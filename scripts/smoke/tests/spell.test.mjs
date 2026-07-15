import { page, nav, T, smoke } from "../harness.mjs";
import { testBrowse, testShareButton } from "./_shared.mjs";

// spell detail: header name + relation tabs + sortable pane (+ Learned-from link
// when craft-taught -- the recipe item links back from the spell page).
async function testSpell(id, expectName) {
  await nav(`?spell=${id}`);
  await page.waitForSelector(".spell-page .spell-card", { timeout: T });
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
  await nav(`?spell=${id}`);
  await page.waitForSelector(".spell-page .spell-card", { timeout: T });
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
  await nav(`?spell=${id}`);
  await page.waitForSelector(".spell-page .kv-grid", { timeout: T });
  const keys = await page.$$eval(".spell-page .kv-grid .kv-k", (e) => e.length);
  const effects = await page.$$eval(".spell-page .spell-effect", (e) => e.length);
  const text = await page.$eval(".spell-page .spell-details", (e) => e.textContent.replace(/\s+/g, " "));
  const tabList = await page.$$eval(".spell-page .tab", (e) => e.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
  const learnable = await page.$$eval(".spell-page .spell-sub .tagx", (e) => e.length);
  const trained = tabList.some((t) => /^Trained by\b/.test(t));
  console.log(`spell detail ${id}: kvKeys=${keys} effects=${effects} learnable=${learnable} trainedTab=${trained} hasText(${expectText})=${text.includes(expectText)}`);
  return keys >= 6 && effects > 0 && text.includes(expectText) && learnable > 0 && trained;
}

// search includes spells: a craft term yields a Spells tab.
async function testSearchSpells(term) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(".results .tabbar .tab", { timeout: T });
  const tabs = await page.$$eval(".results .tabbar .tab", (e) => e.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const spellRows = await page.$$eval('.results [data-pane="spells"] tbody tr', (r) => r.length).catch(() => 0);
  const has = tabs.some((t) => /^Spells\b/.test(t));
  console.log(`search spells "${term}": tabs=[${tabs.join(", ")}] spellTab=${has} spellRows=${spellRows}`);
  return has && spellRows > 0;
}

// Rage costs are stored x10 internally; Heroic Strike (284) is 15 rage, not 150.
// Read the cost cell directly (.spell-card .tt-l) -- the page's full textContent
// runs "Rank 2" into "15 Rage" with no separator.
async function testRageCost(id) {
  await nav(`?spell=${id}`);
  await page.waitForSelector(".spell-page .spell-card", { timeout: T });
  const cost = await page.$eval(".spell-page .spell-card .tt-l", (e) => e.textContent.trim()).catch(() => "");
  console.log(`rage-cost ${id}: cost="${cost}"`);
  return cost === "15 Rage";
}

smoke("spell 41746 Shadowforged Eye", () => testSpell(41746, "Shadowforged Eye"));
smoke("spell detail 10 Blizzard", () => testSpellDetail(10, "Frost"));
smoke("spell rage-cost 284", () => testRageCost(284));
smoke("spell quest-reward 23161", () => testSpellQuestReward(23161));
smoke("share spell 41746", () => testShareButton("spell", 41746, "s"));
smoke("search spells Shadowforged", () => testSearchSpells("Shadowforged"));
smoke("browse spells", () => testBrowse("spells", "", "Profession"));
