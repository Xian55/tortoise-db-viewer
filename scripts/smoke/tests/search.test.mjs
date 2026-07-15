import { page, nav, T, smoke } from "../harness.mjs";

async function testSearch(term) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results table tbody tr", { timeout: T });
  const count = await page.$$eval(".results table tbody tr", (r) => r.length);
  const first = await page.$eval(".results table tbody tr td a", (a) => a.textContent).catch(() => "?");
  console.log(`search "${term}": ${count} results, first="${first}"`);
  return count > 0;
}

// Trigram infix search: a mid-name substring (not a prefix of any token) still
// finds results -- e.g. "owfang" matches "Shadowfang ...". Proves the trigram
// index, since the prefix FTS could never match a non-leading fragment.
async function testSearchInfix(term, expectSub) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results", { timeout: T });
  await page.waitForSelector(".results a.ilink", { timeout: 20000 }).catch(() => {});
  const names = await page.$$eval(".results a.ilink", (a) => a.map((x) => x.textContent.toLowerCase()));
  const hit = names.some((n) => n.includes(expectSub));
  console.log(`search-infix "${term}": hit(${expectSub})=${hit} names=${JSON.stringify(names.slice(0, 4))}`);
  return hit;
}

// unified search renders a tabbed results page spanning multiple entity types.
async function testSearchTabs(term) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results .tabbar .tab", { timeout: T });
  const tabList = await page.$$eval(".results .tabbar .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const rows = await page.$$eval(".results .tabpane:not(.hidden) table tbody tr", (r) => r.length);
  console.log(`search tabs "${term}": [${tabList.join(", ")}] firstPaneRows=${rows}`);
  return tabList.length > 1 && rows > 0;
}

// search includes zones: "Tanaris" yields a Zones tab with >=1 row
async function testSearchZone(term) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results .tabbar .tab", { timeout: T });
  const tabs = await page.$$eval(".results .tabbar .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const zoneRows = await page.$$eval('.results [data-table="zones"] tbody tr, .results [data-pane="zones"] tbody tr', (r) => r.length).catch(() => 0);
  const has = tabs.some((t) => /^Zones\b/.test(t));
  console.log(`search zones "${term}": tabs=[${tabs.join(", ")}] zoneTab=${has} zoneRows=${zoneRows}`);
  return has;
}

// live dropdown: typing yields rows; ArrowDown+Enter navigates to a detail page.
async function testSearchDropdown(term) {
  await nav(`?`);
  await page.waitForSelector("#search", { timeout: T });
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

// search includes factions: a faction name yields a Factions tab with a link.
async function testSearchFaction(term) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".results .tab")].find((t) => t.textContent.includes("Factions")); if (b) b.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const hasFactionLink = (await page.$(".results .tabpane:not(.hidden) a.ilink[href*='faction=']")) !== null;
  console.log(`search-faction "${term}": factionLink=${hasFactionLink}`);
  return hasFactionLink;
}

// Item sets are searchable: the results page has an "Item Sets" tab with links.
async function testSearchItemSet(term) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".results .tab")].find((t) => t.textContent.includes("Item Sets")); if (b) b.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const hasSetLink = (await page.$(".results .tabpane:not(.hidden) a.ilink[href*='itemset=']")) !== null;
  console.log(`search-itemset "${term}": setLink=${hasSetLink}`);
  return hasSetLink;
}
// unified search includes interactive objects (gameobjects) on an Objects tab.
async function testSearchObjects(term) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".results .tab")].find((t) => t.textContent.includes("Objects")); if (b) b.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const hasObjLink = (await page.$(".results .tabpane:not(.hidden) a.ilink.object[href*='object=']")) !== null;
  console.log(`search-objects "${term}": objLink=${hasObjLink}`);
  return hasObjLink;
}

async function testHover() {
  await nav(`?search=copper`);
  await page.waitForSelector(".results table tbody tr td a.ilink", { timeout: T });
  await page.hover(".results table tbody tr td a.ilink");
  await page.waitForSelector(".hovercard .tt-name", { timeout: 10000 }).catch(() => {});
  const name = await page.$eval(".hovercard .tt-name", (e) => e.textContent).catch(() => "(none)");
  console.log(`hover: card name="${name}"`);
  return name !== "(none)";
}

smoke("search thunder", () => testSearch("thunder"));
smoke("search-infix owfang", () => testSearchInfix("owfang", "owfang"));
smoke("search tabs defias", () => testSearchTabs("defias"));
smoke("search zone Tanaris", () => testSearchZone("Tanaris"));
smoke("search dropdown defias", () => testSearchDropdown("defias"));
smoke("search faction Darnassus", () => testSearchFaction("Darnassus"));
smoke("search itemset Dreadnaught", () => testSearchItemSet("Dreadnaught"));
smoke("search objects Copper Vein", () => testSearchObjects("Copper Vein"));
smoke("hover card", () => testHover());
