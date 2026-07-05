// Browse / finder views with filters (wowhead-style). Filtering runs as SQL
// against the in-memory DB; sorting + pagination are handled client-side by the
// shared sortable table (src/table.js), the same one used everywhere else.
import { query } from "./db.js";
import { Q_CRAFTING, Q_FACTIONS, Q_ZONES, Q_BROWSE_SPELLS, Q_BROWSE_ITEMSETS, Q_BROWSE_OBJECTS, Q_PROFESSION_LEARN } from "./queries.js";
import { itemLink, npcLink, questLink, factionLink, zoneLink, spellLink, objectLink, sourceTags, moneyHtml, teamBadge, esc } from "./render.js";
import { createTable } from "./table.js";
import {
  ITEM_CLASS, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE, QUALITY,
  CREATURE_TYPE, CREATURE_RANK, GEAR_CRITERIA, GEAR_STAT_LABEL, ITEM_SOURCE,
  BONDING, CLASS_MASK, PROFESSION, PROFESSION_LABEL, RACE_ALLIANCE, RACE_HORDE,
  QUEST_TYPE, CONTINENT, SPELL_SCHOOL, SPELL_CATEGORIES, GAMEOBJECT_TYPE, questZoneLabel,
  STAT_WEIGHT_PRESETS, STAT_WEIGHT_PRESET_MAP, GATHERING_SKILLS, SKILL_RANK_ORDER,
} from "./constants.js";

const PAGE = 100;
const lvlRange = (r) => (r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : (r.level_min || ""));
// item classes with no real items -- hidden from the browse Class dropdown (the
// ITEM_CLASS map itself is kept intact for labelling). Gem/Generic/Permanent are
// empty; Money has a single row not worth a menu entry.
const EMPTY_ITEM_CLASSES = new Set(["3", "8", "10", "14"]);

const dpsVal = (r) => (r.delay > 0 && (r.dmg_min1 || r.dmg_max1) ? ((r.dmg_min1 + r.dmg_max1) / 2) / (r.delay / 1000) : 0);
// Effective "available level": the item's own equip requirement, or -- for a
// quest reward with a lower/zero required_level -- the min level to take the
// reward quest (quest_min_level, 0 on non-rewards). So the Req column sorts by
// when you can actually obtain+use the item, not just equip it.
// only equippable gear (inventory_type > 0) inherits the quest gate -- a
// quest-reward reagent/consumable has no meaningful "available to equip" level.
const effReq = (r) => Math.max(r.required_level || 0, r.inventory_type ? (r.quest_min_level || 0) : 0);
// Rage is stored x10 (max rage 100 = 1000 units); divide it for display.
const spellCostVal = (r) => (r.power_type === 1 ? (r.mana_cost || 0) / 10 : (r.mana_cost || 0));

const COL = {
  name: { key: "name", label: "Name", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
  ilvl: { key: "ilvl", label: "iLvl", num: true, cls: "muted", cell: (r) => r.item_level || "", value: (r) => r.item_level || 0 },
  req: { key: "req", label: "Req", num: true, cls: "muted", hideEmpty: true,
    cell: (r) => { const e = effReq(r); if (!e) return ""; return e > (r.required_level || 0) ? `<span title="Available from a level-${e} quest reward">${e}*</span>` : `${e}`; },
    value: (r) => effReq(r) },
  slot: { key: "slot", label: "Slot", cls: "muted", hideUniform: true, cell: (r) => INV_TYPE[r.inventory_type] || "", value: (r) => INV_TYPE[r.inventory_type] || "" },
  source: { key: "source", label: "Source", cls: "src-col", cell: (r) => sourceTags(r.sources), value: (r) => r.sources || "" },
  dps: { key: "dps", label: "DPS", num: true, cell: (r) => (dpsVal(r) ? dpsVal(r).toFixed(1) : ""), value: (r) => dpsVal(r) },
  speed: { key: "speed", label: "Speed", num: true, cls: "muted", cell: (r) => (r.delay ? (r.delay / 1000).toFixed(2) : ""), value: (r) => r.delay / 1000 || 0 },
  armor: { key: "armor", label: "Armor", num: true, cls: "muted", cell: (r) => r.armor || "", value: (r) => r.armor || 0 },
  slots: { key: "slots", label: "Slots", num: true, cls: "muted", hideEmpty: true, cell: (r) => r.container_slots || "", value: (r) => r.container_slots || 0 },
  // ammo (class 6) flat damage add, shown wowhead-style as avg "damage per second"
  ammo: { key: "ammo", label: "Damage", num: true, cls: "muted", cell: (r) => { const a = ((r.dmg_min1 || 0) + (r.dmg_max1 || 0)) / 2; return a ? (a % 1 ? a.toFixed(1) : `${a}`) : ""; }, value: (r) => ((r.dmg_min1 || 0) + (r.dmg_max1 || 0)) / 2 },
  // fishing poles' "+N Fishing" equip bonus (item_stats stat='fishing'); replaces
  // DPS/Speed when the Fishing Pole subtype is the only one filtered.
  fishing: { key: "fishing", label: "Fishing", num: true, cls: "muted", cell: (r) => (r.fishing ? `+${r.fishing}` : ""), value: (r) => r.fishing || 0 },
  // recipe (class 9) profession the item teaches/requires, from items.required_skill.
  prof: { key: "prof", label: "Profession", cls: "muted", cell: (r) => esc(PROFESSION_LABEL[r.required_skill] || ""), value: (r) => PROFESSION_LABEL[r.required_skill] || "" },
};

// Faction side of an item for the browse Faction column: a hard race lock
// (allowable_race restricted to one side) OR, failing that, a quest-reward lock
// (items.quest_faction). 0 none/neutral, 1 Alliance, 2 Horde -- so "real
// availability" reads at a glance even on gear the item itself doesn't restrict.
function factionSide(r) {
  const race = r.allowable_race;
  if (race !== -1 && (race & RACE_ALLIANCE) && !(race & RACE_HORDE)) return 1;
  if (race !== -1 && (race & RACE_HORDE) && !(race & RACE_ALLIANCE)) return 2;
  return r.quest_faction || 0;
}
const factionTag = (s) => s === 1 ? '<span class="tagx fac-alliance">Alliance</span>'
  : s === 2 ? '<span class="tagx fac-horde">Horde</span>' : "";
// armor subtype (Cloth/Leather/Mail/Plate) or weapon type (Sword/Axe/...) label.
const itemSubtype = (r) => (r.class === 2 ? WEAPON_SUBCLASS[r.subclass] : r.class === 4 ? ARMOR_SUBCLASS[r.subclass] : "") || "";
// short bind tag for the column (full text via title); mirrors BONDING keys.
const BIND_SHORT = { 1: "BoP", 2: "BoE", 3: "BoU", 4: "Quest" };

// Full item-column registry, keyed by the `cols=` chooser value. The item
// browser is column-driven: the class-adaptive DEFAULTS (defaultColKeys) are just
// the pre-selected set when no cols= param is present; otherwise the chooser is
// the source of truth for which columns show. Stat columns (Stamina, Spell Power,
// ...) are NOT here -- they're built on the fly from the item_stats join.
const ALLCOL = {
  ...COL,
  id: { key: "id", label: "Id", num: true, cls: "muted", cell: (r) => r.entry, value: (r) => r.entry },
  faction: { key: "faction", label: "Faction", cls: "muted", cell: (r) => factionTag(factionSide(r)), value: (r) => factionSide(r) },
  questlvl: { key: "questlvl", label: "Quest Lvl", num: true, cls: "muted", cell: (r) => r.quest_min_level || "", value: (r) => r.quest_min_level || 0 },
  sell: { key: "sell", label: "Sell", num: true, cls: "muted", cell: (r) => (r.sell_price ? moneyHtml(r.sell_price) : ""), value: (r) => r.sell_price || 0 },
  bind: { key: "bind", label: "Bind", cls: "muted", cell: (r) => (BIND_SHORT[r.bonding] ? `<span title="${esc(BONDING[r.bonding])}">${BIND_SHORT[r.bonding]}</span>` : ""), value: (r) => r.bonding || 0 },
  type: { key: "type", label: "Type", cls: "muted", cell: (r) => esc(itemSubtype(r)), value: (r) => itemSubtype(r) },
  quality: { key: "quality", label: "Quality", cls: "muted", cell: (r) => esc((QUALITY[r.quality] || {}).name || ""), value: (r) => r.quality || 0 },
  stack: { key: "stack", label: "Stack", num: true, cls: "muted", cell: (r) => (r.stackable > 1 ? r.stackable : ""), value: (r) => r.stackable || 0 },
};

// class-adaptive default column keys (Name is always shown first, separately).
// These are the pre-checked chooser state when no cols= param is present.
function defaultColKeys(cls, subclass, slot) {
  if (cls === "2" && subclass === "20") return ["fishing", "ilvl", "req", "source"];
  if (cls === "2") return ["dps", "speed", "ilvl", "req", "source"];
  if (cls === "4") return ["armor", "ilvl", "req", "slot", "source"];
  if (cls === "6") return ["ammo", "ilvl", "req", "source"];
  if (cls === "9") return ["prof", "req", "source"];
  // containers/quivers (by class or a bag-slot filter) -> show the bag capacity
  if (cls === "1" || cls === "11" || (slot || "").split(",").includes("18")) return ["slots", "ilvl", "req", "source"];
  // generic mixed view: no bag-slots column (meaningless for gear/consumables)
  return ["ilvl", "req", "slot", "source"];
}

// fixed render order for the selected non-stat columns; stat columns slot in
// right after Name, before these. Selection order doesn't affect layout.
const CANON_ORDER = ["dps", "speed", "armor", "ammo", "fishing", "slots", "prof",
  "ilvl", "req", "slot", "type", "quality", "bind", "stack", "faction", "questlvl", "sell", "id", "source"];

// keys that resolve to a real column (so the chooser's stat groups drop their
// duplicates -- Armor / Weapon DPS are value columns here, not item_stats reads).
const VALUE_COL_KEYS = new Set(Object.keys(ALLCOL));

// Column-chooser groups: the core columns, extra Info columns, then every gear
// stat (minus the ones already offered above as value columns) from GEAR_CRITERIA.
const COL_GROUPS = [
  { group: "Columns", options: [["dps", "DPS"], ["speed", "Speed"], ["armor", "Armor"], ["ammo", "Damage"], ["fishing", "Fishing"], ["prof", "Profession"], ["slots", "Bag slots"], ["ilvl", "iLvl"], ["req", "Req level"], ["slot", "Slot"], ["source", "Source"]] },
  { group: "Info", options: [["id", "Id"], ["faction", "Faction"], ["questlvl", "Quest Lvl"], ["bind", "Bind"], ["type", "Type"], ["quality", "Quality"], ["stack", "Stack"], ["sell", "Sell price"]] },
  ...GEAR_CRITERIA.map((g) => ({ group: g.group, options: g.options.filter(([k]) => !VALUE_COL_KEYS.has(k)) })).filter((g) => g.options.length),
];

// Build the item columns from the selected keys: Name always first, the stat
// columns (statCols) right after it, then the rest in CANON_ORDER. hideProf drops
// the Profession column when a single-profession filter makes it uniform.
function buildItemCols(selectedKeys, statCols, hideProf) {
  const keys = hideProf ? selectedKeys.filter((k) => k !== "prof") : selectedKeys;
  const ordered = CANON_ORDER.filter((k) => keys.includes(k) && ALLCOL[k]).map((k) => ALLCOL[k]);
  return [ALLCOL.name, ...statCols, ...ordered];
}

// Column chooser: grouped multi-select pre-checked with the effective selection
// (class defaults, or the explicit cols= set). Same .multi wrapper as multiField
// so collect() (data-mv) + open/close handlers work.
function colsField(selectedKeys) {
  const sel = new Set(selectedKeys);
  const summary = sel.size ? `${sel.size} shown` : "Default";
  const body = COL_GROUPS.map((g) =>
    `<div class="multi-grp">${esc(g.group)}</div>` + g.options.map(([v, l]) =>
      `<label class="multi-opt"><input type="checkbox" data-mv="cols" value="${v}"${sel.has(String(v)) ? " checked" : ""}> ${esc(l)}</label>`).join("")).join("");
  return `<div class="fld multi" data-multi="cols">
    <button type="button" class="multi-btn">${esc(summary)} ▾</button>
    <div class="multi-panel">${body}</div></div>`;
}

// Multi-criteria gear filter: each criterion is { key, op, val } matched against
// the derived item_stats table (see scripts/lib/itemstats.mjs). AND-combined.
const CRIT_OPS = new Set([">", ">=", "="]);
const statLabel = (key) => GEAR_STAT_LABEL[key] || "Stat";

// Parse the `stats` URL param ("key,op,val|key,op,val"); drop malformed entries.
function parseCriteria(raw) {
  if (!raw) return [];
  return raw.split("|").map((s) => {
    const [key, op, val] = s.split(",");
    return { key, op, val };
  }).filter((c) => GEAR_STAT_LABEL[c.key] && CRIT_OPS.has(c.op) && c.val !== "" && c.val != null && !Number.isNaN(+c.val));
}

// stat <select> with the same grouped layout as the reference gear-finder.
function critStatOptions(cur) {
  return GEAR_CRITERIA.map((g) =>
    `<optgroup label="${esc(g.group)}">${g.options.map(([v, l]) => opt(v, l, cur)).join("")}</optgroup>`).join("");
}
// one criterion row (stat + operator + value + remove). c may be null (blank row).
function critRow(c) {
  const key = c ? c.key : "", op = (c && c.op) || ">=", val = c ? c.val : "";
  const ops = [">", ">=", "="].map((o) => `<option value="${esc(o)}"${o === op ? " selected" : ""}>${esc(o)}</option>`).join("");
  return `<div class="crit-row" data-crow>
    <select data-cstat><option value=""${key ? "" : " selected"}>Stat…</option>${critStatOptions(key)}</select>
    <select data-cop>${ops}</select>
    <input type="number" data-cval value="${esc(val)}" min="0" placeholder="0">
    <button type="button" class="crit-rm" data-crm title="Remove criterion">✕</button>
  </div>`;
}

// ---- gear-score weights (aowow-style "best gear for spec") ----
// Weightable keys fall in two buckets: the item_stats-backed GEAR_CRITERIA stats
// (str/agi/crit/sp/...), and these DERIVED extras read straight off item columns (so
// they're weightable but not valid Stat-filter criteria). Each carries a value(row)
// fn used by the Score. Negative weights work (e.g. speed<0 favours fast weapons).
const WEIGHT_EXTRA = [
  ["speed", "Weapon Speed", (r) => (r.delay ? r.delay / 1000 : 0)],
  ["ilvl", "Item Level", (r) => r.item_level || 0],
];
const WEIGHT_EXTRA_FN = Object.fromEntries(WEIGHT_EXTRA.map(([k, , fn]) => [k, fn]));
const WEIGHT_KEYS = new Set([...Object.keys(GEAR_STAT_LABEL), ...WEIGHT_EXTRA.map(([k]) => k)]);
// stat <select> for a weight row = the criteria stats + the weight-only extras.
function weightStatOptions(cur) {
  return critStatOptions(cur) + `<optgroup label="Item">${WEIGHT_EXTRA.map(([v, l]) => opt(v, l, cur)).join("")}</optgroup>`;
}
// Parse the `weights` URL param ("key:w|key:w"); keep valid weight keys + finite,
// non-zero weights.
function parseWeights(raw) {
  if (!raw) return [];
  return raw.split("|").map((s) => {
    const [key, w] = s.split(":");
    return { key, w: +w };
  }).filter((x) => WEIGHT_KEYS.has(x.key) && Number.isFinite(x.w) && x.w !== 0);
}
// one weight row (stat + multiplier + remove). w may be null (blank row).
function weightRow(w) {
  const key = w ? w.key : "", val = w ? w.w : "";
  return `<div class="wt-row" data-wrow>
    <select data-wstat><option value=""${key ? "" : " selected"}>Stat…</option>${weightStatOptions(key)}</select>
    <span class="wt-x">×</span>
    <input type="number" data-wval value="${esc(String(val))}" step="0.5" placeholder="1">
    <button type="button" class="crit-rm" data-wrm title="Remove weight">✕</button>
  </div>`;
}

const NPC_COLS = [
  { key: "name", label: "Name", cell: (r) => npcLink(r.entry, r.name) + (r.subname ? ` <span class="muted">&lt;${esc(r.subname)}&gt;</span>` : ""), value: (r) => r.name },
  { key: "level", label: "Level", num: true, cls: "muted", cell: (r) => lvlRange(r), value: (r) => r.level_max || r.level_min || 0 },
  { key: "rank", label: "Rank", num: true, cls: "muted", cell: (r) => CREATURE_RANK[r.rank] || "Normal", value: (r) => r.rank || 0 },
  { key: "type", label: "Type", cls: "muted", cell: (r) => CREATURE_TYPE[r.type] || "", value: (r) => CREATURE_TYPE[r.type] || "" },
  { key: "faction", label: "Faction", cls: "muted", cell: (r) => (r.faction ? (r.faction_page ? factionLink(r.faction_id, r.faction) : esc(r.faction)) : ""), value: (r) => r.faction || "" },
  { key: "location", label: "Location", cls: "muted", cell: (r) => (r.zone_id ? zoneLink(r.zone_id, r.zone) : ""), value: (r) => r.zone || "" },
];

// Drop columns made redundant by an active single-value filter: once one
// profession / type / zone is selected, that column shows the same value on
// every row. `keys` is the list of such column keys to hide.
const hideCols = (cols, keys) => (keys.length ? cols.filter((c) => !keys.includes(c.key)) : cols);

function opt(value, label, cur) {
  return `<option value="${value}"${String(cur) === String(value) ? " selected" : ""}>${esc(label)}</option>`;
}
function options(entries, cur, anyLabel) {
  let s = anyLabel != null ? opt("", anyLabel, cur) : "";
  for (const [v, l] of entries) s += opt(v, l, cur);
  return s;
}
function selectField(name, label, opts) {
  return `<div class="fld"><label>${esc(label)}</label><select data-f="${name}">${opts}</select></div>`;
}
function numField(name, label, cur) {
  return `<div class="fld"><label>${esc(label)}</label><input type="number" data-f="${name}" value="${cur ?? ""}" min="0"></div>`;
}
function textField(name, label, cur) {
  return `<div class="fld"><label>${esc(label)}</label><input type="search" data-f="${name}" value="${esc(cur ?? "")}" placeholder="name…"></div>`;
}
// default-on checkbox (see collect(): omitted from the URL when checked, =0 when off)
function checkField(name, label, checked) {
  return `<div class="fld fld-check"><label><input type="checkbox" data-f="${name}"${checked ? " checked" : ""}> ${esc(label)}</label></div>`;
}

// multi-select checkbox dropdown; value persisted as a comma list (e.g. quality=3,4)
let openMulti = null;
function multiField(name, label, entries, csv, raw) {
  const sel = new Set((csv || "").split(",").filter(Boolean));
  const summary = sel.size ? `${sel.size} selected` : "Any";
  const boxes = entries.map(([v, l]) =>
    `<label class="multi-opt"><input type="checkbox" data-mv="${name}" value="${v}"${sel.has(String(v)) ? " checked" : ""}> ${raw ? l : esc(l)}</label>`).join("");
  return `<div class="fld multi" data-multi="${name}"><label>${esc(label)}</label>
    <button type="button" class="multi-btn">${esc(summary)} ▾</button>
    <div class="multi-panel">${boxes}</div></div>`;
}

// selection operations bar for the item browse: clipboard exports + open on
// Wowhead (classic). Reads the live selection from the table API on each click.
const WOWHEAD = "https://www.wowhead.com/classic/item=";
function wireSelbar(bar, api, navigate) {
  const status = bar.querySelector("[data-opstatus]");
  let timer = null;
  const flash = (msg) => {
    status.textContent = msg;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { status.textContent = ""; }, 2500);
  };
  const copy = async (text, n) => {
    try { await navigator.clipboard.writeText(text); flash(`Copied ${n}`); }
    catch { flash("Copy failed"); }
  };
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-op]");
    if (!btn) return;
    const ids = api.getSelected().map((r) => r.entry);
    if (!ids.length) return;
    if (btn.dataset.op === "ids") copy(ids.join("\n"), ids.length);
    else if (btn.dataset.op === "prefix") {
      const pfx = bar.querySelector("[data-prefix]").value;
      copy(ids.map((id) => pfx + id).join("\n"), ids.length);
    } else if (btn.dataset.op === "wh") {
      if (ids.length > 15 && !confirm(`Open ${ids.length} Wowhead tabs?`)) return;
      ids.forEach((id) => window.open(WOWHEAD + id, "_blank", "noopener"));
    } else if (btn.dataset.op === "compare") {
      if (ids.length < 2) { flash("Select 2+ items to compare"); return; }
      navigate(`?compare=${ids.slice(0, 8).join(":")}`);
    } else if (btn.dataset.op === "clear") api.clearSelection();
  });
}

async function browseItems(p) {
  const f = {
    q: p.get("q") || "", class: p.get("class") || "", subclass: p.get("subclass") || "",
    quality: p.get("quality") || "", slot: p.get("slot") || "",
    minrl: p.get("minrl") || "", maxrl: p.get("maxrl") || "",
    minil: p.get("minil") || "", maxil: p.get("maxil") || "",
    source: p.get("source") || "",
    bind: p.get("bind") || "", uclass: p.get("uclass") || "", faction: p.get("faction") || "",
    unique: p.get("unique") || "", prof: p.get("prof") || "",
  };
  const criteria = parseCriteria(p.get("stats"));
  const weights = parseWeights(p.get("weights"));
  const presetId = p.get("preset") || "";
  // Columns are chooser-driven: an explicit cols= set, else the class defaults.
  // Name is always shown; stat keys resolve via the item_stats join, the rest via
  // ALLCOL. defaultColKeys keeps the smart per-class layout as the pre-checked set.
  const chosen = (p.get("cols") || "").split(",").filter(Boolean);
  const selectedKeys = chosen.length ? chosen : defaultColKeys(f.class, f.subclass, f.slot);
  const where = ["i.hidden = 0"], binds = [];
  const add = (cond, val) => { where.push(cond); binds.push(val); };
  const addIn = (col, csv) => {
    const vals = (csv || "").split(",").filter(Boolean);
    if (vals.length) { where.push(`${col} IN (${vals.map(() => "?").join(",")})`); for (const v of vals) binds.push(+v); }
  };
  if (f.q) add("i.name LIKE ?", `%${f.q}%`);
  if (f.class !== "") add("i.class = ?", +f.class);
  addIn("i.subclass", f.subclass); // CSV: nav groups select several (e.g. One-Handed = 0,4,7,13,15)
  addIn("i.quality", f.quality);
  addIn("i.inventory_type", f.slot);
  if (f.minrl !== "") add("i.required_level >= ?", +f.minrl);
  if (f.maxrl !== "") add("i.required_level <= ?", +f.maxrl);
  if (f.minil !== "") add("i.item_level >= ?", +f.minil);
  if (f.maxil !== "") add("i.item_level <= ?", +f.maxil);
  // source is multi-valued + TEXT (can't reuse addIn): match items having ANY selected source.
  const srcVals = f.source.split(",").filter(Boolean);
  if (srcVals.length) {
    where.push(`i.entry IN (SELECT item FROM item_sources WHERE source IN (${srcVals.map(() => "?").join(",")}))`);
    for (const v of srcVals) binds.push(v);
  }
  // dev artifacts (test/deprecated/placeholder) are hidden unless explicitly requested.
  if (!srcVals.includes("unobtainable")) {
    where.push(`i.entry NOT IN (SELECT item FROM item_sources WHERE source='unobtainable')`);
  }
  // A gear-score ranking should only rank gear you can actually get: drop items with
  // no recorded acquisition source (GM/test/beta artifacts otherwise inflate the top
  // of the Score list). Only applied when weighting -- the plain catalogue keeps
  // no-source items (many legit items lack loot data). EXISTS is NULL-safe.
  if (weights.length) where.push(`EXISTS (SELECT 1 FROM item_sources s WHERE s.item = i.entry)`);
  if (f.bind !== "") add("i.bonding = ?", +f.bind);
  // usable by class: unrestricted (-1) or the class bit is set in allowable_class.
  if (f.uclass !== "") { where.push("(i.allowable_class = -1 OR (i.allowable_class & ?) <> 0)"); binds.push(+f.uclass); }
  // faction: show items OBTAINABLE by that side -- neutral + that side's
  // exclusives, EXCLUDING the other side's exclusives (a hard race lock to the
  // other side, or a single-faction quest lock i.quest_faction). "What can my
  // faction get", not "exclusive to my faction" -- so neutral gear stays visible.
  const exclusiveTo = "((i.allowable_race <> -1 AND (i.allowable_race & ?) <> 0 AND (i.allowable_race & ?) = 0) OR i.quest_faction = ?)";
  if (f.faction === "a") { where.push(`NOT ${exclusiveTo}`); binds.push(RACE_HORDE, RACE_ALLIANCE, 2); }
  else if (f.faction === "h") { where.push(`NOT ${exclusiveTo}`); binds.push(RACE_ALLIANCE, RACE_HORDE, 1); }
  if (f.unique === "1") where.push("i.max_count = 1");
  if (f.prof !== "") add("i.required_skill = ?", +f.prof);
  // each criterion -> presence-aware match against item_stats (op is whitelisted).
  // match=any OR-combines them ("crit≥1 OR agi≥20"); default match=all AND-combines.
  const critMatch = p.get("match") === "any" ? "any" : "all";
  if (criteria.length) {
    const clauses = criteria.map((c) => `i.entry IN (SELECT item FROM item_stats WHERE stat='${c.key}' AND value ${c.op} ?)`);
    where.push(critMatch === "any" && clauses.length > 1 ? `(${clauses.join(" OR ")})` : clauses.join(" AND "));
    for (const c of criteria) binds.push(+c.val);
  }

  // stat columns to SHOW: selected stats not already covered by a value column,
  // plus any active filter criterion (so filtering by a stat also surfaces it),
  // plus the stats a gear-score weighting uses -- so you can see the values feeding
  // the Score. Weighted keys that ARE value columns (dps/armor) surface as those.
  // Each needs a LEFT JOIN on item_stats for its value.
  const weightKeys = weights.map((w) => w.key);
  const weightStatCols = weightKeys.filter((k) => !VALUE_COL_KEYS.has(k) && GEAR_STAT_LABEL[k]);
  const weightValCols = weightKeys.filter((k) => VALUE_COL_KEYS.has(k)); // dps, armor
  const statSelKeys = selectedKeys.filter((k) => !VALUE_COL_KEYS.has(k) && GEAR_STAT_LABEL[k]);
  const critColKeys = criteria.filter((c) => !VALUE_COL_KEYS.has(c.key)).map((c) => c.key);
  const columnStatKeys = [...new Set([...critColKeys, ...statSelKeys, ...weightStatCols])];
  // item_stats-backed weighted keys are joined (the Score reads stat_<key>); the
  // derived extras (speed/ilvl) resolve from item columns instead, so skip them here.
  const joinKeys = [...new Set([...columnStatKeys, ...weightKeys.filter((k) => !WEIGHT_EXTRA_FN[k])])];
  const joins = joinKeys.map((key, n) => `LEFT JOIN item_stats s${n} ON s${n}.item=i.entry AND s${n}.stat='${key}'`).join(" ");
  const statSel2 = joinKeys.map((key, n) => `, s${n}.value AS stat_${key}`).join("");
  // the Fishing value column reads a correlated subquery (fishing isn't a GEAR stat).
  const fishingSel = selectedKeys.includes("fishing") ? ", (SELECT value FROM item_stats WHERE item = i.entry AND stat = 'fishing') AS fishing" : "";
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await query(
    `SELECT i.entry, i.name, i.quality, i.class, i.subclass, i.inventory_type, i.item_level, i.required_level, i.display_id,
            i.required_skill, i.dmg_min1, i.dmg_max1, i.delay, i.armor, i.container_slots, i.bonding, i.stackable,
            i.quest_faction, i.quest_min_level, i.allowable_race, i.sell_price, di.icon${statSel2}${fishingSel},
            (SELECT GROUP_CONCAT(source,',') FROM item_sources s WHERE s.item = i.entry) AS sources
     FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id ${joins} ${whereSql}
     ORDER BY i.quality DESC, i.item_level DESC`, binds);

  // gear score: Σ weight·stat over the weighted keys. Compute per row, then sort
  // score-desc so the "best gear for spec" floats to the top by default.
  let scoreCol = null;
  if (weights.length) {
    for (const r of rows) {
      let sc = 0;
      for (const { key, w } of weights) sc += w * (WEIGHT_EXTRA_FN[key] ? WEIGHT_EXTRA_FN[key](r) : (r[`stat_${key}`] || 0));
      r.__score = Math.round(sc * 10) / 10;
    }
    rows.sort((a, b) => b.__score - a.__score);
    scoreCol = { key: "score", label: "Score", num: true,
      cell: (r) => (r.__score ? `<b>${r.__score}</b>` : ""), value: (r) => r.__score ?? 0 };
  }

  const statCols = columnStatKeys.map((key) => ({
    key: `s_${key}`, label: statLabel(key), num: true,
    cell: (r) => { const v = r[`stat_${key}`]; return v == null ? "" : v; },
    value: (r) => r[`stat_${key}`] ?? 0,
  }));

  const subMap = f.class === "2" ? WEAPON_SUBCLASS : f.class === "4" ? ARMOR_SUBCLASS : null;
  const critRows = criteria.length ? criteria.map(critRow).join("") : critRow(null);
  const matchSel = `<select data-f="match" class="crit-match" title="How to combine the criteria below">
    <option value="all"${critMatch === "all" ? " selected" : ""}>Match all</option>
    <option value="any"${critMatch === "any" ? " selected" : ""}>Match any</option></select>`;
  const critInner = `<div data-criteria>
    <div class="crit-rows">${critRows}</div>
    <div class="sec-actions"><button type="button" class="crit-add" data-cadd>+ Add criterion</button>
      <span class="sec-inline">Match ${matchSel}</span></div>
  </div>`;
  // gear-score weight builder: preset dropdown + per-stat multiplier rows
  const presetGroups = [...new Set(STAT_WEIGHT_PRESETS.map((pr) => pr.group || "Presets"))];
  const presetSel = `<select data-wpreset><option value="">Preset…</option>${presetGroups.map((g) =>
    `<optgroup label="${esc(g)}">${STAT_WEIGHT_PRESETS.filter((pr) => (pr.group || "Presets") === g).map((pr) =>
      `<option value="${pr.id}"${pr.id === presetId ? " selected" : ""}>${esc(pr.label)}</option>`).join("")}</optgroup>`).join("")}</select>`;
  const wtRows = weights.length ? weights.map(weightRow).join("") : weightRow(null);
  const weightInner = `<div data-weights>
    <div class="wt-preset">${presetSel}</div>
    <div class="crit-rows wt-rows">${wtRows}</div>
    <button type="button" class="crit-add" data-wadd>+ Add stat</button>
  </div>`;

  // ---- active-filter chips (Iteration 3): a compact, removable summary. Each chip
  // carries the URL mutation that removes it (data-rf / data-rv / data-rcrit / data-rweights). ----
  const CSV = (s) => (s || "").split(",").filter(Boolean);
  const SRC = Object.fromEntries(ITEM_SOURCE);
  const chips = [];
  const chip = (labelHtml, rm) => chips.push(`<span class="chip">${labelHtml}<button type="button" class="chip-x" ${rm} aria-label="Remove">×</button></span>`);
  if (f.q) chip(`Name <b>${esc(f.q)}</b>`, `data-rf="q"`);
  if (f.class !== "") chip(`<b>${esc(ITEM_CLASS[f.class] || f.class)}</b>`, `data-rf="class"`);
  for (const v of CSV(f.subclass)) if (subMap && subMap[v]) chip(`<b>${esc(subMap[v])}</b>`, `data-rf="subclass" data-rv="${v}"`);
  for (const v of CSV(f.quality)) if (QUALITY[v]) chip(`<b style="color:${QUALITY[v].color}">${esc(QUALITY[v].name)}</b>`, `data-rf="quality" data-rv="${v}"`);
  for (const v of CSV(f.slot)) if (INV_TYPE[v]) chip(`Slot <b>${esc(INV_TYPE[v])}</b>`, `data-rf="slot" data-rv="${v}"`);
  for (const v of CSV(f.source)) if (SRC[v]) chip(`Source <b>${esc(SRC[v])}</b>`, `data-rf="source" data-rv="${v}"`);
  if (f.minrl !== "") chip(`Req ≥ <b>${esc(f.minrl)}</b>`, `data-rf="minrl"`);
  if (f.maxrl !== "") chip(`Req ≤ <b>${esc(f.maxrl)}</b>`, `data-rf="maxrl"`);
  if (f.minil !== "") chip(`iLvl ≥ <b>${esc(f.minil)}</b>`, `data-rf="minil"`);
  if (f.maxil !== "") chip(`iLvl ≤ <b>${esc(f.maxil)}</b>`, `data-rf="maxil"`);
  if (f.bind !== "") chip(`Bind <b>${esc(BONDING[f.bind] || f.bind)}</b>`, `data-rf="bind"`);
  if (f.uclass !== "") { const c = (CLASS_MASK.find((x) => String(x[0]) === f.uclass) || [])[1]; chip(`Usable <b>${esc(c || f.uclass)}</b>`, `data-rf="uclass"`); }
  if (f.faction !== "") chip(`Faction <b>${f.faction === "a" ? "Alliance" : "Horde"}</b>`, `data-rf="faction"`);
  if (f.prof !== "") chip(`Prof <b>${esc(PROFESSION_LABEL[f.prof] || f.prof)}</b>`, `data-rf="prof"`);
  if (f.unique === "1") chip(`<b>Unique</b>`, `data-rf="unique"`);
  for (const c of criteria) chip(`<b>${esc(GEAR_STAT_LABEL[c.key] || c.key)} ${esc(c.op)} ${esc(c.val)}</b>`, `data-rcrit="${esc(`${c.key},${c.op},${c.val}`)}"`);
  if (weights.length) chip(`⚔ <b>Gear score (${weights.length})</b>`, `data-rweights="1"`);
  const chipsHtml = chips.length
    ? `<div class="active-chips">${chips.join("")}<button type="button" class="chip-clear" data-reset="1">Clear all</button></div>` : "";

  // collapsible sub-sections; each auto-opens when it has active values + shows a count badge.
  const badge = (n) => (n ? ` <span class="badge">${n}</span>` : "");
  const moreCount = [f.minil, f.maxil, f.bind, f.uclass, f.faction, f.prof, f.unique === "1" ? "1" : ""].filter(Boolean).length;
  const section = (title, count, body, open = count) => `<details class="sec"${open ? " open" : ""}><summary>${title}${badge(count)}</summary><div class="sec-body">${body}</div></details>`;
  const moreBody = `<div class="filters embed">
    ${numField("minil", "iLvl ≥", f.minil)} ${numField("maxil", "iLvl ≤", f.maxil)}
    ${selectField("bind", "Bind", options(Object.entries(BONDING), f.bind, "Any"))}
    ${selectField("uclass", "Usable by", options(CLASS_MASK, f.uclass, "Any class"))}
    ${selectField("faction", "Faction", options([["a", "Alliance"], ["h", "Horde"]], f.faction, "Any"))}
    ${selectField("prof", "Profession", options(PROFESSION, f.prof, "Any"))}
    ${selectField("unique", "Unique", options([["1", "Unique only"]], f.unique, "Any"))}
  </div>`;
  // Columns is its own group -- it controls what's SHOWN, not what's filtered. Muted
  // badge = how many columns are visible; opens when a custom set is active.
  const colsSection = `<details class="sec cols-sec"${chosen.length ? " open" : ""}>
    <summary>Columns <span class="badge mut">${selectedKeys.length} shown</span></summary>
    <div class="sec-body"><p class="sec-hint">Choose which columns the results table shows.</p>${colsField(selectedKeys)}</div></details>`;
  const sectionsHtml = `<div class="filters-sections">
    ${section("More filters", moreCount, moreBody, moreCount)}
    ${section("Stat filters", criteria.length, critInner)}
    ${section("Gear score", weights.length, weightInner)}
    ${colsSection}
  </div>`;

  let panelOpen = true;
  try { panelOpen = localStorage.getItem("browseFiltersOpen") !== "0"; } catch { /* private mode */ }
  const filters = `${chipsHtml}
    <details class="filters-panel" data-fpanel${panelOpen ? " open" : ""}>
      <summary class="filters-toggle">Filters</summary>
      <div class="filters">
        ${textField("q", "Name", f.q)}
        ${selectField("class", "Class", options(Object.entries(ITEM_CLASS).filter(([k]) => !EMPTY_ITEM_CLASSES.has(k)), f.class, "Any class"))}
        ${subMap ? multiField("subclass", "Subtype", Object.entries(subMap), f.subclass) : ""}
        ${multiField("quality", "Quality", QUALITY.map((q, i) => [i, `<span style="color:${q.color}">${esc(q.name)}</span>`]), f.quality, true)}
        ${multiField("slot", "Slot", Object.entries(INV_TYPE), f.slot)}
        ${multiField("source", "Source", ITEM_SOURCE, f.source)}
        ${numField("minrl", "Req lvl ≥", f.minrl)} ${numField("maxrl", "Req lvl ≤", f.maxrl)}
        <div class="break"></div>
        ${sectionsHtml}
      </div>
    </details>`;
  // Display value columns = the chosen set plus any weighted value-col (dps/armor);
  // the Columns chooser itself still reflects only the user's selectedKeys.
  const displayKeys = weightValCols.length ? [...new Set([...selectedKeys, ...weightValCols])] : selectedKeys;
  const cols = buildItemCols(displayKeys, statCols, f.prof !== "");
  if (scoreCol) cols.splice(1, 0, scoreCol); // Score sits right after Name
  return { rows, cols, filters, noun: "items" };
}

async function browseNpcs(p) {
  const f = {
    q: p.get("q") || "", type: p.get("type") || "", rank: p.get("rank") || "",
    faction: p.get("faction") || "", minlvl: p.get("minlvl") || "", maxlvl: p.get("maxlvl") || "",
  };
  const where = ["c.name <> ''", "c.hidden = 0"], binds = [];
  const add = (cond, val) => { where.push(cond); binds.push(val); };
  if (f.q) { where.push("(c.name LIKE ? OR c.subname LIKE ?)"); binds.push(`%${f.q}%`, `%${f.q}%`); } // name OR title
  if (f.type !== "") add("c.type = ?", +f.type);
  if (f.rank !== "") add("c.rank = ?", +f.rank);
  if (f.faction !== "") add("ft.faction_id = ?", +f.faction);
  if (f.minlvl !== "") add("c.level_min >= ?", +f.minlvl);
  if (f.maxlvl !== "") add("c.level_max <= ?", +f.maxlvl);
  const whereSql = "WHERE " + where.join(" AND ");
  const rows = await query(
    `SELECT c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank, c.type,
            ft.faction_id, fn.name1 AS faction,
            (SELECT 1 FROM factions ff WHERE ff.id = ft.faction_id) AS faction_page,
            c.zone AS zone_id, z.name AS zone
     FROM creatures c
     LEFT JOIN faction_template ft ON ft.id = c.faction
     LEFT JOIN faction_names fn ON fn.id = ft.faction_id
     LEFT JOIN zones z ON z.areaid = c.zone
     ${whereSql} ORDER BY c.level_max DESC, c.name`, binds);

  // Faction dropdown: only factions that actually have member NPCs, by name.
  const frows = await query(`SELECT DISTINCT ft.faction_id AS id, fn.name1 AS name
    FROM creatures c JOIN faction_template ft ON ft.id = c.faction
    JOIN faction_names fn ON fn.id = ft.faction_id WHERE c.name <> '' AND fn.name1 <> ''`);
  const fopts = frows.map((r) => [String(r.id), r.name]).sort((a, b) => a[1].localeCompare(b[1]));

  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("type", "Type", options(Object.entries(CREATURE_TYPE), f.type, "Any type"))}
    ${selectField("rank", "Rank", options([[0, "Normal"], ...Object.entries(CREATURE_RANK)], f.rank, "Any rank"))}
    ${selectField("faction", "Faction", options(fopts, f.faction, "Any faction"))}
    ${numField("minlvl", "Level ≥", f.minlvl)} ${numField("maxlvl", "Level ≤", f.maxlvl)}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  const hide = [f.type !== "" && "type", f.rank !== "" && "rank", f.faction !== "" && "faction"].filter(Boolean);
  return { rows, cols: hideCols(NPC_COLS, hide), filters, noun: "NPCs" };
}

// Effective craft skill: many Turtle recipes have a bogus skill_req=1 while the
// real trivial range is e.g. 175-210, so use skill_min when it's higher -- this is
// also the sort/progression key (see craftSkill()).
function craftSkill(c) {
  // orange = the required/learn skill (when you can first craft, 100% skill-up).
  // NOT max(min, req): with req < min (e.g. a 300-recipe whose trivial band is
  // 320/340) max() would equal yellow and drop the real orange (-> "320 330 340"
  // instead of wowhead's "300 320 330 340").
  return c.req || c.min || 0;
}

// Skill-up difficulty colors (orange→yellow→green→grey): orange = the effective
// start, then the trivial range yellow(min) / green(mid) / grey(max). Adjacent
// equal values are deduped so a recipe doesn't read "175 175 193 210".
function craftSkillCell(c) {
  const span = (v, col) => `<span style="color:${col}">${v}</span>`;
  const start = craftSkill(c);
  if (!c.max) return span(start, "#ff8040");
  const min = c.min || start, green = Math.round((min + c.max) / 2);
  const bands = [[start, "#ff8040"], [min, "#ffd100"], [green, "#40c040"], [c.max, "#808080"]];
  const out = [];
  let prev = null;
  for (const [v, col] of bands) { if (v !== prev) out.push(span(v, col)); prev = v; }
  return `<span style="white-space:nowrap">${out.join(" ")}</span>`;
}

// Gathering professions (Fishing/Herbalism/Skinning) craft nothing, so the recipe
// query is empty for them. Show their learnable abilities + trainers instead: the
// spell, its proficiency tier, which NPCs teach it, and which faction those
// trainers serve (answers "what do I learn and where / from which side").
async function browseGathering(p, f) {
  const rows = await query(Q_PROFESSION_LEARN, [+f.prof]);
  const bySpell = new Map();
  for (const r of rows) {
    let g = bySpell.get(r.spell);
    if (!g) { g = { spell: r.spell, name: r.name, rank: r.rank, icon: r.icon, trainers: [] }; bySpell.set(r.spell, g); }
    if (r.npc) g.trainers.push({ npc: r.npc, name: r.npc_name, level: r.npc_level, team: r.team });
  }
  let list = [...bySpell.values()];
  if (f.q) { const ql = f.q.toLowerCase(); list = list.filter((c) => (c.name || "").toLowerCase().includes(ql)); }
  // tier from the spell rank word ("Rank 2" and the like sort last)
  const rankVal = (c) => SKILL_RANK_ORDER[(c.rank || "").split(" ")[0]] || 99;
  // which sides can learn it here (union of the trainers' teams)
  const teamsText = (c) => {
    const s = new Set(c.trainers.map((t) => t.team || 0));
    const parts = [];
    if (s.has(1) || s.has(3)) parts.push("Alliance");
    if (s.has(2) || s.has(3)) parts.push("Horde");
    if (s.has(0)) parts.push("Neutral");
    return parts.length ? parts.join(" · ") : "—";
  };
  const cols = [
    { key: "name", label: "Ability", cell: (c) => spellLink(c.spell, c.rank ? `${c.name} (${c.rank})` : c.name, c.icon), value: (c) => c.name },
    { key: "tier", label: "Tier", cls: "muted", cell: (c) => esc(c.rank || ""), value: rankVal },
    { key: "trainers", label: "Trainers", cell: (c) => trainerCell(c.trainers), value: (c) => c.trainers.length },
    { key: "faction", label: "Faction", cls: "muted", cell: (c) => esc(teamsText(c)), value: (c) => teamsText(c), group: (c) => teamsText(c) },
  ];
  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("prof", "Profession", options(PROFESSION, f.prof, "Any"))}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  return { rows: list, cols, filters, noun: "abilities", noGroup: true };
}

// Trainer NPC list for one ability: faction badge + link, ordered Alliance ->
// Horde -> Neutral then level. Capped -- the ability's spell page has the full list.
const TEAM_ORDER = { 1: 0, 2: 1, 3: 2, 0: 3 };
function trainerCell(trainers) {
  if (!trainers.length) return `<span class="muted">Not taught by a trainer</span>`;
  const sorted = [...trainers].sort((a, b) =>
    (TEAM_ORDER[a.team] - TEAM_ORDER[b.team]) || ((a.level || 0) - (b.level || 0)) || a.name.localeCompare(b.name));
  const CAP = 8;
  const shown = sorted.slice(0, CAP).map((t) => `${teamBadge(t.team)} ${npcLink(t.npc, t.name)}`);
  const extra = sorted.length - CAP;
  return `<span class="trainer-list">${shown.join(", ")}${extra > 0 ? `<span class="muted">, +${extra} more</span>` : ""}</span>`;
}

async function browseCrafting(p) {
  const f = { q: p.get("q") || "", prof: p.get("prof") || "", obtainable: p.get("obtainable") !== "0" };
  if (f.prof && GATHERING_SKILLS.has(+f.prof)) return browseGathering(p, f);
  const rows = await query(Q_CRAFTING, []);
  // one query row per (craft spell, reagent); fold reagents into one craft per spell.
  const bySpell = new Map();
  for (const r of rows) {
    let g = bySpell.get(r.spell);
    if (!g) {
      g = {
        spell: r.spell, item: r.item, item_name: r.item_name, quality: r.quality, item_icon: r.item_icon,
        spell_name: r.spell_name, spell_icon: r.spell_icon,
        skill: r.skill, req: r.learn_req ?? r.skill_req, min: r.skill_min, max: r.skill_max,
        trainer: r.trainer, auto: r.auto, recipe_item: r.recipe_item, recipe_name: r.recipe_name, recipe_quality: r.recipe_quality, recipe_icon: r.recipe_icon,
        reagents: [],
      };
      bySpell.set(r.spell, g);
    }
    if (r.reagent) g.reagents.push({ item: r.reagent, name: r.reagent_name, quality: r.reagent_quality, icon: r.reagent_icon, count: r.count || 1 });
  }
  let crafts = [...bySpell.values()];
  if (f.prof) crafts = crafts.filter((c) => String(c.skill) === f.prof);
  if (f.q) { const ql = f.q.toLowerCase(); crafts = crafts.filter((c) => (c.item_name || c.spell_name || "").toLowerCase().includes(ql)); }
  // hide crafts with no way to learn them (no recipe/trainer/auto) -- on by default
  if (f.obtainable) crafts = crafts.filter((c) => c.recipe_item || c.trainer || c.auto);

  const cols = [
    // enchant crafts produce no item -- link the craft spell itself as the product
    { key: "name", label: "Name", cell: (c) => (c.item ? itemLink(c.item, c.item_name, c.quality, c.item_icon) : spellLink(c.spell, c.spell_name, c.spell_icon)), value: (c) => c.item_name || c.spell_name },
    { key: "prof", label: "Profession", cls: "muted", cell: (c) => esc(PROFESSION_LABEL[c.skill] || ""), value: (c) => PROFESSION_LABEL[c.skill] || "" },
    { key: "skill", label: "Skill", num: true, cell: (c) => craftSkillCell(c), value: (c) => craftSkill(c) },
    { key: "reagents", label: "Reagents", cls: "muted", cell: (c) => c.reagents.map((r) => `${itemLink(r.item, r.name, r.quality, r.icon)}${r.count > 1 ? ` ×${r.count}` : ""}`).join(", "), value: (c) => c.reagents.length },
    { key: "source", label: "Source",
      cell: (c) => (c.recipe_item ? itemLink(c.recipe_item, c.recipe_name, c.recipe_quality, c.recipe_icon)
        : c.trainer ? `<span class="tagx src-crafted">Trainer</span>`
          : c.auto ? `<span class="tagx" title="Learned automatically with the profession">Auto</span>` : "—"),
      value: (c) => (c.recipe_item ? "Recipe" : c.trainer ? "Trainer" : c.auto ? "Auto" : ""),
      // group by source TYPE; the header shows the type, not the first recipe's name
      group: (c) => (c.recipe_item ? "Recipe" : c.trainer ? "Trainer" : c.auto ? "Auto" : "Other") },
  ];
  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("prof", "Profession", options(PROFESSION, f.prof, "Any"))}
    ${checkField("obtainable", "Obtainable only", f.obtainable)}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  return { rows: crafts, cols: hideCols(cols, f.prof ? ["prof"] : []), filters, noun: "crafts" };
}

async function browseSpells(p) {
  const f = { q: p.get("q") || "", cat: p.get("cat") || "", cls: p.get("cls") || "", prof: p.get("prof") || "", school: p.get("school") || "" };
  // The spells table is large but each row is tiny; load all and filter/sort/
  // paginate client-side via createTable (consistent with crafting).
  let rows = await query(Q_BROWSE_SPELLS, []);
  if (f.q) { const ql = f.q.toLowerCase(); rows = rows.filter((r) => (r.name || "").toLowerCase().includes(ql)); }
  if (f.cat) rows = rows.filter((r) => r.category === f.cat);
  if (f.cls) rows = rows.filter((r) => (r.class_mask & +f.cls) !== 0);
  if (f.prof) rows = rows.filter((r) => String(r.skill) === f.prof);
  if (f.school !== "") rows = rows.filter((r) => String(r.school) === f.school);
  const secs = (ms) => (ms ? `${+(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s` : "");
  const rankNum = (r) => { const m = (r.rank || "").match(/\d+/); return m ? +m[0] : 0; };
  const cols = [
    { key: "name", label: "Name", cell: (r) => spellLink(r.entry, r.name, r.icon), value: (r) => r.name },
    { key: "category", label: "Category", cls: "muted", cell: (r) => esc(r.category || ""), value: (r) => r.category || "" },
    { key: "rank", label: "Rank", num: true, cls: "muted", cell: (r) => esc(r.rank || ""), value: rankNum },
    { key: "school", label: "School", cls: "muted", cell: (r) => esc(SPELL_SCHOOL[r.school] || ""), value: (r) => SPELL_SCHOOL[r.school] || "" },
    // Rage is stored x10 (max rage 100 = 1000 units) -> divide for display.
    { key: "cost", label: "Cost", num: true, cls: "muted", cell: (r) => (r.mana_cost ? `${spellCostVal(r)}` : ""), value: (r) => spellCostVal(r) },
    { key: "cast", label: "Cast", num: true, cls: "muted", cell: (r) => (r.channeled ? "Channeled" : r.cast_ms ? secs(r.cast_ms) : ""), value: (r) => r.cast_ms || 0 },
    { key: "level", label: "Level", num: true, cls: "muted", cell: (r) => (r.spell_level || ""), value: (r) => r.spell_level || 0 },
    { key: "prof", label: "Profession", cls: "muted", cell: (r) => esc(PROFESSION_LABEL[r.skill] || ""), value: (r) => PROFESSION_LABEL[r.skill] || "" },
  ];
  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("cat", "Category", options(SPELL_CATEGORIES.map((c) => [c, c]), f.cat, "Any category"))}
    ${selectField("cls", "Class", options(CLASS_MASK, f.cls, "Any class"))}
    ${selectField("school", "School", options(Object.entries(SPELL_SCHOOL), f.school, "Any school"))}
    ${selectField("prof", "Profession", options(PROFESSION, f.prof, "Any profession"))}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  // Class-oriented view (class filter, or browsing class skills) -> show spell Level
  // instead of the irrelevant Profession column; profession view does the reverse.
  const classView = !!f.cls || f.cat === "Class Skills";
  const hide = [classView ? "prof" : "level"];
  if (f.cat) hide.push("category");
  if (f.prof) { hide.push("prof"); if (!hide.includes("level")) hide.push("level"); }
  return { rows, cols: hideCols(cols, hide), filters, noun: "spells" };
}

async function browseQuests(p) {
  const f = {
    q: p.get("q") || "", zone: p.get("zone") || "", type: p.get("type") || "",
    minlvl: p.get("minlvl") || "", maxlvl: p.get("maxlvl") || "",
    class: p.get("class") || "", faction: p.get("faction") || "", origin: p.get("origin") || "",
  };
  const where = ["q.title <> ''", "q.hidden = 0"], binds = [];
  const add = (cond, val) => { where.push(cond); binds.push(val); };
  if (f.q) add("q.title LIKE ?", `%${f.q}%`);
  // origin: Turtle-WoW custom additions (q.custom = 1) vs vanilla 1.12 (0).
  if (f.origin === "tw") where.push("q.custom = 1");
  else if (f.origin === "vanilla") where.push("q.custom = 0");
  if (f.zone !== "") add("q.zone = ?", +f.zone);
  if (f.type !== "") add("q.type = ?", +f.type);
  if (f.minlvl !== "") add("q.level >= ?", +f.minlvl);
  if (f.maxlvl !== "") add("q.level <= ?", +f.maxlvl);
  // required class: unrestricted (0) or the class bit is set.
  if (f.class !== "") { where.push("(q.reqclasses = 0 OR (q.reqclasses & ?) <> 0)"); binds.push(+f.class); }
  // faction: quest restricted to one side's races only.
  const factionCond = "(q.reqraces <> 0 AND (q.reqraces & ?) <> 0 AND (q.reqraces & ?) = 0)";
  if (f.faction === "a") { where.push(factionCond); binds.push(RACE_ALLIANCE, RACE_HORDE); }
  else if (f.faction === "h") { where.push(factionCond); binds.push(RACE_HORDE, RACE_ALLIANCE); }
  const whereSql = "WHERE " + where.join(" AND ");
  const rows = await query(
    `SELECT q.entry, q.title, q.level, q.zone, q.type, q.custom, a.name AS zone_name, z.areaid AS zone_page
     FROM quests q LEFT JOIN areas a ON a.entry = q.zone
     LEFT JOIN zones z ON z.areaid = q.zone ${whereSql}
     ORDER BY q.level, q.title`, binds);

  // Zone dropdown: only zones/categories that actually carry quests, labeled.
  const zrows = await query(`SELECT DISTINCT q.zone, a.name AS zone_name FROM quests q LEFT JOIN areas a ON a.entry = q.zone WHERE q.title <> ''`);
  const zopts = zrows.map((z) => [String(z.zone), questZoneLabel(z.zone, z.zone_name)])
    .filter(([, l]) => l).sort((a, b) => a[1].localeCompare(b[1]));

  const cols = [
    { key: "name", label: "Title", cell: (r) => questLink(r.entry, r.title) + (r.custom ? ' <span class="tagx tw-tag" title="Added by Turtle WoW (not in vanilla 1.12)">TW</span>' : ""), value: (r) => r.title },
    { key: "level", label: "Level", num: true, cls: "muted", cell: (r) => r.level || "", value: (r) => r.level || 0 },
    { key: "zone", label: "Zone", cls: "muted",
      cell: (r) => (r.zone_page ? zoneLink(r.zone, questZoneLabel(r.zone, r.zone_name)) : esc(questZoneLabel(r.zone, r.zone_name))),
      value: (r) => questZoneLabel(r.zone, r.zone_name) },
    { key: "type", label: "Type", cls: "muted", cell: (r) => QUEST_TYPE[r.type] || "", value: (r) => QUEST_TYPE[r.type] || "" },
  ];
  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("zone", "Zone", options(zopts, f.zone, "Any zone"))}
    ${selectField("type", "Type", options(Object.entries(QUEST_TYPE), f.type, "Any type"))}
    ${numField("minlvl", "Level ≥", f.minlvl)} ${numField("maxlvl", "Level ≤", f.maxlvl)}
    ${selectField("class", "Class", options(CLASS_MASK, f.class, "Any class"))}
    ${selectField("faction", "Faction", options([["a", "Alliance"], ["h", "Horde"]], f.faction, "Any"))}
    ${selectField("origin", "Origin", options([["tw", "Turtle WoW"], ["vanilla", "Classic 1.12"]], f.origin, "Any"))}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  const hide = [f.zone !== "" && "zone", f.type !== "" && "type"].filter(Boolean);
  return { rows, cols: hideCols(cols, hide), filters, noun: "quests" };
}

async function browseFactions(p) {
  const f = { q: p.get("q") || "" };
  let rows = await query(Q_FACTIONS, []);
  if (f.q) { const ql = f.q.toLowerCase(); rows = rows.filter((r) => (r.name || "").toLowerCase().includes(ql)); }
  const cols = [
    { key: "name", label: "Faction", cell: (r) => factionLink(r.id, r.name), value: (r) => r.name || "" },
    { key: "items", label: "Items", num: true, cls: "muted", cell: (r) => r.items || "", value: (r) => r.items || 0 },
    { key: "repquests", label: "Rep Quests", num: true, cls: "muted", cell: (r) => r.repquests || "", value: (r) => r.repquests || 0 },
  ];
  const filters = `<div class="filters">${textField("q", "Name", f.q)}<button class="reset" data-reset="1">Reset</button></div>`;
  return { rows, cols, filters, noun: "factions" };
}

async function browseZones(p) {
  const f = { q: p.get("q") || "", cont: p.get("cont") || "" };
  let rows = await query(Q_ZONES, []);
  if (f.cont !== "") rows = rows.filter((r) => String(r.mapid) === f.cont);
  if (f.q) { const ql = f.q.toLowerCase(); rows = rows.filter((r) => (r.name || "").toLowerCase().includes(ql)); }
  const cols = [
    { key: "name", label: "Zone", cell: (r) => zoneLink(r.areaid, r.name), value: (r) => r.name || "" },
    { key: "continent", label: "Continent", cls: "muted", hideUniform: true, cell: (r) => CONTINENT[r.mapid] || "", value: (r) => CONTINENT[r.mapid] || "" },
    { key: "spawns", label: "Spawns", num: true, cls: "muted", cell: (r) => r.spawns || "", value: (r) => r.spawns || 0 },
  ];
  const filters = `<div class="filters">${textField("q", "Name", f.q)}${selectField("cont", "Continent", options(Object.entries(CONTINENT), f.cont, "Any continent"))}<button class="reset" data-reset="1">Reset</button></div>`;
  return { rows, cols, filters, noun: "zones" };
}

async function browseItemsets(p) {
  const f = { q: p.get("q") || "" };
  let rows = await query(Q_BROWSE_ITEMSETS, []);
  rows = rows.filter((r) => r.pieces > 0); // sets whose items aren't in this build
  if (f.q) { const ql = f.q.toLowerCase(); rows = rows.filter((r) => (r.name || "").toLowerCase().includes(ql)); }
  const lvl = (r) => (r.maxlvl ? (r.minlvl === r.maxlvl ? `${r.minlvl}` : `${r.minlvl}-${r.maxlvl}`) : "");
  const cols = [
    { key: "name", label: "Item Set", cell: (r) => `<a class="ilink" href="?itemset=${r.id}">${esc(r.name)}</a>`, value: (r) => r.name || "" },
    { key: "pieces", label: "Pieces", num: true, cls: "muted", cell: (r) => r.pieces || "", value: (r) => r.pieces || 0 },
    { key: "level", label: "Req Level", num: true, cls: "muted", cell: (r) => lvl(r), value: (r) => r.maxlvl || 0 },
  ];
  const filters = `<div class="filters">${textField("q", "Name", f.q)}<button class="reset" data-reset="1">Reset</button></div>`;
  return { rows, cols, filters, noun: "item sets" };
}

// Objects finder: interactive gameobjects (harvest nodes / chests / quest objects),
// grouped by name. Type + name filtered client-side over the small (~few k) set.
async function browseObjects(p) {
  const f = { q: p.get("q") || "", type: p.get("type") || "" };
  let rows = await query(Q_BROWSE_OBJECTS, []);
  if (f.q) { const ql = f.q.toLowerCase(); rows = rows.filter((r) => (r.name || "").toLowerCase().includes(ql)); }
  if (f.type !== "") rows = rows.filter((r) => String(r.type) === f.type);
  const cols = [
    { key: "name", label: "Name", cell: (r) => objectLink(r.entry, r.name), value: (r) => r.name || "" },
    { key: "type", label: "Type", cls: "muted", hideUniform: true, cell: (r) => GAMEOBJECT_TYPE[r.type] || "Object", value: (r) => GAMEOBJECT_TYPE[r.type] || "Object" },
    { key: "loot", label: "Loot", cls: "muted", cell: (r) => (r.has_loot ? "✓" : ""), value: (r) => r.has_loot || 0 },
    { key: "spawns", label: "Spawns", num: true, cls: "muted", cell: (r) => r.spawns || "", value: (r) => r.spawns || 0 },
  ];
  // only the object types actually present, so the dropdown isn't full of dead ends
  const presentTypes = [...new Set(rows.map((r) => r.type))];
  const typeOpts = Object.entries(GAMEOBJECT_TYPE).filter(([id]) => presentTypes.includes(+id));
  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("type", "Type", options(typeOpts, f.type, "Any type"))}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  return { rows, cols, filters, noun: "objects" };
}

export async function showBrowse(kind, navigate) {
  const app = document.getElementById("app");
  const isNpc = kind === "npcs";
  const isItems = kind === "items";
  const isQuests = kind === "quests";
  const isFactions = kind === "factions";
  const isZones = kind === "zones";
  const isSpells = kind === "spells";
  const isItemsets = kind === "itemsets";
  const isObjects = kind === "objects";
  const heading = isNpc ? "NPCs" : kind === "crafting" ? "Crafting" : isQuests ? "Quests" : isFactions ? "Factions" : isZones ? "Zones" : isSpells ? "Spells" : isItemsets ? "Item Sets" : isObjects ? "Objects" : "Items";
  document.title = `Browse ${heading} - Tortoise-WoW DB`;
  app.innerHTML = `<div class="loading">Loading…</div>`;
  const p = new URLSearchParams(location.search);
  let view;
  try { view = kind === "crafting" ? await browseCrafting(p) : isZones ? await browseZones(p) : isFactions ? await browseFactions(p) : isQuests ? await browseQuests(p) : isNpc ? await browseNpcs(p) : isSpells ? await browseSpells(p) : isItemsets ? await browseItemsets(p) : isObjects ? await browseObjects(p) : await browseItems(p); }
  catch (e) { app.innerHTML = `<div class="error">Failed: ${esc(e.message || e)}</div>`; return; }

  // items get row selection + clipboard/external operations on the selection.
  const selbar = !isItems ? "" : `<div class="selbar" data-selbar>
    <span class="selcount" data-selcount>0 selected</span>
    <button type="button" data-op="ids" disabled>Copy IDs</button>
    <span class="op-prefix"><input type="text" data-prefix value=".additem " aria-label="line prefix">
      <button type="button" data-op="prefix" disabled>Copy w/ prefix</button></span>
    <button type="button" data-op="compare" disabled>Compare</button>
    <button type="button" data-op="wh" disabled>Open on Wowhead</button>
    <button type="button" data-op="clear" disabled>Clear</button>
    <span class="op-status" data-opstatus></span>
  </div>`;
  app.innerHTML = `<div class="browse"><h1>Browse ${esc(heading)}</h1>${view.filters}
    <p class="browse-count">${view.rows.length.toLocaleString()} ${view.noun}</p>
    ${selbar}
    <div data-browse></div></div>`;
  const tableEl = app.querySelector("[data-browse]");
  const bar = app.querySelector("[data-selbar]");
  const updateSelbar = (count) => {
    if (!bar) return;
    bar.querySelector("[data-selcount]").textContent = `${count} selected`;
    bar.querySelectorAll("[data-op]").forEach((b) => { b.disabled = count === 0; });
  };
  let tableApi = null;
  if (view.rows.length) {
    tableApi = createTable(tableEl, {
      columns: view.cols, rows: view.rows, pageSize: PAGE, groupable: true,
      sort: p.get("sort"), dir: p.get("dir"),
      group: view.noGroup ? (p.get("groupby") || null) : (p.get("groupby") ?? (kind === "crafting" ? "prof" : null)),
      selectable: isItems, rowKey: isItems ? (r) => r.entry : undefined,
      onSelectionChange: bar ? (count) => updateSelbar(count) : undefined,
      // mirror sort/group into the URL (no re-render) so the view is shareable
      onState: (s) => {
        const np = new URLSearchParams(location.search);
        if (s.sort) { np.set("sort", s.sort); np.set("dir", s.dir); } else { np.delete("sort"); np.delete("dir"); }
        if (s.group) np.set("groupby", s.group); else np.delete("groupby");
        history.replaceState({}, "", "?" + np.toString());
      },
    });
  } else if (bar) { bar.remove(); tableEl.innerHTML = `<p class="muted">No matches.</p>`; }
  else tableEl.innerHTML = `<p class="muted">No matches.</p>`;
  if (bar && tableApi) wireSelbar(bar, tableApi, navigate);

  const collect = () => {
    const np = new URLSearchParams();
    np.set("browse", kind);
    app.querySelectorAll("[data-f]").forEach((el) => {
      // default-on checkbox: omit when checked (the default), emit =0 when off
      if (el.type === "checkbox") { if (!el.checked) np.set(el.dataset.f, "0"); return; }
      if (el.dataset.f === "match" && el.value === "all") return; // AND is the default
      if (el.value !== "") np.set(el.dataset.f, el.value);
    });
    const multi = {};
    app.querySelectorAll("[data-mv]:checked").forEach((cb) => { (multi[cb.dataset.mv] ??= []).push(cb.value); });
    for (const k in multi) np.set(k, multi[k].join(","));
    // Columns: drop cols= when it matches the class defaults, so the view stays
    // adaptive (a bare URL re-derives defaults) and shared URLs aren't cluttered.
    if (isItems) {
      const defs = defaultColKeys(np.get("class") || "", np.get("subclass") || "", np.get("slot") || "");
      const cur = multi.cols || [];
      if (cur.length === defs.length && cur.every((k) => defs.includes(k))) np.delete("cols");
    }
    const crits = [];
    app.querySelectorAll("[data-crow]").forEach((row) => {
      const key = row.querySelector("[data-cstat]").value;
      const op = row.querySelector("[data-cop]").value;
      const val = row.querySelector("[data-cval]").value;
      if (key && op && val !== "") crits.push(`${key},${op},${val}`);
    });
    if (crits.length) np.set("stats", crits.join("|"));
    // gear-score weights ("key:w|key:w"); the item finder recomputes the Score
    // column + score-desc default sort from these.
    const wts = [];
    app.querySelectorAll("[data-wrow]").forEach((row) => {
      const key = row.querySelector("[data-wstat]").value;
      const w = row.querySelector("[data-wval]").value;
      if (key && w !== "" && +w !== 0) wts.push(`${key}:${w}`);
    });
    if (wts.length) np.set("weights", wts.join("|"));
    // preserve active sort/group across filter changes, but drop a sort that
    // points at a criterion column (s_*) or the Score column once it's gone.
    const cur = new URLSearchParams(location.search);
    const liveStatCols = new Set([
      ...crits.map((c) => "s_" + c.split(",")[0]),
      ...(multi.cols || []).filter((k) => GEAR_STAT_LABEL[k]).map((k) => "s_" + k),
    ]);
    const sort = cur.get("sort");
    const keepSort = sort && (sort === "score" ? wts.length > 0 : (!sort.startsWith("s_") || liveStatCols.has(sort)));
    if (keepSort) {
      np.set("sort", sort);
      const dir = cur.get("dir"); if (dir) np.set("dir", dir);
    }
    const groupby = cur.get("groupby"); if (groupby) np.set("groupby", groupby);
    return np;
  };
  app.querySelectorAll("[data-f]").forEach((el) =>
    el.addEventListener("change", () => {
      const np = collect();
      // class change resets subtype AND columns -> the new class re-derives its
      // adaptive default columns (a weapon's DPS/Speed shouldn't linger on armor).
      if (el.dataset.f === "class") { np.delete("subclass"); np.delete("cols"); }
      navigate(`?${np.toString()}`);
    }));
  // multi-select dropdowns
  app.querySelectorAll(".multi-btn").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wrap = btn.closest("[data-multi]"), panel = wrap.querySelector(".multi-panel");
    const willOpen = !panel.classList.contains("open");
    app.querySelectorAll(".multi-panel.open").forEach((p) => p.classList.remove("open"));
    panel.classList.toggle("open", willOpen);
    openMulti = willOpen ? wrap.dataset.multi : null;
  }));
  app.querySelectorAll("[data-mv]").forEach((cb) => cb.addEventListener("change", () => navigate(`?${collect().toString()}`)));
  if (openMulti) { const p = app.querySelector(`[data-multi="${openMulti}"] .multi-panel`); if (p) p.classList.add("open"); }
  if (!document.__multiClose) {
    document.__multiClose = true;
    document.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".multi")) {
        document.querySelectorAll(".multi-panel.open").forEach((p) => p.classList.remove("open"));
        openMulti = null;
      }
    });
  }
  // multi-criteria gear filter (rows added/removed client-side; URL updates on change)
  const critWrap = app.querySelector("[data-criteria]");
  if (critWrap) {
    critWrap.addEventListener("change", (e) => {
      const row = e.target.closest("[data-crow]");
      if (!row) return;
      const key = row.querySelector("[data-cstat]").value;
      const val = row.querySelector("[data-cval]").value;
      // navigate when the row is actionable: complete, or its stat was just cleared
      if ((key && val !== "") || (e.target.matches("[data-cstat]") && !key)) navigate(`?${collect().toString()}`);
    });
    critWrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-cadd]")) {
        e.preventDefault();
        critWrap.querySelector(".crit-rows").insertAdjacentHTML("beforeend", critRow(null));
      } else if (e.target.closest("[data-crm]")) {
        e.preventDefault();
        const row = e.target.closest("[data-crow]");
        if (critWrap.querySelectorAll("[data-crow]").length > 1) row.remove();
        else { row.querySelector("[data-cstat]").value = ""; row.querySelector("[data-cval]").value = ""; }
        // always re-navigate: guarantees the table + columns rebuild from the
        // remaining criteria (a removed column must never linger).
        navigate(`?${collect().toString()}`);
      }
    });
  }
  // gear-score weights: preset dropdown fills the rows; rows add/remove/edit like criteria
  const wtWrap = app.querySelector("[data-weights]");
  if (wtWrap) {
    const preset = wtWrap.querySelector("[data-wpreset]");
    if (preset) preset.addEventListener("change", () => {
      const pr = STAT_WEIGHT_PRESET_MAP[preset.value];
      if (!pr) return;
      const np = collect();
      np.set("weights", Object.entries(pr.weights).map(([k, w]) => `${k}:${w}`).join("|"));
      np.set("sort", "score"); np.set("dir", "d"); // preset -> rank by score desc
      navigate(`?${np.toString()}`);
    });
    wtWrap.addEventListener("change", (e) => {
      const row = e.target.closest("[data-wrow]");
      if (!row) return;
      const key = row.querySelector("[data-wstat]").value;
      const val = row.querySelector("[data-wval]").value;
      if ((key && val !== "") || (e.target.matches("[data-wstat]") && !key)) navigate(`?${collect().toString()}`);
    });
    wtWrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-wadd]")) {
        e.preventDefault();
        wtWrap.querySelector(".wt-rows").insertAdjacentHTML("beforeend", weightRow(null));
      } else if (e.target.closest("[data-wrm]")) {
        e.preventDefault();
        const row = e.target.closest("[data-wrow]");
        if (wtWrap.querySelectorAll("[data-wrow]").length > 1) row.remove();
        else { row.querySelector("[data-wstat]").value = ""; row.querySelector("[data-wval]").value = ""; }
        navigate(`?${collect().toString()}`);
      }
    });
  }
  app.querySelectorAll("[data-reset]").forEach((r) => r.addEventListener("click", () => navigate(`?browse=${kind}`)));

  // active-filter chips: each carries the URL mutation that removes it. Editing the
  // live query params directly is simpler + robust vs. round-tripping through collect().
  app.querySelectorAll(".chip-x").forEach((btn) => btn.addEventListener("click", () => {
    const np = new URLSearchParams(location.search);
    const d = btn.dataset;
    if (d.rf) {
      if (d.rv != null) {
        const vals = (np.get(d.rf) || "").split(",").filter((v) => v && v !== d.rv);
        if (vals.length) np.set(d.rf, vals.join(",")); else np.delete(d.rf);
      } else np.delete(d.rf);
      if (d.rf === "class") { np.delete("subclass"); np.delete("cols"); } // class change resets both
    } else if (d.rcrit) {
      const keep = (np.get("stats") || "").split("|").filter((s) => s && s !== d.rcrit);
      if (keep.length) np.set("stats", keep.join("|")); else np.delete("stats");
      if (np.get("sort") === `s_${d.rcrit.split(",")[0]}`) { np.delete("sort"); np.delete("dir"); }
    } else if (d.rweights) {
      np.delete("weights"); np.delete("preset");
      if (np.get("sort") === "score") { np.delete("sort"); np.delete("dir"); }
    }
    navigate(`?${np.toString()}`);
  }));

  // remember whether the Filters panel is expanded (UI preference, not in the URL)
  const fpanel = app.querySelector("[data-fpanel]");
  if (fpanel) fpanel.addEventListener("toggle", () => {
    try { localStorage.setItem("browseFiltersOpen", fpanel.open ? "1" : "0"); } catch { /* private mode */ }
  });
}
