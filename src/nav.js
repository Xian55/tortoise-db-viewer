// Top-bar mega-menu: a data-driven, wowhead-style flyout. The tree below maps to
// the existing browse filters (?browse=...&class=&subclass=&slot=&type=&prof=&cont=).
// buildNavHtml() renders nested <ul>s; CSS opens them on hover (desktop) and
// wireNav() toggles them on tap (mobile). Leaf <a class="nav"> links ride the
// global SPA-nav handler in main.js.
import { CREATURE_TYPE, PROFESSION, CONTINENT, CLASS_MASK, SPELL_SCHOOL, SPELL_CATEGORIES } from "./constants.js";
import { esc } from "./render.js";

const item = (qs) => `?browse=items&${qs}`;

// Weapons grouped by hand (the group link multi-selects its subclasses; each leaf
// is one subclass). WEAPON_SUBCLASS collapses 1H/2H labels, so name leaves here.
const WEAPONS = {
  label: "Weapons", href: item("class=2"),
  children: [
    { label: "One-Handed", href: item("class=2&subclass=0,4,7,13,15"), children: [
      { label: "One-Handed Axes", href: item("class=2&subclass=0") },
      { label: "One-Handed Maces", href: item("class=2&subclass=4") },
      { label: "One-Handed Swords", href: item("class=2&subclass=7") },
      { label: "Daggers", href: item("class=2&subclass=15") },
      { label: "Fist Weapons", href: item("class=2&subclass=13") },
      { label: "Miscellaneous", href: item("class=2&subclass=14") },
    ] },
    { label: "Two-Handed", href: item("class=2&subclass=1,5,8,6,10"), children: [
      { label: "Two-Handed Axes", href: item("class=2&subclass=1") },
      { label: "Two-Handed Maces", href: item("class=2&subclass=5") },
      { label: "Two-Handed Swords", href: item("class=2&subclass=8") },
      { label: "Polearms", href: item("class=2&subclass=6") },
      { label: "Staves", href: item("class=2&subclass=10") },
    ] },
    { label: "Ranged", href: item("class=2&subclass=2,3,18,16,19"), children: [
      { label: "Bows", href: item("class=2&subclass=2") },
      { label: "Crossbows", href: item("class=2&subclass=18") },
      { label: "Guns", href: item("class=2&subclass=3") },
      { label: "Thrown", href: item("class=2&subclass=16") },
      { label: "Wands", href: item("class=2&subclass=19") },
    ] },
    { label: "Fishing Poles", href: item("class=2&subclass=20") },
  ],
};

const ARMOR_SLOTS = [
  ["Head", 1], ["Neck", 2], ["Shoulder", 3], ["Shirt", 4], ["Chest", 5], ["Waist", 6],
  ["Legs", 7], ["Feet", 8], ["Wrist", 9], ["Hands", 10], ["Finger", 11], ["Trinket", 12],
  ["Back", 16], ["Tabard", 19], ["Held In Off-hand", 23], ["Relic", 28],
];
const ARMOR = {
  label: "Armor", href: item("class=4"),
  children: [
    { label: "Cloth", href: item("class=4&subclass=1") },
    { label: "Leather", href: item("class=4&subclass=2") },
    { label: "Mail", href: item("class=4&subclass=3") },
    { label: "Plate", href: item("class=4&subclass=4") },
    { label: "Shields", href: item("class=4&subclass=6") },
    { label: "Librams", href: item("class=4&subclass=7") },
    { label: "Idols", href: item("class=4&subclass=8") },
    { label: "Totems", href: item("class=4&subclass=9") },
    { label: "Miscellaneous", href: item("class=4&subclass=0") },
    { label: "By Slot", children: ARMOR_SLOTS.map(([l, s]) => ({ label: l, href: item(`class=4&slot=${s}`) })) },
  ],
};

const ITEMS = {
  label: "Items", href: "?browse=items",
  children: [
    WEAPONS, ARMOR,
    { label: "Containers", href: item("class=1") },
    { label: "Consumables", href: item("class=0") },
    { label: "Trade Goods", href: item("class=7") },
    { label: "Projectiles", href: item("class=6") },
    { label: "Quivers", href: item("class=11") },
    { label: "Recipes", href: item("class=9") },
    { label: "Quest", href: item("class=12") },
    { label: "Keys", href: item("class=13") },
    { label: "Miscellaneous", href: item("class=15") },
    { label: "Item Sets", href: "?browse=itemsets" },
  ],
};

const NPCS = {
  label: "NPCs", href: "?browse=npcs",
  children: Object.entries(CREATURE_TYPE)
    .filter(([id]) => +id !== 10) // drop "Not specified"
    .map(([id, name]) => ({ label: name, href: `?browse=npcs&type=${id}` })),
};

const CRAFTING = {
  label: "Crafting", href: "?browse=crafting",
  children: PROFESSION.map(([id, name]) => ({ label: name, href: `?browse=crafting&prof=${id}` })),
};

const SPELLS = {
  label: "Spells", href: "?browse=spells",
  children: [
    { label: "By Class", children: CLASS_MASK.map(([bit, name]) => ({ label: name, href: `?browse=spells&cls=${bit}` })) },
    { label: "By Category", children: SPELL_CATEGORIES.map((c) => ({ label: c, href: `?browse=spells&cat=${encodeURIComponent(c)}` })) },
    { label: "By School", children: Object.entries(SPELL_SCHOOL).map(([id, name]) => ({ label: name, href: `?browse=spells&school=${id}` })) },
  ],
};

const ZONES = {
  label: "Zones", href: "?browse=zones",
  children: [
    ...Object.entries(CONTINENT).map(([id, name]) => ({ label: name, href: `?browse=zones&cont=${id}` })),
    { label: "World Map", href: "?worldmap" },
    { label: "Dungeons & Raids", href: "?dungeons" },
    { label: "Flight Paths", href: "?flights" },
  ],
};

// Utilities grouped under "More" so the menubar fits one line (no wrap).
const MORE = {
  label: "More",
  children: [
    { label: "Characters", href: "?characters" },
    { label: "Objects", href: "?browse=objects" },
    { label: "Icons", href: "?icons" },
    { label: "Random", href: "?random" },
  ],
};

export const MENU = [
  ITEMS,
  NPCS,
  { label: "Quests", href: "?browse=quests" },
  SPELLS,
  CRAFTING,
  { label: "Factions", href: "?browse=factions" },
  ZONES,
  { label: "Guides", href: "?guides" },
  { label: "Talents", href: "?talents" },
  MORE,
];

function renderLi(node) {
  const hasSub = node.children && node.children.length;
  const label = node.href
    ? `<a class="nav" href="${esc(node.href)}">${esc(node.label)}</a>`
    : `<span class="nav navlabel">${esc(node.label)}</span>`;
  // has-sub items get an explicit expand toggle (mobile only, hidden on desktop) so
  // the label itself stays a real link -- tap the text to navigate, the +/− to expand.
  const exp = hasSub ? `<button type="button" class="nav-exp" aria-label="Expand ${esc(node.label)}" tabindex="-1"></button>` : "";
  const sub = hasSub ? `<ul class="submenu">${node.children.map(renderLi).join("")}</ul>` : "";
  return `<li class="${hasSub ? "has-sub" : ""}">${label}${exp}${sub}</li>`;
}

export function buildNavHtml() {
  return `<ul class="menubar">${MENU.map(renderLi).join("")}</ul>`;
}

// Mobile (≤1024px, the hamburger breakpoint): the +/− toggle (or a label with no
// destination of its own) expands a submenu; a real link -- leaf OR a parent that
// has an href, like "One-Handed" -- navigates via the global SPA handler. Desktop
// uses CSS :hover flyouts, so this is a no-op there.
export function wireNav(topnav) {
  topnav.addEventListener("click", (e) => {
    if (!window.matchMedia("(max-width: 1100px)").matches) return;
    const exp = e.target.closest(".nav-exp");
    if (exp) { e.preventDefault(); e.stopPropagation(); exp.closest("li").classList.toggle("open"); return; }
    // a parent with no link of its own (a plain label, e.g. "More" / "By Class") toggles
    const lbl = e.target.closest(".navlabel");
    if (lbl && lbl.parentElement.classList.contains("has-sub")) {
      e.preventDefault(); e.stopPropagation();
      lbl.parentElement.classList.toggle("open");
    }
    // otherwise it's a real link -> fall through so main.js navigates (and closes the nav)
  });
}

// Collapse every expanded mobile submenu (called when the hamburger closes).
export function closeNav(topnav) {
  topnav.querySelectorAll(".has-sub.open").forEach((li) => li.classList.remove("open"));
}
