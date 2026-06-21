// SQLite runs here in a Web Worker so the OPFS SAHPool VFS works: its
// FileSystemSyncAccessHandle is Worker-only (undefined on the main thread in
// Chrome), which is why the previous main-thread SAHPool always fell back to an
// in-memory copy and re-downloaded the ~58 MB DB every visit. In the worker OPFS
// persists across reloads. No COOP/COEP needed (SAHPool, not the Atomics VFS).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const OPFS_POOL = "tortoise-db";
const OPFS_LOCK = "tortoise-db-opfs-vfs";
let db = null;

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DB download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Only one tab may use the OPFS SAHPool VFS: it takes *exclusive* sync access
// handles on its pool files, so a second tab's installOpfsSAHPoolVfs() spams
// NoModificationAllowedError and falls back anyway. Gate on a Web Lock held for
// this worker's lifetime: the first tab gets it (uses OPFS); later tabs don't
// (they go straight to the in-memory copy, with no failed-handle noise).
function acquireOpfsLock() {
  if (!self.navigator?.locks) return Promise.resolve(true); // no Web Locks: just try
  return new Promise((resolve) => {
    self.navigator.locks.request(OPFS_LOCK, { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      // hold the lock for the worker's lifetime when granted (auto-released on close)
      return lock ? new Promise(() => {}) : undefined;
    }).catch(() => resolve(false));
  });
}

async function open(version, url) {
  const sqlite3 = await sqlite3InitModule();
  let poolErr = null;
  // Preferred: durable OPFS SAHPool, keyed by version so a new deploy refreshes.
  // Skipped in secondary tabs (see acquireOpfsLock) to avoid handle contention.
  if (await acquireOpfsLock()) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: OPFS_POOL });
      const file = `/tortoise-${version}.sqlite`;
      if (!pool.getFileNames().includes(file)) {
        for (const f of pool.getFileNames()) {
          if (f.startsWith("/tortoise-") && f.endsWith(".sqlite")) { try { pool.unlink(f); } catch { /* ignore */ } }
        }
        pool.importDb(file, await fetchBytes(url));
      }
      db = new pool.OpfsSAHPoolDb(file);
      return "opfs";
    } catch (e) {
      poolErr = e; // OPFS present but unusable -> fall through to in-memory
    }
  }
  // Fallback: deserialize into memory (secondary tab, or OPFS unavailable). Relies
  // on the HTTP cache for the bytes.
  const bytes = await fetchBytes(url);
  db = new sqlite3.oo1.DB();
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  db.checkRc(sqlite3.capi.sqlite3_deserialize(
    db.pointer, "main", p, bytes.length, bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE));
  return poolErr ? `memory:${poolErr?.message || poolErr}` : "memory:secondary-tab";
}

self.onmessage = async (ev) => {
  const { id, type, sql, params, version, url } = ev.data;
  try {
    if (type === "open") { self.postMessage({ id, result: await open(version, url) }); return; }
    if (type === "query") {
      const rows = db.exec({ sql, bind: params, rowMode: "object", returnValue: "resultRows" });
      self.postMessage({ id, result: rows });
    }
  } catch (e) {
    self.postMessage({ id, error: e?.message || String(e) });
  }
};
