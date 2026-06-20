// Stage the raw Tortoise-WoW world tables the build consumes, then apply the
// server's incremental migrations (sql/database_updates) on top -- the same data
// `mangosd` produces at runtime. The viewer build then reads from these staged
// tables instead of the base dump text, so patch-added content (new zones, NPCs,
// objects, quests) shows up. Future upstream updates ship as new migration files
// and flow through automatically.
//
// Staging tables are named `stg_<table>` to avoid colliding with the viewer's
// own tables (e.g. npc_vendor, item_display_info share the raw name). Columns are
// declared NUMERIC (so numeric-looking values get numeric affinity for correct
// WHERE/JOIN matching) except the optional single-column primary key.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseColumns, iterRows, NULL } from "./sqldump.mjs";
import { splitStatements, translate } from "./mysqlexec.mjs";

const PFX = "stg_";

// specs: [{ table, file, pk? }]. Returns an accessor with the same shape the
// importers expect from the dump (columns + positional rows), plus `drop()`.
export function buildStaging(db, SQL_DIR, UPD_DIR, specs) {
  const colsByTable = {};
  const staged = new Set();

  for (const { table, file, pk } of specs) {
    const path = join(SQL_DIR, file);
    if (!existsSync(path)) continue;
    const sql = readFileSync(path, "utf8");
    const cols = parseColumns(sql);
    colsByTable[table] = cols;
    staged.add(table);
    const hasPk = pk && cols.includes(pk);
    const defs = cols.map((c) => (c === pk && hasPk ? `\`${c}\` INTEGER PRIMARY KEY` : `\`${c}\` NUMERIC`));
    db.exec(`CREATE TABLE \`${PFX}${table}\` (${defs.join(", ")})`);
    const ph = cols.map(() => "?").join(",");
    const st = db.prepare(`INSERT OR REPLACE INTO \`${PFX}${table}\` VALUES (${ph})`);
    db.transaction(() => {
      for (const r of iterRows(sql, table)) st.run(cols.map((_, i) => (r[i] === NULL ? null : r[i])));
    })();
  }

  // Apply migrations in filename (timestamp) order, exactly as the server does.
  const stats = { files: 0, applied: 0, skipped: 0, errors: 0 };
  if (UPD_DIR && existsSync(UPD_DIR)) {
    const files = readdirSync(UPD_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      stats.files++;
      const sql = readFileSync(join(UPD_DIR, f), "utf8");
      for (const raw of splitStatements(sql)) {
        const t = translate(raw, staged, PFX);
        if (t === null) { stats.skipped++; continue; }
        try { db.exec(t); stats.applied++; }
        catch (e) {
          stats.errors++;
          if (stats.errors <= 10) console.warn(`  migration error in ${f}: ${e.message}`);
        }
      }
    }
  }

  return {
    has: (table) => staged.has(table),
    columns: (table) => colsByTable[table],
    // yield rows as positional arrays in the staged column order (iterRows shape)
    rows: function* (table) {
      const cols = colsByTable[table];
      if (!cols) return;
      for (const r of db.prepare(`SELECT * FROM \`${PFX}${table}\``).all()) yield cols.map((c) => r[c]);
    },
    drop: () => { for (const t of staged) db.exec(`DROP TABLE \`${PFX}${t}\``); },
    stats,
  };
}
