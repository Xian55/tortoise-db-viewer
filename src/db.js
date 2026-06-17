// Official SQLite WASM build. The whole DB is fetched once and loaded into the
// engine; all queries then run locally. Persisted to OPFS (when available) so
// repeat visits skip the download. No COOP/COEP headers needed (OPFS SAHPool).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const DB_URL = import.meta.env.BASE_URL + "data/tortoise.sqlite";
// Bump when the DB schema/content changes to invalidate the OPFS copy.
const OPFS_POOL = "tortoise-db";
const OPFS_FILE = "/tortoise.sqlite";

let dbPromise = null;

async function fetchDbBytes() {
  const res = await fetch(DB_URL);
  if (!res.ok) throw new Error(`DB download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function init() {
  const sqlite3 = await sqlite3InitModule();

  // Preferred: OPFS SAHPool — durable, survives reloads, works on GitHub Pages.
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: OPFS_POOL });
    if (!pool.getFileNames().includes(OPFS_FILE)) {
      pool.importDb(OPFS_FILE, await fetchDbBytes());
    }
    return new pool.OpfsSAHPoolDb(OPFS_FILE);
  } catch (e) {
    console.warn("OPFS unavailable; loading DB in-memory.", e?.message || e);
  }

  // Fallback: deserialize into an in-memory database (relies on HTTP cache).
  const bytes = await fetchDbBytes();
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
