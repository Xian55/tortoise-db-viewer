# Tortoise-WoW Item Database

A fast, static, octowow-style item database for [Tortoise-WoW](https://github.com/Penqle/tortoise-wow),
hosted on GitHub Pages. Item pages, drop sources, vendors, quests, disenchanting,
crafting — all queried **in the browser** with the official SQLite WASM build.

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

Routes: `?item=<id>` for an item page, `?search=<term>` for search.

## Icons

Item icon names are not in the SQL dumps — they live in the client's
`ItemDisplayInfo.dbc`. Extract that file from your Turtle client (its patch MPQs
hold the custom item icons) and run:

```sh
ITEMDISPLAYINFO_DBC="X:/path/ItemDisplayInfo.dbc" node scripts/build-icons.mjs
```

This writes `public/data/icons.json` (`display_id → icon name`). Icons are served
from the Blizzard render CDN (`render-us.worldofwarcraft.com/icons/56/<name>.jpg`).
Without `icons.json`, items show a placeholder icon — everything else still works.

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` builds and deploys on push to `main`: it
sparse-checks out the server repo's `sql/base`, builds the SQLite file with Bun,
runs `vite build`, and publishes `dist/` to Pages. The database is **not**
committed — it is regenerated in CI.

One-time setup: repo **Settings → Pages → Source: GitHub Actions**.

The Vite base path defaults to `/tortoise-db-viewer/` (the repo name). For a
custom domain or user site, override with env `BASE_PATH=/`.

## Test

```sh
node scripts/test-queries.mjs 7909        # validate relation SQL against the built DB
npm run build && node scripts/smoke.mjs   # headless end-to-end (needs Chrome/Edge)
# live: SMOKE_BASE="https://<user>.github.io/<repo>/" node scripts/smoke.mjs
```
