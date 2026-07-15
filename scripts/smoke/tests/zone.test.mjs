// Zone pages + world map: parchment maps, category toggles, farming routes,
// gather granularity, floor switchers, quests, flights, and the seamless world map.
import { page, nav, T, smoke } from "../harness.mjs";
import { testBrowse } from "./_shared.mjs";

// zone page: Leaflet renders the parchment image + per-category marker toggles.
// (markers use a canvas renderer, so assert the image layer + layer control.)
async function testZone(id, expectName) {
  await nav(`?zone=${id}`);
  await page.waitForSelector(".zone-page .npc-head h1", { timeout: T });
  const name = await page.$eval(".zone-page .npc-head h1", (e) => e.textContent);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T });
  const cats = await page.$$eval("#zonemap .wm-panel .wm-row", (e) => e.length);
  const tabList = await page.$$eval(".zone-page .tabbar .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const rows = await page.$$eval(".zone-page .tabpane:not(.hidden) table tbody tr", (r) => r.length);
  console.log(`zone ${id}: name="${name}" mapImg=yes categories=${cats} tabs=[${tabList.join(", ")}] firstPaneRows=${rows}`);
  return name.includes(expectName) && cats > 0 && tabList.length >= 3 && rows > 0;
}

// Zone Objects tab: gameobject names link to ?object= (not plain text).
async function testZoneObjectLink(id) {
  await nav(`?zone=${id}`);
  await page.waitForSelector(".zone-page .tabbar .tab", { timeout: T });
  await page.evaluate(() => { const t = [...document.querySelectorAll(".zone-page .tabbar .tab")].find((x) => /Objects/.test(x.textContent)); if (t) t.click(); });
  await page.waitForSelector(".zone-page .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const objLink = (await page.$(".zone-page .tabpane:not(.hidden) a.ilink.object[href*='object=']")) !== null;
  console.log(`zone-object-link ${id}: objLink=${objLink}`);
  return objLink;
}

// The same copy menu works on the zone-page Pixi category dots (GPU sprites, no
// DOM): enable the dense Quest Givers layer, sweep the cursor until the hover
// tooltip reveals a dot, right-click it -> Copy > Coordinates copies "X.X, Y.Y".
async function testZoneDotMenu(id) {
  await page.setViewport({ width: 1280, height: 900 });
  await nav(`?zone=${id}`);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T });
  await new Promise((r) => setTimeout(r, 600));
  // the docked layer panel is open by default; tick the densest category row
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#zonemap .wm-panel .wm-row")];
    const txt = (r) => r.querySelector(".wm-row-main")?.textContent || "";
    const num = (r) => +(r.querySelector(".wm-row-n")?.textContent || 0);
    const target = rows.find((r) => /Quest Givers/i.test(txt(r)))
      || rows.slice().sort((a, b) => num(b) - num(a))[0] || rows[0];
    if (target) target.querySelector("input").click();
  });
  // Ask the app for a visible dot's on-screen position (the window.__zoneDots test
  // hook in zonemap.js) instead of blind-scanning the GPU overlay pixel by pixel --
  // the old nested mouse-move sweep took ~40s (HIT=9 forces a fine grid).
  const found = await page.waitForFunction(() => {
    const d = window.__zoneDots && window.__zoneDots();
    return d && d.length ? d[0] : null;
  }, { timeout: T }).then((h) => h.jsonValue()).catch(() => null);
  if (!found) { console.log(`zone-dot-menu ${id}: no dot found`); return false; }
  await page.mouse.move(found.x, found.y);   // drive the hover hit-test at the dot
  await page.mouse.click(found.x, found.y, { button: "right" });
  await page.waitForSelector(".map-ctx", { visible: true, timeout: 5000 }).catch(() => {});
  const headers = await page.$$eval(".map-ctx .map-ctx-h", (e) => e.map((h) => h.textContent.trim()));
  const items = await page.$$eval(".map-ctx .map-ctx-i", (e) => e.map((b) => b.textContent.trim()));
  await page.click(".map-ctx .map-ctx-i");   // Copy > Coordinates
  const copied = await page.evaluate(() => window.__copied);
  const coordOk = /^-?\d+\.\d -?\d+\.\d$/.test(copied || "");
  console.log(`zone-dot-menu ${id}: at=${JSON.stringify(found)} headers=[${headers.join(",")}] items=[${items.join(",")}] copied="${copied}" coordOk=${coordOk}`);
  return headers.includes("Copy") && items.includes("Coordinates") && items.some((t) => /TomTom/.test(t)) && coordOk;
}

// Farming route: a gather focus (?zone&gather=item) with enough spawns draws a
// numbered waypoint circuit (cluster -> nearest-neighbour), default-on + toggleable.
async function testFarmRoute(areaid, item) {
  await nav(`?zone=${areaid}&gather=${item}`);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T });
  await new Promise((r) => setTimeout(r, 700));
  const overlays = await page.$$eval("#zonemap .wm-panel .wm-row .wm-row-main", (e) => e.map((x) => x.textContent.trim()));
  const stops = await page.$$eval(".route-stop", (e) => e.length);
  const hasRoute = overlays.some((o) => /route/i.test(o));
  console.log(`farm-route ${areaid}/${item}: overlays=[${overlays.join(", ")}] stops=${stops} route=${hasRoute}`);
  return hasRoute && stops >= 3;
}

// Zone Farming tab: best gold targets ranked by total drop value, + a "Gold route"
// map overlay (value-weighted waypoint circuit).
async function testZoneFarm(areaid) {
  await nav(`?zone=${areaid}`);
  await page.waitForSelector(".zone-page .tabbar .tab", { timeout: T });
  await page.evaluate(() => { const t = [...document.querySelectorAll(".zone-page .tabbar .tab")].find((x) => /Farming/.test(x.textContent)); if (t) t.click(); });
  await page.waitForSelector(".zone-page .tabpane:not(.hidden) table tbody tr", { timeout: T }).catch(() => {});
  const headers = await page.$$eval(".zone-page .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const rows = await page.$$eval(".zone-page .tabpane:not(.hidden) table tbody tr", (r) => r.length);
  const goldRoute = (await page.$$eval("#zonemap .wm-panel .wm-row .wm-row-main", (e) => e.map((x) => x.textContent))).some((o) => /Gold route/.test(o));
  console.log(`zone-farm ${areaid}: rows=${rows} headers=[${headers.join(",")}] goldRoute=${goldRoute}`);
  return rows > 5 && headers.includes("Total value") && goldRoute;
}

// Zone map gather nodes get GRANULAR per-node toggles (like the world map): a
// "Mining Veins" / "Herbs" group with one row per ore/herb, not a single coarse
// "Mining"/"Herbalism" bucket. Barrens (17) has Copper/Tin veins + several herbs.
async function testZoneGatherGranular(areaid) {
  await nav(`?zone=${areaid}`);
  await page.waitForSelector("#zonemap .wm-panel .wm-row", { timeout: T });
  const groups = await page.$$eval("#zonemap .wm-panel .wm-group", (gs) => gs.map((g) => ({
    title: g.querySelector(".wm-group-title")?.textContent || "",
    rows: [...g.querySelectorAll(".wm-row .wm-row-main")].map((r) => r.textContent.trim()),
  })));
  const mining = groups.find((g) => /Mining Veins/.test(g.title));
  const herbs = groups.find((g) => /Herbs/.test(g.title));
  const mN = mining ? mining.rows.length : 0, hN = herbs ? herbs.rows.length : 0;
  console.log(`zone-gather ${areaid}: mining=${mN}[${(mining?.rows || []).slice(0, 3).join(", ")}] herbs=${hN}[${(herbs?.rows || []).slice(0, 3).join(", ")}]`);
  return mN > 0 || hN > 0;
}

// "Show on map" (a tab mapchk checkbox) plots the spawns AND injects a toggle row
// into the panel's "Selected" group; unchecking that panel row removes the markers
// and re-unticks the tab checkbox (two-way sync). Elwynn (12) has NPC rows.
async function testZoneSelectedLayer(areaid) {
  await nav(`?zone=${areaid}`);
  await page.waitForSelector('.zone-page [data-pane="npcs"] input[data-mapnpc]', { timeout: T });
  await page.click('.zone-page [data-pane="npcs"] input[data-mapnpc]');
  const selGroup = () => page.$$eval("#zonemap .wm-panel .wm-group", (gs) => {
    const g = gs.find((x) => /Selected/.test(x.querySelector(".wm-group-title")?.textContent || ""));
    return g ? g.querySelectorAll(".wm-row").length : 0;
  });
  await page.waitForFunction(() => [...document.querySelectorAll("#zonemap .wm-panel .wm-group-title")].some((t) => /Selected/.test(t.textContent)), { timeout: 5000 }).catch(() => {});
  const selRows = await selGroup();
  // uncheck via the panel row -> markers + row gone, and the tab checkbox unticks
  await page.evaluate(() => {
    const g = [...document.querySelectorAll("#zonemap .wm-panel .wm-group")].find((x) => /Selected/.test(x.querySelector(".wm-group-title")?.textContent || ""));
    g?.querySelector(".wm-row input[type=checkbox]")?.click();
  });
  const afterRows = await selGroup();
  const tabChecked = await page.$eval('.zone-page [data-pane="npcs"] input[data-mapnpc]', (e) => e.checked).catch(() => true);
  console.log(`zone-selected ${areaid}: selRows=${selRows} afterRows=${afterRows} tabChecked=${tabChecked}`);
  return selRows > 0 && afterRows === 0 && tabChecked === false;
}

// A multi-floor instance shows a floor switcher; the active floor renders a map,
// and switching floors re-renders. Black Morass (?zone=5204) has 2 floors.
async function testZoneFloors(areaid, minFloors) {
  await nav(`?zone=${areaid}`);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T });
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
  await nav(`?zone=${id}`);
  await page.waitForSelector(".zone-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".zone-page .tab")].find((t) => t.textContent.trim().startsWith("Quests")); if (b) b.click(); });
  await page.waitForSelector(".zone-page .tabpane:not(.hidden) table tbody tr", { timeout: T });
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
  await nav(`?zone=${id}`);
  await page.waitForSelector(".zone-page .npc-head h1", { timeout: T });
  const name = await page.$eval(".zone-page .npc-head h1", (e) => e.textContent);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T });
  const hasNote = (await page.$(".zone-page .zone-empty")) !== null;
  const hasTabs = (await page.$(".zone-page .tabbar")) !== null;
  console.log(`empty zone ${id}: name="${name}" mapImg=yes note=${hasNote} tabs=${hasTabs}`);
  return name.includes(expectName) && hasNote && !hasTabs;
}

// Flight-path world map: faction-coloured nodes on a continent parchment, with a
// continent switcher that swaps the map.
async function testFlights() {
  await nav(`?flights`);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T });
  await new Promise((r) => setTimeout(r, 500));
  const nodes = await page.$$eval(".flight-node", (e) => e.length);
  const conts = await page.$$eval("#contswitch button", (b) => b.length).catch(() => 0);
  const src1 = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src"));
  await page.evaluate(() => { const b = [...document.querySelectorAll("#contswitch button")].find((x) => !x.classList.contains("active")); if (b) b.click(); });
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T });
  await new Promise((r) => setTimeout(r, 500));
  const src2 = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src"));
  console.log(`flights: nodes=${nodes} continents=${conts} src1=${src1} src2=${src2} switched=${src1 !== src2}`);
  return nodes > 20 && conts === 2 && src1 !== src2;
}

// Seamless world map: a Leaflet tile pyramid (not a single parchment) over the
// continent, with spawn-category layers in the layer control and a continent
// switcher that swaps the tile source (…/minimap/0/… -> …/minimap/1/…).
async function testWorldMap() {
  await page.setViewport({ width: 1280, height: 900 });
  await nav(`?worldmap`);
  await page.waitForSelector("#zonemap img.leaflet-tile-loaded", { timeout: T });
  await new Promise((r) => setTimeout(r, 500));
  const tiles = await page.$$eval("#zonemap img.leaflet-tile-loaded", (e) => e.length);
  const src1 = await page.$eval("#zonemap img.leaflet-tile", (e) => e.getAttribute("src")).catch(() => "");
  const conts = await page.$$eval("#contswitch button", (b) => b.length).catch(() => 0);
  // docked layer panel (open by default) lists spawn categories, each with a count
  const cats = await page.$$eval("#zonemap .wm-panel .wm-row .wm-row-n", (ns) => ns.filter((n) => /\d/.test(n.textContent)).length).catch(() => 0);
  // global search filters the category rows (and hides emptied groups)
  const search = await page.evaluate(() => {
    const i = document.querySelector("#zonemap .wm-search");
    const vis = () => [...document.querySelectorAll("#zonemap .wm-panel .wm-row")].filter((r) => r.style.display !== "none").length;
    i.value = "ven"; i.dispatchEvent(new Event("input", { bubbles: true }));
    const filtered = vis();
    i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true }));
    return { filtered, all: vis() };
  }).catch(() => ({ filtered: 0, all: 0 }));
  const searchOk = search.filtered >= 1 && search.filtered < search.all;
  // clicking a group header collapses/expands it (real DOM click, exercises the handler)
  const collapseOk = await (async () => {
    const head = await page.$("#zonemap .wm-panel .wm-group-head");
    if (!head) return false;
    const before = await page.$eval("#zonemap .wm-panel .wm-group", (g) => g.classList.contains("collapsed"));
    await head.click();
    const after = await page.$eval("#zonemap .wm-panel .wm-group", (g) => g.classList.contains("collapsed"));
    return before !== after;
  })().catch(() => false);
  // switch continents -> tiles re-request from the other map's pyramid path
  await page.evaluate(() => { const b = [...document.querySelectorAll("#contswitch button")].find((x) => !x.classList.contains("active")); if (b) b.click(); });
  await page.waitForSelector("#zonemap img.leaflet-tile-loaded", { timeout: T });
  await new Promise((r) => setTimeout(r, 500));
  const src2 = await page.$eval("#zonemap img.leaflet-tile", (e) => e.getAttribute("src")).catch(() => "");
  const m1 = /minimap\/(\d+)\//.exec(src1)?.[1], m2 = /minimap\/(\d+)\//.exec(src2)?.[1];
  console.log(`worldmap: tiles=${tiles} conts=${conts} cats=${cats} search=${search.filtered}/${search.all} collapse=${collapseOk} map1=${m1} map2=${m2} switched=${m1 !== m2}`);
  return tiles > 0 && conts === 2 && cats > 0 && searchOk && collapseOk && m1 != null && m2 != null && m1 !== m2;
}

// World-map usability: layer/zone/name state round-trips through the URL (so Back
// restores it), the zone-focus dropdown + npc name filter exist, and ?cats=mob
// restores that layer checked.
async function testWorldMapState() {
  await page.setViewport({ width: 1280, height: 900 });
  const qp = async (k) => new URLSearchParams(new URL(await page.url()).search).get(k);
  await nav(`?worldmap=0&cats=mob`);
  await page.waitForSelector("#zonemap img.leaflet-tile-loaded", { timeout: T });
  await page.waitForSelector("#zonemap .wm-filter .wm-zone", { timeout: 20000 });
  const zoneOpts = await page.$$eval("#zonemap .wm-filter .wm-zone option", (o) => o.length);
  const hasNameInput = (await page.$("#zonemap .wm-filter .wm-name")) !== null;
  const rowByText = (re) => `[...document.querySelectorAll("#zonemap .wm-panel .wm-row")].find((x) => ${re}.test(x.querySelector(".wm-row-main").textContent))`;
  const mobChecked = await page.evaluate(`!!(${rowByText("/Enemy Mobs/")})?.querySelector("input")?.checked`);
  // toggle Vendors on -> cats in URL gains it
  await page.evaluate(`(${rowByText("/Vendors/")})?.querySelector("input")?.click()`);
  await new Promise((r) => setTimeout(r, 350));
  const catsUrl = (await qp("cats")) || "";
  // focus a zone -> URL gains focus=<areaid>
  await page.evaluate(() => { const s = document.querySelector("#zonemap .wm-zone"); s.value = [...s.options].find((o) => o.value)?.value; s.dispatchEvent(new Event("change", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 350));
  const focusUrl = await qp("focus");
  // name filter -> URL gains q=
  await page.evaluate(() => { const i = document.querySelector("#zonemap .wm-name"); i.value = "wolf"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 400));
  const qUrl = await qp("q");
  console.log(`worldmap-state: zoneOpts=${zoneOpts} nameInput=${hasNameInput} mobChecked=${mobChecked} cats="${catsUrl}" focus=${focusUrl} q=${qUrl}`);
  return zoneOpts > 1 && hasNameInput && mobChecked && /(^|,)mob(,|$)/.test(catsUrl) && /vendor/.test(catsUrl) && focusUrl != null && qUrl === "wolf";
}

smoke("zone 12 Elwynn", () => testZone(12, "Elwynn"));
smoke("zone 5561 Balor", () => testZone(5561, "Balor"));
smoke("zone object-link 400", () => testZoneObjectLink(400));
smoke("zone dot-menu 12", () => testZoneDotMenu(12));
smoke("farm-route 17 copper", () => testFarmRoute(17, 2770));
smoke("zone farm 17", () => testZoneFarm(17));
smoke("zone gather-granular 17", () => testZoneGatherGranular(17));
smoke("zone selected-layer 12", () => testZoneSelectedLayer(12));
smoke("zone quests 331", () => testZoneQuests(331, 20));
smoke("zone floors 5204", () => testZoneFloors(5204, 2));
smoke("empty-zone 5722 Thorn Gorge", () => testEmptyZone(5722, "Thorn Gorge"));
smoke("flights", () => testFlights());
smoke("worldmap", () => testWorldMap());
smoke("worldmap state", () => testWorldMapState());
smoke("browse zones", () => testBrowse("zones", "", "Continent"));
smoke("browse zones cont=0", () => testBrowse("zones", "&cont=0", "Zone"));
