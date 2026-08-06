// Shared definitions for the R2-hosted asset sets.
//
// These trees are CLIENT-derived: CI can't rebuild them (no game client), so they used
// to be committed. That grew to ~74 MB / 6.5k binary files, and every new dataset row
// (vanilla/cmangos, tbc/cmangos, ...) multiplies it. They now live ONLY on R2 and are
// pulled on demand with `bun run assets` (scripts/fetch-assets.mjs); the committed
// manifest below is the index of what exists and how to verify it.
//
// NOT in here (deliberately still committed):
//   assets/icons/custom/   the SOURCE the shipped atlas is packed from (1.9 MB) -- a
//                          clean clone must be able to run build-atlas.py
//   public/icons/          the packed atlas + poi/class icons (0.95 MB). config.js
//                          getAtlasUrls() keeps a Pages origin in its fallback chain,
//                          which only works if these ship in the Pages artifact.

import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// set name -> { dir (repo-relative), prefix (R2 key prefix) }. Name == prefix today,
// but keep them separate so a set can be relocated without rewriting the manifest.
export const ASSET_SETS = {
  maps: { dir: "public/maps", prefix: "maps" },
  minimap: { dir: "public/minimap", prefix: "minimap" },
  "maps-vanilla-cmangos": { dir: "public/maps-vanilla-cmangos", prefix: "maps-vanilla-cmangos" },
  "minimap-vanilla-cmangos": { dir: "public/minimap-vanilla-cmangos", prefix: "minimap-vanilla-cmangos" },
  "maps-tbc-cmangos": { dir: "public/maps-tbc-cmangos", prefix: "maps-tbc-cmangos" },
  "minimap-tbc-cmangos": { dir: "public/minimap-tbc-cmangos", prefix: "minimap-tbc-cmangos" },
  "model-thumbs": { dir: "public/model-thumbs", prefix: "model-thumbs" },
};

/** Content-Type by extension. Everything here is webp except a couple of manifests. */
export function contentType(rel) {
  if (rel.endsWith(".webp")) return "image/webp";
  if (rel.endsWith(".json")) return "application/json";
  if (rel.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

/** Tile pyramids are content-addressed by path and never rewritten -> cache forever. */
export const cacheControl = (setName, rel) =>
  (setName.startsWith("minimap") ? "public,max-age=31536000,immutable"
    : rel.endsWith(".json") ? "public,max-age=300"
      : "public,max-age=604800");

export const MANIFEST_PATH = join(ROOT, "scripts", "data", "assets-manifest.json");

// Default origin. Overridable with ASSET_BASE_URL (same var deploy.yml reads), so a
// fork can point at its own bucket without editing the committed manifest.
export const DEFAULT_BASE = "https://cdn.tortoiseclothing.org";
export const assetBase = () => (process.env.ASSET_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");

/** sha256, truncated -- 12 hex is ~2^48 of collision headroom over 7k files. */
export const HASH_LEN = 12;
export const hashBuf = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, HASH_LEN);
export const hashFile = (p) => hashBuf(readFileSync(p));

/** Every file under `dir`, as forward-slash paths relative to it. Sorted (stable diffs). */
export function walk(dir) {
  const out = [];
  const rec = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(relative(dir, p).replace(/\\/g, "/"));
    }
  };
  rec(dir);
  return out.sort();
}

export function readManifest() {
  try { return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")); } catch { return null; }
}

/** Build a manifest entry for one set from what's on disk. files: { rel: [hash, size] } */
export function scanSet(name) {
  const set = ASSET_SETS[name];
  const abs = join(ROOT, set.dir);
  const files = {};
  for (const rel of walk(abs)) {
    const p = join(abs, rel);
    files[rel] = [hashFile(p), statSync(p).size];
  }
  return { dir: set.dir, prefix: set.prefix, files };
}

export function resolveSets(only) {
  if (!only) return Object.keys(ASSET_SETS);
  const want = only.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = want.filter((w) => !ASSET_SETS[w]);
  if (bad.length) {
    console.error(`unknown asset set(s): ${bad.join(", ")}\nknown: ${Object.keys(ASSET_SETS).join(", ")}`);
    process.exit(1);
  }
  return want;
}

export const fmtBytes = (n) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
