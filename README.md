# Tortoise-WoW Item Database

A fast, static, octowow-style item database for [Tortoise-WoW](https://github.com/Penqle/tortoise-wow),
hosted on GitHub Pages. Item pages, drop sources, vendors, quests, disenchanting,
crafting — all queried client-side from a single SQLite file over HTTP range requests.

**Why it's fast:** there is no backend. The SQL dumps are compiled at build time into
one indexed SQLite file. In the browser, [sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs)
reads only the few KB of B-tree pages each query touches via HTTP `Range` requests,
so opening an item downloads a fraction of the 27 MB database. App code is ~9 KB gzipped
vanilla JS; the WASM engine (~500 KB gzipped) loads once and is cached.

## Architecture

```
SQL dumps (../tortoise-wow/sql/base/*.sql)
        │  scripts/build-db.mjs   (parse + normalize + index)
        ▼
public/data/tortoise.sqlite  ──HTTP range──▶  browser (sql.js-httpvfs)
                                                   │  src/queries.js (joins, recursive loot refs)
                                                   ▼
                                              src/render.js  (tooltip + relation panels)
```

Tables mirrored into SQLite: `items`, `spells` (+ crafting graph), `creatures`,
`gameobjects`, `npc_vendor`, all loot tables (`loot_creature`, `loot_object`,
`loot_item`, `loot_disenchant`, `loot_skinning`, `loot_pickpocket`, `loot_reference`),
plus build-time link tables `quest_item`, `spell_creates`, `spell_reagent`, and an
FTS5 index `items_fts` for name search. Joins (including recursive loot-reference
resolution) run in the browser via `src/queries.js`.

## Develop

```sh
npm install
SQL_DIR="X:/Programming/tortoise-wow/sql/base" npm run build:db   # -> public/data/tortoise.sqlite
npm run dev            # http://localhost:5173/tortoise-wow-database/
```

`SQL_DIR` defaults to `../tortoise-wow/sql/base` (the server repo next to this one),
so if both repos sit side by side you can just run `npm run build:db`.

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

`.github/workflows/deploy.yml` builds and deploys automatically on push to `main`:
it sparse-checks out the server repo's `sql/base`, builds the SQLite file, runs
`vite build`, and publishes `dist/` to Pages. The database is **not** committed —
it is regenerated in CI.

One-time setup: repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.

If the repo name differs from `tortoise-wow-database`, set the Vite base path
accordingly (env `BASE_PATH`, e.g. `/` for a custom domain or user site).

## Test

```sh
node scripts/test-queries.mjs 7909   # validate relation SQL against the built DB
npm run build && node scripts/smoke.mjs   # headless end-to-end (needs Chrome/Edge)
```
