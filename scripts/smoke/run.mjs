// Parallel smoke runner. We shard at the PROCESS level: split the test files across K
// `bun test` children, each with its own persistent Chrome profile
// (SMOKE_USER_DATA_DIR) -> its own OPFS -> no shared SAHPool lock, so they run truly in
// parallel and the DB is downloaded once per profile (then reused across runs).
//
// bun 1.4 added `bun test --parallel`, and it does NOT replace this, for a reason worth
// writing down because the flag looks like an exact fit. --parallel implies --isolate:
// each test FILE gets a fresh global, so the beforeAll/afterAll that setup.mjs registers
// from the --preload run once per FILE rather than once per process -- i.e. Chrome would
// be launched and torn down 18 times instead of K. `--no-isolate` shares the module
// registry back (measured: the preload module itself does then run once per worker) but
// the root hooks still fire per file, and the workers exit without running any
// beforeExit/exit/SIGTERM handler, so there is no place left to close the browser. What
// IS worth taking from 1.4 is --timings: see the shard-balancing block below.
//
//   node scripts/smoke/run.mjs                 # boot a preview server, shard across ~cpu-2 procs
//   node scripts/smoke/run.mjs -j 6            # 6 shards
//   node scripts/smoke/run.mjs item quest      # only modules whose filename matches
//   SMOKE_BASE=http://host/ node .../run.mjs   # use an already-running server (no boot)
//   SMOKE_ISOLATE=1 node .../run.mjs -j 1       # full-goto isolation, single shard
//
// Each shard writes a JUnit XML (bun's --reporter=junit) which we parse for robust
// per-test results + durations -- more reliable than scraping the console summary.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.join(HERE, "tests");
const SETUP = path.join(HERE, "setup.mjs");
const JUNIT_DIR = path.resolve(".smoke-cache/junit");
// bun >= 1.4 `--timings <file> --update-timings` records measured per-file durations as
// {version, files: {<cwd-relative posix path>: ms}}. Each shard writes its own file (they
// run concurrently, so one shared target would race), and we fold them into TIMINGS after
// every run -- see mergeTimings().
const TIMINGS = path.resolve(".smoke-cache/timings.json");
const shardTimings = (i) => path.resolve(`.smoke-cache/timings-${i}.json`);
// A bun below 1.4 rejects the flags outright and every shard dies at argv parse -- i.e.
// the whole suite fails for a reason that has nothing to do with the site. Gate on the
// version rather than on the error, so an old bun just falls back to size balancing.
const TIMINGS_OK = (() => {
  if (process.env.SMOKE_NO_TIMINGS) return false;
  try {
    const [maj, min] = spawnSync("bun", ["--version"], { encoding: "utf8", shell: true })
      .stdout.trim().split(".").map(Number);
    return maj > 1 || (maj === 1 && min >= 4);
  } catch { return false; }
})();
const DEFAULT_BASE = "http://localhost:4317/tortoise-db-viewer/";
const PORT = 4317;

// The map/minimap trees are no longer in git (R2 is their source of truth -- see
// scripts/lib/assets.mjs), so a fresh clone or a branch switch leaves them absent and
// the map tests fail for a reason that has nothing to do with the code under test
// (the world-map test needs tiles to actually LOAD, not just be referenced). Say so
// up front rather than letting it read as a real regression.
for (const [dir, hint] of [["public/maps", "maps"], ["public/minimap", "minimap"], ["public/model3d", "model3d"]]) {
  const abs = path.resolve(dir);
  const empty = !existsSync(abs) || readdirSync(abs).length === 0;
  if (empty) {
    console.warn(`[assets] ${dir} is empty -- map tests will fail.\n`
      + `[assets] Fetch them first:  bun run assets -- --only ${hint}`);
  }
}

// --- args: -j N (shard count) + free-text filename filters ---
const argv = process.argv.slice(2);
let jobs = 0, repeat = 1;
const filters = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-j" || argv[i] === "--jobs") jobs = +argv[++i] || 0;
  else if (/^-j\d+$/.test(argv[i])) jobs = +argv[i].slice(2);
  else if (argv[i] === "-r" || argv[i] === "--repeat") repeat = Math.max(1, +argv[++i] || 1);
  else if (/^-r\d+$/.test(argv[i])) repeat = Math.max(1, +argv[i].slice(2));
  else filters.push(argv[i].toLowerCase());
}

// --- discover + filter test files ---
let files = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => path.join(TESTS_DIR, f));
if (filters.length) files = files.filter((f) => filters.some((s) => path.basename(f).toLowerCase().includes(s)));
if (!files.length) { console.error(`No test files match [${filters.join(", ")}] in ${TESTS_DIR}`); process.exit(1); }

// --- shard balancing ---
// The wall time of the whole suite is the busy time of its SLOWEST shard, so how the
// files are split is the only lever the runner itself has. File size was a proxy for
// that and a poor one -- a 4 KB module that loads three zone maps outweighs a 12 KB one
// asserting on table rows -- and it once put the two heaviest files in the same shard.
// So we balance on the MEASURED duration of the previous run instead (bun's own
// --timings file, written by every shard), and fall back to size only on the very first
// run, before any measurement exists. Files added since the last run get the median, so
// one unknown can be assumed neither free nor dominant.
// The assignment is LPT (longest-processing-time first into the currently-lightest
// shard) -- the standard 4/3-approximation for this, and what bun's own --shard does
// with the same file.
const sizes = new Map(files.map((f) => [f, statSync(f).size]));
function readTimings() {
  // Key by BASENAME: bun writes cwd-relative paths, and basename is already the key the
  // JUnit parse and the time profile below use.
  try {
    const j = JSON.parse(readFileSync(TIMINGS, "utf8"));
    return new Map(Object.entries(j.files || {}).map(([k, ms]) => [k.split(/[\\/]/).pop(), ms]));
  } catch { return new Map(); }
}
const timings = readTimings();
const measured = [...timings.values()].sort((a, b) => a - b);
const median = measured.length ? measured[measured.length >> 1] : 0;
const weightOf = (f) => (measured.length ? (timings.get(path.basename(f)) ?? median) : sizes.get(f));
files.sort((a, b) => (weightOf(b) - weightOf(a)) || (sizes.get(b) - sizes.get(a)));

const cap = jobs || Math.max(1, Math.min(files.length, (os.cpus().length || 4) - 2));
const K = Math.min(cap, files.length);
const shards = Array.from({ length: K }, () => []);
const load = new Array(K).fill(0);
for (const f of files) {
  let light = 0;
  for (let i = 1; i < K; i++) if (load[i] < load[light]) light = i;
  shards[light].push(f);
  load[light] += weightOf(f);
}

// Fold the per-shard timing files into the one TIMINGS file and delete them. A file moves
// between shards from run to run, so leaving the per-shard files in place would mean the
// next run reads two different durations for the same file with no way to tell which is
// current. Seeded from the existing merged file so a FILTERED run (`bun run smoke item`)
// updates only what it ran instead of wiping every other file's measurement.
function mergeTimings() {
  let merged = {};
  try { merged = JSON.parse(readFileSync(TIMINGS, "utf8")).files || {}; } catch { /* first run */ }
  let got = 0;
  for (let i = 0; i < K; i++) {
    const p = shardTimings(i);
    try {
      for (const [f, ms] of Object.entries(JSON.parse(readFileSync(p, "utf8")).files || {})) {
        // Blend rather than overwrite. These are wall times on a developer's machine, so
        // anything else competing for the CPU inflates them -- measured: one file recorded
        // 15.9s during a background installer and 4.6s once it finished, a 3.5x spike. Taken
        // as-is that one bad run mis-balances every run after it. An even EMA absorbs a spike
        // in two or three runs while still tracking a test that genuinely got slower.
        merged[f] = merged[f] ? Math.round((merged[f] + ms) / 2) : ms;
      }
      got++;
    } catch { /* shard died before writing */ }
    try { rmSync(p, { force: true }); } catch { /* nothing to remove */ }
  }
  if (!got) return;
  try { writeFileSync(TIMINGS, JSON.stringify({ version: 1, files: merged }, null, 2)); } catch { /* cache only -- never fail the run over it */ }
}

const ping = (base) => new Promise((res) => {
  const req = http.get(base, (r) => { r.destroy(); res(true); });
  req.on("error", () => res(false));
  req.setTimeout(1500, () => { req.destroy(); res(false); });
});

// `shell: true` means the child we hold is a shell wrapper (cmd.exe on Windows,
// bunx -> node vite.js underneath), so proc.kill() terminates the wrapper and ORPHANS
// the real preview server. The orphan keeps the process group alive: run.mjs prints
// "SMOKE: PASS", exits, and `bun run smoke` still never returns -- which reads as a
// hung test suite when the suite actually finished in ~20s. Kill the whole tree.
// spawnSync, NOT spawn: every caller here is immediately followed by process.exit(),
// which would tear us down before an async child ever started -- the kill would simply
// never happen.
function killTree(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); return; }
    catch { /* fall through to the portable path */ }
  }
  try { process.kill(-proc.pid); } catch { try { proc.kill(); } catch { /* already gone */ } }
}

async function ensureServer() {
  const base = process.env.SMOKE_BASE || DEFAULT_BASE;
  if (await ping(base)) { console.log(`[server] using ${base}`); return { base, proc: null }; }
  if (process.env.SMOKE_BASE) { console.error(`[server] SMOKE_BASE ${base} is not reachable`); process.exit(1); }
  console.log(`[server] booting: bunx vite preview --port ${PORT}`);
  const proc = spawn("bunx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { shell: true, stdio: "ignore" });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ping(DEFAULT_BASE)) { console.log(`[server] up at ${DEFAULT_BASE}`); return { base: DEFAULT_BASE, proc }; }
  }
  killTree(proc);
  console.error(`[server] vite preview did not come up (did you run 'bunx vite build'?)`);
  process.exit(1);
}

// Parse bun's JUnit XML into flat testcases. A case failed if it has a <failure>/<error>
// child (self-closed <testcase .../> = pass). time is in seconds.
function parseJUnit(xml) {
  const cases = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1], body = m[3] || "";
    const name = (attrs.match(/name="([^"]*)"/) || [])[1] || "?";
    const time = parseFloat((attrs.match(/time="([^"]*)"/) || [])[1] || "0");
    const rawFile = (attrs.match(/file="([^"]*)"/) || [])[1] || "";
    const file = rawFile.split(/[\\/]/).pop() || "?";
    const failed = /<(failure|error)\b/.test(body);
    cases.push({ name, time, file, failed });
  }
  return cases;
}

function runShard(idx, shardFiles, base) {
  return new Promise((resolve) => {
    const xml = path.join(JUNIT_DIR, `shard-${idx}.xml`);
    const env = { ...process.env, SMOKE_BASE: base, SMOKE_USER_DATA_DIR: `.smoke-cache/shard-${idx}` };
    const args = ["test", "--reporter=junit", `--reporter-outfile=${xml}`,
      // Measure this shard's per-file durations for the NEXT run's balancing. Needs bun
      // >= 1.4; an older bun rejects the flags outright, so they're opt-out via env.
      ...(TIMINGS_OK ? [`--timings=${shardTimings(idx)}`, "--update-timings"] : []),
      "--preload", SETUP, ...shardFiles];
    const child = spawn("bun", args, { env, shell: true });
    let out = "";
    const cap = (b) => { out += b.toString(); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("close", (code) => {
      let cases = [];
      try { cases = parseJUnit(readFileSync(xml, "utf8")); } catch { /* shard died before writing */ }
      resolve({ idx, code, cases, out, files: shardFiles.map((x) => path.basename(x)) });
    });
  });
}

const sum = (cs) => cs.reduce((a, c) => a + c.time, 0);
const bar = (t, max, w = 24) => "█".repeat(Math.max(1, Math.round((t / max) * w)));

async function runOnce(base) {
  const t0 = Date.now();
  const results = await Promise.all(shards.map((s, i) => runShard(i, s, base)));
  if (TIMINGS_OK) mergeTimings();
  return { results, elapsed: ((Date.now() - t0) / 1000).toFixed(1) };
}

function printProfile(results, elapsed) {
  const all = results.flatMap((r) => r.cases);
  console.log("\n==================== SHARD RESULTS ====================");
  for (const r of results) {
    const p = r.cases.filter((c) => !c.failed).length, f = r.cases.filter((c) => c.failed).length;
    console.log(`[s${r.idx}] ${p} pass, ${f} fail  (exit ${r.code})  files: ${r.files.join(", ")}`);
    for (const c of r.cases.filter((c) => c.failed)) console.log(`       FAIL: ${c.name}`);
    if (r.code !== 0 && f === 0) console.log(`       (no test failed but exit ${r.code} -- likely a beforeAll/afterAll hook; see output below)`);
  }
  const shardBusy = results.map((r) => ({ idx: r.idx, t: sum(r.cases), files: r.files })).sort((a, b) => b.t - a.t);
  const byFile = {};
  for (const c of all) byFile[c.file] = (byFile[c.file] || 0) + c.time;
  const fileRows = Object.entries(byFile).sort((a, b) => b[1] - a[1]);
  const slow = [...all].sort((a, b) => b.time - a.time).slice(0, 8);
  console.log("\n==================== TIME PROFILE ====================");
  console.log(`Wall ${elapsed}s | test-time sum ${sum(all).toFixed(1)}s across ${K} shards ` +
    `= ${(sum(all) / Math.max(0.1, +elapsed)).toFixed(1)}x parallel speedup`);
  console.log("\nPer shard (busy time; the slowest ≈ the wall floor):");
  for (const s of shardBusy) console.log(`  s${s.idx}  ${s.t.toFixed(1).padStart(5)}s  ${bar(s.t, shardBusy[0].t)}  ${s.files.join(", ")}`);
  console.log("\nPer file (sum of its test times):");
  for (const [f, t] of fileRows) console.log(`  ${t.toFixed(1).padStart(5)}s  ${bar(t, fileRows[0][1])}  ${f}`);
  console.log("\nSlowest tests:");
  for (const c of slow) console.log(`  ${c.time.toFixed(1).padStart(5)}s  ${c.name}  (${c.file})`);
}

if (!existsSync(JUNIT_DIR)) mkdirSync(JUNIT_DIR, { recursive: true });
const { base, proc } = await ensureServer();
const balanceBy = !TIMINGS_OK ? "file size (bun < 1.4: no --timings)"
  : measured.length ? `measured time (${measured.length} file(s) timed; predicted slowest shard ${(Math.max(...load) / 1000).toFixed(1)}s)`
  : "file size (first run -- no timings yet)";
console.log(`[shard] ${files.length} files across ${K} shard(s), balanced by ${balanceBy}${repeat > 1 ? ` x${repeat} (flake check)` : ""}`);

if (repeat > 1) {
  // ---- flake check: run the whole sharded suite N times, classify each test ----
  const outcomes = new Map(); // name -> {pass, fail}
  let hookCrash = false;
  for (let run = 1; run <= repeat; run++) {
    const { results, elapsed } = await runOnce(base);
    const cs = results.flatMap((r) => r.cases);
    const p = cs.filter((c) => !c.failed).length, f = cs.filter((c) => c.failed).length;
    hookCrash ||= results.some((r) => r.code !== 0 && !r.cases.some((x) => x.failed));
    for (const c of cs) { const o = outcomes.get(c.name) || { pass: 0, fail: 0 }; o[c.failed ? "fail" : "pass"]++; outcomes.set(c.name, o); }
    console.log(`  run ${run}/${repeat}: ${p} pass, ${f} fail  (${elapsed}s)`);
  }
  if (proc) killTree(proc);
  const flaky = [...outcomes].filter(([, o]) => o.pass > 0 && o.fail > 0);
  const always = [...outcomes].filter(([, o]) => o.pass === 0 && o.fail > 0);
  console.log("\n==================== FLAKE REPORT ====================");
  console.log(`${outcomes.size} distinct tests over ${repeat} runs`);
  console.log(`\nConsistent fails (failed EVERY run -- real, not flaky):`);
  if (always.length) for (const [n, o] of always) console.log(`  ${o.fail}/${repeat}  ${n}`);
  else console.log("  (none)");
  console.log(`\nFLAKY (mixed pass+fail across runs):`);
  if (flaky.length) for (const [n, o] of flaky) console.log(`  ⚠ ${o.fail} fail / ${o.pass} pass  ${n}`);
  else console.log("  (none) — suite is stable ✅");
  console.log("------------------------------------------------------");
  console.log(flaky.length ? "SMOKE: FLAKY" : always.length || hookCrash ? "SMOKE: FAIL" : "SMOKE: PASS");
  process.exit(flaky.length || always.length || hookCrash ? 1 : 0);
}

// ---- single run (default): full time profile ----
const { results, elapsed } = await runOnce(base);
if (proc) killTree(proc);
const totalPass = results.flatMap((r) => r.cases).filter((c) => !c.failed).length;
const totalFail = results.flatMap((r) => r.cases).filter((c) => c.failed).length;
const hookCrash = results.some((r) => r.code !== 0 && !r.cases.some((c) => c.failed));
printProfile(results, elapsed);
console.log("------------------------------------------------------");
console.log(`TOTAL: ${totalPass} pass, ${totalFail} fail  |  ${elapsed}s wall  |  ${K} shard(s)`);
console.log(totalFail || hookCrash ? "SMOKE: FAIL" : "SMOKE: PASS");
// Dump the output of any shard that didn't come back clean. Previously this only fired
// for a hook crash (non-zero exit with no failed case), so an ordinary test failure
// printed its NAME and nothing else -- which on CI, where you can't just re-run it
// locally, left no way to tell why it failed. Each test's single console.log diagnostic
// lives in this output, so it is the whole point of having one.
for (const r of results) {
  if (r.code === 0 && !r.cases.some((c) => c.failed)) continue;
  console.log(`\n----- [s${r.idx}] full output -----\n${r.out}`);
}
process.exit(totalFail || hookCrash ? 1 : 0);
