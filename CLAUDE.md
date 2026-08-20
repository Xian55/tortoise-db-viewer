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
  `?quest=`, `?faction=`, `?zone=`, `?subzone=`, `?dungeon=`, `?dungeons`,
  `?browse=items|npcs|quests|factions|zones|subzones|crafting`, `?search=`, `?compare=a:b:c`
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
  `renderCompareTray`) collects items across pages. The selection bar itself is
  `src/selbar.js`, shared with the search results' Items tab.
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
  items/NPCs/quests/dungeons/zones/subzones; the top-bar input also shows a live flat
  top-5 dropdown (`src/search.js`, `runSearch()` + `initSearchDropdown()`). Items,
  creatures, quests, and spells have FTS5 tables (`*_fts`, `unicode61`, prefix);
  dungeons (maps), zones and subzones use LIKE over their small tables. The Items tab
  carries the full `src/selbar.js` selection ops (same as `?browse=items`), and the
  Spells tab shows `spells.rank` — the client's subtext, which is usually "Rank N" but
  also "Passive" / "Toy" / "Game Master", so the column sorts on the parsed number and
  files the non-numeric labels last. Each searchable
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
bun run assets                  # pull the R2-hosted binary assets (maps/minimap/model-thumbs, ~109 MB) into public/. Needed only for a LOCAL run that should render maps -- the deployed site always loads them from R2. `-- --only maps` for one set, `-- --verify` to re-hash, `-- --all` to include the OPTIONAL sets (the 1.86 GB of extracted audio, excluded by default). See "Binary assets live on R2"
bun scripts/publish-assets.mjs  # LOCAL: the reverse -- rescan public/ after an extract-*.py, rewrite scripts/data/assets-manifest.json, upload changed files to R2
bun scripts/build-db.mjs        # build public/data/tortoise.sqlite (+ version.json)
bun run dev                     # http://localhost:5173/tortoise-db-viewer/
bunx --bun vite build           # production build to dist/
bun run smoke                   # headless end-to-end, PARALLEL (bun test; needs Chrome). Shards topic modules across processes, each its own persistent Chrome profile (OPFS DB downloaded once, not per run). See scripts/smoke/tests/CLAUDE.md. `-- item quest` filters modules; `bun run smoke:test -t "name"` runs one test; SMOKE_BASE points it at a running server
bun scripts/bench-queries.mjs   # LOCAL dev tool: times every Q_* vs the built DB (worst-case hot params) + flags bad plans (SCAN/TEMP-BTREE/AUTO-INDEX) for indexing fruit. --plans / --top N. Not CI-wired

# Custom icons (Python + Pillow + StormLib; see "Custom icons" below)
python scripts/extract-icons.py       # LOCAL: client MPQ -> assets/icons/custom/*.webp + supplement
python scripts/extract-spell-icons.py # LOCAL: client SpellIcon.dbc -> scripts/data/spell-icon-map.json (+ custom spell icons)
python scripts/build-atlas.py         # assets/icons/custom/*.webp -> public/icons/custom-atlas.{webp,json}
python scripts/extract-maps.py        # LOCAL: client -> public/maps/*.webp + scripts/data/zones.json
python scripts/extract-area-bounds.py # LOCAL: client ADTs -> scripts/data/subzone-bounds.json (exact coord->area; also the `subzones` table). CLIENT_PROFILE=tbc + TW_CLIENT + AREA_BOUNDS_OUT=scripts/data/subzone-bounds-tbc.json for the TBC client (the ONLY source of Outland bounds)
python scripts/extract-wmo-areas.py   # LOCAL: client ADT WMO placements + WMOAreaTable.dbc -> scripts/data/wmo-areas.json (what the game calls the INSIDE of a cave/building, which the terrain over it does not know). CLIENT_PROFILE=tbc + TW_CLIENT + WMO_AREAS_OUT=scripts/data/wmo-areas-tbc.json for the TBC client
python scripts/extract-item-sets.py   # LOCAL: client ItemSet.dbc -> scripts/data/item-sets.json (set names + bonuses + ItemID_* membership; build-db corrects items.set_id to it)
python scripts/extract-skill-lines.py # LOCAL: client SkillLine.dbc -> scripts/data/skill-lines.json (skill categories)
python scripts/extract-creature-families.py # LOCAL: client CreatureFamily.dbc -> scripts/data/creature-families.json (pet family id -> name + diet/PetFoodMask + ability skill line + icon; powers the Hunter Pets section)
python scripts/extract-locks.py       # LOCAL: client Lock.dbc -> scripts/data/locks.json (lockId -> mining/herbalism; splits gather nodes)
python scripts/extract-minimap.py     # LOCAL: client minimap BLPs -> public/minimap/<map>/{z}/{x}/{y}.webp tile pyramid + scripts/data/minimap.json
python scripts/extract-talents.py     # LOCAL: client Talent.dbc + TalentTab.dbc -> scripts/data/talents.json (talent-tree structure)
python scripts/extract-random-suffix.py # LOCAL: client ItemRandomProperties.dbc + SpellItemEnchantment.dbc -> scripts/data/random-suffix.json (random suffix id -> "of the Bear" name + stats; VERIFY offsets)
python scripts/extract-class-icons.py # LOCAL: crops the client class-emblem sheet -> public/icons/class/<slug>.webp (talent class picker)
python scripts/transcribe-sounds.py   # LOCAL+GPU: Whisper over public/sounds -> scripts/data/voice-transcripts-auto.json (machine transcripts for the ~1.6k clips no text table records). `--model`/`--compute`/`--only`/`--limit`. Needs faster-whisper. See "Transcribing the clips nothing writes down"
bun scripts/extract-script-sounds.mjs # LOCAL: server ScriptDev2 src + the SQL dumps -> scripts/data/script-sounds.json (script_name -> the script_texts entries it speaks + sounds it plays, plus the sound-id worklist extract-sounds.py needs). Run BEFORE extract-sounds.py
python scripts/extract-sounds.py      # LOCAL: client MPQ audio -> public/sounds/**.ogg (Opus, R2-only) + scripts/data/sound-map.json (committed mapping). `--only creature,npc,zone,va,cdir,text`, `--limit N`, `--jobs N`, `--dry-run`. Needs ffmpeg. See "Sounds"
bun scripts/extract-script-abilities.mjs # LOCAL: server ScriptDev2 src (../tortoise-wow/src/scripts) -> scripts/data/script-abilities.json (creature_template.script_name -> the spell ids that C++ fight hardcodes; gives Ragnaros/Nefarian/Onyxia an ability list they have no SQL rows for)
bun scripts/extract-instance-bosses.mjs # LOCAL: server ScriptDev2 src (../tortoise-wow/src) + built DB -> scripts/data/instance-bosses.json (script-spawned boss entry -> instance mapId; needs build-db first)
bun scripts/extract-vanilla-ids.mjs   # LOCAL: cmangos Classic SQLite DB (classicmangos.sqlite) -> scripts/data/vanilla-ids.json (vanilla-1.12 id allowlist + `edited` field-diff set; build-db flags items/creatures/quests custom = id NOT IN vanilla OR IN edited). Also field-diffs the built Turtle DB vs cmangos (run build-db first). CMANGOS_DB / TW_DB override paths
python scripts/extract-cmangos-dbc.py # LOCAL: vanilla 1.12 client DBCs -> scripts/data/cmangos-dbc.json (areas/maps/faction/faction_template/item_display_info/skill_line_ability; fills the DBC tables cmangos's world DB omits, for the SQL_SOURCE=cmangos build). CLIENT overrides path
SQL_SOURCE=cmangos DATA_SUBDIR=data-vanilla-cmangos bun scripts/build-db.mjs # build the vanilla/cmangos dataset from cmangos's SQLite DB (+ cmangos-dbc.json) instead of Turtle dumps
bun scripts/probe-wowhead-thumbs.mjs  # LOCAL: classify every creature display_id by whether Wowhead's Classic webthumb exists -> scripts/data/model-thumb-missing.json (the 404 set = Turtle-custom models to render ourselves). Needs built DB. --fresh ignores the cache
python scripts/render-model-thumbs.py # LOCAL: render the missing-worklist creature models (client MPQ -> M2 v256 parse -> headless-GL) -> public/model-thumbs/<displayId>.webp (300x300 transparent) + manifest.json. Skips CHARACTER models (need char-texture compositing). --only ID / --size N / --characters / --force. Needs moderngl+numpy+Pillow+StormLib+GPU
python scripts/extract-item-appearance.py # LOCAL: client ItemDisplayInfo.dbc + the built DB -> scripts/data/item-appearance.json (display_id -> model/texture/geosets/component textures; powers the 3D tab). --probe prints the field-layout evidence and writes nothing. Run build-db FIRST
python scripts/export-models.py       # LOCAL: client M2 v256 -> public/model3d/**.m2b + .webp textures (R2-only) for the in-browser viewer. --only NAME / --limit N / --force
bun scripts/build-tooltips.mjs        # compact per-entity JSON for the embeddable tooltip widget -> dist/tt/<prefix>/<id>.json (run AFTER vite build)
bun scripts/build-api.mjs             # public JSON API: rich per-entity JSON + tooltipHtml -> dist/api/<i|n|q|s>/<id>.json (served from R2 at api.tortoiseclothing.org); API_LIMIT=N for a fast subset
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

- **The layout is walked recursively, and that is not cosmetic.** Upstream moved the
  migrations out of a flat `database_updates/*.sql` into `world/` + `character/`
  subdirectories, at which point a non-recursive `readdir` matched **nothing**: 117
  migrations dropped, the build reported success, and main's deploy went red on content
  tests (Balor empty, "Thorn Gorge" un-renamed, a quest and a pet family gone). Both
  layouts are accepted; `character/` is skipped (it targets the character DB, which this
  build never stages); ordering is by **filename**, since the timestamp prefix is the
  server's own apply order and is global across directories. An updates dir that yields
  zero `.sql` files now **warns loudly** — that state is never legitimate.
- **DDL is read even though it is not executed.** The executor skips `ALTER TABLE`, so a
  migration that adds a column and then UPDATEs it would lose every one of those writes
  (`spell_template.script_name`: 377 failures). The pre-scan that ALTERs staged tables to
  match INSERT column lists also parses `ALTER TABLE … ADD [COLUMN]`, skipping
  index/key/constraint clauses. Migration errors should sit at **0**; a non-zero count in
  the build log means the executor met something new.

### Peer baselines ("vs. typical …")

A raw stat means nothing alone, so a stat is shown next to the **median of a
comparable cohort** plus its rank in it. Two cohorts exist; `src/context.js` renders
both (ratio bar + the outlier headline).

- **NPCs** — cohort = every non-hidden creature of the same `level_max` + `rank`,
  computed at runtime (`Q_NPC_PEERS`, index `idx_creatures_peer`). Params `?3..?6`
  pass the creature's own health/armor/DPS/AP back in so the query also returns its
  competition rank, which drives the headline ("More melee DPS than 98% of level 54
  mobs — ×3.0 the median", NPC 9176).
- **Items** — cohort = same class/subclass/slot/quality/ilvl band. No index can group
  that at runtime, so `scripts/lib/itempeers.mjs` precomputes it into `item_peer`
  (one row per gear item: its armor/DPS/base-stats + rank) and `item_peer_cohort`
  (label, member counts, medians); the page does one PK lookup (`Q_ITEM_PEERS`).
  The key **coarsens** through `COHORT_LEVELS` until a cohort clears `PEER_MIN` (10) —
  widening the ilvl band first and giving up quality last, since "vs. typical Epic
  ilvl 60–79 Dagger" beats a band that mixes greens in. ~99% of gear lands on the top
  two levels. A cohort's members are ALL items sharing its key (not just the ones that
  fell through to it), dev artifacts (`item_sources` `unobtainable`) and hidden rows
  excluded. Weapon DPS sums **both** damage lines, matching the tooltip's own
  "(53.9 damage per second)". "Base stats" = the five 1.12 primaries only —
  deliberately not a score (that's the browse stat-weight ranking's job).

- **Zones** — the profile strip above the map (`zoneStatsCard`): spawn/NPC/quest/
  gather counts, the p10–p90 **level spread** (spawn-weighted, so it reads as "what
  you meet here"; min–max would let one stray level-60 rare make a starting zone say
  "1–60"), elite share, rares/world bosses — plus the continent rank ("13th busiest ·
  3rd by quest count of 30 Kalimdor zones"), which a page that loads only its own zone
  can't know. Derived into `zone_stats` (`Q_ZONE_STATS`, one PK lookup). Ranks are per
  `mapid` over zones that have spawns. Only the **high** side gets a headline (a small
  zone being small is not trivia), and a zone with no spawns of its own gets no card:
  a city's NPCs are attributed to its parent zone (Ironforge → Dun Morogh) and an
  instance-entrance WorldMap area holds only quests, so both would otherwise be ranked
  against real zones on a quest count alone. Instance pages skip the strip entirely.

Medians, never means, on both sides: a few outliers (a raid boss's `dmg_multiplier`,
one absurd test weapon) drag a mean far off the thing players compare against.

### Subzones (`?subzone=`)

Sub-areas of a zone — Elwynn Forest → Goldshire / Northshire Valley / Fargodeep Mine.
The hierarchy always shipped (`areas.zone_id`), and `build-db`'s `homeZone()` always
computed each spawn's exact leaf area — it just **threw the leaf away** and returned
only the walked-up render zone. Keeping it (`spawn_points.sub`) is what the whole
feature rests on.

- **`sub` is set only on the clean ADT path.** The cross-map guard (an instance ADT
  tagged with a continent area id), the multi-floor reject and the WMA-box fallback
  all store `NULL` — a rejected leaf is actively wrong, and would file Hateforge
  Quarry's bosses under a Redridge sub-area. 152k of 164k spawns (93%) get one.
- **Invariant every subzone read depends on:** when `sub` is non-null,
  `zone == renderZone(sub)` *and* the point is inside that zone's own WMA box. So all
  subzone queries are **zone-scoped** (`WHERE s.zone = ?2 AND s.sub = ?1`) and ride
  the existing `idx_spawn_zone`. **There is deliberately no `idx_spawn_sub`**: it
  would cost ~2.5 MB on the cold whole-DB download and buy nothing (measured
  `Q_SUBZONE_SPAWNS` 0.95 ms, `Q_SUBZONE_LOOT` 0.94 ms vs `Q_ZONE_LOOT`'s 16 ms).
  Nothing needs "all spawns of subzone X regardless of zone".
- **`subzones`** (derived, ~1057 rows / 67 zones) carries name, the **render** zone
  (not raw `areas.zone_id` — that's the parchment the page draws, and it collapses the
  few areas whose parent is itself a sub-area), the ADT bbox, and precomputed
  spawn/npc/object/quest counts, so search, browse, the zone tab and the map dropdown
  never scan `spawn_points`. Rows with no content and the client's `*UNUSED*` leftovers
  are dropped. `quests` counts come straight off `quests.zone`, which was **already** a
  leaf area id.
- **Names repeat** ("The Great Sea" ×2 with spawns, "Southfury River", …), so every
  subzone reference — search rows, browse, the page header — carries its parent zone.
- **UI**: `?subzone=` mirrors the zone page (NPCs / Farming / Quests / Items / Objects)
  drawing the **parent's** parchment with only this area's spawns, fit to and outlined
  by the bbox (`initZoneMap` `opts.bounds`). The zone page gains a Subzones tab
  (appended last, so the default pane stays NPCs) and a map dropdown that filters the
  Pixi dots **in place** via a `DotLayer` visibility predicate — re-initing the map per
  change would drop the WebGL context and silently reset category toggles, "Selected"
  rows and pan/zoom. The dropdown is suppressed in `focus` mode (a `?zone=X&gather=Y`
  view builds no category sprites at all).
- **Every rendered sub-area name is a link.** A page exists for each one, so printing
  the name as dead text is a bug, and the places that did it were all *downstream* of
  the subzone work rather than part of it:
  - `main.js` `subSuffix` — the second half of the shared Location cell, which
    `resolveNpcLocations` builds for **every** Location column on the site (quest
    givers/enders, item Dropped-by/Sold-by, faction members, spell trainers). One
    helper, ~8 tables.
  - the quest header's `continent > zone > sub-zone` chain and the Zone cell on both
    `?browse=quests` and the search Quests tab. `quests.zone` is a **leaf** area, so it
    is a sub-area about as often as a zone; the old code linked it only when it had a
    parchment (`zones.areaid`) and printed the rest. `Q_SUBZONE_EXISTS` / a `sub_page`
    column decides which of the two pages it gets.
  - the zone map's subzone dropdown, which names an area a `<select>` can't link —
    hence the `Open ›` anchor beside it.
- **The trainer Location column was the last user of the pre-subzone locator** — "the
  largest WorldMapArea box containing the spawn". Those boxes overlap far too badly for
  that (Sayoc, NPC 11868, stands in Orgrimmar and the biggest box over him is Azshara's),
  so the spell page and the NPC's own page named different zones. Every Location now goes
  through `resolveNpcLocations` → ADT-exact `spawn_points.zone`. If a location disagrees
  across two pages, look for a second locator rather than bad data.
- **Optional schema.** The frontend is shared by every dataset, so a deploy lands on
  DBs built before this. `db.js` `caps()` probes for the table + column once and the
  UI degrades: no Subzones tab, no dropdown, empty search tab, zone-only Location
  labels. Dispatch `deploy-dev` / `deploy-cmangos` / `deploy-tbc-cmangos` to close it.

### Interiors: the area a cave has, not the one above it

The ADT terrain chunk names the ground you stand ON. Walk into a cave or a building and
the client stops reading it and takes the area off the **WMO** you are inside
(`WMOAreaTable`, keyed by the root model's `MOHD.wmoID` + the placement's nameSet). Those
two answers disagree far more often than they look like they would, so terrain-only
assignment silently mis-homes ~13k spawns — 9% of the world.

The case that surfaced it: Highlord Mastrogonde (NPC 8282) sits in the **Firewatch
Ridge** cave. Turtle painted the rock above that cave as **Sherwood Quarry** when it added
the Northwind zone, so the cave came out cut in half — the southern spawns in Searing
Gorge, the northern ones (the rare among them) filed under a different zone on a different
continent from the one the game names when you walk in. The cave is a *generic model*
(`MD_MUSHROOMCAVE03`) whose nameSet 1/2/3/4 is Firewatch Ridge / Raptor Ridge /
Crystalvein Mine / Emberstrife's Den, which is the general statement of why terrain can
never name an interior: the same rock is four different places.

- `scripts/extract-wmo-areas.py` (LOCAL, committed output) walks every ADT's MODF
  placements, resolves each to its area, and writes `wmo-areas.json`. `build-db`'s
  `homeZone()` tries the WMO leaf first and the terrain leaf second.
- **Two levels of box, because one is useless either way.** The outer box is the
  placement's stored world AABB — a cheap reject, and far too coarse to decide with
  (Stormwind's is 1488 yards square). `g` holds the per-GROUP boxes from `MOGI`,
  transformed by the placement, which hug the actual rooms; a point counts as inside only
  when a **group** contains it. The transform was derived from the client, not from
  memory: local (X,Y,Z) maps to ADT (y,z,x), rotated about the up axis by the MODF's
  second angle, then clipped to the stored extents (which bounds the error from the two
  tilt angles it drops).
- **The boxes are 3D and the z range is load-bearing** — it is what keeps a mob standing
  on the mountain above a cave out of the cave. `spawn_points` stays 2D; z is read from
  the dump row at assignment time and thrown away.
- **Only the model-wide `WMOAreaTable` row (`WMOGroupID = -1`) is followed.** A zero area
  there means "keep the terrain area", which is what most buildings do. Per-group
  overrides are skipped — there is exactly 1 on the Turtle client, and honouring it would
  mean applying one room's area to the whole model.
- **Two guards, both of which cost real spawns when missing.** A WMO box that claims the
  *parent* of what the terrain says is dropped: Stormwind's model reaches over the Valley
  of Heroes and "Stormwind City" is not an improvement on "Valley of Heroes" (~1.8k spawns
  on that rule alone). And a WMO area whose own `AreaTable.MapID` is not the spawn's map is
  dropped: an instance ENTRANCE is modelled on the continent but its area belongs to the
  instance (Westfall's Deadmines cave is area 1581, map 36), and taking it moves those
  spawns off the zone page that can actually draw them onto an entrance mini-map — and
  lets an entrance WMA rank against real zones in `zone_stats`.
- Interiors also give ~60 sub-areas a page they never had (Gallows' End Tavern, Brill Town
  Hall, Thunderbrew Distillery): they have no terrain chunks at all, so the placement box
  is also the only bbox the `subzones` row can carry.
- **Per-expansion** via `clientData()`, same as the terrain bounds:
  `wmo-areas-tbc.json` for the TBC row.

### NPC stats + abilities

The NPC page's **Stats** tab and **Abilities** tab (wowhead-style) come from
`creature_template` columns the build used to drop, plus one derived table.

- **Stats** live on `creatures`: `armor`, `mana_min/max`, `dmg_min/max`,
  `dmg_school`, `attack_power`, `base_attack_time`, the ranged trio, `unit_class`,
  the six `*_res`, `gold_min/max`, `mechanic_immune_mask`, `school_immune_mask`.
  `dmg_multiplier` is **folded into `dmg_min/max` and dropped** — the server applies
  it when it builds the creature (`Creature::SelectLevel` → `SetBaseWeaponDamage`),
  so the stored numbers are what the mob actually hits for. Like `health_*`, they're
  pre-`rate.*`-config values (the world data doesn't expose those rates).
- The Stats tab is a **grouped table** (Defense / Offense / Resources & loot) whose
  third column reads each stat against its **peers**: `Q_NPC_PEERS` takes the
  **median** health/armor/DPS/attack-power of every non-hidden creature at the same
  `level_max` + `rank` (index `idx_creatures_peer`), so "3,379 armor" becomes
  "×0.80 of a typical level 63 boss". Median, **not** average — a few raid bosses
  with a big `dmg_multiplier` drag the lvl-63-boss mean DPS to ~4990 vs a ~1277
  median. Under `NPC_PEER_MIN` (10) peers the cohort isn't representative, so every
  ratio cell renders empty and the table's `hideEmpty` drops the column outright
  rather than quoting a made-up median.
- **Abilities** land in `creature_ability(creature, spell, src, prob, cd_min,
  cd_max, ord)`, unioned from four sources; `(creature, spell)` is unique and the
  first source to claim a pair wins, in this order:
  `l` the shared spell list (`creature_template.spell_list_id` → `creature_spells`;
  carries a cast chance + repeat cooldown, stored by the server in **seconds**),
  `t` the four `spell_id1..4` template slots, `e` EventAI scripted casts
  (`creature_ai_events.action{1,2,3}_script` → `creature_ai_scripts` command 15,
  `datalong` = the spell), `a` the passive `auras` list, and `c` the ScriptDev2 **C++**
  fights (below). Rows whose spell isn't in the shipped `spells` table are dropped, so
  this runs **after** the spells import.
- **`c` -- C++ boss fights.** A boss scripted in the server's C++ has no spell list, no
  template slots and no EventAI rows, so it listed nothing at all (Ragnaros, Nefarian,
  Onyxia...). `extract-script-abilities.mjs` (LOCAL) parses
  `../tortoise-wow/src/scripts/**/*.cpp`: constants -> each AI struct's brace range ->
  the cast calls inside it, then chains `newscript->Name` -> `GetAI_*` -> struct, and
  writes the committed `scripts/data/script-abilities.json` (`script_name -> [spell]`).
  build-db joins it on `creature_template.script_name`. **Turtle only** -- cmangos'
  `ScriptName` points at its own separate C++, so attributing Turtle's spells there
  would be a guess (and cmangos covers those fights with EventAI). Shared scripts that
  cast from DB data (`generic_spell_ai`, 338 creatures) correctly resolve to zero.
- The **Skinning** tab leads with the skill a skinner needs, derived on the client from
  the creature's level (`constants.js` `skinningReq`) — no DB column. Server-exact
  (`Spell::CheckCast` SPELL_EFFECT_SKINNING: `level*5`, or `(level-10)*10` while the
  skinner is under 100 skill; the branches cross at level 20). A level *range* shows a
  range, and anything over the 300 profession cap (61+ bosses) says so and links to
  `?browse=items&stats=skinning,>=,1` — the gathering-skill bonuses (`skinning`/
  `herbalism`/`mining`, derived into `item_stats` from each item's MOD_SKILL equip
  aura) are GEAR_CRITERIA stats, so the existing stat filter lists the +Skinning gear.
- **cmangos** carries the same data in different shapes, so the derivation branches
  on the staged **column names**, not on `SQL_SOURCE`: the template slots are a
  separate `creature_template_spells` table, `creature_spell_list` is row-per-spell
  with cooldowns in **milliseconds**, `creature_ai_scripts` *is* the EventAI event
  table (action type 11 = cast) rather than dbscripts, and auras live in
  `creature_template_addon`. The adapter stages those under their own names.

### Sounds (`?voicelines`, NPC Sounds tab, zone Music tab)

Extracted game audio: what an NPC says/roars, and what a zone plays. Wowhead-style, plus
the thing wowhead doesn't have — **transcripts**, and full-text search over them.

- **Audio is R2-only** (`public/sounds/`, ~5.0k files / ~1.0 GB), like maps and minimap
  tiles. What's **committed** is `scripts/data/sound-map.json` (~0.7 MB) — the mapping CI
  can't rebuild without a client — and `scripts/data/script-sounds.json`.
- **Transcoding** (`extract-sounds.py`, needs ffmpeg): `.wav` → Opus in Ogg, music/ambience
  96k stereo and voice 48k mono. Already-compressed sources ≤512 KB are **copied through**
  (re-encoding a 19 KB Ogg measured 18 KB — generation loss for nothing, and these are the
  quality-sensitive Turtle voice clips). Above that they are re-encoded: Turtle's custom
  ambience ships as 4–11 MB mp3s. Music is 828 MB of the 1.0 GB — `MUSIC_ARGS` is the knob.
  Output paths mirror the source (lowercased, minus the leading `sound/`), which is both
  the dedupe key and stable across runs.
- **The NPC chain is entirely client-side**, hence the committed JSON:
  `creature_template.display_id` → `CreatureDisplayInfo.SoundID` (an override, ~300 rows)
  else `CreatureModelData[.ModelID].SoundID` → `CreatureSoundData` → ~20 activity slots
  (Aggro/Death/Exertion/Loop/Fidget/Custom Attack/Pet…). Separately
  `CreatureDisplayInfo.NPCSoundID` → `NPCSounds` → the greeting/farewell/pissed set.
  Zones: `AreaTable.{ZoneMusic,AmbienceID,IntroSound}` → `ZoneMusic` / `SoundAmbience` /
  `ZoneIntroMusicTable`, each a day+night pair (collapsed to one row when identical).
- **`WMOAreaTable` is a second, easily-missed source.** The client also binds audio to the
  BUILDING you stand in, and that never reaches the zone's own `AreaTable` row — the
  Deadmines' iconic `Moment-Spooky01` intro is a WMO row (wmo 499 → area 1581) with
  nothing on the AreaTable side at all. Reading zones only silently loses it. 2,889 rows
  carry music/ambience/intro across 305 areas; those with an `AreaTableID` are placeable
  and land as `… (Interior)` kinds, deduped against whatever the zone already lists (a WMO
  usually repeats the zone track). Fields 6/7/8/10 = Ambience/ZoneMusic/IntroSound/
  AreaTableID, all ahead of the localized name block, so TBC doesn't move them.
- **Transcripts come from the server, but the SPEAKER usually doesn't.** `script_texts`
  pairs a line with a sound id and says nothing about who says it — that binding is a C++
  `DoScriptText(SAY_AGGRO, m_creature)` call, read out by `extract-script-sounds.mjs` via
  the shared `scripts/lib/scriptdev.mjs` chain (the same enum → AI struct → `script_name`
  walk `extract-script-abilities.mjs` uses). It resolves ~half; `broadcast_text` covers a
  second pool where `creature_ai_events.creature_id` *does* name the speaker. **A line
  that can't be attributed is still listed, without a speaker** — dropping it was a bug
  that cost ~2/3 of the voice lines. Result: 420 distinct lines with audio, 176 credited.
- **`extract-script-sounds.mjs` must run BEFORE `extract-sounds.py`.** A boss line's sound
  is in neither `CreatureSoundData` nor the VA directory, so the client DBCs give the
  extractor no reason to pull it; the `ids` array in `script-sounds.json` is that reason.
  Without it 30 of ~340 voice lines had audio. Turtle's own voice acting is scoped by
  **directory** instead (`Sound\Interface\VA`, ~400 clips) — most are played straight from
  C++ and referenced by no DBC row at all.
- **`Sound\Creature\<Folder>` is the scope rule that scales, and it supersedes chasing
  boss ids one at a time.** `script-sounds.json` only ever worked for Turtle: it is parsed
  out of *Turtle's* ScriptDev2 tree, so on the cmangos rows every C++-scripted boss listed
  nothing but grunts. Mother Shahraz (22947) is the case that forced this — 11 spoken lines
  sitting in `Sound\Creature\MotherShahraz`, reachable from no DBC row at all, while wowhead
  lists them all. The folder IS the client's own "all audio for this creature" grouping, so
  it is taken whole: 3,757 sounds on a TBC client, 3,830 on Turtle, against the ~1,400
  `CreatureSoundData` reaches. New client, new boss, new core — no worklist to update.
  Binding a folder back to a creature uses three signals, and needs all three:
  1. the folder holds a sound some `CreatureSoundData` row references → that CSD's displays;
  2. the folder `CreatureModelData.ModelPath` sits in → that model's displays (`cmd_path`).
     Together these are ~313 of 568 TBC folders, and they are done in the extractor
     (`displayDir`), being purely client-side.
  3. else the folder NAME vs the creature name — exact, else contained-in with ≥6 chars and
     ≤3 matching names ("Faerlina" is "Grand Widow Faerlina"; "Archer" is in 42 names and
     means none of them). Done in **build-db**, which is where creature names live. This is
     the only thing that finds Shahraz: her display reuses another model's sound data.
  A folder that binds to nothing (generic voice types like `Peon`, cut content) is still
  extracted and still listed at `?sounds` — `Q_SOUND_LIST` files it as `Creature` on its
  file path — it just carries no NPC attribution, which beats a guessed one.
  These rows carry `creature_sound.ord` **200 (speech) / 201 (noise)** — above every client
  slot, whose max is 103 — which is how `main.js` groups them without a new column an older
  DB would fail on. A folder holds both kinds: Illidan's 19 spoken lines sit beside his wing
  flaps. The splitter is the **`A_` filename prefix**, Blizzard's own marker for a spoken
  SoundEntries row and near-perfect here (of 1,773 `A_` rows in TBC creature folders, the
  only effect-*looking* names are `…Summon01` — the boss saying "arise"), plus a small
  vocal-activity set for the rest.
  Their **activity** is read off the filename by two rules: a known activity word anywhere
  in it (longest first, so `SpecialAttack` isn't read as `Attack`), else the name minus its
  `A_` prefix, trailing counter and the FOLDER NAME (`A_Mr Smite Alarm01` in `MrSmite` →
  Alarm), compared on alphanumerics because the two spell the creature differently as often
  as not. **There is deliberately no third "last word-ish token" rule**: it reads the
  ENCOUNTER prefix as an activity — Illidan's numbered lines came out labelled "Illidan",
  the Black Temple prelude "Btprlude" — which is worse than a blank activity cell.
- **A transcript belongs to a TAKE, not to the sound.** The 10 files a SoundEntries row can
  hold are interchangeable to the *client*, not to a reader: they are different lines.
  "Time is money, friend!" is take 1 of `GoblinMaleZanyNPCGreetings`, take 4 of
  `GoblinFemaleZanyNPCGreetings` and take 6 of `GoblinFemaleZanyVendorNPCGreeti`. Keying
  `sound_text` on the sound alone made every page quote whichever row came first and cue
  take 1's audio, so a phrase search found the right sounds and then printed and played
  something else. Hence `sound_text.take` — NULL where no take is knowable, which is
  exactly the server-derived pool (`script_texts` / `broadcast_text` pair a line with a
  SOUND and say nothing about which file carries it). The take was never missing from the
  inputs: `voice-transcripts*.json` are indexed by take and build-db already read that
  index for hand-vs-machine precedence, then dropped it on insert.
  Frontend: `caps().soundTake` gates it, the take-aware queries are **additive** (each page
  keeps its single-text column as the fallback), the transcript cell lists every take
  numbered against the player chips, clicking a line selects that take, and a search hit
  resolves WHICH take matched so the player opens on it.
- **Crediting a speaker UPDATEs, it does not INSERT a copy.** The three attribution passes
  (cluster-propagate, name-match, abbreviation) used to insert a credited duplicate of an
  anonymous line. That was invisible only because every page read one row per sound —
  listing all takes showed each line set twice, once numbered with an `auto` badge and once
  bare. They now write `creature` onto the existing rows (546 rows of pure duplication gone
  on main). `src` is deliberately left alone: it records where the TEXT came from, so a
  machine transcript stays machine-flagged whoever is later found to say it.
- **Tables**: `sounds` (id → name/type/files/ms; `files` is a JSON array, since one
  SoundEntries row holds up to 10 interchangeable takes the client picks between — the UI
  renders them as numbered chips), `creature_sound`, `zone_sound`, `sound_text` +
  `sound_text_fts`. **Optional schema** — `db.js` `caps()` probes for `sounds` and the UI
  hides itself on a DB built before this (dispatch the per-dataset deploys to close it).
- **`f.rank` must be qualified** in any query joining `sound_text_fts` to `creatures`:
  creatures has its own `rank` column (elite/rare/boss) and the bare name is ambiguous, so
  the query throws and — behind the view's `catch` — search silently returns nothing.
- Category labels are derived from the **slot**, never `SoundEntries.type`: that column is
  a playback-engine flag (2D vs 3D, looping) and says nothing about what the sound is.
- **Reachable from three places**, which is the point of a transcript index: `?voicelines`
  (More → Voice Lines), a **Voice Lines tab on `?search=`**, and the top-bar dropdown.
  `Q_SEARCH_VOICE` unions two ways in — the spoken TEXT (FTS) and the sound NAME (LIKE) —
  because "ragnaros" should find his clips by name while a quoted phrase finds them by
  what is said; the name half is the only thing that surfaces Turtle's ~400 VA clips,
  most of which no text row references. In `rankFlat` a voice row is tiered on its
  TRANSCRIPT, not its sound name: ranking a spoken line by its internal filename buries
  an exact quote under unrelated clips whose name happens to start with the term.
- Zone music also appears on **subzone** pages — a sub-area is its own `AreaTable` row and
  ~half of them (495/1057) carry their own track, so Northshire Valley plays something
  Elwynn doesn't. It counts toward that page's `hasData`, or a lake with no spawns would
  claim "nothing is recorded here" while holding something to play.
- **Per-expansion**: the archive order and every DBC offset live in
  `scripts/lib/clientprofile.py`. TBC keeps its spoken audio in the *locale* archives
  (`enGB/speech-enGB.MPQ`, `expansion-speech-enGB.MPQ`), `CreatureSoundData` grew 30 → 37
  fields (an unused `NPCSoundID` at 23 pushes Loop/Jump/Pet by one) and
  `CreatureDisplayInfo.NPCSoundID` moved 11 → 12. `SoundEntries` itself is 29 fields in
  both — it carries no localized string, so nothing in it shifted.

### Transcribing the clips nothing writes down

~1,600 voice sounds (4,067 takes) have audio and no line anywhere in the world data: the
client picks a clip from an NPC's voice type and the words exist only in the audio.
`scripts/transcribe-sounds.py` (LOCAL, GPU) runs Whisper over `public/sounds` and writes
`scripts/data/voice-transcripts-auto.json`. Doing it ourselves also sidesteps the wiki
route: a wiki lists what a voice TYPE says, not which take says it, and its text is
CC BY-SA.

- **Two files, and the precedence matters.** `voice-transcripts.json` is hand-verified and
  authoritative; `voice-transcripts-auto.json` is machine output. build-db loads hand
  first, and a hand line for a sound suppresses the machine one for that whole sound.
  Machine rows carry src `w` and the UI badges them "auto" — a guess from audio must not
  read with the same authority as a line lifted from the server's own scripts.
- **Scope is voice only.** Anything reachable from `zone_sound` is excluded: speech
  recognition over a five-minute orchestral loop yields confident nonsense and would
  dominate the runtime.
- **Whisper hallucinates in silence, and repeats itself doing it** — a 0.6s grunt becomes
  "Thanks for watching!". Hence a phrase denylist plus gates on `avg_logprob`,
  `no_speech_prob` and a 0.8s floor, and VAD on.
- The speaker's name goes in `initial_prompt`, which is what gets Anub'Rekhan and
  Vek'nilash spelled correctly; a general model has never seen them.
- **GPU**: `--compute` is **negotiated at runtime** via
  `ctranslate2.get_supported_compute_types()`, not hardcoded. A GTX 1070 (Pascal) reports
  `{int8_float32, int8, float32}` and **no fp16 at all**, so a hardcoded `int8_float16`
  fails to initialise and silently drops the whole run onto the CPU. ctranslate2 also
  needs the CUDA 12 runtime (`pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`); the
  script registers those DLL dirs itself, because without them the model LOADS (VRAM
  fills, it looks like the GPU is working) and every encode then dies with
  "cublas64_12.dll is not found".
- **Checkpoints every 25 sounds.** The first full pass ran 105 minutes and persisted
  nothing — it wrote once at the end and stalled before reaching it.
- **Whisper's degenerate repetition loop** is guarded (`repetition_penalty`,
  `no_repeat_ngram_size`, `compression_ratio_threshold`): one 3-second clip stalled a run
  for ~48 minutes emitting tokens to the window cap.
- **A systemic error must abort, not be absorbed per file.** 5 consecutive identical
  failures stop the run — otherwise a missing CUDA DLL reads as 4,067 bad files and the
  run reports success having transcribed nothing.
- Thresholds are measured, not guessed: real lines score `avg_logprob` −0.21…−0.44 and
  grunts −0.79…−1.14, while DURATION is a poor discriminator ("Yo" is 0.40s), which is why
  the length floor is only 0.25s.

### Browsing sounds (`?sounds`)

2,545 sounds exist; `?voicelines` only ever listed the ~1,000 with words, so music,
ambience and creature audio had no page at all. `?sounds` lists everything, filterable by
name **or file path** (people know these by either), with a derived **Kind** — Music /
Ambience / Zone Intro / Voice Acting / NPC Gossip / Creature. Kind comes from what POINTS
at a sound, never `SoundEntries.type`, which is a playback flag (2D/3D/looping).

- **The player column needs `max-width`, not `width`.** `width: 1px` is the usual
  shrink-to-content idiom and it does nothing in these tables: measured against the real
  page, `width` of 1px / 1% / 100% all left the column at 344px around a 211px control,
  because auto layout hands the slack back. Only `max-width` binds. `.snd` wraps its take
  chips so a 10-take sound doesn't overflow the cap.

### NPC gossip (`npc_gossip`, the NPC Gossip tab, the search Dialogue tab)

What an NPC says when you *talk* to it, and the only place a quoted phrase is searchable.

- **A voice clip and a spoken line are different objects, and the data never links them.**
  The client picks the clip from the NPC's **voice type** (`GoblinMaleGruffVendorNPCGreeting`
  is shared by ~50 goblin male gruff vendors) and shows that one NPC's gossip text
  separately. Only 94 of 13,665 `broadcast_text` rows carry a `sound_id` at all, and **no**
  gossip-slot sound has one — so "Time is money, friend" can never be a *transcript* of the
  vendor greeting, however much it sounds like one. It is gossip text, and it belongs to
  Clemence the Counter.
- Chain: `creature_template.gossip_menu_id` → `gossip_menu.text_id` → `npc_text.BroadcastTextID0..7`
  → `broadcast_text.male_text`. Yields ~4,983 lines across ~2,620 NPCs.
- `npc_gossip` is deliberately **not** `WITHOUT ROWID`: `npc_gossip_fts` is external-content
  and keys on the content table's rowid, which such a table doesn't have.
- Rendered through `questText()`, since gossip carries the same `$B`/`$N` tokens quest text
  does. **Optional schema** — `caps().gossip` gates the tab and the search query.

### 3D model viewer (item page "3D" tab)

An interactive preview of the item's real model, rendered in the browser with three.js
from models we convert ourselves. **44% of this site's 15,534 equippable items are
Turtle-custom**, so every Wowhead-backed viewer is structurally blind to the half of the
wardrobe people actually come here for — and `Miorey/wow-model-viewer`, the obvious
dependency, is a thin wrapper over Wowhead's proprietary `ZamModelViewer` that needs
jQuery and a **CORS proxy server** besides. Same call, same reason, as `OWN_MODEL_THUMBS`.

- **`item_appearance`** (`scripts/data/item-appearance.json` via
  `extract-item-appearance.py`, committed; build-db loads it) is display_id → the model
  (`model_l`/`model_dir`), its texture (`tex_l`), the geoset groups, the helmet-visibility
  ids, and the 8 armor component textures. **Turtle-only** and gated by `caps().appearance`
  — a display id is not a shared namespace.
- **`ItemDisplayInfo.dbc` is 23 fields in 1.12 and the layout everyone quotes is WotLK's**,
  which has a second icon field and shifts the whole `Texture[8]` block by one. The real
  order is `ID, ModelName[2], ModelTexture[2], InventoryIcon, GeosetGroup[3], Flags,
  SpellVisualID, GroupSoundIndex, HelmetGeosetVis[2], Texture[8], ItemVisual`, and it is
  pinned by evidence, not memory: field 11's values are all valid `ItemGroupSounds` ids,
  12-13's all valid `HelmetGeosetVisData` ids, field 9 only ever holds 1/2/4 (bits), and
  every chest writes torso-upper+lower while every glove writes arm-lower+hand.
  `extract-item-appearance.py --probe` re-prints that evidence and writes nothing.
- **`.m2b`, not glTF** (`scripts/export-models.py` → `src/m2b.js`). The semantics that must
  survive have no glTF home: geoset ids, ADDITIVE blend, and above all the texture-unit
  **type** (0 embedded / 1 char skin / 2 object skin / 6 hair), which is the whole
  mechanism by which one mesh is re-textured per item. In glTF each would be an `extras`
  bag we parse ourselves — a custom format wearing a costume, plus a ~150 KB loader.
  The pose is **baked** (Stand frame 0, the same `skin()` the thumbs use), so v1 needs no
  runtime skinning; bones and attachments still ship for the character work.
- **A texture is bound per SLOT, never per model.** An effect weapon is its own mesh plus
  glow/lightning planes that name their own textures inside the file (Thunderfury:
  `SPELLS\ZAP1.BLP`, `LIGHTNINGBALL.BLP`, and only slot 4 is the blade). Binding the item
  texture to everything painted the blade onto its own glow and rendered as a lit square.
  Embedded textures export by client path to `model3d/tex/<path>.webp`.
- **Framing uses the opaque submeshes only** — effect planes reach well past the mesh, so
  including them shrinks the item and pushes it off-centre. Lighting copies the thumb
  renderer's (amb+key+fill); these textures are pre-shaded and a "normal" 3-point rig
  blows them out.
- **It must cost nothing when idle**, which is not free: the loop renders only while
  something moves, sleeps when the pane is hidden (IntersectionObserver) or the browser
  tab is, and the idle spin stops after one full revolution. Measured under software
  rendering: 3.3% of a core while spinning, **0.0% at rest or hidden**. The spin is
  per-SECOND, not per-frame — a frame-based step silently doubled the revolution once the
  draw rate was throttled to 30fps.
- **The pane mounts on VISIBILITY, not on the tab click.** Relying on the click leaves it
  stuck on "Loading model…" whenever the listener is missing — which is exactly what a
  Vite HMR update does, by re-running `main.js` while leaving the rendered DOM in place.
- Offered only for models that stand alone: `per_race` items (every helm, most shoulders,
  modelled once per race+gender) and texture-only armor need a character to sit on, so
  they get no tab rather than an empty one. ~2.5k of 10.2k displays qualify today.
- Assets are the R2 set `model3d/` (817 models 7.7 MB + 1,559 item textures 6.9 MB + 274
  embedded 1.8 MB), `optional` like `sounds`. The DB cost is **+0.11 MB brotli**.

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

**The tile pyramid is NOT committed** — it lives only on R2 (see "Binary assets live
on R2"), like `public/maps`. Only the tiny `scripts/data/minimap.json` transform
manifest is committed (Vite bundles it). Re-run `extract-minimap.py` on client map
changes, then `bun scripts/publish-assets.mjs` to push the new tiles.

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
  the `creature_ability` table (the spells an NPC casts — see "NPC stats + abilities"),
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
  box containing it, keeping BOTH the leaf area (`spawn_points.sub`, see "Subzones")
  and that leaf walked up `area_template.zone_id` to the render zone (`.zone`) — exact
  coord→zone the SQL dumps lack. Re-run on client updates. **Per-expansion**: resolved
  through `clientData()`, so `CLIENT_PROFILE=tbc` + `AREA_BOUNDS_OUT=…-tbc.json` against
  a TBC 2.4.3 client yields `subzone-bounds-tbc.json` — the only source of Outland
  (map 530 `Expansion01`) bounds, and of the TBC-era maps 0/1 that carry Eversong /
  Ghostlands / Azuremyst / Bloodmyst. ADT format is unchanged from 1.12 (MCNK areaid
  at header `+0x34`; split `_obj0`/`_tex0` ADTs only arrive in Cataclysm), so only the
  MPQ set differs.
- `scripts/extract-wmo-areas.py` — LOCAL: the OTHER half of coord→area, the half the
  terrain cannot see. Reads every ADT's WMO placements (MODF) and resolves each through
  the root model's `MOHD.wmoID` + the placement's nameSet to `WMOAreaTable` → committed
  `scripts/data/wmo-areas.json`. See "Interiors" below.
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
- `scripts/extract-item-appearance.py` — LOCAL: the client half of "what does this item
  look like" (`ItemDisplayInfo.dbc` + the built DB for which display ids are used) ->
  committed `scripts/data/item-appearance.json`. `--probe` prints the field-layout
  evidence rather than trusting the WotLK layout everyone quotes. See "3D model viewer".
- `scripts/export-models.py` — LOCAL: client M2 v256 -> `public/model3d/**` (R2-only):
  `.m2b` meshes (pose baked, submesh/blend/texture-slot metadata kept) plus the item and
  embedded effect textures as WebP, and a `manifest.json`. Reads `scripts/lib/m2.py`.
- `scripts/lib/m2.py` — the shared client-3D reader (MPQ, WDBC, M2 v256 parse, bone
  posing, BLP decode), factored out of `render-model-thumbs.py`, which still imports it
  and is the regression oracle: its thumbs must stay byte-identical across changes here.
- `src/m2b.js` — pure `.m2b` -> plain-object decode (typed-array views, no three import,
  so it is testable without WebGL). `src/modelviewer.js` — the lazy three.js chunk that
  turns that into a rendered, orbitable preview.
- `scripts/build-tooltips.mjs` — dumps compact per-entity JSON
  (`dist/tt/<prefix>/<id>.json`, prefixes i/n/q/s) for the embeddable powered-tooltip
  widget `public/embed/tw-power.js`. Content-hashed like the OG stubs (HASH_ONLY=1);
  run AFTER `vite build` (it writes into `dist`, which vite wipes). deploy.yml
  regenerates + merges it (cache-gated). `public/embed/demo.html` is a demo/test page.
- `scripts/build-api.mjs` — the **public JSON API** (Wowhead-style): one rich file per
  entity at `dist/api/<i|n|q|s>/<id>.json` — the same data the detail page shows
  (structured fields + stats + capped source lists + a rendered `tooltipHtml`), served
  from R2 at **`api.tortoiseclothing.org`** (`/i/55057`, or `.json`). REUSES the app's
  real SQL (`src/queries.js`) + tooltip renderer (`src/render.js` `renderTooltip`/
  `spellTooltip` — both pure/Node-safe) so it can't drift from the page; tooltip links
  are absolutized to the site. Source arrays capped to 25 (best-first) to bound size.
  Content-hashed (`HASH_ONLY=1`) + `api/manifest.json` like the tt JSON; deploy.yml
  builds it cache-gated and R2-syncs it hash-gated (R2-only, never in `dist`). Env:
  `OUT_DIR`, `DB_PATH`, `API_ONLY` (i,n,q,s), `API_LIMIT`, `API_VERSION` (bump on schema
  change). Serving needs a one-time Cloudflare setup: add `api.tortoiseclothing.org`
  as an R2 custom domain on the `tortoise-db-viewer` bucket, set bucket CORS to `*`,
  and a Transform Rule rewriting `/[inqs]/<id>` → `…/<id>.json`.
- `scripts/extract-script-abilities.mjs` — LOCAL: reads the server ScriptDev2 C++
  (`../tortoise-wow/src/scripts/**/*.cpp`) → committed `scripts/data/script-abilities.json`
  (`script_name → [spellId]`). Per file it collects the `NAME = <number>` constants, walks
  each `struct …AI` brace range for `DoCastSpellIfCan`/`CastSpell`/`DoCast`/`DoCastAOE`
  calls, resolves their spell argument through those constants, then chains
  `newscript->Name` → `GetAI_*` → struct so a multi-script file attributes correctly (a
  file with a single AI struct falls back to it). build-db joins it on
  `creature_template.script_name` → `creature_ability` src `c`. CI has no server `src/`,
  so the JSON is committed; re-run + commit on scriptdev changes.
- `scripts/extract-instance-bosses.mjs` — LOCAL: reads the server ScriptDev2 C++
  (`../tortoise-wow/src/scripts/dungeons/<instance>/`) + the built DB → committed
  `scripts/data/instance-bosses.json` (`[{e:creatureEntry, m:mapId}]`). Instance bosses
  placed by C++ scripts have NO static `creature` spawn, so the SQL dump can't locate
  them; this parses each folder's creature/GO enums, grounds the folder→mapId from the
  built DB (gameobjects are placed inside the instance), and maps every spawn-less
  creature there to that map. build-db loads it into `creature_instance`; the character
  upgrade finder (`qInstanceDropsIn`) uses it to name e.g. "Razorfen Downs · Tuten'kash".
  CI has no server `src/`, so the JSON is committed. Run: build-db → this → build-db.
- `scripts/extract-vanilla-ids.mjs` — LOCAL: reads the cmangos **Classic DB, published
  as SQLite** (github.com/cmangos/classic-db/releases → `classicmangos.sqlite`) →
  committed `scripts/data/vanilla-ids.json` (`{items,creatures,quests}` = the canonical
  vanilla-1.12 id sets, **plus** an `edited` set — see next). build-db flags Turtle-custom
  content as `custom = entry NOT IN vanilla OR entry IN edited` — more accurate than the
  old ID threshold (catches Turtle additions squatting inside the vanilla id range; not
  fooled by high-id vanilla rows). Threshold is the fallback if the JSON is absent.
  **`edited` closes the in-place-edit gap** the id-list can't see: if the built Turtle DB
  (`public/data/tortoise.sqlite`) is present, the script field-DIFFs every shared id vs
  cmangos and records Turtle's changes — **items** on a normalized-name OR curated
  gameplay-field diff (repurposed ids AND rebalances; e.g. Atiesh's tweaked weapon speed),
  **creatures/quests** on a name/title diff only (repurposes; their field diffs are FP-prone
  — derived health, NULL-vs-empty subname, npc-flag drift, quest typo-fixes — so excluded).
  Only Turtle builds union `edited` (the cmangos dataset's rows ARE that baseline). Run
  order for a full refresh: `build-db → extract-vanilla-ids → build-db` (first build makes
  the DB it diffs; `TW_DB` overrides its path). Re-run + commit on a new cmangos Classic DB
  release or material Turtle world-data change.
- `scripts/probe-wowhead-thumbs.mjs` — LOCAL: HTTP-probes Wowhead's Classic creature
  webthumb (`wow.zamimg.com/.../webthumbs/npc/<d%256>/<d>.webp`) for every creature
  `display_id`; the confirmed-404 set (Turtle-custom models Wowhead never saw) →
  committed `scripts/data/model-thumb-missing.json` (the render worklist). Full
  present/missing map cached to `model-thumb-coverage.json` (gitignored). ~1500 of
  ~8900 display_ids are custom.
- `scripts/render-model-thumbs.py` — LOCAL: renders the missing worklist to static
  preview thumbnails Wowhead can't provide. Reads the client MPQ (StormLib),
  resolves `display_id → CreatureModelData M2 (vanilla v256) + CreatureDisplayInfo
  skins`, parses the M2 (vertices/skin/views/textures/materials, bone-skinned to the
  Stand-animation frame 0), and renders headless with moderngl → `public/model-thumbs/
  <displayId>.webp` (300×300 transparent) + `manifest.json`. Two-pass opaque→additive
  blend (particle/glow planes), opaque-body framing. **CHARACTER models** (humanoid
  NPCs, `CreatureDisplayInfo.ExtendedDisplayInfoID != 0`) render from their **pre-baked
  NPC texture** (`CreatureDisplayInfoExtra` field 18 → `Textures\BakedNpcTextures\<name>`;
  Turtle ships these) mapped onto the character-skin (type 1) + object-skin (type 2)
  texture units — no full char-compositing pipeline needed; 3D hair (type 6) is skipped
  (the baked head carries the face/hairline). A char model with no bake is skipped.
  `src/render.js` `modelThumbUrl`
  serves our webp for manifest ids, else the Wowhead webthumb. Committed (CI has no
  client/GPU); re-run + commit on client model changes. Verified against wow.export's
  `M2LegacyLoader`.
- `scripts/lib/cmangos-adapter.mjs` — alternative staging source for `SQL_SOURCE=cmangos`:
  builds the viewer DB from cmangos's published Classic **SQLite** DB
  (`classicmangos.sqlite`) instead of Turtle's MySQL dumps. Returns the same accessor
  shape as `staging.mjs` so build-db's importers run unchanged — ATTACHes the cmangos DB
  and stages each table under the *Turtle* column names (same MaNGOS table names + SQLite
  case-insensitive columns ⇒ most map free; ~40 explicit renames + NULL for absent). The
  first build step of the `/{expansion}/{core}` matrix's vanilla row (see the plan in
  `notes/`). cmangos omits DBC-derived tables (it reads DBCs from the client at runtime);
  those are filled from `scripts/data/cmangos-dbc.json` (see `extract-cmangos-dbc.py`).
  `spell_template` is deferred (its text lives in Spell.dbc) ⇒ spells empty for now.
- `scripts/extract-cmangos-dbc.py` — LOCAL: reads a vanilla 1.12 client's DBCs (StormLib
  MPQ reader + WDBC parser, shared with extract-talents.py) → committed
  `scripts/data/cmangos-dbc.json` (`areas`/`maps`/`faction`/`faction_template`/
  `item_display_info`/`skill_line_ability`). Fills the DBC tables cmangos's world DB omits
  so the `SQL_SOURCE=cmangos` build gets zone names, dungeon names, faction data + NPC team
  alignment, and item icons. CI has no client ⇒ committed. `CLIENT` env overrides the path.
- `scripts/lib/itempeers.mjs` — derives the `item_peer` / `item_peer_cohort` tables
  (the item page's "vs. typical …" card): cohort key + coarsening fallback, per-cohort
  medians and competition ranks. Pure; imports only `src/constants.js` for the labels.
  See "Peer baselines".
- `scripts/extract-sounds.py` — LOCAL: pulls the client's audio (StormLib) and transcodes
  it → `public/sounds/**.ogg` (R2-only) + committed `scripts/data/sound-map.json`
  (SoundEntries → files, the CreatureSoundData/NPCSounds slot sets, display→sound-set, the
  per-area music/ambience/intro, and `dirSound`/`displayDir` — the `Sound\Creature\<Folder>`
  grouping that carries every C++-scripted boss line, plus the display ids it could bind
  client-side). See "Sounds".
- `scripts/extract-script-sounds.mjs` — LOCAL: server ScriptDev2 C++ + the `script_texts` /
  `broadcast_text` dumps → committed `scripts/data/script-sounds.json`: `script_name →
  {t: [textEntry], s: [soundId]}` (who says which line) plus `ids` (the sound worklist
  `extract-sounds.py` can't derive from the client). Run it BEFORE `extract-sounds.py`.
- `scripts/lib/scriptdev.mjs` — the shared ScriptDev2 walk (comment strip, constants, brace
  ranges, `newscript->Name` → `GetAI_*` → AI struct). `extract-script-abilities.mjs` and
  `extract-script-sounds.mjs` each supply only a `collect()` for the calls they care about.
- `src/audio.js` — the one `<audio>` for the whole app plus `soundPlayer()` / `wireAudio()`
  / `stopAudio()`. Single element on purpose (two clips at once is never intended), and
  `route()` stops it so a zone track can't outlive its page. The progress bar is a real
  `role="slider"`: pointer drag (captured, `touch-action:none`) plus arrows/Home/End.
  Seeking an idle player STARTS it — clicking into the middle of a clip is a play command.
  Two traps it handles: seeking before load can't set `currentTime`, so the fraction is
  held in `pendingSeek` and applied on `loadedmetadata`; and `play()` rejecting with
  **NotAllowedError is the autoplay policy, not a broken file** — flagging it as an error
  put a "!" on perfectly good clips. Download fetches to a **Blob**, because browsers
  ignore `<a download>` on a cross-origin URL without `Content-Disposition` — the plain
  link would open a tab instead of saving (bucket CORS is `*`; falls back to a tab).
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
- `src/selbar.js` — the item selection-ops bar (`0 selected` · Copy IDs · `.additem `
  prefix copy · Compare · Open on Wowhead · Clear), driven by `createTable`'s opt-in
  row selection. Mounted by **both** `?browse=items` and the search results' Items tab,
  which is why it's its own module — the two would otherwise drift the moment one grew
  an op. `selbarHtml()` / `updateSelbar(bar, count)` / `wireSelbar(bar, api, navigate)`;
  ops read the live selection from the table API per click, so sorting or paging between
  selecting and copying can't hand back stale rows. Search wires it via `regTable`'s
  `tableId` + the Map returned by `mountTables()`.
- `src/search.js` — unified search: `runSearch()` (shared multi-entity query,
  used by the results page) + `initSearchDropdown()` (live flat top-5 panel).
- `src/zonemap.js` — Leaflet zone map (lazy chunk): `initZoneMap()` draws the
  parchment + per-category circle-marker layers (quest/vendor/repair/trainer/
  flight/inn/bank/mob/object) with a layer-control toggle.
- `src/render.js` — `renderTooltip`, `tabs`, `itemLink`/`npcLink`/`dungeonLink`/
  `questLink`/`factionLink`, `iconImg`, `moneyHtml`, helpers. Factions are linked
  wherever named (quest reward rep, item tooltip reputation requirement).
- `src/hovercard.js` — item + quest tooltip on hover.
- `src/context.js` — comparative context ("is this number big?"): the ratio-to-median
  bar cell (`ratioCell`, `positive: true` flips the colour for more-is-better stats),
  `pctBeaten`, and `outlierLine` — the one-line "More melee DPS than 98% of level 54
  mobs" headline, which only fires on a top/bottom-decile stat ≥15% off the median.
  Shared by the NPC Stats tab, the item page's peer card and the zone profile strip.
  See "Peer baselines".
- `src/external.js` — the detail page's **"Open in ▾"** menu (the same entity on another
  WoW database) and the **in-game chat-link macro**. Two rules do the real work, and both
  exist because an entry id is NOT a shared namespace:
  - **Which sites cover which game.** TurtleDB (`turtledb.cthuly.com/site/<kind>/<id>.html`)
    and OctoWow (`octowow.st/db/?<kind>=<id>`, an aowow instance — the path form silently
    serves its homepage) index Turtle and resolve Turtle's own ids; Wowhead
    (`/{classic|tbc}/<kind>=<id>`) and WoW Classic DB (`/{tbc/}<kind>/<id>`) index retail
    Classic. So the Turtle pair is offered only on a `core: "turtle"` dataset, and a
    Turtle-**custom** entity (the build-time `custom` flag, items/creatures/quests only)
    greys the retail pair with a reason instead of linking into a 404. A site with no page
    for the KIND at all is DROPPED rather than greyed — TurtleDB has no zones, and a dead
    row on every zone page says nothing about that zone. wowdb.com is deliberately absent:
    it 403s on every URL including its homepage.
  - **The chat macro is not Wowhead's.** Wowhead Classic hands out the RETAIL item payload
    (`Hitem:2536::::::::60:::::`, 14 fields) from its shared generator; a 1.12 client's
    `SetItemRef` parses exactly FOUR (`item:id:enchant:suffix:unique`) and TBC eight (four
    gem slots before the suffix), so Wowhead's string does not resolve on the clients this
    site is about. We emit per `EXPANSION`, and colour by real item quality / 71d5ff for a
    spell rather than Wowhead's flat white. The `T` escapes are load-bearing: `|` cannot
    be typed into a chat command, so the pasteable form is a `/script ... AddMessage`. Only
    item/quest/spell are linkable in-game at all — an NPC/object/zone/faction gets no
    button. The client's edit box caps at **255 chars** and truncates rather than refusing,
    so the bracket text (cosmetic; the payload is what makes it clickable) is what gives.
  - **Random suffixes** get their own copy button per row of the item page's suffix list.
    Within one suffix NAME the pool ids are the stat permutations, not tiers ("of the Bear"
    = 8/8, 9/8, 8/9, 9/9), so the highest id is that suffix's max roll; the bracket text is
    literal, so the button carries the suffixed name too.
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
- Every user-facing change should keep the smoke suite green (`bun run smoke`) and
  add a check when it introduces a new view/behavior. Tests live in per-topic modules
  under `scripts/smoke/tests/*.test.mjs` (bun test); see that dir's `CLAUDE.md` for the
  harness API (`nav`/`load`/`smoke`) and how to add one.

### The `/tbc/cmangos` row (TBC 2.4.3)

Second non-Turtle matrix row: cmangos's **TBC** world DB (`tbc-sqlite-db.zip` →
`tbcmangos.sqlite`) + a TBC 2.4.3 client. Built by the same adapter, selected with
`EXPANSION=tbc`:

```sh
SQL_SOURCE=cmangos EXPANSION=tbc CMANGOS_DB=…/tbcmangos.sqlite \
CMANGOS_DBC=scripts/data/cmangos-dbc-tbc.json \
DATA_SUBDIR=data-tbc-cmangos ZONES_FILE=scripts/data/zones-tbc-cmangos.json \
bun scripts/build-db.mjs
```

`EXPANSION` is what makes it a *version*, not just a source: it resolves the
`scripts/data/<name>-tbc.json` client lookups (`clientData()`), suppresses the
Turtle-custom flag (the vanilla id list would mark all 5.4k TBC additions custom), and
blocks the Turtle instance-interior map fallback (1.12 art would be *wrong* for a TBC
dungeon, not merely missing).

**Client extraction** — `scripts/lib/clientprofile.py` holds the per-expansion MPQ order
and DBC field offsets; `CLIENT_PROFILE=tbc` selects it. Two traps it exists to avoid:
TBC keeps the whole `DBFilesClient\` tree in the **locale** archives (`Data\enGB\…`)
while `Data\patch.MPQ` still exists, so the "no archives opened" guard passes and the run
dies later; and localized strings widened from a 9-field block to 17, shifting every
field after the first name. Offsets were derived by probing the client (locale blocks
found by their zero-padding signature, numerics checked against known values), not from
memory — only Spell (Description 138→161, ToolTip 147→178), TalentTab (ClassMask/Order
12/13→20/21), SkillLineAbility (req_train_points 12→14) and ItemSet (+8) actually moved.

**TBC-specific data shapes** the adapter handles: pooled spawns move to
`creature_spawn_entry` **and set `creature.id = 0`** (7,696 of 7,733 — left alone those
NPCs have no spawn at all), and `spell_template.School` is gone in favour of `SchoolMask`
(derived back via `DERIVE`).

**A same-named column can mean a different quantity** — the adapter's real risk, and worse
than an outright missing column because nothing is NULL to warn about. `DamageMultiplier`
is the case that bit: on Turtle it's a *factor* on `dmg_min`/`dmg_max` (`SelectLevel` seeds
the weapon damage, `UpdateDamagePhysical` multiplies), so build-db folds the two together.
On cmangos it scales `creature_template_classlevelstats.BaseDamage` and `MinMeleeDmg` is
its **alternative** source, used only when `DamageMultiplier < 0 || ArmorMultiplier < 0`
(zero rows in either the Classic or TBC DB); their `UpdateDamagePhysical` multiplies by the
runtime `m_damageMultiplier`, never by the template field. Folding them double-counts. It
stayed invisible for a year because cmangos shipped `DamageMultiplier = 1.0` for every row
until ~2026-07 — then started computing real values (1.4–2.6, max 260) and every NPC's
listed damage/DPS on both cmangos datasets inflated by that factor overnight. The adapter
now stages a literal `1.0` (a `DERIVE` entry, not a rename), leaving build-db's fold
source-agnostic. **Upstream data can change meaning without changing shape — when a
number looks off by a suspiciously clean-ish factor, diff the source column against an
older release before assuming our derivation drifted.**

**Known upstream gap:** cmangos's TBC-DB has no Outland spawns for Fel Iron / Adamantite /
Khorium — they exist only inside Coilfang/Auchindoun. Outland herbs are complete. Not a
build bug; the nodes are correctly flagged `gather='mining'` and simply have no
`gameobject` rows on map 530.

### Ratings, gems and gear scoring (TBC)

**Where a stat lives moved between expansions, and reading only one place loses most of
TBC's itemisation.** 1.12 keeps base stats/resistances/armor in `item_template` columns and
everything else (crit, hit, AP, …) in EQUIP-spell auras. TBC put the combat *ratings* back
onto the **columns** as `stat_type` 12–45. `statsFromColumns` mapped only the five 1.12
primaries, so ~4,700 TBC rating rows were silently dropped — resilience, crit, spell crit,
hit, defense, haste, expertise — and TBC gear scored nearly blind. It now folds in
`ITEM_MOD_STAT` (`COLUMN_STAT_KEY`); a vanilla item never sets those ids (measured: one
stray `Health` row across all of Turtle), so the vanilla datasets are bit-identical.
`resil`/`expertise` are new GEAR_CRITERIA keys, added **TBC-only** so a 1.12 filter
dropdown doesn't grow permanently-empty options. Armor/spell penetration stay unmapped —
no 1.12 counterpart to score against.

**The stat keys are shared but the UNITS are not**, which is why `STAT_WEIGHT_PRESETS`
forks on `EXPANSION`. A vanilla `crit: 14` means "per 1% crit"; a TBC item carries +20 crit
*rating*, so the vanilla set doesn't degrade on TBC, it mis-ranks by ~20×. The TBC presets
are written in the same per-1% terms and divided by one `RATING_CONV` table (level-70
constants), so both sets stay comparable and the conversion is auditable in one place.
Ids are reused where a spec exists in both, so saved builds and `?weights=` links keep
resolving. `expertise` uses 15.77, **not** the familiar 3.94: 3.94 rating = 1 expertise,
but 1 expertise = 0.25% of attacks undodged, so a full 1% costs 15.77 — using 3.94 would
value it 4× over. Landing on hit's number is the result, not a coincidence.

**Gems** (`enchant_text.stats`, `gem_properties`). A socketed gem and an item's socket
bonus are both `SpellItemEnchantment` rows, whose DBC carries three `(type, amount, arg)`
triples — now extracted (`eff`) alongside the display text. Type 5 is a stat (arg =
ITEM_MOD id), type 4 a resistance, and **type 3 is a SPELL** — which most TBC gems are, so
"+8 Spell Damage" is spell 9398, not a parseable stat line. Type 3 resolves through the
very same `statsFromAuras` that builds `item_stats`, so a gem and an item granting the same
effect can't disagree. Two traps: an enchant may store one displayed rating under several
per-attack-type ITEM_MODs (2735 "+8 Critical Strike Rating" = melee-crit 8 **and**
ranged-crit 8), so ITEM_MOD contributions are a per-key **max**, not a sum; and base-stat
gems are aura 29 (MOD_STAT), which `AURA_STAT` never needed — it's behind a `baseStats`
opt-in that only the enchant pass uses, because ~120 Turtle / ~170 TBC items also carry
that aura and enabling it for `item_stats` would move their scores. ~95% of gems derive
real stats; the rest are procs or stats with no criteria key, and still show their text.
The character sheet counts gems in **totals** but not in the upgrade finder's baseline —
scoring a gemmed item against un-gemmed candidates would hide upgrades you'd re-socket.

**Share + JSON links are main-only** (`config.js` `HAS_OG_API`). The unfurl Worker and the
public JSON API are both generated from the MAIN dataset's DB, and an entry id is not a
shared namespace: item 23425 is Adamantite Ore on TBC and absent from Turtle entirely, so
off `main` those links answer about a different game -- the API returns a Cloudflare 404
HTML page (not JSON) and the unfurl degrades to a generic site card. So on other datasets
the Share button copies the plain in-app URL (built from `location.pathname`, NOT
`BASE_URL`, so it keeps the `/tbc/cmangos/` directory) and the JSON button isn't rendered.
This costs `dev` its rich unfurl, which is the right trade: it previously handed out links
that sent the recipient to main's copy of the page. Real coverage for the other rows means
per-dataset build targets + R2 prefixes + Worker routing (a known parity gap, see
notes/plan-content-origin-and-variants.md).

**Creature thumbnails are per-dataset**, via `config.js` `WEBTHUMB_BRANCH` /
`OWN_MODEL_THUMBS` (and the new registry field `core`, "turtle" | "cmangos" -- distinct
from `expansion`, since vanilla/cmangos is 1.12 content but not Turtle). A display_id is
NOT a shared namespace across games, which breaks `modelThumbUrl` two ways on TBC: Wowhead
serves a separate webthumb set per branch and the TBC ids 404 on `classic` (measured: only
60% of sampled TBC display_ids resolve there vs 100% on `tbc`), and our OWN renders are
Turtle-client models, so serving them on TBC would show a confidently wrong creature --
1,007 TBC display_ids collide with a Turtle-custom render (display 21015 is Turtle's
"Keeper Blackforge" but TBC's "Garek"). Hence: own renders only when `core === "turtle"`,
Wowhead branch from `EXPANSION`. vanilla/cmangos collides on just 2, but is gated the same
way for the same reason. The `render-model-thumbs.py` worklist is likewise Turtle-scoped.

**"Obtainable" for the upgrade finder** is four conditions, and one was a trap:
`'unobtainable'` is itself an `item_sources` row, so the finder's `EXISTS (… item_sources …)`
check treated *being flagged junk* as proof of a source and let every test/placeholder item
through. It now also requires `hidden = 0`, no `unobtainable` row, and
`duration = 0` — `duration` is a self-destruct timer, i.e. encounter props rather than gear
(Kael'thas' Warp Slicer & co at 15 min, Andonisus at 5, the Hallow's End masks). 35 such
equippable items on TBC, all correctly caught, no permanent gear affected.

### Binary assets live on R2, not git

Client-derived **image** trees are no longer committed. CI still can't regenerate them
(no game client), but committing them cost ~74 MB / 6.5k files and every new matrix row
(`vanilla/cmangos`, `tbc/cmangos`, …) multiplied it. **R2 is now their source of truth.**

| set | R2 prefix / local dir |
|---|---|
| zone parchments | `maps/`, `maps-<dataset>/` |
| minimap pyramids | `minimap/`, `minimap-<dataset>/` |
| creature model thumbs | `model-thumbs/` |
| converted 3D models + textures | `model3d/` |
| extracted game audio | `sounds/`, `sounds-<dataset>/` |

- `scripts/lib/assets.mjs` defines the sets; `scripts/data/assets-manifest.json`
  (committed, ~1.2 MB) indexes every file as `[sha256-12, size]`. It jumped from ~250 KB
  when the audio sets landed — 10.7k more files at ~1.8 GB, which is now the bulk of both
  the manifest and the R2 bucket.
- `bun run assets` downloads them (hash-verified on arrival — a truncated tile is worse
  than a missing one). Needed only for a LOCAL run that should show maps.
- `bun run publish` rescans + uploads after an `extract-*.py` run, then rewrites the
  manifest. Uploads go straight to R2's S3 API, signed in-process by `scripts/lib/r2.mjs`
  (SigV4 via `node:crypto`) — **no `aws` CLI and no SDK**: the CLI spawns a process per
  object, unusable for a 3.5k-file tile pyramid. Needs `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (`R2_BUCKET` optional). Only files whose
  hash differs from the committed manifest upload, so a re-run resumes; `--dry-run`,
  `--only <sets>` (prefix match), `--force`, `--manifest-only`.
- **CI never syncs these.** The old `aws s3 sync … --delete` steps were removed from
  `deploy.yml` and `deploy-cmangos.yml`: run against a checkout that no longer has the
  files, `--delete` would erase the whole set off R2. `publish-assets.mjs` likewise never
  passes `--delete`, and reports files that vanished locally rather than deleting them.
- **There is no second copy.** Enable R2 object versioning, or keep the extractor outputs
  archived somewhere, before treating this as durable. (Old revisions do remain in git
  history, which is why `git rm --cached` didn't shrink the ~318 MB `.git`.)
- Still committed: `assets/icons/custom/` (the *source* the atlas is packed from) and
  `public/icons/` (0.95 MB — `config.js` `getAtlasUrls()` keeps a Pages origin in its
  fallback chain, which only works if they ship in the Pages artifact).

## Gotchas

- **Don't commit built data.** It's regenerated by CI from the server repo. The
  the exceptions are **client-derived** assets CI can't regenerate, so they're
  committed: custom icons (`assets/icons/custom/`, `public/icons/custom-atlas.*`,
  `scripts/data/item-display-supplement.json`, `scripts/data/spell-icon-map.json`,
  `scripts/data/spell-lookups.json`), zone bounds
  (`scripts/data/zones.json` — the parchment *images* are R2-only, see above),
  per-area ADT bounds (`scripts/data/subzone-bounds.json`
  via `extract-area-bounds.py`, for exact coord→zone) plus the WMO interior boxes
  (`scripts/data/wmo-areas.json` via `extract-wmo-areas.py`, the area the game names
  INSIDE a cave/building — see "Interiors"), and the "minimap" POI sprite
  sheet `public/icons/poi-atlas.webp` (16-col, 32px grid; sourced from the
  WowClassicGrindBot atlas). `Elite` at [11,14] is the boss-marker skull; the zone +
  world map markers and the layer-control legend draw their per-category icons from
  it via the `CAT_ICON`/`OBJ_ICON` cell map in `src/zonemap.js` (cells verified
  against the art -- the upstream `icon_atlas.js` names are unreliable). Plus
  item-set names + bonus spells + membership (`scripts/data/item-sets.json` via
  `extract-item-sets.py`, from the client `ItemSet.dbc`; each set carries its DBC
  `ItemID_*` member list, and build-db **corrects `items.set_id` to it** —
  authoritative over the server dump's `item_template.set`, which mis-groups some
  re-itemized/orphaned pieces into the wrong set, issue #319), and skill-line categories
  (`scripts/data/skill-lines.json` via `extract-skill-lines.py`, from the client
  `SkillLine.dbc`; build-db joins these onto `skill_line_ability` to set
  `spells.category` for the browse filter), gather-node skills
  (`scripts/data/locks.json` via `extract-locks.py`, from the client `Lock.dbc`;
  maps a gameobject's `data0` lockId -> `mining`/`herbalism` so build-db sets
  `gameobjects.gather`, splitting veins/herbs out of the map's `Obj: Chest` bucket),
  and hunter-pet family metadata (`scripts/data/creature-families.json` via
  `extract-creature-families.py`, from the client `CreatureFamily.dbc`: family id ->
  name + diet/PetFoodMask + ability skill line + icon; plus the curated
  `scripts/data/pet-families.json` = per-family role + Health/Armor/Damage stat
  modifiers + shared-ability membership. build-db ingests `creature_template.beast_family`
  + the `type_flags` TAMEABLE bit, then derives the `pet_families` / `pet_ability` /
  `pet_ability_rank` / `pet_ability_spell` / `pet_family_ability` tables — the ability
  catalog comes from the shipped `spells` table (skill 261 "Beast Training" holds one
  empty "learn" stub per rank; build-db resolves each to the REAL cast spell in a family
  skill line for a real tooltip) + each family's own skill line, so TW-custom families
  (Serpent/Fox/Moth) and their custom abilities are covered automatically. `pet_ability_spell`
  maps every pet-ability spell entry → ability/rank/level so the spell page shows a "tame a
  beast to learn this rank" panel. Powers `?pets` / `?petfamily=<id>`, the NPC-page
  "Tameable" badge, and the pet-ability spell-page panel),
  and the seamless-world-map transform
  manifest (`scripts/data/minimap.json` via `extract-minimap.py`; the tile pyramid
  itself is R2-only, NOT committed — see "Binary assets live on R2"). Plus talent-tree
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
  server `src/`); re-run on scriptdev changes. Plus the vanilla-1.12 id allowlist +
  `edited` field-diff set (`scripts/data/vanilla-ids.json` via `extract-vanilla-ids.mjs`,
  from the cmangos Classic SQLite DB + a diff of the built Turtle DB): build-db flags
  items/creatures/quests `custom = id NOT IN vanilla OR id IN edited` — the `edited` set
  catches Turtle's in-place repurposes/rebalances of vanilla ids (items = name/gameplay
  diff, creatures/quests = name/title diff), applied only to Turtle builds. Falls back to
  an id threshold if the JSON is absent. Committed (CI has no cmangos DB); re-run on a new
  cmangos Classic DB release or material Turtle world-data change.
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
  **Terrain is only half of it** — inside a cave or a building the client reads the
  area off the WMO instead, and that answer routinely differs from the ground over it.
  See "Interiors" below; `wmo-areas.json` is consulted first, terrain second.
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

**Asset origin is a repo variable.** The Build-site step reads
`vars.ASSET_BASE_URL` (Actions → Variables) for `VITE_DATA_BASE`/`_DEV`/
`VITE_ASSETS_BASE`; unset falls back to the rate-limited `pub-*.r2.dev` public URL.
Set it to an R2 **custom domain** (e.g. `https://cdn.tortoiseclothing.org`, no
trailing slash) to drop the r2.dev throttling — after the custom domain's SSL is
Active in the R2 dashboard, and with the bucket **CORS policy** allowing the site
origins (the custom domain uses bucket CORS, unlike the permissive r2.dev default).
The S3-API upload steps still target the `tortoise-db-viewer` bucket directly and
are unaffected.

**World-map tiles do NOT sync via CI** — they aren't in the repo (see "Binary assets
live on R2"), so CI has nothing to upload and, critically, must not try: the old sync
passed `--delete` and would wipe the set off R2 from an empty checkout. The frontend
reads `${VITE_ASSETS_BASE}minimap/<map>/{z}/{x}/{y}.webp`; the committed
`scripts/data/minimap.json` (bundled by Vite) supplies the transform. Re-run
`extract-minimap.py` on client map changes, then `bun scripts/publish-assets.mjs`.

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
- **Changelog (`?changelog`):** each `deploy-dev` run diffs the freshly-built DB
  against the previous one (downloaded from R2) via `scripts/build-changelog.mjs`
  (`ATTACH` + anti-joins over content tables + `spawn_points` deltas — NOT `sqldiff`,
  which drowns in VACUUM/FTS/stat noise), then prepends a dated section to an
  accumulated `data-dev/changelog.json`. The `?changelog` view (`showChangelog` in
  `main.js`) fetches `${DATA_BASE}changelog.json` (dataset-aware) and links each
  entity. Dev-only for now; the main dataset has no file and shows a pointer to the
  Dev view (the 404 is benign — the view handles it). A footer "What's new" link
  (relative, so it stays on the active dataset) opens it.
