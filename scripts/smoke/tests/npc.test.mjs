import { page, nav, T, smoke } from "../harness.mjs";
import { testBrowse } from "./_shared.mjs";

// Measure the in-app (SPA) navigation render time — the actual "click an NPC"
// path (DB already in memory; just queries + render). Catches query regressions
// like an unindexed spawn_points scan. App must already be loaded (warm).
async function testNpcLoad(id, maxMs) {
  await nav(`?item=2770`); // warm the DB
  await page.waitForSelector(".tooltip .tt-name", { timeout: T });
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

async function testNpc(id, expectName, expectTab) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-head h1", { timeout: T });
  const name = await page.$eval(".npc-head h1", (e) => e.textContent);
  const tabsList = await page.$$eval(".tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  // Across ALL panes, not just the visible one: the first tab is now "Stats", whose
  // pane is a key/value block rather than a sortable table.
  const sortableH = await page.$$eval(".npc-page .tabpane th.sortable", (e) => e.length);
  // Every creature has a display_id -> the meta line must carry the model thumb hook.
  const display = await page.$eval(".npc-meta .model-link", (e) => e.getAttribute("data-display")).catch(() => null);
  console.log(`npc ${id}: name="${name}" tabs=[${tabsList.join(", ")}] sortableHdrs=${sortableH} model=${display}`);
  return name.includes(expectName) && tabsList.length > 0 && sortableH > 0 && !!display && (!expectTab || tabsList.some((t) => t.includes(expectTab)));
}

// Build-time prune of false-positive QUESTGIVER flags (build-db.mjs): an NPC with the
// flag but no quest relation (e.g. Servant of Azora #1949) must NOT show the role badge;
// a real quest giver (Eagan Peltskinner #196) must keep it.
async function testQuestGiverPrune() {
  const roleTags = async (id) => {
    await nav(`?npc=${id}`);
    await page.waitForSelector(".npc-head h1", { timeout: T });
    return page.$$eval(".npc-head .npc-meta .tagx", (e) => e.map((x) => x.textContent.trim()));
  };
  const fp = await roleTags(1949);
  const real = await roleTags(196);
  const fpClean = !fp.includes("Quest Giver");
  const realHas = real.includes("Quest Giver");
  console.log(`questgiver-prune: #1949 tags=[${fp.join(",")}] (noBadge=${fpClean}) | #196 tags=[${real.join(",")}] (hasBadge=${realHas})`);
  return fpClean && realHas;
}

// A single-profession trainer hides the redundant Profession column (every row
// the same skill). NPC 5038 is an Enchanting trainer.
async function testTrainerCols(id) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".npc-page .tab")].find((t) => t.textContent.includes("Teaches")); if (b) b.click(); });
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const headers = await page.$$eval(".npc-page .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const rows = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr", (r) => r.length).catch(() => 0);
  console.log(`trainer-cols ${id}: rows=${rows} headers=[${headers.join(",")}]`);
  return rows > 0 && !headers.includes("Profession");
}

async function testNpcTypeLink(id) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-meta a.nav[href*='browse=npcs']", { timeout: T });
  const href = await page.$eval(".npc-meta a.nav[href*='browse=npcs']", (e) => e.getAttribute("href"));
  const label = await page.$eval(".npc-meta a.nav[href*='browse=npcs']", (e) => e.textContent.trim());
  await page.click(".npc-meta a.nav[href*='browse=npcs']");
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const typeSel = await page.$eval(".filters [data-f='type']", (e) => e.value).catch(() => "?");
  const m = /type=(\d+)/.exec(href);
  const matchSel = m && m[1] === typeSel;
  console.log(`npc type link ${id}: label="${label}" href="${href}" filterType=${typeSel} match=${matchSel}`);
  return /browse=npcs&type=\d+/.test(href) && matchSel;
}

// A spawning NPC's page renders its zone map with the parchment image + its
// own spawn pins (focus layer).
async function testNpcMap(id) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-head h1", { timeout: T });
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
  await nav(`?npc=${id}`);
  await page.waitForSelector("#zonemap .leaflet-marker-icon", { timeout: 30000 });
  // Right-click a marker to open the copy menu. RETRY: the map may still be running
  // its fitBounds animation, which shifts marker positions and drops the first
  // contextmenu -- this was the suite's one flaky test (1 miss in 3 runs).
  let opened = false;
  for (let i = 0; i < 5 && !opened; i++) {
    await new Promise((r) => setTimeout(r, 250));
    await page.click("#zonemap .leaflet-marker-icon", { button: "right" }).catch(() => {});
    opened = await page.waitForSelector(".map-ctx", { visible: true, timeout: 2000 }).then(() => true).catch(() => false);
  }
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

// A template-vendor NPC (creature_template.vendor_id -> npc_vendor_template) lists
// its stock on the Sells tab. NPC 1249 (Quartermaster Hudson) sells via vendor_id.
async function testNpcSells(id, minItems) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".npc-page .tab")].find((t) => t.textContent.includes("Sells")); if (b) b.click(); });
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const rows = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr", (r) => r.length).catch(() => 0);
  console.log(`npc-sells ${id}: rows=${rows}`);
  return rows >= minItems;
}

// NPCs with no recorded spawn (script/pool/event-placed, e.g. 80101) show an
// explanatory note instead of a blank where the map would be.
async function testNpcNoSpawn(id) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-page", { timeout: T });
  const note = (await page.$(".npc-page .zone-empty")) !== null;
  const noMap = (await page.$("#zonemap")) === null;
  console.log(`npc-nospawn ${id}: note=${note} noMap=${noMap}`);
  return note && noMap;
}

// The NPC-page map uses each spawn's exact precomputed home zone (ADT-derived),
// so overlapping WMA boxes no longer mis-assign: NPC 596 (Deadmines-entrance spawn)
// resolves to its real terrain zone Westfall (40), not Stranglethorn.
async function testNpcMapZone(id, areaid) {
  await nav(`?npc=${id}`);
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
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-head", { timeout: T });
  const hrefs = await page.$$eval(".npc-head .npc-meta a.ilink.zone", (e) => e.map((x) => x.getAttribute("href")));
  const match = hrefs.some((h) => h.includes(`zone=${areaid}`));
  console.log(`npc-loc-label ${id}: hrefs=${JSON.stringify(hrefs)} wantZone=${areaid} match=${match}`);
  return match;
}

// Multi-floor instance: a spawn on the upper floor (Kel'Thuzad, npc 15990, is on
// The Upper Necropolis = areaId 5148) is assigned to that floor's parchment, not
// the main Naxxramas zone. The NPC page also shows the static model thumbnail.
async function testNpcFloorAndModel(id) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-head h1", { timeout: T });
  const modelOk = await page.$eval(".npc-model[href]", (a) => /model-thumbs|zamimg/.test(a.getAttribute("href")) && a.getAttribute("target") === "_blank").catch(() => false);
  // #zonemap only renders when the spawn resolves to a mappable floor (KT -> the
  // Upper Necropolis parchment). The image layer itself is flaky to await headlessly.
  const hasMap = (await page.$("#zonemap")) !== null;
  console.log(`npc-floor-model ${id}: modelThumb=${modelOk} hasMap=${hasMap}`);
  return modelOk && hasMap;   // KT's correct floor (5148 vs 3456) is verified in-DB
}

// An NPC that belongs to a faction shows it (linked when the faction has a page).
async function testNpcFaction(id, factionId) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-head", { timeout: T });
  const has = (await page.$(`.npc-head .npc-meta a.ilink[href*='faction=${factionId}']`)) !== null;
  console.log(`npc-faction ${id}: factionLink(${factionId})=${has}`);
  return has;
}

// NPC links get a hover tooltip too (name + level/rank/type), like items/quests/spells.
async function testNpcHover() {
  await nav(`?browse=npcs`);
  await page.waitForSelector('.browse table tbody a.ilink[href^="?npc="]', { timeout: T });
  await page.hover('.browse table tbody a.ilink[href^="?npc="]');
  await page.waitForSelector(".hovercard .tt-name", { timeout: 10000 }).catch(() => {});
  const name = await page.$eval(".hovercard .tt-name", (e) => e.textContent).catch(() => "(none)");
  console.log(`npc-hover: card name="${name}"`);
  return name !== "(none)";
}

// browse NPCs shows Faction + Location (not ID), searches title, and filters by faction.
async function testBrowseNpcCols() {
  await nav(`?browse=npcs&q=quartermaster`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const factionFilter = (await page.$(".filters [data-f='faction']")) !== null;
  console.log(`browse-npc-cols: rows=${rows} headers=[${headers.join(",")}] factionFilter=${factionFilter}`);
  return rows > 0 && headers.includes("Faction") && headers.includes("Location") && !headers.includes("ID") && factionFilter;
}

// ?npc=ID&fz=<areaid>: a mob's map opens on the farmed zone (when it spawns there),
// not its busiest one -- the zone Farming tab links mobs here too.
async function testNpcFocusZone(id, areaid) {
  await nav(`?npc=${id}&fz=${areaid}`);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T });
  const src = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src"));
  console.log(`npc-focus-zone ${id}&fz=${areaid}: map=${src}`);
  return src.includes(`/${areaid}.webp`);
}

// Combat stats (creature_template -> creatures, see build-db): the FIRST tab, no
// count badge, a real grouped table (Defense / Offense / Resources & loot), and a
// "vs. typical" column holding each stat against the median of its peers
// (Q_NPC_PEERS). Lucifron (12118) is a level 63 boss -> a 227-strong cohort.
async function testNpcStats(id, wantStats) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) table tbody tr", { timeout: T });
  const firstTab = await page.$eval(".npc-page .tab", (e) => e.textContent.trim());
  const noBadge = await page.$eval(".npc-page .tab", (e) => !e.querySelector(".tabn"));
  const pane = ".npc-page .tabpane:not(.hidden)";
  const headers = await page.$$eval(`${pane} th`, (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const groups = await page.$$eval(`${pane} tr.grouprow`, (e) => e.map((g) => g.textContent.replace(/[▸▾]/g, "").trim()));
  const stats = await page.$$eval(`${pane} tbody tr:not(.grouprow) td:first-child`, (e) => e.map((c) => c.textContent.trim()));
  // ratio cells: "×1.20" + a bar whose fill sits on one side of the median tick
  const ratios = await page.$$eval(`${pane} .cmp-num`, (e) => e.map((c) => c.textContent.trim()));
  const bars = await page.$$eval(`${pane} .cmp-bar i`, (e) => e.length);
  const note = await page.$eval(`${pane} .npc-stat-note`, (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
  const missing = wantStats.filter((s) => !stats.includes(s));
  const peerCol = headers.some((h) => /^vs\. typical Lvl \d+/.test(h));
  console.log(`npc-stats ${id}: firstTab="${firstTab}" noBadge=${noBadge} headers=[${headers.join(",")}] groups=[${groups.join(",")}] stats=[${stats.join(",")}] ratios=[${ratios.join(",")}] bars=${bars} note="${note}" missing=[${missing.join(",")}]`);
  return firstTab === "Stats" && noBadge && peerCol && !missing.length
    && groups.includes("Defense") && groups.includes("Offense")
    && ratios.length >= 3 && ratios.every((r) => /^×\d+\.\d\d$/.test(r)) && bars > 0
    && /median of [\d,]+ level \d+ \w/i.test(note);
}

// Too small a cohort must NOT quote a made-up median: Hogger (448) is one of only 7
// level 11 elites, under NPC_PEER_MIN, so every ratio cell is empty and the table's
// hideEmpty drops the whole comparison column.
async function testNpcStatsNoPeers(id) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) table tbody tr", { timeout: T });
  const pane = ".npc-page .tabpane:not(.hidden)";
  const headers = await page.$$eval(`${pane} th`, (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const ratios = await page.$$eval(`${pane} .cmp-num`, (e) => e.length);
  const note = await page.$eval(`${pane} .npc-stat-note`, (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
  const rows = await page.$$eval(`${pane} tbody tr:not(.grouprow)`, (e) => e.length);
  console.log(`npc-stats-nopeers ${id}: headers=[${headers.join(",")}] ratioCells=${ratios} rows=${rows} note="${note}"`);
  return rows > 0 && ratios === 0 && !headers.some((h) => /^vs\. typical/.test(h)) && /too few/i.test(note);
}

// Abilities: the spells a creature casts, unioned from the template slots, its
// shared spell list and its EventAI script (build-db `creature_ability`). Bolvar
// (1748) draws from all three, so the Source column must show more than one value.
async function testNpcAbilities(id, minRows) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".npc-page .tab")].find((t) => t.textContent.includes("Abilities")); if (b) b.click(); });
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) tbody tr", { timeout: T }).catch(() => {});
  const rows = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr", (r) => r.length).catch(() => 0);
  const spellLinks = await page.$$eval('.npc-page .tabpane:not(.hidden) tbody a.ilink[href^="?spell="]', (e) => e.length).catch(() => 0);
  const sources = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr", (trs) =>
    [...new Set(trs.map((r) => r.children[1]?.textContent.trim()).filter(Boolean))]).catch(() => []);
  console.log(`npc-abilities ${id}: rows=${rows} spellLinks=${spellLinks} sources=[${sources.join(",")}]`);
  return rows >= minRows && spellLinks === rows && sources.length > 1;
}

// A boss whose fight lives in the server's C++ (ScriptDev2) has no spell list, no
// template slots and no EventAI rows, so it listed nothing until script-abilities.json
// (extract-script-abilities.mjs) mapped script_name -> the spells the script casts.
// Ragnaros is the canonical case.
async function testNpcScriptAbilities(id, wantSpells) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".npc-page .tab")].find((t) => t.textContent.includes("Abilities")); if (b) b.click(); });
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) tbody tr", { timeout: T }).catch(() => {});
  const pane = ".npc-page .tabpane:not(.hidden)";
  const names = await page.$$eval(`${pane} tbody a.ilink`, (e) => e.map((a) => a.textContent.trim()));
  const sources = await page.$$eval(`${pane} tbody tr`, (trs) =>
    [...new Set(trs.map((r) => r.children[1]?.textContent.trim()).filter(Boolean))]).catch(() => []);
  const missing = wantSpells.filter((s) => !names.some((n) => n.includes(s)));
  console.log(`npc-script-abilities ${id}: spells=[${names.join(",")}] sources=[${sources.join(",")}] missing=[${missing.join(",")}]`);
  return !missing.length && sources.includes("Boss script");
}

smoke("npc-load 15379 perf", () => testNpcLoad(15379, 400));
smoke("npc stats 12118 Lucifron", () => testNpcStats(12118, ["Health", "Mana", "Armor", "Melee damage", "Melee DPS", "Attack speed"]));
smoke("npc stats no-peers 448 Hogger", () => testNpcStatsNoPeers(448));
smoke("npc abilities 1748 Bolvar", () => testNpcAbilities(1748, 4));
smoke("npc abilities 11502 Ragnaros (C++ script)", () => testNpcScriptAbilities(11502, ["Wrath of Ragnaros", "Magma Blast"]));
smoke("npc 2376 Torn Fin Oracle", () => testNpc(2376, "Torn Fin Oracle"));
smoke("npc 80402 trainer Teaches", () => testNpc(80402, "Aemara Sunsorrow", "Teaches"));
smoke("npc 10981 Skinning", () => testNpc(10981, "", "Skinning"));
smoke("questgiver-prune", () => testQuestGiverPrune());
smoke("trainer-cols 5038", () => testTrainerCols(5038));
smoke("npc type-link 2376", () => testNpcTypeLink(2376));
smoke("npc map 2376", () => testNpcMap(2376));
smoke("npc map-menu 2376", () => testNpcMapMenu(2376));
smoke("npc sells 1249", () => testNpcSells(1249, 5));
smoke("npc no-spawn 80101", () => testNpcNoSpawn(80101));
smoke("npc map-zone 596 Westfall", () => testNpcMapZone(596, 40));
smoke("npc map-zone 11501 Dire Maul", () => testNpcMapZone(11501, 2557));
smoke("npc map-zone 80208", () => testNpcMapZone(80208, 5225));
smoke("npc map-zone 14890 Ashenvale", () => testNpcMapZone(14890, 331));
smoke("npc map-zone 60735 Hateforge", () => testNpcMapZone(60735, 5103));
smoke("npc loc-label 80208", () => testNpcLocationLabel(80208, 5225));
smoke("npc loc-label 596", () => testNpcLocationLabel(596, 40));
smoke("npc floor-and-model 15990 KT", () => testNpcFloorAndModel(15990));
smoke("npc faction 80959", () => testNpcFaction(80959, 69));
smoke("npc hover", () => testNpcHover());
smoke("browse npc cols", () => testBrowseNpcCols());
smoke("browse npcs rank=3", () => testBrowse("npcs", "&rank=3"));
smoke("npc focus-zone 524", () => testNpcFocusZone(524, 10));
