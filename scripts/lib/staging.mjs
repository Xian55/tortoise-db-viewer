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
import { basename, join } from "node:path";
import { parseColumns, iterRows, NULL } from "./sqldump.mjs";
import { splitStatements, translate } from "./mysqlexec.mjs";

const PFX = "stg_";

// The migrations used to be flat `*.sql` under database_updates/; upstream moved them
// into `world/` + `character/` subdirectories (server commit "Reorganizing database
// migrations"). A non-recursive readdir then matched NOTHING and the build quietly
// produced a base-only DB -- 117 migrations, i.e. every 1.18.x zone, quest and rename,
// dropped while the run reported success. Walk both layouts, and skip `character/`:
// those target the character DB, which this build does not stage at all.
function migrationFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name.toLowerCase() !== "character") walk(join(d, e.name));
      } else if (e.name.endsWith(".sql")) {
        out.push(join(d, e.name));
      }
    }
  };
  walk(dir);
  // Ordered by FILENAME, not path: the leading timestamp is the server's own apply
  // order and is global across directories.
  return out.sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
}

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
    const files = migrationFiles(UPD_DIR);
    // An updates dir that yields no migrations is never normal -- it means the layout
    // moved again. Say so loudly; the alternative is a base-only DB that looks fine.
    if (!files.length) console.warn(`  WARNING: ${UPD_DIR} exists but holds no .sql migrations -- building base-only`);
    // Migrations may target columns the base CREATE lacks (Turtle extends some
    // tables, e.g. npc_vendor_template gains slot/condition_id). Pre-scan the
    // INSERT/REPLACE column lists and ALTER-add any missing columns to the staged
    // table, else those statements would error on "no such column" and be dropped.
    const colRe = /(?:INSERT(?:\s+IGNORE)?|REPLACE)\s+INTO\s+`?(\w+)`?\s*\(([^)]+)\)/gi;
    // A migration may also declare the new column itself and then UPDATE it -- the
    // executor skips DDL, so without reading the ALTER those UPDATEs all die on "no
    // such column" (377 of them on spell_template.script_name alone). Harmless while
    // nothing here reads that column; silent data loss the day something does.
    const altRe = /ALTER\s+TABLE\s+`?(\w+)`?([\s\S]*?);/gi;
    const addRe = /\bADD\s+(?:COLUMN\s+)?`?(\w+)`?/gi;
    const NOT_A_COLUMN = /^(index|key|unique|primary|constraint|fulltext|spatial|foreign)$/i;
    for (const f of files) {
      const sql = readFileSync(f, "utf8");
      const add = (table, names) => {
        if (!staged.has(table)) return;
        const cols = colsByTable[table];
        for (const c of names) {
          // Case-insensitive: SQLite matches column names case-insensitively, so a
          // migration that inserts into `itemid` against a base `itemId` column must
          // NOT trigger an ALTER (it would fail "duplicate column name").
          if (c && !cols.some((x) => x.toLowerCase() === c.toLowerCase())) {
            db.exec(`ALTER TABLE \`${PFX}${table}\` ADD COLUMN \`${c}\` NUMERIC`);
            cols.push(c);
          }
        }
      };
      let m;
      while ((m = colRe.exec(sql))) add(m[1], m[2].split(",").map((s) => s.replace(/[`\s]/g, "")));
      while ((m = altRe.exec(sql))) {
        const names = [];
        let a;
        addRe.lastIndex = 0;
        while ((a = addRe.exec(m[2]))) if (!NOT_A_COLUMN.test(a[1])) names.push(a[1]);
        add(m[1], names);
      }
    }
    for (const f of files) {
      stats.files++;
      const sql = readFileSync(f, "utf8");
      // One transaction PER FILE. Applying a migration statement at a time was the single
      // biggest cost in the build (37% of CPU): with no explicit transaction every one of
      // them commits on its own, and these files are mostly long runs of small DML. Per
      // file rather than one transaction for all 118, so a file stays the unit of work and
      // peak memory stays bounded. The per-statement catch is kept INSIDE, which is what
      // preserves the old semantics -- SQLite does not abort a transaction over a failed
      // statement, and since nothing rethrows, one bad statement still skips only itself.
      db.transaction(() => {
        for (const raw of splitStatements(sql)) {
          const t = translate(raw, staged, PFX);
          if (t === null) { stats.skipped++; continue; }
          try { db.exec(t); stats.applied++; }
          catch (e) {
            stats.errors++;
            if (stats.errors <= 10) console.warn(`  migration error in ${basename(f)}: ${e.message}`);
          }
        }
      })();
    }
  }

  return {
    has: (table) => staged.has(table),
    columns: (table) => colsByTable[table],
    // Yield rows as positional arrays in the staged column order (iterRows shape), read
    // positionally. `SELECT *` returns columns in physical order and
    // colsByTable is kept in that same order (the migration pre-scan pushes each
    // ALTER-added name as it adds the column), so values() yields exactly what the old
    // `cols.map((c) => r[c])` built -- without materialising an object per row and mapping
    // it straight back. That round trip was ~12% of the build's CPU time.
    rows: function* (table) {
      const cols = colsByTable[table];
      if (!cols) return;
      yield* db.prepare(`SELECT * FROM \`${PFX}${table}\``).values();
    },
    drop: () => { for (const t of staged) db.exec(`DROP TABLE \`${PFX}${t}\``); },
    stats,
  };
}
