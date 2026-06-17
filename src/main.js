import "./style.css";
import { query, queryOne, preconnect } from "./db.js";
import * as Q from "./queries.js";
import { renderTooltip, tabs, itemLink, npcLink, dungeonLink, iconImg, sourceTags, pct, esc } from "./render.js";
import { createTable } from "./table.js";
import { CREATURE_TYPE, CREATURE_RANK, npcRoles } from "./constants.js";
import { showBrowse } from "./browse.js";
import { initHovercards } from "./hovercard.js";

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
function navigate(url, replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  route();
}
window.addEventListener("popstate", route);

document.addEventListener("click", (e) => {
  const a = e.target.closest("a.ilink, a.nav");
  if (a && a.origin === location.origin) {
    e.preventDefault();
    navigate(a.getAttribute("href"));
  }
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
  const dungeon = params.get("dungeon");
  const browse = params.get("browse");
  const term = params.get("search");
  if (item) showItem(Number(item));
  else if (npc) showNpc(Number(npc));
  else if (dungeon) showDungeon(Number(dungeon));
  else if (params.get("dungeons") !== null) showDungeons();
  else if (browse) showBrowse(browse, navigate);
  else if (term) { searchInput.value = term; showSearch(term); }
  else showHome();
}

// ---- views ----
function showHome() {
  document.title = "Tortoise-WoW Database";
  app.innerHTML = `<div class="home">
    <h1>Tortoise-WoW Database</h1>
    <p>Search above, or browse <a class="nav" href="?browse=items">items</a> /
       <a class="nav" href="?browse=npcs">NPCs</a> /
       <a class="nav" href="?dungeons">dungeons &amp; raids</a>.
       Open directly with <code>?item=ID</code>, <code>?npc=ID</code>, or <code>?dungeon=ID</code>.</p>
    <p class="muted">Examples:
      <a class="ilink" href="?item=2770">Copper Ore</a> ·
      <a class="ilink" href="?item=7909">Aquamarine</a> ·
      <a class="ilink" href="?npc=2376">Torn Fin Oracle</a></p>
  </div>`;
}

async function showSearch(term) {
  document.title = `Search: ${term}`;
  app.innerHTML = `<div class="loading">Searching…</div>`;
  let rows;
  try { rows = await query(Q.Q_SEARCH, [`%${term}%`, term]); }
  catch (e) { app.innerHTML = errorBox(e); return; }
  if (!rows.length) { app.innerHTML = `<div class="home"><p>No items match “${esc(term)}”.</p></div>`; return; }
  const cols = [
    { label: "Name", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
    { label: "iLvl", num: true, cls: "muted", cell: (r) => r.item_level || "", value: (r) => r.item_level || 0 },
    { label: "Req", num: true, cls: "muted", cell: (r) => r.required_level || "", value: (r) => r.required_level || 0 },
    { label: "ID", num: true, cls: "muted", cell: (r) => r.entry, value: (r) => r.entry },
  ];
  const t = regTable(cols, rows, { pageSize: 100 });
  app.innerHTML = `<div class="results"><h1>Results for “${esc(term)}”</h1>${t.html}</div>`;
  mountTables();
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

  const [dropped, objects, sold, contained, disen, quests, starts, createdBy, reagentFor, srcRows] =
    await Promise.all([
      query(Q.Q_DROPPED_BY, [id]), query(Q.Q_OBJECT_SOURCE, [id]), query(Q.Q_SOLD_BY, [id]),
      query(Q.Q_CONTAINED_IN, [id]), query(Q.Q_DISENCHANTS_INTO, [id]), query(Q.Q_QUEST_ITEM, [id]),
      query(Q.Q_STARTS_QUEST, [id]), query(Q.Q_CREATED_BY, [id]), query(Q.Q_REAGENT_FOR, [id]),
      query(Q.Q_ITEM_SOURCES, [id]),
    ]);
  const srcCsv = srcRows.map((r) => r.source).join(",");

  const dchance = (d) => d.drop_chance ?? d.skin_chance ?? d.pick_chance;
  const srcTag = (d) => (d.skin_chance != null ? ' <span class="muted">(skin)</span>' : d.pick_chance != null ? ' <span class="muted">(pickpocket)</span>' : "");
  const droppedCols = [
    { label: "NPC", cell: (d) => npcLink(d.entry, d.name) + srcTag(d), value: (d) => d.name },
    { label: "Level", num: true, cls: "muted", cell: (d) => lvlRange(d), value: (d) => d.level_max || d.level_min || 0 },
    { label: "Location", cls: "muted", cell: (d) => (d.dungeon ? dungeonLink(d.dungeon_id, d.dungeon) : ""), value: (d) => d.dungeon || "" },
    { label: "Chance", num: true, cell: (d) => pct(dchance(d)), value: (d) => dchance(d) || 0 },
  ];
  const objectCols = [
    { label: "Object", cell: (o) => esc(o.name), value: (o) => o.name },
    { label: "Chance", num: true, cell: (o) => pct(o.chance), value: (o) => o.chance || 0 },
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
    { label: "Quest", cell: (q) => esc(q.title) + (showChoice && q.role === "choice" ? ' <span class="muted">(choice)</span>' : ""), value: (q) => q.title },
    { label: "Level", num: true, cls: "muted", cell: (q) => q.level || "", value: (q) => q.level || 0 },
    ...(showQty ? [{ label: "Qty", num: true, cls: "muted", cell: (q) => q.count, value: (q) => q.count || 0 }] : []),
  ];
  const reagentForCols = [
    { label: "Creates", cell: (r) => itemLink(r.created, r.created_name, r.quality, r.created_icon), value: (r) => r.created_name },
    { label: "Via spell", cls: "muted", cell: (r) => esc(r.spell_name), value: (r) => r.spell_name },
  ];

  // created-by: group reagents per spell
  const bySpell = new Map();
  for (const r of createdBy) {
    if (!bySpell.has(r.entry)) bySpell.set(r.entry, { name: r.name, reagents: [] });
    if (r.reagent_item) bySpell.get(r.entry).reagents.push(`${iconImg(r.reagent_icon)}${esc(r.reagent_name)} ×${r.count || 1}`);
  }
  const createdRows = [...bySpell.values()];
  const createdCols = [
    { label: "Spell", cell: (s) => esc(s.name), value: (s) => s.name },
    { label: "Reagents", cls: "muted", cell: (s) => s.reagents.join(", "), value: (s) => s.reagents.length },
  ];

  const reqQuests = quests.filter((q) => q.role === "req");
  const rewQuests = quests.filter((q) => q.role !== "req");

  const tabDefs = [
    { id: "dropped", label: "Dropped by", ...regTable(droppedCols, dropped, { groupable: true }) },
    { id: "object", label: "Found in object", ...regTable(objectCols, objects) },
    { id: "sold", label: "Sold by", ...regTable(soldCols, sold) },
    { id: "contained", label: "Contained in", ...regTable(itemChanceCols, contained) },
    { id: "disen", label: "Disenchants into", ...regTable(disenCols, disen) },
    { id: "reward", label: "Reward from quest", ...regTable(questCols(false, true), rewQuests) },
    { id: "reqquest", label: "Required for quest", ...regTable(questCols(true, false), reqQuests) },
    { id: "starts", label: "Starts quest", ...regTable(questCols(false, false), starts) },
    { id: "created", label: "Created by", ...regTable(createdCols, createdRows) },
    { id: "reagent", label: "Reagent for", ...regTable(reagentForCols, reagentFor.filter((r) => r.created)) },
  ];

  app.innerHTML =
    `<div class="item-view">
      <div class="item-main">${renderTooltip(it, { spellMap })}
        <div class="item-meta muted">Item #${it.entry} · iLvl ${it.item_level || "—"}</div>
        ${srcCsv ? `<div class="item-sources">${sourceTags(srcCsv)}</div>` : ""}
      </div>
      <div class="item-rel">${tabs(tabDefs)}</div>
    </div>`;
  mountTables();
  wireTabs();
}

async function showNpc(id) {
  app.innerHTML = `<div class="loading">Loading NPC ${id}…</div>`;
  let npc;
  try { npc = await queryOne(Q.Q_NPC, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!npc) { app.innerHTML = `<div class="home"><p>No NPC with ID ${id}.</p></div>`; return; }
  document.title = `${npc.name} - Tortoise-WoW DB`;

  const [loot, skin, pick, sells, starts, ends, maps] = await Promise.all([
    query(Q.Q_NPC_LOOT, [id]), query(Q.Q_NPC_SKIN, [id]), query(Q.Q_NPC_PICK, [id]),
    query(Q.Q_NPC_SELLS, [id]), query(Q.Q_NPC_STARTS, [id]), query(Q.Q_NPC_ENDS, [id]),
    query(Q.Q_NPC_MAPS, [id]),
  ]);
  const mapHtml = maps.map((m) => {
    const tag = m.type === 2 ? "Raid" : m.type === 1 ? "Dungeon" : null;
    const nm = tag ? dungeonLink(m.id, m.name) : esc(m.name);
    return tag ? `${nm} <span class="dim">(${tag})</span>` : nm;
  }).join(", ");

  const lvl = lvlRange(npc) || "??";
  const bits = [`Level ${lvl}`];
  if (CREATURE_RANK[npc.rank]) bits.push(CREATURE_RANK[npc.rank]);
  if (CREATURE_TYPE[npc.type]) bits.push(`<a class="nav" href="?browse=npcs&type=${npc.type}">${CREATURE_TYPE[npc.type]}</a>`);
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
    { label: "Quest", cell: (q) => esc(q.title), value: (q) => q.title },
    { label: "Level", num: true, cls: "muted", cell: (q) => q.level || "", value: (q) => q.level || 0 },
  ];

  const tabDefs = [
    { id: "drops", label: "Drops", ...regTable(lootCols, loot) },
    { id: "skinning", label: "Skinning", ...regTable(lootCols, skin) },
    { id: "pickpocketing", label: "Pickpocketing", ...regTable(lootCols, pick) },
    { id: "sells", label: "Sells", ...regTable(sellCols, sells) },
    { id: "starts", label: "Starts quests", ...regTable(questCols, starts) },
    { id: "ends", label: "Ends quests", ...regTable(questCols, ends) },
  ];

  app.innerHTML =
    `<div class="npc-page">
      <div class="npc-head">
        <h1 class="${rankClass}">${esc(npc.name)}</h1>
        ${npc.subname ? `<span class="npc-sub muted">&lt;${esc(npc.subname)}&gt;</span>` : ""}
        <div class="npc-meta muted">${bits.join(" · ")}${hp ? " · " + hp : ""}
          ${roles.map((r) => `<span class="tagx">${esc(r)}</span>`).join("")}
          <span class="dim">· NPC #${npc.entry}</span></div>
        ${mapHtml ? `<div class="npc-meta muted">Location: ${mapHtml}</div>` : ""}
      </div>
      ${tabs(tabDefs)}
    </div>`;
  mountTables();
  wireTabs();
}

async function showDungeons() {
  document.title = "Dungeons & Raids - Tortoise-WoW DB";
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let rows;
  try { rows = await query(Q.Q_DUNGEONS); } catch (e) { app.innerHTML = errorBox(e); return; }
  const cols = [
    { label: "Name", cell: (m) => dungeonLink(m.id, m.name), value: (m) => m.name },
    { label: "Type", cls: "muted", cell: (m) => (m.type === 2 ? "Raid" : "Dungeon"), value: (m) => m.type },
  ];
  const t = regTable(cols, rows);
  app.innerHTML = `<div class="results"><h1>Dungeons &amp; Raids</h1>${t.html}</div>`;
  mountTables();
}

async function showDungeon(id) {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let map;
  try { map = await queryOne(Q.Q_DUNGEON, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!map) { app.innerHTML = `<div class="home"><p>No map with ID ${id}.</p></div>`; return; }
  document.title = `${map.name} - Tortoise-WoW DB`;
  const [bossLoot, npcs, loot] = await Promise.all([
    query(Q.Q_DUNGEON_BOSS_LOOT, [id]), query(Q.Q_DUNGEON_NPCS, [id]), query(Q.Q_DUNGEON_LOOT, [id]),
  ]);
  const typeLabel = map.type === 2 ? "Raid" : "Dungeon";

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
  const tabDefs = [
    { id: "bosses", label: "Boss Loot", ...regTable(bossCols, bossLoot, { pageSize: 500, groupable: true, group: 0 }) },
    { id: "npcs", label: "Creatures", ...regTable(npcCols, npcs) },
    { id: "loot", label: "All Loot", ...regTable(lootCols, loot, { pageSize: 200 }) },
  ];

  app.innerHTML =
    `<div class="npc-page">
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

// ---- boot ----
preconnect();
initHovercards();
route();
