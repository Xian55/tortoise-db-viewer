// Build a single SQLite file from the Tortoise-WoW SQL dumps.
// Output: public/data/tortoise.sqlite  (queried in-browser via sql.js-httpvfs)
//
// Usage:  SQL_DIR=X:/Programming/tortoise-wow/sql/base node scripts/build-db.mjs
// Default SQL_DIR assumes the server repo sits next to this one.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseColumns, iterRows, NULL } from "./lib/sqldump.mjs";
import { IMPORTS, LOOT_TABLES, LOOT_COLUMNS } from "./lib/schema.mjs";
import { openDatabase, RUNTIME } from "./lib/sqlite.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL_DIR = process.env.SQL_DIR || join(ROOT, "..", "tortoise-wow", "sql", "base");
// Single DB file, fetched whole by the browser and loaded into sqlite-wasm.
// GitHub Pages gzips it on the wire (~27 MB -> ~8.6 MB), decompressed by the browser.
const OUT = join(ROOT, "public", "data", "tortoise.sqlite");

if (!existsSync(SQL_DIR)) {
  console.error(`SQL_DIR not found: ${SQL_DIR}\nSet SQL_DIR to the server repo's sql/base folder.`);
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
rmSync(OUT, { force: true });

const db = await openDatabase(OUT);
db.pragma("page_size = 4096"); // must be set before any table is created
db.pragma("journal_mode = OFF");
db.pragma("synchronous = OFF");
console.log(`Runtime: ${RUNTIME}`);

const t0 = Date.now();
const clean = (v) => (v === NULL ? null : v);
const read = (file) => readFileSync(join(SQL_DIR, file), "utf8");

function colType(name, textSet) {
  return textSet.has(name) ? "TEXT" : "INTEGER";
}

// ---- Generic importers (items, creatures, gameobjects, npc_vendor) ----
function importSpec(spec) {
  const sql = read(spec.file);
  const srcCols = parseColumns(sql);
  const cols = spec.columns || srcCols;
  const idx = cols.map((c) => srcCols.indexOf(c));
  const missing = cols.filter((c, i) => idx[i] < 0);
  if (missing.length) throw new Error(`${spec.target}: columns missing from ${spec.file}: ${missing}`);
  const textSet = new Set(spec.text);

  const defs = cols.map((c) =>
    c === spec.pk ? `\`${c}\` INTEGER PRIMARY KEY` : `\`${c}\` ${colType(c, textSet)}`
  );
  db.exec(`CREATE TABLE ${spec.target} (${defs.join(", ")})`);

  const placeholders = cols.map(() => "?").join(",");
  const stmt = db.prepare(`INSERT OR REPLACE INTO ${spec.target} VALUES (${placeholders})`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const row of iterRows(sql, spec.table)) {
      stmt.run(idx.map((i) => clean(row[i])));
      n++;
    }
  });
  tx();
  for (const c of spec.indexes) db.exec(`CREATE INDEX idx_${spec.target}_${c} ON ${spec.target}(\`${c}\`)`);
  console.log(`  ${spec.target}: ${n} rows`);
}

console.log("Importing core tables...");
for (const spec of IMPORTS) importSpec(spec);

// ---- Loot tables (shared shape) ----
console.log("Importing loot tables...");
for (const lt of LOOT_TABLES) {
  if (!existsSync(join(SQL_DIR, lt.file))) {
    console.log(`  (skip ${lt.target}: ${lt.file} not found)`);
    continue;
  }
  const sql = read(lt.file);
  const srcCols = parseColumns(sql);
  const idx = LOOT_COLUMNS.map((c) => srcCols.indexOf(c));
  db.exec(
    `CREATE TABLE ${lt.target} (entry INTEGER, item INTEGER, chance REAL, groupid INTEGER, mincountOrRef INTEGER, maxcount INTEGER)`
  );
  const stmt = db.prepare(`INSERT INTO ${lt.target} VALUES (?,?,?,?,?,?)`);
  let n = 0;
  db.transaction(() => {
    for (const row of iterRows(sql, lt.table)) {
      stmt.run(idx.map((i) => clean(row[i])));
      n++;
    }
  })();
  db.exec(`CREATE INDEX idx_${lt.target}_item ON ${lt.target}(item)`);
  db.exec(`CREATE INDEX idx_${lt.target}_entry ON ${lt.target}(entry)`);
  console.log(`  ${lt.target}: ${n} rows`);
}

// ---- Maps + distinct creature spawns (for dungeon/raid + NPC location) ----
console.log("Importing maps + spawns...");
{
  const ms = read("tw_world_map_template.sql");
  const mc = parseColumns(ms);
  const iE = mc.indexOf("entry"), iN = mc.indexOf("map_name"), iT = mc.indexOf("map_type");
  db.exec(`CREATE TABLE maps (id INTEGER PRIMARY KEY, name TEXT, type INTEGER)`);
  const sm = db.prepare(`INSERT OR REPLACE INTO maps VALUES (?,?,?)`);
  let nm = 0;
  db.transaction(() => { for (const r of iterRows(ms, "map_template")) { sm.run(clean(r[iE]), clean(r[iN]), clean(r[iT])); nm++; } })();
  db.exec(`CREATE INDEX idx_maps_type ON maps(type)`);

  const cs = read("tw_world_creature.sql");
  const cc = parseColumns(cs);
  const iId = cc.indexOf("id"), iMap = cc.indexOf("map");
  db.exec(`CREATE TABLE spawns (id INTEGER, map INTEGER)`);
  const ss = db.prepare(`INSERT INTO spawns VALUES (?,?)`);
  const seen = new Set();
  let ns = 0;
  db.transaction(() => {
    for (const r of iterRows(cs, "creature")) {
      const id = clean(r[iId]), map = clean(r[iMap]);
      const k = `${id}:${map}`;
      if (!seen.has(k)) { seen.add(k); ss.run(id, map); ns++; }
    }
  })();
  db.exec(`CREATE INDEX idx_spawns_id ON spawns(id)`);
  db.exec(`CREATE INDEX idx_spawns_map ON spawns(map)`);
  console.log(`  maps: ${nm} | spawns (distinct id,map): ${ns}`);
}

// ---- Spells + crafting graph (single pass over the 16MB dump) ----
console.log("Importing spells + crafting graph...");
{
  const sql = read("tw_world_spell_template.sql");
  const c = parseColumns(sql);
  const at = (name) => c.indexOf(name);
  const iEntry = at("entry"), iName = at("name"), iDesc = at("description"), iAura = at("auraDescription"), iIcon = at("spellIconId");
  const bp = [1, 2, 3].map((n) => at(`effectBasePoints${n}`));
  const ds = [1, 2, 3].map((n) => at(`effectDieSides${n}`));
  const reagents = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [at(`reagent${n}`), at(`reagentCount${n}`)]);
  const creates = [1, 2, 3].map((n) => at(`effectItemType${n}`));

  db.exec(`CREATE TABLE spells (entry INTEGER PRIMARY KEY, name TEXT, description TEXT, auraDescription TEXT, spellIconId INTEGER,
    s1 INTEGER, s2 INTEGER, s3 INTEGER, d1 INTEGER, d2 INTEGER, d3 INTEGER)`);
  db.exec(`CREATE TABLE spell_creates (spell INTEGER, item INTEGER)`);
  db.exec(`CREATE TABLE spell_reagent (spell INTEGER, item INTEGER, count INTEGER)`);
  const sSpell = db.prepare(`INSERT OR REPLACE INTO spells VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const sCreate = db.prepare(`INSERT INTO spell_creates VALUES (?,?)`);
  const sReag = db.prepare(`INSERT INTO spell_reagent VALUES (?,?,?)`);
  let ns = 0, nc = 0, nr = 0;
  db.transaction(() => {
    for (const row of iterRows(sql, "spell_template")) {
      const e = clean(row[iEntry]);
      // $sN in spell text resolves to basePoints+1 (.. +dieSides for ranges)
      const s = bp.map((bi, k) => (clean(row[bi]) || 0) + 1);
      const d = ds.map((di) => clean(row[di]) || 0);
      sSpell.run(e, clean(row[iName]), clean(row[iDesc]), clean(row[iAura]), clean(row[iIcon]),
        s[0], s[1], s[2], d[0], d[1], d[2]);
      ns++;
      for (const ci of creates) {
        const item = clean(row[ci]);
        if (item) { sCreate.run(e, item); nc++; }
      }
      for (const [ri, rc] of reagents) {
        const item = clean(row[ri]);
        if (item) { sReag.run(e, item, clean(row[rc]) || 1); nr++; }
      }
    }
  })();
  db.exec(`CREATE INDEX idx_spell_creates_item ON spell_creates(item)`);
  db.exec(`CREATE INDEX idx_spell_creates_spell ON spell_creates(spell)`);
  db.exec(`CREATE INDEX idx_spell_reagent_item ON spell_reagent(item)`);
  db.exec(`CREATE INDEX idx_spell_reagent_spell ON spell_reagent(spell)`);
  console.log(`  spells: ${ns} | creates: ${nc} | reagents: ${nr}`);
}

// ---- Quests + quest<->item link table ----
console.log("Importing quests + quest items...");
{
  const sql = read("tw_world_quest_template.sql");
  const c = parseColumns(sql);
  const at = (name) => c.indexOf(name);
  const iEntry = at("entry"), iTitle = at("Title"), iZone = at("ZoneOrSort"),
    iMin = at("MinLevel"), iLvl = at("QuestLevel");
  const req = [1, 2, 3, 4].map((n) => [at(`ReqItemId${n}`), at(`ReqItemCount${n}`)]);
  const rew = [1, 2, 3, 4].map((n) => [at(`RewItemId${n}`), at(`RewItemCount${n}`)]);
  const choice = [1, 2, 3, 4, 5, 6].map((n) => [at(`RewChoiceItemId${n}`), at(`RewChoiceItemCount${n}`)]);

  db.exec(`CREATE TABLE quests (entry INTEGER PRIMARY KEY, title TEXT, zone INTEGER, minlevel INTEGER, level INTEGER)`);
  db.exec(`CREATE TABLE quest_item (quest INTEGER, item INTEGER, role TEXT, count INTEGER)`);
  const sQ = db.prepare(`INSERT OR REPLACE INTO quests VALUES (?,?,?,?,?)`);
  const sQI = db.prepare(`INSERT INTO quest_item VALUES (?,?,?,?)`);
  let nq = 0, nqi = 0;
  const addItems = (e, pairs, role, row) => {
    for (const [ii, ci] of pairs) {
      const item = clean(row[ii]);
      if (item) { sQI.run(e, item, role, ci >= 0 ? clean(row[ci]) || 1 : 1); nqi++; }
    }
  };
  db.transaction(() => {
    for (const row of iterRows(sql, "quest_template")) {
      const e = clean(row[iEntry]);
      sQ.run(e, clean(row[iTitle]), clean(row[iZone]), clean(row[iMin]), clean(row[iLvl]));
      nq++;
      addItems(e, req, "req", row);
      addItems(e, rew, "reward", row);
      addItems(e, choice, "choice", row);
    }
  })();
  db.exec(`CREATE INDEX idx_quest_item_item ON quest_item(item)`);
  db.exec(`CREATE INDEX idx_quest_item_quest ON quest_item(quest)`);
  console.log(`  quests: ${nq} | quest_item links: ${nqi}`);
}

// ---- Full-text search over item names ----
console.log("Building FTS index...");
db.exec(`CREATE VIRTUAL TABLE items_fts USING fts5(name, content='items', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO items_fts(rowid, name) SELECT entry, name FROM items`);

console.log("Optimizing...");
db.pragma("journal_mode = DELETE");
db.exec("VACUUM");
db.close();

// content hash -> version.json (drives client cache invalidation)
const buf = readFileSync(OUT);
const version = createHash("sha256").update(buf).digest("hex").slice(0, 12);
writeFileSync(join(ROOT, "public", "data", "version.json"), JSON.stringify({ version }));

const mb = (buf.length / 1048576).toFixed(1);
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT} (${mb} MB, version ${version})`);
