# Deliberately NOT applicable (read-only, CI-built, single-reader)

A generic SQLite skill spends most of its budget here. For this project every item below is
**out of scope** — recorded once so future-you doesn't re-derive it or paste it in from a
generic guide. If a task genuinely needs one of these, the project's architecture has changed
and this note should be revisited.

| Topic | Why it doesn't apply here |
|---|---|
| **WAL mode** (`journal_mode=WAL`) | A write-concurrency feature (readers don't block a writer). There is exactly one reader and zero runtime writers. Nothing to concurrency-tune. |
| **Journaling / `synchronous`** | The build turns journaling `OFF` (crash-safety irrelevant for a rebuildable artifact); at runtime nothing writes, so no journal is ever produced. |
| **Transactions / batching writes** | No runtime writes. (The *build* wraps bulk inserts in one `BEGIN`/`COMMIT` for speed — that's a build-script concern, covered implicitly in build-db, not a runtime pattern.) |
| **Connection pooling** | One worker, one connection, one DB. Pools solve many-connection contention that doesn't exist. |
| **Locking / `busy_timeout`** | No concurrent writers → no lock contention. (The only locking here is the OPFS SAHPool's *exclusive* file handle, which is why a second browser tab falls back to in-memory — a VFS concern, not SQL locking.) |
| **`VACUUM` scheduling / auto-vacuum** | `VACUUM` runs once at the end of the build to shrink the download. It never runs at runtime (read-only) and needs no schedule. |
| **Corruption recovery / `PRAGMA integrity_check` in prod** | The file is a deterministic CI artifact; a corrupt download is re-fetched, not repaired. (Handy during a *build* to sanity-check, not a runtime concern.) |
| **Migrations / `user_version` / ALTER on live DB** | Schema changes happen by editing `build-db.mjs` and rebuilding; there is no in-place migration of a live database. Cache invalidation is by content hash (`version.json`), not schema versioning. |
| **Prepared-statement reuse / bind caching for writes** | Read queries use positional binds already (`src/queries.js`); there's no write hot-loop to optimize. |

If you're reaching for any of the above to speed something up, stop — the real lever is in
`build-time.md` (schema/index/size) or `runtime-wasm.md` (cache/load), not the write path.
