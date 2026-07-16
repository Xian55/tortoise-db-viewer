// Item detail page: tooltip, tabs, sets, mounts, suffixes, slots, readables,
// custom icons, world-drop split, same-model, compare, sources, buy price,
// gather/spell links, crafting/reagent relations, share button.
import { page, nav, T, smoke } from "../harness.mjs";
import { testShareButton } from "./_shared.mjs";

async function testItem(id, expectName) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".tooltip .tt-name", { timeout: T });
  const name = await page.$eval(".tooltip .tt-name", (el) => el.textContent);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  const tabList = await page.$$eval(".item-rel .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const sortableH = await page.$$eval(".item-rel .tabpane:not(.hidden) th.sortable", (e) => e.length);
  console.log(`item ${id}: name="${name}" tabs=[${tabList.join(", ")}] sortableHdrs=${sortableH}`);
  return name.includes(expectName) && tabList.length > 0 && sortableH > 0;
}

// A world-drop item is labelled and its low-chance droppers split into a separate
// "World drop from" tab. Item 14555 (Alcor's Sunrazor) is a world drop.
async function testItemWorldDrop(id) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  const tabs = await page.$$eval(".item-rel .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const label = await page.$$eval(".item-meta .tagx", (e) => e.some((x) => x.textContent.includes("World Drop"))).catch(() => false);
  console.log(`item-wd ${id}: tabs=[${tabs.join(", ")}] label=${label}`);
  return tabs.some((t) => t.startsWith("World drop from")) && label;
}

// A set item shows the set panel (members + bonuses, set name links the set page);
// the ?itemset= page lists the same. Item 22416 -> set 523 (Dreadnaught's Battlegear).
async function testItemSet(itemId, setId) {
  // item page: set block inside the tooltip (members + bonus spell links)
  await nav(`?item=${itemId}`);
  await page.waitForSelector(".tt-set", { timeout: T });
  const members = await page.$$eval(".tt-set .tt-set-member", (e) => e.length).catch(() => 0);
  const bonuses = await page.$$eval(".tt-set .tt-set-bonus", (e) => e.length).catch(() => 0);
  const bonusLink = (await page.$(".tt-set a.set-bonus-link[href*='spell=']")) !== null;
  const nameLink = (await page.$(`.tt-set .tt-set-name a[href*='itemset=${setId}']`)) !== null;
  const noRawToken = await page.$eval(".tt-set", (e) => !/\$\d/.test(e.textContent)).catch(() => true); // cross-spell vars resolved
  // ?itemset page: panel + stat summary table
  await nav(`?itemset=${setId}`);
  await page.waitForSelector(".item-set-page .item-set", { timeout: T });
  const pageMembers = await page.$$eval(".item-set-page .set-member", (e) => e.length).catch(() => 0);
  const summary = (await page.$(".item-set-page .set-summary")) !== null;
  const summarySortable = await page.$$eval(".item-set-page .set-summary th.sortable", (e) => e.length).catch(() => 0);
  console.log(`item-set ${itemId}/${setId}: members=${members} bonuses=${bonuses} bonusLink=${bonusLink} nameLink=${nameLink} noRawToken=${noRawToken} pageMembers=${pageMembers} summary=${summary} summarySortable=${summarySortable}`);
  return members >= 5 && bonuses >= 2 && bonusLink && nameLink && noRawToken && pageMembers >= 5 && summary && summarySortable > 0;
}

// Set membership is corrected to the client ItemSet.dbc (issue #319): the server
// dump mis-groups Paladin Judgement pieces (70517-70524) into set 640
// "Dreadslayer's Rampage" whose DBC members are only 55108/55113. The ?itemset=640
// page must list the wanted member and NOT the contaminant.
async function testSetMembership(setId, wantItem, contaminantItem) {
  await nav(`?itemset=${setId}`);
  await page.waitForSelector(".item-set-page .item-set", { timeout: T });
  const hrefs = await page.$$eval(".item-set-page .set-member a", (e) => e.map((a) => a.getAttribute("href") || "")).catch(() => []);
  const hasWant = hrefs.some((h) => h.includes(`item=${wantItem}`));
  const hasContaminant = hrefs.some((h) => h.includes(`item=${contaminantItem}`));
  console.log(`set-membership ${setId}: members=${hrefs.length} hasWant=${hasWant} hasContaminant=${hasContaminant}`);
  return hasWant && !hasContaminant;
}

// a faction-specific quest reward shows a Faction column on "Reward from quest".
// Item 22113 has mirrored Alliance + Horde reward quests.
async function testQuestRewardFaction(id) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".item-rel .tab")].find((t) => /Reward from quest/.test(t.textContent)); if (b) b.click(); });
  await page.waitForSelector(".item-rel .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const facs = await page.$$eval(".item-rel .tabpane:not(.hidden) .tagx", (e) => e.map((x) => x.textContent.trim()));
  console.log(`reward-faction ${id}: tags=[${facs.join(",")}]`);
  return facs.includes("Alliance") && facs.includes("Horde");
}

// containers show their capacity on the item page: bags (class 1) and
// quivers/ammo pouches (class 11). 42243 = 22 Slot Bag, 18714 = 18 Slot Quiver.
async function testItemSlots(id, expect) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-main .tooltip", { timeout: T });
  const txt = await page.$eval(".item-main .tooltip", (e) => e.textContent);
  const has = txt.includes(expect);
  console.log(`item-slots ${id}: expect="${expect}" found=${has}`);
  return has;
}

async function testSameModel(id, minRows) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll(".item-rel .tab")].find((t) => t.textContent.includes("Same model")); if (b) { b.click(); return true; } return false; });
  if (!clicked) { console.log(`same-model ${id}: no tab`); return false; }
  await page.waitForSelector(".item-rel .tabpane:not(.hidden) table tbody tr", { timeout: T });
  const rows = await page.$$eval(".item-rel .tabpane:not(.hidden) tbody tr", (e) => e.length);
  const headers = await page.$$eval(".item-rel .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  console.log(`same-model ${id}: rows=${rows} headers=[${headers.join(",")}]`);
  return rows >= minRows && headers.includes("Slot");
}

// "Same model" tab lists other items sharing this one's display_id (appearance).
// Item 33292 (Elberetha's Scepter) shares display 68751 with 2 other wands.
// Mount item: the tooltip surfaces the summoned creature ("Summons <npc>"), the
// creature's NPC page reverse-links the item ("Mount summoned by"), and browse
// categorises it as "Mount" (not blank Miscellaneous) + the mount=1 filter works.
// 18768 Armored Dawnsaber -> Swift Dawnsaber (creature 14557).
async function testMount(itemId, creatureId, expectCreature) {
  await nav(`?item=${itemId}`);
  await page.waitForSelector(".item-main .tt-mount", { timeout: T });
  const summons = await page.$eval(".item-main .tt-mount", (e) => e.textContent.trim());
  const npcHref = await page.$eval(".item-main .tt-mount a", (a) => a.getAttribute("href")).catch(() => "");
  // reverse: the summoned creature's page names the item
  await nav(`?npc=${creatureId}`);
  await page.waitForSelector(".npc-head", { timeout: T });
  const rev = await page.$$eval(".npc-meta", (es) => es.map((e) => e.textContent).join(" | "));
  const revLink = await page.$(`.npc-meta a[href*="item=${itemId}"]`) !== null;
  // browse: mount=1 filter -> rows, all typed "Mount", + the summoned-model column
  // renders model-link spans (data-display) that drive the 3D hover preview.
  await nav(`?browse=items&mount=1&cols=type,model`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const ti = headers.indexOf("Type");
  const types = ti < 0 ? [] : await page.$$eval(".browse table tbody tr",
    (rs, i) => rs.map((r) => r.querySelectorAll("td")[i]?.textContent.trim()).filter(Boolean), ti);
  const allMount = types.length > 0 && types.every((t) => t === "Mount");
  const models = await page.$$eval(".browse tbody .model-link[data-display]", (e) => e.length);
  console.log(`mount ${itemId}: summons="${summons}" npcHref="${npcHref}" rev=${revLink} | browse rows=${rows} typesMount=${allMount} modelLinks=${models}`);
  return summons.includes("Summons") && summons.includes(expectCreature) && /npc=/.test(npcHref)
    && revLink && rows > 0 && allMount && models > 0;
}

// ?compare=a:b renders side-by-side tooltip cards + a stat-delta table with the
// best value per row highlighted.
async function testCompare(a, b) {
  await nav(`?compare=${a}:${b}`);
  await page.waitForSelector(".compare-view .cmp-card .tooltip .tt-name", { timeout: T });
  const cards = await page.$$eval(".compare-view .cmp-card", (e) => e.length);
  const rows = await page.$$eval(".cmp-table tbody tr", (e) => e.length);
  const best = await page.$$eval(".cmp-table td.cmp-best", (e) => e.length);
  console.log(`compare ${a}:${b}: cards=${cards} statRows=${rows} bestCells=${best}`);
  return cards === 2 && rows >= 2 && best > 0;
}

// Items that roll a random suffix (item.random_property) show a "🎲 Random suffix"
// badge + the pool of possible suffixes with stat ranges + chance (item 7457
// "Knight's Gauntlets" -> of the Bear / of the Whale / …).
async function testItemRandomSuffix(id) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-view", { timeout: T });
  const r = await page.evaluate(() => ({
    badge: !!document.querySelector('.item-meta .tagx[title*="random"]'),
    rows: document.querySelectorAll(".item-suffixes .suf-list li").length,
    hasBear: [...document.querySelectorAll(".item-suffixes .suf-name")].some((e) => /of the Bear/i.test(e.textContent)),
    hasChance: !!document.querySelector(".item-suffixes .suf-chance"),
  }));
  console.log(`item ${id} random suffix: badge=${r.badge} rows=${r.rows} bear=${r.hasBear} chance=${r.hasChance}`);
  return r.badge && r.rows > 0 && r.hasBear && r.hasChance;
}

// container/lockbox item shows a "Contains" tab listing what it yields
async function testContainer(id, expectName) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  const tabs = await page.$$eval(".item-rel .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const has = tabs.some((t) => /^Contains\b/.test(t));
  console.log(`container ${id}: tabs=[${tabs.join(", ")}] hasContains=${has}`);
  return has;
}

// vendor items with limited stock show a restock cadence (↻ 2h) beside the cap;
// unlimited stock shows ∞. Medium Leather (2319) restocks up to 5 every 2h at Lhara.
async function testVendorRestock(id) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".item-rel .tab")].find((t) => /Sold by/.test(t.textContent)); if (b) b.click(); });
  await page.waitForSelector(".item-rel .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const stock = await page.$$eval(".item-rel .tabpane:not(.hidden) tbody tr td:last-child", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const hasRestock = stock.some((s) => /↻/.test(s));
  console.log(`vendor-restock ${id}: stock=[${stock.join(" | ")}] hasRestock=${hasRestock}`);
  return stock.length > 0 && hasRestock;
}

// Sold-by tab shows each vendor's zone (Location column) and faction alignment
// badge (A/H/N). Medium Leather (2319) is sold by Lhara in a real zone.
async function testSoldByLocation(id) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".item-rel .tab")].find((t) => /Sold by/.test(t.textContent)); if (b) b.click(); });
  await page.waitForSelector(".item-rel .tabpane:not(.hidden) table tbody tr", { timeout: T });
  const heads = await page.$$eval(".item-rel .tabpane:not(.hidden) thead th", (e) => e.map((t) => t.textContent.trim()));
  const badges = await page.$$eval(".item-rel .tabpane:not(.hidden) tbody .tbadge", (e) => e.length);
  const zoneLinks = await page.$$eval(".item-rel .tabpane:not(.hidden) tbody a.zone", (e) => e.length);
  console.log(`sold-by ${id}: heads=${JSON.stringify(heads)} badges=${badges} zoneLinks=${zoneLinks}`);
  return heads.includes("Location") && heads.includes("Faction") && badges >= 1 && zoneLinks >= 1;
}

// readable item (book/letter/document) renders its page_text prose in a .readable
// panel. Marshal McBride's Documents (745) chains four report pages.
async function testReadableItem(id, expect) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-main .readable .readable-body", { timeout: T });
  const txt = await page.$eval(".item-main .readable .readable-body", (e) => e.textContent);
  console.log(`readable-item ${id}: expect="${expect}" found=${txt.includes(expect)} len=${txt.length}`);
  return txt.includes(expect);
}

// recipe/pattern/plans item shows a "Teaches" tab with the craft it unlocks
async function testTeaches(id, expectName) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  const tabs = await page.$$eval(".item-rel .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const has = tabs.some((t) => /^Teaches\b/.test(t));
  console.log(`teaches ${id}: tabs=[${tabs.join(", ")}] hasTeaches=${has}`);
  return has;
}

// Turtle custom icon (not on Blizzard CDN) renders from the sprite atlas as a
// <span class="icon-sprite"> backed by custom-atlas.webp. Item 9376 Jang'thraze
// uses custom icon "gensword1h_4".
async function testCustomIcon(id, expectName) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".tooltip .tt-name", { timeout: T });
  const name = await page.$eval(".tooltip .tt-name", (e) => e.textContent);
  const bg = await page.$eval(".tooltip .tt-head .icon-sprite", (e) => e.style.backgroundImage).catch(() => "");
  console.log(`custom icon ${id}: name="${name}" spriteBg="${bg}"`);
  return name.includes(expectName) && /custom-atlas\.webp/.test(bg);
}

// The "Dropped by" tab carries a Location column resolved for each NPC (open-world
// zone or dungeon), e.g. wolves dropping Tough Wolf Meat (item 750).
async function testItemDropLocation(id) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".item-rel .tab")].find((t) => t.textContent.includes("Dropped by")); if (b) b.click(); });
  await page.waitForSelector(".item-rel .tabpane:not(.hidden) table tbody tr", { timeout: T });
  const headers = await page.$$eval(".item-rel .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const li = headers.indexOf("Location");
  const locs = await page.$$eval(".item-rel .tabpane:not(.hidden) tbody tr", (rows, idx) => rows.map((r) => r.querySelectorAll("td")[idx]?.textContent.trim()).filter(Boolean), li);
  console.log(`item-drop-loc ${id}: headers=[${headers.join(",")}] locs=${JSON.stringify(locs.slice(0, 3))}`);
  return li >= 0 && locs.length > 0;
}

async function testItemSources(id, expectTag) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-sources .tagx", { timeout: T });
  const tags = await page.$$eval(".item-sources .tagx", (e) => e.map((t) => t.textContent.trim()));
  console.log(`item sources ${id}: [${tags.join(", ")}]`);
  return tags.length > 0 && (!expectTag || tags.includes(expectTag));
}

// Item tooltip "Buy Price": shown only for vendor-purchasable items (build-db
// `buyable`); a drop/quest item with no vendor shows Sell but not Buy.
async function testItemBuyPrice(buyableId, dropId) {
  const buyLine = async (id) => {
    await nav(`?item=${id}`);
    await page.waitForSelector(".tooltip .tt-name", { timeout: T });
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
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  await page.evaluate(() => { const t = [...document.querySelectorAll(".item-rel .tab")].find((x) => /Found in object/.test(x.textContent)); if (t) t.click(); });
  await page.waitForSelector(".item-rel .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const objLink = (await page.$(".item-rel .tabpane:not(.hidden) a.ilink.object[href*='object=']")) !== null;
  const headers = await page.$$eval(".item-rel .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  console.log(`item-found-in-object ${id}: objLink=${objLink} headers=[${headers.join(",")}]`);
  return objLink && headers.includes("Chance") && headers.includes("Spawns");
}

// item tooltip green spell lines are now spell links (item -> ?spell=).
async function testItemSpellLink(id) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-main .tooltip", { timeout: T });
  const links = await page.$$eval(".item-main .tt-spell a.ilink.spell", (e) => e.length);
  console.log(`item ${id} spell links: ${links}`);
  return links > 0;
}

// crafted item shows its crafting profession in the "Created by" section.
async function testCrafted(id, expectProf) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel", { timeout: T });
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

// "Reagent for" tab must include enchant spells (which create no item), not just
// crafted-item rows. Dream Dust (11176) is a reagent for 17 spells, 11 of them enchants.
async function testReagentFor(id, minRows) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel", { timeout: T });
  await page.$$eval(".item-rel .tab", (tabs) => { const t = tabs.find((x) => /Reagent for/.test(x.textContent)); if (t) t.click(); });
  const rows = await page.$$eval(".item-rel .tabpane:not(.hidden) table tbody tr", (r) => r.length).catch(() => 0);
  // no broken ?item=null links from enchant rows with no created item
  const badLinks = await page.$$eval('.item-rel .tabpane:not(.hidden) a.ilink[href*="item=null"]', (a) => a.length).catch(() => 0);
  console.log(`reagent-for ${id}: rows=${rows} (expect >=${minRows}) badLinks=${badLinks}`);
  return rows >= minRows && badLinks === 0;
}

smoke("item 7909 Aquamarine", () => testItem(7909, "Aquamarine"));
smoke("item 2770 Copper Ore", () => testItem(2770, "Copper Ore"));
smoke("item 55356 Netherwrought", () => testItem(55356, "Netherwrought"));
smoke("item 647 Destiny", () => testItem(647, "Destiny"));
smoke("item-worlddrop 14555", () => testItemWorldDrop(14555));
smoke("item-set 22416/523", () => testItemSet(22416, 523));
smoke("set-membership 640", () => testSetMembership(640, 55108, 70517));
smoke("item reward-faction 22113", () => testQuestRewardFaction(22113));
smoke("item-slots 42243 bag", () => testItemSlots(42243, "22 Slot Bag"));
smoke("item-slots 18714 quiver", () => testItemSlots(18714, "18 Slot Quiver"));
smoke("item-slots 18042 ammo", () => testItemSlots(18042, "Adds 17.5 damage per second"));
smoke("item same-model 33292", () => testSameModel(33292, 2));
smoke("item mount 18768", () => testMount(18768, 14557, "Swift Dawnsaber"));
smoke("item compare 47185:47191", () => testCompare(47185, 47191));
smoke("item random-suffix 7457", () => testItemRandomSuffix(7457));
smoke("item container 16882", () => testContainer(16882, "Junkbox"));
smoke("item vendor-restock 2319", () => testVendorRestock(2319));
smoke("item sold-by location+faction 2319", () => testSoldByLocation(2319));
smoke("item readable 745", () => testReadableItem(745, "REPORT: Kobolds"));
smoke("item teaches 70204", () => testTeaches(70204, "Shadowforged"));
smoke("item custom-icon 9376", () => testCustomIcon(9376, "Jang"));
smoke("item drop-location 750", () => testItemDropLocation(750));
smoke("item sources 2770", () => testItemSources(2770));
smoke("item sources 5031 unobtainable", () => testItemSources(5031, "Unobtainable"));
smoke("item buy-price 68/65", () => testItemBuyPrice(68, 65));
smoke("item gather-link 12467", () => testItemGatherLink(12467));
smoke("item spell-link 70204", () => testItemSpellLink(70204));
smoke("item crafted 2575", () => testCrafted(2575, "Tailoring"));
smoke("item reagent-for 11176", () => testReagentFor(11176, 17));
smoke("share item 2770", () => testShareButton("item", 2770, "i"));
