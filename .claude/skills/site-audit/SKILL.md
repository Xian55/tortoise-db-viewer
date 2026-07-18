---
name: site-audit
description: Run Google Lighthouse over the Tortoise-WoW DB viewer's rendered pages and read the results for THIS site (a no-backend SPA that ships the whole SQLite DB to the browser). Load whenever asked to audit / profile / Lighthouse the site, check performance / accessibility / best-practices / SEO of a page, measure Core Web Vitals (LCP/TBT/CLS), or investigate why a page loads slow or scores poorly. Runs `bun run audit` (scripts/audit.mjs) — boots `vite preview` and drives Lighthouse via a fresh headless Chrome. Covers how to run + filter routes, the representative route set, and — the real value — how to interpret scores given the whole-DB (sqlite-wasm/OPFS) architecture: the intentional cold ~13 MB DB download structurally caps perf, so a11y / best-practices / SEO are the actionable levers. Triggers: "audit the site", "run lighthouse", "check performance", "check accessibility", "web vitals", "why is <page> slow to load", "lighthouse score".
---

# Auditing the site with Lighthouse

`scripts/audit.mjs` boots a production preview (or points at a running / live server) and runs
**Google Lighthouse** over a representative set of routes, producing a per-category scorecard in
the terminal plus a per-route HTML/JSON report on disk. It's a **local dev tool** — not CI-wired
(the user opted out of a CI gate) — and needs a system Chrome.

## When to use this vs the neighbours

- **This skill** — user-facing audit of the *rendered pages*: the 4 Lighthouse categories
  (performance, accessibility, best-practices, SEO) + Core Web Vitals, per route.
- **`sqlite-wasm-perf`** — the *internals* behind the perf number: shipped file size / download,
  WASM cold-load, query planning, FTS, build-time indexing. Go there to actually *move* perf.
- **`web-perf`** (global) — Core Web Vitals via the Chrome DevTools MCP (LCP/INP/CLS, trace-level
  network/CPU). Use when you want interactive DevTools tracing rather than a Lighthouse scorecard.

## How to run

Preview serves the **built** site, so build first (the DB must already exist at
`public/data/tortoise.sqlite`; if not, `bun scripts/build-db.mjs`):

```sh
bunx --bun vite build          # preview serves dist/; needed once after any src/ change
bun run audit                  # all default routes, boots vite preview on :4317
bun run audit "?item=19019"    # one route (fast iteration)
bun run audit "" "?zone=33"    # the home shell + the zone map only
```

`bun run audit` just calls `node scripts/audit.mjs` (Lighthouse is a Node ESM package — run it
under **Node**, not Bun). Env knobs:

- `AUDIT_BASE=<url>` — audit a **running / live** server and skip the preview boot, e.g.
  `AUDIT_BASE=https://xian55.github.io/tortoise-db-viewer/ bun run audit "?item=19019"`. A set-but-
  unreachable value is a hard error (mirrors the smoke suite's `SMOKE_BASE`).
- `AUDIT_CHROME=<path>` — Chrome executable (falls back to `SMOKE_CHROME`, then the default
  `C:/Program Files/Google/Chrome/Application/chrome.exe`).
- `AUDIT_RUNS=<n>` — median-of-N per route (default 1); the median run by perf score is kept.
- `AUDIT_OUT=<dir>` — report root (default `.lighthouse/`, gitignored). Each invocation writes a
  timestamped subdir with `<route>.report.html` + `.json` per route.

## The route set (and why each)

Filter to the surface you care about; the default covers the distinct subsystems:

| route | stresses |
|---|---|
| `` (home) | shell + asset load — **DB not yet required**, the "fast path" baseline |
| `?item=19019` | item tooltip render — **DB-gated** LCP |
| `?npc=11502` | NPC page + model-thumb image |
| `?zone=33` | Leaflet + Pixi lazy map chunk (heavy JS) |
| `?worldmap=0` | GPU world map, ~67k spawns — heaviest |
| `?browse=items` | big client-side table |
| `?search=thunderfury` | FTS search results page |
| `?talents=warrior` | talent calculator |

## Reading the scorecard — the one thing to get right

**Perf is structurally capped, by design.** Lighthouse uses a fresh Chrome profile every run, so
OPFS is empty and each audit **cold-fetches the whole ~13 MB brotli DB**. Entity routes render
their content only after the Web Worker opens that DB, so their LCP / TTI / Speed-Index are
*download-bound*. Read perf as a **relative regression signal**, and split the **home "shell"**
route (asset/JS perf you can actually tune) from the **DB-gated** routes (dominated by the
intentional whole-DB fetch — see `CLAUDE.md` "Whole-DB load"). Chasing the absolute perf number on
entity routes fights the architecture; if perf genuinely regressed, the lever lives in
`sqlite-wasm-perf` (download size, cold-load) — not here.

**accessibility / best-practices / SEO are deterministic** ⇒ they're the actionable categories.
Full per-audit detail (which findings to fix vs which are known-noise, and how to open the HTML
report) is in **`references/reading-lighthouse.md`** — read it before acting on a low score.

## Don't "fix" these (known non-issues)

- The **~13 MB DB download / "Enormous network payload"** — deliberate (no backend; queried
  in-browser, cached in OPFS after first visit). Not a bug.
- **Third-party icon CDN** (`render-us.worldofwarcraft.com`) flagged for cross-origin / caching —
  we don't control its headers; icons fall back to the committed atlas.
- **Response-header** best-practices items (CSP, HSTS, caching) — served by GitHub Pages /
  Cloudflare R2, tunable only in the deploy layer, not the app.
- **SPA query-param routing** — expected; there are no server rewrites. (Do still fix genuine SEO
  findings like a missing/duplicated per-route `<title>`/meta description if Lighthouse flags one.)

## Out of scope (v1)
No asset/bundle-size budget, no axe-core a11y deep-dive, no CI gate. If you later want the size
budget, add a `dist/` chunk check; for deeper a11y, add `axe-core` — both were deferred by choice.
