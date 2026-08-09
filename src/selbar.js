// Selection-operations bar for item tables: clipboard exports (raw ids / prefixed
// lines like ".additem 1234"), compare, and open-on-Wowhead, driven by the shared
// table's opt-in row selection (see table.js `selectable` / `rowKey`).
//
// Lives in its own module because TWO views mount it -- ?browse=items and the search
// results' Items tab -- and a copy in each would drift the moment one grows an op.
import { esc } from "./render.js";

const WOWHEAD = "https://www.wowhead.com/classic/item=";

// The bar starts disabled: every op needs a non-empty selection, and buttons that do
// nothing when clicked read as broken.
export function selbarHtml(prefix = ".additem ") {
  return `<div class="selbar" data-selbar>
    <span class="selcount" data-selcount>0 selected</span>
    <button type="button" data-op="ids" disabled>Copy IDs</button>
    <span class="op-prefix"><input type="text" data-prefix value="${esc(prefix)}" aria-label="line prefix">
      <button type="button" data-op="prefix" disabled>Copy w/ prefix</button></span>
    <button type="button" data-op="compare" disabled>Compare</button>
    <button type="button" data-op="wh" disabled>Open on Wowhead</button>
    <button type="button" data-op="clear" disabled>Clear</button>
    <span class="op-status" data-opstatus></span>
  </div>`;
}

// Feed this the count from createTable's onSelectionChange. Tolerates a null bar so
// the caller can wire it before the DOM exists (the table can emit during first render).
export function updateSelbar(bar, count) {
  if (!bar) return;
  bar.querySelector("[data-selcount]").textContent = `${count} selected`;
  bar.querySelectorAll("[data-op]").forEach((b) => { b.disabled = count === 0; });
}

// Reads the live selection from the table API on each click (not a snapshot), so
// sorting/paging between selecting and copying can't hand back stale rows.
export function wireSelbar(bar, api, navigate) {
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
