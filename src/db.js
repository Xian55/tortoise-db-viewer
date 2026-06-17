// Official SQLite WASM build. The whole DB is fetched once and loaded into the
// engine; all queries then run locally. Persisted to OPFS (when available) so
// repeat visits skip the download. No COOP/COEP headers needed (OPFS SAHPool).
//
// Cache invalidation: build-db.mjs writes data/version.json with a content hash.
// The client keys both the download URL (?v=) and the OPFS filename by that hash,
// and wipes stale OPFS copies — so a new deploy is picked up automatically.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const BASE = import.meta.env.BASE_URL;
const OPFS_POOL = "tortoise-db";

let dbPromise = null;

async function getVersion() {
  try {
    const res = await fetch(`${BASE}data/version.json`, { cache: "no-store" });
    if (res.ok) return (await res.json()).version || "0";
  } catch { /* fall through */ }
  return "0";
}

async function fetchDbBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DB download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function init() {
  const version = await getVersion();
  const url = `${BASE}data/tortoise.sqlite?v=${version}`;
  const opfsFile = `/tortoise-${version}.sqlite`;
  const sqlite3 = await sqlite3InitModule();

  // Preferred: OPFS SAHPool — durable, survives reloads, works on GitHub Pages.
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: OPFS_POOL });
    if (!pool.getFileNames().includes(opfsFile)) {
      // a new version: drop any older cached DBs, then import this one
      for (const f of pool.getFileNames()) {
        if (f.startsWith("/tortoise-") && f.endsWith(".sqlite")) {
          try { pool.unlink(f); } catch { /* ignore */ }
        }
      }
      pool.importDb(opfsFile, await fetchDbBytes(url));
    }
    return new pool.OpfsSAHPoolDb(opfsFile);
  } catch (e) {
    console.warn("OPFS unavailable; loading DB in-memory.", e?.message || e);
  }

  // Fallback: deserialize into an in-memory database (relies on HTTP cache).
  const bytes = await fetchDbBytes(url);
  const db = new sqlite3.oo1.DB();
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer, "main", p, bytes.length, bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  db.checkRc(rc);
  return db;
}

function getDb() {
  if (!dbPromise) dbPromise = init();
  return dbPromise;
}

/** Run a query; returns an array of row objects. */
export async function query(sql, params = []) {
  const db = await getDb();
  return db.exec({ sql, bind: params, rowMode: "object", returnValue: "resultRows" });
}

/** Run a query and return the first row (or null). */
export async function queryOne(sql, params = []) {
  return (await query(sql, params))[0] || null;
}

/** Start loading the engine + DB in the background. */
export function preconnect() {
  getDb().catch(() => {});
}
