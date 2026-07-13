# Query planning: reading EXPLAIN QUERY PLAN + this project's patterns

## Always start here

```sh
bun -e 'import{Database}from"bun:sqlite";const db=new Database("public/data/tortoise.sqlite",{readonly:true});
for(const r of db.query("EXPLAIN QUERY PLAN "+process.argv[1]).all())console.log(r.detail)' "<your SQL>"
```

Run against the **built** DB (it has the shipped indexes + `sqlite_stat1`). A query that's fast
in isolation can regress once the planner sees real stats — always test the real file.

## Reading the plan

| token | meaning | action |
|---|---|---|
| `SEARCH t USING INDEX ix (col=?)` | index seek, subset of rows | good |
| `SEARCH t USING COVERING INDEX ix` | answered from index, table never touched | best |
| `SCAN t` | full table scan | fine for tiny tables; **suspect** on a filtered/joined big table (drops 550k, spawn_points 160k) |
| `USE TEMP B-TREE FOR ORDER BY`/`GROUP BY` | sort not covered by an index | add/extend an index so the order falls out of it |
| `CORRELATED SCALAR SUBQUERY n` | subquery re-runs per outer row | ensure its inner lookup is indexed; consider a join |
| `USE TEMP B-TREE` inside a recursive CTE | recursion materializing | see "pre-flatten" below |

## Pattern 1 — pre-flatten at build time instead of recursive CTEs at query time

The mangos loot model (loot groups + `mob_group` reference multipliers, equal-chance groups)
is naturally a **recursive** resolution. This project resolves it **once in `build-db.mjs`**
into a flat `drops` table (`src`: c/s/p/o/i/e, with the effective `chance` already computed).
So runtime loot reads are simple indexed joins:

```
SEARCH d USING INDEX idx_drops_owner (owner=? AND src=?)   -- not a recursive CTE
```

**Rule (also in CLAUDE.md): do NOT reintroduce recursive loot CTEs at query time.** If you need
a new transitive/derived relation, compute it in the build (a table + index), don't recurse per
request. This is the same principle as the `build-db-derivation` skill — and `quest_dungeon` is
another instance: the dungeon↔quest bridge is a built table, so the finder does
`WHERE zone=? OR EXISTS(quest_dungeon…)` (indexed) instead of resolving membership live.

## Pattern 2 — composite index to kill the temp-B-tree sort

`items WHERE class=? AND quality=? ORDER BY name` → `SCAN items` + `USE TEMP B-TREE FOR ORDER BY`.
An index `(class, quality, name)` turns it into an index seek whose rows already arrive in `name`
order — filter and sort in one structure. Leading columns = equality filters, trailing = the sort
key. Verify the temp B-tree is gone in the new plan.

## Pattern 3 — correlated subquery vs join

`EXPLAIN` showing `CORRELATED SCALAR SUBQUERY` that re-runs per row is fine **iff** its inner
access is an index seek (e.g. `quest_dungeon` via `idx_quest_dungeon_quest`). If the inner side
scans, rewrite as a JOIN or ensure the index exists. Small correlated subqueries over indexed
keys are cheap; scans inside them are not.

## Pattern 4 — FTS, not LIKE

`… WHERE name LIKE '%x%'` scans and can't index. Use the `*_fts` (prefix) + `*_tg` (trigram/infix)
tables built at CI time; `MATCH` plans as a virtual-table lookup + a PK fetch. See build-time.md.

## The optimizer's levers (when a plan is wrong)

- Missing/covering index (most common fix) — see build-time.md.
- Stale stats — confirm `sqlite_stat1` shipped; re-`ANALYZE` if the data shape changed a lot.
- Join order — SQLite reorders joins by cost; a `CROSS JOIN` forces the written order (a hint,
  rarely needed here). Prefer fixing the index over hinting.

Canonical: <https://sqlite.org/eqp.html>, <https://sqlite.org/optoverview.html>,
<https://sqlite.org/queryplanner.html>.
