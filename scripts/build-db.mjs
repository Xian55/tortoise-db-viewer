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
import { statsFromColumns, statsFromAuras } from "./lib/itemstats.mjs";

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
  // spawn count per (creature, map) — cnt=1 marks a unique spawn (a boss heuristic)
  const counts = new Map();
  for (const r of iterRows(cs, "creature")) {
    const k = `${clean(r[iId])}:${clean(r[iMap])}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  db.exec(`CREATE TABLE spawns (id INTEGER, map INTEGER, cnt INTEGER)`);
  const ss = db.prepare(`INSERT INTO spawns VALUES (?,?,?)`);
  db.transaction(() => {
    for (const [k, c] of counts) {
      const [id, map] = k.split(":").map(Number);
      ss.run(id, map, c);
    }
  })();
  db.exec(`CREATE INDEX idx_spawns_id ON spawns(id)`);
  db.exec(`CREATE INDEX idx_spawns_map ON spawns(map)`);
  console.log(`  maps: ${nm} | spawns (distinct id,map): ${counts.size}`);
}

// ---- Resolve effective drop chances (mangos loot groups + references) ----
// Equal-chance groups (chance=0) split the group remainder; references multiply
// through. Large shared/world-drop pools are excluded (noise, not per-creature
// loot). The result replaces the raw loot tables, which are dropped afterward.
console.log("Resolving loot chances...");
{
  const REF_THRESHOLD = 30; // a reference resolving to more items than this = world-drop pool
  const load = (t) => {
    const m = new Map();
    for (const r of db.prepare(`SELECT entry, item, chance, groupid, mincountOrRef FROM ${t}`).all()) {
      let a = m.get(r.entry); if (!a) m.set(r.entry, a = []); a.push(r);
    }
    return m;
  };
  const REF = load("loot_reference");

  const sizeCache = new Map();
  function refItems(refId, seen) {
    const s = new Set();
    for (const r of (REF.get(refId) || [])) {
      if (r.item > 0) s.add(r.item);
      else if (r.mincountOrRef < 0 && !seen.has(-r.mincountOrRef)) {
        seen.add(-r.mincountOrRef);
        for (const it of refItems(-r.mincountOrRef, seen)) s.add(it);
      }
    }
    return s;
  }
  const refSize = (refId) => {
    if (sizeCache.has(refId)) return sizeCache.get(refId);
    const n = refItems(refId, new Set([refId])).size;
    sizeCache.set(refId, n); return n;
  };

  const refResCache = new Map();
  function resolveRef(refId) {
    if (refResCache.has(refId)) return refResCache.get(refId);
    refResCache.set(refId, new Map()); // cycle guard
    const res = resolveRows(REF.get(refId) || []);
    refResCache.set(refId, res); return res;
  }
  function addRow(result, row, prob) {
    if (prob <= 0) return;
    if (row.mincountOrRef < 0) {
      const refId = -row.mincountOrRef;
      if (refSize(refId) > REF_THRESHOLD) return; // skip world-drop pools
      for (const [item, p] of resolveRef(refId)) result.set(item, (result.get(item) || 0) + p * prob);
    } else if (row.item > 0) {
      result.set(row.item, (result.get(row.item) || 0) + prob);
    }
  }
  function resolveRows(rows) {
    const result = new Map(), groups = new Map();
    for (const r of rows) { let a = groups.get(r.groupid); if (!a) groups.set(r.groupid, a = []); a.push(r); }
    for (const [gid, grows] of groups) {
      if (gid === 0) {
        for (const row of grows) {
          const ch = Math.abs(row.chance);
          addRow(result, row, ch > 0 ? ch / 100 : (row.mincountOrRef < 0 ? 1 : 0));
        }
      } else {
        const explicit = grows.filter((r) => Math.abs(r.chance) > 0);
        const equal = grows.filter((r) => r.chance === 0);
        const sumE = explicit.reduce((a, r) => a + Math.abs(r.chance), 0);
        for (const row of explicit) addRow(result, row, Math.abs(row.chance) / 100);
        const eqP = Math.max(0, 100 - sumE) / 100 / (equal.length || 1);
        for (const row of equal) addRow(result, row, eqP);
      }
    }
    return result;
  }

  db.exec(`CREATE TABLE drops (src TEXT, owner INTEGER, item INTEGER, chance REAL)`);
  const ins = db.prepare(`INSERT INTO drops VALUES (?,?,?,?)`);
  const sources = [["c", "loot_creature"], ["s", "loot_skinning"], ["p", "loot_pickpocket"],
    ["o", "loot_object"], ["i", "loot_item"], ["e", "loot_disenchant"]];
  let nd = 0;
  db.transaction(() => {
    for (const [src, table] of sources) {
      for (const [owner, rows] of load(table)) {
        for (const [item, prob] of resolveRows(rows)) { ins.run(src, owner, item, prob * 100); nd++; }
      }
    }
  })();
  db.exec(`CREATE INDEX idx_drops_owner ON drops(owner, src)`);
  db.exec(`CREATE INDEX idx_drops_item ON drops(item, src)`);

  // raw loot tables are no longer needed at runtime
  for (const t of ["loot_creature", "loot_skinning", "loot_pickpocket", "loot_object",
    "loot_item", "loot_disenchant", "loot_fishing", "loot_reference"]) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  console.log(`  drops (resolved): ${nd} rows (raw loot tables dropped)`);
}

// ---- Spells + crafting graph (single pass over the 16MB dump) ----
// spellStats: spellId -> { statKey: value } derived from the spell's effect auras
// (build-time only; the raw effect/aura columns are NOT persisted). Used by the
// item_stats pass below to resolve an item's equip-spell stats.
const spellStats = new Map();
console.log("Importing spells + crafting graph...");
{
  // spell_id -> { skill, req } from skill_line_ability: lets us label a crafting
  // spell with its profession (+ required skill) on the item page. First row wins.
  const spellSkill = new Map();
  {
    const slaSql = read("tw_world_skill_line_ability.sql");
    const sc = parseColumns(slaSql);
    const iSp = sc.indexOf("spell_id"), iSk = sc.indexOf("skill_id"), iRq = sc.indexOf("req_skill_value");
    for (const r of iterRows(slaSql, "skill_line_ability")) {
      const sp = clean(r[iSp]);
      if (!spellSkill.has(sp)) spellSkill.set(sp, { skill: clean(r[iSk]), req: clean(r[iRq]) });
    }
    console.log(`  skill_line_ability: ${spellSkill.size} spells`);
  }
  const sql = read("tw_world_spell_template.sql");
  const c = parseColumns(sql);
  const at = (name) => c.indexOf(name);
  const iEntry = at("entry"), iName = at("name"), iDesc = at("description"), iAura = at("auraDescription"), iIcon = at("spellIconId");
  const bp = [1, 2, 3].map((n) => at(`effectBasePoints${n}`));
  const ds = [1, 2, 3].map((n) => at(`effectDieSides${n}`));
  const effIdx = [1, 2, 3].map((n) => ({ a: at(`effectApplyAuraName${n}`), m: at(`effectMiscValue${n}`), b: at(`effectBasePoints${n}`) }));
  const reagents = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [at(`reagent${n}`), at(`reagentCount${n}`)]);
  const creates = [1, 2, 3].map((n) => at(`effectItemType${n}`));

  db.exec(`CREATE TABLE spells (entry INTEGER PRIMARY KEY, name TEXT, description TEXT, auraDescription TEXT, spellIconId INTEGER,
    s1 INTEGER, s2 INTEGER, s3 INTEGER, d1 INTEGER, d2 INTEGER, d3 INTEGER)`);
  db.exec(`CREATE TABLE spell_creates (spell INTEGER, item INTEGER, skill INTEGER, skill_req INTEGER)`);
  db.exec(`CREATE TABLE spell_reagent (spell INTEGER, item INTEGER, count INTEGER)`);
  const sSpell = db.prepare(`INSERT OR REPLACE INTO spells VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const sCreate = db.prepare(`INSERT INTO spell_creates VALUES (?,?,?,?)`);
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
      // derive gear stats from this spell's effect auras (for item_stats)
      const effects = effIdx.map((f) => ({ aura: clean(row[f.a]) || 0, misc: clean(row[f.m]) || 0, base: clean(row[f.b]) || 0 }));
      const st = statsFromAuras(effects);
      if (Object.keys(st).length) spellStats.set(e, st);
      const sk = spellSkill.get(e);
      for (const ci of creates) {
        const item = clean(row[ci]);
        if (item) { sCreate.run(e, item, sk ? sk.skill : null, sk ? sk.req : null); nc++; }
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

// ---- Derived per-item gear stats (powers the multi-criteria browse filter) ----
// One row per (item, stat). Stats come from item columns (base stats, armor,
// resistances, DPS) plus equip-spell auras (spellStats). Only items that actually
// have a stat get a row -> presence-aware filtering (`natRes >= 0` => has nature res).
console.log("Deriving item_stats...");
{
  db.exec(`CREATE TABLE item_stats (item INTEGER, stat TEXT, value REAL)`);
  const ins = db.prepare(`INSERT INTO item_stats VALUES (?,?,?)`);
  const items = db.prepare(`SELECT * FROM items`).all();
  const coverage = new Map();
  let nrows = 0;
  db.transaction(() => {
    for (const it of items) {
      const acc = statsFromColumns(it);
      for (let k = 1; k <= 5; k++) {
        if (it[`spelltrigger_${k}`] !== 1) continue; // "Equip:" effects only
        const st = spellStats.get(it[`spellid_${k}`]);
        if (st) for (const key in st) acc[key] = (acc[key] || 0) + st[key];
      }
      for (const stat in acc) {
        if (!acc[stat]) continue;
        ins.run(it.entry, stat, acc[stat]);
        coverage.set(stat, (coverage.get(stat) || 0) + 1);
        nrows++;
      }
    }
  })();
  db.exec(`CREATE INDEX idx_item_stats_lookup ON item_stats(stat, value)`);
  db.exec(`CREATE INDEX idx_item_stats_item ON item_stats(item)`);
  const cov = [...coverage.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}:${c}`).join(" ");
  console.log(`  item_stats: ${nrows} rows | ${cov}`);
}

// ---- Derived per-item acquisition sources (powers the browse Source filter) ----
// One row per (item, source); the rich set mirrors the item-detail tabs. PvP is
// approximated from a honor-rank requirement (no honor/BG vendor link in dumps).
console.log("Deriving item_sources...");
{
  db.exec(`CREATE TABLE item_sources (item INTEGER, source TEXT)`);
  const insSrc = (sql) => db.exec(`INSERT INTO item_sources ${sql}`);
  insSrc(`SELECT DISTINCT item, 'drop'       FROM drops WHERE src='c'`);
  insSrc(`SELECT DISTINCT item, 'skin'       FROM drops WHERE src='s'`);
  insSrc(`SELECT DISTINCT item, 'pick'       FROM drops WHERE src='p'`);
  insSrc(`SELECT DISTINCT item, 'object'     FROM drops WHERE src='o'`);
  insSrc(`SELECT DISTINCT item, 'container'  FROM drops WHERE src='i'`);
  insSrc(`SELECT DISTINCT item, 'disenchant' FROM drops WHERE src='e'`);
  insSrc(`SELECT DISTINCT item, 'vendor'     FROM npc_vendor`);
  insSrc(`SELECT DISTINCT item, 'quest'      FROM quest_item WHERE role IN ('reward','choice')`);
  insSrc(`SELECT DISTINCT item, 'crafted'    FROM spell_creates`);
  insSrc(`SELECT entry, 'pvp'                FROM items WHERE required_honor_rank > 0`);
  // 'unobtainable' = dev artifacts (test/deprecated/placeholder items) detected by
  // name convention; hidden by default in the item browse. Name-pattern, NOT
  // "no known source" — many legit items simply lack loot data (e.g. world drops,
  // rep rewards) and must stay visible. The OLD rules are case-sensitive: all-caps
  // "OLD"/"(OLD)" is a dev marker, while normal-case "Old Blanchy" is a real item.
  const JUNK = [/^zz/i, /^OLD\b/, /\(OLD\)/, /\bdeprecated\b/i, /^monster\s*-/i,
    /\[ph\]/i, /\[dep\]/i, /\bunused\b/i, /\btest\b/i];
  const insU = db.prepare(`INSERT INTO item_sources VALUES (?, 'unobtainable')`);
  let nu = 0;
  db.transaction(() => {
    for (const { entry, name } of db.prepare(`SELECT entry, name FROM items`).all()) {
      if (name && JUNK.some((re) => re.test(name))) { insU.run(entry); nu++; }
    }
  })();
  db.exec(`CREATE INDEX idx_item_sources_source ON item_sources(source, item)`);
  db.exec(`CREATE INDEX idx_item_sources_item ON item_sources(item)`);
  const n = db.prepare(`SELECT COUNT(*) c FROM item_sources`).get().c;
  console.log(`  item_sources: ${n} rows (unobtainable: ${nu})`);
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
