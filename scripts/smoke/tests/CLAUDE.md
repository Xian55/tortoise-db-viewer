# Smoke tests (scripts/smoke/tests)

Browser end-to-end suite for the site, split into per-topic **bun test** modules.
One `<topic>.test.mjs` per area (item, quest, npc, zone, browse, …). See the parent
`scripts/smoke/` for the machinery.

## How it fits together

```
../harness.mjs   one shared browser+page per PROCESS, nav()/load(), error scoping, warm()
../setup.mjs     bun --preload: beforeAll(launch+warm) / beforeEach(resetState) / afterEach(assertNoErrors)
../run.mjs       parallel runner: shards these files across K `bun test` procs, each its own Chrome profile
tests/_shared.mjs   generic helpers used by >1 topic (testBrowse, testShareButton) — NOT a *.test.mjs
tests/*.test.mjs    the topic modules (this dir)
```

Every test in a shard **reuses one page**. The DB (sqlite-wasm/OPFS) opens **once** in
`warm()`; each `nav()` is an in-app `history.pushState` route, skipping the app + WASM +
DB-worker re-init a full reload would cost. Parallelism is by **process** (bun has no
worker pool): each shard has its own `SMOKE_USER_DATA_DIR` → own OPFS → no shared lock,
and the DB persists across runs (downloaded once per profile, not every run).

## Running

```sh
bun run smoke                 # parallel: boots a preview server, shards across ~cpu procs
bun run smoke -- -j 6         # 6 shards
bun run smoke -- item quest   # only modules whose filename matches
bun run smoke:test            # single shard, all files (good for -t filtering / debugging)
bun test --preload ./scripts/smoke/setup.mjs scripts/smoke/tests/item.test.mjs   # one module
bun test --preload ./scripts/smoke/setup.mjs scripts/smoke/tests -t "item 7909"  # one test by name
SMOKE_ISOLATE=1 bun run smoke:test   # force full-goto per test (gold-standard isolation, slow)
bun run smoke -- -r 3        # FLAKE CHECK: run the whole suite 3x, classify each test stable/flaky
bun run smoke:flake          # same (alias)
bun test --rerun-each 8 --preload ./scripts/smoke/setup.mjs scripts/smoke/tests/npc.test.mjs -t "map-menu"  # hammer one test
```
Tests hit a static server (default `http://localhost:4317/tortoise-db-viewer/`). `run.mjs`
boots `bunx vite preview` if nothing is there; needs a `bunx vite build` first. Point at a
running server with `SMOKE_BASE`.

## Harness API (import from `../harness.mjs`)

- `page` — puppeteer `Page` (live binding). Use it exactly like a normal puppeteer page.
- `nav("?item=5")` — **default navigation**; SPA `pushState` (fast). Use for every `?…` app route.
- `nav("?x", { full: true })` — force a full `page.goto` (only where a full document is needed).
- `load("embed/demo.html")` — full navigation to a **non-app document**.
- `T` — per-selector timeout (ms). `BASE` — the site root (rarely needed directly).
- `smoke(name, fn)` — register a **bool-returning** async test fn as a bun test (from `../harness.mjs`).
- `testBrowse`, `testShareButton` — generic helpers from `./_shared.mjs`.

## Adding / editing a test

1. Write an `async` function that drives the page and **returns `true` on pass**. Keep a
   single `console.log(...)` diagnostic line — on failure bun prints it, so it's your error message.
2. Navigate with `nav("?…")`, **not** `page.goto`. Assert readiness with `waitForSelector`.
3. Register it at the bottom: `smoke("descriptive name with ids/args", () => myTest(5, "Foo"));`
   Names carry the args so `bun test -t "<substr>"` can select them.
4. Put it in the matching topic module, or create a new `<topic>.test.mjs`. A generic helper
   used by more than one topic goes in `_shared.mjs` (export it; no `smoke()` there).
5. Keep it green. A new view/behavior should get a check here (repo convention).

## Isolation & gotchas

- `beforeEach` runs `resetState()`: clears localStorage/sessionStorage, resets the viewport
  to 1280×900, and re-loads the app shell if a prior test left a foreign document. `afterEach`
  fails the test if it produced a `pageerror` / `requestfailed` / `http ≥ 400` (minus `BENIGN`
  in harness.mjs — favicon, icon CDN, sparse minimap tiles, main-dataset `changelog.json`, …).
- **SPA `nav()` needs the app shell document.** After `load("embed/…")` the next `nav()` auto-
  heals with a full goto. Use `load()` for foreign docs, `nav(x, {full:true})` for **mobile
  viewport** tests (they `setViewport` small), and keep `page.reload()` for persistence tests.
- The DB warms **once per shard**; the first run per profile downloads it into
  `.smoke-cache/shard-N/` (gitignored), later runs reuse it. A schema/DB change auto-refreshes
  (OPFS file is keyed by the build version hash).
- Don't add `beforeAll`/browser setup inside a test module — the preload owns the lifecycle.
- **Interacting with a map marker/dot?** The Leaflet map runs a `fitBounds` animation on
  load that shifts marker positions — a single click can miss. Either **retry** the
  click until the menu/result appears (see `testNpcMapMenu`), or read positions from the
  `window.__zoneDots` hook (Pixi dots) instead of clicking by pixel. Run `bun run smoke -- -r 3`
  after adding a map test to make sure it isn't flaky.
