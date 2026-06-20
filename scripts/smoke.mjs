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
const BENIGN = /favicon\.ico|icons\.json/;
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
  console.log(`crafted ${id}: profession "${expectProf}" present=${hit}`);
  return hit;
}

// crafting browse: filtered to one profession, grouped, with skill-up brackets
// (orange #ff8040 span) and a Source column (recipe link / Trainer badge).
async function testCrafting() {
  await page.goto(`${BASE}?browse=crafting&prof=171`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const groupRows = await page.$$eval(".browse .grouprow", (e) => e.length);
  const profSel = await page.$eval(".filters [data-f='prof']", (e) => e.value).catch(() => "?");
  const brackets = await page.$$eval(".browse tbody td span[style*='ff8040']", (e) => e.length);
  console.log(`crafting prof=171: rows=${rows} headers=[${headers.join(",")}] groupRows=${groupRows} profSel=${profSel} brackets=${brackets}`);
  return rows > 0 && headers.includes("Skill") && headers.includes("Source") && profSel === "171" && groupRows > 0 && brackets > 0;
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
  console.log(`dungeon ${id}: name="${name}" tabs=[${tabList.join(", ")}] groupRows=${groupRows} groupCtl=${hasGroupCtl} collapse=${collapseOk}`);
  return name.includes(expectName) && tabList.some((t) => t.includes("Boss Loot")) && groupRows > 0 && hasGroupCtl && collapseOk;
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

// unified search renders a tabbed results page spanning multiple entity types.
async function testSearchTabs(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".results .tabbar .tab", { timeout: 40000 });
  const tabList = await page.$$eval(".results .tabbar .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const rows = await page.$$eval(".results .tabpane:not(.hidden) table tbody tr", (r) => r.length);
  console.log(`search tabs "${term}": [${tabList.join(", ")}] firstPaneRows=${rows}`);
  return tabList.length > 1 && rows > 0;
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

let ok = true;
const t = Date.now();
ok = (await testItem(7909, "Aquamarine")) && ok;
ok = (await testItem(2770, "Copper Ore")) && ok;
ok = (await testItem(55356, "Netherwrought")) && ok;
ok = (await testItem(647, "Destiny")) && ok;
ok = (await testCustomIcon(9376, "Jang")) && ok;
ok = (await testSearch("thunder")) && ok;
ok = (await testQuest(14, "Militia")) && ok;
ok = (await testSearchTabs("defias")) && ok;
ok = (await testSearchDropdown("defias")) && ok;
ok = (await testBrowse("quests", "&minlvl=1&maxlvl=12", "Zone")) && ok;
ok = (await testFaction(509, "League of Arathor")) && ok;
ok = (await testQuestRepLink(14)) && ok;
ok = (await testBrowse("factions", "", "Items")) && ok;
ok = (await testNpc(2376, "Torn Fin Oracle")) && ok;
ok = (await testNpc(10981, "", "Skinning")) && ok;
ok = (await testNpcTypeLink(2376)) && ok;
ok = (await testDungeons()) && ok;
ok = (await testDungeon(36, "Deadmines")) && ok;
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
ok = (await testSelection()) && ok;
ok = (await testGroupSelection()) && ok;
console.log(`\nelapsed ${Date.now() - t}ms`);
if (errors.length) { console.log("\nERRORS:\n" + errors.slice(0, 20).join("\n")); }
console.log(ok && !errors.length ? "\nSMOKE: PASS" : "\nSMOKE: FAIL");
await browser.close();
process.exit(ok && !errors.length ? 0 : 1);
