import { page, nav, T, smoke } from "../harness.mjs";
import { waitStable } from "./_shared.mjs";

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

// search includes sub-areas: "Goldshire" yields a Subzones tab whose rows name the
// parent zone (subzone names repeat, so the bare name would be ambiguous).
async function testSearchSubzone(term) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results .tabbar .tab", { timeout: T });
  const tabs = await page.$$eval(".results .tabbar .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const has = tabs.some((t) => /^Subzones\b/.test(t));
  await page.evaluate(() => { const t = [...document.querySelectorAll(".results .tabbar .tab")].find((x) => /^Subzones\b/.test(x.textContent.trim())); if (t) t.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const rows = await page.$$eval(".results .tabpane:not(.hidden) table tbody tr", (r) => r.length).catch(() => 0);
  const link = (await page.$(".results .tabpane:not(.hidden) a.ilink[href*='subzone=']")) !== null;
  const parent = (await page.$(".results .tabpane:not(.hidden) a.ilink.zone[href*='zone=']")) !== null;
  console.log(`search subzones "${term}": tabs=[${tabs.join(", ")}] rows=${rows} link=${link} parentZone=${parent}`);
  return has && rows > 0 && link && parent;
}

// Search results carry the same selection ops as ?browse=items: ticking rows enables
// the bar, and Compare hands the selection to ?compare=. (Clipboard ops are skipped --
// headless Chrome gates navigator.clipboard behind a permission prompt.)
async function testSearchSelbar(term, pane, { prefix: wantPrefix, compare }) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results .tabbar .tab", { timeout: T });
  await page.evaluate((p) => { const t = [...document.querySelectorAll(".results .tabbar .tab")].find((x) => new RegExp(`^${p}`, "i").test(x.textContent.trim())); if (t) t.click(); }, pane === "items" ? "Items" : "Spells");
  const sel = `.results [data-pane="${pane}"]`;
  await page.waitForSelector(`${sel} [data-selbar]`, { timeout: T });
  const before = await page.$eval(`${sel} [data-selcount]`, (e) => e.textContent);
  const disabledBefore = await page.$eval(`${sel} [data-op="ids"]`, (e) => e.disabled);
  await page.$$eval(`${sel} input[data-selrow]`, (b) => b.slice(0, 2).forEach((x) => x.click()));
  const after = await page.$eval(`${sel} [data-selcount]`, (e) => e.textContent);
  const disabledAfter = await page.$eval(`${sel} [data-op="ids"]`, (e) => e.disabled);
  const prefix = await page.$eval(`${sel} [data-prefix]`, (e) => e.value);
  const hasCompare = (await page.$(`${sel} [data-op="compare"]`)) !== null;
  // The checkbox column must not eat the row: it's width:1% precisely because a px
  // width is only a hint in auto table layout (a narrow search table gave it ~60%).
  const selColPct = await page.evaluate((s) => {
    const th = document.querySelector(`${s} table th.selcol`);
    const tbl = document.querySelector(`${s} table`);
    return th && tbl ? Math.round((th.getBoundingClientRect().width / tbl.getBoundingClientRect().width) * 100) : null;
  }, sel);
  let url = "";
  if (compare) {
    await page.click(`${sel} [data-op="compare"]`);
    await page.waitForFunction(() => /[?&]compare=/.test(location.search), { timeout: T }).catch(() => {});
    url = await page.evaluate(() => location.search);
  }
  console.log(`search selbar ${pane} "${term}": "${before}"(disabled=${disabledBefore}) -> "${after}"(disabled=${disabledAfter}) prefix="${prefix}" compareBtn=${hasCompare} selCol=${selColPct}% ${compare ? `compare="${url}"` : ""}`);
  return disabledBefore && before === "0 selected" && after === "2 selected" && !disabledAfter
    && prefix === wantPrefix && hasCompare === compare && selColPct !== null && selColPct <= 10
    && (!compare || /compare=\d+:\d+/.test(url));
}

// Spell results show the client's rank subtext ("Rank 4"), like Wowhead.
async function testSearchSpellRank(term) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results .tabbar .tab", { timeout: T });
  await page.evaluate(() => { const t = [...document.querySelectorAll(".results .tabbar .tab")].find((x) => /^Spells\b/.test(x.textContent.trim())); if (t) t.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const heads = await page.$$eval(".results .tabpane:not(.hidden) table thead th", (e) => e.map((h) => h.textContent.replace(/[^\w ]/g, "").trim()));
  // Index by header, not a fixed offset: the Spells table grew a leading .selcol
  // checkbox column when bulk-selection was added, which shifted every cell by one.
  const col = heads.findIndex((h) => /^Rank$/.test(h));
  const ranks = col < 0 ? [] : await page.$$eval(".results .tabpane:not(.hidden) table tbody tr",
    (rows, i) => rows.map((r) => r.children[i]?.textContent.trim()).filter(Boolean), col);
  const hasCol = col >= 0;
  const anyRank = ranks.some((v) => /^Rank \d+$/.test(v));
  console.log(`search spell-rank "${term}": heads=[${heads.join(", ")}] rankCol=${hasCol} sample=[${ranks.slice(0, 4).join(" | ")}]`);
  return hasCol && anyRank;
}

// "Learn" stubs (effect 36) duplicate the spell they teach: "Blessing of Might"
// listed 15 rows -- 7 real ranks plus 8 stubs. A stub is indexed only when its target
// isn't, so the real rank must be present and its stub absent.
async function testSearchNoLearnStubs(term, wantReal, wantStubGone) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results .tabbar .tab", { timeout: T });
  await page.evaluate(() => { const t = [...document.querySelectorAll(".results .tabbar .tab")].find((x) => /^Spells\b/.test(x.textContent.trim())); if (t) t.click(); });
  await page.waitForSelector(".results .tabpane:not(.hidden) table tbody tr", { timeout: T });
  const ids = await page.$$eval('.results .tabpane:not(.hidden) a[href*="spell="]',
    (as) => as.map((a) => +(a.getAttribute("href").match(/spell=(\d+)/) || [])[1]).filter(Boolean));
  const hasReal = ids.includes(wantReal);
  const hasStub = ids.includes(wantStubGone);
  console.log(`search learn-stubs "${term}": ${ids.length} spells, real ${wantReal}=${hasReal} stub ${wantStubGone}=${hasStub}`);
  return hasReal && !hasStub;
}

// live dropdown: typing yields rows; ArrowDown+Enter navigates to a detail page.
async function testSearchDropdown(term) {
  await nav(`?`);
  await page.waitForSelector("#search", { timeout: T });
  await page.click("#search");
  await page.type("#search", term, { delay: 30 });
  await page.waitForSelector(".search-dropdown .sd-row", { timeout: 10000 });
  // The rows appearing is not the same as the dropdown being DONE: a later response
  // still re-renders the panel, which clears the keyboard selection and makes the
  // Enter below a no-op. Wait for the row set to stop changing first.
  await waitStable(() => page.$$eval(".search-dropdown .sd-row", (e) => e.map((r) => r.textContent)).catch(() => null));
  const rows = await page.$$eval(".search-dropdown .sd-row", (e) => e.length);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const NAV = /[?&](item|npc|quest|spell|object|faction|dungeon|zone|subzone|search)=/;
  await page.waitForFunction(() => /[?&](item|npc|quest|spell|object|faction|dungeon|zone|subzone|search)=/.test(location.search), { timeout: 10000 }).catch(() => {});
  const url = await page.evaluate(() => location.search);
  console.log(`dropdown "${term}": rows=${rows} navigatedTo="${url}"`);
  return rows > 1 && NAV.test(url);
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
smoke("search subzone Goldshire", () => testSearchSubzone("Goldshire"));
smoke("search selbar items copper", () => testSearchSelbar("copper", "items", { prefix: ".additem ", compare: true }));
smoke("search selbar spells blessing of might", () => testSearchSelbar("blessing of might", "spells", { prefix: ".learn ", compare: false }));
smoke("search spell-rank fireball", () => testSearchSpellRank("fireball"));
smoke("search no learn-stubs blessing of might", () => testSearchNoLearnStubs("blessing of might", 19838, 19843));
smoke("search dropdown defias", () => testSearchDropdown("defias"));
smoke("search faction Darnassus", () => testSearchFaction("Darnassus"));
smoke("search itemset Dreadnaught", () => testSearchItemSet("Dreadnaught"));
smoke("search objects Copper Vein", () => testSearchObjects("Copper Vein"));
smoke("hover card", () => testHover());
