// "Open in ▾" — the same entity on the other WoW databases.
//
// Four sites, and they do NOT cover the same game. Two of them (TurtleDB, OctoWow)
// index Turtle-WoW and resolve Turtle's own ids; two (Wowhead, WoW Classic DB) index
// retail Classic and have never heard of anything Turtle added. An entry id is not a
// shared namespace, so a link that merely LOOKS plausible is the failure mode here:
// Wowhead would happily 404, and on a TBC dataset a TurtleDB link would answer about
// a different game entirely. Hence the two rules below (`turtle`, and the custom flag).
import { CORE, EXPANSION } from "./config.js";
import { esc, qualityColor } from "./render.js";

// Wowhead serves a separate database per expansion under a branch segment. Same value
// as config's WEBTHUMB_BRANCH today, deliberately not imported from it: that constant
// is about model thumbnails, and the two would have to be untangled the moment either
// grew a case the other doesn't share.
const WH_BRANCH = EXPANSION === "tbc" ? "tbc" : "classic";
// WoW Classic DB nests its later expansions under a path prefix (routes read off its
// own SPA bundle: /item/:id, /tbc/…, /wotlk/…).
const WCDB_PREFIX = EXPANSION === "tbc" ? "tbc/" : "";

// `paths` maps OUR route param to the site's own name for that entity — the spelling
// differs more than you'd guess (item-set vs itemset), and a site that simply has no
// page for a kind is expressed by leaving the key out.
//
// `turtle: true` = indexes Turtle-WoW. Those sites are offered ONLY on a Turtle
// dataset; elsewhere they're not "missing this entity", they're the wrong game.
const SITES = [
  {
    id: "turtledb", label: "TurtleDB", host: "turtledb.cthuly.com", turtle: true,
    paths: { item: "item", npc: "npc", quest: "quest", spell: "spell", object: "object", faction: "faction", itemset: "itemset" },
    href: (p, id) => `https://turtledb.cthuly.com/site/${p}/${id}.html`,
  },
  {
    id: "octowow", label: "OctoWow", host: "octowow.st", turtle: true,
    // An aowow instance: entities live on the query string, and the /db/path=id form
    // silently serves the homepage instead of 404ing.
    paths: { item: "item", npc: "npc", quest: "quest", spell: "spell", object: "object", faction: "faction", itemset: "itemset" },
    href: (p, id) => `https://octowow.st/db/?${p}=${id}`,
  },
  {
    id: "wowhead", label: "Wowhead", host: "wowhead.com", turtle: false,
    paths: { item: "item", npc: "npc", quest: "quest", spell: "spell", object: "object", zone: "zone", faction: "faction", itemset: "item-set" },
    href: (p, id) => `https://www.wowhead.com/${WH_BRANCH}/${p}=${id}`,
  },
  {
    id: "wowclassicdb", label: "WoW Classic DB", host: "wowclassicdb.com", turtle: false,
    paths: { item: "item", npc: "npc", quest: "quest", spell: "spell", object: "object", zone: "zone", faction: "faction", itemset: "item-set" },
    href: (p, id) => `https://wowclassicdb.com/${WCDB_PREFIX}${p}/${id}`,
  },
];

// Only these three carry a build-time `custom` flag (see build-db's vanilla-ids work).
// A Turtle-custom SPELL is just as absent from Wowhead, but we have no flag saying so
// and the id-range guess it would take is exactly what that flag replaced -- so those
// kinds are offered everywhere rather than greyed on a hunch.
export const CUSTOM_KINDS = { item: "items", npc: "creatures", quest: "quests" };

// Turtle-aware sites first on a Turtle dataset (they're the ones that actually hold the
// content), Wowhead-side first everywhere else. Stable within each half.
function ranked() {
  const mine = CORE === "turtle";
  return SITES.filter((s) => !s.turtle || mine)
    .map((s, i) => [s, (s.turtle === mine ? 0 : 1) * 100 + i])
    .sort((a, b) => a[1] - b[1])
    .map(([s]) => s);
}

// One row per offered site: { label, href, reason }.
//
// The two ways a site can be unavailable are deliberately NOT treated alike. A site with
// no page for this KIND at all (TurtleDB has no zones) is dropped -- it would sit greyed
// on every single zone page saying nothing about this zone. A site that has the kind but
// provably not THIS entity (a Turtle-custom item on Wowhead) is kept and greyed with the
// reason: that is a fact about the thing you are looking at, and silently shortening the
// menu would leave you wondering where the Wowhead link went.
export function externalLinks(kind, id, custom = false) {
  return ranked().flatMap((s) => {
    const p = s.paths[kind];
    if (!p) return [];
    if (custom && !s.turtle) return [{ label: s.label, href: null, reason: "not in vanilla 1.12" }];
    return [{ label: s.label, href: s.href(p, id), reason: s.host }];
  });
}

// null when no site covers this kind, so the caller can skip the button entirely.
export function externalMenuHtml(kind, id, custom = false) {
  const links = externalLinks(kind, id, custom);
  if (!links.length) return null;
  const rows = links.map((l) => l.href
    ? `<a class="xt-item" role="menuitem" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">
         <span class="xt-name">${esc(l.label)}</span><span class="xt-host">${esc(l.reason)}</span></a>`
    : `<span class="xt-item xt-off" role="menuitem" aria-disabled="true">
         <span class="xt-name">${esc(l.label)}</span><span class="xt-host">${esc(l.reason)}</span></span>`).join("");
  return `<div class="xt-wrap">
    <button type="button" class="share-btn xt-btn" aria-haspopup="true" aria-expanded="false"
      title="Open this ${esc(kind)} on another WoW database">🌐 Open in ▾</button>
    <div class="xt-menu" role="menu" hidden>${rows}</div>
  </div>`;
}

// ---- in-game chat link ("/script ... AddMessage") ----
//
// Only three kinds are linkable in the 1.12 / 2.4.3 client at all; an NPC, object, zone
// or faction has no chat-link form, so no button is offered for those.
//
// The `\124` escapes are not decoration: `|` cannot be typed into a chat command (the
// client strips it), so the pasteable form is a /script that rebuilds the pipes.
//
// TWO deliberate differences from the macro Wowhead Classic hands out:
//
//  * Wowhead emits the RETAIL item payload -- `Hitem:2536::::::::60:::::`, 14 fields --
//    out of its shared generator. A 1.12 client's SetItemRef parses exactly FOUR
//    (`item:id:enchant:suffix:unique`) and TBC's eight (four gem slots inserted before
//    the suffix), so Wowhead's string does not resolve on the clients this site is
//    about. We emit the payload for the ACTIVE dataset's expansion.
//  * Wowhead colours every link white. The client itself colours an item by quality and
//    a spell 71d5ff, which is what a link pasted out of the game actually looks like.
// `suffix` is the rolled ItemRandomProperties id ("of the Bear"), which the client reads
// out of the link and turns back into the suffix name + its stats. It sits in a DIFFERENT
// slot per expansion: 1.12 is id:enchant:suffix:unique, TBC inserts four gem sockets in
// between. Zero = the plain, unrolled item.
const ITEM_PAYLOAD = EXPANSION === "tbc"
  ? (id, suffix) => `Hitem:${id}:0:0:0:0:0:${suffix}:0`
  : (id, suffix) => `Hitem:${id}:0:${suffix}:0`;
const CHAT = {
  item: (id, r, suffix) => ({ hex: qualityColor(r.quality), body: ITEM_PAYLOAD(id, suffix) }),
  quest: (id, r) => ({ hex: "#ffff00", body: `Hquest:${id}:${r.level || 0}` }),
  spell: (id) => ({ hex: "#71d5ff", body: `Hspell:${id}` }),
};

// The client's chat/macro edit box caps at 255 characters, and it TRUNCATES rather than
// refusing -- a macro cut mid-payload pastes as visible garbage. The fixed part runs
// ~90-100 chars so a real name never gets close, but the only part that can be shortened
// safely is the bracket text (cosmetic; the Hitem:/Hquest:/Hspell: payload is what makes
// it clickable), so that is what gives if a name ever does.
export const CHAT_MAX = 255;

// `suffix` (items only) links a specific random-suffix roll; the display name must then
// carry the suffix too, since the bracket text is literal.
export function chatMacro(kind, id, row, suffix = 0) {
  const f = CHAT[kind];
  if (!f || !row || !row.name) return null;
  const { hex, body } = f(Number(id), row, Number(suffix) || 0);
  // A literal double quote would close the Lua string mid-macro. No 1.12 name carries
  // one, but this is pasted straight into a client, so don't lean on that.
  const clean = String(row.name).replace(/\\/g, "").replace(/"/g, '\\"');
  const build = (nm) => `/script DEFAULT_CHAT_FRAME:AddMessage("\\124cff${String(hex).replace("#", "")}\\124${body}\\124h[${nm}]\\124h\\124r");`;
  let out = build(clean);
  if (out.length > CHAT_MAX) {
    const room = clean.length - (out.length - CHAT_MAX) - 1;
    out = build(room > 0 ? clean.slice(0, room) + "…" : "");
  }
  return out;
}

// Copies on click, same affordance as the Share button. The macro rides in data-macro
// rather than a closure so there is ONE copy of it -- the clipboard is permission-gated
// in headless Chrome, so that attribute is also the only way to assert the exact string
// in the smoke suite.
export function chatButtonHtml(macro) {
  return `<button type="button" class="share-btn xt-chat" data-macro="${esc(macro)}"
    title="Copy a /script macro that prints this as a clickable in-game chat link">\u{1F4AC} Chat link</button>`;
}
export function wireChatButton(btn) {
  btn.addEventListener("click", async () => {
    const was = btn.textContent;
    try { await navigator.clipboard.writeText(btn.dataset.macro); btn.textContent = "✓ Macro copied"; }
    catch { btn.textContent = "Copy failed"; }
    setTimeout(() => { btn.textContent = was; }, 1600);
  });
}

// Click to open, click-away / Escape to close, one open at a time.
//
// The document-level handlers are installed ONCE for the module, not per menu: this
// wires on every detail render, so per-instance listeners would pile up for the life
// of the SPA session. They act on whichever menu is currently open.
let openWrap = null;
function closeOpen() {
  if (!openWrap) return;
  openWrap.querySelector(".xt-menu").hidden = true;
  openWrap.querySelector(".xt-btn").setAttribute("aria-expanded", "false");
  openWrap = null;
}
let docWired = false;
function wireDocOnce() {
  if (docWired) return;
  docWired = true;
  // Click-away closes -- including a click on a link INSIDE the menu: that tab opens
  // in the background, and leaving the menu hanging open over the page reads as a
  // failed click.
  document.addEventListener("click", closeOpen);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeOpen(); });
}

export function wireExternalMenu(wrap) {
  wireDocOnce();
  const btn = wrap.querySelector(".xt-btn");
  const menu = wrap.querySelector(".xt-menu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();               // else the document handler shuts it again
    const wasOpen = openWrap === wrap;
    closeOpen();
    if (wasOpen) return;
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    openWrap = wrap;
  });
}
