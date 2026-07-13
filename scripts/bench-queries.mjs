// LOCAL query benchmark — times every Q_* in src/queries.js against the built DB and
// flags slow queries + suspicious EXPLAIN QUERY PLANs (full SCAN / TEMP B-TREE /
// AUTOMATIC INDEX). Purely a dev tool for finding indexing low-hanging fruit; not wired
// into CI. Opens read-only with the SAME runtime pragmas as src/db-worker.js so numbers
// track the browser Worker (minus WASM overhead).
//
// Params are auto-resolved to WORST-CASE "hot" ids (the entity with the most rows) per
// query kind, so timings reflect the heaviest real page, not an empty lookup.
//
// Run:  bun scripts/bench-queries.mjs            (full table, sorted slowest-first)
//       bun scripts/bench-queries.mjs --plans    (also print the plan for flagged queries)
//       bun scripts/bench-queries.mjs --top 20   (limit the printed table)
//       DB_PATH=... bun scripts/bench-queries.mjs
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./lib/sqlite.mjs";
import * as Q from "../src/queries.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.DB_PATH || join(ROOT, "public", "data", "tortoise.sqlite");
const argv = process.argv.slice(2);
const SHOW_PLANS = argv.includes("--plans");
const TOP = (() => { const i = argv.indexOf("--top"); return i >= 0 ? Number(argv[i + 1]) : Infinity; })();

const db = await openDatabase(DB);
// mirror db-worker.js runtime pragmas
for (const p of ["cache_size=-32768", "temp_store=MEMORY", "query_only=ON"]) db.exec(`PRAGMA ${p}`);

// ---- hot-id resolution (worst case per kind) ----
const one = (s) => { try { return db.prepare(s).get(); } catch { return null; } };
const hot = {
  ITEM: one("SELECT item id FROM drops GROUP BY item ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  NPC: one("SELECT owner id FROM drops WHERE src='c' GROUP BY owner ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  QUEST: one("SELECT entry id FROM quests WHERE (nextquest<>0 OR prevquest<>0) AND title<>'' ORDER BY entry LIMIT 1")?.id,
  SPELL: one("SELECT spellid_1 id FROM items WHERE spellid_1>0 GROUP BY spellid_1 ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  OBJECT: one("SELECT owner id FROM drops WHERE src='o' GROUP BY owner ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  SET: one("SELECT set_id id FROM items WHERE set_id>0 GROUP BY set_id ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  FACTION: one("SELECT id FROM factions ORDER BY items DESC LIMIT 1")?.id,
  ZONE: one("SELECT zone id FROM spawn_points GROUP BY zone ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  MAP: one("SELECT map id FROM spawn_points WHERE map IN (0,1) GROUP BY map ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  DUNGEON: one("SELECT map id FROM spawns WHERE map NOT IN (0,1) GROUP BY map ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  DISPLAY: one("SELECT display_id id FROM items WHERE display_id>0 GROUP BY display_id ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  ICON: one("SELECT di.icon id FROM item_display_info di JOIN items i ON i.display_id=di.ID GROUP BY di.icon ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  SKILL: one("SELECT skill id FROM spells WHERE skill>0 GROUP BY skill ORDER BY COUNT(*) DESC LIMIT 1")?.id,
  PAGE: one("SELECT entry id FROM page_text LIMIT 1")?.id,
  CONTINENT: 0,
};

// ---- per-query param spec (kind => hot value; arrays are literal param lists) ----
// FTS/LIKE search strings sized to a common infix ("opper" hits Copper/Chopper/...).
const SEARCH4 = ["copper*", "Copper", 50, '"opper"'];      // fts, name, limit, trigram
const SEARCH3 = ["%opper%", "Copper", 50];                  // like, exact, limit
const K = (kind) => hot[kind];
const SPEC = {
  // 2+ param specials
  Q_SAME_MODEL: [K("DISPLAY"), K("ITEM")],
  Q_ZONE_FOCUS_SPAWNS: [K("ZONE"), K("ITEM")],
  Q_DUNGEON_QUESTS: [K("DUNGEON"), 255],
  Q_GUIDE_QUESTS: [K("ZONE"), 255],
  Q_WORLD_NPC_FILTER: ["copper*", '"opper"'],
  Q_SEARCH_ITEMS: SEARCH4, Q_SEARCH_NPCS: SEARCH4, Q_SEARCH_QUESTS: SEARCH4, Q_SEARCH_SPELLS: SEARCH4,
  Q_SEARCH_DUNGEONS: SEARCH3, Q_SEARCH_ZONES: SEARCH3, Q_SEARCH_FACTIONS: SEARCH3,
  Q_SEARCH_OBJECTS: SEARCH3, Q_SEARCH_ITEMSETS: SEARCH3,
};
// 1-param queries by kind (name -> kind)
const KIND = {
  ITEM: ["Q_ITEM","Q_ID_ITEM","Q_ITEM_STATS","Q_ITEM_SOURCES","Q_ITEM_SUFFIXES","Q_ITEM_OBJECT_SPAWNS","Q_ITEM_ICON","Q_DROPPED_BY","Q_SOLD_BY","Q_CONTAINED_IN","Q_CONTAINS","Q_DISENCHANTS_INTO","Q_QUEST_ITEM","Q_STARTS_QUEST","Q_CREATED_BY","Q_REAGENT_FOR","Q_TEACHES","Q_OBJECT_SOURCE","Q_OBJECT_SOURCE_ENTRIES"],
  NPC: ["Q_NPC","Q_ID_NPC","Q_NPC_CARD","Q_NPC_LOOT","Q_NPC_SKIN","Q_NPC_PICK","Q_NPC_SELLS","Q_NPC_TRAINS","Q_NPC_STARTS","Q_NPC_ENDS","Q_NPC_MAPS","Q_NPC_SPAWNS","Q_NPC_QUEST_ZONES","Q_NPC_OBJECTIVE_OF"],
  QUEST: ["Q_QUEST","Q_ID_QUEST","Q_QUEST_BRIEF","Q_QUEST_CHAIN","Q_QUEST_CREATURES","Q_QUEST_ITEMS","Q_QUEST_REP","Q_QUEST_GIVERS_NPC","Q_QUEST_ENDERS_NPC","Q_QUEST_GIVERS_GO","Q_QUEST_ENDERS_GO"],
  SPELL: ["Q_SPELL","Q_ID_SPELL","Q_SPELL_PRODUCES","Q_SPELL_REAGENTS","Q_SPELL_USED_BY","Q_SPELL_TRAINERS","Q_SPELL_BOOKS","Q_SPELL_REWARD_QUESTS","Q_SPELL_SOURCE"],
  OBJECT: ["Q_OBJECT","Q_ID_OBJECT","Q_OBJECT_SIBLINGS"],
  SET: ["Q_ITEM_SET","Q_ITEMSET_MEMBERS","Q_ITEMSET_BONUSES","Q_ITEMSET_STATS"],
  FACTION: ["Q_FACTION","Q_FACTION_ITEMS","Q_FACTION_MOBS","Q_FACTION_NPCS","Q_FACTION_QUESTS","Q_NPC_FACTION"],
  ZONE: ["Q_ZONE","Q_ZONE_LOOT","Q_ZONE_OBJECTS","Q_ZONE_QUESTS","Q_ZONE_SPAWNS","Q_DUNGEON_ZONE","Q_MAP_FLOORS","Q_MAP_OBJECTS"],
  // instance maps (a real dungeon page) — NOT a continent
  DUNGEON: ["Q_MAP_TYPE","Q_MAP_BOSSES","Q_MAP_SPAWNS","Q_DUNGEON","Q_DUNGEON_NPCS","Q_DUNGEON_LOOT","Q_DUNGEON_BOSS_LOOT"],
  // the seamless world map — continent 0/1, inherently large result sets
  MAP: ["Q_WORLD_SPAWNS","Q_WORLD_OBJECTS"],
  CONTINENT: ["Q_CONTINENT_ZONES","Q_TAXI_NODES","Q_TAXI_ROUTES"],
  ICON: ["Q_ICON_ITEMS","Q_ICON_SPELLS"],
  SKILL: ["Q_PROFESSION_LEARN"],
  PAGE: ["Q_PAGE_TEXT"],
};
const nameKind = {};
for (const [kind, names] of Object.entries(KIND)) for (const n of names) nameKind[n] = kind;

function paramsFor(name, sql) {
  if (SPEC[name]) return SPEC[name];
  const maxP = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => +m[1]));
  if (maxP === 0) return [];
  const kind = nameKind[name];
  if (kind && maxP === 1) return [K(kind)];
  return null; // unresolved
}

// ---- plan analysis ----
function planFlags(sql, params) {
  let rows;
  try { rows = db.prepare("EXPLAIN QUERY PLAN " + sql).all(...params); } catch { return { flags: [], text: "(plan err)" }; }
  const text = rows.map((r) => r.detail).join(" | ");
  const flags = [];
  // full table scan (ignore virtual/FTS SCANs and covering-index scans, which are fine)
  if (/\bSCAN\b(?!.*USING (COVERING )?INDEX)(?!.*VIRTUAL)/.test(text)) flags.push("SCAN");
  if (/USE TEMP B-TREE/.test(text)) flags.push("TEMP-BTREE");
  if (/AUTOMATIC/.test(text)) flags.push("AUTO-INDEX");
  return { flags, text };
}

// ---- timing ----
function bench(stmt, params) {
  const warm = (() => { const s = performance.now(); const r = stmt.all(...params); return { ms: performance.now() - s, n: r.length }; })();
  const iters = warm.ms > 20 ? 15 : warm.ms > 3 ? 50 : 200;
  const t = [];
  for (let i = 0; i < iters; i++) { const s = performance.now(); stmt.all(...params); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  return { median: t[t.length >> 1], p95: t[Math.min(t.length - 1, Math.floor(t.length * 0.95))], rows: warm.n, iters };
}

// ---- run ----
const results = [], unresolved = [], errored = [];
for (const [name, sql] of Object.entries(Q)) {
  if (typeof sql !== "string" || !name.startsWith("Q_")) continue;
  const params = paramsFor(name, sql);
  if (params === null) { unresolved.push(name); continue; }
  if (params.some((p) => p === undefined)) { unresolved.push(name); continue; }
  let stmt;
  try { stmt = db.prepare(sql); } catch (e) { errored.push([name, e.message]); continue; }
  let r;
  try { r = bench(stmt, params); } catch (e) { errored.push([name, e.message]); continue; }
  const { flags, text } = planFlags(sql, params);
  results.push({ name, ...r, flags, plan: text, params });
}

results.sort((a, b) => b.median - a.median);
const pad = (s, n) => String(s).padEnd(n);
const ms = (x) => x.toFixed(2).padStart(8);
console.log(`\nDB: ${DB}`);
console.log(`benched ${results.length} queries | unresolved ${unresolved.length} | errored ${errored.length}\n`);
console.log(pad("query", 26), pad("median", 8), pad("p95", 8), pad("rows", 7), "flags");
console.log("-".repeat(78));
for (const r of results.slice(0, TOP)) {
  console.log(pad(r.name, 26), ms(r.median), ms(r.p95), pad(r.rows, 7), r.flags.join(",") || "");
}

// low-hanging fruit: slow AND a plan smell
const fruit = results.filter((r) => r.median > 1 && r.flags.length).sort((a, b) => b.median - a.median);
if (fruit.length) {
  console.log(`\n=== LOW-HANGING FRUIT (median > 1ms + plan smell) — ${fruit.length} ===`);
  for (const r of fruit) {
    console.log(`\n${r.name}  ${r.median.toFixed(2)}ms  [${r.flags.join(",")}]  rows=${r.rows}  params=${JSON.stringify(r.params)}`);
    if (SHOW_PLANS) console.log("  " + r.plan);
  }
}
if (unresolved.length) console.log(`\nunresolved params (skipped): ${unresolved.join(", ")}`);
if (errored.length) { console.log("\nerrored:"); for (const [n, m] of errored) console.log(`  ${n}: ${m}`); }
db.close();
