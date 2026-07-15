// Parallel smoke runner. bun test has no worker pool, so we shard at the PROCESS
// level: split the test files across K `bun test` children, each with its own
// persistent Chrome profile (SMOKE_USER_DATA_DIR) -> its own OPFS -> no shared
// SAHPool lock, so they run truly in parallel and the DB is downloaded once per
// profile (then reused across runs).
//
//   node scripts/smoke/run.mjs                 # boot a preview server, shard across ~cpu-2 procs
//   node scripts/smoke/run.mjs -j 6            # 6 shards
//   node scripts/smoke/run.mjs item quest      # only modules whose filename matches
//   SMOKE_BASE=http://host/ node .../run.mjs   # use an already-running server (no boot)
//   SMOKE_ISOLATE=1 node .../run.mjs -j 1       # full-goto isolation, single shard
//
// Each shard writes a JUnit XML (bun's --reporter=junit) which we parse for robust
// per-test results + durations -- more reliable than scraping the console summary.
import { spawn } from "node:child_process";
import { readdirSync, statSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.join(HERE, "tests");
const SETUP = path.join(HERE, "setup.mjs");
const JUNIT_DIR = path.resolve(".smoke-cache/junit");
const DEFAULT_BASE = "http://localhost:4317/tortoise-db-viewer/";
const PORT = 4317;

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
// heaviest-first so round-robin balances the shards
files.sort((a, b) => statSync(b).size - statSync(a).size);

const cap = jobs || Math.max(1, Math.min(files.length, (os.cpus().length || 4) - 2));
const K = Math.min(cap, files.length);
// round-robin the size-sorted files into K buckets
const shards = Array.from({ length: K }, () => []);
files.forEach((f, i) => shards[i % K].push(f));

const ping = (base) => new Promise((res) => {
  const req = http.get(base, (r) => { r.destroy(); res(true); });
  req.on("error", () => res(false));
  req.setTimeout(1500, () => { req.destroy(); res(false); });
});

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
  proc.kill();
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
    const args = ["test", "--reporter=junit", `--reporter-outfile=${xml}`, "--preload", SETUP, ...shardFiles];
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
console.log(`[shard] ${files.length} files across ${K} shard(s)${repeat > 1 ? ` x${repeat} (flake check)` : ""}`);

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
  if (proc) proc.kill();
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
if (proc) proc.kill();
const totalPass = results.flatMap((r) => r.cases).filter((c) => !c.failed).length;
const totalFail = results.flatMap((r) => r.cases).filter((c) => c.failed).length;
const hookCrash = results.some((r) => r.code !== 0 && !r.cases.some((c) => c.failed));
printProfile(results, elapsed);
console.log("------------------------------------------------------");
console.log(`TOTAL: ${totalPass} pass, ${totalFail} fail  |  ${elapsed}s wall  |  ${K} shard(s)`);
console.log(totalFail || hookCrash ? "SMOKE: FAIL" : "SMOKE: PASS");
for (const r of results) if (r.code !== 0 && !r.cases.some((c) => c.failed)) { console.log(`\n----- [s${r.idx}] full output -----\n${r.out}`); }
process.exit(totalFail || hookCrash ? 1 : 0);
