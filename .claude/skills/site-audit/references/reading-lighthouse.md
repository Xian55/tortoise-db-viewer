# Reading a Lighthouse report for this site

Per-category interpretation for the Tortoise-WoW DB viewer. Read this before acting on a low
score — several "problems" Lighthouse reports are intrinsic to the no-backend, whole-DB design and
must not be "fixed".

## Open the detail

The terminal scorecard is a summary. Every failing *audit* (the specific check, e.g. "Buttons do
not have an accessible name") lives in the per-route HTML report:

```
.lighthouse/<timestamp>/<route>.report.html    # open in a browser — grouped by category, with element pointers
.lighthouse/<timestamp>/<route>.report.json     # same data, machine-readable (audits[<id>].details.items)
```

Work from the HTML report's failing-audit list, not the top-line number.

## Performance — relative signal, not an absolute target

Why the number is low and noisy on entity routes:

- **Fresh profile every run ⇒ empty OPFS ⇒ cold ~13 MB brotli DB fetch.** The Worker downloads
  and opens the DB before any entity content can render, so **LCP / TTI / Speed Index on
  `?item=` / `?npc=` / `?zone=` / etc. are download-bound**, not layout- or script-bound.
- The runner uses the **desktop preset** (no mobile 4× CPU + Slow-4G throttle) precisely so this
  number is at least stable enough to compare across runs. Mobile would make it meaningless.

How to read it:

- **Home (`` shell)** — DB not yet required. This is your real, tunable front-end perf: JS parse/
  execute, render-blocking assets, CLS, unused bytes. **Regressions here are actionable in `src/`.**
- **Entity routes** — treat perf as a **relative regression signal** run-to-run. A drop usually
  means the DB got bigger or cold-load got slower ⇒ the fix lives in the **`sqlite-wasm-perf`**
  skill (shipped file size, `page_size`, indexing, WASM cold-load budget), *not* in page markup.
- **TBT / CLS** are still meaningful everywhere (main-thread blocking + layout stability are
  independent of the download) — a high TBT or visible CLS *is* worth chasing in `src/`.

Do **not** act on: "Enormous network payload", "Avoid enormous network payloads", "Serve static
assets with an efficient cache policy" (for the DB), "Reduce initial server response time" — all
downstream of the deliberate whole-DB architecture (`CLAUDE.md` → "Whole-DB load, not HTTP range").

## Accessibility — deterministic, highest-value

Not affected by the download; the same every run ⇒ the best place to spend effort. Common
actionable findings and where they live:

- **Color contrast** (quality-color item names, muted table text) → the palette in `src/` CSS.
- **Names/labels** — icon-only buttons, the search input, map layer-control toggles, pagination
  controls lacking an accessible name → `aria-label` / `<label>` at the render site
  (`src/render.js`, `src/table.js`, `src/browse.js`, `src/zonemap.js`).
- **Heading order / landmarks** — pages that jump heading levels or lack a `<main>` → the view
  builders in `src/main.js`.
- **Link/text alternatives** — decorative vs meaningful icons (`iconImg` in `src/render.js`).

Fix these at the shared render helpers so the fix propagates across every entity type.

## Best-practices — split app vs deploy layer

- **App-fixable**: browser-console errors during load (the smoke suite already guards these —
  cross-check `scripts/smoke/harness.mjs` `BENIGN` filters), deprecated APIs, image aspect-ratio,
  missing `rel="noopener"` on external links.
- **Deploy-layer only (don't chase in `src/`)**: CSP / HSTS / `X-Content-Type-Options` and cache
  headers — set by GitHub Pages / Cloudflare R2 (see `CLAUDE.md` → "Deploy"), not the SPA.
- **Known-noise**: cross-origin flags for the WoW icon CDN (`render-us.worldofwarcraft.com`) — we
  don't own its headers; `render.js` falls back to the committed atlas.

## SEO — mostly deterministic

- **Actionable**: a missing or duplicated **per-route `<title>` / meta description** (each entity
  view should set its own), `<html lang>`, tap-target sizing, crawlable links.
- **Expected, not a bug**: query-param routing (`?item=…`) — there are no server rewrites; the app
  is a client-rendered SPA. Lighthouse may note "links are not crawlable" for JS-driven nav — a
  known trade-off of the static-Pages hosting, not something to restructure routing over.

## Practical loop

1. `bunx --bun vite build` then `bun run audit "<route>"` for the surface you changed.
2. Open the HTML report; act only on the **a11y / best-practices / SEO** failing audits and on
   **home-route perf / TBT / CLS**.
3. For an entity-route perf regression, hand off to **`sqlite-wasm-perf`** (verify with EXPLAIN
   QUERY PLAN / the download-size levers) — don't tweak markup expecting the perf score to move.
4. Re-audit the same route to confirm the fix moved the intended category.
