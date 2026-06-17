import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.SMOKE_BASE || "http://localhost:4317/tortoise-db-viewer/";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
const BENIGN = /favicon\.ico|icons\.json/;
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("requestfailed", (r) => { if (!BENIGN.test(r.url())) errors.push("reqfail: " + r.url() + " " + r.failure()?.errorText); });
page.on("response", (r) => { if (r.status() >= 400 && !BENIGN.test(r.url())) errors.push(`http ${r.status()}: ${r.url()}`); });

async function testItem(id, expectName) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".tooltip .tt-name", { timeout: 40000 });
  const name = await page.$eval(".tooltip .tt-name", (el) => el.textContent);
  await page.waitForSelector(".item-rel", { timeout: 40000 });
  const panels = await page.$$eval(".item-rel .panel h2", (els) => els.map((e) => e.textContent));
  const firstDrop = await page.$eval(".item-rel .panel tbody tr td", (e) => e.textContent).catch(() => "(none)");
  console.log(`item ${id}: name="${name}" expect~"${expectName}" panels=[${panels.join(", ")}] firstRow="${firstDrop}"`);
  return name.includes(expectName);
}

async function testSearch(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".results table tbody tr", { timeout: 40000 });
  const count = await page.$$eval(".results table tbody tr", (r) => r.length);
  const first = await page.$eval(".results table tbody tr td a", (a) => a.textContent).catch(() => "?");
  console.log(`search "${term}": ${count} results, first="${first}"`);
  return count > 0;
}

async function testNpc(id, expectName) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  const panels = await page.$$eval(".item-rel .panel h2", (els) => els.map((e) => e.textContent));
  console.log(`npc ${id}: name="${name}" expect~"${expectName}" panels=[${panels.join(", ")}]`);
  return name.includes(expectName);
}

async function testBrowse(kind, query = "") {
  await page.goto(`${BASE}?browse=${kind}${query}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const filters = await page.$$eval(".filters [data-f]", (e) => e.length);
  const count = await page.$eval(".browse-count", (e) => e.textContent).catch(() => "?");
  console.log(`browse ${kind}${query}: ${rows} rows, ${filters} filters, "${count}"`);
  return rows > 0 && filters > 0;
}

let ok = true;
const t = Date.now();
ok = (await testItem(7909, "Aquamarine")) && ok;
ok = (await testItem(55356, "Netherwrought")) && ok;
ok = (await testItem(647, "Destiny")) && ok;
ok = (await testSearch("thunder")) && ok;
ok = (await testNpc(2376, "Torn Fin Oracle")) && ok;
ok = (await testBrowse("items", "&class=2&quality=4&minrl=40")) && ok;
ok = (await testBrowse("npcs", "&rank=3")) && ok;
console.log(`\nelapsed ${Date.now() - t}ms`);
if (errors.length) { console.log("\nERRORS:\n" + errors.slice(0, 20).join("\n")); }
console.log(ok && !errors.length ? "\nSMOKE: PASS" : "\nSMOKE: FAIL");
await browser.close();
process.exit(ok && !errors.length ? 0 : 1);
