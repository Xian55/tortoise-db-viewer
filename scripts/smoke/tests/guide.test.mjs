import { page, nav, T, smoke } from "../harness.mjs";

// ---- leveling guides (?guides index + ?guide=<id> auto-generated step guide) ----
async function testLevelingIndex() {
  await nav(`?guides`);
  await page.waitForSelector(".guide-index .guide-level-cards .guide-card", { timeout: T });
  // zone leveling guides (scoped: the page also has chain-guide + profession-planner card grids)
  const cards = await page.$$eval(".guide-index .guide-level-cards .guide-card", (e) => e.map((c) => c.getAttribute("href")));
  const chainCards = await page.$$eval(".guide-index .guide-card[href*='?guide=']", (e) => e.length);
  const profCards = await page.$$eval(".guide-index .guide-card[href*='?profplan=']", (e) => e.length);
  console.log(`leveling-index: level=${cards.length} chain=${chainCards} prof=${profCards} links=${JSON.stringify(cards)}`);
  return cards.length >= 2 && cards.every((h) => /guide=/.test(h)) && chainCards >= 2 && profCards >= 2;
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

// ---- chain guides (attunements + Inferno): ordered tickable checklist ----
async function testChainGuide(id, minSteps, factions) {
  await nav(`?guide=${id}`);
  await page.waitForSelector(".chain-page .chain-step", { timeout: T });
  const steps = await page.$$eval(".chain-page .chain-step", (e) => e.length);
  const hasQuestLink = (await page.$(".chain-step .chain-step-h a.ilink.quest")) !== null;
  const terminal = (await page.$(".chain-step.chain-terminal .chain-badge")) !== null;
  const pills = await page.$$eval(".chain-factions button", (e) => e.length).catch(() => 0);
  // tick first step -> persists + progress label updates
  await page.evaluate(() => { const cb = document.querySelector(".chain-step .guide-check"); cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); });
  const label = await page.$eval(".guide-progress-label", (e) => e.textContent);
  const done = (await page.$(".chain-step.done")) !== null;
  console.log(`chain ${id}: steps=${steps} questLink=${hasQuestLink} terminal=${terminal} pills=${pills} label="${label}" done=${done}`);
  return steps >= minSteps && hasQuestLink && terminal && pills === factions && /^1 \/ /.test(label) && done;
}

// Faction toggle swaps the Alliance/Horde step list (different terminal quest).
async function testChainFactionSwitch() {
  await nav(`?guide=onyxia`);
  await page.waitForSelector(".chain-page .chain-step", { timeout: T });
  const before = await page.$$eval(".chain-step .guide-check", (e) => e.map((c) => c.dataset.q).join(","));
  await page.evaluate(() => { [...document.querySelectorAll(".chain-factions button")].find((b) => !b.classList.contains("active"))?.click(); });
  await page.waitForFunction((prev) => {
    const now = [...document.querySelectorAll(".chain-step .guide-check")].map((c) => c.dataset.q).join(",");
    return now && now !== prev;
  }, { timeout: T }, before).catch(() => {});
  const after = await page.$$eval(".chain-step .guide-check", (e) => e.map((c) => c.dataset.q).join(","));
  console.log(`chain onyxia switch: changed=${before !== after}`);
  return before !== after;
}

smoke("leveling index", () => testLevelingIndex());
smoke("leveling guide high-elf", () => testLevelingGuide("high-elf", 20));
smoke("leveling guide goblin", () => testLevelingGuide("goblin", 20));
smoke("guide progress goblin", () => testGuideProgress("goblin"));
// Per-step hand-authored notes (manifest `notes`) render under the step.
async function testChainNotes(id, minSteps) {
  await nav(`?guide=${id}`);
  await page.waitForSelector(".chain-page .chain-step", { timeout: T });
  const steps = await page.$$eval(".chain-page .chain-step", (e) => e.length);
  const notes = await page.$$eval(".chain-page .chain-step-note", (e) => e.length);
  console.log(`chain ${id}: steps=${steps} notes=${notes}`);
  return steps >= minSteps && notes >= 1;
}

// oneOf chain (Naxx rep tiers): banner shown, ticking two options still caps at 1 / 1.
async function testChainOneOf(id, options) {
  await nav(`?guide=${id}`);
  await page.waitForSelector(".chain-page .chain-oneof", { timeout: T });
  const steps = await page.$$eval(".chain-page .chain-step", (e) => e.length);
  await page.evaluate(() => {
    [...document.querySelectorAll(".chain-step .guide-check")].slice(0, 2)
      .forEach((cb) => { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); });
  });
  const label = await page.$eval(".guide-progress-label", (e) => e.textContent);
  console.log(`chain ${id} oneOf: steps=${steps} label="${label}"`);
  return steps === options && /^1 \/ 1 /.test(label);
}

smoke("chain guide inferno", () => testChainGuide("inferno", 10, 0));
smoke("chain guide onyxia", () => testChainGuide("onyxia", 14, 2));
smoke("chain guide onyxia faction switch", () => testChainFactionSwitch());
smoke("chain guide karazhan", () => testChainGuide("karazhan", 10, 2));
smoke("chain guide karazhan notes", () => testChainNotes("karazhan", 10));
smoke("chain guide emerald-sanctum", () => testChainGuide("emerald-sanctum", 6, 0));
smoke("chain guide naxxramas oneOf", () => testChainOneOf("naxxramas", 3));
