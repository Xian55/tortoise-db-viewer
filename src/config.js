// Asset hosts. CI sets VITE_*_BASE to the R2 public URL so the heavy DB + maps +
// icon atlas are served off GitHub Pages bandwidth; when unset (dev / self-host)
// both fall back to the Pages base path so the dist copies resolve.
//
// Two datasets: "main" (server `main` branch, /) and "dev" (server `1181dev`
// branch, served at /dev/). They share every asset (maps/icons/minimap) — only
// the DB + version.json differ, so only DATA_BASE is dataset-aware. DATASET is
// picked from the path (/<base>/dev/...) with a ?db=dev override for the local
// vite dev server (which has no /dev/ file on disk).
//
// Regional Cloudflare/R2 failover: every asset URL is built from DATA_BASE /
// ASSETS_BASE (live `let` bindings — reassigning them here updates every importer
// that reads them at call time). resolveOrigins() probes R2's tiny version.json at
// boot; if R2 is throttled/blocked it flips both to the Pages mirror (dist already
// ships a full asset copy) for the session and remembers it. main.js awaits it
// before anything reads a base; db.js also passes the mirror DB URL to the worker
// as a second attempt for the case where R2 serves version.json but throttles the
// big DB. The dev dataset has no Pages copy of its DB, so it is R2-only: the DB
// origin is never flipped to Pages (that would silently serve main's DB).
const BASE = import.meta.env.BASE_URL; // e.g. "/tortoise-db-viewer/"
const relPath = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : "";
const qDb = new URLSearchParams(location.search).get("db");
export const DATASET = relPath.startsWith("dev") || qDb === "dev" ? "dev" : "main";
const IS_DEV = DATASET === "dev";

const R2_DATA = IS_DEV
  ? (import.meta.env.VITE_DATA_BASE_DEV || `${BASE}data-dev/`)
  : (import.meta.env.VITE_DATA_BASE || `${BASE}data/`);
const R2_ASSETS    = import.meta.env.VITE_ASSETS_BASE || BASE; // dataset-independent
// The dev DB has no dist/Pages copy (dist ships none, and it'd be the *main* DB),
// so its "Pages" origin is the dev R2 base itself — useMirror() then can't flip
// dev's DB to main's, and the worker's mirror URL dedups away.
const PAGES_DATA   = IS_DEV ? R2_DATA : `${BASE}data/`; // main's dist copy (Pages/Fastly, not Cloudflare)
const PAGES_ASSETS = BASE;

export let DATA_BASE   = R2_DATA;   // flipped to PAGES_DATA by resolveOrigins() if R2 is unreachable (main only)
export let ASSETS_BASE = R2_ASSETS;
export const MIRROR_DATA_BASE = PAGES_DATA; // db.js builds the worker's fallback DB URL from this

const MIRROR_KEY = "assetMirror"; // sticky flag: R2 proven dead in this region
const STICKY_TTL = 7 * 864e5;     // 7d — a transient block self-recovers after this
let probedMeta = null;            // version.json captured by the probe; reused by db.js getMeta
export function getProbedMeta() { return probedMeta; }

// Fail the DB origin over to Pages only for the main dataset (dev has no Pages
// copy — PAGES_DATA === R2_DATA there, so DATA_BASE stays on dev R2). Assets are
// shared and always have a dist copy, so they flip either way.
function useMirror() { DATA_BASE = PAGES_DATA; ASSETS_BASE = PAGES_ASSETS; }
function readSticky() { try { return JSON.parse(localStorage.getItem(MIRROR_KEY)); } catch { return null; } }
function writeSticky() { try { localStorage.setItem(MIRROR_KEY, JSON.stringify({ o: "pages", t: Date.now() })); } catch { /* private mode */ } }

// Pick the asset origin once at boot. Fast no-op when R2 isn't configured (dev) or
// when a prior visit already proved R2 dead (sticky, within TTL).
export async function resolveOrigins() {
  if (DATA_BASE === PAGES_DATA && ASSETS_BASE === PAGES_ASSETS) return; // nothing to fail over to
  const s = readSticky();
  if (s?.o === "pages" && Date.now() - s.t < STICKY_TTL) { useMirror(); return; }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000); // reachability test, not throughput
    const r = await fetch(`${R2_DATA}version.json`, { cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    probedMeta = await r.json(); // reuse in getMeta -> no second version.json fetch
  } catch {
    useMirror();
    writeSticky();
  }
}
