import { page, nav, T, smoke } from "../harness.mjs";

// Home page advertises the embeddable tooltip widget (link to the demo page).
async function testHomeEmbed() {
  await nav(`?`);
  await page.waitForSelector(".home", { timeout: T });
  const demo = await page.$$eval('.home a[href*="embed/demo.html"]', (e) => e.length);
  const talents = await page.$$eval('.home a[href="?talents"]', (e) => e.length);
  // static JSON endpoints note + its per-entity tooltip example link
  const api = await page.$$eval(".home-api .api-list li", (e) => e.length);
  const ttLink = await page.$$eval('.home-api a[href*="tt/i/2770.json"]', (e) => e.length);
  console.log(`home-embed: demoLink=${demo} talentsLink=${talents} apiRows=${api} ttLink=${ttLink}`);
  return demo > 0 && talents > 0 && api >= 3 && ttLink > 0;
}

// Talent calculator: allocating ranks updates the point counter + URL, and obeys
// the rank cap (clicking a 3-rank talent 4× stops at 3/3).
async function testTalents() {
  // class picker: one icon per class (9)
  await nav(`?talents`);
  await page.waitForSelector(".talent-classlist .talent-cls-icon", { timeout: T });
  const icons = await page.$$eval(".talent-classlist .talent-cls-icon", (e) => e.length);
  const iconOk = await page.$eval(".talent-classlist .talent-cls-icon", (e) => e.complete && e.naturalWidth > 0);
  console.log(`talent-picker: classIcons=${icons} firstLoaded=${iconOk}`);
  await nav(`?talents=warrior`);
  const sel = "a.talent-cell:not(.locked)"; // a row-0 talent, unlocked at load
  await page.waitForSelector(sel, { timeout: T });
  const tabs = await page.$$eval(".talent-tree-head", (e) => e.map((h) => h.textContent.trim()));
  const max = (await page.$eval(sel + " .talent-rank", (e) => e.textContent)).split("/")[1];
  for (let i = 0; i < +max + 2; i++) await page.click(sel); // over-click: must cap at max
  const rank = await page.$eval(sel + " .talent-rank", (e) => e.textContent);
  const spent = await page.$eval(".talent-status b", (e) => e.textContent);
  const url = await page.evaluate(() => location.search);
  console.log(`talents: tabs=[${tabs.join("|")}] rank=${rank} spent=${spent} url=${url}`);
  return icons === 9 && iconOk && tabs.length === 3 && rank === `${max}/${max}` && spent === max && /[?&]t=/.test(url);
}

// Site footer: shows the page load time always, and an "Updated <date>" stamp
// when version.json carries builtAt (CI build writes it).
async function testFooter() {
  await nav(`?item=2770`);
  await page.waitForSelector(".tooltip .tt-name", { timeout: T });
  await page.waitForFunction(() => { const e = document.getElementById("footLoad"); return e && /\d/.test(e.textContent); }, { timeout: 15000 }).catch(() => {});
  const load = await page.$eval("#footLoad", (e) => e.textContent.trim()).catch(() => "");
  const updated = await page.$eval("#footUpdated", (e) => e.textContent.trim()).catch(() => "");
  const srcLink = (await page.$(".sitefoot .foot-src a[href*='github.com']")) !== null;
  const loadOk = /Loaded in \d+(\.\d+)? (ms|s)/.test(load);
  const updatedOk = /^Updated /.test(updated);   // present when builtAt is set
  console.log(`footer: load="${load}" updated="${updated}" srcLink=${srcLink}`);
  return loadOk && updatedOk && srcLink;
}

// Data-source toggle (main | dev): the top bar shows a two-link segmented pill.
// On the main site the "Main" side is active, the body is NOT flagged dev, and the
// "Dev" link points at the /dev/ path (carrying the current query). DOM-only so it
// doesn't need the dev DB built/served.
async function testDatasetToggle() {
  await nav(`?item=2770`);
  await page.waitForSelector("#dsToggle .ds-btn", { timeout: T });
  const r = await page.evaluate(() => {
    const main = document.querySelector('#dsToggle [data-ds="main"]');
    const dev = document.querySelector('#dsToggle [data-ds="dev"]');
    const cm = document.querySelector('#dsToggle [data-ds="vanilla-cmangos"]');
    return {
      count: document.querySelectorAll("#dsToggle .ds-btn").length,
      mainOn: main?.classList.contains("on"),
      devOn: dev?.classList.contains("on"),
      devHref: dev?.getAttribute("href") || "",
      cmHref: cm?.getAttribute("href") || "",
      bodyDev: document.body.classList.contains("ds-dev"),
    };
  });
  console.log(`dataset-toggle: count=${r.count} mainOn=${r.mainOn} devOn=${r.devOn} devHref="${r.devHref}" cmHref="${r.cmHref}" bodyDev=${r.bodyDev}`);
  // three datasets: main (/), dev (/dev/), vanilla-cmangos (/vanilla/cmangos/) -- see src/config.js DATASETS
  return r.count === 3 && r.mainOn === true && r.devOn === false
    && /\/dev\/\?item=2770$/.test(r.devHref) && /\/vanilla\/cmangos\/\?item=2770$/.test(r.cmHref)
    && r.bodyDev === false;
}

// "What's new" changelog (?changelog). On the main dataset there's no
// data/changelog.json, so the page renders the dev-pointer empty state (with a
// link to the Dev view) -- assert it renders cleanly without a page error.
async function testChangelog() {
  await nav(`?changelog`);
  await page.waitForSelector(".changelog h1", { timeout: T });
  const r = await page.evaluate(() => ({
    heading: document.querySelector(".changelog h1")?.textContent || "",
    empty: (document.querySelector(".changelog .cl-empty")) !== null,
    devLink: (document.querySelector('.changelog a[href*="dev/?changelog"]')) !== null,
  }));
  console.log(`changelog: heading="${r.heading}" empty=${r.empty} devLink=${r.devLink}`);
  return /What's new/.test(r.heading) && r.empty && r.devLink;
}

// The ?origin= override forces a specific asset origin (config.js resolveOrigins).
// Forcing r2 must still load the DB + render (guards the origin-resolver/getDbUrls
// path; the real jsDelivr/raw mirrors can only be exercised post-deploy).
async function testOriginOverride() {
  await nav(`?origin=r2&item=2770`);
  await page.waitForSelector(".tooltip .tt-name", { timeout: T });
  const name = await page.$eval(".tooltip .tt-name", (e) => e.textContent);
  console.log(`origin-override r2: name="${name}"`);
  return name.includes("Copper Ore");
}

// ?random rolls a random entity and replaces the URL with its detail page.
async function testRandom() {
  await nav(`?random`);
  await page.waitForFunction(() => /[?&](item|npc|quest)=\d+/.test(location.search), { timeout: T });
  await page.waitForSelector("#app h1, #app .tooltip .tt-name", { timeout: T });
  const search = await page.evaluate(() => location.search);
  console.log(`random -> ${search}`);
  return /[?&](item|npc|quest)=\d+/.test(search);
}

// Icons index: searchable grid; filter + page live in the URL (?icons=term&page=n),
// non-renderable junk icons (BTN* etc.) are filtered out, and a deep-link pre-fills.
async function testIcons() {
  await nav(`?icons`);
  await page.waitForSelector(".icon-grid .icon-tile", { timeout: T });
  const full = await page.$$eval(".icon-grid .icon-tile", (t) => t.length);
  // no junk: searching the WC3 button prefix should yield zero tiles (filtered out)
  await page.type(".icon-search", "btnbrown");
  await new Promise((r) => setTimeout(r, 200));
  const junk = await page.$$eval(".icon-grid .icon-tile", (t) => t.length);
  const junkUrl = await page.evaluate(() => location.search); // URL reflects the filter
  // deep-link: ?icons=copper pre-fills the box, filters, and a page param paginates
  await nav(`?icons=copper`);
  await page.waitForSelector(".icon-grid .icon-tile", { timeout: T });
  const prefilled = await page.$eval(".icon-search", (e) => e.value);
  const filtered = await page.$$eval(".icon-grid .icon-tile", (t) => t.length);
  const noText = (await page.$$eval(".icons-page p", (ps) => ps.map((p) => p.textContent).join(""))).includes("click one to see") === false;
  console.log(`icons index: full=${full} junk(btnbrown)=${junk} url="${junkUrl}" prefill="${prefilled}" filtered(copper)=${filtered} noBlurb=${noText}`);
  return full === 300 && junk === 0 && /icons=btnbrown/.test(junkUrl)
    && prefilled === "copper" && filtered > 0 && filtered < 300 && noText;
}
// Icon detail: the items (and/or spells) that use a given icon basename.
async function testIcon(name, expectItem) {
  await nav(`?icon=${encodeURIComponent(name)}`);
  await page.waitForSelector(".icon-page .icon-head h1", { timeout: T });
  const title = await page.$eval(".icon-page .icon-head h1", (e) => e.textContent);
  await page.waitForSelector(".icon-page .tabpane:not(.hidden) td a.ilink", { timeout: 20000 }).catch(() => {});
  const items = await page.$$eval(".icon-page .tabpane:not(.hidden) td a.ilink", (a) => a.map((x) => x.textContent.trim()));
  console.log(`icon ${name}: title="${title}" items=${items.slice(0, 3).join(",")}`);
  return title === name && items.some((t) => t.includes(expectItem));
}

// Mobile: the top nav collapses behind a hamburger that toggles it open.
// Mobile: the shared data table collapses to stacked cards (each cell a labelled
// line) so dense tables don't overflow. Crafting has 4 columns incl. reagent lists.
async function testMobileTable() {
  await page.setViewport({ width: 390, height: 800, isMobile: true });
  await nav(`?browse=crafting&prof=185&sort=skill&dir=a`, { full: true });
  await page.waitForSelector(".dtable td[data-label]", { timeout: T });
  const r = await page.evaluate(() => ({
    tdBlock: getComputedStyle(document.querySelector(".dtable td[data-label]")).display === "block",
    label: getComputedStyle(document.querySelector(".dtable td[data-label]"), "::before").content.replace(/"/g, ""),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  await page.setViewport({ width: 1280, height: 900 }); // restore
  console.log(`mobile-table: cards=${r.tdBlock} label="${r.label}" hOverflow=${r.overflow}`);
  return r.tdBlock && r.label.length > 0 && r.overflow <= 0;
}

async function testMobileNav() {
  await page.setViewport({ width: 390, height: 800 });
  await nav(`?`, { full: true });
  await page.waitForSelector("#navToggle", { timeout: T });
  const toggleVisible = await page.$eval("#navToggle", (el) => getComputedStyle(el).display !== "none");
  const hiddenBefore = await page.$eval(".topnav", (el) => getComputedStyle(el).display === "none");
  await page.click("#navToggle");
  const shownAfter = await page.$eval(".topnav", (el) => getComputedStyle(el).display !== "none");
  await page.setViewport({ width: 1280, height: 900 });   // restore for any later tests
  console.log(`mobile-nav: toggleVisible=${toggleVisible} hiddenBefore=${hiddenBefore} shownAfter=${shownAfter}`);
  return toggleVisible && hiddenBefore && shownAfter;
}

smoke("home embed links", () => testHomeEmbed());
smoke("talents calculator", () => testTalents());
smoke("footer", () => testFooter());
smoke("dataset toggle", () => testDatasetToggle());
smoke("changelog empty-state", () => testChangelog());
smoke("origin override r2", () => testOriginOverride());
smoke("random entity", () => testRandom());
smoke("icons index", () => testIcons());
smoke("icon detail copper", () => testIcon("INV_Ore_Copper_01", "Copper Ore"));
smoke("mobile table", () => testMobileTable());
smoke("mobile nav", () => testMobileNav());
