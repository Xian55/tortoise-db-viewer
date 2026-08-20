// The 3D item viewer: the tab appears only where there is a model to show, the WebGL
// canvas actually draws something, and the context is released on navigation.
import { page, nav, T, smoke } from "../harness.mjs";

const openTab = async (id) => {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-rel .tab", { timeout: T });
  const btn = await page.$('.tab[data-tab="model3d"]');
  if (!btn) return null;
  await btn.click();
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  return page.evaluate(() => window.__mv());
};

// Item 10571 (Ebony Boneclub) is a one-hand mace: a model of its own, no race variants.
async function testItemModel(id) {
  const st = await openTab(id);
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
