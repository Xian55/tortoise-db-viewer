import "./style.css";
import { query, queryOne, preconnect } from "./db.js";
import * as Q from "./queries.js";
import { renderTooltip, tabs, itemLink, npcLink, dungeonLink, questLink, factionLink, zoneLink, moneyHtml, iconImg, sourceTags, pct, esc, setIconAtlas } from "./render.js";
import { createTable } from "./table.js";
import { CREATURE_TYPE, CREATURE_RANK, PROFESSION_LABEL, QUEST_TYPE, REP_STANDING, CONTINENT, GAMEOBJECT_TYPE, questZoneLabel, classRestrictions, raceRestrictions, npcRoles } from "./constants.js";
import { showBrowse } from "./browse.js";
import { initHovercards } from "./hovercard.js";
import { runSearch, initSearchDropdown } from "./search.js";

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
  window.scrollTo(0, 0); // new view starts at the top (SPA nav keeps scroll otherwise)
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
  const quest = params.get("quest");
  const faction = params.get("faction");
  const zone = params.get("zone");
  const dungeon = params.get("dungeon");
  const browse = params.get("browse");
  const term = params.get("search");
  // Browse first: browse URLs carry filter params (e.g. faction=a|h) that would
  // otherwise collide with the singular entity-detail routes below.
  if (browse) showBrowse(browse, navigate);
  else if (item) showItem(Number(item));
  else if (npc) showNpc(Number(npc));
  else if (quest) showQuest(Number(quest));
  else if (faction) showFaction(Number(faction));
  else if (zone) showZone(Number(zone), params.get("gather") ? Number(params.get("gather")) : null);
  else if (dungeon) showDungeon(Number(dungeon));
  else if (params.get("dungeons") !== null) showDungeons();
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
       <a class="nav" href="?browse=quests">quests</a> /
       <a class="nav" href="?browse=factions">factions</a> /
       <a class="nav" href="?browse=zones">zones</a> /
       <a class="nav" href="?dungeons">dungeons &amp; raids</a>.
       Open directly with <code>?item=ID</code>, <code>?npc=ID</code>, <code>?quest=ID</code>, <code>?faction=ID</code>, or <code>?dungeon=ID</code>.</p>
    <p class="muted">Examples:
      <a class="ilink" href="?item=2770">Copper Ore</a> ·
      <a class="ilink" href="?item=7909">Aquamarine</a> ·
      <a class="ilink" href="?npc=2376">Torn Fin Oracle</a></p>
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
  // Resolve a representative zone per NPC result (the largest WMA box that
  // contains one of its spawns -- same heuristic as the NPC detail page).
  const npcZone = new Map();
  if (res.npcs.length) {
    const ids = res.npcs.map((n) => n.entry);
    const ph = ids.map(() => "?").join(",");
    const rows = await query(`SELECT entry, areaid, name FROM (
        SELECT s.id AS entry, z.areaid, z.name,
          ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY (z.loctop - z.locbottom) * (z.locleft - z.locright) DESC) AS rn
        FROM spawn_points s INDEXED BY idx_spawn_id
        JOIN zones z ON z.mapid = s.map AND s.x BETWEEN z.locbottom AND z.loctop AND s.y BETWEEN z.locright AND z.locleft
        WHERE s.kind = 'c' AND s.id IN (${ph}) AND z.name <> ''
      ) WHERE rn = 1`, ids);
    for (const r of rows) npcZone.set(r.entry, r);
  }
  const npcCols = [
    { label: "Name", cell: (r) => npcLink(r.entry, r.name), value: (r) => r.name },
    { label: "Level", num: true, cls: "muted", cell: (r) => lvlRange(r), value: (r) => r.level_max || r.level_min || 0 },
    { label: "Rank", num: true, cls: "muted", cell: (r) => CREATURE_RANK[r.rank] || "Normal", value: (r) => r.rank || 0 },
    { label: "Location", cls: "muted", cell: (r) => { const z = npcZone.get(r.entry); return z ? zoneLink(z.areaid, z.name) : ""; }, value: (r) => npcZone.get(r.entry)?.name || "" },
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
  const zoneCols = [
    { label: "Name", cell: (r) => zoneLink(r.areaid, r.name), value: (r) => r.name },
    { label: "Continent", cls: "muted", cell: (r) => CONTINENT[r.mapid] || "", value: (r) => CONTINENT[r.mapid] || "" },
  ];

  const tabDefs = [
    { id: "items", label: "Items", ...regTable(itemCols, res.items, { pageSize: 100 }) },
    { id: "npcs", label: "NPCs", ...regTable(npcCols, res.npcs, { pageSize: 100 }) },
    { id: "quests", label: "Quests", ...regTable(questCols, res.quests, { pageSize: 100 }) },
    { id: "dungeons", label: "Dungeons", ...regTable(dungeonCols, res.dungeons) },
    { id: "zones", label: "Zones", ...regTable(zoneCols, res.zones) },
  ];
  const total = res.items.length + res.npcs.length + res.quests.length + res.dungeons.length + res.zones.length;
  if (!total) { app.innerHTML = `<div class="home"><p>No results for “${esc(term)}”.</p></div>`; return; }

  app.innerHTML = `<div class="results"><h1>Results for “${esc(term)}”</h1>${tabs(tabDefs)}</div>`;
  mountTables();
  wireTabs();
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

  const [dropped, objects, sold, contained, contains, disen, quests, starts, createdBy, reagentFor, teaches, srcRows, gatherSpawns] =
    await Promise.all([
      query(Q.Q_DROPPED_BY, [id]), query(Q.Q_OBJECT_SOURCE, [id]), query(Q.Q_SOLD_BY, [id]),
      query(Q.Q_CONTAINED_IN, [id]), query(Q.Q_CONTAINS, [id]), query(Q.Q_DISENCHANTS_INTO, [id]), query(Q.Q_QUEST_ITEM, [id]),
      query(Q.Q_STARTS_QUEST, [id]), query(Q.Q_CREATED_BY, [id]), query(Q.Q_REAGENT_FOR, [id]),
      query(Q.Q_TEACHES, [id]), query(Q.Q_ITEM_SOURCES, [id]), query(Q.Q_ITEM_OBJECT_SPAWNS, [id]),
    ]);
  const srcCsv = srcRows.map((r) => r.source).join(",");

  // Gathering breakdown: assign each node spawn to its zone (largest containing
  // WMA box), count per (object, zone) -> best farm zones (wowhead-style list).
  let gatherRows = [];
  if (gatherSpawns.length) {
    const boxes = await query(Q.Q_ZONE_BOXES);
    const agg = new Map();
    for (const p of gatherSpawns) {
      let best = null, bestA = -1;
      for (const z of boxes) {
        if (z.mapid !== p.map || p.x < z.locbottom || p.x > z.loctop || p.y < z.locright || p.y > z.locleft) continue;
        const a = (z.loctop - z.locbottom) * (z.locleft - z.locright);
        if (a > bestA) { bestA = a; best = z; }
      }
      const areaid = best ? best.areaid : 0, zone = best ? best.name : (CONTINENT[p.map] || "Unknown");
      const key = `${p.name}|${areaid}`;
      const g = agg.get(key) || { object: p.name, areaid, zone, count: 0 };
      g.count++; agg.set(key, g);
    }
    gatherRows = [...agg.values()].sort((a, b) => b.count - a.count);
  }

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
  const gatherCols = [
    { label: "Object", cell: (r) => esc(r.object), value: (r) => r.object },
    // zone link carries &gather=<item> so the zone map opens focused on this node
    { label: "Zone", cell: (r) => (r.areaid ? `<a class="ilink zone" href="?zone=${r.areaid}&gather=${id}">${esc(r.zone)}</a>` : esc(r.zone)), value: (r) => r.zone },
    { label: "Spawns", num: true, cell: (r) => r.count, value: (r) => r.count },
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
    ...(showQty ? [{ label: "Qty", num: true, cls: "muted", cell: (q) => q.count, value: (q) => q.count || 0 }] : []),
  ];
  const reagentForCols = [
    { label: "Creates", cell: (r) => itemLink(r.created, r.created_name, r.quality, r.created_icon), value: (r) => r.created_name },
    { label: "Via spell", cls: "muted", cell: (r) => esc(r.spell_name), value: (r) => r.spell_name },
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
      name: r.name, skill: r.skill, req: r.skill_req,
      recipe_item: r.recipe_item, recipe_name: r.recipe_name, recipe_quality: r.recipe_quality, recipe_icon: r.recipe_icon,
      trainer: r.trainer, auto: r.auto, reagents: [],
    });
    if (r.reagent_item) bySpell.get(r.entry).reagents.push(`${itemLink(r.reagent_item, r.reagent_name, r.reagent_quality, r.reagent_icon)} ×${r.count || 1}`);
  }
  const createdRows = [...bySpell.values()];
  const profOf = (s) => PROFESSION_LABEL[s.skill] || "";
  const createdCols = [
    { label: "Spell", cell: (s) => esc(s.name), value: (s) => s.name },
    // profession links to the crafting browse filtered to that profession
    { label: "Profession", cls: "muted", cell: (s) => (profOf(s) ? `<a class="nav" href="?browse=crafting&prof=${s.skill}">${esc(profOf(s))}</a>` + (s.req > 1 ? ` <span class="dim">(${s.req})</span>` : "") : ""), value: (s) => profOf(s) },
    { label: "Reagents", cls: "muted", cell: (s) => s.reagents.join(", "), value: (s) => s.reagents.length },
    // how the craft is learned: the recipe/pattern item, or Trainer / Auto
    { label: "Source", cls: "muted", cell: (s) => (s.recipe_item ? itemLink(s.recipe_item, s.recipe_name, s.recipe_quality, s.recipe_icon)
      : s.trainer ? `<span class="tagx src-crafted">Trainer</span>`
        : s.auto ? `<span class="tagx" title="Learned automatically with the profession">Auto</span>` : "—"),
      value: (s) => (s.recipe_item ? s.recipe_name || "Recipe" : s.trainer ? "Trainer" : s.auto ? "Auto" : "") },
  ];

  const reqQuests = quests.filter((q) => q.role === "req");
  const rewQuests = quests.filter((q) => q.role !== "req");

  const tabDefs = [
    { id: "dropped", label: "Dropped by", ...regTable(droppedCols, dropped, { groupable: true }) },
    { id: "object", label: "Found in object", ...regTable(objectCols, objects) },
    { id: "gather", label: "Gathered in", ...regTable(gatherCols, gatherRows, { pageSize: 200, groupable: true, group: 0, sort: "Spawns", dir: "d" }) },
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

  const [loot, skin, pick, sells, starts, ends, objectiveOf, maps, zoneCand] = await Promise.all([
    query(Q.Q_NPC_LOOT, [id]), query(Q.Q_NPC_SKIN, [id]), query(Q.Q_NPC_PICK, [id]),
    query(Q.Q_NPC_SELLS, [id]), query(Q.Q_NPC_STARTS, [id]), query(Q.Q_NPC_ENDS, [id]),
    query(Q.Q_NPC_OBJECTIVE_OF, [id]), query(Q.Q_NPC_MAPS, [id]), query(Q.Q_NPC_ZONES, [id]),
  ]);
  // Resolve the open-world zone per continent. WMA boxes overlap at borders and
  // the dumps lack true coord->area, so among the boxes containing a spawn we take
  // the largest = the encompassing zone (e.g. Camp Taurajo -> The Barrens, not the
  // clipped Mulgore corner; cities resolve to their parent zone).
  const zoneByMap = {};
  for (const z of zoneCand) {
    const area = (z.loctop - z.locbottom) * (z.locleft - z.locright);
    if (!zoneByMap[z.mapid] || area > zoneByMap[z.mapid].area) zoneByMap[z.mapid] = { ...z, area };
  }
  const mapHtml = maps.map((m) => {
    const tag = m.type === 2 ? "Raid" : m.type === 1 ? "Dungeon" : null;
    if (tag) return `${dungeonLink(m.id, m.name)} <span class="dim">(${tag})</span>`;
    // continent: append the resolved zone link -> "Kalimdor › The Barrens"
    const z = zoneByMap[m.id];
    return `${esc(m.name)}${z ? ` <span class="dim">›</span> ${zoneLink(z.areaid, z.name)}` : ""}`;
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
    { label: "Quest", cell: (q) => questLink(q.entry, q.title), value: (q) => q.title },
    { label: "Level", num: true, cls: "muted", cell: (q) => q.level || "", value: (q) => q.level || 0 },
  ];
  const objectiveCols = [
    { label: "Quest", cell: (q) => questLink(q.entry, q.title), value: (q) => q.title },
    { label: "Level", num: true, cls: "muted", cell: (q) => q.level || "", value: (q) => q.level || 0 },
    { label: "Needed", num: true, cls: "muted", cell: (q) => (q.count > 1 ? q.count : ""), value: (q) => q.count || 0 },
  ];

  const tabDefs = [
    { id: "drops", label: "Drops", ...regTable(lootCols, loot) },
    { id: "skinning", label: "Skinning", ...regTable(lootCols, skin) },
    { id: "pickpocketing", label: "Pickpocketing", ...regTable(lootCols, pick) },
    { id: "sells", label: "Sells", ...regTable(sellCols, sells) },
    { id: "starts", label: "Starts quests", ...regTable(questCols, starts) },
    { id: "ends", label: "Ends quests", ...regTable(questCols, ends) },
    { id: "objective", label: "Objective of", ...regTable(objectiveCols, objectiveOf) },
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

async function showQuest(id) {
  app.innerHTML = `<div class="loading">Loading quest ${id}…</div>`;
  let q;
  try { q = await queryOne(Q.Q_QUEST, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!q) { app.innerHTML = `<div class="home"><p>No quest with ID ${id}.</p></div>`; return; }
  document.title = `${q.title} - Tortoise-WoW DB`;

  const [giversN, endersN, giversG, endersG, qitems, qcreatures, qrep, rewSpell, prev, next] =
    await Promise.all([
      query(Q.Q_QUEST_GIVERS_NPC, [id]), query(Q.Q_QUEST_ENDERS_NPC, [id]),
      query(Q.Q_QUEST_GIVERS_GO, [id]), query(Q.Q_QUEST_ENDERS_GO, [id]),
      query(Q.Q_QUEST_ITEMS, [id]), query(Q.Q_QUEST_CREATURES, [id]), query(Q.Q_QUEST_REP, [id]),
      q.rewspell ? queryOne(Q.Q_SPELL, [q.rewspell]) : null,
      q.prevquest > 0 ? queryOne(Q.Q_QUEST_BRIEF, [q.prevquest]) : null,
      q.nextquest > 0 ? queryOne(Q.Q_QUEST_BRIEF, [q.nextquest]) : null,
    ]);

  const byRole = (role) => qitems.filter((r) => r.role === role);

  // ---- header meta ----
  const bits = [];
  if (q.level > 0) bits.push(`Level ${q.level}`);
  if (q.minlevel > 0) bits.push(`Requires level ${q.minlevel}`);
  const zoneLabel = questZoneLabel(q.zone, q.zone_name);
  if (zoneLabel) bits.push(q.zone_page ? zoneLink(q.zone, zoneLabel) : esc(zoneLabel));
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

  const chain = [];
  if (prev) chain.push(`<span class="dim">← Previous:</span> ${questLink(prev.entry, prev.title)}`);
  if (next) chain.push(`<span class="dim">Next →:</span> ${questLink(next.entry, next.title)}`);

  // ---- reward summary ----
  const rewBits = [];
  if (q.money > 0) rewBits.push(moneyHtml(q.money));
  if (q.xp > 0) rewBits.push(`${q.xp.toLocaleString()} XP`);
  for (const r of qrep) if (r.value) rewBits.push(`+${r.value} ${factionLink(r.faction, r.faction_name)}`);
  if (rewSpell) rewBits.push(`Learn: ${esc(rewSpell.name)}`);

  const desc = [];
  if (q.objectives) desc.push(`<p class="quest-obj">${questText(q.objectives)}</p>`);
  if (q.details) desc.push(`<h3>Description</h3><p>${questText(q.details)}</p>`);
  if (q.objtext) desc.push(`<h3>Quest Objectives</h3><p>${questText(q.objtext)}</p>`);
  if (q.offertext) desc.push(`<h3>Completion</h3><p>${questText(q.offertext)}</p>`);
  if (rewBits.length) desc.push(`<h3>Rewards</h3><p class="quest-rew">${rewBits.join('<span class="dim"> · </span>')}</p>`);

  // ---- relation tables ----
  const npcCols = [
    { label: "NPC", cell: (c) => npcLink(c.entry, c.name), value: (c) => c.name },
    { label: "Level", num: true, cls: "muted", cell: (c) => lvlRange(c), value: (c) => c.level_max || c.level_min || 0 },
  ];
  const goCols = [{ label: "Object", cell: (g) => esc(g.name), value: (g) => g.name }];
  const itemCols = [
    { label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon), value: (r) => r.name },
    { label: "Qty", num: true, cls: "muted", cell: (r) => (r.count > 1 ? r.count : ""), value: (r) => r.count || 0 },
  ];
  const targetCols = [
    { label: "Target", cell: (o) => (o.is_go ? esc(o.name || `Object #${o.target}`) : npcLink(o.target, o.name || `NPC #${o.target}`)), value: (o) => o.name || "" },
    { label: "Count", num: true, cls: "muted", cell: (o) => (o.count > 1 ? o.count : ""), value: (o) => o.count || 0 },
  ];

  const tabDefs = [
    { id: "giverN", label: "Starts (NPC)", ...regTable(npcCols, giversN) },
    { id: "enderN", label: "Ends (NPC)", ...regTable(npcCols, endersN) },
    { id: "giverG", label: "Starts (Object)", ...regTable(goCols, giversG) },
    { id: "enderG", label: "Ends (Object)", ...regTable(goCols, endersG) },
    { id: "objcre", label: "Kill / Use", ...regTable(targetCols, qcreatures) },
    { id: "reqitem", label: "Required items", ...regTable(itemCols, byRole("req")) },
    { id: "srcitem", label: "Provided items", ...regTable(itemCols, byRole("source")) },
    { id: "reward", label: "Rewards", ...regTable(itemCols, byRole("reward")) },
    { id: "choice", label: "Choice of", ...regTable(itemCols, byRole("choice")) },
  ];

  app.innerHTML =
    `<div class="npc-page quest-page">
      <div class="npc-head">
        <h1>${esc(q.title)}</h1>
        <div class="npc-meta muted">${bits.join(" · ")}<span class="dim"> · Quest #${q.entry}</span></div>
        ${restr.length ? `<div class="npc-meta muted">${restr.map(esc).join(" · ")}</div>` : ""}
        ${chain.length ? `<div class="npc-meta quest-chain">${chain.join('<span class="dim"> · </span>')}</div>` : ""}
      </div>
      ${desc.length ? `<div class="panel quest-desc">${desc.join("")}</div>` : ""}
      ${tabs(tabDefs)}
    </div>`;
  mountTables();
  wireTabs();
}

async function showFaction(id) {
  app.innerHTML = `<div class="loading">Loading faction ${id}…</div>`;
  let fac;
  try { fac = await queryOne(Q.Q_FACTION, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!fac) { app.innerHTML = `<div class="home"><p>No faction with ID ${id}.</p></div>`; return; }
  const name = fac.name || `Faction #${fac.id}`;
  document.title = `${name} - Tortoise-WoW DB`;

  const [items, quests] = await Promise.all([
    query(Q.Q_FACTION_ITEMS, [id]), query(Q.Q_FACTION_QUESTS, [id]),
  ]);

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

  const meta = [`${fac.items} item${fac.items === 1 ? "" : "s"}`, `${fac.repquests} rep quest${fac.repquests === 1 ? "" : "s"}`];
  const tabDefs = [
    { id: "items", label: "Items", ...regTable(itemCols, items, { pageSize: 200, groupable: true, group: 1 }) },
    { id: "quests", label: "Rep from quests", ...regTable(questColsF, quests, { pageSize: 100 }) },
  ];

  app.innerHTML =
    `<div class="npc-page">
      <div class="npc-head">
        <h1>${esc(name)}</h1>
        <div class="npc-meta muted">${meta.join(" · ")}<span class="dim"> · Faction #${fac.id}</span></div>
      </div>
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

  const rect = [z.mapid, z.locbottom, z.loctop, z.locright, z.locleft];
  const [spawns, objects, loot, focusPts, focusItem] = await Promise.all([
    query(Q.Q_ZONE_SPAWNS, rect), query(Q.Q_ZONE_OBJECTS, rect), query(Q.Q_ZONE_LOOT, rect),
    gatherItem ? query(Q.Q_ZONE_FOCUS_SPAWNS, [...rect, gatherItem]) : [],
    gatherItem ? queryOne(Q.Q_ITEM_ICON, [gatherItem]) : null,
  ]);
  // focus mode: only the gathered node's spawns, drawn with the item's icon
  const focus = focusPts.length
    ? { label: (focusItem && focusItem.name) || focusPts[0].name || "Node", icon: focusItem && focusItem.icon, points: focusPts }
    : null;
  const meta = [CONTINENT[z.mapid], `${spawns.length + objects.length} spawns`].filter(Boolean);

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
    { label: "Object", cell: (o) => (iconByEntry.get(o.entry) ? iconImg(iconByEntry.get(o.entry)) : "") + esc(o.name), value: (o) => o.name },
    { label: "Type", cls: "muted", cell: (o) => GAMEOBJECT_TYPE[o.type] || "", value: (o) => GAMEOBJECT_TYPE[o.type] || "" },
    { label: "Spawns", num: true, cls: "muted", cell: (o) => o.count, value: (o) => o.count },
    { label: "Map", cls: "mapcol",
      cell: (o) => `<label class="mapchk"><input type="checkbox" data-mapobj="${o.entry}"${shownObjects.has(o.entry) ? " checked" : ""}></label>`,
      value: (o) => (shownObjects.has(o.entry) ? 1 : 0) },
  ];
  const tabDefs = [
    { id: "npcs", label: "NPCs", ...regTable(npcCols, npcs, { pageSize: 100 }) },
    { id: "items", label: "Items", ...regTable(lootCols, loot, { pageSize: 100 }) },
    { id: "objects", label: "Objects", ...regTable(objCols, objs, { pageSize: 100 }) },
  ];

  // A few client-defined zones (e.g. not-yet-populated Turtle areas) have a map
  // texture but no spawns recorded within their bounds -> three blank tabs. Show
  // an explanatory note instead.
  const hasData = npcs.length || objs.length || loot.length;
  const body = hasData
    ? tabs(tabDefs)
    : `<div class="zone-empty muted">No NPCs, items, or objects are recorded within this
        zone's bounds in the current Tortoise-WoW data. The zone map exists in the client, but
        the server data has no spawns here yet — this is usually a newly added zone that hasn't
        been populated upstream.</div>`;

  app.innerHTML =
    `<div class="zone-page">
      <div class="npc-head">
        <h1>${esc(z.name)}</h1>
        <div class="npc-meta muted">${meta.join(" · ")}<span class="dim"> · Zone #${z.areaid}</span></div>
      </div>
      <div id="zonemap"></div>
      ${body}
    </div>`;
  mountTables();
  wireTabs();
  const el = document.getElementById("zonemap");
  try {
    const { initZoneMap } = await import("./zonemap.js");
    const imgUrl = `${import.meta.env.BASE_URL}maps/${z.areaid}.webp`;
    const zmap = initZoneMap(el, { ...z, imgUrl }, spawns, objects, navigate, focus);
    // Objects tab checkboxes add/remove that object's spawns on the map.
    const objPane = app.querySelector('[data-pane="objects"]');
    if (objPane && zmap) objPane.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-mapobj]");
      if (!cb) return;
      const entry = Number(cb.dataset.mapobj);
      zmap.toggleObject(entry, cb.checked, iconByEntry.get(entry));
      if (cb.checked) shownObjects.add(entry); else shownObjects.delete(entry);
    });
    // NPCs tab checkboxes do the same for a creature's spawns.
    const npcPane = app.querySelector('[data-pane="npcs"]');
    if (npcPane && zmap) npcPane.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-mapnpc]");
      if (!cb) return;
      const entry = Number(cb.dataset.mapnpc);
      zmap.toggleNpc(entry, cb.checked);
      if (cb.checked) shownNpcs.add(entry); else shownNpcs.delete(entry);
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
  const zone = await queryOne(Q.Q_DUNGEON_ZONE, [id]);
  const rect = zone ? [zone.mapid, zone.locbottom, zone.loctop, zone.locright, zone.locleft] : null;
  const [bossLoot, npcs, loot, spawns, objects] = await Promise.all([
    query(Q.Q_DUNGEON_BOSS_LOOT, [id]), query(Q.Q_DUNGEON_NPCS, [id]), query(Q.Q_DUNGEON_LOOT, [id]),
    rect ? query(Q.Q_ZONE_SPAWNS, rect) : [], rect ? query(Q.Q_ZONE_OBJECTS, rect) : [],
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
    `<div class="npc-page zone-page">
      <div class="npc-head">
        <h1>${esc(map.name)}</h1>
        <div class="npc-meta muted">${typeLabel} · Map #${map.id}</div>
      </div>
      ${zone ? `<div id="zonemap"></div>` : ""}
      ${tabs(tabDefs)}
    </div>`;
  mountTables();
  wireTabs();
  if (zone) {
    const el = document.getElementById("zonemap");
    try {
      const { initZoneMap } = await import("./zonemap.js");
      const imgUrl = `${import.meta.env.BASE_URL}maps/${zone.areaid}.webp`;
      initZoneMap(el, { ...zone, imgUrl }, spawns, objects, navigate);
    } catch (e) { el.innerHTML = errorBox(e); }
  }
}

function errorBox(e) {
  return `<div class="error">Failed: ${esc(e.message || e)}</div>`;
}

// Load the Turtle custom-icon sprite-sheet manifest, then resolve `url` against
// the app base so render.js can draw custom icons (no-op if absent).
async function loadIconAtlas() {
  try {
    const base = import.meta.env.BASE_URL;
    const res = await fetch(`${base}icons/custom-atlas.json`);
    if (!res.ok) return;
    const m = await res.json();
    setIconAtlas({ ...m, url: `${base}icons/custom-atlas.webp` });
  } catch { /* fall back to CDN icons */ }
}

// ---- boot ----
preconnect();
initHovercards();
initSearchDropdown(searchInput, document.getElementById("searchForm"), navigate);
// Wait for the atlas (small JSON) so the first paint shows custom icons; route
// anyway if it fails or is missing.
loadIconAtlas().finally(route);
