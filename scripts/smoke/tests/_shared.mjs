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
