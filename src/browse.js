// Browse / finder views with filters (wowhead-style). Filtering runs as SQL
// against the in-memory DB; sorting + pagination are handled client-side by the
// shared sortable table (src/table.js), the same one used everywhere else.
import { query } from "./db.js";
import { Q_CRAFTING, Q_FACTIONS, Q_ZONES, Q_BROWSE_SPELLS, Q_BROWSE_ITEMSETS } from "./queries.js";
import { itemLink, npcLink, questLink, factionLink, zoneLink, spellLink, sourceTags, esc } from "./render.js";
import { createTable } from "./table.js";
import {
  ITEM_CLASS, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE, QUALITY,
  CREATURE_TYPE, CREATURE_RANK, GEAR_CRITERIA, GEAR_STAT_LABEL, ITEM_SOURCE,
  BONDING, CLASS_MASK, PROFESSION, PROFESSION_LABEL, RACE_ALLIANCE, RACE_HORDE,
  QUEST_TYPE, CONTINENT, SPELL_SCHOOL, SPELL_CATEGORIES, questZoneLabel,
} from "./constants.js";

const PAGE = 100;
const lvlRange = (r) => (r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : (r.level_min || ""));

const dpsVal = (r) => (r.delay > 0 && (r.dmg_min1 || r.dmg_max1) ? ((r.dmg_min1 + r.dmg_max1) / 2) / (r.delay / 1000) : 0);
// Rage is stored x10 (max rage 100 = 1000 units); divide it for display.
const spellCostVal = (r) => (r.power_type === 1 ? (r.mana_cost || 0) / 10 : (r.mana_cost || 0));

const COL = {
  name: { key: "name", label: "Name", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
  ilvl: { key: "ilvl", label: "iLvl", num: true, cls: "muted", cell: (r) => r.item_level || "", value: (r) => r.item_level || 0 },
  req: { key: "req", label: "Req", num: true, cls: "muted", hideEmpty: true, cell: (r) => r.required_level || "", value: (r) => r.required_level || 0 },
  slot: { key: "slot", label: "Slot", cls: "muted", hideUniform: true, cell: (r) => INV_TYPE[r.inventory_type] || "", value: (r) => INV_TYPE[r.inventory_type] || "" },
  source: { key: "source", label: "Source", cls: "src-col", cell: (r) => sourceTags(r.sources), value: (r) => r.sources || "" },
  dps: { key: "dps", label: "DPS", num: true, cell: (r) => (dpsVal(r) ? dpsVal(r).toFixed(1) : ""), value: (r) => dpsVal(r) },
  speed: { key: "speed", label: "Speed", num: true, cls: "muted", cell: (r) => (r.delay ? (r.delay / 1000).toFixed(2) : ""), value: (r) => r.delay / 1000 || 0 },
  armor: { key: "armor", label: "Armor", num: true, cls: "muted", cell: (r) => r.armor || "", value: (r) => r.armor || 0 },
  slots: { key: "slots", label: "Slots", num: true, cls: "muted", hideEmpty: true, cell: (r) => r.container_slots || "", value: (r) => r.container_slots || 0 },
  // ammo (class 6) flat damage add, shown wowhead-style as avg "damage per second"
  ammo: { key: "ammo", label: "Damage", num: true, cls: "muted", cell: (r) => { const a = ((r.dmg_min1 || 0) + (r.dmg_max1 || 0)) / 2; return a ? (a % 1 ? a.toFixed(1) : `${a}`) : ""; }, value: (r) => ((r.dmg_min1 || 0) + (r.dmg_max1 || 0)) / 2 },
};

// columns adapt to the class filter: weapons show DPS/Speed, armor shows Armor.
// the default set carries Slots (auto-hidden unless a row has container_slots --
// bags/quivers) and Slot (auto-hidden when every row is the same slot, e.g. a
// Bag-slot or container filter). when stat criteria are active, a sortable column
// per criterion stat is inserted (right after Name).
function buildItemCols(cls, statCols) {
  const base = cls === "2" ? [COL.name, COL.dps, COL.speed, COL.ilvl, COL.req, COL.source]
    : cls === "4" ? [COL.name, COL.armor, COL.ilvl, COL.req, COL.slot, COL.source]
      : cls === "6" ? [COL.name, COL.ammo, COL.ilvl, COL.req, COL.source]
        : [COL.name, COL.slots, COL.ilvl, COL.req, COL.slot, COL.source];
  return statCols.length ? [base[0], ...statCols, ...base.slice(1)] : base;
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
function multiField(name, label, entries, csv) {
  const sel = new Set((csv || "").split(",").filter(Boolean));
  const summary = sel.size ? `${sel.size} selected` : "Any";
  const boxes = entries.map(([v, l]) =>
    `<label class="multi-opt"><input type="checkbox" data-mv="${name}" value="${v}"${sel.has(String(v)) ? " checked" : ""}> ${esc(l)}</label>`).join("");
  return `<div class="fld multi" data-multi="${name}"><label>${esc(label)}</label>
    <button type="button" class="multi-btn">${esc(summary)} ▾</button>
    <div class="multi-panel">${boxes}</div></div>`;
}

// selection operations bar for the item browse: clipboard exports + open on
// Wowhead (classic). Reads the live selection from the table API on each click.
const WOWHEAD = "https://www.wowhead.com/classic/item=";
function wireSelbar(bar, api) {
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
  if (f.bind !== "") add("i.bonding = ?", +f.bind);
  // usable by class: unrestricted (-1) or the class bit is set in allowable_class.
  if (f.uclass !== "") { where.push("(i.allowable_class = -1 OR (i.allowable_class & ?) <> 0)"); binds.push(+f.uclass); }
  // faction: items restricted to one side's races only (allowable_race set, no cross-faction bit).
  const factionCond = "(i.allowable_race <> -1 AND (i.allowable_race & ?) <> 0 AND (i.allowable_race & ?) = 0)";
  if (f.faction === "a") { where.push(factionCond); binds.push(RACE_ALLIANCE, RACE_HORDE); }
  else if (f.faction === "h") { where.push(factionCond); binds.push(RACE_HORDE, RACE_ALLIANCE); }
  if (f.unique === "1") where.push("i.max_count = 1");
  if (f.prof !== "") add("i.required_skill = ?", +f.prof);
  // each criterion -> presence-aware match against item_stats (op is whitelisted).
  for (const c of criteria) add(`i.entry IN (SELECT item FROM item_stats WHERE stat='${c.key}' AND value ${c.op} ?)`, +c.val);

  // one LEFT JOIN per distinct criterion stat so its value can be shown + sorted.
  const critKeys = [...new Set(criteria.map((c) => c.key))];
  const joins = critKeys.map((key, n) => `LEFT JOIN item_stats s${n} ON s${n}.item=i.entry AND s${n}.stat='${key}'`).join(" ");
  const statSel2 = critKeys.map((key, n) => `, s${n}.value AS stat_${key}`).join("");
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await query(
    `SELECT i.entry, i.name, i.quality, i.inventory_type, i.item_level, i.required_level, i.display_id,
            i.dmg_min1, i.dmg_max1, i.delay, i.armor, i.container_slots, di.icon${statSel2},
            (SELECT GROUP_CONCAT(source,',') FROM item_sources s WHERE s.item = i.entry) AS sources
     FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id ${joins} ${whereSql}
     ORDER BY i.quality DESC, i.item_level DESC`, binds);

  // skip a criterion column when the class column already shows it (weapon DPS, armor Armor)
  const statCols = critKeys
    .filter((key) => !(key === "dps" && f.class === "2") && !(key === "armor" && f.class === "4"))
    .map((key) => ({
      key: `s_${key}`, label: statLabel(key), num: true,
      cell: (r) => { const v = r[`stat_${key}`]; return v == null ? "" : (key === "dps" ? Number(v).toFixed(1) : v); },
      value: (r) => r[`stat_${key}`] ?? 0,
    }));

  const subMap = f.class === "2" ? WEAPON_SUBCLASS : f.class === "4" ? ARMOR_SUBCLASS : null;
  const critRows = criteria.length ? criteria.map(critRow).join("") : critRow(null);
  const critBlock = `<div class="fld crit" data-criteria><label>Stats</label>
    <div class="crit-rows">${critRows}</div>
    <button type="button" class="crit-add" data-cadd>+ Add criterion</button>
  </div>`;
  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("class", "Class", options(Object.entries(ITEM_CLASS), f.class, "Any class"))}
    ${subMap ? multiField("subclass", "Subtype", Object.entries(subMap), f.subclass) : ""}
    ${multiField("quality", "Quality", QUALITY.map((q, i) => [i, q.name]), f.quality)}
    ${multiField("slot", "Slot", Object.entries(INV_TYPE), f.slot)}
    ${multiField("source", "Source", ITEM_SOURCE, f.source)}
    <div class="break"></div>
    ${numField("minrl", "Req lvl ≥", f.minrl)} ${numField("maxrl", "Req lvl ≤", f.maxrl)}
    ${numField("minil", "iLvl ≥", f.minil)} ${numField("maxil", "iLvl ≤", f.maxil)}
    <div class="break"></div>
    ${selectField("bind", "Bind", options(Object.entries(BONDING), f.bind, "Any"))}
    ${selectField("uclass", "Usable by", options(CLASS_MASK, f.uclass, "Any class"))}
    ${selectField("faction", "Faction", options([["a", "Alliance"], ["h", "Horde"]], f.faction, "Any"))}
    ${selectField("prof", "Profession", options(PROFESSION, f.prof, "Any"))}
    ${selectField("unique", "Unique", options([["1", "Unique only"]], f.unique, "Any"))}
    ${critBlock}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  return { rows, cols: buildItemCols(f.class, statCols), filters, noun: "items" };
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

async function browseCrafting(p) {
  const f = { q: p.get("q") || "", prof: p.get("prof") || "", obtainable: p.get("obtainable") !== "0" };
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
    class: p.get("class") || "", faction: p.get("faction") || "",
  };
  const where = ["q.title <> ''", "q.hidden = 0"], binds = [];
  const add = (cond, val) => { where.push(cond); binds.push(val); };
  if (f.q) add("q.title LIKE ?", `%${f.q}%`);
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
    `SELECT q.entry, q.title, q.level, q.zone, q.type, a.name AS zone_name, z.areaid AS zone_page
     FROM quests q LEFT JOIN areas a ON a.entry = q.zone
     LEFT JOIN zones z ON z.areaid = q.zone ${whereSql}
     ORDER BY q.level, q.title`, binds);

  // Zone dropdown: only zones/categories that actually carry quests, labeled.
  const zrows = await query(`SELECT DISTINCT q.zone, a.name AS zone_name FROM quests q LEFT JOIN areas a ON a.entry = q.zone WHERE q.title <> ''`);
  const zopts = zrows.map((z) => [String(z.zone), questZoneLabel(z.zone, z.zone_name)])
    .filter(([, l]) => l).sort((a, b) => a[1].localeCompare(b[1]));

  const cols = [
    { key: "name", label: "Title", cell: (r) => questLink(r.entry, r.title), value: (r) => r.title },
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

export async function showBrowse(kind, navigate) {
  const app = document.getElementById("app");
  const isNpc = kind === "npcs";
  const isItems = kind === "items";
  const isQuests = kind === "quests";
  const isFactions = kind === "factions";
  const isZones = kind === "zones";
  const isSpells = kind === "spells";
  const isItemsets = kind === "itemsets";
  const heading = isNpc ? "NPCs" : kind === "crafting" ? "Crafting" : isQuests ? "Quests" : isFactions ? "Factions" : isZones ? "Zones" : isSpells ? "Spells" : isItemsets ? "Item Sets" : "Items";
  document.title = `Browse ${heading} - Tortoise-WoW DB`;
  app.innerHTML = `<div class="loading">Loading…</div>`;
  const p = new URLSearchParams(location.search);
  let view;
  try { view = kind === "crafting" ? await browseCrafting(p) : isZones ? await browseZones(p) : isFactions ? await browseFactions(p) : isQuests ? await browseQuests(p) : isNpc ? await browseNpcs(p) : isSpells ? await browseSpells(p) : isItemsets ? await browseItemsets(p) : await browseItems(p); }
  catch (e) { app.innerHTML = `<div class="error">Failed: ${esc(e.message || e)}</div>`; return; }

  // items get row selection + clipboard/external operations on the selection.
  const selbar = !isItems ? "" : `<div class="selbar" data-selbar>
    <span class="selcount" data-selcount>0 selected</span>
    <button type="button" data-op="ids" disabled>Copy IDs</button>
    <span class="op-prefix"><input type="text" data-prefix value=".additem " aria-label="line prefix">
      <button type="button" data-op="prefix" disabled>Copy w/ prefix</button></span>
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
      group: p.get("groupby") ?? (kind === "crafting" ? "prof" : null),
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
  if (bar && tableApi) wireSelbar(bar, tableApi);

  const collect = () => {
    const np = new URLSearchParams();
    np.set("browse", kind);
    app.querySelectorAll("[data-f]").forEach((el) => {
      // default-on checkbox: omit when checked (the default), emit =0 when off
      if (el.type === "checkbox") { if (!el.checked) np.set(el.dataset.f, "0"); return; }
      if (el.value !== "") np.set(el.dataset.f, el.value);
    });
    const multi = {};
    app.querySelectorAll("[data-mv]:checked").forEach((cb) => { (multi[cb.dataset.mv] ??= []).push(cb.value); });
    for (const k in multi) np.set(k, multi[k].join(","));
    const crits = [];
    app.querySelectorAll("[data-crow]").forEach((row) => {
      const key = row.querySelector("[data-cstat]").value;
      const op = row.querySelector("[data-cop]").value;
      const val = row.querySelector("[data-cval]").value;
      if (key && op && val !== "") crits.push(`${key},${op},${val}`);
    });
    if (crits.length) np.set("stats", crits.join("|"));
    // preserve active sort/group across filter changes, but drop a sort that
    // points at a criterion column (s_*) which no longer exists.
    const cur = new URLSearchParams(location.search);
    const liveStatCols = new Set(crits.map((c) => "s_" + c.split(",")[0]));
    const sort = cur.get("sort");
    if (sort && (!sort.startsWith("s_") || liveStatCols.has(sort))) {
      np.set("sort", sort);
      const dir = cur.get("dir"); if (dir) np.set("dir", dir);
    }
    const groupby = cur.get("groupby"); if (groupby) np.set("groupby", groupby);
    return np;
  };
  app.querySelectorAll("[data-f]").forEach((el) =>
    el.addEventListener("change", () => {
      const np = collect();
      if (el.dataset.f === "class") np.delete("subclass");
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
  const reset = app.querySelector("[data-reset]");
  if (reset) reset.addEventListener("click", () => navigate(`?browse=${kind}`));
}
