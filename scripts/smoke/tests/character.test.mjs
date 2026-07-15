import { page, nav, T, smoke, BASE } from "../harness.mjs";

// Character gear loadouts (character.js): import a GearExport JSON on the
// ?characters page, land on the ?character= sheet, and verify the slots render
// item links + a stat summary, and that Export produces re-importable JSON.
async function testCharacterLoadout() {
  // GearExport format: race/class/level + per-slot enchantId
  const loadout = [{
    name: "Smoke Gear", race: "Human", class: "Paladin", level: 36,
    slots: {
      Head: { itemId: 83216, obtained: true }, Chest: { itemId: 60180, suffixId: 1199, obtained: true },
      Legs: { itemId: 13129, obtained: true }, MainHand: { itemId: 10571, enchantId: 805, obtained: true },
      Trinket1: { itemId: 55211, obtained: true }, Trinket2: { itemId: 55211, obtained: true },
      Waist: { itemId: 10329, obtained: false },
    },
  }];
  await nav(`?characters`);
  await page.waitForSelector("#charJson", { timeout: T });
  await page.evaluate((json) => { document.querySelector("#charJson").value = json; }, JSON.stringify(loadout));
  await page.click("#charImport");
  await page.waitForSelector(".char-sheet .gear-tile", { timeout: T });
  const sheet = await page.evaluate(() => ({
    title: document.querySelector(".char-title")?.textContent?.trim(),
    itemLinks: document.querySelectorAll(".char-view .gear-icon[href*='item=']").length,
    statRows: document.querySelectorAll(".char-summary .stat-pill").length,
    unobtained: document.querySelectorAll(".char-view .gt-unobt").length,
    enchant: !!document.querySelector(".gt-ench"),                          // icon-view enchant badge
    classPicker: document.querySelector("#charClass")?.value,               // inherited from import
    levelPicker: document.querySelector("#charLevel")?.value,
    hasExport: !!document.querySelector("#charExport"),
  }));
  // gear layout toggle: detailed view spells out item name + enchant, then restore icons
  await page.click('[data-gv="detail"]');
  await page.waitForSelector(".det-slot", { timeout: T });
  const detail = await page.evaluate(() => ({ rows: document.querySelectorAll(".det-slot").length, enchLink: !!document.querySelector(".det-ench a.ilink.spell") }));
  await page.click('[data-gv="icons"]');
  await page.waitForSelector(".char-sheet.sheet-icons", { timeout: T });
  // upgrade finder: ranked table per slot (item, score, gain, stat change, source)
  await page.click("#charFindUp");
  await page.waitForSelector(".up-table tbody tr:not(.up-eq)", { timeout: T });
  const up = await page.evaluate(() => ({
    rows: document.querySelectorAll(".up-table tbody tr:not(.up-eq)").length,
    diffs: document.querySelectorAll(".up-diff .dstat").length,
    sources: document.querySelectorAll(".up-src .tagx, .up-src a.ilink.quest").length,
    // dungeon/raid-drop upgrades name their instance + creature (not every upgrade is one)
    bosses: document.querySelectorAll(".up-loc .up-loc-row").length,
    noStaff: ![...document.querySelectorAll(".up-table")].some((tb) =>
      tb.querySelector("thead th")?.textContent === "Main Hand" &&
      [...tb.querySelectorAll(".up-item a.ilink")].some((a) => /staff|gnarled staff/i.test(a.textContent))),
    // test/deprecated items must never be suggested
    noTest: ![...document.querySelectorAll(".up-item a.ilink[href*='item=']")].some((a) => /\btest\b|deprecated/i.test(a.textContent)),
  }));
  const roundTrip = await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("tw_characters") || "[]")[0];
    return !!(c && c.race === 1 && c.cls === 2 && c.level === 36 && c.slots.MainHand?.enchantId === 805 && c.slots.Chest?.suffixId === 1199 && c.id);
  });
  // share link: encodes the loadout into ?loadout=, opens without localStorage
  await page.click("#charShare");
  const shareUrl = await page.evaluate(() => window.__copied);
  await page.goto(shareUrl || `${BASE}?characters`);
  await page.waitForSelector(".char-view", { timeout: T }).catch(() => {});
  const share = await page.evaluate(() => ({
    isLoadout: /\?loadout=/.test(location.href),
    banner: !!document.querySelector(".char-shared-note"),
    saveBtn: !!document.querySelector("#charSave"),
    noDelete: !document.querySelector("#charDelete"),
    slots: document.querySelectorAll(".gear-icon[href*='item=']").length,
  }));
  console.log(`character loadout: title=${sheet.title} items=${sheet.itemLinks} stats=${sheet.statRows} unobt=${sheet.unobtained} ench=${sheet.enchant} class=${sheet.classPicker} lvl=${sheet.levelPicker} | detail rows=${detail.rows} enchLink=${detail.enchLink} | up rows=${up.rows} diffs=${up.diffs} src=${up.sources} boss=${up.bosses} noStaff=${up.noStaff} noTest=${up.noTest} roundTrip=${roundTrip} | share=${share.isLoadout} banner=${share.banner} save=${share.saveBtn} slots=${share.slots}`);
  return sheet.title === "Smoke Gear" && sheet.itemLinks >= 5 && sheet.statRows > 0 && sheet.unobtained === 1
    && sheet.enchant && sheet.classPicker === "2" && sheet.levelPicker === "36" && sheet.hasExport
    && detail.rows > 0 && detail.enchLink
    && up.rows > 0 && up.diffs > 0 && up.sources > 0 && up.noStaff && up.noTest && roundTrip
    && share.isLoadout && share.banner && share.saveBtn && share.noDelete && share.slots >= 5;
}

// Gear-score presets (?weights): create/import a stat-weight set, confirm it lists
// and becomes selectable in the item browser's gear-score dropdown (ranking by it).
async function testWeightSets() {
  await nav(`?weights`);
  await page.waitForSelector("#wsImport", { timeout: T });
  await page.evaluate(() => { document.querySelector("#wsJson").value = JSON.stringify({ name: "Smoke Preset", weights: { def: 12, sta: 3, speed: -3 } }); });
  await page.click("#wsImport");
  await page.waitForSelector(".ws-card", { timeout: T });
  const p1 = await page.evaluate(() => ({
    cards: document.querySelectorAll(".ws-card").length,
    name: document.querySelector(".ws-card-name")?.textContent?.trim(),
    pills: document.querySelectorAll(".ws-pills .wpill").length,
    id: JSON.parse(localStorage.getItem("tw_weightsets") || "[]").find((s) => s.name === "Smoke Preset")?.id,
  }));
  await nav(`?browse=items&class=4`);
  await page.waitForSelector("[data-wpreset]", { timeout: T });
  const inBrowse = await page.evaluate((id) => [...document.querySelectorAll('[data-wpreset] optgroup[label="My presets"] option')].some((o) => o.value === id), p1.id);
  await page.select("[data-wpreset]", p1.id);
  const scored = await page.waitForFunction(() => [...document.querySelectorAll(".browse th")].some((h) => /Score/.test(h.textContent)), { timeout: T }).then(() => true).catch(() => false);
  console.log(`weight sets: cards=${p1.cards} name=${p1.name} pills=${p1.pills} inBrowse=${inBrowse} scored=${scored}`);
  return p1.cards >= 1 && p1.name === "Smoke Preset" && p1.pills === 3 && inBrowse && scored;
}

// Stat-weight gear ranking: weights= adds a computed Score column and sorts the
// finder score-desc (best gear for the spec on top).
async function testGearScore() {
  const w = encodeURIComponent("dps:3|crit:14|hit:12");
  await nav(`?browse=items&class=2&weights=${w}`);
  await page.waitForSelector(".browse table tbody tr", { timeout: T });
  const headers = await page.$$eval(".browse th", (e) => e.map((h) => h.textContent.replace(/[▲▼]/g, "").trim()));
  const idx = headers.indexOf("Score");
  const scores = idx < 0 ? [] : await page.$$eval(".browse tbody tr", (rows, i) => rows.map((r) => parseFloat(r.querySelectorAll("td")[i]?.textContent) || 0), idx);
  const nonzero = scores.filter((v) => v > 0);
  const desc = nonzero.length < 2 || nonzero[0] >= nonzero[nonzero.length - 1];
  // ranking must only include obtainable gear -> every row has a non-empty Source
  const srcIdx = headers.indexOf("Source");
  const srcs = srcIdx < 0 ? [] : await page.$$eval(".browse tbody tr", (rows, i) => rows.map((r) => (r.querySelectorAll("td")[i]?.textContent || "").trim()), srcIdx);
  const allSourced = srcs.length > 0 && srcs.every((s) => s.length > 0);
  // the weighted stats surface as columns (Crit %, Hit % for these weights)
  const weightedCols = headers.includes("Crit %") && headers.includes("Hit %");
  // weapon speed / item level are weightable (derived, not item_stats)
  const derivedOpts = await page.$$eval("[data-wstat] option", (o) => { const t = o.map((x) => x.textContent); return t.includes("Weapon Speed") && t.includes("Item Level"); });
  console.log(`gear-score: hasScore=${idx >= 0} rows=${nonzero.length} top=${scores[0]} desc=${desc} allSourced=${allSourced} weightedCols=${weightedCols} derivedOpts=${derivedOpts}`);
  return idx >= 0 && nonzero.length > 0 && desc && allSourced && weightedCols && derivedOpts;
}

// Multi-criteria OR: match=any OR-combines the stat criteria, so it must return
// at least as many items as the default AND (agi≥20 OR int≥20 ⊇ agi≥20 AND int≥20).
// Feral (druid-form) attack power is a stat distinct from generic AP: form-gated
// "Attack Power in Cat/Bear/... forms only" derives to `feralAp`, not `ap`, so it
// doesn't inflate non-druid weapon scores. Assert the derived stat is queryable
// (feral weapons exist) and that plain AP still works separately.
async function testFeralAp() {
  const readCount = async (stats) => {
    await nav(`?browse=items&stats=${encodeURIComponent(stats)}`);
    await page.waitForSelector(".browse-count", { timeout: T });
    return parseInt((await page.$eval(".browse-count", (e) => e.textContent)).replace(/[^0-9]/g, ""), 10) || 0;
  };
  const feral = await readCount("feralAp,>=,50");
  const ap = await readCount("ap,>=,50");
  // Ranged AP (aura 124) is its own key too, so hunters can weight it independently.
  const ranged = await readCount("rangedAp,>=,1");
  console.log(`feral-ap: feralAp>=50 items=${feral} | ap>=50 items=${ap} | rangedAp>=1 items=${ranged}`);
  return feral > 0 && ap > 0 && ranged > 0;
}

async function testCriteriaOr() {
  const stats = encodeURIComponent("agi,>=,20|int,>=,20");
  const readCount = async (m) => {
    await nav(`?browse=items&stats=${stats}${m}`);
    await page.waitForSelector(".browse-count", { timeout: T });
    const txt = await page.$eval(".browse-count", (e) => e.textContent);
    return parseInt(txt.replace(/[^0-9]/g, ""), 10) || 0;
  };
  const all = await readCount("");
  const any = await readCount("&match=any");
  console.log(`criteria-or: all=${all} any=${any}`);
  return any > all;
}

smoke("character loadout", () => testCharacterLoadout());
smoke("weight sets", () => testWeightSets());
smoke("gear score", () => testGearScore());
smoke("feral-ap split", () => testFeralAp());
smoke("criteria-or", () => testCriteriaOr());
