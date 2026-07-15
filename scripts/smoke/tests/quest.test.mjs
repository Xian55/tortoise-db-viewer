// Quest detail page: header + tabs (givers/objectives/rewards), inline objectives
// embed, video link, quest chain (branches/merges), zone chain, NPC/kill locations,
// required drops, quest map (single/multi/bounds), object + rep links, origin badge.
import { page, nav, T, smoke } from "../harness.mjs";
import { testBrowse, testShareButton } from "./_shared.mjs";

// quest detail: header + tabs (givers/objectives/rewards) + sortable pane + desc.
async function testQuest(id, expectName) {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-page .npc-head h1", { timeout: T });
  const name = await page.$eval(".quest-page .npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".quest-page .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const sortableH = await page.$$eval(".quest-page .tabpane:not(.hidden) th.sortable", (e) => e.length);
  const descBlocks = await page.$$eval(".quest-desc h3", (e) => e.length);
  console.log(`quest ${id}: name="${name}" tabs=[${tabList.join(", ")}] sortableHdrs=${sortableH} descBlocks=${descBlocks}`);
  return name.includes(expectName) && tabList.length > 0 && sortableH > 0;
}

// The quest desc embeds objectives (collect items w/ icons) and rewards
// ("You will receive:" item + icon) inline, like the in-game log. Quest 60141 ->
// collect Rockhide Boar Meat, receive Linen Bag.
async function testQuestObjectivesEmbed(id) {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-desc", { timeout: T });
  const goalItems = await page.$$eval(".quest-goals li a.ilink", (e) => e.length).catch(() => 0);
  const goalIcons = await page.$$eval(".quest-goals li a.ilink .il-icon", (e) => e.length).catch(() => 0);
  const rewLbls = await page.$$eval(".quest-desc .q-rew-lbl", (e) => e.map((x) => x.textContent.trim()));
  const rewItems = await page.$$eval(".quest-desc .q-rew-grp .quest-items li a.ilink", (e) => e.length).catch(() => 0);
  const receive = rewLbls.some((l) => /You will receive/i.test(l));
  console.log(`quest-embed ${id}: goalItems=${goalItems} goalIcons=${goalIcons} rewLbls=${JSON.stringify(rewLbls)} rewItems=${rewItems}`);
  return goalItems > 0 && goalIcons > 0 && receive && rewItems > 0;
}

// Quest page carries a "Watch walkthrough" link: a channel-scoped YouTube search
// for the quest title (opens in a new tab).
async function testQuestVideoLink(id) {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-page .yt-link", { timeout: T });
  const href = await page.$eval(".quest-page .yt-link", (e) => e.getAttribute("href"));
  const target = await page.$eval(".quest-page .yt-link", (e) => e.getAttribute("target"));
  const title = await page.$eval(".quest-page .npc-head h1", (e) => e.textContent.trim());
  const m = /\/@TurtleWoWQuests\/search\?query=(.+)$/.exec(href || "");
  const queryOk = !!m && decodeURIComponent(m[1]) === `${title} (ID: ${id})`;
  console.log(`quest-video-link ${id}: href="${href}" target=${target} queryMatchesTitleAndId=${queryOk}`);
  return queryOk && target === "_blank";
}

// Quest page shows the full chain (both directions, as a table) with the current
// quest marked, plus each step's start NPC + location.
async function testQuestChain(id, minLen) {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("Quest Chain")); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: T });
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

// Starts/Ends (NPC) tabs carry a Location column with where the NPC is.
async function testQuestNpcLocation(id) {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("Starts (NPC)")); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: T });
  const headers = await page.$$eval(".tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const locs = await page.$$eval(".tabpane:not(.hidden) tbody tr td:last-child", (t) => t.map((x) => x.textContent.trim()).filter(Boolean));
  console.log(`quest-npc-loc ${id}: headers=[${headers.join(",")}] locs=${JSON.stringify(locs.slice(0, 3))}`);
  return headers.includes("Location") && locs.length > 0;
}

// A sub-zone quest resolves the full hierarchy continent > zone > sub-zone, with
// the parent zone linked. Quest 783 -> Eastern Kingdoms > Elwynn Forest > Northshire Valley.
async function testQuestZoneChain(id) {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-page .npc-head", { timeout: T });
  const meta = await page.$eval(".quest-page .npc-head", (e) => e.textContent.replace(/\s+/g, " ").trim());
  const zoneHrefs = await page.$$eval(".quest-page .npc-head a.ilink.zone", (a) => a.map((x) => x.getAttribute("href")));
  const ok = meta.includes("Eastern Kingdoms") && meta.includes("Elwynn Forest") && meta.includes("Northshire Valley") && zoneHrefs.some((h) => h.includes("zone=12"));
  console.log(`quest-zone-chain ${id}: meta="${meta.slice(0, 90)}" zoneHrefs=${JSON.stringify(zoneHrefs)} ok=${ok}`);
  return ok;
}

// Chain tab flags chain structure with inline badges (no redundant prereq column):
// ⑂ = a quest opening several lines, ⇉ = a merge point, ↗ = a separate chain that
// connects in. `want` selects which badge class must be present (.qc-branch any,
// .qc-merge convergence). 783 forks; 5862 (Redemption) has a 3-quest merge.
async function testQuestBranch(id, want = ".qc-branch") {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("Quest Chain")); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: T });
  const badges = await page.$$eval(`.tabpane:not(.hidden) ${want}`, (e) => e.map((x) => x.textContent.trim()));
  const ok = badges.length > 0;
  console.log(`quest-branch ${id}: want=${want} badges=${JSON.stringify(badges)} ok=${ok}`);
  return ok;
}

// Browse quests links zone names that have a map page (e.g. Stormwind/Elwynn).
async function testBrowseQuestZoneLink() {
  await nav(`?browse=quests&minlvl=1&maxlvl=12`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const zlinks = await page.$$eval(".browse td a.ilink.zone", (a) => a.length);
  console.log(`browse-quest-zonelink: zoneLinks=${zlinks}`);
  return zlinks > 0;
}

// quest_dungeon bridge: filtering the quest finder by a dungeon zone surfaces quests
// mis-filed elsewhere (Baron Aquanis is a Blackfathom Deeps quest filed under Ashenvale).
async function testBrowseQuestDungeonBridge() {
  await nav(`?browse=quests&zone=719`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const titles = await page.$$eval(".browse td a.ilink[href*='quest=']", (a) => a.map((x) => x.textContent.trim()));
  const hasBaron = titles.some((t) => t.includes("Baron Aquanis"));
  console.log(`browse-quest-dungeon-bridge zone=719: rows=${titles.length} Baron Aquanis=${hasBaron}`);
  return hasBaron && titles.length > 0;
}

// A required item whose ReqSourceId duplicates it must NOT appear as "Provided items".
async function testQuestNoProvided(id) {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-page .tab", { timeout: T });
  const tabList = await page.$$eval(".quest-page .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const hasProvided = tabList.some((t) => t.includes("Provided items"));
  console.log(`quest-no-provided ${id}: tabs=[${tabList.join(", ")}] hasProvided=${hasProvided}`);
  return !hasProvided;
}

// Required (objective) items are collapsible groups; expanding one reveals the
// NPCs/objects that drop it + the zone. Quest 179 -> Tough Wolf Meat -> wolves.
async function testQuestRequiredDrops(id) {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".quest-page .tab")].find((t) => t.textContent.includes("Required items")); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) .grouprow", { timeout: T });
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
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".quest-page .tab")].find((t) => t.textContent.includes("Kill / Use")); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: T });
  const headers = await page.$$eval(".tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const li = headers.indexOf("Location");
  const locs = await page.$$eval(".tabpane:not(.hidden) tbody tr", (rows, idx) => rows.map((r) => r.querySelectorAll("td")[idx]?.textContent.trim()).filter(Boolean), li);
  console.log(`quest-kill-loc ${id}: headers=[${headers.join(",")}] locs=${JSON.stringify(locs.slice(0, 3))}`);
  return li >= 0 && locs.length > 0;
}

// Quest map: a single-zone quest embeds the zone parchment (no switcher) with
// categorized highlight rows (Quest giver / Turn in / Kill / use) + an opt-in Suggested
// route toggle. A multi-zone quest gets a switcher: one button per zone parchment
// (busiest first, shown by default) plus a "World map" button that swaps in the seamless
// tile pyramid overview.
async function testQuestMap(single, multi) {
  await nav(`?quest=${single}`);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T }).catch(() => {});
  await page.waitForSelector("#zonemap .wm-panel .wm-row", { timeout: 20000 }).catch(() => {});
  const rows = await page.$$eval("#zonemap .wm-panel .wm-row .wm-row-main", (e) => e.map((x) => x.textContent.trim())).catch(() => []);
  const has = (re) => rows.some((r) => re.test(r));
  // giver/turn-in may be one merged row ("Quest giver & turn-in") when it's the same NPC
  const giver = has(/quest giver/i), turnin = has(/turn[- ]?in/i), route = has(/Suggested route/);
  // objectives are per-target layers now (named after the kill/collect target) -> any
  // marker row that isn't giver/turn-in/route counts as an objective layer.
  const objective = rows.some((r) => !/quest giver|turn[- ]?in|Suggested route/i.test(r));
  const singleNoSwitch = (await page.$$("#questmapswitch button")).length === 0;

  await nav(`?quest=${multi}`);
  await page.waitForSelector("#questmapswitch button", { timeout: T }).catch(() => {});
  const btns = await page.$$eval("#questmapswitch button", (e) => e.map((b) => b.textContent.trim())).catch(() => []);
  // defaults to the busiest zone's parchment (not the world map)
  const defaultParchment = await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T }).then(() => true).catch(() => false);
  const wIdx = btns.findIndex((b) => /world map/i.test(b));
  let worldTiles = false, worldGiver = false;
  if (wIdx >= 0) {
    (await page.$$("#questmapswitch button"))[wIdx].click();
    worldTiles = await page.waitForSelector("#zonemap img.leaflet-tile-loaded", { timeout: T }).then(() => true).catch(() => false);
    const mrows = await page.$$eval("#zonemap .wm-panel .wm-row .wm-row-main", (e) => e.map((x) => x.textContent.trim())).catch(() => []);
    worldGiver = mrows.some((r) => /quest giver/i.test(r));
  }
  console.log(`quest-map single=${single}: giver=${giver} turnin=${turnin} objective=${objective} route=${route} noSwitch=${singleNoSwitch} | multi=${multi}: zones=[${btns.join(", ")}] default=${defaultParchment} worldTiles=${worldTiles} giver=${worldGiver}`);
  return giver && turnin && objective && route && singleNoSwitch && btns.length > 1 && wIdx >= 0 && defaultParchment && worldTiles && worldGiver;
}

// Out-of-bounds parchment pruning: a spawn's ADT-assigned zone can differ from the
// zone whose WorldMapArea actually contains it, so it projects off that parchment.
// Quest 60145's kill target sits in "Northwind" but plots at Y~103 -> the Northwind
// zone view must be dropped, leaving only Elwynn Forest + the World map.
async function testQuestMapBounds(id) {
  await nav(`?quest=${id}`);
  await page.waitForSelector("#questmapswitch button", { timeout: T }).catch(() => {});
  const btns = await page.$$eval("#questmapswitch button", (e) => e.map((b) => b.textContent.trim())).catch(() => []);
  const ok = btns.includes("Elwynn Forest") && btns.some((b) => /world map/i.test(b)) && !btns.some((b) => /northwind/i.test(b));
  console.log(`quest-map-bounds ${id}: zones=[${btns.join(", ")}] ok=${ok}`);
  return ok;
}

// quest required-item object sources link to the object page (Relic of Elunaris).
async function testQuestObjectLink(id) {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".tab")].find((t) => /Required items/.test(t.textContent)); if (b) b.click(); });
  await page.waitForSelector(".tabpane:not(.hidden) .grouprow", { timeout: T }).catch(() => {});
  await page.evaluate(() => { const g = document.querySelector(".tabpane:not(.hidden) .grouprow"); if (g) g.click(); }); // expand
  await new Promise((r) => setTimeout(r, 200));
  const objLink = (await page.$(".tabpane:not(.hidden) a.ilink.object[href*='object=']")) !== null;
  console.log(`quest-object-link ${id}: objLink=${objLink}`);
  return objLink;
}

// a quest that grants reputation renders its faction as a link.
async function testQuestRepLink(id) {
  await nav(`?quest=${id}`);
  await page.waitForSelector(".quest-desc", { timeout: T });
  const links = await page.$$eval(".quest-desc a.ilink.faction", (e) => e.length);
  console.log(`quest ${id} rep faction links: ${links}`);
  return links > 0;
}

// Quest browse: the Origin=Turtle WoW filter shows only custom (entry>=10000)
// quests, each tagged "TW"; and a custom quest's page header carries the badge.
async function testQuestOrigin(customQuestId) {
  await nav(`?browse=quests&origin=tw`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const origin = await page.$eval('select[data-f="origin"]', (el) => el.value);
  const twTags = await page.$$eval(".browse td .tagx.tw-tag", (e) => e.length);
  await nav(`?quest=${customQuestId}`);
  await page.waitForSelector(".quest-page .npc-head h1", { timeout: T });
  const badge = await page.$eval(".quest-page .npc-head h1 .tagx.tw-tag", (e) => e.textContent.trim()).catch(() => "");
  console.log(`quest-origin: rows=${rows} origin="${origin}" twTags=${twTags} pageBadge="${badge}"`);
  return rows > 0 && origin === "tw" && twTags > 0 && badge === "Turtle WoW";
}

smoke("quest 14 Militia", () => testQuest(14, "Militia"));
smoke("quest objectives-embed 60141", () => testQuestObjectivesEmbed(60141));
smoke("quest video-link 14", () => testQuestVideoLink(14));
smoke("share quest 14", () => testShareButton("quest", 14, "q"));
smoke("quest chain 55220", () => testQuestChain(55220, 11));
smoke("quest npc-location 55220", () => testQuestNpcLocation(55220));
smoke("quest zone-chain 783", () => testQuestZoneChain(783));
smoke("quest branch 783", () => testQuestBranch(783));
smoke("quest merge 5862", () => testQuestBranch(5862, ".qc-merge"));
smoke("browse quest zone-link", () => testBrowseQuestZoneLink());
smoke("browse quest dungeon-bridge", () => testBrowseQuestDungeonBridge());
smoke("quest no-provided 179", () => testQuestNoProvided(179));
smoke("quest required-drops 179", () => testQuestRequiredDrops(179));
smoke("quest kill-location 41189", () => testQuestKillLocation(41189));
smoke("quest map 12/52", () => testQuestMap(12, 52));
smoke("quest map-bounds 60145", () => testQuestMapBounds(60145));
smoke("quest object-link 42087", () => testQuestObjectLink(42087));
smoke("quest rep-link 14", () => testQuestRepLink(14));
smoke("quest origin 41189", () => testQuestOrigin(41189));
smoke("browse quests level", () => testBrowse("quests", "&minlvl=1&maxlvl=12", "Zone"));
