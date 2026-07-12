# Runtime: WASM + OPFS load and query cost

The runtime target is `@sqlite.org/sqlite-wasm` running in a **Web Worker**
(`src/db-worker.js`). Two cost centres exist here that a native app doesn't have:
**cold-load** (download + parse + open) and **page-cache CPU** (no OS page cache to lean on).

## Why the whole DB is downloaded (don't "optimize" this away)

sql.js-httpvfs / HTTP range reads are **unusable on GitHub Pages**: Pages gzips responses
including 206 partials, and `Content-Range` reports the *compressed* length, corrupting
byte-range math. So the whole file is fetched once (gzip/brotli is transparent for a full
GET) and cached in OPFS. Do not reintroduce range-based lazy loading against Pages.

## Cold-load budget — a first-class metric

Downloading + instantiating WASM SQLite + opening the DB costs real time (the WASM module
alone is ~half a second to fetch+compile before a single query runs). Treat first-paint /
time-to-first-query as a metric, not just steady-state query latency. Levers:

- **OPFS persistence** (already done): the SAHPool VFS keeps the DB across reloads, keyed
  `tortoise-<dataset>-<version>.sqlite`, so a returning visitor skips the ~15 MB (brotli)
  download entirely. A new deploy changes the version hash → one fresh download, then sticky.
  The **worker is mandatory** for this: `FileSystemSyncAccessHandle` is Worker-only (undefined
  on the main thread in Chrome), so a main-thread SAHPool silently falls back and re-downloads
  every visit.
- **Brotli transport**: the DB ships pre-brotli'd (~77 MB → ~13–15 MB) with `Content-Encoding: br`;
  fallback mirrors serve a raw `.br` decoded client-side. Keep the file small (see build-time.md)
  because this is the number users feel on first load.
- Lazy-load the query worker / heavy chunks so they don't block first paint.

## Runtime PRAGMAs (set on open in db-worker.js)

Read-only, so the tuning is about **cache** and **temp**, not durability:

- `PRAGMA cache_size=-32768` → 32 MB page cache (negative = KiB). The single biggest WASM query
  knob: with no OS page cache, the SQLite page cache is all you get, so a bigger cache keeps hot
  B-tree pages resident across the heavy joins. Raising it trades WASM heap for speed — measure
  before going higher.
- `PRAGMA temp_store=MEMORY` → temp B-trees (the `USE TEMP B-TREE FOR ORDER BY`/GROUP sorts) stay
  in RAM instead of a temp file the OPFS VFS would have to back.
- `PRAGMA query_only=ON` → guards against accidental writes; also lets SQLite skip write-side
  bookkeeping.

## Journaling / WAL — N/A for read-only

The DB is never written at runtime, so `journal_mode`/`synchronous`/WAL are moot on the query
path (nothing generates a journal). Do not add WAL "for performance" — it's a write-concurrency
feature and irrelevant here. (General note for read-*write* OPFS workloads elsewhere:
`journal_mode=truncate` tends to beat `wal`/`delete` on OPFS — not applicable to this project.)

## Crossing the worker boundary

Query results are structured-cloned from the worker to the main thread. Negligible even for the
big zone queries, but: don't `SELECT *` huge result sets you then filter in JS — filter/limit in
SQL so less crosses the boundary and less is materialized in the worker.

Canonical: <https://sqlite.org/wasm/doc/trunk/index.md>,
<https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system>.
