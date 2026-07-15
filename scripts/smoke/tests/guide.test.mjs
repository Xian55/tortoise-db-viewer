import { page, nav, T, smoke } from "../harness.mjs";

// ---- leveling guides (?guides index + ?guide=<id> auto-generated step guide) ----
async function testLevelingIndex() {
  await nav(`?guides`);
  await page.waitForSelector(".guide-index .guide-card", { timeout: T });
  const cards = await page.$$eval(".guide-index .guide-card", (e) => e.map((c) => c.getAttribute("href")));
  console.log(`leveling-index: cards=${cards.length} links=${JSON.stringify(cards)}`);
  return cards.length >= 2 && cards.every((h) => /guide=/.test(h));
}

// One guide: quests batched into hub STAGES (Pick up / Complete / Turn in), a TSP hub
// route on the map, and per-stage focus spotlighting the objective targets.
async function testLevelingGuide(id, minQuests) {
  await nav(`?guide=${id}`);
  await page.waitForSelector(".guide-page .guide-stage", { timeout: 45000 });
  const stages = await page.$$eval(".guide-page .guide-stage", (e) => e.length);
  const quests = await page.$$eval(".guide-page .guide-check", (e) => e.length); // one turn-in checkbox per quest
  const hasQuestLink = (await page.$(".guide-page .guide-stage a.ilink.quest")) !== null;
  const hasGiver = (await page.$(".guide-page .guide-stage a.ilink[href*='npc='], .guide-page .guide-stage a.ilink[href*='object=']")) !== null;
  await page.waitForSelector(".guide-page #zonemap .leaflet-image-layer", { timeout: 45000 });
  await page.waitForSelector(".guide-page #zonemap .route-stop", { timeout: 20000 }).catch(() => {});
  const stops = await page.$$eval(".guide-page #zonemap .route-stop", (e) => e.length).catch(() => 0);
  // click a stage -> focus mode (spotlight its markers; "full route" reset appears)
  await page.evaluate(() => { document.querySelector(".guide-stage[data-hub]").click(); });
  await page.waitForSelector(".guide-stage.focused", { timeout: 10000 }).catch(() => {});
  const focused = (await page.$(".guide-stage.focused")) !== null;
  const resetShown = await page.$eval(".guide-map-reset", (e) => !e.hidden).catch(() => false);
  console.log(`guide ${id}: stages=${stages} quests=${quests} questLink=${hasQuestLink} giver=${hasGiver} routeStops=${stops} focus=${focused} reset=${resetShown}`);
  return stages >= 2 && quests >= minQuests && hasQuestLink && hasGiver && stops >= 1 && focused && resetShown;
}

// Ticking a turn-in persists to localStorage + survives a reload.
async function testGuideProgress(id) {
  await nav(`?guide=${id}`);
  await page.waitForSelector(".guide-page .guide-check", { timeout: 45000 });
  await page.evaluate(() => { const cb = document.querySelector(".guide-check"); cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); });
  const stored = await page.evaluate((gid) => localStorage.getItem(`twdb:guide:${gid}`), id);
  const label = await page.$eval(".guide-progress-label", (e) => e.textContent);
  await page.reload();
  await page.waitForSelector(".guide-page .guide-qlist li.done", { timeout: 45000 });
  const persisted = (await page.$(".guide-page .guide-qlist li.done")) !== null;
  console.log(`guide-progress ${id}: stored=${stored} label="${label}" persisted=${persisted}`);
  return !!stored && /^1 \/ /.test(label) && persisted;
}

smoke("leveling index", () => testLevelingIndex());
smoke("leveling guide high-elf", () => testLevelingGuide("high-elf", 20));
smoke("leveling guide goblin", () => testLevelingGuide("goblin", 20));
smoke("guide progress goblin", () => testGuideProgress("goblin"));
