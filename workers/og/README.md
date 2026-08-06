# og.tortoiseclothing.org — link-unfurl Worker

Renders the per-entity Open Graph page for a share link, **on demand**.

## Why

The site is a query-param SPA on GitHub Pages, so a crawler that sees `?item=19019`
only gets `index.html`'s generic `<meta>` — crawlers don't run JS, and a static host
can't vary a file by query string.

That used to be solved by prerendering one tiny HTML file per entity into the Pages
artifact: **94,930 files**. Pages syncs an artifact file-by-file, so that alone took
15–20 min and routinely timed the deploy out (`actions/deploy-pages` burned its full
10-minute timeout on attempt 1 of every run). Narrowing the stub set to 59,744 cut the
sync to ~4 min; moving them here removes the file-count ceiling entirely — the artifact
drops to ~6k files.

## How it works

`https://og.tortoiseclothing.org/<prefix>/<id>` → OG meta + redirect into the app.

| prefix | entity | metadata source |
|---|---|---|
| `i` `n` `q` `s` | item, NPC, quest, spell | the JSON API already on R2 (`api.tortoiseclothing.org/<prefix>/<id>`) — **always in sync with the DB, no build step** |
| `o` `z` `f` `is` | object, zone, faction, item set | `og-extra.json`, bundled (1,860 entries, ~107 KB) — these four have no API |

Humans get an instant redirect; crawlers read the meta and never follow. An unknown id
still redirects (with the generic site card) rather than 404ing — **a shared link must
always open**.

Output is byte-identical to the stubs it replaces; verified against the live
prerendered page for item 19019 (`Legendary One-Handed Sword · Item Level 80`).

## Deploying

```sh
cd workers/og
wrangler deploy
```

`wrangler.toml` declares `og.tortoiseclothing.org` as a `custom_domain`, so Cloudflare
manages the DNS record — no manual entry needed.

## Regenerating og-extra.json

Only needed when objects / zones / factions / item sets change (i.e. a server data
change). Items, NPCs, quests and spells are read live from the API and never go stale.

```sh
OG_MAP_OUT=workers/og/og-extra.json bun scripts/build-og.mjs
cd workers/og && wrangler deploy
```

## Related

- `src/config.js` `OG_BASE` — the origin the Share button hands out.
- `public/404.html` — recovers `<prefix>/<id>` on the **Pages** origin, so links shared
  before this move (and any stub that no longer exists) still open the right page.
- `scripts/build-og.mjs` — still able to prerender stubs (`OUT_DIR=…`) if this is ever
  reverted; `OG_MAP_OUT=…` is the mode that feeds this Worker.
