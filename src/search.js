// Unified search: a shared multi-entity query (runSearch) + a live flat top-5
// autocomplete dropdown wired onto the top-bar input. Items/NPCs/quests are
// FTS5-backed; dungeons use LIKE over the ~39 maps. All in-memory (no network).
import { query } from "./db.js";
import { Q_SEARCH_ITEMS, Q_SEARCH_NPCS, Q_SEARCH_QUESTS, Q_SEARCH_SPELLS, Q_SEARCH_DUNGEONS, Q_SEARCH_ZONES, Q_SEARCH_FACTIONS, Q_SEARCH_ITEMSETS, Q_SEARCH_OBJECTS } from "./queries.js";
import { itemLink, npcLink, questLink, spellLink, dungeonLink, zoneLink, factionLink, objectLink, esc } from "./render.js";

// FTS5 prefix MATCH: prefix-match each alnum token ("fire bl" -> "fire* bl*").
function ftsQuery(term) {
  const toks = term.toLowerCase().match(/[a-z0-9]+/g);
  return toks && toks.length ? toks.map((t) => `${t}*`).join(" ") : null;
}
// Trigram MATCH for substring/infix search: each >=3-char token becomes a quoted
// substring, AND-combined ("shadow fang" -> '"shadow" AND "fang"', matches
// "Shadowfang"). Trigram can't index <3-char tokens, so they're dropped; if none
// remain the sentinel matches nothing (the prefix index still covers short terms).
const TG_SENTINEL = '"qzqzqzq"';
function trigramQuery(term) {
  const toks = (term.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length >= 3);
  return toks.length ? toks.map((t) => `"${t}"`).join(" AND ") : TG_SENTINEL;
}

// Run all entity searches in parallel; `limit` rows per entity.
export async function runSearch(term, limit) {
  const t = (term || "").trim();
  const empty = { items: [], npcs: [], quests: [], spells: [], dungeons: [], zones: [], factions: [], itemsets: [], objects: [] };
  if (!t) return empty;
  const fts = ftsQuery(t);
  const tg = trigramQuery(t);
  const like = `%${t}%`;
  const [items, npcs, quests, spells, dungeons, zones, factions, itemsets, objects] = await Promise.all([
    fts ? query(Q_SEARCH_ITEMS, [fts, t, limit, tg]) : [],
    fts ? query(Q_SEARCH_NPCS, [fts, t, limit, tg]) : [],
    fts ? query(Q_SEARCH_QUESTS, [fts, t, limit, tg]) : [],
    fts ? query(Q_SEARCH_SPELLS, [fts, t, limit, tg]) : [],
    query(Q_SEARCH_DUNGEONS, [like, t, limit]),
    query(Q_SEARCH_ZONES, [like, t, limit]),
    query(Q_SEARCH_FACTIONS, [like, t, limit]),
    query(Q_SEARCH_ITEMSETS, [like, t, limit]),
    query(Q_SEARCH_OBJECTS, [like, t, limit]),
  ]);
  return { items, npcs, quests, spells, dungeons, zones, factions, itemsets, objects };
}

// Flatten the per-type results into one ranked list (exact > prefix > other,
// then a small per-type weight, then name) and keep the best `n`.
function rankFlat(res, term, n) {
  const tl = term.toLowerCase();
  const tier = (name) => { const s = (name || "").toLowerCase(); return s === tl ? 0 : s.startsWith(tl) ? 1 : 2; };
  const all = [];
  for (const it of res.items) all.push({ type: "item", w: 0, name: it.name, tier: tier(it.name), html: itemLink(it.entry, it.name, it.quality, it.icon), href: `?item=${it.entry}` });
  for (const c of res.npcs) all.push({ type: "npc", w: 1, name: c.name, tier: tier(c.name), html: npcLink(c.entry, c.name) + (c.subname ? ` <span class="muted">&lt;${esc(c.subname)}&gt;</span>` : ""), href: `?npc=${c.entry}` });
  for (const q of res.quests) all.push({ type: "quest", w: 2, name: q.title, tier: tier(q.title), html: questLink(q.entry, q.title), href: `?quest=${q.entry}` });
  for (const s of res.spells) all.push({ type: "spell", w: 3, name: s.name, tier: tier(s.name), html: spellLink(s.entry, s.name, s.icon), href: `?spell=${s.entry}` });
  for (const f of res.factions) all.push({ type: "faction", w: 4, name: f.name, tier: tier(f.name), html: factionLink(f.id, f.name), href: `?faction=${f.id}` });
  for (const s of res.itemsets || []) all.push({ type: "item set", w: 5, name: s.name, tier: tier(s.name), html: `<a class="ilink" href="?itemset=${s.id}">${esc(s.name)}</a>`, href: `?itemset=${s.id}` });
  for (const d of res.dungeons) all.push({ type: "dungeon", w: 6, name: d.name, tier: tier(d.name), html: dungeonLink(d.id, d.name), href: `?dungeon=${d.id}` });
  for (const o of res.objects || []) all.push({ type: "object", w: 7, name: o.name, tier: tier(o.name), html: objectLink(o.entry, o.name), href: `?object=${o.entry}` });
  for (const z of res.zones) all.push({ type: "zone", w: 8, name: z.name, tier: tier(z.name), html: zoneLink(z.areaid, z.name), href: `?zone=${z.areaid}` });
  all.sort((a, b) => a.tier - b.tier || a.w - b.w || (a.name || "").localeCompare(b.name || ""));
  return all.slice(0, n);
}

export function initSearchDropdown(input, form, navigate) {
  const panel = document.createElement("div");
  panel.className = "search-dropdown";
  panel.style.display = "none";
  document.body.appendChild(panel);

  let seq = 0;        // monotonic guard so a slow query can't overwrite a newer one
  let hrefs = [];     // navigable targets, parallel to rendered rows (+ "see all")
  let active = -1;
  let timer = null;

  const reposition = () => {
    const r = input.getBoundingClientRect();
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.bottom + 4}px`;
    panel.style.minWidth = `${Math.max(r.width, 300)}px`;
  };
  const close = () => { panel.style.display = "none"; active = -1; hrefs = []; };
  const isOpen = () => panel.style.display !== "none";

  const paint = () => {
    panel.querySelectorAll(".sd-row").forEach((el, i) => el.classList.toggle("active", i === active));
  };

  const render = (term, rows) => {
    hrefs = rows.map((r) => r.href).concat(`?search=${encodeURIComponent(term)}`);
    const items = rows.map((r) =>
      `<div class="sd-row" data-href="${r.href}">${r.html}<span class="sd-tag">${r.type}</span></div>`).join("");
    panel.innerHTML = items +
      `<div class="sd-row sd-all" data-href="?search=${encodeURIComponent(term)}">See all results for “${esc(term)}” →</div>`;
    active = -1;
    reposition();
    panel.style.display = "block";
  };

  const update = async () => {
    const term = input.value.trim();
    if (term.length < 2) { close(); return; }
    const my = ++seq;
    const res = await runSearch(term, 6);
    if (my !== seq || input.value.trim() !== term) return;   // stale / moved on
    const rows = rankFlat(res, term, 5);
    if (!rows.length) { close(); return; }
    render(term, rows);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(update, 150);
  });

  input.addEventListener("keydown", (e) => {
    if (!isOpen()) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, hrefs.length - 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    else if (e.key === "Enter") {
      const href = active >= 0 ? hrefs[active] : null;   // capture before close() wipes hrefs
      if (href) { e.preventDefault(); close(); navigate(href); }
      // else: let the form submit (full results page)
    } else if (e.key === "Escape") { close(); }
  });

  // keep focus on click (avoid blur closing before the click lands)
  panel.addEventListener("mousedown", (e) => e.preventDefault());
  panel.addEventListener("click", (e) => {
    const row = e.target.closest("[data-href]");
    if (!row) return;
    e.preventDefault(); e.stopPropagation();   // beat the global a.ilink handler
    const href = row.getAttribute("data-href");
    close();
    navigate(href);
  });

  // close on outside click, blur, submit, and window changes
  document.addEventListener("mousedown", (e) => {
    if (!panel.contains(e.target) && e.target !== input) close();
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  form.addEventListener("submit", () => close());
  window.addEventListener("resize", () => { if (isOpen()) reposition(); });
  window.addEventListener("scroll", () => { if (isOpen()) reposition(); }, { passive: true });
}
