# CLAUDE.md

Guidance for working in this repo. See `README.md` for the user-facing overview.

## What this is

A static, single-page item/NPC/dungeon database for Tortoise-WoW (a 1.12 MaNGOS
fork), hosted on GitHub Pages at https://xian55.github.io/tortoise-db-viewer/.
There is **no backend**: the whole SQLite DB is shipped and queried in the
browser with the official `@sqlite.org/sqlite-wasm` build.

## Architecture (how it fits together)

```
../tortoise-wow/sql/base/*.sql        server MaNGOS SQL dumps (base world data)
../tortoise-wow/sql/database_updates/  incremental world migrations (patch content:
   *.sql                               new zones/NPCs/objects/quests). mangosd
                                       applies these at runtime; the build does too.
        │  scripts/build-db.mjs        stage raw tables -> apply migrations (in
        │                              timestamp order) -> normalize + index +
        │                              resolve chances
        ▼
public/data/tortoise.sqlite           one indexed DB (~34 MB), fetched whole
        │  src/db.js (sqlite-wasm + OPFS cache, gzip-safe full download)
        ▼
src/queries.js  → src/table.js / src/render.js / src/hovercard.js / src/browse.js

F:/Game/Turtle WoW/Data/*.mpq         client patch MPQs (Turtle custom content)
        │  scripts/extract-icons.py    LOCAL ONLY — needs the client + StormLib
        ▼
assets/icons/custom/*.webp            committed source: 1 icon/file (extracted once)
scripts/data/item-display-supplement.json  committed: display_id -> icon, for every
                                      item row missing/stale in the server SQL dump
        │  scripts/build-atlas.py      pack icons into one sprite sheet
        ▼
public/icons/custom-atlas.{webp,json} the shippable atlas (render.js draws sprites)
```

- **Whole-DB load, not HTTP range.** GitHub Pages gzips responses (including 206
  partials) with `Content-Range` reporting the *compressed* size, which corrupts
  byte-range reads — so sql.js-httpvfs is unusable here. We download the whole
  file once (gzip is transparent for a full GET) and query it in memory. The DB
  is cached in **OPFS** (SAHPool VFS, no COOP/COEP needed); falls back to an
  in-memory deserialize when OPFS is unavailable.
- **Cache invalidation:** `build-db.mjs` writes `data/version.json` with a
  content hash. `db.js` keys the download URL (`?v=`) and the OPFS filename by
  that hash and wipes old copies, so a new deploy auto-refreshes clients.
- **Routing** is query-param based (SPA, no server rewrites): `?item=`, `?npc=`,
  `?quest=`, `?faction=`, `?zone=`, `?dungeon=`, `?dungeons`,
  `?browse=items|npcs|quests|factions|zones|crafting`, `?search=`. `route()`
  checks `?browse=` **before** the singular entity params (browse URLs carry
  filter params like `faction=a` that collide otherwise). See `src/main.js`.
- **Zone maps use Leaflet** (`L.CRS.Simple`, npm dep, lazy-loaded as its own
  chunk via `src/zonemap.js`). A zone page renders the in-game parchment image
  (`public/maps/<areaId>.webp`) and plots spawn markers; world (x,y) → image px
  via the zone's WorldMapArea bounds (`lat=H*(x-locbottom)/(loctop-locbottom)`,
  `lng=W*(locleft-y)/(locleft-locright)`). Markers use a canvas renderer.
- **Search is unified + FTS-backed.** `?search=` renders a tabbed page across
  items/NPCs/quests/dungeons/zones; the top-bar input also shows a live flat
  top-5 dropdown (`src/search.js`, `runSearch()` + `initSearchDropdown()`). Items,
  creatures, and quests have FTS5 tables (`*_fts`); dungeons (maps) and zones use
  LIKE over their small tables.

## Commands

Runs on **Bun** (preferred — native `bun:sqlite`, no native compile) or **Node**
(`better-sqlite3`, an optional dep). `scripts/lib/sqlite.mjs` auto-detects.

```sh
bun install
bun scripts/build-db.mjs        # build public/data/tortoise.sqlite (+ version.json)
bun run dev                     # http://localhost:5173/tortoise-db-viewer/
bunx --bun vite build           # production build to dist/
node scripts/smoke.mjs          # headless end-to-end (needs Chrome; SMOKE_BASE env to point it)

# Custom icons (Python + Pillow + StormLib; see "Custom icons" below)
python scripts/extract-icons.py # LOCAL: client MPQ -> assets/icons/custom/*.webp + supplement
python scripts/build-atlas.py   # assets/icons/custom/*.webp -> public/icons/custom-atlas.{webp,json}
python scripts/extract-maps.py  # LOCAL: client -> public/maps/*.webp + scripts/data/zones.json
```

`SQL_DIR` defaults to `../tortoise-wow/sql/base`; `UPDATES_DIR` defaults to its
sibling `../database_updates` (the world migrations). Built data (`*.sqlite`,
`version.json`) is **gitignored and rebuilt in CI** — never commit it.

### World migrations (sql/database_updates)

The server ships patch content (new zones, NPCs, objects, quests) as timestamped
migration files in `sql/database_updates`, applied by `mangosd` **on top of**
`sql/base` at runtime — the base dump alone is missing all of it (e.g. the 1.18.1
zones Balor/Dragonmaw/etc. would be empty). `build-db.mjs` replicates the server:
it **stages** the raw world tables it consumes from `sql/base`, then **applies the
migrations in filename (timestamp) order** before deriving the viewer tables. So
future upstream updates flow through automatically — no code change needed. The
applier (`scripts/lib/staging.mjs` + `scripts/lib/mysqlexec.mjs`) is a *targeted*
MySQL→SQLite executor (INSERT/REPLACE/UPDATE/DELETE/DROP for single-table DML; it
re-escapes string literals and skips statements for tables the build doesn't
stage), **not** a general SQL engine. CI sparse-checks out both `sql/base` **and**
`sql/database_updates` (see `deploy.yml`); a missing updates dir falls back to
base-only.

### Custom icons

Turtle adds items whose icons are **not on Blizzard's CDN**; they live only in
the client patch MPQs as BLP textures, and their `display_id → icon` mapping is
in the client `ItemDisplayInfo.dbc`, **absent from the server SQL dump**. CI has
no client, so the extracted icons + the mapping supplement are **committed
source** (the one exception to "don't commit built data" — they can't be
regenerated in CI). `extract-icons.py` runs locally (needs the client +
`StormLib.dll`); `build-atlas.py` repacks the committed icons into the shipped
atlas and needs only the repo. Re-run both when the client updates with new
items, then commit. Set `TW_CLIENT` / `STORMLIB` / `SQL_DIR` to relocate inputs.

## File map

- `scripts/build-db.mjs` — the whole build. **Stages** the raw world tables from
  `sql/base` and **applies the `sql/database_updates` migrations** on top (see
  "World migrations"), then reads from the staged tables to: **resolve effective
  drop chances** into a `drops` table (mangos loot groups + references) and
  **drop the raw loot tables**; build `maps`/`spawns` (location), the `quests`
  table + `quest_item`/`quest_creature_objective`/`quest_reward_rep` links +
  `areas`/`faction_names` lookups, the derived `factions` summary (rep-gated item
  + rep-quest counts per faction), `spell_creates`/`spell_reagent` link tables, an
  `item_display_info` icon map, the `*_fts` search indexes (items/creatures/
  quests), and `version.json`. Staging tables are dropped before the final VACUUM.
- `scripts/lib/staging.mjs` — stages the consumed raw tables (`stg_<table>`),
  bulk-loads base rows, then applies the migrations in timestamp order; exposes
  positional `rows()`/`columns()` accessors the importers read instead of dump text.
- `scripts/lib/mysqlexec.mjs` — the MySQL→SQLite statement splitter + translator
  staging uses (string re-escaping, `INSERT IGNORE`/`ON DUPLICATE` rewrites,
  table retargeting to `stg_*`). Targeted at the migrations' single-table DML.
- `scripts/extract-icons.py` — LOCAL: pulls Turtle custom BLP icons from the
  client MPQs (StormLib) → `assets/icons/custom/*.webp`, plus `scripts/data/
  item-display-supplement.json` (the `display_id → icon` corrective rows build-db
  merges — every item row the server SQL dump is missing or has stale vs the DBC).
- `scripts/build-atlas.py` — packs `assets/icons/custom/*.webp` into the shipped
  sprite sheet `public/icons/custom-atlas.{webp,json}`.
- `scripts/extract-maps.py` — LOCAL: parses the client `WorldMapArea.dbc`, stitches
  the base `Interface\WorldMap\<dir>` BLP tiles AND composites the explored-detail
  `WorldMapOverlay` textures, then crops to the 1002×668 content (drops the black
  tile padding; keeps the authentic burnt frame, like wowhead) → committed
  `public/maps/<areaId>.webp` + `scripts/data/zones.json` (zone bounds + dims; image
  dims MUST equal the world-bound rectangle or Leaflet markers misalign).
  `spawn_points`/`zones` tables are built in CI from these + the SQL dumps (which
  carry spawn coords). NPC pages resolve their open-world zone from spawn coords by
  the largest containing WMA box (boxes overlap at borders; no true coord→area in
  the dumps). Future seamless minimap: `X:\Programming\WoWTools.Minimaps` (.NET).
- `scripts/lib/sqldump.mjs` — zero-dep mysqldump parser.
- `scripts/lib/schema.mjs` — generic import specs (which dump cols → which table).
- `scripts/lib/sqlite.mjs` — Bun/Node SQLite wrapper.
- `src/db.js` — sqlite-wasm init, OPFS cache, versioned download, `query()`.
- `src/queries.js` — all SQL (positional `?1`). Loot reads come from `drops`.
- `src/table.js` — the one reusable table: client-side sort + paginate + group
  (collapsible) used everywhere. `createTable(container, {columns, rows, ...})`.
- `src/browse.js` — filter UI + the item/NPC/quest finder; feeds `createTable`.
- `src/search.js` — unified search: `runSearch()` (shared multi-entity query,
  used by the results page) + `initSearchDropdown()` (live flat top-5 panel).
- `src/zonemap.js` — Leaflet zone map (lazy chunk): `initZoneMap()` draws the
  parchment + per-category circle-marker layers (quest/vendor/repair/trainer/
  flight/inn/bank/mob/object) with a layer-control toggle.
- `src/render.js` — `renderTooltip`, `tabs`, `itemLink`/`npcLink`/`dungeonLink`/
  `questLink`/`factionLink`, `iconImg`, `moneyHtml`, helpers. Factions are linked
  wherever named (quest reward rep, item tooltip reputation requirement).
- `src/hovercard.js` — item + quest tooltip on hover.
- `src/constants.js` — WoW 1.12 enum maps (quality, class/slot/stat, creature
  type/rank, quest type/sort, etc.) + `questZoneLabel`/`classRestrictions`/
  `raceRestrictions` helpers.
- `src/main.js` — routing + the item/NPC/quest/faction/dungeon/search views.

## Conventions

- **All loot/drop chances come from the `drops` table** (`src`: c=creature,
  s=skinning, p=pickpocket, o=object, i=item-container, e=disenchant). It already
  resolves equal-chance groups and reference multipliers, so queries are simple
  joins — do **not** reintroduce recursive loot CTEs.
- Tables: define `columns` as `{ key?, label, cell(row)->html, value?(row),
  num?, cls? }`. `value` is the sort/group key (defaults to cell text). Pass
  `{groupable, group, pageSize, sort, dir, onState}` to `createTable`. Browse
  persists sort/group in the URL via `onState` + `replaceState`.
- Item names render via `itemLink(entry, name, quality, icon)` so they get the
  quality color, lazy icon, and hover tooltip. Icons come from the DB join
  (`item_display_info`), served from `render-us.worldofwarcraft.com/icons/56/` —
  **except** Turtle custom icons, which `render.js` `iconImg` draws as a `<span>`
  sprite from the committed atlas (`main.js` loads `custom-atlas.json` at boot;
  falls back to the CDN `<img>` until then / if absent).
- Every user-facing change should keep `scripts/smoke.mjs` green and add a check
  when it introduces a new view/behavior.

## Gotchas

- **Don't commit built data.** It's regenerated by CI from the server repo. The
  the exceptions are **client-derived** assets CI can't regenerate, so they're
  committed: custom icons (`assets/icons/custom/`, `public/icons/custom-atlas.*`,
  `scripts/data/item-display-supplement.json`) and zone maps (`public/maps/*.webp`,
  `scripts/data/zones.json`). See "Custom icons" / `scripts/extract-maps.py`.
- **Zone assignment is by rectangle**, not exact boundaries — a spawn is "in" a
  zone when its `position_x/y` fall inside that zone's WorldMapArea world-coord
  box (from the client DBC, in `zones`). Overlapping/nested zones can both claim a
  point — fine for the map. Continent (map id) is still the only exact open-world
  locator for an NPC detail page.
- **World-drop reference pools are intentionally excluded** from `drops`
  (`REF_THRESHOLD` in build-db). Items reachable only via those won't list
  individual creatures — by design (they're world drops).
- **Boss = unique spawn** (`spawns.cnt == 1`) within a map.
- **PowerShell is the shell.** Avoid backticks inside `node -e`/`bun -e` one
  liners (they break); write a temp `.mjs` and run it instead. Bash tool is also
  available for POSIX. Native paths like `/x/...` get mangled to `X:\x\...` by
  node — use `X:/...`.
- LF→CRLF warnings on commit are expected on Windows; harmless.

## Deploy

`.github/workflows/deploy.yml` (push to `main`): sparse-checks out the server
repo's `sql/base`, builds the DB with Bun, runs `vite build`, deploys `dist/` to
Pages. Pages base path is `/tortoise-db-viewer/` (`vite.config.js`; override with
`BASE_PATH`).
