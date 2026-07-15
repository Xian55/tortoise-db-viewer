// Dungeon/instance pages: the dungeons index, the ?dungeon= detail (boss loot +
// parchment + skull markers), the zone-route auto-detect of instances, dungeon
// quests, map-less fallbacks, and synthetic-areaId parchment redirects.
import { page, nav, T, smoke } from "../harness.mjs";

async function testDungeons() {
  await nav(`?dungeons`);
  await page.waitForSelector(".results table tbody tr", { timeout: T });
  const rows = await page.$$eval(".results table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".results th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  // a derived Level column with at least one populated "lo–hi" range
  const ranges = await page.$$eval(".results table tbody tr", (trs) =>
    trs.map((tr) => tr.children[1]?.textContent.trim()).filter((t) => /^\d+–\d+$/.test(t)).length);
  console.log(`dungeons index: ${rows} rows headers=[${headers.join(",")}] levelRanges=${ranges}`);
  return rows > 0 && headers.includes("Level") && ranges > 10;
}

async function testDungeon(id, expectName) {
  await nav(`?dungeon=${id}`);
  await page.waitForSelector(".npc-head h1", { timeout: T });
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
  await nav(`?zone=${areaid}`);
  await page.waitForSelector(".npc-head h1", { timeout: T });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  await page.waitForSelector("#zonemap .map-boss", { timeout: 30000 }).catch(() => {});
  const bossPins = await page.$$eval("#zonemap .map-boss", (e) => e.length).catch(() => 0);
  const hasMap = (await page.$("#zonemap .leaflet-image-layer")) !== null;
  const tabList = await page.$$eval(".tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  console.log(`zone-instance ${areaid}: name="${name}" tabs=[${tabList.join(", ")}] map=${hasMap} bossPins=${bossPins}`);
  return name.includes(expectName) && tabList.some((t) => t.includes("Boss Loot")) && hasMap && bossPins > 0;
}

// An instance lists the quests related to it (giver/turn-in inside, dungeon-
// exclusive item drop, or same-named gameplay zone) on its Quests tab. Gilneas
// City (?zone=5208) is a Turtle dungeon whose quests live on a separate AreaTable
// zone, so this exercises the WorldMap-area <-> gameplay-zone bridge.
// expectTitle (optional): a quest that MUST appear -> guards the creature_instance
// bridge in Q_DUNGEON_QUESTS. Baron Aquanis's start item drops from a script-spawned
// boss (no static `spawns` row), so a spawns-only join dropped it from the list.
async function testDungeonQuests(areaid, minQuests, expectTitle) {
  await nav(`?zone=${areaid}`);
  await page.waitForSelector(".zone-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".zone-page .tab")].find((t) => t.textContent.trim().startsWith("Quests")); if (b) b.click(); });
  await page.waitForSelector(".zone-page .tabpane:not(.hidden) table tbody tr", { timeout: T });
  const rows = await page.$$eval(".zone-page .tabpane:not(.hidden) tbody tr", (r) => r.length);
  const hasQuestLink = (await page.$(".zone-page .tabpane:not(.hidden) a.ilink[href*='quest=']")) !== null;
  const headers = await page.$$eval(".zone-page .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  // each quest carries a faction-eligibility badge (Alliance / Horde / Neutral)
  const factions = await page.$$eval(".zone-page .tabpane:not(.hidden) tbody tr .tagx[class*='fac-']", (e) => [...new Set(e.map((x) => x.textContent.trim()))]);
  const titles = await page.$$eval(".zone-page .tabpane:not(.hidden) tbody tr a.ilink[href*='quest=']", (e) => e.map((x) => x.textContent.trim()));
  const hasTitle = !expectTitle || titles.some((t) => t.includes(expectTitle));
  console.log(`dungeon-quests ${areaid}: rows=${rows} questLink=${hasQuestLink} headers=[${headers.join(",")}] factions=${JSON.stringify(factions)}${expectTitle ? ` hasTitle(${expectTitle})=${hasTitle}` : ""}`);
  return rows >= minQuests && hasQuestLink && headers.includes("Faction") && factions.length > 0
    && factions.every((f) => ["Alliance", "Horde", "Neutral"].includes(f)) && hasTitle;
}

async function testDungeonNoMap(id, expectName) {
  await nav(`?dungeon=${id}`);
  await page.waitForSelector(".npc-head h1", { timeout: T });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const mapDiv = (await page.$("#zonemap")) !== null;
  console.log(`dungeon-nomap ${id}: name="${name}" tabs=[${tabList.join(", ")}] mapDiv=${mapDiv}`);
  // map-less instances may lack loot data, so don't require a Boss Loot tab -- the
  // point is the dungeon page renders with NO map (the fallback path).
  return name.includes(expectName) && !mapDiv;
}

// A map-less instance (no WorldMap parchment, e.g. Lower Karazhan Halls) still
// renders via the ?dungeon= fallback: Boss Loot tab, no zone map.
// A dungeon whose WorldMapArea shares an areaId with another instance (Lower
// Karazhan Halls, map 532, shares areaId 3457 with Upper Karazhan) still gets its
// own parchment via a synthetic areaId (extract-maps.py) -> ?dungeon= redirects to
// that zone and shows the map.
async function testDungeonMap(id, expectZone) {
  await nav(`?dungeon=${id}`);
  await page.waitForFunction((z) => location.search.includes(`zone=${z}`), { timeout: T }, expectZone).catch(() => {});
  const hasMap = await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: 20000 }).then(() => true).catch(() => false);
  const onZone = await page.evaluate(() => location.search);
  console.log(`dungeon-map ${id}: url="${onZone}" hasMap=${hasMap}`);
  return onZone.includes(`zone=${expectZone}`) && hasMap;
}

smoke("dungeons index", () => testDungeons());
smoke("dungeon 36 Deadmines", () => testDungeon(36, "Deadmines"));
smoke("instance-zone 5138 Deadmines", () => testInstanceZone(5138, "Deadmines"));
smoke("instance-zone 2557 Dire Maul", () => testInstanceZone(2557, "Dire Maul"));
smoke("dungeon-quests 5208 Gilneas", () => testDungeonQuests(5208, 8));
smoke("dungeon-quests 719 BFD Baron", () => testDungeonQuests(719, 15, "Baron Aquanis"));
smoke("dungeon-nomap 45 Scarlet Citadel", () => testDungeonNoMap(45, "Scarlet Citadel"));
smoke("dungeon-map 532 Lower Karazhan", () => testDungeonMap(532, 1000532));
