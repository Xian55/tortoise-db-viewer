#!/usr/bin/env bun
/**
 * Upload the R2-hosted asset sets (zone parchments, minimap tile pyramids, creature
 * model thumbnails) and regenerate scripts/data/assets-manifest.json. The counterpart to
 * fetch-assets.mjs -- run it after an extract-*.py that writes into one of the sets
 * defined in scripts/lib/assets.mjs.
 *
 *   bun run publish -- --dry-run                        # show what would upload
 *   bun run publish -- --only maps-tbc-cmangos          # one set
 *   bun run publish -- --only maps-tbc,minimap-tbc      # (prefix match works too)
 *   bun run publish                                     # every set
 *   bun run publish -- --manifest-only                  # rewrite the manifest, upload nothing
 *   bun run publish -- --force                          # re-upload even unchanged files
 *
 * Uploads go straight to R2's S3 API, signed in-process (scripts/lib/r2.mjs) -- no `aws`
 * CLI and no SDK. Credentials come from the environment:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY  (R2_BUCKET optional)
 *
 * By default only files whose hash differs from the committed manifest are uploaded, so
 * a re-run after a partial upload resumes cheaply.
 *
 * SAFETY: this never deletes. R2 is the only copy of these trees (they are not in git --
 * see scripts/lib/assets.mjs), so a file that vanished locally is REPORTED, not removed
 * remotely. Delete by hand if you actually mean it.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ROOT, ASSET_SETS, MANIFEST_PATH, readManifest, scanSet, fmtBytes, contentType, cacheControl,
} from "./lib/assets.mjs";
import { r2FromEnv } from "./lib/r2.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const optOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const MANIFEST_ONLY = flag("manifest-only"), DRY = flag("dry-run"), FORCE = flag("force");
// These are thousands of ~9 KB objects, so wall-clock is ROUND-TRIPS, not bandwidth --
// the whole TBC payload is 33 MB, which even a modest link moves in seconds. Measured
// against the R2 edge (256 requests, warm pool, ~60 ms RTT):
//     conc=1 -> 16 req/s | 16 -> 250 | 64 -> 890 | 128 -> 670
// 64 is the peak; past it, contention and R2 throttling make it slower, not faster. A
// gigabit line does not move this number. Don't raise the default without re-measuring.
const CONCURRENCY = Number(optOf("concurrency")) || 64;

// --only accepts exact names or prefixes, so `--only maps-tbc` hits maps-tbc-cmangos.
function pickSets(only) {
  const all = Object.keys(ASSET_SETS);
  if (!only) return all;
  const out = new Set();
  for (const raw of only.split(",").map((s) => s.trim()).filter(Boolean)) {
    const hits = all.filter((n) => n === raw || n.startsWith(raw));
    if (!hits.length) {
      console.error(`no asset set matches "${raw}"\nknown: ${all.join(", ")}`);
      process.exit(1);
    }
    hits.forEach((h) => out.add(h));
  }
  return [...out];
}

const prev = readManifest() || { version: 1, sets: {} };
const sets = pickSets(optOf("only"));
const manifest = { version: 1, sets: { ...prev.sets } };
const plan = [];

console.log(`Scanning ${sets.length} asset set(s)...`);
for (const name of sets) {
  const dir = join(ROOT, ASSET_SETS[name].dir);
  if (!existsSync(dir)) {
    console.log(`  ${name}: ${ASSET_SETS[name].dir} not present locally — keeping existing manifest entry`);
    continue;
  }
  const entry = scanSet(name);
  const before = prev.sets[name]?.files || {};
  const files = Object.entries(entry.files);
  const changed = files.filter(([k, [h]]) => FORCE || !before[k] || before[k][0] !== h);
  const removed = Object.keys(before).filter((k) => !entry.files[k]);
  const bytes = files.reduce((a, [, [, s]]) => a + s, 0);
  manifest.sets[name] = entry;
  console.log(`  ${name}: ${files.length} files, ${fmtBytes(bytes)} — ${changed.length} to upload`
    + (removed.length ? `, ${removed.length} gone from disk` : ""));
  if (removed.length) {
    console.log(`    NOTE: those ${removed.length} are NOT deleted from R2 (it is the only copy). Remove by hand if intended.`);
  }
  for (const [rel] of changed) plan.push({ set: name, rel, dir, key: `${ASSET_SETS[name].prefix}/${rel}` });
}

// stat, don't read -- reading every file just to total the bytes doubles the disk work
// before a single byte is uploaded.
for (const f of plan) { try { f.size = statSync(join(f.dir, f.rel)).size; } catch { f.size = 0; } }
const totalBytes = plan.reduce((a, f) => a + f.size, 0);
// Longest-processing-time-first: start the big objects while every worker is still busy,
// so the run doesn't end with one straggler uploading an 800 KB parchment alone.
plan.sort((a, b) => b.size - a.size);
console.log(`\n${plan.length} file(s) to upload (${fmtBytes(totalBytes)})`);

if (DRY) {
  for (const f of plan.slice(0, 15)) console.log(`  would PUT ${f.key}`);
  if (plan.length > 15) console.log(`  ... and ${plan.length - 15} more`);
  console.log("\n--dry-run: nothing uploaded, manifest not written");
  process.exit(0);
}

if (!MANIFEST_ONLY && plan.length) {
  let r2;
  try {
    r2 = r2FromEnv();
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exit(1);
  }
  console.log(`Uploading to s3://${r2.bucket} via ${r2.host}\n`);

  let done = 0, failed = 0, sent = 0, throttled = 0;
  const started = Date.now();
  let i = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.length) }, async () => {
    while (i < plan.length) {
      const f = plan[i++];
      // await, don't readFileSync: a sync read stalls every other in-flight upload on
      // this single-threaded event loop, which at 64-way concurrency is most of them.
      const body = await readFile(join(f.dir, f.rel));
      let ok = false;
      for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
        try {
          await r2.put(f.key, body, {
            contentType: contentType(f.rel),
            cacheControl: cacheControl(f.set, f.rel),
          });
          ok = true;
        } catch (e) {
          // R2 answers 429/503 when pushed too hard. Backing off hard on those (rather
          // than hammering) is what keeps a high --concurrency a win instead of a loss.
          const rateLimited = /\b(429|503)\b/.test(e.message);
          if (rateLimited) throttled++;
          if (attempt === 5) {
            failed++;
            if (failed <= 5) console.error(`  FAIL ${f.key}: ${e.message}`);
          } else {
            await sleep((rateLimited ? 500 : 200) * 2 ** (attempt - 1) + Math.random() * 100);
          }
        }
      }
      if (ok) sent += body.length;
      if (++done % 500 === 0 || done === plan.length) {
        const secs = (Date.now() - started) / 1000;
        console.log(`  ${done}/${plan.length}  ${fmtBytes(sent)}  ${(done / secs).toFixed(0)} files/s`
          + `  ${((sent / 1048576) / secs).toFixed(1)} MB/s`);
      }
    }
  }));

  const secs = (Date.now() - started) / 1000;
  console.log(`\nUploaded ${done - failed}/${plan.length} in ${secs.toFixed(1)}s`
    + ` (${fmtBytes(sent)}, ${(done / secs).toFixed(0)} files/s, ${((sent / 1048576) / secs).toFixed(1)} MB/s)`
    + (throttled ? `\n  ${throttled} request(s) were rate-limited and retried — lower --concurrency if that number is large` : "")
    + (failed ? `, ${failed} FAILED` : ""));
  if (failed) {
    console.error("Manifest NOT written — fix the failures and re-run (it resumes; only missing files retry).");
    process.exit(1);
  }
}

// Deterministic key order so the committed manifest diffs cleanly.
const ordered = { version: manifest.version, sets: {} };
for (const k of Object.keys(manifest.sets).sort()) ordered.sets[k] = manifest.sets[k];
writeFileSync(MANIFEST_PATH, JSON.stringify(ordered) + "\n");
console.log(`Wrote ${MANIFEST_PATH}\nCommit the updated assets-manifest.json.`);
