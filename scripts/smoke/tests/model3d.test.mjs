// The 3D item viewer: the tab appears only where there is a model to show, the WebGL
// canvas actually draws something, and the context is released on navigation.
import { page, nav, T, smoke } from "../harness.mjs";

// The 3D feature is OPTIONAL SCHEMA: it needs item_appearance, which a DB built before
// it simply does not have. That is not hypothetical here -- config.js RACES several
// origins for the database (R2, the mirrors, then the local server), so a preview build
// can legitimately end up running against the DEPLOYED DB, and until the next deploy
// that one predates the table. The page then hides the tab exactly as designed. Treat
// that as "not applicable" rather than a failure, the same way the site treats it, and
// say so loudly enough that a REAL regression is not mistaken for it.
async function appearanceMissing() {
  const reason = await page.evaluate(() => document.querySelector("#app")?.dataset.model3d);
  return reason === "no-appearance-row";
}

const openTab = async (id) => {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  const btn = await page.$('.tab[data-tab="model3d"]');
  if (!btn) {
    // Say WHY there is no tab. It is gated on three independent things, and a bare
    // "no 3D tab" sent an earlier investigation looking at the model files when the
    // actual cause was caps() having cached a failed probe.
    const why = await page.evaluate(() => ({
      reason: document.querySelector("#app")?.dataset.model3d,
      webgl: !!document.createElement("canvas").getContext("webgl2"),
    })).catch(() => ({}));
    console.log(`  (no tab; reason=${why.reason} webgl=${why.webgl})`);
    return null;
  }
  await btn.click();
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  return page.evaluate(() => window.__mv());
};

// Item 10571 (Ebony Boneclub) is a one-hand mace: a model of its own, no race variants.
async function testItemModel(id) {
  const st = await openTab(id);
  if (!st && await appearanceMissing()) {
    console.log(`model3d ${id}: SKIPPED -- this DB has no item_appearance table`);
    return true;
  }
  console.log(`model3d ${id}: ${JSON.stringify(st)}`);
  return !!st && st.triangles > 0 && st.meshes > 0 && st.textured;
}

// "Did it actually draw?" -- the honest question, and the one a canvas will happily lie
// about. A WebGL canvas reads back BLANK unless it is read in the same frame it was
// drawn, so the viewer exposes snapshot() to render+read in one tick rather than making
// every visitor pay preserveDrawingBuffer. The 1000-opaque-pixel floor is the same
// threshold render-model-thumbs.py's QC pass uses to reject an empty render, so "it drew
// something" means the same thing on both renderers.
async function testCanvasNotBlank(id) {
  const st = await openTab(id);
  if (!st && await appearanceMissing()) {
    console.log(`model3d ${id}: SKIPPED -- this DB has no item_appearance table`);
    return true;
  }
  if (!st) { console.log(`model3d ${id}: no 3D tab`); return false; }
  const opaque = await page.evaluate(async () => {
    const url = window.__mv.snapshot();
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
    return n;
  });
  console.log(`model3d ${id}: opaque pixels=${opaque}`);
  return opaque >= 1000;
}

// Armor paints onto the character rather than carrying a model of its own, and helms are
// modelled once per race+gender -- neither can be previewed standalone, so neither may
// offer an empty tab. 7457 = Knight's Gauntlets (textures only), 83216 = a helm.
// Who gets a 3D tab, and in which of the two forms. A weapon stands alone; a helm, a
// shoulder and any texture-only armor are shown ON the mannequin, which is why they have
// a tab at all now. A ring changes nothing about how a character looks and gets none.
//
// The reason string is asserted rather than just the tab's presence: "worn" vs "on" is the
// difference between the two renderers, and a helm silently falling back to the standalone
// path is exactly the bug that put a pauldron on the gauntlets' page.
async function testTabKinds(cases) {
  const got = {};
  for (const [id] of cases) {
    await nav(`?item=${id}`);
    await page.waitForSelector(".item-rel .tab", { timeout: T });
    const has = !!(await page.$('.tab[data-tab="model3d"]'));
    const why = await page.evaluate(() => document.querySelector("#app")?.dataset.model3d);
    got[id] = has ? why : `none:${why}`;
  }
  console.log(`tab kinds: ${JSON.stringify(got)}`);
  return cases.every(([id, want]) => got[id] === want || (want === "none" && got[id].startsWith("none")));
}

// A WebGL context is scarce and is not garbage-collected: leaving one behind per page
// makes the browser silently kill the oldest canvas after a handful of navigations. The
// route owns the teardown, so leaving the page must drop the hook.
async function testContextReleased(id) {
  await openTab(id);
  await nav("?item=7457");
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  const stillThere = await page.evaluate(() => typeof window.__mv === "function");
  console.log(`model3d teardown: hook after navigation=${stillThere} (want false)`);
  return stillThere === false;
}

// The viewer must cost nothing when nothing is happening. Two ways it could quietly burn
// a core: keep rendering while its pane is hidden behind another tab of the item page,
// or keep redrawing a still image after the model has come to rest. Both are asserted by
// watching the frame counter rather than by trusting the code to have stopped.
async function testIdleCostsNothing(id) {
  const st = await openTab(id);
  if (!st && await appearanceMissing()) {
    console.log(`model3d ${id}: SKIPPED -- this DB has no item_appearance table`);
    return true;
  }
  if (!st) { console.log(`model3d ${id}: no 3D tab`); return false; }
  // Switch to a different tab: the canvas stays in the DOM, so only the visibility
  // handling stops it drawing.
  await page.click('.tab[data-tab="samemodel"]');
  await new Promise((r) => setTimeout(r, 600));
  const a = await page.evaluate(() => window.__mv().frames);
  await new Promise((r) => setTimeout(r, 1200));
  const b = await page.evaluate(() => window.__mv().frames);
  const state = await page.evaluate(() => window.__mv());
  console.log(`model3d idle: frames ${a} -> ${b} while hidden (want equal), running=${state.running} visible=${state.visible}`);
  return b === a && state.running === false;
}

smoke("model3d item 10571 renders geometry", () => testItemModel(10571));
smoke("model3d stops rendering when its pane is hidden", () => testIdleCostsNothing(10571));
smoke("model3d item 10571 canvas is not blank", () => testCanvasNotBlank(10571));
smoke("model3d tab: alone for a weapon, worn for armor, none for a ring", () => testTabKinds([
  [10571, "on"],       // a mace: its own model
  [22418, "worn"],     // Dreadnaught Helmet: per-race, needs a head to sit on
  [22421, "worn"],     // Dreadnaught Gauntlets: texture-only
  [7457, "worn"],      // plain armor
  [19382, "none"],     // a ring changes nothing about how a character looks
]));
smoke("model3d releases its WebGL context on navigation", () => testContextReleased(10571));

// ---- dressing room (?dressing) -------------------------------------------------

async function testDressingRoom(race, sex) {
  await nav(`?dressing&race=${race}&sex=${sex}&hair=1`);
  await page.waitForSelector("#mv-host canvas", { timeout: T });
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const st = await page.evaluate(() => window.__mv());
  // Scope by data-key: gender shares the tile class with the races (it leads the same
  // row), so an unscoped "first pressed tile" reads the gender as the race.
  const picked = await page.evaluate(() => ({
    race: document.querySelector('.race-tile[data-key="race"][aria-pressed="true"]')?.dataset.val,
    sex: document.querySelector('.race-tile[data-key="sex"][aria-pressed="true"]')?.dataset.val,
  }));
  console.log(`dressing ${race}-${sex}: tris=${st.triangles} meshes=${st.meshes} geosets=[${st.geosets}] picked=${JSON.stringify(picked)}`);
  // the pickers must also AGREE with the URL -- a look that renders while the controls
  // show something else is the same bug as one that renders wrong.
  return st.triangles > 0 && st.meshes > 1 && picked.race === String(race) && picked.sex === sex;
}

// The naked mannequin must show the body and its bare limbs, and nothing it is not
// wearing. Three plausible rules fail here, each in a way that looks like a different
// bug, so all three are pinned:
//   * dropping the "clothing" groups leaves a torso with no legs -- 1301 IS the bare leg;
//   * taking each group's lowest variant puts a sleeve (802) and a kilt (1302) on a naked
//     character, because that group has no variant 1 at all;
//   * excluding the cape group loses 1501, the small patch of BODY that closes the back
//     where a cloak attaches -- a hole between the shoulders of every character. The
//     cloak sheets are 1502+, and must still be off.
async function testNakedGeosets() {
  await nav("?dressing&race=1&sex=m&hair=1");
  await page.waitForFunction(() => window.__mv && window.__mv().geosets, { timeout: T });
  const g = await page.evaluate(() => window.__mv().geosets);
  const has = (x) => g.includes(x);
  const ok = has(0) && has(1301) && has(1501) && !has(802) && !has(1302) && !has(1502);
  console.log(`naked geosets: [${g}] (want 0 + 1301 + 1501, no 802/1302/1502)`);
  return ok;
}

// Hair is a separate texture slot (texType 6) on its own geoset, and its BLP is
// palettized with a 1-bit alpha section -- decoded wrongly it comes out fully
// transparent and every hairstyle silently disappears. So assert the hair submesh is
// actually drawn WITH a texture, not merely selected.
async function testHairDrawn() {
  await nav("?dressing&race=1&sex=m&hair=1");
  await page.waitForFunction(() => window.__mv && window.__mv().drawn, { timeout: T });
  const drawn = await page.evaluate(() => window.__mv().drawn);
  const hair = drawn.filter((d) => d[1] === 6);
  console.log(`hair submeshes drawn: ${JSON.stringify(hair)} (want at least one, with a texture)`);
  return hair.length > 0 && hair.every((d) => d[3] === 1);
}

smoke("dressing room renders human male", () => testDressingRoom(1, "m"));
smoke("dressing room renders tauren female", () => testDressingRoom(6, "f"));
smoke("dressing room naked geoset rule", () => testNakedGeosets());
smoke("dressing room draws hair with its own texture", () => testHairDrawn());

// Bald is not "draw nothing". CharHairGeosets gives geoset 0 (no hair mesh) and geoset 1
// is the cap that closes the top of the skull -- without it the body mesh stops below
// the crown, which read as a scalpless human and a headless troll. Meanwhile variation 0
// is only "bald" on SOME races: on a gnome it is a real hairstyle, so the check is that
// the model gains a scalp exactly where it has no hair mesh.
async function testBaldScalp(race, sex, expectHair) {
  await nav(`?dressing&race=${race}&sex=${sex}&hair=0&hcolor=0&facial=0`);
  await page.waitForFunction(() => window.__mv && window.__mv().geosets, { timeout: T });
  const st = await page.evaluate(() => window.__mv());
  const hairMesh = st.drawn.some((d) => d[1] === 6);
  const scalp = st.geosets.includes(1);
  console.log(`bald ${race}-${sex}: geosets=[${st.geosets}] hairMesh=${hairMesh} scalp=${scalp} (want hairMesh=${expectHair})`);
  return hairMesh === expectHair && (hairMesh || scalp);
}

smoke("dressing room bald human keeps its scalp", () => testBaldScalp(1, "m", false));
smoke("dressing room bald troll keeps its head", () => testBaldScalp(8, "m", false));
smoke("dressing room gnome variation 0 is a real hairstyle", () => testBaldScalp(7, "f", true));

// Wearing armor: most gear has no model at all, only textures painted into the body
// atlas plus a geoset swap. Both halves are asserted -- the geoset ids encode the rule
// that a value is an OFFSET from the bare variant (gloves geo1=1 -> 402, because 401 is
// the bare hand), which is the thing most likely to drift.
async function testWornGear() {
  await nav("?dressing&race=1&sex=m&hair=1&hands=888&feet=1121");
  await page.waitForSelector("#mv-host canvas", { timeout: T });
  await page.waitForFunction(() => window.__mv && window.__mv().geosets, { timeout: T });
  const g = await page.evaluate(() => window.__mv().geosets);
  // The paperdoll fills the SLOT itself; each filled slot names the item and links to
  // its page, which is where "where it drops" lives.
  const chips = await page.$$eval(".dress-slot.filled .dress-slot-label a", (e) => e.map((x) => x.textContent));
  const links = await page.$$eval(".dress-slot.filled .dress-slot-label a",
    (e) => e.length > 0 && e.every((x) => x.getAttribute("href").startsWith("?item=")));
  console.log(`worn gear: geosets=[${g}] slots=[${chips.join(", ")}] itemLinks=${links}`);
  // 402 = gloves over the bare 401; 504 = the boot variant; both must have REPLACED the
  // bare ones rather than drawing alongside them.
  return g.includes(402) && !g.includes(401) && g.includes(504) && !g.includes(501)
    && chips.length === 2 && links;
}

smoke("dressing room wears gloves and boots", () => testWornGear());

// A cloak is the character's own cape geoset textured from the ITEM, and its texture is
// the one kind that belongs to a display with NO model -- which is exactly how it got
// missed: the export worklist was keyed on models, so no cape texture was ever written
// and every cloak rendered with the body atlas (the character's own face stretched down
// their back). Assert the texture actually LOADED, not merely that it was requested: a
// dev server answers a missing file with index.html at 200, so the request looked fine.
async function testCloakTexture() {
  await nav("?dressing&race=1&sex=f&hair=2&back=80505");
  await page.waitForFunction(() => window.__mv && window.__mv().cape, { timeout: T });
  const st = await page.evaluate(() => window.__mv());
  console.log(`cloak: ${JSON.stringify(st.cape)} capeGeoset=${st.geosets.filter((g) => g >= 1502 && g < 1600)}`);
  return st.cape?.loaded === true && st.geosets.some((g) => g >= 1502 && g < 1600);
}

smoke("dressing room textures a cloak from the item", () => testCloakTexture());

// Helms and shoulders are MODELS hung off attachment points, not textures. Three things
// can each silently produce "no helm": a per-race variant that was never exported (a helm
// is 20 files, one per race+gender), a shoulder whose second model was not selected (the
// DBC names left and right separately in ModelName[0] and [1]), and an attachment id that
// does not exist on the model. Assert all three landed.
async function testAttachments() {
  await nav("?dressing&race=1&sex=m&hair=1&head=83216&shoulder=60691");
  await page.waitForFunction(() => window.__mv && window.__mv().attached, { timeout: T });
  const att = await page.evaluate(() => window.__mv().attached);
  const ids = att.map((a) => a.attach).sort((a, b) => a - b);
  const helm = att.find((a) => a.attach === 11);
  console.log(`attachments: ${JSON.stringify(att)}`);
  // 11 head, 5/6 the shoulder pair; the helm must be the race+gender variant, not a bare name
  return ids.join(",") === "5,6,11" && /_hum$/i.test(helm?.model || "");
}

smoke("dressing room attaches a helm and both shoulders", () => testAttachments());

// The paperdoll: slots flank the character, clicking one opens a search restricted to
// that slot, and picking an item equips it there. Also guards the mount race that left
// the room with no character at all -- a slow first mount finishing after a later one had
// already cleared the host.
async function testPaperdoll() {
  await nav("?dressing&race=1&sex=f&hair=2&chest=60180&feet=1121");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const slots = await page.$$eval(".dress-slot", (e) => e.map((b) => b.dataset.slot));
  const filled = await page.$$eval(".dress-slot.filled", (e) => e.map((b) => b.dataset.slot));
  const canvases = await page.$$eval("#mv-host canvas", (e) => e.length);
  // open the Head slot: the picker must appear, scoped to that slot, and it is the SAME
  // panel the top-bar search uses -- asserting the class keeps the two from drifting.
  await page.click('.dress-slot[data-slot="head"]');
  const open = await page.$eval("#dress-pop", (e) => !e.hidden);
  const shared = await page.$eval("#dress-pop", (e) => e.classList.contains("search-dropdown"));
  const ph = await page.$eval("#dress-find", (e) => e.placeholder);
  console.log(`paperdoll: slots=[${slots.join(",")}] filled=[${filled.join(",")}] canvases=${canvases} placeholder="${ph}" open=${open} sharedPanel=${shared}`);
  return slots.includes("head") && slots.includes("mainhand") && filled.length === 2
    && canvases === 1 && open && shared && /head/i.test(ph);
}

smoke("dressing room paperdoll equips per slot", () => testPaperdoll());

// Wearing a tier set one slot at a time is eleven searches, so the room can equip a whole
// set at once. Two things are easy to get wrong and both look like "the button does
// nothing": the picker's own click bubbles to the room's close-on-outside-click handler,
// and a set that names several items for one slot (a 1H and a 2H) must fill that slot once.
async function testSets() {
  await nav("?dressing&race=1&sex=m&hair=1");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  await page.click("#dress-set");
  await page.type("#dress-find", "Dreadnaught", { delay: 20 });
  await page.waitForFunction(() => document.querySelector('#dress-hits .sd-row[data-i="0"]'), { timeout: T });
  const open = await page.$eval("#dress-pop", (e) => !e.hidden);
  await page.click('#dress-hits .sd-row[data-i="0"]');
  await page.waitForFunction(() => document.querySelectorAll(".dress-slot.filled").length > 4, { timeout: T });
  const filled = await page.$$eval(".dress-slot.filled", (e) => e.map((b) => b.dataset.slot));
  const dupes = filled.length !== new Set(filled).size;
  // and off again in one click
  await page.click("#dress-strip");
  await page.waitForFunction(() => !document.querySelectorAll(".dress-slot.filled").length, { timeout: T });
  const after = await page.$$eval(".dress-slot.filled", (e) => e.length);
  console.log(`sets: pickerOpen=${open} filled=[${filled.join(",")}] afterStrip=${after}`);
  return open && !dupes && filled.includes("chest") && filled.includes("head") && after === 0;
}

smoke("dressing room equips a whole item set", () => testSets());

// Weapons hang off the hands. Two rules are easy to get wrong and both look plausible on
// screen: WHICH hand is decided by the slot an item is worn in (a one-hander is a main
// hand or an off hand, and the item itself cannot say), and a shield goes to the forearm
// point rather than into a fist. Equipping the SAME one-hander in both hands exercises
// the duplicate-entry path too -- one query row, two slots.
async function testWeapons() {
  await nav("?dressing&race=1&sex=m&hair=1&mainhand=15221&offhand=15221");
  await page.waitForFunction(() => window.__mv && window.__mv().attached?.length === 2, { timeout: T });
  const dual = (await page.evaluate(() => window.__mv().attached)).map((a) => a.attach).sort();
  await nav("?dressing&race=1&sex=m&hair=1&mainhand=15258&offhand=22819&ranged=20278");
  await page.waitForFunction(() => window.__mv && window.__mv().attached?.length === 3, { timeout: T });
  const mixed = await page.evaluate(() => window.__mv().attached);
  const ids = mixed.map((a) => a.attach).sort();
  const filled = await page.$$eval(".dress-slot.filled", (e) => e.map((b) => b.dataset.slot).sort());
  console.log(`weapons: dual=[${dual}] mixed=${JSON.stringify(mixed)} slots=[${filled}]`);
  // 1 right hand, 2 left hand, 0 the shield's forearm point
  return dual.join(",") === "1,2" && ids.join(",") === "0,1,2"
    && filled.join(",") === "mainhand,offhand,ranged";
}

smoke("dressing room puts weapons in the right hands", () => testWeapons());

// The room was reachable only by typing its URL. Three ways in now, and the item link is
// deliberately NOT tied to the 3D tab: most armor is texture-only and has no tab, which
// is exactly the gear you want to see on a character.
async function testEntryPoints() {
  await nav("");
  const home = await page.$$eval('.home a[href="?dressing"]', (a) => a.length);
  const menu = await page.$$eval('.nav-menu a[href="?dressing"], nav a[href="?dressing"]', (a) => a.length);
  await nav("?item=17581");                        // a plate chest: texture-only, no 3D tab
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  const chest = await page.$$eval(".item-dress a", (a) => a.map((x) => x.getAttribute("href")));
  await nav("?item=19382");                        // a ring changes nothing about the look
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  const ring = await page.$$eval(".item-dress a", (a) => a.length);
  console.log(`entry points: home=${home} menu=${menu} chest=${JSON.stringify(chest)} ring=${ring}`);
  return home >= 1 && menu >= 1 && chest[0] === "?dressing&chest=17581" && ring === 0;
}

smoke("dressing room is reachable without typing a URL", () => testEntryPoints());

// The appearance pickers are the character creator's, not a form's: race portraits,
// colour swatches, and steppers only where nothing can be previewed. Asserting "no
// <select> survives" is the point of the change, and the race icons must actually load --
// they are committed art served from the asset origin, so a wrong path is a silent
// blank tile rather than an error.
async function testPickers() {
  // Wait on TRIANGLES, never on `running`: the character is stationary by default, so the
  // render loop stops the moment it has drawn, and a test that waits for a running loop
  // is racing the frame it is waiting for (it lost about one full run in three).
  await nav("?dressing&race=1&sex=f&hair=1");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  // The portraits are real network images; under a loaded shard they are occasionally
  // still decoding when the model is ready, which failed the icon check rather than the
  // thing it is testing. Wait for them.
  await page.waitForFunction(
    () => [...document.querySelectorAll('.race-tile[data-key="race"] img')]
      .every((i) => i.complete && i.naturalWidth > 0), { timeout: T });
  const before = await page.evaluate(() => ({
    selects: document.querySelectorAll("#dress-bar select").length,
    tiles: document.querySelectorAll('.race-tile[data-key="race"]').length,
    swatches: document.querySelectorAll(".sw").length,
    steppers: document.querySelectorAll(".stepper").length,
    iconOk: [...document.querySelectorAll('.race-tile[data-key="race"] img')].every((i) => i.complete && i.naturalWidth > 0),
  }));
  // switching race must re-clamp: a tauren has option counts a human does not
  await page.click('.race-tile[data-val="6"]');
  await page.waitForFunction(() => location.search.includes("race=6"), { timeout: T });
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const after = await page.evaluate(() => ({
    pressed: document.querySelector('.race-tile[data-key="race"][aria-pressed="true"]')?.dataset.val,
    tris: window.__mv().triangles,
  }));
  console.log(`pickers: ${JSON.stringify(before)} -> race ${after.pressed}, ${after.tris} tris`);
  return before.selects === 0 && before.tiles === 10 && before.swatches > 5
    && before.steppers >= 2 && before.iconOk && after.pressed === "6" && after.tris > 0;
}

smoke("dressing room picks by portrait and swatch, not dropdown", () => testPickers());

// The action bar: a random look must produce a DIFFERENT, still-renderable character, and
// saving keeps the outfit as its URL (the URL already is the outfit).
async function testActions() {
  await nav("?dressing&race=1&sex=m&hair=1&chest=17581");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const first = await page.evaluate(() => location.search);
  await page.click("#dress-save");
  await page.waitForFunction(() => document.querySelectorAll(".outfit-chip").length === 1, { timeout: T });
  const chip = await page.$eval(".outfit-chip a", (a) => a.textContent.trim());
  await page.click("#dress-random");
  await page.waitForFunction((q) => location.search !== q, { timeout: T }, first);
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const rolled = await page.evaluate(() => location.search);
  // and the saved outfit is still one click away
  const chips = await page.$$eval(".outfit-chip", (e) => e.length);
  await page.evaluate(() => localStorage.removeItem("tw-outfits"));
  console.log(`actions: saved "${chip}", rolled ${rolled.slice(0, 60)}, chips=${chips}`);
  return chip.length > 0 && rolled !== first && chips === 1;
}

smoke("dressing room saves an outfit and rolls a random look", () => testActions());

// The room opens on a character facing the visitor and HOLDING STILL -- the page is about
// what an outfit looks like from the front, and a model that turns away on its own has to
// be caught and dragged back. Rotating is a control, not a default.
async function testViewControls() {
  await nav("?dressing&race=1&sex=f&hair=1&chest=17581");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  await new Promise((r) => setTimeout(r, 2500));
  const still = await page.evaluate(() => window.__mv());
  await page.click("#dress-spin");
  await new Promise((r) => setTimeout(r, 800));
  const turning = await page.evaluate(() => ({
    spinning: window.__mv().spinning,
    pressed: document.querySelector("#dress-spin").getAttribute("aria-pressed"),
  }));
  await page.click("#dress-spin");
  await new Promise((r) => setTimeout(r, 400));
  const stopped = await page.evaluate(() => window.__mv().spinning);
  // A screenshot with a background and one without must not be the same image: the canvas
  // itself is always transparent, so the opaque one is the composited version.
  const shots = await page.evaluate(() => {
    const a = window.__mv.snapshot({ background: false });
    const b = window.__mv.snapshot({ background: true });
    return { alpha: a.length, opaque: b.length, differ: a !== b, png: a.startsWith("data:image/png") };
  });
  console.log(`view: idle spinning=${still.spinning} running=${still.running}; toggle ${JSON.stringify(turning)} -> ${stopped}; shots ${JSON.stringify(shots)}`);
  return still.spinning === false && still.running === false
    && turning.spinning === true && turning.pressed === "true" && stopped === false
    && shots.differ && shots.png && shots.opaque > shots.alpha;
}

smoke("dressing room opens still, rotates on demand, screenshots both ways", () => testViewControls());

// A locked slot is one the dice must leave alone. Rolling several times is the test that
// matters: exclusion is by INVENTORY TYPE (a one-hander is inv 13 or 21), so missing one
// of a slot's types lets the dice through anyway.
async function testLocks() {
  await nav("?dressing&race=1&sex=f&hair=1&chest=17581");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  await page.click('.dress-slot[data-slot="chest"] .dress-lock');
  const pressed = await page.$eval('.dress-slot[data-slot="chest"] .dress-lock', (e) => e.getAttribute("aria-pressed"));
  for (let i = 0; i < 6; i++) {
    await page.click("#dress-item");
    await new Promise((r) => setTimeout(r, 700));
  }
  const after = await page.evaluate(() => {
    const q = new URLSearchParams(location.search);
    const skip = ["dressing", "race", "sex", "skin", "face", "hair", "hcolor", "facial"];
    return { chest: q.get("chest"), rolled: [...q.keys()].filter((k) => !skip.includes(k)) };
  });
  console.log(`locks: pressed=${pressed} chest=${after.chest} rolled=[${after.rolled}]`);
  return pressed === "true" && after.chest === "17581" && after.rolled.length > 2;
}

smoke("dressing room dice skips a locked slot", () => testLocks());

// Fullscreen must give the pane back exactly as it found it. three.js writes the size
// onto the canvas as an INLINE style unless told not to, and an inline style outranks the
// stylesheet that sizes the canvas to its pane -- so coming back the canvas kept the
// screen's height, overflowed the room and pushed the page apart.
async function testFullscreen() {
  await nav("?dressing&race=1&sex=f&hair=1&chest=17581");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const box = () => page.evaluate(() => {
    const w = document.querySelector(".mv-wrap").getBoundingClientRect();
    const c = document.querySelector("#mv-host canvas");
    return { w: Math.round(w.width), h: Math.round(w.height), buf: `${c.width}x${c.height}`,
      doc: document.documentElement.scrollHeight, fs: !!document.fullscreenElement };
  });
  const before = await box();
  await page.click("#dress-full");
  await new Promise((r) => setTimeout(r, 900));
  const during = await box();
  await page.evaluate(() => document.exitFullscreen()).catch(() => {});
  await new Promise((r) => setTimeout(r, 900));
  const after = await box();
  console.log(`fullscreen: ${JSON.stringify(before)} -> ${JSON.stringify(during)} -> ${JSON.stringify(after)}`);
  if (!during.fs) { console.log("  (this browser refused fullscreen; treating as n/a)"); return true; }
  return during.h > before.h && after.h === before.h && after.w === before.w
    && after.buf === before.buf && after.doc === before.doc;
}

smoke("dressing room fullscreen gives the pane back unchanged", () => testFullscreen());

// Every equip and every appearance change builds a NEW viewer, and the camera used to go
// back to three-quarters-front each time -- so comparing two hair colours from behind
// meant dragging the character round again after every click. The view is handed over.
async function testCameraSurvives() {
  await nav("?dressing&race=1&sex=f&hair=1&chest=17581");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const home = await page.evaluate(() => window.__mv.view());
  const box = await page.$eval("#mv-host", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 40, { steps: 12 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 900));
  const dragged = await page.evaluate(() => window.__mv.view());
  await page.click('.sw[data-key="hcolor"][data-val="4"]');
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  await new Promise((r) => setTimeout(r, 1200));
  const after = await page.evaluate(() => window.__mv.view());
  // Tight on purpose: view() settles the camera before handing it over, so "roughly the
  // same place" is not the bar -- a drift here means the handover read a coasting camera.
  const dist = (a, b) => Math.hypot(...a.off.map((n, i) => n - b.off[i]));
  console.log(`camera: home=${home.off.map((n) => n.toFixed(2))} dragged=${dragged.off.map((n) => n.toFixed(2))} after=${after.off.map((n) => n.toFixed(2))}`);
  // moved away from the default, and stayed there across the re-mount
  return dist(home, dragged) > 1 && dist(dragged, after) < 0.15;
}

smoke("dressing room keeps the camera across a re-mount", () => testCameraSurvives());

// Reset puts the camera and the model back where the room opened, and stops the
// turntable while it is at it -- a "reset" that leaves the model turning is not one.
// Empty slots wear the game's own paperdoll silhouette, which is a UI texture Blizzard's
// icon CDN refuses, so a wrong path here is a blank square rather than an error.
async function testResetAndSlotArt() {
  await nav("?dressing&race=1&sex=f&hair=1&chest=17581");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".slot-art")].every((i) => i.complete && i.naturalWidth > 0),
    { timeout: T });
  const art = await page.$$eval(".slot-art", (e) => e.length);
  const home = await page.evaluate(() => window.__mv.view());
  const box = await page.$eval("#mv-host", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 60, { steps: 10 });
  await page.mouse.up();
  await page.click("#dress-spin");                    // and leave it turning
  await new Promise((r) => setTimeout(r, 700));
  const moved = await page.evaluate(() => window.__mv.view());
  await page.click("#dress-reset");
  await new Promise((r) => setTimeout(r, 1400));      // damping has to settle
  const back = await page.evaluate(() => ({ view: window.__mv.view(), spinning: window.__mv().spinning }));
  const dist = (a, b) => Math.hypot(...a.off.map((n, i) => n - b.off[i]));
  console.log(`reset: art=${art} home=${home.off.map((n) => n.toFixed(2))} moved=${moved.off.map((n) => n.toFixed(2))} back=${back.view.off.map((n) => n.toFixed(2))} spinning=${back.spinning}`);
  return art > 10 && dist(home, moved) > 1 && dist(home, back.view) < 0.2 && back.spinning === false;
}

smoke("dressing room resets the view and shows empty-slot art", () => testResetAndSlotArt());

// What the appearance options are CALLED is per race, and the client says so (ChrRaces
// names a token, the glue strings give it text). A troll's option is Tusks, a night elf
// female's is Markings, a tauren's hair slider is Horns. Calling them all "Facial hair"
// sends people looking for a beard slider that does not exist.
async function testRaceLabels() {
  const seen = {};
  for (const [race, sex] of [[8, "m"], [6, "f"], [4, "f"], [1, "m"]]) {
    await nav(`?dressing&race=${race}&sex=${sex}&hair=1`);
    await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
    seen[`${race}${sex}`] = await page.$$eval(".stepper .val", (e) => e.map((x) => x.textContent.trim()));
  }
  console.log(`labels: ${JSON.stringify(seen)}`);
  return /Tusks/.test(seen["8m"].join()) && /Horns/.test(seen["6f"].join())
    && /Markings/.test(seen["4f"].join()) && /Facial Hair/i.test(seen["1m"].join());
}

smoke("dressing room names each race's options as the game does", () => testRaceLabels());

// Shape and paint are TWO choices on some races and one on others. A troll's fourteen
// "tusk" variations are five tusk shapes and nine war paints, and the game picks one of
// each; a human's nine beards are nine beards. Both halves are asserted, because getting
// this wrong in either direction is invisible until you look at a face.
async function testFacialSplit() {
  await nav("?dressing&race=8&sex=m&hair=1&facial=0&paint=0");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const troll = await page.$$eval(".stepper .val", (e) => e.map((x) => x.textContent.trim()));
  const g0 = await page.evaluate(() => window.__mv().geosets.join(","));
  // paint alone: the geosets must not move
  await nav("?dressing&race=8&sex=m&hair=1&facial=0&paint=7");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const gPaint = await page.evaluate(() => window.__mv().geosets.join(","));
  // shape alone: they must
  await nav("?dressing&race=8&sex=m&hair=1&facial=4&paint=7");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const gShape = await page.evaluate(() => window.__mv().geosets.join(","));
  await nav("?dressing&race=1&sex=m&hair=1");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const human = await page.$$eval(".stepper .val", (e) => e.map((x) => x.textContent.trim()));
  console.log(`split: troll=[${troll.join(" | ")}] human=[${human.join(" | ")}] paintOnly=${g0 === gPaint} shapeMoved=${g0 !== gShape}`);
  return troll.length === 4 && /Tusks/.test(troll[2]) && /paint/i.test(troll[3])
    && g0 === gPaint && g0 !== gShape
    && human.length === 3 && /Facial Hair/i.test(human[2]);
}

smoke("dressing room separates tusk shape from war paint", () => testFacialSplit());

// A tauren has no texType 6 unit at all: its horns, tail and hoof soles hang off an
// UNNAMED type 8, which is the only such unit on any race (everyone else's type 8 names
// its own file, for an eye glow). Falling through to the body atlas painted those meshes
// from the atlas's FACE rectangle, so a tauren wore a smeared second copy of its own face
// above the horns. The check is that every drawn submesh resolved a texture and that the
// horn slider still moves geometry.
async function testTaurenMane() {
  await nav("?dressing&race=6&sex=m&hair=3");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const st = await page.evaluate(() => window.__mv());
  // drawn rows are [geoset, texType, blend, hasTexture]
  const untextured = st.drawn.filter((d) => !d[3]).map((d) => d[0]);
  const type8 = st.drawn.filter((d) => d[1] === 8).length;
  await nav("?dressing&race=6&sex=m&hair=8");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const moved = await page.evaluate(() => window.__mv().geosets.join(",")) !== st.geosets.join(",");
  console.log(`tauren: type8 submeshes=${type8} untextured=[${untextured}] hornsMove=${moved}`);
  return type8 > 0 && untextured.length === 0 && moved;
}

smoke("tauren horns take the mane texture, not the face", () => testTaurenMane());

// The slot picker opens DOWNWARD from the slot it is anchored to, which puts the results
// below the fold for the slots at the bottom of the rail -- you type a weapon's name and
// cannot see what you found. It flips up when there is more room above, and is capped to
// the space it has either way.
async function testPickerPlacement() {
  await nav("?dressing&race=1&sex=m&hair=1");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const open = async (slot, term) => {
    await page.click(`.dress-slot[data-slot="${slot}"]`);
    await page.type("#dress-find", term, { delay: 12 });
    await page.waitForFunction(() => document.querySelectorAll("#dress-hits .sd-row").length > 0, { timeout: T });
    await new Promise((r) => setTimeout(r, 350));
    const m = await page.evaluate(() => {
      const el = document.querySelector("#dress-pop");
      const r = el.getBoundingClientRect();
      return { up: el.classList.contains("up"), top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight };
    });
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 150));
    return { ...m, onScreen: m.top >= 0 && m.bottom <= m.vh };
  };
  const head = await open("head", "helm");
  const ranged = await open("ranged", "bow");
  console.log(`picker: head=${JSON.stringify(head)} ranged=${JSON.stringify(ranged)}`);
  return head.onScreen && ranged.onScreen && head.up === false && ranged.up === true;
}

smoke("dressing room picker stays on screen for the bottom slots", () => testPickerPlacement());

// A helm hides what it covers. The client keeps that in HelmetGeosetVisData -- five
// bitmasks per helm style (hair, the three facial groups, ears) where a set bit means
// "covered, do not draw" -- and without it a hood renders with the hair through the cloth.
// Two things this pins: the bit index is the GEOSET number, not the picker's variation,
// and geoset 0 is the BODY, which shares group 0 with the hair and must never be hidden
// (the mask has bit 0 set on most full helms; obeying it deleted the whole character).
async function testHelmetHides() {
  const at = async (url) => {
    await nav(url);
    await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
    return page.evaluate(() => window.__mv().geosets);
  };
  const bare = await at("?dressing&race=1&sex=m&hair=3&facial=4");
  const helmed = await at("?dressing&race=1&sex=m&hair=3&facial=4&head=1024");   // hides hair + facial
  const headband = await at("?dressing&race=1&sex=f&hair=5&head=1");             // hides nothing
  const g = (list, group) => list.filter((x) => Math.floor(x / 100) === group);
  console.log(`helmvis: bare=[${bare}] helmed=[${helmed}] headband=[${headband}]`);
  return bare.includes(0) && helmed.includes(0)              // the body survives
    && g(bare, 1).length > 0 && g(helmed, 1).length === 0     // facial hair covered
    && bare.includes(4) && !helmed.includes(4)                // the hairstyle covered
    && helmed.includes(701) && !helmed.includes(702)          // ears give way to the bare head
    && headband.includes(7) && headband.includes(702);        // and a headband covers nothing
}

smoke("a helm hides the hair and beard it covers", () => testHelmetHides());

// ...but only what is actually facial HAIR. Groups 1-3 are not facial hair on every race:
// Turtle reuses them for head SHAPES on goblins, and a goblin female's head is geoset 103,
// so obeying a helm's beard mask deleted her face and left the hair and mask floating over
// nothing. The discriminator is art: her 103 paints no texture, while a goblin MALE's 103
// is a moustache and does, so his is covered and hers is not.
async function testHelmetKeepsHeads() {
  const at = async (url) => {
    await nav(url);
    await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
    return page.evaluate(() => window.__mv().geosets);
  };
  const fBare = await at("?dressing&race=9&sex=f&face=5&hair=3&facial=1");
  const fHelm = await at("?dressing&race=9&sex=f&face=5&hair=3&facial=1&head=81007");
  const mBare = await at("?dressing&race=9&sex=m&hair=2&facial=1");
  const mHelm = await at("?dressing&race=9&sex=m&hair=2&facial=1&head=1024");
  console.log(`goblin: f ${fBare} -> ${fHelm} | m ${mBare} -> ${mHelm}`);
  return fBare.includes(103) && fHelm.includes(103)          // her head survives the mask
    && mBare.includes(103) && !mHelm.includes(103);          // his moustache does not
}

smoke("a helm covers a goblin's moustache but not her head", () => testHelmetKeepsHeads());

// A robe paints AFTER the legs: its skirt covers them, which is what the robe geoset is
// for. Filed under the chest's usual paint slot, a pair of trousers painted over the skirt
// the robe had just drawn and the legs won. Asserted by pixels rather than by order --
// wearing trousers under a robe must render exactly the same as wearing none.
async function testRobeOverLegs() {
  const shot = async (url) => {
    await nav(url);
    await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
    await new Promise((r) => setTimeout(r, 400));
    return page.evaluate(() => window.__mv.snapshot({ background: false }));
  };
  const robeOnly = await shot("?dressing&race=1&sex=m&hair=3&chest=51848");
  const withLegs = await shot("?dressing&race=1&sex=m&hair=3&chest=51848&legs=6568");
  const legsOnly = await shot("?dressing&race=1&sex=m&hair=3&legs=6568");
  console.log(`robe: covered=${robeOnly === withLegs} legsDiffer=${robeOnly !== legsOnly}`);
  // the second half of the check guards the first: if the viewer rendered nothing at all,
  // every snapshot would match and "covered" would pass for the wrong reason.
  return robeOnly === withLegs && robeOnly !== legsOnly;
}

smoke("a robe covers the trousers under it", () => testRobeOverLegs());

// On a phone the two rails cannot stand beside the model, and stacking them in source
// order buried it under fourteen slot rows: you scrolled PAST the character to change it,
// then back up to see the result. The model leads and stays put, and tabs swap which rail
// is under it. (beforeEach resets the viewport, so the phone size does not leak.)
async function testPhoneLayout() {
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await nav("?dressing&race=9&sex=f&hair=3&head=81007&chest=10399&legs=10400");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const m = await page.evaluate(() => {
    const stage = document.querySelector(".mv-wrap").getBoundingClientRect();
    const slot = document.querySelector(".dress-slot").getBoundingClientRect();
    return { stageTop: Math.round(stage.top), slotTop: Math.round(slot.top),
      tabs: getComputedStyle(document.querySelector(".dress-tabs")).display,
      sticky: getComputedStyle(document.querySelector(".mv-wrap")).position,
      xOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      doc: document.documentElement.scrollHeight };
  });
  // switching to Appearance must hide the gear rail rather than stack it
  await page.click('.dress-tab[data-pane="look"]');
  await new Promise((r) => setTimeout(r, 250));
  const swapped = await page.evaluate(() => ({
    gear: getComputedStyle(document.querySelector(".dress-col-l")).display,
    look: getComputedStyle(document.querySelector(".dress-bar")).display,
  }));
  console.log(`phone: ${JSON.stringify(m)} swapped=${JSON.stringify(swapped)}`);
  return m.stageTop < m.slotTop && m.tabs !== "none" && m.sticky === "sticky"
    && !m.xOverflow && swapped.gear === "none" && swapped.look !== "none";
}

smoke("dressing room puts the model first on a phone", () => testPhoneLayout());

// A slot paints only ITS OWN regions of the body atlas. ItemDisplayInfo hands out eight
// component textures per row and a tier piece routinely carries the whole set's pack --
// Dreadnaught Gauntlets name all eight, the Helmet names a chest and a trouser texture --
// so painting every one of them re-skinned the torso and legs the moment a helmet went on.
async function testSlotPaintsItsOwnRegions() {
  const shot = async (url) => {
    await nav(url);
    await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
    await new Promise((r) => setTimeout(r, 400));
    return page.evaluate(() => window.__mv.snapshot({ background: false }));
  };
  const bare = await shot("?dressing&race=1&sex=m&hair=1");
  const helmed = await shot("?dressing&race=1&sex=m&hair=1&head=22418");
  const gloved = await shot("?dressing&race=1&sex=m&hair=1&hands=22421");
  // A helm and a glove must each change the picture -- and the body underneath must be
  // the same in both, which it is not if either painted the torso from its stale pack.
  const chest = async (url) => {
    await nav(url);
    await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
    await new Promise((r) => setTimeout(r, 400));
    // sample the torso from the composited atlas: same skin means no bleed
    return page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const ctx = c.getContext("2d");
      const src = document.querySelector("#mv-host canvas");
      ctx.drawImage(src, 0, 0, 256, 256);
      const d = ctx.getImageData(128, 90, 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    });
  };
  const bareChest = await chest("?dressing&race=1&sex=m&hair=1");
  const helmChest = await chest("?dressing&race=1&sex=m&hair=1&head=22418");
  console.log(`regions: helmChanged=${bare !== helmed} gloveChanged=${bare !== gloved} torso ${bareChest} -> ${helmChest}`);
  return bare !== helmed && bare !== gloved && bareChest === helmChest;
}

smoke("a slot paints only its own regions of the body", () => testSlotPaintsItsOwnRegions());
