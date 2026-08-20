// "Open in" (other WoW databases) + the in-game chat-link macro.
// See src/external.js: which sites cover which entity kinds, and why a Turtle-custom
// entity is greyed on Wowhead rather than linked into a 404.
import { page, nav, T, smoke } from "../harness.mjs";

async function openMenu(url) {
  await nav(url);
  await page.waitForSelector(".xt-wrap .xt-btn", { timeout: T });
  await page.click(".xt-wrap .xt-btn");
  await page.waitForSelector(".xt-menu:not([hidden])", { timeout: T });
  return page.$$eval(".xt-menu .xt-item", (els) => els.map((e) => ({
    label: e.querySelector(".xt-name").textContent.trim(),
    host: e.querySelector(".xt-host").textContent.trim(),
    href: e.tagName === "A" ? e.getAttribute("href") : null,
    off: e.classList.contains("xt-off"),
  })));
}

// A plain vanilla item is on all four sites, each with its own URL shape.
async function testExternalItem(id) {
  const rows = await openMenu(`?item=${id}`);
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  const ok = rows.length === 4
    && by["Wowhead"].href === `https://www.wowhead.com/classic/item=${id}`
    && by["TurtleDB"].href === `https://turtledb.cthuly.com/site/item/${id}.html`
    && by["OctoWow"].href === `https://octowow.st/db/?item=${id}`
    && by["WoW Classic DB"].href === `https://wowclassicdb.com/item/${id}`
    && rows.every((r) => !r.off);
  console.log(`external item ${id}: ${JSON.stringify(rows.map((r) => r.label + "=" + r.href))} ok=${ok}`);
  return ok;
}

// Turtle-aware sites lead on a Turtle dataset -- they're the ones that hold the content.
async function testExternalOrder(id) {
  const rows = await openMenu(`?item=${id}`);
  const order = rows.map((r) => r.label);
  const ok = order[0] === "TurtleDB" && order[1] === "OctoWow";
  console.log(`external order: [${order.join(", ")}] ok=${ok}`);
  return ok;
}

// A Turtle-custom entity is NOT on Wowhead. Those rows stay, greyed, with the reason --
// silently shortening the menu would just look like a bug.
async function testExternalCustom(id) {
  const rows = await openMenu(`?item=${id}`);
  const off = rows.filter((r) => r.off).map((r) => r.label);
  const live = rows.filter((r) => !r.off).map((r) => r.label);
  const reason = (rows.find((r) => r.off) || {}).host;
  const ok = off.includes("Wowhead") && off.includes("WoW Classic DB")
    && live.includes("TurtleDB") && live.includes("OctoWow")
    && /vanilla/.test(reason || "");
  console.log(`external custom ${id}: off=[${off.join(",")}] live=[${live.join(",")}] reason="${reason}" ok=${ok}`);
  return ok;
}

// A site with no page for the KIND is dropped, not greyed: TurtleDB/OctoWow have no
// zone pages, and a permanently-dead row on every zone page says nothing about the zone.
async function testExternalZone(id) {
  const rows = await openMenu(`?zone=${id}`);
  const labels = rows.map((r) => r.label);
  const chat = (await page.$(".xt-chat")) !== null;
  const ok = rows.length === 2 && labels.includes("Wowhead") && labels.includes("WoW Classic DB") && !chat;
  console.log(`external zone ${id}: [${labels.join(", ")}] chatBtn=${chat} ok=${ok}`);
  return ok;
}

// Escape closes the menu (and the click-away/Escape handlers are module-level, so this
// also proves they act on whichever menu is currently open after an SPA re-render).
async function testExternalClose() {
  await openMenu("?item=2770");
  await page.keyboard.press("Escape");
  const hidden = await page.$eval(".xt-menu", (e) => e.hidden);
  const expanded = await page.$eval(".xt-btn", (e) => e.getAttribute("aria-expanded"));
  console.log(`external close: hidden=${hidden} aria-expanded=${expanded}`);
  return hidden === true && expanded === "false";
}

// The in-game chat link. The clipboard is permission-gated in headless Chrome, so the
// macro is asserted from data-macro -- which is the same string the button copies.
// Payload shape is 1.12's four-field item link, NOT the 14-field retail one Wowhead
// Classic emits, and the colour is the item's real quality colour.
async function testChatMacro(url, expect) {
  await nav(url);
  await page.waitForSelector(".xt-chat", { timeout: T });
  const macro = await page.$eval(".xt-chat", (e) => e.dataset.macro);
  const ok = macro === expect && macro.length <= 255;
  console.log(`chat macro ${url}: len=${macro.length}\n  got  ${macro}\n  want ${expect}\n  ok=${ok}`);
  return ok;
}

// An NPC has no in-game chat-link form at all, so no button (rather than one that
// copies something the client can't resolve).
async function testNoChatMacro(url) {
  await nav(url);
  await page.waitForSelector(".xt-wrap", { timeout: T });
  const chat = (await page.$(".xt-chat")) !== null;
  console.log(`chat macro absent ${url}: chatBtn=${chat}`);
  return !chat;
}

// A random-suffix item gets a per-suffix copy button carrying that suffix's MAX roll
// (within a name the ids are stat permutations, not tiers).
async function testSuffixChat(id, suffix) {
  await nav(`?item=${id}`);
  await page.waitForSelector(".item-suffixes .suf-chat", { timeout: T });
  const rows = await page.$$eval(".item-suffixes li", (lis) => lis.map((li) => ({
    name: li.querySelector(".suf-name").textContent.trim(),
    ench: Number(li.querySelector(".suf-chat")?.dataset.ench || 0),
    suf: li.querySelector(".suf-chat")?.dataset.suf,
  })));
  const bear = rows.find((r) => r.name === suffix);
  const ok = rows.length > 1 && rows.every((r) => r.ench > 0) && !!bear && bear.suf === suffix;
  console.log(`suffix chat ${id}: rows=${rows.length} "${suffix}"=${JSON.stringify(bear)} ok=${ok}`);
  return ok;
}

smoke("external item 2770", () => testExternalItem(2770));
smoke("external order turtle-first", () => testExternalOrder(2770));
smoke("external custom 55057", () => testExternalCustom(55057));
smoke("external zone 12", () => testExternalZone(12));
smoke("external menu closes", () => testExternalClose());
// The macro's pipes are the literal three characters T (see external.js: `|` cannot be
// typed into a chat command). Built from a char code so no escaping layer can halve it.
const P = String.fromCharCode(92) + "124";
const macroOf = (hex, body, name) =>
  `/script DEFAULT_CHAT_FRAME:AddMessage("${P}cff${hex}${P}${body}${P}h[${name}]${P}h${P}r");`;

smoke("chat macro item 10089", () => testChatMacro("?item=10089",
  macroOf("1eff00", "Hitem:10089:0:0:0", "Gothic Sabatons")));
smoke("chat macro spell 13439", () => testChatMacro("?spell=13439",
  macroOf("71d5ff", "Hspell:13439", "Frostbolt")));
smoke("chat macro quest 107", () => testChatMacro("?quest=107",
  macroOf("ffff00", "Hquest:107:6", "Note to William")));
smoke("chat macro absent on npc", () => testNoChatMacro("?npc=11868"));
smoke("suffix chat 10089", () => testSuffixChat(10089, "of the Bear"));
