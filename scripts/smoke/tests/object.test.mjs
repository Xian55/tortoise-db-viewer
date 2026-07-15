import { page, nav, T, smoke } from "../harness.mjs";

// Objects browse: interactive gameobjects (harvest nodes/chests/quest objects),
// name-grouped, with a Spawns column and links to the object detail page.
async function testObjectsBrowse() {
  await nav(`?browse=objects`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const objLink = (await page.$('.browse a.ilink.object[href*="object="]')) !== null;
  // type=9 (readable plaques/monuments) must return rows -- the object page links
  // here via ?browse=objects&type=9, which was empty before they were browsable.
  await nav(`?browse=objects&type=9`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T }).catch(() => {});
  const type9Rows = await page.$$eval(".browse table tbody tr", (r) => r.length).catch(() => 0);
  console.log(`objects browse: ${rows} rows headers=[${headers.join(",")}] objLink=${objLink} type9Rows=${type9Rows}`);
  return rows > 0 && headers.includes("Spawns") && objLink && type9Rows > 0;
}

async function testObject(id, expectName, expectItem) {
  await nav(`?object=${id}`);
  await page.waitForSelector(".npc-head h1", { timeout: T });
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

// Object detail: aggregates same-name entries -> Contains tab links the looted item
// (Copper Vein -> Copper Ore); a multi-zone node gets a zone switcher that re-draws
// the map (one button per zone), like the dungeon floor switcher.
// ?object=ID&fz=<areaid> opens the object map on that zone (not the busiest) -- the
// zone Farming tab links here so a node opens in the zone you're farming.
async function testObjectFocusZone(id, areaid) {
  await nav(`?object=${id}&fz=${areaid}`);
  await page.waitForSelector("#zonemap .leaflet-image-layer", { timeout: T });
  await new Promise((r) => setTimeout(r, 300));
  const src = await page.$eval("#zonemap .leaflet-image-layer", (e) => e.getAttribute("src"));
  const active = await page.$eval("#objzoneswitch button.active", (e) => e.textContent.trim()).catch(() => "");
  console.log(`object-focus-zone ${id}&fz=${areaid}: map=${src} active="${active}"`);
  return src.includes(`/${areaid}.webp`);
}

// a type-9 plaque/statue reads its inscription from page_text via data0. Uther the
// Lightbringer's statue (#2082) shows the memorial text.
async function testReadableObject(id, expect) {
  await nav(`?object=${id}`);
  await page.waitForSelector(".npc-page .readable .readable-body", { timeout: T });
  const txt = await page.$eval(".npc-page .readable .readable-body", (e) => e.textContent);
  console.log(`readable-object ${id}: expect="${expect}" found=${txt.includes(expect)} len=${txt.length}`);
  return txt.includes(expect);
}

smoke("objects browse", () => testObjectsBrowse());
smoke("object 1731 Copper Vein", () => testObject(1731, "Copper Vein", "Copper Ore"));
smoke("object focus-zone 2852", () => testObjectFocusZone(2852, 10));
smoke("readable-object 2082 Uther", () => testReadableObject(2082, "Uther"));
