// Per-deploy "What's new" changelog for a dataset (currently the dev / 1181dev DB).
//
// Diffs the freshly-built shipped DB against the PREVIOUS deployed one (downloaded
// from R2 by the workflow) via ATTACH + anti-joins over the curated content tables,
// then PREPENDS a dated section to an accumulated changelog.json (also pulled from
// R2). Domain-aware alternative to `sqldiff` (which drowns in VACUUM/FTS/stat noise)
// -- only stable-PK content tables are compared, so a VACUUM/ANALYZE-only rebuild
// with a different file hash correctly yields "no changes".
//
// SEED baseline: when the accumulated log is still empty and there's no dev-vs-dev
// delta yet, the first section is seeded as dev-vs-SEED (the main dataset) so the
// changelog opens with "everything this dataset adds over main" instead of blank.
//
// Env:
//   DB        new shipped DB           (default public/data-dev/tortoise.sqlite)
//   PREV      previous shipped DB       (absent => no per-deploy delta)
//   SEED      baseline DB (main)        (used only to seed the first section)
//   PREV_LOG  accumulated changelog.json from R2 (absent => start fresh [])
//   OUT       output changelog.json     (default public/data-dev/changelog.json)
//   VERSION   version.json to stamp     (default public/data-dev/version.json)
//   MAX_LIST  cap per entity list       (default 300)  MAX_SECTIONS total (default 100)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { openDatabase } from "./lib/sqlite.mjs";

const DB = process.env.DB || "public/data-dev/tortoise.sqlite";
const PREV = process.env.PREV || "";
const SEED = process.env.SEED || "";
const PREV_LOG = process.env.PREV_LOG || "";
const OUT = process.env.OUT || "public/data-dev/changelog.json";
const VERSION = process.env.VERSION || "public/data-dev/version.json";
const MAX_LIST = +(process.env.MAX_LIST || 300);
const MAX_SECTIONS = +(process.env.MAX_SECTIONS || 100);

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

const db = await openDatabase(DB);

const tableIn = (schema, t) =>
  !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(t);

const ENTITIES = [
  { key: "npcs", table: "creatures", pk: "entry", name: "name" },
  { key: "items", table: "items", pk: "entry", name: "name", extra: "quality" },
  { key: "quests", table: "quests", pk: "entry", name: "title" },
  { key: "objects", table: "gameobjects", pk: "entry", name: "name" },
  { key: "spells", table: "spells", pk: "entry", name: "name" },
  { key: "sets", table: "item_sets", pk: "id", name: "name" },
];

// Diff the open DB (main schema) against an attached previous DB. Returns a section
// plus the total change count so the caller can decide whether to keep it.
function diffAgainst(prevPath) {
  const p = prevPath.replace(/\\/g, "/").replace(/'/g, "''");
  db.exec(`ATTACH '${p}' AS old`);
  try {
    const cap = (arr) => arr.slice(0, MAX_LIST);
    const section = { version, builtAt, added: {}, removed: {}, spawns: [], counts: { added: {}, removed: {}, spawns: 0 } };
    let total = 0;

    for (const e of ENTITIES) {
      if (!tableIn("main", e.table) || !tableIn("old", e.table)) { section.added[e.key] = []; section.removed[e.key] = []; section.counts.added[e.key] = 0; section.counts.removed[e.key] = 0; continue; }
      const sel = `${e.pk} AS id, ${e.name} AS name${e.extra ? `, ${e.extra} AS quality` : ""}`;
      const added = db.prepare(`SELECT ${sel} FROM main.${e.table} WHERE ${e.pk} NOT IN (SELECT ${e.pk} FROM old.${e.table}) ORDER BY ${e.pk}`).all();
      const removed = db.prepare(`SELECT ${sel} FROM old.${e.table} WHERE ${e.pk} NOT IN (SELECT ${e.pk} FROM main.${e.table}) ORDER BY ${e.pk}`).all();
      section.added[e.key] = cap(added); section.removed[e.key] = cap(removed);
      section.counts.added[e.key] = added.length; section.counts.removed[e.key] = removed.length;
      total += added.length + removed.length;
    }

    // spawn-location deltas (spawn_points has no PK): aggregate by (kind,id,map),
    // compare counts. Emulated FULL OUTER JOIN for portability.
    let spawns = [];
    if (tableIn("main", "spawn_points") && tableIn("old", "spawn_points")) {
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
      const nameOf = (kind, id) => {
        const tbl = kind === "o" ? "gameobjects" : "creatures";
        const q = (s) => (tableIn(s, tbl) ? db.prepare(`SELECT name FROM ${s}.${tbl} WHERE entry=?`).get(id)?.name : null);
        return q("main") || q("old") || `#${id}`;
      };
      const mapOf = (map) => {
        const q = (s) => (tableIn(s, "maps") ? db.prepare(`SELECT name FROM ${s}.maps WHERE id=?`).get(map)?.name : null);
        return q("main") || q("old") || `Map ${map}`;
      };
      spawns = rows.map((r) => ({ kind: r.kind, id: r.id, name: nameOf(r.kind, r.id), map: r.map, mapName: mapOf(r.map), delta: r.delta }));
    }
    section.spawns = cap(spawns);
    section.counts.spawns = spawns.length;
    total += spawns.length;

    return { section, total };
  } finally {
    db.exec("DETACH old");
  }
}

// 1) normal per-deploy delta (dev vs previous dev). 2) if empty and the log is
// still empty, seed the first section from the main dataset (dev vs main).
let section = null, baseline = false;
if (PREV && existsSync(PREV)) {
  const r = diffAgainst(PREV);
  if (r.total > 0) section = r.section;
}
if (!section && log.length === 0 && SEED && existsSync(SEED)) {
  const r = diffAgainst(SEED);
  if (r.total > 0) { section = r.section; baseline = true; }
}
db.close();

if (!section) {
  writeFileSync(OUT, JSON.stringify(log));
  console.log(`build-changelog: no changes -> log unchanged (${log.length} section(s)) -> ${OUT}`);
  process.exit(0);
}

section.baseline = baseline;
if (log[0]?.version === version) log.shift(); // idempotent re-run of one deploy
log.unshift(section);
const out = log.slice(0, MAX_SECTIONS);
writeFileSync(OUT, JSON.stringify(out));
const c = section.counts;
console.log(`build-changelog: ${baseline ? "BASELINE (vs main) " : ""}version ${version} -> +NPC ${c.added.npcs} +item ${c.added.items} +quest ${c.added.quests} +obj ${c.added.objects} +spell ${c.added.spells} | spawns ${c.spawns} | ${out.length} section(s) -> ${OUT}`);
