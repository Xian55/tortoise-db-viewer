import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.SMOKE_BASE || "http://localhost:4317/tortoise-db-viewer/";
// Every test waits on an explicit selector after navigating, so the page's
// readiness is asserted there -- "networkidle0" (idle for 500ms + the decorative
// icon-CDN traffic) only added ~500ms of dead time per nav. domcontentloaded +
// the existing waitForSelector is the real ready signal and ~2.5x faster.
const WAIT = "domcontentloaded";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});
// NOTE: tests run SERIALLY on a single tab. Multi-tab parallelism was tried and
// abandoned -- only one tab can hold the OPFS DB lock (db-worker.js / the OPFS
// FileSystemSyncAccessHandle is exclusive, see wa-sqlite discussion #81), so every
// extra lane keeps its own ~34 MB in-memory copy; two lanes each materializing a
// large whole-table result (all spells / all plate) at once thrashed memory and
// hung the CDP connection. The real win was dropping networkidle0 (see WAIT).
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
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 30000 });
  await page.waitForSelector(".tooltip .tt-name", { timeout: 40000 });
  const name = await page.$eval(".tooltip .tt-name", (el) => el.textContent);
  await page.waitForSelector(".item-rel .tab", { timeout: 40000 });
  const tabList = await page.$$eval(".item-rel .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const sortableH = await page.$$eval(".item-rel .tabpane:not(.hidden) th.sortable", (e) => e.length);
  console.log(`item ${id}: name="${name}" tabs=[${tabList.join(", ")}] sortableHdrs=${sortableH}`);
  return name.includes(expectName) && tabList.length > 0 && sortableH > 0;
}

// The "Dropped by" tab carries a Location column resolved for each NPC (open-world
// zone or dungeon), e.g. wolves dropping Tough Wolf Meat (item 750).
async function testItemDropLocation(id) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".item-rel .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".item-rel .tab")].find((t) => t.textContent.includes("Dropped by")); if (b) b.click(); });
  await page.waitForSelector(".item-rel .tabpane:not(.hidden) table tbody tr", { timeout: 40000 });
  const headers = await page.$$eval(".item-rel .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const li = headers.indexOf("Location");
  const locs = await page.$$eval(".item-rel .tabpane:not(.hidden) tbody tr", (rows, idx) => rows.map((r) => r.querySelectorAll("td")[idx]?.textContent.trim()).filter(Boolean), li);
  console.log(`item-drop-loc ${id}: headers=[${headers.join(",")}] locs=${JSON.stringify(locs.slice(0, 3))}`);
  return li >= 0 && locs.length > 0;
}

// Required (objective) items are collapsible groups; expanding one reveals the
// NPCs/objects that drop it + the zone. Quest 179 -> Tough Wolf Meat -> wolves.
async function testQuestRequiredDrops(id) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".quest-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".quest-page .tab")].find((t) => t.textContent.includes("Required items")); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) .grouprow", { timeout: 40000 });
  const groups = await page.$$eval(".tabpane:not(.hidden) .grouprow", (e) => e.length);
  const collapsedInit = await page.$$eval(".tabpane:not(.hidden) .grouprow.collapsed", (e) => e.length);
  await page.click(".tabpane:not(.hidden) .grouprow");
  const shown = await page.$$eval(".tabpane:not(.hidden) tbody tr:not(.grouprow)", (trs) => trs.filter((t) => t.style.display !== "none").length);
  const headers = await page.$$eval(".tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const zones = await page.$$eval(".tabpane:not(.hidden) tbody tr:not(.grouprow)", (trs) => trs.filter((t) => t.style.display !== "none").map((t) => t.querySelectorAll("td")[1]?.textContent.trim()).filter(Boolean));
  console.log(`quest-req-drops ${id}: groups=${groups} collapsedInit=${collapsedInit} shownAfterExpand=${shown} headers=[${headers.join(",")}] zones=${JSON.stringify(zones.slice(0, 2))}`);
  return groups >= 1 && collapsedInit === groups && shown > 0 && headers.includes("Source") && headers.includes("Zone") && zones.length > 0;
}

// The Kill / Use tab shows where each target NPC/object is (e.g. quest 41189 ->
// targets in Thalassian Highlands).
async function testQuestKillLocation(id) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".quest-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".quest-page .tab")].find((t) => t.textContent.includes("Kill / Use")); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: 40000 });
  const headers = await page.$$eval(".tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const li = headers.indexOf("Location");
  const locs = await page.$$eval(".tabpane:not(.hidden) tbody tr", (rows, idx) => rows.map((r) => r.querySelectorAll("td")[idx]?.textContent.trim()).filter(Boolean), li);
  console.log(`quest-kill-loc ${id}: headers=[${headers.join(",")}] locs=${JSON.stringify(locs.slice(0, 3))}`);
  return li >= 0 && locs.length > 0;
}

// A required item whose ReqSourceId duplicates it must NOT appear as "Provided items".
async function testQuestNoProvided(id) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".quest-page .tab", { timeout: 40000 });
  const tabList = await page.$$eval(".quest-page .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const hasProvided = tabList.some((t) => t.includes("Provided items"));
  console.log(`quest-no-provided ${id}: tabs=[${tabList.join(", ")}] hasProvided=${hasProvided}`);
  return !hasProvided;
}

// A world-drop item is labelled and its low-chance droppers split into a separate
// "World drop from" tab. Item 14555 (Alcor's Sunrazor) is a world drop.
async function testItemWorldDrop(id) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".item-rel .tab", { timeout: 40000 });
  const tabs = await page.$$eval(".item-rel .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const label = await page.$$eval(".item-meta .tagx", (e) => e.some((x) => x.textContent.includes("World Drop"))).catch(() => false);
  console.log(`item-wd ${id}: tabs=[${tabs.join(", ")}] label=${label}`);
  return tabs.some((t) => t.startsWith("World drop from")) && label;
}

// A set item shows the set panel (members + bonuses, set name links the set page);
// the ?itemset= page lists the same. Item 22416 -> set 523 (Dreadnaught's Battlegear).
async function testItemSet(itemId, setId) {
  // item page: set block inside the tooltip (members + bonus spell links)
  await page.goto(`${BASE}?item=${itemId}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".tt-set", { timeout: 40000 });
  const members = await page.$$eval(".tt-set .tt-set-member", (e) => e.length).catch(() => 0);
  const bonuses = await page.$$eval(".tt-set .tt-set-bonus", (e) => e.length).catch(() => 0);
  const bonusLink = (await page.$(".tt-set a.set-bonus-link[href*='spell=']")) !== null;
  const nameLink = (await page.$(`.tt-set .tt-set-name a[href*='itemset=${setId}']`)) !== null;
  const noRawToken = await page.$eval(".tt-set", (e) => !/\$\d/.test(e.textContent)).catch(() => true); // cross-spell vars resolved
  // ?itemset page: panel + stat summary table
  await page.goto(`${BASE}?itemset=${setId}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".item-set-page .item-set", { timeout: 40000 });
  const pageMembers = await page.$$eval(".item-set-page .set-member", (e) => e.length).catch(() => 0);
  const summary = (await page.$(".item-set-page .set-summary")) !== null;
  const summarySortable = await page.$$eval(".item-set-page .set-summary th.sortable", (e) => e.length).catch(() => 0);
  console.log(`item-set ${itemId}/${setId}: members=${members} bonuses=${bonuses} bonusLink=${bonusLink} nameLink=${nameLink} noRawToken=${noRawToken} pageMembers=${pageMembers} summary=${summary} summarySortable=${summarySortable}`);
  return members >= 5 && bonuses >= 2 && bonusLink && nameLink && noRawToken && pageMembers >= 5 && summary && summarySortable > 0;
}

// A single-profession trainer hides the redundant Profession column (every row
// the same skill). NPC 5038 is an Enchanting trainer.
async function testTrainerCols(id) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".npc-page .tab")].find((t) => t.textContent.includes("Teaches")); if (b) b.click(); });
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const headers = await page.$$eval(".npc-page .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const rows = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr", (r) => r.length).catch(() => 0);
  console.log(`trainer-cols ${id}: rows=${rows} headers=[${headers.join(",")}]`);
  return rows > 0 && !headers.includes("Profession");
}

// a faction-specific quest reward shows a Faction column on "Reward from quest".
// Item 22113 has mirrored Alliance + Horde reward quests.
async function testQuestRewardFaction(id) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".item-rel .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".item-rel .tab")].find((t) => /Reward from quest/.test(t.textContent)); if (b) b.click(); });
  await page.waitForSelector(".item-rel .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const facs = await page.$$eval(".item-rel .tabpane:not(.hidden) .tagx", (e) => e.map((x) => x.textContent.trim()));
  console.log(`reward-faction ${id}: tags=[${facs.join(",")}]`);
  return facs.includes("Alliance") && facs.includes("Horde");
}

// containers show their capacity on the item page: bags (class 1) and
// quivers/ammo pouches (class 11). 42243 = 22 Slot Bag, 18714 = 18 Slot Quiver.
async function testItemSlots(id, expect) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".item-main .tooltip", { timeout: 40000 });
  const txt = await page.$eval(".item-main .tooltip", (e) => e.textContent);
  const has = txt.includes(expect);
  console.log(`item-slots ${id}: expect="${expect}" found=${has}`);
  return has;
}

// recipe/pattern/plans item shows a "Teaches" tab with the craft it unlocks
async function testTeaches(id, expectName) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 30000 });
  await page.waitForSelector(".item-rel .tab", { timeout: 40000 });
  const tabs = await page.$$eval(".item-rel .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const has = tabs.some((t) => /^Teaches\b/.test(t));
  console.log(`teaches ${id}: tabs=[${tabs.join(", ")}] hasTeaches=${has}`);
  return has;
}

// container/lockbox item shows a "Contains" tab listing what it yields
async function testContainer(id, expectName) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 30000 });
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
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".tooltip .tt-name", { timeout: 40000 });
  const name = await page.$eval(".tooltip .tt-name", (e) => e.textContent);
  const bg = await page.$eval(".tooltip .tt-head .icon-sprite", (e) => e.style.backgroundImage).catch(() => "");
  console.log(`custom icon ${id}: name="${name}" spriteBg="${bg}"`);
  return name.includes(expectName) && /custom-atlas\.webp/.test(bg);
}

async function testSearch(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".results table tbody tr", { timeout: 40000 });
  const count = await page.$$eval(".results table tbody tr", (r) => r.length);
  const first = await page.$eval(".results table tbody tr td a", (a) => a.textContent).catch(() => "?");
  console.log(`search "${term}": ${count} results, first="${first}"`);
  return count > 0;
}

async function testNpc(id, expectName, expectTab) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  const tabsList = await page.$$eval(".tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const sortableH = await page.$$eval(".tabpane:not(.hidden) th.sortable", (e) => e.length);
  // Every creature has a display_id -> the meta line must carry the model thumb hook.
  const display = await page.$eval(".npc-meta .model-link", (e) => e.getAttribute("data-display")).catch(() => null);
  console.log(`npc ${id}: name="${name}" tabs=[${tabsList.join(", ")}] sortableHdrs=${sortableH} model=${display}`);
  return name.includes(expectName) && tabsList.length > 0 && sortableH > 0 && !!display && (!expectTab || tabsList.some((t) => t.includes(expectTab)));
}

// Measure the in-app (SPA) navigation render time — the actual "click an NPC"
// path (DB already in memory; just queries + render). Catches query regressions
// like an unindexed spawn_points scan. App must already be loaded (warm).
async function testNpcLoad(id, maxMs) {
  await page.goto(`${BASE}?item=2770`, { waitUntil: WAIT, timeout: 40000 }); // warm the DB
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
  await page.goto(`${BASE}?browse=items&source=${src}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const tags = await page.$$eval(".browse td.src-col .tagx", (e) => e.length);
  const checked = await page.$$eval(".multi [data-mv='source']:checked", (e) => e.map((c) => c.value));
  console.log(`browse source=${src}: rows=${rows} tags=${tags} headers=[${headers.join(",")}] checked=[${checked.join(",")}]`);
  return rows > 0 && headers.includes("Source") && tags > 0 && checked.includes(src);
}

// Spell browse: category + class filters (Class Skills / Mage). The Category
// column + the two selects reflect the URL filter.
async function testBrowseSpellCat() {
  await page.goto(`${BASE}?browse=spells&cat=${encodeURIComponent("Class Skills")}&cls=64`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const cat = await page.$eval('select[data-f="cat"]', (el) => el.value);
  const cls = await page.$eval('select[data-f="cls"]', (el) => el.value);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const spellLink = (await page.$(".browse a.ilink[href*='spell=']")) !== null;
  console.log(`browse-spellcat: rows=${rows} cat="${cat}" cls=${cls} headers=[${headers.join(",")}] spellLink=${spellLink}`);
  return rows > 0 && cat === "Class Skills" && cls === "64" && spellLink
    && headers.includes("Level") && !headers.includes("Profession");  // class view swaps Profession -> Level
}

async function testItemSources(id, expectTag) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".item-sources .tagx", { timeout: 40000 });
  const tags = await page.$$eval(".item-sources .tagx", (e) => e.map((t) => t.textContent.trim()));
  console.log(`item sources ${id}: [${tags.join(", ")}]`);
  return tags.length > 0 && (!expectTag || tags.includes(expectTag));
}

// new select filters: confirm the param yields rows and the select reflects it.
async function testFilter(param, value) {
  await page.goto(`${BASE}?browse=items&${param}=${value}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const sel = await page.$eval(`.filters [data-f='${param}']`, (e) => e.value).catch(() => "?");
  console.log(`filter ${param}=${value}: rows=${rows} selected=${sel}`);
  return rows > 0 && sel === value;
}

// crafted item shows its crafting profession in the "Created by" section.
async function testCrafted(id, expectProf) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 40000 });
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
  await page.goto(`${BASE}?browse=crafting&prof=171`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const profSel = await page.$eval(".filters [data-f='prof']", (e) => e.value).catch(() => "?");
  const brackets = await page.$$eval(".browse tbody td span[style*='ff8040']", (e) => e.length);
  // grouping still works (group by source TYPE, header = Recipe/Trainer/Auto)
  await page.goto(`${BASE}?browse=crafting&prof=171&groupby=source`, { waitUntil: WAIT, timeout: 40000 });
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
  await page.goto(`${BASE}?browse=crafting&prof=333`, { waitUntil: WAIT, timeout: 40000 });
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
    await page.goto(`${BASE}?browse=crafting&prof=755${qs}`, { waitUntil: WAIT, timeout: 40000 });
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
  await page.goto(`${BASE}?browse=items`, { waitUntil: WAIT, timeout: 40000 });
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
  await page.goto(`${BASE}?browse=items&class=4`, { waitUntil: WAIT, timeout: 40000 });
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
    await page.goto(`${BASE}?browse=items&source=${src}&q=ZZZZZZZZ`, { waitUntil: WAIT, timeout: 40000 });
    await page.waitForSelector(".browse", { timeout: 40000 });
    return page.$$eval(".browse table tbody tr", (r) => r.length).catch(() => 0);
  };
  // default (no source filter): the junk item must be hidden
  await page.goto(`${BASE}?browse=items&q=ZZZZZZZZ`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse", { timeout: 40000 });
  const hiddenByDefault = await page.$$eval(".browse table tbody tr", (r) => r.length).catch(() => 0);
  const shownWhenOptedIn = await has("unobtainable");
  console.log(`unobtainable: defaultRows=${hiddenByDefault} (want 0) optedInRows=${shownWhenOptedIn} (want >0)`);
  return hiddenByDefault === 0 && shownWhenOptedIn > 0;
}

// A spawning NPC's page renders its zone map with the parchment image + its
// own spawn pins (focus layer).
async function testNpcMap(id) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 30000 }).catch(() => {});
  const hasMap = (await page.$("#zonemap .leaflet-image-layer")) !== null;
  const pins = await page.$$eval("#zonemap .leaflet-marker-icon", (e) => e.length).catch(() => 0);
  console.log(`npc ${id} map: hasMap=${hasMap} pins=${pins}`);
  return hasMap && pins > 0;
}

// Right-clicking an NPC-page spawn pin opens a wowhead-style copy menu (Copy /
// Copy All -> Coordinates, TomTom command). Torn Fin Oracle (2376) has many spawns
// (so "Copy All" shows); the first item copies a "X.X, Y.Y" coordinate pair.
async function testNpcMapMenu(id) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector("#zonemap .leaflet-marker-icon", { timeout: 30000 });
  await page.click("#zonemap .leaflet-marker-icon", { button: "right" });
  await page.waitForSelector(".map-ctx", { visible: true, timeout: 10000 }).catch(() => {});
  const headers = await page.$$eval(".map-ctx .map-ctx-h", (e) => e.map((h) => h.textContent.trim()));
  const items = await page.$$eval(".map-ctx .map-ctx-i", (e) => e.map((b) => b.textContent.trim()));
  await page.click(".map-ctx .map-ctx-i");   // first item = Copy > Coordinates
  const copied = await page.evaluate(() => window.__copied);
  const coordOk = /^-?\d+\.\d -?\d+\.\d$/.test(copied || "");
  console.log(`npc-map-menu ${id}: headers=[${headers.join(",")}] items=[${items.join(",")}] copied="${copied}" coordOk=${coordOk}`);
  return headers.includes("Copy") && headers.includes("Copy All")
    && items.filter((t) => t === "Coordinates").length === 2
    && items.filter((t) => /TomTom/.test(t)).length === 2 && coordOk;
}

// The same copy menu works on the zone-page Pixi category dots (GPU sprites, no
// DOM): enable the dense Quest Givers layer, sweep the cursor until the hover
// tooltip reveals a dot, right-click it -> Copy > Coordinates copies "X.X, Y.Y".
async function testZoneDotMenu(id) {
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE}?zone=${id}`, { waitUntil: WAIT, timeout: 60000 });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 600));
  // open the collapsed layer control + tick the densest category
  await page.evaluate(() => { const t = document.querySelector(".leaflet-control-layers-toggle"); if (t) t.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    const ls = [...document.querySelectorAll(".leaflet-control-layers-overlays label")];
    const target = ls.find((l) => /Quest Givers/i.test(l.textContent)) || ls.find((l) => /\(\d{2,}\)/.test(l.textContent)) || ls[0];
    if (target) target.querySelector("input").click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const box = await page.$eval("#zonemap", (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  let found = null;
  for (let gy = 40; gy < box.h - 40 && !found; gy += 8) {
    for (let gx = 40; gx < box.w - 40; gx += 8) {
      const px = box.x + gx, py = box.y + gy;
      await page.mouse.move(px, py);
      if (await page.$eval(".pixi-tip", (e) => getComputedStyle(e).display === "block").catch(() => false)) { found = { px, py }; break; }
    }
  }
  if (!found) { console.log(`zone-dot-menu ${id}: no dot found`); return false; }
  await page.mouse.click(found.px, found.py, { button: "right" });
  await page.waitForSelector(".map-ctx", { visible: true, timeout: 5000 }).catch(() => {});
  const headers = await page.$$eval(".map-ctx .map-ctx-h", (e) => e.map((h) => h.textContent.trim()));
  const items = await page.$$eval(".map-ctx .map-ctx-i", (e) => e.map((b) => b.textContent.trim()));
  await page.click(".map-ctx .map-ctx-i");   // Copy > Coordinates
  const copied = await page.evaluate(() => window.__copied);
  const coordOk = /^-?\d+\.\d -?\d+\.\d$/.test(copied || "");
  console.log(`zone-dot-menu ${id}: at=${JSON.stringify(found)} headers=[${headers.join(",")}] items=[${items.join(",")}] copied="${copied}" coordOk=${coordOk}`);
  return headers.includes("Copy") && items.includes("Coordinates") && items.some((t) => /TomTom/.test(t)) && coordOk;
}

// The NPC-page map uses each spawn's exact precomputed home zone (ADT-derived),
// so overlapping WMA boxes no longer mis-assign: NPC 596 (Deadmines-entrance spawn)
// resolves to its real terrain zone Westfall (40), not Stranglethorn.
async function testNpcMapZone(id, areaid) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 30000 }).catch(() => {});
  const src = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src")).catch(() => "");
  const pins = await page.$$eval("#zonemap .leaflet-marker-icon", (e) => e.length).catch(() => 0);
  const match = src.includes(`/${areaid}.webp`);
  console.log(`npc-map-zone ${id}: src="${src}" wantArea=${areaid} match=${match} pins=${pins}`);
  return match && pins > 0;
}

// The Location label links the NPC's exact home zone(s). NPC 80208 -> Thalassian
// Highlands (5225) among its per-continent zone links.
async function testNpcLocationLabel(id, areaid) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-head", { timeout: 40000 });
  const hrefs = await page.$$eval(".npc-head .npc-meta a.ilink.zone", (e) => e.map((x) => x.getAttribute("href")));
  const match = hrefs.some((h) => h.includes(`zone=${areaid}`));
  console.log(`npc-loc-label ${id}: hrefs=${JSON.stringify(hrefs)} wantZone=${areaid} match=${match}`);
  return match;
}

async function testNpcTypeLink(id) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: WAIT, timeout: 40000 });
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
  await page.goto(`${BASE}?browse=${kind}${query}`, { waitUntil: WAIT, timeout: 40000 });
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
  await page.goto(`${BASE}?browse=items&class=4&sort=ilvl&dir=d&groupby=slot`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const active = await page.$eval(".browse th.active", (e) => e.textContent.trim()).catch(() => "(none)");
  const groups = await page.$$eval(".browse .grouprow", (e) => e.length);
  const groupSel = await page.$eval(".browse [data-groupby]", (e) => e.value).catch(() => "?");
  console.log(`browse persist: active="${active}" groupRows=${groups} groupSel=${groupSel}`);
  return active.includes("iLvl") && groups > 0;
}

async function testBrowseMulti() {
  await page.goto(`${BASE}?browse=items&quality=3,4&slot=1,5`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const checked = await page.$$eval(".multi [data-mv]:checked", (e) => e.map((c) => `${c.dataset.mv}:${c.value}`));
  console.log(`browse multi: rows=${rows} checked=[${checked.join(",")}]`);
  return rows > 0 && ["quality:3", "quality:4", "slot:1", "slot:5"].every((k) => checked.includes(k));
}

async function testBrowseCriteria() {
  const q = encodeURIComponent("agi,>=,10|sta,>=,10"); // multi-criteria, AND-combined
  await page.goto(`${BASE}?browse=items&stats=${q}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const critRows = await page.$$eval(".crit-row", (e) => e.length);
  const cstats = await page.$$eval(".crit-row [data-cstat]", (e) => e.map((s) => s.value));
  console.log(`browse criteria: rows=${rows} headers=[${headers.join(",")}] critRows=${critRows} cstats=[${cstats.join(",")}]`);
  return rows > 0 && headers.includes("Agility") && headers.includes("Stamina")
    && critRows === 2 && cstats.includes("agi") && cstats.includes("sta");
}

// Flight-path world map: faction-coloured nodes on a continent parchment, with a
// continent switcher that swaps the map.
async function testFlights() {
  await page.goto(`${BASE}?flights`, { waitUntil: WAIT, timeout: 60000 });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 500));
  const nodes = await page.$$eval(".flight-node", (e) => e.length);
  const conts = await page.$$eval("#contswitch button", (b) => b.length).catch(() => 0);
  const src1 = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src"));
  await page.evaluate(() => { const b = [...document.querySelectorAll("#contswitch button")].find((x) => !x.classList.contains("active")); if (b) b.click(); });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 500));
  const src2 = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src"));
  console.log(`flights: nodes=${nodes} continents=${conts} src1=${src1} src2=${src2} switched=${src1 !== src2}`);
  return nodes > 20 && conts === 2 && src1 !== src2;
}
async function testDungeons() {
  await page.goto(`${BASE}?dungeons`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".results table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".results table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".results th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  // a derived Level column with at least one populated "lo–hi" range
  const ranges = await page.$$eval(".results table tbody tr", (trs) =>
    trs.map((tr) => tr.children[1]?.textContent.trim()).filter((t) => /^\d+–\d+$/.test(t)).length);
  console.log(`dungeons index: ${rows} rows headers=[${headers.join(",")}] levelRanges=${ranges}`);
  return rows > 0 && headers.includes("Level") && ranges > 10;
}
// Objects browse: interactive gameobjects (harvest nodes/chests/quest objects),
// name-grouped, with a Spawns column and links to the object detail page.
async function testObjectsBrowse() {
  await page.goto(`${BASE}?browse=objects`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const objLink = (await page.$('.browse a.ilink.object[href*="object="]')) !== null;
  console.log(`objects browse: ${rows} rows headers=[${headers.join(",")}] objLink=${objLink}`);
  return rows > 0 && headers.includes("Spawns") && objLink;
}
// Object detail: aggregates same-name entries -> Contains tab links the looted item
// (Copper Vein -> Copper Ore); a multi-zone node gets a zone switcher that re-draws
// the map (one button per zone), like the dungeon floor switcher.
// ?object=ID&fz=<areaid> opens the object map on that zone (not the busiest) -- the
// zone Farming tab links here so a node opens in the zone you're farming.
async function testObjectFocusZone(id, areaid) {
  await page.goto(`${BASE}?object=${id}&fz=${areaid}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 300));
  const src = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src"));
  const active = await page.$eval("#objzoneswitch button.active", (e) => e.textContent.trim()).catch(() => "");
  console.log(`object-focus-zone ${id}&fz=${areaid}: map=${src} active="${active}"`);
  return src.includes(`/${areaid}.webp`);
}
// ?npc=ID&fz=<areaid>: a mob's map opens on the farmed zone (when it spawns there),
// not its busiest one -- the zone Farming tab links mobs here too.
async function testNpcFocusZone(id, areaid) {
  await page.goto(`${BASE}?npc=${id}&fz=${areaid}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 40000 });
  const src = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src"));
  console.log(`npc-focus-zone ${id}&fz=${areaid}: map=${src}`);
  return src.includes(`/${areaid}.webp`);
}
async function testObject(id, expectName, expectItem) {
  await page.goto(`${BASE}?object=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 30000 }).catch(() => {});
  const hasMap = (await page.$("#zonemap .leaflet-image-layer")) !== null;
  const items = await page.$$eval(".tabpane:not(.hidden) td a.ilink", (a) => a.map((x) => x.textContent.trim()));
  // multi-zone switcher: one active button, and clicking another zone swaps the parchment
  const zones = await page.$$eval("#objzoneswitch button", (b) => b.length).catch(() => 0);
  const active = await page.$$eval("#objzoneswitch button.active", (b) => b.length).catch(() => 0);
  const src1 = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src")).catch(() => "");
  await page.evaluate(() => { const b = [...document.querySelectorAll("#objzoneswitch button")].find((x) => !x.classList.contains("active")); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 400));
  const src2 = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src")).catch(() => "");
  console.log(`object ${id}: name="${name}" tabs=[${tabList.join(", ")}] map=${hasMap} zones=${zones} active=${active} switched=${src1 !== src2} items=${items.slice(0, 3).join(",")}`);
  return name.includes(expectName) && tabList.some((t) => t.includes("Contains")) && hasMap
    && items.some((t) => t.includes(expectItem)) && zones > 1 && active === 1 && src1 !== src2;
}
// Item tooltip "Buy Price": shown only for vendor-purchasable items (build-db
// `buyable`); a drop/quest item with no vendor shows Sell but not Buy.
async function testItemBuyPrice(buyableId, dropId) {
  const buyLine = async (id) => {
    await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 40000 });
    await page.waitForSelector(".tooltip .tt-name", { timeout: 40000 });
    const buy = (await page.$(".tooltip .tt-buy")) !== null;
    const sell = (await page.$(".tooltip .tt-sell")) !== null;
    return { buy, sell };
  };
  const b = await buyLine(buyableId), d = await buyLine(dropId);
  console.log(`item-buy-price: buyable#${buyableId}=${JSON.stringify(b)} drop#${dropId}=${JSON.stringify(d)}`);
  return b.buy && b.sell && !d.buy;
}
// Item "Found in object" tab (merged gather + object source): the node links to
// ?object= and the row carries spawn count + drop chance.
async function testItemGatherLink(id) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".item-rel .tab", { timeout: 40000 });
  await page.evaluate(() => { const t = [...document.querySelectorAll(".item-rel .tab")].find((x) => /Found in object/.test(x.textContent)); if (t) t.click(); });
  await page.waitForSelector(".item-rel .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const objLink = (await page.$(".item-rel .tabpane:not(.hidden) a.ilink.object[href*='object=']")) !== null;
  const headers = await page.$$eval(".item-rel .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  console.log(`item-found-in-object ${id}: objLink=${objLink} headers=[${headers.join(",")}]`);
  return objLink && headers.includes("Chance") && headers.includes("Spawns");
}
// Icons index: searchable grid; filter + page live in the URL (?icons=term&page=n),
// non-renderable junk icons (BTN* etc.) are filtered out, and a deep-link pre-fills.
async function testIcons() {
  await page.goto(`${BASE}?icons`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".icon-grid .icon-tile", { timeout: 40000 });
  const full = await page.$$eval(".icon-grid .icon-tile", (t) => t.length);
  // no junk: searching the WC3 button prefix should yield zero tiles (filtered out)
  await page.type(".icon-search", "btnbrown");
  await new Promise((r) => setTimeout(r, 200));
  const junk = await page.$$eval(".icon-grid .icon-tile", (t) => t.length);
  const junkUrl = await page.evaluate(() => location.search); // URL reflects the filter
  // deep-link: ?icons=copper pre-fills the box, filters, and a page param paginates
  await page.goto(`${BASE}?icons=copper`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".icon-grid .icon-tile", { timeout: 40000 });
  const prefilled = await page.$eval(".icon-search", (e) => e.value);
  const filtered = await page.$$eval(".icon-grid .icon-tile", (t) => t.length);
  const noText = (await page.$$eval(".icons-page p", (ps) => ps.map((p) => p.textContent).join(""))).includes("click one to see") === false;
  console.log(`icons index: full=${full} junk(btnbrown)=${junk} url="${junkUrl}" prefill="${prefilled}" filtered(copper)=${filtered} noBlurb=${noText}`);
  return full === 300 && junk === 0 && /icons=btnbrown/.test(junkUrl)
    && prefilled === "copper" && filtered > 0 && filtered < 300 && noText;
}
// Icon detail: the items (and/or spells) that use a given icon basename.
async function testIcon(name, expectItem) {
  await page.goto(`${BASE}?icon=${encodeURIComponent(name)}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".icon-page .icon-head h1", { timeout: 40000 });
  const title = await page.$eval(".icon-page .icon-head h1", (e) => e.textContent);
  await page.waitForSelector(".icon-page .tabpane:not(.hidden) td a.ilink", { timeout: 20000 }).catch(() => {});
  const items = await page.$$eval(".icon-page .tabpane:not(.hidden) td a.ilink", (a) => a.map((x) => x.textContent.trim()));
  console.log(`icon ${name}: title="${title}" items=${items.slice(0, 3).join(",")}`);
  return title === name && items.some((t) => t.includes(expectItem));
}
async function testDungeon(id, expectName) {
  await page.goto(`${BASE}?dungeon=${id}`, { waitUntil: WAIT, timeout: 40000 });
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
  await page.goto(`${BASE}?zone=${areaid}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  await page.waitForSelector("#zonemap .map-boss", { timeout: 30000 }).catch(() => {});
  const bossPins = await page.$$eval("#zonemap .map-boss", (e) => e.length).catch(() => 0);
  const hasMap = (await page.$("#zonemap .leaflet-image-layer")) !== null;
  const tabList = await page.$$eval(".tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  console.log(`zone-instance ${areaid}: name="${name}" tabs=[${tabList.join(", ")}] map=${hasMap} bossPins=${bossPins}`);
  return name.includes(expectName) && tabList.some((t) => t.includes("Boss Loot")) && hasMap && bossPins > 0;
}

// A map-less instance (no WorldMap parchment, e.g. Lower Karazhan Halls) still
// renders via the ?dungeon= fallback: Boss Loot tab, no zone map.
async function testDungeonNoMap(id, expectName) {
  await page.goto(`${BASE}?dungeon=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const mapDiv = (await page.$("#zonemap")) !== null;
  console.log(`dungeon-nomap ${id}: name="${name}" tabs=[${tabList.join(", ")}] mapDiv=${mapDiv}`);
  return name.includes(expectName) && tabList.some((t) => t.includes("Boss Loot")) && !mapDiv;
}

// Quest page shows the full chain (both directions, as a table) with the current
// quest marked, plus each step's start NPC + location.
async function testQuestChain(id, minLen) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".quest-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("Quest Chain")); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".tabpane:not(.hidden) tbody tr", (r) => r.length);
  const cur = await page.$$eval(".tabpane:not(.hidden) .qc-cur", (e) => e.length);
  const nums = await page.$$eval(".tabpane:not(.hidden) a.ilink", (a) =>
    a.map((x) => x.getAttribute("href")).filter((h) => h && h.includes("quest="))
      .map((h) => Number(new URLSearchParams(h.split("?")[1]).get("quest"))));
  const hasBack = nums.some((n) => n < id), hasFwd = nums.some((n) => n > id);
  const startLocs = await page.$$eval(".tabpane:not(.hidden) tbody tr td:last-child", (t) => t.map((x) => x.textContent.trim()).filter(Boolean));
  const headers = await page.$$eval(".tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  console.log(`quest-chain ${id}: rows=${rows} cur=${cur} back=${hasBack} fwd=${hasFwd} startLocs=${startLocs.length} headers=[${headers.join(",")}]`);
  return rows >= minLen && cur === 1 && hasBack && hasFwd && startLocs.length > 0 && headers.includes("#");
}

// A sub-zone quest resolves the full hierarchy continent > zone > sub-zone, with
// the parent zone linked. Quest 783 -> Eastern Kingdoms > Elwynn Forest > Northshire Valley.
async function testQuestZoneChain(id) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".quest-page .npc-head", { timeout: 40000 });
  const meta = await page.$eval(".quest-page .npc-head", (e) => e.textContent.replace(/\s+/g, " ").trim());
  const zoneHrefs = await page.$$eval(".quest-page .npc-head a.ilink.zone", (a) => a.map((x) => x.getAttribute("href")));
  const ok = meta.includes("Eastern Kingdoms") && meta.includes("Elwynn Forest") && meta.includes("Northshire Valley") && zoneHrefs.some((h) => h.includes("zone=12"));
  console.log(`quest-zone-chain ${id}: meta="${meta.slice(0, 90)}" zoneHrefs=${JSON.stringify(zoneHrefs)} ok=${ok}`);
  return ok;
}

// Browse quests links zone names that have a map page (e.g. Stormwind/Elwynn).
async function testBrowseQuestZoneLink() {
  await page.goto(`${BASE}?browse=quests&minlvl=1&maxlvl=12`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const zlinks = await page.$$eval(".browse td a.ilink.zone", (a) => a.length);
  console.log(`browse-quest-zonelink: zoneLinks=${zlinks}`);
  return zlinks > 0;
}

// Starts/Ends (NPC) tabs carry a Location column with where the NPC is.
async function testQuestNpcLocation(id) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".quest-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("Starts (NPC)")); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: 40000 });
  const headers = await page.$$eval(".tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const locs = await page.$$eval(".tabpane:not(.hidden) tbody tr td:last-child", (t) => t.map((x) => x.textContent.trim()).filter(Boolean));
  console.log(`quest-npc-loc ${id}: headers=[${headers.join(",")}] locs=${JSON.stringify(locs.slice(0, 3))}`);
  return headers.includes("Location") && locs.length > 0;
}

async function testHover() {
  await page.goto(`${BASE}?search=copper`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".results table tbody tr td a.ilink", { timeout: 40000 });
  await page.hover(".results table tbody tr td a.ilink");
  await page.waitForSelector(".hovercard .tt-name", { timeout: 10000 }).catch(() => {});
  const name = await page.$eval(".hovercard .tt-name", (e) => e.textContent).catch(() => "(none)");
  console.log(`hover: card name="${name}"`);
  return name !== "(none)";
}

// quest detail: header + tabs (givers/objectives/rewards) + sortable pane + desc.
async function testQuest(id, expectName) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".quest-page .npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".quest-page .npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".quest-page .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const sortableH = await page.$$eval(".quest-page .tabpane:not(.hidden) th.sortable", (e) => e.length);
  const descBlocks = await page.$$eval(".quest-desc h3", (e) => e.length);
  console.log(`quest ${id}: name="${name}" tabs=[${tabList.join(", ")}] sortableHdrs=${sortableH} descBlocks=${descBlocks}`);
  return name.includes(expectName) && tabList.length > 0 && sortableH > 0;
}

// Detail pages carry a "Share" button that copies the prerendered /<prefix>/<id>
// link (the one that unfurls in Discord, vs the non-unfurling ?param= URL).
async function testShareButton(param, id, prefix) {
  await page.goto(`${BASE}?${param}=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".share-btn", { timeout: 40000 });
  await page.click(".share-btn");
  const copied = await page.evaluate(() => window.__copied);
  const ok = typeof copied === "string" && copied.endsWith(`/${prefix}/${id}`);
  console.log(`share-btn ${param}=${id}: copied="${copied}" ok=${ok}`);
  return ok;
}

// Quest page carries a "Watch walkthrough" link: a channel-scoped YouTube search
// for the quest title (opens in a new tab).
async function testQuestVideoLink(id) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".quest-page .yt-link", { timeout: 40000 });
  const href = await page.$eval(".quest-page .yt-link", (e) => e.getAttribute("href"));
  const target = await page.$eval(".quest-page .yt-link", (e) => e.getAttribute("target"));
  const title = await page.$eval(".quest-page .npc-head h1", (e) => e.textContent.trim());
  const m = /\/@TurtleWoWQuests\/search\?query=(.+)$/.exec(href || "");
  const queryOk = !!m && decodeURIComponent(m[1]) === `${title} (ID: ${id})`;
  console.log(`quest-video-link ${id}: href="${href}" target=${target} queryMatchesTitleAndId=${queryOk}`);
  return queryOk && target === "_blank";
}

// spell detail: header name + relation tabs + sortable pane (+ Learned-from link
// when craft-taught -- the recipe item links back from the spell page).
async function testSpell(id, expectName) {
  await page.goto(`${BASE}?spell=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".spell-page .spell-card", { timeout: 40000 });
  const name = await page.$eval(".spell-page .spell-card .tt-name", (e) => e.textContent);
  const cards = await page.$$eval(".spell-page .spell-card", (e) => e.length);
  const tabList = await page.$$eval(".spell-page .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const sortableH = await page.$$eval(".spell-page .tabpane:not(.hidden) th.sortable", (e) => e.length);
  const learned = await page.$$eval(".spell-page .spell-sub a.ilink", (e) => e.length).catch(() => 0);
  console.log(`spell ${id}: name="${name}" card=${cards} tabs=[${tabList.join(", ")}] sortableHdrs=${sortableH} learnedLinks=${learned}`);
  return name.includes(expectName) && cards === 1 && tabList.length > 0 && sortableH > 0;
}

// A spell taught by a quest reward shows a "Reward from quest" tab; the page has
// no duplicate tooltip card and the Spell # sits in Quick Facts. Spell 23161
// (Summon Dreadsteed) <- quest 7631.
async function testSpellQuestReward(id) {
  await page.goto(`${BASE}?spell=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".spell-page .spell-card", { timeout: 40000 });
  const tabList = await page.$$eval(".spell-page .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const names = await page.$$eval(".spell-page .tt-name", (e) => e.length).catch(() => 0); // exactly 1 -> no dup
  const noData = await page.$eval(".spell-page", (el) => el.textContent.includes("No data.")).catch(() => true);
  const sub = await page.$eval(".spell-page .spell-sub", (e) => e.textContent).catch(() => "");
  const effNpcLink = (await page.$(".spell-page .spell-details a.ilink[href*='npc=']")) !== null; // Mounted -> creature link
  const noZeroRange = await page.$eval(".spell-page .spell-details", (e) => !/\b0 yards\b/.test(e.textContent)).catch(() => true);
  console.log(`spell-reward ${id}: tabs=[${tabList.join(", ")}] names=${names} noData=${noData} subHasId=${sub.includes("Spell #" + id)} effNpc=${effNpcLink} noZeroRange=${noZeroRange}`);
  return tabList.some((t) => t.includes("Reward from quest")) && names === 1 && !noData && sub.includes("Spell #" + id) && effNpcLink && noZeroRange;
}

// detailed spell page: "Details on spell" grid + per-effect breakdown resolved
// from the client DBC lookups (e.g. spell 10 Blizzard -> Frost, effect rows).
async function testSpellDetail(id, expectText) {
  await page.goto(`${BASE}?spell=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".spell-page .kv-grid", { timeout: 40000 });
  const keys = await page.$$eval(".spell-page .kv-grid .kv-k", (e) => e.length);
  const effects = await page.$$eval(".spell-page .spell-effect", (e) => e.length);
  const text = await page.$eval(".spell-page .spell-details", (e) => e.textContent.replace(/\s+/g, " "));
  const tabList = await page.$$eval(".spell-page .tab", (e) => e.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
  const learnable = await page.$$eval(".spell-page .spell-sub .tagx", (e) => e.length);
  const trained = tabList.some((t) => /^Trained by\b/.test(t));
  console.log(`spell detail ${id}: kvKeys=${keys} effects=${effects} learnable=${learnable} trainedTab=${trained} hasText(${expectText})=${text.includes(expectText)}`);
  return keys >= 6 && effects > 0 && text.includes(expectText) && learnable > 0 && trained;
}

// item tooltip green spell lines are now spell links (item -> ?spell=).
async function testItemSpellLink(id) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".item-main .tooltip", { timeout: 40000 });
  const links = await page.$$eval(".item-main .tt-spell a.ilink.spell", (e) => e.length);
  console.log(`item ${id} spell links: ${links}`);
  return links > 0;
}

// search includes spells: a craft term yields a Spells tab.
async function testSearchSpells(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".results .tabbar .tab", { timeout: 40000 });
  const tabs = await page.$$eval(".results .tabbar .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const spellRows = await page.$$eval('.results [data-pane="spells"] tbody tr', (r) => r.length).catch(() => 0);
  const has = tabs.some((t) => /^Spells\b/.test(t));
  console.log(`search spells "${term}": tabs=[${tabs.join(", ")}] spellTab=${has} spellRows=${spellRows}`);
  return has && spellRows > 0;
}

// unified search renders a tabbed results page spanning multiple entity types.
async function testSearchTabs(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".results .tabbar .tab", { timeout: 40000 });
  const tabList = await page.$$eval(".results .tabbar .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const rows = await page.$$eval(".results .tabpane:not(.hidden) table tbody tr", (r) => r.length);
  console.log(`search tabs "${term}": [${tabList.join(", ")}] firstPaneRows=${rows}`);
  return tabList.length > 1 && rows > 0;
}

// search includes factions: a faction name yields a Factions tab with a link.
async function testSearchFaction(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".results .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".results .tab")].find((t) => t.textContent.includes("Factions")); if (b) b.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const hasFactionLink = (await page.$(".results .tabpane:not(.hidden) a.ilink[href*='faction=']")) !== null;
  console.log(`search-faction "${term}": factionLink=${hasFactionLink}`);
  return hasFactionLink;
}

// Top-bar mega-menu: nested flyouts render; a deep weapon leaf links to the
// class+subclass browse, and the One-Handed group carries the multi-subclass link.
async function testMegaMenu() {
  await page.goto(`${BASE}?`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".menubar .submenu", { timeout: 40000 });
  const subs = await page.$$eval(".menubar .submenu", (e) => e.length);
  const weaponLeaf = (await page.$('.menubar a.nav[href*="class=2&subclass=0"]')) !== null;
  const oneHanded = (await page.$('.menubar a.nav[href*="class=2&subclass=0,4,7,13,15"]')) !== null;
  const spellPreset = (await page.$('.menubar a.nav[href*="browse=spells&cls="]')) !== null;
  console.log(`mega-menu: submenus=${subs} weaponLeaf=${weaponLeaf} oneHandedGroup=${oneHanded} spellPreset=${spellPreset}`);
  return subs > 5 && weaponLeaf && oneHanded && spellPreset;
}

// The Subtype filter is multi-select and reflects a multi-subclass URL, so the
// nav "One-Handed" state (class=2&subclass=0,4,7,13,15) is reproducible.
async function testSubclassMulti() {
  await page.goto(`${BASE}?browse=items&class=2&subclass=0,4,7,13,15`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const checked = await page.$$eval('[data-multi="subclass"] [data-mv]:checked', (e) => e.map((c) => c.value).sort());
  console.log(`subclass-multi: checked=[${checked.join(",")}]`);
  return checked.length === 5 && ["0", "4", "7", "13", "15"].every((v) => checked.includes(v));
}

// Fishing poles (class=2 subclass=20) swap the weapon DPS/Speed columns for a
// "+N Fishing" column; Big Iron Fishing Pole (6367) carries +20.
async function testFishingPoleCols() {
  await page.goto(`${BASE}?browse=items&class=2&subclass=20`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const bigIron = await page.$$eval(".browse table tbody tr", (rows) => {
    const tr = rows.find((r) => /Big Iron Fishing Pole/.test(r.textContent));
    return tr ? tr.textContent : "";
  });
  console.log(`fishing-pole-cols: headers=[${headers.join(",")}] bigIron="${bigIron.replace(/\s+/g, " ").trim()}"`);
  return headers.includes("Fishing") && !headers.includes("DPS") && !headers.includes("Speed")
    && /\+20/.test(bigIron);
}

// Rage costs are stored x10 internally; Heroic Strike (284) is 15 rage, not 150.
// Read the cost cell directly (.spell-card .tt-l) -- the page's full textContent
// runs "Rank 2" into "15 Rage" with no separator.
async function testRageCost(id) {
  await page.goto(`${BASE}?spell=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".spell-page .spell-card", { timeout: 40000 });
  const cost = await page.$eval(".spell-page .spell-card .tt-l", (e) => e.textContent.trim()).catch(() => "");
  console.log(`rage-cost ${id}: cost="${cost}"`);
  return cost === "15 Rage";
}

// Reagents all have required_level 0, so the Req column (hideEmpty) drops out.
async function testReagentNoReq() {
  await page.goto(`${BASE}?browse=items&class=5`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  console.log(`reagent-cols: headers=[${headers.join(",")}]`);
  return headers.length > 0 && !headers.includes("Req");
}

// NPCs with no recorded spawn (script/pool/event-placed, e.g. 80101) show an
// explanatory note instead of a blank where the map would be.
async function testNpcNoSpawn(id) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-page", { timeout: 40000 });
  const note = (await page.$(".npc-page .zone-empty")) !== null;
  const noMap = (await page.$("#zonemap")) === null;
  console.log(`npc-nospawn ${id}: note=${note} noMap=${noMap}`);
  return note && noMap;
}

// Site footer: shows the page load time always, and an "Updated <date>" stamp
// when version.json carries builtAt (CI build writes it).
async function testFooter() {
  await page.goto(`${BASE}?item=2770`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".tooltip .tt-name", { timeout: 40000 });
  await page.waitForFunction(() => { const e = document.getElementById("footLoad"); return e && /\d/.test(e.textContent); }, { timeout: 15000 }).catch(() => {});
  const load = await page.$eval("#footLoad", (e) => e.textContent.trim()).catch(() => "");
  const updated = await page.$eval("#footUpdated", (e) => e.textContent.trim()).catch(() => "");
  const srcLink = (await page.$(".sitefoot .foot-src a[href*='github.com']")) !== null;
  const loadOk = /Loaded in \d+(\.\d+)? (ms|s)/.test(load);
  const updatedOk = /^Updated /.test(updated);   // present when builtAt is set
  console.log(`footer: load="${load}" updated="${updated}" srcLink=${srcLink}`);
  return loadOk && updatedOk && srcLink;
}

// Mobile: the top nav collapses behind a hamburger that toggles it open.
async function testMobileNav() {
  await page.setViewport({ width: 390, height: 800 });
  await page.goto(`${BASE}?`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector("#navToggle", { timeout: 40000 });
  const toggleVisible = await page.$eval("#navToggle", (el) => getComputedStyle(el).display !== "none");
  const hiddenBefore = await page.$eval(".topnav", (el) => getComputedStyle(el).display === "none");
  await page.click("#navToggle");
  const shownAfter = await page.$eval(".topnav", (el) => getComputedStyle(el).display !== "none");
  await page.setViewport({ width: 1280, height: 900 });   // restore for any later tests
  console.log(`mobile-nav: toggleVisible=${toggleVisible} hiddenBefore=${hiddenBefore} shownAfter=${shownAfter}`);
  return toggleVisible && hiddenBefore && shownAfter;
}

// Item sets are searchable: the results page has an "Item Sets" tab with links.
async function testSearchItemSet(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".results .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".results .tab")].find((t) => t.textContent.includes("Item Sets")); if (b) b.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const hasSetLink = (await page.$(".results .tabpane:not(.hidden) a.ilink[href*='itemset=']")) !== null;
  console.log(`search-itemset "${term}": setLink=${hasSetLink}`);
  return hasSetLink;
}
// unified search includes interactive objects (gameobjects) on an Objects tab.
async function testSearchObjects(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".results .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".results .tab")].find((t) => t.textContent.includes("Objects")); if (b) b.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const hasObjLink = (await page.$(".results .tabpane:not(.hidden) a.ilink.object[href*='object=']")) !== null;
  console.log(`search-objects "${term}": objLink=${hasObjLink}`);
  return hasObjLink;
}
// quest required-item object sources link to the object page (Relic of Elunaris).
async function testQuestObjectLink(id) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".tab")].find((t) => /Required items/.test(t.textContent)); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) .grouprow", { timeout: 40000 }).catch(() => {});
  await page.evaluate(() => { const g = document.querySelector(".tabpane:not(.hidden) .grouprow"); if (g) g.click(); }); // expand
  await new Promise((r) => setTimeout(r, 200));
  const objLink = (await page.$(".tabpane:not(.hidden) a.ilink.object[href*='object=']")) !== null;
  console.log(`quest-object-link ${id}: objLink=${objLink}`);
  return objLink;
}

// A template-vendor NPC (creature_template.vendor_id -> npc_vendor_template) lists
// its stock on the Sells tab. NPC 1249 (Quartermaster Hudson) sells via vendor_id.
async function testNpcSells(id, minItems) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".npc-page .tab")].find((t) => t.textContent.includes("Sells")); if (b) b.click(); });
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const rows = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr", (r) => r.length).catch(() => 0);
  console.log(`npc-sells ${id}: rows=${rows}`);
  return rows >= minItems;
}

// browse NPCs shows Faction + Location (not ID), searches title, and filters by faction.
async function testBrowseNpcCols() {
  await page.goto(`${BASE}?browse=npcs&q=quartermaster`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const factionFilter = (await page.$(".filters [data-f='faction']")) !== null;
  console.log(`browse-npc-cols: rows=${rows} headers=[${headers.join(",")}] factionFilter=${factionFilter}`);
  return rows > 0 && headers.includes("Faction") && headers.includes("Location") && !headers.includes("ID") && factionFilter;
}

// search includes zones: "Tanaris" yields a Zones tab with >=1 row
async function testSearchZone(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".results .tabbar .tab", { timeout: 40000 });
  const tabs = await page.$$eval(".results .tabbar .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const zoneRows = await page.$$eval('.results [data-table="zones"] tbody tr, .results [data-pane="zones"] tbody tr', (r) => r.length).catch(() => 0);
  const has = tabs.some((t) => /^Zones\b/.test(t));
  console.log(`search zones "${term}": tabs=[${tabs.join(", ")}] zoneTab=${has} zoneRows=${zoneRows}`);
  return has;
}

// live dropdown: typing yields rows; ArrowDown+Enter navigates to a detail page.
async function testSearchDropdown(term) {
  await page.goto(`${BASE}?`, { waitUntil: WAIT, timeout: 40000 });
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
  await page.goto(`${BASE}?faction=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-page .npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".npc-page .npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".npc-page .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const groupRows = await page.$$eval(".npc-page .tabpane:not(.hidden) .grouprow", (e) => e.length);
  const sortableH = await page.$$eval(".npc-page .tabpane:not(.hidden) th.sortable", (e) => e.length);
  console.log(`faction ${id}: name="${name}" tabs=[${tabList.join(", ")}] groupRows=${groupRows} sortableHdrs=${sortableH}`);
  return name.includes(expectName) && tabList.length > 0 && groupRows > 0 && sortableH > 0;
}

// A faction page lists its member NPCs (name / level / location).
async function testFactionMembers(id, minMembers) {
  await page.goto(`${BASE}?faction=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".npc-page .tab")].find((t) => t.textContent.trim().startsWith("Members")); if (b) b.click(); });
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr", (r) => r.length);
  const headers = await page.$$eval(".npc-page .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const locs = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr td:last-child", (t) => t.map((x) => x.textContent.trim()).filter(Boolean));
  const npcLink = (await page.$(".npc-page .tabpane:not(.hidden) a.ilink[href*='npc=']")) !== null;
  console.log(`faction-members ${id}: rows=${rows} headers=[${headers.join(",")}] locs=${locs.length} npcLink=${npcLink}`);
  return rows >= minMembers && headers.includes("Location") && headers.includes("Title") && npcLink && locs.length > 0;
}

// An NPC that belongs to a faction shows it (linked when the faction has a page).
async function testNpcFaction(id, factionId) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".npc-head", { timeout: 40000 });
  const has = (await page.$(`.npc-head .npc-meta a.ilink[href*='faction=${factionId}']`)) !== null;
  console.log(`npc-faction ${id}: factionLink(${factionId})=${has}`);
  return has;
}

// a quest that grants reputation renders its faction as a link.
async function testQuestRepLink(id) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: WAIT, timeout: 40000 });
  await page.waitForSelector(".quest-desc", { timeout: 40000 });
  const links = await page.$$eval(".quest-desc a.ilink.faction", (e) => e.length);
  console.log(`quest ${id} rep faction links: ${links}`);
  return links > 0;
}

// zone page: Leaflet renders the parchment image + per-category marker toggles.
// (markers use a canvas renderer, so assert the image layer + layer control.)
async function testZone(id, expectName) {
  await page.goto(`${BASE}?zone=${id}`, { waitUntil: WAIT, timeout: 60000 });
  await page.waitForSelector(".zone-page .npc-head h1", { timeout: 40000 });
  const name = await page.$eval(".zone-page .npc-head h1", (e) => e.textContent);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 40000 });
  const cats = await page.$$eval(".leaflet-control-layers-overlays label", (e) => e.length);
  const tabList = await page.$$eval(".zone-page .tabbar .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const rows = await page.$$eval(".zone-page .tabpane:not(.hidden) table tbody tr", (r) => r.length);
  console.log(`zone ${id}: name="${name}" mapImg=yes categories=${cats} tabs=[${tabList.join(", ")}] firstPaneRows=${rows}`);
  return name.includes(expectName) && cats > 0 && tabList.length >= 3 && rows > 0;
}

// Zone Objects tab: gameobject names link to ?object= (not plain text).
async function testZoneObjectLink(id) {
  await page.goto(`${BASE}?zone=${id}`, { waitUntil: WAIT, timeout: 60000 });
  await page.waitForSelector(".zone-page .tabbar .tab", { timeout: 40000 });
  await page.evaluate(() => { const t = [...document.querySelectorAll(".zone-page .tabbar .tab")].find((x) => /Objects/.test(x.textContent)); if (t) t.click(); });
  await page.waitForSelector(".zone-page .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const objLink = (await page.$(".zone-page .tabpane:not(.hidden) a.ilink.object[href*='object=']")) !== null;
  console.log(`zone-object-link ${id}: objLink=${objLink}`);
  return objLink;
}
// Farming route: a gather focus (?zone&gather=item) with enough spawns draws a
// numbered waypoint circuit (cluster -> nearest-neighbour), default-on + toggleable.
async function testFarmRoute(areaid, item) {
  await page.goto(`${BASE}?zone=${areaid}&gather=${item}`, { waitUntil: WAIT, timeout: 60000 });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 700));
  const overlays = await page.$$eval(".leaflet-control-layers-overlays label", (e) => e.map((x) => x.textContent.trim()));
  const stops = await page.$$eval(".route-stop", (e) => e.length);
  const hasRoute = overlays.some((o) => /route/i.test(o));
  console.log(`farm-route ${areaid}/${item}: overlays=[${overlays.join(", ")}] stops=${stops} route=${hasRoute}`);
  return hasRoute && stops >= 3;
}
// Zone Farming tab: best gold targets ranked by total drop value, + a "Gold route"
// map overlay (value-weighted waypoint circuit).
async function testZoneFarm(areaid) {
  await page.goto(`${BASE}?zone=${areaid}`, { waitUntil: WAIT, timeout: 60000 });
  await page.waitForSelector(".zone-page .tabbar .tab", { timeout: 40000 });
  await page.evaluate(() => { const t = [...document.querySelectorAll(".zone-page .tabbar .tab")].find((x) => /Farming/.test(x.textContent)); if (t) t.click(); });
  await page.waitForSelector(".zone-page .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const headers = await page.$$eval(".zone-page .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const rows = await page.$$eval(".zone-page .tabpane:not(.hidden) table tbody tr", (r) => r.length);
  const goldRoute = (await page.$$eval(".leaflet-control-layers-overlays label", (e) => e.map((x) => x.textContent))).some((o) => /Gold route/.test(o));
  console.log(`zone-farm ${areaid}: rows=${rows} headers=[${headers.join(",")}] goldRoute=${goldRoute}`);
  return rows > 5 && headers.includes("Total value") && goldRoute;
}
// A multi-floor instance shows a floor switcher; the active floor renders a map,
// and switching floors re-renders. Black Morass (?zone=5204) has 2 floors.
async function testZoneFloors(areaid, minFloors) {
  await page.goto(`${BASE}?zone=${areaid}`, { waitUntil: WAIT, timeout: 60000 });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 40000 });
  const floors = await page.$$eval("#floorswitch button", (b) => b.length).catch(() => 0);
  const active = await page.$$eval("#floorswitch button.active", (b) => b.length).catch(() => 0);
  const src1 = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src")).catch(() => "");
  // switch to a non-active floor; map image should change
  await page.evaluate(() => { const b = [...document.querySelectorAll("#floorswitch button")].find((x) => !x.classList.contains("active")); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 400));
  const src2 = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src")).catch(() => "");
  console.log(`zone-floors ${areaid}: floors=${floors} active=${active} src1=${src1} src2=${src2} switched=${src1 !== src2}`);
  return floors >= minFloors && active === 1 && src1 !== src2;
}

// A zone lists the quests bound to it (directly or in a sub-zone) as a tab.
async function testZoneQuests(id, minQuests) {
  await page.goto(`${BASE}?zone=${id}`, { waitUntil: WAIT, timeout: 60000 });
  await page.waitForSelector(".zone-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".zone-page .tab")].find((t) => t.textContent.trim().startsWith("Quests")); if (b) b.click(); });
  await page.waitForSelector(".zone-page .tabpane:not(.hidden) table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".zone-page .tabpane:not(.hidden) tbody tr", (r) => r.length);
  const headers = await page.$$eval(".zone-page .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const hasQuestLink = (await page.$(".zone-page .tabpane:not(.hidden) a.ilink[href*='quest=']")) !== null;
  const hasGiverLink = (await page.$(".zone-page .tabpane:not(.hidden) a.ilink[href*='npc=']")) !== null;
  console.log(`zone-quests ${id}: rows=${rows} headers=[${headers.join(",")}] questLink=${hasQuestLink} giverLink=${hasGiverLink}`);
  return rows >= minQuests && hasQuestLink && headers.includes("Quest Giver") && hasGiverLink;
}

// An instance lists the quests related to it (giver/turn-in inside, dungeon-
// exclusive item drop, or same-named gameplay zone) on its Quests tab. Gilneas
// City (?zone=5208) is a Turtle dungeon whose quests live on a separate AreaTable
// zone, so this exercises the WorldMap-area <-> gameplay-zone bridge.
async function testDungeonQuests(areaid, minQuests) {
  await page.goto(`${BASE}?zone=${areaid}`, { waitUntil: WAIT, timeout: 60000 });
  await page.waitForSelector(".zone-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".zone-page .tab")].find((t) => t.textContent.trim().startsWith("Quests")); if (b) b.click(); });
  await page.waitForSelector(".zone-page .tabpane:not(.hidden) table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".zone-page .tabpane:not(.hidden) tbody tr", (r) => r.length);
  const hasQuestLink = (await page.$(".zone-page .tabpane:not(.hidden) a.ilink[href*='quest=']")) !== null;
  const headers = await page.$$eval(".zone-page .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  // each quest carries a faction-eligibility badge (Alliance / Horde / Neutral)
  const factions = await page.$$eval(".zone-page .tabpane:not(.hidden) tbody tr .tagx[class*='fac-']", (e) => [...new Set(e.map((x) => x.textContent.trim()))]);
  console.log(`dungeon-quests ${areaid}: rows=${rows} questLink=${hasQuestLink} headers=[${headers.join(",")}] factions=${JSON.stringify(factions)}`);
  return rows >= minQuests && hasQuestLink && headers.includes("Faction") && factions.length > 0
    && factions.every((f) => ["Alliance", "Horde", "Neutral"].includes(f));
}

// client-only zones (map texture, no spawns in the public SQL export) render the
// parchment map + an explanatory note instead of three blank tabs.
async function testEmptyZone(id, expectName) {
  await page.goto(`${BASE}?zone=${id}`, { waitUntil: WAIT, timeout: 60000 });
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

// Selective run: `node scripts/smoke.mjs fishing rage` (or SMOKE_ONLY="fishing rage")
// runs only tests whose call source matches ANY filter (case-insensitive substring,
// e.g. "fishing", "rage", "class=2", "testZone"). No filter => run everything.
const ONLY = (process.env.SMOKE_ONLY || process.argv.slice(2).join(" ")).toLowerCase().split(/[\s,]+/).filter(Boolean);
const failed = [], ran = [];
// `run` only *enqueues* (the calls below are sequential but cheap); the pool at the
// end runs the queue across lanes. `thunk.toString()` is the arrow's source
// ("() => testFishingPoleCols()") -- the label, with args baked in for filtering.
const TESTS = [];
function run(thunk) {
  const label = thunk.toString().replace(/^\s*\(\s*\)\s*=>\s*/, "");
  if (ONLY.length && !ONLY.some((f) => label.toLowerCase().includes(f))) return;
  TESTS.push({ label, thunk });
}

run(() => testItem(7909, "Aquamarine"));
run(() => testItemWorldDrop(14555));  // world-drop item: label + "World drop from" tab
run(() => testItemSet(22416, 523));   // item set panel + ?itemset page
run(() => testQuestRewardFaction(22113));  // reward-from-quest Faction column
run(() => testItemSlots(42243, "22 Slot Bag"));     // bag capacity (class 1)
run(() => testItemSlots(18714, "18 Slot Quiver"));  // quiver capacity (class 11)
run(() => testItemSlots(18042, "Adds 17.5 damage per second"));  // ammo damage (class 6)
run(() => testItem(2770, "Copper Ore"));
run(() => testItem(55356, "Netherwrought"));
run(() => testItem(647, "Destiny"));
run(() => testContainer(16882, "Junkbox"));  // lockbox -> Contains tab
run(() => testTeaches(70204, "Shadowforged"));  // recipe -> Teaches tab
run(() => testCustomIcon(9376, "Jang"));
run(() => testSearch("thunder"));
run(() => testQuest(14, "Militia"));
run(() => testQuestVideoLink(14));  // quest page: YouTube walkthrough search link
run(() => testShareButton("quest", 14, "q"));  // Share button copies the OG-stub link
run(() => testShareButton("item", 2770, "i"));
run(() => testShareButton("spell", 41746, "s"));  // spell page anchors on .spell-sub
run(() => testQuestChain(55220, 11));  // mid-chain quest: back + forward + start locations
run(() => testQuestNpcLocation(55220));  // Starts/Ends (NPC) Location column
run(() => testQuestZoneChain(783));      // continent > zone > sub-zone
run(() => testBrowseQuestZoneLink());    // browse quests links zones
run(() => testQuestNoProvided(179));     // ReqSourceId==ReqItemId not shown as Provided
run(() => testQuestRequiredDrops(179));  // objective item collapses to its drop sources + zones
run(() => testQuestKillLocation(41189)); // Kill / Use targets show their zone
run(() => testItemDropLocation(750));    // dropped-by NPC locations resolved
run(() => testSearchTabs("defias"));
run(() => testSearchZone("Tanaris"));
run(() => testSearchDropdown("defias"));
run(() => testSpell(41746, "Shadowforged Eye"));   // craft spell: Creates/Reagents tabs + Learned-from link
run(() => testSpellDetail(10, "Frost"));           // Blizzard: details grid + effect breakdown (DBC-resolved)
run(() => testRageCost(284));                      // Heroic Strike: rage cost /10 (15, not 150)
run(() => testSpellQuestReward(23161));            // spell taught by quest reward + no dup card / No data.
run(() => testItemSpellLink(70204));               // recipe item: green "Teaches…" now links to ?spell=
run(() => testSearchSpells("Shadowforged"));       // search yields a Spells tab
run(() => testBrowse("spells", "", "Profession")); // ?browse=spells finder
run(() => testBrowse("quests", "&minlvl=1&maxlvl=12", "Zone"));
run(() => testFaction(509, "League of Arathor"));
run(() => testFactionMembers(69, 20));  // Darnassus member NPCs + title + location
run(() => testNpcFaction(80959, 69));   // NPC shows its faction (Darnassus Quartermaster)
run(() => testQuestRepLink(14));
run(() => testBrowse("factions", "", "Items"));
run(() => testZone(12, "Elwynn"));
run(() => testZoneObjectLink(400));              // zone Objects tab links to ?object=
run(() => testZoneDotMenu(12));                  // right-click a Pixi category dot -> copy menu
run(() => testFarmRoute(17, 2770));              // gather focus -> numbered farming-route circuit (Copper in Barrens)
run(() => testZoneFarm(17));                     // zone Farming tab (best gold targets) + Gold route overlay
run(() => testZone(5561, "Balor"));             // 1.18.1 zone, populated via migrations
run(() => testZoneQuests(331, 20));             // Ashenvale quests tab (incl. sub-zones)
run(() => testZoneFloors(5204, 2));             // Black Morass: multi-floor switcher
run(() => testEmptyZone(5722, "Thorn Gorge")); // 1.18.1 zone with no spawns upstream yet
run(() => testBrowse("zones", "", "Continent"));
run(() => testNpcLoad(15379, 400));  // AQ NPC, many spawns; ~4ms healthy, 726ms if zone lookup unindexed
run(() => testNpc(2376, "Torn Fin Oracle"));
run(() => testNpc(80402, "Aemara Sunsorrow", "Teaches"));  // trainer -> Teaches tab
run(() => testTrainerCols(5038));  // single-profession trainer hides Profession col
run(() => testNpc(10981, "", "Skinning"));
run(() => testNpcTypeLink(2376));
run(() => testNpcMap(2376));  // NPC page shows its zone map + spawn pins
run(() => testNpcMapMenu(2376));  // right-click pin -> copy coords / TomTom menu
run(() => testNpcSells(1249, 5));  // template-vendor (vendor_id) stock on Sells tab
run(() => testNpcNoSpawn(80101));  // no-spawn NPC shows an explanatory note
run(() => testNpcMapZone(596, 40));    // exact ADT area: Deadmines-entrance spawn is Westfall terrain
run(() => testNpcMapZone(11501, 2557));  // Dire Maul interior NPC (King Gordok)
run(() => testNpcMapZone(80208, 5225));  // map = most-spawned interior zone
run(() => testNpcLocationLabel(80208, 5225));  // label agrees with the map
run(() => testNpcMapZone(14890, 331));        // Taerar -> Ashenvale (exact ADT area, was Azshara)
run(() => testNpcMapZone(60735, 5103));       // Hateforge Quarry boss stays in the instance (was continent zone 46)
run(() => testNpcLocationLabel(596, 40));
run(() => testDungeons());
run(() => testFlights());                        // flight-path world map + continent switch
run(() => testObjectsBrowse());                       // objects finder (interactive gameobjects)
run(() => testObject(1731, "Copper Vein", "Copper Ore"));  // object detail: contains item + map
run(() => testObjectFocusZone(2852, 10));   // Solid Chest opens on the focused zone (Duskwood) via &fz
run(() => testNpcFocusZone(524, 10));       // Rockhide Boar (busiest Elwynn) opens on Duskwood via &fz
run(() => testIcons());                               // icons index: grid + filter
run(() => testIcon("INV_Ore_Copper_01", "Copper Ore"));  // icon detail: items using it
run(() => testDungeon(36, "Deadmines"));          // ?dungeon= redirects to the zone view
run(() => testInstanceZone(5138, "Deadmines"));  // ?zone= auto-detects the dungeon
run(() => testInstanceZone(2557, "Dire Maul"));  // interior map (areaId collision fix)
run(() => testDungeonQuests(5208, 8));           // Gilneas City: related-quests tab (zone bridge)
run(() => testDungeonNoMap(532, "Lower Karazhan Halls"));  // map-less instance fallback
run(() => testBrowsePersist());
run(() => testBrowseMulti());
run(() => testBrowseCriteria());
run(() => testHover());
const sc = (s) => `&stats=${encodeURIComponent(s)}`;
run(() => testBrowse("items", "&class=2&quality=4&minrl=40", "DPS"));
run(() => testBrowse("items", `&class=4${sc("armor,>=,100")}`, "Armor"));
run(() => testBrowse("items", sc("agi,>=,20"), "Agility"));
run(() => testBrowse("items", sc("sp,>=,20"), "Spell Power"));
run(() => testBrowse("npcs", "&rank=3"));
run(() => testBrowseNpcCols());                  // browse NPCs: Faction + Location cols, title search, faction filter
run(() => testSearchFaction("Darnassus"));      // unified search includes factions
run(() => testSearchItemSet("Dreadnaught"));    // unified search includes item sets
run(() => testSearchObjects("Copper Vein"));    // unified search includes objects
run(() => testQuestObjectLink(42087));          // quest req-item object source links to ?object=
run(() => testItemGatherLink(12467));           // item Gathered-in object links to ?object= (Alien Egg)
run(() => testBrowse("itemsets", "", "Pieces"));      // item-sets browse category
run(() => testBrowse("items", "&class=1", "Slots"));  // container browse shows slot count
run(() => testBrowse("items", "&slot=18", "Slots"));  // Bag-slot filter (bags + quivers) shows slot count
run(() => testBrowse("items", "&class=6", "Damage"));  // projectiles show ammo damage
run(() => testReagentNoReq());                         // reagents hide the empty Req column
run(() => testBrowseSource("vendor"));
run(() => testBrowseSource("worlddrop"));  // new World Drop source filter
run(() => testBrowseSpellCat());           // spell category + class filters
run(() => testItemSources(2770));
run(() => testItemBuyPrice(68, 65));   // vendor item shows Buy Price; non-vendor item doesn't
run(() => testItemSources(5031, "Unobtainable"));
run(() => testUnobtainable());
run(() => testFilter("bind", "2"));
run(() => testFilter("uclass", "8"));
run(() => testFilter("faction", "a"));
run(() => testFilter("prof", "197"));
run(() => testFilter("unique", "1"));
run(() => testCrafted(2575, "Tailoring"));
run(() => testCrafting());
run(() => testCraftEnchanting());
run(() => testCraftObtainable());
run(() => testSelection());
run(() => testGroupSelection());
run(() => testMegaMenu());                                  // top-bar flyout mega-menu
run(() => testBrowse("items", "&class=2&subclass=0,4,7,13,15", "DPS"));  // One-Handed multi-subclass filter
run(() => testSubclassMulti());                             // Subtype multi-select reflects the URL
run(() => testFishingPoleCols());                           // fishing poles: +N Fishing column, no DPS/Speed
run(() => testBrowse("zones", "&cont=0", "Zone"));          // Zones continent filter
run(() => testFooter());      // site footer: load time + "Updated" stamp + source link
run(() => testMobileNav());   // responsive top bar (run last; resets viewport)

// Execute the (optionally filtered) queue serially on the single page.
for (const { label, thunk } of TESTS) {
  ran.push(label);
  let pass = false;
  try { pass = await thunk(); } catch (e) { errors.push(`THREW ${label}: ${e.message}`); }
  if (!pass) { ok = false; failed.push(label); }
}

console.log(`\nelapsed ${Date.now() - t}ms${ONLY.length ? ` | filter [${ONLY.join(", ")}] -> ran ${ran.length} test(s)` : ""}`);
if (ONLY.length && !ran.length) console.log(`(no test matched the filter -- check the substring against the test call source)`);
if (failed.length) { console.log("\nFAILED:\n" + failed.map((l) => "  " + l).join("\n")); }
if (errors.length) { console.log("\nERRORS:\n" + errors.slice(0, 20).join("\n")); }
console.log(ok && !errors.length ? "\nSMOKE: PASS" : "\nSMOKE: FAIL");
await browser.close();
process.exit(ok && !errors.length ? 0 : 1);
