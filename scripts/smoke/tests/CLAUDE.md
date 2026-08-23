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
DB-worker re-init a full reload would cost. Parallelism is by **process**: each shard has
its own `SMOKE_USER_DATA_DIR` → own OPFS → no shared lock, and the DB persists across runs
(downloaded once per profile, not every run).

**`bun test --parallel` (1.4) is not a replacement**, though it looks like one. It implies
`--isolate`, which gives every test FILE a fresh global — so the `beforeAll`/`afterAll`
this dir's `setup.mjs` registers fire once per file instead of once per process, launching
and closing Chrome 18 times instead of K. `--no-isolate` shares the module registry back
but the root hooks still run per file, and a parallel worker exits without running
`beforeExit`/`exit`/`SIGTERM`, leaving nowhere to close the browser.

What run.mjs *does* take from 1.4 is **`--timings`**: each shard records its measured
per-file durations, run.mjs merges them into `.smoke-cache/timings.json` (an even EMA, so
one run under CPU contention can't poison the balance), and the next run packs the shards
longest-first by measured time instead of by file size — file size was a poor proxy, e.g.
`browse.test.mjs` ranks 6th by size and 2nd by time. `SMOKE_NO_TIMINGS=1` forces the size
fallback.

### Where the wall time goes (measured, not guessed)

The suite went **62s → 28s** through three changes, in order of what each was worth:
splitting `model3d.test.mjs` (46 tests / ~47s, it was longer than an ideal shard and so
capped the suite by itself), timing-based packing, and replacing fixed sleeps with waits
on a condition (32s of sleeps across the suite → 4.9s).

It is now close to its floor, so know what the levers are before reaching for one:

- **Shard count is already optimal at `cpus - 2`.** Measured on an 8-core box: K=4 43.2s,
  K=5 29.4s, **K=6 28.4s**, K=7 37.3s, K=8 41.0s. Past 6, contention inflates *total* work
  (140s → 157s → 170s), so extra shards cost more than they parallelize.
- **Shards are balanced to within ~3s of each other** and ~2s of the theoretical bound.
  Packing has almost nothing left to give.
- **Per-shard overhead is ~1.1s** (Chrome launch; `warm()` is ~370ms off a persisted OPFS).
- **Per-test harness overhead is ~2ms** — `resetState` is not a cost worth optimizing.
- **A GPU-backed headless Chrome does not help**: measured 13.69s vs 13.80s on the 3D file.
  The time is model download/parse and genuine elapsed-time assertions, not rasterization.
- Contention roughly **doubles** every file's time vs running it alone; that is the plateau.

So the only remaining lever is *less work*, and the biggest single file
(`browse.test.mjs`, ~25s under contention, no sleeps left in it) is now the wall floor.

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
6. **Never `await new Promise(r => setTimeout(r, N))` to wait for something.** See below.

### Waiting: on a condition, never on a clock

A fixed sleep is wrong in both directions at once — it wastes the difference on a fast
machine and *passes for the wrong reason* on a slow one, since it expires whether or not
the thing happened. An audit found **32s of the suite's ~140s of work was fixed sleeps**,
25.6s of it in one file that was also the wall floor; converting them left **4.9s** and cut
those three files from 30.1s/27.2s/23.3s to 12.9s/9.6s/10.2s standalone. Individual tests:
`dressing room opens still, rotates on demand` 3.94s → 0.19s, `dice skips a locked slot`
4.38s → 1.18s, `hovering a result tries it on` 3.55s → 0.71s — with assertions that got
*stricter*, not weaker. The suite stayed green over a 3× flake check.

Four patterns, in order of preference:

0. **Reach for the helpers in `_shared.mjs` first.** `afterRemount(act)` runs `act` and
   waits for the model viewer to have been rebuilt and settled (every equip, hover preview
   and appearance change builds a NEW viewer, so the hook object's identity flipping is the
   exact signal); `viewerIdle()` is the same settle without a rebuild; `waitStable(sample)`
   polls until a sample repeats, which is how you wait out OrbitControls' damping or a
   progressive tile load without naming a duration.

1. **Wait for the state you are about to assert.** The app already reports it —
   `window.__mv()` exposes `running`, `spinning`, `animating`, `frames`, `frameGap`;
   `__zoneDots` and the URL do the same elsewhere. So:
   ```js
   await page.waitForFunction(() => window.__mv && window.__mv().running === false, { timeout: T });
   ```
   not `setTimeout(r, 2500)` followed by reading `running`.

2. **When you need change over time, wait on a COUNTER, not on milliseconds.** Two
   snapshots only differ once frames have actually been drawn, and how long that takes is a
   property of the machine:
   ```js
   const f0 = await page.evaluate(() => window.__mv().frames);
   await page.click("#dress-anim");
   await page.waitForFunction((f) => window.__mv().animating && window.__mv().frames > f + 10, { timeout: T }, f0);
   ```

3. **A real elapsed-time measurement may keep its sleep — say why in a comment.** A few
   properties genuinely are about wall time and cannot be waited into existence: the
   turntable drawing half the frames the animation does (a 30-vs-60fps gap needs ~1s to be
   observable at all), OrbitControls' damping hoarding a drag's leftover delta for about a
   second, the blink cycle's phase. These are worth their seconds — each pins a bug that
   actually shipped and that no screenshot would catch. They are the exception, and a
   comment saying which one it is keeps the next reader from copying the pattern.

If a test needs a state the app doesn't expose, **add it to the debug hook** rather than
sleeping around its absence — that is what `__mv()`'s counters are for.

**A `.catch(() => {})` on a wait is a loaded gun.** It turns "this never happened" into a
silent full-timeout pause. That is not hypothetical: replacing a 400ms sleep with a wait for
the hover preview badge to re-appear took one test from 3.5s to **15.7s**, because the
preceding `mouseleave` was *dispatched* rather than moving the real pointer — so re-hovering
the same row fired nothing and the wait burned its whole timeout before being swallowed.
Use the swallow only where the condition is genuinely optional, and when a converted test
gets *slower*, suspect a wait that is never satisfied.

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
