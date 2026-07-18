// LOCAL dev tool (not CI-wired): boot `vite preview` (or reuse a running / live
// server) and run Google Lighthouse over the site's representative routes ->
// a per-category scorecard printed to the terminal + a per-route HTML/JSON
// report on disk. Reuses the smoke suite's server-boot + Chrome-path patterns
// (scripts/smoke/run.mjs, scripts/smoke/harness.mjs).
//
//   node scripts/audit.mjs                              # all default routes, boot preview on :4317
//   node scripts/audit.mjs "?item=19019" "?zone=33"     # only these routes
//   node scripts/audit.mjs ""                            # just the home shell
//   AUDIT_BASE=https://xian55.github.io/tortoise-db-viewer/ node scripts/audit.mjs   # audit a live server (no boot)
//
// Env: AUDIT_BASE   point at / reuse a running server (skips the preview boot; a set-but-
//                   unreachable value is an error, mirroring SMOKE_BASE).
//      AUDIT_CHROME  chrome.exe path (falls back to SMOKE_CHROME, then the default install path).
//      AUDIT_RUNS    median-of-N per route (default 1); the median run by perf score is kept.
//      AUDIT_OUT     report root dir (default .lighthouse); each invocation writes a timestamped subdir.
//
// Perf caveat (see .claude/skills/site-audit): Lighthouse uses a FRESH Chrome profile,
// so every audit has an empty OPFS and cold-fetches the whole ~13 MB brotli DB. Entity
// routes (?item=/?npc=/…) render their content only after the worker opens that DB, so
// their LCP/TTI/Speed-Index are download-bound -- read perf as a RELATIVE regression
// signal and split the home "shell" route from the DB-gated routes. accessibility /
// best-practices / SEO are deterministic and are the actionable categories.
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as ChromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";

const DEFAULT_BASE = "http://localhost:4317/tortoise-db-viewer/";
const PORT = 4317;
const CHROME = process.env.AUDIT_CHROME || process.env.SMOKE_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const RUNS = Math.max(1, +process.env.AUDIT_RUNS || 1);
const OUT_ROOT = process.env.AUDIT_OUT || ".lighthouse";

// Representative routes: each stresses a different subsystem (see the skill's route table).
const DEFAULT_ROUTES = [
  "",                    // home shell -- DB not yet required, the "fast path" baseline
  "?item=19019",         // item tooltip render -- DB-gated LCP
  "?npc=11502",          // NPC page + model-thumb image
  "?zone=33",            // Leaflet + Pixi lazy map chunk (heavy JS)
  "?worldmap=0",         // GPU world map, ~67k spawns -- heaviest
  "?browse=items",       // big client-side table
  "?search=thunderfury", // FTS search results page
  "?talents=warrior",    // talent calculator
];

const CATEGORIES = [
  ["performance", "Perf"],
  ["accessibility", "A11y"],
  ["best-practices", "BestPr"],
  ["seo", "SEO"],
];

const routes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROUTES;

const slug = (route) =>
  route === "" ? "home" : route.replace(/^\?/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

const ping = (base) =>
  new Promise((res) => {
    const mod = base.startsWith("https:") ? https : http;
    const req = mod.get(base, (r) => { r.destroy(); res(true); });
    req.on("error", () => res(false));
    req.setTimeout(1500, () => { req.destroy(); res(false); });
  });

async function ensureServer() {
  const base = process.env.AUDIT_BASE || DEFAULT_BASE;
  if (await ping(base)) { console.log(`[server] using ${base}`); return { base, proc: null }; }
  if (process.env.AUDIT_BASE) { console.error(`[server] AUDIT_BASE ${base} is not reachable`); process.exit(1); }
  console.log(`[server] booting: bunx vite preview --port ${PORT}`);
  const proc = spawn("bunx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { shell: true, stdio: "ignore" });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ping(DEFAULT_BASE)) { console.log(`[server] up at ${DEFAULT_BASE}`); return { base: DEFAULT_BASE, proc }; }
  }
  proc.kill();
  console.error(`[server] vite preview did not come up (did you run 'bunx vite build'?)`);
  process.exit(1);
}

// Run Lighthouse once against `url` on an already-launched Chrome `port`.
async function runOnce(url, port) {
  const flags = {
    port,
    output: ["json", "html"],
    logLevel: "error",
    onlyCategories: CATEGORIES.map(([k]) => k),
  };
  const result = await lighthouse(url, flags, desktopConfig);
  return result; // { lhr, report: [jsonStr, htmlStr] }
}

// Launch a FRESH Chrome (fresh temp profile -> empty OPFS -> honest cold DB fetch),
// audit `url`, kill Chrome. One Chrome per (route, run) so no route warms another's cache.
async function auditUrl(url) {
  const chrome = await ChromeLauncher.launch({
    chromePath: CHROME,
    chromeFlags: ["--headless=new", "--no-sandbox"],
  });
  try {
    return await runOnce(url, chrome.port);
  } finally {
    await chrome.kill();
  }
}

const pct = (score) => (score == null ? null : Math.round(score * 100));
const emoji = (p) => (p == null ? "—" : p >= 90 ? "🟢" : p >= 50 ? "🟡" : "🔴");
const cell = (p) => (p == null ? "  — " : `${emoji(p)} ${String(p).padStart(2)}`);
const dv = (lhr, id) => lhr.audits[id]?.displayValue ?? "—";

async function main() {
  const { base, proc } = await ensureServer();
  const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
  const outDir = path.resolve(OUT_ROOT, stamp);
  mkdirSync(outDir, { recursive: true });
  console.log(`[audit] ${routes.length} route(s) x ${RUNS} run(s), desktop preset -> ${outDir}\n`);

  const rows = [];
  const { writeFileSync } = await import("node:fs");

  for (const route of routes) {
    const url = base + route;
    const label = slug(route);
    process.stdout.write(`[audit] ${label.padEnd(18)} ${url} ... `);
    let best = null; // median-by-perf run
    try {
      const runsArr = [];
      for (let i = 0; i < RUNS; i++) runsArr.push(await auditUrl(url));
      runsArr.sort((a, b) => (a.lhr.categories.performance?.score ?? 0) - (b.lhr.categories.performance?.score ?? 0));
      best = runsArr[Math.floor(runsArr.length / 2)]; // median run
    } catch (e) {
      console.log(`FAILED (${e.message})`);
      rows.push({ label, url, scores: {}, lhr: null });
      continue;
    }
    const { lhr, report } = best;
    const scores = {};
    for (const [key] of CATEGORIES) scores[key] = pct(lhr.categories[key]?.score);
    console.log(CATEGORIES.map(([k, lbl]) => `${lbl} ${scores[k] ?? "—"}`).join("  "));
    writeFileSync(path.join(outDir, `${label}.report.html`), report[1]);
    writeFileSync(path.join(outDir, `${label}.report.json`), report[0]);
    rows.push({ label, url, scores, lhr });
  }

  if (proc) proc.kill();

  // ---- scorecard ----
  console.log("\n### Lighthouse scorecard (desktop preset)\n");
  console.log(`| Route | ${CATEGORIES.map(([, l]) => l).join(" | ")} |`);
  console.log(`|---|${CATEGORIES.map(() => "---").join("|")}|`);
  for (const r of rows) console.log(`| \`${r.label}\` | ${CATEGORIES.map(([k]) => cell(r.scores[k])).join(" | ")} |`);

  console.log("\n### Key metrics\n");
  console.log("| Route | FCP | LCP | TBT | CLS | SpeedIdx | TTI | Weight |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    if (!r.lhr) { console.log(`| \`${r.label}\` | — | — | — | — | — | — | — |`); continue; }
    const L = r.lhr;
    console.log(
      `| \`${r.label}\` | ${dv(L, "first-contentful-paint")} | ${dv(L, "largest-contentful-paint")} | ` +
        `${dv(L, "total-blocking-time")} | ${dv(L, "cumulative-layout-shift")} | ${dv(L, "speed-index")} | ` +
        `${dv(L, "interactive")} | ${dv(L, "total-byte-weight")} |`,
    );
  }

  console.log(`\n[audit] reports: ${outDir}`);
  console.log(
    "[audit] NOTE: perf is DB-download-bound on entity routes (cold OPFS every run) -- read it\n" +
      "        relative; a11y / best-practices / SEO are the actionable categories. See\n" +
      "        .claude/skills/site-audit for how to interpret + act on these.",
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
