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
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".results table tbody tr", { timeout: 30000 });
  const count = await page.$$eval(".results table tbody tr", (r) => r.length);
  const first = await page.$eval(".results table tbody tr td a", (a) => a.textContent).catch(() => "?");
  console.log(`search "${term}": ${count} results, first="${first}"`);
  return count > 0;
}

let ok = true;
const t = Date.now();
ok = (await testItem(7909, "Aquamarine")) && ok;
ok = (await testItem(55356, "Netherwrought")) && ok;
ok = (await testItem(647, "Destiny")) && ok;
ok = (await testSearch("thunder")) && ok;
console.log(`\nelapsed ${Date.now() - t}ms`);
if (errors.length) { console.log("\nERRORS:\n" + errors.slice(0, 20).join("\n")); }
console.log(ok && !errors.length ? "\nSMOKE: PASS" : "\nSMOKE: FAIL");
await browser.close();
process.exit(ok && !errors.length ? 0 : 1);
