// Asset origins + multi-CDN failover.
//
// The heavy DB is normally served from Cloudflare R2 (VITE_DATA_BASE). Some networks
// block or throttle R2, and the GitHub Pages artifact does NOT carry the DB
// (deploy.yml trims it), so a single-origin setup leaves those users with a dead
// site. We therefore give the DB several independent delivery routes and pick a
// reachable one at boot:
//
//   version.json source (DATA_BASE):  R2  ->  raw.githubusercontent (Fastly)  ->  Pages
//   DB bytes (tried in order):        R2 (.sqlite, brotli via header)
//                                       ->  jsDelivr (@<tag>/data/tortoise.sqlite.br)
//                                       ->  raw.githubusercontent (@<tag>, .br)
//
// jsDelivr/raw serve a raw *brotli* copy (no Content-Encoding, ~15 MB — under
// jsDelivr's 20 MB file limit); db-worker.js decodes it client-side with brotli-wasm
// (lazy-loaded only on this fallback path), so any dumb static host works as a
// mirror. jsDelivr can't be a version.json source (its URL is pinned by the version
// we're trying to discover), so it's a DB/atlas route only. Both read the CI-pushed
// `cdn`/`cdn-dev` orphan branch: version.json discovery uses branch HEAD (CORS-open),
// the DB/atlas use an immutable per-version tag (`cdn-v<version>`) so mirror bytes
// always match the discovered version.
//
// Two datasets: "main" (/) and "dev" (/dev/, server 1181dev) — DATA_BASE + the
// mirror branch/tag are dataset-aware. Maps/minimap stay on ASSETS_BASE (R2/Pages),
// are not mirrored, and degrade to blank if R2 is unreachable (documented).

const BASE = import.meta.env.BASE_URL; // e.g. "/tortoise-db-viewer/"
const relPath = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : "";
const qs = new URLSearchParams(location.search);

// Dataset registry. The site serves several DB copies chosen by URL path. Today:
// "main" (vanilla/tortoise, at /) and "dev" (Turtle 1181dev branch, at /dev/). The
// scheme generalizes to a /{expansion}/{core} matrix (e.g. vanilla/cmangos) — add an
// entry and resolution + OPFS keying + R2 prefix + CDN mirrors all follow. Fields:
//   id    OPFS-safe key (no slash) + UI id; keep "main"/"dev" (main.js/db-worker key on them)
//   path  URL segment under BASE that selects this dataset ("" = the root/default)
//   sub   R2 prefix + CDN slug suffix: data-base `data<sub>/`, branch `cdn<sub>`, tag `cdn<sub>-v`
//   data  optional per-dataset R2 base env (MUST be a literal import.meta.env.* — Vite only
//         static-replaces literal refs, not dynamic lookups); falls back to the `sub` convention
// A new matrix row needs a build target + R2 populate + deploy wiring before it's live (see
// notes/plan-content-origin-and-variants.md). main/dev reproduce the previous exact config.
const DATASETS = [
  { id: "main", path: "",    sub: "",     data: import.meta.env.VITE_DATA_BASE,     label: "Main" },
  { id: "dev",  path: "dev", sub: "-dev", data: import.meta.env.VITE_DATA_BASE_DEV, label: "Dev"  },
  // { id: "vanilla-cmangos", path: "vanilla/cmangos", sub: "-vanilla-cmangos",
  //   data: import.meta.env.VITE_DATA_BASE_VANILLA_CMANGOS, label: "Vanilla · cMaNGOS" },
];

// Active dataset: ?db=<id> local-dev override, else the longest URL-path match (so "dev"
// beats "" and "vanilla/cmangos" beats "dev"), else main (empty-path fallback).
const forcedDb = qs.get("db");
const matchesPath = (p) => p !== "" && (relPath === p || relPath.startsWith(p + "/"));
const DS =
  (forcedDb && DATASETS.find((d) => d.id === forcedDb)) ||
  DATASETS.filter((d) => matchesPath(d.path)).sort((a, b) => b.path.length - a.path.length)[0] ||
  DATASETS[0];
export const DATASET = DS.id;
const IS_DEV = DATASET === "dev";

const REPO = import.meta.env.VITE_GH_REPO || "Xian55/tortoise-db-viewer";
// Public JSON API origin (scripts/build-api.mjs → R2). Rotatable via VITE_API_BASE.
export const API_BASE = import.meta.env.VITE_API_BASE || "https://api.tortoiseclothing.org";
const CDN_BRANCH = `cdn${DS.sub}`;                       // orphan branch CI force-pushes (cdn, cdn-dev)
const TAG = `cdn${DS.sub}-v`;                            // jsDelivr pin: `@${TAG}${version}`
const JSDELIVR = `https://cdn.jsdelivr.net/gh/${REPO}`;
const RAW_ROOT = `https://raw.githubusercontent.com/${REPO}`;
const RAW_BRANCH = `${RAW_ROOT}/${CDN_BRANCH}`;      // branch HEAD (version.json discovery)
const rawTag = (v) => `${RAW_ROOT}/${TAG}${v}`;       // immutable per-version tag (DB/atlas)

const R2_DATA = DS.data || `${BASE}data${DS.sub}/`;   // per-dataset R2 base, else path convention
const R2_ASSETS    = import.meta.env.VITE_ASSETS_BASE || BASE; // maps/minimap/class/poi/tt
const PAGES_DATA   = IS_DEV ? R2_DATA : `${BASE}data/`; // Pages has main version.json/icons only
const PAGES_ASSETS = BASE;

// version.json sources (small, non-circular) raced at boot to discover the version
// AND a reachable data origin. Order = preference when several respond together.
const DATA_ORIGINS = [
  { name: "r2", data: R2_DATA },
  { name: "raw", data: `${RAW_BRANCH}/data/` },
  { name: "pages", data: PAGES_DATA },
];

export let DATA_BASE   = R2_DATA;   // winner's version.json/changelog.json base (live binding)
// Maps/minimap/class icons/poi/tt live ONLY on R2 (deploy.yml trims maps+minimap
// from the Pages artifact), so this is R2-fixed. It must NOT follow the version.json
// race winner: a non-R2 origin winning the race (faster version.json) does not mean
// R2 is unreachable, and pointing maps at Pages there just 404s. If R2 is genuinely
// blocked, these assets degrade (no mirror — the icon atlas has its own chain).
export let ASSETS_BASE = R2_ASSETS;

let winner = "r2";                  // which DATA_ORIGIN answered
let probedMeta = null;              // version.json captured by the probe; reused by db.js getMeta
export function getProbedMeta() { return probedMeta; }

const STICKY_KEY = `assetOrigin:${DATASET}`;
const STICKY_TTL = 7 * 864e5; // 7d — a transient block self-recovers after this
function readSticky() { try { return JSON.parse(localStorage.getItem(STICKY_KEY)); } catch { return null; } }
function writeSticky(name) { try { localStorage.setItem(STICKY_KEY, JSON.stringify({ o: name, t: Date.now() })); } catch { /* private mode */ } }

function applyWinner(name) {
  winner = name;
  const o = DATA_ORIGINS.find((x) => x.name === name) || DATA_ORIGINS[0];
  DATA_BASE = o.data; // ASSETS_BASE stays R2 (maps/minimap are R2-only) — see above
}

// DB byte URLs, tried in order by the worker. The reachable origin (from the race)
// goes first; jsDelivr is pinned to the discovered version's tag.
export function getDbUrls(version) {
  const list = [
    { n: "r2", url: `${R2_DATA}tortoise.sqlite?v=${version}` },
    { n: "jsdelivr", url: `${JSDELIVR}@${TAG}${version}/data/tortoise.sqlite.br` },
    { n: "raw", url: `${rawTag(version)}/data/tortoise.sqlite.br` },
  ];
  list.sort((a, b) => (a.n === winner ? -1 : 0) - (b.n === winner ? -1 : 0));
  return list.map((x) => x.url);
}

// Icon-atlas URLs (json + matching webp), tried in order by loadIconAtlas.
export function getAtlasUrls(version) {
  const at = [
    { n: "r2", json: `${R2_ASSETS}icons/custom-atlas.json`, webp: `${R2_ASSETS}icons/custom-atlas.webp` },
    { n: "jsdelivr", json: `${JSDELIVR}@${TAG}${version}/icons/custom-atlas.json`, webp: `${JSDELIVR}@${TAG}${version}/icons/custom-atlas.webp` },
    { n: "raw", json: `${rawTag(version)}/icons/custom-atlas.json`, webp: `${rawTag(version)}/icons/custom-atlas.webp` },
    { n: "pages", json: `${PAGES_ASSETS}icons/custom-atlas.json`, webp: `${PAGES_ASSETS}icons/custom-atlas.webp` },
  ];
  at.sort((a, b) => (a.n === winner ? -1 : 0) - (b.n === winner ? -1 : 0));
  return at;
}

async function probe(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Pick a reachable data origin once at boot: honour ?origin= / sticky, else race
// version.json across the candidates and remember the winner.
export async function resolveOrigins() {
  const forced = qs.get("origin");
  if (forced && DATA_ORIGINS.some((o) => o.name === forced)) { applyWinner(forced); return; }

  const s = readSticky();
  if (s?.o && Date.now() - s.t < STICKY_TTL && DATA_ORIGINS.some((o) => o.name === s.o)) {
    applyWinner(s.o);
    // verify the sticky origin quickly; if it's dead now, fall through to a fresh race
    try { probedMeta = await probe(`${DATA_BASE}version.json`, 4000); return; }
    catch { /* sticky origin down -> re-race below */ }
  }

  // Race: first origin whose version.json resolves wins. Promise.any rejects only if
  // ALL reject, so a single reachable origin is enough.
  try {
    const attempts = DATA_ORIGINS.map((o) =>
      probe(`${o.data}version.json`, 4000).then((meta) => ({ name: o.name, meta })));
    const { name, meta } = await Promise.any(attempts);
    applyWinner(name);
    probedMeta = meta;
    writeSticky(name);
  } catch {
    // everything unreachable -> leave the R2 default; the DB fetch will surface the error
    applyWinner("r2");
  }
}
