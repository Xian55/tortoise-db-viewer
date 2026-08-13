#!/usr/bin/env bun
/**
 * Download the R2-hosted asset sets (zone parchments, minimap tile pyramids, creature
 * model thumbnails) into public/.
 *
 * These are client-derived and no longer committed -- see scripts/lib/assets.mjs. The
 * site itself always loads them from R2, so you only need this for a LOCAL run that
 * should show maps: `bun run dev`, `bun run smoke`, `bun run audit`. CI does not need it.
 *
 *   bun run assets                      # the default sets (~110 MB, ~10k files)
 *   bun run assets -- --only sounds     # one set (see scripts/lib/assets.mjs)
 *   bun run assets -- --all             # default sets PLUS the optional ones
 *   bun run assets -- --verify          # re-hash local files instead of size-only
 *   bun run assets -- --force           # re-download everything
 *
 * The extracted game AUDIO (`sounds`, `sounds-tbc-cmangos`) is `optional` and NOT part of
 * a bare run: it is 1.86 GB, ~25x every other set combined, and a local run only needs it
 * to hear a clip -- whereas without maps a zone page doesn't render at all. Ask for it by
 * name, or with --all.
 *
 * Env: ASSET_BASE_URL to point at a different origin (default cdn.tortoiseclothing.org).
 */
import { mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  ROOT, MANIFEST_PATH, assetBase, hashBuf, readManifest, resolveSets, fmtBytes,
} from "./lib/assets.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const FORCE = flag("force"), VERIFY = flag("verify");
const CONCURRENCY = Number(opt("concurrency")) || 16;

const manifest = readManifest();
if (!manifest) {
  console.error(`No asset manifest at ${MANIFEST_PATH}.\nRun: bun scripts/publish-assets.mjs --manifest-only`);
  process.exit(1);
}

const base = assetBase();
const sets = resolveSets(opt("only"), { all: flag("all") });
console.log(`Fetching ${sets.length} asset set(s) from ${base}`);

let downloaded = 0, skipped = 0, bytes = 0, failed = 0;

/** Does the local file already match the manifest entry? */
function upToDate(abs, hash, size) {
  if (FORCE) return false;
  let st;
  try { st = statSync(abs); } catch { return false; }
  if (st.size !== size) return false;
  if (!VERIFY) return true; // size-only is the default: hashing 6.5k files costs more
  try { return hashBuf(readFileSync(abs)) === hash; } catch { return false; }
}

async function fetchOne(url, abs, hash) {
  // A truncated/garbled body is worse than a missing one (Leaflet would cache a broken
  // tile), so verify the hash of what actually arrived before writing it.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (hashBuf(buf) !== hash) throw new Error(`hash mismatch (expected ${hash})`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return buf.length;
}

for (const name of sets) {
  const entry = manifest.sets[name];
  if (!entry) { console.warn(`  ${name}: not in the manifest — skipped`); continue; }
  const files = Object.entries(entry.files);
  const todo = [];
  for (const [rel, [hash, size]] of files) {
    const abs = join(ROOT, entry.dir, rel);
    if (upToDate(abs, hash, size)) { skipped++; continue; }
    todo.push({ rel, abs, hash, url: `${base}/${entry.prefix}/${rel}` });
  }
  if (!todo.length) { console.log(`  ${name}: up to date (${files.length} files)`); continue; }
  process.stdout.write(`  ${name}: ${todo.length}/${files.length} to fetch `);

  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (i < todo.length) {
      const t = todo[i++];
      try {
        // NB: `bytes += await …` would read `bytes` before suspending and clobber the
        // other workers' increments. Await first, then accumulate.
        const n = await fetchOne(t.url, t.abs, t.hash);
        bytes += n;
        downloaded++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.warn(`\n    FAIL ${t.url}: ${e.message}`);
      }
      if (++done % 250 === 0) process.stdout.write(".");
    }
  }));
  process.stdout.write("\n");
}

console.log(`\nDone: ${downloaded} downloaded (${fmtBytes(bytes)}), ${skipped} already current`
  + (failed ? `, ${failed} FAILED` : ""));
if (failed) process.exit(1);
