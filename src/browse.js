// Browse / finder views with filters (wowhead-style), paginated.
// All filtering runs as SQL against the in-memory DB, so it's instant.
import { query } from "./db.js";
import { itemLink, npcLink, esc } from "./render.js";
import {
  ITEM_CLASS, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE, QUALITY,
  CREATURE_TYPE, CREATURE_RANK,
} from "./constants.js";

const PAGE = 100;

// sortable column defs: { key (url + sql sort id), label, sql (order expr) }
const ITEM_COLS = [
  { key: "name", label: "Name", sql: "i.name" },
  { key: "ilvl", label: "iLvl", sql: "i.item_level" },
  { key: "req", label: "Req", sql: "i.required_level" },
  { key: "slot", label: "Slot", sql: "i.inventory_type" },
  { key: "id", label: "ID", sql: "i.entry" },
];
const NPC_COLS = [
  { key: "name", label: "Name", sql: "c.name" },
  { key: "level", label: "Level", sql: "c.level_max" },
  { key: "rank", label: "Rank", sql: "c.rank" },
  { key: "type", label: "Type", sql: "c.type" },
  { key: "id", label: "ID", sql: "c.entry" },
];

// default sort direction for a column when first clicked ("a" name, "d" others)
const defaultDir = (key) => (key === "name" ? "a" : "d");

function orderBy(cols, sortKey, dir, fallback) {
  const col = cols.find((c) => c.key === sortKey);
  if (!col) return fallback;
  return `${col.sql} ${dir === "a" ? "ASC" : "DESC"}, ${cols[0].sql} ASC`;
}

function sortableTable(cols, sortKey, dir, bodyRows) {
  if (!bodyRows) return "";
  const head = cols.map((c) => {
    const active = c.key === sortKey;
    const arrow = active ? (dir === "a" ? " ▲" : " ▼") : "";
    return `<th class="sortable${active ? " active" : ""}" data-sort="${c.key}">${esc(c.label)}${arrow}</th>`;
  }).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

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
function pager(page, total) {
  const pages = Math.ceil(total / PAGE);
  if (pages <= 1) return "";
  return `<div class="pager">
    <button data-page="${page - 1}"${page <= 0 ? " disabled" : ""}>← Prev</button>
    <span class="muted">Page ${page + 1} / ${pages}</span>
    <button data-page="${page + 1}"${page >= pages - 1 ? " disabled" : ""}>Next →</button></div>`;
}

async function browseItems(p) {
  const f = {
    q: p.get("q") || "", class: p.get("class") || "", subclass: p.get("subclass") || "",
    quality: p.get("quality") || "", slot: p.get("slot") || "",
    minrl: p.get("minrl") || "", maxrl: p.get("maxrl") || "",
    minil: p.get("minil") || "", maxil: p.get("maxil") || "",
    sort: p.get("sort") || "", dir: p.get("dir") || defaultDir(p.get("sort")),
    page: Math.max(0, parseInt(p.get("page") || "0", 10) || 0),
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
  const order = orderBy(ITEM_COLS, f.sort, f.dir, "i.quality DESC, i.item_level DESC");

  const total = (await query(`SELECT COUNT(*) AS n FROM items i ${whereSql}`, binds))[0]?.n || 0;
  const rows = await query(
    `SELECT i.entry, i.name, i.quality, i.inventory_type, i.item_level, i.required_level, di.icon
     FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id ${whereSql}
     ORDER BY ${order} LIMIT ? OFFSET ?`, [...binds, PAGE, f.page * PAGE]);

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

  const body = rows.map((r) => `<tr>
    <td>${itemLink(r.entry, r.name, r.quality, r.icon)}</td>
    <td class="muted">${r.item_level || ""}</td>
    <td class="muted">${r.required_level || ""}</td>
    <td class="muted">${INV_TYPE[r.inventory_type] || ""}</td>
    <td class="muted">${r.entry}</td></tr>`).join("");

  return { page: f.page, total,
    html: filters + `<p class="browse-count">${total.toLocaleString()} items</p>` +
      sortableTable(ITEM_COLS, f.sort, f.dir, body) + pager(f.page, total) };
}

async function browseNpcs(p) {
  const f = {
    q: p.get("q") || "", type: p.get("type") || "", rank: p.get("rank") || "",
    minlvl: p.get("minlvl") || "", maxlvl: p.get("maxlvl") || "",
    sort: p.get("sort") || "", dir: p.get("dir") || defaultDir(p.get("sort")),
    page: Math.max(0, parseInt(p.get("page") || "0", 10) || 0),
  };
  const where = ["c.name <> ''"], binds = [];
  const add = (cond, val) => { where.push(cond); binds.push(val); };
  if (f.q) add("c.name LIKE ?", `%${f.q}%`);
  if (f.type !== "") add("c.type = ?", +f.type);
  if (f.rank !== "") add("c.rank = ?", +f.rank);
  if (f.minlvl !== "") add("c.level_min >= ?", +f.minlvl);
  if (f.maxlvl !== "") add("c.level_max <= ?", +f.maxlvl);
  const whereSql = "WHERE " + where.join(" AND ");
  const order = orderBy(NPC_COLS, f.sort, f.dir, "c.level_max DESC, c.name");

  const total = (await query(`SELECT COUNT(*) AS n FROM creatures c ${whereSql}`, binds))[0]?.n || 0;
  const rows = await query(
    `SELECT c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank, c.type
     FROM creatures c ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...binds, PAGE, f.page * PAGE]);

  const filters = `<div class="filters">
    ${textField("q", "Name", f.q)}
    ${selectField("type", "Type", options(Object.entries(CREATURE_TYPE), f.type, "Any type"))}
    ${selectField("rank", "Rank", options([[0, "Normal"], ...Object.entries(CREATURE_RANK)], f.rank, "Any rank"))}
    ${numField("minlvl", "Level ≥", f.minlvl)} ${numField("maxlvl", "Level ≤", f.maxlvl)}
    <button class="reset" data-reset="1">Reset</button>
  </div>`;

  const body = rows.map((r) => {
    const lvl = r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : (r.level_min || "");
    return `<tr>
      <td>${npcLink(r.entry, r.name)}${r.subname ? ` <span class="muted">&lt;${esc(r.subname)}&gt;</span>` : ""}</td>
      <td class="muted">${lvl}</td>
      <td class="muted">${CREATURE_RANK[r.rank] || "Normal"}</td>
      <td class="muted">${CREATURE_TYPE[r.type] || ""}</td>
      <td class="muted">${r.entry}</td></tr>`;
  }).join("");

  return { page: f.page, total,
    html: filters + `<p class="browse-count">${total.toLocaleString()} NPCs</p>` +
      sortableTable(NPC_COLS, f.sort, f.dir, body) + pager(f.page, total) };
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
  app.innerHTML = `<div class="browse"><h1>Browse ${isNpc ? "NPCs" : "Items"}</h1>${view.html}</div>`;

  // build params from the current control values, preserving the active sort
  const collect = () => {
    const np = new URLSearchParams();
    np.set("browse", kind);
    app.querySelectorAll("[data-f]").forEach((el) => { if (el.value !== "") np.set(el.dataset.f, el.value); });
    const s = p.get("sort");
    if (s) { np.set("sort", s); np.set("dir", p.get("dir") || defaultDir(s)); }
    return np;
  };
  app.querySelectorAll("[data-f]").forEach((el) =>
    el.addEventListener("change", () => {
      const np = collect();            // changing a filter resets to page 0
      if (el.dataset.f === "class") np.delete("subclass"); // subtype list depends on class
      navigate(`?${np.toString()}`);
    }));
  // clickable column headers: set/toggle sort, page resets
  app.querySelectorAll("th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      const cur = p.get("sort"), curDir = p.get("dir") || defaultDir(cur);
      const dir = key === cur ? (curDir === "a" ? "d" : "a") : defaultDir(key);
      const np = collect();
      np.set("sort", key); np.set("dir", dir);
      navigate(`?${np.toString()}`);
    }));
  app.querySelectorAll("[data-page]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const np = collect(); np.set("page", btn.dataset.page);
      navigate(`?${np.toString()}`);
    }));
  const reset = app.querySelector("[data-reset]");
  if (reset) reset.addEventListener("click", () => navigate(`?browse=${kind}`));
}
