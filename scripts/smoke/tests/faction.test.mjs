import { page, nav, T, smoke } from "../harness.mjs";
import { testBrowse } from "./_shared.mjs";

// faction detail: header + tabs, items grouped by standing, sortable pane.
async function testFaction(id, expectName) {
  await nav(`?faction=${id}`);
  await page.waitForSelector(".npc-page .npc-head h1", { timeout: T });
  const name = await page.$eval(".npc-page .npc-head h1", (e) => e.textContent);
  const tabList = await page.$$eval(".npc-page .tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  const groupRows = await page.$$eval(".npc-page .tabpane:not(.hidden) .grouprow", (e) => e.length);
  const sortableH = await page.$$eval(".npc-page .tabpane:not(.hidden) th.sortable", (e) => e.length);
  console.log(`faction ${id}: name="${name}" tabs=[${tabList.join(", ")}] groupRows=${groupRows} sortableHdrs=${sortableH}`);
  return name.includes(expectName) && tabList.length > 0 && groupRows > 0 && sortableH > 0;
}

// Faction rep calculator: the panel (tier table + notes) + a "Rep from kills" tab
// listing mobs with rep/kill and kills-to-Exalted. Argent Dawn (529) has both.
async function testFactionRepCalc(id) {
  await nav(`?faction=${id}`);
  await page.waitForSelector(".npc-page .rep-calc", { timeout: T });
  const notes = await page.$$eval(".rep-calc .rep-notes li", (e) => e.length);
  const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("Rep from kills")); if (b) { b.click(); return true; } return false; });
  await page.waitForSelector(".tabpane:not(.hidden) table tbody tr", { timeout: T });
  const headers = await page.$$eval(".tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const rows = await page.$$eval(".tabpane:not(.hidden) tbody tr", (e) => e.length);
  const strat = await page.$eval(".rep-calc .rep-notes", (e) => e.textContent);
  console.log(`faction-repcalc ${id}: notes=${notes} killsTab=${clicked} rows=${rows} grindFirst=${/Grind first/.test(strat)}`);
  return notes > 0 && /Grind first/.test(strat) && clicked && rows > 0 && headers.includes("Rep / kill");
}

// A faction page lists its member NPCs (name / level / location).
async function testFactionMembers(id, minMembers) {
  await nav(`?faction=${id}`);
  await page.waitForSelector(".npc-page .tab", { timeout: T });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".npc-page .tab")].find((t) => t.textContent.trim().startsWith("Members")); if (b) b.click(); });
  await page.waitForSelector(".npc-page .tabpane:not(.hidden) table tbody tr", { timeout: T });
  const rows = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr", (r) => r.length);
  const headers = await page.$$eval(".npc-page .tabpane:not(.hidden) th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const locs = await page.$$eval(".npc-page .tabpane:not(.hidden) tbody tr td:last-child", (t) => t.map((x) => x.textContent.trim()).filter(Boolean));
  const npcLink = (await page.$(".npc-page .tabpane:not(.hidden) a.ilink[href*='npc=']")) !== null;
  console.log(`faction-members ${id}: rows=${rows} headers=[${headers.join(",")}] locs=${locs.length} npcLink=${npcLink}`);
  return rows >= minMembers && headers.includes("Location") && headers.includes("Title") && npcLink && locs.length > 0;
}

smoke("faction 509 League of Arathor", () => testFaction(509, "League of Arathor"));
smoke("faction rep-calc 529 Argent Dawn", () => testFactionRepCalc(529));
smoke("faction members 69 Darnassus", () => testFactionMembers(69, 20));
smoke("browse factions", () => testBrowse("factions", "", "Items"));
