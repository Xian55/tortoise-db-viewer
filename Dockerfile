# syntax=docker/dockerfile:1

# Tortoise-WoW DB viewer — self-host image.
#
# This image ships ONLY the static app shell (index.html + hashed JS/CSS/WASM +
# the small committed icon atlases). The heavy runtime assets — the built SQLite
# DB, zone maps, and the minimap tile pyramid — are NOT baked in; they are served
# from a volume mounted at /assets (see docker/README.md and docker-compose.yml).
#
# The app is built with base "/" and no VITE_*_BASE, so src/config.js resolves
# every asset same-origin (/data/, /maps/, /minimap/, /icons/). nginx maps the
# first three to the mounted volume.

# ---- build stage: compile the static shell ----------------------------------
FROM oven/bun:1 AS build
WORKDIR /app

# Install deps first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source. .dockerignore keeps public/{data,maps,minimap} OUT of the context,
# so vite never bakes the heavy assets into dist/.
COPY . .

# Self-host build: same-origin asset resolution.
ENV BASE_PATH=/
RUN bunx --bun vite build

# ---- serve stage: nginx ------------------------------------------------------
FROM nginx:alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Heavy assets are bind/volume-mounted here at runtime.
VOLUME ["/assets"]
EXPOSE 80
