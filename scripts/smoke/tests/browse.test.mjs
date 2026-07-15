import { page, nav, T, smoke } from "../harness.mjs";
import { testBrowse } from "./_shared.mjs";

const sc = (s) => `&stats=${encodeURIComponent(s)}`;

async function testBrowseSource(src) {
  await nav(`?browse=items&source=${src}`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const tags = await page.$$eval(".browse td.src-col .tagx", (e) => e.length);
  const checked = await page.$$eval(".multi [data-mv='source']:checked", (e) => e.map((c) => c.value));
  console.log(`browse source=${src}: rows=${rows} tags=${tags} headers=[${headers.join(",")}] checked=[${checked.join(",")}]`);
  return rows > 0 && headers.includes("Source") && tags > 0 && checked.includes(src);
}

// Quest-reward view (source=quest) adds a Faction column, and the Faction=Alliance
// filter returns only Alliance-locked rewards (incl. race-unrestricted items whose
// quest is Alliance-only -- the item's own allowable_race can't express that).
async function testQuestRewardFactionBrowse() {
  // faction=a shows items obtainable by Alliance (neutral + Alliance-exclusive),
  // never a Horde-exclusive tag; Faction column added via the chooser (cols=).
  await nav(`?browse=items&source=quest&faction=a&cols=faction`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const li = headers.indexOf("Faction");
  const facs = li < 0 ? [] : await page.$$eval(".browse table tbody tr",
    (rs, idx) => rs.map((r) => r.querySelectorAll("td")[idx]?.textContent.trim()).filter(Boolean), li);
  const noHorde = facs.every((f) => f !== "Horde");
  console.log(`browse quest-reward faction: rows=${rows} hasFactionCol=${li >= 0} tags=${facs.length} noHorde=${noHorde}`);
  return rows > 0 && li >= 0 && noHorde;
}

// Column chooser (cols=): user-toggled extra columns render + populate alongside
// the class defaults -- Faction (race/quest lock), a stat column (Stamina), and
// Quest Lvl (min level to take the reward quest). source=quest guarantees quest
// rewards so Quest Lvl is populated.
// Item filters (Iteration 3): active-filter chips render with quality color, and a
// chip removes its own filter from the URL.
async function testFilterChips() {
  await nav(`?browse=items&class=2&quality=4`);
  await page.waitForSelector(".active-chips .chip", { timeout: T });
  const chips = await page.$$eval(".active-chips .chip", (e) => e.map((c) => c.textContent.replace(/×/g, "").trim()));
  const epicColor = await page.$$eval(".active-chips .chip b", (bs) => { const b = bs.find((x) => /Epic/.test(x.textContent)); return b ? b.style.color : ""; });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".chip-x")].find((x) => x.dataset.rf === "quality"); if (b) b.click(); });
  await page.waitForFunction(() => !/quality=/.test(location.search), { timeout: T });
  const after = await page.evaluate(() => location.search);
  console.log(`filter-chips: chips=${JSON.stringify(chips)} epicColor="${epicColor}" after="${after}"`);
  return chips.length >= 2 && /163, ?53, ?238/.test(epicColor) && !/quality=/.test(after) && /class=2/.test(after);
}

async function testColumnChooser() {
  await nav(`?browse=items&source=quest&cols=faction,sta,questlvl`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const colVals = async (label) => {
    const idx = headers.indexOf(label);
    if (idx < 0) return [];
    return page.$$eval(".browse table tbody tr",
      (rs, i) => rs.map((r) => r.querySelectorAll("td")[i]?.textContent.trim()).filter(Boolean), idx);
  };
  const qlvl = await colVals("Quest Lvl");
  const summary = await page.$eval('[data-multi="cols"] .multi-btn', (el) => el.textContent.trim()).catch(() => "");
  const has = (h) => headers.includes(h);
  console.log(`column-chooser: headers=[${headers.join(",")}] questLvlVals=${qlvl.length} summary="${summary}"`);
  return has("Faction") && has("Stamina") && has("Quest Lvl") && qlvl.length > 0 && summary.startsWith("3");
}

// Spell browse: category + class filters (Class Skills / Mage). The Category
// column + the two selects reflect the URL filter.
async function testBrowseSpellCat() {
  await nav(`?browse=spells&cat=${encodeURIComponent("Class Skills")}&cls=64`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const cat = await page.$eval('select[data-f="cat"]', (el) => el.value);
  const cls = await page.$eval('select[data-f="cls"]', (el) => el.value);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const spellLink = (await page.$(".browse a.ilink[href*='spell=']")) !== null;
  console.log(`browse-spellcat: rows=${rows} cat="${cat}" cls=${cls} headers=[${headers.join(",")}] spellLink=${spellLink}`);
  return rows > 0 && cat === "Class Skills" && cls === "64" && spellLink
    && headers.includes("Level") && !headers.includes("Profession");  // class view swaps Profession -> Level
}

// Item/NPC browse Origin filter (Turtle additions vs vanilla range). origin=tw ->
// rows exist, all TW-tagged; origin=vanilla -> rows exist, none TW-tagged on the page.
async function testOriginFilter(noun) {
  await nav(`?browse=${noun}&origin=tw`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const twRows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const sel = await page.$eval('[data-f="origin"]', (el) => el.value).catch(() => "?");
  const twTags = await page.$$eval(".browse td .tagx.tw-tag", (e) => e.length);
  await nav(`?browse=${noun}&origin=vanilla`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const vanRows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const vanTags = await page.$$eval(".browse td .tagx.tw-tag", (e) => e.length);
  console.log(`origin ${noun}: tw(rows=${twRows} sel=${sel} tags=${twTags}) vanilla(rows=${vanRows} tags=${vanTags})`);
  return twRows > 0 && sel === "tw" && twTags > 0 && vanRows > 0 && vanTags === 0;
}

// new select filters: confirm the param yields rows and the select reflects it.
async function testFilter(param, value) {
  await nav(`?browse=items&${param}=${value}`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const sel = await page.$eval(`.filters [data-f='${param}']`, (e) => e.value).catch(() => "?");
  console.log(`filter ${param}=${value}: rows=${rows} selected=${sel}`);
  return rows > 0 && sel === value;
}

// unobtainable (dev-artifact) items are hidden by default but shown when opted in;
// item 5031 ("ZZZZZZZZ") is a known dev artifact.
async function testUnobtainable() {
  const has = async (src) => {
    await nav(`?browse=items&source=${src}&q=ZZZZZZZZ`);
    await page.waitForSelector(".browse", { timeout: T });
    return page.$$eval(".browse table tbody tr", (r) => r.length).catch(() => 0);
  };
  // default (no source filter): the junk item must be hidden
  await nav(`?browse=items&q=ZZZZZZZZ`);
  await page.waitForSelector(".browse", { timeout: T });
  const hiddenByDefault = await page.$$eval(".browse table tbody tr", (r) => r.length).catch(() => 0);
  const shownWhenOptedIn = await has("unobtainable");
  console.log(`unobtainable: defaultRows=${hiddenByDefault} (want 0) optedInRows=${shownWhenOptedIn} (want >0)`);
  return hiddenByDefault === 0 && shownWhenOptedIn > 0;
}

// row selection: ID column gone, ops disabled until a row is picked, prefix copy.
async function testSelection() {
  await nav(`?browse=items`);
  await page.waitForSelector(".browse tbody tr [data-selrow]", { timeout: T });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const noId = !headers.includes("ID");
  const disabled0 = await page.$eval('.selbar [data-op="ids"]', (b) => b.disabled);
  const firstId = await page.$eval(".browse tbody tr [data-selrow]", (el) => el.getAttribute("data-selrow"));
  await page.click(".browse tbody tr [data-selrow]");
  const count1 = await page.$eval("[data-selcount]", (e) => e.textContent);
  const enabled = await page.$eval('.selbar [data-op="ids"]', (b) => !b.disabled);
  await page.click('.selbar [data-op="prefix"]');
  const copied = await page.evaluate(() => window.__copied);
  const okPrefix = copied === `.additem ${firstId}`;
  console.log(`selection: noId=${noId} disabled0=${disabled0} count="${count1}" enabled=${enabled} copied="${copied}"`);
  return noId && disabled0 && enabled && count1 === "1 selected" && okPrefix;
}

// group selection: grouping by Slot, ticking a group header selects all its rows.
async function testGroupSelection() {
  await nav(`?browse=items&class=4`);
  await page.waitForSelector(".browse [data-groupby]", { timeout: T });
  const val = await page.$$eval(".browse [data-groupby] option", (opts) => {
    const o = opts.find((x) => x.textContent.trim() === "Slot"); return o ? o.value : "";
  });
  await page.select(".browse [data-groupby]", val);
  await page.waitForSelector(".browse [data-selgroup]", { timeout: T });
  await page.click(".browse [data-selgroup]");
  const count = await page.$eval("[data-selcount]", (e) => e.textContent);
  const n = parseInt(count, 10) || 0;
  console.log(`group selection: "${count}"`);
  return n > 1;
}

async function testBrowsePersist() {
  await nav(`?browse=items&class=4&sort=ilvl&dir=d&groupby=slot`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const active = await page.$eval(".browse th.active", (e) => e.textContent.trim()).catch(() => "(none)");
  const groups = await page.$$eval(".browse .grouprow", (e) => e.length);
  const groupSel = await page.$eval(".browse [data-groupby]", (e) => e.value).catch(() => "?");
  console.log(`browse persist: active="${active}" groupRows=${groups} groupSel=${groupSel}`);
  return active.includes("iLvl") && groups > 0;
}

async function testBrowseMulti() {
  await nav(`?browse=items&quality=3,4&slot=1,5`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const checked = await page.$$eval(".multi [data-mv]:checked", (e) => e.map((c) => `${c.dataset.mv}:${c.value}`));
  console.log(`browse multi: rows=${rows} checked=[${checked.join(",")}]`);
  return rows > 0 && ["quality:3", "quality:4", "slot:1", "slot:5"].every((k) => checked.includes(k));
}

async function testBrowseCriteria() {
  const q = encodeURIComponent("agi,>=,10|sta,>=,10"); // multi-criteria, AND-combined
  await nav(`?browse=items&stats=${q}`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const critRows = await page.$$eval(".crit-row", (e) => e.length);
  const cstats = await page.$$eval(".crit-row [data-cstat]", (e) => e.map((s) => s.value));
  console.log(`browse criteria: rows=${rows} headers=[${headers.join(",")}] critRows=${critRows} cstats=[${cstats.join(",")}]`);
  return rows > 0 && headers.includes("Agility") && headers.includes("Stamina")
    && critRows === 2 && cstats.includes("agi") && cstats.includes("sta");
}

// Reagents all have required_level 0, so the Req column (hideEmpty) drops out.
async function testReagentNoReq() {
  await nav(`?browse=items&class=5`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  console.log(`reagent-cols: headers=[${headers.join(",")}]`);
  return headers.length > 0 && !headers.includes("Req");
}

// The Subtype filter is multi-select and reflects a multi-subclass URL, so the
// nav "One-Handed" state (class=2&subclass=0,4,7,13,15) is reproducible.
async function testSubclassMulti() {
  await nav(`?browse=items&class=2&subclass=0,4,7,13,15`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const checked = await page.$$eval('[data-multi="subclass"] [data-mv]:checked', (e) => e.map((c) => c.value).sort());
  console.log(`subclass-multi: checked=[${checked.join(",")}]`);
  return checked.length === 5 && ["0", "4", "7", "13", "15"].every((v) => checked.includes(v));
}

// Fishing poles (class=2 subclass=20) swap the weapon DPS/Speed columns for a
// "+N Fishing" column; Big Iron Fishing Pole (6367) carries +20.
async function testFishingPoleCols() {
  await nav(`?browse=items&class=2&subclass=20`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const bigIron = await page.$$eval(".browse table tbody tr", (rows) => {
    const tr = rows.find((r) => /Big Iron Fishing Pole/.test(r.textContent));
    return tr ? tr.textContent : "";
  });
  console.log(`fishing-pole-cols: headers=[${headers.join(",")}] bigIron="${bigIron.replace(/\s+/g, " ").trim()}"`);
  return headers.includes("Fishing") && !headers.includes("DPS") && !headers.includes("Speed")
    && /\+20/.test(bigIron);
}

// Top-bar mega-menu: nested flyouts render; a deep weapon leaf links to the
// class+subclass browse, and the One-Handed group carries the multi-subclass link.
async function testMegaMenu() {
  await nav(`?`);
  await page.waitForSelector(".menubar .submenu", { timeout: T });
  const subs = await page.$$eval(".menubar .submenu", (e) => e.length);
  const weaponLeaf = (await page.$('.menubar a.nav[href*="class=2&subclass=0"]')) !== null;
  const oneHanded = (await page.$('.menubar a.nav[href*="class=2&subclass=0,4,7,13,15"]')) !== null;
  const spellPreset = (await page.$('.menubar a.nav[href*="browse=spells&cls="]')) !== null;
  console.log(`mega-menu: submenus=${subs} weaponLeaf=${weaponLeaf} oneHandedGroup=${oneHanded} spellPreset=${spellPreset}`);
  return subs > 5 && weaponLeaf && oneHanded && spellPreset;
}

// crafting browse: filtered to one profession, grouped, with skill-up brackets
// (orange #ff8040 span) and a Source column (recipe link / Trainer badge).
async function testCrafting() {
  // prof-filtered view: the redundant Profession column is hidden; skill-up
  // brackets render. (Grouping by the single profession is moot, so it ungroups.)
  await nav(`?browse=crafting&prof=171`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const profSel = await page.$eval(".filters [data-f='prof']", (e) => e.value).catch(() => "?");
  const brackets = await page.$$eval(".browse tbody td span[style*='ff8040']", (e) => e.length);
  // grouping still works (group by source TYPE, header = Recipe/Trainer/Auto)
  await nav(`?browse=crafting&prof=171&groupby=source`);
  await page.waitForSelector(".browse .grouprow", { timeout: T });
  const groupHeads = await page.$$eval(".browse .grouprow", (e) => e.map((g) => g.textContent.replace(/[▸▾\s]+/g, " ").trim()));
  const typeGroups = groupHeads.every((g) => /Recipe|Trainer|Auto|Other/.test(g));
  console.log(`crafting prof=171: rows=${rows} headers=[${headers.join(",")}] profSel=${profSel} brackets=${brackets} groups=[${groupHeads.join(",")}]`);
  return rows > 0 && headers.includes("Skill") && headers.includes("Source") && !headers.includes("Profession") && profSel === "171" && brackets > 0 && groupHeads.length > 0 && typeGroups;
}

// enchanting crafts produce no item (they apply an enchant), so the Name column
// links the craft spell itself; assert these item-less rows render and resolve a
// recipe Source (regression: the whole profession was missing from Crafting).
async function testCraftEnchanting() {
  await nav(`?browse=crafting&prof=333`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  // Name column links a craft spell (?spell=) for the item-less enchant rows
  const spellLinks = await page.$$eval('.browse tbody td a.ilink.spell[href*="spell="]', (a) => a.length);
  console.log(`crafting prof=333 (enchanting): rows=${rows} spellLinks=${spellLinks}`);
  return rows > 30 && spellLinks > 0;
}

// gathering professions (Fishing/Herbalism/Skinning) craft no item, so the recipe
// query is empty -- the Crafting browse instead lists their learnable abilities +
// the trainers (with faction badges) that teach them. Regression: these three
// professions rendered a blank page.
async function testGatheringProf() {
  await nav(`?browse=crafting&prof=182`); // Herbalism
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const rows = await page.$$eval(".browse table tbody tr", (r) => r.length);
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const spellLinks = await page.$$eval('.browse tbody a.ilink.spell[href*="spell="]', (a) => a.length);
  const npcLinks = await page.$$eval('.browse tbody a.ilink.npc[href*="npc="]', (a) => a.length);
  const badges = await page.$$eval(".browse tbody .tbadge", (e) => e.length);
  console.log(`gathering prof=182: rows=${rows} headers=[${headers.join(",")}] spellLinks=${spellLinks} npcLinks=${npcLinks} badges=${badges}`);
  return rows > 0 && headers.includes("Ability") && headers.includes("Trainers") && headers.includes("Faction")
    && spellLinks > 0 && npcLinks > 0 && badges > 0;
}

// "Obtainable only" checkbox (default on) hides crafts with no recipe/trainer/auto
async function testCraftObtainable() {
  const count = async (qs) => {
    await nav(`?browse=crafting&prof=755${qs}`);
    await page.waitForSelector(".browse table tbody tr", { timeout: T });
    return page.evaluate(() => ({
      rows: document.querySelectorAll(".browse table tbody tr").length,
      checked: document.querySelector('input[data-f="obtainable"]')?.checked,
      dash: [...document.querySelectorAll(".browse table tbody tr")].filter((r) => r.lastElementChild?.textContent.trim() === "—").length,
    }));
  };
  const on = await count("");
  const all = await count("&obtainable=0");
  console.log(`craft obtainable: default rows=${on.rows} checked=${on.checked} dash=${on.dash} | all rows=${all.rows} checked=${all.checked} dash=${all.dash}`);
  // rows are page-capped at 100; the sourceless ("—") rows are the proof
  return on.checked === true && on.dash === 0 && all.checked === false && all.dash > 0;
}

smoke("browse items class=2 q4 rl40", () => testBrowse("items", "&class=2&quality=4&minrl=40", "DPS"));
smoke("browse items class=4 armor", () => testBrowse("items", `&class=4${sc("armor,>=,100")}`, "Armor"));
smoke("browse items agi", () => testBrowse("items", sc("agi,>=,20"), "Agility"));
smoke("browse items sp", () => testBrowse("items", sc("sp,>=,20"), "Spell Power"));
smoke("browse items one-handed multi", () => testBrowse("items", "&class=2&subclass=0,4,7,13,15", "DPS"));
smoke("browse items containers", () => testBrowse("items", "&class=1", "Slots"));
smoke("browse items bag-slot", () => testBrowse("items", "&slot=18", "Slots"));
smoke("browse items projectiles", () => testBrowse("items", "&class=6", "Damage"));
smoke("browse itemsets", () => testBrowse("itemsets", "", "Pieces"));
smoke("browse-source vendor", () => testBrowseSource("vendor"));
smoke("browse-source worlddrop", () => testBrowseSource("worlddrop"));
smoke("browse quest-reward faction", () => testQuestRewardFactionBrowse());
smoke("filter-chips", () => testFilterChips());
smoke("column-chooser", () => testColumnChooser());
smoke("browse spell-cat", () => testBrowseSpellCat());
smoke("origin-filter items", () => testOriginFilter("items"));
smoke("origin-filter npcs", () => testOriginFilter("npcs"));
smoke("filter bind=2", () => testFilter("bind", "2"));
smoke("filter uclass=8", () => testFilter("uclass", "8"));
smoke("filter faction=a", () => testFilter("faction", "a"));
smoke("filter prof=197", () => testFilter("prof", "197"));
smoke("filter unique=1", () => testFilter("unique", "1"));
smoke("unobtainable hidden", () => testUnobtainable());
smoke("selection", () => testSelection());
smoke("group-selection", () => testGroupSelection());
smoke("browse persist", () => testBrowsePersist());
smoke("browse multi", () => testBrowseMulti());
smoke("browse criteria", () => testBrowseCriteria());
smoke("reagent no-req col", () => testReagentNoReq());
smoke("subclass multi", () => testSubclassMulti());
smoke("fishing pole cols", () => testFishingPoleCols());
smoke("mega-menu", () => testMegaMenu());
smoke("crafting prof=171", () => testCrafting());
smoke("crafting enchanting", () => testCraftEnchanting());
smoke("gathering prof", () => testGatheringProf());
smoke("craft obtainable", () => testCraftObtainable());
