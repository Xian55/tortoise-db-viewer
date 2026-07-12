# Runtime: WASM + OPFS load and query cost

The runtime target is `@sqlite.org/sqlite-wasm` running in a **Web Worker**
(`src/db-worker.js`). Two cost centres exist here that a native app doesn't have:
**cold-load** (download + parse + open) and **page-cache CPU** (no OS page cache to lean on).

## Why the whole DB is downloaded (and the range-read caveats)

The current design fetches the **whole** file once and caches it in OPFS. Range-based lazy
loading (sql.js-httpvfs) is **unusable on GitHub Pages**: Pages gzips responses including 206
partials, and `Content-Range` reports the *compressed* length, corrupting byte-range math.
Do not reintroduce range reads against **Pages**.

**On Cloudflare R2 (now the primary DB origin) the Pages blocker doesn't apply — but range
reads are still not a free win, for three concrete reasons (verified 2026-07):**

1. **The object is brotli-stored** (`Content-Encoding: br`; a `Range` request returns 206 whose
   `Content-Range` total is the *compressed* ~15 MB). sql.js-httpvfs needs ranges over the *raw*
   SQLite bytes — ranges over a brotli stream are useless. You'd have to publish a **separate
   uncompressed 77 MB object** (losing the 5× wire compression for whole-file users).
2. **The Cloudflare custom domain returned `200`, not `206`** — the proxy did not honor `Range`
   as-configured (the `r2.dev` origin did). Range through the CDN needs cache/transform-rule work.
3. **OPFS already makes repeat visits free** (whole file cached, keyed by version). So the range
   win is only *first-visit, light* users; a heavy session (finder scanning ~25k items, a zone
   map with ~12k spawns) fetches many pages and can exceed the 15 MB whole-file cost + add
   round-trips.

Net: a **measured spike** against an uncompressed R2 object, not a blind adoption. Keep whole-file
+ OPFS as the default until a prototype proves range reads win for your traffic mix.

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
