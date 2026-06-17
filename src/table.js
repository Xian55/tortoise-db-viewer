// One reusable, client-side sortable + paginated table, used everywhere.
// Sorting happens in JS over the already-loaded rows (no re-query). Each table
// owns its container and re-renders on header click / pager click.
//
// columns: [{ label, cell:(row)=>html, value?:(row)=>primitive, num?:bool, cls?:string }]
//   value() supplies the sort key; defaults to the cell's text. num => numeric.
import { esc } from "./render.js";

const stripTags = (h) => String(h).replace(/<[^>]*>/g, "").trim();

export function createTable(container, { columns, rows, pageSize = Infinity }) {
  const state = { rows: rows.slice(), sort: null, dir: "a", page: 0 };

  const sortValue = (col, row) => (col.value ? col.value(row) : stripTags(col.cell(row)));

  function applySort() {
    if (state.sort == null) return;
    const col = columns[state.sort];
    const mul = state.dir === "a" ? 1 : -1;
    state.rows.sort((a, b) => {
      let va = sortValue(col, a), vb = sortValue(col, b);
      const ea = va == null || va === "", eb = vb == null || vb === "";
      if (ea && eb) return 0;
      if (ea) return 1;          // empties sort last regardless of dir
      if (eb) return -1;
      if (col.num) return (Number(va) - Number(vb)) * mul;
      return String(va).localeCompare(String(vb)) * mul;
    });
  }

  function render() {
    applySort();
    const showAll = !isFinite(pageSize);
    const pages = showAll ? 1 : Math.max(1, Math.ceil(state.rows.length / pageSize));
    if (state.page >= pages) state.page = pages - 1;
    const slice = showAll ? state.rows : state.rows.slice(state.page * pageSize, (state.page + 1) * pageSize);

    const head = columns.map((c, i) => {
      const active = state.sort === i;
      const arrow = active ? (state.dir === "a" ? " ▲" : " ▼") : "";
      return `<th class="sortable${active ? " active" : ""}" data-i="${i}">${esc(c.label)}${arrow}</th>`;
    }).join("");
    const body = slice.map((r) =>
      "<tr>" + columns.map((c) => `<td${c.cls ? ` class="${c.cls}"` : ""}>${c.cell(r)}</td>`).join("") + "</tr>").join("");
    const pager = (!showAll && pages > 1) ? `<div class="pager">
      <button data-pg="${state.page - 1}"${state.page <= 0 ? " disabled" : ""}>← Prev</button>
      <span class="muted">Page ${state.page + 1} / ${pages}</span>
      <button data-pg="${state.page + 1}"${state.page >= pages - 1 ? " disabled" : ""}>Next →</button></div>` : "";

    container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${pager}`;
  }

  container.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-i]");
    if (th) {
      const i = +th.dataset.i;
      if (state.sort === i) state.dir = state.dir === "a" ? "d" : "a";
      else { state.sort = i; state.dir = columns[i].num ? "d" : "a"; }
      state.page = 0;
      render();
      return;
    }
    const pg = e.target.closest("button[data-pg]");
    if (pg) { state.page = +pg.dataset.pg; render(); }
  });

  render();
}
