// One reusable, client-side sortable + paginated table, used everywhere.
// Sorting happens in JS over the already-loaded rows (no re-query). Each table
// owns its container and re-renders on header click / pager click / group change.
//
// columns: [{ label, cell:(row)=>html, value?:(row)=>primitive, num?:bool, cls?:string }]
//   value() supplies the sort/group key; defaults to the cell's text. num => numeric.
// opts: { pageSize, groupable, group } — groupable shows a "Group by" selector;
//   group is the default column index to group by (null = none).
import { esc } from "./render.js";

const stripTags = (h) => String(h).replace(/<[^>]*>/g, "").trim();

export function createTable(container, { columns, rows, pageSize = Infinity, groupable = false, group = null, sort = null, dir = "a", onState }) {
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
  };
  const emit = () => onState && onState({ sort: colKey(state.sort), dir: state.dir, group: colKey(state.group) });

  const keyOf = (col, row) => (col.value ? col.value(row) : stripTags(col.cell(row)));
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

    const showAll = !isFinite(pageSize);
    const pages = showAll ? 1 : Math.max(1, Math.ceil(state.rows.length / pageSize));
    if (state.page >= pages) state.page = pages - 1;
    const slice = showAll ? state.rows : state.rows.slice(state.page * pageSize, (state.page + 1) * pageSize);

    const head = dcols.map((c) => {
      const i = columns.indexOf(c);
      const active = state.sort === i;
      const arrow = active ? (state.dir === "a" ? " ▲" : " ▼") : "";
      return `<th class="sortable${active ? " active" : ""}" data-i="${i}">${esc(c.label)}${arrow}</th>`;
    }).join("");

    let body = "", prev = Symbol("none");
    for (const r of slice) {
      if (grouped) {
        const g = keyOf(gcol, r);
        if (g !== prev) { body += `<tr class="grouprow"><td colspan="${dcols.length}">${gcol.cell(r)}</td></tr>`; prev = g; }
      }
      body += "<tr>" + dcols.map((c) => `<td${c.cls ? ` class="${c.cls}"` : ""}>${c.cell(r)}</td>`).join("") + "</tr>";
    }

    const groupSel = groupable ? `<div class="groupctl"><label>Group by</label><select data-groupby>
      <option value=""${state.group == null ? " selected" : ""}>None</option>
      ${columns.map((c, i) => `<option value="${i}"${state.group === i ? " selected" : ""}>${esc(c.label)}</option>`).join("")}
    </select></div>` : "";

    const pager = (!showAll && pages > 1) ? `<div class="pager">
      <button data-pg="${state.page - 1}"${state.page <= 0 ? " disabled" : ""}>← Prev</button>
      <span class="muted">Page ${state.page + 1} / ${pages}</span>
      <button data-pg="${state.page + 1}"${state.page >= pages - 1 ? " disabled" : ""}>Next →</button></div>` : "";

    container.innerHTML = groupSel + `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` + pager;
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
    if (pg) { state.page = +pg.dataset.pg; render(); }
  });
  container.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-groupby]");
    if (sel) { state.group = sel.value === "" ? null : +sel.value; state.page = 0; render(); emit(); }
  });

  render();
}
