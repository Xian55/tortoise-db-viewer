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
import { buildStaging } from "./lib/staging.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL_DIR = process.env.SQL_DIR || join(ROOT, "..", "tortoise-wow", "sql", "base");
// Server world migrations (applied on top of the base dump, exactly as mangosd
// does at runtime). Sibling of SQL_DIR; override with UPDATES_DIR. Absent = the
// build falls back to base-only (older server repos without database_updates).
const UPDATES_DIR = process.env.UPDATES_DIR || join(SQL_DIR, "..", "database_updates");
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

// ---- Staging: load the raw world tables + apply server migrations ----
// Every base table the build consumes is staged so any current or future
// migration (sql/database_updates) to those tables flows into the viewer DB.
// Single-column natural keys get a PRIMARY KEY so REPLACE/INSERT IGNORE upserts
// behave like the server; the rest apply UPDATE/DELETE/INSERT without one.
const STAGE_PK = {
  creature: "guid", gameobject: "guid", creature_template: "entry",
  gameobject_template: "entry", item_template: "entry", quest_template: "entry",
  map_template: "entry", item_display_info: "ID", faction: "entry",
  area_template: "entry", spell_template: "entry",
};
const STAGE_SPECS = (() => {
  const seen = new Set(), specs = [];
  const add = (table, file) => { if (table && file && !seen.has(table)) { seen.add(table); specs.push({ table, file, pk: STAGE_PK[table] }); } };
  for (const s of IMPORTS) add(s.table, s.file);
  for (const s of LOOT_TABLES) add(s.table, s.file);
  add("creature", "tw_world_creature.sql");
  add("gameobject", "tw_world_gameobject.sql");
  add("map_template", "tw_world_map_template.sql");
  add("skill_line_ability", "tw_world_skill_line_ability.sql");
  add("spell_template", "tw_world_spell_template.sql");
  add("quest_template", "tw_world_quest_template.sql");
  add("npc_trainer", "tw_world_npc_trainer.sql");
  add("npc_trainer_template", "tw_world_npc_trainer_template.sql");
  return specs;
})();

console.log("Staging raw tables + applying migrations...");
const src = buildStaging(db, SQL_DIR, UPDATES_DIR, STAGE_SPECS);
console.log(`  staged ${STAGE_SPECS.length} tables | migrations: ${src.stats.files} files, ${src.stats.applied} applied, ${src.stats.skipped} skipped, ${src.stats.errors} errors`);

// Source accessors: prefer the migrated staging table, fall back to dump text
// for any table that wasn't staged (keeps the importers working unchanged).
const srcColumns = (table, file) => (src.has(table) ? src.columns(table) : parseColumns(read(file)));
function* srcRows(table, file) {
  if (src.has(table)) yield* src.rows(table);
  else yield* iterRows(read(file), table);
}

// ---- Generic importers (items, creatures, gameobjects, npc_vendor) ----
function importSpec(spec) {
  const srcCols = srcColumns(spec.table, spec.file);
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
    for (const row of srcRows(spec.table, spec.file)) {
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

// The server SQL item_display_info dump is missing or stale for Turtle's newer
// items (both custom AND standard icons). The supplement -- extracted once from
// the client ItemDisplayInfo.dbc (scripts/extract-icons.py) and committed --
// corrects those display->icon rows so every item resolves its real icon.
{
  const f = join(ROOT, "scripts", "data", "item-display-supplement.json");
  if (existsSync(f)) {
    const map = JSON.parse(readFileSync(f, "utf8"));
    const stmt = db.prepare(`INSERT OR REPLACE INTO item_display_info (ID, icon) VALUES (?, ?)`);
    let n = 0;
    db.transaction(() => {
      for (const [id, icon] of Object.entries(map)) { stmt.run([Number(id), icon]); n++; }
    })();
    console.log(`  item_display_info: +${n} corrective rows`);
  } else {
    console.log("  (no item-display-supplement.json -- run scripts/extract-icons.py for Turtle icons)");
  }
}

// ---- Loot tables (shared shape) ----
console.log("Importing loot tables...");
for (const lt of LOOT_TABLES) {
  if (!src.has(lt.table)) {
    console.log(`  (skip ${lt.target}: ${lt.file} not found)`);
    continue;
  }
  const srcCols = srcColumns(lt.table, lt.file);
  const idx = LOOT_COLUMNS.map((c) => srcCols.indexOf(c));
  db.exec(
    `CREATE TABLE ${lt.target} (entry INTEGER, item INTEGER, chance REAL, groupid INTEGER, mincountOrRef INTEGER, maxcount INTEGER)`
  );
  const stmt = db.prepare(`INSERT INTO ${lt.target} VALUES (?,?,?,?,?,?)`);
  let n = 0;
  db.transaction(() => {
    for (const row of srcRows(lt.table, lt.file)) {
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
  const mc = srcColumns("map_template", "tw_world_map_template.sql");
  const iE = mc.indexOf("entry"), iN = mc.indexOf("map_name"), iT = mc.indexOf("map_type");
  db.exec(`CREATE TABLE maps (id INTEGER PRIMARY KEY, name TEXT, type INTEGER)`);
  const sm = db.prepare(`INSERT OR REPLACE INTO maps VALUES (?,?,?)`);
  let nm = 0;
  db.transaction(() => { for (const r of srcRows("map_template", "tw_world_map_template.sql")) { sm.run(clean(r[iE]), clean(r[iN]), clean(r[iT])); nm++; } })();
  db.exec(`CREATE INDEX idx_maps_type ON maps(type)`);

  const cc = srcColumns("creature", "tw_world_creature.sql");
  const iId = cc.indexOf("id"), iMap = cc.indexOf("map");
  // spawn count per (creature, map) — cnt=1 marks a unique spawn (a boss heuristic)
  const counts = new Map();
  for (const r of srcRows("creature", "tw_world_creature.sql")) {
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

  // Flag "world drop" items: dropped by many distinct creature loot tables (the
  // ubiquitous BoE greens, gems, cloth). They aren't characteristic of any zone,
  // so the zone Items tab excludes them (Q_ZONE_LOOT). Threshold is deliberate:
  // zone-specific drops come from a handful of loot tables; world drops from 25+.
  const WORLD_DROP_BREADTH = 25;
  db.exec(`ALTER TABLE items ADD COLUMN world_drop INTEGER NOT NULL DEFAULT 0`);
  const nwd = db.prepare(`UPDATE items SET world_drop = 1 WHERE entry IN (
    SELECT item FROM drops WHERE src = 'c' GROUP BY item
    HAVING COUNT(DISTINCT owner) >= ?)`).run(WORLD_DROP_BREADTH);
  console.log(`  world_drop items: ${nwd.changes ?? "?"} (>= ${WORLD_DROP_BREADTH} creature loot tables)`);

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
// craftSpell -> [learn spells that trigger it]. Recipe items and trainers reference
// the learn spell, which teaches the actual trade-skill craft. Used by craft_source.
const spellTriggers = new Map();
// learn-spell id -> the spell it teaches. ONLY spells with a LEARN_SPELL (effect
// 36) effect, so trainers/books resolve to the real player spell without the
// false positives a raw effectTriggerSpell (procs, missiles) would add.
const learnTeaches = new Map();
// spellId -> 1 when the skill grants the craft automatically (learn_on_get_skill):
// these have no trainer/recipe source — you just know them with the profession.
const craftAuto = new Map();
console.log("Importing spells + crafting graph...");
{
  // spell_id -> { skill, req } from skill_line_ability: lets us label a crafting
  // spell with its profession (+ required skill) on the item page. First row wins.
  const spellSkill = new Map();
  {
    const sc = srcColumns("skill_line_ability", "tw_world_skill_line_ability.sql");
    const iSp = sc.indexOf("spell_id"), iSk = sc.indexOf("skill_id"), iRq = sc.indexOf("req_skill_value");
    const iMin = sc.indexOf("min_value"), iMax = sc.indexOf("max_value"), iLearn = sc.indexOf("learn_on_get_skill");
    for (const r of srcRows("skill_line_ability", "tw_world_skill_line_ability.sql")) {
      const sp = clean(r[iSp]);
      // min_value/max_value are the yellow/grey skill-up thresholds (green is their
      // midpoint); kept so the crafting view can color recipe difficulty.
      if (!spellSkill.has(sp)) spellSkill.set(sp, { skill: clean(r[iSk]), req: clean(r[iRq]), min: clean(r[iMin]), max: clean(r[iMax]) });
      if (clean(r[iLearn])) craftAuto.set(sp, 1);
    }
    console.log(`  skill_line_ability: ${spellSkill.size} spells`);
  }
  // spellIconId -> icon basename, extracted once from the client SpellIcon.dbc
  // (scripts/extract-spell-icons.py) and committed. Standard icons resolve from
  // the CDN by basename; absent map = text/CDN-fallback links (graceful).
  let spellIconMap = {};
  {
    const f = join(ROOT, "scripts", "data", "spell-icon-map.json");
    if (existsSync(f)) {
      spellIconMap = JSON.parse(readFileSync(f, "utf8"));
      console.log(`  spell-icon-map: ${Object.keys(spellIconMap).length} icons`);
    } else {
      console.log("  (no spell-icon-map.json -- run scripts/extract-spell-icons.py for spell icons)");
    }
  }
  // index->value lookup tables (cast time/range/duration/radius) extracted from
  // the client DBCs (scripts/extract-spell-icons.py). Absent = those detail fields
  // resolve to null (graceful). Keyed by string id (JSON object).
  let spellLookups = { castTime: {}, duration: {}, radius: {}, range: {} };
  {
    const f = join(ROOT, "scripts", "data", "spell-lookups.json");
    if (existsSync(f)) {
      spellLookups = JSON.parse(readFileSync(f, "utf8"));
      console.log(`  spell-lookups: cast ${Object.keys(spellLookups.castTime).length}, range ${Object.keys(spellLookups.range).length}, duration ${Object.keys(spellLookups.duration).length}, radius ${Object.keys(spellLookups.radius).length}`);
    } else {
      console.log("  (no spell-lookups.json -- run scripts/extract-spell-icons.py for spell detail)");
    }
  }
  const c = srcColumns("spell_template", "tw_world_spell_template.sql");
  const at = (name) => c.indexOf(name);
  const iEntry = at("entry"), iName = at("name"), iDesc = at("description"), iAura = at("auraDescription"), iIcon = at("spellIconId");
  const bp = [1, 2, 3].map((n) => at(`effectBasePoints${n}`));
  const ds = [1, 2, 3].map((n) => at(`effectDieSides${n}`));
  const effIdx = [1, 2, 3].map((n) => ({ a: at(`effectApplyAuraName${n}`), m: at(`effectMiscValue${n}`), b: at(`effectBasePoints${n}`) }));
  const reagents = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [at(`reagent${n}`), at(`reagentCount${n}`)]);
  const creates = [1, 2, 3].map((n) => at(`effectItemType${n}`));
  const triggers = [1, 2, 3].map((n) => at(`effectTriggerSpell${n}`));
  // detailed spell-page columns (wowhead-style): combat stats + per-effect breakdown
  const iSub = at("nameSubtext"), iSchool = at("school"), iPower = at("powerType");
  const iMana = at("manaCost"), iManaPct = at("manaCostPercentage");
  const iCast = at("castingTimeIndex"), iRange = at("rangeIndex"), iDur = at("durationIndex");
  const iRec = at("recoveryTime"), iCatRec = at("categoryRecoveryTime"), iGcd = at("startRecoveryTime");
  const iProc = at("procChance"), iDispel = at("dispel"), iMech = at("mechanic"), iLvl = at("spellLevel");
  const iAttr = at("attributes"), iEx = at("attributesEx"), iEx2 = at("attributesEx2"), iEx3 = at("attributesEx3"), iEx4 = at("attributesEx4");
  const effType = [1, 2, 3].map((n) => at(`effect${n}`));
  const effRadius = [1, 2, 3].map((n) => at(`effectRadiusIndex${n}`));
  const effAmp = [1, 2, 3].map((n) => at(`effectAmplitude${n}`));

  db.exec(`CREATE TABLE spells (
    entry INTEGER PRIMARY KEY, name TEXT, description TEXT, auraDescription TEXT, spellIconId INTEGER,
    icon TEXT, skill INTEGER, rank TEXT, school INTEGER, power_type INTEGER,
    mana_cost INTEGER, mana_cost_pct INTEGER, cast_ms INTEGER, channeled INTEGER,
    range_min REAL, range_max REAL, range_name TEXT, duration_ms INTEGER,
    cooldown_ms INTEGER, cat_cooldown_ms INTEGER, gcd_ms INTEGER, proc_chance INTEGER,
    dispel INTEGER, mechanic INTEGER, spell_level INTEGER,
    attr INTEGER, attr_ex INTEGER, attr_ex2 INTEGER, attr_ex3 INTEGER, attr_ex4 INTEGER,
    effects TEXT, s1 INTEGER, s2 INTEGER, s3 INTEGER, d1 INTEGER, d2 INTEGER, d3 INTEGER)`);
  db.exec(`CREATE TABLE spell_creates (spell INTEGER, item INTEGER, skill INTEGER, skill_req INTEGER, skill_min INTEGER, skill_max INTEGER)`);
  db.exec(`CREATE TABLE spell_reagent (spell INTEGER, item INTEGER, count INTEGER)`);
  const sSpell = db.prepare(`INSERT OR REPLACE INTO spells (
    entry, name, description, auraDescription, spellIconId, icon, skill, rank, school, power_type,
    mana_cost, mana_cost_pct, cast_ms, channeled, range_min, range_max, range_name, duration_ms,
    cooldown_ms, cat_cooldown_ms, gcd_ms, proc_chance, dispel, mechanic, spell_level,
    attr, attr_ex, attr_ex2, attr_ex3, attr_ex4, effects, s1, s2, s3, d1, d2, d3
  ) VALUES (${Array(37).fill("?").join(",")})`);
  const sCreate = db.prepare(`INSERT INTO spell_creates VALUES (?,?,?,?,?,?)`);
  const sReag = db.prepare(`INSERT INTO spell_reagent VALUES (?,?,?)`);
  let ns = 0, nc = 0, nr = 0;
  db.transaction(() => {
    for (const row of srcRows("spell_template", "tw_world_spell_template.sql")) {
      const e = clean(row[iEntry]);
      // $sN in spell text resolves to basePoints+1 (.. +dieSides for ranges)
      const s = bp.map((bi, k) => (clean(row[bi]) || 0) + 1);
      const d = ds.map((di) => clean(row[di]) || 0);
      const iconId = clean(row[iIcon]);
      const sk = spellSkill.get(e);

      // ---- detailed spell-page fields ----
      // resolve DBC index columns to real values via the committed lookups
      const cast_ms = spellLookups.castTime[clean(row[iCast])] ?? null;
      const rng = spellLookups.range[clean(row[iRange])];
      const duration_ms = spellLookups.duration[clean(row[iDur])] ?? null;
      const attrEx = clean(row[iEx]) || 0;
      // CHANNELED_1 (0x4) | CHANNELED_2 (0x40)
      const channeled = (attrEx & 0x44) ? 1 : 0;
      const rank = clean(row[iSub]) || null;
      // per-effect breakdown (only effects that do something), as JSON
      const effJson = [];
      for (let k = 0; k < 3; k++) {
        const ef = clean(row[effType[k]]) || 0;
        const au = clean(row[effIdx[k].a]) || 0;
        if (!ef && !au) continue;
        effJson.push({
          i: k + 1, effect: ef, aura: au, value: s[k], die: d[k],
          misc: clean(row[effIdx[k].m]) || 0,
          radius: spellLookups.radius[clean(row[effRadius[k]])] ?? null,
          period: clean(row[effAmp[k]]) || 0,
        });
      }

      sSpell.run(e, clean(row[iName]), clean(row[iDesc]), clean(row[iAura]), iconId,
        spellIconMap[iconId] || null, sk ? sk.skill : null,
        rank, clean(row[iSchool]), clean(row[iPower]),
        clean(row[iMana]), clean(row[iManaPct]), cast_ms, channeled,
        rng ? rng.min : null, rng ? rng.max : null, rng ? rng.name : null, duration_ms,
        clean(row[iRec]), clean(row[iCatRec]), clean(row[iGcd]), clean(row[iProc]),
        clean(row[iDispel]), clean(row[iMech]), clean(row[iLvl]),
        clean(row[iAttr]), attrEx, clean(row[iEx2]), clean(row[iEx3]), clean(row[iEx4]),
        effJson.length ? JSON.stringify(effJson) : null,
        s[0], s[1], s[2], d[0], d[1], d[2]);
      ns++;
      // derive gear stats from this spell's effect auras (for item_stats)
      const effects = effIdx.map((f) => ({ aura: clean(row[f.a]) || 0, misc: clean(row[f.m]) || 0, base: clean(row[f.b]) || 0 }));
      const st = statsFromAuras(effects);
      if (Object.keys(st).length) spellStats.set(e, st);
      let madeItem = false;
      for (const ci of creates) {
        const item = clean(row[ci]);
        if (item) { sCreate.run(e, item, sk ? sk.skill : null, sk ? sk.req : null, sk ? sk.min : null, sk ? sk.max : null); madeItem = true; nc++; }
      }
      // Item-less crafts (enchanting): the recipe applies an enchant (effect 53
      // ENCHANT_ITEM / 54 ENCHANT_ITEM_TEMPORARY) directly to gear rather than
      // producing an item, so effectItemType is never set. Record an item=NULL row
      // (skill thresholds from skill_line_ability) so the craft still lists in the
      // Crafting view -- otherwise ~all enchanting formulas would be missing.
      if (!madeItem && sk && effJson.some((x) => x.effect === 53 || x.effect === 54)) {
        sCreate.run(e, null, sk.skill, sk.req, sk.min, sk.max); nc++;
      }
      for (const [ri, rc] of reagents) {
        const item = clean(row[ri]);
        if (item) { sReag.run(e, item, clean(row[rc]) || 1); nr++; }
      }
      // record learn-spell -> craft chains (triggered craft spell -> [learn spells])
      for (let k = 0; k < 3; k++) {
        const t = clean(row[triggers[k]]);
        if (!t) continue;
        const a = spellTriggers.get(t); if (a) a.push(e); else spellTriggers.set(t, [e]);
        // a genuine "learn" spell (effect 36 = LEARN_SPELL) teaches its trigger target
        if ((clean(row[effType[k]]) || 0) === 36 && !learnTeaches.has(e)) learnTeaches.set(e, t);
      }
    }
  })();
  db.exec(`CREATE INDEX idx_spell_creates_item ON spell_creates(item)`);
  db.exec(`CREATE INDEX idx_spell_creates_spell ON spell_creates(spell)`);
  db.exec(`CREATE INDEX idx_spell_reagent_item ON spell_reagent(item)`);
  db.exec(`CREATE INDEX idx_spell_reagent_spell ON spell_reagent(spell)`);
  console.log(`  spells: ${ns} | creates: ${nc} | reagents: ${nr}`);
}

// ---- Crafting source: trainer-taught vs recipe-item-taught ----
// For each craft spell, record whether it can be learned from a trainer and the
// recipe/pattern/plans item (if any) that teaches it. Runs after items + spells.
console.log("Deriving craft sources...");
{
  // spells a trainer can teach: union of npc_trainer (per-NPC) and the shared
  // npc_trainer_template pools. Map to the trainer's required skill (the "orange"
  // skill level), keeping the highest value seen.
  const trainerSkill = new Map();
  for (const [file, table] of [
    ["tw_world_npc_trainer.sql", "npc_trainer"],
    ["tw_world_npc_trainer_template.sql", "npc_trainer_template"],
  ]) {
    const cols = srcColumns(table, file);
    const iSpell = cols.indexOf("spell"), iReq = cols.indexOf("reqskillvalue");
    for (const r of srcRows(table, file)) {
      const sp = clean(r[iSpell]);
      if (!sp) continue;
      const req = clean(r[iReq]) || 0;
      if (!trainerSkill.has(sp) || req > trainerSkill.get(sp)) trainerSkill.set(sp, req);
    }
  }

  // recipe items (class 9: Recipe/Pattern/Plans/Schematic/Formula/Book) reference a
  // spell in one of their spellid slots — usually a "learn" spell that triggers the
  // real craft, occasionally the craft spell itself. Map that referenced spell -> item,
  // and remember each recipe item's required skill rank (its "orange" level).
  const slots = [1, 2, 3, 4, 5];
  const itemBySpell = new Map();
  const itemRank = new Map();
  const recipeRows = db.prepare(
    `SELECT entry, required_skill_rank, ${slots.map((n) => `spellid_${n}`).join(", ")} FROM items WHERE class = 9`).all();
  for (const r of recipeRows) {
    itemRank.set(r.entry, r.required_skill_rank || 0);
    for (const n of slots) {
      const sp = r[`spellid_${n}`];
      if (sp > 0 && !itemBySpell.has(sp)) itemBySpell.set(sp, r.entry);
    }
  }
  // the spells that "stand in" for a craft when checking trainer/recipe sources: the
  // craft spell itself plus any learn spell that triggers it (the indirection both
  // trainers and recipe items use).
  const learnersOf = (spell) => [spell, ...(spellTriggers.get(spell) || [])];
  const recipeFor = (spell) => { for (const s of learnersOf(spell)) if (itemBySpell.has(s)) return itemBySpell.get(s); return null; };
  const trainerReq = (spell) => { let r = null; for (const s of learnersOf(spell)) if (trainerSkill.has(s)) r = Math.max(r ?? 0, trainerSkill.get(s)); return r; };

  // learn_req is the recipe's "orange" skill: where it first becomes learnable. The
  // skill_line_ability req is unreliable here (mostly 1), so prefer the recipe item's
  // required rank, then the trainer's required skill; fall back at query time.
  db.exec(`CREATE TABLE craft_source (spell INTEGER PRIMARY KEY, trainer INTEGER DEFAULT 0, recipe_item INTEGER, auto INTEGER DEFAULT 0, learn_req INTEGER)`);
  const insCs = db.prepare(`INSERT OR REPLACE INTO craft_source VALUES (?,?,?,?,?)`);
  // includes item-less enchant crafts (item IS NULL) so they resolve a trainer/recipe source too.
  const craftSpells = db.prepare(`SELECT DISTINCT spell FROM spell_creates`).all();
  let ncs = 0, nrec = 0, ntr = 0;
  db.transaction(() => {
    for (const { spell } of craftSpells) {
      const recipe = recipeFor(spell);
      const tReq = trainerReq(spell);
      const trainer = tReq != null ? 1 : 0;
      const learnReq = recipe != null ? (itemRank.get(recipe) || null) : tReq;
      if (recipe) nrec++;
      if (trainer) ntr++;
      insCs.run(spell, trainer, recipe, craftAuto.get(spell) || 0, learnReq);
      ncs++;
    }
  })();
  db.exec(`CREATE INDEX idx_craft_source_spell ON craft_source(spell)`);
  console.log(`  craft_source: ${ncs} spells (trainer: ${ntr}, recipe: ${nrec}, recipe pool: ${itemBySpell.size})`);

  // Flag "learn" spells: a recipe's Use-effect spell whose only job is to teach the
  // real craft spell (which it triggers). They duplicate the craft's name, carry no
  // reagents/result, and would otherwise show as a confusing twin in search/browse.
  // spells.teaches = the craft spell taught -> excluded from FTS/browse, and the
  // recipe item's "Teaches you how to craft X" link points at the craft, not this stub.
  db.exec(`ALTER TABLE spells ADD COLUMN teaches INTEGER`);
  {
    const setTeaches = db.prepare(`UPDATE spells SET teaches = ? WHERE entry = ?`);
    let n = 0;
    db.transaction(() => {
      for (const { spell } of db.prepare(`SELECT spell FROM craft_source`).all()) {
        for (const learner of (spellTriggers.get(spell) || [])) { setTeaches.run(spell, learner); n++; }
      }
    })();
    db.exec(`CREATE INDEX idx_spells_teaches ON spells(teaches)`);
    console.log(`  learn spells flagged (teaches set): ${n}`);
  }
}

// ---- Spell teach sources (which spells a player can learn, and from where) ----
// Trainers: npc_trainer (per-creature) + npc_trainer_template (shared pools linked
// by creature_template.trainer_id). Books: items whose Use "learn" spell triggers
// the taught spell (same indirection recipes use). Powers the spell page's
// "Learnable" badge + "Trained by" / "Taught by item" tabs.
console.log("Deriving spell teach sources...");
{
  const addTo = (map, k, v) => { let s = map.get(k); if (!s) map.set(k, s = new Set()); s.add(v); };
  // trainers/books reference the "learn" spell; resolve to the real player spell.
  const real = (s) => learnTeaches.get(s) ?? s;
  // spell -> teaching creature entries (direct npc_trainer rows)
  const trainerNpcs = new Map();
  {
    const cols = srcColumns("npc_trainer", "tw_world_npc_trainer.sql");
    const iE = cols.indexOf("entry"), iSp = cols.indexOf("spell");
    for (const r of srcRows("npc_trainer", "tw_world_npc_trainer.sql")) {
      const sp = clean(r[iSp]), e = clean(r[iE]);
      if (sp && e) addTo(trainerNpcs, real(sp), e);
    }
  }
  // template id -> spells; then expand onto creatures referencing that trainer_id
  const tmplSpells = new Map();
  {
    const cols = srcColumns("npc_trainer_template", "tw_world_npc_trainer_template.sql");
    const iE = cols.indexOf("entry"), iSp = cols.indexOf("spell");
    for (const r of srcRows("npc_trainer_template", "tw_world_npc_trainer_template.sql")) {
      const t = clean(r[iE]), sp = clean(r[iSp]);
      if (t && sp) addTo(tmplSpells, t, sp);
    }
  }
  {
    const cols = srcColumns("creature_template", "tw_world_creature_template.sql");
    const iE = cols.indexOf("entry"), iT = cols.indexOf("trainer_id");
    for (const r of srcRows("creature_template", "tw_world_creature_template.sql")) {
      const t = clean(r[iT]); if (!t) continue;
      const spells = tmplSpells.get(t); if (!spells) continue;
      const e = clean(r[iE]);
      for (const sp of spells) addTo(trainerNpcs, real(sp), e);
    }
  }
  db.exec(`CREATE TABLE spell_trainer (spell INTEGER, npc INTEGER)`);
  const insST = db.prepare(`INSERT INTO spell_trainer VALUES (?,?)`);
  let nst = 0;
  db.transaction(() => { for (const [sp, set] of trainerNpcs) for (const e of set) { insST.run(sp, e); nst++; } })();
  db.exec(`CREATE INDEX idx_spell_trainer_spell ON spell_trainer(spell)`);

  // book/tome/recipe items: an item's Use LEARN_SPELL effect teaches a spell.
  db.exec(`CREATE TABLE spell_taught_item (spell INTEGER, item INTEGER)`);
  const insTI = db.prepare(`INSERT INTO spell_taught_item VALUES (?,?)`);
  let nti = 0;
  db.transaction(() => {
    for (const it of db.prepare(`SELECT entry, spellid_1, spellid_2, spellid_3, spellid_4, spellid_5 FROM items`).all()) {
      const seen = new Set();
      for (const n of [1, 2, 3, 4, 5]) {
        const t = it[`spellid_${n}`] && learnTeaches.get(it[`spellid_${n}`]);
        if (t && !seen.has(t)) { seen.add(t); insTI.run(t, it.entry); nti++; }
      }
    }
  })();
  db.exec(`CREATE INDEX idx_spell_taught_item_spell ON spell_taught_item(spell)`);

  // learnable flag (taught by a trainer or a book) for the page badge + browse hint
  db.exec(`ALTER TABLE spells ADD COLUMN learnable INTEGER DEFAULT 0`);
  db.exec(`UPDATE spells SET learnable = 1 WHERE entry IN (SELECT spell FROM spell_trainer) OR entry IN (SELECT spell FROM spell_taught_item)`);
  console.log(`  spell_trainer: ${nst} | spell_taught_item: ${nti}`);
}

// ---- Quests + quest link tables (items, creature/GO objectives, rep rewards) ----
console.log("Importing quests + quest links...");
{
  const c = srcColumns("quest_template", "tw_world_quest_template.sql");
  const at = (name) => c.indexOf(name);
  const cols = {
    entry: at("entry"), title: at("Title"), zone: at("ZoneOrSort"), type: at("Type"),
    min: at("MinLevel"), level: at("QuestLevel"),
    reqclasses: at("RequiredClasses"), reqraces: at("RequiredRaces"),
    reqskill: at("RequiredSkill"), reqskillvalue: at("RequiredSkillValue"),
    details: at("Details"), objectives: at("Objectives"),
    requesttext: at("RequestItemsText"), offertext: at("OfferRewardText"), endtext: at("EndText"),
    money: at("RewOrReqMoney"), xp: at("RewXP"), rewspell: at("RewSpell"),
    srcitem: at("SrcItemId"), prevquest: at("PrevQuestId"), nextquest: at("NextQuestId"),
  };
  const objText = [1, 2, 3, 4].map((n) => at(`ObjectiveText${n}`));
  const reqItem = [1, 2, 3, 4].map((n) => [at(`ReqItemId${n}`), at(`ReqItemCount${n}`)]);
  const srcItem = [1, 2, 3, 4].map((n) => [at(`ReqSourceId${n}`), at(`ReqSourceCount${n}`)]);
  const rewItem = [1, 2, 3, 4].map((n) => [at(`RewItemId${n}`), at(`RewItemCount${n}`)]);
  const choiceItem = [1, 2, 3, 4, 5, 6].map((n) => [at(`RewChoiceItemId${n}`), at(`RewChoiceItemCount${n}`)]);
  const reqCreature = [1, 2, 3, 4].map((n) => [at(`ReqCreatureOrGOId${n}`), at(`ReqCreatureOrGOCount${n}`)]);
  const repReward = [1, 2, 3, 4, 5].map((n) => [at(`RewRepFaction${n}`), at(`RewRepValue${n}`)]);

  db.exec(`CREATE TABLE quests (entry INTEGER PRIMARY KEY, title TEXT, zone INTEGER, type INTEGER,
    minlevel INTEGER, level INTEGER, reqclasses INTEGER, reqraces INTEGER, reqskill INTEGER, reqskillvalue INTEGER,
    details TEXT, objectives TEXT, requesttext TEXT, offertext TEXT, endtext TEXT, objtext TEXT,
    money INTEGER, xp INTEGER, rewspell INTEGER, srcitem INTEGER, prevquest INTEGER, nextquest INTEGER)`);
  db.exec(`CREATE TABLE quest_item (quest INTEGER, item INTEGER, role TEXT, count INTEGER)`);
  db.exec(`CREATE TABLE quest_creature_objective (quest INTEGER, target INTEGER, is_go INTEGER, count INTEGER)`);
  db.exec(`CREATE TABLE quest_reward_rep (quest INTEGER, faction INTEGER, value INTEGER)`);
  const sQ = db.prepare(`INSERT OR REPLACE INTO quests VALUES (${Array(22).fill("?").join(",")})`);
  const sQI = db.prepare(`INSERT INTO quest_item VALUES (?,?,?,?)`);
  const sCO = db.prepare(`INSERT INTO quest_creature_objective VALUES (?,?,?,?)`);
  const sRep = db.prepare(`INSERT INTO quest_reward_rep VALUES (?,?,?)`);
  let nq = 0, nqi = 0, nco = 0, nrep = 0;
  const addItems = (e, pairs, role, row) => {
    for (const [ii, ci] of pairs) {
      const item = clean(row[ii]);
      if (item) { sQI.run(e, item, role, ci >= 0 ? clean(row[ci]) || 1 : 1); nqi++; }
    }
  };
  db.transaction(() => {
    for (const row of srcRows("quest_template", "tw_world_quest_template.sql")) {
      const e = clean(row[cols.entry]);
      const ot = objText.map((i) => clean(row[i])).filter((s) => s && String(s).trim()).join("\n") || null;
      sQ.run(
        e, clean(row[cols.title]), clean(row[cols.zone]), clean(row[cols.type]),
        clean(row[cols.min]), clean(row[cols.level]), clean(row[cols.reqclasses]), clean(row[cols.reqraces]),
        clean(row[cols.reqskill]), clean(row[cols.reqskillvalue]),
        clean(row[cols.details]), clean(row[cols.objectives]), clean(row[cols.requesttext]),
        clean(row[cols.offertext]), clean(row[cols.endtext]), ot,
        clean(row[cols.money]), clean(row[cols.xp]), clean(row[cols.rewspell]),
        clean(row[cols.srcitem]), clean(row[cols.prevquest]), clean(row[cols.nextquest]),
      );
      nq++;
      addItems(e, reqItem, "req", row);
      addItems(e, srcItem, "source", row);
      addItems(e, rewItem, "reward", row);
      addItems(e, choiceItem, "choice", row);
      for (const [ii, ci] of reqCreature) {
        const id = clean(row[ii]);
        if (id) { sCO.run(e, Math.abs(id), id < 0 ? 1 : 0, clean(row[ci]) || 1); nco++; }
      }
      for (const [fi, vi] of repReward) {
        const fac = clean(row[fi]), val = clean(row[vi]);
        if (fac && val) { sRep.run(e, fac, val); nrep++; }
      }
    }
  })();
  db.exec(`CREATE INDEX idx_quest_item_item ON quest_item(item)`);
  db.exec(`CREATE INDEX idx_quest_item_quest ON quest_item(quest)`);
  db.exec(`CREATE INDEX idx_qco_quest ON quest_creature_objective(quest)`);
  db.exec(`CREATE INDEX idx_qco_target ON quest_creature_objective(target)`);
  db.exec(`CREATE INDEX idx_qrr_quest ON quest_reward_rep(quest)`);
  db.exec(`CREATE INDEX idx_quests_zone ON quests(zone)`);
  db.exec(`CREATE INDEX idx_quests_level ON quests(level)`);
  db.exec(`CREATE INDEX idx_quests_type ON quests(type)`);
  console.log(`  quests: ${nq} | items: ${nqi} | creature/GO objectives: ${nco} | rep rewards: ${nrep}`);
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

  // Only keep "Taught by item" rows for items a player can actually obtain. Many
  // spell tomes are unobtainable dev placeholders with mislabeled spellids (e.g.
  // the "Tome of Mana Shield" items point at the learn-Blizzard spell), so an item
  // with no real source must not be presented as a teach source. Then recompute
  // the learnable flag from the surviving trainer + book sources.
  const before = db.prepare(`SELECT COUNT(*) c FROM spell_taught_item`).get().c;
  db.exec(`DELETE FROM spell_taught_item WHERE item NOT IN (SELECT item FROM item_sources WHERE source <> 'unobtainable')`);
  db.exec(`UPDATE spells SET learnable = (entry IN (SELECT spell FROM spell_trainer) OR entry IN (SELECT spell FROM spell_taught_item))`);
  const after = db.prepare(`SELECT COUNT(*) c FROM spell_taught_item`).get().c;
  console.log(`  spell_taught_item: ${after} obtainable (dropped ${before - after} unobtainable)`);
}

// ---- Factions summary (reputation feature) ----
// One row per faction that gates >=1 item (items.required_reputation_faction) OR
// grants reputation via a quest (quest_reward_rep). Counts power the browse list
// + detail header without runtime aggregation.
console.log("Deriving factions...");
{
  db.exec(`CREATE TABLE factions (id INTEGER PRIMARY KEY, name TEXT, listid INTEGER, items INTEGER, repquests INTEGER)`);
  db.exec(`INSERT INTO factions (id, name, listid, items, repquests)
    SELECT fn.id, fn.name1, fn.reputation_list_id,
           (SELECT COUNT(*) FROM items i WHERE i.required_reputation_faction = fn.id) AS items,
           (SELECT COUNT(DISTINCT r.quest) FROM quest_reward_rep r WHERE r.faction = fn.id) AS repquests
    FROM faction_names fn
    WHERE EXISTS (SELECT 1 FROM items i WHERE i.required_reputation_faction = fn.id)
       OR EXISTS (SELECT 1 FROM quest_reward_rep r WHERE r.faction = fn.id)`);
  const n = db.prepare(`SELECT COUNT(*) c FROM factions`).get().c;
  console.log(`  factions: ${n} rows`);
}

// ---- Zones (committed bounds/images from the client) + spawn points ----
// zones.json (areaId -> WorldMapArea bounds + image dims) is extracted from the
// client by scripts/extract-maps.py and committed; spawn_points are built here
// from the SQL dumps (which carry position_x/y per spawn). The zone page filters
// spawns to a zone by point-in-rectangle against the zone's world bounds.
console.log("Importing zones + spawn points...");
{
  db.exec(`CREATE TABLE zones (areaid INTEGER PRIMARY KEY, name TEXT, mapid INTEGER, dir TEXT,
    locleft REAL, locright REAL, loctop REAL, locbottom REAL, img_w INTEGER, img_h INTEGER, spawns INTEGER)`);
  const zf = join(ROOT, "scripts", "data", "zones.json");
  if (existsSync(zf)) {
    const zones = JSON.parse(readFileSync(zf, "utf8"));
    const nameOf = db.prepare(`SELECT name FROM areas WHERE entry = ?`);
    const sZ = db.prepare(`INSERT OR REPLACE INTO zones
      (areaid,name,mapid,dir,locleft,locright,loctop,locbottom,img_w,img_h) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let nz = 0;
    db.transaction(() => {
      for (const z of zones) {
        const a = nameOf.get(z.areaId);
        sZ.run(z.areaId, (a && a.name) || z.dir, z.mapId, z.dir,
          z.locleft, z.locright, z.loctop, z.locbottom, z.w, z.h);
        nz++;
      }
    })();
    console.log(`  zones: ${nz}`);
  } else {
    console.log("  (no zones.json -- run scripts/extract-maps.py for the zone maps)");
  }

  db.exec(`CREATE TABLE spawn_points (kind TEXT, id INTEGER, map INTEGER, x REAL, y REAL)`);
  const sSp = db.prepare(`INSERT INTO spawn_points VALUES (?,?,?,?,?)`);
  const loadSpawns = (file, table, kind) => {
    const cols = srcColumns(table, file);
    const iId = cols.indexOf("id"), iMap = cols.indexOf("map"), iX = cols.indexOf("position_x"), iY = cols.indexOf("position_y");
    let n = 0;
    db.transaction(() => {
      for (const row of srcRows(table, file)) {
        sSp.run(kind, clean(row[iId]), clean(row[iMap]), clean(row[iX]), clean(row[iY]));
        n++;
      }
    })();
    return n;
  };
  const nc = loadSpawns("tw_world_creature.sql", "creature", "c");
  const ngo = src.has("gameobject") ? loadSpawns("tw_world_gameobject.sql", "gameobject", "o") : 0;
  db.exec(`CREATE INDEX idx_spawn_map ON spawn_points(map)`);
  db.exec(`CREATE INDEX idx_spawn_id ON spawn_points(kind, id)`); // NPC-page zone lookup
  console.log(`  spawn_points: ${nc} creatures + ${ngo} objects`);

  // precompute per-zone spawn count (point-in-rectangle) for the browse list
  db.exec(`UPDATE zones SET spawns = (SELECT COUNT(*) FROM spawn_points s
    WHERE s.map = zones.mapid AND s.x BETWEEN zones.locbottom AND zones.loctop
      AND s.y BETWEEN zones.locright AND zones.locleft)`);
}

// staging tables have served their purpose; drop them so VACUUM reclaims the
// space (they hold the full raw mangos rows, much larger than the viewer tables).
src.drop();

// ---- Full-text search over item / creature / quest names (unified search) ----
console.log("Building FTS indexes...");
db.exec(`CREATE VIRTUAL TABLE items_fts USING fts5(name, content='items', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO items_fts(rowid, name) SELECT entry, name FROM items`);
db.exec(`CREATE VIRTUAL TABLE creatures_fts USING fts5(name, content='creatures', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO creatures_fts(rowid, name) SELECT entry, name FROM creatures WHERE name IS NOT NULL AND name <> ''`);
db.exec(`CREATE VIRTUAL TABLE quests_fts USING fts5(title, content='quests', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO quests_fts(rowid, title) SELECT entry, title FROM quests WHERE title IS NOT NULL AND title <> ''`);
db.exec(`CREATE VIRTUAL TABLE spells_fts USING fts5(name, description, content='spells', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO spells_fts(rowid, name, description) SELECT entry, name, description FROM spells WHERE name IS NOT NULL AND name <> '' AND teaches IS NULL`);

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
