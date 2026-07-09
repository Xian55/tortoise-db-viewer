// Per-deploy "What's new" changelog for a dataset (currently the dev / 1181dev DB).
//
// Diffs the freshly-built shipped DB against the PREVIOUS deployed one (downloaded
// from R2 by the workflow) via ATTACH + anti-joins over the curated content tables,
// then PREPENDS a dated section to an accumulated changelog.json (also pulled from
// R2). This is the domain-aware alternative to `sqldiff` on the whole file, which
// would drown in VACUUM/FTS/sqlite_stat1 noise -- here we only touch stable-PK
// content tables and emit entity-level add/remove + spawn-location deltas.
//
// Env:
//   DB        new shipped DB           (default public/data-dev/tortoise.sqlite)
//   PREV      previous shipped DB       (absent => baseline: log written unchanged)
//   PREV_LOG  accumulated changelog.json from R2 (absent => start fresh [])
//   OUT       output changelog.json     (default public/data-dev/changelog.json)
//   VERSION   version.json to stamp     (default public/data-dev/version.json)
//   MAX_LIST  cap per entity list       (default 300)  MAX_SECTIONS total (default 100)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { openDatabase } from "./lib/sqlite.mjs";

const DB = process.env.DB || "public/data-dev/tortoise.sqlite";
const PREV = process.env.PREV || "";
const PREV_LOG = process.env.PREV_LOG || "";
const OUT = process.env.OUT || "public/data-dev/changelog.json";
const VERSION = process.env.VERSION || "public/data-dev/version.json";
const MAX_LIST = +(process.env.MAX_LIST || 300);
const MAX_SECTIONS = +(process.env.MAX_SECTIONS || 100);

// Accumulated history (array of sections, newest first). Tolerate a wrapped
// {sections:[...]} shape or garbage.
function loadLog() {
  if (PREV_LOG && existsSync(PREV_LOG)) {
    try {
      const j = JSON.parse(readFileSync(PREV_LOG, "utf8"));
      if (Array.isArray(j)) return j;
      if (Array.isArray(j?.sections)) return j.sections;
    } catch { /* corrupt -> start fresh */ }
  }
  return [];
}

function readMeta() {
  try { return JSON.parse(readFileSync(VERSION, "utf8")); } catch { return {}; }
}

const log = loadLog();
const { version = "unknown", builtAt = new Date().toISOString() } = readMeta();

// No previous DB (first deploy, or wiped R2) -> baseline: persist the log unchanged
// so the file always exists. Self-healing; the next deploy diffs normally.
if (!PREV || !existsSync(PREV)) {
  writeFileSync(OUT, JSON.stringify(log));
  console.log(`build-changelog: no PREV DB -> baseline (${log.length} existing section(s)) -> ${OUT}`);
  process.exit(0);
}

const db = await openDatabase(DB);
const prevPath = PREV.replace(/\\/g, "/").replace(/'/g, "''");
db.exec(`ATTACH '${prevPath}' AS old`);

const tableIn = (schema, t) =>
  !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(t);

// entity add/remove -----------------------------------------------------------
const ENTITIES = [
  { key: "npcs", table: "creatures", pk: "entry", name: "name" },
  { key: "items", table: "items", pk: "entry", name: "name", extra: "quality" },
  { key: "quests", table: "quests", pk: "entry", name: "title" },
  { key: "objects", table: "gameobjects", pk: "entry", name: "name" },
  { key: "spells", table: "spells", pk: "entry", name: "name" },
  { key: "sets", table: "item_sets", pk: "id", name: "name" },
];

function diffEntity(e) {
  // Guard schema drift: a table missing on either side => no diff for it.
  if (!tableIn("main", e.table) || !tableIn("old", e.table)) return { added: [], removed: [] };
  const sel = `${e.pk} AS id, ${e.name} AS name${e.extra ? `, ${e.extra} AS quality` : ""}`;
  const added = db.prepare(
    `SELECT ${sel} FROM main.${e.table} WHERE ${e.pk} NOT IN (SELECT ${e.pk} FROM old.${e.table}) ORDER BY ${e.pk}`
  ).all();
  const removed = db.prepare(
    `SELECT ${sel} FROM old.${e.table} WHERE ${e.pk} NOT IN (SELECT ${e.pk} FROM main.${e.table}) ORDER BY ${e.pk}`
  ).all();
  return { added, removed };
}

// spawn-location deltas -------------------------------------------------------
// spawn_points has no PK; aggregate by (kind,id,map) and compare counts. Emulated
// FULL OUTER JOIN (two LEFT JOINs UNIONed) for portability across SQLite builds.
function diffSpawns() {
  if (!tableIn("main", "spawn_points") || !tableIn("old", "spawn_points")) return [];
  const rows = db.prepare(`
    WITH n AS (SELECT kind,id,map,COUNT(*) c FROM main.spawn_points GROUP BY kind,id,map),
         o AS (SELECT kind,id,map,COUNT(*) c FROM old.spawn_points GROUP BY kind,id,map)
    SELECT kind,id,map,delta FROM (
      SELECT COALESCE(n.kind,o.kind) kind, COALESCE(n.id,o.id) id, COALESCE(n.map,o.map) map,
             COALESCE(n.c,0)-COALESCE(o.c,0) delta
      FROM n LEFT JOIN o ON n.kind=o.kind AND n.id=o.id AND n.map=o.map
      UNION ALL
      SELECT o.kind,o.id,o.map,0-o.c
      FROM o LEFT JOIN n ON n.kind=o.kind AND n.id=o.id AND n.map=o.map
      WHERE n.id IS NULL
    ) WHERE delta <> 0
    ORDER BY ABS(delta) DESC, id`).all();
  // resolve entity + map names (prefer new DB, fall back to old for removed rows)
  const nameOf = (kind, id) => {
    const tbl = kind === "o" ? "gameobjects" : "creatures";
    const q = (s) => (tableIn(s, tbl) ? db.prepare(`SELECT name FROM ${s}.${tbl} WHERE entry=?`).get(id)?.name : null);
    return q("main") || q("old") || `#${id}`;
  };
  const mapOf = (map) => {
    const q = (s) => (tableIn(s, "maps") ? db.prepare(`SELECT name FROM ${s}.maps WHERE id=?`).get(map)?.name : null);
    return q("main") || q("old") || `Map ${map}`;
  };
  return rows.map((r) => ({ kind: r.kind, id: r.id, name: nameOf(r.kind, r.id), map: r.map, mapName: mapOf(r.map), delta: r.delta }));
}

// build the section -----------------------------------------------------------
const cap = (arr) => arr.slice(0, MAX_LIST);
const section = { version, builtAt, added: {}, removed: {}, spawns: [], counts: { added: {}, removed: {}, spawns: 0 } };
let total = 0;
for (const e of ENTITIES) {
  const { added, removed } = diffEntity(e);
  section.added[e.key] = cap(added);
  section.removed[e.key] = cap(removed);
  section.counts.added[e.key] = added.length;
  section.counts.removed[e.key] = removed.length;
  total += added.length + removed.length;
}
const spawns = diffSpawns();
section.spawns = cap(spawns);
section.counts.spawns = spawns.length;
total += spawns.length;
db.close();

if (total === 0) {
  writeFileSync(OUT, JSON.stringify(log));
  console.log(`build-changelog: no changes vs previous DB -> log unchanged (${log.length} section(s)) -> ${OUT}`);
  process.exit(0);
}

// prepend, but replace a same-version head (idempotent re-runs of one deploy)
if (log[0]?.version === version) log.shift();
log.unshift(section);
const out = log.slice(0, MAX_SECTIONS);
writeFileSync(OUT, JSON.stringify(out));
const c = section.counts;
console.log(`build-changelog: version ${version} -> +NPC ${c.added.npcs} +item ${c.added.items} +quest ${c.added.quests} +obj ${c.added.objects} +spell ${c.added.spells} | spawns ${c.spawns} | ${out.length} section(s) -> ${OUT}`);
