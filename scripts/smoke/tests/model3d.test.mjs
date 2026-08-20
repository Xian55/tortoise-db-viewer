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
async function testNoTabWithoutModel(...ids) {
  const found = [];
  for (const id of ids) {
    await nav(`?item=${id}`);
    await page.waitForSelector(".item-rel .tab", { timeout: T });
    if (await page.$('.tab[data-tab="model3d"]')) found.push(id);
  }
  console.log(`model3d no-tab: offered for ${found.length ? found.join(", ") : "none"} (want none)`);
  return found.length === 0;
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
smoke("model3d no tab for texture-only 7457 / per-race helm 83216", () => testNoTabWithoutModel(7457, 83216));
smoke("model3d releases its WebGL context on navigation", () => testContextReleased(10571));

// ---- dressing room (?dressing) -------------------------------------------------

async function testDressingRoom(race, sex) {
  await nav(`?dressing&race=${race}&sex=${sex}&hair=1`);
  await page.waitForSelector("#mv-host canvas", { timeout: T });
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const st = await page.evaluate(() => window.__mv());
  const pickers = await page.$$eval(".dress-pick select", (e) => e.map((s) => s.dataset.key));
  console.log(`dressing ${race}-${sex}: tris=${st.triangles} meshes=${st.meshes} geosets=[${st.geosets}] pickers=[${pickers}]`);
  return st.triangles > 0 && st.meshes > 1 && pickers.includes("race") && pickers.includes("sex");
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
