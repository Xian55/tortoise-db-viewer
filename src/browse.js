// Browse / finder views with filters (wowhead-style). Filtering runs as SQL
// against the in-memory DB; sorting + pagination are handled client-side by the
// shared sortable table (src/table.js), the same one used everywhere else.
import { query } from "./db.js";
import { itemLink, npcLink, esc } from "./render.js";
import { createTable } from "./table.js";
import {
  ITEM_CLASS, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE, QUALITY,
  CREATURE_TYPE, CREATURE_RANK,
} from "./constants.js";

const PAGE = 100;
const lvlRange = (r) => (r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : (r.level_min || ""));

const dpsVal = (r) => (r.delay > 0 && (r.dmg_min1 || r.dmg_max1) ? ((r.dmg_min1 + r.dmg_max1) / 2) / (r.delay / 1000) : 0);

const COL = {
  name: { key: "name", label: "Name", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
  ilvl: { key: "ilvl", label: "iLvl", num: true, cls: "muted", cell: (r) => r.item_level || "", value: (r) => r.item_level || 0 },
  req: { key: "req", label: "Req", num: true, cls: "muted", cell: (r) => r.required_level || "", value: (r) => r.required_level || 0 },
  slot: { key: "slot", label: "Slot", cls: "muted", cell: (r) => INV_TYPE[r.inventory_type] || "", value: (r) => INV_TYPE[r.inventory_type] || "" },
  id: { key: "id", label: "ID", num: true, cls: "muted", cell: (r) => r.entry, value: (r) => r.entry },
  dps: { key: "dps", label: "DPS", num: true, cell: (r) => (dpsVal(r) ? dpsVal(r).toFixed(1) : ""), value: (r) => dpsVal(r) },
  speed: { key: "speed", label: "Speed", num: true, cls: "muted", cell: (r) => (r.delay ? (r.delay / 1000).toFixed(2) : ""), value: (r) => r.delay / 1000 || 0 },
  armor: { key: "armor", label: "Armor", num: true, cls: "muted", cell: (r) => r.armor || "", value: (r) => r.armor || 0 },
};

// columns adapt to the class filter: weapons show DPS/Speed, armor shows Armor.
// when a stat filter is active, its column is inserted (right after Name) so it
// can be sorted by value.
function buildItemCols(cls, statCol) {
  const base = cls === "2" ? [COL.name, COL.dps, COL.speed, COL.ilvl, COL.req, COL.id]
    : cls === "4" ? [COL.name, COL.armor, COL.ilvl, COL.req, COL.slot, COL.id]
      : [COL.name, COL.ilvl, COL.req, COL.slot, COL.id];
  return statCol ? [base[0], statCol, ...base.slice(1)] : base;
}

// stat filter (wowhead-style "additional filters"): pick stat + minimum value.
const STAT_TYPES = [["agi", "Agility", 3], ["str", "Strength", 4], ["sta", "Stamina", 7], ["int", "Intellect", 5], ["spi", "Spirit", 6]];
const RES_COLS = [["holyres", "Holy Res", "holy_res"], ["fireres", "Fire Res", "fire_res"], ["natureres", "Nature Res", "nature_res"], ["frostres", "Frost Res", "frost_res"], ["shadowres", "Shadow Res", "shadow_res"], ["arcaneres", "Arcane Res", "arcane_res"]];

function statFilter(key, v) {
  const s = STAT_TYPES.find((x) => x[0] === key);
  if (s) {
    const parts = [], binds = [];
    for (let i = 1; i <= 10; i++) { parts.push(`(i.stat_type${i}=${s[2]} AND i.stat_value${i} >= ?)`); binds.push(v); }
    return { sql: "(" + parts.join(" OR ") + ")", binds };
  }
  if (key === "armor") return { sql: "i.armor >= ?", binds: [v] };
  if (key === "dps") return { sql: "(i.delay > 0 AND ((i.dmg_min1+i.dmg_max1)/2.0)/(i.delay/1000.0) >= ?)", binds: [v] };
  const r = RES_COLS.find((x) => x[0] === key);
  if (r) return { sql: `i.${r[2]} >= ?`, binds: [v] };
  return null;
}

// SQL expression yielding the stat's value (aliased AS statval for the column).
function statExpr(key) {
  const s = STAT_TYPES.find((x) => x[0] === key);
  if (s) {
    let e = "0";
    for (let i = 10; i >= 1; i--) e = `CASE WHEN i.stat_type${i}=${s[2]} THEN i.stat_value${i} ELSE ${e} END`;
    return `(${e})`;
  }
  if (key === "armor") return "i.armor";
  if (key === "dps") return "(CASE WHEN i.delay>0 THEN ((i.dmg_min1+i.dmg_max1)/2.0)/(i.delay/1000.0) ELSE 0 END)";
  const r = RES_COLS.find((x) => x[0] === key);
  if (r) return `i.${r[2]}`;
  return null;
}
function statLabel(key) {
  const s = STAT_TYPES.find((x) => x[0] === key);
  if (s) return s[1];
  if (key === "armor") return "Armor";
  if (key === "dps") return "DPS";
  const r = RES_COLS.find((x) => x[0] === key);
  return r ? r[1] : "Stat";
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

async function browseItems(p) {
  const f = {
    q: p.get("q") || "", class: p.get("class") || "", subclass: p.get("subclass") || "",
    quality: p.get("quality") || "", slot: p.get("slot") || "",
    minrl: p.get("minrl") || "", maxrl: p.get("maxrl") || "",
    minil: p.get("minil") || "", maxil: p.get("maxil") || "",
    stat: p.get("stat") || "", statmin: p.get("statmin") || "",
  };
  const where = [], binds = [];
  const add = (cond, val) => { where.push(cond); binds.push(val); };
  if (f.q) add("i.name LIKE ?", `%${f.q}%`);
  if (f.class !== "") add("i.class = ?", +f.class);
  if (f.subclass !== "") add("i.subclass = ?", +f.subclass);
  if (f.quality !== "") add("i.quality = ?", +f.quality);
  if (f.slot !== "") add("i.inventory_type = ?", +f.slot);
  if (f.minrl !== "") add("i.required_level >= ?", +f.minrl);
  if (f.maxrl !== "") add("i.required_level <= ?", +f.maxrl);
  if (f.minil !== "") add("i.item_level >= ?", +f.minil);
  if (f.maxil !== "") add("i.item_level <= ?", +f.maxil);
  if (f.stat && f.statmin !== "") {
    const sf = statFilter(f.stat, +f.statmin);
    if (sf) { where.push(sf.sql); binds.push(...sf.binds); }
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const statSel2 = f.stat ? `, ${statExpr(f.stat)} AS statval` : "";
  const rows = await query(
    `SELECT i.entry, i.name, i.quality, i.inventory_type, i.item_level, i.required_level, i.display_id,
            i.dmg_min1, i.dmg_max1, i.delay, i.armor, di.icon${statSel2}
     FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id ${whereSql}
     ORDER BY i.quality DESC, i.item_level DESC`, binds);

  // skip the stat column when the class already shows it (weapon DPS, armor Armor)
  const dupCol = (f.class === "2" && f.stat === "dps") || (f.class === "4" && f.stat === "armor");
  const statCol = (f.stat && !dupCol) ? {
    key: f.stat, label: statLabel(f.stat), num: true,
    cell: (r) => (r.statval ? (f.stat === "dps" ? Number(r.statval).toFixed(1) : r.statval) : ""),
    value: (r) => r.statval || 0,
  } : null;

  const subMap = f.class === "2" ? WEAPON_SUBCLASS : f.class === "4" ? ARMOR_SUBCLASS : null;
  const statSel = `<div class="fld"><label>Stat</label><select data-f="stat">
    ${opt("", "Any stat", f.stat)}
    <optgroup label="Base stats">${STAT_TYPES.map((s) => opt(s[0], s[1], f.stat)).join("")}</optgroup>
    <optgroup label="Defense">${opt("armor", "Armor", f.stat)}</optgroup>
    <optgroup label="Weapon">${opt("dps", "DPS", f.stat)}</optgroup>
    <optgroup label="Resistances">${RES_COLS.map((r) => opt(r[0], r[1], f.stat)).join("")}</optgroup>
  </select></div>`;
  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("class", "Class", options(Object.entries(ITEM_CLASS), f.class, "Any class"))}
    ${subMap ? selectField("subclass", "Subtype", options(Object.entries(subMap), f.subclass, "Any")) : ""}
    ${selectField("quality", "Quality", options(QUALITY.map((q, i) => [i, q.name]), f.quality, "Any quality"))}
    ${selectField("slot", "Slot", options(Object.entries(INV_TYPE), f.slot, "Any slot"))}
    <div class="break"></div>
    ${numField("minrl", "Req lvl ≥", f.minrl)} ${numField("maxrl", "Req lvl ≤", f.maxrl)}
    ${numField("minil", "iLvl ≥", f.minil)} ${numField("maxil", "iLvl ≤", f.maxil)}
    ${statSel} ${numField("statmin", "Stat ≥", f.statmin)}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  return { rows, cols: buildItemCols(f.class, statCol), filters, noun: "items" };
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

export async function showBrowse(kind, navigate) {
  const app = document.getElementById("app");
  const isNpc = kind === "npcs";
  document.title = `Browse ${isNpc ? "NPCs" : "Items"} - Tortoise-WoW DB`;
  app.innerHTML = `<div class="loading">Loading…</div>`;
  const p = new URLSearchParams(location.search);
  let view;
  try { view = isNpc ? await browseNpcs(p) : await browseItems(p); }
  catch (e) { app.innerHTML = `<div class="error">Failed: ${esc(e.message || e)}</div>`; return; }

  app.innerHTML = `<div class="browse"><h1>Browse ${isNpc ? "NPCs" : "Items"}</h1>${view.filters}
    <p class="browse-count">${view.rows.length.toLocaleString()} ${view.noun}</p>
    <div data-browse></div></div>`;
  const tableEl = app.querySelector("[data-browse]");
  if (view.rows.length) {
    createTable(tableEl, {
      columns: view.cols, rows: view.rows, pageSize: PAGE, groupable: true,
      sort: p.get("sort"), dir: p.get("dir"), group: p.get("groupby"),
      // mirror sort/group into the URL (no re-render) so the view is shareable
      onState: (s) => {
        const np = new URLSearchParams(location.search);
        if (s.sort) { np.set("sort", s.sort); np.set("dir", s.dir); } else { np.delete("sort"); np.delete("dir"); }
        if (s.group) np.set("groupby", s.group); else np.delete("groupby");
        history.replaceState({}, "", "?" + np.toString());
      },
    });
  } else tableEl.innerHTML = `<p class="muted">No matches.</p>`;

  const collect = () => {
    const np = new URLSearchParams();
    np.set("browse", kind);
    app.querySelectorAll("[data-f]").forEach((el) => { if (el.value !== "") np.set(el.dataset.f, el.value); });
    const cur = new URLSearchParams(location.search); // preserve active sort/group across filter changes
    for (const k of ["sort", "dir", "groupby"]) { const v = cur.get(k); if (v) np.set(k, v); }
    return np;
  };
  app.querySelectorAll("[data-f]").forEach((el) =>
    el.addEventListener("change", () => {
      const np = collect();
      if (el.dataset.f === "class") np.delete("subclass");
      navigate(`?${np.toString()}`);
    }));
  const reset = app.querySelector("[data-reset]");
  if (reset) reset.addEventListener("click", () => navigate(`?browse=${kind}`));
}
