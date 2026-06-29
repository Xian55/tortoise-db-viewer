// SQLite runs here in a Web Worker so the OPFS SAHPool VFS works: its
// FileSystemSyncAccessHandle is Worker-only (undefined on the main thread in
// Chrome), which is why the previous main-thread SAHPool always fell back to an
// in-memory copy and re-downloaded the ~58 MB DB every visit. In the worker OPFS
// persists across reloads. No COOP/COEP needed (SAHPool, not the Atomics VFS).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const OPFS_POOL = "tortoise-db";
const OPFS_LOCK = "tortoise-db-opfs-vfs";
let db = null;

// Try each URL in order (primary R2, then the Pages mirror). A per-attempt abort
// keeps a throttled/stalled R2 transfer from hanging forever before we fall over.
async function fetchBytes(urls) {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr;
  for (const u of list) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 60000);
      const res = await fetch(u, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) { lastErr = e; }
  }
  throw new Error(`DB download failed: ${lastErr?.message || lastErr}`);
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

async function open(version, urls) {
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
        pool.importDb(file, await fetchBytes(urls));
      }
      db = new pool.OpfsSAHPoolDb(file);
      return "opfs";
    } catch (e) {
      poolErr = e; // OPFS present but unusable -> fall through to in-memory
    }
  }
  // Fallback: deserialize into memory (secondary tab, or OPFS unavailable). Relies
  // on the HTTP cache for the bytes.
  const bytes = await fetchBytes(urls);
  db = new sqlite3.oo1.DB();
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  db.checkRc(sqlite3.capi.sqlite3_deserialize(
    db.pointer, "main", p, bytes.length, bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE));
  return poolErr ? `memory:${poolErr?.message || poolErr}` : "memory:secondary-tab";
}

self.onmessage = async (ev) => {
  const { id, type, sql, params, version, urls } = ev.data;
  try {
    if (type === "open") {
      const result = await open(version, urls);
      // Read-only tuning: a 32 MB page cache keeps the hot b-tree resident (faster
      // repeat zone/search queries), temp b-trees (ORDER BY / GROUP BY) build in
      // RAM, and query_only guards against accidental writes. Best-effort.
      try { db.exec("PRAGMA cache_size=-32768; PRAGMA temp_store=MEMORY; PRAGMA query_only=ON;"); } catch { /* non-fatal */ }
      self.postMessage({ id, result });
      return;
    }
    if (type === "query") {
      const rows = db.exec({ sql, bind: params, rowMode: "object", returnValue: "resultRows" });
      self.postMessage({ id, result: rows });
    }
  } catch (e) {
    self.postMessage({ id, error: e?.message || String(e) });
  }
};
