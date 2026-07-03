// Talent calculator (?talents=<class>). Renders a class's talent trees from the
// committed scripts/data/talents.json (structure only: tab/row/col/rank-spell-ids/
// prereq — see scripts/extract-talents.py). Talent names, icons and tooltips are
// resolved from the rank spell ids against the shipped `spells` table, so the JSON
// stays tiny and the existing spell hovercard powers the tooltips.
//
// Build state persists in the URL (?talents=warrior&t=<per-tab rank digits>), so a
// spec is a shareable link. Allocation obeys the classic rules: 51 points, a tree
// row unlocks after 5 points per row below it, and prerequisite talents.
import { queryOne } from "./db.js";
import { iconImg, esc } from "./render.js";
import { Q_SPELL } from "./queries.js";
import { ASSETS_BASE } from "./config.js";
import talentsData from "../scripts/data/talents.json";

// canonical class order for the picker (matches the in-game class list)
const CLASS_ORDER = ["warrior", "paladin", "hunter", "rogue", "priest", "shaman", "mage", "warlock", "druid"];

const COLS = 4;      // classic talent grid width
const ROW_COST = 5;  // points per row to unlock the next tier

// One set of delegated listeners for the whole app lifetime; they dispatch to the
// controller of whichever talent page is currently mounted (avoids re-binding on
// every visit / re-render). Left-click = +1 rank, right-click = −1.
let active = null;
function ensureListeners() {
  if (ensureListeners.done) return;
  ensureListeners.done = true;
  const app = document.getElementById("app");
  app.addEventListener("click", (e) => {
    if (!active) return;
    const c = e.target.closest(".talent-cell");
    if (c) { e.preventDefault(); e.stopPropagation(); active.change(+c.dataset.tid, +1); return; }
    if (e.target.closest("[data-reset]")) active.reset();
  });
  app.addEventListener("contextmenu", (e) => {
    if (!active) return;
    const c = e.target.closest(".talent-cell");
    if (c) { e.preventDefault(); e.stopPropagation(); active.change(+c.dataset.tid, -1); }
  });
}

// A build is legal if, within each tab, every allocated talent is under its rank
// cap, has enough points spent below its row (5·row), and its prereq is met; and
// the grand total is within the point budget.
function legalTab(tab, alloc, maxPoints, totalAll) {
  if (totalAll > maxPoints) return false;
  const rowPts = {};
  for (const t of tab.talents) {
    const r = alloc[t.id] || 0;
    if (r > 0) { if (r > t.ranks.length) return false; rowPts[t.row] = (rowPts[t.row] || 0) + r; }
  }
  for (const t of tab.talents) {
    const r = alloc[t.id] || 0;
    if (r <= 0) continue;
    let below = 0;
    for (const k in rowPts) if (+k < t.row) below += rowPts[k];
    if (below < ROW_COST * t.row) return false;
    if (t.req && (alloc[t.req] || 0) < (t.reqRank || 1)) return false;
  }
  return true;
}

const totalPoints = (alloc) => Object.values(alloc).reduce((a, b) => a + (b || 0), 0);

function parseAlloc(search, data) {
  const alloc = {};
  const digitsByTab = (new URLSearchParams(search).get("t") || "").split("-");
  data.tabs.forEach((tab, ti) => {
    const digits = digitsByTab[ti] || "";
    tab.talents.forEach((t, i) => {
      const r = parseInt(digits[i] || "0", 10);
      if (r > 0 && r <= t.ranks.length) alloc[t.id] = r;
    });
  });
  return alloc;
}

export async function showTalents(clsParam) {
  const app = document.getElementById("app");
  const classes = talentsData.classes || {};
  const slug = (clsParam || "").toLowerCase();

  if (!slug || !classes[slug]) {
    document.title = "Talent Calculator - Tortoise-WoW DB";
    const order = CLASS_ORDER.filter((s) => classes[s]).concat(Object.keys(classes).filter((s) => !CLASS_ORDER.includes(s)));
    const links = order.map((s) => `<a class="nav talent-cls" href="?talents=${s}">
      <img class="talent-cls-icon" src="${ASSETS_BASE}icons/class/${s}.webp" alt="" width="48" height="48" loading="lazy">
      <span>${esc(classes[s].name)}</span></a>`).join("");
    app.innerHTML = `<div class="talent-page"><h1>Talent Calculator</h1>${
      links ? `<div class="talent-classlist">${links}</div>`
            : `<p class="muted">No talent data yet — run <code>python scripts/extract-talents.py</code> against the Turtle client to generate <code>scripts/data/talents.json</code>.</p>`}</div>`;
    return;
  }

  const data = classes[slug];
  document.title = `${data.name} Talents - Tortoise-WoW DB`;
  app.innerHTML = `<div class="loading">Loading talents…</div>`;

  // resolve every rank spell once (name / icon / tooltip via the spell hovercard)
  const ids = new Set();
  for (const tab of data.tabs) for (const t of tab.talents) for (const sid of t.ranks) ids.add(sid);
  const spellMap = new Map();
  await Promise.all([...ids].map(async (sid) => { const sp = await queryOne(Q_SPELL, [sid]); if (sp) spellMap.set(sid, sp); }));

  const maxPoints = talentsData.maxPoints || 51;
  const alloc = parseAlloc(location.search, data);
  const tabOf = (tid) => data.tabs.find((tab) => tab.talents.some((t) => t.id === tid));

  const writeAlloc = () => {
    const enc = data.tabs.map((tab) => tab.talents.map((t) => alloc[t.id] || 0).join("")).join("-");
    const np = new URLSearchParams(location.search);
    np.set("talents", slug);
    if (/[1-9]/.test(enc)) np.set("t", enc); else np.delete("t");
    history.replaceState({}, "", "?" + np.toString());
  };

  const change = (tid, delta) => {
    const tab = tabOf(tid);
    const t = tab.talents.find((x) => x.id === tid);
    const prev = alloc[tid] || 0;
    const next = prev + delta;
    if (next < 0 || next > t.ranks.length) return;
    alloc[tid] = next;
    if (!legalTab(tab, alloc, maxPoints, totalPoints(alloc))) { alloc[tid] = prev; return; }
    if (!alloc[tid]) delete alloc[tid];
    writeAlloc();
    render();
  };

  const cell = (tab, t, spentInTab) => {
    const rank = alloc[t.id] || 0;
    const shown = spellMap.get(t.ranks[Math.max(0, rank - 1)]) || spellMap.get(t.ranks[0]);
    const name = shown ? shown.name : `Talent ${t.id}`;
    const icon = shown ? iconImg(shown.icon) : "";
    const unlocked = spentInTab >= ROW_COST * t.row && (!t.req || (alloc[t.req] || 0) >= (t.reqRank || 1));
    const maxed = rank >= t.ranks.length;
    const state = maxed ? "maxed" : rank > 0 ? "on" : unlocked ? "open" : "locked";
    const href = shown ? `?spell=${shown.entry}` : "#";
    return `<a class="ilink talent-cell ${state}" style="grid-row:${t.row + 1};grid-column:${t.col + 1}"
      href="${href}" data-tid="${t.id}" title="${esc(name)}">
      ${icon}<span class="talent-rank">${rank}/${t.ranks.length}</span></a>`;
  };

  const renderTab = (tab, spent) => {
    const cells = tab.talents.map((t) => cell(tab, t, spent)).join("");
    const rows = Math.max(6, ...tab.talents.map((t) => t.row + 1));
    return `<div class="talent-tree">
      <div class="talent-tree-head"><b>${esc(tab.name)}</b> <span class="muted">${spent}</span></div>
      <div class="talent-grid" style="grid-template-columns:repeat(${COLS},44px);grid-template-rows:repeat(${rows},44px)">${cells}</div>
    </div>`;
  };

  const render = () => {
    const spentPer = data.tabs.map((tab) => tab.talents.reduce((s, t) => s + (alloc[t.id] || 0), 0));
    const spentTotal = spentPer.reduce((a, b) => a + b, 0);
    app.innerHTML = `<div class="talent-page">
      <div class="talent-head">
        <h1>${esc(data.name)} Talents</h1>
        <div class="talent-status">Points spent: <b>${spentTotal}</b> / ${maxPoints}
          <span class="muted">(${maxPoints - spentTotal} left)</span>
          · <button type="button" class="talent-reset" data-reset>Reset</button></div>
      </div>
      ${talentsData._note ? `<p class="talent-note muted">${esc(talentsData._note)}</p>` : ""}
      <div class="talent-trees">${data.tabs.map((tab, i) => renderTab(tab, spentPer[i])).join("")}</div>
    </div>`;
  };

  const reset = () => { for (const k in alloc) delete alloc[k]; writeAlloc(); render(); };
  active = { change, reset };
  ensureListeners();
  render();
}
