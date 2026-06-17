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

const ITEM_COLS = [
  { label: "Name", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
  { label: "iLvl", num: true, cls: "muted", cell: (r) => r.item_level || "", value: (r) => r.item_level || 0 },
  { label: "Req", num: true, cls: "muted", cell: (r) => r.required_level || "", value: (r) => r.required_level || 0 },
  { label: "Slot", cls: "muted", cell: (r) => INV_TYPE[r.inventory_type] || "", value: (r) => INV_TYPE[r.inventory_type] || "" },
  { label: "ID", num: true, cls: "muted", cell: (r) => r.entry, value: (r) => r.entry },
];
const NPC_COLS = [
  { label: "Name", cell: (r) => npcLink(r.entry, r.name) + (r.subname ? ` <span class="muted">&lt;${esc(r.subname)}&gt;</span>` : ""), value: (r) => r.name },
  { label: "Level", num: true, cls: "muted", cell: (r) => lvlRange(r), value: (r) => r.level_max || r.level_min || 0 },
  { label: "Rank", num: true, cls: "muted", cell: (r) => CREATURE_RANK[r.rank] || "Normal", value: (r) => r.rank || 0 },
  { label: "Type", cls: "muted", cell: (r) => CREATURE_TYPE[r.type] || "", value: (r) => CREATURE_TYPE[r.type] || "" },
  { label: "ID", num: true, cls: "muted", cell: (r) => r.entry, value: (r) => r.entry },
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
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await query(
    `SELECT i.entry, i.name, i.quality, i.inventory_type, i.item_level, i.required_level, di.icon
     FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id ${whereSql}
     ORDER BY i.quality DESC, i.item_level DESC`, binds);

  const subMap = f.class === "2" ? WEAPON_SUBCLASS : f.class === "4" ? ARMOR_SUBCLASS : null;
  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("class", "Class", options(Object.entries(ITEM_CLASS), f.class, "Any class"))}
    ${subMap ? selectField("subclass", "Subtype", options(Object.entries(subMap), f.subclass, "Any")) : ""}
    ${selectField("quality", "Quality", options(QUALITY.map((q, i) => [i, q.name]), f.quality, "Any quality"))}
    ${selectField("slot", "Slot", options(Object.entries(INV_TYPE), f.slot, "Any slot"))}
    ${numField("minrl", "Req lvl ≥", f.minrl)} ${numField("maxrl", "Req lvl ≤", f.maxrl)}
    ${numField("minil", "iLvl ≥", f.minil)} ${numField("maxil", "iLvl ≤", f.maxil)}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;
  return { rows, cols: ITEM_COLS, filters, noun: "items" };
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
  if (view.rows.length) createTable(tableEl, { columns: view.cols, rows: view.rows, pageSize: PAGE });
  else tableEl.innerHTML = `<p class="muted">No matches.</p>`;

  const collect = () => {
    const np = new URLSearchParams();
    np.set("browse", kind);
    app.querySelectorAll("[data-f]").forEach((el) => { if (el.value !== "") np.set(el.dataset.f, el.value); });
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
