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
