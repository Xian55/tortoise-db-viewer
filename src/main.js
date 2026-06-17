import "./style.css";
import { query, queryOne, preconnect } from "./db.js";
import * as Q from "./queries.js";
import {
  renderTooltip, panel, table, tabs, itemLink, npcLink, iconImg, pct, esc, qualityColor,
} from "./render.js";
import { CREATURE_TYPE, CREATURE_RANK, npcRoles } from "./constants.js";
import { showBrowse } from "./browse.js";

const app = document.getElementById("app");
const searchInput = document.getElementById("search");

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
  const browse = params.get("browse");
  const term = params.get("search");
  if (item) showItem(Number(item));
  else if (npc) showNpc(Number(npc));
  else if (browse) showBrowse(browse, navigate);
  else if (term) { searchInput.value = term; showSearch(term); }
  else showHome();
}

// ---- views ----
function showHome() {
  document.title = "Tortoise-WoW Database";
  app.innerHTML = `<div class="home">
    <h1>Tortoise-WoW Database</h1>
    <p>Search above, or <a class="nav" href="?browse=items">browse items</a> /
       <a class="nav" href="?browse=npcs">browse NPCs</a> with filters.
       Open directly with <code>?item=ID</code> or <code>?npc=ID</code>.</p>
    <p class="muted">Examples:
      <a class="ilink" href="?item=55356">Netherwrought Bracers</a> ·
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
  const body = rows.map((r) =>
    `<tr><td>${itemLink(r.entry, r.name, r.quality, r.icon)}</td>` +
    `<td class="muted">${r.item_level || ""}</td>` +
    `<td class="muted">${r.required_level || ""}</td>` +
    `<td class="muted">${r.entry}</td></tr>`).join("");
  app.innerHTML = `<div class="results"><h1>Results for “${esc(term)}”</h1>` +
    table(["Name", "iLvl", "Req", "ID"], body) + `</div>`;
}

async function showItem(id) {
  app.innerHTML = `<div class="loading">Loading item ${id}…</div>`;
  let it;
  try { it = await queryOne(Q.Q_ITEM, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!it) { app.innerHTML = `<div class="home"><p>No item with ID ${id}.</p></div>`; return; }
  document.title = `${it.name} - Tortoise-WoW DB`;

  // spell descriptions for the tooltip effect lines
  const spellIds = [1, 2, 3, 4, 5].map((i) => it[`spellid_${i}`]).filter(Boolean);
  const spellMap = new Map();
  await Promise.all(spellIds.map(async (sid) => {
    const sp = await queryOne(Q.Q_SPELL, [sid]);
    if (sp) spellMap.set(sid, sp);
  }));

  const [dropped, objects, sold, contained, disen, quests, starts, createdBy, reagentFor] =
    await Promise.all([
      query(Q.Q_DROPPED_BY, [id]), query(Q.Q_OBJECT_SOURCE, [id]), query(Q.Q_SOLD_BY, [id]),
      query(Q.Q_CONTAINED_IN, [id]), query(Q.Q_DISENCHANTS_INTO, [id]), query(Q.Q_QUEST_ITEM, [id]),
      query(Q.Q_STARTS_QUEST, [id]), query(Q.Q_CREATED_BY, [id]), query(Q.Q_REAGENT_FOR, [id]),
    ]);

  let html = "";
  html += panel("Dropped by", table(["NPC", "Level", "Chance"],
    dropped.map((d) => {
      const ch = d.drop_chance ?? d.skin_chance ?? d.pick_chance;
      const tag = d.skin_chance != null ? " (skin)" : d.pick_chance != null ? " (pickpocket)" : "";
      const lvl = d.level_max && d.level_max !== d.level_min ? `${d.level_min}-${d.level_max}` : (d.level_min || "");
      return `<tr><td>${npcLink(d.entry, d.name)}${tag}</td><td class="muted">${lvl}</td><td>${pct(ch)}</td></tr>`;
    }).join("")));

  html += panel("Found in object", table(["Object", "Chance"],
    objects.map((o) => `<tr><td>${esc(o.name)}</td><td>${pct(o.chance)}</td></tr>`).join("")));

  html += panel("Sold by", table(["Vendor", "Level", "Stock"],
    sold.map((s) => {
      const lvl = s.level_max && s.level_max !== s.level_min ? `${s.level_min}-${s.level_max}` : (s.level_min || "");
      return `<tr><td>${npcLink(s.entry, s.name)}</td><td class="muted">${lvl}</td><td class="muted">${s.maxcount > 0 ? s.maxcount : "∞"}</td></tr>`;
    }).join("")));

  html += panel("Contained in", table(["Container", "Chance"],
    contained.map((c) => `<tr><td>${itemLink(c.entry, c.name, c.quality, c.icon)}</td><td>${pct(c.chance)}</td></tr>`).join("")));

  html += panel("Disenchants into", table(["Item", "Chance", "Qty"],
    disen.map((d) => {
      const qty = d.maxc > d.minc ? `${d.minc}-${d.maxc}` : d.minc;
      return `<tr><td>${itemLink(d.entry, d.name, d.quality, d.icon)}</td><td>${pct(d.chance)}</td><td class="muted">${qty}</td></tr>`;
    }).join("")));

  const reqQuests = quests.filter((q) => q.role === "req");
  const rewQuests = quests.filter((q) => q.role !== "req");
  html += panel("Reward from quest", table(["Quest", "Level"],
    rewQuests.map((q) => `<tr><td>${esc(q.title)}${q.role === "choice" ? " (choice)" : ""}</td><td class="muted">${q.level || ""}</td></tr>`).join("")));
  html += panel("Required for quest", table(["Quest", "Level", "Qty"],
    reqQuests.map((q) => `<tr><td>${esc(q.title)}</td><td class="muted">${q.level || ""}</td><td class="muted">${q.count}</td></tr>`).join("")));

  if (starts.length) html += panel("Starts quest", table(["Quest", "Level"],
    starts.map((q) => `<tr><td>${esc(q.title)}</td><td class="muted">${q.level || ""}</td></tr>`).join("")));

  if (createdBy.length) {
    const bySpell = new Map();
    for (const r of createdBy) {
      if (!bySpell.has(r.entry)) bySpell.set(r.entry, { name: r.name, reagents: [] });
      if (r.reagent_item) bySpell.get(r.entry).reagents.push(`${iconImg(r.reagent_icon)}${esc(r.reagent_name)} ×${r.count || 1}`);
    }
    const rows = [...bySpell.values()].map((s) =>
      `<tr><td>${esc(s.name)}</td><td class="muted">${s.reagents.join(", ")}</td></tr>`).join("");
    html += panel("Created by", table(["Spell", "Reagents"], rows));
  }

  html += panel("Reagent for", table(["Creates", "Via spell"],
    reagentFor.filter((r) => r.created).map((r) =>
      `<tr><td>${itemLink(r.created, r.created_name, r.quality, r.created_icon)}</td><td class="muted">${esc(r.spell_name)}</td></tr>`).join("")));

  app.innerHTML =
    `<div class="item-view">
      <div class="item-main">${renderTooltip(it, { spellMap })}
        <div class="item-meta muted">Item #${it.entry} · iLvl ${it.item_level || "—"}</div>
      </div>
      <div class="item-rel">${html || `<p class="muted">No additional sources found.</p>`}</div>
    </div>`;
}

async function showNpc(id) {
  app.innerHTML = `<div class="loading">Loading NPC ${id}…</div>`;
  let npc;
  try { npc = await queryOne(Q.Q_NPC, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!npc) { app.innerHTML = `<div class="home"><p>No NPC with ID ${id}.</p></div>`; return; }
  document.title = `${npc.name} - Tortoise-WoW DB`;

  const [loot, skin, pick, sells, starts, ends] = await Promise.all([
    query(Q.Q_NPC_LOOT, [id]), query(Q.Q_NPC_SKIN, [id]), query(Q.Q_NPC_PICK, [id]),
    query(Q.Q_NPC_SELLS, [id]), query(Q.Q_NPC_STARTS, [id]), query(Q.Q_NPC_ENDS, [id]),
  ]);

  const lvl = npc.level_max && npc.level_max !== npc.level_min ? `${npc.level_min}-${npc.level_max}` : (npc.level_min || "??");
  const bits = [`Level ${lvl}`];
  if (CREATURE_RANK[npc.rank]) bits.push(CREATURE_RANK[npc.rank]);
  if (CREATURE_TYPE[npc.type]) bits.push(CREATURE_TYPE[npc.type]);
  const hp = npc.health_max ? `${npc.health_min}–${npc.health_max} HP` : "";
  const roles = npcRoles(npc.npc_flags);
  const rankClass = npc.rank === 3 ? "npc-boss" : (npc.rank === 2 || npc.rank === 4) ? "npc-rare" : npc.rank === 1 ? "npc-elite" : "";

  const lootTable = (rows) => table(["Item", "Chance"],
    rows.map((d) => `<tr><td>${itemLink(d.entry, d.name, d.quality, d.icon)}</td><td>${pct(d.chance)}</td></tr>`).join(""));
  const questTable = (rows) => table(["Quest", "Level"],
    rows.map((q) => `<tr><td>${esc(q.title)}</td><td class="muted">${q.level || ""}</td></tr>`).join(""));
  const sellTable = table(["Item", "Stock"],
    sells.map((s) => `<tr><td>${itemLink(s.entry, s.name, s.quality, s.icon)}</td><td class="muted">${s.maxcount > 0 ? s.maxcount : "∞"}</td></tr>`).join(""));

  const tabDefs = [
    { id: "drops", label: "Drops", count: loot.length, html: lootTable(loot) },
    { id: "skinning", label: "Skinning", count: skin.length, html: lootTable(skin) },
    { id: "pickpocketing", label: "Pickpocketing", count: pick.length, html: lootTable(pick) },
    { id: "sells", label: "Sells", count: sells.length, html: sellTable },
    { id: "starts", label: "Starts quests", count: starts.length, html: questTable(starts) },
    { id: "ends", label: "Ends quests", count: ends.length, html: questTable(ends) },
  ];

  app.innerHTML =
    `<div class="npc-page">
      <div class="npc-head">
        <h1 class="${rankClass}">${esc(npc.name)}</h1>
        ${npc.subname ? `<span class="npc-sub muted">&lt;${esc(npc.subname)}&gt;</span>` : ""}
        <div class="npc-meta muted">${bits.join(" · ")}${hp ? " · " + hp : ""}
          ${roles.map((r) => `<span class="tagx">${esc(r)}</span>`).join("")}
          <span class="dim">· NPC #${npc.entry}</span></div>
      </div>
      ${tabs(tabDefs)}
    </div>`;
  wireTabs();
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

function errorBox(e) {
  return `<div class="error">Failed: ${esc(e.message || e)}</div>`;
}

// ---- boot ----
preconnect();
route();
