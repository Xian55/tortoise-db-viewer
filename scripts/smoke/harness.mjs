// Shared browser/page singleton + navigation helpers for the smoke suite.
//
// One browser + one page per PROCESS (a shard). Every test file imports these
// live bindings and reuses the same page -- the DB (sqlite-wasm/OPFS) is opened
// ONCE in warm() and every subsequent nav() is an in-app pushState (SPA) route,
// skipping the app + WASM + DB-worker re-init a full page.goto would incur.
//
// Isolation: the profile is a persistent userDataDir (SMOKE_USER_DATA_DIR), so
// OPFS survives across runs -> the ~34 MB DB is downloaded once, not every run.
// Distinct dirs per shard give each process its own OPFS -> no shared SAHPool
// lock, which is what lets shards run in parallel (see run.mjs).
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

// Chrome executable. SMOKE_CHROME wins; otherwise probe the usual per-platform spots so
// the suite runs unchanged on a dev Windows box, a mac, and the Linux CI runner (which
// ships google-chrome preinstalled). Hardcoding the Windows path meant this could never
// run in CI -- which is a large part of why the suite went unwatched for so long.
const CHROME = process.env.SMOKE_CHROME || (() => {
  const candidates = process.platform === "win32"
    ? ["C:/Program Files/Google/Chrome/Application/chrome.exe",
       "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
         "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error(`[smoke] no Chrome found. Tried:\n  ${candidates.join("\n  ")}\n`
      + `Set SMOKE_CHROME to its path.`);
  }
  return found || candidates[0];
})();
export const BASE = process.env.SMOKE_BASE || "http://localhost:4317/tortoise-db-viewer/";
export const BASE_PATH = new URL(BASE).pathname; // "/tortoise-db-viewer/"
// domcontentloaded + an explicit waitForSelector is the real ready signal and
// ~2.5x faster than networkidle0 (see the note in the legacy smoke.mjs).
export const WAIT = "domcontentloaded";
// Per-selector timeout: healthy renders are sub-second to a few seconds; keep it
// short so red tests fail fast. The one-time DB load is covered by warm()'s own
// long timeout. Override with SMOKE_TIMEOUT if a slow machine needs more.
export const T = +process.env.SMOKE_TIMEOUT || 12000;
// SMOKE_ISOLATE=1 forces every nav() to a full page.goto (gold-standard document
// isolation) instead of SPA pushState reuse -- the slow-but-pristine A/B baseline.
const ISOLATE = process.env.SMOKE_ISOLATE === "1";

// Ignore: favicon, the optional icon-atlas manifest, the third-party WoW icon CDN
// (decorative; render.js falls back to the atlas, and headless Chrome intermittently
// ORB-blocks them), intentionally-sparse world-map tiles (empty ADT blocks 404 by
// design), the main-dataset changelog.json (dev-only feature), and the CDN-mirror
// probes (raw.githubusercontent / jsDelivr) that 404 until CI pushes the `cdn` branch.
// wow.zamimg.com = Wowhead's creature webthumb CDN, which render.js modelThumbUrl uses
// for display_ids we don't render ourselves. Exempt for the same reason the icon CDN is:
// a third party whose CURRENT contents we don't control -- it drops thumbs over time
// (a re-probe on 2026-08-06 found 12 that had vanished), and a 404 served as text/html
// gets ORB-blocked by Chrome, which would fail an NPC test over a cosmetic image.
// NB: if you see a FLOOD of these locally, the cause is usually public/model-thumbs
// being empty rather than Wowhead -- without its manifest every id falls back to the
// CDN. `bun run assets -- --only model-thumbs` fixes that.
// `model3d/comp/**` misses are DELIBERATE, not breakage: an armor component texture ships
// as a male+female PAIR or as one unisex file, never both, so every layer asks for its
// sexed name first and falls back to `_u`. One of the two is always a 404 by design. It
// only shows up in CI: a local run serves those files off disk, while CI reads them from
// R2 where the miss is real.
export const BENIGN = /favicon\.ico|icons\.json|worldofwarcraft\.com|zamimg\.com|minimap\/.+\.webp$|changelog\.json|raw\.githubusercontent\.com|cdn\.jsdelivr\.net|model3d\/comp\/.+\.webp$/;
// Benign *pageerror* messages. SPA nav (pushState) swaps #app out from under a
// Leaflet/Pixi map whose queued animation callbacks then fire once against removed
// DOM -> a spurious async "_leaflet_pos"/getPosition error. The legacy suite never
// saw these (its full page.goto tore the whole document down first); they signal no
// real defect, and because they're async they land on whichever test runs next, so
// they must be ignored rather than attributed. Add teardown-race patterns here only.
export const BENIGN_PAGEERR = /_leaflet_pos|reading 'getPosition'|Cannot read properties of undefined \(reading '_leaflet/;

// Live bindings: assigned in launch(), imported by every test module.
export let browser = null;
export let page = null;

// Per-test error buffer. beforeEach clears it; afterEach (assertNoErrors) fails
// the CURRENT test if a pageerror / requestfailed / http>=400 landed during it.
// This attributes console/network breakage to the offending test, unlike the
// legacy end-of-run dump.
const errbuf = [];
export function currentErrors() { return errbuf.slice(); }
export function clearErrors() { errbuf.length = 0; }

export async function launch() {
  if (browser) return;
  const userDataDir = process.env.SMOKE_USER_DATA_DIR || ".smoke-cache/default";
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox"],
    userDataDir, // persistent -> OPFS (and thus the DB) survives across runs
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 }); // desktop default (full menubar > 1100px)
  // capture clipboard writes so copy operations can be asserted headlessly
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } },
    });
  });
  page.on("pageerror", (e) => { if (!BENIGN_PAGEERR.test(e.message)) errbuf.push("pageerror: " + e.message); });
  page.on("requestfailed", (r) => {
    // An ABORTED media request is normal, not breakage: the audio player drops its src on
    // route change (stopAudio), so navigating away mid-clip cancels the in-flight fetch.
    // Because the abort surfaces asynchronously it lands on whichever test runs next --
    // which is why this presented as ~1 flaky test per 3 runs, on a different test each
    // time, and eventually failed CI. Attributing it to that test would be wrong twice
    // over: it is neither that test's doing nor a defect.
    const err = r.failure()?.errorText || "";
    if (err === "net::ERR_ABORTED" && /\/sounds\/.+\.(ogg|mp3)$/.test(r.url())) return;
    if (!BENIGN.test(r.url())) errbuf.push("reqfail: " + r.url() + " " + err);
  });
  page.on("response", (r) => { if (r.status() >= 400 && !BENIGN.test(r.url())) errbuf.push(`http ${r.status()}: ${r.url()}`); });
}

// One-time DB warm-up: the first navigation downloads the DB into OPFS (or reuses
// a persisted copy) and opens it. Doing it here lets every test's per-selector
// timeout stay short. Logs whether the DB was reused (fast) or freshly downloaded.
export async function warm() {
  const t0 = Date.now();
  await page.goto(`${BASE}?item=2770`, { waitUntil: WAIT, timeout: 120000 });
  await page.waitForSelector(".tooltip .tt-name", { timeout: 120000 });
  const ms = Date.now() - t0;
  // A persisted OPFS DB opens quickly; a cold download is much slower. ~4s is the
  // rough boundary on localhost -- purely informational for the "no re-download" check.
  console.log(`[warm] ${ms}ms (${ms < 6000 ? "OPFS reuse likely" : "fresh download likely"}) profile=${process.env.SMOKE_USER_DATA_DIR || ".smoke-cache/default"}`);
  clearErrors(); // warm-up nav isn't a test
}

// browser.close() can hang in headless Chrome when a shard leaves WebGL contexts
// alive (Pixi/Leaflet maps) -- graceful shutdown stalls. Race it against a force-kill
// so afterAll never times out and drags/‑fails the run.
export async function close() {
  if (!browser) return;
  const b = browser; browser = null; page = null;
  try {
    await Promise.race([b.close(), new Promise((_, rej) => setTimeout(() => rej(new Error("close timeout")), 8000))]);
  } catch { try { b.process()?.kill("SIGKILL"); } catch { /* already gone */ } }
}

// True when the app shell (index) is loaded and #app exists -> safe for SPA nav.
async function appReady() {
  return page.evaluate((bp) => {
    const p = location.pathname;
    return (p === bp || p === bp + "index.html") && !!document.getElementById("app");
  }, BASE_PATH).catch(() => false);
}

// Wait for the app to be idle before we hand off: no in-flight render (its transient
// ".loading" gone) and #app stable for two frames. A test that triggered an app-driven
// navigate() (e.g. a filter click) can return BEFORE its async, DB-backed render
// settles; that pending showBrowse would otherwise resolve DURING the next test and
// overwrite its DOM (the app has no route-generation guard). Frame-capped so it can't
// hang. A full page.goto doesn't need this (the document is torn down).
async function settle() {
  await page.evaluate(() => new Promise((res) => {
    const app = document.getElementById("app");
    if (!app) return res();
    let last = -1, stable = 0, frames = 0;
    const tick = () => {
      if (++frames > 180) return res(); // ~3s cap
      const busy = app.querySelector(".loading");
      const n = app.innerHTML.length;
      if (!busy && n === last) { if (++stable >= 2) return res(); } else { stable = 0; }
      last = n;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })).catch(() => {});
}

// Navigate to a query-string route. Default: in-app pushState (fast) once the shell
// is loaded. Forces a full page.goto when isolating, when asked (full:true), or when
// the current document isn't the app shell (e.g. just after an embed/foreign-doc test).
export async function nav(search, { full = false } = {}) {
  await settle(); // flush any pending render from the previous test/nav first
  if (full || ISOLATE || !(await appReady())) {
    await page.goto(BASE + search, { waitUntil: WAIT, timeout: 90000 });
    return;
  }
  // Absolute same-origin URL avoids relative-resolution traps. The app's own route
  // handler clears #app before its async render, so we don't pre-clear here (doing so
  // raced the render for filter-heavy browse views).
  await page.evaluate((url) => { history.pushState({}, "", url); dispatchEvent(new PopStateEvent("popstate")); }, BASE + search);
}

// Full document load for foreign docs (embed/demo.html), reload-persistence tests,
// or an absolute/shared URL. `path` is appended to BASE ("embed/demo.html", "?x=1").
export const load = (path) => page.goto(BASE + path, { waitUntil: WAIT, timeout: 90000 });

// beforeEach: pristine state without a full reload. Clears storage + error buffer,
// resets the viewport, and re-loads the shell if a prior test left a foreign document.
export async function resetState() {
  clearErrors();
  await page.setViewport({ width: 1280, height: 900 });
  if (!(await appReady())) { await page.goto(BASE, { waitUntil: WAIT, timeout: 90000 }); }
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch {}
    // Reset persistent state that lives OUTSIDE #app -- a full page.goto used to wipe
    // it, SPA nav does not. Left over, it makes loose selectors match the wrong thing:
    //  - the reused .hovercard singleton keeps its last .tooltip/.tt-name content
    //    (ensureCard() caches the node, so empty it in place rather than remove it),
    //  - the top-bar #search input keeps its text (so the next dropdown test appends
    //    to it and finds nothing),
    //  - transient overlays (context menu / pixi + embed tooltips) stay in the DOM.
    const hc = document.querySelector(".hovercard");
    if (hc) { hc.style.display = "none"; hc.innerHTML = ""; }
    // .map-ctx is a CACHED singleton too (zonemap.js ctxMenuEl), so removing it left
    // the module holding a detached node: the first map context-menu test in a page
    // passed and every later one failed FOREVER, because openMarkerMenu was filling an
    // element that was no longer in the document. Only visible once two such tests
    // shared a shard. Hide + empty in place, exactly like the hovercard above.
    const ctx = document.querySelector(".map-ctx");
    if (ctx) { ctx.style.display = "none"; ctx.innerHTML = ""; }
    document.querySelectorAll(".pixi-tip, .twp-tip").forEach((e) => e.remove());
    const s = document.getElementById("search");
    if (s) { s.value = ""; s.blur(); s.dispatchEvent(new Event("input", { bubbles: true })); }
  }).catch(() => {});
}

// afterEach: fail the test if it produced console/network errors (minus BENIGN).
export function assertNoErrors() {
  if (errbuf.length) {
    const msg = errbuf.slice(0, 10).join("\n  ");
    clearErrors();
    throw new Error("page errors during test:\n  " + msg);
  }
}

// The bool-return adapter: register a legacy test fn (returns true on pass) as a
// bun test. On failure the fn's own console.log line above carries the diagnostic.
// The explicit per-test timeout OVERRIDES bun's 5000ms default -- the heaviest map
// tests legitimately wait up to ~45-60s on a slow render, which the default would
// abort mid-flight.
import { test, expect } from "bun:test";
export const TEST_TIMEOUT = +process.env.SMOKE_TEST_TIMEOUT || 90000;
// SMOKE_TIME=1 logs each test's wall time (bun only prints [ms] for slow/failed
// tests) -- grep '^TIME ' and sort to find the heaviest tests.
export const smoke = (name, fn) => test(name, async () => {
  const t0 = Date.now();
  try { expect(await fn()).toBe(true); }
  finally { if (process.env.SMOKE_TIME) console.log(`TIME\t${Date.now() - t0}\t${name}`); }
}, TEST_TIMEOUT);
