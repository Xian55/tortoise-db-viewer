// Build a single SQLite file from the Tortoise-WoW SQL dumps.
// Output: public/data/tortoise.sqlite  (queried in-browser via sql.js-httpvfs)
//
// Usage:  SQL_DIR=X:/Programming/tortoise-wow/sql/base node scripts/build-db.mjs
// Default SQL_DIR assumes the server repo sits next to this one.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseColumns, iterRows, NULL } from "./lib/sqldump.mjs";
import { IMPORTS, LOOT_TABLES, LOOT_COLUMNS } from "./lib/schema.mjs";
import { openDatabase, RUNTIME } from "./lib/sqlite.mjs";
import { statsFromColumns, statsFromAuras } from "./lib/itemstats.mjs";
import { buildStaging } from "./lib/staging.mjs";
import { buildCmangosStaging } from "./lib/cmangos-adapter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL_DIR = process.env.SQL_DIR || join(ROOT, "..", "tortoise-wow", "sql", "base");
// Server world migrations (applied on top of the base dump, exactly as mangosd
// does at runtime). Sibling of SQL_DIR; override with UPDATES_DIR. Absent = the
// build falls back to base-only (older server repos without database_updates).
const UPDATES_DIR = process.env.UPDATES_DIR || join(SQL_DIR, "..", "database_updates");
// Output subdir under public/ (default "data"). The dev-dataset build sets
// DATA_SUBDIR=data-dev so the 1181dev DB lands beside the main one on R2.
const DATA_SUBDIR = process.env.DATA_SUBDIR || "data";
// Data source: "turtle" (default) stages Turtle's MySQL dumps + migrations from
// SQL_DIR; "cmangos" reads cmangos's published Classic SQLite DB (CMANGOS_DB) via
// lib/cmangos-adapter.mjs instead. See notes/plan-content-origin-and-variants.md.
const SQL_SOURCE = process.env.SQL_SOURCE || "turtle";
const CMANGOS_DB = process.env.CMANGOS_DB || "C:/Users/poler/Downloads/classic-sqlite-db/classicmangos.sqlite";
// Single DB file, fetched whole by the browser and loaded into sqlite-wasm.
// GitHub Pages gzips it on the wire (~27 MB -> ~8.6 MB), decompressed by the browser.
const OUT = join(ROOT, "public", DATA_SUBDIR, "tortoise.sqlite");

if (SQL_SOURCE === "cmangos") {
  if (!existsSync(CMANGOS_DB)) { console.error(`CMANGOS_DB not found: ${CMANGOS_DB}`); process.exit(1); }
} else if (!existsSync(SQL_DIR)) {
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

function colType(name, textSet, realSet) {
  if (textSet.has(name)) return "TEXT";
  if (realSet && realSet.has(name)) return "REAL";
  return "INTEGER";
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
  area_template: "entry", spell_template: "entry", creature_onkill_reputation: "creature_id",
  page_text: "entry",
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
  add("collection_mount", "tw_world_collection_mount.sql"); // Turtle: itemId -> real mount spell
  // NPC ability sources (-> creature_ability). creature_spells is the shared spell
  // list creature_template.spell_list_id points at; the EventAI pair resolves a
  // scripted cast (creature_ai_events.actionN_script -> creature_ai_scripts command 15).
  add("creature_spells", "tw_world_creature_spells.sql");
  add("creature_ai_events", "tw_world_creature_ai_events.sql");
  add("creature_ai_scripts", "tw_world_creature_ai_scripts.sql");
  return specs;
})();

console.log(`Staging raw tables (source: ${SQL_SOURCE})...`);
const src = SQL_SOURCE === "cmangos"
  ? buildCmangosStaging(db, CMANGOS_DB, STAGE_SPECS)
  : buildStaging(db, SQL_DIR, UPDATES_DIR, STAGE_SPECS);
console.log(SQL_SOURCE === "cmangos"
  ? `  staged ${STAGE_SPECS.length} tables from cmangos | mapped ${src.stats.applied}, DBC-filled: ${src.stats.dbc.join(", ") || "none"}, empty: ${src.stats.empty.join(", ") || "none"}`
  : `  staged ${STAGE_SPECS.length} tables | migrations: ${src.stats.files} files, ${src.stats.applied} applied, ${src.stats.skipped} skipped, ${src.stats.errors} errors`);

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
  const realSet = new Set(spec.real);

  const defs = cols.map((c) =>
    c === spec.pk ? `\`${c}\` INTEGER PRIMARY KEY` : `\`${c}\` ${colType(c, textSet, realSet)}`
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

// Restore items.food_type from the BASE dump. Migrations that REPLACE an item row
// without the Turtle-specific `food_type` column null it out (staging applies them
// before this import), so the staged value is unreliable. The base dump is authoritative
// for pet-food type (1 Meat, 2 Fish, 3 Cheese, 4 Bread, 5 Fungus, 6 Fruit, 7 Raw Meat,
// 8 Raw Fish) -> powers the Hunter Pets diet links (?browse=items&food=N).
// Turtle-only: the cmangos dataset has no base dump file (built from a SQLite DB).
if (SQL_SOURCE !== "cmangos" && existsSync(join(SQL_DIR, "tw_world_item_template.sql"))) {
  const dump = read("tw_world_item_template.sql");
  const cols = parseColumns(dump);
  const iE = cols.indexOf("entry"), iF = cols.indexOf("food_type");
  if (iF >= 0) {
    const upd = db.prepare("UPDATE items SET food_type = ? WHERE entry = ?");
    let n = 0;
    db.transaction(() => {
      for (const r of iterRows(dump, "item_template")) {
        const ft = clean(r[iF]);
        if (ft) { upd.run(ft, clean(r[iE])); n++; }
      }
    })();
    console.log(`  food_type restored: ${n} food items`);
  }
}

// creature_template.display_id1 is the creature's default model (always nonzero
// in the dump). Expose it as `display_id` -- the key for Wowhead's pre-rendered
// model thumbnail (render.js modelThumbUrl). display_id2..4 are unused here.
db.exec("ALTER TABLE creatures RENAME COLUMN display_id1 TO display_id");

// Hunter-pet fields (creature_template.beast_family + type_flags). `pet_family` is
// the CreatureFamily id (0 = not a pet family); `tameable` is the TAMEABLE bit of
// type_flags (0x1). Together they drive the Hunter Pets section (src/pets.js) and
// the "Tameable · <family>" badge on the NPC page. type_flags is only needed to
// derive `tameable`, so it's dropped after (keeps the shipped row narrow).
db.exec("ALTER TABLE creatures RENAME COLUMN beast_family TO pet_family");
db.exec("ALTER TABLE creatures ADD COLUMN tameable INTEGER NOT NULL DEFAULT 0");
db.exec("UPDATE creatures SET tameable = 1 WHERE (type_flags & 1) <> 0");
db.exec("ALTER TABLE creatures DROP COLUMN type_flags");
db.exec("CREATE INDEX idx_creatures_pet_family ON creatures(pet_family) WHERE tameable = 1");
// Peer cohort for the NPC Stats tab's "vs. typical" column (Q_NPC_PEERS): every
// creature of the same level + rank. Without it that query full-scans creatures.
db.exec("CREATE INDEX idx_creatures_peer ON creatures(level_max, rank)");

// Melee/ranged damage: the server multiplies the template's dmg_min/dmg_max by
// dmg_multiplier when it builds the creature (Creature::SelectLevel ->
// SetBaseWeaponDamage, then StatSystem's damage calc), so fold it in here and drop
// the multiplier -- the stored numbers are then what the mob actually hits for
// (before the per-rank rate.damage.* config mod, which we can't see, exactly like
// health_min/health_max already ignores rate.health.*). Rounded to 1 decimal -- the
// raw dump values carry meaningless float precision (19.837, 14.868877, ...).
db.exec(`UPDATE creatures SET
    dmg_min = ROUND(dmg_min * dmg_multiplier, 1), dmg_max = ROUND(dmg_max * dmg_multiplier, 1),
    ranged_dmg_min = ROUND(ranged_dmg_min * dmg_multiplier, 1), ranged_dmg_max = ROUND(ranged_dmg_max * dmg_multiplier, 1)`);
db.exec("ALTER TABLE creatures DROP COLUMN dmg_multiplier");

// Creature faction alignment (team): resolve creature_template.faction ->
// faction_template.our_mask (0x2 = Alliance, 0x4 = Horde). Lets the UI tag which
// side an NPC serves -- e.g. which faction can use a profession trainer. 0 =
// neutral/monster, 1 = Alliance, 2 = Horde, 3 = both (shared city guards, etc).
db.exec("ALTER TABLE creatures ADD COLUMN team INTEGER NOT NULL DEFAULT 0");
{
  const ftCols = srcColumns("faction_template", "tw_world_faction_template.sql");
  const iId = ftCols.indexOf("id"), iMask = ftCols.indexOf("our_mask");
  const upd = db.prepare("UPDATE creatures SET team = ? WHERE faction = ?");
  db.transaction(() => {
    for (const r of srcRows("faction_template", "tw_world_faction_template.sql")) {
      const om = clean(r[iMask]) || 0;
      const a = om & 2, h = om & 4;
      const team = a && h ? 3 : a ? 1 : h ? 2 : 0;
      if (team) upd.run(team, clean(r[iId]));
    }
  })();
  const na = db.prepare("SELECT COUNT(*) n FROM creatures WHERE team=1").get().n;
  const nh = db.prepare("SELECT COUNT(*) n FROM creatures WHERE team=2").get().n;
  console.log(`  creature team: ${na} Alliance, ${nh} Horde`);
}

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
  // A creature spawn can roll one of up to 4 template ids (Turtle random-pick
  // slots); count each distinct non-zero id so NPCs that only ever appear as an
  // id2/3/4 alternate still get a spawn (else ~210 creatures have no location).
  const idCols = ["id", "id2", "id3", "id4"].map((c) => cc.indexOf(c)).filter((i) => i >= 0);
  const iMap = cc.indexOf("map");
  // spawn count per (creature, map) — cnt=1 marks a unique spawn (a boss heuristic)
  const counts = new Map();
  for (const r of srcRows("creature", "tw_world_creature.sql")) {
    const map = clean(r[iMap]);
    const seen = new Set();
    for (const i of idCols) {
      const id = clean(r[i]);
      if (!id || seen.has(id)) continue; // skip 0/null + within-row dupes
      seen.add(id);
      const k = `${id}:${map}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
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

// ---- Script-spawned instance bosses -> their dungeon/raid map ----
// Some instance bosses/adds are placed by the server's C++ instance scripts, not by a
// static `creature` spawn row, so the SQL dump has no location for them (no `spawns`,
// no `spawn_points`). extract-instance-bosses.mjs reads the ScriptDev2 source (LOCAL;
// CI has no server src) and writes scripts/data/instance-bosses.json = [{e,m},...]
// mapping such a creature entry to the instance map it's scripted into. Lets the
// character upgrade finder (qInstanceDropsIn) still name "Razorfen Downs · Tuten'kash"
// for a boss the spawn tables can't locate. Absent file => empty table (feature falls
// back to spawn-based sources only).
console.log("Loading instance bosses...");
{
  db.exec(`CREATE TABLE creature_instance (entry INTEGER, map INTEGER)`);
  const f = join(ROOT, "scripts", "data", "instance-bosses.json");
  let n = 0;
  if (existsSync(f)) {
    const rows = JSON.parse(readFileSync(f, "utf8"));
    const ins = db.prepare(`INSERT INTO creature_instance VALUES (?,?)`);
    db.transaction(() => {
      for (const r of rows) { ins.run(r.e, r.m); n++; }
    })();
  }
  db.exec(`CREATE INDEX idx_creature_instance_entry ON creature_instance(entry)`);
  console.log(`  creature_instance: ${n}${n ? "" : " (scripts/data/instance-bosses.json absent)"}`);
}

// "Sold by" reverse lookup (Q_SOLD_BY): the query ORs c.entry (PK, indexed) with
// c.vendor_id IN (shared vendor template). Indexing vendor_id lets the planner do a
// MULTI-INDEX OR instead of scanning every creature per item.
db.exec(`CREATE INDEX idx_creatures_vendor_id ON creatures(vendor_id)`);

// ---- Recommended level range per instance (dungeons/raids) ----
// map_template carries no level field, so derive a band from each instance's elite
// (rank>=1) creatures, weighted by spawn count: lo = 10th percentile of their min
// levels, hi = 90th percentile of their max levels. The percentiles strip stray low
// critters / over-level bosses, tracking the known classic ranges within a couple
// levels, and it auto-covers Turtle-custom instances (no hardcoded table to maintain).
console.log("Deriving instance level ranges...");
{
  db.exec(`ALTER TABLE maps ADD COLUMN min_level INTEGER`);
  db.exec(`ALTER TABLE maps ADD COLUMN max_level INTEGER`);
  const pct = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
  const rows = db.prepare(`
    SELECT s.map AS map, c.level_min AS lo, c.level_max AS hi, s.cnt AS cnt
    FROM spawns s JOIN creatures c ON c.entry = s.id JOIN maps m ON m.id = s.map
    WHERE m.type IN (1, 2) AND c.level_min > 0 AND c.rank >= 1`).all();
  const byMap = new Map();
  for (const r of rows) {
    let e = byMap.get(r.map);
    if (!e) byMap.set(r.map, e = { los: [], his: [] });
    const w = Math.min(r.cnt, 10); // cap weight so a single swarm can't dominate
    for (let k = 0; k < w; k++) { e.los.push(r.lo); e.his.push(r.hi); }
  }
  const upd = db.prepare(`UPDATE maps SET min_level = ?, max_level = ? WHERE id = ?`);
  let nlvl = 0;
  db.transaction(() => {
    for (const [map, e] of byMap) {
      const lo = pct(e.los, 10), hi = pct(e.his, 90);
      if (lo != null && hi != null) { upd.run(lo, Math.max(lo, hi), map); nlvl++; }
    }
  })();
  console.log(`  instance level ranges: ${nlvl}`);
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
    for (const r of db.prepare(`SELECT entry, item, chance, groupid, mincountOrRef, maxcount FROM ${t}`).all()) {
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
  // Combine an item's chance from independent sources as a probabilistic OR
  // (1-∏(1-p)), never a sum -- a creature drawing the same item from several
  // reference pools must not exceed 100% (e.g. Colossus of Zora was 166%).
  const orProb = (a, b) => 1 - (1 - a) * (1 - b);
  // Merge a drop into `result` (item -> {p, min, max}): probability OR-combines, the
  // stack range widens (min = smallest, max = largest count seen across sources).
  function combine(result, item, p, min, max) {
    const cur = result.get(item);
    if (!cur) result.set(item, { p, min, max });
    else { cur.p = orProb(cur.p, p); cur.min = Math.min(cur.min, min); cur.max = Math.max(cur.max, max); }
  }
  function addRow(result, row, prob) {
    if (prob <= 0) return;
    if (row.mincountOrRef < 0) {
      const refId = -row.mincountOrRef;
      if (refSize(refId) > REF_THRESHOLD) return; // skip world-drop pools
      for (const [item, r] of resolveRef(refId)) combine(result, item, r.p * prob, r.min, r.max);
    } else if (row.item > 0) {
      const min = row.mincountOrRef > 0 ? row.mincountOrRef : 1;      // stack size (1 if unset)
      const max = row.maxcount > 0 ? Math.max(min, row.maxcount) : min;
      combine(result, row.item, prob, min, max);
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

  db.exec(`CREATE TABLE drops (src TEXT, owner INTEGER, item INTEGER, chance REAL, mincount INTEGER, maxcount INTEGER)`);
  const ins = db.prepare(`INSERT INTO drops VALUES (?,?,?,?,?,?)`);
  const sources = [["c", "loot_creature"], ["s", "loot_skinning"], ["p", "loot_pickpocket"],
    ["o", "loot_object"], ["i", "loot_item"], ["e", "loot_disenchant"]];
  let nd = 0;
  db.transaction(() => {
    for (const [src, table] of sources) {
      for (const [owner, rows] of load(table)) {
        for (const [item, r] of resolveRows(rows)) { ins.run(src, owner, item, r.p * 100, r.min, r.max); nd++; }
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
  // skill_id -> { cat, name } from the client SkillLine.dbc (committed JSON), used to
  // categorize spells for the browse filter (class skill / profession / weapon / ...).
  const skillLines = (() => {
    const f = join(ROOT, "scripts", "data", "skill-lines.json");
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  })();
  // Map a skill's category id (+ name) to a viewer filter bucket. Cat 9 mixes
  // secondary professions (First Aid/Fishing/Cooking) with the "X Racial" lines.
  const catLabel = (skillId) => {
    const sl = skillLines[skillId];
    if (!sl) return null;
    switch (sl.cat) {
      case 6: return "Weapon Skills";
      case 7: return "Class Skills";
      case 8: return "Armor Proficiencies";
      case 9: return /racial/i.test(sl.name) ? "Racial Traits" : "Secondary Skills";
      case 10: return "Languages";
      case 11: return "Professions";
      default: return null; // generic/unknown -> uncategorized
    }
  };

  const spellSkill = new Map();
  {
    const sc = srcColumns("skill_line_ability", "tw_world_skill_line_ability.sql");
    const iSp = sc.indexOf("spell_id"), iSk = sc.indexOf("skill_id"), iRq = sc.indexOf("req_skill_value");
    const iMin = sc.indexOf("min_value"), iMax = sc.indexOf("max_value"), iLearn = sc.indexOf("learn_on_get_skill");
    const iCls = sc.indexOf("class_mask");
    for (const r of srcRows("skill_line_ability", "tw_world_skill_line_ability.sql")) {
      const sp = clean(r[iSp]);
      // min_value/max_value are the yellow/grey skill-up thresholds (green is their
      // midpoint); kept so the crafting view can color recipe difficulty.
      if (!spellSkill.has(sp)) spellSkill.set(sp, { skill: clean(r[iSk]), req: clean(r[iRq]), min: clean(r[iMin]), max: clean(r[iMax]), classMask: clean(r[iCls]) || 0 });
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
  const iStances = at("stances"); // shapeshift-form mask -> marks druid-form-only ("feral") AP
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
    effects TEXT, s1 INTEGER, s2 INTEGER, s3 INTEGER, d1 INTEGER, d2 INTEGER, d3 INTEGER,
    category TEXT, class_mask INTEGER)`);
  db.exec(`CREATE TABLE spell_creates (spell INTEGER, item INTEGER, skill INTEGER, skill_req INTEGER, skill_min INTEGER, skill_max INTEGER)`);
  db.exec(`CREATE TABLE spell_reagent (spell INTEGER, item INTEGER, count INTEGER)`);
  const sSpell = db.prepare(`INSERT OR REPLACE INTO spells (
    entry, name, description, auraDescription, spellIconId, icon, skill, rank, school, power_type,
    mana_cost, mana_cost_pct, cast_ms, channeled, range_min, range_max, range_name, duration_ms,
    cooldown_ms, cat_cooldown_ms, gcd_ms, proc_chance, dispel, mechanic, spell_level,
    attr, attr_ex, attr_ex2, attr_ex3, attr_ex4, effects, s1, s2, s3, d1, d2, d3,
    category, class_mask
  ) VALUES (${Array(39).fill("?").join(",")})`);
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
        s[0], s[1], s[2], d[0], d[1], d[2],
        sk ? catLabel(sk.skill) : null, sk ? sk.classMask : 0);
      ns++;
      // derive gear stats from this spell's effect auras (for item_stats)
      const effects = effIdx.map((f) => ({ aura: clean(row[f.a]) || 0, misc: clean(row[f.m]) || 0, base: clean(row[f.b]) || 0 }));
      const st = statsFromAuras(effects, {}, clean(row[iName]), clean(row[iStances]) || 0);
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

  // Resolve CROSS-spell description tokens ($<id>s<n> / $<id>d<n>) -- a spell's
  // text can reference another spell's value (e.g. Cheat Death's "$28846s1" = 160).
  // The viewer's resolveSpellText only knows the spell's own $s1 tokens, so bake
  // the cross-refs here using every spell's s/d values. Own-spell $s1 stays for render.
  {
    const vals = new Map();
    for (const r of db.prepare(`SELECT entry, s1, s2, s3, d1, d2, d3, duration_ms FROM spells`).all()) vals.set(r.entry, r);
    const valStr = (s, d) => (d > 1 ? `${s} to ${s + d - 1}` : String(s ?? 0));
    const durStr = (ms) => (ms ? `${Number.isInteger(ms / 1000) ? ms / 1000 : (ms / 1000).toFixed(1)} sec` : "");
    const fix = (t) => {
      if (!t) return t;
      return t
        // scaled cross-spell refs: $/10;27418s2 = spell 27418's s2 / 10, $*N;<id>sM likewise
        .replace(/\$\/(\d+);(\d+)s([123])/gi, (m, div, id, n) => { const r = vals.get(+id); return r ? valStr(Math.round((r[`s${n}`] || 0) / (+div)), 0) : m; })
        .replace(/\$\*(\d+);(\d+)s([123])/gi, (m, mul, id, n) => { const r = vals.get(+id); return r ? valStr(Math.round((r[`s${n}`] || 0) * (+mul)), 0) : m; })
        // $<id>s<n> (or bare $<id>s = effect 1): referenced spell's effect base value
        .replace(/\$(\d+)s([123]?)/gi, (m, id, n) => { const r = vals.get(+id); if (!r) return m; const k = n || 1; return valStr(r[`s${k}`] || 0, r[`d${k}`] || 0); })
        // $<id>d : referenced spell's duration (no index)
        .replace(/\$(\d+)d(?![0-9])/gi, (m, id) => { const r = vals.get(+id); return r ? durStr(r.duration_ms || 0) : m; })
        // drop any remaining unresolvable cross-spell tokens ($<id>a1, $<id>o1, ...)
        // so they don't render as literal garbage (render strips $<letter> but not $<digit>)
        .replace(/\$\d+[a-zA-Z]\d*%?/g, "");
    };
    const upd = db.prepare(`UPDATE spells SET description = ?, auraDescription = ? WHERE entry = ?`);
    let nfix = 0;
    db.transaction(() => {
      for (const r of db.prepare(`SELECT entry, description, auraDescription FROM spells WHERE description LIKE '%$%' OR auraDescription LIKE '%$%'`).all()) {
        const d = fix(r.description), a = fix(r.auraDescription);
        if (d !== r.description || a !== r.auraDescription) { upd.run(d, a, r.entry); nfix++; }
      }
    })();
    console.log(`  resolved cross-spell desc tokens in ${nfix} spells`);
  }
}

// ---- Item enchant id -> enchanting spell name ----
// GearExport (and the item DB) reference enchants by SpellItemEnchantment id, not
// by name. Map each id to the spell that applies it (effect 53 ENCHANT_ITEM / 54
// ENCHANT_ITEM_TEMPORARY, misc = the enchant id), preferring a clean-named recipe
// over QA/Test twins. Powers the character sheet's per-slot enchant label.
console.log("Deriving item enchants...");
{
  db.exec(`CREATE TABLE item_enchant (id INTEGER PRIMARY KEY, spell INTEGER, name TEXT)`);
  const best = new Map(); // enchantId -> { spell, name, clean }
  for (const r of db.prepare(`SELECT entry, name, effects FROM spells WHERE effects LIKE '%"effect":53%' OR effects LIKE '%"effect":54%'`).all()) {
    let effs; try { effs = JSON.parse(r.effects); } catch { continue; }
    for (const e of effs) {
      if ((e.effect === 53 || e.effect === 54) && e.misc > 0) {
        const clean = !/^(qa|test)\b/i.test(r.name || "");
        const cur = best.get(e.misc);
        // prefer a clean-named spell; among equals, the lowest entry
        if (!cur || (clean && !cur.clean) || (clean === cur.clean && r.entry < cur.spell)) {
          best.set(e.misc, { spell: r.entry, name: r.name, clean });
        }
      }
    }
  }
  const ins = db.prepare(`INSERT OR REPLACE INTO item_enchant VALUES (?,?,?)`);
  db.transaction(() => { for (const [id, v] of best) ins.run(id, v.spell, v.name); })();
  console.log(`  item_enchant: ${best.size}`);
}

// ---- Random-suffix ("of the Bear", ...) id -> name + stats ----
// GearExport reports a rolled item's random-property id (item link's suffixId).
// The name + stat bonuses live in the client ItemRandomProperties/SpellItemEnchantment
// DBCs (absent from the SQL dump), extracted locally to scripts/data/random-suffix.json
// (extract-random-suffix.py). Absent file => empty table (the site shows the base item).
console.log("Loading random suffixes...");
{
  db.exec(`CREATE TABLE random_suffix (id INTEGER PRIMARY KEY, name TEXT, stats TEXT)`);
  const f = join(ROOT, "scripts", "data", "random-suffix.json");
  let n = 0;
  if (existsSync(f)) {
    const map = JSON.parse(readFileSync(f, "utf8"));
    const ins = db.prepare(`INSERT OR REPLACE INTO random_suffix VALUES (?,?,?)`);
    db.transaction(() => {
      for (const [id, v] of Object.entries(map)) {
        ins.run(+id, v.suffix || v.name || "", JSON.stringify(v.stats || {}));
        n++;
      }
    })();
  }
  console.log(`  random_suffix: ${n}${n ? "" : " (scripts/data/random-suffix.json absent)"}`);
}

// ---- Which items can roll which random suffixes ----
// item_template.RandomProperty (>0) indexes a pool in item_enchantment_template
// (entry -> ench + chance), where each ench is an ItemRandomProperties id (a suffix).
// Keep only the pools real items reference and enchants that resolved to a stat
// suffix, so the item page can show "can roll: of the Bear (+7 Sta/+8 Str), …".
console.log("Building random-suffix pools...");
{
  db.exec(`CREATE TABLE suffix_pool (entry INTEGER, ench INTEGER, chance REAL)`);
  const groups = new Set(db.prepare(`SELECT DISTINCT random_property FROM items WHERE random_property > 0`).all().map((r) => r.random_property));
  const known = new Set(db.prepare(`SELECT id FROM random_suffix`).all().map((r) => r.id));
  let n = 0;
  if (groups.size && known.size) {
    const cols = srcColumns("item_enchantment_template", "tw_world_item_enchantment_template.sql");
    const iE = cols.indexOf("entry"), iN = cols.indexOf("ench"), iC = cols.indexOf("chance");
    const ins = db.prepare(`INSERT INTO suffix_pool VALUES (?,?,?)`);
    db.transaction(() => {
      for (const r of srcRows("item_enchantment_template", "tw_world_item_enchantment_template.sql")) {
        const e = clean(r[iE]), ench = clean(r[iN]);
        if (groups.has(e) && known.has(ench)) { ins.run(e, ench, clean(r[iC]) || 0); n++; }
      }
    })();
  }
  db.exec(`CREATE INDEX idx_suffix_pool_entry ON suffix_pool(entry)`);
  // flag items that can roll a stat suffix (their pool has at least one known suffix)
  db.exec(`ALTER TABLE items ADD COLUMN rolls_suffix INTEGER NOT NULL DEFAULT 0`);
  db.exec(`UPDATE items SET rolls_suffix = 1 WHERE random_property > 0 AND random_property IN (SELECT DISTINCT entry FROM suffix_pool)`);
  const ni = db.prepare(`SELECT COUNT(*) n FROM items WHERE rolls_suffix = 1`).get().n;
  console.log(`  suffix_pool: ${n} rows | ${ni} items can roll a suffix`);
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
  db.exec(`CREATE INDEX idx_spell_trainer_npc ON spell_trainer(npc)`); // Q_NPC_TRAINS (per trainer NPC page)

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

// ---- NPC abilities (the spells a creature casts at you) ----
// Four independent sources in the world DB, unioned into one `creature_ability`
// table so the NPC page can list them wowhead-style:
//   't' creature_template.spell_id1..4  -- the classic four fixed slots
//   'l' creature_template.spell_list_id -> creature_spells (the shared list Turtle
//       prefers; carries cast probability + repeat cooldown, the latter in seconds)
//   'e' EventAI: creature_ai_events.action{1,2,3}_script -> creature_ai_scripts rows
//       with command 15 (SCRIPT_COMMAND_CAST_SPELL), datalong = the spell id
//   'a' creature_template.auras -- a comma list of passive auras the mob spawns with
// Rows whose spell isn't in the shipped `spells` table are dropped (nothing to show),
// so this runs after the spells import. (creature, spell) is unique; the first source
// to claim a pair wins in the order above, so a listed spell keeps its probability.
console.log("Deriving NPC abilities...");
{
  db.exec(`CREATE TABLE creature_ability (
    creature INTEGER NOT NULL, spell INTEGER NOT NULL, src TEXT NOT NULL,
    prob INTEGER, cd_min INTEGER, cd_max INTEGER, ord INTEGER, -- cd_* in SECONDS
    PRIMARY KEY (creature, spell)) WITHOUT ROWID`);
  const ins = db.prepare(`INSERT OR IGNORE INTO creature_ability VALUES (?,?,?,?,?,?,?)`);
  const known = new Set(db.prepare(`SELECT entry FROM spells WHERE name <> ''`).all().map((r) => r.entry));
  const add = (creature, spell, src, prob, cdMin, cdMax, ord) => {
    if (!spell || !known.has(spell)) return 0;
    ins.run(creature, spell, src, prob ?? null, cdMin ?? null, cdMax ?? null, ord);
    return 1;
  };
  let nl = 0, nt = 0, ne = 0, na = 0, ncpp = 0;

  // 'l' -- shared spell lists, keyed by creature_template.spell_list_id.
  const lists = new Map(); // listId -> [{spell, prob, cdMin, cdMax, ord}]
  if (src.has("creature_spells")) {
    const c = src.columns("creature_spells");
    const at = (n) => c.indexOf(n);
    const slots = [];
    for (let k = 1; ; k++) {
      const i = at(`spellId_${k}`);
      if (i < 0) break;
      slots.push({ id: i, prob: at(`probability_${k}`), lo: at(`delayRepeatMin_${k}`), hi: at(`delayRepeatMax_${k}`) });
    }
    for (const r of src.rows("creature_spells")) {
      const out = [];
      slots.forEach((s, k) => {
        const sp = Number(r[s.id]) || 0;
        if (!sp) return;
        // The server stores these timers as SECONDS (ObjectMgr multiplies by
        // IN_MILLISECONDS on load) and clamps an out-of-range probability to 100.
        const p = Number(r[s.prob]) || 0;
        out.push({
          spell: sp, prob: p > 0 && p <= 100 ? p : 100,
          cdMin: Number(r[s.lo]) || null, cdMax: Number(r[s.hi]) || null, ord: k,
        });
      });
      if (out.length) lists.set(Number(r[c.indexOf("entry")]), out);
    }
  }
  db.transaction(() => {
    for (const cr of db.prepare(`SELECT entry, spell_list_id FROM creatures WHERE spell_list_id <> 0`).all()) {
      for (const s of lists.get(cr.spell_list_id) || []) nl += add(cr.entry, s.spell, "l", s.prob, s.cdMin, s.cdMax, s.ord);
    }
  })();

  // 't' -- the four fixed template slots.
  db.transaction(() => {
    for (const cr of db.prepare(`SELECT entry, spell_id1, spell_id2, spell_id3, spell_id4 FROM creatures
        WHERE spell_id1 <> 0 OR spell_id2 <> 0 OR spell_id3 <> 0 OR spell_id4 <> 0`).all()) {
      for (const k of [1, 2, 3, 4]) nt += add(cr.entry, cr[`spell_id${k}`], "t", null, null, null, k - 1);
    }
  })();

  // 'l' (cmangos) -- creature_spell_list is row-per-spell instead of 8 fixed slots,
  // keyed by the same creature_template.SpellList. Availability is the cast chance in
  // %, and its repeat timers are MILLISECONDS (Turtle's are seconds) -> normalize.
  if (src.has("creature_spell_list")) {
    const c = src.columns("creature_spell_list");
    const at = (n) => c.indexOf(n);
    const [iId, iPos, iSp, iAv, iLo, iHi] = ["Id", "Position", "SpellId", "Availability", "RepeatMin", "RepeatMax"].map(at);
    for (const r of src.rows("creature_spell_list")) {
      const list = Number(r[iId]), sp = Number(r[iSp]) || 0;
      if (!list || !sp) continue;
      if (!lists.has(list)) lists.set(list, []);
      const av = Number(r[iAv]) || 0;
      lists.get(list).push({
        spell: sp, prob: av > 0 && av <= 100 ? av : 100,
        cdMin: Math.round(Number(r[iLo]) / 1000) || null, cdMax: Math.round(Number(r[iHi]) / 1000) || null,
        ord: Number(r[iPos]) || 0,
      });
    }
    db.transaction(() => {
      for (const cr of db.prepare(`SELECT entry, spell_list_id FROM creatures WHERE spell_list_id <> 0`).all()) {
        for (const s of lists.get(cr.spell_list_id) || []) nl += add(cr.entry, s.spell, "l", s.prob, s.cdMin, s.cdMax, s.ord);
      }
    })();
  }

  // 't' (cmangos) -- the template slots live in their own table (spell1..spell10).
  if (src.has("creature_template_spells")) {
    const c = src.columns("creature_template_spells");
    const iE = c.indexOf("entry");
    const slots = c.map((n, i) => (/^spell\d+$/.test(n) ? i : -1)).filter((i) => i >= 0);
    db.transaction(() => {
      for (const r of src.rows("creature_template_spells")) {
        const cr = Number(r[iE]);
        if (cr) slots.forEach((i, k) => { nt += add(cr, Number(r[i]) || 0, "t", null, null, null, k); });
      }
    })();
  }

  // 'e' -- EventAI: event row -> action script id -> the CAST_SPELL commands in it.
  if (src.has("creature_ai_events") && src.has("creature_ai_scripts")) {
    const sc = src.columns("creature_ai_scripts");
    const iId = sc.indexOf("id"), iCmd = sc.indexOf("command"), iSpell = sc.indexOf("datalong");
    const byScript = new Map(); // script id -> [spell]
    for (const r of src.rows("creature_ai_scripts")) {
      if (Number(r[iCmd]) !== 15) continue;
      const id = Number(r[iId]), sp = Number(r[iSpell]) || 0;
      if (!sp) continue;
      if (!byScript.has(id)) byScript.set(id, []);
      byScript.get(id).push(sp);
    }
    const ec = src.columns("creature_ai_events");
    const iCr = ec.indexOf("creature_id");
    const actions = ["action1_script", "action2_script", "action3_script"].map((n) => ec.indexOf(n)).filter((i) => i >= 0);
    db.transaction(() => {
      for (const r of src.rows("creature_ai_events")) {
        const cr = Number(r[iCr]);
        if (!cr) continue;
        for (const ai of actions) {
          for (const sp of byScript.get(Number(r[ai])) || []) ne += add(cr, sp, "e", null, null, null, 0);
        }
      }
    })();
  }

  // 'e' (cmangos) -- same EventAI data, but flattened: cmangos' `creature_ai_scripts`
  // IS the event table (Turtle's same-named table is dbscripts, handled above), with
  // the actions inline. action type 11 = ACTION_T_CAST, param1 = the spell.
  if (src.has("creature_ai_scripts") && (src.columns("creature_ai_scripts") || []).includes("action1_type")) {
    const c = src.columns("creature_ai_scripts");
    const iCr = c.indexOf("creature_id");
    const acts = [1, 2, 3].map((k) => [c.indexOf(`action${k}_type`), c.indexOf(`action${k}_param1`)])
      .filter(([t, p]) => t >= 0 && p >= 0);
    db.transaction(() => {
      for (const r of src.rows("creature_ai_scripts")) {
        const cr = Number(r[iCr]);
        if (!cr) continue;
        for (const [t, p] of acts) if (Number(r[t]) === 11) ne += add(cr, Number(r[p]) || 0, "e", null, null, null, 0);
      }
    })();
  }

  // 'c' -- ScriptDev2 C++ fights. A boss whose fight lives in code has no spell list,
  // no template slots and no EventAI events, so it listed nothing at all (Ragnaros,
  // Nefarian, Onyxia...). scripts/data/script-abilities.json maps
  // creature_template.script_name -> the spell ids that script hardcodes; see
  // scripts/extract-script-abilities.mjs. Turtle only: cmangos' ScriptName refers to
  // its own, separate C++ implementations, so attributing Turtle's spells there would
  // be a guess (and cmangos covers those fights with EventAI anyway).
  if (SQL_SOURCE !== "cmangos") {
    const f = join(ROOT, "scripts", "data", "script-abilities.json");
    if (existsSync(f)) {
      const map = JSON.parse(readFileSync(f, "utf8"));
      db.transaction(() => {
        for (const cr of db.prepare(`SELECT entry, script_name FROM creatures WHERE script_name IS NOT NULL AND script_name <> ''`).all()) {
          (map[cr.script_name] || []).forEach((sp, k) => { ncpp += add(cr.entry, sp, "c", null, null, null, k); });
        }
      })();
    } else {
      console.warn("  script-abilities.json missing -- C++ boss abilities skipped");
    }
  }

  // 'a' -- passive auras (a space/comma-separated spell id list). Turtle carries them
  // on creature_template.auras; cmangos in creature_template_addon.
  const addAuras = (entry, list) => {
    String(list ?? "").split(/[\s,]+/).forEach((s, k) => { na += add(entry, Number(s) || 0, "a", null, null, null, k); });
  };
  db.transaction(() => {
    for (const cr of db.prepare(`SELECT entry, auras FROM creatures WHERE auras IS NOT NULL AND auras <> ''`).all()) addAuras(cr.entry, cr.auras);
  })();
  if (src.has("creature_template_addon")) {
    const c = src.columns("creature_template_addon");
    const iE = c.indexOf("entry"), iA = c.indexOf("auras");
    if (iE >= 0 && iA >= 0) db.transaction(() => {
      for (const r of src.rows("creature_template_addon")) if (r[iA]) addAuras(Number(r[iE]), r[iA]);
    })();
  }

  db.exec(`CREATE INDEX idx_creature_ability_spell ON creature_ability(spell)`);
  // The raw source columns have served their purpose -- keep the shipped row narrow.
  for (const c of ["spell_id1", "spell_id2", "spell_id3", "spell_id4", "spell_list_id", "auras", "script_name"]) {
    db.exec(`ALTER TABLE creatures DROP COLUMN ${c}`);
  }
  const nc = db.prepare(`SELECT COUNT(DISTINCT creature) n FROM creature_ability`).get().n;
  console.log(`  creature_ability: list ${nl}, template ${nt}, eventai ${ne}, c++ ${ncpp}, auras ${na} -> ${nc} creatures`);
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
  const addItems = (e, pairs, role, row, skip) => {
    for (const [ii, ci] of pairs) {
      const item = clean(row[ii]);
      if (item && !(skip && skip.has(item))) { sQI.run(e, item, role, ci >= 0 ? clean(row[ci]) || 1 : 1); nqi++; }
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
      // ReqSourceId often duplicates ReqItemId (a mangos quirk) -> a required item
      // would wrongly show under "Provided items". Skip source rows already required.
      const reqSet = new Set(reqItem.map(([ii]) => clean(row[ii])).filter(Boolean));
      addItems(e, srcItem, "source", row, reqSet);
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
  // Reverse-lookup indexes for the spell/quest reverse relations (Q_SPELL_REWARD_QUESTS,
  // Q_QUEST_CHAIN). Without these both full-SCAN quests per call and the chain CTE builds
  // an AUTOMATIC index every invocation -- the API build's quest/spell pass dominated on it.
  db.exec(`CREATE INDEX idx_quests_rewspell ON quests(rewspell)`);
  db.exec(`CREATE INDEX idx_quests_nextquest ON quests(nextquest)`);
  db.exec(`CREATE INDEX idx_quests_prevquest ON quests(abs(prevquest))`); // chain walks abs(prevquest)
  console.log(`  quests: ${nq} | items: ${nqi} | creature/GO objectives: ${nco} | rep rewards: ${nrep}`);
}

// ---- Mounts: item -> summon spell -> summoned creature ----
// Turtle changed mounts to "add to collection" (the item's own Use spell is a
// generic dummy: 46499 "Add Mount to Collection"), so the item no longer points
// at its creature directly. The real mount spell lives in `collection_mount`
// (itemId -> spellId), and that spell carries SPELL_AURA_MOUNTED (aura 78) whose
// miscValue is the summoned creature. VANILLA/old items keep the classic mechanic
// (their own spellid_N is the mount aura spell), so we resolve BOTH paths ->
// dataset-proof (cmangos has no collection_mount, falls back to own-spell). The
// derived item_mount table + items.is_mount flag power the item/NPC pages and let
// browse categorise mounts out of the "Miscellaneous" bucket.
console.log("Deriving mounts (item -> spell -> creature)...");
{
  // spellId -> summoned creature entry, from the aura-78 (Mounted) effect misc value.
  const mountCreature = new Map();
  for (const r of db.prepare(`SELECT entry, effects FROM spells WHERE effects LIKE '%"aura":78%'`).all()) {
    for (const e of JSON.parse(r.effects)) {
      if (e.aura === 78 && e.misc) { mountCreature.set(r.entry, e.misc); break; }
    }
  }
  // itemId -> mount spellId (Turtle's collection table; empty for cmangos).
  const collectionSpell = new Map();
  if (src.has("collection_mount")) {
    const cm = src.columns("collection_mount");
    const iItem = cm.indexOf("itemId"), iSpell = cm.indexOf("spellId");
    for (const row of src.rows("collection_mount")) {
      const item = clean(row[iItem]), spell = clean(row[iSpell]);
      if (item && spell && !collectionSpell.has(item)) collectionSpell.set(item, spell);
    }
  }
  db.exec(`ALTER TABLE items ADD COLUMN is_mount INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE TABLE item_mount (item INTEGER PRIMARY KEY, spell INTEGER, creature INTEGER)`);
  const insMount = db.prepare(`INSERT OR IGNORE INTO item_mount VALUES (?,?,?)`);
  const setFlag = db.prepare(`UPDATE items SET is_mount = 1 WHERE entry = ?`);
  let nm = 0, ncr = 0;
  db.transaction(() => {
    for (const it of db.prepare(`SELECT entry, spellid_1, spellid_2, spellid_3, spellid_4, spellid_5 FROM items`).all()) {
      let spell = null, creature = null;
      // Turtle collection path first (its own spell is the dummy).
      if (collectionSpell.has(it.entry)) { spell = collectionSpell.get(it.entry); creature = mountCreature.get(spell) ?? null; }
      // Classic/own-spell path: a spellid_N that IS a mount-aura spell.
      if (creature == null) {
        for (const s of [it.spellid_1, it.spellid_2, it.spellid_3, it.spellid_4, it.spellid_5]) {
          if (s && mountCreature.has(s)) { spell = s; creature = mountCreature.get(s); break; }
        }
      }
      if (spell == null && !collectionSpell.has(it.entry)) continue; // not a mount
      insMount.run(it.entry, spell, creature); setFlag.run(it.entry); nm++;
      if (creature != null) ncr++;
    }
  })();
  db.exec(`CREATE INDEX idx_item_mount_creature ON item_mount(creature)`);
  console.log(`  mounts: ${nm} items | ${ncr} resolved to a creature`);
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
  // 'crafted' = made by a profession recipe (matches the Crafting browse). Restrict
  // to profession skill lines so a class/talent spell that spuriously references an
  // item as its effectItemType (e.g. the warlock talent "Emberstorm" -> item 868
  // Ardent Custodian) doesn't mislabel a drop as crafted.
  insSrc(`SELECT DISTINCT item, 'crafted'    FROM spell_creates WHERE skill IN (171,164,185,333,202,129,356,182,755,165,186,393,142,197)`);
  insSrc(`SELECT entry, 'pvp'                FROM items WHERE required_honor_rank > 0`);
  // Reputation-gated battleground/arena gear: an item whose required_reputation_faction
  // is a PvP faction is a PvP reward (Arathi Basin League of Arathor 509 / Defilers 510,
  // Alterac Valley Stormpike 730 / Frostwolf 729, Warsong 889 / Silverwing 890, and the
  // Turtle Blood Ring arena 1008). Catches the rep-reward pieces even when they carry no
  // honor-rank gate and aren't in a set.
  insSrc(`SELECT DISTINCT entry, 'pvp'       FROM items WHERE required_reputation_faction IN (889, 890, 509, 510, 729, 730, 1008)`);
  // Battleground reputation-reward gear: equippable items (class 2 weapon / 4 armor)
  // sold by vendors of BG rep factions -> also 'pvp'. Resolve the Faction.dbc rep id
  // -> its faction_template ids -> the vendor creatures -> their npc_vendor(_template)
  // gear. Covers all BG quartermasters: Warsong Gulch (Warsong Outriders 889 /
  // Silverwing Sentinels 890), Arathi Basin (League of Arathor 509 / Defilers 510),
  // Alterac Valley (Stormpike Guard 730 / Frostwolf Clan 729).
  {
    const PVP_REP_FACTIONS = new Set([889, 890, 509, 510, 729, 730]);
    const ftCols = srcColumns("faction_template", "tw_world_faction_template.sql");
    const iFtId = ftCols.indexOf("id"), iFaction = ftCols.indexOf("faction_id");
    const pvpFts = [];
    for (const r of srcRows("faction_template", "tw_world_faction_template.sql")) {
      if (PVP_REP_FACTIONS.has(clean(r[iFaction]))) pvpFts.push(clean(r[iFtId]));
    }
    if (pvpFts.length) {
      const inFts = pvpFts.join(",");
      insSrc(`SELECT DISTINCT nv.item, 'pvp' FROM npc_vendor nv
        JOIN creatures c ON c.entry = nv.entry AND c.faction IN (${inFts})
        JOIN items i ON i.entry = nv.item AND i.class IN (2, 4)`);
      insSrc(`SELECT DISTINCT vt.item, 'pvp' FROM npc_vendor_template vt
        JOIN creatures c ON c.vendor_id = vt.entry AND c.faction IN (${inFts})
        JOIN items i ON i.entry = vt.item AND i.class IN (2, 4)`);
    }
  }
  insSrc(`SELECT entry, 'worlddrop'          FROM items WHERE world_drop = 1`);
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

// ---- Item sets (name + set-bonus spells from the client ItemSet.dbc). Membership
// is CORRECTED against the DBC ItemID_* list below: the server dump's
// item_template.set groups some re-itemized/orphaned pieces into the wrong set
// (issue #319 -- e.g. Paladin Judgement 70517-70524 polluting set 640
// "Dreadslayer's Rampage"); the client uses ItemSet.dbc's ItemID_*, so we make it
// authoritative on items.set_id (which every set query keys on). ----
console.log("Importing item sets...");
{
  db.exec(`CREATE TABLE item_sets (id INTEGER PRIMARY KEY, name TEXT)`);
  db.exec(`CREATE TABLE item_set_bonus (setid INTEGER, threshold INTEGER, spell INTEGER)`);
  db.exec(`CREATE INDEX idx_items_set ON items(set_id)`);
  // display_id reverse lookup: Q_SAME_MODEL (item page "other versions" + API build, ×25k)
  // + kills the AUTOMATIC index the icon-list EXISTS built. req-rep faction: Q_FACTION_ITEMS.
  db.exec(`CREATE INDEX idx_items_display_id ON items(display_id)`);
  db.exec(`CREATE INDEX idx_items_req_rep_faction ON items(required_reputation_faction)`);
  // "Used by this spell" reverse lookup (Q_SPELL_USED_BY): the query ORs spellid_1..5,
  // so one index per column lets the planner do a MULTI-INDEX OR instead of scanning
  // every item per spell (the API build's spell pass was the worst offender).
  for (let k = 1; k <= 5; k++) db.exec(`CREATE INDEX idx_items_spellid_${k} ON items(spellid_${k})`);
  const f = join(ROOT, "scripts", "data", "item-sets.json");
  if (existsSync(f)) {
    const sets = JSON.parse(readFileSync(f, "utf8"));
    const sS = db.prepare(`INSERT INTO item_sets VALUES (?,?)`);
    const sB = db.prepare(`INSERT INTO item_set_bonus VALUES (?,?,?)`);
    let nset = 0, nb = 0;
    db.transaction(() => {
      for (const [id, v] of Object.entries(sets)) {
        sS.run(Number(id), v.name); nset++;
        for (const [thr, spell] of v.bonuses) { sB.run(Number(id), thr, spell); nb++; }
      }
    })();
    db.exec(`CREATE INDEX idx_item_set_bonus ON item_set_bonus(setid)`);
    console.log(`  item_sets: ${nset} sets, ${nb} bonuses`);

    // Correct items.set_id to the client ItemSet.dbc membership (authoritative).
    // Two DBC-derived passes, no name/class heuristics -- see the block comment.
    // Backward-safe: if item-sets.json has no "items" key yet, both maps are empty
    // and nothing changes. `items` = DBC ItemID_1..17 (Turtle client, so legit
    // Turtle set extensions are already included and contamination is excluded).
    const dbcSetOf = new Map();  // itemId -> its authoritative setId
    const membered = new Set();  // setIds that HAVE a non-empty DBC member list
    for (const [id, v] of Object.entries(sets)) {
      if (v.items && v.items.length) {
        membered.add(Number(id));
        for (const it of v.items) if (it) dbcSetOf.set(it, Number(id));
      }
    }
    const setTo = db.prepare(`UPDATE items SET set_id = ? WHERE entry = ?`);
    let moved = 0, detached = 0;
    db.transaction(() => {
      // Pass 1 -- DBC wins: every DBC-listed item that exists in this dataset gets
      // its authoritative set_id (fixes mis-assignments + adds untagged members).
      for (const [it, sid] of dbcSetOf) {
        const r = setTo.run(sid, it);
        if (r.changes) moved++;
      }
      // Pass 2 -- detach contamination: an item pointing at a DBC-membered set but
      // not listed in it (and not rescued by pass 1) is not a client-visible member.
      for (const { entry, set_id } of db.prepare(
        `SELECT entry, set_id FROM items WHERE set_id > 0`).all()) {
        if (membered.has(set_id) && dbcSetOf.get(entry) !== set_id) {
          setTo.run(null, entry); detached++;
        }
      }
    })();
    console.log(`  item set membership: ${moved} set_id assigned, ${detached} detached (DBC-corrected)`);
  } else {
    console.log("  (no item-sets.json -- run scripts/extract-item-sets.py)");
  }
}

// ---- PvP item-set gear (extends item_sources 'pvp') ----
// Every member of a PvP reward set is PvP-obtainable even when the row itself
// carries no honor-rank/reputation gate (many pieces don't). Detect by set NAME
// family, which is self-documenting and has no collision with PvE sets (verified
// against the full ItemSet.dbc list). Families: the Classic rank sets -- Alliance
// rare "Lieutenant Commander's" / epic "Field Marshal's", Horde rare "Champion's" /
// epic "Warlord's" (each set mixes the lower rank titles too) -- the Arathi Basin
// rep sets "The Highlander's" (League of Arathor) / "The Defiler's" (Defilers), and
// the Turtle-custom PvP brackets (Bloody Gladiator's, Combatant's, Corpsman's,
// Executor's, Field Medic's, Partisan's, Physician's, Strategist's, Tactician's,
// Veteran's), which reuse the same per-class set-suffix scheme. Must run AFTER the
// item_sets table is built. NOTE: "The Gladiator" (Dal'Rend's, a UBRS drop) is NOT
// a PvP set and is deliberately excluded.
console.log("Tagging PvP set gear...");
{
  const PVP_SET_FAMILIES = ["Champion's", "Lieutenant Commander's", "Warlord's",
    "Field Marshal's", "The Highlander's", "The Defiler's", "Bloody Gladiator's",
    "Combatant's", "Corpsman's", "Executor's", "Field Medic's", "Partisan's",
    "Physician's", "Strategist's", "Tactician's", "Veteran's"];
  const like = PVP_SET_FAMILIES.map(() => `s.name LIKE ?`).join(" OR ");
  db.prepare(`INSERT INTO item_sources
    SELECT DISTINCT i.entry, 'pvp' FROM items i JOIN item_sets s ON i.set_id = s.id
    WHERE ${like}`).run(...PVP_SET_FAMILIES.map((f) => `${f} %`));
  // An item can match more than one PvP rule (honor rank + rep + set); collapse any
  // duplicate (item, source) rows so the browse Source cell doesn't show "pvp,pvp".
  db.exec(`DELETE FROM item_sources WHERE rowid NOT IN
    (SELECT MIN(rowid) FROM item_sources GROUP BY item, source)`);
  const np = db.prepare(`SELECT COUNT(DISTINCT item) c FROM item_sources WHERE source='pvp'`).get().c;
  console.log(`  item_sources pvp: ${np} items`);
}

// Denormalize the item->sources CSV onto items. The item finder's hottest query (the
// full ~25k-row catalogue) rendered each row's source tags via a per-row correlated
// GROUP_CONCAT subquery over item_sources -- ~1/3 of that query's time (measured ~30ms
// of ~100ms). Precompute it in one build-time pass so the browse SELECT reads a column.
// MUST run after item_sources is FULLY populated -- the PvP-set block above adds 'pvp'
// rows after the main derivation. Order within the CSV is irrelevant: render.js
// sourceTags() re-sorts by SRC_ORDER.
console.log("Denormalizing item sources...");
db.exec(`ALTER TABLE items ADD COLUMN sources TEXT`);
db.exec(`UPDATE items SET sources = (SELECT GROUP_CONCAT(source, ',') FROM item_sources s WHERE s.item = items.entry)`);

// ---- Reputation per kill (grind calculator) ----
// Flatten the two-slot creature_onkill_rep into one row per (creature, faction):
// value = rep gained on kill, maxstanding = the standing index kills cap out at.
console.log("Deriving creature reputation (per-kill)...");
{
  db.exec(`CREATE TABLE creature_rep (creature INTEGER, faction INTEGER, value INTEGER, maxstanding INTEGER)`);
  db.exec(`INSERT INTO creature_rep (creature, faction, value, maxstanding)
    SELECT creature_id, RewOnKillRepFaction1, RewOnKillRepValue1, MaxStanding1
      FROM creature_onkill_rep WHERE RewOnKillRepFaction1 <> 0 AND RewOnKillRepValue1 <> 0
    UNION ALL
    SELECT creature_id, RewOnKillRepFaction2, RewOnKillRepValue2, MaxStanding2
      FROM creature_onkill_rep WHERE RewOnKillRepFaction2 <> 0 AND RewOnKillRepValue2 <> 0`);
  db.exec(`CREATE INDEX idx_creature_rep_faction ON creature_rep(faction)`);
  db.exec(`CREATE INDEX idx_creature_rep_creature ON creature_rep(creature)`);
  db.exec(`DROP TABLE creature_onkill_rep`); // raw slots consumed
  const n = db.prepare(`SELECT COUNT(*) c FROM creature_rep`).get().c;
  console.log(`  creature_rep: ${n} rows`);
}

// ---- Factions summary (reputation feature) ----
// One row per faction that gates >=1 item (items.required_reputation_faction),
// grants reputation via a quest (quest_reward_rep), OR via a mob kill
// (creature_rep). Counts power the browse list + detail header + rep calculator.
console.log("Deriving factions...");
{
  db.exec(`CREATE TABLE factions (id INTEGER PRIMARY KEY, name TEXT, listid INTEGER, items INTEGER, repquests INTEGER, repmobs INTEGER)`);
  db.exec(`INSERT INTO factions (id, name, listid, items, repquests, repmobs)
    SELECT fn.id, fn.name1, fn.reputation_list_id,
           (SELECT COUNT(*) FROM items i WHERE i.required_reputation_faction = fn.id) AS items,
           (SELECT COUNT(DISTINCT r.quest) FROM quest_reward_rep r WHERE r.faction = fn.id) AS repquests,
           (SELECT COUNT(DISTINCT cr.creature) FROM creature_rep cr WHERE cr.faction = fn.id AND cr.value > 0) AS repmobs
    FROM faction_names fn
    WHERE EXISTS (SELECT 1 FROM items i WHERE i.required_reputation_faction = fn.id)
       OR EXISTS (SELECT 1 FROM quest_reward_rep r WHERE r.faction = fn.id)
       OR EXISTS (SELECT 1 FROM creature_rep cr WHERE cr.faction = fn.id AND cr.value > 0)`);
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
  // ZONES_FILE selects a dataset-scoped parchment-bounds file (e.g.
  // zones-vanilla-cmangos.json for the cMaNGOS build); default is the Turtle set.
  const zf = process.env.ZONES_FILE
    ? (isAbsolute(process.env.ZONES_FILE) ? process.env.ZONES_FILE : join(ROOT, process.env.ZONES_FILE))
    : join(ROOT, "scripts", "data", "zones.json");
  if (existsSync(zf)) {
    const zones = JSON.parse(readFileSync(zf, "utf8"));
    const nameOf = db.prepare(`SELECT name FROM areas WHERE entry = ?`);
    const sZ = db.prepare(`INSERT OR REPLACE INTO zones
      (areaid,name,mapid,dir,locleft,locright,loctop,locbottom,img_w,img_h) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insZone = (z) => { const a = nameOf.get(z.areaId); sZ.run(z.areaId, (a && a.name) || z.dir, z.mapId, z.dir, z.locleft, z.locright, z.loctop, z.locbottom, z.w, z.h); };
    let nz = 0;
    db.transaction(() => { for (const z of zones) { insZone(z); nz++; } })();
    console.log(`  zones: ${nz}`);
    // Dungeon/raid interior FALLBACK bounds. Vanilla ships no interior parchments, so a
    // non-Turtle dataset (ZONES_FILE set) has no bounds for those pages. Merge the Turtle
    // zones.json entries on INSTANCE maps (type 1/2) the dataset lacks, so a cMaNGOS
    // dungeon page renders with bounds and the frontend falls the IMAGE back to Turtle's
    // interior parchment (config.js MAPS_BASE_MAIN). Aligns for dungeons Turtle didn't
    // re-lay; a reworked interior (Molten Core) may drift -- accepted vs no map.
    const baseZf = join(ROOT, "scripts", "data", "zones.json");
    if (process.env.ZONES_FILE && existsSync(baseZf) && baseZf !== zf) {
      const have = new Set(zones.map((z) => z.areaId));
      const instMaps = new Set(db.prepare(`SELECT id FROM maps WHERE type IN (1,2)`).all().map((r) => r.id));
      let nf = 0;
      db.transaction(() => {
        for (const z of JSON.parse(readFileSync(baseZf, "utf8"))) {
          if (have.has(z.areaId) || !instMaps.has(z.mapId)) continue;
          insZone(z); nf++;
        }
      })();
      if (nf) console.log(`  zones: +${nf} Turtle instance-interior fallback bounds`);
    }
  } else {
    console.log("  (no zones.json -- run scripts/extract-maps.py for the zone maps)");
  }

  // Assign each spawn to ONE home zone. Primary source: per-(sub)area bounding
  // boxes extracted from the client ADT terrain chunks (scripts/extract-area-bounds
  // .py -> subzone-bounds.json), which carry the REAL AreaTable id per chunk. The
  // smallest such box containing the point is its true sub-area, walked up the
  // area_template hierarchy to the render zone. This is exact -- it fixes the
  // overlap mis-assignments the loose WorldMapArea rectangles cause (Jory Zaga ->
  // Darkshore not Moonglade, Taerar -> Ashenvale not Azshara). Fallback (no ADT
  // coverage): the smallest containing WMA box.
  const boxesByMap = new Map();
  for (const z of db.prepare(`SELECT areaid, mapid, locbottom, loctop, locright, locleft FROM zones`).all()) {
    z.area = (z.loctop - z.locbottom) * (z.locleft - z.locright);
    if (!boxesByMap.has(z.mapid)) boxesByMap.set(z.mapid, []);
    boxesByMap.get(z.mapid).push(z);
  }
  const zoneSet = new Set(db.prepare(`SELECT areaid FROM zones`).all().map((r) => r.areaid));
  const zoneMapid = new Map(db.prepare(`SELECT areaid, mapid FROM zones`).all().map((r) => [r.areaid, r.mapid]));
  const areaParent = new Map(db.prepare(`SELECT entry, zone_id FROM areas`).all().map((r) => [r.entry, r.zone_id]));
  const renderZone = (aid) => {
    let c = aid, g = 0;
    while (c && g++ < 12) { if (zoneSet.has(c)) return c; const p = areaParent.get(c); if (!p || p === c) break; c = p; }
    return zoneSet.has(aid) ? aid : null;
  };
  const subByMap = new Map();
  {
    const sf = join(ROOT, "scripts", "data", "subzone-bounds.json");
    if (existsSync(sf)) {
      const sb = JSON.parse(readFileSync(sf, "utf8"));
      for (const [mid, arr] of Object.entries(sb)) {
        for (const b of arr) b.area = (b.x1 - b.x0) * (b.y1 - b.y0);
        subByMap.set(Number(mid), arr);
      }
      console.log(`  subzone-bounds: ${[...subByMap.values()].reduce((n, a) => n + a.length, 0)} area boxes / ${subByMap.size} maps`);
    } else {
      console.log("  (no subzone-bounds.json -- run scripts/extract-area-bounds.py; falling back to WMA boxes)");
    }
  }
  const homeZone = (map, x, y) => {
    if (x == null || y == null) return null;
    const subs = subByMap.get(map);
    if (subs) {
      let best = null, bestArea = Infinity;
      for (const b of subs) { if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue; if (b.area < bestArea) { bestArea = b.area; best = b; } }
      // The resolved zone must live on the spawn's own map. Some instance ADTs carry
      // a continent AreaTable id (e.g. Hateforge Quarry, map 808, has chunks tagged
      // area 46 = Redridge): without this guard those bosses get dragged onto the
      // continent zone and vanish from the dungeon map. Reject the cross-map hit and
      // fall through to the WMA box below (which only holds this map's zones).
      if (best) {
        const rz = renderZone(best.i);
        if (rz && zoneMapid.get(rz) === map) {
          // Multi-floor instances: the 2D ADT area can't tell stacked floors apart
          // (Kel'Thuzad's Upper Necropolis chunk resolves to the main Naxxramas zone),
          // so if the point isn't inside the resolved zone's OWN WMA box, prefer the
          // WMA-box search below — the per-floor boxes disambiguate by footprint.
          const bx = (boxesByMap.get(map) || []).find((z) => z.areaid === rz);
          if (!bx || (x >= bx.locbottom && x <= bx.loctop && y >= bx.locright && y <= bx.locleft)) return rz;
        }
      }
    }
    const boxes = boxesByMap.get(map);
    if (!boxes) return null;
    let best = null, bestArea = Infinity;
    for (const z of boxes) {
      if (x < z.locbottom || x > z.loctop || y < z.locright || y > z.locleft) continue;
      if (z.area > 0 && z.area < bestArea) { bestArea = z.area; best = z; }
    }
    return best ? best.areaid : null;
  };

  db.exec(`CREATE TABLE spawn_points (kind TEXT, id INTEGER, map INTEGER, x REAL, y REAL, zone INTEGER)`);
  const sSp = db.prepare(`INSERT INTO spawn_points VALUES (?,?,?,?,?,?)`);
  const loadSpawns = (file, table, kind) => {
    const cols = srcColumns(table, file);
    // Emit a point per distinct non-zero id slot. creature has id/id2/id3/id4
    // (random-pick); gameobject has only `id`, so the missing cols filter out.
    const idCols = ["id", "id2", "id3", "id4"].map((c) => cols.indexOf(c)).filter((i) => i >= 0);
    const iMap = cols.indexOf("map"), iX = cols.indexOf("position_x"), iY = cols.indexOf("position_y");
    let n = 0;
    db.transaction(() => {
      for (const row of srcRows(table, file)) {
        const map = clean(row[iMap]), x = clean(row[iX]), y = clean(row[iY]);
        const zone = homeZone(map, x, y); // shared by every id at this point
        const seen = new Set();
        for (const i of idCols) {
          const id = clean(row[i]);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          sSp.run(kind, id, map, x, y, zone);
          n++;
        }
      }
    })();
    return n;
  };
  const nc = loadSpawns("tw_world_creature.sql", "creature", "c");
  const ngo = src.has("gameobject") ? loadSpawns("tw_world_gameobject.sql", "gameobject", "o") : 0;
  db.exec(`CREATE INDEX idx_spawn_map ON spawn_points(map)`);
  db.exec(`CREATE INDEX idx_spawn_id ON spawn_points(kind, id)`); // NPC-page zone lookup
  db.exec(`CREATE INDEX idx_spawn_zone ON spawn_points(zone, kind)`); // zone-page spawns

  // Scripted transforms: some creatures never get a static `creature` row -- a server
  // C++ script (src/scripts/world/*.cpp, not ingestible SQL) swaps them in at another
  // NPC's location (e.g. the "Stave of the Ancients" demons transform in place from a
  // friendly NPC). Copy the source NPC's spawn points onto them so they still map.
  // Mapping is committed (CI has no server src/); see scripts/data/scripted-spawn-links.json.
  let nlink = 0;
  {
    const lf = join(ROOT, "scripts", "data", "scripted-spawn-links.json");
    if (existsSync(lf)) {
      const { links = {} } = JSON.parse(readFileSync(lf, "utf8"));
      const copy = db.prepare(`INSERT INTO spawn_points (kind, id, map, x, y, zone)
        SELECT 'c', ?1, map, x, y, zone FROM spawn_points INDEXED BY idx_spawn_id WHERE kind = 'c' AND id = ?2`);
      // Mirror into `spawns` (id,map,cnt) too, so Q_NPC_MAPS (map/Location label) sees them.
      const copyMap = db.prepare(`INSERT INTO spawns (id, map, cnt) SELECT ?1, map, cnt FROM spawns WHERE id = ?2`);
      db.transaction(() => {
        for (const [dst, srcId] of Object.entries(links)) {
          nlink += copy.run(Number(dst), Number(srcId)).changes ?? 0;
          copyMap.run(Number(dst), Number(srcId));
        }
      })();
    }
  }
  console.log(`  spawn_points: ${nc} creatures + ${ngo} objects${nlink ? ` (+${nlink} scripted-transform)` : ""}`);

  // precompute per-zone spawn count (home-zone membership) for the browse list
  db.exec(`UPDATE zones SET spawns = (SELECT COUNT(*) FROM spawn_points s WHERE s.zone = zones.areaid)`);

  // primary home zone per creature (the zone holding most of its spawns) -> the
  // browse-NPC Location column reads this directly (no per-row subquery at query time).
  db.exec(`ALTER TABLE creatures ADD COLUMN zone INTEGER`);
  db.exec(`UPDATE creatures SET zone = (
    SELECT s.zone FROM spawn_points s INDEXED BY idx_spawn_id
    WHERE s.kind = 'c' AND s.id = creatures.entry AND s.zone IS NOT NULL
    GROUP BY s.zone ORDER BY COUNT(*) DESC LIMIT 1)`);

  // Browsable "objects": interactive gameobjects (have loot via data1, start/end a
  // quest, or are a quest objective), grouped by name so the many per-zone copies of
  // e.g. "Copper Vein" collapse to one row. Precomputed here (the per-name spawn
  // count + EXISTS filters are ~2s over 21k objects) so ?browse=objects is instant.
  console.log("Deriving object_browse...");
  db.exec(`CREATE TABLE object_browse (entry INTEGER, name TEXT, type INTEGER, has_loot INTEGER, spawns INTEGER)`);
  db.exec(`
    INSERT INTO object_browse (entry, name, type, has_loot, spawns)
    SELECT MIN(g.entry), g.name, g.type,
      MAX(CASE WHEN EXISTS(SELECT 1 FROM drops d WHERE d.src='o' AND d.owner=g.data1) THEN 1 ELSE 0 END),
      (SELECT COUNT(*) FROM spawn_points s WHERE s.kind='o' AND s.id IN
         (SELECT g2.entry FROM gameobjects g2 WHERE g2.name = g.name))
    FROM gameobjects g
    WHERE g.name <> '' AND (
        EXISTS(SELECT 1 FROM drops d WHERE d.src='o' AND d.owner=g.data1)
     OR EXISTS(SELECT 1 FROM gameobject_quest_start q WHERE q.id=g.entry)
     OR EXISTS(SELECT 1 FROM gameobject_quest_end q WHERE q.id=g.entry)
     OR EXISTS(SELECT 1 FROM quest_creature_objective o WHERE o.is_go=1 AND o.target=g.entry)
     -- readable type-9 plaques/monuments/statues (no loot/quest link, but they show
     -- a page_text inscription on their page -- keep them browsable, incl. by type)
     OR (g.type=9 AND EXISTS(SELECT 1 FROM page_text p
           WHERE p.entry=g.data0 AND trim(p.text)<>'' AND lower(p.text)<>'missing text')))
    GROUP BY g.name`);
  db.exec(`CREATE INDEX idx_object_browse_name ON object_browse(name)`);
  console.log(`  object_browse: ${db.prepare("SELECT COUNT(*) n FROM object_browse").get().n}`);

  // Farm value: expected vendor value of a creature/object's drops per kill/gather
  // (sum of sell_price * chance). Powers the zone "best gold route" -- which spots
  // are worth farming. (Mob coin drops aren't in the server data, so this is the
  // drop value only.) Precomputed so the zone farm view is a plain join.
  console.log("Deriving farm values...");
  db.exec(`ALTER TABLE creatures ADD COLUMN loot_value REAL NOT NULL DEFAULT 0`);
  db.exec(`UPDATE creatures SET loot_value = COALESCE((
    SELECT SUM(i.sell_price * d.chance / 100.0) FROM drops d JOIN items i ON i.entry = d.item
    WHERE d.src = 'c' AND d.owner = creatures.loot_id), 0)`);
  db.exec(`ALTER TABLE gameobjects ADD COLUMN loot_value REAL NOT NULL DEFAULT 0`);
  db.exec(`UPDATE gameobjects SET loot_value = COALESCE((
    SELECT SUM(i.sell_price * d.chance / 100.0) FROM drops d JOIN items i ON i.entry = d.item
    WHERE d.src = 'o' AND d.owner = gameobjects.data1), 0)`);
  console.log(`  farm values: ${db.prepare("SELECT COUNT(*) n FROM creatures WHERE loot_value>0").get().n} mobs, ${db.prepare("SELECT COUNT(*) n FROM gameobjects WHERE loot_value>0").get().n} objects`);

  // Gather classification: mining veins / herb nodes / treasure chests are all
  // GAMEOBJECT_TYPE 3 and indistinguishable in the SQL dump. The real signal is the
  // gathering skill on the object's lock (data0 = lockId; Lock.dbc -> mining/herb),
  // dumped to scripts/data/locks.json by extract-locks.py. Absent file -> all NULL
  // (the map falls back to one "Obj: Chest" bucket).
  db.exec(`ALTER TABLE gameobjects ADD COLUMN gather TEXT`);
  const lf = join(ROOT, "scripts", "data", "locks.json");
  if (existsSync(lf)) {
    const locks = JSON.parse(readFileSync(lf, "utf8"));
    const ids = (kind) => Object.keys(locks).filter((k) => locks[k] === kind).map(Number).filter(Number.isFinite);
    const mining = ids("mining"), herb = ids("herbalism");
    if (mining.length) db.exec(`UPDATE gameobjects SET gather='mining' WHERE data0 IN (${mining.join(",")})`);
    if (herb.length) db.exec(`UPDATE gameobjects SET gather='herbalism' WHERE data0 IN (${herb.join(",")})`);
    // gather_icon: the node's primary yielded item's icon basename (Copper Vein ->
    // INV_Ore_Copper_01) so the map can draw each ore/herb's real icon. Correlated
    // subquery but only over the ~130 gather rows -> fast.
    db.exec(`ALTER TABLE gameobjects ADD COLUMN gather_icon TEXT`);
    db.exec(`UPDATE gameobjects SET gather_icon = (
      SELECT di.icon FROM drops d JOIN items it ON it.entry = d.item
        LEFT JOIN item_display_info di ON di.ID = it.display_id
      WHERE d.src = 'o' AND d.owner = gameobjects.data1 AND di.icon IS NOT NULL AND di.icon <> ''
      ORDER BY d.chance DESC LIMIT 1) WHERE gather IS NOT NULL`);
    console.log(`  gather: ${db.prepare("SELECT COUNT(*) n FROM gameobjects WHERE gather IS NOT NULL").get().n} nodes (${mining.length} mining + ${herb.length} herb locks), ${db.prepare("SELECT COUNT(*) n FROM gameobjects WHERE gather_icon IS NOT NULL").get().n} with icons`);
  } else {
    console.log("  (no scripts/data/locks.json -- run scripts/extract-locks.py; gather split disabled)");
  }

  // Validation: every instance boss (unique spawn, cnt=1) should plot inside its
  // dungeon parchment. A boss whose coords fall outside its zone's WorldMapArea
  // rectangle renders off-image. The cross-map cases are fixed by the homeZone
  // guard above; the residue is client map limits (a WMA box that doesn't cover the
  // whole interior -- Scholomance lower rooms, Naxx wings). Warn so it stays visible.
  {
    const zb = new Map();
    for (const z of db.prepare(`SELECT areaid, locleft, locright, loctop, locbottom FROM zones`).all()) zb.set(z.areaid, z);
    const rows = db.prepare(`
      SELECT sp.id, sp.x, sp.y, sp.zone, c.name
      FROM spawns s
      JOIN spawn_points sp ON sp.kind='c' AND sp.id=s.id AND sp.map=s.map
      JOIN creatures c ON c.entry=s.id
      JOIN maps m ON m.id=s.map
      WHERE m.type IN (1,2) AND s.cnt=1 AND c.name <> '' AND sp.zone IS NOT NULL`).all();
    const byBoss = new Map(); // id -> rendered-in-bounds-anywhere?
    for (const r of rows) {
      const z = zb.get(r.zone);
      const inB = z && r.x >= z.locbottom && r.x <= z.loctop && r.y >= z.locright && r.y <= z.locleft;
      const e = byBoss.get(r.id) || { name: r.name, anyIn: false };
      if (inB) e.anyIn = true;
      byBoss.set(r.id, e);
    }
    const out = [...byBoss.values()].filter((b) => !b.anyIn);
    if (out.length) console.log(`  WARN ${out.length}/${byBoss.size} instance bosses render outside their parchment bounds (client map limits): ${out.slice(0, 8).map((b) => b.name).join(", ")}${out.length > 8 ? ", …" : ""}`);
    else console.log(`  boss-bounds: all ${byBoss.size} instance bosses render in bounds`);
  }
}

// ---- Flight (taxi) network for the world map (scripts/data/taxi.json, client) ----
// Nodes + route polylines + continent bounds. Faction is derived from the flight
// graph itself -- BFS from the Alliance (Stormwind) and Horde (Orgrimmar) hubs over
// the (undirected) path edges -- which is reliable where the mount-id heuristic is
// not (neutral hubs like Booty Bay carry an Alliance mount model). Absent file =>
// no flight map (graceful); the data is committed (CI can't read the client).
{
  const tf = join(ROOT, "scripts", "data", "taxi.json");
  if (existsSync(tf)) {
    console.log("Ingesting flight network...");
    const taxi = JSON.parse(readFileSync(tf, "utf8"));
    db.exec(`CREATE TABLE taxi_nodes (id INTEGER PRIMARY KEY, map INTEGER, x REAL, y REAL, name TEXT, faction TEXT)`);
    db.exec(`CREATE TABLE taxi_pathnodes (path INTEGER, idx INTEGER, map INTEGER, x REAL, y REAL)`);
    db.exec(`CREATE TABLE taxi_continents (map INTEGER PRIMARY KEY, dir TEXT, w INTEGER, h INTEGER, locleft REAL, locright REAL, loctop REAL, locbottom REAL)`);
    // edge endpoints per path (TaxiPath) -> faction + route metadata
    db.exec(`CREATE TABLE taxi_paths (id INTEGER PRIMARY KEY, "from" INTEGER, "to" INTEGER, cost INTEGER, faction TEXT)`);
    const adj = new Map();
    const link = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); };
    for (const p of taxi.paths) { link(p.from, p.to); link(p.to, p.from); }
    const bfs = (start) => { const seen = new Set([start]); const q = [start]; while (q.length) { const n = q.shift(); for (const m of (adj.get(n) || [])) if (!seen.has(m)) { seen.add(m); q.push(m); } } return seen; };
    const byName = (re) => taxi.nodes.find((n) => re.test(n.name));
    const aSet = byName(/Stormwind/) ? bfs(byName(/Stormwind/).id) : new Set();
    const hSet = byName(/Orgrimmar/) ? bfs(byName(/Orgrimmar/).id) : new Set();
    const faction = (id) => { const a = aSet.has(id), h = hSet.has(id); return a && h ? "N" : a ? "A" : h ? "H" : "N"; };
    db.transaction(() => {
      const insN = db.prepare(`INSERT INTO taxi_nodes VALUES (?,?,?,?,?,?)`);
      for (const n of taxi.nodes) insN.run(n.id, n.map, n.x, n.y, n.name, faction(n.id));
      const insP = db.prepare(`INSERT INTO taxi_paths VALUES (?,?,?,?,?)`);
      // a path's faction = its endpoints' (both ends share a side, else neutral)
      for (const p of taxi.paths) { const f = faction(p.from) === faction(p.to) ? faction(p.from) : "N"; insP.run(p.id, p.from, p.to, p.cost, f); }
      const insW = db.prepare(`INSERT INTO taxi_pathnodes VALUES (?,?,?,?,?)`);
      for (const w of taxi.pathnodes) insW.run(w.path, w.idx, w.map, w.x, w.y);
      const insC = db.prepare(`INSERT INTO taxi_continents VALUES (?,?,?,?,?,?,?,?)`);
      for (const c of taxi.continents) insC.run(c.mapId, c.dir, c.w, c.h, c.locleft, c.locright, c.loctop, c.locbottom);
    })();
    db.exec(`CREATE INDEX idx_taxi_pathnodes ON taxi_pathnodes(path, idx)`);
    db.exec(`CREATE INDEX idx_taxi_nodes_map ON taxi_nodes(map)`);
    console.log(`  taxi: ${taxi.nodes.length} nodes (A ${aSet.size}/H ${hSet.size}), ${taxi.paths.length} paths, ${taxi.pathnodes.length} waypoints`);
  } else {
    console.log("  (no scripts/data/taxi.json -- run scripts/extract-taxi.py; flight map disabled)");
  }
}

// staging tables have served their purpose; drop them so VACUUM reclaims the
// space (they hold the full raw mangos rows, much larger than the viewer tables).
src.drop();

// ---- Flag dev/junk rows so they're hidden from browse + search (kept in the DB
// so direct links still resolve). Matches unambiguous markers only -- NOT a bare
// "test" (that hits legit "Test of Faith", "Testament of Rexxar", ...). ----
console.log("Flagging dev/junk rows...");
const JUNK = /placeholder|deprecated|cancell?ed|\bunused\b|cashtest|qaspell|\[test\]|monster\s*-\s|\s-\s*qa\b|\(old\)/i;
const flagJunk = (table, ...cols) => {
  db.exec(`ALTER TABLE ${table} ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
  const sel = `rowid AS rid, ${cols.join(", ")}`;
  const ids = db.prepare(`SELECT ${sel} FROM ${table}`).all()
    .filter((r) => cols.some((c) => r[c] && JUNK.test(r[c]))).map((r) => r.rid);
  const upd = db.prepare(`UPDATE ${table} SET hidden = 1 WHERE rowid = ?`);
  db.transaction(() => { for (const id of ids) upd.run(id); })();
  console.log(`  ${table}: ${ids.length} hidden`);
};
flagJunk("items", "name");
flagJunk("creatures", "name");
flagJunk("quests", "title");
flagJunk("spells", "name", "rank");
flagJunk("maps", "name");

// Turtle-WoW custom content flag ("not in vanilla 1.12") for items/creatures/quests,
// so the item/NPC/quest finder can isolate Turtle additions (browse.js origin filter +
// TW badge). PRIMARY source is the vanilla-ID allowlist (scripts/data/vanilla-ids.json,
// derived by extract-vanilla-ids.mjs from the cmangos Classic SQLite DB): an entry is
// custom iff its id is NOT in the canonical vanilla set. This catches Turtle additions
// that squat INSIDE the vanilla id range (e.g. items 10000-24283) and isn't fooled by
// vanilla entries with very high ids. FALLBACK (allowlist absent, e.g. not yet
// extracted) is an ID threshold placed in the empty gap above vanilla density -- clean
// for items/creatures, hence those cutoffs.
//
// SECOND signal: the `edited` set (also from vanilla-ids.json) closes the in-place
// *edit* gap the id-list alone can't see -- ids that ARE vanilla but Turtle repurposed
// or rebalanced (extract-vanilla-ids.mjs field-diffs the built DB vs cmangos). An entry
// is custom iff its id is NOT in vanilla OR it is in `edited`. Coverage per policy:
// items = name/gameplay-field diff (repurposes + rebalances); creatures/quests = name/
// title diff (repurposes only). Absent `edited` (id-list-only JSON) => allowlist behaviour.
const vanillaIdsFile = join(ROOT, "scripts", "data", "vanilla-ids.json");
const vanillaIds = existsSync(vanillaIdsFile) ? JSON.parse(readFileSync(vanillaIdsFile, "utf8")) : null;
if (vanillaIds) console.log(`  vanilla-ids: ${vanillaIds.db_version || "cmangos"} (items ${vanillaIds.items?.length}, creatures ${vanillaIds.creatures?.length}, quests ${vanillaIds.quests?.length})`);
for (const [tbl, key, cutoff] of [["items", "items", 24283], ["creatures", "creatures", 17999], ["quests", "quests", 9999]]) {
  db.exec(`ALTER TABLE ${tbl} ADD COLUMN custom INTEGER NOT NULL DEFAULT 0`);
  const ids = vanillaIds?.[key];
  if (ids?.length) {
    db.exec(`CREATE TEMP TABLE _van(id INTEGER PRIMARY KEY)`);
    const ins = db.prepare(`INSERT OR IGNORE INTO _van(id) VALUES (?)`);
    db.exec("BEGIN");
    for (const id of ids) ins.run(id);
    db.exec("COMMIT");
    db.exec(`UPDATE ${tbl} SET custom = 1 WHERE entry NOT IN (SELECT id FROM _van)`);
    db.exec(`DROP TABLE _van`);
  } else {
    db.exec(`UPDATE ${tbl} SET custom = 1 WHERE entry > ${cutoff}`); // fallback: threshold
  }
  // Union the field-diff "edited" ids (vanilla id but Turtle-modified) into the flag.
  // Only for Turtle builds: the `edited` set was diffed FROM the Turtle DB against
  // cmangos, so in the cmangos dataset those same rows ARE pristine vanilla (never custom).
  const edited = SQL_SOURCE === "cmangos" ? null : vanillaIds?.edited?.[key];
  let nEdited = 0;
  if (edited?.length) {
    db.exec(`CREATE TEMP TABLE _edited(id INTEGER PRIMARY KEY)`);
    const ins = db.prepare(`INSERT OR IGNORE INTO _edited(id) VALUES (?)`);
    db.exec("BEGIN");
    for (const id of edited) ins.run(id);
    db.exec("COMMIT");
    nEdited = db.prepare(`SELECT COUNT(*) n FROM ${tbl} WHERE custom = 0 AND entry IN (SELECT id FROM _edited)`).get().n;
    db.exec(`UPDATE ${tbl} SET custom = 1 WHERE entry IN (SELECT id FROM _edited)`);
    db.exec(`DROP TABLE _edited`);
  }
  const total = db.prepare(`SELECT COUNT(*) n FROM ${tbl} WHERE custom=1`).get().n;
  console.log(`  custom (Turtle) ${tbl}: ${total}${ids?.length ? "" : " (threshold fallback)"}${nEdited ? ` (+${nEdited} vanilla-id edits)` : ""}`);
}

// Buyable flag: item_template.buy_price is set on most items but only meaningful
// when a vendor actually sells it (~2.6k of ~20k) -- so the tooltip can show a
// "Buy Price" without implying a drop/quest item is purchasable.
db.exec(`ALTER TABLE items ADD COLUMN buyable INTEGER NOT NULL DEFAULT 0`);
db.exec(`UPDATE items SET buyable = 1 WHERE buy_price > 0 AND entry IN (
  SELECT item FROM npc_vendor UNION SELECT item FROM npc_vendor_template)`);
console.log(`  buyable items: ${db.prepare("SELECT COUNT(*) n FROM items WHERE buyable=1").get().n}`);

// Quest-reward faction lock (0 none, 1 Alliance, 2 Horde). An item is faction-
// locked when EVERY quest that rewards/offers it is one side's, none neutral --
// so the item browse can tag + filter faction-exclusive quest rewards even when
// the item itself is race-unrestricted (allowable_race = -1). Mirrors
// questFaction() in src/constants.js: RACE_ALLIANCE_ALL = 589 (77 | High Elf 512),
// RACE_HORDE_ALL = 434 (178 | Goblin 256); the two masks are bit-disjoint.
// quest_min_level = lowest MinLevel to accept a quest that rewards/offers the
// item (0 = none/available from level 1), so the browse can show the *effective*
// level to obtain a reward -- the item's own required_level is often 0 on rewards.
db.exec(`ALTER TABLE items ADD COLUMN quest_faction INTEGER NOT NULL DEFAULT 0`);
db.exec(`ALTER TABLE items ADD COLUMN quest_min_level INTEGER NOT NULL DEFAULT 0`);
{
  const A = 589, H = 434;
  const acc = new Map(); // item -> { a, h, n, min }
  for (const { item, rr, ml } of db.prepare(
    `SELECT qi.item AS item, q.reqraces AS rr, q.minlevel AS ml FROM quest_item qi
     JOIN quests q ON q.entry = qi.quest
     WHERE qi.role IN ('reward','choice') AND q.hidden = 0`).all()) {
    const ally = (rr & A) !== 0 && (rr & H) === 0;
    const horde = (rr & H) !== 0 && (rr & A) === 0;
    const e = acc.get(item) || { a: 0, h: 0, n: 0, min: Infinity };
    if (ally) e.a++; else if (horde) e.h++; else e.n++; // neutral = both/no restriction
    if (ml < e.min) e.min = ml;
    acc.set(item, e);
  }
  const upd = db.prepare(`UPDATE items SET quest_faction = ?, quest_min_level = ? WHERE entry = ?`);
  let na = 0, nh = 0;
  db.transaction(() => {
    for (const [item, e] of acc) {
      // faction: 0 if any neutral quest or a mix of A+H; else the exclusive side.
      const qf = e.n ? 0 : (e.a && !e.h) ? 1 : (e.h && !e.a) ? 2 : 0;
      if (qf === 1) na++; else if (qf === 2) nh++;
      upd.run(qf, Number.isFinite(e.min) ? e.min : 0, item);
    }
  })();
  console.log(`  quest-reward faction lock: ${na} Alliance, ${nh} Horde`);
}

// ---- Prune false-positive quest-giver flags. The QUESTGIVER npc_flag (bit 2) is set
// on ~40% of flagged creatures that have NO quest relation at all -- gossip-only NPCs
// like "Servant of Azora" (#1949). It's a data quirk, not a per-entity fix: clear the
// bit wherever the creature neither starts nor ends a quest we ingest. One structural
// correction (no hardcoded list) fixes EVERY consumer at once -- the NPC-page role
// badge, the zone/world-map "quest" marker (zonemap.js ORs npc_flags & 2), and the
// public API roles -- and applies to every dataset (main/dev/cmangos). Other role bits
// (vendor/trainer/…) are left intact.
console.log("Pruning false-positive quest-giver flags...");
{
  const before = db.prepare(`SELECT COUNT(*) n FROM creatures WHERE (npc_flags & 2) <> 0`).get().n;
  db.exec(`UPDATE creatures SET npc_flags = npc_flags & ~2
    WHERE (npc_flags & 2) <> 0
      AND entry NOT IN (SELECT id FROM creature_quest_start)
      AND entry NOT IN (SELECT id FROM creature_quest_end)`);
  const after = db.prepare(`SELECT COUNT(*) n FROM creatures WHERE (npc_flags & 2) <> 0`).get().n;
  console.log(`  quest-giver flag: ${before} -> ${after} (${before - after} false positives cleared)`);
}

// ---- quest_dungeon: bridge dungeon quests to the areaid the finder's Zone filter
// expects, so a mis-sorted dungeon quest still surfaces under its dungeon. A quest's
// ZoneOrSort (q.zone) is often NOT the dungeon: Baron Aquanis is filed under Ashenvale,
// yet it's a Blackfathom Deeps quest (its start item drops from a BFD-only boss). This
// mirrors EXACTLY the dungeon page's Q_DUNGEON_QUESTS relations -- name-filed zone,
// a quest giver/ender spawned INSIDE the instance, or a dungeon-exclusive req/source
// item drop (via spawns UNION creature_instance, so script-spawned bosses count) -- so
// the finder's Zone filter and the dungeon page agree on membership. For each belonging
// quest whose own q.zone differs from the dungeon's "primary" browse zone (the areaid
// the dungeon's OWN quests most commonly use), emit (quest, primaryZone). The primary is
// always a real, populated q.zone, so it already appears in the finder's Zone dropdown
// -- no dropdown change needed. Raid/custom interiors whose quests are never name-filed
// have no clean dropdown target -> skipped.
console.log("Building quest_dungeon bridge...");
db.exec(`CREATE TABLE quest_dungeon (quest INTEGER, zone INTEGER)`);
{
  // Set-based (in-memory) build: each source table is scanned ONCE and joined via JS
  // Maps. The earlier per-map SQL (a NOT-EXISTS over drops re-evaluating a CTE 47x with
  // no build-time index) was quadratic -> minutes; this is ~0.5s.
  const areaNameById = new Map(db.prepare(`SELECT entry, name FROM areas`).all().map((r) => [r.entry, r.name]));
  const instMaps = db.prepare(`SELECT id, name FROM maps WHERE type IN (1,2) AND name <> '' AND hidden = 0`).all();
  const instSet = new Set(instMaps.map((m) => m.id));
  // dungeon display name = its largest WorldMap zone (what the dungeon page's zone route
  // keys Q_DUNGEON_QUESTS on), falling back to the map name (map-less instances).
  const zoneNameStmt = db.prepare(`SELECT name FROM zones WHERE mapid = ? ORDER BY (loctop-locbottom)*(locleft-locright) DESC LIMIT 1`);
  const mapName = new Map(instMaps.map((m) => [m.id, zoneNameStmt.get(m.id)?.name || m.name]));

  // creature entry -> Set(maps) it occupies: static `spawns` UNION script-placed
  // `creature_instance` (so a boss with no static spawn still resolves to its instance).
  const creatureMaps = new Map();
  const addCM = (e, mp) => { let s = creatureMaps.get(e); if (!s) creatureMaps.set(e, s = new Set()); s.add(mp); };
  for (const r of db.prepare(`SELECT id, map FROM spawns`).all()) addCM(r.id, r.map);
  for (const r of db.prepare(`SELECT entry, map FROM creature_instance`).all()) addCM(r.entry, r.map);

  // loot_id -> creature entries (a shared loot table can back several creatures).
  const lootToCreatures = new Map();
  for (const r of db.prepare(`SELECT entry, loot_id FROM creatures WHERE loot_id IS NOT NULL AND loot_id <> 0`).all()) {
    let a = lootToCreatures.get(r.loot_id); if (!a) lootToCreatures.set(r.loot_id, a = []); a.push(r.entry);
  }

  // item -> the single instance map it drops EXCLUSIVELY inside (else absent). An item
  // qualifies iff every map any of its droppers occupies is that one instance (or 451,
  // the GM copy). Mirrors Q_DUNGEON_QUESTS' NOT-EXISTS off-map guard, in one pass.
  const itemMaps = new Map();
  for (const d of db.prepare(`SELECT item, owner FROM drops WHERE src = 'c'`).all()) {
    const ces = lootToCreatures.get(d.owner); if (!ces) continue;
    let s = itemMaps.get(d.item); if (!s) itemMaps.set(d.item, s = new Set());
    for (const ce of ces) { const cm = creatureMaps.get(ce); if (cm) for (const mp of cm) s.add(mp); }
  }
  const itemExclusiveMap = new Map();
  for (const [item, maps] of itemMaps) {
    let only = null, ok = true;
    for (const mp of maps) { if (mp === 451) continue; if (only === null) only = mp; else if (only !== mp) { ok = false; break; } }
    if (ok && only !== null && instSet.has(only)) itemExclusiveMap.set(item, only);
  }
  // Persist item -> its exclusive instance map so the dungeon page's Q_DUNGEON_QUESTS
  // branch (c) is a plain indexed join instead of a per-call NOT-EXISTS over drops + a
  // materialized spawns∪creature_instance CTE (~95ms -> ~4ms/dungeon; see queries.js).
  db.exec(`CREATE TABLE item_dungeon (item INTEGER, map INTEGER)`);
  {
    const insID = db.prepare(`INSERT INTO item_dungeon VALUES (?, ?)`);
    db.exec("BEGIN");
    for (const [item, mp] of itemExclusiveMap) insID.run(item, mp);
    db.exec("COMMIT");
    db.exec(`CREATE INDEX idx_item_dungeon_map ON item_dungeon(map)`);
    console.log(`  item_dungeon: ${itemExclusiveMap.size} exclusive-drop items`);
  }

  // object entry -> Set(instance maps) for quest giver/ender objects placed inside instances.
  const objInst = new Map();
  const instList = instMaps.map((m) => m.id).join(",");
  if (instList) for (const r of db.prepare(`SELECT id, map FROM spawn_points WHERE kind = 'o' AND map IN (${instList})`).all()) {
    let s = objInst.get(r.id); if (!s) objInst.set(r.id, s = new Set()); s.add(r.map);
  }

  // quest -> Set(instance maps) it belongs to, via the same relations as the dungeon page.
  const questMaps = new Map();
  const belong = (q, mp) => { if (!instSet.has(mp)) return; let s = questMaps.get(q); if (!s) questMaps.set(q, s = new Set()); s.add(mp); };
  const nameToMaps = new Map();
  for (const [id, nm] of mapName) { let a = nameToMaps.get(nm); if (!a) nameToMaps.set(nm, a = []); a.push(id); }
  // (a) quest's own zone area-name matches a dungeon display name
  for (const r of db.prepare(`SELECT entry, zone FROM quests WHERE hidden = 0`).all()) {
    const ms = nameToMaps.get(areaNameById.get(r.zone)); if (ms) for (const mp of ms) belong(r.entry, mp);
  }
  // (b) quest giver/ender spawns INSIDE the instance (creature or object)
  for (const tbl of ["creature_quest_start", "creature_quest_end"]) {
    for (const r of db.prepare(`SELECT quest, id FROM ${tbl}`).all()) {
      const cm = creatureMaps.get(r.id); if (cm) for (const mp of cm) belong(r.quest, mp);
    }
  }
  for (const tbl of ["gameobject_quest_start", "gameobject_quest_end"]) {
    for (const r of db.prepare(`SELECT quest, id FROM ${tbl}`).all()) {
      const om = objInst.get(r.id); if (om) for (const mp of om) belong(r.quest, mp);
    }
  }
  // (c) required/source item that drops exclusively inside an instance
  for (const r of db.prepare(`SELECT quest, item FROM quest_item WHERE role IN ('req','source')`).all()) {
    const mp = itemExclusiveMap.get(r.item); if (mp !== undefined) belong(r.quest, mp);
  }

  const questZone = new Map(db.prepare(`SELECT entry, zone FROM quests WHERE hidden = 0`).all().map((r) => [r.entry, r.zone]));
  const mapQuests = new Map();
  for (const [q, maps] of questMaps) for (const mp of maps) { let a = mapQuests.get(mp); if (!a) mapQuests.set(mp, a = []); a.push(q); }

  const ins = db.prepare(`INSERT INTO quest_dungeon VALUES (?, ?)`);
  const seen = new Set();
  let n = 0;
  db.exec("BEGIN");
  for (const [mp, quests] of mapQuests) {
    const nm = mapName.get(mp);
    // primary browse zone = most common belonging-quest zone whose area NAME is the
    // dungeon (bridges the WorldMap-area vs AreaTable id split, e.g. Deadmines interior
    // 5138 -> 1581, the id its quests actually file under). No name-filed quest -> skip
    // (raid/custom interior with no clean dropdown target).
    const cnt = new Map();
    for (const q of quests) { const z = questZone.get(q); if (areaNameById.get(z) === nm) cnt.set(z, (cnt.get(z) || 0) + 1); }
    let primary = null, best = -1;
    for (const [z, c] of cnt) if (c > best) { best = c; primary = z; }
    if (primary == null) continue;
    for (const q of quests) {
      if (questZone.get(q) === primary) continue;
      const key = `${q}:${primary}`; if (seen.has(key)) continue; seen.add(key);
      ins.run(q, primary); n++;
    }
  }
  db.exec("COMMIT");
  db.exec(`CREATE INDEX idx_quest_dungeon_quest ON quest_dungeon(quest)`);
  db.exec(`CREATE INDEX idx_quest_dungeon_zone ON quest_dungeon(zone)`);
  console.log(`  quest_dungeon: ${n} bridged quest->zone mappings`);
}

// ---- Full-text search over item / creature / quest names (unified search) ----
console.log("Building FTS indexes...");
db.exec(`CREATE VIRTUAL TABLE items_fts USING fts5(name, content='items', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO items_fts(rowid, name) SELECT entry, name FROM items WHERE hidden = 0`);
db.exec(`CREATE VIRTUAL TABLE creatures_fts USING fts5(name, subname, content='creatures', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO creatures_fts(rowid, name, subname) SELECT entry, name, subname FROM creatures WHERE name IS NOT NULL AND name <> '' AND hidden = 0`);
db.exec(`CREATE VIRTUAL TABLE quests_fts USING fts5(title, content='quests', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO quests_fts(rowid, title) SELECT entry, title FROM quests WHERE title IS NOT NULL AND title <> '' AND hidden = 0`);
db.exec(`CREATE VIRTUAL TABLE spells_fts USING fts5(name, description, content='spells', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO spells_fts(rowid, name, description) SELECT entry, name, description FROM spells WHERE name IS NOT NULL AND name <> '' AND teaches IS NULL AND hidden = 0`);

// Trigram indexes on the NAME columns -> substring/infix search ("fang" finds
// "Shadowfang"), which the unicode61 prefix index above can't do. Contentless
// (content='') -> only rowid + the tokenized trigrams are stored (smallest); the
// search query joins back to the base table by rowid. The prefix index stays for
// short (<3 char) terms and prefix ranking; the search OR-matches both.
db.exec(`CREATE VIRTUAL TABLE items_tg USING fts5(name, tokenize='trigram', content='')`);
db.exec(`INSERT INTO items_tg(rowid, name) SELECT entry, name FROM items WHERE hidden = 0`);
db.exec(`CREATE VIRTUAL TABLE creatures_tg USING fts5(name, tokenize='trigram', content='')`);
db.exec(`INSERT INTO creatures_tg(rowid, name) SELECT entry, name FROM creatures WHERE name IS NOT NULL AND name <> '' AND hidden = 0`);
db.exec(`CREATE VIRTUAL TABLE quests_tg USING fts5(title, tokenize='trigram', content='')`);
db.exec(`INSERT INTO quests_tg(rowid, title) SELECT entry, title FROM quests WHERE title IS NOT NULL AND title <> '' AND hidden = 0`);
db.exec(`CREATE VIRTUAL TABLE spells_tg USING fts5(name, tokenize='trigram', content='')`);
db.exec(`INSERT INTO spells_tg(rowid, name) SELECT entry, name FROM spells WHERE name IS NOT NULL AND name <> '' AND teaches IS NULL AND hidden = 0`);

// ---- Hunter pet families (Hunter Pets section, src/pets.js) ----
// Family NAME + DIET + ICON come from the client CreatureFamily.dbc
// (scripts/data/creature-families.json, committed). ROLE + Health/Armor/Damage stat
// MODIFIERS + which family learns which shared ability are curated
// (scripts/data/pet-families.json). The trainable ability CATALOG is DERIVED from the
// shipped spells table: skill 261 ("Beast Training") holds every trainable pet ability,
// one max-rank spell per ability. A family's ability set = the universal abilities +
// its curated family-specific set + any signature spell in its OWN CreatureFamily skill
// line -- the last auto-covers TW-custom families (Serpent/Fox) whose Poison Spit/Grace
// aren't in the curated data. Only families with >=1 tameable creature get a row.
{
  const famFile = join(ROOT, "scripts", "data", "creature-families.json");
  const petFile = join(ROOT, "scripts", "data", "pet-families.json");
  const famDbc = existsSync(famFile) ? JSON.parse(readFileSync(famFile, "utf8")) : {};
  const petCur = existsSync(petFile) ? JSON.parse(readFileSync(petFile, "utf8")) : {};
  const STANDARD = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 20, 21, 24, 25, 26, 27]); // vanilla 1.12 hunter families

  db.exec(`CREATE TABLE pet_families (
    id INTEGER PRIMARY KEY, name TEXT, diet TEXT, icon TEXT, role TEXT,
    mod_health REAL, mod_armor REAL, mod_damage REAL,
    custom INTEGER NOT NULL DEFAULT 0, npc_count INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE pet_ability (
    key TEXT PRIMARY KEY, name TEXT, active INTEGER NOT NULL DEFAULT 1,
    spell INTEGER, icon TEXT, description TEXT, max_rank INTEGER)`);
  // Per-rank rows: `level` is the pet level at which that rank becomes available
  // (spell_template.spellLevel). A tamed pet gets the highest rank its level allows,
  // so this answers "to learn Bite (Rank 3), tame a Bite-family beast of level >=16".
  db.exec(`CREATE TABLE pet_ability_rank (
    ability_key TEXT NOT NULL, rank INTEGER NOT NULL, spell INTEGER, level INTEGER,
    PRIMARY KEY (ability_key, rank))`);
  // Reverse map: any pet-ability spell entry (the empty "learn" stub in skill 261, the
  // real cast spell in a family skill line, or a family duplicate) -> its ability + rank +
  // the pet level that rank needs. Lets the spell page answer "tame X to learn this".
  db.exec(`CREATE TABLE pet_ability_spell (
    spell INTEGER PRIMARY KEY, ability_key TEXT NOT NULL, rank INTEGER, level INTEGER)`);
  db.exec(`CREATE TABLE pet_family_ability (
    family_id INTEGER NOT NULL, ability_key TEXT NOT NULL,
    PRIMARY KEY (family_id, ability_key))`);

  // Families that actually have tameable creatures (+ per-family counts).
  const famCounts = new Map();
  for (const r of db.prepare(`SELECT pet_family AS f, COUNT(*) n FROM creatures WHERE tameable=1 AND pet_family>0 GROUP BY pet_family`).all())
    famCounts.set(r.f, r.n);

  // Ability catalog from skill 261 (Beast Training): group by name, keep max rank.
  const passive = new Set(petCur.passive || []);
  const nameToKey = {}; // curated display name (lower) -> stable key
  for (const [k, nm] of Object.entries(petCur.abilityNames || {})) nameToKey[nm.toLowerCase()] = k;
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const rankNum = (r) => { const m = /(\d+)/.exec(r || ""); return m ? +m[1] : 0; };

  // Pet skill lines: skill 261 (Beast Training, the canonical ability enumerator with
  // one stub per rank) + each family's own line + the shared 270/134 pet skills. Bounds
  // name+rank matching to PET spells (so warrior Charge / rogue Prowl don't leak in).
  const petSkillSet = new Set([261, 270, 134]);
  for (const f of Object.values(famDbc)) if (f.skillLine) petSkillSet.add(f.skillLine);
  const petSkillList = [...petSkillSet].join(",");
  // Resolve a rank's REAL cast spell (with a tooltip) -- the skill-261 entry is an empty
  // "learn" stub. Match by name+rank within the pet skill set, richest description wins.
  const realStmt = db.prepare(`SELECT entry, icon, description FROM spells
    WHERE name = ?1 AND rank IS ?2 AND description <> '' AND skill IN (${petSkillList})
    ORDER BY (skill = 261), LENGTH(description) DESC LIMIT 1`);

  const abilityByKey = new Map(); // key -> catalog row
  const keyByName = new Map();    // lower spell name -> key (membership resolve)
  const ranksByKey = new Map();   // key -> [{rank, spell, level}]
  const canonLevel = new Map();   // `${key}|${rank}` -> canonical pet level (from the 261 stub)
  const insRank = db.prepare(`INSERT OR REPLACE INTO pet_ability_rank(ability_key, rank, spell, level) VALUES (?,?,?,?)`);
  for (const s of db.prepare(`SELECT entry, name, rank, icon, description, spell_level FROM spells WHERE skill=261 AND name IS NOT NULL AND name<>''`).all()) {
    if (/Tamed Pet Passive/i.test(s.name)) continue;
    const lname = s.name.toLowerCase();
    const key = nameToKey[lname] || slug(s.name);
    keyByName.set(lname, key);
    const rn = rankNum(s.rank);
    const level = s.spell_level || 0;
    canonLevel.set(`${key}|${rn}`, level);
    // prefer the real cast spell (tooltip); fall back to the stub if none found.
    const real = realStmt.get(s.name, s.rank) || null;
    const spell = real?.entry ?? s.entry;
    const icon = real?.icon || s.icon || null;
    const description = real?.description || s.description || null;
    const prev = abilityByKey.get(key);
    if (!prev || rn >= prev.max_rank) {
      abilityByKey.set(key, { key, name: s.name, active: passive.has(key) ? 0 : 1, spell, icon, description, max_rank: rn });
    }
    if (!ranksByKey.has(key)) ranksByKey.set(key, []);
    ranksByKey.get(key).push({ rank: rn, spell, level });
  }
  // Reverse map: EVERY pet-ability spell entry (stub + real + family dupes) -> ability/rank/
  // canonical level, so opening any of them on the spell page shows the "tame to learn" panel.
  const insPAS = db.prepare(`INSERT OR IGNORE INTO pet_ability_spell(spell, ability_key, rank, level) VALUES (?,?,?,?)`);
  db.transaction(() => {
    for (const s of db.prepare(`SELECT entry, name, rank FROM spells WHERE skill IN (${petSkillList}) AND name IS NOT NULL AND name<>''`).all()) {
      if (/Tamed Pet Passive/i.test(s.name)) continue;
      const key = keyByName.get(s.name.toLowerCase());
      if (!key) continue;
      const rn = rankNum(s.rank);
      insPAS.run(s.entry, key, rn, canonLevel.get(`${key}|${rn}`) ?? 0);
    }
  })();
  db.transaction(() => {
    for (const [key, ranks] of ranksByKey) for (const r of ranks) insRank.run(key, r.rank, r.spell, r.level);
  })();
  const insAbil = db.prepare(`INSERT OR REPLACE INTO pet_ability(key,name,active,spell,icon,description,max_rank) VALUES (?,?,?,?,?,?,?)`);
  db.transaction(() => { for (const a of abilityByKey.values()) insAbil.run(a.key, a.name, a.active, a.spell, a.icon, a.description, a.max_rank); })();

  // Per-family metadata + ability membership.
  const univ = (petCur.universal || []).filter((k) => abilityByKey.has(k));
  const insFam = db.prepare(`INSERT INTO pet_families(id,name,diet,icon,role,mod_health,mod_armor,mod_damage,custom,npc_count) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insFA = db.prepare(`INSERT OR IGNORE INTO pet_family_ability(family_id,ability_key) VALUES (?,?)`);
  const sigStmt = db.prepare(`SELECT DISTINCT name FROM spells WHERE skill=? AND name IS NOT NULL AND name<>''`);
  db.transaction(() => {
    for (const [fid, n] of famCounts) {
      const d = famDbc[String(fid)] || {};
      const c = petCur.families?.[String(fid)] || {};
      const mods = c.mods || {};
      insFam.run(fid, d.name || `Family ${fid}`, (d.diet || []).join(", ") || null, d.icon || null,
        c.role || null, mods.health ?? null, mods.armor ?? null, mods.damage ?? null,
        STANDARD.has(fid) ? 0 : 1, n);

      const keys = new Set(univ);
      for (const k of c.abilities || []) if (abilityByKey.has(k)) keys.add(k);
      if (d.skillLine) { // signature abilities from the family's own skill line
        for (const s of sigStmt.all(d.skillLine)) {
          if (/Tamed Pet Passive/i.test(s.name)) continue;
          const k = keyByName.get(s.name.toLowerCase());
          if (k && abilityByKey.has(k)) keys.add(k);
        }
      }
      for (const k of keys) insFA.run(fid, k);
    }
  })();

  const ntame = db.prepare(`SELECT COUNT(*) n FROM creatures WHERE tameable=1`).get().n;
  const ncustom = db.prepare(`SELECT COUNT(*) n FROM pet_families WHERE custom=1`).get().n;
  console.log(`  pet families: ${famCounts.size} (${ncustom} Turtle-custom), ${abilityByKey.size} abilities, ${ntame} tameable creatures`);
}

console.log("Optimizing...");
db.pragma("journal_mode = DELETE");
// Collect planner statistics (sqlite_stat1) so the query planner picks the right
// index on the heavy joins (drops ~550k, spawn_points ~150k, multi-join search).
db.exec("ANALYZE");
db.exec("VACUUM");
db.close();

// content hash -> version.json (drives client cache invalidation)
const buf = readFileSync(OUT);
const version = createHash("sha256").update(buf).digest("hex").slice(0, 12);
writeFileSync(join(ROOT, "public", DATA_SUBDIR, "version.json"), JSON.stringify({ version, builtAt: new Date().toISOString() }));

const mb = (buf.length / 1048576).toFixed(1);
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT} (${mb} MB, version ${version})`);
