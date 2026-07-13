# Build-time: schema, indexing, file size

Everything here happens in `scripts/build-db.mjs`, runs once in CI, and is baked into the
shipped file. A read-only DB can be indexed as aggressively as the download budget allows —
there are no write amplification costs to pay later.

## Covering & composite indexes — the biggest read-only win

A **covering index** answers a query entirely from the index B-tree, never touching the table
(no rowid lookups). The plan shows `COVERING INDEX`. Make an index cover a hot query by
including every column it reads.

- Example already in this DB: `idx_quests_zone` covers `SELECT entry … WHERE zone=?` →
  `SCAN q USING COVERING INDEX idx_quests_zone`. Good.
- Counter-example to fix by pattern: `items WHERE class=2 AND quality=4 ORDER BY name` plans as
  **`SCAN items`** + `USE TEMP B-TREE FOR ORDER BY`. A composite index
  `(class, quality, name)` would let one index satisfy the **filter AND the sort** — the
  leading equality columns (`class`,`quality`) seek, and `name` is then already ordered, so
  the temp B-tree sort disappears. (The item browse builds its WHERE dynamically in
  `browse.js`; index the common leading filters — `class`, then `quality`/`subclass`/`slot`.)

**Column order rule:** equality-filter columns first, then the `ORDER BY` column, then any
extra covered columns. An index on `(a, b)` serves `WHERE a=? ORDER BY b` with no sort; an
index on `(b, a)` does not.

Canonical: <https://sqlite.org/queryplanner.html>, <https://sqlite.org/optoverview.html>.

## ANALYZE — ship the stats

`build-db.mjs` runs `ANALYZE` before the final `VACUUM`, writing `sqlite_stat1` **into the
file**. The planner is deterministic, not magic: on multi-table joins (drops ↔ items ↔
spawns) it needs row-count/selectivity stats to pick the driving table and the right index.
Absent/stale stats is the usual cause of a suddenly-bad plan. If you add heavy joins, keep
`ANALYZE` last-but-one (before `VACUUM`) so the shipped stats reflect the final data.
Verify shipped: `SELECT count(*) FROM sqlite_stat1;` (>0).

## FTS5 for search — never leading-wildcard LIKE

`LIKE '%term%'` cannot use an index (leading wildcard) → full scan every keystroke. This DB
builds **FTS5** contentless indexes at CI time instead: `items_fts`/`creatures_fts`/
`quests_fts`/`spells_fts` (`unicode61`, prefix) for prefix+ranking, plus `*_tg` **trigram**
indexes for true substring/infix ("fang" → "Shadowfang"). Search OR-matches both. When adding
a searchable entity, mirror that pair; don't reach for `LIKE`. Trigram indexes cost download
size (~2 MB here) — add them only where infix search matters (items/creatures), not everywhere.

Canonical: <https://sqlite.org/fts5.html>.

## File size (it ships over the wire)

- `page_size = 4096`, set **before any table is created** (can't change later without a rebuild).
  Measured optimal for the **brotli** download here; 8k/16k/32k compressed *worse*. Don't change
  without re-measuring the compressed size, not the raw size.
- `VACUUM` at the very end defragments and packs pages → smaller file → smaller brotli.
- Drop staging/intermediate tables **before** `VACUUM` (build-db does: `src.drop()`), else their
  pages bloat the file.
- Indexes are download weight too. Each index is pure win for query speed but adds bytes; the
  trade is size-vs-speed, decided by measuring the **brotli** artifact.

## WITHOUT ROWID — consider for pure link tables

Small two/three-column link/lookup tables that are always queried by their key (`quest_item`,
`spell_reagent`, `quest_dungeon`, `suffix_pool`) are candidates for `WITHOUT ROWID` with an
explicit composite `PRIMARY KEY`: it stores rows *in* the PK B-tree (no separate rowid table),
which can shrink the file and make key lookups covering. Only worth it when the table is
lookup-only and the PK is the access path — **measure file size + the plan** before/after,
don't apply blindly. Canonical: <https://sqlite.org/withoutrowid.html>.

## Checklist when adding a table/index

- [ ] Index the columns the real query filters + sorts by, in that order; aim for `COVERING`.
- [ ] Re-run `EXPLAIN QUERY PLAN` on the actual query against the built DB — confirm `SEARCH`/`COVERING`, no stray `SCAN`/`USE TEMP B-TREE`.
- [ ] Keep `ANALYZE` before `VACUUM`; confirm `sqlite_stat1` ships.
- [ ] Check the **brotli** size delta, not the raw `.sqlite` size.
