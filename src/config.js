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
//                                       ->  jsDelivr (@<tag>/data/tortoise.sqlite.gz)
//                                       ->  raw.githubusercontent (cdn branch, .gz)
//
// jsDelivr/raw serve a *gzip* copy (no Content-Encoding); db-worker.js decodes it
// client-side (DecompressionStream), so any dumb static host works as a mirror.
// jsDelivr can't be a version.json source (its URL is pinned by the version we're
// trying to discover), so it's a DB/atlas route only. raw + jsDelivr both read the
// committed CI-pushed `cdn`/`cdn-dev` orphan branch — raw at branch HEAD (CORS-open,
// ~5min cache), jsDelivr pinned to an immutable per-version tag for freshness.
//
// Two datasets: "main" (/) and "dev" (/dev/, server 1181dev) — DATA_BASE + the
// mirror branch/tag are dataset-aware. Maps/minimap stay on ASSETS_BASE (R2/Pages),
// are not mirrored, and degrade to blank if R2 is unreachable (documented).

const BASE = import.meta.env.BASE_URL; // e.g. "/tortoise-db-viewer/"
const relPath = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : "";
const qs = new URLSearchParams(location.search);
export const DATASET = relPath.startsWith("dev") || qs.get("db") === "dev" ? "dev" : "main";
const IS_DEV = DATASET === "dev";

const REPO = import.meta.env.VITE_GH_REPO || "Xian55/tortoise-db-viewer";
const CDN_BRANCH = IS_DEV ? "cdn-dev" : "cdn";           // orphan branch CI force-pushes
const TAG = IS_DEV ? "cdn-dev-v" : "cdn-v";              // jsDelivr pin: `@${TAG}${version}`
const JSDELIVR = `https://cdn.jsdelivr.net/gh/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/${CDN_BRANCH}`;

const R2_DATA = IS_DEV
  ? (import.meta.env.VITE_DATA_BASE_DEV || `${BASE}data-dev/`)
  : (import.meta.env.VITE_DATA_BASE || `${BASE}data/`);
const R2_ASSETS    = import.meta.env.VITE_ASSETS_BASE || BASE; // maps/minimap/class/poi/tt
const PAGES_DATA   = IS_DEV ? R2_DATA : `${BASE}data/`; // Pages has main version.json/icons only
const PAGES_ASSETS = BASE;

// version.json sources (small, non-circular) raced at boot to discover the version
// AND a reachable data origin. Order = preference when several respond together.
const DATA_ORIGINS = [
  { name: "r2", data: R2_DATA },
  { name: "raw", data: `${RAW}/data/` },
  { name: "pages", data: PAGES_DATA },
];

export let DATA_BASE   = R2_DATA;   // winner's version.json/changelog.json base (live binding)
export let ASSETS_BASE = R2_ASSETS; // maps/minimap etc. (R2, or Pages if R2 dead)

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
  DATA_BASE = o.data;
  ASSETS_BASE = name === "r2" ? R2_ASSETS : PAGES_ASSETS;
}

// DB byte URLs, tried in order by the worker. The reachable origin (from the race)
// goes first; jsDelivr is pinned to the discovered version's tag.
export function getDbUrls(version) {
  const list = [
    { n: "r2", url: `${R2_DATA}tortoise.sqlite?v=${version}` },
    { n: "jsdelivr", url: `${JSDELIVR}@${TAG}${version}/data/tortoise.sqlite.gz` },
    { n: "raw", url: `${RAW}/data/tortoise.sqlite.gz` },
  ];
  list.sort((a, b) => (a.n === winner ? -1 : 0) - (b.n === winner ? -1 : 0));
  return list.map((x) => x.url);
}

// Icon-atlas URLs (json + matching webp), tried in order by loadIconAtlas.
export function getAtlasUrls(version) {
  const at = [
    { n: "r2", json: `${R2_ASSETS}icons/custom-atlas.json`, webp: `${R2_ASSETS}icons/custom-atlas.webp` },
    { n: "jsdelivr", json: `${JSDELIVR}@${TAG}${version}/icons/custom-atlas.json`, webp: `${JSDELIVR}@${TAG}${version}/icons/custom-atlas.webp` },
    { n: "raw", json: `${RAW}/icons/custom-atlas.json`, webp: `${RAW}/icons/custom-atlas.webp` },
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
