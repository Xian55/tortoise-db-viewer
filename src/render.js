import {
  QUALITY, ITEM_CLASS, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE, STAT_TYPE,
  BONDING, DMG_SCHOOL, SPELL_TRIGGER, RESISTANCES, ITEM_SOURCE, REP_STANDING, classRestrictions, money,
} from "./constants.js";

const SRC_LABEL = Object.fromEntries(ITEM_SOURCE);
const SRC_ORDER = ITEM_SOURCE.map(([k]) => k);
// render a comma-list of source keys as ordered .tagx pills (browse + item page)
export function sourceTags(csv) {
  if (!csv) return "";
  const set = new Set(String(csv).split(","));
  return SRC_ORDER.filter((k) => set.has(k))
    .map((k) => `<span class="tagx src-${k}">${SRC_LABEL[k]}</span>`).join("");
}

const ICON_BASE = "https://render-us.worldofwarcraft.com/icons/56";
const PLACEHOLDER = "inv_misc_questionmark";

export function iconUrl(name) {
  return `${ICON_BASE}/${(name || PLACEHOLDER).toLowerCase()}.jpg`;
}

// Turtle custom icons (not on Blizzard's CDN) are shipped as one sprite-sheet.
// main.js loads the manifest at boot; until then custom icons fall back to CDN.
// { url, cols, rows, count, icons: { <name>: index } }  -- see build-atlas.py
let ATLAS = null;
export function setIconAtlas(atlas) { ATLAS = atlas; }
// the loaded atlas manifest ({ url, cols, rows, icons }) for consumers that need
// to draw sprites directly (e.g. the Pixi zone map). null until loaded.
export function getIconAtlas() { return ATLAS; }

// Background-position for cell `i` in the grid, as percentages so the one atlas
// scales to any on-screen icon size (18px lists, 48px tooltip).
function spriteStyle(i) {
  const { url, cols, rows } = ATLAS;
  const x = cols > 1 ? ((i % cols) / (cols - 1)) * 100 : 0;
  const y = rows > 1 ? (Math.floor(i / cols) / (rows - 1)) * 100 : 0;
  return `background-image:url(${url});background-size:${cols * 100}% ${rows * 100}%;` +
    `background-position:${x}% ${y}%`;
}

// small inline icon (for item links / lists), lazy-loaded, placeholder on error
export function iconImg(name, cls = "il-icon") {
  const key = (name || "").toLowerCase();
  const i = ATLAS && ATLAS.icons[key];
  if (i !== undefined && i !== null && i !== false) {
    return `<span class="${cls} icon-sprite" style="${spriteStyle(i)}" ` +
      `role="img" aria-label="${esc(name)}"></span>`;
  }
  return `<img class="${cls}" loading="lazy" src="${iconUrl(name)}" alt="" ` +
    `onerror="this.src='${iconUrl(PLACEHOLDER)}'">`;
}

// Map-marker icon: a <span> with a CSS background (atlas sprite or CDN image),
// not an <img>. Leaflet reparents the marker element when it builds the icon,
// which aborts an in-flight <img> load and fires its onerror -> the question-mark
// placeholder (the bug where toggled map nodes all showed "?"). A background
// image is immune to reparenting, so the real icon shows.
export function iconMarker(name, cls = "il-icon") {
  const key = (name || "").toLowerCase();
  const i = ATLAS && ATLAS.icons[key];
  if (i !== undefined && i !== null && i !== false) {
    return `<span class="${cls} icon-sprite" style="${spriteStyle(i)}" role="img" aria-label="${esc(name)}"></span>`;
  }
  return `<span class="${cls}" style="background-image:url(${iconUrl(name)});background-size:cover" ` +
    `role="img" aria-label="${esc(name)}"></span>`;
}

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function qualityColor(q) {
  return (QUALITY[q] || QUALITY[1]).color;
}

function valStr(s, d) {
  return d > 1 ? `${s} to ${s + d - 1}` : String(s);
}

// Replace $s1/$s2/$s3 with resolved numbers; strip remaining $-codes.
function resolveSpellText(text, sp) {
  if (!text) return "";
  return text
    .replace(/\$s1/gi, valStr(sp.s1, sp.d1))
    .replace(/\$s2/gi, valStr(sp.s2, sp.d2))
    .replace(/\$s3/gi, valStr(sp.s3, sp.d3))
    .replace(/\$\{[^}]*\}/g, "")
    .replace(/\$[a-zA-Z]\d*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Build the item tooltip card. spellMap: Map<spellId, spellRow>.
export function renderTooltip(it, { spellMap = new Map() } = {}) {
  const L = [];
  const line = (html, cls = "") => L.push(`<div class="tt-line ${cls}">${html}</div>`);

  // header (icon + name)
  const head =
    `<div class="tt-head">` +
    iconImg(it.icon, "tt-icon") +
    `<div class="tt-name" style="color:${qualityColor(it.quality)}">${esc(it.name)}</div>` +
    `</div>`;
  L.push(head);

  if (it.max_count === 1) line("Unique");
  if (BONDING[it.bonding]) line(BONDING[it.bonding]);

  // slot / subtype row
  const slot = INV_TYPE[it.inventory_type];
  let subtype = "";
  if (it.class === 2) subtype = WEAPON_SUBCLASS[it.subclass] || "";
  else if (it.class === 4) subtype = ARMOR_SUBCLASS[it.subclass] || "";
  if (slot || subtype) {
    line(`<span class="tt-l">${esc(slot || "")}</span><span class="tt-r">${esc(subtype)}</span>`, "tt-split");
  }

  // weapon damage / speed
  if (it.class === 2 && (it.dmg_min1 || it.dmg_max1)) {
    const speed = (it.delay / 1000).toFixed(2);
    const schools = [
      [it.dmg_min1, it.dmg_max1, it.dmg_type1],
      [it.dmg_min2, it.dmg_max2, it.dmg_type2],
    ].filter(([mn, mx]) => mn || mx);
    for (const [mn, mx, school] of schools) {
      const lbl = DMG_SCHOOL[school] ? ` ${DMG_SCHOOL[school]}` : "";
      line(`<span class="tt-l">${Math.round(mn)} - ${Math.round(mx)}${lbl} Damage</span>` +
        (school === it.dmg_type1 || schools.length === 1 ? `<span class="tt-r">Speed ${speed}</span>` : ""), "tt-split");
    }
    const total = schools.reduce((a, [mn, mx]) => a + (mn + mx) / 2, 0);
    const dps = (total / (it.delay / 1000)).toFixed(1);
    line(`(${dps} damage per second)`);
  }

  if (it.armor) line(`${it.armor} Armor`);
  if (it.block) line(`${it.block} Block`);

  // primary stats
  for (let i = 1; i <= 10; i++) {
    const t = it[`stat_type${i}`], v = it[`stat_value${i}`];
    if (t && v && STAT_TYPE[t]) {
      const sign = v > 0 ? "+" : "";
      line(`${sign}${v} ${STAT_TYPE[t]}`, "tt-stat");
    }
  }

  // resistances
  for (const [col, label] of RESISTANCES) {
    if (it[col]) line(`+${it[col]} ${label} Resistance`, "tt-stat");
  }

  if (it.max_durability) line(`Durability ${it.max_durability} / ${it.max_durability}`);

  // requirements
  const reqs = [];
  const cls = classRestrictions(it.allowable_class);
  if (cls) reqs.push(`Classes: ${cls.join(", ")}`);
  if (it.required_level) reqs.push(`Requires Level ${it.required_level}`);
  for (const r of reqs) line(esc(r), "tt-req");
  // reputation requirement renders as a faction link (raw HTML, not escaped)
  if (it.required_reputation_faction) {
    const rep = REP_STANDING[it.required_reputation_rank] || "";
    line(`Requires: ${factionLink(it.required_reputation_faction, it.req_rep_faction)}${rep ? " – " + rep : ""}`, "tt-req");
  }

  // spell effects (green)
  for (let i = 1; i <= 5; i++) {
    const sid = it[`spellid_${i}`];
    const trig = it[`spelltrigger_${i}`];
    if (!sid) continue;
    const sp = spellMap.get(sid);
    const label = SPELL_TRIGGER[trig] || "";
    const txt = sp ? resolveSpellText(sp.description || sp.auraDescription, sp) : "";
    if (txt) line(`${label} ${esc(txt)}`, "tt-spell");
    else if (sp && sp.name) line(`${label} ${esc(sp.name)}`, "tt-spell");
  }

  // flavor
  if (it.description) line(`"${esc(it.description)}"`, "tt-flavor");

  // sell price
  if (it.sell_price) {
    const { g, s, c } = money(it.sell_price);
    const parts = [];
    if (g) parts.push(`<span class="coin g">${g}</span>`);
    if (s) parts.push(`<span class="coin s">${s}</span>`);
    parts.push(`<span class="coin c">${c}</span>`);
    line(`Sell Price: ${parts.join(" ")}`, "tt-sell");
  }

  return `<div class="tooltip">${L.join("")}</div>`;
}

// ---- tabbed sections (NPC pages) ----
// items: [{ id, label, count, html }] — only non-empty tabs are shown.
export function tabs(items) {
  const live = items.filter((t) => t.count > 0);
  if (!live.length) return `<p class="muted">No data.</p>`;
  const bar = live.map((t, i) =>
    `<button class="tab${i === 0 ? " active" : ""}" data-tab="${t.id}">${esc(t.label)} <span class="tabn">${t.count}</span></button>`).join("");
  const panes = live.map((t, i) =>
    `<div class="tabpane${i === 0 ? "" : " hidden"}" data-pane="${t.id}">${t.html}</div>`).join("");
  return `<div class="tabs"><div class="tabbar">${bar}</div><div class="tabpanes">${panes}</div></div>`;
}

// ---- relation panels ----
export function panel(title, bodyHtml) {
  if (!bodyHtml) return "";
  return `<section class="panel"><h2>${esc(title)}</h2>${bodyHtml}</section>`;
}

export function table(headers, body) {
  const html = Array.isArray(body) ? body.join("") : body;
  if (!html || !html.trim()) return ""; // no rows -> panel() drops the whole section
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${html}</tbody></table>`;
}

export function itemLink(entry, name, quality, icon) {
  return `<a class="ilink" href="?item=${entry}" style="color:${qualityColor(quality)}">` +
    `${iconImg(icon)}${esc(name)}</a>`;
}

export function npcLink(entry, name) {
  return `<a class="ilink npc" href="?npc=${entry}">${esc(name)}</a>`;
}

export function dungeonLink(id, name) {
  return `<a class="ilink" href="?dungeon=${id}">${esc(name)}</a>`;
}

export function questLink(entry, title) {
  return `<a class="ilink quest" href="?quest=${entry}">${esc(title)}</a>`;
}

export function factionLink(id, name) {
  return `<a class="ilink faction" href="?faction=${id}">${esc(name || `Faction #${id}`)}</a>`;
}

export function zoneLink(areaid, name) {
  return `<a class="ilink zone" href="?zone=${areaid}">${esc(name)}</a>`;
}

// gold/silver/copper coin spans from a raw copper amount (mirrors the tooltip).
export function moneyHtml(copper) {
  const { g, s, c } = money(copper);
  const p = [];
  if (g) p.push(`<span class="coin g">${g}</span>`);
  if (s) p.push(`<span class="coin s">${s}</span>`);
  p.push(`<span class="coin c">${c}</span>`);
  return p.join(" ");
}

export function pct(v) {
  if (v == null) return "";
  return v >= 100 ? "100%" : v >= 1 ? `${v.toFixed(1)}%` : `${v.toFixed(2)}%`;
}
