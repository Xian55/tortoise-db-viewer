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
import { statsFromColumns, statsFromAuras, statsFromEnchant } from "./lib/itemstats.mjs";
import { deriveItemPeers } from "./lib/itempeers.mjs";
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
// Game version of the dataset ("vanilla" | "tbc"). Orthogonal to SQL_SOURCE: it selects
// version-dependent BUILD behaviour, not where the rows come from. Two things key off it
// today -- the Turtle-custom flag (only meaningful against a vanilla-1.12 id list) and
// the Turtle instance-map bounds fallback (vanilla art must not stand in for TBC
// dungeons). The frontend has its own copy in the config.js dataset registry.
const EXPANSION = process.env.EXPANSION || "vanilla";

// Client-derived lookup JSONs under scripts/data are version-specific: SpellIcon ids,
// the four index->value spell lookup DBCs, item sets, lock ids, creature families and
// random suffixes all renumber between expansions. Resolve "<name>.json" to
// "<name>-<expansion>.json" when one exists, else fall back to the vanilla file and say
// so -- a silent fallback is how TBC's Mangle (Bear) ended up drawing inv_letter_13.
const dataFileWarned = new Set();
function clientData(name) {
  const base = join(ROOT, "scripts", "data", name);
  if (EXPANSION === "vanilla") return base;
  const scoped = join(ROOT, "scripts", "data", name.replace(/\.json$/, `-${EXPANSION}.json`));
  if (existsSync(scoped)) return scoped;
  if (existsSync(base) && !dataFileWarned.has(name)) {
    dataFileWarned.add(name);
    console.warn(`  NOTE: no ${name.replace(/\.json$/, `-${EXPANSION}.json`)} — falling back to the vanilla ${name}`);
  }
  return base;
}
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
  // Voice lines (-> sound_text). Both tables pair a transcript with a SoundEntries id:
  // script_texts is the ScriptDev2 boss-line pool, broadcast_text the dbscript SAY pool.
  add("script_texts", "tw_world_script_texts.sql");
  add("broadcast_text", "tw_world_broadcast_text.sql");
  // Gossip: creature_template.gossip_menu_id -> gossip_menu.text_id -> npc_text
  // -> broadcast_text. What an NPC says when you talk to it (-> npc_gossip).
  add("gossip_menu", "tw_world_gossip_menu.sql");
  add("npc_text", "tw_world_npc_text.sql");
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
// dmg_multiplier when it builds the creature (Creature::SelectLevel seeds the base
// weapon damage from dmg_min/dmg_max, then Creature::UpdateDamagePhysical in
// StatSystem.cpp scales it by cinfo->dmg_multiplier), so fold it in here and drop
// the multiplier -- the stored numbers are then what the mob actually hits for
// (before the per-rank rate.damage.* config mod, which we can't see, exactly like
// health_min/health_max already ignores rate.health.*). Rounded to 1 decimal -- the
// raw dump values carry meaningless float precision (19.837, 14.868877, ...).
// This is a TURTLE-server fact. cmangos' DamageMultiplier means something else
// entirely (it scales creature_template_classlevelstats, and MinMeleeDmg is its
// *alternative*, not its operand), so lib/cmangos-adapter.mjs stages a literal 1
// here -- see the DERIVE comment there. Keep this fold source-agnostic.
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
// It is a TURTLE-client artefact, so on any other source it may only FILL GAPS, never
// override: a cmangos build already has an authoritative display->icon table straight
// from that expansion's own ItemDisplayInfo.dbc, and blanket REPLACE corrupts it (on the
// TBC dataset, 126 display ids collide and 1661 would flip from the correct INV_Hammer_03
// to Turtle's inv_pet_broom).
{
  const f = join(ROOT, "scripts", "data", "item-display-supplement.json");
  if (existsSync(f)) {
    const map = JSON.parse(readFileSync(f, "utf8"));
    const authoritative = SQL_SOURCE === "turtle";
    const stmt = db.prepare(authoritative
      ? `INSERT OR REPLACE INTO item_display_info (ID, icon) VALUES (?, ?)`
      : `INSERT OR IGNORE  INTO item_display_info (ID, icon) VALUES (?, ?)`);
    let n = 0;
    db.transaction(() => {
      for (const [id, icon] of Object.entries(map)) { n += stmt.run([Number(id), icon]).changes ?? 0; }
    })();
    console.log(`  item_display_info: +${n} ${authoritative ? "corrective" : "gap-fill (non-Turtle source: existing rows kept)"} rows`);
  } else {
    console.log("  (no item-display-supplement.json -- run scripts/extract-icons.py for Turtle icons)");
  }
}

// What an item LOOKS like: the 3D model (weapons/shields/helms/shoulders) or, for the
// ~5.1k armor displays that have no model at all, the eight component textures painted
// onto the character's body atlas. Client-only data (ItemDisplayInfo.dbc), extracted by
// scripts/extract-item-appearance.py and committed, since CI has no client.
//
// Its own table rather than columns on item_display_info: that table is joined by nearly
// every item query for its icon, and widening it by 18 columns would tax every one of
// them to serve the one tab that needs appearance. Reads here are single PK lookups.
//
// TURTLE-client artefact, like the icon supplement above -- a display id is not a shared
// namespace, so it is loaded only when the source IS Turtle. The other datasets get no
// table at all, and the frontend hides the feature via caps().
{
  const f = join(ROOT, "scripts", "data", "item-appearance.json");
  if (existsSync(f) && SQL_SOURCE === "turtle") {
    const doc = JSON.parse(readFileSync(f, "utf8"));
    const S = doc.s || [""];
    const str = (i) => S[i] || null;
    db.exec(`CREATE TABLE item_appearance (
      display_id INTEGER PRIMARY KEY,
      -- per_race: 1 when the bare model name does not exist and only <name>_<RaceSex>
      -- variants do (every helm, many shoulders). NULL when there is no model at all.
      model_l TEXT, model_r TEXT, model_dir TEXT, per_race INTEGER,
      tex_l TEXT, tex_r TEXT,
      geo1 INTEGER, geo2 INTEGER, geo3 INTEGER,
      helm_m INTEGER, helm_f INTEGER,
      t_arm_u TEXT, t_arm_l TEXT, t_hand TEXT, t_torso_u TEXT, t_torso_l TEXT,
      t_leg_u TEXT, t_leg_l TEXT, t_foot TEXT,
      item_visual INTEGER
    ) WITHOUT ROWID`);
    const stmt = db.prepare(`INSERT INTO item_appearance VALUES (${Array(21).fill("?").join(",")})`);
    let n = 0, withModel = 0;
    db.transaction(() => {
      for (const [id, row] of Object.entries(doc.d)) {
        // rows are stored with trailing zeros trimmed -- pad back to the full 18 slots
        const r = row.concat(Array(Math.max(0, 18 - row.length)).fill(0));
        const where = doc.m?.[String(r[0])] || null;   // [dir, 1 = the bare name exists]
        if (where) withModel++;
        stmt.run([Number(id), str(r[0]), str(r[1]), where ? where[0] : null, where ? (where[1] ? 0 : 1) : null,
          str(r[2]), str(r[3]), r[4] || null, r[5] || null, r[6] || null, r[7] || null, r[8] || null,
          ...Array.from({ length: 8 }, (_, i) => str(r[9 + i])), r[17] || null]);
        n++;
      }
    })();
    console.log(`  item_appearance: ${n} displays (${withModel} with a 3D model)`);
  } else if (existsSync(f)) {
    console.log(`  (skip item_appearance: ${SQL_SOURCE} source -- display ids are not a shared namespace)`);
  } else {
    console.log("  (no item-appearance.json -- run scripts/extract-item-appearance.py)");
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
  // Turtle-only, for the same reason script-abilities.json is: it was parsed out of
  // Turtle's ScriptDev2 C++, and cmangos' instance scripts are a different codebase with
  // different entry->instance placements. Attributing Turtle's to a cmangos dataset would
  // be a guess dressed up as data.
  const f = SQL_SOURCE === "turtle" ? join(ROOT, "scripts", "data", "instance-bosses.json") : null;
  let n = 0;
  if (f && existsSync(f)) {
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
  // src letters: c creature, s skinning, p pickpocket, o object, i item-container,
  // e disenchant, r pRospecting (TBC jewelcrafting), m mail. The last two are absent
  // from a 1.12 source and simply contribute nothing there.
  const sources = [["c", "loot_creature"], ["s", "loot_skinning"], ["p", "loot_pickpocket"],
    ["o", "loot_object"], ["i", "loot_item"], ["e", "loot_disenchant"],
    ["r", "loot_prospecting"], ["m", "loot_mail"]];
  // A source without these loot types never gets the table created at all (the
  // importer skips a dump file it can't find), and load() does a bare SELECT -- so
  // filter to what actually exists rather than throwing on a 1.12 build.
  const hasTable = (t) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  const present = sources.filter(([, t]) => hasTable(t));
  const absent = sources.filter(([, t]) => !hasTable(t)).map(([, t]) => t);
  if (absent.length) console.log(`  loot sources absent from this dataset: ${absent.join(", ")}`);
  let nd = 0;
  db.transaction(() => {
    for (const [src, table] of present) {
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
    "loot_item", "loot_disenchant", "loot_fishing", "loot_reference",
    "loot_prospecting", "loot_mail"]) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  console.log(`  drops (resolved): ${nd} rows (raw loot tables dropped)`);
}

// ---- Spells + crafting graph (single pass over the 16MB dump) ----
// spellStats: spellId -> { statKey: value } derived from the spell's effect auras
// (build-time only; the raw effect/aura columns are NOT persisted). Used by the
// item_stats pass below to resolve an item's equip-spell stats.
const spellStats = new Map();
// Same thing, but with statsFromAuras' `baseStats` opt-in (auras 29/22: "+8 Strength",
// "+3 Resist All" granted BY A SPELL). Only the enchant/gem pass reads this -- most TBC
// base-stat gems are exactly that shape, while item_stats must keep reading base stats
// from item columns alone or ~120 existing items would silently change score.
const spellStatsFull = new Map();
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
    const f = clientData("skill-lines.json");
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
    const f = clientData("spell-icon-map.json");
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
    const f = clientData("spell-lookups.json");
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
      const stFull = statsFromAuras(effects, {}, clean(row[iName]), clean(row[iStances]) || 0, { baseStats: true });
      if (Object.keys(stFull).length) spellStatsFull.set(e, stFull);
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

// ---- TBC sockets/gems: enchant display text + gem colour ----
// An item's socketBonus and a gem's GemProperties are both SpellItemEnchantment ids,
// and the only place their DISPLAY TEXT exists is the client DBC ("+6 Stamina") --
// no world DB carries it. Both tables come through the adapter's DBC-JSON path, so
// they simply stage empty on a source without sockets (any 1.12 dataset).
console.log("Deriving sockets/gems...");
{
  // `stats` is the enchant's effect resolved to the SAME stat keys item_stats uses, so
  // the character sheet can add a gem's contribution to a loadout's totals and score
  // upgrades against it. Derived, not parsed: see statsFromEnchant. NULL when the
  // enchant grants nothing scoreable (a proc, a stat 1.12 has no criteria key for) --
  // the display text still carries it, it just can't move a number.
  db.exec(`CREATE TABLE enchant_text (id INTEGER PRIMARY KEY, name TEXT, stats TEXT)`);
  db.exec(`CREATE TABLE gem_properties (id INTEGER PRIMARY KEY, enchant_id INTEGER, color INTEGER)`);
  let ne = 0, ng = 0, nes = 0;
  if (src.has("spell_item_enchantment")) {
    const c = srcColumns("spell_item_enchantment"); const at = (n) => c.indexOf(n);
    const iEff = at("eff");
    const ins = db.prepare(`INSERT OR REPLACE INTO enchant_text VALUES (?,?,?)`);
    db.transaction(() => {
      for (const r of srcRows("spell_item_enchantment")) {
        const nm = clean(r[at("name")]);
        if (!nm) continue;
        let stats = null;
        if (iEff >= 0) {
          const raw = clean(r[iEff]);
          let eff = null;
          try { eff = raw ? JSON.parse(raw) : null; } catch { eff = null; }
          const st = eff ? statsFromEnchant(eff, spellStatsFull) : null;
          if (st && Object.keys(st).length) { stats = JSON.stringify(st); nes++; }
        }
        ins.run(clean(r[at("id")]), nm, stats);
        ne++;
      }
    })();
  }
  if (src.has("gem_properties")) {
    const c = srcColumns("gem_properties"); const at = (n) => c.indexOf(n);
    const ins = db.prepare(`INSERT OR REPLACE INTO gem_properties VALUES (?,?,?)`);
    db.transaction(() => {
      for (const r of srcRows("gem_properties")) {
        ins.run(clean(r[at("id")]), clean(r[at("enchant_id")]), clean(r[at("color")]));
        ng++;
      }
    })();
  }
  console.log(`  enchant_text: ${ne} (${nes} w/derived stats) | gem_properties: ${ng}`);
}

// ---- Random-suffix ("of the Bear", ...) id -> name + stats ----
// GearExport reports a rolled item's random-property id (item link's suffixId).
// The name + stat bonuses live in the client ItemRandomProperties/SpellItemEnchantment
// DBCs (absent from the SQL dump), extracted locally to scripts/data/random-suffix.json
// (extract-random-suffix.py). Absent file => empty table (the site shows the base item).
console.log("Loading random suffixes...");
{
  db.exec(`CREATE TABLE random_suffix (id INTEGER PRIMARY KEY, name TEXT, stats TEXT)`);
  const f = clientData("random-suffix.json");
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
    const seen = new Set();
    let n = 0, nl = 0;
    db.transaction(() => {
      for (const { spell } of db.prepare(`SELECT spell FROM craft_source`).all()) {
        for (const learner of (spellTriggers.get(spell) || [])) { setTeaches.run(spell, learner); seen.add(learner); n++; }
      }
      // The craft path above only reaches learn-spells for CRAFTS, but the same stubs
      // exist for every trainer-taught class spell: "Blessing of Might" ships 15 rows,
      // 7 real ranks and 8 effect-36 stubs that teach them. learnTeaches already holds
      // every effect-36 spell -> its target (built during the spell import), so fill in
      // the rest here rather than leaving the column half-populated.
      for (const [learner, taught] of learnTeaches) {
        if (seen.has(learner)) continue;
        setTeaches.run(taught, learner); nl++;
      }
    })();
    db.exec(`CREATE INDEX idx_spells_teaches ON spells(teaches)`);
    console.log(`  learn spells flagged (teaches set): ${n} craft + ${nl} other`);
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

// ---- Sounds (what an NPC says/roars, and what a zone plays) ----
// The audio itself lives on R2 (public/sounds, see "Binary assets live on R2"); what
// lands here is only the mapping, and none of it is derivable from SQL alone:
//
//   sounds          SoundEntries id -> display name + the shipped file variants
//   creature_sound  creature -> sound, per activity slot (Aggro/Death/Loop/Greeting...)
//   zone_sound      area -> sound, per kind (music/ambience day+night, zone intro)
//   sound_text      sound -> the line's TRANSCRIPT, and who says it
//
// The creature and zone chains are client-side (CreatureDisplayInfo -> CreatureModelData
// -> CreatureSoundData; AreaTable -> ZoneMusic/SoundAmbience), so they arrive precomputed
// in scripts/data/sound-map.json from scripts/extract-sounds.py. The transcripts are
// server-side but their SPEAKER usually isn't: ~250 script_texts rows carry a sound id
// and nothing in SQL says who says them -- that binding is a C++ DoScriptText call, read
// out by scripts/extract-script-sounds.mjs. Absent either JSON the tables just come out
// empty and the UI hides itself (db.js caps()).
console.log("Importing sounds...");
{
  db.exec(`CREATE TABLE sounds (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, type INTEGER,
    files TEXT NOT NULL,  -- JSON array of R2-relative paths; >1 = the client picks at random
    ms INTEGER)`);
  db.exec(`CREATE TABLE creature_sound (
    creature INTEGER NOT NULL, sound INTEGER NOT NULL, slot TEXT NOT NULL, ord INTEGER,
    PRIMARY KEY (creature, sound, slot)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE zone_sound (
    area INTEGER NOT NULL, sound INTEGER NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (area, sound, kind)) WITHOUT ROWID`);
  // `take` is the index into the sound's `files` array, i.e. which numbered chip in the
  // player says this. A SoundEntries row holds up to 10 interchangeable takes and they
  // are DIFFERENT LINES -- "Time is money, friend!" is take 1 of
  // GoblinMaleZanyNPCGreetings, take 4 of GoblinFemaleZanyNPCGreetings and take 6 of
  // GoblinFemaleZanyVendorNPCGreeti. Keying transcripts on the sound alone made every
  // page show take 1's words and preselect take 1's audio, so a search hit played and
  // read as something other than what was searched for.
  // NULL where no take is knowable: script_texts / broadcast_text pair a line with a
  // SOUND, saying nothing about which of its files carries it.
  db.exec(`CREATE TABLE sound_text (
    id INTEGER PRIMARY KEY, sound INTEGER NOT NULL, creature INTEGER,
    take INTEGER, text TEXT NOT NULL, src TEXT NOT NULL)`);

  // NOT clientData(): audio is per-CLIENT, but its R2 prefix is per-DATASET (config.js
  // SOUNDS_BASE appends MAP_SUB). clientData()'s vanilla fallback would hand the
  // vanilla/cmangos build Turtle's sound map, whose paths would then be served from a
  // `sounds-vanilla-cmangos/` prefix that has no files -- a page of 404 play buttons,
  // which is worse than no tab. So the map must be named for THIS dataset; a dataset
  // whose client audio hasn't been extracted simply ships no sounds.
  const SOUND_SUB = (process.env.DATA_SUBDIR || "data").replace(/^data-?/, "");
  const soundMapName = (SOUND_SUB === "" || SOUND_SUB === "dev") ? "sound-map.json"
    : SOUND_SUB === "tbc-cmangos" ? "sound-map-tbc.json"
      : `sound-map-${SOUND_SUB}.json`;
  const mapFile = join(ROOT, "scripts", "data", soundMapName);
  const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, "utf8")) : null;
  let nsnd = 0, ncs = 0, nzs = 0, ntx = 0;

  if (!map) {
    console.warn(`  ${soundMapName} missing -- sounds skipped (run scripts/extract-sounds.py for this dataset)`);
  } else {
    const insSound = db.prepare(`INSERT OR IGNORE INTO sounds VALUES (?,?,?,?,?)`);
    db.transaction(() => {
      for (const [id, s] of Object.entries(map.sounds)) {
        insSound.run(Number(id), s.n || `Sound ${id}`, s.t ?? null, JSON.stringify(s.f), (s.d || [])[0] || null);
        nsnd++;
      }
    })();
    const haveSound = new Set(db.prepare(`SELECT id FROM sounds`).all().map((r) => r.id));

    // creature_sound. displaySound resolves the client's display -> model -> sound-data
    // walk; a creature just looks up its own display_id. The four NPCSounds slots are the
    // gossip set -- greeting, farewell, and a "pissed" pair whose exact split the DBC
    // doesn't distinguish, so both are labelled the same and separated by `ord`.
    const NPC_SLOTS = ["Greeting", "Farewell", "Annoyed", "Annoyed"];
    const insCs = db.prepare(`INSERT OR IGNORE INTO creature_sound VALUES (?,?,?,?)`);
    const slotted = new Set();   // `${creature}:${sound}` already filed under a client slot
    const addCs = (creature, sound, slot, ord) => {
      if (sound && haveSound.has(sound)) { insCs.run(creature, sound, slot, ord); ncs++; }
    };
    db.transaction(() => {
      for (const cr of db.prepare(`SELECT entry, display_id FROM creatures WHERE display_id > 0`).all()) {
        const ds = map.displaySound[cr.display_id];
        if (!ds) continue;
        const [csd, ns] = ds;
        for (const [slotIx, sound] of map.creatureSound[csd] || []) {
          addCs(cr.entry, sound, map.slots[slotIx], slotIx);
          slotted.add(`${cr.entry}:${sound}`);
        }
        (map.npcSounds[ns] || []).forEach((sound, i) => {
          addCs(cr.entry, sound, NPC_SLOTS[i], 100 + i);
          slotted.add(`${cr.entry}:${sound}`);
        });
      }
    })();

    // ---- Sound\Creature\<Folder>: the spoken lines no DBC row names ----
    // CreatureSoundData holds grunts and footsteps; a boss's Aggro/Taunt/Slay/Death lines
    // are fired from the server's C++ and are reachable from no client table at all. What
    // DOES group them is the folder they sit in, so extract-sounds ships the folder ->
    // sounds map plus whatever display ids it could bind (a folder its CreatureSoundData
    // points into, or the folder its model file lives in). That covers a bit over half.
    // The rest is matched here, by NAME, because this is where creature names exist --
    // Mother Shahraz's 11 lines sit in Sound\Creature\MotherShahraz and nothing else in
    // the client connects them to creature 22947.
    // Ordered after every client slot (max 103) so the NPC page lists the real slots first.
    const DIR_ORD = 200;
    const dirSound = map.dirSound || {};
    // These carry no CreatureSoundData slot, so their ACTIVITY has to be read off the
    // filename. There is no single convention -- "BLCKTMPLE_MothrSha_Taunt01",
    // "A_RagnarosArrival01", "A_ASH_SPEAK_01" and "CoweringRoar" are all real -- so three
    // rules run in order, and the measured yield of each is why all three exist (Turtle:
    // 1688 / 128 / ~50 of 1974, vs 158 left as "Other").
    //   1. a known activity word anywhere in the name. Longest/most specific first, so
    //      "SpecialAttack" is not read as "Attack" and "WoundCrit" is not read as "Wound".
    //   2. the name with its "A_" prefix, trailing counter and the FOLDER NAME removed --
    //      "A_Mr Smite Alarm01" in folder MrSmite is an Alarm. Compared on alphanumerics
    //      only, since the two spell the creature differently as often as not.
    //   3. the rightmost all-alphabetic underscore token (A_DOOMGUARD_DISMISS01).
    // Anything left is an effect rather than an activity (Growl, FootstepHorseDirt).
    const DIR_ACTIVITY = [
      ["WINGFLAP", "Wing Flap"], ["LIFTOFF", "Lift Off"], ["SPECIALATTACK", "Special Attack"],
      ["WOUNDCRIT", "Wound Critical"], ["FOOTSTEP", "Footsteps"], ["FOORSTEP", "Footsteps"],
      ["AGGRO", "Aggro"], ["SLAY", "Slay"], ["DEATH", "Death"], ["TAUNT", "Taunt"],
      ["GREET", "Greet"], ["FAREWELL", "Farewell"], ["INTRO", "Intro"], ["ARRIVAL", "Arrival"],
      ["ENRAGE", "Enrage"], ["BERSERK", "Enrage"], ["SPECIAL", "Special"], ["SPELL", "Spell"],
      ["CAST", "Spell"], ["WOUND", "Wound"], ["ATTACK", "Attack"], ["ROAR", "Roar"],
      ["SPEAK", "Speak"], ["READY", "Ready"], ["RALLY", "Rally"], ["WAKE", "Wake"],
      ["FIDGET", "Fidget"], ["TRANSFORM", "Transform"], ["LOOP", "Loop"], ["BARK", "Bark"],
      ["EMOTE", "Emote"], ["FEAR", "Fear"], ["FLEE", "Flee"], ["PISSED", "Annoyed"],
      ["LAND", "Land"], ["JUMP", "Jump"], ["SUBMERGE", "Submerge"], ["BIRTH", "Birth"],
      ["STUN", "Stun"], ["DISMISS", "Dismiss"], ["ORDER", "Order"], ["KILL", "Kill"],
      ["SUMMON", "Summon"], ["HEALTH", "Health"], ["SPAWN", "Spawn"], ["STEP", "Footsteps"],
      ["EXERT", "Exertion"], ["INJUR", "Injury"], ["STAND", "Stand"], ["ALERT", "Alert"],
      ["YES", "Yes"], ["WHAT", "What"],
    ];
    const alnum = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    // Greeting/Farewell/Annoyed are the NPCSounds gossip slots, and Q_SOUND_LIST keys its
    // "NPC Gossip" category off exactly those three -- a boss taunt must not land there.
    const activityLabel = (tok) => {
      if (!tok || tok.length < 2 || tok.length > 14) return null;
      const lab = /^[A-Z0-9]+$/.test(tok) ? tok[0] + tok.slice(1).toLowerCase() : tok[0].toUpperCase() + tok.slice(1);
      return NPC_SLOTS.includes(lab) ? "Dialogue" : lab;
    };
    const dirSlot = (name, dir) => {
      const n = String(name || "");
      const up = n.toUpperCase();
      const known = DIR_ACTIVITY.find(([w]) => up.includes(w));
      if (known) return known[1];
      const trimmed = n.replace(/^A_/, "").replace(/[\s_\d]+$/, "");
      const key = alnum(dir);
      if (key && alnum(trimmed).startsWith(key) && alnum(trimmed).length > key.length) {
        let i = 0, seen = 0;
        while (i < trimmed.length && seen < key.length) {
          if (/[a-z0-9]/i.test(trimmed[i])) seen++;
          i++;
        }
        const lab = activityLabel(trimmed.slice(i).replace(/[^A-Za-z]/g, ""));
        if (lab) return lab;
      }
      // Deliberately no third rule. Falling back to "the last word-ish token" reads the
      // ENCOUNTER prefix as an activity -- Illidan's 19 numbered lines came out labelled
      // "Illidan", the Black Temple prelude "Btprlude" -- which is worse than admitting
      // the filename records no activity. Blank; the column hides itself when empty.
      return "";
    };
    // Voice or noise. The `A_` prefix is Blizzard's own marker for a spoken SoundEntries
    // row and it is near-perfect here: of 1,773 A_ rows in TBC creature folders the only
    // ones that look like effects by name ("...Summon01") are the boss SAYING "arise".
    // Everything without it is the model's noise set, unless the activity word says
    // otherwise. Carried in `ord` rather than a new column, so a DB built before this
    // still satisfies every existing query.
    const VOCAL = new Set(["Aggro", "Slay", "Death", "Taunt", "Greet", "Farewell", "Intro",
      "Arrival", "Enrage", "Speak", "Rally", "Ready", "Yes", "What", "Dialogue", "Annoyed"]);
    const DIR_ORD_FX = 201;
    const dirOrd = (name, slot) => (/^A_/.test(String(name || "")) || VOCAL.has(slot) ? DIR_ORD : DIR_ORD_FX);
    const addDir = (creature, dir) => {
      for (const sound of dirSound[dir] || []) {
        if (slotted.has(`${creature}:${sound}`)) continue;
        const name = (map.sounds[sound] || {}).n;
        const slot = dirSlot(name, dir);
        addCs(creature, sound, slot, dirOrd(name, slot));
      }
    };
    const boundDirs = new Set();
    let nDirCr = 0, nDirName = 0;
    db.transaction(() => {
      for (const cr of db.prepare(`SELECT entry, display_id FROM creatures WHERE display_id > 0`).all()) {
        for (const dir of (map.displayDir || {})[cr.display_id] || []) {
          addDir(cr.entry, dir);
          boundDirs.add(dir);
          nDirCr++;
        }
      }
    })();
    {
      const nm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const byName = new Map();
      for (const c of db.prepare(`SELECT entry, name FROM creatures WHERE name IS NOT NULL`).all()) {
        const k = nm(c.name);
        if (!k) continue;
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(c.entry);
      }
      const allNames = [...byName.keys()];
      db.transaction(() => {
        for (const dir of Object.keys(dirSound)) {
          if (boundDirs.has(dir)) continue;
          const leaf = nm(dir);
          if (!leaf) continue;
          let keys = byName.has(leaf) ? [leaf] : [];
          // The folder usually drops the title ("Curator" is "The Curator", "Faerlina" is
          // "Grand Widow Faerlina"), so a contained match counts too -- but only when it is
          // long enough to be a name and lands on a handful of NPCs. "Archer" is contained
          // in 42 creature names and identifies none of them.
          if (!keys.length && leaf.length >= 6) {
            const cand = allNames.filter((n) => n.includes(leaf));
            if (cand.length && cand.length <= 3) keys = cand;
          }
          if (!keys.length) continue;
          nDirName++;
          for (const k of keys) for (const e of byName.get(k)) addDir(e, dir);
        }
      })();
    }
    if (Object.keys(dirSound).length) {
      console.log(`  creature folders: ${Object.keys(dirSound).length} | ${boundDirs.size} bound by the client `
        + `(${nDirCr} display links), ${nDirName} by name, `
        + `${Object.keys(dirSound).length - boundDirs.size - nDirName} unattributed`);
    }

    // zone_sound. Day and night are separate SoundEntries rows but usually the same one;
    // collapse that case so a zone doesn't list the identical track twice.
    const insZs = db.prepare(`INSERT OR IGNORE INTO zone_sound VALUES (?,?,?)`);
    const addPair = (area, pair, label) => {
      if (!pair) return;
      const [day, night] = pair;
      const same = day && day === night;
      for (const [sound, kind] of same ? [[day, label]] : [[day, `${label} (Day)`], [night, `${label} (Night)`]]) {
        if (sound && haveSound.has(sound)) { insZs.run(area, sound, kind); nzs++; }
      }
    };
    db.transaction(() => {
      for (const [area, ent] of Object.entries(map.areaSound)) {
        addPair(Number(area), map.zoneMusic[ent.m], "Music");
        addPair(Number(area), map.ambience[ent.a], "Ambience");
        const intro = map.intro[ent.i];
        if (intro && haveSound.has(intro)) { insZs.run(Number(area), intro, "Intro"); nzs++; }
      }
      // WMOAreaTable: audio the client plays for the BUILDING you are standing in, which
      // never reaches the zone's own AreaTable row. Several of the most recognisable
      // tracks live only here -- the Deadmines' intro sting is a WMO row and nothing else
      // -- so a zone-only reading silently misses them. Labelled "(Interior)" because
      // that is what they are: a zone can legitimately have both, playing in different
      // places, and collapsing them would misrepresent either one.
      // A WMO commonly repeats the zone's own track. Only the ones the zone does NOT
      // already list are worth a second row; otherwise Deadmines shows "Zone-Mystery"
      // twice, once per source, which tells the reader nothing.
      const already = new Set(db.prepare(`SELECT area, sound FROM zone_sound`).all()
        .map((r) => `${r.area}:${r.sound}`));
      const addWmo = (a, sound, kind) => {
        if (!sound || !haveSound.has(sound) || already.has(`${a}:${sound}`)) return;
        already.add(`${a}:${sound}`);
        insZs.run(a, sound, kind);
        nzs++;
      };
      for (const [area, ent] of Object.entries(map.wmoSound || {})) {
        const a = Number(area);
        for (const id of ent.m || []) for (const s of map.zoneMusic[id] || []) addWmo(a, s, "Music (Interior)");
        for (const id of ent.a || []) for (const s of map.ambience[id] || []) addWmo(a, s, "Ambience (Interior)");
        for (const id of ent.i || []) addWmo(a, map.intro[id], "Intro (Interior)");
      }
    })();

    // ---- transcripts ----
    const insTx = db.prepare(`INSERT INTO sound_text (sound, creature, take, text, src) VALUES (?,?,?,?,?)`);
    const seenTx = new Set();
    const namedTx = new Set();   // (sound, text) pairs that got a real speaker
    const addTx = (sound, creature, text, srcTag, take = null) => {
      text = String(text ?? "").trim();
      if (!sound || !haveSound.has(sound) || !text) return;
      // Dedupe on the sound plus a NORMALIZED text. script_texts and broadcast_text often
      // carry the same line with cosmetic differences ("What, Mograine has fallen?" vs
      // "Mograine has fallen?"), so keying on the raw string listed one clip twice.
      const norm = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
      // Both text pools end with a sweep that lists whatever couldn't be attributed. A
      // line that DID get a speaker must not also appear speaker-less, or the voice-line
      // page shows it twice -- once credited, once anonymous.
      if (!creature && namedTx.has(`${sound}:${norm}`)) return;
      // The take is part of the key. Two takes of one sound legitimately hold the same
      // words (a voice type often records a line twice), and collapsing them would leave
      // the second chip looking silent.
      const key = take == null ? `${sound}:${creature || 0}:${norm}` : `${sound}:${creature || 0}:${take}`;
      if (seenTx.has(key)) return;
      seenTx.add(key);
      if (creature) namedTx.add(`${sound}:${norm}`);
      insTx.run(sound, creature || null, take, text, srcTag);
      ntx++;
    };

    // 's' -- script_texts, spoken by whichever creature's C++ script names the entry.
    // Turtle only: cmangos' ScriptName points at its own separate C++ (same reason
    // creature_ability's 'c' source is Turtle-only).
    const textRows = new Map();   // script_texts.entry -> { text, sound }
    if (src.has("script_texts")) {
      const c = src.columns("script_texts");
      const iE = c.indexOf("entry"), iT = c.indexOf("content_default"), iS = c.indexOf("sound");
      if (iE >= 0 && iT >= 0 && iS >= 0) {
        for (const r of src.rows("script_texts")) {
          const sound = Number(r[iS]) || 0;
          if (sound) textRows.set(Number(r[iE]), { text: r[iT], sound });
        }
      }
    }
    // A script may name its line by broadcast_text.entry instead (a POSITIVE id). Those
    // rows usually carry sound 0 -- the audio lives on the script_texts row holding the
    // same line -- so the two are bridged on normalized text. That bridge is what gives
    // Anub'Rekhan's whole fight a speaker: the C++ names broadcast_text 13004, whose
    // sound is 0, while script_texts has the identical line with sound 8788.
    // Normalization is only case/punctuation ("Shh..." vs "Shhh...", "Yes, Run!" vs
    // "Yes, run!"); measured across the dump it leaves exactly one ambiguous text out of
    // 230, and an ambiguous one is skipped rather than guessed.
    // Three tiers, tried in order, each requiring a UNIQUE hit. The two pools were hand-
    // authored separately and disagree in small ways that plain normalization can't see:
    //   exact    "The Light has spoken!"        -- most lines
    //   squash   "Shh..." vs "Shhh...",         -- elongated interjections; collapsing a
    //            "Yesss..." vs "Yes..."            run of one letter to a single one
    //   prefix   "...the all smell..." vs       -- a typo in one copy, so only the head
    //            "...They all smell..."            of the line can be trusted
    // Measured over the dump: 143 rows resolve exactly, +4 with squash, +6 more on the
    // prefix, and the ambiguous-key count stays at exactly 1 at every tier -- the looser
    // matching buys coverage without costing precision. An ambiguous key is skipped.
    const normText = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const squashText = (s) => normText(s).replace(/(.)\1+/g, "$1");
    const PREFIX_LEN = 40;
    const MIN_MATCH = 12;
    const soundByText = new Map(), soundBySquash = new Map(), soundByPrefix = new Map();
    const addKey = (map, key, sound) => {
      if (key.length < MIN_MATCH) return;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(sound);
    };
    for (const row of textRows.values()) {
      addKey(soundByText, normText(row.text), row.sound);
      addKey(soundBySquash, squashText(row.text), row.sound);
      addKey(soundByPrefix, squashText(row.text).slice(0, PREFIX_LEN), row.sound);
    }
    const uniqueSound = (map, key) => {
      const v = key.length >= MIN_MATCH ? map.get(key) : null;
      return v && v.size === 1 ? [...v][0] : null;
    };
    const btRow = new Map();      // broadcast_text.entry -> { text, sound }
    if (src.has("broadcast_text")) {
      const c = src.columns("broadcast_text");
      const iE = c.indexOf("entry"), iM = c.indexOf("male_text"), iF = c.indexOf("female_text"), iS = c.indexOf("sound_id");
      if (iE >= 0) for (const r of src.rows("broadcast_text")) {
        btRow.set(Number(r[iE]), { text: r[iM] || (iF >= 0 ? r[iF] : "") || "", sound: Number(r[iS]) || 0 });
      }
    }
    const soundForBroadcast = (id) => {
      const row = btRow.get(id);
      if (!row || !row.text) return null;
      if (row.sound) return { sound: row.sound, text: row.text };
      const sq = squashText(row.text);
      const sound = uniqueSound(soundByText, normText(row.text))
        ?? uniqueSound(soundBySquash, sq)
        ?? uniqueSound(soundByPrefix, sq.slice(0, PREFIX_LEN));
      return sound ? { sound, text: row.text } : null;
    };

    const scriptFile = join(ROOT, "scripts", "data", "script-sounds.json");
    if (SQL_SOURCE !== "cmangos" && existsSync(scriptFile) && textRows.size) {
      const byScript = JSON.parse(readFileSync(scriptFile, "utf8")).scripts || {};
      // How many creatures run each script. The file-level fallback is only trustworthy
      // for a script that belongs to a specific encounter; a GENERIC one shared by dozens
      // of creatures would hand every last one of them the same boss line -- unfixed,
      // Majordomo Executus' "Burn mortals!" was credited to 71 creatures including
      // Chicken, Target Dummy and Explosive Sheep. Struct-resolved ids (`t`) skip this
      // cap: they name the AI struct outright and are precise however widely shared.
      // 4 keeps the Four Horsemen, who really do share lines, and drops the generics.
      const MAX_FANOUT = 4;
      const fanout = new Map();
      for (const r of db.prepare(`SELECT script_name, COUNT(*) n FROM creatures WHERE script_name IS NOT NULL AND script_name <> '' GROUP BY script_name`).all()) {
        fanout.set(r.script_name, r.n);
      }
      db.transaction(() => {
        for (const cr of db.prepare(`SELECT entry, script_name FROM creatures WHERE script_name IS NOT NULL AND script_name <> ''`).all()) {
          const ent = byScript[cr.script_name];
          if (!ent) continue;
          for (const t of ent.t || []) {
            const row = textRows.get(t);
            if (row) addTx(row.sound, cr.entry, row.text, "s");
          }
          // `b` is struct-resolved like `t`, so it is exempt from the fan-out cap.
          for (const b of ent.b || []) {
            const hit = soundForBroadcast(b);
            if (hit) addTx(hit.sound, cr.entry, hit.text, "s");
          }
          // `tf`/`bf` came from a whole-file scan; only trust them for a script a small
          // number of creatures run.
          const specific = (fanout.get(cr.script_name) || 0) <= MAX_FANOUT;
          if (specific) {
            for (const t of ent.tf || []) {
              const row = textRows.get(t);
              if (row) addTx(row.sound, cr.entry, row.text, "s");
            }
            for (const b of ent.bf || []) {
              const hit = soundForBroadcast(b);
              if (hit) addTx(hit.sound, cr.entry, hit.text, "s");
            }
          }
          // A sound the script plays with no line attached (a roar, a stinger) is still
          // that creature's -- it belongs on the NPC page, just not in the transcript.
          for (const sound of ent.s || []) addCs(cr.entry, sound, "Script", 200);
        }
      })();
    }
    // C++ attribution resolves about half of them (127 of 247 measured): the rest sit in
    // a script whose registration we can't tie to a struct, or are spoken by a GO/event
    // rather than a creature. The line and its audio are still real, so list them with no
    // speaker rather than dropping them -- the voice-line page is the point.
    db.transaction(() => { for (const row of textRows.values()) addTx(row.sound, null, row.text, "s"); })();

    // 'l' -- inline yells. A Turtle-custom boss usually doesn't route its line through
    // script_texts at all; it yells a literal string and plays the VO on the next line
    // (see extract-script-sounds.mjs). Those clips shipped with audio and no words --
    // Moroes' whole fight, the Satyr/Keeper/Furbolg bosses. The speaker comes from
    // creature_sound, which already links that sound to whoever plays it.
    if (SQL_SOURCE !== "cmangos" && existsSync(scriptFile)) {
      const inline = JSON.parse(readFileSync(scriptFile, "utf8")).lines || {};
      // Three ways to name the speaker, most specific first: the script dispatched on this
      // creature's entry (`case fenektis_the_deceiver:` -- exact, and the only thing that
      // works for an instance script, which registers no per-creature name); else the
      // sound is already linked to a creature via creature_sound; else any creature running
      // a script the line's FILE registers, which rescues files whose several AI structs
      // per-struct resolution can't tell apart.
      const known = new Set(db.prepare(`SELECT entry FROM creatures`).all().map((r) => r.entry));
      const bySound = db.prepare(`SELECT creature FROM creature_sound WHERE sound = ?1 ORDER BY ord, creature`);
      const byScriptName = new Map();
      for (const cr of db.prepare(`SELECT entry, script_name FROM creatures WHERE script_name IS NOT NULL AND script_name <> ''`).all()) {
        if (!byScriptName.has(cr.script_name)) byScriptName.set(cr.script_name, []);
        byScriptName.get(cr.script_name).push(cr.entry);
      }
      db.transaction(() => {
        for (const [sid, ent] of Object.entries(inline)) {
          const sound = Number(sid);
          // `bi` is a broadcast_text id the script said numerically rather than inline.
          const text = typeof ent === "string" ? ent
            : (ent.t ?? (ent.bi ? (btRow.get(ent.bi) || {}).text : null));
          if (!text) continue;
          let who = (typeof ent === "object" && ent.c && known.has(ent.c)) ? [ent.c] : [];
          if (!who.length) who = bySound.all(sound).map((r) => r.creature);
          if (!who.length && typeof ent === "object") {
            who = [...new Set((ent.s || []).flatMap((n) => byScriptName.get(n) || []))];
          }
          if (who.length) for (const c of who) addTx(sound, c, text, "l");
          else addTx(sound, null, text, "l");
        }
      })();
    }

    // dbscript id -> the creatures whose EventAI owns it. Shared by the two readers below.
    const owner = new Map();
    if (src.has("creature_ai_events")) {
      const ec = src.columns("creature_ai_events");
      const iC = ec.indexOf("creature_id");
      const acts = ["action1_script", "action2_script", "action3_script"].map((k) => ec.indexOf(k)).filter((i) => i >= 0);
      if (iC >= 0) for (const r of src.rows("creature_ai_events")) {
        for (const a of acts) {
          const sid = Number(r[a]) || 0;
          if (!sid) continue;
          if (!owner.has(sid)) owner.set(sid, new Set());
          owner.get(sid).add(Number(r[iC]));
        }
      }
    }

    // 'b' -- broadcast_text, spoken via a dbscript SAY. Here SQL *does* know the speaker:
    // creature_ai_events.creature_id owns the script whose SAY row names the text.
    if (src.has("broadcast_text")) {
      const c = src.columns("broadcast_text");
      const iE = c.indexOf("entry"), iM = c.indexOf("male_text"), iF = c.indexOf("female_text"), iS = c.indexOf("sound_id");
      const bt = new Map();
      if (iE >= 0 && iS >= 0) {
        for (const r of src.rows("broadcast_text")) {
          const sound = Number(r[iS]) || 0;
          if (sound) bt.set(Number(r[iE]), { text: r[iM] || (iF >= 0 ? r[iF] : "") || "", sound });
        }
      }
      if (src.has("creature_ai_scripts") && bt.size) {
        const sc = src.columns("creature_ai_scripts");
        const iId = sc.indexOf("id"), iCmd = sc.indexOf("command");
        const ints = ["dataint", "dataint2", "dataint3", "dataint4"].map((k) => sc.indexOf(k)).filter((i) => i >= 0);
        if (iId >= 0 && iCmd >= 0) db.transaction(() => {
          for (const r of src.rows("creature_ai_scripts")) {
            if (Number(r[iCmd]) !== 0) continue;          // 0 = SCRIPT_COMMAND_TALK
            const creatures = owner.get(Number(r[iId]));
            for (const di of ints) {
              const row = bt.get(Number(r[di]) || 0);
              if (!row) continue;
              if (creatures && creatures.size) for (const cid of creatures) addTx(row.sound, cid, row.text, "b");
              else addTx(row.sound, null, row.text, "b");
            }
          }
        })();
      }
      // Any remaining sound-bearing broadcast_text is a real line we simply can't
      // attribute -- still worth listing on the voice-line page, just with no speaker.
      db.transaction(() => { for (const row of bt.values()) addTx(row.sound, null, row.text, "b"); })();
    }

    // A dbscript can also fire a bare sound (command 16, SCRIPT_COMMAND_PLAY_SOUND,
    // datalong = the SoundEntries id) with no text at all -- an alarm bell, a horn, a
    // roar. No transcript to show, but it is still that creature's sound.
    if (src.has("creature_ai_scripts") && owner.size) {
      const sc = src.columns("creature_ai_scripts");
      const iId = sc.indexOf("id"), iCmd = sc.indexOf("command"), iDl = sc.indexOf("datalong");
      if (iId >= 0 && iCmd >= 0 && iDl >= 0) db.transaction(() => {
        for (const r of src.rows("creature_ai_scripts")) {
          if (Number(r[iCmd]) !== 16) continue;
          const sound = Number(r[iDl]) || 0;
          for (const cid of owner.get(Number(r[iId])) || []) addCs(cid, sound, "Script", 200);
        }
      })();
    }

    // 'v' -- hand-verified transcripts (scripts/data/voice-transcripts.json).
    // ~250 clips have no line anywhere in the world data: the client picks them from an
    // NPC's voice type and the words exist only in the audio. Extraction can never reach
    // those, so this is the escape hatch for someone who listened. Keyed by sound NAME
    // (ids move when the client is patched) and indexed by TAKE, so a multi-take sound
    // can have one take transcribed and the rest blank.
    // 'w' -- the same, but MACHINE-generated by scripts/transcribe-sounds.py (Whisper over
    // the extracted audio). Loaded second and only where hand hasn't spoken, so a human
    // correction always wins. Kept under its own src so the UI can present it as an
    // automatic transcript rather than asserting it: these are good but not infallible,
    // and a wrong line presented as fact is worse than a blank one.
    {
      const idOf = new Map(db.prepare(`SELECT id, name FROM sounds`).all().map((r) => [r.name, r.id]));
      const load = (file, srcTag) => {
        const f = join(ROOT, "scripts", "data", file);
        if (!existsSync(f)) return 0;
        let byName;
        try { byName = JSON.parse(readFileSync(f, "utf8")); } catch { return 0; }
        let n = 0;
        db.transaction(() => {
          for (const [name, takes] of Object.entries(byName)) {
            if (name.startsWith("_") || !Array.isArray(takes)) continue;   // _comment block
            const sound = idOf.get(name);
            if (!sound) continue;
            for (let i = 0; i < takes.length; i++) {
              const line = takes[i];
              if (typeof line !== "string" || !line.trim()) continue;
              // Per TAKE, not per sound: a hand entry can correct take 2 while leaving the
              // rest to the machine. An empty string at an index is an explicit "this one
              // is wrong" -- it suppresses the machine line without inventing a
              // replacement, which is the only way to mark a bad transcript as bad.
              if (srcTag === "w" && handTakes.has(`${sound}:${i}`)) continue;
              addTx(sound, null, line, srcTag, i);
              n++;
            }
          }
        })();
        return n;
      };
      // Which (sound, take) pairs a human has an opinion on -- a correction OR an
      // explicit rejection (empty string). Both block the machine line for that take.
      const handTakes = new Set();
      {
        const f = join(ROOT, "scripts", "data", "voice-transcripts.json");
        if (existsSync(f)) {
          try {
            for (const [name, takes] of Object.entries(JSON.parse(readFileSync(f, "utf8")))) {
              if (name.startsWith("_") || !Array.isArray(takes)) continue;
              const id = idOf.get(name);
              if (!id) continue;
              takes.forEach((t, i) => { if (typeof t === "string") handTakes.add(`${id}:${i}`); });
            }
          } catch { /* malformed file -> no hand transcripts, machine ones stand */ }
        }
      }
      const nv = load("voice-transcripts.json", "v");
      const nw = load("voice-transcripts-auto.json", "w");
      if (nv || nw) console.log(`  sound_text: +${nv} hand-verified, +${nw} machine transcripts`);
    }

    // Attribution passes credit a speaker to a sound whose lines are anonymous. They used
    // to INSERT a credited copy of the text, which was invisible only because every page
    // read one row per sound -- now that the transcript lists every take, that copy shows
    // up as the whole line set repeated, once numbered and once not. What these passes
    // actually mean is "these lines are this creature's", so they UPDATE in place.
    // `src` is deliberately left alone: it records where the TEXT came from, and a machine
    // transcript stays a machine transcript no matter who is later found to say it.
    const creditSound = db.prepare(`UPDATE sound_text SET creature = ?2 WHERE sound = ?1 AND creature IS NULL`);
    const credit = (sound, creature) => creditSound.run(sound, creature).changes || 0;

    // ---- propagate a speaker across a sound-NAME cluster ----
    // Blizzard names a creature's VO as one family: A_Arugal Aggro01 / Slay01 / Charm01,
    // A_ANU_NAXX_GREET / _SLAY / _TAUNT01. Whether a given line got attributed depends on
    // whether its particular script call happened to be resolvable, so a boss routinely
    // ends up with most of its family credited and two or three stragglers blank.
    //
    // If a family's attributed sounds all point at ONE creature, the stragglers are that
    // creature's too. The safeguard is that unanimity: a family credited to several
    // creatures (the Four Horsemen share a script and a text pool) is left alone rather
    // than guessed at, and a family with nothing attributed stays anonymous. This never
    // overrides an existing attribution, only fills gaps.
    const clusterKey = (name) => String(name || "")
      .replace(/\d+$/, "")                       // trailing take number
      // the event word at the end -- what varies WITHIN a family
      .replace(/[ _-]*(aggro|slay|death|dead|taunt|special|specialattack|spawn|greet|charm|summon|health|intro|kill|res|resurrect|wound|attack|loop|arrival|escape|whirlwind|enrage|berserk)$/i, "")
      .replace(/[ _-]+$/, "")
      .toLowerCase().trim();
    let propagated = 0;
    {
      const byCluster = new Map();               // cluster -> { sounds:Set, creatures:Set }
      for (const r of db.prepare(`SELECT id, name FROM sounds`).all()) {
        const k = clusterKey(r.name);
        if (k.length < 4) continue;              // too generic to be a family
        if (!byCluster.has(k)) byCluster.set(k, { sounds: new Set(), creatures: new Set() });
        byCluster.get(k).sounds.add(r.id);
      }
      const named = db.prepare(`SELECT DISTINCT sound, creature FROM sound_text WHERE creature IS NOT NULL`).all();
      const soundCluster = new Map();
      for (const [k, v] of byCluster) for (const s of v.sounds) soundCluster.set(s, k);
      for (const r of named) {
        const k = soundCluster.get(r.sound);
        if (k) byCluster.get(k).creatures.add(r.creature);
      }
      const textOf = db.prepare(`SELECT text FROM sound_text WHERE sound = ?1 ORDER BY creature IS NULL, id LIMIT 1`);
      const hasSpeaker = new Set(named.map((r) => r.sound));
      db.transaction(() => {
        for (const [, v] of byCluster) {
          if (v.creatures.size !== 1) continue;  // ambiguous or empty -> leave alone
          const who = [...v.creatures][0];
          for (const s of v.sounds) {
            if (hasSpeaker.has(s)) continue;
            const t = textOf.get(s);
            if (!t || !t.text) continue;         // no transcript -> nothing to credit
            if (credit(s, who)) propagated++;
          }
        }
      })();
    }

    // ---- last resort: the cluster name IS the creature's name ----
    // Blizzard names boss VO after the boss: A_CthunYouWillDie, A_RazorgoreDeath,
    // A_BloodlordMandokirAggro. Where nothing in the scripts or the text tables resolved
    // a speaker, that name is the only evidence left -- and it is good evidence, so long
    // as it is required to be unambiguous rather than merely plausible:
    //   * the cluster token must be >= 5 chars (rules out "anub", "bla" and other stubs),
    //   * it must match exactly ONE creature, either on the full normalized name or as a
    //     unique prefix of it ("razorgore" -> "Razorgore the Untamed"),
    //   * hidden rows and anything already attributed are excluded.
    // A token matching two creatures (or none) is left anonymous. This is a weaker signal
    // than a script call, so it runs last and never overrides one.
    let byName = 0;
    {
      const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const exact = new Map(), all = [];
      // No `hidden` filter: that column is set later in the build than this import runs.
      for (const c of db.prepare(`SELECT entry, name FROM creatures WHERE name <> ''`).all()) {
        const n = normName(c.name);
        if (n.length < 5) continue;
        if (!exact.has(n)) exact.set(n, []);
        exact.get(n).push(c.entry);
        all.push({ entry: c.entry, n });
      }
      // One row per SOUND: the pass credits the sound, so iterating its individual lines
      // would just re-run the same UPDATE.
      const anon = db.prepare(`SELECT DISTINCT t.sound, s.name FROM sound_text t JOIN sounds s ON s.id = t.sound
        WHERE t.creature IS NULL
          AND NOT EXISTS (SELECT 1 FROM sound_text x WHERE x.sound = t.sound AND x.creature IS NOT NULL)`).all();
      db.transaction(() => {
        for (const r of anon) {
          const tok = normName(clusterKey(r.name).replace(/^a[_ -]/i, ""));
          if (tok.length < 5) continue;
          let who = exact.get(tok);
          if (!who) {
            // Both directions. The creature name can extend the token
            // ("razorgore" -> "Razorgore the Untamed"), or the token can extend the
            // creature name when the sound is named after the LINE rather than an event
            // ("A_CthunYouWillDie" -> "C'Thun"). The longest creature name wins, so
            // "Anub'Rekhan" beats a bare "Anub" if both existed.
            let pre = all.filter((c) => c.n.startsWith(tok) || tok.startsWith(c.n));
            // Still nothing: the name may sit INSIDE a longer one on either side --
            // "A_Veklor..." vs "Emperor Vek'lor", "Blackhammer..." vs "Bargul
            // Blackhammer", "Doomcaller..." vs "Hargesh Doomcaller". Substring matching
            // is looser, so it needs a longer token (>= 6) to earn it, and still has to
            // land on exactly one creature.
            if (!pre.length && tok.length >= 6) pre = all.filter((c) => c.n.includes(tok) || tok.includes(c.n));
            const best = pre.reduce((a, b) => (!a || b.n.length > a.n.length ? b : a), null);
            who = best ? [...new Set(pre.filter((c) => c.n === best.n).map((c) => c.entry))] : null;
          }
          if (!who || who.length !== 1) continue;
          if (credit(r.sound, who[0])) byName++;
        }
      })();
    }

    db.exec(`CREATE INDEX idx_creature_sound_sound ON creature_sound(sound)`);
    db.exec(`CREATE INDEX idx_zone_sound_sound ON zone_sound(sound)`);
    db.exec(`CREATE INDEX idx_sound_text_sound ON sound_text(sound)`);
    db.exec(`CREATE INDEX idx_sound_text_creature ON sound_text(creature) WHERE creature IS NOT NULL`);
    // The transcript is the only free text here, and searching it is the point ("find
    // the line that goes ..."), so it gets the same FTS treatment as items/quests.
    db.exec(`CREATE VIRTUAL TABLE sound_text_fts USING fts5(text, content='sound_text', content_rowid='id', tokenize='unicode61')`);
    db.exec(`INSERT INTO sound_text_fts(rowid, text) SELECT id, text FROM sound_text`);
  }
  const ncr = db.prepare(`SELECT COUNT(DISTINCT creature) n FROM creature_sound`).get().n;
  console.log(`  sounds: ${nsnd} | creature_sound: ${ncs} rows / ${ncr} creatures | zone_sound: ${nzs} | sound_text: ${ntx}`);
}

// ---- NPC gossip (what an NPC says when you talk to it) ----
// The words players actually quote live here, not in the sound tables: a voice clip is
// picked from the NPC's VOICE TYPE and shared by every NPC of that type, while the gossip
// text belongs to the one NPC. The two are never linked in the data (only 94 of 13,665
// broadcast_text rows carry a sound id, and no gossip-slot sound has one), so this is the
// only place a phrase like "Time is money, friend" can be searched from.
//   creature_template.gossip_menu_id -> gossip_menu.text_id -> npc_text.BroadcastTextID*
//   -> broadcast_text.male_text
console.log("Importing NPC gossip...");
{
  // Deliberately NOT `WITHOUT ROWID`: npc_gossip_fts is an external-content FTS5 table
  // and keys on the content table's rowid, which such a table doesn't have.
  db.exec(`CREATE TABLE npc_gossip (
    creature INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL,
    UNIQUE (creature, ord))`);
  let ngos = 0, nnpc = 0;
  const have = (t) => src.has(t);
  if (have("gossip_menu") && have("npc_text") && have("broadcast_text")) {
    const btc = src.columns("broadcast_text");
    const iBE = btc.indexOf("entry"), iBM = btc.indexOf("male_text"), iBF = btc.indexOf("female_text");
    const btText = new Map();
    for (const r of src.rows("broadcast_text")) {
      const t = String(r[iBM] ?? "") || String(iBF >= 0 ? (r[iBF] ?? "") : "");
      if (t.trim()) btText.set(Number(r[iBE]), t);
    }
    // npc_text row -> its broadcast ids (up to 8 random variants)
    const ntc = src.columns("npc_text");
    const iNI = ntc.indexOf("ID");
    const bcols = ntc.map((c, i) => (/^BroadcastTextID\d+$/i.test(c) ? i : -1)).filter((i) => i >= 0);
    const ntTexts = new Map();
    if (iNI >= 0 && bcols.length) for (const r of src.rows("npc_text")) {
      const ids = bcols.map((i) => Number(r[i])).filter((v) => v > 0);
      if (ids.length) ntTexts.set(Number(r[iNI]), ids);
    }
    // gossip menu -> its npc_text rows
    const gmc = src.columns("gossip_menu");
    const iGE = gmc.indexOf("entry"), iGT = gmc.indexOf("text_id");
    const menuTexts = new Map();
    if (iGE >= 0 && iGT >= 0) for (const r of src.rows("gossip_menu")) {
      const t = Number(r[iGT]);
      if (!t) continue;
      const e = Number(r[iGE]);
      if (!menuTexts.has(e)) menuTexts.set(e, []);
      menuTexts.get(e).push(t);
    }
    const ins = db.prepare(`INSERT OR IGNORE INTO npc_gossip VALUES (?,?,?)`);
    const ctc = srcColumns("creature_template", "tw_world_creature_template.sql");
    const iCE = ctc.indexOf("entry"), iCG = ctc.indexOf("gossip_menu_id");
    if (iCE >= 0 && iCG >= 0) db.transaction(() => {
      for (const r of srcRows("creature_template", "tw_world_creature_template.sql")) {
        const menu = Number(r[iCG]);
        if (!menu || !menuTexts.has(menu)) continue;
        const entry = Number(r[iCE]);
        const seen = new Set();
        let ord = 0;
        for (const ntId of menuTexts.get(menu)) {
          for (const b of ntTexts.get(ntId) || []) {
            const t = btText.get(b);
            // One menu can point at several npc_text rows that repeat a line; keep one.
            if (!t || seen.has(t)) continue;
            seen.add(t);
            ins.run(entry, ord++, t);
            ngos++;
          }
        }
        if (ord) nnpc++;
      }
    })();
    db.exec(`CREATE VIRTUAL TABLE npc_gossip_fts USING fts5(text, content='npc_gossip', tokenize='unicode61')`);
    db.exec(`INSERT INTO npc_gossip_fts(rowid, text) SELECT rowid, text FROM npc_gossip`);
  } else {
    console.warn("  gossip tables not staged -- npc_gossip skipped");
  }
  console.log(`  npc_gossip: ${ngos} lines across ${nnpc} NPCs`);
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
    moneymax: at("RewMoneyMaxLevel"),
  };
  // XP fallback. Neither cmangos world DB (Classic or TBC) has a RewXP column, and 2.4.3
  // has no QuestXP.dbc either -- so every quest showed no XP at all. But patch 1.10.0
  // added the max-level "quest XP -> gold" conversion, and the server stores its result
  // in RewMoneyMaxLevel (see Quest::GetRewMoneyMaxLevelAtComplete), so RewXP is
  // recoverable by inverting it. Rate measured, not assumed: over Turtle's dump (which
  // has BOTH columns) the money/XP ratio has a hard mode at exactly 0.6, and inverting
  // 0.6 lands on a whole number for 3489/3493 (99.9%) of cmangos quests.
  // Only used when the source LACKS the column -- a source that has RewXP always wins,
  // so the Turtle datasets are untouched (Turtle also rescales some quests to a 6.0
  // ratio, which this would misread).
  const XP_TO_GOLD = 0.6;
  const xpOf = (row) => {
    if (cols.xp >= 0) return clean(row[cols.xp]);
    if (cols.moneymax < 0) return null;
    const m = clean(row[cols.moneymax]);
    return m > 0 ? Math.round(m / XP_TO_GOLD) : null;
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
        clean(row[cols.money]), xpOf(row), clean(row[cols.rewspell]),
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
  // "Unk Item #12 - Quest" is cmangos' own placeholder name for a row it has no data
  // for (258 of them on TBC, all quality 6). Anchored to the start so a real item
  // couldn't match, and paired with the "#<n> - " shape the generator always emits.
  const JUNK = [/^zz/i, /^OLD\b/, /\(OLD\)/, /\bdeprecated\b/i, /^monster\s*-/i,
    /\[ph\]/i, /\[dep\]/i, /\bunused\b/i, /\btest\b/i, /^unk item\s*#?\d/i];
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
  const f = clientData("item-sets.json");
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
    // ONLY within the same expansion. Turtle's zones.json is 1.12 art: standing it in for
    // a TBC dungeon would render the wrong instance, which is worse than rendering none
    // (a missing parchment degrades to the existing tab-only page). TBC also has no
    // interior WorldMapAreas of its own -- those arrived in WotLK.
    const baseZf = join(ROOT, "scripts", "data", "zones.json");
    if (EXPANSION !== "vanilla") {
      console.log(`  zones: Turtle instance-interior fallback skipped (EXPANSION=${EXPANSION} — 1.12 art would be wrong, not missing)`);
    } else if (process.env.ZONES_FILE && existsSync(baseZf) && baseZf !== zf) {
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
  const areaMapid = new Map(db.prepare(`SELECT entry, map_id FROM areas`).all().map((r) => [r.entry, r.map_id]));
  const renderZone = (aid) => {
    let c = aid, g = 0;
    while (c && g++ < 12) { if (zoneSet.has(c)) return c; const p = areaParent.get(c); if (!p || p === c) break; c = p; }
    return zoneSet.has(aid) ? aid : null;
  };
  const subByMap = new Map();
  {
    const sf = clientData("subzone-bounds.json");
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
  // Second source, and the one the terrain can never supply: what the client calls the
  // INSIDE of a building or a cave (WMOAreaTable, via scripts/extract-wmo-areas.py).
  // The terrain chunk over a cave says whatever the surface says -- Turtle painted the
  // rock above the Firewatch Ridge cave as Sherwood Quarry, so half that cave's spawns
  // (Highlord Mastrogonde among them) were filed under Northwind, a different zone on a
  // different continent from the one the game names when you walk in.
  const wmoByMap = new Map();
  {
    const wf = clientData("wmo-areas.json");
    if (existsSync(wf)) {
      const wa = JSON.parse(readFileSync(wf, "utf8"));
      for (const [mid, arr] of Object.entries(wa)) {
        for (const p of arr) for (const g of p.g) g[6] = (g[1] - g[0]) * (g[3] - g[2]) * Math.max(1, g[5] - g[4]);
        wmoByMap.set(Number(mid), arr);
      }
      const ni = [...wmoByMap.values()].reduce((n, a) => n + a.length, 0);
      console.log(`  wmo-areas: ${ni} interiors / ${[...wmoByMap.values()].reduce((n, a) => n + a.reduce((m, p) => m + p.g.length, 0), 0)} group boxes / ${wmoByMap.size} maps`);
    } else {
      console.log("  (no wmo-areas.json -- run scripts/extract-wmo-areas.py; cave/building interiors keep their terrain area)");
    }
  }
  // Returns { zone, sub }: the render zone (as before) plus the EXACT leaf area the
  // point sits in -- the thing the `subzones` feature is built on. `sub` is set ONLY
  // on the clean ADT path below; every guard that rejects a leaf also drops it, since
  // a rejected leaf is actively wrong (the Hateforge chunk tagged area 46 would file
  // its bosses under a Redridge sub-area). INVARIANT, relied on by every subzone
  // query: when sub != null, zone === renderZone(sub) AND the point lies inside that
  // zone's own WMA box -- so subzone reads can be zone-scoped (riding idx_spawn_zone,
  // no extra index) and a subzone's markers always land on its parent's parchment.
  const NO_HOME = { zone: null, sub: null };
  // A leaf area is usable only if it survives two guards. First: the resolved zone must
  // live on the spawn's own map -- some instance ADTs carry a continent AreaTable id
  // (Hateforge Quarry, map 808, has chunks tagged area 46 = Redridge), and without this
  // those bosses get dragged onto the continent zone and vanish from the dungeon map.
  // Second: multi-floor instances -- the 2D ADT area can't tell stacked floors apart
  // (Kel'Thuzad's Upper Necropolis chunk resolves to the main Naxxramas zone), so a point
  // outside the resolved zone's OWN WMA box falls through to the WMA-box search, whose
  // per-floor boxes disambiguate by footprint.
  const acceptLeaf = (map, x, y, aid) => {
    const rz = renderZone(aid);
    if (!rz || zoneMapid.get(rz) !== map) return null;
    const bx = (boxesByMap.get(map) || []).find((z) => z.areaid === rz);
    if (bx && !(x >= bx.locbottom && x <= bx.loctop && y >= bx.locright && y <= bx.locleft)) return null;
    return { zone: rz, sub: aid };
  };
  const isAncestor = (a, of) => {
    let c = areaParent.get(of), g = 0;
    while (c && g++ < 12) { if (c === a) return true; const p = areaParent.get(c); if (!p || p === c) break; c = p; }
    return false;
  };
  // The smallest GROUP box containing the point, off the placement whose outer AABB
  // contains it. Group boxes, not the placement AABB: Stormwind's is 1488 yards square
  // and would swallow half of Elwynn.
  const wmoLeaf = (map, x, y, z) => {
    if (z == null) return null;
    let best = null, bestVol = Infinity;
    for (const p of wmoByMap.get(map) || []) {
      if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1 || z < p.z0 || z > p.z1) continue;
      for (const g of p.g) {
        if (x < g[0] || x > g[1] || y < g[2] || y > g[3] || z < g[4] || z > g[5]) continue;
        if (g[6] < bestVol) { bestVol = g[6]; best = p.i; }
      }
    }
    return best;
  };
  const terrainLeaf = (map, x, y) => {
    let best = null, bestArea = Infinity;
    for (const b of subByMap.get(map) || []) {
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      if (b.area < bestArea) { bestArea = b.area; best = b.i; }
    }
    return best;
  };
  const homeZone = (map, x, y, z) => {
    if (x == null || y == null) return NO_HOME;
    const t = terrainLeaf(map, x, y);
    let w = wmoLeaf(map, x, y, z);
    // A WMO box is an AABB around real geometry, so it reaches past the walls. Where it
    // claims the PARENT of what the terrain already says, the terrain is both correct and
    // more specific and wins: Stormwind's model reaches over the Valley of Heroes, and
    // "Stormwind City" is not an improvement on "Valley of Heroes". The cave case this
    // whole path exists for is never a parent/child pair -- Firewatch Ridge and Sherwood
    // Quarry sit under different zones entirely.
    if (w != null && t != null && (w === t || isAncestor(w, t))) w = null;
    // An instance's ENTRANCE is modelled on the continent but its area belongs to the
    // instance map (Westfall's Deadmines cave is AreaTable 1581, map 36; the Barrens'
    // Wailing Caverns cave is map 43). Both have a continent WorldMapArea row too, so
    // acceptLeaf would happily take them and quietly move those spawns off the zone page
    // they belong to and into a mini-map that exists to show an entrance. The zone the
    // client names there is right; the zone this site can draw is the continent one.
    if (w != null && areaMapid.has(w) && areaMapid.get(w) !== map) w = null;
    for (const aid of [w, t]) {
      if (aid == null) continue;
      const hit = acceptLeaf(map, x, y, aid);
      if (hit) return hit;
    }
    const boxes = boxesByMap.get(map);
    if (!boxes) return NO_HOME;
    let best = null, bestArea = Infinity;
    for (const z of boxes) {
      if (x < z.locbottom || x > z.loctop || y < z.locright || y > z.locleft) continue;
      if (z.area > 0 && z.area < bestArea) { bestArea = z.area; best = z; }
    }
    return best ? { zone: best.areaid, sub: null } : NO_HOME;
  };

  db.exec(`CREATE TABLE spawn_points (kind TEXT, id INTEGER, map INTEGER, x REAL, y REAL, zone INTEGER, sub INTEGER)`);
  const sSp = db.prepare(`INSERT INTO spawn_points VALUES (?,?,?,?,?,?,?)`);
  const loadSpawns = (file, table, kind) => {
    const cols = srcColumns(table, file);
    // Emit a point per distinct non-zero id slot. creature has id/id2/id3/id4
    // (random-pick); gameobject has only `id`, so the missing cols filter out.
    const idCols = ["id", "id2", "id3", "id4"].map((c) => cols.indexOf(c)).filter((i) => i >= 0);
    const iMap = cols.indexOf("map"), iX = cols.indexOf("position_x"), iY = cols.indexOf("position_y");
    // z is not stored (spawn_points is 2D) but it is what separates a cave from the
    // mountain over it, so the WMO-interior test needs it here.
    const iZ = cols.indexOf("position_z");
    let n = 0;
    db.transaction(() => {
      for (const row of srcRows(table, file)) {
        const map = clean(row[iMap]), x = clean(row[iX]), y = clean(row[iY]);
        const home = homeZone(map, x, y, iZ >= 0 ? clean(row[iZ]) : null); // shared by every id at this point
        const seen = new Set();
        for (const i of idCols) {
          const id = clean(row[i]);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          sSp.run(kind, id, map, x, y, home.zone, home.sub);
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
    // Turtle-only: hand-maintained from Turtle's ScriptDev2 enums (see instance-bosses).
    const lf = SQL_SOURCE === "turtle" ? join(ROOT, "scripts", "data", "scripted-spawn-links.json") : null;
    if (lf && existsSync(lf)) {
      const { links = {} } = JSON.parse(readFileSync(lf, "utf8"));
      const copy = db.prepare(`INSERT INTO spawn_points (kind, id, map, x, y, zone, sub)
        SELECT 'c', ?1, map, x, y, zone, sub FROM spawn_points INDEXED BY idx_spawn_id WHERE kind = 'c' AND id = ?2`);
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

  // Sub-areas ("subzones"): Elwynn Forest -> Goldshire / Northshire Valley / Fargodeep
  // Mine. The hierarchy has always shipped in `areas` and homeZone now keeps each
  // spawn's exact leaf, so this is a pure roll-up -- one row per sub-area worth a page,
  // carrying its parent's RENDER zone (the parchment it draws on), the ADT bounding box
  // the map fits to, and the counts the search/browse/tab lists sort by. Runtime never
  // scans spawn_points for these numbers.
  console.log("Deriving subzones...");
  db.exec(`CREATE TABLE subzones (entry INTEGER PRIMARY KEY, name TEXT, zone_id INTEGER, map_id INTEGER,
    x0 REAL, x1 REAL, y0 REAL, y1 REAL,
    spawns INTEGER, npcs INTEGER, objects INTEGER, quests INTEGER)`);
  {
    const bbox = new Map(); // areaId -> the SAME box homeZone resolved against
    for (const arr of subByMap.values()) for (const b of arr) if (!bbox.has(b.i)) bbox.set(b.i, b);
    // An area that exists only as a building/cave interior (Gallows' End Tavern, The
    // Slag Pit) has no terrain chunks at all; its WMO placement is the only footprint
    // there is, so the page has something to fit its map to.
    for (const arr of wmoByMap.values()) for (const p of arr) if (!bbox.has(p.i)) bbox.set(p.i, p);
    const agg = new Map();
    const bump = (id, k, v) => {
      if (id == null) return;
      let a = agg.get(id);
      if (!a) agg.set(id, (a = { spawns: 0, npcs: 0, objects: 0, quests: 0 }));
      a[k] += v;
    };
    for (const r of db.prepare(`SELECT sub, COUNT(*) n, COUNT(DISTINCT id) d FROM spawn_points
      WHERE kind = 'c' AND sub IS NOT NULL GROUP BY sub`).all()) { bump(r.sub, "spawns", r.n); bump(r.sub, "npcs", r.d); }
    for (const r of db.prepare(`SELECT sub, COUNT(*) n FROM spawn_points
      WHERE kind = 'o' AND sub IS NOT NULL GROUP BY sub`).all()) bump(r.sub, "objects", r.n);
    // quests.zone is ALREADY a leaf area id. `quests.hidden` doesn't exist yet at this
    // point in the build, so count with the same `title <> ''` predicate the Quests tab
    // itself renders -- the number shown and the number counted then agree.
    for (const r of db.prepare(`SELECT zone, COUNT(*) n FROM quests WHERE title <> '' GROUP BY zone`).all())
      bump(r.zone, "quests", r.n);

    const ins = db.prepare(`INSERT INTO subzones VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const seenZones = new Set();
    let n = 0, withBox = 0;
    db.transaction(() => {
      // `zone_id > 0` alone already excludes the render zones (none of them has a
      // parent); the UNUSED filter drops the client's dev leftovers ("Valley of Heroes
      // UNUSED"), which would otherwise be searchable.
      for (const a of db.prepare(`SELECT entry, name, map_id FROM areas
        WHERE zone_id > 0 AND trim(name) <> '' AND name NOT LIKE '%UNUSED%'`).all()) {
        const c = agg.get(a.entry);
        if (!c || c.spawns + c.objects + c.quests === 0) continue;
        // The RENDER zone, not areas.zone_id: it's the parchment the page draws, it
        // equals spawn_points.zone by the homeZone invariant, and it collapses the
        // handful of areas whose own parent is itself a sub-area.
        const rz = renderZone(a.entry);
        if (!rz) continue;
        const b = bbox.get(a.entry);
        if (b) withBox++;
        ins.run(a.entry, a.name, rz, a.map_id,
          b ? b.x0 : null, b ? b.x1 : null, b ? b.y0 : null, b ? b.y1 : null,
          c.spawns, c.npcs, c.objects, c.quests);
        seenZones.add(rz);
        n++;
      }
    })();
    db.exec(`CREATE INDEX idx_subzones_zone ON subzones(zone_id)`);
    console.log(`  subzones: ${n} across ${seenZones.size} zones (${withBox} with a bbox)`);
  }

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
  const lf = clientData("locks.json");
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

// ---- Derived item peer baseline (powers the item page's "vs. typical …" card) ----
// The cohort key (class/subclass/slot/quality/ilvl band, with a coarsening fallback)
// can't be grouped by any index at runtime, so the medians + ranks are precomputed
// here and the page reads one primary-key row. See lib/itempeers.mjs.
console.log("Deriving item_peer...");
{
  db.exec(`CREATE TABLE item_peer_cohort (id INTEGER PRIMARY KEY, label TEXT, n INTEGER,
    n_armor INTEGER, n_dps INTEGER, n_stats INTEGER, armor REAL, dps REAL, stats REAL)`);
  db.exec(`CREATE TABLE item_peer (item INTEGER PRIMARY KEY, cohort INTEGER,
    armor REAL, dps REAL, stats REAL, armor_rank INTEGER, dps_rank INTEGER, stats_rank INTEGER)`);
  // Dev artifacts are excluded from the cohorts as well as hidden rows: the medians
  // survive them (that's the point of a median), but they inflate the "of N items"
  // counts the card quotes.
  const gear = db.prepare(`SELECT entry, class, subclass, inventory_type, quality, item_level,
    armor, dmg_min1, dmg_max1, dmg_min2, dmg_max2, delay
    FROM items WHERE inventory_type > 0 AND class IN (2, 4) AND hidden = 0
      AND entry NOT IN (SELECT item FROM item_sources WHERE source = 'unobtainable')`).all();
  // "Base stats" = the five 1.12 primaries; comparable across a slot in a way that
  // mixing in +spell power / +crit would not be.
  const statTotal = new Map();
  for (const r of db.prepare(`SELECT item, SUM(value) v FROM item_stats
      WHERE stat IN ('str','agi','sta','int','spi') GROUP BY item`).all()) statTotal.set(r.item, r.v);
  const { cohorts, peers, unassigned } = deriveItemPeers(gear, statTotal);
  const insC = db.prepare(`INSERT INTO item_peer_cohort VALUES (?,?,?,?,?,?,?,?,?)`);
  const insP = db.prepare(`INSERT INTO item_peer VALUES (?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const c of cohorts) insC.run(c.id, c.label, c.n, c.n_armor, c.n_dps, c.n_stats, c.armor, c.dps, c.stats);
    for (const p of peers) insP.run(p.item, p.cohort, p.armor, p.dps, p.stats, p.armor_rank, p.dps_rank, p.stats_rank);
  })();
  console.log(`  item_peer: ${peers.length} items in ${cohorts.length} cohorts | ${unassigned} too niche to compare`);
}

// ---- Derived zone profile (powers the zone page's stat strip) ----
// What a zone IS at a glance: how busy, what levels you meet there, how much of it
// is elite, how many quests and gather nodes -- plus where it ranks among the other
// zones of its continent ("6th busiest of 45"). Everything comes from tables that
// already exist; the ranks are what a page can't work out for itself, since it only
// ever loads its own zone. Same shape as item_peer: precompute, then one PK lookup.
console.log("Deriving zone_stats...");
{
  db.exec(`CREATE TABLE zone_stats (zone INTEGER PRIMARY KEY, mapid INTEGER,
    spawns INTEGER, objects INTEGER, npcs INTEGER, elites INTEGER, rares INTEGER, bosses INTEGER,
    gather INTEGER, quests INTEGER, lvl_lo INTEGER, lvl_med INTEGER, lvl_hi INTEGER,
    rank_spawns INTEGER, rank_quests INTEGER, n_zones INTEGER, med_spawns REAL, med_quests REAL)`);
  const zoneRows = db.prepare(`SELECT areaid, mapid FROM zones WHERE name <> ''`).all();
  const st = new Map();
  for (const z of zoneRows) st.set(z.areaid, { zone: z.areaid, mapid: z.mapid, spawns: 0, objects: 0,
    npcs: new Set(), elites: 0, rares: new Set(), bosses: new Set(), gather: 0, quests: 0, levels: [] });

  // Creature spawn points, joined to the creature so each POINT carries its level and
  // rank -- the levels are weighted by spawn count on purpose: what you actually run
  // into in the zone, not what its rarest mob happens to be.
  for (const r of db.prepare(`SELECT s.zone, s.id, c.level_min, c.level_max, c.rank
      FROM spawn_points s JOIN creatures c ON c.entry = s.id
      WHERE s.kind = 'c' AND c.hidden = 0`).all()) {
    const z = st.get(r.zone); if (!z) continue;
    z.spawns++;
    z.npcs.add(r.id);
    if (r.rank === 1) z.elites++;
    else if (r.rank === 2) z.rares.add(r.id);
    else if (r.rank === 3) z.bosses.add(r.id);
    const lvl = r.level_max || r.level_min;
    if (lvl > 0) z.levels.push(lvl);
  }
  for (const r of db.prepare(`SELECT s.zone, g.gather FROM spawn_points s
      JOIN gameobjects g ON g.entry = s.id WHERE s.kind = 'o'`).all()) {
    const z = st.get(r.zone); if (!z) continue;
    z.objects++;
    if (r.gather) z.gather++;
  }
  for (const r of db.prepare(`SELECT zone, COUNT(*) n FROM quests WHERE hidden = 0 GROUP BY zone`).all()) {
    const z = st.get(r.zone); if (z) z.quests = r.n;
  }

  // Level SPREAD as p10-p90, not min-max: one stray level-60 rare would otherwise
  // make a starting zone read "levels 1-60".
  const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
  // Ranks are per continent (mapid) over zones that have any spawns -- comparing a
  // populated zone against empty client-only areas would flatter it.
  const byMap = new Map();
  for (const z of st.values()) {
    if (!(z.spawns + z.objects + z.quests)) continue;
    if (!byMap.has(z.mapid)) byMap.set(z.mapid, []);
    byMap.get(z.mapid).push(z);
  }
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
  const ins = db.prepare(`INSERT INTO zone_stats VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  db.transaction(() => {
    for (const [, zs] of byMap) {
      const bySpawns = [...zs].sort((a, b) => b.spawns - a.spawns);
      const byQuests = [...zs].sort((a, b) => b.quests - a.quests);
      const rankOf = (list, key) => { // competition rank, ties share
        const m = new Map();
        list.forEach((z, i) => { if (!m.has(z[key])) m.set(z[key], i + 1); });
        return (z) => m.get(z[key]);
      };
      const rs = rankOf(bySpawns, "spawns"), rq = rankOf(byQuests, "quests");
      const medS = median(zs.map((z) => z.spawns)), medQ = median(zs.map((z) => z.quests));
      for (const z of zs) {
        const lv = z.levels.sort((a, b) => a - b);
        ins.run(z.zone, z.mapid, z.spawns, z.objects, z.npcs.size, z.elites, z.rares.size, z.bosses.size,
          z.gather, z.quests, pct(lv, 0.1), pct(lv, 0.5), pct(lv, 0.9),
          rs(z), rq(z), zs.length, medS, medQ);
        n++;
      }
    }
  })();
  console.log(`  zone_stats: ${n} zones across ${byMap.size} maps`);
}


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
// The flag answers "is this row absent from vanilla 1.12?", so it is only meaningful for
// a vanilla-era dataset. On a TBC dataset every one of the ~5.4k TBC additions is
// legitimately not in the vanilla list, and flagging them all "Turtle custom" would be
// nonsense -- leave the column 0 and let the UI show no origin badge.
const flagCustom = EXPANSION === "vanilla";
if (!flagCustom) console.log(`  custom flag: skipped (EXPANSION=${EXPANSION}; the vanilla id list doesn't apply)`);
for (const [tbl, key, cutoff] of [["items", "items", 24283], ["creatures", "creatures", 17999], ["quests", "quests", 9999]]) {
  db.exec(`ALTER TABLE ${tbl} ADD COLUMN custom INTEGER NOT NULL DEFAULT 0`);
  const ids = flagCustom ? vanillaIds?.[key] : null;
  if (!flagCustom) continue;
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
// ---- voice lines: abbreviations, disambiguated by a sibling family's zone ----
// Runs HERE, not in the sounds import: it needs creatures.zone, which is assigned later
// in the build. Adds rows to sound_text, so it re-syncs sound_text_fts after itself.
if (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='sound_text'`).get().n) {
  const wordsOf = (x) => String(x || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const creatureRows = db.prepare(`SELECT entry, name, zone FROM creatures WHERE name <> ''`).all();
  // tag -> the zones its already-attributed sounds belong to. The Naxxramas VO is named
  // A_<ABBREV>_NAXX_<EVENT>; three or four characters match far too many creatures alone,
  // but the families that already resolved through the second token (A_ANU_NAXX_ ->
  // Anub'Rekhan) pin down which zone "naxx" means, and that makes the abbreviation unique.
  // Learned from the data, so no hand-written abbreviation table and it generalises to any
  // instance whose VO follows the convention.
  const zonesByTag = new Map();
  for (const r of db.prepare(`SELECT DISTINCT s.name AS sname, c.zone FROM sound_text t
      JOIN sounds s ON s.id = t.sound JOIN creatures c ON c.entry = t.creature
      WHERE t.creature IS NOT NULL AND c.zone IS NOT NULL`).all()) {
    for (const w of wordsOf(r.sname)) {
      if (w.length < 3) continue;
      if (!zonesByTag.has(w)) zonesByTag.set(w, new Map());
      const m = zonesByTag.get(w);
      m.set(r.zone, (m.get(r.zone) || 0) + 1);
    }
  }
  // One row per SOUND, and the speaker is written onto the EXISTING lines rather than
  // inserted as a credited copy -- see `creditSound` in the import above: a copy showed
  // up as the sound's whole line set listed twice once the UI stopped quoting one row.
  const anon = db.prepare(`SELECT DISTINCT t.sound, s.name FROM sound_text t JOIN sounds s ON s.id = t.sound
    WHERE t.creature IS NULL
      AND NOT EXISTS (SELECT 1 FROM sound_text x WHERE x.sound = t.sound AND x.creature IS NOT NULL)`).all();
  const ins = db.prepare(`UPDATE sound_text SET creature = ?2 WHERE sound = ?1 AND creature IS NULL`);
  let byAbbrev = 0;
  db.transaction(() => {
    for (const r of anon) {
      const ws = wordsOf(r.name).filter((w) => w !== "a");
      const abbrev = ws[0];
      if (!abbrev || abbrev.length < 3) continue;
      let zoneSet = null, bestN = 0;
      for (const w of ws.slice(1)) {
        const m = zonesByTag.get(w);
        if (!m) continue;
        const n = [...m.values()].reduce((x, y) => x + y, 0);
        if (n > bestN) { bestN = n; zoneSet = new Set(m.keys()); }
      }
      let cands = creatureRows.filter((c) => wordsOf(c.name).some((w) => w.startsWith(abbrev)));
      if (cands.length > 1 && zoneSet) cands = cands.filter((c) => zoneSet.has(c.zone));
      const uniq = [...new Set(cands.map((c) => c.entry))];
      if (uniq.length !== 1) continue;          // still ambiguous -> leave anonymous
      if (ins.run(r.sound, uniq[0]).changes) byAbbrev++;
    }
  })();
  // sound_text_fts is an EXTERNAL-CONTENT table, so DELETE FROM it is invalid
  // (SQLITE_CORRUPT_VTAB). 'rebuild' is the documented way to resync one to its content.
  if (byAbbrev) db.exec(`INSERT INTO sound_text_fts(sound_text_fts) VALUES('rebuild')`);

  // ---- speakers for clips that have NO transcript ----
  // Most of Turtle's own voice acting is never written down anywhere: the C++ plays the
  // clip and the character says nothing in text. Those sounds never reach sound_text, so
  // every pass above is blind to them -- yet their names identify the speaker as plainly
  // as the transcribed ones do (Ostarius_Intro1, Perotharn_DEATH, Ursol_Phase2).
  // A speaker shouldn't require a transcript, so these are attached through
  // creature_sound instead, under a 'Voice' slot. Same matching rules and the same
  // requirement of a unique creature; ambiguous ones stay blank.
  const insCs2 = db.prepare(`INSERT OR IGNORE INTO creature_sound VALUES (?,?,'Voice',300)`);
  // VOICE-ACTING files only. Without that guard this matched music: "EversongNight" ->
  // "E'llo Turtle'mon", "HyjalPastDay" -> "PvP H-Mid Credit Marker". A zone track's name
  // is not a creature's name, and a loose substring will always find something.
  const orphans = db.prepare(`SELECT s.id, s.name FROM sounds s
    WHERE s.files LIKE '["interface/va/%'
      AND NOT EXISTS (SELECT 1 FROM sound_text t WHERE t.sound = s.id AND t.creature IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM creature_sound cs WHERE cs.sound = s.id)`).all();
  let voiceNamed = 0;
  db.transaction(() => {
    for (const r of orphans) {
      const ws = wordsOf(r.name).filter((w) => w !== "a" && !/^mp3$/i.test(w));
      const tok = ws[0];
      if (!tok || tok.length < 4) continue;
      let cands = creatureRows.filter((c) => wordsOf(c.name).some((w) => w === tok));
      if (!cands.length) cands = creatureRows.filter((c) => wordsOf(c.name).some((w) => w.startsWith(tok) || tok.startsWith(w)));
      if (!cands.length && tok.length >= 6) {
        const t2 = tok.replace(/[^a-z0-9]/g, "");
        cands = creatureRows.filter((c) => String(c.name).toLowerCase().replace(/[^a-z0-9]/g, "").includes(t2));
      }
      const uniq = [...new Set(cands.map((c) => c.entry))];
      if (uniq.length !== 1) continue;
      insCs2.run(uniq[0], r.id);
      voiceNamed++;
    }
  })();
  console.log(`  creature_sound: +${voiceNamed} transcript-less clips matched to a speaker by name`);
  const namedNow = db.prepare(`SELECT COUNT(DISTINCT sound) n FROM sound_text WHERE creature IS NOT NULL`).get().n;
  console.log(`  sound_text: ${byAbbrev} sounds credited by abbreviation -> ${namedNow} sounds name a speaker`);
}

console.log("Building FTS indexes...");
db.exec(`CREATE VIRTUAL TABLE items_fts USING fts5(name, content='items', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO items_fts(rowid, name) SELECT entry, name FROM items WHERE hidden = 0`);
db.exec(`CREATE VIRTUAL TABLE creatures_fts USING fts5(name, subname, content='creatures', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO creatures_fts(rowid, name, subname) SELECT entry, name, subname FROM creatures WHERE name IS NOT NULL AND name <> '' AND hidden = 0`);
db.exec(`CREATE VIRTUAL TABLE quests_fts USING fts5(title, content='quests', content_rowid='entry', tokenize='unicode61')`);
db.exec(`INSERT INTO quests_fts(rowid, title) SELECT entry, title FROM quests WHERE title IS NOT NULL AND title <> '' AND hidden = 0`);
db.exec(`CREATE VIRTUAL TABLE spells_fts USING fts5(name, description, content='spells', content_rowid='entry', tokenize='unicode61')`);
// A learn-stub is dropped only when the spell it TEACHES is itself indexed: then it's
// a pure duplicate ("Blessing of Might" listed 15 rows, 7 real ranks + 8 stubs). When
// the target isn't in the index, the stub is the only handle on that name (252 such
// rows -- "Curse of Archimonde", "Holy Word: Shield" and other unused leftovers), so
// dropping it would make the name unfindable rather than tidier.
const SPELL_SEARCHABLE = `name IS NOT NULL AND name <> '' AND hidden = 0
  AND (teaches IS NULL OR NOT EXISTS (
    SELECT 1 FROM spells t WHERE t.entry = spells.teaches AND t.hidden = 0 AND t.name IS NOT NULL AND t.name <> ''))`;
db.exec(`INSERT INTO spells_fts(rowid, name, description) SELECT entry, name, description FROM spells WHERE ${SPELL_SEARCHABLE}`);

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
db.exec(`INSERT INTO spells_tg(rowid, name) SELECT entry, name FROM spells WHERE ${SPELL_SEARCHABLE}`);

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
  const famFile = clientData("creature-families.json");
  const petFile = clientData("pet-families.json");
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
