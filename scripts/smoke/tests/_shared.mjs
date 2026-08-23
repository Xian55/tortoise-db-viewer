// Generic test helpers used across more than one topic module. NOT a *.test.mjs
// (no smoke() calls) so bun won't execute it standalone -- topic modules import it.
import { page, nav, T } from "../harness.mjs";

// Generic finder assertion: rows + filters + sortable headers + a sort click takes
// effect, optionally asserting a specific header is present.
export async function testBrowse(kind, query = "", expectHeader) {
  await nav(`?browse=${kind}${query}`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const filters = await page.$$eval(".filters [data-f]", (e) => e.length);
  const sortable = await page.$$eval(".browse th.sortable", (e) => e.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  await page.click(".browse th.sortable");
  await page.waitForSelector(".browse th.active", { timeout: 10000 }).catch(() => {});
  const active = await page.$$eval(".browse th.active", (e) => e.length);
  const count = await page.$eval(".browse-count", (e) => e.textContent).catch(() => "?");
  console.log(`browse ${kind}${query}: ${rows} rows, ${filters} filters, ${sortable} sortable, active=${active}, headers=[${headers.join(",")}], "${count}"`);
  return rows > 0 && filters > 0 && sortable > 0 && active > 0 && (!expectHeader || headers.includes(expectHeader));
}

// Leaflet runs a fitBounds animation on load, so a marker/dot keeps MOVING for a beat
// after it exists. The context-menu tests sample a position and then click it, and the
// hit-test radius is only 9px -- on a loaded runner (CI packs 8 test files into one
// shard) enough latency lands between the sample and the click that the target has
// already moved away. Retrying doesn't help: the animation is still running, so every
// attempt misses for the same reason, which is why this failed DETERMINISTICALLY in CI
// rather than looking like an ordinary flake. Wait for the position to repeat instead.
// Also used for async-rendered widgets that can re-render after they first appear (the
// search dropdown debounces 150ms and drops stale responses by sequence, so a second
// render can land after the rows exist -- resetting the keyboard selection and
// swallowing an Enter that was pressed in between).
export async function waitStable(sample, { tries = 40, gap = 100 } = {}) {
  let prev = null;
  for (let i = 0; i < tries; i++) {
    const cur = await sample();
    const key = cur == null ? null : JSON.stringify(cur);
    if (key != null && key === prev) return cur;
    prev = key;
    await new Promise((r) => setTimeout(r, gap));
  }
  return null;
}

export async function waitMapStill(sample, opts) {
  return waitStable(sample, opts);
}

// Run `act`, then wait for the model viewer to have REBUILT and settled.
//
// Every equip, every hover preview and every appearance change builds a NEW viewer (see
// "The camera survives a re-mount" in the root CLAUDE.md), so the hook object's identity
// flipping is the exact "the change has landed" signal -- and `running === false` is then
// the frame a snapshot() will read. That matters because almost every test here asserts by
// comparing two snapshots, and a snapshot taken mid-rebuild compares the wrong frames.
//
// This replaces the sleeps that used to stand in for it. Measured on the race swap it was
// written for: identity flips at 143ms and the loop is idle at 160ms, where the sleep
// guessed 2500ms. It is not only ~15x faster, it is the more correct wait: a fixed sleep
// expires whether or not the model finished loading, so on a slow machine it asserts on
// whatever happened to be on screen.
export async function afterRemount(act, { timeout = T } = {}) {
  await page.evaluate(() => { window.__mvPrev = window.__mv; });
  await act();
  await page.waitForFunction(
    () => window.__mv && window.__mv !== window.__mvPrev
      && window.__mv().triangles > 0 && window.__mv().running === false,
    { timeout },
  );
}

// The same settle without a rebuild: the viewer is the one already mounted, we just want
// the render loop to have gone quiet before reading a frame.
export async function viewerIdle({ timeout = T } = {}) {
  await page.waitForFunction(
    () => window.__mv && window.__mv().triangles > 0 && window.__mv().running === false,
    { timeout },
  );
}

// Detail pages carry a Share button copying the prerendered /<prefix>/<id> link.
export async function testShareButton(param, id, prefix) {
  await nav(`?${param}=${id}`);
  await page.waitForSelector(".share-btn", { timeout: T });
  await page.click(".share-btn");
  const copied = await page.evaluate(() => window.__copied);
  const ok = typeof copied === "string" && copied.endsWith(`/${prefix}/${id}`);
  console.log(`share-btn ${param}=${id}: copied="${copied}" ok=${ok}`);
  return ok;
}

// The Location cell names BOTH halves and both are reachable: the zone, and the
// sub-area when one dominates the NPC's spawns. The subzone half was plain text
// until the shared `subSuffix` helper started linking it -- and that one cell is
// rendered by every Location column on the site (quest givers, drop sources,
// vendors, faction members), so the topic modules each point it at their own.
// `tab` clicks a tab by label first, for pages where Location isn't the default pane.
export async function testLocationSubzoneLink(url, expectSub, tab = null) {
  await nav(url);
  await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: T });
  if (tab) {
    await page.evaluate((t) => { const b = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(t)); if (b) b.click(); }, tab);
    await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: T });
  }
  const cell = await page.$$eval(".tabpane:not(.hidden) tbody tr td", (tds) => {
    const td = tds.find((t) => t.querySelector('a.ilink[href^="?subzone="]'));
    if (!td) return null;
    const a = td.querySelector('a.ilink[href^="?subzone="]');
    return { href: a.getAttribute("href"), name: a.textContent.trim(),
             zoneLink: !!td.querySelector('a.ilink[href^="?zone="]') };
  });
  console.log(`loc-subzone-link ${url}${tab ? ` [${tab}]` : ""}: ${JSON.stringify(cell)}`);
  return !!cell && cell.zoneLink && /^\?subzone=\d+$/.test(cell.href) && (!expectSub || cell.name === expectSub);
}
