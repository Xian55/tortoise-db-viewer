// LOCAL-ONLY extract: maps script-spawned instance bosses -> their dungeon/raid map.
//
// Why this exists: some instance bosses (and their adds) are placed by the server's
// C++ instance scripts, NOT by a static `creature` spawn row. The server SQL dump the
// build ingests therefore has ZERO location data for them -- no `spawns`, no
// `spawn_points` -- so nothing can name their instance (the item page, dungeon page,
// NPC page and the character upgrade finder all draw a blank). wowhead/turtledb know
// e.g. Tuten'kash is in Razorfen Downs only because the RFD instance script spawns him;
// that association lives in `../tortoise-wow/src/scripts/dungeons/<instance>/`, not in
// any table.
//
// This reads that ScriptDev2 source (CI has no server `src/`, so the output JSON is
// COMMITTED like the other client/src-derived data) and, for each dungeon/raid script
// folder:
//   1. collects the creature + gameobject entries the folder's scripts reference
//      (enums in both `NAME = 123` and modern `NAME{ 123 }` brace-init styles),
//   2. GROUNDS the folder -> mapId from the built DB: gameobjects are statically placed
//      inside the instance, so the map their spawns sit on IS the instance map (creature
//      spawns, where present, vote too),
//   3. emits every SPAWNLESS creature in the folder (no `spawns` AND no `spawn_points`)
//      paired with that mapId -- exactly the script-placed bosses/adds the SQL can't locate.
//
// Output: scripts/data/instance-bosses.json = [{ e: <creatureEntry>, m: <mapId> }, ...].
// build-db loads it into `creature_instance`; `qInstanceDropsIn` (character upgrades)
// falls back to it when a boss has no dungeon spawn. Only type 1 (dungeon) / 2 (raid)
// maps are kept -- world-script bosses (Kazzak &c.) are not "in" an instance.
//
// Run order (LOCAL): build-db  ->  extract-instance-bosses  ->  build-db (merges JSON).
// The built DB must exist first (grounding + spawnless detection read it). CI just
// consumes the committed JSON, so the normal build is single-pass.
//
// Env: SRC_DIR (default ../tortoise-wow/src/scripts/dungeons), DB (default the built
// public/data/tortoise.sqlite).

import { openDatabase } from "./lib/sqlite.mjs";
import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = process.env.SRC_DIR || join(HERE, "..", "..", "tortoise-wow", "src", "scripts", "dungeons");
const DB_PATH = process.env.DB || join(HERE, "..", "public", "data", "tortoise.sqlite");
const OUT = join(HERE, "data", "instance-bosses.json");

// creature-entry enums, all three declaration styles the scripts use:
//   NPC_FOO = 123         NPC_FOO{ 123 }        #define NPC_FOO 123
const CRE_RE = /\b(?:CREATURE|NPC|BOSS|MOB)_[A-Z0-9_]+\s*(?:=|\{)\s*(\d{2,7})/g;
const CRE_DEF_RE = /#\s*define\s+(?:CREATURE|NPC|BOSS|MOB)_[A-Z0-9_]+\s+(\d{2,7})/g;
// Bare entry literals in an array, annotated with a trailing name comment, e.g. the
// BRD Ring-of-Law roster: `9027, // Gorosh`. Accepted ONLY when the DB creature name
// for that id shares a word with the comment (below) -- guards against spell-id/timer
// literals that happen to collide with a creature entry number.
const CRE_COMMENT_RE = /\b(\d{3,7})\s*,?\s*\/\/\s*([A-Za-z][A-Za-z'` .-]{2,})/g;
// gameobject enums (for map grounding): GO_/OBJECT_/GAMEOBJECT_ prefixed, same styles.
const OBJ_RE = /\b(?:GO|OBJECT|GAMEOBJECT)_[A-Z0-9_]+\s*(?:=|\{)\s*(\d{2,7})/g;
const OBJ_DEF_RE = /#\s*define\s+(?:GO|OBJECT|GAMEOBJECT)_[A-Z0-9_]+\s+(\d{2,7})/g;

// do creature `name` and a source comment refer to the same thing? (shared >=3-char word)
function nameMatchesComment(name, comment) {
  if (!name) return false;
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z']{3,}/g) || []);
  const cw = words(comment);
  for (const w of words(name)) if (cw.has(w)) return true;
  return false;
}

function walk(dir) {
  let out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) out = out.concat(walk(p));
    else if (/\.(h|cpp)$/.test(f)) out.push(p);
  }
  return out;
}

const db = await openDatabase(DB_PATH);
const qCreMaps = db.prepare("SELECT map, COUNT(*) c FROM spawns WHERE id = ? GROUP BY map");
const qObjMap = db.prepare("SELECT map, COUNT(*) c FROM spawn_points WHERE kind = 'o' AND id = ? GROUP BY map");
const qHasSpawn = db.prepare("SELECT 1 FROM spawns WHERE id = ? LIMIT 1");
const qHasSp = db.prepare("SELECT 1 FROM spawn_points WHERE kind = 'c' AND id = ? LIMIT 1");
const qCreName = db.prepare("SELECT name FROM creatures WHERE entry = ?");
const qMap = db.prepare("SELECT name, type FROM maps WHERE id = ?");

const folders = readdirSync(SRC_DIR).filter((f) => statSync(join(SRC_DIR, f)).isDirectory());
const mapped = new Map(); // entry -> Set(mapId)
const noMap = [];
const perFolder = [];

for (const fol of folders) {
  const cre = new Set();
  const obj = new Set();
  for (const file of walk(join(SRC_DIR, fol))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(CRE_RE)) cre.add(+m[1]);
    for (const m of text.matchAll(CRE_DEF_RE)) cre.add(+m[1]);
    for (const m of text.matchAll(OBJ_RE)) obj.add(+m[1]);
    for (const m of text.matchAll(OBJ_DEF_RE)) obj.add(+m[1]);
    // comment-annotated bare literals: keep only if the id is a creature whose name
    // matches the comment (safe capture of array rosters like BRD's arena bosses).
    for (const m of text.matchAll(CRE_COMMENT_RE)) {
      const id = +m[1];
      if (!cre.has(id) && nameMatchesComment(qCreName.get(id)?.name, m[2])) cre.add(id);
    }
  }
  // Ground the folder's mapId. Gameobjects are placed inside the instance -> strong
  // signal (weighted); creature spawns (where any exist) vote by spawn count.
  const votes = new Map();
  const bump = (map, w) => votes.set(map, (votes.get(map) || 0) + w);
  for (const o of obj) for (const r of qObjMap.all(o)) bump(r.map, r.c * 5);
  for (const c of cre) for (const r of qCreMaps.all(c)) bump(r.map, r.c);
  let best = null, bestV = 0;
  for (const [map, v] of votes) if (v > bestV) { best = map; bestV = v; }

  const info = qMap.get(best ?? -1);
  const spawnless = [...cre].filter((c) => qCreName.get(c) && !qHasSpawn.get(c) && !qHasSp.get(c));
  perFolder.push({ folder: fol, map: best, mapName: info?.name, type: info?.type, creatures: cre.size, spawnless: spawnless.length });

  // Keep only dungeon (1) / raid (2) maps; a world map means the grounding picked up an
  // outdoor creature and the folder isn't a real instance for our purposes.
  if (best == null || !(info && (info.type === 1 || info.type === 2))) {
    if (best == null) noMap.push(fol);
    continue;
  }
  for (const c of spawnless) {
    let s = mapped.get(c);
    if (!s) { s = new Set(); mapped.set(c, s); }
    s.add(best);
  }
}

// stable, sorted output: one {e, m} per (entry, map)
const rows = [];
for (const [e, maps] of [...mapped].sort((a, b) => a[0] - b[0])) {
  for (const m of [...maps].sort((a, b) => a - b)) rows.push({ e, m });
}
writeFileSync(OUT, JSON.stringify(rows) + "\n");

console.log("Per-folder grounding:");
for (const f of perFolder.sort((a, b) => a.folder.localeCompare(b.folder))) {
  console.log(`  ${f.folder.padEnd(22)} map=${String(f.map ?? "?").padStart(4)} ${f.mapName || "(no map)"}${f.type ? ` t${f.type}` : ""}  creatures=${f.creatures} spawnless=${f.spawnless}`);
}
if (noMap.length) console.log(`\nFolders with no grounded map (skipped): ${noMap.join(", ")}`);
console.log(`\nWrote ${OUT}: ${rows.length} (entry,map) pairs, ${mapped.size} distinct creatures.`);
db.close();
