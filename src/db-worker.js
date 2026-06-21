// SQLite runs here in a Web Worker so the OPFS SAHPool VFS works: its
// FileSystemSyncAccessHandle is Worker-only (undefined on the main thread in
// Chrome), which is why the previous main-thread SAHPool always fell back to an
// in-memory copy and re-downloaded the ~58 MB DB every visit. In the worker OPFS
// persists across reloads. No COOP/COEP needed (SAHPool, not the Atomics VFS).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const OPFS_POOL = "tortoise-db";
let db = null;

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DB download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function open(version, url) {
  const sqlite3 = await sqlite3InitModule();
  // Preferred: durable OPFS SAHPool, keyed by version so a new deploy refreshes.
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
    // Fallback: deserialize into memory (relies on the HTTP cache for the bytes).
    const bytes = await fetchBytes(url);
    db = new sqlite3.oo1.DB();
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    db.checkRc(sqlite3.capi.sqlite3_deserialize(
      db.pointer, "main", p, bytes.length, bytes.length,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE));
    return `memory:${e?.message || e}`;
  }
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
