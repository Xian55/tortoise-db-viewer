import { page, nav, T, smoke } from "../harness.mjs";

// ---- Hunter Pets index (?pets): sortable family comparison + every ability inline ----
async function testPetsIndex() {
  await nav(`?pets`);
  await page.waitForSelector("#pet-fam-compare tbody tr", { timeout: T });
  const famRows = await page.$$eval("#pet-fam-compare tbody tr", (e) => e.length);
  const famLinks = await page.$$eval("#pet-fam-compare a.ilink.npc[href*='petfamily=']", (e) => e.length);
  const statBars = await page.$$eval("#pet-fam-compare .pet-statcell-fill", (e) => e.length); // H/A/D bars
  const twBadges = await page.$$eval("#pet-fam-compare .tw-tag", (e) => e.length); // Serpent/Fox/Moth
  const dietLink = (await page.$("#pet-fam-compare a.pet-diet-pill[href*='food=']")) !== null;
  await page.waitForSelector(".pet-ability-blocks .pet-ability-block", { timeout: T });
  const blocks = await page.$$eval(".pet-ability-block", (e) => e.length);
  const toc = await page.$$eval(".pet-toc .pet-toc-link", (e) => e.length);
  const tames = await page.$$eval(".pet-ability-block .pet-tame-list li", (e) => e.length);
  const hasNpc = (await page.$(".pet-ability-block .pet-tame-list a.ilink.npc[href*='npc=']")) !== null;
  console.log(`pets-index: famRows=${famRows} famLinks=${famLinks} statBars=${statBars} tw=${twBadges} dietLink=${dietLink} blocks=${blocks} toc=${toc} tames=${tames} npc=${hasNpc}`);
  return famRows >= 17 && famLinks >= 17 && statBars >= 10 && twBadges >= 1 && dietLink
    && blocks >= 15 && toc >= 15 && tames >= 50 && hasNpc;
}

// ---- one family (?petfamily=<id>): diet, abilities, where-to-tame list ----
async function testPetFamily(id, name, minNpcs) {
  await nav(`?petfamily=${id}`);
  await page.waitForSelector(".pet-family h1", { timeout: T });
  const title = await page.$eval(".pet-family h1", (e) => e.textContent.trim());
  const diet = await page.$$eval(".pet-fam-header .pet-diet-pill", (e) => e.length);
  const active = await page.$$eval(".pet-abil-group .pet-abil-rows .pet-abil-row", (e) => e.length);
  const hasSpellLink = (await page.$(".pet-abil-rows a.ilink[href*='petability=']")) !== null;
  const hasRankChip = (await page.$(".pet-abil-ranks a.pet-rank[href*='spell=']")) !== null;
  await page.waitForSelector("#pet-npc-table tbody tr", { timeout: T });
  const npcs = await page.$$eval("#pet-npc-table tbody tr", (e) => e.length);
  const hasNpcLink = (await page.$("#pet-npc-table a.ilink.npc[href*='npc=']")) !== null;
  console.log(`petfamily ${id}: title="${title}" diet=${diet} abils=${active} spellLink=${hasSpellLink} rankChip=${hasRankChip} npcs=${npcs} npcLink=${hasNpcLink}`);
  return title.startsWith(name) && diet >= 1 && active >= 5 && hasSpellLink && hasRankChip && npcs >= minNpcs && hasNpcLink;
}

// ---- NPC page: tameable beast shows badge + Pet Abilities tab w/ the rank a tame grants ----
async function testNpcTameable(id, familyId) {
  await nav(`?npc=${id}`);
  await page.waitForSelector(".npc-page .npc-tame", { timeout: T });
  const badgeLink = (await page.$(`.npc-tame a[href*='petfamily=${familyId}']`)) !== null;
  const tabs = await page.$$eval(".npc-page .tabbar .tab", (e) => e.map((t) => t.textContent.trim()));
  const petTab = tabs.some((t) => /Pet Abilities/.test(t));
  const headers = await page.$$eval(".npc-page .tabpane[data-pane='petabilities'] th", (e) => e.map((t) => t.textContent.trim())).catch(() => []);
  const hasLearnCol = headers.some((h) => /Learn on tame/.test(h));
  const grantsRank = await page.$$eval(".npc-page .tabpane[data-pane='petabilities'] tbody tr", (rows) =>
    rows.some((r) => /Rank \d/.test(r.children[1]?.textContent || ""))).catch(() => false);
  console.log(`npc ${id}: familyLink=${badgeLink} petTab=${petTab} learnCol=${hasLearnCol} grantsRank=${grantsRank} tabs=${JSON.stringify(tabs)}`);
  return badgeLink && petTab && hasLearnCol && grantsRank;
}

// ---- pet-ability spell page (?spell=): "tame a beast to learn this" panel ----
async function testPetLearnSpell(spellId, minNpcs) {
  await nav(`?spell=${spellId}`);
  await page.waitForSelector(".spell-page .pet-learn", { timeout: T });
  const note = await page.$eval(".pet-learn .pet-note", (e) => e.textContent.replace(/\s+/g, " ").trim());
  await page.waitForSelector(".pet-learn #pet-learn-table tbody tr", { timeout: T });
  const npcs = await page.$$eval(".pet-learn #pet-learn-table tbody tr", (e) => e.length);
  const hasNpcLink = (await page.$(".pet-learn #pet-learn-table a.ilink.npc")) !== null;
  const petTag = (await page.$(".spell-sub a[href*='petability=']")) !== null;
  console.log(`pet-learn spell ${spellId}: note="${note.slice(0, 70)}" npcs=${npcs} npcLink=${hasNpcLink} petTag=${petTag}`);
  return npcs >= minNpcs && hasNpcLink && petTag;
}

// ---- one ability page (?petability=<key>): per-rank sections + who to tame ----
async function testPetAbility(key, name, minRanks) {
  await nav(`?petability=${key}`);
  await page.waitForSelector(".pet-ability .pet-rank-sec", { timeout: T });
  const title = await page.$eval(".pet-ability h1", (e) => e.textContent.trim());
  const secs = await page.$$eval(".pet-ability .pet-rank-sec", (e) => e.length);
  const tames = await page.$$eval(".pet-ability .pet-tame-list li", (e) => e.length);
  const hasNpc = (await page.$(".pet-tame-list a.ilink.npc[href*='npc=']")) !== null;
  const hasFam = (await page.$(".pet-learnedby a[href*='petfamily=']")) !== null;
  const rankDesc = (await page.$(".pet-rank-desc")) !== null;
  // hovering the gold rank title shows the spell hovercard
  await page.hover(".pet-ability .pet-rank-title.ilink");
  await page.waitForFunction(() => { const c = document.querySelector(".hovercard"); return c && c.style.display === "block" && c.textContent.trim(); }, { timeout: 5000 }).catch(() => {});
  const tip = await page.evaluate(() => { const c = document.querySelector(".hovercard"); return c && c.style.display === "block" ? c.textContent.trim().slice(0, 30) : ""; });
  console.log(`petability ${key}: title="${title}" ranks=${secs} tames=${tames} npc=${hasNpc} fam=${hasFam} desc=${rankDesc} tooltip="${tip}"`);
  return title === name && secs >= minRanks && tames >= 5 && hasNpc && hasFam && tip.length > 0;
}

// ---- diet pill links to the item browse filtered by food type ----
async function testDietLink() {
  await nav(`?petfamily=2`); // Cat: Meat, Fish
  await page.waitForSelector(".pet-fam-header a.pet-diet-pill[href*='food=']", { timeout: T });
  const href = await page.$eval(".pet-fam-header a.pet-diet-pill[href*='food=']", (e) => e.getAttribute("href"));
  await nav(`?browse=items&food=1`); // Meat foods
  await page.waitForSelector("#app table tbody tr", { timeout: T });
  const rows = await page.$$eval("#app table tbody tr", (e) => e.length);
  console.log(`diet-link: pillHref="${href}" meatBrowseRows=${rows}`);
  return /food=\d/.test(href) && rows >= 5;
}

smoke("pets index", () => testPetsIndex());
smoke("pet diet link -> food browse", () => testDietLink());
smoke("pet ability bite (petability)", () => testPetAbility("bite", "Bite", 6));
smoke("pet-learn spell bite r2 (17255)", () => testPetLearnSpell(17255, 3));
smoke("pet family raptor (11)", () => testPetFamily(11, "Raptor", 5));
smoke("pet family turtle (21)", () => testPetFamily(21, "Turtle", 3));
smoke("npc 856 tameable raptor", () => testNpcTameable(856, 11));
smoke("npc 61717 tameable fox rank", () => testNpcTameable(61717, 36));
