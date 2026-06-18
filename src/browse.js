// Browse / finder views with filters (wowhead-style). Filtering runs as SQL
// against the in-memory DB; sorting + pagination are handled client-side by the
// shared sortable table (src/table.js), the same one used everywhere else.
import { query } from "./db.js";
import { Q_CRAFTING } from "./queries.js";
import { itemLink, npcLink, sourceTags, esc } from "./render.js";
import { createTable } from "./table.js";
import {
  ITEM_CLASS, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE, QUALITY,
  CREATURE_TYPE, CREATURE_RANK, GEAR_CRITERIA, GEAR_STAT_LABEL, ITEM_SOURCE,
  BONDING, CLASS_MASK, PROFESSION, PROFESSION_LABEL, RACE_ALLIANCE, RACE_HORDE,
} from "./constants.js";

const PAGE = 100;
const lvlRange = (r) => (r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : (r.level_min || ""));

const dpsVal = (r) => (r.delay > 0 && (r.dmg_min1 || r.dmg_max1) ? ((r.dmg_min1 + r.dmg_max1) / 2) / (r.delay / 1000) : 0);

const COL = {
  name: { key: "name", label: "Name", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
  ilvl: { key: "ilvl", label: "iLvl", num: true, cls: "muted", cell: (r) => r.item_level || "", value: (r) => r.item_level || 0 },
  req: { key: "req", label: "Req", num: true, cls: "muted", cell: (r) => r.required_level || "", value: (r) => r.required_level || 0 },
  slot: { key: "slot", label: "Slot", cls: "muted", cell: (r) => INV_TYPE[r.inventory_type] || "", value: (r) => INV_TYPE[r.inventory_type] || "" },
  source: { key: "source", label: "Source", cls: "src-col", cell: (r) => sourceTags(r.sources), value: (r) => r.sources || "" },
  dps: { key: "dps", label: "DPS", num: true, cell: (r) => (dpsVal(r) ? dpsVal(r).toFixed(1) : ""), value: (r) => dpsVal(r) },
  speed: { key: "speed", label: "Speed", num: true, cls: "muted", cell: (r) => (r.delay ? (r.delay / 1000).toFixed(2) : ""), value: (r) => r.delay / 1000 || 0 },
  armor: { key: "armor", label: "Armor", num: true, cls: "muted", cell: (r) => r.armor || "", value: (r) => r.armor || 0 },
};

// columns adapt to the class filter: weapons show DPS/Speed, armor shows Armor.
// when stat criteria are active, a sortable column per criterion stat is inserted
// (right after Name).
function buildItemCols(cls, statCols) {
  const base = cls === "2" ? [COL.name, COL.dps, COL.speed, COL.ilvl, COL.req, COL.source]
    : cls === "4" ? [COL.name, COL.armor, COL.ilvl, COL.req, COL.slot, COL.source]
      : [COL.name, COL.ilvl, COL.req, COL.slot, COL.source];
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
  { key: "id", label: "ID", num: true, cls: "muted", cell: (r) => r.entry, value: (r) => r.entry },
];

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
  const where = [], binds = [];
  const add = (cond, val) => { where.push(cond); binds.push(val); };
  const addIn = (col, csv) => {
    const vals = (csv || "").split(",").filter(Boolean);
    if (vals.length) { where.push(`${col} IN (${vals.map(() => "?").join(",")})`); for (const v of vals) binds.push(+v); }
  };
  if (f.q) add("i.name LIKE ?", `%${f.q}%`);
  if (f.class !== "") add("i.class = ?", +f.class);
  if (f.subclass !== "") add("i.subclass = ?", +f.subclass);
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
            i.dmg_min1, i.dmg_max1, i.delay, i.armor, di.icon${statSel2},
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
    ${subMap ? selectField("subclass", "Subtype", options(Object.entries(subMap), f.subclass, "Any")) : ""}
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
    minlvl: p.get("minlvl") || "", maxlvl: p.get("maxlvl") || "",
  };
  const where = ["c.name <> ''"], binds = [];
  const add = (cond, val) => { where.push(cond); binds.push(val); };
  if (f.q) add("c.name LIKE ?", `%${f.q}%`);
  if (f.type !== "") add("c.type = ?", +f.type);
  if (f.rank !== "") add("c.rank = ?", +f.rank);
  if (f.minlvl !== "") add("c.level_min >= ?", +f.minlvl);
  if (f.maxlvl !== "") add("c.level_max <= ?", +f.maxlvl);
  const whereSql = "WHERE " + where.join(" AND ");
  const rows = await query(
    `SELECT c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank, c.type
     FROM creatures c ${whereSql} ORDER BY c.level_max DESC, c.name`, binds);

  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("type", "Type", options(Object.entries(CREATURE_TYPE), f.type, "Any type"))}
    ${selectField("rank", "Rank", options([[0, "Normal"], ...Object.entries(CREATURE_RANK)], f.rank, "Any rank"))}
    ${numField("minlvl", "Level ≥", f.minlvl)} ${numField("maxlvl", "Level ≤", f.maxlvl)}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  return { rows, cols: NPC_COLS, filters, noun: "NPCs" };
}

// Skill-up difficulty colors (recipe orange→yellow→green→grey). green is the
// midpoint of the yellow (min_value) and grey (max_value) thresholds; some recipes
// never go grey (min=max=0) and just show the orange requirement.
function craftSkillCell(c) {
  const span = (v, col) => `<span style="color:${col}">${v}</span>`;
  const o = span(c.req || 0, "#ff8040");
  if (!c.min && !c.max) return o;
  const green = Math.round((c.min + c.max) / 2);
  return `<span style="white-space:nowrap">${o} ${span(c.min, "#ffd100")} ${span(green, "#40c040")} ${span(c.max, "#808080")}</span>`;
}

async function browseCrafting(p) {
  const f = { q: p.get("q") || "", prof: p.get("prof") || "" };
  const rows = await query(Q_CRAFTING, []);
  // one query row per (craft spell, reagent); fold reagents into one craft per spell.
  const bySpell = new Map();
  for (const r of rows) {
    let g = bySpell.get(r.spell);
    if (!g) {
      g = {
        spell: r.spell, item: r.item, item_name: r.item_name, quality: r.quality, item_icon: r.item_icon,
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
  if (f.q) { const ql = f.q.toLowerCase(); crafts = crafts.filter((c) => (c.item_name || "").toLowerCase().includes(ql)); }

  const cols = [
    { key: "name", label: "Name", cell: (c) => itemLink(c.item, c.item_name, c.quality, c.item_icon), value: (c) => c.item_name },
    { key: "prof", label: "Profession", cls: "muted", cell: (c) => esc(PROFESSION_LABEL[c.skill] || ""), value: (c) => PROFESSION_LABEL[c.skill] || "" },
    { key: "skill", label: "Skill", num: true, cell: (c) => craftSkillCell(c), value: (c) => c.req || 0 },
    { key: "reagents", label: "Reagents", cls: "muted", cell: (c) => c.reagents.map((r) => `${itemLink(r.item, r.name, r.quality, r.icon)}${r.count > 1 ? ` ×${r.count}` : ""}`).join(", "), value: (c) => c.reagents.length },
    { key: "source", label: "Source",
      cell: (c) => (c.recipe_item ? itemLink(c.recipe_item, c.recipe_name, c.recipe_quality, c.recipe_icon)
        : c.trainer ? `<span class="tagx src-crafted">Trainer</span>`
          : c.auto ? `<span class="tagx" title="Learned automatically with the profession">Auto</span>` : "—"),
      value: (c) => (c.recipe_item ? "Recipe" : c.trainer ? "Trainer" : c.auto ? "Auto" : "") },
  ];
  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("prof", "Profession", options(PROFESSION, f.prof, "Any"))}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  return { rows: crafts, cols, filters, noun: "crafts" };
}

export async function showBrowse(kind, navigate) {
  const app = document.getElementById("app");
  const isNpc = kind === "npcs";
  const isItems = kind === "items";
  const heading = isNpc ? "NPCs" : kind === "crafting" ? "Crafting" : "Items";
  document.title = `Browse ${heading} - Tortoise-WoW DB`;
  app.innerHTML = `<div class="loading">Loading…</div>`;
  const p = new URLSearchParams(location.search);
  let view;
  try { view = kind === "crafting" ? await browseCrafting(p) : isNpc ? await browseNpcs(p) : await browseItems(p); }
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
    app.querySelectorAll("[data-f]").forEach((el) => { if (el.value !== "") np.set(el.dataset.f, el.value); });
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
