import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.SMOKE_BASE || "http://localhost:4317/tortoise-db-viewer/";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
// capture clipboard writes so the copy operations can be asserted headlessly
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } },
  });
});
const errors = [];
// Ignore: favicon, the optional icon atlas manifest, and the third-party WoW
// icon CDN. CDN item icons are decorative (render.js falls back to the atlas /
// renders without them) and headless Chrome intermittently ORB-blocks them after
// the CDN's render-us -> render/us redirect, which would flake the run.
const BENIGN = /favicon\.ico|icons\.json|worldofwarcraft\.com/;
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("requestfailed", (r) => { if (!BENIGN.test(r.url())) errors.push("reqfail: " + r.url() + " " + r.failure()?.errorText); });
page.on("response", (r) => { if (r.status() >= 400 && !BENIGN.test(r.url())) errors.push(`http ${r.status()}: ${r.url()}`); });

async function testItem(id, expectName) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".tooltip .tt-name", { timeout: 40000 });
  const name = await page.$eval(".tooltip .tt-name", (el) => el.textContent);
  await page.waitForSelector(".item-rel .tab", { timeout: 40000 });
  const tabList = await page.$$eval(".item-rel .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const sortableH = await page.$$eval(".item-rel .tabpane:not(.hidden) th.sortable", (e) => e.length);
  console.log(`item ${id}: name="${name}" tabs=[${tabList.join(", ")}] sortableHdrs=${sortableH}`);
  return name.includes(expectName) && tabList.length > 0 && sortableH > 0;
}

// recipe/pattern/plans item shows a "Teaches" tab with the craft it unlocks
async function testTeaches(id, expectName) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".item-rel .tab", { timeout: 40000 });
  const tabs = await page.$$eval(".item-rel .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const has = tabs.some((t) => /^Teaches\b/.test(t));
  console.log(`teaches ${id}: tabs=[${tabs.join(", ")}] hasTeaches=${has}`);
  return has;
}

// container/lockbox item shows a "Contains" tab listing what it yields
async function testContainer(id, expectName) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".item-rel .tab", { timeout: 40000 });
  const tabs = await page.$$eval(".item-rel .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const has = tabs.some((t) => /^Contains\b/.test(t));
  console.log(`container ${id}: tabs=[${tabs.join(", ")}] hasContains=${has}`);
  return has;
}

// Turtle custom icon (not on Blizzard CDN) renders from the sprite atlas as a
// <span class="icon-sprite"> backed by custom-atlas.webp. Item 9376 Jang'thraze
// uses custom icon "gensword1h_4".
async function testCustomIcon(id, expectName) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".tooltip .tt-name", { timeout: 40000 });
  const name = await page.$eval(".tooltip .tt-name", (e) => e.textContent);
  const bg = await page.$eval(".tooltip .tt-head .icon-sprite", (e) => e.style.backgroundImage).catch(() => "");
  console.log(`custom icon ${id}: name="${name}" spriteBg="${bg}"`);
  return name.includes(expectName) && /custom-atlas\.webp/.test(bg);
}

async function testSearch(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".results table tbody tr", { timeout: 40000 });
  const count = await page.$$eval(".results table tbody tr", (r) => r.length);
  const first = await page.$eval(".results table tbody tr td a", (a) => a.textContent).catch(() => "?");
  console.log(`search "${term}": ${count} results, first="${first}"`);
  return count > 0;
}

async function testNpc(id, expectName, expectTab) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  const tabsList = await page.$$eval(".tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const sortableH = await page.$$eval(".tabpane:not(.hidden) th.sortable", (e) => e.length);
  console.log(`npc ${id}: name="${name}" tabs=[${tabsList.join(", ")}] sortableHdrs=${sortableH}`);
  return name.includes(expectName) && tabsList.length > 0 && sortableH > 0 && (!expectTab || tabsList.some((t) => t.includes(expectTab)));
}

// Measure the in-app (SPA) navigation render time — the actual "click an NPC"
// path (DB already in memory; just queries + render). Catches query regressions
// like an unindexed spawn_points scan. App must already be loaded (warm).
async function testNpcLoad(id, maxMs) {
  await page.goto(`${BASE}?item=2770`, { waitUntil: "networkidle0", timeout: 40000 }); // warm the DB
  await page.waitForSelector(".tooltip .tt-name", { timeout: 40000 });
  const ms = await page.evaluate((id) => {
    const t0 = performance.now();
    history.pushState({}, "", `?npc=${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return new Promise((res) => {
      const check = () => (document.querySelector(".npc-head h1") ? res(performance.now() - t0) : requestAnimationFrame(check));
      check();
    });
  }, id);
  console.log(`npc ${id} in-app load: ${ms.toFixed(0)}ms (budget ${maxMs}ms)`);
  return ms < maxMs;
}

async function testBrowseSource(src) {
  await page.goto(`${BASE}?browse=items&source=${src}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const tags = await page.$$eval(".browse td.src-col .tagx", (e) => e.length);
  const checked = await page.$$eval(".multi [data-mv='source']:checked", (e) => e.map((c) => c.value));
  console.log(`browse source=${src}: rows=${rows} tags=${tags} headers=[${headers.join(",")}] checked=[${checked.join(",")}]`);
  return rows > 0 && headers.includes("Source") && tags > 0 && checked.includes(src);
}

async function testItemSources(id, expectTag) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".item-sources .tagx", { timeout: 40000 });
  const tags = await page.$$eval(".item-sources .tagx", (e) => e.map((t) => t.textContent.trim()));
  console.log(`item sources ${id}: [${tags.join(", ")}]`);
  return tags.length > 0 && (!expectTag || tags.includes(expectTag));
}

// new select filters: confirm the param yields rows and the select reflects it.
async function testFilter(param, value) {
  await page.goto(`${BASE}?browse=items&${param}=${value}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const sel = await page.$eval(`.filters [data-f='${param}']`, (e) => e.value).catch(() => "?");
  console.log(`filter ${param}=${value}: rows=${rows} selected=${sel}`);
  return rows > 0 && sel === value;
}

// crafted item shows its crafting profession in the "Created by" section.
async function testCrafted(id, expectProf) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".item-rel", { timeout: 40000 });
  const cells = await page.$$eval(".item-rel td", (tds) => tds.map((t) => t.textContent.trim()));
  const hit = cells.some((t) => t.includes(expectProf));
  // Created-by reagents must be clickable item links, not plain text
  await page.$$eval(".item-rel .tab", (tabs) => { const t = tabs.find((x) => /Created by/.test(x.textContent)); if (t) t.click(); });
  const reagentLinks = await page.$$eval('.item-rel .tabpane:not(.hidden) td a.ilink', (a) => a.length).catch(() => 0);
  // profession links to the crafting browse filtered to that profession
  const profLink = await page.$$eval('.item-rel .tabpane:not(.hidden) a.nav[href*="browse=crafting&prof"]', (a) => a.length).catch(() => 0);
  console.log(`crafted ${id}: profession "${expectProf}" present=${hit} reagentLinks=${reagentLinks} profLink=${profLink}`);
  return hit && reagentLinks > 0 && profLink > 0;
}

// crafting browse: filtered to one profession, grouped, with skill-up brackets
// (orange #ff8040 span) and a Source column (recipe link / Trainer badge).
async function testCrafting() {
  // prof-filtered view: the redundant Profession column is hidden; skill-up
  // brackets render. (Grouping by the single profession is moot, so it ungroups.)
  await page.goto(`${BASE}?browse=crafting&prof=171`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const profSel = await page.$eval(".filters [data-f='prof']", (e) => e.value).catch(() => "?");
  const brackets = await page.$$eval(".browse tbody td span[style*='ff8040']", (e) => e.length);
  // grouping still works (group by source TYPE, header = Recipe/Trainer/Auto)
  await page.goto(`${BASE}?browse=crafting&prof=171&groupby=source`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse .grouprow", { timeout: 40000 });
  const groupHeads = await page.$$eval(".browse .grouprow", (e) => e.map((g) => g.textContent.replace(/[▸▾\s]+/g, " ").trim()));
  const typeGroups = groupHeads.every((g) => /Recipe|Trainer|Auto|Other/.test(g));
  console.log(`crafting prof=171: rows=${rows} headers=[${headers.join(",")}] profSel=${profSel} brackets=${brackets} groups=[${groupHeads.join(",")}]`);
  return rows > 0 && headers.includes("Skill") && headers.includes("Source") && !headers.includes("Profession") && profSel === "171" && brackets > 0 && groupHeads.length > 0 && typeGroups;
}

// enchanting crafts produce no item (they apply an enchant), so the Name column
// links the craft spell itself; assert these item-less rows render and resolve a
// recipe Source (regression: the whole profession was missing from Crafting).
async function testCraftEnchanting() {
  await page.goto(`${BASE}?browse=crafting&prof=333`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  // Name column links a craft spell (?spell=) for the item-less enchant rows
  const spellLinks = await page.$$eval('.browse tbody td a.ilink.spell[href*="spell="]', (a) => a.length);
  console.log(`crafting prof=333 (enchanting): rows=${rows} spellLinks=${spellLinks}`);
  return rows > 30 && spellLinks > 0;
}

// "Obtainable only" checkbox (default on) hides crafts with no recipe/trainer/auto
async function testCraftObtainable() {
  const count = async (qs) => {
    await page.goto(`${BASE}?browse=crafting&prof=755${qs}`, { waitUntil: "networkidle0", timeout: 40000 });
    await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
    return page.evaluate(() => ({
      rows: document.querySelectorAll(".browse table tbody tr").length,
      checked: document.querySelector('input[data-f="obtainable"]')?.checked,
      dash: [...document.querySelectorAll(".browse table tbody tr")].filter((r) => r.lastElementChild?.textContent.trim() === "—").length,
    }));
  };
  const on = await count("");
  const all = await count("&obtainable=0");
  console.log(`craft obtainable: default rows=${on.rows} checked=${on.checked} dash=${on.dash} | all rows=${all.rows} checked=${all.checked} dash=${all.dash}`);
  // rows are page-capped at 100; the sourceless ("—") rows are the proof
  return on.checked === true && on.dash === 0 && all.checked === false && all.dash > 0;
}

// row selection: ID column gone, ops disabled until a row is picked, prefix copy.
async function testSelection() {
  await page.goto(`${BASE}?browse=items`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse tbody tr [data-selrow]", { timeout: 40000 });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const noId = !headers.includes("ID");
  const disabled0 = await page.$eval('.selbar [data-op="ids"]', (b) => b.disabled);
  const firstId = await page.$eval(".browse tbody tr [data-selrow]", (el) => el.getAttribute("data-selrow"));
  await page.click(".browse tbody tr [data-selrow]");
  const count1 = await page.$eval("[data-selcount]", (e) => e.textContent);
  const enabled = await page.$eval('.selbar [data-op="ids"]', (b) => !b.disabled);
  await page.click('.selbar [data-op="prefix"]');
  const copied = await page.evaluate(() => window.__copied);
  const okPrefix = copied === `.additem ${firstId}`;
  console.log(`selection: noId=${noId} disabled0=${disabled0} count="${count1}" enabled=${enabled} copied="${copied}"`);
  return noId && disabled0 && enabled && count1 === "1 selected" && okPrefix;
}

// group selection: grouping by Slot, ticking a group header selects all its rows.
async function testGroupSelection() {
  await page.goto(`${BASE}?browse=items&class=4`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse [data-groupby]", { timeout: 40000 });
  const val = await page.$$eval(".browse [data-groupby] option", (opts) => {
    const o = opts.find((x) => x.textContent.trim() === "Slot"); return o ? o.value : "";
  });
  await page.select(".browse [data-groupby]", val);
  await page.waitForSelector(".browse [data-selgroup]", { timeout: 40000 });
  await page.click(".browse [data-selgroup]");
  const count = await page.$eval("[data-selcount]", (e) => e.textContent);
  const n = parseInt(count, 10) || 0;
  console.log(`group selection: "${count}"`);
  return n > 1;
}

// unobtainable (dev-artifact) items are hidden by default but shown when opted in;
// item 5031 ("ZZZZZZZZ") is a known dev artifact.
async function testUnobtainable() {
  const has = async (src) => {
    await page.goto(`${BASE}?browse=items&source=${src}&q=ZZZZZZZZ`, { waitUntil: "networkidle0", timeout: 40000 });
    await page.waitForSelector(".browse", { timeout: 40000 });
    return page.$$eval(".browse table tbody tr", (r) => r.length).catch(() => 0);
  };
  // default (no source filter): the junk item must be hidden
  await page.goto(`${BASE}?browse=items&q=ZZZZZZZZ`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse", { timeout: 40000 });
  const hiddenByDefault = await page.$$eval(".browse table tbody tr", (r) => r.length).catch(() => 0);
  const shownWhenOptedIn = await has("unobtainable");
  console.log(`unobtainable: defaultRows=${hiddenByDefault} (want 0) optedInRows=${shownWhenOptedIn} (want >0)`);
  return hiddenByDefault === 0 && shownWhenOptedIn > 0;
}

// A spawning NPC's page renders its zone map with the parchment image + its
// own spawn pins (focus layer).
async function testNpcMap(id) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 30000 }).catch(() => {});
  const hasMap = (await page.$("#zonemap .leaflet-image-layer")) !== null;
  const pins = await page.$$eval("#zonemap .leaflet-marker-icon", (e) => e.length).catch(() => 0);
  console.log(`npc ${id} map: hasMap=${hasMap} pins=${pins}`);
  return hasMap && pins > 0;
}

async function testNpcTypeLink(id) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-meta a.nav[href*='browse=npcs']", { timeout: 40000 });
  const href = await page.$eval(".npc-meta a.nav[href*='browse=npcs']", (e) => e.getAttribute("href"));
  const label = await page.$eval(".npc-meta a.nav[href*='browse=npcs']", (e) => e.textContent.trim());
  await page.click(".npc-meta a.nav[href*='browse=npcs']");
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const typeSel = await page.$eval(".filters [data-f='type']", (e) => e.value).catch(() => "?");
  const m = /type=(\d+)/.exec(href);
  const matchSel = m && m[1] === typeSel;
  console.log(`npc type link ${id}: label="${label}" href="${href}" filterType=${typeSel} match=${matchSel}`);
  return /browse=npcs&type=\d+/.test(href) && matchSel;
}

async function testBrowse(kind, query = "", expectHeader) {
  await page.goto(`${BASE}?browse=${kind}${query}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
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

async function testBrowsePersist() {
  await page.goto(`${BASE}?browse=items&class=4&sort=ilvl&dir=d&groupby=slot`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const active = await page.$eval(".browse th.active", (e) => e.textContent.trim()).catch(() => "(none)");
  const groups = await page.$$eval(".browse .grouprow", (e) => e.length);
  const groupSel = await page.$eval(".browse [data-groupby]", (e) => e.value).catch(() => "?");
  console.log(`browse persist: active="${active}" groupRows=${groups} groupSel=${groupSel}`);
  return active.includes("iLvl") && groups > 0;
}

async function testBrowseMulti() {
  await page.goto(`${BASE}?browse=items&quality=3,4&slot=1,5`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const checked = await page.$$eval(".multi [data-mv]:checked", (e) => e.map((c) => `${c.dataset.mv}:${c.value}`));
  console.log(`browse multi: rows=${rows} checked=[${checked.join(",")}]`);
  return rows > 0 && ["quality:3", "quality:4", "slot:1", "slot:5"].every((k) => checked.includes(k));
}

async function testBrowseCriteria() {
  const q = encodeURIComponent("agi,>=,10|sta,>=,10"); // multi-criteria, AND-combined
  await page.goto(`${BASE}?browse=items&stats=${q}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const critRows = await page.$$eval(".crit-row", (e) => e.length);
  const cstats = await page.$$eval(".crit-row [data-cstat]", (e) => e.map((s) => s.value));
  console.log(`browse criteria: rows=${rows} headers=[${headers.join(",")}] critRows=${critRows} cstats=[${cstats.join(",")}]`);
  return rows > 0 && headers.includes("Agility") && headers.includes("Stamina")
    && critRows === 2 && cstats.includes("agi") && cstats.includes("sta");
}

async function testDungeons() {
  await page.goto(`${BASE}?dungeons`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".results table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".results table tbody tr", (r) => r.length);
  console.log(`dungeons index: ${rows} rows`);
  return rows > 0;
}
async function testDungeon(id, expectName) {
  await page.goto(`${BASE}?dungeon=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 30000 }).catch(() => {});
  const hasMap = (await page.$("#zonemap .leaflet-image-layer")) !== null;
  await page.waitForSelector("#zonemap .map-boss", { timeout: 15000 }).catch(() => {});
  const bossPins = await page.$$eval("#zonemap .map-boss", (e) => e.length).catch(() => 0);
  const tabList = await page.$$eval(".tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const groupRows = await page.$$eval(".tabpane:not(.hidden) .grouprow", (e) => e.length);
  const hasGroupCtl = (await page.$(".tabpane:not(.hidden) [data-groupby]")) !== null;
  await page.click(".tabpane:not(.hidden) .grouprow");
  const collapseOk = await page.evaluate(() => {
    const gr = document.querySelector(".tabpane:not(.hidden) .grouprow.collapsed");
    if (!gr) return false;
    const key = gr.getAttribute("data-group");
    const rows = [...document.querySelectorAll(".tabpane:not(.hidden) tbody tr[data-group]")]
      .filter((t) => !t.classList.contains("grouprow") && t.getAttribute("data-group") === key);
    return rows.length > 0 && rows.every((t) => t.style.display === "none");
  });
  console.log(`dungeon ${id}: name="${name}" tabs=[${tabList.join(", ")}] groupRows=${groupRows} groupCtl=${hasGroupCtl} collapse=${collapseOk} map=${hasMap} bossPins=${bossPins}`);
  return name.includes(expectName) && tabList.some((t) => t.includes("Boss Loot")) && groupRows > 0 && hasGroupCtl && collapseOk && hasMap && bossPins > 0;
}

// The zone route auto-detects an instance map: ?zone=<areaid of a dungeon> shows
// the Boss Loot tab, the parchment, and skull boss markers.
async function testInstanceZone(areaid, expectName) {
  await page.goto(`${BASE}?zone=${areaid}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  await page.waitForSelector("#zonemap .map-boss", { timeout: 30000 }).catch(() => {});
  const bossPins = await page.$$eval("#zonemap .map-boss", (e) => e.length).catch(() => 0);
  const hasMap = (await page.$("#zonemap .leaflet-image-layer")) !== null;
  const tabList = await page.$$eval(".tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  console.log(`zone-instance ${areaid}: name="${name}" tabs=[${tabList.join(", ")}] map=${hasMap} bossPins=${bossPins}`);
  return name.includes(expectName) && tabList.some((t) => t.includes("Boss Loot")) && hasMap && bossPins > 0;
}

// A map-less instance (no WorldMap parchment, e.g. Dire Maul) still renders via
// the ?dungeon= fallback: Boss Loot tab, no zone map.
async function testDungeonNoMap(id, expectName) {
  await page.goto(`${BASE}?dungeon=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const mapDiv = (await page.$("#zonemap")) !== null;
  console.log(`dungeon-nomap ${id}: name="${name}" tabs=[${tabList.join(", ")}] mapDiv=${mapDiv}`);
  return name.includes(expectName) && tabList.some((t) => t.includes("Boss Loot")) && !mapDiv;
}

async function testHover() {
  await page.goto(`${BASE}?search=copper`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".results table tbody tr td a.ilink", { timeout: 40000 });
  await page.hover(".results table tbody tr td a.ilink");
  await page.waitForSelector(".hovercard .tt-name", { timeout: 10000 }).catch(() => {});
  const name = await page.$eval(".hovercard .tt-name", (e) => e.textContent).catch(() => "(none)");
  console.log(`hover: card name="${name}"`);
  return name !== "(none)";
}

// quest detail: header + tabs (givers/objectives/rewards) + sortable pane + desc.
async function testQuest(id, expectName) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".quest-page .npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".quest-page .npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".quest-page .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const sortableH = await page.$$eval(".quest-page .tabpane:not(.hidden) th.sortable", (e) => e.length);
  const descBlocks = await page.$$eval(".quest-desc h3", (e) => e.length);
  console.log(`quest ${id}: name="${name}" tabs=[${tabList.join(", ")}] sortableHdrs=${sortableH} descBlocks=${descBlocks}`);
  return name.includes(expectName) && tabList.length > 0 && sortableH > 0;
}

// spell detail: header name + relation tabs + sortable pane (+ Learned-from link
// when craft-taught -- the recipe item links back from the spell page).
async function testSpell(id, expectName) {
  await page.goto(`${BASE}?spell=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".spell-page .npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".spell-page .npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".spell-page .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const sortableH = await page.$$eval(".spell-page .tabpane:not(.hidden) th.sortable", (e) => e.length);
  const learned = await page.$$eval(".spell-page .npc-head a.ilink", (e) => e.length);
  console.log(`spell ${id}: name="${name}" tabs=[${tabList.join(", ")}] sortableHdrs=${sortableH} learnedLinks=${learned}`);
  return name.includes(expectName) && tabList.length > 0 && sortableH > 0;
}

// detailed spell page: "Details on spell" grid + per-effect breakdown resolved
// from the client DBC lookups (e.g. spell 10 Blizzard -> Frost, effect rows).
async function testSpellDetail(id, expectText) {
  await page.goto(`${BASE}?spell=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".spell-page .kv-grid", { timeout: 40000 });
  const keys = await page.$$eval(".spell-page .kv-grid .kv-k", (e) => e.length);
  const effects = await page.$$eval(".spell-page .spell-effect", (e) => e.length);
  const text = await page.$eval(".spell-page .spell-details", (e) => e.textContent.replace(/\s+/g, " "));
  const tabList = await page.$$eval(".spell-page .tab", (e) => e.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
  const learnable = await page.$$eval(".spell-page .npc-head .tagx", (e) => e.length);
  const trained = tabList.some((t) => /^Trained by\b/.test(t));
  console.log(`spell detail ${id}: kvKeys=${keys} effects=${effects} learnable=${learnable} trainedTab=${trained} hasText(${expectText})=${text.includes(expectText)}`);
  return keys >= 6 && effects > 0 && text.includes(expectText) && learnable > 0 && trained;
}

// item tooltip green spell lines are now spell links (item -> ?spell=).
async function testItemSpellLink(id) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".item-main .tooltip", { timeout: 40000 });
  const links = await page.$$eval(".item-main .tt-spell a.ilink.spell", (e) => e.length);
  console.log(`item ${id} spell links: ${links}`);
  return links > 0;
}

// search includes spells: a craft term yields a Spells tab.
async function testSearchSpells(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".results .tabbar .tab", { timeout: 40000 });
  const tabs = await page.$$eval(".results .tabbar .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const spellRows = await page.$$eval('.results [data-pane="spells"] tbody tr', (r) => r.length).catch(() => 0);
  const has = tabs.some((t) => /^Spells\b/.test(t));
  console.log(`search spells "${term}": tabs=[${tabs.join(", ")}] spellTab=${has} spellRows=${spellRows}`);
  return has && spellRows > 0;
}

// unified search renders a tabbed results page spanning multiple entity types.
async function testSearchTabs(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".results .tabbar .tab", { timeout: 40000 });
  const tabList = await page.$$eval(".results .tabbar .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const rows = await page.$$eval(".results .tabpane:not(.hidden) table tbody tr", (r) => r.length);
  console.log(`search tabs "${term}": [${tabList.join(", ")}] firstPaneRows=${rows}`);
  return tabList.length > 1 && rows > 0;
}

// search includes zones: "Tanaris" yields a Zones tab with >=1 row
async function testSearchZone(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".results .tabbar .tab", { timeout: 40000 });
  const tabs = await page.$$eval(".results .tabbar .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const zoneRows = await page.$$eval('.results [data-table="zones"] tbody tr, .results [data-pane="zones"] tbody tr', (r) => r.length).catch(() => 0);
  const has = tabs.some((t) => /^Zones\b/.test(t));
  console.log(`search zones "${term}": tabs=[${tabs.join(", ")}] zoneTab=${has} zoneRows=${zoneRows}`);
  return has;
}

// live dropdown: typing yields rows; ArrowDown+Enter navigates to a detail page.
async function testSearchDropdown(term) {
  await page.goto(`${BASE}?`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector("#search", { timeout: 40000 });
  await page.click("#search");
  await page.type("#search", term, { delay: 30 });
  await page.waitForSelector(".search-dropdown .sd-row", { timeout: 10000 });
  const rows = await page.$$eval(".search-dropdown .sd-row", (e) => e.length);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /[?&](item|npc|quest|dungeon|search)=/.test(location.search), { timeout: 10000 }).catch(() => {});
  const url = await page.evaluate(() => location.search);
  console.log(`dropdown "${term}": rows=${rows} navigatedTo="${url}"`);
  return rows > 1 && /[?&](item|npc|quest|dungeon|search)=/.test(url);
}

// faction detail: header + tabs, items grouped by standing, sortable pane.
async function testFaction(id, expectName) {
  await page.goto(`${BASE}?faction=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-page .npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-page .npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".npc-page .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const groupRows = await page.$$eval(".npc-page .tabpane:not(.hidden) .grouprow", (e) => e.length);
  const sortableH = await page.$$eval(".npc-page .tabpane:not(.hidden) th.sortable", (e) => e.length);
  console.log(`faction ${id}: name="${name}" tabs=[${tabList.join(", ")}] groupRows=${groupRows} sortableHdrs=${sortableH}`);
  return name.includes(expectName) && tabList.length > 0 && groupRows > 0 && sortableH > 0;
}

// a quest that grants reputation renders its faction as a link.
async function testQuestRepLink(id) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".quest-desc", { timeout: 40000 });
  const links = await page.$$eval(".quest-desc a.ilink.faction", (e) => e.length);
  console.log(`quest ${id} rep faction links: ${links}`);
  return links > 0;
}

// zone page: Leaflet renders the parchment image + per-category marker toggles.
// (markers use a canvas renderer, so assert the image layer + layer control.)
async function testZone(id, expectName) {
  await page.goto(`${BASE}?zone=${id}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector(".zone-page .npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".zone-page .npc-head h1", (e) => e.textContent);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 40000 });
  const cats = await page.$$eval(".leaflet-control-layers-overlays label", (e) => e.length);
  const tabList = await page.$$eval(".zone-page .tabbar .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const rows = await page.$$eval(".zone-page .tabpane:not(.hidden) table tbody tr", (r) => r.length);
  console.log(`zone ${id}: name="${name}" mapImg=yes categories=${cats} tabs=[${tabList.join(", ")}] firstPaneRows=${rows}`);
  return name.includes(expectName) && cats > 0 && tabList.length === 3 && rows > 0;
}

// client-only zones (map texture, no spawns in the public SQL export) render the
// parchment map + an explanatory note instead of three blank tabs.
async function testEmptyZone(id, expectName) {
  await page.goto(`${BASE}?zone=${id}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector(".zone-page .npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".zone-page .npc-head h1", (e) => e.textContent);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 40000 });
  const hasNote = (await page.$(".zone-page .zone-empty")) !== null;
  const hasTabs = (await page.$(".zone-page .tabbar")) !== null;
  console.log(`empty zone ${id}: name="${name}" mapImg=yes note=${hasNote} tabs=${hasTabs}`);
  return name.includes(expectName) && hasNote && !hasTabs;
}

let ok = true;
const t = Date.now();
ok = (await testItem(7909, "Aquamarine")) && ok;
ok = (await testItem(2770, "Copper Ore")) && ok;
ok = (await testItem(55356, "Netherwrought")) && ok;
ok = (await testItem(647, "Destiny")) && ok;
ok = (await testContainer(16882, "Junkbox")) && ok;  // lockbox -> Contains tab
ok = (await testTeaches(70204, "Shadowforged")) && ok;  // recipe -> Teaches tab
ok = (await testCustomIcon(9376, "Jang")) && ok;
ok = (await testSearch("thunder")) && ok;
ok = (await testQuest(14, "Militia")) && ok;
ok = (await testSearchTabs("defias")) && ok;
ok = (await testSearchZone("Tanaris")) && ok;
ok = (await testSearchDropdown("defias")) && ok;
ok = (await testSpell(41746, "Shadowforged Eye")) && ok;   // craft spell: Creates/Reagents tabs + Learned-from link
ok = (await testSpellDetail(10, "Frost")) && ok;           // Blizzard: details grid + effect breakdown (DBC-resolved)
ok = (await testItemSpellLink(70204)) && ok;               // recipe item: green "Teaches…" now links to ?spell=
ok = (await testSearchSpells("Shadowforged")) && ok;       // search yields a Spells tab
ok = (await testBrowse("spells", "", "Profession")) && ok; // ?browse=spells finder
ok = (await testBrowse("quests", "&minlvl=1&maxlvl=12", "Zone")) && ok;
ok = (await testFaction(509, "League of Arathor")) && ok;
ok = (await testQuestRepLink(14)) && ok;
ok = (await testBrowse("factions", "", "Items")) && ok;
ok = (await testZone(12, "Elwynn")) && ok;
ok = (await testZone(5561, "Balor")) && ok;             // 1.18.1 zone, populated via migrations
ok = (await testEmptyZone(5722, "Thorn Gorge")) && ok; // 1.18.1 zone with no spawns upstream yet
ok = (await testBrowse("zones", "", "Continent")) && ok;
ok = (await testNpcLoad(15379, 400)) && ok;  // AQ NPC, many spawns; ~4ms healthy, 726ms if zone lookup unindexed
ok = (await testNpc(2376, "Torn Fin Oracle")) && ok;
ok = (await testNpc(80402, "Aemara Sunsorrow", "Teaches")) && ok;  // trainer -> Teaches tab
ok = (await testNpc(10981, "", "Skinning")) && ok;
ok = (await testNpcTypeLink(2376)) && ok;
ok = (await testNpcMap(2376)) && ok;  // NPC page shows its zone map + spawn pins
ok = (await testDungeons()) && ok;
ok = (await testDungeon(36, "Deadmines")) && ok;          // ?dungeon= redirects to the zone view
ok = (await testInstanceZone(5138, "Deadmines")) && ok;  // ?zone= auto-detects the dungeon
ok = (await testDungeonNoMap(429, "Dire Maul")) && ok;   // map-less instance fallback
ok = (await testBrowsePersist()) && ok;
ok = (await testBrowseMulti()) && ok;
ok = (await testBrowseCriteria()) && ok;
ok = (await testHover()) && ok;
const sc = (s) => `&stats=${encodeURIComponent(s)}`;
ok = (await testBrowse("items", "&class=2&quality=4&minrl=40", "DPS")) && ok;
ok = (await testBrowse("items", `&class=4${sc("armor,>=,100")}`, "Armor")) && ok;
ok = (await testBrowse("items", sc("agi,>=,20"), "Agility")) && ok;
ok = (await testBrowse("items", sc("sp,>=,20"), "Spell Power")) && ok;
ok = (await testBrowse("npcs", "&rank=3")) && ok;
ok = (await testBrowseSource("vendor")) && ok;
ok = (await testItemSources(2770)) && ok;
ok = (await testItemSources(5031, "Unobtainable")) && ok;
ok = (await testUnobtainable()) && ok;
ok = (await testFilter("bind", "2")) && ok;
ok = (await testFilter("uclass", "8")) && ok;
ok = (await testFilter("faction", "a")) && ok;
ok = (await testFilter("prof", "197")) && ok;
ok = (await testFilter("unique", "1")) && ok;
ok = (await testCrafted(2575, "Tailoring")) && ok;
ok = (await testCrafting()) && ok;
ok = (await testCraftEnchanting()) && ok;
ok = (await testCraftObtainable()) && ok;
ok = (await testSelection()) && ok;
ok = (await testGroupSelection()) && ok;
console.log(`\nelapsed ${Date.now() - t}ms`);
if (errors.length) { console.log("\nERRORS:\n" + errors.slice(0, 20).join("\n")); }
console.log(ok && !errors.length ? "\nSMOKE: PASS" : "\nSMOKE: FAIL");
await browser.close();
process.exit(ok && !errors.length ? 0 : 1);
