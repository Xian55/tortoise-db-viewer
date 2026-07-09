import {
  QUALITY, ITEM_CLASS, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE, STAT_TYPE,
  BONDING, DMG_SCHOOL, SPELL_TRIGGER, RESISTANCES, ITEM_SOURCE, REP_STANDING, POWER_TYPE, classRestrictions, setClassMask, money,
  PROFESSION_LABEL,
} from "./constants.js";
// skill_id -> name for item equip requirements (professions + a few non-profession skills).
const REQ_SKILL_LABEL = { ...PROFESSION_LABEL, 762: "Riding", 433: "Cooking", 129: "First Aid" };

const SRC_LABEL = Object.fromEntries(ITEM_SOURCE);
const SRC_ORDER = ITEM_SOURCE.map(([k]) => k);
// render a comma-list of source keys as ordered .tagx pills (browse + item page)
export function sourceTags(csv) {
  if (!csv) return "";
  const set = new Set(String(csv).split(","));
  return SRC_ORDER.filter((k) => set.has(k))
    .map((k) => `<span class="tagx src-${k}">${SRC_LABEL[k]}</span>`).join("");
}

// Post-redirect URL: render-us.worldofwarcraft.com 302s to render.worldofwarcraft.com/us/,
// and that cross-origin redirect is what trips ORB / "CORS" console warnings on the
// icon <img>. Pointing straight at the target skips the redirect (both hops send
// Access-Control-Allow-Origin: *, so the image loaded either way -- this quiets it).
const ICON_BASE = "https://render.worldofwarcraft.com/us/icons/56";
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

// Icons-grid tile image: like iconImg, but a CDN icon that 404s HIDES its tile
// instead of showing the "?" placeholder. Offline we can't know which icon names
// have a real CDN texture (many in-use names are stale/invalid), so the grid lets
// the browser decide -- atlas sprites always render; broken CDN icons drop out.
export function iconGridImg(name) {
  const key = (name || "").toLowerCase();
  const i = ATLAS && ATLAS.icons[key];
  if (i !== undefined && i !== null && i !== false) {
    return `<span class="icon-grid-img icon-sprite" style="${spriteStyle(i)}" role="img" aria-label="${esc(name)}"></span>`;
  }
  return `<img class="icon-grid-img" loading="lazy" src="${iconUrl(name)}" alt="" ` +
    `onerror="this.closest('.icon-tile').style.display='none'">`;
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

// Resolve spell description placeholders to numbers, then strip remaining codes.
// $sN = effect base value, $oN = over-time total (value x ticks), $tN = tick
// interval (sec), $aN = radius (yd), $d = duration (sec). Needs sp.duration_ms +
// sp.effects (Q_SPELL SELECT *); degrades gracefully when absent.
export function resolveSpellText(text, sp) {
  if (!text) return "";
  let effs = [];
  try { effs = sp.effects ? JSON.parse(sp.effects) : []; } catch { /* ignore */ }
  const eff = (n) => effs.find((e) => e.i === n);
  const dur = sp.duration_ms || 0;
  const over = (n) => {
    const e = eff(n), base = sp[`s${n}`] || 0;
    const ticks = e && e.period && dur ? Math.round(dur / e.period) : 1;
    return String(base * (ticks || 1));
  };
  const durStr = dur ? `${Number.isInteger(dur / 1000) ? dur / 1000 : (dur / 1000).toFixed(1)} sec` : "";
  return text
    // scaled own-effect tokens: "$/10;s1" = s1 / 10, "$*2;s1" = s1 * 2
    .replace(/\$\/(\d+);s([123])/gi, (_, div, n) => valStr(Math.round((sp[`s${n}`] || 0) / (+div)), 0))
    .replace(/\$\*(\d+);s([123])/gi, (_, mul, n) => valStr(Math.round((sp[`s${n}`] || 0) * (+mul)), 0))
    .replace(/\$o([123])/gi, (_, n) => over(+n))
    .replace(/\$s([123])/gi, (_, n) => valStr(sp[`s${n}`], sp[`d${n}`]))
    .replace(/\$t([123])/gi, (_, n) => { const e = eff(+n); return e && e.period ? String(e.period / 1000) : ""; })
    .replace(/\$a([123])/gi, (_, n) => { const e = eff(+n); return e && e.radius != null ? String(e.radius) : ""; })
    .replace(/\$d(?![a-zA-Z0-9])/gi, durStr)
    .replace(/\$\{[^}]*\}/g, "")                    // ${...} math expressions
    .replace(/\$[gl][^;]*;/gi, "")                  // $g..:..; / $l..:..; gender/plural
    .replace(/\$[*/]?\d*;?\d*[a-z]*\d*%?/gi, "")    // any remaining spell-variable token
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Build the item tooltip card. spellMap: Map<spellId, spellRow>. linkSpells wraps
// the green effect lines in spell links (on for the item page, off for transient
// hovercards so a popover never holds a nested link).
export function renderTooltip(it, { spellMap = new Map(), linkSpells = false, set = null } = {}) {
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

  // container capacity (bags = class 1; quivers/ammo pouches = class 11)
  if (it.container_slots) {
    const kind = it.class === 11 ? (it.subclass === 3 ? "Ammo Pouch" : "Quiver") : "Bag";
    line(`${it.container_slots} Slot ${kind}`);
  }

  // ammo (arrows/bullets = class 6): flat damage add, shown wowhead-style.
  if (it.class === 6 && (it.dmg_min1 || it.dmg_max1)) {
    const a = ((it.dmg_min1 || 0) + (it.dmg_max1 || 0)) / 2;
    line(`Adds ${a % 1 ? a.toFixed(1) : a} damage per second`);
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
  // profession/skill needed to equip or use (e.g. Requires Engineering (100))
  if (it.required_skill) reqs.push(`Requires ${REQ_SKILL_LABEL[it.required_skill] || "Skill"}${it.required_skill_rank ? ` (${it.required_skill_rank})` : ""}`);
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
    const body = txt || (sp && sp.name) || "";
    if (!body) continue;
    // a recipe's "learn" spell (sp.teaches) is a stub -> link to the real craft.
    const inner = linkSpells && sp ? spellLink(sp.teaches || sid, body, sp.icon) : esc(body);
    line(`${label} ${inner}`, "tt-spell");
  }

  // item set (in-game style: gold set name + member list + bonus lines)
  if (set && set.members && set.members.length) {
    const setName = set.id ? `<a class="ilink" href="?itemset=${set.id}">${esc(set.name)}</a>` : esc(set.name);
    let s = `<div class="tt-set"><div class="tt-set-name">${setName} <span class="dim">(${set.members.length})</span></div>`;
    const setCls = classRestrictions(setClassMask(set.members));
    if (setCls) s += `<div class="tt-set-class dim">Classes: ${esc(setCls.join(", "))}</div>`;
    for (const m of set.members) {
      s += `<div class="tt-set-member">${m.entry === set.currentEntry
        ? `<b>${esc(m.name)}</b>`
        : `<a class="ilink" href="?item=${m.entry}">${esc(m.name)}</a>`}</div>`;
    }
    for (const b of set.bonuses) {
      const txt = b.description ? resolveSpellText(b.description, b) : (b.spell_name || "");
      const body = b.spell ? `<a class="ilink set-bonus-link" href="?spell=${b.spell}">${esc(txt)}</a>` : `<span class="set-bonus-link">${esc(txt)}</span>`;
      s += `<div class="tt-set-bonus"><span class="dim">(${b.threshold}) Set:</span> ${body}</div>`;
    }
    L.push(s + "</div>");
  }

  // flavor
  if (it.description) line(`"${esc(it.description)}"`, "tt-flavor");

  // vendor prices: Buy only when actually vendor-purchasable (build-db `buyable`),
  // Sell whenever the item has a sell value.
  const coins = (cp) => {
    const { g, s, c } = money(cp);
    const parts = [];
    if (g) parts.push(`<span class="coin g">${g}</span>`);
    if (s) parts.push(`<span class="coin s">${s}</span>`);
    parts.push(`<span class="coin c">${c}</span>`);
    return parts.join(" ");
  };
  if (it.buyable && it.buy_price) line(`Buy Price: ${coins(it.buy_price)}`, "tt-buy");
  if (it.sell_price) line(`Sell Price: ${coins(it.sell_price)}`, "tt-sell");

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

// Readable book/letter/plaque prose (a page_text chain). Each page keeps its own
// line breaks; "Missing Text" placeholder pages and blanks are dropped. Returns ""
// when nothing readable remains, so the caller can omit the whole section.
export function readableText(pages, { title = "Text" } = {}) {
  const clean = (pages || [])
    .map((p) => String(p.text || "").replace(/\r\n?/g, "\n").trim())
    .filter((t) => t && t.toLowerCase() !== "missing text");
  if (!clean.length) return "";
  const multi = clean.length > 1;
  const body = clean.map((t, i) => {
    const pageNo = multi ? `<div class="readable-pageno">Page ${i + 1}</div>` : "";
    return `<div class="readable-page">${pageNo}${esc(t).replace(/\n/g, "<br>")}</div>`;
  }).join("");
  return `<section class="panel readable"><h2>📖 ${esc(title)}</h2><div class="readable-body">${body}</div></section>`;
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

// Wowhead's pre-rendered creature thumbnail (Classic branch), keyed by the
// creature's display_id (creature_template.display_id1). 404s for some creatures
// -- incl. Turtle-custom ones Wowhead never saw -- so callers must hide on the
// <img> error (see hovercard.js model card).
export function modelThumbUrl(displayId) {
  return `https://wow.zamimg.com/modelviewer/classic/webthumbs/npc/${displayId % 256}/${displayId}.webp`;
}

export function dungeonLink(id, name) {
  return `<a class="ilink" href="?dungeon=${id}">${esc(name)}</a>`;
}

export function objectLink(entry, name) {
  return `<a class="ilink object" href="?object=${entry}">${esc(name)}</a>`;
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

// Faction-alignment label/badge for an NPC (creatures.team: 1 Alliance, 2 Horde,
// 3 both, else neutral). Used where "which side can use this NPC" matters --
// profession trainers on the crafting browse + spell page.
export function teamLabel(team) {
  return team === 1 ? "Alliance" : team === 2 ? "Horde" : team === 3 ? "Both" : "Neutral";
}
export function teamBadge(team) {
  const cls = team === 1 ? "team-a" : team === 2 ? "team-h" : team === 3 ? "team-b" : "team-n";
  const abbr = team === 1 ? "A" : team === 2 ? "H" : team === 3 ? "A/H" : "N";
  return `<span class="tbadge ${cls}" title="${teamLabel(team)}">${abbr}</span>`;
}

// Spell link. icon is the basename (CDN or custom atlas); rendered only when set
// (spells without an extracted icon degrade to a clean text link, no "?" image).
export function spellLink(entry, name, icon) {
  return `<a class="ilink spell" href="?spell=${entry}">` +
    `${icon ? iconImg(icon) : ""}${esc(name)}</a>`;
}

const spellSecs = (ms) => { const v = ms / 1000; return `${Number.isInteger(v) ? v : v.toFixed(v < 1 ? 2 : 1)} ${v === 1 ? "second" : "seconds"}`; };

// Power cost string. Rage is stored internally x10 (max rage 100 = 1000 units),
// so divide it for display; mana/energy/focus are 1:1.
export function spellCost(sp) {
  if (sp.mana_cost) {
    const n = sp.power_type === 1 ? sp.mana_cost / 10 : sp.mana_cost;
    return `${n} ${POWER_TYPE[sp.power_type] || "Mana"}`;
  }
  return sp.mana_cost_pct ? `${sp.mana_cost_pct}% of base mana` : "";
}

// Parchment summary card for a spell (the page header + the hover tooltip share
// this). sp is a full Q_SPELL row (icon/rank/cost/range/cast + description).
export function spellTooltip(sp) {
  const cost = spellCost(sp);
  const cast = sp.channeled ? "Channeled" : (sp.cast_ms ? spellSecs(sp.cast_ms) : "Instant");
  const desc = resolveSpellText(sp.description || sp.auraDescription, sp);
  const lines = [];
  if (cost || sp.range_max) {
    lines.push(`<div class="tt-split"><span class="tt-l">${esc(cost)}</span>` +
      `<span class="tt-r">${sp.range_max ? `${sp.range_max} yd range` : ""}</span></div>`);
  }
  lines.push(`<div>${esc(cast)}</div>`);
  if (desc) lines.push(`<div class="tt-spell">${esc(desc)}</div>`);
  return `<div class="tooltip spell-card">
    <div class="tt-head">${sp.icon ? iconImg(sp.icon, "tt-icon") : ""}` +
    `<div class="tt-name">${esc(sp.name)}</div>${sp.rank ? `<div class="tt-rank muted">${esc(sp.rank)}</div>` : ""}</div>` +
    `${lines.map((l) => `<div class="tt-line">${l}</div>`).join("")}</div>`;
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
  if (v >= 100) return "100%";
  if (v >= 1) return `${v.toFixed(1)}%`;
  if (v >= 0.01) return `${v.toFixed(2)}%`;
  return v > 0 ? "<0.01%" : "0%"; // tiny world-drop chances: avoid a misleading "0.00%"
}

// Stack-size badge for a loot drop that yields more than one of an item (e.g. a gem
// that drops 1-2, cloth that drops 2). Empty when max <= 1 (the common single case),
// so it only clutters rows where the quantity is actually noteworthy.
export function dropQty(min, max) {
  const hi = max || 0;
  if (hi <= 1) return "";
  const lo = min && min > 0 ? min : 1;
  return ` <span class="drop-qty" title="Drops ${lo === hi ? hi : `${lo}-${hi}`} at a time">×${lo === hi ? hi : `${lo}-${hi}`}</span>`;
}
