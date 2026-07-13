// LOCAL tool: classify every creature display_id by whether Wowhead's Classic
// webthumb exists (HTTP 200) or 404s. The 404 set = Turtle-custom / unseen models
// Wowhead can't provide -> the worklist for our own static preview renders. Output
// scripts/data/model-thumb-missing.json (sorted display_ids Wowhead lacks) +
// model-thumb-coverage.json (full map, for reruns/debug). Re-run on client updates.
//
//   bun scripts/probe-wowhead-thumbs.mjs [--concurrency N] [--limit N]
//
// Idempotent-ish: reuses model-thumb-coverage.json as a cache; only probes ids not
// already classified (pass --fresh to ignore the cache).
import { openDatabase } from "./lib/sqlite.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.DB_PATH || join(ROOT, "public", "data", "tortoise.sqlite");
const OUT_MISSING = join(ROOT, "scripts", "data", "model-thumb-missing.json");
const OUT_COV = join(ROOT, "scripts", "data", "model-thumb-coverage.json");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CONC = +arg("--concurrency", 24);
const LIMIT = +arg("--limit", 0);
const FRESH = process.argv.includes("--fresh");

const thumbUrl = (d) => `https://wow.zamimg.com/modelviewer/classic/webthumbs/npc/${d % 256}/${d}.webp`;

async function probe(d) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // GET (not HEAD) — zamimg's CDN is unreliable on HEAD; abort the body early.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(thumbUrl(d), { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
      clearTimeout(t);
      r.body?.cancel?.();
      if (r.status === 200) return true;
      if (r.status === 404) return false;
      // 403/429/5xx -> transient, back off and retry
    } catch { /* network/abort -> retry */ }
    await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
  return null; // undetermined after retries
}

const db = await openDatabase(DB);
let ids = db.prepare(`SELECT DISTINCT display_id FROM creatures WHERE display_id > 0 ORDER BY display_id`).all().map((r) => r.display_id);
if (LIMIT) ids = ids.slice(0, LIMIT);

const cov = (!FRESH && existsSync(OUT_COV)) ? JSON.parse(readFileSync(OUT_COV, "utf8")) : {};
const todo = ids.filter((d) => cov[d] === undefined);
console.log(`display_ids: ${ids.length} | cached: ${ids.length - todo.length} | to probe: ${todo.length} | concurrency ${CONC}`);

let done = 0, present = 0, missing = 0, undetermined = 0;
const tally = (v) => { if (v === true) present++; else if (v === false) missing++; else undetermined++; };
Object.values(cov).forEach(tally);

// simple concurrency pool
let idx = 0;
async function worker() {
  while (idx < todo.length) {
    const d = todo[idx++];
    const v = await probe(d);
    cov[d] = v; tally(v);
    if (++done % 200 === 0) {
      console.log(`  ${done}/${todo.length} probed (present ${present}, missing ${missing}, undet ${undetermined})`);
      writeFileSync(OUT_COV, JSON.stringify(cov)); // checkpoint
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// missing = confirmed 404s only (undetermined stays out of the worklist -> retried next run)
const missingIds = ids.filter((d) => cov[d] === false).sort((a, b) => a - b);
writeFileSync(OUT_COV, JSON.stringify(cov));
writeFileSync(OUT_MISSING, JSON.stringify(missingIds));
console.log(`\nDONE: present ${present} | missing ${missing} | undetermined ${undetermined}`);
console.log(`  -> ${OUT_MISSING} (${missingIds.length} display_ids to render)`);

// how many missing are Turtle-custom creatures (context)
const customMissing = db.prepare(
  `SELECT COUNT(DISTINCT display_id) c FROM creatures WHERE custom=1 AND display_id IN (${missingIds.join(",") || 0})`
).get().c;
const mountMissing = db.prepare(
  `SELECT COUNT(DISTINCT c.display_id) c FROM item_mount im JOIN creatures c ON c.entry=im.creature WHERE c.display_id IN (${missingIds.join(",") || 0})`
).get().c;
console.log(`  of which custom creatures: ${customMissing} | mount display_ids missing: ${mountMissing}`);
