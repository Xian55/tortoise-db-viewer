# Tortoise-WoW Item Database

A fast, static, octowow-style item database for [Tortoise-WoW](https://github.com/Penqle/tortoise-wow),
hosted on GitHub Pages. Item pages, NPC pages, drop sources, vendors, quests,
disenchanting, crafting, and filterable browse/finder pages for items and NPCs —
all queried **in the browser** with the official SQLite WASM build.

Routes: `?item=<id>`, `?npc=<id>`, `?browse=items` / `?browse=npcs` (with filter
query params, e.g. `?browse=items&class=2&quality=4&minrl=40`), `?search=<term>`.

**Live:** https://xian55.github.io/tortoise-db-viewer/

## How it works

The server's SQL dumps are compiled at build time into one indexed SQLite file.
The browser downloads that file once (GitHub Pages gzips it, ~27 MB → ~8.6 MB on
the wire) and loads it into [`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm).
Every query — including the recursive loot-reference resolution and substring
search — then runs locally with zero further network round-trips.

The DB is persisted to **OPFS** (SAHPool VFS, no COOP/COEP headers required) so
repeat visits skip the download; browsers without OPFS fall back to an in-memory
copy (the file is HTTP-cached, so repeat visits are still fast).

> Why not HTTP range requests (sql.js-httpvfs)? GitHub Pages gzips responses
> including `206` partials, and `Content-Range` then reports the *compressed*
> size — so byte-range reads return corrupt data. A full download sidesteps this
> entirely (gzip is transparent), and an in-memory DB makes every query instant.

```
SQL dumps (../tortoise-wow/sql/base/*.sql)
        │  scripts/build-db.mjs   (parse + normalize + index)
        ▼
public/data/tortoise.sqlite  ──one gzip'd download──▶  browser (sqlite-wasm + OPFS)
                                                          │  src/queries.js
                                                          ▼
                                                     src/render.js (tooltip + relations)
```

Tables mirrored into SQLite: `items`, `spells` (+ crafting graph), `creatures`,
`gameobjects`, `npc_vendor`, all loot tables (`loot_creature`, `loot_object`,
`loot_item`, `loot_disenchant`, `loot_skinning`, `loot_pickpocket`,
`loot_reference`), plus build-time link tables `quest_item`, `spell_creates`,
`spell_reagent`. Joins (incl. recursive loot-reference resolution via a CTE) run
in the browser from `src/queries.js`.

## Develop

Runs on **Bun** or **Node** — the build script auto-detects the runtime (Bun
uses native `bun:sqlite`, Node uses `better-sqlite3`, an optional dependency).

```sh
# Bun (no native compile)
bun install
bun scripts/build-db.mjs        # -> public/data/tortoise.sqlite
bun run dev                     # http://localhost:5173/tortoise-db-viewer/

# Node
npm install
npm run build:db
npm run dev
```

`SQL_DIR` defaults to `../tortoise-wow/sql/base` (the server repo next to this
one). Override it: `SQL_DIR="X:/path/sql/base" bun scripts/build-db.mjs`.

## Icons

Icon names come from the repo's `item_display_info` table (`display_id → icon`),
which is mirrored into the DB. Every query that returns an item LEFT JOINs it, so
item names show their icon everywhere (tooltip, search, relation lists) with no
extra request — the name is already loaded with the DB. Images are lazy-loaded
(`<img loading="lazy">`) from the Blizzard render CDN
(`render-us.worldofwarcraft.com/icons/56/<name>.jpg`) and fall back to a
placeholder on a 404.

Custom Turtle displays absent from `item_display_info` show the placeholder; add
their icons by extending that table in the source data.

Spell icons work the same way. The server `spell_template` stores only a numeric
`spellIconId`; `scripts/extract-spell-icons.py` resolves it to a texture basename
via the client `SpellIcon.dbc`, written to a committed
`scripts/data/spell-icon-map.json` that build-db joins onto `spells.icon`. Spells
share the `Interface\Icons` pool with items, so standard spell icons load from the
same CDN; only custom Turtle spell icons are packed into the atlas. Without the
map, spell links render as clean text.

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` builds and deploys on push to `main`: it
sparse-checks out the server repo's `sql/base`, builds the SQLite file with Bun,
runs `vite build`, and publishes `dist/` to Pages. The database is **not**
committed — it is regenerated in CI.

One-time setup: repo **Settings → Pages → Source: GitHub Actions**.

The Vite base path defaults to `/tortoise-db-viewer/` (the repo name). For a
custom domain or user site, override with env `BASE_PATH=/`.

## Self-host (Docker)

Run your own copy — an offline archive, a private-server mirror, or a LAN box
that never touches GitHub Pages / R2. The published image is the **static app
shell only** (built with base `/`, same-origin asset resolution); the heavy,
data-derived assets (the built DB, zone maps, minimap tiles) are served from a
**volume mounted at `/assets`**, so the image stays small.

```sh
# 1. Build the DB, then serve the shell + your public/ assets
bun scripts/build-db.mjs
docker compose up -d --build          # -> http://localhost:8080/

# ...or pull the prebuilt shell and point a volume at your assets
docker run -d -p 8080:80 -v /srv/tortoise-db:/assets:ro \
  ghcr.io/xian55/tortoise-db-viewer:latest
```

Full setup — asset layout, `docker run` / **Portainer** stack, the optional
embeddable-tooltip (`/tt`) step, and TLS notes — is in
[`docker/README.md`](docker/README.md).

## Test

```sh
node scripts/test-queries.mjs 7909        # validate relation SQL against the built DB
npm run build && bun run smoke            # headless end-to-end, parallel (needs Chrome; bun test)
# one topic / one test:  bun run smoke -- item      |  bun run smoke:test -t "item 7909"
# live: SMOKE_BASE="https://<user>.github.io/<repo>/" bun run smoke
```

## Data sources & licenses

Datasets are built from third-party sources — see [`NOTICE.md`](NOTICE.md) for the full attribution.

- **`vanilla/cmangos` dataset** and `scripts/data/vanilla-ids.json` are **derived from
  [cMaNGOS classic-db](https://github.com/cmangos/classic-db)**, licensed **GPL v3**. Its
  license and copyright notice are vendored verbatim in
  [`third_party/cmangos-classic-db/`](third_party/cmangos-classic-db/); the corresponding source
  for the derived data is this repository (`scripts/build-db.mjs` with `SQL_SOURCE=cmangos`).
  These notices must not be removed from redistributed copies.
- **main / dev datasets** are built from the Turtle-WoW server SQL dumps
  ([Penqle/tortoise-wow](https://github.com/Penqle/tortoise-wow)).
- **Blizzard content** (client-extracted maps, icons, talents, DBC tables) is © Blizzard
  Entertainment / its licensors, used non-commercially for fan reference only — not affiliated
  with or endorsed by Blizzard.
