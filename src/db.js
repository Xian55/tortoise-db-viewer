// Thin client over a Web Worker that owns the SQLite engine (src/db-worker.js).
// The worker is required for the durable OPFS cache: the SAHPool VFS's
// FileSystemSyncAccessHandle only exists in a Worker, so a new deploy is fetched
// once and then served from OPFS on repeat visits (no ~58 MB re-download).
//
// Cache invalidation: build-db.mjs writes data/version.json with a content hash;
// the worker keys the OPFS filename by it and wipes stale copies.

import { DATA_BASE, getProbedMeta, getDbUrls, DATASET } from "./config.js";

let worker = null;
let readyPromise = null;
let seq = 0;
const pending = new Map();

function send(msg) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg });
  });
}

// version.json: { version: <content hash>, builtAt: <ISO build time> }. Fetched
// once and cached; drives both the cache key and the footer "Updated" stamp.
let metaPromise = null;
export function getMeta() {
  if (!metaPromise) {
    const probed = getProbedMeta(); // resolveOrigins() already fetched it during boot
    metaPromise = probed
      ? Promise.resolve(probed)
      : fetch(`${DATA_BASE}version.json`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({}));
  }
  return metaPromise;
}

async function getVersion() {
  return (await getMeta()).version || "0";
}

async function init() {
  worker = new Worker(new URL("./db-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const { id, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || "DB worker error"));
    pending.clear();
  };
  const version = await getVersion();
  // Ordered DB byte URLs across every reachable origin (R2 br via header, then the
  // jsDelivr/raw brotli mirrors). The worker tries them in order and decodes the
  // brotli client-side, so a blocked/throttled R2 falls through to a CDN mirror.
  const urls = getDbUrls(version);
  // OPFS filename is keyed by dataset + version so both datasets cache side-by-side
  // (switching main<->dev is download-free) without evicting each other.
  const mode = await send({ type: "open", version, dataset: DATASET, urls });
  if (typeof mode === "string" && mode.startsWith("memory")) {
    console.warn("OPFS unavailable; loading DB in-memory.", mode.slice(7));
  }
  return true;
}

function ready() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

/** Run a query; returns an array of row objects. */
export async function query(sql, params = []) {
  await ready();
  return send({ type: "query", sql, params });
}

/** Run a query and return the first row (or null). */
export async function queryOne(sql, params = []) {
  return (await query(sql, params))[0] || null;
}

// Optional-schema probe. The frontend is shared by every dataset (main / dev /
// vanilla-cmangos / tbc-cmangos) but each ships its own DB, so a deploy always lands
// on DBs built before the newest schema change until their workflows are dispatched.
// One round-trip, memoized, resolved before anything queries the new shapes -- reading
// them behind a per-call .catch() is not enough, because qNpcZoneSpawns feeds ~10 call
// sites and runSearch puts one inside a Promise.all where a single rejection would
// wipe out every other entity's results.
let capsPromise = null;
export function caps() {
  if (!capsPromise) {
    capsPromise = query(`SELECT
        (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'subzones') AS subzones,
        (SELECT COUNT(*) FROM pragma_table_info('spawn_points') WHERE name = 'sub') AS spawn_sub`)
      .then((r) => ({ subzones: !!r[0]?.subzones, spawnSub: !!r[0]?.spawn_sub }))
      .catch(() => ({ subzones: false, spawnSub: false }));
  }
  return capsPromise;
}

/** Start loading the engine + DB in the background. */
export function preconnect() {
  ready().catch(() => {});
  caps().catch(() => {});
}
