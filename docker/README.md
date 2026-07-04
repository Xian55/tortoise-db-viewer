# Self-hosting with Docker

Run the Tortoise-WoW DB viewer on your own box — a private-server mirror, an
offline archive, or a LAN copy that never touches GitHub Pages / R2.

## What's in the image

The image is the **static app shell only**: `index.html`, the hashed
JS/CSS/WASM bundle, and the small committed icon atlases. It is a few MB.

The **heavy assets are NOT baked in** and are served from a volume you mount at
`/assets`:

| Path                | Size  | Source                                         |
| ------------------- | ----- | ---------------------------------------------- |
| `data/tortoise.sqlite` | ~34 MB | built by `scripts/build-db.mjs`             |
| `data/version.json` | tiny  | built by `scripts/build-db.mjs`                |
| `maps/*.webp`       | ~19 MB | committed in the repo (`public/maps`)         |
| `minimap/**`        | ~23 MB | committed in the repo (`public/minimap`)      |
| `tt/**` (optional)  | ~small | `scripts/build-tooltips.mjs` — embed widget only |

The app is built with base `/` and no `VITE_*_BASE`, so `src/config.js` resolves
every asset **same-origin** (`/data/`, `/maps/`, `/minimap/`, `/icons/`). nginx
maps `/data`, `/maps`, `/minimap` to the mounted volume; `/icons` is baked in.

## 1. Produce the assets

The DB isn't committed (it's generated); the map/minimap tiles are committed.
Build the DB and gather the tree once:

```sh
git clone https://github.com/Xian55/tortoise-db-viewer
cd tortoise-db-viewer
bun install
bun scripts/build-db.mjs          # writes public/data/tortoise.sqlite + version.json
```

`public/` now contains `data/`, `maps/`, `minimap/` — that's your assets tree.
Mount `public/` directly, or copy those three dirs somewhere dedicated:

```sh
mkdir -p /srv/tortoise-db
cp -r public/data public/maps public/minimap /srv/tortoise-db/
```

> `build-db.mjs` needs the server SQL dumps. `SQL_DIR` defaults to
> `../tortoise-wow/sql/base` and `UPDATES_DIR` to its sibling
> `sql/database_updates`. See the top-level `CLAUDE.md` / `README.md`.

**Optional — embeddable tooltips.** The `public/embed/tw-power.js` widget (for
Wowhead-style hover tooltips on third-party pages) fetches per-entity JSON from
`/tt/`. It's off by default; generate the data into the volume to enable it:

```sh
OUT_DIR=public bun scripts/build-tooltips.mjs   # writes public/tt/**
```

nginx serves `/tt/` from the volume with permissive CORS. Absent ⇒ the widget
degrades gracefully (no tooltip). The `public/embed/demo.html` page exercises it.

## 2. Run it

### docker compose (local build)

From the repo root — builds the shell and mounts `public/` (run `build-db`
first so `public/data` exists):

```sh
docker compose up -d --build
# -> http://localhost:8080/
```

### docker run (published image)

```sh
docker run -d -p 8080:80 \
  -v /srv/tortoise-db:/assets:ro \
  --name tortoise-db \
  ghcr.io/xian55/tortoise-db-viewer:latest
```

### Portainer stack

Use `docker/portainer-stack.yml` — paste it into **Stacks → Add stack → Web
editor**, set the `ASSETS_DIR` env var to your host assets path (default
`/srv/tortoise-db`), and deploy. It pulls the GHCR image (Portainer can't build
from a local context).

## Notes

- **Ports:** container listens on `80`; the examples publish it on `8080`. Put a
  reverse proxy (Caddy/Traefik/nginx) in front for TLS if exposing it.
- **DB download size:** the browser fetches the whole `.sqlite` once, then caches
  it in OPFS. To cut first-load bandwidth, precompress and serve it statically —
  see the `gzip_static` note in `docker/nginx.conf`.
- **Updates:** rebuild the DB (`bun scripts/build-db.mjs`) and refresh the volume;
  `version.json` changes its hash so clients auto-invalidate their OPFS cache.
- **No client needed at runtime.** Icons/maps/minimap were extracted from the
  game client at build time and are committed; the container serves them as-is.
