import "./style.css";
import { query, queryOne, preconnect, getMeta } from "./db.js";
import * as Q from "./queries.js";
import { renderTooltip, tabs, itemLink, npcLink, dungeonLink, questLink, factionLink, zoneLink, spellLink, objectLink, spellTooltip, spellCost, resolveSpellText, moneyHtml, iconImg, iconGridImg, sourceTags, teamBadge, teamLabel, pct, esc, setIconAtlas } from "./render.js";
import { createTable } from "./table.js";
import { CREATURE_TYPE, CREATURE_RANK, PROFESSION_LABEL, QUEST_TYPE, REP_STANDING, REP_TO_STANDING, REP_EXALTED, repStandingReached, CONTINENT, GAMEOBJECT_TYPE, INV_TYPE, questZoneLabel, classRestrictions, raceRestrictions, questFaction, npcRoles, SPELL_SCHOOL, POWER_TYPE, SPELL_DISPEL, SPELL_MECHANIC, SPELL_EFFECT, SPELL_AURA, SPELL_FLAGS, GEAR_STAT_LABEL, GEAR_CRITERIA } from "./constants.js";
import { showBrowse } from "./browse.js";
import { showCharacters, showCharacter, showSharedLoadout } from "./character.js";
import { showWeightSets, showSharedWeightSet } from "./weightsets.js";
import { initHovercards } from "./hovercard.js";
import { runSearch, initSearchDropdown } from "./search.js";
import { ASSETS_BASE, resolveOrigins } from "./config.js";
import { buildNavHtml, wireNav, closeNav } from "./nav.js";
import { buildQuestMap } from "./questmap.js";
import { showLeveling, showGuide } from "./guide.js";
import { showTalents } from "./talents.js";
// Seamless-minimap transform manifest (tile/adt/grid + per-continent bbox). Tiny,
// committed; bundled at build time. The tile pyramid itself lives on R2.
import minimapManifest from "../scripts/data/minimap.json";

const app = document.getElementById("app");
const searchInput = document.getElementById("search");

const lvlRange = (r) => (r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : (r.level_min || ""));

// ---- sortable-table registry (mounted after innerHTML) ----
let pendingTables = [];
function regTable(columns, rows, opts = {}) {
  if (!rows || !rows.length) return { html: "", count: 0 };
  const id = `t${pendingTables.length}`;
  pendingTables.push({ id, columns, rows, ...opts });
  return { html: `<div class="tbl" data-table="${id}"></div>`, count: rows.length };
}
function mountTables() {
  for (const s of pendingTables) {
    const el = app.querySelector(`[data-table="${s.id}"]`);
    if (el) createTable(el, s);
  }
  pendingTables = [];
}
function wireTabs() {
  const bar = app.querySelector(".tabbar");
  if (!bar) return;
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    app.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === btn));
    app.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== btn.dataset.tab));
  });
}

// ---- routing ----
export function navigate(url, replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  renderRoute();
  window.scrollTo(0, 0); // new view starts at the top (SPA nav keeps scroll otherwise)
}
window.addEventListener("popstate", renderRoute);

document.addEventListener("click", (e) => {
  const a = e.target.closest("a.ilink, a.nav");
  if (a && a.origin === location.origin) {
    e.preventDefault();
    topbar.classList.remove("nav-open");   // close the mobile menu after navigating
    navToggle.setAttribute("aria-expanded", "false");
    closeNav(topnav);
    navigate(a.getAttribute("href"));
  }
});

// Top-bar mega-menu (data-driven flyout) + mobile hamburger.
const topbar = document.querySelector(".topbar");
const navToggle = document.getElementById("navToggle");
const topnav = document.getElementById("topnav");
topnav.innerHTML = buildNavHtml();
wireNav(topnav);
navToggle.addEventListener("click", () => {
  const open = topbar.classList.toggle("nav-open");
  navToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) closeNav(topnav);
});

document.getElementById("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const term = searchInput.value.trim();
  if (term) navigate(`?search=${encodeURIComponent(term)}`);
});

function route() {
  const params = new URLSearchParams(location.search);
  const item = params.get("item");
  const npc = params.get("npc");
  const quest = params.get("quest");
  const spell = params.get("spell");
  const itemset = params.get("itemset");
  const faction = params.get("faction");
  const zone = params.get("zone");
  const dungeon = params.get("dungeon");
  const object = params.get("object");
  const icon = params.get("icon");
  const browse = params.get("browse");
  const compare = params.get("compare");
  const term = params.get("search");
  // Browse first: browse URLs carry filter params (e.g. faction=a|h) that would
  // otherwise collide with the singular entity-detail routes below.
  // return the view's promise so boot can time the first render (page load).
  if (browse) return showBrowse(browse, navigate);
  else if (compare) return showCompare(compare);
  else if (item) return showItem(Number(item));
  else if (npc) return showNpc(Number(npc));
  else if (quest) return showQuest(Number(quest));
  else if (spell) return showSpell(Number(spell));
  else if (itemset) return showItemSet(Number(itemset));
  else if (faction) return showFaction(Number(faction));
  else if (zone) return showZone(Number(zone), params.get("gather") ? Number(params.get("gather")) : null);
  else if (dungeon) return showDungeon(Number(dungeon));
  else if (object) return showObject(Number(object));
  else if (icon) return showIcon(icon);
  else if (params.get("icons") !== null) return showIcons();
  else if (params.get("flights") !== null) return showFlights(params.get("cont") ? Number(params.get("cont")) : 0);
  else if (params.get("worldmap") !== null) return showWorldMap(params.get("worldmap") ? Number(params.get("worldmap")) : 0);
  else if (params.get("dungeons") !== null) return showDungeons();
  else if (params.get("random") !== null) return showRandom();
  else if (params.get("guides") !== null) return showLeveling();
  else if (params.get("guide")) return showGuide(params.get("guide"));
  else if (params.get("talents") !== null) return showTalents(params.get("talents"));
  else if (params.get("loadout")) return showSharedLoadout(params.get("loadout"), navigate);
  else if (params.get("character")) return showCharacter(params.get("character"), navigate);
  else if (params.get("characters") !== null) return showCharacters(navigate);
  else if (params.get("weightset")) return showSharedWeightSet(params.get("weightset"), navigate);
  else if (params.get("weights") !== null) return showWeightSets(navigate);
  else if (term) { searchInput.value = term; return showSearch(term); }
  else return showHome();
}

// Detail routes -> their prerendered OG-stub path prefix (scripts/build-og.mjs).
// Sharing that /<prefix>/<id> link (not the ?param= URL) is what unfurls in
// Discord/Twitter, so detail pages get a "Share" button that copies it.
const SHARE_PREFIX = { item: "i", npc: "n", quest: "q", spell: "s", object: "o", zone: "z", faction: "f", itemset: "is" };
function addShareButton() {
  const params = new URLSearchParams(location.search);
  let param = null, id = null;
  for (const k in SHARE_PREFIX) { const v = params.get(k); if (v) { param = k; id = v; break; } }
  if (!id) return;
  // anchor: the page heading (most pages) or the meta line (item/spell pages put
  // the name in a tooltip card, not an <h1>).
  const anchor = app.querySelector("h1, .item-meta, .spell-sub");
  if (!anchor || (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains("share-btn"))) return;
  const url = `${location.origin}${import.meta.env.BASE_URL}${SHARE_PREFIX[param]}/${id}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "share-btn";
  btn.title = "Copy a link that shows a rich preview in Discord, Twitter, etc.";
  btn.textContent = "🔗 Share";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "✓ Link copied";
      setTimeout(() => { btn.textContent = "🔗 Share"; }, 1600);
    } catch { btn.textContent = "Copy failed"; }
  });
  anchor.insertAdjacentElement("afterend", btn);
}

// ---- compare tray (a small localStorage-backed basket of items) ----
// Lets you collect items across pages, then open them side-by-side via ?compare=.
const CMP_KEY = "tw_compare", CMP_MAX = 8;
function getCmp() {
  try { const a = JSON.parse(localStorage.getItem(CMP_KEY) || "[]"); return Array.isArray(a) ? a.filter(Number).slice(0, CMP_MAX) : []; }
  catch { return []; }
}
function setCmp(arr) {
  try { localStorage.setItem(CMP_KEY, JSON.stringify(arr.slice(0, CMP_MAX))); } catch { /* private mode */ }
  renderCompareTray();
}
function toggleCmp(id) {
  const a = getCmp();
  const i = a.indexOf(id);
  if (i >= 0) a.splice(i, 1); else if (a.length < CMP_MAX) a.push(id);
  setCmp(a);
}
// Floating pill: "⚖ Compare (n)" -> ?compare=…, with a clear button. Hidden when <2.
function renderCompareTray() {
  let el = document.getElementById("cmpTray");
  const ids = getCmp();
  if (ids.length < 2) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement("div"); el.id = "cmpTray"; el.className = "cmp-tray"; document.body.appendChild(el); }
  el.innerHTML = `<a class="nav cmp-tray-open" href="?compare=${ids.join(":")}">⚖ Compare (${ids.length})</a><button type="button" class="cmp-tray-clear" title="Clear compare list" aria-label="Clear compare list">×</button>`;
  el.querySelector(".cmp-tray-clear").onclick = () => setCmp([]);
}

// Item pages get an "add to compare" toggle next to the Share button.
function addCompareButton() {
  const params = new URLSearchParams(location.search);
  const id = Number(params.get("item"));
  if (!id) return;
  const anchor = app.querySelector(".item-meta");
  if (!anchor || anchor.querySelector(".cmp-add")) return;
  const inList = getCmp().includes(id);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cmp-add" + (inList ? " on" : "");
  btn.title = "Add this item to the compare list";
  btn.textContent = inList ? "⚖ In compare" : "⚖ Compare";
  btn.addEventListener("click", () => {
    toggleCmp(id);
    const now = getCmp().includes(id);
    btn.classList.toggle("on", now);
    btn.textContent = now ? "⚖ In compare" : "⚖ Compare";
  });
  anchor.appendChild(btn);
}

// route() then drop the Share + compare buttons onto the rendered detail page.
function renderRoute() {
  const p = Promise.resolve(route());
  const after = () => { addShareButton(); addCompareButton(); renderCompareTray(); };
  p.then(after, after);
  return p;
}

// ---- views ----
function showHome() {
  document.title = "Tortoise-WoW Database";
  app.innerHTML = `<div class="home">
    <h1>Tortoise-WoW Database</h1>
    <p>Search above, or browse <a class="nav" href="?browse=items">items</a> /
       <a class="nav" href="?browse=itemsets">item sets</a> /
       <a class="nav" href="?browse=npcs">NPCs</a> /
       <a class="nav" href="?browse=quests">quests</a> /
       <a class="nav" href="?browse=spells">spells</a> /
       <a class="nav" href="?browse=factions">factions</a> /
       <a class="nav" href="?browse=zones">zones</a> /
       <a class="nav" href="?dungeons">dungeons &amp; raids</a> /
       <a class="nav" href="?guides">leveling guides</a> /
       <a class="nav" href="?talents">talent calculator</a> /
       <a class="nav" href="?characters">characters</a> /
       <a class="nav" href="?weights">gear-score presets</a> /
       <a class="nav" href="?browse=objects">objects</a> /
       <a class="nav" href="?worldmap">world map</a> /
       <a class="nav" href="?flights">flight paths</a> /
       <a class="nav" href="?icons">icons</a>.
       Open directly with <code>?item=ID</code>, <code>?npc=ID</code>, <code>?quest=ID</code>, <code>?spell=ID</code>, <code>?faction=ID</code>, or <code>?zone=ID</code>.</p>
    <p class="muted">Examples:
      <a class="ilink" href="?item=2770">Copper Ore</a> ·
      <a class="ilink" href="?item=7909">Aquamarine</a> ·
      <a class="ilink" href="?npc=2376">Torn Fin Oracle</a></p>
    <p class="muted">Embedding elsewhere? Drop our
      <a class="nav-ext" href="${import.meta.env.BASE_URL}embed/tw-power.js">tooltip widget</a>
      on any page for Wowhead-style hover tooltips on links to this database —
      <a class="nav-ext" href="${import.meta.env.BASE_URL}embed/demo.html" target="_blank" rel="noopener">see the demo</a>.</p>
  </div>`;
}

async function showSearch(term) {
  document.title = `Search: ${term}`;
  app.innerHTML = `<div class="loading">Searching…</div>`;
  let res;
  try { res = await runSearch(term, 100); }
  catch (e) { app.innerHTML = errorBox(e); return; }

  const itemCols = [
    { label: "Name", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
    { label: "iLvl", num: true, cls: "muted", cell: (r) => r.item_level || "", value: (r) => r.item_level || 0 },
    { label: "Req", num: true, cls: "muted", cell: (r) => r.required_level || "", value: (r) => r.required_level || 0 },
  ];
  // exact home zone per NPC result (precomputed; same as everywhere else)
  const npcLoc = await resolveNpcLocations(res.npcs.map((n) => n.entry));
  const npcCols = [
    { label: "Name", cell: (r) => npcLink(r.entry, r.name) + (r.subname ? ` <span class="muted">&lt;${esc(r.subname)}&gt;</span>` : ""), value: (r) => r.name },
    { label: "Level", num: true, cls: "muted", cell: (r) => lvlRange(r), value: (r) => r.level_max || r.level_min || 0 },
    { label: "Rank", num: true, cls: "muted", cell: (r) => CREATURE_RANK[r.rank] || "Normal", value: (r) => r.rank || 0 },
    { label: "Location", cls: "muted", cell: (r) => (npcLoc.get(r.entry) || {}).html || "", value: (r) => (npcLoc.get(r.entry) || {}).text || "" },
  ];
  const questCols = [
    { label: "Title", cell: (r) => questLink(r.entry, r.title), value: (r) => r.title },
    { label: "Level", num: true, cls: "muted", cell: (r) => r.level || "", value: (r) => r.level || 0 },
    { label: "Zone", cls: "muted", cell: (r) => esc(questZoneLabel(r.zone, r.zone_name)), value: (r) => questZoneLabel(r.zone, r.zone_name) },
  ];
  const dungeonCols = [
    { label: "Name", cell: (r) => dungeonLink(r.id, r.name), value: (r) => r.name },
    { label: "Type", cls: "muted", cell: (r) => (r.type === 2 ? "Raid" : "Dungeon"), value: (r) => r.type },
  ];
  const objectCols = [
    { label: "Name", cell: (r) => objectLink(r.entry, r.name), value: (r) => r.name },
    { label: "Type", cls: "muted", cell: (r) => GAMEOBJECT_TYPE[r.type] || "Object", value: (r) => GAMEOBJECT_TYPE[r.type] || "Object" },
  ];
  const zoneCols = [
    { label: "Name", cell: (r) => zoneLink(r.areaid, r.name), value: (r) => r.name },
    { label: "Continent", cls: "muted", cell: (r) => CONTINENT[r.mapid] || "", value: (r) => CONTINENT[r.mapid] || "" },
  ];
  const spellCols = [
    { label: "Name", cell: (r) => spellLink(r.entry, r.name, r.icon), value: (r) => r.name },
    { label: "Profession", cls: "muted", cell: (r) => esc(PROFESSION_LABEL[r.skill] || ""), value: (r) => PROFESSION_LABEL[r.skill] || "" },
  ];
  const factionCols = [
    { label: "Name", cell: (r) => factionLink(r.id, r.name), value: (r) => r.name },
  ];
  const itemsetCols = [
    { label: "Name", cell: (r) => `<a class="ilink" href="?itemset=${r.id}">${esc(r.name)}</a>`, value: (r) => r.name },
  ];

  const itemsets = res.itemsets || [];
  const tabDefs = [
    { id: "items", label: "Items", ...regTable(itemCols, res.items, { pageSize: 100 }) },
    { id: "npcs", label: "NPCs", ...regTable(npcCols, res.npcs, { pageSize: 100 }) },
    { id: "quests", label: "Quests", ...regTable(questCols, res.quests, { pageSize: 100 }) },
    { id: "spells", label: "Spells", ...regTable(spellCols, res.spells, { pageSize: 100 }) },
    { id: "factions", label: "Factions", ...regTable(factionCols, res.factions) },
    { id: "itemsets", label: "Item Sets", ...regTable(itemsetCols, itemsets) },
    { id: "dungeons", label: "Dungeons", ...regTable(dungeonCols, res.dungeons) },
    { id: "objects", label: "Objects", ...regTable(objectCols, res.objects || []) },
    { id: "zones", label: "Zones", ...regTable(zoneCols, res.zones) },
  ];
  const total = res.items.length + res.npcs.length + res.quests.length + res.spells.length + res.factions.length + itemsets.length + res.dungeons.length + (res.objects || []).length + res.zones.length;
  if (!total) { app.innerHTML = `<div class="home"><p>No results for “${esc(term)}”.</p></div>`; return; }

  app.innerHTML = `<div class="results"><h1>Results for “${esc(term)}”</h1>${tabs(tabDefs)}</div>`;
  mountTables();
  wireTabs();
}

// Item-set panel: name (links the set page), members (current item bolded), and
// the set-bonus lines (threshold + the bonus spell's resolved description).
function renderItemSet(set, members, bonuses, currentEntry, linkName = true) {
  if (!set || !members.length) return "";
  const head = linkName ? `<a class="ilink" href="?itemset=${set.id}">${esc(set.name)}</a>` : esc(set.name);
  const mem = members.map((m) => `<div class="set-member">${m.entry === currentEntry ? `<b>${esc(m.name)}</b>` : itemLink(m.entry, m.name, m.quality, m.icon)}</div>`).join("");
  const bon = bonuses.map((b) => {
    const txt = b.description ? resolveSpellText(b.description, b) : (b.spell_name || "");
    const body = b.spell ? `<a class="ilink set-bonus-link" href="?spell=${b.spell}">${esc(txt)}</a>` : `<span class="set-bonus-link">${esc(txt)}</span>`;
    return `<div class="set-bonus"><span class="set-thr">${b.threshold} pieces:</span> ${body}</div>`;
  }).join("");
  return `<div class="panel item-set">
    <div class="set-name">${head} <span class="dim">(${members.length} pieces)</span></div>
    <div class="set-members">${mem}</div>
    ${bon}
  </div>`;
}

// Random-suffix pool for an item, grouped by suffix name with the stat range each
// rolls and the total drop chance (there's one ItemRandomProperties variant per
// exact stat roll, e.g. "of the Bear" 7/7, 7/8, 8/8 -> one "of the Bear" row).
function suffixSection(rows) {
  if (!rows || !rows.length) return "";
  const groups = new Map();
  for (const r of rows) {
    const st = JSON.parse(r.stats || "{}");
    const key = r.name || "(+stats)";
    let g = groups.get(key);
    if (!g) { g = { chance: 0, stats: {} }; groups.set(key, g); }
    g.chance += r.chance || 0;
    for (const k in st) { const c = g.stats[k] || [Infinity, -Infinity]; g.stats[k] = [Math.min(c[0], st[k]), Math.max(c[1], st[k])]; }
  }
  const lis = [...groups.entries()].sort((a, b) => b[1].chance - a[1].chance).map(([name, g]) => {
    const statStr = Object.entries(g.stats).map(([k, [mn, mx]]) => `+${mn === mx ? mn : `${mn}–${mx}`} ${esc(GEAR_STAT_LABEL[k] || k)}`).join(", ");
    return `<li><span class="suf-name">${esc(name)}</span> <span class="muted suf-stats">${statStr}</span> <span class="suf-chance muted">${g.chance.toFixed(1)}%</span></li>`;
  });
  return `<div class="item-suffixes">
    <h2>🎲 Random suffixes</h2>
    <p class="muted">This item can drop with one of these random suffixes:</p>
    <ul class="suf-list">${lis.join("")}</ul></div>`;
}

async function showItem(id) {
  app.innerHTML = `<div class="loading">Loading item ${id}…</div>`;
  let it;
  try { it = await queryOne(Q.Q_ITEM, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!it) { app.innerHTML = `<div class="home"><p>No item with ID ${id}.</p></div>`; return; }
  document.title = `${it.name} - Tortoise-WoW DB`;

  const spellIds = [1, 2, 3, 4, 5].map((i) => it[`spellid_${i}`]).filter(Boolean);
  const spellMap = new Map();
  await Promise.all(spellIds.map(async (sid) => {
    const sp = await queryOne(Q.Q_SPELL, [sid]);
    if (sp) spellMap.set(sid, sp);
  }));

  const [dropped, objects, sold, contained, contains, disen, quests, starts, createdBy, reagentFor, teaches, srcRows, gatherSpawns, sameModel] =
    await Promise.all([
      query(Q.Q_DROPPED_BY, [id]), query(Q.Q_OBJECT_SOURCE, [id]), query(Q.Q_SOLD_BY, [id]),
      query(Q.Q_CONTAINED_IN, [id]), query(Q.Q_CONTAINS, [id]), query(Q.Q_DISENCHANTS_INTO, [id]), query(Q.Q_QUEST_ITEM, [id]),
      query(Q.Q_STARTS_QUEST, [id]), query(Q.Q_CREATED_BY, [id]), query(Q.Q_REAGENT_FOR, [id]),
      query(Q.Q_TEACHES, [id]), query(Q.Q_ITEM_SOURCES, [id]), query(Q.Q_ITEM_OBJECT_SPAWNS, [id]),
      it.display_id ? query(Q.Q_SAME_MODEL, [it.display_id, id]) : Promise.resolve([]),
    ]);
  // random suffixes this item can roll ("of the Bear", …)
  const suffixes = it.rolls_suffix ? await query(Q.Q_ITEM_SUFFIXES, [id]) : [];
  const srcCsv = srcRows.map((r) => r.source).join(",");

  // item set (if this item belongs to one): shown inside the tooltip (in-game style)
  const [itemSet, setMembers, setBonuses] = it.set_id
    ? await Promise.all([queryOne(Q.Q_ITEM_SET, [it.set_id]), query(Q.Q_ITEMSET_MEMBERS, [it.set_id]), query(Q.Q_ITEMSET_BONUSES, [it.set_id])])
    : [null, [], []];
  const setOpt = itemSet ? { id: itemSet.id, name: itemSet.name, members: setMembers, bonuses: setBonuses, currentEntry: it.entry } : null;

  // Gathering breakdown: group node spawns by their precomputed home zone -> best
  // farm zones (wowhead-style list).
  let gatherRows = [];
  if (gatherSpawns.length) {
    const agg = new Map();
    for (const p of gatherSpawns) {
      const areaid = p.areaid || 0, zone = p.zone || "Unknown";
      const key = `${p.name}|${areaid}`;
      const g = agg.get(key) || { object: p.name, entry: p.entry, areaid, zone, count: 0 };
      if (p.entry && (!g.entry || p.entry < g.entry)) g.entry = p.entry; // canonical = lowest entry
      g.count++; agg.set(key, g);
    }
    gatherRows = [...agg.values()].sort((a, b) => b.count - a.count);
  }
  // Merge the object drop-chance (Q_OBJECT_SOURCE) onto each gather row, and fold in
  // objects that yield the item but have no recorded spawn (one row, blank zone) ->
  // a single "Found in object" tab covering both gathering nodes and chests.
  {
    const chanceByName = new Map(objects.map((o) => [o.name, o.chance]));
    for (const g of gatherRows) g.chance = chanceByName.get(g.object) ?? null;
    const gathered = new Set(gatherRows.map((g) => g.object));
    for (const o of objects) {
      if (!gathered.has(o.name)) gatherRows.push({ object: o.name, entry: o.entry, areaid: 0, zone: "", count: 0, chance: o.chance });
    }
  }

  // where each dropping NPC lives (zone or dungeon), batched
  const dropLoc = await resolveNpcLocations(dropped.map((d) => d.entry));
  const dchance = (d) => d.drop_chance ?? d.skin_chance ?? d.pick_chance;
  const srcTag = (d) => (d.skin_chance != null ? ' <span class="muted">(skin)</span>' : d.pick_chance != null ? ' <span class="muted">(pickpocket)</span>' : "");
  const droppedCols = [
    { label: "NPC", cell: (d) => npcLink(d.entry, d.name) + srcTag(d), value: (d) => d.name },
    { label: "Level", num: true, cls: "muted", cell: (d) => lvlRange(d), value: (d) => d.level_max || d.level_min || 0 },
    { label: "Location", cls: "muted", cell: (d) => (dropLoc.get(d.entry) || {}).html || "", value: (d) => (dropLoc.get(d.entry) || {}).text || "" },
    { label: "Chance", num: true, cell: (d) => pct(dchance(d)), value: (d) => dchance(d) || 0 },
  ];
  // Found-in-object: one row per object × zone (grouped by object) with the spawn
  // count + drop chance. Replaces the old separate "Found in object" + "Gathered in".
  const gatherCols = [
    { label: "Object", cell: (r) => (r.entry ? objectLink(r.entry, r.object) : esc(r.object)), value: (r) => r.object },
    // zone link carries &gather=<item> so the zone map opens focused on this node
    { label: "Zone", cell: (r) => (r.areaid ? `<a class="ilink zone" href="?zone=${r.areaid}&gather=${id}">${esc(r.zone)}</a>` : esc(r.zone)), value: (r) => r.zone },
    { label: "Spawns", num: true, cls: "muted", cell: (r) => r.count || "", value: (r) => r.count },
    { label: "Chance", num: true, cell: (r) => (r.chance != null ? pct(r.chance) : ""), value: (r) => r.chance || 0 },
  ];
  const soldCols = [
    { label: "Vendor", cell: (s) => npcLink(s.entry, s.name), value: (s) => s.name },
    { label: "Level", num: true, cls: "muted", cell: (s) => lvlRange(s), value: (s) => s.level_max || s.level_min || 0 },
    { label: "Stock", num: true, cls: "muted", cell: (s) => (s.maxcount > 0 ? s.maxcount : "∞"), value: (s) => (s.maxcount > 0 ? s.maxcount : Infinity) },
  ];
  const itemChanceCols = [
    { label: "Item", cell: (c) => itemLink(c.entry, c.name, c.quality, c.icon), value: (c) => c.name },
    { label: "Chance", num: true, cell: (c) => pct(c.chance), value: (c) => c.chance || 0 },
  ];
  const disenCols = [
    { label: "Item", cell: (d) => itemLink(d.entry, d.name, d.quality, d.icon), value: (d) => d.name },
    { label: "Chance", num: true, cell: (d) => pct(d.chance), value: (d) => d.chance || 0 },
  ];
  const questCols = (showQty, showChoice) => [
    { label: "Quest", cell: (q) => questLink(q.entry, q.title) + (showChoice && q.role === "choice" ? ' <span class="muted">(choice)</span>' : ""), value: (q) => q.title },
    { label: "Level", num: true, cls: "muted", cell: (q) => q.level || "", value: (q) => q.level || 0 },
    { label: "Req Lvl", num: true, cls: "muted", cell: (q) => q.minlevel || "", value: (q) => q.minlevel || 0 },
    { label: "Faction", cell: (q) => { const f = questFaction(q.reqraces); return `<span class="tagx fac-${f.toLowerCase()}">${f}</span>`; }, value: (q) => questFaction(q.reqraces) },
    ...(showQty ? [{ label: "Qty", num: true, cls: "muted", cell: (q) => q.count, value: (q) => q.count || 0 }] : []),
  ];
  const reagentForCols = [
    { label: "Creates", cell: (r) => itemLink(r.created, r.created_name, r.quality, r.created_icon), value: (r) => r.created_name },
    { label: "Via spell", cls: "muted", cell: (r) => spellLink(r.spell, r.spell_name, r.spell_icon), value: (r) => r.spell_name },
  ];
  // recipe/pattern/plans -> the item it teaches you to craft
  // orange/required skill (when you can first craft) = learn_req, falling back to
  // the spell's req then the trivial yellow. NOT skill_min alone -- that's the
  // yellow trivial level and can exceed the 300 cap (e.g. a 300-recipe at 320).
  const orangeSkill = (t) => t.learn_req || t.skill_req || t.skill_min || 0;
  const teachesCols = [
    { label: "Teaches", cell: (t) => itemLink(t.item, t.item_name, t.quality, t.item_icon), value: (t) => t.item_name },
    { label: "Profession", cls: "muted", cell: (t) => esc(PROFESSION_LABEL[t.skill] || ""), value: (t) => PROFESSION_LABEL[t.skill] || "" },
    { label: "Skill", num: true, cls: "muted", cell: (t) => orangeSkill(t) || "", value: (t) => orangeSkill(t) },
  ];

  // created-by: group reagents per spell
  const bySpell = new Map();
  for (const r of createdBy) {
    if (!bySpell.has(r.entry)) bySpell.set(r.entry, {
      entry: r.entry, name: r.name, icon: r.spell_icon, skill: r.skill, req: r.skill_req,
      recipe_item: r.recipe_item, recipe_name: r.recipe_name, recipe_quality: r.recipe_quality, recipe_icon: r.recipe_icon,
      trainer: r.trainer, auto: r.auto, reagents: [],
    });
    if (r.reagent_item) bySpell.get(r.entry).reagents.push(`${itemLink(r.reagent_item, r.reagent_name, r.reagent_quality, r.reagent_icon)} ×${r.count || 1}`);
  }
  const createdRows = [...bySpell.values()];
  const profOf = (s) => PROFESSION_LABEL[s.skill] || "";
  const createdCols = [
    { label: "Spell", cell: (s) => spellLink(s.entry, s.name, s.icon), value: (s) => s.name },
    // profession links to the crafting browse filtered to that profession
    { label: "Profession", cls: "muted", cell: (s) => (profOf(s) ? `<a class="nav" href="?browse=crafting&prof=${s.skill}">${esc(profOf(s))}</a>` + (s.req > 1 ? ` <span class="dim">(${s.req})</span>` : "") : ""), value: (s) => profOf(s) },
    { label: "Reagents", cls: "muted", cell: (s) => s.reagents.join(", "), value: (s) => s.reagents.length },
    // how the craft is learned: the recipe/pattern item, or Trainer / Auto
    { label: "Source", cls: "muted", cell: (s) => (s.recipe_item ? itemLink(s.recipe_item, s.recipe_name, s.recipe_quality, s.recipe_icon)
      : s.trainer ? `<span class="tagx src-crafted">Trainer</span>`
        : s.auto ? `<span class="tagx" title="Learned automatically with the profession">Auto</span>` : "—"),
      value: (s) => (s.recipe_item ? s.recipe_name || "Recipe" : s.trainer ? "Trainer" : s.auto ? "Auto" : "") },
  ];

  // items sharing this one's display_id (same model / appearance)
  const sameModelCols = [
    { label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
    { label: "Slot", cls: "muted", cell: (r) => INV_TYPE[r.inventory_type] || "", value: (r) => INV_TYPE[r.inventory_type] || "" },
    { label: "iLvl", num: true, cls: "muted", cell: (r) => r.item_level || "", value: (r) => r.item_level || 0 },
    { label: "Req Lvl", num: true, cls: "muted", cell: (r) => r.required_level || "", value: (r) => r.required_level || 0 },
  ];

  const reqQuests = quests.filter((q) => q.role === "req");
  const rewQuests = quests.filter((q) => q.role !== "req");

  // For a world-drop item, split its droppers: the meaningful drops (>=1%) stay
  // under "Dropped by"; the long world-drop-tier tail (<1%) moves to "World drop from".
  const droppedMain = it.world_drop ? dropped.filter((d) => (dchance(d) || 0) >= 1) : dropped;
  const droppedWorld = it.world_drop ? dropped.filter((d) => (dchance(d) || 0) < 1) : [];

  const tabDefs = [
    { id: "dropped", label: "Dropped by", ...regTable(droppedCols, droppedMain, { groupable: true }) },
    { id: "worlddrop", label: "World drop from", ...regTable(droppedCols, droppedWorld, { groupable: true }) },
    { id: "object", label: "Found in object", ...regTable(gatherCols, gatherRows, { pageSize: 200, groupable: true, group: 0, sort: "Spawns", dir: "d" }) },
    { id: "sold", label: "Sold by", ...regTable(soldCols, sold) },
    { id: "teaches", label: "Teaches", ...regTable(teachesCols, teaches) },
    { id: "contains", label: "Contains", ...regTable(itemChanceCols, contains) },
    { id: "contained", label: "Contained in", ...regTable(itemChanceCols, contained) },
    { id: "disen", label: "Disenchants into", ...regTable(disenCols, disen) },
    { id: "reward", label: "Reward from quest", ...regTable(questCols(false, true), rewQuests) },
    { id: "reqquest", label: "Required for quest", ...regTable(questCols(true, false), reqQuests) },
    { id: "starts", label: "Starts quest", ...regTable(questCols(false, false), starts) },
    { id: "created", label: "Created by", ...regTable(createdCols, createdRows) },
    { id: "reagent", label: "Reagent for", ...regTable(reagentForCols, reagentFor.filter((r) => r.created)) },
    { id: "samemodel", label: "Same model", ...regTable(sameModelCols, sameModel) },
  ];

  app.innerHTML =
    `<div class="item-view">
      <div class="item-main">${renderTooltip(it, { spellMap, linkSpells: true, set: setOpt })}
        <div class="item-meta muted">Item #${it.entry} · iLvl ${it.item_level || "—"}${it.world_drop ? ' · <span class="tagx">World Drop</span>' : ""}${it.rolls_suffix ? ' · <span class="tagx" title="Can drop with a random suffix">🎲 Random suffix</span>' : ""}</div>
        ${srcCsv ? `<div class="item-sources">${sourceTags(srcCsv)}</div>` : ""}
        ${suffixSection(suffixes)}
      </div>
      <div class="item-rel">${tabs(tabDefs)}</div>
    </div>`;
  mountTables();
  wireTabs();
}

// ---- random page (surprise-me) ----
// Rolls a random entity kind, then a random row, and replaces the URL with its
// page so Back returns to wherever the user was (not a loop of ?random).
async function showRandom() {
  app.innerHTML = `<div class="loading">Rolling the dice…</div>`;
  const picks = [
    [Q.Q_RANDOM_ITEM, (r) => `?item=${r.entry}`],
    [Q.Q_RANDOM_NPC, (r) => `?npc=${r.entry}`],
    [Q.Q_RANDOM_QUEST, (r) => `?quest=${r.entry}`],
  ];
  const [q, to] = picks[Math.floor(Math.random() * picks.length)];
  let row;
  try { row = await queryOne(q, []); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (row && row.entry) navigate(to(row), true);
  else return showHome();
}

// ---- item comparison (?compare=a:b:c) ----
// Side-by-side tooltips + a stat-delta table. Ids are colon-separated item entries;
// both the browse "Compare" button and the item-page compare tray build this URL.
async function showCompare(spec) {
  const ids = [...new Set(String(spec).split(":").map(Number).filter(Boolean))].slice(0, 8);
  document.title = "Compare items - Tortoise-WoW DB";
  if (ids.length < 2) {
    app.innerHTML = `<div class="home"><h1>Compare items</h1><p class="muted">Add two or more items to compare. Use the <b>Compare</b> button when selecting rows in <a class="nav" href="?browse=items">Browse Items</a>, or the ⚖ button on any item page.</p></div>`;
    return;
  }
  app.innerHTML = `<div class="loading">Loading comparison…</div>`;
  let its;
  try { its = await Promise.all(ids.map((id) => queryOne(Q.Q_ITEM, [id]))); }
  catch (e) { app.innerHTML = errorBox(e); return; }
  const items = ids.map((id, i) => its[i]).filter(Boolean);
  if (items.length < 2) { app.innerHTML = `<div class="home"><p>Need at least two valid items to compare.</p></div>`; return; }

  // per-item spell maps (equip/use effects in the tooltip) + derived gear stats
  const [spellMaps, statRowsAll] = await Promise.all([
    Promise.all(items.map(async (it) => {
      const m = new Map();
      const sids = [1, 2, 3, 4, 5].map((i) => it[`spellid_${i}`]).filter(Boolean);
      await Promise.all(sids.map(async (sid) => { const sp = await queryOne(Q.Q_SPELL, [sid]); if (sp) m.set(sid, sp); }));
      return m;
    })),
    Promise.all(items.map((it) => query(Q.Q_ITEM_STATS, [it.entry]))),
  ]);
  const statMaps = statRowsAll.map((rows) => { const m = {}; for (const r of rows) m[r.stat] = r.value; return m; });

  // union of stat keys, rendered in GEAR_CRITERIA display order
  const present = new Set();
  statMaps.forEach((m) => Object.keys(m).forEach((k) => present.add(k)));
  const orderedKeys = GEAR_CRITERIA.flatMap((g) => g.options.map(([k]) => k)).filter((k) => present.has(k));

  const rmUrl = (entry) => { const rest = ids.filter((x) => x !== entry); return rest.length >= 2 ? `?compare=${rest.join(":")}` : `?item=${rest[0] || entry}`; };
  const cards = items.map((it, i) => `
    <div class="cmp-col">
      <div class="cmp-card">${renderTooltip(it, { spellMap: spellMaps[i], linkSpells: true })}</div>
      <div class="cmp-links muted"><a class="ilink" href="?item=${it.entry}">Open page</a>${items.length > 2 ? ` · <a class="nav" href="${rmUrl(it.entry)}">Remove</a>` : ""}</div>
    </div>`).join("");

  // stat-delta table: one column per item, best value per row highlighted. Higher is
  // better for every gear stat and iLvl; lower is better for the required level.
  const cell = (v, best) => v == null ? '<td class="muted">—</td>' : `<td class="${v === best ? "cmp-best" : ""}">${v}</td>`;
  const numRow = (label, vals, lowerBetter = false) => {
    const nums = vals.filter((v) => v != null);
    const best = nums.length ? (lowerBetter ? Math.min(...nums) : Math.max(...nums)) : null;
    return `<tr><th>${label}</th>${vals.map((v) => cell(v, best)).join("")}</tr>`;
  };
  const statTable = `<table class="cmp-table">
    <thead><tr><th></th>${items.map((it) => `<th>${itemLink(it.entry, it.name, it.quality, it.icon)}</th>`).join("")}</tr></thead>
    <tbody>
      ${numRow("Item Level", items.map((it) => it.item_level || null))}
      ${numRow("Required Level", items.map((it) => it.required_level || null), true)}
      ${orderedKeys.map((k) => numRow(GEAR_STAT_LABEL[k], statMaps.map((m) => m[k] ?? null))).join("")}
    </tbody></table>`;

  app.innerHTML = `<div class="compare-view">
    <h1>Compare items</h1>
    <div class="cmp-cards">${cards}</div>
    <h2>Stat comparison</h2>${statTable}
  </div>`;
}

// Stat-summary table for a set: rows = stats, columns = Total + each member; the
// highest contributor per stat is highlighted (wowhead-style). Sortable by header
// (member columns sort the stats by that member's contribution) via createTable.
function setSummary(members, statRows) {
  if (!members.length || !statRows.length) return "";
  const byItem = new Map();
  for (const r of statRows) { let m = byItem.get(r.item); if (!m) { m = new Map(); byItem.set(r.item, m); } m.set(r.stat, (m.get(r.stat) || 0) + r.value); }
  const present = Object.keys(GEAR_STAT_LABEL).filter((k) => members.some((m) => (byItem.get(m.entry) || new Map()).get(k)));
  if (!present.length) return "";
  const rows = present.map((k) => {
    const v = {}; let total = 0, max = 0;
    for (const m of members) { const val = (byItem.get(m.entry) || new Map()).get(k) || 0; v[m.entry] = val; total += val; if (val > max) max = val; }
    return { stat: GEAR_STAT_LABEL[k], total, max, v };
  });
  const cols = [
    { key: "stat", label: "Stat", cell: (r) => esc(r.stat), value: (r) => r.stat },
    { key: "total", label: "Total", num: true, cls: "total", cell: (r) => r.total.toLocaleString(), value: (r) => r.total },
    ...members.map((m) => ({
      key: `m${m.entry}`, label: m.name, labelHtml: `<span title="${esc(m.name)}">${iconImg(m.icon)}</span>`, num: true,
      cell: (r) => { const val = r.v[m.entry]; return val ? (val === r.max ? `<span class="best">${val.toLocaleString()}</span>` : val.toLocaleString()) : ""; },
      value: (r) => r.v[m.entry] || 0,
    })),
  ];
  return `<h2>Summary</h2><div class="set-summary">${regTable(cols, rows).html}</div>`;
}

async function showItemSet(id) {
  app.innerHTML = `<div class="loading">Loading set ${id}…</div>`;
  let set;
  try { set = await queryOne(Q.Q_ITEM_SET, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!set) { app.innerHTML = `<div class="home"><p>No item set with ID ${id}.</p></div>`; return; }
  document.title = `${set.name} - Tortoise-WoW DB`;
  const [members, bonuses, statRows] = await Promise.all([
    query(Q.Q_ITEMSET_MEMBERS, [id]), query(Q.Q_ITEMSET_BONUSES, [id]), query(Q.Q_ITEMSET_STATS, [id]),
  ]);
  app.innerHTML = `<div class="results item-set-page"><h1>${esc(set.name)}</h1>${renderItemSet(set, members, bonuses, null, false)}${setSummary(members, statRows)}</div>`;
  mountTables();
}

async function showSpell(id) {
  app.innerHTML = `<div class="loading">Loading spell ${id}…</div>`;
  let sp;
  try { sp = await queryOne(Q.Q_SPELL, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!sp) { app.innerHTML = `<div class="home"><p>No spell with ID ${id}.</p></div>`; return; }
  document.title = `${sp.name} - Tortoise-WoW DB`;

  const [produces, reagents, usedBy, source, trainers, books, rewardQuests] = await Promise.all([
    query(Q.Q_SPELL_PRODUCES, [id]), query(Q.Q_SPELL_REAGENTS, [id]),
    query(Q.Q_SPELL_USED_BY, [id]), queryOne(Q.Q_SPELL_SOURCE, [id]),
    query(Q.Q_SPELL_TRAINERS, [id]), query(Q.Q_SPELL_BOOKS, [id]),
    query(Q.Q_SPELL_REWARD_QUESTS, [id]),
  ]);

  const prof = PROFESSION_LABEL[sp.skill] || "";

  // "Learned from": the recipe/pattern/plans item, or Trainer / Auto -- mirrors
  // the item-page "Source" cell so a recipe-taught craft links to its item.
  let learned = "";
  if (source) {
    if (source.recipe_item) learned = itemLink(source.recipe_item, source.recipe_name, source.recipe_quality, source.recipe_icon);
    else if (source.trainer) learned = `<span class="tagx src-crafted">Trainer</span>`;
    else if (source.auto) learned = `<span class="tagx" title="Learned automatically with the profession">Auto</span>`;
  }

  // Resolve a location per trainer NPC (largest WMA box containing one of its
  // spawns -- same heuristic as the NPC search/detail Location column).
  const trainerZone = new Map();
  if (trainers.length) {
    const ids = trainers.map((n) => n.entry);
    const ph = ids.map(() => "?").join(",");
    const rows = await query(`SELECT entry, areaid, name FROM (
        SELECT s.id AS entry, z.areaid, z.name,
          ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY (z.loctop - z.locbottom) * (z.locleft - z.locright) DESC) AS rn
        FROM spawn_points s INDEXED BY idx_spawn_id
        JOIN zones z ON z.mapid = s.map AND s.x BETWEEN z.locbottom AND z.loctop AND s.y BETWEEN z.locright AND z.locleft
        WHERE s.kind = 'c' AND s.id IN (${ph}) AND z.name <> ''
      ) WHERE rn = 1`, ids);
    for (const r of rows) trainerZone.set(r.entry, r);
  }

  // ---- formatters (wowhead-style values) ----
  const secs = (ms) => { const v = ms / 1000; return `${Number.isInteger(v) ? v : v.toFixed(v < 1 ? 2 : 1)} ${v === 1 ? "second" : "seconds"}`; };
  const castStr = sp.channeled ? "Channeled" : (sp.cast_ms ? secs(sp.cast_ms) : "Instant");
  const costStr = spellCost(sp);
  // range_max 0 = self-cast; show "Self" rather than a pointless "0 yards"
  const rangeStr = sp.range_max ? `${sp.range_min ? `${sp.range_min}-` : ""}${sp.range_max} yards${sp.range_name ? ` (${sp.range_name})` : ""}` : (sp.range_max === 0 ? "Self" : "n/a");

  // ---- "Details on spell" key/value grid ----
  const grid = [
    ["Cost", costStr || "None"],
    ["Duration", sp.duration_ms ? secs(sp.duration_ms) : "n/a"],
    ["Range", rangeStr],
    ["School", SPELL_SCHOOL[sp.school] || "n/a"],
    ["Cast time", castStr],
    ["Mechanic", SPELL_MECHANIC[sp.mechanic] || (sp.mechanic ? `#${sp.mechanic}` : "n/a")],
    ["Cooldown", sp.cooldown_ms ? secs(sp.cooldown_ms) : "n/a"],
    ["Category Cooldown", sp.cat_cooldown_ms ? secs(sp.cat_cooldown_ms) : "n/a"],
    ["Dispel type", SPELL_DISPEL[sp.dispel] || "n/a"],
    ["GCD", sp.gcd_ms ? secs(sp.gcd_ms) : "n/a"],
  ];
  if (sp.proc_chance && sp.proc_chance < 100) grid.push(["Proc chance", `${sp.proc_chance}%`]);
  const gridHtml = grid.map(([k, v]) => `<div class="kv-k">${esc(k)}</div><div class="kv-v">${esc(String(v))}</div>`).join("");

  // ---- per-effect breakdown ----
  let effList = [];
  try { effList = sp.effects ? JSON.parse(sp.effects) : []; } catch { /* ignore */ }
  // effectMiscValue references a creature for these types (Summon / Summon Pet /
  // Mounted / Transform) -> render it as an NPC link (e.g. Mounted -> the mount).
  const CREATURE_EFFECT = new Set([28, 56]);   // SUMMON, SUMMON_PET
  const CREATURE_AURA = new Set([78, 56]);     // MOUNTED, TRANSFORM
  const miscIsCreature = (ef) => ef.misc > 0 && (CREATURE_EFFECT.has(ef.effect) || (ef.effect === 6 && CREATURE_AURA.has(ef.aura)));
  const miscIds = [...new Set(effList.filter(miscIsCreature).map((ef) => ef.misc))];
  const miscName = new Map();
  if (miscIds.length) {
    for (const r of await query(`SELECT entry, name FROM creatures WHERE entry IN (${miscIds.map(() => "?").join(",")})`, miscIds)) miscName.set(r.entry, r.name);
  }
  const effHtml = effList.map((ef) => {
    const head = `(${ef.effect}) ${SPELL_EFFECT[ef.effect] || `Effect #${ef.effect}`}` +
      (ef.aura ? `: ${SPELL_AURA[ef.aura] || `Aura #${ef.aura}`}` : "");
    const miscLink = miscIsCreature(ef) ? ` ${npcLink(ef.misc, miscName.get(ef.misc) || `NPC #${ef.misc}`)}` : "";
    const lines = [];
    if (ef.value) lines.push(`Value: ${ef.value}${ef.die > 1 ? ` to ${ef.value + ef.die - 1}` : ""}`);
    if (ef.radius) lines.push(`Radius: ${ef.radius} yards`);
    if (ef.period) lines.push(`Interval: ${secs(ef.period)}`);
    return `<div class="spell-effect"><div class="eff-head">Effect #${ef.i}: ${esc(head)}${miscLink}</div>` +
      `${lines.length ? `<div class="eff-body muted">${lines.map(esc).join("<br>")}</div>` : ""}</div>`;
  }).join("");

  // ---- decoded attribute flags (recognized bits only) ----
  const flags = [...new Set(SPELL_FLAGS
    .filter(([f, bit]) => ((f === "a" ? sp.attr : sp.attr_ex) || 0) & bit)
    .map(([, , name]) => name))];
  const flagsHtml = flags.length
    ? `<div class="spell-flags"><span class="kv-k">Flags</span> <span class="muted">${flags.map(esc).join(", ")}</span></div>` : "";

  const producesCols = [
    { label: "Creates", cell: (r) => itemLink(r.item, r.item_name, r.quality, r.item_icon), value: (r) => r.item_name },
    { label: "Skill", num: true, cls: "muted", cell: (r) => r.skill_req || r.skill_min || "", value: (r) => r.skill_req || r.skill_min || 0 },
  ];
  const reagentCols = [
    { label: "Reagent", cell: (r) => itemLink(r.item, r.item_name, r.quality, r.item_icon), value: (r) => r.item_name },
    { label: "Qty", num: true, cls: "muted", cell: (r) => (r.count > 1 ? r.count : ""), value: (r) => r.count || 0 },
  ];
  const usedByCols = [
    { label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
  ];
  const trainerCols = [
    { label: "Trainer", cell: (r) => npcLink(r.entry, r.name), value: (r) => r.name },
    { label: "Faction", cls: "muted", cell: (r) => teamBadge(r.team), value: (r) => teamLabel(r.team) },
    { label: "Level", num: true, cls: "muted", cell: (r) => lvlRange(r), value: (r) => r.level_max || r.level_min || 0 },
    { label: "Location", cls: "muted", cell: (r) => { const z = trainerZone.get(r.entry); return z ? zoneLink(z.areaid, z.name) : ""; }, value: (r) => trainerZone.get(r.entry)?.name || "" },
  ];
  const bookCols = [
    { label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
  ];
  const rewQuestCols = [
    { label: "Quest", cell: (r) => questLink(r.entry, r.title), value: (r) => r.title },
    { label: "Level", num: true, cls: "muted", cell: (r) => r.level || "", value: (r) => r.level || 0 },
  ];

  const tabDefs = [
    { id: "produces", label: "Creates", ...regTable(producesCols, produces) },
    { id: "reagents", label: "Reagents", ...regTable(reagentCols, reagents) },
    { id: "trained", label: "Trained by", ...regTable(trainerCols, trainers) },
    { id: "books", label: "Taught by item", ...regTable(bookCols, books) },
    { id: "rewquest", label: "Reward from quest", ...regTable(rewQuestCols, rewardQuests) },
    { id: "usedby", label: "Used by items", ...regTable(usedByCols, usedBy) },
  ];
  const hasTabs = tabDefs.some((t) => t.count > 0);

  // The spell tooltip card IS the header (in-game look, like the item page) -- no
  // separate h1, so the icon+name aren't drawn twice. A small meta line sits below.
  const card = spellTooltip(sp);
  const meta = [`Spell #${sp.entry}`];
  if (sp.spell_level) meta.push(`Level ${sp.spell_level}`);
  if (prof) meta.push(`<a class="nav" href="?browse=crafting&prof=${sp.skill}">${esc(prof)}</a>`);
  if (sp.learnable) {
    const srcs = [];
    if (trainers.length) srcs.push("Trainer");
    if (books.length) srcs.push("Book");
    if (rewardQuests.length) srcs.push("Quest");
    meta.push(`<span class="tagx" title="A player can learn this spell">Learnable${srcs.length ? ` · ${srcs.join(" / ")}` : ""}</span>`);
  }
  if (learned) meta.push(`Learned from: ${learned}`);

  app.innerHTML =
    `<div class="npc-page spell-page">
      ${card}
      <div class="npc-meta muted spell-sub">${meta.join('<span class="dim"> · </span>')}</div>
      <div class="panel spell-details">
        <h3>Details on spell</h3>
        <div class="kv-grid">${gridHtml}</div>
        ${effHtml}
        ${flagsHtml}
      </div>
      ${hasTabs ? tabs(tabDefs) : ""}
    </div>`;
  mountTables();
  wireTabs();
}

// Render a zone link with an optional Dungeon/Raid tag from its map type.
function zoneCellHtml(areaid, name, mapType) {
  const tag = mapType === 2 ? "Raid" : mapType === 1 ? "Dungeon" : null;
  return zoneLink(areaid, name) + (tag ? ` <span class="dim">(${tag})</span>` : "");
}

// Batch-resolve a set of creature ('c') / object ('o') entries to { html, text }
// location cells using each spawn's precomputed home zone (exact, from build-db).
// Picks the zone holding the most of the entry's spawns. Used by the quest
// giver/ender/chain tabs and the item / required-item drop tabs.
async function resolveNpcLocations(entries, kind = "c") {
  const out = new Map();
  const uniq = [...new Set(entries)].filter(Boolean);
  if (!uniq.length) return out;
  const rows = await query(Q.qNpcZoneSpawns(uniq.length, kind), uniq);
  const byEntry = new Map();
  for (const r of rows) {
    let m = byEntry.get(r.entry); if (!m) { m = new Map(); byEntry.set(r.entry, m); }
    const e = m.get(r.areaid) || { ...r, n: 0 }; e.n++; m.set(r.areaid, e);
  }
  for (const [entry, m] of byEntry) {
    let best = null; for (const e of m.values()) if (!best || e.n > best.n) best = e;
    out.set(entry, { html: zoneCellHtml(best.areaid, best.name, best.type), text: best.name });
  }
  return out;
}

async function showNpc(id) {
  app.innerHTML = `<div class="loading">Loading NPC ${id}…</div>`;
  let npc;
  try { npc = await queryOne(Q.Q_NPC, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!npc) { app.innerHTML = `<div class="home"><p>No NPC with ID ${id}.</p></div>`; return; }
  document.title = `${npc.name} - Tortoise-WoW DB`;

  const [loot, skin, pick, sells, starts, ends, objectiveOf, maps, trains, npcSpawns, npcFaction] = await Promise.all([
    query(Q.Q_NPC_LOOT, [id]), query(Q.Q_NPC_SKIN, [id]), query(Q.Q_NPC_PICK, [id]),
    query(Q.Q_NPC_SELLS, [id]), query(Q.Q_NPC_STARTS, [id]), query(Q.Q_NPC_ENDS, [id]),
    query(Q.Q_NPC_OBJECTIVE_OF, [id]), query(Q.Q_NPC_MAPS, [id]),
    query(Q.Q_NPC_TRAINS, [id]), query(Q.Q_NPC_SPAWNS, [id]), queryOne(Q.Q_NPC_FACTION, [id]),
  ]);
  // Each spawn carries its exact precomputed home zone (build-db, ADT-derived).
  // Count per zone (and per map) -> the most-common zone is the one the map renders;
  // the Location label names the top zone for each continent map.
  const zoneCount = new Map();   // areaid -> count
  const byMapZone = new Map();   // map -> Map(areaid -> count)
  for (const s of npcSpawns) {
    if (!s.zone) continue;
    zoneCount.set(s.zone, (zoneCount.get(s.zone) || 0) + 1);
    let mm = byMapZone.get(s.map); if (!mm) { mm = new Map(); byMapZone.set(s.map, mm); }
    mm.set(s.zone, (mm.get(s.zone) || 0) + 1);
  }
  const zoneIds = [...zoneCount.keys()];
  const zinfo = new Map();
  if (zoneIds.length) for (const z of await query(Q.qZonesByIds(zoneIds.length), zoneIds)) zinfo.set(z.areaid, z);
  let mapZone = null, top = -1;
  for (const [aid, n] of zoneCount) if (n > top && zinfo.get(aid)) { top = n; mapZone = zinfo.get(aid); }
  // ?fz=<areaid> (focus zone, e.g. from the zone Farming tab) opens the map on that
  // zone instead of the busiest one, when the NPC actually spawns there.
  const fz = Number(new URLSearchParams(location.search).get("fz")) || 0;
  if (fz && zinfo.get(fz)) mapZone = zinfo.get(fz);
  const mapPts = mapZone ? npcSpawns.filter((s) => s.zone === mapZone.areaid) : [];
  // Spawn-less NPCs (script/pool/event-placed bosses, e.g. Kilrogg Deadeye) carry no
  // static coordinates. Fall back to the zone of the quests they give / turn in, so
  // the page still names + maps the zone (no pins -- no exact coords exist).
  let questZone = null;
  if (!mapZone && !npcSpawns.length && (starts.length || ends.length)) {
    const qz = await query(Q.Q_NPC_QUEST_ZONES, [id]);
    if (qz.length) questZone = qz[0];
  }
  const bestZoneForMap = (mid) => {
    const mm = byMapZone.get(mid); if (!mm) return null;
    let a = null, n = -1; for (const [aid, c] of mm) if (c > n && zinfo.get(aid)) { n = c; a = aid; }
    return a ? zinfo.get(a) : null;
  };
  const mapHtml = maps.map((m) => {
    const tag = m.type === 2 ? "Raid" : m.type === 1 ? "Dungeon" : null;
    if (tag) return `${dungeonLink(m.id, m.name)} <span class="dim">(${tag})</span>`;
    // continent: append the resolved zone link -> "Kalimdor › The Barrens"
    const z = bestZoneForMap(m.id);
    return `${esc(m.name)}${z ? ` <span class="dim">›</span> ${zoneLink(z.areaid, z.name)}` : ""}`;
  }).join(", ");

  const lvl = lvlRange(npc) || "??";
  const bits = [`Level ${lvl}`];
  if (CREATURE_RANK[npc.rank]) bits.push(CREATURE_RANK[npc.rank]);
  if (CREATURE_TYPE[npc.type]) bits.push(`<a class="nav" href="?browse=npcs&type=${npc.type}">${CREATURE_TYPE[npc.type]}</a>`);
  if (npcFaction) bits.push(npcFaction.has_page ? factionLink(npcFaction.id, npcFaction.name) : esc(npcFaction.name));
  const hp = npc.health_max ? `${npc.health_min}–${npc.health_max} HP` : "";
  const roles = npcRoles(npc.npc_flags);
  const rankClass = npc.rank === 3 ? "npc-boss" : (npc.rank === 2 || npc.rank === 4) ? "npc-rare" : npc.rank === 1 ? "npc-elite" : "";

  const lootCols = [
    { label: "Item", cell: (d) => itemLink(d.entry, d.name, d.quality, d.icon), value: (d) => d.name },
    { label: "Chance", num: true, cell: (d) => pct(d.chance), value: (d) => d.chance || 0 },
  ];
  const sellCols = [
    { label: "Item", cell: (s) => itemLink(s.entry, s.name, s.quality, s.icon), value: (s) => s.name },
    { label: "Stock", num: true, cls: "muted", cell: (s) => (s.maxcount > 0 ? s.maxcount : "∞"), value: (s) => (s.maxcount > 0 ? s.maxcount : Infinity) },
  ];
  const questCols = [
    { label: "Quest", cell: (q) => questLink(q.entry, q.title), value: (q) => q.title },
    { label: "Level", num: true, cls: "muted", cell: (q) => q.level || "", value: (q) => q.level || 0 },
  ];
  const objectiveCols = [
    { label: "Quest", cell: (q) => questLink(q.entry, q.title), value: (q) => q.title },
    { label: "Level", num: true, cls: "muted", cell: (q) => q.level || "", value: (q) => q.level || 0 },
    { label: "Needed", num: true, cls: "muted", cell: (q) => (q.count > 1 ? q.count : ""), value: (q) => q.count || 0 },
  ];
  const rankNum = (r) => { const m = (r.rank || "").match(/\d+/); return m ? +m[0] : 0; };
  const teachesCols = [
    { label: "Spell", cell: (r) => spellLink(r.entry, r.name, r.icon), value: (r) => r.name },
    { label: "Rank", num: true, cls: "muted", cell: (r) => esc(r.rank || ""), value: rankNum },
    { label: "Profession", cls: "muted", hideUniform: true, cell: (r) => esc(PROFESSION_LABEL[r.skill] || ""), value: (r) => PROFESSION_LABEL[r.skill] || "" },
    { label: "Level", num: true, cls: "muted", hideEmpty: true, cell: (r) => r.spell_level || "", value: (r) => r.spell_level || 0 },
  ];

  // World drops (ubiquitous greens/gems/cloth dropped at world-drop-tier low rates)
  // go to their own tab so they don't bury the creature's characteristic loot. A
  // world-drop item dropped at a notable rate (a real drop) stays under "Drops".
  const isWorldDrop = (d) => d.world_drop && d.chance < 1;
  const drops = loot.filter((d) => !isWorldDrop(d));
  const worldDrops = loot.filter(isWorldDrop);
  const tabDefs = [
    { id: "teaches", label: "Teaches", ...regTable(teachesCols, trains) },
    { id: "drops", label: "Drops", ...regTable(lootCols, drops) },
    { id: "worlddrops", label: "World Drops", ...regTable(lootCols, worldDrops) },
    { id: "skinning", label: "Skinning", ...regTable(lootCols, skin) },
    { id: "pickpocketing", label: "Pickpocketing", ...regTable(lootCols, pick) },
    { id: "sells", label: "Sells", ...regTable(sellCols, sells) },
    { id: "starts", label: "Starts quests", ...regTable(questCols, starts) },
    { id: "ends", label: "Ends quests", ...regTable(questCols, ends) },
    { id: "objective", label: "Objective of", ...regTable(objectiveCols, objectiveOf) },
  ];

  // No map -> explain why instead of leaving a confusing blank. Two cases: the NPC
  // has spawns but none resolve to a zone with a parchment (e.g. map-less instances
  // like Dire Maul), or the NPC has no recorded spawn at all (Turtle NPCs placed by
  // a script/pool/event carry no static coordinates in the server data we ingest).
  const instMap = maps.find((m) => m.type === 1 || m.type === 2);
  const noMapNote = (mapZone || questZone) ? ""
    : npcSpawns.length
      ? `<div class="zone-empty muted">No spawn-location map is available${instMap ? ` — <b>${esc(instMap.name)}</b> has no interior map in the client data` : ""}.</div>`
      : `<div class="zone-empty muted">No spawn location is recorded for this NPC (it may be placed by a script or event).</div>`;
  // Quest-inferred zone: show the parchment but caption that there are no exact coords.
  const questZoneNote = questZone
    ? `<div class="zone-empty muted">No exact spawn coordinates in the current data — this NPC is placed by a script or event; the zone above is inferred from its quests.</div>`
    : "";

  app.innerHTML =
    `<div class="npc-page">
      <div class="npc-head">
        <h1 class="${rankClass}">${esc(npc.name)}</h1>
        ${npc.subname ? `<span class="npc-sub muted">&lt;${esc(npc.subname)}&gt;</span>` : ""}
        <div class="npc-meta muted">${bits.join(" · ")}${hp ? " · " + hp : ""}
          ${roles.map((r) => `<span class="tagx">${esc(r)}</span>`).join("")}
          <span class="dim">· NPC #${npc.entry}</span>${npc.display_id ? `<span class="dim"> · </span><span class="model-link" data-display="${npc.display_id}" tabindex="0" title="Hover to preview the 3D model">Model #${npc.display_id}</span>` : ""}</div>
        ${mapHtml ? `<div class="npc-meta muted">Location: ${mapHtml}</div>`
          : questZone ? `<div class="npc-meta muted">Location: ${zoneLink(questZone.areaid, questZone.name)} <span class="dim">(from quests)</span></div>`
          : ""}
      </div>
      ${(mapZone || questZone) ? `<div id="zonemap"></div>` : noMapNote}
      ${questZoneNote}
      ${tabs(tabDefs)}
    </div>`;
  mountTables();
  wireTabs();
  const drawZone = mapZone || questZone;
  if (drawZone) {
    const el = document.getElementById("zonemap");
    try {
      const { initZoneMap } = await import("./zonemap.js");
      const imgUrl = `${ASSETS_BASE}maps/${drawZone.areaid}.webp`;
      // Real spawns -> focus pins; quest-inferred zone -> parchment only (no coords).
      const opts = mapZone ? { focus: { label: npc.name, npc: npc.entry, points: mapPts } } : {};
      initZoneMap(el, { ...drawZone, imgUrl }, [], [], navigate, opts);
    } catch (e) { el.innerHTML = errorBox(e); }
  }
}

// Object (gameobject) detail page: harvest nodes / chests / quest objects. Like the
// NPC page but aggregated over every entry sharing the object's name (the per-zone
// copies of e.g. "Copper Vein"): their loot + spawns + quest links combine, and the
// most-common spawn zone renders the parchment with the looted item's icon as pins.
async function showObject(id) {
  app.innerHTML = `<div class="loading">Loading object ${id}…</div>`;
  let obj;
  try { obj = await queryOne(Q.Q_OBJECT, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!obj) { app.innerHTML = `<div class="home"><p>No object with ID ${id}.</p></div>`; return; }
  document.title = `${obj.name} - Tortoise-WoW DB`;

  const siblings = await query(Q.Q_OBJECT_SIBLINGS, [obj.name]);
  const entryIds = [...new Set(siblings.map((s) => s.entry))];
  const lootIds = [...new Set(siblings.map((s) => s.data1).filter(Boolean))];

  const [loot, spawns, starts, ends, objectiveOf] = await Promise.all([
    lootIds.length ? query(Q.qObjectLoot(lootIds.length), lootIds) : [],
    entryIds.length ? query(Q.qObjectSpawns(entryIds.length), entryIds) : [],
    query(Q.qObjectQuestStart(entryIds.length), entryIds),
    query(Q.qObjectQuestEnd(entryIds.length), entryIds),
    query(Q.qObjectObjectiveOf(entryIds.length), entryIds),
  ]);

  // A node like Copper Vein spawns across many zones; list every zone it appears in
  // (with parchment) by spawn count, and let a switcher re-draw the map per zone
  // (same UX as the multi-floor dungeon switcher). Default = the busiest zone.
  const zoneCount = new Map();
  for (const s of spawns) if (s.zone) zoneCount.set(s.zone, (zoneCount.get(s.zone) || 0) + 1);
  const zoneIds = [...zoneCount.keys()];
  const zinfo = new Map();
  if (zoneIds.length) for (const z of await query(Q.qZonesByIds(zoneIds.length), zoneIds)) zinfo.set(z.areaid, z);
  const objZones = [...zoneCount.entries()]
    .map(([aid, n]) => ({ zone: zinfo.get(aid), n }))
    .filter((z) => z.zone)
    .sort((a, b) => b.n - a.n);
  // ?fz=<areaid> (focus zone) opens the map on that zone -- e.g. the zone Farming
  // tab links here so clicking a node shows it in the zone you're farming, not the
  // busiest one. Falls back to the busiest zone.
  const fz = Number(new URLSearchParams(location.search).get("fz")) || 0;
  const activeZone = (fz && (objZones.find((z) => z.zone.areaid === fz) || {}).zone) || (objZones.length ? objZones[0].zone : null);

  const lootCols = [
    { label: "Item", cell: (d) => itemLink(d.entry, d.name, d.quality, d.icon), value: (d) => d.name },
    { label: "Chance", num: true, cell: (d) => pct(d.chance), value: (d) => d.chance || 0 },
  ];
  const questCols = [
    { label: "Quest", cell: (q) => questLink(q.entry, q.title), value: (q) => q.title },
    { label: "Level", num: true, cls: "muted", cell: (q) => q.level || "", value: (q) => q.level || 0 },
  ];
  const objectiveCols = [
    ...questCols,
    { label: "Needed", num: true, cls: "muted", cell: (q) => (q.count > 1 ? q.count : ""), value: (q) => q.count || 0 },
  ];

  const typeLabel = GAMEOBJECT_TYPE[obj.type] || "Object";
  const meta = [`<a class="nav" href="?browse=objects&type=${obj.type}">${esc(typeLabel)}</a>`];
  if (spawns.length) meta.push(`${spawns.length} spawn${spawns.length === 1 ? "" : "s"}`);
  if (objZones.length > 1) meta.push(`${objZones.length} zones`);

  const tabDefs = [];
  if (loot.length) tabDefs.push({ id: "contains", label: "Contains", ...regTable(lootCols, loot) });
  if (starts.length) tabDefs.push({ id: "starts", label: "Starts quests", ...regTable(questCols, starts) });
  if (ends.length) tabDefs.push({ id: "ends", label: "Ends quests", ...regTable(questCols, ends) });
  if (objectiveOf.length) tabDefs.push({ id: "objective", label: "Objective of", ...regTable(objectiveCols, objectiveOf) });

  // Zone switcher (one button per zone the object spawns in), like the floor switcher.
  const zoneSwitch = objZones.length > 1
    ? `<div id="objzoneswitch" class="floor-switch">${objZones.map(({ zone, n }) =>
        `<button data-zone="${zone.areaid}">${esc(zone.name)} <span class="dim">(${n})</span></button>`).join("")}</div>`
    : "";

  const noMapNote = activeZone ? ""
    : spawns.length
      ? `<div class="zone-empty muted">No spawn-location map is available for this object.</div>`
      : `<div class="zone-empty muted">No spawn location is recorded for this object (it may be placed by a script or event).</div>`;

  app.innerHTML =
    `<div class="npc-page">
      <div class="npc-head">
        <h1>${esc(obj.name)}</h1>
        <div class="npc-meta muted">${meta.join(" · ")} <span class="dim">· Object #${obj.entry}</span></div>
      </div>
      ${activeZone ? zoneSwitch + `<div id="zonemap"></div>` : noMapNote}
      ${tabDefs.length ? tabs(tabDefs) : ""}
    </div>`;
  mountTables();
  wireTabs();
  if (activeZone) {
    const el = document.getElementById("zonemap");
    try {
      const { initZoneMap } = await import("./zonemap.js");
      const focusIcon = loot[0] && loot[0].icon;
      // (re)draw the map for a zone: its parchment + this object's spawns there.
      const renderZone = (zone) => {
        const pts = spawns.filter((s) => s.zone === zone.areaid);
        const imgUrl = `${ASSETS_BASE}maps/${zone.areaid}.webp`;
        initZoneMap(el, { ...zone, imgUrl }, [], [], navigate, { focus: { label: obj.name, icon: focusIcon, points: pts } });
        app.querySelectorAll("#objzoneswitch button").forEach((b) => b.classList.toggle("active", Number(b.dataset.zone) === zone.areaid));
      };
      renderZone(activeZone);
      const zsw = document.getElementById("objzoneswitch");
      if (zsw) zsw.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-zone]"); if (!b) return;
        const z = objZones.find((o) => o.zone.areaid === Number(b.dataset.zone));
        if (z) renderZone(z.zone);
      });
    } catch (e) { el.innerHTML = errorBox(e); }
  }
}

// Icons index: a searchable grid of every icon used by a visible item or spell
// (the image is the hero element). Click a tile -> the icon detail page. Filter term
// + page live in the URL (?icons=<term>&page=<n>), like ?search=, so a filtered/
// paginated view is shareable. Paginated client-side. Q_ICON_LIST already drops
// orphan display rows; a tile whose CDN icon 404s removes itself (iconGridImg), so
// the remaining stale-but-in-use names (e.g. Warcraft-III "BTN*" art) don't show "?".
async function showIcons() {
  document.title = "Icons - Tortoise-WoW DB";
  app.innerHTML = `<div class="loading">Loading icons…</div>`;
  let rows;
  try { rows = await query(Q.Q_ICON_LIST); } catch (e) { app.innerHTML = errorBox(e); return; }
  // BTN* are Warcraft-III button textures (never valid WoW icons) -- skip them up
  // front so a "btn" search isn't a grid of tiles that all flash in then self-hide.
  const all = rows.map((r) => r.icon).filter((n) => !/^btn/i.test(n));
  const PER = 300;

  // initial filter + page from the URL
  const p0 = new URLSearchParams(location.search);
  let term = (p0.get("icons") || "").toLowerCase();
  let pageN = Math.max(0, (parseInt(p0.get("page"), 10) || 1) - 1);

  app.innerHTML = `<div class="icons-page">
    <h1>Icons</h1>
    <input type="search" class="icon-search" placeholder="Filter icons… (e.g. copper, sword, herb)" aria-label="Filter icons" value="${esc(term)}">
    <p class="muted icon-count" data-count></p>
    <div class="icon-grid" data-grid></div>
    <div class="icon-pager" data-pager></div>
  </div>`;
  const grid = app.querySelector("[data-grid]");
  const countEl = app.querySelector("[data-count]");
  const pager = app.querySelector("[data-pager]");
  const search = app.querySelector(".icon-search");

  // reflect the live filter + page into the URL (shareable, no history spam)
  const syncUrl = () => {
    let qs = "?icons" + (term ? "=" + encodeURIComponent(term) : "");
    if (pageN > 0) qs += "&page=" + (pageN + 1);
    history.replaceState({}, "", qs);
  };
  const render = () => {
    const f = term ? all.filter((n) => n.toLowerCase().includes(term)) : all;
    const pages = Math.max(1, Math.ceil(f.length / PER));
    if (pageN >= pages) pageN = pages - 1;
    const slice = f.slice(pageN * PER, pageN * PER + PER);
    grid.innerHTML = slice.map((n) =>
      `<button class="icon-tile" data-icon="${esc(n)}" title="${esc(n)}">${iconGridImg(n)}</button>`).join("")
      || `<p class="muted">No icon matches “${esc(term)}”.</p>`;
    countEl.textContent = `${f.length.toLocaleString()} shown${pages > 1 ? ` · page ${pageN + 1} / ${pages}` : ""}`;
    pager.innerHTML = pages > 1
      ? `<button data-pg="prev"${pageN === 0 ? " disabled" : ""}>‹ Prev</button>
         <button data-pg="next"${pageN === pages - 1 ? " disabled" : ""}>Next ›</button>` : "";
  };
  render();
  search.addEventListener("input", () => { term = search.value.trim().toLowerCase(); pageN = 0; render(); syncUrl(); });
  pager.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pg]"); if (!b) return;
    pageN += b.dataset.pg === "next" ? 1 : -1; render(); syncUrl();
    window.scrollTo({ top: 0 });
  });
  grid.addEventListener("click", (e) => {
    const tile = e.target.closest("[data-icon]"); if (!tile) return;
    navigate(`?icon=${encodeURIComponent(tile.dataset.icon)}`);
  });
}

// Icon detail: the items and spells that use a given icon basename.
async function showIcon(name) {
  document.title = `${name} - Icon - Tortoise-WoW DB`;
  app.innerHTML = `<div class="loading">Loading icon…</div>`;
  let items, spells;
  try { [items, spells] = await Promise.all([query(Q.Q_ICON_ITEMS, [name]), query(Q.Q_ICON_SPELLS, [name])]); }
  catch (e) { app.innerHTML = errorBox(e); return; }
  const itemCols = [
    { label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
    { label: "iLvl", num: true, cls: "muted", cell: (r) => r.item_level || "", value: (r) => r.item_level || 0 },
  ];
  const spellCols = [
    { label: "Spell", cell: (r) => spellLink(r.entry, r.name, r.icon), value: (r) => r.name },
    { label: "Profession", cls: "muted", hideEmpty: true, cell: (r) => esc(PROFESSION_LABEL[r.skill] || ""), value: (r) => PROFESSION_LABEL[r.skill] || "" },
  ];
  const tabDefs = [];
  if (items.length) tabDefs.push({ id: "items", label: "Items", ...regTable(itemCols, items, { pageSize: 100 }) });
  if (spells.length) tabDefs.push({ id: "spells", label: "Spells", ...regTable(spellCols, spells, { pageSize: 100 }) });
  app.innerHTML = `<div class="icon-page">
    <div class="icon-head">
      ${iconImg(name, "icon-hero")}
      <div><h1>${esc(name)}</h1>
        <div class="muted"><a class="nav" href="?icons">Icons</a> · ${items.length} item${items.length === 1 ? "" : "s"} · ${spells.length} spell${spells.length === 1 ? "" : "s"}</div></div>
    </div>
    ${tabDefs.length ? tabs(tabDefs) : `<p class="muted">Nothing in this build uses this icon.</p>`}
  </div>`;
  mountTables();
  wireTabs();
}

// Render mangos quest text: escape, then turn $B/$b into breaks and replace the
// $N/$C/$R name/class/race tokens + $gMale:Female; gender switches.
function questText(t) {
  if (!t) return "";
  return esc(t)
    .replace(/\$[bB]/g, "<br>")
    .replace(/\$[nN]/g, "&lt;name&gt;")
    .replace(/\$[cC]/g, "&lt;class&gt;")
    .replace(/\$[rR]/g, "&lt;race&gt;")
    .replace(/\$[gG]\s*([^:]*):([^;]*);/g, "$1/$2")
    .replace(/\r?\n/g, "<br>");
}

// Order the quest chain (Q_QUEST_CHAIN rows = the connected component) into a
// first->last sequence. Edges: a quest's prevquest (abs covers the negative
// "exclusive group" form) and nextquest. Topological sort; ties break by level
// then entry. Returns the ordered rows, or null when there's no chain (<2 quests).
export function orderQuestChain(rows) {
  if (!rows || rows.length < 2) return null;
  const byId = new Map(rows.map((r) => [r.entry, r]));
  const cmp = (a, b) => (a.level || 0) - (b.level || 0) || a.entry - b.entry;
  const adj = new Map(rows.map((r) => [r.entry, []]));
  const indeg = new Map(rows.map((r) => [r.entry, 0]));
  const edges = new Set();
  const addEdge = (a, b) => {
    if (a === b || !byId.has(a) || !byId.has(b) || edges.has(`${a}>${b}`)) return;
    edges.add(`${a}>${b}`); adj.get(a).push(b); indeg.set(b, indeg.get(b) + 1);
  };
  for (const r of rows) {
    const p = Math.abs(r.prevquest || 0);
    if (p) addEdge(p, r.entry);
    if (r.nextquest) addEdge(r.entry, r.nextquest);
  }
  // Kahn topological sort, picking the lowest-level node available at each step.
  const ready = rows.filter((r) => indeg.get(r.entry) === 0);
  const deg = new Map(indeg);
  const order = [];
  const placed = new Set();
  while (ready.length) {
    ready.sort(cmp);
    const r = ready.shift();
    if (placed.has(r.entry)) continue;
    placed.add(r.entry); order.push(r);
    for (const c of adj.get(r.entry)) { deg.set(c, deg.get(c) - 1); if (deg.get(c) === 0) ready.push(byId.get(c)); }
  }
  for (const r of rows) if (!placed.has(r.entry)) order.push(r); // cycle / leftover fallback
  // Annotate each quest with its DAG neighbours so the chain tab can flag branch
  // points (a quest with >1 child "opens" several follow-up lines) and separate
  // chains that connect in (a self-rooted quest, prevquest 0, pulled in via
  // another quest's nextquest -- e.g. Milly Osworth off Brotherhood of Thieves).
  const parents = new Map(rows.map((r) => [r.entry, []]));
  for (const [a, outs] of adj) for (const b of outs) parents.get(b).push(a);
  for (const r of rows) { r.children = adj.get(r.entry) || []; r.parents = parents.get(r.entry) || []; }
  return order;
}

async function showQuest(id) {
  app.innerHTML = `<div class="loading">Loading quest ${id}…</div>`;
  let q;
  try { q = await queryOne(Q.Q_QUEST, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!q) { app.innerHTML = `<div class="home"><p>No quest with ID ${id}.</p></div>`; return; }
  document.title = `${q.title} - Tortoise-WoW DB`;

  const [giversN, endersN, giversG, endersG, qitems, qcreatures, qrep, rewSpell, chainRows] =
    await Promise.all([
      query(Q.Q_QUEST_GIVERS_NPC, [id]), query(Q.Q_QUEST_ENDERS_NPC, [id]),
      query(Q.Q_QUEST_GIVERS_GO, [id]), query(Q.Q_QUEST_ENDERS_GO, [id]),
      query(Q.Q_QUEST_ITEMS, [id]), query(Q.Q_QUEST_CREATURES, [id]), query(Q.Q_QUEST_REP, [id]),
      q.rewspell ? queryOne(Q.Q_SPELL, [q.rewspell]) : null,
      query(Q.Q_QUEST_CHAIN, [id]),
    ]);

  const byRole = (role) => qitems.filter((r) => r.role === role);

  // ---- header meta ----
  const bits = [];
  if (q.level > 0) bits.push(`Level ${q.level}`);
  if (q.minlevel > 0) bits.push(`Requires level ${q.minlevel}`);
  // Zone: resolve the full hierarchy continent › zone › sub-zone, linking whichever
  // levels have a map page. Categories (negative q.zone, e.g. "Class") fall back to
  // the plain questZoneLabel.
  if (q.zone > 0 && q.zone_name) {
    const sep = ' <span class="dim">›</span> ';
    const parts = [];
    if (CONTINENT[q.zone_map]) parts.push(esc(CONTINENT[q.zone_map]));
    if (q.zone_parent && q.zone_parent !== q.zone && q.parent_name) {
      parts.push(q.parent_page ? zoneLink(q.zone_parent, q.parent_name) : esc(q.parent_name));
    }
    parts.push(q.zone_page ? zoneLink(q.zone, q.zone_name) : esc(q.zone_name));
    bits.push(parts.join(sep));
  } else {
    const zoneLabel = questZoneLabel(q.zone, q.zone_name);
    if (zoneLabel) bits.push(esc(zoneLabel));
  }
  if (QUEST_TYPE[q.type]) bits.push(QUEST_TYPE[q.type]);

  const restr = [];
  const cls = classRestrictions(q.reqclasses);
  if (cls) restr.push(`Classes: ${cls.join(", ")}`);
  const race = raceRestrictions(q.reqraces);
  if (race) restr.push(`Races: ${race.join(", ")}`);
  if (q.reqskill > 0) {
    restr.push(`Requires ${PROFESSION_LABEL[q.reqskill] || `skill ${q.reqskill}`}` +
      (q.reqskillvalue > 0 ? ` (${q.reqskillvalue})` : ""));
  }

  const chainOrdered = orderQuestChain(chainRows);

  // ---- NPC locations (batched): for the giver/ender tabs AND each chain step's
  // start NPC (so the chain tab shows where to pick up every quest) ----
  const chainEntries = (chainOrdered || []).map((r) => r.entry);
  const startByQuest = new Map();
  if (chainEntries.length) {
    for (const r of await query(Q.qQuestStartNpcs(chainEntries.length), chainEntries)) {
      (startByQuest.get(r.quest) || startByQuest.set(r.quest, []).get(r.quest)).push(r);
    }
  }
  const chainStartNpcs = [...startByQuest.values()].flat();
  const locByNpc = await resolveNpcLocations([...giversN, ...endersN, ...chainStartNpcs].map((n) => n.entry));
  const locHtml = (e) => (locByNpc.get(e) || {}).html || "";
  const locText = (e) => (locByNpc.get(e) || {}).text || "";
  const locCol = { label: "Location", cls: "muted", cell: (c) => locHtml(c.entry), value: (c) => locText(c.entry) };

  // attach the step number + start NPC/location to each chain row for the chain tab
  const chainById = new Map((chainOrdered || []).map((r) => [r.entry, r]));
  (chainOrdered || []).forEach((r, i) => {
    r.step = i + 1;
    const npc = (startByQuest.get(r.entry) || [])[0];
    r.startHtml = npc ? npcLink(npc.entry, npc.name) + (locHtml(npc.entry) ? ` <span class="dim">·</span> ${locHtml(npc.entry)}` : "") : "";
    r.startText = npc ? (locText(npc.entry) || npc.name) : "";
  });

  // ---- required (objective) items: per item, where it drops + the zone ----
  // Each objective item becomes a collapsible group; its rows list the NPCs/objects
  // that drop it and where. So a "collect 8 Tough Wolf Meat" objective expands to
  // the wolves (and their zones) you can farm.
  const reqItems = byRole("req");
  const reqDropRows = [];
  const collectSources = []; // {entry,name,kind,icon} drop/gather sources -> quest map "Collect" layer
  if (reqItems.length) {
    // Items with no direct drop source that are CRAFTED/COMBINED (e.g. a pendant from
    // two half-pendants) fall back to where their create-recipe REAGENTS are collected.
    const reagentRows = await query(Q.qItemReagents(reqItems.length), reqItems.map((r) => r.entry));
    const reagentsByResult = new Map();
    for (const r of reagentRows) { const a = reagentsByResult.get(r.result) || []; a.push(r); reagentsByResult.set(r.result, a); }
    // per req item -> the "parts" we actually look up sources for (itself, or its reagents)
    const per = await Promise.all(reqItems.map(async (ri) => {
      const [npcs, objs] = await Promise.all([query(Q.Q_DROPPED_BY, [ri.entry]), query(Q.Q_OBJECT_SOURCE_ENTRIES, [ri.entry])]);
      if (npcs.length || objs.length) return { ri, parts: [{ item: ri, npcs, objs }] };
      const reags = reagentsByResult.get(ri.entry) || [];
      const parts = await Promise.all(reags.map(async (rg) => {
        const [rn, ro] = await Promise.all([query(Q.Q_DROPPED_BY, [rg.reagent]), query(Q.Q_OBJECT_SOURCE_ENTRIES, [rg.reagent])]);
        return { item: { entry: rg.reagent, name: rg.reagent_name, quality: rg.quality, icon: rg.icon }, npcs: rn, objs: ro, via: ri };
      }));
      return { ri, parts };
    }));
    const allParts = per.flatMap((p) => p.parts);
    const [npcLoc, objLoc] = await Promise.all([
      resolveNpcLocations(allParts.flatMap((pt) => pt.npcs.map((n) => n.entry)), "c"),
      resolveNpcLocations(allParts.flatMap((pt) => pt.objs.map((o) => o.entry)), "o"),
    ]);
    for (const { ri, parts } of per) {
      const base = { item: ri.entry, itemName: ri.name, quality: ri.quality, icon: ri.icon, qty: ri.count };
      let anySrc = false;
      for (const pt of parts) {
        const via = pt.via ? ` <span class="muted">(from ${esc(pt.item.name)})</span>` : ""; // a reagent fallback
        for (const n of pt.npcs) {
          anySrc = true;
          const loc = npcLoc.get(n.entry) || {};
          const tag = n.skin_chance != null ? ' <span class="muted">(skin)</span>' : n.pick_chance != null ? ' <span class="muted">(pickpocket)</span>' : "";
          reqDropRows.push({ ...base, srcHtml: npcLink(n.entry, n.name) + tag + via, srcName: n.name, zoneHtml: loc.html || "", zoneText: loc.text || "", chance: n.drop_chance ?? n.skin_chance ?? n.pick_chance });
          collectSources.push({ entry: n.entry, name: n.name, kind: "c", icon: pt.item.icon || ri.icon, group: pt.item.entry, groupName: pt.item.name });
        }
        const seenObjName = new Set(); // table: one row per object NAME; map: every entry
        for (const o of pt.objs) {
          if (!o.entry) continue;
          anySrc = true;
          collectSources.push({ entry: o.entry, name: o.name, kind: "o", icon: pt.item.icon || ri.icon, group: pt.item.entry, groupName: pt.item.name });
          if (seenObjName.has(o.name)) continue;
          seenObjName.add(o.name);
          const loc = objLoc.get(o.entry) || {};
          reqDropRows.push({ ...base, srcHtml: `${objectLink(o.entry, o.name)} <span class="muted">(object)</span>${via}`, srcName: o.name, zoneHtml: loc.html || "", zoneText: loc.text || "", chance: o.chance });
        }
      }
      if (!anySrc) reqDropRows.push({ ...base, srcHtml: '<span class="muted">No recorded drop source</span>', srcName: "", zoneHtml: "", zoneText: "", chance: null });
    }
  }

  // ---- where the kill/use targets are (creatures + objects), batched ----
  const [killNpcLoc, killObjLoc] = await Promise.all([
    resolveNpcLocations(qcreatures.filter((o) => !o.is_go).map((o) => o.target), "c"),
    resolveNpcLocations(qcreatures.filter((o) => o.is_go).map((o) => o.target), "o"),
  ]);
  const killLoc = (o) => (o.is_go ? killObjLoc : killNpcLoc).get(o.target) || {};

  // ---- quest map plan: one view per zone the quest touches, plus a world-map overview
  // of the busiest continent; a switcher (like the object/dungeon-floor one) flips them ----
  let questMap = { views: [] };
  try {
    questMap = await buildQuestMap({
      giversN, endersN, giversG, endersG,
      kills: qcreatures.map((o) => ({ entry: o.target, name: o.name || `#${o.target}`, kind: o.is_go ? "o" : "c", count: o.count })),
      collects: collectSources,
    });
  } catch (_) { /* no map */ }
  // resolve parchment bounds/names for the zone views; keep only drawable views (zone
  // with a parchment row, world continent with a minimap pyramid).
  const qvZoneIds = questMap.views.filter((v) => v.kind === "zone").map((v) => v.areaid);
  const qvZones = qvZoneIds.length ? await query(Q.qZonesByIds(qvZoneIds.length), qvZoneIds) : [];
  const qvZoneById = new Map(qvZones.map((z) => [z.areaid, z]));
  // Drop parchment markers whose in-game coordinate falls outside 0-100: a spawn's
  // ADT-assigned zone can differ from the zone whose WorldMapArea rectangle actually
  // contains it, so its world (x,y) projects off that zone's parchment (e.g. quest
  // 60145's kill target sits in "Northwind" but plots at Y=103 on its map). The
  // continent world view keeps them -- its projection is valid there. A zone view
  // left with no in-bounds markers is discarded entirely. (M = small edge tolerance
  // for WMA-rectangle rounding at zone borders.)
  const inZoneBounds = (z, p) => {
    const dx = z.loctop - z.locbottom, dy = z.locleft - z.locright, M = 2;
    const X = dy ? (100 * (z.locleft - p.y)) / dy : 0;
    const Y = dx ? (100 * (z.loctop - p.x)) / dx : 0;
    return X >= -M && X <= 100 + M && Y >= -M && Y <= 100 + M;
  };
  for (const v of questMap.views) {
    if (v.kind !== "zone") continue;
    const z = qvZoneById.get(v.areaid);
    if (!z) continue;
    for (const l of v.markerLayers || []) l.points = l.points.filter((p) => inZoneBounds(z, p));
    v.markerLayers = (v.markerLayers || []).filter((l) => l.points.length);
    if (v.route && v.route.points) {
      v.route.points = v.route.points.filter((p) => inZoneBounds(z, p));
      if (v.route.points.length < 3) v.route = null;
    }
  }
  const mapViews = questMap.views.filter((v) => v.kind === "world"
    ? !!(minimapManifest.maps || {})[String(v.mapId)]
    : (qvZoneById.has(v.areaid) && (v.markerLayers || []).length > 0));
  const viewLabel = (v) => (v.kind === "world" ? "World map" : (qvZoneById.get(v.areaid)?.name || `Zone ${v.areaid}`));
  const mapSwitch = mapViews.length > 1
    ? `<div id="questmapswitch" class="floor-switch">${mapViews.map((v, i) =>
        `<button data-vk="${esc(v.key)}"${i === 0 ? ' class="active"' : ""}>${esc(viewLabel(v))}</button>`).join("")}</div>`
    : "";
  const mapHtml = mapViews.length
    ? `<div class="panel quest-map"><h3 class="quest-map-h">Map</h3>${mapSwitch}<div id="zonemap"></div></div>` : "";

  // ---- objectives: kill/use targets + collect items, icons inline (like the
  // in-game quest log / octowow). The tabs still carry the farming detail. ----
  const goalItemQty = (n) => (n > 1 ? ` <span class="q-qty">(${n})</span>` : "");
  const goalLis = [];
  for (const o of qcreatures) {
    const link = o.is_go ? objectLink(o.target, o.name || `Object #${o.target}`) : npcLink(o.target, o.name || `NPC #${o.target}`);
    goalLis.push(`<li>${link}${goalItemQty(o.count)}</li>`);
  }
  for (const it of byRole("req")) goalLis.push(`<li>${itemLink(it.entry, it.name, it.quality, it.icon)}${goalItemQty(it.count)}</li>`);

  // ---- rewards: reward + choice items with icons, plus money/xp/rep/spell ----
  const rewItemLi = (it) => `<li>${itemLink(it.entry, it.name, it.quality, it.icon)}${it.count > 1 ? ` <span class="q-qty">×${it.count}</span>` : ""}</li>`;
  const provided = byRole("source");
  const choiceItems = byRole("choice");
  const rewItems = byRole("reward");
  const rewExtra = [];
  if (q.money > 0) rewExtra.push(moneyHtml(q.money));
  if (q.xp > 0) rewExtra.push(`${q.xp.toLocaleString()} XP`);
  for (const r of qrep) if (r.value) rewExtra.push(`+${r.value} ${factionLink(r.faction, r.faction_name)}`);
  if (rewSpell) rewExtra.push(`Learn: ${spellLink(rewSpell.entry, rewSpell.name, rewSpell.icon)}`);
  const rewGroup = (lbl, items) => `<div class="q-rew-grp"><span class="q-rew-lbl">${lbl}</span><ul class="quest-items">${items.map(rewItemLi).join("")}</ul></div>`;
  const rewardBlocks = [];
  if (choiceItems.length) rewardBlocks.push(rewGroup("You will be able to choose one of these rewards:", choiceItems));
  if (rewItems.length) rewardBlocks.push(rewGroup("You will receive:", rewItems));
  if (rewExtra.length) rewardBlocks.push(`<p class="quest-rew">${rewExtra.join('<span class="dim"> · </span>')}</p>`);

  const desc = [];
  if (q.objectives) desc.push(`<p class="quest-obj">${questText(q.objectives)}</p>`);
  if (goalLis.length) desc.push(`<ul class="quest-items quest-goals">${goalLis.join("")}</ul>`);
  if (provided.length) desc.push(`<h3>Provided item${provided.length > 1 ? "s" : ""}</h3><ul class="quest-items">${provided.map(rewItemLi).join("")}</ul>`);
  if (q.details) desc.push(`<h3>Description</h3><p>${questText(q.details)}</p>`);
  if (q.objtext) desc.push(`<h3>Quest Objectives</h3><p>${questText(q.objtext)}</p>`);
  if (q.offertext) desc.push(`<h3>Completion</h3><p>${questText(q.offertext)}</p>`);
  if (rewardBlocks.length) desc.push(`<h3>Rewards</h3>${rewardBlocks.join("")}`);

  // ---- relation tables ----
  const npcCols = [
    { label: "NPC", cell: (c) => npcLink(c.entry, c.name), value: (c) => c.name },
    { label: "Level", num: true, cls: "muted", cell: (c) => lvlRange(c), value: (c) => c.level_max || c.level_min || 0 },
    locCol,
  ];
  const goCols = [{ label: "Object", cell: (g) => objectLink(g.entry, g.name), value: (g) => g.name }];
  const itemCols = [
    { label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
    { label: "Qty", num: true, cls: "muted", cell: (r) => (r.count > 1 ? r.count : ""), value: (r) => r.count || 0 },
  ];
  const targetCols = [
    { label: "Target", cell: (o) => (o.is_go ? objectLink(o.target, o.name || `Object #${o.target}`) : npcLink(o.target, o.name || `NPC #${o.target}`)), value: (o) => o.name || "" },
    { label: "Location", cls: "muted", cell: (o) => killLoc(o).html || "", value: (o) => killLoc(o).text || "" },
    { label: "Count", num: true, cls: "muted", cell: (o) => (o.count > 1 ? o.count : ""), value: (o) => o.count || 0 },
  ];
  // Quest chain: ordered first->last via a step "#" column (default no sort keeps
  // that order; click # to restore it). Current quest bolded; "Starts at" = the
  // step's giver NPC + its location.
  // Badges convey chain structure so a plain prereq column (near-always just the
  // row above, in topo order) isn't needed: ⑂ = opens several follow-up lines,
  // ⇉ = several quests converge here (tooltip names them), ↗ = a self-rooted line
  // that connects in. Ordinary linear steps carry no badge (prereq = the row above).
  const chainCols = [
    { label: "#", num: true, cls: "muted", cell: (r) => r.step, value: (r) => r.step },
    { label: "Quest", value: (r) => r.title, cell: (r) => {
        const nm = r.entry === q.entry ? `<b class="qc-cur">${esc(r.title)}</b>` : questLink(r.entry, r.title);
        const b = [];
        const kids = (r.children || []).length;
        if (kids > 1) b.push(`<span class="qc-branch" title="Opens ${kids} follow-up quest lines">⑂ ${kids}</span>`);
        const par = (r.parents || []).map((e) => chainById.get(e)).filter(Boolean);
        if (par.length > 1) b.push(`<span class="qc-branch qc-merge" title="${esc(`${par.length} quests lead here: ${par.map((p) => p.title).join(", ")}`)}">⇉ ${par.length}</span>`);
        if (r.prevquest === 0 && (r.parents || []).length) b.push(`<span class="qc-branch qc-join" title="Start of a separate quest line that connects into this chain">↗ separate chain</span>`);
        return nm + b.map((x) => ` ${x}`).join("");
      } },
    { label: "Level", num: true, cls: "muted", cell: (r) => (r.level > 0 ? r.level : ""), value: (r) => r.level || 0 },
    { label: "Starts at", cls: "muted", cell: (r) => r.startHtml, value: (r) => r.startText },
  ];
  // Required items grouped by item (one collapsible row per objective); each row =
  // a drop source + its zone. group() renders the item link + qty in the header.
  const reqCols = [
    { key: "item", label: "Item", value: (r) => r.itemName,
      group: (r) => itemLink(r.item, r.itemName, r.quality, r.icon) + (r.qty > 1 ? ` <span class="dim">×${r.qty}</span>` : ""),
      cell: () => "" },
    { label: "Source", cell: (r) => r.srcHtml, value: (r) => r.srcName },
    { label: "Zone", cls: "muted", cell: (r) => r.zoneHtml, value: (r) => r.zoneText },
    { label: "Chance", num: true, cls: "muted", cell: (r) => (r.chance != null ? pct(r.chance) : ""), value: (r) => r.chance || 0 },
  ];

  const tabDefs = [
    ...(chainOrdered ? [{ id: "chain", label: "Quest Chain", ...regTable(chainCols, chainOrdered, { pageSize: 200 }) }] : []),
    { id: "giverN", label: "Starts (NPC)", ...regTable(npcCols, giversN) },
    { id: "enderN", label: "Ends (NPC)", ...regTable(npcCols, endersN) },
    { id: "giverG", label: "Starts (Object)", ...regTable(goCols, giversG) },
    { id: "enderG", label: "Ends (Object)", ...regTable(goCols, endersG) },
    { id: "objcre", label: "Kill / Use", ...regTable(targetCols, qcreatures) },
    { id: "reqitem", label: "Required items", ...regTable(reqCols, reqDropRows, { group: 0, startCollapsed: true, pageSize: 1000 }), count: reqItems.length },
    { id: "srcitem", label: "Provided items", ...regTable(itemCols, byRole("source")) },
    { id: "reward", label: "Rewards", ...regTable(itemCols, byRole("reward")) },
    { id: "choice", label: "Choice of", ...regTable(itemCols, byRole("choice")) },
  ];

  // Walkthrough link: a channel-scoped YouTube search on the community "Turtle WoW
  // Quests Archives" channel (one quest/video, start->finish). The channel titles
  // its videos "[lvl] <title> | <zone> (ID: <questId>)", so we search title + the
  // exact "(ID: <entry>)" token -> the right video lands as the top result. A search
  // (not a hard-coded video id) needs no per-quest data and never goes stale.
  const ytUrl = `https://www.youtube.com/@TurtleWoWQuests/search?query=${encodeURIComponent(`${q.title} (ID: ${q.entry})`)}`;

  app.innerHTML =
    `<div class="npc-page quest-page">
      <div class="npc-head">
        <h1>${esc(q.title)}${q.custom ? ' <span class="tagx tw-tag" title="Added by Turtle WoW (not in vanilla 1.12)">Turtle WoW</span>' : ""}</h1>
        <div class="npc-meta muted">${bits.join(" · ")}<span class="dim"> · Quest #${q.entry}</span></div>
        ${restr.length ? `<div class="npc-meta muted">${restr.map(esc).join(" · ")}</div>` : ""}
        <div class="npc-meta"><a class="yt-link" href="${ytUrl}" target="_blank" rel="noopener noreferrer">▶ Watch walkthrough on YouTube</a></div>
      </div>
      ${desc.length ? `<div class="panel quest-desc">${desc.join("")}</div>` : ""}
      ${mapHtml}
      ${tabs(tabDefs)}
    </div>`;
  mountTables();
  wireTabs();

  // lazy-init the quest map (heavy Leaflet/Pixi chunk); the switcher redraws it per view.
  if (mapViews.length) {
    const el = document.getElementById("zonemap");
    try {
      const { initZoneMap, initWorldMap } = await import("./zonemap.js");
      const renderView = (v) => {
        const opts = { markerLayers: v.markerLayers, route: v.route };
        if (v.kind === "zone") {
          const zone = qvZoneById.get(v.areaid);
          initZoneMap(el, { ...zone, imgUrl: `${ASSETS_BASE}maps/${zone.areaid}.webp` }, [], [], navigate, opts);
        } else {
          const m = (minimapManifest.maps || {})[String(v.mapId)];
          initWorldMap(el, {
            mapId: v.mapId, name: m.name, bbox: m.bbox,
            tile: minimapManifest.tile, adt: minimapManifest.adt, grid: minimapManifest.grid,
            maxNativeZoom: minimapManifest.maxNativeZoom, tilesBase: `${ASSETS_BASE}minimap/`,
          }, [], [], navigate, opts);
        }
        app.querySelectorAll("#questmapswitch button").forEach((b) => b.classList.toggle("active", b.dataset.vk === v.key));
      };
      renderView(mapViews[0]);
      app.querySelectorAll("#questmapswitch button").forEach((b) => b.addEventListener("click", () => {
        const v = mapViews.find((x) => x.key === b.dataset.vk);
        if (v) renderView(v);
      }));
    } catch (e) { document.getElementById("zonemap")?.closest(".quest-map")?.remove(); }
  }
}

async function showFaction(id) {
  app.innerHTML = `<div class="loading">Loading faction ${id}…</div>`;
  let fac;
  try { fac = await queryOne(Q.Q_FACTION, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!fac) { app.innerHTML = `<div class="home"><p>No faction with ID ${id}.</p></div>`; return; }
  const name = fac.name || `Faction #${fac.id}`;
  document.title = `${name} - Tortoise-WoW DB`;

  const [items, quests, members, mobs] = await Promise.all([
    query(Q.Q_FACTION_ITEMS, [id]), query(Q.Q_FACTION_QUESTS, [id]), query(Q.Q_FACTION_NPCS, [id]),
    query(Q.Q_FACTION_MOBS, [id]),
  ]);
  const npcLoc = await resolveNpcLocations([...members.map((m) => m.entry), ...mobs.map((m) => m.entry)]);

  // Standing column: value=rank (orders Friendly→Exalted), cell=label (group header).
  const itemCols = [
    { key: "name", label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
    { key: "standing", label: "Standing", cls: "muted", cell: (r) => REP_STANDING[r.rank] || "", value: (r) => r.rank || 0 },
    { key: "ilvl", label: "iLvl", num: true, cls: "muted", cell: (r) => r.item_level || "", value: (r) => r.item_level || 0 },
    { key: "req", label: "Req", num: true, cls: "muted", cell: (r) => r.required_level || "", value: (r) => r.required_level || 0 },
  ];
  const questColsF = [
    { label: "Quest", cell: (r) => questLink(r.entry, r.title), value: (r) => r.title },
    { label: "Level", num: true, cls: "muted", cell: (r) => r.level || "", value: (r) => r.level || 0 },
    { label: "Rep", num: true, cls: "muted", cell: (r) => `+${r.value}`, value: (r) => r.value || 0 },
  ];
  const memberCols = [
    { label: "NPC", cell: (r) => npcLink(r.entry, r.name), value: (r) => r.name },
    { label: "Title", cls: "muted", cell: (r) => esc(r.subname || ""), value: (r) => r.subname || "" },
    { label: "Level", num: true, cls: "muted", cell: (r) => lvlRange(r), value: (r) => r.level_max || r.level_min || 0 },
    { label: "Location", cls: "muted", cell: (r) => (npcLoc.get(r.entry) || {}).html || "", value: (r) => (npcLoc.get(r.entry) || {}).text || "" },
  ];
  // rep-per-kill grind targets. A kill stops giving rep once you reach maxstanding,
  // so "kills to Exalted" only applies when the mob caps at Exalted (>=7).
  const toExalted = (v) => Math.ceil(REP_EXALTED / v);
  const mobCols = [
    { label: "NPC", cell: (r) => npcLink(r.entry, r.name) + (CREATURE_RANK[r.rank] ? ` <span class="muted">(${CREATURE_RANK[r.rank]})</span>` : ""), value: (r) => r.name },
    { label: "Level", num: true, cls: "muted", cell: (r) => lvlRange(r), value: (r) => r.level_max || r.level_min || 0 },
    { label: "Location", cls: "muted", cell: (r) => (npcLoc.get(r.entry) || {}).html || "", value: (r) => (npcLoc.get(r.entry) || {}).text || "" },
    { label: "Rep / kill", num: true, cell: (r) => `+${r.value}`, value: (r) => r.value || 0 },
    { label: "Caps at", cls: "muted", cell: (r) => REP_STANDING[r.maxstanding] || "", value: (r) => r.maxstanding || 0 },
    { label: "Kills → Exalted", num: true, cls: "muted", cell: (r) => (r.maxstanding >= 7 ? toExalted(r.value).toLocaleString() : "—"), value: (r) => (r.maxstanding >= 7 ? toExalted(r.value) : Infinity) },
  ];

  // ---- rep calculator: tier thresholds + a grind-first strategy ----
  // Optimal order is grind BEFORE questing: a kill stops paying rep once you reach
  // its cap standing, and quest rep is a finite one-off — so farm mobs while they
  // still pay, then cash quests in for the final push (usually the last tier).
  const questTotal = quests.reduce((s, q) => s + (q.value || 0), 0);
  const repMobs = mobs.filter((m) => m.value > 0);
  const fastMob = repMobs.slice().sort((a, b) => b.value - a.value)[0];  // best rep/kill
  const grindCeiling = repMobs.reduce((m, x) => Math.max(m, x.maxstanding || 0), 0); // highest standing kills reach
  const tierRows = [4, 5, 6, 7].map((s) => `<tr><td>${REP_STANDING[s]}</td><td class="num">${REP_TO_STANDING[s].toLocaleString()}</td></tr>`).join("");
  const notes = [];
  if (repMobs.length) {
    notes.push(`<li><b>⚔ Grind first, quest last.</b> Kills stop granting rep at their cap standing and quest rep is a one-off — so farm mobs while they still pay, then turn in quests for the final stretch.</li>`);
    if (fastMob) {
      const cap = fastMob.maxstanding, capRep = REP_TO_STANDING[cap];
      const detail = cap >= 7
        ? `grinds all the way to Exalted — ~<b>${toExalted(fastMob.value).toLocaleString()} kills</b>`
        : `is fastest${capRep ? ` — ~<b>${Math.ceil(capRep / fastMob.value).toLocaleString()} kills</b> to ${REP_STANDING[cap]}` : ""}, then it caps out`;
      notes.push(`<li><b>Fastest grind:</b> ${npcLink(fastMob.entry, fastMob.name)} at +${fastMob.value}/kill ${detail}.</li>`);
    }
    if (grindCeiling > 0 && grindCeiling < 7) notes.push(`<li>Kills top out at <b>${REP_STANDING[grindCeiling]}</b> — cover the rest to Exalted with quests.</li>`);
  }
  if (quests.length) notes.push(`<li><b>Quests:</b> +${questTotal.toLocaleString()} across ${quests.length} quest${quests.length === 1 ? "" : "s"} (worth <b>${REP_STANDING[repStandingReached(questTotal)]}</b> on their own) — save them until after the grind.</li>`);
  const calc = (quests.length || mobs.length) ? `<details class="rep-calc" open>
    <summary>Reputation calculator — grind first, quests last</summary>
    <div class="rep-calc-body">
      <table class="rep-tiers"><thead><tr><th>Standing</th><th class="num">Total rep</th></tr></thead><tbody>${tierRows}</tbody></table>
      <ul class="rep-notes">${notes.join("")}</ul>
    </div>
  </details>` : "";

  const meta = [`${fac.items} item${fac.items === 1 ? "" : "s"}`, `${fac.repquests} rep quest${fac.repquests === 1 ? "" : "s"}`];
  if (fac.repmobs) meta.push(`${fac.repmobs} rep mob${fac.repmobs === 1 ? "" : "s"}`);
  const tabDefs = [
    { id: "items", label: "Items", ...regTable(itemCols, items, { pageSize: 200, groupable: true, group: 1 }) },
    { id: "quests", label: "Rep from quests", ...regTable(questColsF, quests, { pageSize: 100 }) },
    { id: "mobs", label: "Rep from kills", ...regTable(mobCols, mobs, { pageSize: 100 }) },
    { id: "members", label: "Members", ...regTable(memberCols, members, { pageSize: 100 }) },
  ];

  app.innerHTML =
    `<div class="npc-page">
      <div class="npc-head">
        <h1>${esc(name)}</h1>
        <div class="npc-meta muted">${meta.join(" · ")}<span class="dim"> · Faction #${fac.id}</span></div>
      </div>
      ${calc}
      ${tabs(tabDefs)}
    </div>`;
  mountTables();
  wireTabs();
}

async function showZone(id, gatherItem = null) {
  app.innerHTML = `<div class="loading">Loading zone ${id}…</div>`;
  let z;
  try { z = await queryOne(Q.Q_ZONE, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!z) { app.innerHTML = `<div class="home"><p>No zone with ID ${id}.</p></div>`; return; }
  document.title = `${z.name} - Tortoise-WoW DB`;

  // A zone whose map is an instance (type 1 dungeon / 2 raid) is rendered as a
  // dungeon: boss-loot tab, instance loot/creature queries, skull boss markers.
  const mapInfo = await queryOne(Q.Q_MAP_TYPE, [z.mapid]);
  const typeLabel = mapInfo && (mapInfo.type === 2 ? "Raid" : mapInfo.type === 1 ? "Dungeon" : null);
  const isInstance = !!typeLabel;

  // Instances are loaded whole-map (all floors): tabs cover the entire instance,
  // and a multi-floor dungeon/raid (e.g. Black Morass, Karazhan) gets a floor
  // switcher over the map. Open-world zones load by their single home zone.
  const az = [z.areaid], mz = [z.mapid];
  const [spawns, objects, loot, focusPts, focusItem, bossLoot, bossEntries, zoneQuests, floors] = await Promise.all([
    isInstance ? query(Q.Q_MAP_SPAWNS, mz) : query(Q.Q_ZONE_SPAWNS, az),
    isInstance ? query(Q.Q_MAP_OBJECTS, mz) : query(Q.Q_ZONE_OBJECTS, az),
    isInstance ? query(Q.Q_DUNGEON_LOOT, mz) : query(Q.Q_ZONE_LOOT, az),
    gatherItem ? query(Q.Q_ZONE_FOCUS_SPAWNS, [z.areaid, gatherItem]) : [],
    gatherItem ? queryOne(Q.Q_ITEM_ICON, [gatherItem]) : null,
    isInstance ? query(Q.Q_DUNGEON_BOSS_LOOT, mz) : [],
    isInstance ? query(Q.Q_MAP_BOSSES, mz) : [],
    isInstance ? query(Q.Q_DUNGEON_QUESTS, [z.mapid, z.name]) : query(Q.Q_ZONE_QUESTS, az),
    isInstance ? query(Q.Q_MAP_FLOORS, mz) : [],
  ]);
  // focus mode: only the gathered node's spawns, drawn with the item's icon
  const focus = focusPts.length
    ? { label: (focusItem && focusItem.name) || focusPts[0].name || "Node", icon: focusItem && focusItem.icon, points: focusPts }
    : null;
  // Boss skull markers: instance unique-spawns (cnt=1). Open-world rank-3 "World
  // Boss" creatures are intentionally excluded (that rank also covers city leaders).
  const bossSet = new Set(bossEntries.map((r) => r.id));
  const bosses = isInstance ? spawns.filter((s) => bossSet.has(s.entry)) : [];

  // Map floors: the instance's WorldMap areas (>1 = multi-floor). Spawns split
  // across them by home zone; default to the floor holding most (preferring the
  // opened areaid). Open-world zones are a single "floor" (the zone itself).
  const allFloors = (isInstance && floors.length) ? floors : [z];
  const spawnsByFloor = new Map();
  for (const s of spawns) spawnsByFloor.set(s.zone, (spawnsByFloor.get(s.zone) || 0) + 1);
  const floorCount = (fl) => spawnsByFloor.get(fl.areaid) || 0;
  const activeFloor = allFloors.find((fl) => fl.areaid === z.areaid && floorCount(fl) > 0)
    || [...allFloors].sort((a, b) => floorCount(b) - floorCount(a))[0] || z;

  const meta = [typeLabel || CONTINENT[z.mapid], `${spawns.length + objects.length} spawns`].filter(Boolean);

  // dedupe spawn rows into distinct NPCs / objects (with a spawn-point count)
  const dedupe = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const g = m.get(r.entry);
      if (g) g.count++; else m.set(r.entry, { ...r, count: 1 });
    }
    return [...m.values()];
  };
  const npcs = dedupe(spawns), objs = dedupe(objects);

  // Best farms (open-world): mobs/objects ranked by total expected drop value in the
  // zone (vendor value per kill/gather x spawn count) -- what's worth farming for
  // gold. Plus value-weighted points for the map's "Gold route" overlay.
  const farmRows = isInstance ? [] : [
    ...npcs.filter((n) => n.loot_value > 0).map((n) => ({ kind: "c", entry: n.entry, name: n.name, level_min: n.level_min, level_max: n.level_max, value: n.loot_value, count: n.count, total: n.loot_value * n.count })),
    ...objs.filter((o) => o.loot_value > 0).map((o) => ({ kind: "o", entry: o.entry, name: o.name, type: o.type, value: o.loot_value, count: o.count, total: o.loot_value * o.count })),
  ].sort((a, b) => b.total - a.total).slice(0, 100);
  const farmPoints = isInstance ? null : [
    ...spawns.filter((s) => s.loot_value > 0).map((s) => ({ x: s.x, y: s.y, value: s.loot_value })),
    ...objects.filter((o) => o.loot_value > 0).map((o) => ({ x: o.x, y: o.y, value: o.loot_value })),
  ];

  // representative in-game icon per object = its highest-chance loot item's icon
  // (idx_drops_owner makes the per-object subquery cheap).
  const iconByEntry = new Map();
  if (objs.length) {
    const ph = objs.map(() => "?").join(",");
    const rows = await query(
      `SELECT g.entry, (SELECT di.icon FROM drops d JOIN items i ON i.entry = d.item
         LEFT JOIN item_display_info di ON di.ID = i.display_id
         WHERE d.src='o' AND d.owner = g.data1 ORDER BY d.chance DESC LIMIT 1) AS icon
       FROM gameobjects g WHERE g.entry IN (${ph})`, objs.map((o) => o.entry));
    for (const r of rows) if (r.icon) iconByEntry.set(r.entry, r.icon);
  }

  // per-NPC map toggles: shownNpcs survives table re-render (sort/page)
  const shownNpcs = new Set();
  const npcCols = [
    { label: "NPC", cell: (r) => npcLink(r.entry, r.name) + (r.subname ? ` <span class="muted">&lt;${esc(r.subname)}&gt;</span>` : ""), value: (r) => r.name },
    { label: "Level", num: true, cls: "muted", cell: (r) => lvlRange(r), value: (r) => r.level_max || r.level_min || 0 },
    { label: "Rank", num: true, cls: "muted", cell: (r) => CREATURE_RANK[r.rank] || "Normal", value: (r) => r.rank || 0 },
    { label: "Spawns", num: true, cls: "muted", cell: (r) => r.count, value: (r) => r.count },
    { label: "Map", cls: "mapcol",
      cell: (r) => `<label class="mapchk"><input type="checkbox" data-mapnpc="${r.entry}"${shownNpcs.has(r.entry) ? " checked" : ""}></label>`,
      value: (r) => (shownNpcs.has(r.entry) ? 1 : 0) },
  ];
  const lootCols = [
    { label: "Item", cell: (i) => itemLink(i.entry, i.name, i.quality, i.icon), value: (i) => i.name },
    { label: "iLvl", num: true, cls: "muted", cell: (i) => i.item_level || "", value: (i) => i.item_level || 0 },
    { label: "Req", num: true, cls: "muted", cell: (i) => i.required_level || "", value: (i) => i.required_level || 0 },
  ];
  // per-object map toggles: shownObjects survives table re-render (sort/page)
  const shownObjects = new Set();
  const objCols = [
    { label: "Object", cell: (o) => (iconByEntry.get(o.entry) ? iconImg(iconByEntry.get(o.entry)) : "") + objectLink(o.entry, o.name), value: (o) => o.name },
    { label: "Type", cls: "muted", cell: (o) => GAMEOBJECT_TYPE[o.type] || "", value: (o) => GAMEOBJECT_TYPE[o.type] || "" },
    { label: "Spawns", num: true, cls: "muted", cell: (o) => o.count, value: (o) => o.count },
    { label: "Map", cls: "mapcol",
      cell: (o) => `<label class="mapchk"><input type="checkbox" data-mapobj="${o.entry}"${shownObjects.has(o.entry) ? " checked" : ""}></label>`,
      value: (o) => (shownObjects.has(o.entry) ? 1 : 0) },
  ];
  const bossCols = [
    { label: "Boss", cell: (r) => npcLink(r.boss, r.boss_name), value: (r) => r.boss_name },
    { label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
    { label: "Chance", num: true, cell: (r) => pct(r.chance), value: (r) => r.chance || 0 },
  ];
  const questCols = [
    { label: "Quest", cell: (r) => questLink(r.entry, r.title), value: (r) => r.title },
    { label: "Level", num: true, cls: "muted", cell: (r) => r.level || "", value: (r) => r.level || 0 },
    { label: "Faction", cell: (r) => { const f = questFaction(r.reqraces); return `<span class="tagx fac-${f.toLowerCase()}">${f}</span>`; }, value: (r) => questFaction(r.reqraces) },
    { label: "Quest Giver", cls: "muted", cell: (r) => (r.giver_id ? npcLink(r.giver_id, r.giver) : ""), value: (r) => r.giver || "" },
  ];
  // Farming: best gold targets, sorted by total expected drop value. Each links to
  // its own page where the per-target farming route is shown.
  const farmCols = [
    // link to the target's page focused on THIS zone (&fz) so its map opens here
    { label: "Target", cell: (r) => `<a class="ilink ${r.kind === "c" ? "npc" : "object"}" href="?${r.kind === "c" ? "npc" : "object"}=${r.entry}&fz=${z.areaid}">${esc(r.name)}</a>`, value: (r) => r.name },
    { label: "Type", cls: "muted", cell: (r) => (r.kind === "c" ? "Mob" : (GAMEOBJECT_TYPE[r.type] || "Object")), value: (r) => (r.kind === "c" ? "Mob" : "Object") },
    { label: "Level", num: true, cls: "muted", cell: (r) => (r.kind === "c" ? lvlRange(r) : ""), value: (r) => r.level_max || r.level_min || 0 },
    { label: "Spawns", num: true, cls: "muted", cell: (r) => r.count, value: (r) => r.count },
    { label: "Value/each", num: true, cls: "muted", cell: (r) => moneyHtml(Math.round(r.value)), value: (r) => r.value },
    { label: "Total value", num: true, cell: (r) => moneyHtml(Math.round(r.total)), value: (r) => r.total },
  ];
  const tabDefs = [
    ...(isInstance ? [{ id: "bosses", label: "Boss Loot", ...regTable(bossCols, bossLoot, { pageSize: 500, groupable: true, group: 0 }) }] : []),
    { id: "npcs", label: "NPCs", ...regTable(npcCols, npcs, { pageSize: 100 }) },
    ...(farmRows.length ? [{ id: "farm", label: "Farming", ...regTable(farmCols, farmRows, { pageSize: 100, sort: "Total value", dir: "d" }) }] : []),
    { id: "quests", label: "Quests", ...regTable(questCols, zoneQuests, { pageSize: 100 }) },
    { id: "items", label: "Items", ...regTable(lootCols, loot, { pageSize: 100 }) },
    { id: "objects", label: "Objects", ...regTable(objCols, objs, { pageSize: 100 }) },
  ];

  // A few client-defined zones (e.g. not-yet-populated Turtle areas) have a map
  // texture but no spawns recorded within their bounds -> blank tabs. Show
  // an explanatory note instead.
  const hasData = npcs.length || objs.length || loot.length || bossLoot.length || zoneQuests.length;
  const body = hasData
    ? tabs(tabDefs)
    : `<div class="zone-empty muted">No NPCs, items, or objects are recorded within this
        zone's bounds in the current Tortoise-WoW data. The zone map exists in the client, but
        the server data has no spawns here yet — this is usually a newly added zone that hasn't
        been populated upstream.</div>`;

  // Floor switcher for multi-floor instances (one button per WorldMap floor).
  const floorSwitch = allFloors.length > 1
    ? `<div id="floorswitch" class="floor-switch">${allFloors.map((fl) =>
        `<button data-floor="${fl.areaid}">${esc(fl.name)} <span class="dim">(${floorCount(fl)})</span></button>`).join("")}</div>`
    : "";

  app.innerHTML =
    `<div class="zone-page">
      <div class="npc-head">
        <h1>${esc(z.name)}</h1>
        <div class="npc-meta muted">${meta.join(" · ")}<span class="dim"> · Zone #${z.areaid}</span></div>
      </div>
      ${floorSwitch}
      <div id="zonemap"></div>
      ${body}
    </div>`;
  mountTables();
  wireTabs();
  const el = document.getElementById("zonemap");
  try {
    const { initZoneMap } = await import("./zonemap.js");
    const base = ASSETS_BASE;
    let zmap = null;
    // Keep the tab "show on map" checkbox + shown set in sync with the map/panel —
    // fires both on a tab-checkbox change and when the panel's "Selected" row is
    // unchecked (map -> tab), so the two controls never drift.
    const syncSel = (kind, entry, on) => {
      const set = kind === "npc" ? shownNpcs : shownObjects;
      if (on) set.add(entry); else set.delete(entry);
      const box = app.querySelector(`input[data-map${kind === "npc" ? "npc" : "obj"}="${entry}"]`);
      if (box) box.checked = on;
    };
    // (re)draw the map for a floor: its parchment + the spawns/bosses on it.
    const renderFloor = (fl) => {
      const fs = isInstance ? spawns.filter((s) => s.zone === fl.areaid) : spawns;
      const fo = isInstance ? objects.filter((o) => o.zone === fl.areaid) : objects;
      const fb = isInstance ? bosses.filter((b) => b.zone === fl.areaid) : bosses;
      zmap = initZoneMap(el, { ...fl, imgUrl: `${base}maps/${fl.areaid}.webp` }, fs, fo, navigate, { focus: fl.areaid === z.areaid ? focus : null, bosses: fb, farm: isInstance ? null : farmPoints, onToggle: syncSel });
      app.querySelectorAll("#floorswitch button").forEach((b) => b.classList.toggle("active", Number(b.dataset.floor) === fl.areaid));
    };
    renderFloor(activeFloor);
    const fsw = document.getElementById("floorswitch");
    if (fsw) fsw.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-floor]"); if (!b) return;
      const fl = allFloors.find((f) => f.areaid === Number(b.dataset.floor));
      if (fl) { shownNpcs.clear(); shownObjects.clear(); renderFloor(fl); }
    });
    // Objects tab checkboxes add/remove that object's spawns on the (current) map.
    const objPane = app.querySelector('[data-pane="objects"]');
    if (objPane) objPane.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-mapobj]");
      if (!cb || !zmap) return;
      const entry = Number(cb.dataset.mapobj);
      zmap.toggleObject(entry, cb.checked, iconByEntry.get(entry)); // syncSel updates shownObjects + the box
    });
    // NPCs tab checkboxes do the same for a creature's spawns.
    const npcPane = app.querySelector('[data-pane="npcs"]');
    if (npcPane) npcPane.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-mapnpc]");
      if (!cb || !zmap) return;
      zmap.toggleNpc(Number(cb.dataset.mapnpc), cb.checked); // syncSel updates shownNpcs + the box
    });
  } catch (e) { el.innerHTML = errorBox(e); }
}

async function showDungeons() {
  document.title = "Dungeons & Raids - Tortoise-WoW DB";
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let rows;
  try { rows = await query(Q.Q_DUNGEONS); } catch (e) { app.innerHTML = errorBox(e); return; }
  const cols = [
    { label: "Name", cell: (m) => dungeonLink(m.id, m.name), value: (m) => m.name },
    // recommended character level, derived from elite creature levels (build-db)
    { label: "Level", cls: "muted", num: true, cell: (m) => (m.min_level ? `${m.min_level}–${m.max_level}` : ""), value: (m) => m.min_level || 0 },
    { label: "Type", cls: "muted", cell: (m) => (m.type === 2 ? "Raid" : "Dungeon"), value: (m) => m.type },
  ];
  const t = regTable(cols, rows);
  app.innerHTML = `<div class="results"><h1>Dungeons &amp; Raids</h1>${t.html}</div>`;
  mountTables();
}

// Flight-path world map: a continent parchment with every flight master (faction-
// coloured) + all routes as polylines. ?flights[&cont=0|1]; switch continents.
async function showFlights(mapId = 0) {
  document.title = "Flight Paths - Tortoise-WoW DB";
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let continents, cont, nodes, routeRows;
  try {
    continents = await query(Q.Q_TAXI_CONTINENTS);
    if (!continents.length) { app.innerHTML = `<div class="home"><p>No flight-path data in this build.</p></div>`; return; }
    cont = continents.find((c) => c.map === mapId) || continents[0];
    [nodes, routeRows] = await Promise.all([query(Q.Q_TAXI_NODES, [cont.map]), query(Q.Q_TAXI_ROUTES, [cont.map])]);
  } catch (e) { app.innerHTML = errorBox(e); return; }
  // group route waypoints (ordered) into one polyline per path
  const byPath = new Map();
  for (const r of routeRows) { let g = byPath.get(r.path); if (!g) { g = { faction: r.faction, pts: [] }; byPath.set(r.path, g); } g.pts.push({ x: r.x, y: r.y }); }
  const routes = [...byPath.values()];

  const switcher = `<div id="contswitch" class="floor-switch">${continents.map((c) =>
    `<button data-cont="${c.map}"${c.map === cont.map ? ' class="active"' : ""}>${esc(CONTINENT[c.map] || c.dir)}</button>`).join("")}</div>`;
  const dot = (col, label) => `<span class="flight-leg"><span class="flight-node" style="background:${col};position:static;display:inline-block"></span> ${label}</span>`;
  app.innerHTML = `<div class="zone-page">
    <div class="npc-head"><h1>Flight Paths</h1>
      <div class="npc-meta muted">${nodes.length} flight masters · ${routes.length} routes · ${dot("#5b86ff", "Alliance")} ${dot("#e0524a", "Horde")} ${dot("#ffce4a", "Neutral")}</div>
    </div>
    ${switcher}
    <div id="zonemap"></div>
  </div>`;
  const el = document.getElementById("zonemap");
  try {
    const { initFlightMap } = await import("./zonemap.js");
    initFlightMap(el, { ...cont, imgUrl: `${ASSETS_BASE}maps/continent-${cont.map}.webp` }, nodes, routes, navigate);
  } catch (e) { el.innerHTML = errorBox(e); }
  const csw = document.getElementById("contswitch");
  if (csw) csw.addEventListener("click", (e) => { const b = e.target.closest("button[data-cont]"); if (b) navigate(`?flights&cont=${b.dataset.cont}`); });
}

// Seamless continent minimap (?worldmap=mapid): one zoomable slippy map over the
// client's stitched minimap tiles (R2 pyramid) with every spawn reprojected onto
// it. Categories live in the layer control (default off) -- a continent has tens of
// thousands of spawns, so opt-in keeps the initial view clean + fast.
async function showWorldMap(mapId = 0) {
  const maps = minimapManifest.maps || {};
  const ids = Object.keys(maps).map(Number).sort((a, b) => a - b);
  if (!ids.length) { app.innerHTML = `<div class="home"><p>No world-map data in this build.</p></div>`; return; }
  if (!maps[String(mapId)]) mapId = ids[0];
  const m = maps[String(mapId)];
  document.title = `${m.name} Map - Tortoise-WoW DB`;
  app.innerHTML = `<div class="loading">Loading…</div>`;

  // Kick off the (large) zonemap chunk download NOW so it overlaps the DB query +
  // worker round-trip instead of waiting for them (the chunk req otherwise sits in
  // a ~1s network-idle gap after the spawns resolve).
  const zonemapMod = import("./zonemap.js");
  let spawns, objects, zones;
  try {
    [spawns, objects, zones] = await Promise.all([
      query(Q.Q_WORLD_SPAWNS, [mapId]), query(Q.Q_WORLD_OBJECTS, [mapId]), query(Q.Q_CONTINENT_ZONES, [mapId])]);
  } catch (e) { app.innerHTML = errorBox(e); return; }

  const switcher = `<div id="contswitch" class="floor-switch">${ids.map((id) =>
    `<button data-cont="${id}"${id === mapId ? ' class="active"' : ""}>${esc(maps[String(id)].name)}</button>`).join("")}</div>`;
  app.innerHTML = `<div class="zone-page">
    <div class="npc-head"><h1>${esc(m.name)} <span class="dim">— World Map</span></h1>
      <div class="npc-meta muted">${spawns.length.toLocaleString()} creature spawns · ${objects.length.toLocaleString()} objects</div>
    </div>
    ${switcher}
    <div id="zonemap"></div>
  </div>`;
  const el = document.getElementById("zonemap");
  // Restore map state from the URL (so browser Back recreates layers + view), and
  // mirror changes back via replaceState (no new history entry, like browse pages).
  const p = new URLSearchParams(location.search);
  const initial = {
    cats: (p.get("cats") || "").split(",").filter(Boolean),
    z: p.get("z") != null ? Number(p.get("z")) : null,
    c: p.get("c") ? p.get("c").split(",").map(Number) : null,
    focus: p.get("focus") != null ? Number(p.get("focus")) : null,
    q: p.get("q") || "",
  };
  const onState = (s) => {
    const np = new URLSearchParams(location.search);
    np.set("worldmap", String(mapId));
    if (s.cats && s.cats.length) np.set("cats", s.cats.join(",")); else np.delete("cats");
    if (s.z != null) np.set("z", String(s.z)); else np.delete("z");
    if (s.c) np.set("c", s.c.join(",")); else np.delete("c");
    if (s.focus != null) np.set("focus", String(s.focus)); else np.delete("focus");
    if (s.q) np.set("q", s.q); else np.delete("q");
    history.replaceState({}, "", "?" + np.toString());
  };
  // FTS npc filter for the map: prefix + trigram MATCH (same indexes as global
  // search) -> the Set of matching creature entries the map narrows its markers to.
  const searchNpcs = async (term) => {
    const toks = term.toLowerCase().match(/[a-z0-9]+/g);
    if (!toks || !toks.length) return null;
    const fts = toks.map((t) => `${t}*`).join(" ");
    const tg = toks.filter((t) => t.length >= 3).map((t) => `"${t}"`).join(" AND ") || '"qzqzqzq"';
    const rows = await query(Q.Q_WORLD_NPC_FILTER, [fts, tg]);
    return new Set(rows.map((r) => r.entry));
  };
  try {
    const { initWorldMap } = await zonemapMod;
    initWorldMap(el, {
      mapId, name: m.name, bbox: m.bbox,
      tile: minimapManifest.tile, adt: minimapManifest.adt, grid: minimapManifest.grid,
      maxNativeZoom: minimapManifest.maxNativeZoom, tilesBase: `${ASSETS_BASE}minimap/`,
    }, spawns, objects, navigate, { zones, initial, onState, searchNpcs });
  } catch (e) { el.innerHTML = errorBox(e); }
  const csw = document.getElementById("contswitch");
  if (csw) csw.addEventListener("click", (e) => { const b = e.target.closest("button[data-cont]"); if (b) navigate(`?worldmap=${b.dataset.cont}`); });
}

// Legacy ?dungeon=<mapid> route. Dungeons/raids are now rendered by the unified
// zone view, so redirect to the instance's WorldMap zone (?zone=areaid). The few
// instances with no WorldMap parchment (e.g. Dire Maul) have no zone -> render a
// map-less instance page here as a fallback.
async function showDungeon(id) {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let zone;
  try { zone = await queryOne(Q.Q_DUNGEON_ZONE, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (zone && zone.areaid) { navigate(`?zone=${zone.areaid}`, true); return; }

  let map;
  try { map = await queryOne(Q.Q_DUNGEON, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!map) { app.innerHTML = `<div class="home"><p>No dungeon with map ID ${id}.</p></div>`; return; }
  document.title = `${map.name} - Tortoise-WoW DB`;
  const typeLabel = map.type === 2 ? "Raid" : "Dungeon";
  const [bossLoot, npcs, loot, dquests] = await Promise.all([
    query(Q.Q_DUNGEON_BOSS_LOOT, [id]), query(Q.Q_DUNGEON_NPCS, [id]), query(Q.Q_DUNGEON_LOOT, [id]),
    query(Q.Q_DUNGEON_QUESTS, [id, map.name]),
  ]);

  const bossCols = [
    { label: "Boss", cell: (r) => npcLink(r.boss, r.boss_name), value: (r) => r.boss_name },
    { label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
    { label: "Chance", num: true, cell: (r) => pct(r.chance), value: (r) => r.chance || 0 },
  ];
  const npcCols = [
    { label: "NPC", cell: (c) => npcLink(c.entry, c.name) + (c.subname ? ` <span class="muted">&lt;${esc(c.subname)}&gt;</span>` : ""), value: (c) => c.name },
    { label: "Level", num: true, cls: "muted", cell: (c) => lvlRange(c), value: (c) => c.level_max || c.level_min || 0 },
    { label: "Rank", num: true, cls: "muted", cell: (c) => CREATURE_RANK[c.rank] || "Normal", value: (c) => c.rank || 0 },
  ];
  const lootCols = [
    { label: "Item", cell: (i) => itemLink(i.entry, i.name, i.quality, i.icon), value: (i) => i.name },
    { label: "iLvl", num: true, cls: "muted", cell: (i) => i.item_level || "", value: (i) => i.item_level || 0 },
    { label: "Req", num: true, cls: "muted", cell: (i) => i.required_level || "", value: (i) => i.required_level || 0 },
  ];
  const questCols = [
    { label: "Quest", cell: (r) => questLink(r.entry, r.title), value: (r) => r.title },
    { label: "Level", num: true, cls: "muted", cell: (r) => r.level || "", value: (r) => r.level || 0 },
    { label: "Faction", cell: (r) => { const f = questFaction(r.reqraces); return `<span class="tagx fac-${f.toLowerCase()}">${f}</span>`; }, value: (r) => questFaction(r.reqraces) },
    { label: "Quest Giver", cls: "muted", cell: (r) => (r.giver_id ? npcLink(r.giver_id, r.giver) : ""), value: (r) => r.giver || "" },
  ];
  const tabDefs = [
    { id: "bosses", label: "Boss Loot", ...regTable(bossCols, bossLoot, { pageSize: 500, groupable: true, group: 0 }) },
    { id: "npcs", label: "Creatures", ...regTable(npcCols, npcs) },
    { id: "quests", label: "Quests", ...regTable(questCols, dquests, { pageSize: 100 }) },
    { id: "loot", label: "All Loot", ...regTable(lootCols, loot, { pageSize: 200 }) },
  ];

  app.innerHTML =
    `<div class="npc-page zone-page">
      <div class="npc-head">
        <h1>${esc(map.name)}</h1>
        <div class="npc-meta muted">${typeLabel} · Map #${map.id}</div>
      </div>
      ${tabs(tabDefs)}
    </div>`;
  mountTables();
  wireTabs();
}

function errorBox(e) {
  return `<div class="error">Failed: ${esc(e.message || e)}</div>`;
}

// Load the Turtle custom-icon sprite-sheet manifest, then resolve `url` against
// the app base so render.js can draw custom icons (no-op if absent).
async function loadIconAtlas() {
  try {
    const base = ASSETS_BASE;
    const res = await fetch(`${base}icons/custom-atlas.json`);
    if (!res.ok) return;
    const m = await res.json();
    setIconAtlas({ ...m, url: `${base}icons/custom-atlas.webp` });
  } catch { /* fall back to CDN icons */ }
}

// Footer: "Updated <build date>" (from version.json's builtAt) + how long the
// first page render took (performance.now() = ms since navigation start). Set once
// on boot; the footer persists across SPA navigation so it reflects initial load.
async function showFooterMeta(loadMs) {
  const load = document.getElementById("footLoad");
  if (load) load.textContent = `Loaded in ${loadMs < 1000 ? `${Math.round(loadMs)} ms` : `${(loadMs / 1000).toFixed(1)} s`}`;
  const upd = document.getElementById("footUpdated");
  if (!upd) return;
  try {
    const { builtAt } = await getMeta();
    if (!builtAt) return;
    const d = new Date(builtAt);
    if (isNaN(d)) return;
    upd.textContent = `Updated ${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
    upd.title = d.toLocaleString();
  } catch { /* no build stamp -> omit */ }
}

// ---- boot ----
// Resolve the asset origin first (probe R2, fall over to the Pages mirror if it's
// blocked) so nothing below reads DATA_BASE/ASSETS_BASE before they're settled.
resolveOrigins().finally(() => {
  preconnect();
  initHovercards();
  initSearchDropdown(searchInput, document.getElementById("searchForm"), navigate);
  // Wait for the atlas (small JSON) so the first paint shows custom icons; route
  // anyway if it fails or is missing. Time the first render for the footer.
  loadIconAtlas()
    .then(renderRoute, renderRoute)
    .finally(() => showFooterMeta(performance.now()));
});
