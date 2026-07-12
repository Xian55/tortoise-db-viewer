---
name: build-db-derivation
description: Rules for adding or editing a DERIVED table / relation in the DB build (scripts/build-db.mjs, scripts/lib/*, or any build-time SQLite derivation that reads staged/imported tables to compute a new viewer table). Load BEFORE writing derivation code that joins large tables (drops ~550k, spawn_points ~160k, creatures ~30k) or loops over entities/maps/zones running a query per iteration. Enforces set-based (index-free-safe) derivation and dataset-agnostic relations so the build stays fast and works across every dataset (Turtle main, 1181dev, cmangos vanilla). Triggers: "derive a table", "new build-db table", "quest_dungeon-style", "build is slow/hanging", "add a relation", "cross-entity link at build time".
---

# Build-time derivation: make it fast and portable

Two rules, learned the hard way (a derivation that ran 16 min → 0.5 s after the rewrite).

## Rule 1 — Derive SET-BASED, not per-entity SQL

At the point derivations run, the shipped DB's indexes and `ANALYZE` stats **do not exist
yet** (they are created near the end, right before `VACUUM`). So a query that looks cheap
against the *finished* DB is a full table scan during the build.

**Anti-pattern (quadratic — this is the mistake):** loop over N entities and run a query
each iteration, especially a correlated `NOT EXISTS` / subquery over a big table.

```js
// ❌ 47 maps × a NOT EXISTS over drops(550k) with a re-evaluated CTE, no index → minutes
for (const m of instMaps) {
  db.prepare(`... WHERE ... AND NOT EXISTS (SELECT 1 FROM drops d2 JOIN ... WHERE d2.item = qi.item ...)`).all();
}
```

**Pattern:** scan each source table **once**, build in-memory `Map`/`Set` indexes in JS, then
join by lookup. Bounded, linear, needs no DB index.

```js
// ✅ each source scanned once; joins are Map lookups → ~0.5s
const creatureMaps = new Map();                 // entry -> Set(maps)
for (const r of db.prepare(`SELECT id, map FROM spawns`).all()) addTo(creatureMaps, r.id, r.map);
for (const r of db.prepare(`SELECT entry, map FROM creature_instance`).all()) addTo(creatureMaps, r.entry, r.map);
const itemMaps = new Map();                      // item -> Set(maps across all droppers)
for (const d of db.prepare(`SELECT item, owner FROM drops WHERE src='c'`).all()) { /* Map lookups */ }
// ...then decide membership from the Maps, INSERT once inside a single BEGIN/COMMIT.
```

Checklist before you write a derivation:
- [ ] No query inside a loop over entities/maps/zones/items. One scan per source table.
- [ ] Big-table access (`drops`, `spawn_points`, `creatures`) is a single `SELECT ... ` pulled
      into JS, not a correlated subquery / repeated join.
- [ ] All INSERTs wrapped in one `db.exec("BEGIN")` / `db.exec("COMMIT")`.
- [ ] Create the derived table's index AFTER bulk insert; the build's final `ANALYZE` covers stats.
- [ ] Sanity-check timing: a derivation touching the big tables should be < ~2 s, not minutes.

Canonical example: the `quest_dungeon` block in `scripts/build-db.mjs` (search
"Building quest_dungeon"). Its git history is the before/after of this exact rule.

## Rule 2 — Derive from STRUCTURAL facts, no hardcoded ids

A derivation that hardcodes entry/zone/map ids or names rots on the next upstream patch and
is wrong on the other datasets. Instead compute from the standard MaNGOS-derived viewer
tables that EVERY build produces (`maps`/`zones`/`areas`/`quests`/`spawns`/`drops`/
`creature_instance`/`quest_item`/`*_quest_start|end`, …).

- [ ] Zero hardcoded entry/zone/map ids or dungeon names. (Only sanctioned constant: map
      `451`, the GM "Development Land" copy — an existing repo convention.)
- [ ] Works unchanged on Turtle `main`, the `1181dev` branch, and `SQL_SOURCE=cmangos` (vanilla).
      → future world migrations + new content flow through automatically, no code change.
- [ ] Creature location = `spawns` UNION `creature_instance`. Script-spawned bosses (e.g. Baron
      Aquanis) have **no** static `spawns` row — a spawns-only join silently drops them.
- [ ] If a UI surface already expresses the same relation (e.g. `Q_DUNGEON_QUESTS` in
      `src/queries.js`), mirror ITS relations so the derived table can't drift from the page.

See also memory `derived-relations-build-time`.
