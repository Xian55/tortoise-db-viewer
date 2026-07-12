---
name: sqlite-wasm-perf
description: SQLite performance for THIS project — a read-only, CI-built, browser-side (sqlite-wasm + OPFS) database. Load whenever touching scripts/build-db.mjs, src/queries.js, src/db-worker.js, index or schema design, the shipped file size / download, WASM cold-load time, FTS/search, or ANY slow-query / EXPLAIN QUERY PLAN investigation — even if the user never says the word "performance". Covers build-time schema+indexing, runtime WASM pragmas, and reading query plans. Does NOT cover the SQLite write path (WAL, locking, pooling, transactions) — this DB is never mutated in the browser; see references/not-applicable.md.
---

# SQLite performance for a read-only WASM viewer

This project is NOT a typical SQLite app. Generic "SQLite best practices" (WAL, connection
pools, transaction batching, VACUUM schedules, locking) are about the **write path** and
**concurrency** — this DB has neither. It is:

- **Built once in CI** (`scripts/build-db.mjs`) → shipped as one file → **never written in the browser**.
- **Queried in a Web Worker** (`src/db-worker.js`) via `@sqlite.org/sqlite-wasm`, cached in **OPFS** (SAHPool VFS).
- Loaded **whole** (no HTTP range — Pages gzips 206s wrong), so **download size** and **cold-load** are first-class costs.
- Read-only at runtime (`PRAGMA query_only=ON`), so there are only two levers: **build-time schema/indexing** and **runtime query CPU**.

Discard the write-path 60%. Go deep on the 40% that is ours.

## Decision tree — which surface is the problem?

```
Slow / heavy?
├─ file too big to download, or cold-load slow      → references/runtime-wasm.md (size, page cache, load budget)
├─ a specific query is slow / a browse filter lags  → references/query-planning.md  (EXPLAIN QUERY PLAN first!)
├─ adding a table/column, an index, or search       → references/build-time.md      (covering/composite idx, ANALYZE, FTS5)
└─ tempted to add WAL / a transaction / pooling      → references/not-applicable.md  (you don't need it — here's why)
```

## The one rule: verify with EXPLAIN QUERY PLAN, never guess

Every performance claim is checked against the **real built DB**, not intuition:

```sh
bun -e 'import{Database}from"bun:sqlite";const db=new Database("public/data/tortoise.sqlite",{readonly:true});
for(const r of db.query("EXPLAIN QUERY PLAN "+process.argv[1]).all())console.log(r.detail)' \
  "SELECT entry,name FROM items WHERE class=2 AND quality=4 ORDER BY name"
```

Read it: **`SEARCH … USING INDEX`** good (subset of rows); **`SCAN <table>`** = full table scan (suspect on a filtered query); **`USE TEMP B-TREE FOR ORDER BY`** = the sort isn't index-covered; **`COVERING INDEX`** = best (never touches the table). For recursive/EXISTS work watch for `CORRELATED SCALAR SUBQUERY` re-running per row.

Real output from this DB (why it matters):

| query | plan | verdict |
|---|---|---|
| `drops WHERE owner=? AND src='c' ORDER BY chance` | `SEARCH d USING INDEX idx_drops_owner` + `USE TEMP B-TREE FOR ORDER BY` | indexed lookup, sort not covered |
| `items WHERE class=2 AND quality=4 ORDER BY name` | **`SCAN items`** + temp b-tree | full scan — no composite index on the filter |
| `items_fts MATCH 'copper*'` | `SCAN f VIRTUAL TABLE` + PK lookup | correct FTS path |
| `quests WHERE zone=719 OR EXISTS(quest_dungeon…)` | `SCAN q USING COVERING INDEX idx_quests_zone` + `SEARCH qd USING idx_quest_dungeon_quest` | both sides indexed |

## This project's actual perf config (know it before you change it)

- **Build** (`build-db.mjs`): `page_size=4096` (set before any table — measured optimal for the brotli download; 8k/16k/32k compress worse), `journal_mode=OFF`+`synchronous=OFF` during the build for speed, then `journal_mode=DELETE` → **`ANALYZE`** (ships `sqlite_stat1` so the planner has stats) → **`VACUUM`** (defragment for a smaller download). 42 indexes. ~77 MB file, ~19.8k pages.
- **Runtime** (`db-worker.js`): opens read-only in a Worker with `PRAGMA cache_size=-32768` (32 MB), `temp_store=MEMORY`, `query_only=ON`. OPFS SAHPool persists across reloads (keyed by dataset+version); falls back to an in-memory deserialize if OPFS is unusable.
- **Loot is pre-flattened** into the `drops` table at build time — the project deliberately does NOT run recursive loot-CTEs at query time (see `src/queries.js` header + CLAUDE.md). Build-time pre-resolution over runtime recursion is the pattern; keep it.

## Sibling skill

`build-db-derivation` owns **what** derived tables exist and how to build them cheaply (set-based, no build-time indexes). This skill owns **how fast** the shipped tables query. When adding a derived table, both apply: derive it set-based, then index it for its read pattern and re-check the plan.
