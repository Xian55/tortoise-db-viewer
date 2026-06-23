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

// The "Dropped by" tab carries a Location column resolved for each NPC (open-world
// zone or dungeon), e.g. wolves dropping Tough Wolf Meat (item 750).
async function testItemDropLocation(id) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
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
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
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
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
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
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".quest-page .tab", { timeout: 40000 });
  const tabList = await page.$$eval(".quest-page .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const hasProvided = tabList.some((t) => t.includes("Provided items"));
  console.log(`quest-no-provided ${id}: tabs=[${tabList.join(", ")}] hasProvided=${hasProvided}`);
  return !hasProvided;
}

// A world-drop item is labelled and its low-chance droppers split into a separate
// "World drop from" tab. Item 14555 (Alcor's Sunrazor) is a world drop.
async function testItemWorldDrop(id) {
  await page.goto(`${BASE}?item=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
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
  await page.goto(`${BASE}?item=${itemId}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".tt-set", { timeout: 40000 });
  const members = await page.$$eval(".tt-set .tt-set-member", (e) => e.length).catch(() => 0);
  const bonuses = await page.$$eval(".tt-set .tt-set-bonus", (e) => e.length).catch(() => 0);
  const bonusLink = (await page.$(".tt-set a.set-bonus-link[href*='spell=']")) !== null;
  const nameLink = (await page.$(`.tt-set .tt-set-name a[href*='itemset=${setId}']`)) !== null;
  const noRawToken = await page.$eval(".tt-set", (e) => !/\$\d/.test(e.textContent)).catch(() => true); // cross-spell vars resolved
  // ?itemset page: panel + stat summary table
  await page.goto(`${BASE}?itemset=${setId}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".item-set-page .item-set", { timeout: 40000 });
  const pageMembers = await page.$$eval(".item-set-page .set-member", (e) => e.length).catch(() => 0);
  const summary = (await page.$(".item-set-page .set-summary")) !== null;
  console.log(`item-set ${itemId}/${setId}: members=${members} bonuses=${bonuses} bonusLink=${bonusLink} nameLink=${nameLink} noRawToken=${noRawToken} pageMembers=${pageMembers} summary=${summary}`);
  return members >= 5 && bonuses >= 2 && bonusLink && nameLink && noRawToken && pageMembers >= 5 && summary;
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
  // Every creature has a display_id -> the meta line must carry the model thumb hook.
  const display = await page.$eval(".npc-meta .model-link", (e) => e.getAttribute("data-display")).catch(() => null);
  console.log(`npc ${id}: name="${name}" tabs=[${tabsList.join(", ")}] sortableHdrs=${sortableH} model=${display}`);
  return name.includes(expectName) && tabsList.length > 0 && sortableH > 0 && !!display && (!expectTab || tabsList.some((t) => t.includes(expectTab)));
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

// Spell browse: category + class filters (Class Skills / Mage). The Category
// column + the two selects reflect the URL filter.
async function testBrowseSpellCat() {
  await page.goto(`${BASE}?browse=spells&cat=${encodeURIComponent("Class Skills")}&cls=64`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const cat = await page.$eval('select[data-f="cat"]', (el) => el.value);
  const cls = await page.$eval('select[data-f="cls"]', (el) => el.value);
  const spellLink = (await page.$(".browse a.ilink[href*='spell=']")) !== null;
  console.log(`browse-spellcat: rows=${rows} cat="${cat}" cls=${cls} spellLink=${spellLink}`);
  return rows > 0 && cat === "Class Skills" && cls === "64" && spellLink;
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

// The NPC-page map uses each spawn's exact precomputed home zone (ADT-derived),
// so overlapping WMA boxes no longer mis-assign: NPC 596 (Deadmines-entrance spawn)
// resolves to its real terrain zone Westfall (40), not Stranglethorn.
async function testNpcMapZone(id, areaid) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
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
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-head", { timeout: 40000 });
  const hrefs = await page.$$eval(".npc-head .npc-meta a.ilink.zone", (e) => e.map((x) => x.getAttribute("href")));
  const match = hrefs.some((h) => h.includes(`zone=${areaid}`));
  console.log(`npc-loc-label ${id}: hrefs=${JSON.stringify(hrefs)} wantZone=${areaid} match=${match}`);
  return match;
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

// A map-less instance (no WorldMap parchment, e.g. Lower Karazhan Halls) still
// renders via the ?dungeon= fallback: Boss Loot tab, no zone map.
async function testDungeonNoMap(id, expectName) {
  await page.goto(`${BASE}?dungeon=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
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
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
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
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".quest-page .npc-head", { timeout: 40000 });
  const meta = await page.$eval(".quest-page .npc-head", (e) => e.textContent.replace(/\s+/g, " ").trim());
  const zoneHrefs = await page.$$eval(".quest-page .npc-head a.ilink.zone", (a) => a.map((x) => x.getAttribute("href")));
  const ok = meta.includes("Eastern Kingdoms") && meta.includes("Elwynn Forest") && meta.includes("Northshire Valley") && zoneHrefs.some((h) => h.includes("zone=12"));
  console.log(`quest-zone-chain ${id}: meta="${meta.slice(0, 90)}" zoneHrefs=${JSON.stringify(zoneHrefs)} ok=${ok}`);
  return ok;
}

// Browse quests links zone names that have a map page (e.g. Stormwind/Elwynn).
async function testBrowseQuestZoneLink() {
  await page.goto(`${BASE}?browse=quests&minlvl=1&maxlvl=12`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const zlinks = await page.$$eval(".browse td a.ilink.zone", (a) => a.length);
  console.log(`browse-quest-zonelink: zoneLinks=${zlinks}`);
  return zlinks > 0;
}

// Starts/Ends (NPC) tabs carry a Location column with where the NPC is.
async function testQuestNpcLocation(id) {
  await page.goto(`${BASE}?quest=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".quest-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("Starts (NPC)")); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: 40000 });
  const headers = await page.$$eval(".tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const locs = await page.$$eval(".tabpane:not(.hidden) tbody tr td:last-child", (t) => t.map((x) => x.textContent.trim()).filter(Boolean));
  console.log(`quest-npc-loc ${id}: headers=[${headers.join(",")}] locs=${JSON.stringify(locs.slice(0, 3))}`);
  return headers.includes("Location") && locs.length > 0;
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
  await page.goto(`${BASE}?spell=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
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
  await page.goto(`${BASE}?spell=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
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

// search includes factions: a faction name yields a Factions tab with a link.
async function testSearchFaction(term) {
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".results .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".results .tab")].find((t) => t.textContent.includes("Factions")); if (b) b.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const hasFactionLink = (await page.$(".results .tabpane:not(.hidden) a.ilink[href*='faction=']")) !== null;
  console.log(`search-faction "${term}": factionLink=${hasFactionLink}`);
  return hasFactionLink;
}

// Mobile: the top nav collapses behind a hamburger that toggles it open.
async function testMobileNav() {
  await page.setViewport({ width: 390, height: 800 });
  await page.goto(`${BASE}?`, { waitUntil: "networkidle0", timeout: 40000 });
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
  await page.goto(`${BASE}?search=${encodeURIComponent(term)}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".results .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".results .tab")].find((t) => t.textContent.includes("Item Sets")); if (b) b.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const hasSetLink = (await page.$(".results .tabpane:not(.hidden) a.ilink[href*='itemset=']")) !== null;
  console.log(`search-itemset "${term}": setLink=${hasSetLink}`);
  return hasSetLink;
}

// A template-vendor NPC (creature_template.vendor_id -> npc_vendor_template) lists
// its stock on the Sells tab. NPC 1249 (Quartermaster Hudson) sells via vendor_id.
async function testNpcSells(id, minItems) {
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-page .tab", { timeout: 40000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".npc-page .tab")].find((t) => t.textContent.includes("Sells")); if (b) b.click(); });
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) table tbody tr", { timeout: 40000 }).catch(() => {});
  const rows = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr", (r) => r.length).catch(() => 0);
  console.log(`npc-sells ${id}: rows=${rows}`);
  return rows >= minItems;
}

// browse NPCs shows Faction + Location (not ID), searches title, and filters by faction.
async function testBrowseNpcCols() {
  await page.goto(`${BASE}?browse=npcs&q=quartermaster`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".browse table tbody tr", { timeout: 40000 });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const factionFilter = (await page.$(".filters [data-f='faction']")) !== null;
  console.log(`browse-npc-cols: rows=${rows} headers=[${headers.join(",")}] factionFilter=${factionFilter}`);
  return rows > 0 && headers.includes("Faction") && headers.includes("Location") && !headers.includes("ID") && factionFilter;
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

// A faction page lists its member NPCs (name / level / location).
async function testFactionMembers(id, minMembers) {
  await page.goto(`${BASE}?faction=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
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
  await page.goto(`${BASE}?npc=${id}`, { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector(".npc-head", { timeout: 40000 });
  const has = (await page.$(`.npc-head .npc-meta a.ilink[href*='faction=${factionId}']`)) !== null;
  console.log(`npc-faction ${id}: factionLink(${factionId})=${has}`);
  return has;
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
  return name.includes(expectName) && cats > 0 && tabList.length >= 3 && rows > 0;
}

// A multi-floor instance shows a floor switcher; the active floor renders a map,
// and switching floors re-renders. Black Morass (?zone=5204) has 2 floors.
async function testZoneFloors(areaid, minFloors) {
  await page.goto(`${BASE}?zone=${areaid}`, { waitUntil: "networkidle0", timeout: 60000 });
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
  await page.goto(`${BASE}?zone=${id}`, { waitUntil: "networkidle0", timeout: 60000 });
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
ok = (await testItemWorldDrop(14555)) && ok;  // world-drop item: label + "World drop from" tab
ok = (await testItemSet(22416, 523)) && ok;   // item set panel + ?itemset page
ok = (await testItem(2770, "Copper Ore")) && ok;
ok = (await testItem(55356, "Netherwrought")) && ok;
ok = (await testItem(647, "Destiny")) && ok;
ok = (await testContainer(16882, "Junkbox")) && ok;  // lockbox -> Contains tab
ok = (await testTeaches(70204, "Shadowforged")) && ok;  // recipe -> Teaches tab
ok = (await testCustomIcon(9376, "Jang")) && ok;
ok = (await testSearch("thunder")) && ok;
ok = (await testQuest(14, "Militia")) && ok;
ok = (await testQuestChain(55220, 11)) && ok;  // mid-chain quest: back + forward + start locations
ok = (await testQuestNpcLocation(55220)) && ok;  // Starts/Ends (NPC) Location column
ok = (await testQuestZoneChain(783)) && ok;      // continent > zone > sub-zone
ok = (await testBrowseQuestZoneLink()) && ok;    // browse quests links zones
ok = (await testQuestNoProvided(179)) && ok;     // ReqSourceId==ReqItemId not shown as Provided
ok = (await testQuestRequiredDrops(179)) && ok;  // objective item collapses to its drop sources + zones
ok = (await testQuestKillLocation(41189)) && ok; // Kill / Use targets show their zone
ok = (await testItemDropLocation(750)) && ok;    // dropped-by NPC locations resolved
ok = (await testSearchTabs("defias")) && ok;
ok = (await testSearchZone("Tanaris")) && ok;
ok = (await testSearchDropdown("defias")) && ok;
ok = (await testSpell(41746, "Shadowforged Eye")) && ok;   // craft spell: Creates/Reagents tabs + Learned-from link
ok = (await testSpellDetail(10, "Frost")) && ok;           // Blizzard: details grid + effect breakdown (DBC-resolved)
ok = (await testSpellQuestReward(23161)) && ok;            // spell taught by quest reward + no dup card / No data.
ok = (await testItemSpellLink(70204)) && ok;               // recipe item: green "Teaches…" now links to ?spell=
ok = (await testSearchSpells("Shadowforged")) && ok;       // search yields a Spells tab
ok = (await testBrowse("spells", "", "Profession")) && ok; // ?browse=spells finder
ok = (await testBrowse("quests", "&minlvl=1&maxlvl=12", "Zone")) && ok;
ok = (await testFaction(509, "League of Arathor")) && ok;
ok = (await testFactionMembers(69, 20)) && ok;  // Darnassus member NPCs + title + location
ok = (await testNpcFaction(80959, 69)) && ok;   // NPC shows its faction (Darnassus Quartermaster)
ok = (await testQuestRepLink(14)) && ok;
ok = (await testBrowse("factions", "", "Items")) && ok;
ok = (await testZone(12, "Elwynn")) && ok;
ok = (await testZone(5561, "Balor")) && ok;             // 1.18.1 zone, populated via migrations
ok = (await testZoneQuests(331, 20)) && ok;             // Ashenvale quests tab (incl. sub-zones)
ok = (await testZoneFloors(5204, 2)) && ok;             // Black Morass: multi-floor switcher
ok = (await testEmptyZone(5722, "Thorn Gorge")) && ok; // 1.18.1 zone with no spawns upstream yet
ok = (await testBrowse("zones", "", "Continent")) && ok;
ok = (await testNpcLoad(15379, 400)) && ok;  // AQ NPC, many spawns; ~4ms healthy, 726ms if zone lookup unindexed
ok = (await testNpc(2376, "Torn Fin Oracle")) && ok;
ok = (await testNpc(80402, "Aemara Sunsorrow", "Teaches")) && ok;  // trainer -> Teaches tab
ok = (await testNpc(10981, "", "Skinning")) && ok;
ok = (await testNpcTypeLink(2376)) && ok;
ok = (await testNpcMap(2376)) && ok;  // NPC page shows its zone map + spawn pins
ok = (await testNpcSells(1249, 5)) && ok;  // template-vendor (vendor_id) stock on Sells tab
ok = (await testNpcMapZone(596, 40)) && ok;    // exact ADT area: Deadmines-entrance spawn is Westfall terrain
ok = (await testNpcMapZone(11501, 2557)) && ok;  // Dire Maul interior NPC (King Gordok)
ok = (await testNpcMapZone(80208, 5225)) && ok;  // map = most-spawned interior zone
ok = (await testNpcLocationLabel(80208, 5225)) && ok;  // label agrees with the map
ok = (await testNpcMapZone(14890, 331)) && ok;        // Taerar -> Ashenvale (exact ADT area, was Azshara)
ok = (await testNpcLocationLabel(596, 40)) && ok;
ok = (await testDungeons()) && ok;
ok = (await testDungeon(36, "Deadmines")) && ok;          // ?dungeon= redirects to the zone view
ok = (await testInstanceZone(5138, "Deadmines")) && ok;  // ?zone= auto-detects the dungeon
ok = (await testInstanceZone(2557, "Dire Maul")) && ok;  // interior map (areaId collision fix)
ok = (await testDungeonNoMap(532, "Lower Karazhan Halls")) && ok;  // map-less instance fallback
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
ok = (await testBrowseNpcCols()) && ok;                  // browse NPCs: Faction + Location cols, title search, faction filter
ok = (await testSearchFaction("Darnassus")) && ok;      // unified search includes factions
ok = (await testSearchItemSet("Dreadnaught")) && ok;    // unified search includes item sets
ok = (await testBrowseSource("vendor")) && ok;
ok = (await testBrowseSource("worlddrop")) && ok;  // new World Drop source filter
ok = (await testBrowseSpellCat()) && ok;           // spell category + class filters
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
ok = (await testMobileNav()) && ok;   // responsive top bar (run last; resets viewport)
console.log(`\nelapsed ${Date.now() - t}ms`);
if (errors.length) { console.log("\nERRORS:\n" + errors.slice(0, 20).join("\n")); }
console.log(ok && !errors.length ? "\nSMOKE: PASS" : "\nSMOKE: FAIL");
await browser.close();
process.exit(ok && !errors.length ? 0 : 1);
