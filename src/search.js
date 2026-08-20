// Unified search: a shared multi-entity query (runSearch) + a live flat top-5
// autocomplete dropdown wired onto the top-bar input. Items/NPCs/quests are
// FTS5-backed; dungeons use LIKE over the ~39 maps. All in-memory (no network).
import { query, caps } from "./db.js";
import { Q_SEARCH_GOSSIP, Q_SEARCH_VOICE, Q_SEARCH_ITEMS, Q_SEARCH_NPCS, qSearchQuests, Q_SEARCH_SPELLS, Q_SEARCH_DUNGEONS, Q_SEARCH_ZONES, Q_SEARCH_SUBZONES, Q_SEARCH_FACTIONS, Q_SEARCH_ITEMSETS, Q_SEARCH_OBJECTS, Q_ID_ITEM, Q_ID_NPC, Q_ID_QUEST, Q_ID_SPELL, Q_ID_OBJECT } from "./queries.js";
import { itemLink, npcLink, questLink, spellLink, dungeonLink, zoneLink, subzoneLink, factionLink, objectLink, esc } from "./render.js";

// FTS5 prefix MATCH: prefix-match each alnum token ("fire bl" -> "fire* bl*").
export function ftsQuery(term) {
  const toks = term.toLowerCase().match(/[a-z0-9]+/g);
  return toks && toks.length ? toks.map((t) => `${t}*`).join(" ") : null;
}
// Trigram MATCH for substring/infix search: each >=3-char token becomes a quoted
// substring, AND-combined ("shadow fang" -> '"shadow" AND "fang"', matches
// "Shadowfang"). Trigram can't index <3-char tokens, so they're dropped; if none
// remain the sentinel matches nothing (the prefix index still covers short terms).
const TG_SENTINEL = '"qzqzqzq"';
export function trigramQuery(term) {
  const toks = (term.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length >= 3);
  return toks.length ? toks.map((t) => `"${t}"`).join(" AND ") : TG_SENTINEL;
}

// A pure-numeric term is also treated as an entity id -> direct-match rows that
// rank above name matches (mark _id so rankFlat pins them to the top).
async function idMatches(t) {
  if (!/^\d+$/.test(t)) return {};
  const id = Number(t);
  const [item, npc, quest, spell, object] = await Promise.all([
    query(Q_ID_ITEM, [id]), query(Q_ID_NPC, [id]), query(Q_ID_QUEST, [id]), query(Q_ID_SPELL, [id]), query(Q_ID_OBJECT, [id]),
  ]);
  const flag = (rows) => rows.map((r) => ({ ...r, _id: true }));
  return { items: flag(item), npcs: flag(npc), quests: flag(quest), spells: flag(spell), objects: flag(object) };
}

// merge id-match rows to the FRONT of their type array, de-duped by entry
function mergeId(base, ids) {
  for (const k of ["items", "npcs", "quests", "spells", "objects"]) {
    const extra = ids[k]; if (!extra || !extra.length) continue;
    const have = new Set(base[k].map((r) => r.entry));
    base[k] = [...extra.filter((r) => !have.has(r.entry)), ...base[k]];
  }
  return base;
}

// Run all entity searches in parallel; `limit` rows per entity.
export async function runSearch(term, limit) {
  const t = (term || "").trim();
  const empty = { items: [], npcs: [], quests: [], spells: [], dungeons: [], zones: [], subzones: [], factions: [], itemsets: [], objects: [], voice: [], gossip: [] };
  if (!t) return empty;
  const fts = ftsQuery(t);
  const tg = trigramQuery(t);
  const like = `%${t}%`;
  // Cached after the first probe, so this costs nothing on later keystrokes.
  const hasSub = (await caps()).subzones;
  const [items, npcs, quests, spells, dungeons, zones, subzones, factions, itemsets, objects, voice, gossip, ids] = await Promise.all([
    fts ? query(Q_SEARCH_ITEMS, [fts, t, limit, tg]) : [],
    fts ? query(Q_SEARCH_NPCS, [fts, t, limit, tg]) : [],
    fts ? query(qSearchQuests(hasSub), [fts, t, limit, tg]) : [],
    fts ? query(Q_SEARCH_SPELLS, [fts, t, limit, tg]) : [],
    query(Q_SEARCH_DUNGEONS, [like, t, limit]),
    query(Q_SEARCH_ZONES, [like, t, limit]),
    // Runs on every keystroke, inside a Promise.all: a dataset whose DB predates the
    // subzones table must degrade to an empty tab, not take every other entity with it.
    query(Q_SEARCH_SUBZONES, [like, t, limit]).catch(() => []),
    query(Q_SEARCH_FACTIONS, [like, t, limit]),
    query(Q_SEARCH_ITEMSETS, [like, t, limit]),
    query(Q_SEARCH_OBJECTS, [like, t, limit]),
    // Optional schema (db.js caps()): a DB built before the audio tables must yield an
    // empty tab, not reject inside this Promise.all and wipe out every other entity.
    fts ? query(Q_SEARCH_VOICE, [fts, like, limit]).catch(() => []) : [],
    // Gossip text -- where a quoted phrase actually lives. Optional schema, so the
    // same .catch() rule as the other late additions applies.
    fts ? query(Q_SEARCH_GOSSIP, [fts, limit]).catch(() => []) : [],
    idMatches(t),
  ]);
  return mergeId({ items, npcs, quests, spells, dungeons, zones, subzones, factions, itemsets, objects, voice: await withTakes(voice, t), gossip }, ids);
}

// A sound's numbered takes are different lines, so a hit has to say WHICH one matched --
// otherwise the row quotes take 1 and the player opens take 1 while the phrase the reader
// typed is take 6 ("Time is money, friend!" in GoblinFemaleZanyVendorNPCGreeti).
// Fetched for just the hit ids: the ids come straight from the DB, so the inline IN list
// is numeric by construction.
async function withTakes(voice, term) {
  if (!voice.length) return voice;
  const ids = voice.map((v) => v.id).filter((n) => Number.isInteger(n));
  if (!ids.length) return voice;
  let rows = [];
  try {
    rows = await query(`SELECT sound, take, text, src FROM sound_text
      WHERE sound IN (${ids.join(",")}) AND take IS NOT NULL
      ORDER BY sound, take, id`);
  } catch { return voice; }        // DB predates the column -- keep the old single text
  if (!rows.length) return voice;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.sound)) by.set(r.sound, []);
    by.get(r.sound).push(r);
  }
  const lower = (term || "").toLowerCase();
  return voice.map((v) => {
    const list = by.get(v.id);
    if (!list) return v;
    const hit = (lower && list.find((t) => (t.text || "").toLowerCase().includes(lower)))
      || list.find((t) => t.text === v.text) || list[0];
    return { ...v, take: hit.take, text: hit.text, src: hit.src, takes: list };
  });
}

// Flatten the per-type results into one ranked list (exact > prefix > other,
// then a small per-type weight, then name) and keep the best `n`.
function rankFlat(res, term, n) {
  const tl = term.toLowerCase();
  // an id-matched row (_id) wins outright (tier -1); otherwise exact > prefix > other
  const tier = (name, row) => { if (row && row._id) return -1; const s = (name || "").toLowerCase(); return s === tl ? 0 : s.startsWith(tl) ? 1 : 2; };
  const all = [];
  for (const it of res.items) all.push({ type: it._id ? "item #" + it.entry : "item", w: 0, name: it.name, tier: tier(it.name, it), html: itemLink(it.entry, it.name, it.quality, it.icon), href: `?item=${it.entry}` });
  for (const c of res.npcs) all.push({ type: c._id ? "npc #" + c.entry : "npc", w: 1, name: c.name, tier: tier(c.name, c), html: npcLink(c.entry, c.name) + (c.subname ? ` <span class="muted">&lt;${esc(c.subname)}&gt;</span>` : ""), href: `?npc=${c.entry}` });
  for (const q of res.quests) all.push({ type: q._id ? "quest #" + q.entry : "quest", w: 2, name: q.title, tier: tier(q.title, q), html: questLink(q.entry, q.title), href: `?quest=${q.entry}` });
  for (const s of res.spells) all.push({ type: s._id ? "spell #" + s.entry : "spell", w: 3, name: s.name, tier: tier(s.name, s), html: spellLink(s.entry, s.name, s.icon), href: `?spell=${s.entry}` });
  for (const f of res.factions) all.push({ type: "faction", w: 4, name: f.name, tier: tier(f.name), html: factionLink(f.id, f.name), href: `?faction=${f.id}` });
  for (const s of res.itemsets || []) all.push({ type: "item set", w: 5, name: s.name, tier: tier(s.name), html: `<a class="ilink" href="?itemset=${s.id}">${esc(s.name)}</a>`, href: `?itemset=${s.id}` });
  for (const d of res.dungeons) all.push({ type: "dungeon", w: 6, name: d.name, tier: tier(d.name), html: dungeonLink(d.id, d.name), href: `?dungeon=${d.id}` });
  for (const o of res.objects || []) all.push({ type: o._id ? "object #" + o.entry : "object", w: 7, name: o.name, tier: tier(o.name, o), html: objectLink(o.entry, o.name), href: `?object=${o.entry}` });
  for (const z of res.zones) all.push({ type: "zone", w: 8, name: z.name, tier: tier(z.name), html: zoneLink(z.areaid, z.name), href: `?zone=${z.areaid}` });
  // After zones (w: 8), so searching "Elwynn Forest" surfaces the zone itself first.
  // The parent name rides along because subzone names repeat across the world.
  for (const s of res.subzones || []) all.push({ type: "subzone", w: 9, name: s.name, tier: tier(s.name), html: subzoneLink(s.entry, s.name) + (s.zone_name ? ` <span class="muted">${esc(s.zone_name)}</span>` : ""), href: `?subzone=${s.entry}` });
  // Last (w: 10): a voice line is rarely what someone means by a bare name search, but
  // it's exactly what they mean when they typed a phrase. Tiered on the TRANSCRIPT when
  // there is one -- ranking a spoken line by its internal sound name would bury an exact
  // quote under unrelated clips whose filename happens to start with the term.
  for (const v of res.voice || []) all.push({
    type: "voice line", w: 10, name: v.text || v.name, tier: tier(v.text || v.name),
    html: `<span class="muted">${esc(v.text ? `“${v.text}”` : v.name)}</span>`
      + (v.creature_name ? ` ${npcLink(v.creature, v.creature_name)}` : ""),
    href: `?voicelines=${encodeURIComponent(v.name)}`,
  });
  // Gossip (w: 11) -- the words an NPC says to you. Ranked on the LINE, since that is
  // what was typed; the result navigates to the NPC, which is what the phrase identifies.
  for (const g of res.gossip || []) all.push({
    type: "dialogue", w: 11, name: g.text, tier: tier(g.text),
    html: `${npcLink(g.entry, g.name)} <span class="muted">“${esc(String(g.text).replace(/\$[BbNnCcRr]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70))}”</span>`,
    href: `?npc=${g.entry}`,
  });
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
