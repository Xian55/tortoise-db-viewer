// Prerender per-entity Open Graph "stub" pages for link unfurls (Discord/Twitter/
// Slack). The site is a query-param SPA on GitHub Pages, so a crawler that pastes
// ?quest=40790 only ever sees index.html's generic <meta> (crawlers don't run JS,
// and a static host can't vary a file by query string). These stubs solve it: one
// tiny HTML file per entity at a real PATH (e.g. /q/40790) carrying real og:title /
// og:description, plus an instant redirect to the SPA route for humans.
//
// Pure function of the built DB -> the whole output is content-hashed (manifest +
// printed hash) so CI can skip regeneration when the DB (and this script) are
// unchanged. See scripts/lib/og-hash.mjs + the deploy workflow's cache step.
//
// Out:  <OUT>/<prefix>/<id>/index.html   (OUT defaults to dist/)
//       <OUT>/og-manifest.json           (count + content hash)
// Env:  OUT_DIR (default "dist"), BASE_PATH (default "/tortoise-db-viewer/"),
//       SITE_URL (default "https://xian55.github.io"), DB_PATH.
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { openDatabase } from "./lib/sqlite.mjs";
import {
  QUALITY, ITEM_CLASS, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE,
  CREATURE_TYPE, CREATURE_RANK, GAMEOBJECT_TYPE,
} from "../src/constants.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = resolve(ROOT, process.env.OUT_DIR || "dist");
const DB = process.env.DB_PATH || join(ROOT, "public", "data", "tortoise.sqlite");
let BASE = process.env.BASE_PATH || "/tortoise-db-viewer/";
if (!BASE.endsWith("/")) BASE += "/";
const SITE = (process.env.SITE_URL || "https://xian55.github.io").replace(/\/$/, "");
// Bump when the stub TEMPLATE/description logic changes so the CI cache key shifts
// even if the DB is unchanged (the hash folds this in).
const OG_VERSION = "1";
// HASH_ONLY=1 -> compute + print only the content hash, write nothing (the fast
// pass the deploy uses to key the cache). OG_TYPES -> comma list of prefixes to
// limit which entity kinds are generated (default: all).
const HASH_ONLY = process.env.HASH_ONLY === "1";
const ONLY = new Set((process.env.OG_TYPES || "").split(",").map((s) => s.trim()).filter(Boolean));

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Strip WoW quest-text markup: $B/$b line breaks, $G male:female; gender, $N/$C/$R
// and $<n>s style tokens -> a flat sentence for the meta description.
const clean = (s) => String(s || "")
  .replace(/\$[Bb]/g, " ")
  .replace(/\$[Gg][^;]*;/g, "")
  .replace(/\$[A-Za-z]\d*/g, "")
  .replace(/\s+/g, " ")
  .trim();

const trim = (s, n) => {
  s = clean(s);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:]+$/, "") + "…";
};

const lvlRange = (r) => (r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : `${r.level_min || "?"}`);

function itemDesc(r) {
  const q = QUALITY[r.quality] && QUALITY[r.quality].name;
  const sub = r.class === 2 ? WEAPON_SUBCLASS[r.subclass]
    : r.class === 4 ? ARMOR_SUBCLASS[r.subclass] : null;
  const slot = INV_TYPE[r.inventory_type];
  // weapons: the subclass already names the hand (don't tack on "One-Hand");
  // armor: append the slot so it reads "Plate Chest"; otherwise fall back to slot/class.
  const kind = sub ? (r.class === 4 && slot ? `${sub} ${slot}` : sub) : (slot || ITEM_CLASS[r.class] || "");
  const ilvl = r.item_level > 0 ? ` · Item Level ${r.item_level}` : "";
  return ([q, kind].filter(Boolean).join(" ") + ilvl).trim() || "Item in Tortoise-WoW.";
}
function npcDesc(r) {
  const rank = CREATURE_RANK[r.rank] ? `${CREATURE_RANK[r.rank]} ` : "";
  const tail = `Level ${lvlRange(r)} ${rank}${CREATURE_TYPE[r.type] || ""}`.trim();
  return `${r.subname ? `<${r.subname}> · ` : ""}${tail}`;
}

// Each: param = SPA query key, prefix = path segment, sql -> {id, ...}, desc(r).
const ENTITIES = [
  { param: "quest", prefix: "q",
    sql: "SELECT entry id, title, level, objectives, details FROM quests WHERE title <> '' AND COALESCE(hidden,0) = 0",
    title: (r) => r.title,
    desc: (r) => trim((r.level > 0 ? `Level ${r.level} quest. ` : "") + (clean(r.objectives) || clean(r.details)), 200) || "Quest in Tortoise-WoW." },
  { param: "item", prefix: "i",
    sql: "SELECT entry id, name, quality, class, subclass, inventory_type, item_level FROM items WHERE name <> '' AND COALESCE(hidden,0) = 0",
    title: (r) => r.name, desc: (r) => trim(itemDesc(r), 180) },
  { param: "npc", prefix: "n",
    sql: "SELECT entry id, name, subname, level_min, level_max, rank, type FROM creatures WHERE name <> '' AND COALESCE(hidden,0) = 0",
    title: (r) => r.name, desc: (r) => trim(npcDesc(r), 180) },
  { param: "spell", prefix: "s",
    sql: "SELECT entry id, name, description FROM spells WHERE name <> '' AND COALESCE(hidden,0) = 0",
    title: (r) => r.name, desc: (r) => trim(clean(r.description) || "Spell in Tortoise-WoW.", 200) },
  { param: "object", prefix: "o",
    sql: "SELECT entry id, name, type FROM gameobjects WHERE name <> ''",
    title: (r) => r.name, desc: (r) => `${GAMEOBJECT_TYPE[r.type] || "Object"} in Tortoise-WoW.` },
  { param: "zone", prefix: "z",
    sql: "SELECT areaid id, name, spawns FROM zones WHERE name <> ''",
    title: (r) => r.name, desc: (r) => `Zone in Tortoise-WoW${r.spawns ? ` · ${r.spawns} spawns` : ""}.` },
  { param: "faction", prefix: "f",
    sql: "SELECT id, name FROM factions WHERE name <> ''",
    title: (r) => r.name, desc: () => "Reputation faction in Tortoise-WoW." },
  { param: "itemset", prefix: "is",
    sql: "SELECT id, name FROM item_sets WHERE name <> ''",
    title: (r) => r.name, desc: () => "Item set in Tortoise-WoW." },
];

function stubHtml(title, desc, appPath, ogUrl, canonical) {
  const t = esc(title), d = esc(desc);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t} - Tortoise-WoW DB</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tortoise-WoW Database">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${esc(ogUrl)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta http-equiv="refresh" content="0; url=${esc(appPath)}">
<script>location.replace(${JSON.stringify(appPath)})</script>
</head>
<body>Redirecting to <a href="${esc(appPath)}">${t}</a>…</body>
</html>
`;
}

const db = await openDatabase(DB);
const hash = createHash("sha256");
hash.update(`v${OG_VERSION}|${BASE}|${SITE}|${[...ONLY].sort().join(",")}\n`);
let total = 0;
for (const e of ENTITIES) {
  if (ONLY.size && !ONLY.has(e.prefix)) continue;
  let rows;
  try { rows = db.prepare(e.sql).all(); }
  catch (err) { console.warn(`skip ${e.prefix}: ${err.message}`); continue; }
  if (!HASH_ONLY) mkdirSync(join(OUT, e.prefix), { recursive: true });
  for (const r of rows) {
    if (r.id == null) continue;
    const title = e.title(r) || `#${r.id}`;
    const desc = e.desc(r);
    hash.update(`${e.prefix}\t${r.id}\t${title}\t${desc}\n`);
    total++;
    if (HASH_ONLY) continue;
    const appPath = `${BASE}?${e.param}=${r.id}`;
    // flat <prefix>/<id>.html -> GitHub Pages serves it at the extensionless path
    // /<prefix>/<id> (no redirect, no per-id directory). og:url uses that clean path.
    const ogUrl = `${SITE}${BASE}${e.prefix}/${r.id}`;
    const canonical = `${SITE}${appPath}`;
    writeFileSync(join(OUT, e.prefix, `${r.id}.html`), stubHtml(title, desc, appPath, ogUrl, canonical));
  }
  if (!HASH_ONLY) console.log(`  ${e.prefix}: ${rows.length}`);
}
db.close();

const digest = hash.digest("hex").slice(0, 16);
if (HASH_ONLY) {
  // print ONLY the hash so the deploy can capture it as a cache key
  process.stdout.write(digest + "\n");
} else {
  writeFileSync(join(OUT, "og-manifest.json"), JSON.stringify({ count: total, hash: digest }) + "\n");
  console.log(`OG stubs: ${total} pages -> ${OUT} (content hash ${digest})`);
}
