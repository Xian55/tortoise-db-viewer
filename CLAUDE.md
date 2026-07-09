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
        │  src/db.js + src/db-worker.js (sqlite-wasm in a Worker, OPFS cache)
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
  file once (gzip is transparent for a full GET). SQLite runs in a **Web Worker**
  (`src/db-worker.js`); `src/db.js` is a thin message client. The worker is
  required for the durable **OPFS** cache: the SAHPool VFS's
  `FileSystemSyncAccessHandle` is **Worker-only** (it's `undefined` on the main
  thread in Chrome), so the old main-thread SAHPool always failed and re-fetched
  the ~58 MB DB every visit. In the worker OPFS persists (no COOP/COEP needed,
  SAHPool not the Atomics VFS); falls back to an in-memory deserialize when OPFS
  is unavailable. Trade-off: query results cross the worker boundary (structured
  clone) — negligible even for the big zone queries.
- **Cache invalidation:** `build-db.mjs` writes `data/version.json` with a
  content hash. `db.js` keys the download URL (`?v=`) and the OPFS filename by
  that hash and wipes old copies, so a new deploy auto-refreshes clients.
- **Routing** is query-param based (SPA, no server rewrites): `?item=`, `?npc=`,
  `?quest=`, `?faction=`, `?zone=`, `?dungeon=`, `?dungeons`,
  `?browse=items|npcs|quests|factions|zones|crafting`, `?search=`, `?compare=a:b:c`
  (item comparison), `?talents=<class>` (talent calculator), `?random`. `route()`
  checks `?browse=` (and `?compare=`) **before** the singular entity params (browse
  URLs carry filter params like `faction=a` that collide otherwise). See `src/main.js`.
  The **dataset** (main vs dev DB) is orthogonal to `route()` — it's chosen from the
  path (`/dev/…`) in `src/config.js`, not a `route()` branch (see "Two datasets").
- **Item browse gear features** (`src/browse.js`): the multi-criteria stat filter
  (`stats=key,op,val|…`, `match=all|any` for AND/OR) and **stat-weight ranking**
  (`weights=key:w|…` + `STAT_WEIGHT_PRESETS`) add a computed, sortable **Score**
  column — both resolve stats through the derived `item_stats` table. Selecting rows
  → **Compare** builds a `?compare=` URL; a localStorage compare tray (main.js
  `renderCompareTray`) collects items across pages.
- **Zone maps use Leaflet + a Pixi GPU overlay** (`L.CRS.Simple`,
  `leaflet-pixi-overlay` + `pixi.js`, all npm, lazy-loaded as one chunk via
  `src/zonemap.js`). A zone page renders the in-game parchment image
  (`public/maps/<areaId>.webp`) and plots spawn markers; world (x,y) → image px
  via the zone's WorldMapArea bounds (`lat=H*(x-locbottom)/(loctop-locbottom)`,
  `lng=W*(locleft-y)/(locleft-locright)`). Markers are **Pixi sprites** in one
  `PIXI.Container` (a tinted disc texture for category dots, atlas/CDN textures
  for focus/object icons) so huge zones (~12k spawns) pan/zoom on the GPU.
  Category toggles are tiny `L.Layer`s flipping `sprite.visible`; hover tooltip +
  click-nav use a throttled nearest-visible-sprite hit-test (no per-marker DOM).
  The previous overlay is `destroy()`ed on re-init to free its WebGL context.
- **Search is unified + FTS-backed.** `?search=` renders a tabbed page across
  items/NPCs/quests/dungeons/zones; the top-bar input also shows a live flat
  top-5 dropdown (`src/search.js`, `runSearch()` + `initSearchDropdown()`). Items,
  creatures, quests, and spells have FTS5 tables (`*_fts`, `unicode61`, prefix);
  dungeons (maps) and zones use LIKE over their small tables. Each searchable
  entity also has a **contentless `trigram` index on its name** (`*_tg`) so search
  matches **substrings/infix** ("fang" -> "Shadowfang"); the query OR-matches the
  prefix index (covers <3-char + ranking) and the trigram index. `search.js` builds
  both MATCH strings (`ftsQuery` prefix, `trigramQuery` quoted ≥3-char substrings
  AND-combined, with a no-match sentinel for short terms). The trigram indexes add
  ~2 MB to the brotli download — worth it for items/creatures (the bulk; trimming
  spells/quests saves only ~0.6 MB).
- **DB build runs `ANALYZE`** (sqlite_stat1) before the final VACUUM so the planner
  has stats for the heavy joins. The DB-worker opens read-only with tuned pragmas
  (`cache_size=-32768` 32 MB, `temp_store=MEMORY`, `query_only=ON`). `page_size`
  stays 4096 — measured optimal for the brotli download (8k/16k/32k compress worse).

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
python scripts/extract-icons.py       # LOCAL: client MPQ -> assets/icons/custom/*.webp + supplement
python scripts/extract-spell-icons.py # LOCAL: client SpellIcon.dbc -> scripts/data/spell-icon-map.json (+ custom spell icons)
python scripts/build-atlas.py         # assets/icons/custom/*.webp -> public/icons/custom-atlas.{webp,json}
python scripts/extract-maps.py        # LOCAL: client -> public/maps/*.webp + scripts/data/zones.json
python scripts/extract-area-bounds.py # LOCAL: client ADTs -> scripts/data/subzone-bounds.json (exact coord->area)
python scripts/extract-item-sets.py   # LOCAL: client ItemSet.dbc -> scripts/data/item-sets.json (set names + bonuses)
python scripts/extract-skill-lines.py # LOCAL: client SkillLine.dbc -> scripts/data/skill-lines.json (skill categories)
python scripts/extract-locks.py       # LOCAL: client Lock.dbc -> scripts/data/locks.json (lockId -> mining/herbalism; splits gather nodes)
python scripts/extract-minimap.py     # LOCAL: client minimap BLPs -> public/minimap/<map>/{z}/{x}/{y}.webp tile pyramid + scripts/data/minimap.json
python scripts/extract-talents.py     # LOCAL: client Talent.dbc + TalentTab.dbc -> scripts/data/talents.json (talent-tree structure)
python scripts/extract-random-suffix.py # LOCAL: client ItemRandomProperties.dbc + SpellItemEnchantment.dbc -> scripts/data/random-suffix.json (random suffix id -> "of the Bear" name + stats; VERIFY offsets)
python scripts/extract-class-icons.py # LOCAL: crops the client class-emblem sheet -> public/icons/class/<slug>.webp (talent class picker)
bun scripts/extract-instance-bosses.mjs # LOCAL: server ScriptDev2 src (../tortoise-wow/src) + built DB -> scripts/data/instance-bosses.json (script-spawned boss entry -> instance mapId; needs build-db first)
bun scripts/build-tooltips.mjs        # compact per-entity JSON for the embeddable tooltip widget -> dist/tt/<prefix>/<id>.json (run AFTER vite build)
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

**Run order: `build-db` BEFORE `extract-icons`.** Item display_ids shift with the
world migrations, so `extract-icons.py` reads the migrated display_ids from the
built `public/data/tortoise.sqlite` (falls back to `sql/base` with a warning if
absent) — otherwise migration-added items' icons are never extracted. It also
recovers icons present in the client but absent from a patch MPQ's listfile via a
direct `SFileHasFile` probe (plain enumeration misses them). Full local refresh:
`build-db` → `extract-icons` → `extract-spell-icons` → `build-atlas` → `build-db`
(to merge the updated supplement + spell-icon map).

**Spell icons** work the same way but the mapping source is the client
`SpellIcon.dbc` (the server `spell_template` dump stores only a numeric
`spellIconId`). `extract-spell-icons.py` reads the used `spellIconId`s from the
built DB, resolves each to its texture basename, and writes
`scripts/data/spell-icon-map.json` (`spellIconId → basename`, committed). Spells
share the `Interface\Icons` pool with items, so standard basenames load straight
from the CDN; only Turtle-custom spell icons (not on the CDN) are extracted into
the shared `assets/icons/custom/` atlas pool. `build-db.mjs` joins the map onto
`spells.icon`; absent map ⇒ text/CDN-fallback spell links (graceful).

### Seamless world map (?worldmap=)

A continuous, zoomable continent minimap (Eastern Kingdoms map 0, Kalimdor map 1)
— wowhead/gamermaps-style — alongside the per-zone parchments. `extract-minimap.py`
(LOCAL) stitches the client's per-ADT-block minimap BLPs (md5-renamed; resolved via
`textures\Minimap\md5translate.trs`) into a Leaflet XYZ tile **pyramid**
(`public/minimap/<mapId>/{z}/{x}/{y}.webp`, z0..6, 256px, y-down) and writes the
tiny transform manifest `scripts/data/minimap.json`. The ADT grid is regular, so
world→pixel is **linear + uniform** (no per-zone WorldMapArea bounds):
`gpx = tile*(32 - worldY/adt)`, `gpy = tile*(32 - worldX/adt)` (tile=256,
adt=1600/3); one CRS unit = native px / 2^maxNativeZoom. `src/zonemap.js`
`initWorldMap()` draws the pyramid (CRS.Simple, y-down `Transformation(1,0,1,0)`)
and reprojects every spawn with that formula, reusing the zone map's Pixi dot
overlay + category toggles. `src/main.js` `showWorldMap()` (route `?worldmap=<map>`)
loads the bundled manifest, queries `Q_WORLD_SPAWNS`/`Q_WORLD_OBJECTS` (generous
LIMITs — a continent has ~67k spawns; categories default OFF so the cost is paid
only on toggle), and serves tiles from `${ASSETS_BASE}minimap/`.

Only overworld continents WITH spawns ship (the `SHIP` map in the script): Outland
/ Kalidar exist as client art but have no spawns → excluded. Scope = maps 0,1.

**The tile pyramid IS committed** (`public/minimap/`, ~2400 webp) — like
`public/maps`, because CI can't regenerate it (no client), and the deploy workflow
**syncs it to R2** (`aws s3 sync`, see "Deploy") alongside the other assets. The
committed `scripts/data/minimap.json` (bundled by Vite) carries the transform.
Re-run `extract-minimap.py` + commit on client map changes.

## File map

- `scripts/build-db.mjs` — the whole build. **Stages** the raw world tables from
  `sql/base` and **applies the `sql/database_updates` migrations** on top (see
  "World migrations"), then reads from the staged tables to: **resolve effective
  drop chances** into a `drops` table (mangos loot groups + references) and
  **drop the raw loot tables**; build `maps`/`spawns` (location), the `quests`
  table + `quest_item`/`quest_creature_objective`/`quest_reward_rep` links +
  `areas`/`faction_names` lookups, the `creature_rep` table (rep-per-kill, flattened
  from `creature_onkill_reputation` — powers the faction rep-grind calculator), the
  derived `factions` summary (rep-gated item + rep-quest + rep-mob counts per
  faction), `spell_creates`/`spell_reagent` link tables, the
  `spells` table (incl. `icon` from `spell-icon-map.json`, `skill` profession, and
  detailed combat columns resolved via `spell-lookups.json`), the spell teach
  sources (`spell_trainer` NPCs + `spell_taught_item` books, plus `spells.learnable`),
  an `item_display_info` icon map, the `*_fts` search indexes (items/creatures/
  quests/spells), and `version.json`. Staging tables are dropped before the final VACUUM.
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
- `scripts/extract-spell-icons.py` — LOCAL: reads the used `spellIconId`s from the
  built DB, resolves each via the client `SpellIcon.dbc` → `scripts/data/
  spell-icon-map.json` (`spellIconId → icon basename`, committed; build-db joins it
  onto `spells.icon`), and extracts any Turtle-custom spell icons (not on the CDN)
  into the shared `assets/icons/custom/` pool. Also dumps the four index→value
  lookup DBCs (`SpellCastTimes/SpellRange/SpellDuration/SpellRadius`) → committed
  `scripts/data/spell-lookups.json`, which build-db uses to resolve the detailed
  spell page's cast time / range / duration / radius.
- `scripts/build-atlas.py` — packs `assets/icons/custom/*.webp` into the shipped
  sprite sheet `public/icons/custom-atlas.{webp,json}`.
- `scripts/extract-maps.py` — LOCAL: parses the client `WorldMapArea.dbc`, stitches
  the base `Interface\WorldMap\<dir>` BLP tiles AND composites the explored-detail
  `WorldMapOverlay` textures, then crops to the 1002×668 content (drops the black
  tile padding; keeps the authentic burnt frame, like wowhead) → committed
  `public/maps/<areaId>.webp` + `scripts/data/zones.json` (zone bounds + dims; image
  dims MUST equal the world-bound rectangle or Leaflet markers misalign).
  `spawn_points`/`zones` tables are built in CI from these + the SQL dumps (which
  carry spawn coords). Each spawn's zone is the ADT-exact `spawn_points.zone` (see
  `extract-area-bounds.py` + the "Zone assignment" gotcha), not the loose WMA box.
  Several WMAs share one areaId — an instance interior (mapId = the instance) plus a
  continent "entrance" mini-map; the parchment output is areaId-keyed, so extract-maps
  **prefers the instance interior** (e.g. Dire Maul 2557 → the `DireMaul` interior on
  map 429, not `DireMaulEntrance`). The map-less instances (no WorldMap at all) fall
  back to a tab-only page.
- `scripts/extract-area-bounds.py` — LOCAL: reads the client ADTs (per `Map.dbc`
  continent dir; MCNK terrain chunks carry the real AreaTable id) and accumulates the
  world-coord bounding box per area → committed `scripts/data/subzone-bounds.json`
  (`{mapId: [{i:areaId, x0,x1,y0,y1}]}`). build-db assigns each spawn the smallest
  box containing it, walked up `area_template.zone_id` to the render zone — exact
  coord→zone the SQL dumps lack. Re-run on client updates.
- `scripts/extract-minimap.py` — LOCAL: stitches the client's per-ADT-block minimap
  BLPs into the seamless-world-map tile pyramid `public/minimap/<mapId>/{z}/{x}/{y}.webp`
  (committed — CI can't rebuild it; synced to R2 by deploy.yml) + the committed
  transform manifest `scripts/data/minimap.json`. See "Seamless world map (?worldmap=)".
  Per-map runs MERGE the manifest. Standalone reference C# tooling:
  `X:\Programming\WoWTools.Minimaps` (not used by the build).
- `scripts/extract-talents.py` — LOCAL: reads the client `Talent.dbc` +
  `TalentTab.dbc` → committed `scripts/data/talents.json` (talent-tree STRUCTURE:
  per class → tab → talent row/col/rank-spell-ids/prereq). Names/icons/tooltips are
  NOT stored — `src/talents.js` resolves them from the rank spell ids against the
  shipped `spells` table. CI has no client, so the JSON is committed source (real
  all-class data, 9 classes / 476 talents, extracted from the Turtle client). DBC
  offsets are verified in the script header; re-run + commit on client changes. See
  the talent calculator route `?talents=<class>`.
- `scripts/build-tooltips.mjs` — dumps compact per-entity JSON
  (`dist/tt/<prefix>/<id>.json`, prefixes i/n/q/s) for the embeddable powered-tooltip
  widget `public/embed/tw-power.js`. Content-hashed like the OG stubs (HASH_ONLY=1);
  run AFTER `vite build` (it writes into `dist`, which vite wipes). deploy.yml
  regenerates + merges it (cache-gated). `public/embed/demo.html` is a demo/test page.
- `scripts/extract-instance-bosses.mjs` — LOCAL: reads the server ScriptDev2 C++
  (`../tortoise-wow/src/scripts/dungeons/<instance>/`) + the built DB → committed
  `scripts/data/instance-bosses.json` (`[{e:creatureEntry, m:mapId}]`). Instance bosses
  placed by C++ scripts have NO static `creature` spawn, so the SQL dump can't locate
  them; this parses each folder's creature/GO enums, grounds the folder→mapId from the
  built DB (gameobjects are placed inside the instance), and maps every spawn-less
  creature there to that map. build-db loads it into `creature_instance`; the character
  upgrade finder (`qInstanceDropsIn`) uses it to name e.g. "Razorfen Downs · Tuten'kash".
  CI has no server `src/`, so the JSON is committed. Run: build-db → this → build-db.
- `scripts/lib/sqldump.mjs` — zero-dep mysqldump parser.
- `scripts/lib/schema.mjs` — generic import specs (which dump cols → which table).
- `scripts/lib/sqlite.mjs` — Bun/Node SQLite wrapper.
- `src/db.js` — thin client to the DB worker (`query()`/`queryOne()` post
  messages; resolves by id). `src/db-worker.js` — owns sqlite-wasm, installs the
  OPFS SAHPool VFS (Worker-only API), imports/opens the versioned DB, runs exec.
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
- `src/talents.js` — talent calculator (`?talents=<class>`): renders the trees from
  `scripts/data/talents.json`, resolves names/icons/tooltips from rank spell ids,
  enforces the 51-point / 5-per-row / prereq rules, persists the build in the URL.
- `src/main.js` — routing + the item/NPC/quest/faction/dungeon/search views, the
  `?compare=` item-comparison view, the `?random` roll, and the compare tray.

## Conventions

- **All loot/drop chances come from the `drops` table** (`src`: c=creature,
  s=skinning, p=pickpocket, o=object, i=item-container, e=disenchant). It already
  resolves equal-chance groups and reference multipliers, so queries are simple
  joins — do **not** reintroduce recursive loot CTEs.
- Tables: define `columns` as `{ key?, label, cell(row)->html, value?(row),
  num?, cls?, group?(row) }`. `value` is the sort/group key (defaults to cell
  text); `group(row)` renders the group-header label when grouped by that column
  (defaults to the cell) — use it when the cell shows a member but the group key
  is a category (e.g. crafting Source groups by "Recipe"/"Trainer"/"Auto", not by
  each recipe's name). Pass `{groupable, group, pageSize, sort, dir, onState}` to
  `createTable`. Browse persists sort/group in the URL via `onState` +
  `replaceState`.
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
  `scripts/data/item-display-supplement.json`, `scripts/data/spell-icon-map.json`,
  `scripts/data/spell-lookups.json`), zone maps (`public/maps/*.webp`,
  `scripts/data/zones.json`), per-area ADT bounds (`scripts/data/subzone-bounds.json`
  via `extract-area-bounds.py`, for exact coord→zone), and the "minimap" POI sprite
  sheet `public/icons/poi-atlas.webp` (16-col, 32px grid; sourced from the
  WowClassicGrindBot atlas). `Elite` at [11,14] is the boss-marker skull; the zone +
  world map markers and the layer-control legend draw their per-category icons from
  it via the `CAT_ICON`/`OBJ_ICON` cell map in `src/zonemap.js` (cells verified
  against the art -- the upstream `icon_atlas.js` names are unreliable). Plus
  item-set names + bonus spells (`scripts/data/item-sets.json` via
  `extract-item-sets.py`, from the client `ItemSet.dbc`; set members derive from
  `items.set_id` in the SQL dump), and skill-line categories
  (`scripts/data/skill-lines.json` via `extract-skill-lines.py`, from the client
  `SkillLine.dbc`; build-db joins these onto `skill_line_ability` to set
  `spells.category` for the browse filter), gather-node skills
  (`scripts/data/locks.json` via `extract-locks.py`, from the client `Lock.dbc`;
  maps a gameobject's `data0` lockId -> `mining`/`herbalism` so build-db sets
  `gameobjects.gather`, splitting veins/herbs out of the map's `Obj: Chest` bucket),
  and the seamless-world-map transform
  manifest (`scripts/data/minimap.json` via `extract-minimap.py`) + the world-map
  **tile pyramid** itself (`public/minimap/`, ~2400 webp — committed like
  `public/maps`; CI can't rebuild it, deploy.yml syncs it to R2). Plus talent-tree
  structure (`scripts/data/talents.json` via `extract-talents.py`, from the client
  `Talent.dbc`/`TalentTab.dbc`; real all-class Turtle trees, re-run on client
  changes) + random-suffix stats (`scripts/data/random-suffix.json` via
  `extract-random-suffix.py`, from the client `ItemRandomProperties.dbc` +
  `SpellItemEnchantment.dbc`; maps a rolled `suffixId` -> "of the Bear" name + stats.
  build-db loads it into `random_suffix` and joins the SQL-dump
  `item_enchantment_template` into `suffix_pool` + `items.rolls_suffix` so the item
  page lists the pool and the character sheet resolves a rolled suffix) + the
  class-picker emblems (`public/icons/class/<slug>.webp` via
  `extract-class-icons.py`, cropped from the client character-create sheet; served
  from `${ASSETS_BASE}icons/class/`, synced to R2 by deploy.yml's `public/icons`
  sync). See "Custom
  icons" / `scripts/extract-maps.py` / "Seamless world map". Plus scripted-transform
  spawn links (`scripts/data/scripted-spawn-links.json`): creatures with no static
  `creature` row that a server **C++** script swaps in at another NPC's location (the
  transform is in `../tortoise-wow/src/scripts/world/*.cpp`, not ingestible SQL — e.g.
  the "Stave of the Ancients" demons transform in place from a friendly NPC). Maps the
  spawn-less entry -> the entry whose `spawns`/`spawn_points` it inherits, so build-db
  can still map it. Committed (CI has no server `src/`); hand-maintained from the
  scriptdev enums — extend when new transforms are found. Plus script-spawned instance
  bosses (`scripts/data/instance-bosses.json` via `extract-instance-bosses.mjs`): a
  boss placed by a C++ instance script has no static `creature` spawn, so the SQL can't
  tell which dungeon it's in. The extract parses each `src/scripts/dungeons/<instance>/`
  folder → `creature_instance(entry, map)`, letting the character upgrade finder name
  the instance for such a boss (e.g. Tuten'kash → Razorfen Downs). Committed (CI has no
  server `src/`); re-run on scriptdev changes.
- **Zone assignment is ADT-exact.** Each spawn's `spawn_points.zone` is precomputed
  in build-db from `scripts/data/subzone-bounds.json` (per-AreaTable bounding boxes
  extracted from the client ADT terrain chunks by `extract-area-bounds.py`): the
  smallest box containing the point is its real sub-area, walked up the
  `area_template.zone_id` hierarchy to the render zone. This replaced the old loose
  WorldMapArea-rectangle test, which overlapped badly (Jory Zaga → Moonglade instead
  of Darkshore, Taerar → Azshara instead of Ashenvale, oversized custom-zone boxes
  swallowing real zones). Zone pages, the NPC-page map/label, and all location
  columns read this one field. Fallback to the smallest WMA box only where ADTs give
  no area (~0.4% of spawns); `subzone-bounds.json` absent ⇒ WMA-box behaviour.
- **World-drop reference pools are intentionally excluded** from `drops`
  (`REF_THRESHOLD` in build-db). Items reachable only via those won't list
  individual creatures — by design (they're world drops).
- **`items.world_drop`** (build-db, set when an item drops from ≥25 distinct
  creature loot tables — ubiquitous greens/gems/cloth) flags world drops so the
  **zone Items tab excludes them** (`Q_ZONE_LOOT`); they aren't characteristic of
  any zone. Item/NPC pages still show them normally.
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
`BASE_PATH`). Heavy assets (DB, zone maps, icon atlas) are pushed to Cloudflare R2
(`aws s3 sync`, S3 API) and served from `VITE_ASSETS_BASE` to spare Pages bandwidth.

**World-map tiles sync via CI** like the zone maps: they're committed
(`public/minimap/`, CI can't rebuild them — no client), and the "Upload assets to
Cloudflare R2" step `aws s3 sync`s them to `s3://tortoise-db-viewer/minimap`. The
frontend reads `${VITE_ASSETS_BASE}minimap/<map>/{z}/{x}/{y}.webp`; the committed
`scripts/data/minimap.json` (bundled by Vite) supplies the transform. Re-run
`extract-minimap.py` + commit on client map changes; the next deploy pushes them.

### Two datasets: `main` + `dev` (server `1181dev` branch)

The site serves **two** copies of the DB and lets the visitor toggle the source
(`Main | Dev` pill in the top bar):

- **main** — built from the server repo's default branch, at `/` (R2 prefix
  `data/`). Unchanged behaviour.
- **dev** — built from the `1181dev` feature branch, served at the **`/dev/`**
  path (R2 prefix `data-dev/`). Refreshed **hourly** when `1181dev` gets a commit.

**Only the DB + `version.json` differ per dataset** — maps/icons/minimap/tt/OG are
branch-independent and shared (owned by the main deploy). Mechanics:

- **Build:** `build-db.mjs` takes `DATA_SUBDIR` (default `data`); the dev build
  runs `SQL_DIR=…/1181dev/sql/base DATA_SUBDIR=data-dev`.
- **Frontend dataset pick** (`src/config.js`): `DATASET` is `dev` when the path is
  under `<base>/dev/` (or `?db=dev`, the local-dev override — the vite dev server
  has no `/dev/` file); it selects `VITE_DATA_BASE_DEV` vs `VITE_DATA_BASE`. Dev is
  **R2-only** (no Pages mirror — a mirror flip would silently serve *main's* DB).
- **Path-based, sticky-by-relative-link:** query routing means the only path we
  must serve is `dev/index.html` (a build-time copy of the app shell — deploy.yml
  "Emit /dev app shell"). Internal links are relative (`href="?item=…"`) and
  `navigate()` feeds that to `pushState`, so every click under `/dev/` stays under
  `/dev/`. No per-link threading, no localStorage.
- **OPFS cache** (`src/db-worker.js`) is keyed `/tortoise-<dataset>-<version>.sqlite`
  so both datasets persist side-by-side (switching is download-free) without
  evicting each other.
- **CI:** `deploy-dev.yml` (manual/`workflow_dispatch`) builds ONLY the dev DB and
  `aws s3 cp`s it to `data-dev/` on R2 — no Pages redeploy (a new content hash
  auto-invalidates clients). `watch-dev.yml` polls `1181dev` **hourly** (distinct
  cache key from `watch-upstream.yml`) and dispatches `deploy-dev.yml` on a new SHA.
- **Rollout:** enabling the toggle needs one normal `main` deploy first (ships the
  frontend + `VITE_DATA_BASE_DEV` + `/dev/index.html`), then one `deploy-dev` run
  (populates `data-dev/`). After that, dev refreshes are pure R2 uploads.
