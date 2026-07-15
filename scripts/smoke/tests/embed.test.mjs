import { page, nav, load, T, smoke } from "../harness.mjs";

// Embeddable powered tooltip: the demo page loads embed/tw-power.js which, on hover
// over a DB link, fetches the entity's JSON from the public API and injects its
// rendered `tooltipHtml` (the full in-game card) as a floating tooltip.
async function testEmbedTooltip() {
  await load("embed/demo.html");
  await page.waitForSelector('a[href="../?item=2770"]', { timeout: T });
  await (await page.$('a[href="../?item=2770"]')).hover();
  await page.waitForSelector(".twp-tip.on", { timeout: T });
  const txt = await page.$eval(".twp-tip", (e) => e.textContent);
  const iconSrc = await page.$eval(".twp-tip .tt-icon", (e) => e.getAttribute("src")).catch(() => null);
  // also prove a different entity kind (spell) tooltips + the stub-link form
  await (await page.$('a[href="../?spell=133"]')).hover();
  await page.waitForFunction(() => /Fireball/.test((document.querySelector(".twp-tip.on") || {}).textContent || ""), { timeout: T });
  const spellTxt = await page.$eval(".twp-tip", (e) => e.textContent);
  console.log(`embed-tooltip: item="${txt.slice(0, 30)}" icon=${iconSrc ? iconSrc.split("/").pop() : "none"} spell="${spellTxt.slice(0, 20)}"`);
  return /Copper Ore/.test(txt) && !!iconSrc && /inv_ore_copper_01/i.test(iconSrc) && /Fireball/.test(spellTxt);
}

smoke("embed tooltip", () => testEmbedTooltip());
