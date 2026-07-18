// One reusable, client-side sortable + paginated table, used everywhere.
// Sorting happens in JS over the already-loaded rows (no re-query). Each table
// owns its container and re-renders on header click / pager click / group change.
//
// columns: [{ label, cell:(row)=>html, value?:(row)=>primitive, num?:bool, cls?:string, group?:(row)=>html }]
//   value() supplies the sort/group key; defaults to the cell's text. num => numeric.
//   group() renders the group-header label when grouped by this column (defaults to
//   the cell) -- use it when the cell shows a member (e.g. a recipe link) but the
//   group key is a category (e.g. "Recipe").
// opts: { pageSize, groupable, group } — groupable shows a "Group by" selector;
//   group is the default column index to group by (null = none).
// Selection (opt-in): pass selectable:true + rowKey:(row)=>id to add a checkbox
//   column with per-row, per-group, and select-all checkboxes. Selection is a Set
//   of row keys that survives sort/paging/grouping. onSelectionChange(count, rows)
//   fires on every change; createTable returns { getSelected, clearSelection }.
import { esc } from "./render.js";

const stripTags = (h) => String(h).replace(/<[^>]*>/g, "").trim();

// Rows-per-page: the dropdown options + a persisted global preference so the choice
// survives a table's re-render (browse rebuilds its table on every filter change).
const PS_OPTIONS = [25, 50, 100, 200, 1000, 5000];
const PS_MIN = PS_OPTIONS[0]; // fewer rows than this => nothing to paginate, hide the tools
const PS_STORE = "tw.tablePageSize";
function psRead() {
  try { const v = localStorage.getItem(PS_STORE); if (v === "all") return Infinity; const n = +v; return n > 0 ? n : null; }
  catch { return null; }
}
function psWrite(v) { try { localStorage.setItem(PS_STORE, isFinite(v) ? String(v) : "all"); } catch { /* ignore */ } }

// Drop columns flagged hideEmpty (no row renders a value) or hideUniform (every
// row renders the same single value) -- e.g. a profession trainer's Profession
// column (all rows the same), or a Level column that's empty for every row.
// Detection uses the rendered cell text so "0"/"" both read as empty.
function hideCols(columns, rows) {
  if (!rows.length) return columns;
  return columns.filter((c) => {
    if (!c.hideEmpty && !c.hideUniform) return true;
    const vals = rows.map((r) => stripTags(c.cell(r))).filter((v) => v !== "");
    if (c.hideUniform) return new Set(vals).size > 1;
    return vals.length > 0;
  });
}

export function createTable(container, { columns, rows, pageSize = Infinity, groupable = false, group = null, startCollapsed = false, sort = null, dir = "a", onState, selectable = false, rowKey = null, onSelectionChange }) {
  columns = hideCols(columns, rows);
  const colKey = (i) => (i == null ? "" : (columns[i].key || columns[i].label));
  const findCol = (key) => {
    if (key == null || key === "") return null;
    const i = columns.findIndex((c) => (c.key || c.label) === key);
    return i < 0 ? null : i;
  };
  const state = {
    rows: rows.slice(), page: 0,
    sort: findCol(sort), dir: dir === "d" ? "d" : "a",
    group: typeof group === "number" ? group : findCol(group),
    collapsed: new Set(),
    selected: new Set(),
  };
  // Finite-default tables (browse, tabbed lists) honour the persisted global rows-per-page;
  // show-all tables (pageSize omitted => Infinity) stay show-all but still get the dropdown.
  state.pageSize = isFinite(pageSize) ? (psRead() ?? pageSize) : pageSize;
  const emit = () => onState && onState({ sort: colKey(state.sort), dir: state.dir, group: colKey(state.group) });

  const keyOf = (col, row) => (col.value ? col.value(row) : stripTags(col.cell(row)));
  const rkey = (row) => String(rowKey ? rowKey(row) : keyOf(columns[0], row));
  const selectedRows = () => state.rows.filter((r) => state.selected.has(rkey(r)));
  const emitSel = () => onSelectionChange && onSelectionChange(state.selected.size, selectedRows());
  function cmp(col, dir) {
    const mul = dir === "a" ? 1 : -1;
    return (a, b) => {
      let va = keyOf(col, a), vb = keyOf(col, b);
      const ea = va == null || va === "", eb = vb == null || vb === "";
      if (ea && eb) return 0;
      if (ea) return 1;
      if (eb) return -1;
      if (col.num) return (Number(va) - Number(vb)) * mul;
      return String(va).localeCompare(String(vb)) * mul;
    };
  }
  function applyOrder() {
    const comps = [];
    if (state.group != null) comps.push(cmp(columns[state.group], "a"));
    if (state.sort != null) comps.push(cmp(columns[state.sort], state.dir));
    if (!comps.length) return;
    state.rows.sort((a, b) => { for (const c of comps) { const r = c(a, b); if (r) return r; } return 0; });
  }

  function render() {
    applyOrder();
    const grouped = state.group != null;
    const dcols = grouped ? columns.filter((_, i) => i !== state.group) : columns;
    const gcol = grouped ? columns[state.group] : null;
    const selTh = selectable ? `<th class="selcol"><input type="checkbox" data-selall title="Select all"></th>` : "";
    const selTd = (r) => (selectable ? `<td class="selcol"><input type="checkbox" aria-label="Select row" data-selrow="${esc(rkey(r))}"${state.selected.has(rkey(r)) ? " checked" : ""}></td>` : "");

    const showAll = !isFinite(state.pageSize);
    const pages = showAll ? 1 : Math.max(1, Math.ceil(state.rows.length / state.pageSize));
    if (state.page >= pages) state.page = pages - 1;
    if (state.page < 0) state.page = 0;
    const slice = showAll ? state.rows : state.rows.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);

    const head = dcols.map((c) => {
      const i = columns.indexOf(c);
      const active = state.sort === i;
      const arrow = active ? (state.dir === "a" ? " ▲" : " ▼") : "";
      return `<th class="sortable${active ? " active" : ""}" data-i="${i}">${c.labelHtml || esc(c.label)}${arrow}</th>`;
    }).join("");

    let body = "", prev = Symbol("none");
    for (const r of slice) {
      // data-label drives the mobile stacked-card layout (each cell shows its header).
      const cells = dcols.map((c) => `<td data-label="${esc(c.label)}"${c.cls ? ` class="${c.cls}"` : ""}>${c.cell(r)}</td>`).join("");
      if (grouped) {
        const g = keyOf(gcol, r), gk = String(g), col = state.collapsed.has(gk);
        if (g !== prev) {
          const gsel = selectable ? `<td class="selcol"><input type="checkbox" aria-label="Select group" data-selgroup="${esc(gk)}"></td>` : "";
          // header labels the group; gcol.group(row) lets a column show the group
          // key (e.g. "Recipe") instead of a member's cell (a specific recipe link)
          const ghead = gcol.group ? gcol.group(r) : gcol.cell(r);
          body += `<tr class="grouprow${col ? " collapsed" : ""}" data-group="${esc(gk)}">${gsel}<td colspan="${dcols.length}">` +
            `<span class="caret">${col ? "▸" : "▾"}</span>${ghead}</td></tr>`;
          prev = g;
        }
        body += `<tr data-group="${esc(gk)}"${col ? ' style="display:none"' : ""}>${selTd(r)}${cells}</tr>`;
      } else {
        body += `<tr>${selTd(r)}${cells}</tr>`;
      }
    }

    const groupSel = groupable ? `<div class="groupctl"><label>Group by</label><select data-groupby aria-label="Group by column">
      <option value=""${state.group == null ? " selected" : ""}>None</option>
      ${columns.map((c, i) => `<option value="${i}"${state.group === i ? " selected" : ""}>${esc(c.label)}</option>`).join("")}
    </select></div>` : "";

    const long = state.rows.length > PS_MIN; // enough rows to warrant the paging tools
    const pagerHtml = () => (!showAll && pages > 1) ? `<div class="pager">
      <button data-pg="${state.page - 1}"${state.page <= 0 ? " disabled" : ""}>← Prev</button>
      <span class="muted">Page ${state.page + 1} / ${pages}</span>
      <button data-pg="${state.page + 1}"${state.page >= pages - 1 ? " disabled" : ""}>Next →</button></div>` : "";
    // options = the canonical set + whatever custom size this table was created with / is on
    const extra = [pageSize, state.pageSize].filter((n) => isFinite(n) && !PS_OPTIONS.includes(n));
    const sizeOpts = extra.length ? [...new Set([...PS_OPTIONS, ...extra])].sort((a, b) => a - b) : PS_OPTIONS;
    const sizeSel = long ? `<label class="psize"><span>Rows</span><select data-psize aria-label="Rows per page">${
      sizeOpts.map((n) => `<option value="${n}"${state.pageSize === n ? " selected" : ""}>${n}</option>`).join("")
    }<option value="all"${showAll ? " selected" : ""}>All</option></select></label>` : "";
    const jumpBtn = (d, txt) => `<button type="button" class="tbl-jump" data-jump="${d}" title="Jump to ${d} of table">${txt}</button>`;

    const topbar = (groupable || long) ? `<div class="tabletop">${groupSel || "<span></span>"}` +
      `<div class="table-tools">${sizeSel}${pagerHtml()}${long ? jumpBtn("bottom", "↓ Bottom") : ""}</div></div>` : "";
    const botbar = long ? `<div class="tablebot">${pagerHtml()}${jumpBtn("top", "↑ Top")}</div>` : "";

    container.innerHTML = topbar + `<table class="dtable"><thead><tr>${selTh}${head}</tr></thead><tbody>${body}</tbody></table>` + botbar;
    if (selectable) syncSelUI();
  }

  // reflect selection state on the (in)determinate header + group checkboxes.
  function syncSelUI() {
    const total = state.rows.length;
    const selN = selectedRows().length;
    const allCb = container.querySelector("[data-selall]");
    if (allCb) { allCb.checked = total > 0 && selN === total; allCb.indeterminate = selN > 0 && selN < total; }
    const gcol = state.group != null ? columns[state.group] : null;
    if (gcol) container.querySelectorAll("[data-selgroup]").forEach((cb) => {
      const inG = state.rows.filter((r) => String(keyOf(gcol, r)) === cb.dataset.selgroup);
      const s = inG.filter((r) => state.selected.has(rkey(r))).length;
      cb.checked = inG.length > 0 && s === inG.length;
      cb.indeterminate = s > 0 && s < inG.length;
    });
  }

  container.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-i]");
    if (th) {
      const i = +th.dataset.i;
      if (state.sort === i) state.dir = state.dir === "a" ? "d" : "a";
      else { state.sort = i; state.dir = columns[i].num ? "d" : "a"; }
      state.page = 0;
      render(); emit();
      return;
    }
    const pg = e.target.closest("button[data-pg]");
    if (pg) { state.page = +pg.dataset.pg; render(); return; }
    const jump = e.target.closest("[data-jump]");
    if (jump) {
      const tbl = container.querySelector("table.dtable");
      if (jump.dataset.jump === "bottom") tbl?.scrollIntoView({ block: "end", behavior: "smooth" });
      else container.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    // collapse / expand a group (ignore clicks on links or the group checkbox)
    const gr = e.target.closest(".grouprow");
    if (gr && !e.target.closest("a") && !e.target.closest("input")) {
      const key = gr.getAttribute("data-group");
      const collapsed = !state.collapsed.has(key);
      if (collapsed) state.collapsed.add(key); else state.collapsed.delete(key);
      gr.classList.toggle("collapsed", collapsed);
      const caret = gr.querySelector(".caret"); if (caret) caret.textContent = collapsed ? "▸" : "▾";
      container.querySelectorAll("tbody tr[data-group]").forEach((tr) => {
        if (!tr.classList.contains("grouprow") && tr.getAttribute("data-group") === key) tr.style.display = collapsed ? "none" : "";
      });
    }
  });
  container.addEventListener("change", (e) => {
    const ps = e.target.closest("[data-psize]");
    if (ps) {
      const topIndex = isFinite(state.pageSize) ? state.page * state.pageSize : 0; // keep the current top row in view
      state.pageSize = ps.value === "all" ? Infinity : +ps.value;
      state.page = isFinite(state.pageSize) ? Math.floor(topIndex / state.pageSize) : 0;
      psWrite(state.pageSize);
      render();
      return;
    }
    const sel = e.target.closest("[data-groupby]");
    if (sel) { state.group = sel.value === "" ? null : +sel.value; state.collapsed.clear(); state.page = 0; render(); emit(); return; }
    if (!selectable) return;
    const row = e.target.closest("[data-selrow]");
    if (row) {
      if (e.target.checked) state.selected.add(row.dataset.selrow); else state.selected.delete(row.dataset.selrow);
      syncSelUI(); emitSel(); return;
    }
    const grp = e.target.closest("[data-selgroup]");
    if (grp) {
      const gcol = columns[state.group], on = e.target.checked;
      for (const r of state.rows) if (String(keyOf(gcol, r)) === grp.dataset.selgroup) {
        if (on) state.selected.add(rkey(r)); else state.selected.delete(rkey(r));
      }
      render(); emitSel(); return;
    }
    const all = e.target.closest("[data-selall]");
    if (all) {
      if (all.checked) for (const r of state.rows) state.selected.add(rkey(r)); else state.selected.clear();
      render(); emitSel(); return;
    }
  });

  // optionally start with every group collapsed (e.g. quest objective items ->
  // expand to reveal each item's drop sources).
  if (startCollapsed && state.group != null) {
    const gcol = columns[state.group];
    for (const r of state.rows) state.collapsed.add(String(keyOf(gcol, r)));
  }

  render();
  return {
    getSelected: () => selectedRows(),
    clearSelection: () => { state.selected.clear(); render(); emitSel(); },
  };
}
