// Dump compact per-entity tooltip JSON for the embeddable powered-tooltip widget
// (public/embed/tw-power.js). A third-party page (Turtle forum / Discord-linked
// site) includes the widget; on hover over a link to this database it fetches the
// matching JSON here and renders a small in-game-style tooltip.
//
// One tiny JSON file per entity at a real PATH mirrors the OG-stub layout
// (dist/tt/<prefix>/<id>.json). Keys are short to keep each file ~100-200 bytes.
// Pure function of the built DB -> content-hashed so CI can skip regeneration when
// the DB (and this script) are unchanged (HASH_ONLY=1 prints only the hash).
//
// Out:  <OUT>/tt/<prefix>/<id>.json  +  <OUT>/tt/manifest.json  (OUT defaults to dist)
// Env:  OUT_DIR (default "dist"), DB_PATH, TT_ONLY (comma prefixes: i,n,q,s),
//       TT_LIMIT (cap rows per type -- for a fast local subset), HASH_ONLY=1.
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { openDatabase } from "./lib/sqlite.mjs";
import {
  QUALITY, ITEM_CLASS, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE,
  CREATURE_TYPE, CREATURE_RANK,
} from "../src/constants.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = resolve(ROOT, process.env.OUT_DIR || "dist");
const DB = process.env.DB_PATH || join(ROOT, "public", "data", "tortoise.sqlite");
const TT_VERSION = "1";
const HASH_ONLY = process.env.HASH_ONLY === "1";
const ONLY = new Set((process.env.TT_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean));
const LIMIT = Number(process.env.TT_LIMIT) || 0;

const clean = (s) => String(s || "")
  .replace(/\$[Bb]/g, " ").replace(/\$[Gg][^;]*;/g, "").replace(/\$[A-Za-z]\d*/g, "")
  .replace(/\s+/g, " ").trim();
const trim = (s, n) => { s = clean(s); return s.length <= n ? s : s.slice(0, n).replace(/\s\S*$/, "") + "…"; };
const lvlRange = (r) => (r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : `${r.level_min || "?"}`);

function itemKind(r) {
  const sub = r.class === 2 ? WEAPON_SUBCLASS[r.subclass] : r.class === 4 ? ARMOR_SUBCLASS[r.subclass] : null;
  const slot = INV_TYPE[r.inventory_type];
  return sub ? (r.class === 4 && slot ? `${sub} ${slot}` : sub) : (slot || ITEM_CLASS[r.class] || "");
}

// Each: prefix = path segment (matches the OG stubs + the widget's link parser).
const TYPES = [
  { prefix: "i",
    sql: "SELECT i.entry id, i.name, i.quality, i.class, i.subclass, i.inventory_type, i.item_level, i.required_level, di.icon FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id WHERE i.name <> '' AND COALESCE(i.hidden,0) = 0 ORDER BY i.entry",
    row: (r) => ({ k: "i", n: r.name, q: r.quality || 0, ic: r.icon || "", il: r.item_level || 0, rl: r.required_level || 0, b: itemKind(r) }) },
  { prefix: "n",
    sql: "SELECT entry id, name, subname, level_min, level_max, rank, type FROM creatures WHERE name <> '' AND COALESCE(hidden,0) = 0 ORDER BY entry",
    row: (r) => ({ k: "n", n: r.name, s: r.subname || "", l: lvlRange(r), r: CREATURE_RANK[r.rank] || "", t: CREATURE_TYPE[r.type] || "" }) },
  { prefix: "q",
    sql: "SELECT entry id, title, level, minlevel FROM quests WHERE title <> '' AND hidden = 0 ORDER BY entry",
    row: (r) => ({ k: "q", n: r.title, l: r.level || 0, rl: r.minlevel || 0 }) },
  { prefix: "s",
    sql: "SELECT entry id, name, icon, description FROM spells WHERE name <> '' AND COALESCE(hidden,0) = 0 ORDER BY entry",
    row: (r) => ({ k: "s", n: r.name, ic: r.icon || "", d: trim(r.description, 160) }) },
];

const db = await openDatabase(DB);
const hash = createHash("sha256");
hash.update(`v${TT_VERSION}|${[...ONLY].sort().join(",")}|${LIMIT}\n`);
let total = 0;
for (const t of TYPES) {
  if (ONLY.size && !ONLY.has(t.prefix)) continue;
  let rows;
  try { rows = db.prepare(t.sql + (LIMIT ? ` LIMIT ${LIMIT}` : "")).all(); }
  catch (err) { console.warn(`skip ${t.prefix}: ${err.message}`); continue; }
  if (!HASH_ONLY) mkdirSync(join(OUT, "tt", t.prefix), { recursive: true });
  for (const r of rows) {
    if (r.id == null) continue;
    const json = JSON.stringify(t.row(r));
    hash.update(`${t.prefix}\t${r.id}\t${json}\n`);
    total++;
    if (HASH_ONLY) continue;
    writeFileSync(join(OUT, "tt", t.prefix, `${r.id}.json`), json);
  }
  if (!HASH_ONLY) console.log(`  ${t.prefix}: ${rows.length}`);
}
db.close();

const digest = hash.digest("hex").slice(0, 16);
if (HASH_ONLY) { process.stdout.write(digest + "\n"); }
else {
  writeFileSync(join(OUT, "tt", "manifest.json"), JSON.stringify({ count: total, hash: digest, version: TT_VERSION }) + "\n");
  console.log(`Tooltip JSON: ${total} files -> ${OUT}/tt (content hash ${digest})`);
}
