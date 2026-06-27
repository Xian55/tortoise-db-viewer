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
  children: Object.entries(CONTINENT).map(([id, name]) => ({ label: name, href: `?browse=zones&cont=${id}` })),
};

export const MENU = [
  ITEMS,
  { label: "Item Sets", href: "?browse=itemsets" },
  NPCS,
  { label: "Quests", href: "?browse=quests" },
  SPELLS,
  CRAFTING,
  { label: "Factions", href: "?browse=factions" },
  ZONES,
  { label: "Dungeons", href: "?dungeons" },
  { label: "Objects", href: "?browse=objects" },
];

function renderLi(node) {
  const hasSub = node.children && node.children.length;
  const label = node.href
    ? `<a class="nav" href="${esc(node.href)}">${esc(node.label)}</a>`
    : `<span class="nav navlabel">${esc(node.label)}</span>`;
  const sub = hasSub ? `<ul class="submenu">${node.children.map(renderLi).join("")}</ul>` : "";
  return `<li class="${hasSub ? "has-sub" : ""}">${label}${sub}</li>`;
}

export function buildNavHtml() {
  return `<ul class="menubar">${MENU.map(renderLi).join("")}</ul>`;
}

// Mobile: tapping a parent expands its submenu (instead of navigating). Desktop
// uses CSS :hover, so this only acts under the hamburger breakpoint. stopPropagation
// keeps the global SPA-nav handler from also firing on a parent tap.
export function wireNav(topnav) {
  topnav.addEventListener("click", (e) => {
    if (!window.matchMedia("(max-width: 760px)").matches) return; // desktop: hover + normal nav
    const label = e.target.closest("a.nav, .navlabel");
    const li = label && label.parentElement;
    if (li && li.classList.contains("has-sub")) {
      e.preventDefault();
      e.stopPropagation();
      li.classList.toggle("open");
    }
  });
}

// Collapse every expanded mobile submenu (called when the hamburger closes).
export function closeNav(topnav) {
  topnav.querySelectorAll(".has-sub.open").forEach((li) => li.classList.remove("open"));
}
