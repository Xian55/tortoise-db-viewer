// Leveling guides (?guides index, ?guide=<id> detail) for Turtle-WoW custom races.
// A thin hand-authored manifest (scripts/data/leveling-guides.json) picks the zones
// and level bands; EVERYTHING else is generated live from the quest DB through the same
// engine the quest/zone pages use -- so the guides double as a showcase of the database.
//
// The route is EFFICIENCY-oriented, like a speedrun guide: quests are batched by the
// hub where you pick them up / turn them in, the hubs are ordered by a travelling-
// salesman solve (nearest-neighbour + 2-opt) to minimise walking, and each hub becomes
// a STAGE -- "Pick up [quests] -> Complete [objectives] -> Turn in [quests]" -- instead
// of a quest-at-a-time list. Click a stage to spotlight its givers, turn-ins and every
// objective target (all in-zone spawns of the mobs/objects to kill) on the map. One
// live map at a time (initZoneMap is a WebGL singleton); multi-zone guides swap sections
// via a switcher. Progress (quests turned in) is stored per guide in localStorage.
import { query } from "./db.js";
import * as Q from "./queries.js";
import { questLink, npcLink, objectLink, itemLink, zoneLink, moneyHtml, iconImg, esc } from "./render.js";
import { orderQuestChain, navigate } from "./main.js";
import { ASSETS_BASE } from "./config.js";
import { PROFESSION, GATHERING_SKILLS } from "./constants.js";
import guides from "../scripts/data/leveling-guides.json";
import chainGuides from "../scripts/data/chain-guides.json";

// Craftable professions (gathering skills craft nothing; Mining keeps smelting) ->
// the profession-planner cards on the Guides index. Icons mirror profplan.js.
const CRAFTABLE_PROFS = PROFESSION.filter(([id]) => !GATHERING_SKILLS.has(id) || id === 186);
const PROF_ICON = {
  171: "trade_alchemy", 164: "trade_blacksmithing", 185: "inv_misc_food_15",
  333: "trade_engraving", 202: "trade_engineering", 129: "inv_misc_bandage_03",
  755: "inv_misc_gem_variety_01", 165: "trade_leatherworking", 186: "trade_mining",
  197: "trade_tailoring", 142: "ability_tracking",
};

const appEl = () => document.getElementById("app");
const MARKER_CAP = 250;   // max spawns plotted for one focused objective target
const HUB_MERGE = 12;     // hubs merge givers within this many map units (0-100 space)

// ---- localStorage progress (array of completed quest entries; ordinal-independent) ----
const PKEY = (id) => `twdb:guide:${id}`;
function readProgress(id) {
  try { const v = JSON.parse(localStorage.getItem(PKEY(id))); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function writeProgress(id, arr) {
  try { localStorage.setItem(PKEY(id), JSON.stringify(arr)); } catch { /* private mode */ }
}

// ---- world (x,y) -> zone parchment coordinate (0-100) + bounds test ----
function toMapCoord(z, x, y) {
  const dx = z.loctop - z.locbottom, dy = z.locleft - z.locright;
  return [dy ? (100 * (z.locleft - y)) / dy : 0, dx ? (100 * (z.loctop - x)) / dx : 0];
}
function inBounds(z, p) {
  const [X, Y] = toMapCoord(z, p.x, p.y), M = 2;
  return X >= -M && X <= 100 + M && Y >= -M && Y <= 100 + M;
}

// Mangos quest text tokens (inlined from main.js).
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
const facClass = (f) => `fac-${(f || "neutral").toLowerCase()}`;
const lvlSort = (a, b) => (a.level || 0) - (b.level || 0) || a.entry - b.entry;

// ---- index: the guide cards ----
export function showLeveling() {
  document.title = "Leveling Guides - Tortoise-WoW DB";
  const cards = Object.entries(guides).map(([id, g]) => {
    const saved = readProgress(id).length;
    const prog = saved ? `<span class="guide-card-prog">${saved} quest${saved === 1 ? "" : "s"} done</span>` : "";
    return `<a class="guide-card ilink" href="?guide=${esc(id)}">
      <div class="guide-card-top">
        <span class="guide-card-name">${esc(g.name)}</span>
        <span class="tagx ${facClass(g.faction)}">${esc(g.faction || "")}</span>
      </div>
      <div class="guide-card-range muted">Levels ${esc(g.levelRange || "")} · ${g.sections.length} zone${g.sections.length > 1 ? "s" : ""}</div>
      <div class="guide-card-blurb">${esc(g.blurb || "")}</div>
      ${prog}
    </a>`;
  }).join("");
  const chainCards = Object.entries(chainGuides).map(([id, g]) => {
    const variants = g.factions ? Object.keys(g.factions) : [];
    const steps = g.factions ? Object.values(g.factions)[0].quests.length : (g.quests || []).length;
    return `<a class="guide-card ilink" href="?guide=${esc(id)}">
      <div class="guide-card-top">
        <span class="guide-card-name">${esc(g.name)}</span>
        ${g.tw ? `<span class="tagx tw-tag" title="Added by Turtle WoW">TW</span>` : ""}
      </div>
      <div class="guide-card-range muted">Levels ${esc(g.levelRange || "")} · ${steps} steps${variants.length ? ` · ${esc(variants.join(" / "))}` : ""}</div>
      <div class="guide-card-blurb">${esc(g.blurb || "")}</div>
    </a>`;
  }).join("");

  const profCards = CRAFTABLE_PROFS.map(([id, name]) =>
    `<a class="guide-card guide-prof-card ilink" href="?profplan=${id}">
      <span class="guide-prof-icon">${iconImg(PROF_ICON[id] || "inv_misc_questionmark", "guide-prof-img")}</span>
      <span class="guide-prof-name">${esc(name)}</span>
    </a>`).join("");

  appEl().innerHTML = `<div class="guide-index">
    <h1>Leveling Guides</h1>
    <p class="muted">Efficient starting-zone routes for Turtle WoW's custom races, generated live from the quest
      database. Quests are batched by hub and the hubs are ordered to cut travel.
      Click a stage to spotlight its targets on the map. Progress is saved in this browser.</p>
    <div class="guide-cards guide-level-cards">${cards}</div>

    <h2 class="guide-prof-h">Attunements &amp; Special Chains</h2>
    <p class="muted">Long, order-sensitive quest chains — raid attunements and Turtle's permanent-Hardcore
      Inferno line — as tickable checklists. Each step links its givers, objectives and rewards.
      Progress is saved in this browser.</p>
    <div class="guide-cards">${chainCards}</div>

    <h2 class="guide-prof-h">Profession Leveling</h2>
    <p class="muted">Efficient 1→300 routes for every crafting profession — what to craft in each skill window,
      with a deduped materials shopping list. Progress is saved in this browser.</p>
    <div class="guide-cards guide-prof-cards">${profCards}</div>
  </div>`;
}

// ---- one guide ----
export async function showGuide(id) {
  if (chainGuides[id]) return showChainGuide(id);
  const app = appEl();
  const g = guides[id];
  if (!g) {
    document.title = "Leveling Guide";
    app.innerHTML = `<div class="home"><h1>Leveling Guide</h1><p>No guide named “${esc(id)}”. See <a class="nav" href="?guides">all guides</a>.</p></div>`;
    return;
  }
  document.title = `${g.name} Leveling Guide - Tortoise-WoW DB`;
  app.innerHTML = `<div class="loading">Building ${esc(g.name)} guide…</div>`;

  const zoneIds = [...new Set(g.sections.map((s) => s.zone))];
  const zoneRows = zoneIds.length ? await query(Q.qZonesByIds(zoneIds.length), zoneIds) : [];
  const zoneById = new Map(zoneRows.map((z) => [z.areaid, z]));

  const seen = new Set();      // dedupe a quest matched by two sections -> first section
  const sections = [];         // { section, zone, quests, stages, rel, maps }

  for (const section of g.sections) {
    const zone = zoneById.get(section.zone) || null;
    let quests = await query(Q.Q_GUIDE_QUESTS, [section.zone, g.racebit]);
    quests = quests.filter((q) => !seen.has(q.entry));
    quests.forEach((q) => seen.add(q.entry));
    if (!quests.length) { sections.push({ section, zone, quests: [], stages: [] }); continue; }

    const ordered = orderQuestChain(quests) || quests.slice().sort(lvlSort);
    const rel = await loadRelations(ordered);
    const maps = await loadSectionSpawns(rel, ordered);
    const coords = buildCoords(ordered, rel, maps, zone);
    const stages = buildStages(ordered, rel, coords, zone);
    sections.push({ section, zone, quests: ordered, stages, rel, maps, coords });
  }

  const total = sections.reduce((n, s) => n + s.quests.length, 0);
  const withMap = sections.filter((s) => s.stages.some((st) => st.hub));

  const sectionHtml = sections.map((sd) => {
    const name = sd.zone ? sd.zone.name : `Zone ${sd.section.zone}`;
    const head = `<div class="guide-section-head" id="sec-${sd.section.zone}">
      <h2>${sd.zone ? zoneLink(sd.zone.areaid, name) : esc(name)}${sd.section.levelRange ? ` <span class="guide-section-lvl">Lvl ${esc(sd.section.levelRange)}</span>` : ""}</h2>
      <span class="guide-section-count" data-section="${sd.section.zone}"></span>
    </div>`;
    const note = sd.section.note ? `<div class="guide-section-note">${esc(sd.section.note)}</div>` : "";
    const body = sd.stages.length
      ? sd.stages.map((st) => renderStage(st, sd.zone, sd.rel)).join("")
      : `<div class="guide-empty muted">No quests recorded for this section.</div>`;
    return `<section class="guide-section">${head}${note}<div class="guide-stages">${body}</div></section>`;
  }).join("");

  const mapSwitch = withMap.length > 1
    ? `<div id="guidemapswitch" class="floor-switch">${withMap.map((sd, i) =>
        `<button data-zone="${sd.zone.areaid}"${i === 0 ? ' class="active"' : ""}>${esc(sd.zone.name)}</button>`).join("")}</div>`
    : "";
  const mapHtml = withMap.length
    ? `<div class="guide-map"><div class="panel quest-map"><h3 class="quest-map-h">Route map</h3>${mapSwitch}
         <button type="button" class="guide-map-reset" hidden>↺ Show full route</button>
         <div id="zonemap"></div>
         <p class="guide-map-tip muted"><b>Click a stage</b> to spotlight its givers, turn-ins and kill targets. Numbered stops are the hubs in travel order.</p>
       </div></div>`
    : "";

  const secNav = sections.length > 1
    ? `<div class="guide-secnav floor-switch">${sections.map((sd) =>
        `<button data-goto="sec-${sd.section.zone}">${esc(sd.zone ? sd.zone.name : `Zone ${sd.section.zone}`)}</button>`).join("")}</div>`
    : "";

  app.innerHTML = `<div class="guide-page">
    <div class="guide-header">
      <div class="guide-head-top">
        <h1>${esc(g.name)} <span class="tagx ${facClass(g.faction)}">${esc(g.faction || "")}</span></h1>
        <span class="guide-range muted">Levels ${esc(g.levelRange || "")}</span>
      </div>
      ${g.intro ? `<p class="guide-intro">${esc(g.intro)}</p>` : ""}
      <div class="guide-progress-row">
        <div class="guide-progress"><i></i></div>
        <span class="guide-progress-label"></span>
        <button type="button" class="guide-reset">Reset progress</button>
      </div>
      ${secNav}
    </div>
    <div class="guide-body">
      <div class="guide-steps-col">${sectionHtml}</div>
      ${mapHtml}
    </div>
  </div>`;

  wireProgress(id, total, sections);
  wireCopy();
  if (secNav) app.querySelectorAll(".guide-secnav button").forEach((b) =>
    b.addEventListener("click", () => document.getElementById(b.dataset.goto)?.scrollIntoView({ behavior: "smooth", block: "start" })));

  if (withMap.length) await wireMap(sections, withMap);
}

// One round-trip per relation for a whole section; grouped by quest entry.
async function loadRelations(ordered) {
  const ids = ordered.map((q) => q.entry);
  const n = ids.length;
  const [giversN, endersN, giversG, endersG, objectives, items] = await Promise.all([
    query(Q.qQuestStartNpcs(n), ids),
    query(Q.qQuestEndNpcs(n), ids),
    query(Q.qQuestStartObjects(n), ids),
    query(Q.qQuestEndObjects(n), ids),
    query(Q.qGuideObjectives(n), ids),
    query(Q.qGuideItems(n), ids),
  ]);
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) (m.get(r.quest) || m.set(r.quest, []).get(r.quest)).push(r);
    return m;
  };
  return { giversN: group(giversN), endersN: group(endersN), giversG: group(giversG), endersG: group(endersG), objectives: group(objectives), items: group(items) };
}

// Spawn coordinates for every creature/object referenced as giver, turn-in or target.
async function loadSectionSpawns(rel, ordered) {
  const cSet = new Set(), oSet = new Set();
  for (const q of ordered) {
    for (const r of rel.giversN.get(q.entry) || []) cSet.add(r.entry);
    for (const r of rel.endersN.get(q.entry) || []) cSet.add(r.entry);
    for (const r of rel.giversG.get(q.entry) || []) oSet.add(r.entry);
    for (const r of rel.endersG.get(q.entry) || []) oSet.add(r.entry);
    for (const o of rel.objectives.get(q.entry) || []) (o.is_go ? oSet : cSet).add(o.target);
  }
  const cArr = [...cSet], oArr = [...oSet];
  const [cPts, oPts] = await Promise.all([
    cArr.length ? query(Q.qSpawnPointsFor(cArr.length, "c"), cArr) : [],
    oArr.length ? query(Q.qSpawnPointsFor(oArr.length, "o"), oArr) : [],
  ]);
  const byEntry = (rows) => { const m = new Map(); for (const r of rows) (m.get(r.entry) || m.set(r.entry, []).get(r.entry)).push(r); return m; };
  return { cMap: byEntry(cPts), oMap: byEntry(oPts) };
}

function spawnsFor(entries, kind, maps, zone) {
  const src = kind === "o" ? maps.oMap : maps.cMap;
  const pts = [];
  for (const e of entries) for (const p of src.get(e) || []) if (!zone || (p.zone === zone.areaid && inBounds(zone, p))) pts.push(p);
  return pts;
}

// Representative in-zone giver / turn-in world coordinate per quest.
function buildCoords(ordered, rel, maps, zone) {
  const rep = (entries, src) => {
    let pts = [];
    for (const e of entries) for (const p of src.get(e) || []) pts.push(p);
    if (zone) pts = pts.filter((p) => p.zone === zone.areaid && inBounds(zone, p));
    if (!pts.length) return null;
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  };
  const coords = new Map();
  for (const q of ordered) {
    const gN = (rel.giversN.get(q.entry) || []).map((r) => r.entry);
    const gO = (rel.giversG.get(q.entry) || []).map((r) => r.entry);
    const eN = (rel.endersN.get(q.entry) || []).map((r) => r.entry);
    const eO = (rel.endersG.get(q.entry) || []).map((r) => r.entry);
    coords.set(q.entry, { giver: rep(gN, maps.cMap) || rep(gO, maps.oMap), ender: rep(eN, maps.cMap) || rep(eO, maps.oMap) });
  }
  return coords;
}

// ---- efficiency core: cluster giver/turn-in coords into HUBS, order them with a TSP
// solve, and build one STAGE per hub (batched accept / objectives / turn-in). ----
function buildStages(ordered, rel, coords, zone) {
  if (!zone) return ordered.length ? [{ hub: null, n: 1, npcs: [], quests: ordered, accepts: ordered.slice().sort(lvlSort), turnins: ordered.slice().sort(lvlSort), objectives: dedupObjectives(ordered, rel) }] : [];

  // collect giver/turn-in points in map (0-100) space + carry the world coord
  const pts = [];
  for (const q of ordered) {
    const c = coords.get(q.entry) || {};
    if (c.giver) { const [X, Y] = toMapCoord(zone, c.giver.x, c.giver.y); pts.push({ q: q.entry, role: "g", X, Y, wx: c.giver.x, wy: c.giver.y }); }
    if (c.ender) { const [X, Y] = toMapCoord(zone, c.ender.x, c.ender.y); pts.push({ q: q.entry, role: "t", X, Y, wx: c.ender.x, wy: c.ender.y }); }
  }
  // greedy online clustering: merge points within HUB_MERGE map-units
  const hubs = [];
  for (const p of pts) {
    let best = null, bd = HUB_MERGE;
    for (const h of hubs) { const d = Math.hypot(h.X - p.X, h.Y - p.Y); if (d < bd) { bd = d; best = h; } }
    if (best) { best.pts.push(p); best.n++; best.X += (p.X - best.X) / best.n; best.Y += (p.Y - best.Y) / best.n; best.swx += p.wx; best.swy += p.wy; p.hub = best; }
    else { const h = { id: hubs.length, X: p.X, Y: p.Y, n: 1, swx: p.wx, swy: p.wy, pts: [p] }; hubs.push(h); p.hub = h; }
  }
  for (const h of hubs) { h.wx = h.swx / h.n; h.wy = h.swy / h.n; }

  const gHub = new Map(), tHub = new Map();
  for (const p of pts) (p.role === "g" ? gHub : tHub).set(p.q, p.hub.id);
  for (const q of ordered) {
    const e = q.entry;
    if (!gHub.has(e) && tHub.has(e)) gHub.set(e, tHub.get(e));
    if (!tHub.has(e) && gHub.has(e)) tHub.set(e, gHub.get(e));
  }

  // TSP order: start at the hub of the lowest-level quest, nearest-neighbour + 2-opt
  const startId = gHub.get(ordered[0].entry) ?? (hubs[0] && hubs[0].id);
  const order = tspOrder(hubs, startId);

  const byId = new Map(hubs.map((h) => [h.id, h]));
  // the giver/turn-in NPCs (+ objects) anchoring a hub, as {entry,name,isObj} for links
  const npcsFor = (accepts, turnins) => {
    const seen = new Map();
    const add = (quests, rlN, rlO) => {
      for (const q of quests) {
        for (const r of rlN.get(q.entry) || []) { const k = "c" + r.entry; if (!seen.has(k)) seen.set(k, { entry: r.entry, name: r.name, isObj: false }); }
        for (const r of rlO.get(q.entry) || []) { const k = "o" + r.entry; if (!seen.has(k)) seen.set(k, { entry: r.entry, name: r.name, isObj: true }); }
      }
    };
    add(accepts, rel.giversN, rel.giversG);
    add(turnins, rel.endersN, rel.endersG);
    return [...seen.values()];
  };

  const stages = [];
  let n = 0;
  for (const hid of order) {
    const hub = byId.get(hid);
    const accepts = ordered.filter((q) => gHub.get(q.entry) === hid).sort(lvlSort);
    const turnins = ordered.filter((q) => tHub.get(q.entry) === hid).sort(lvlSort);
    if (!accepts.length && !turnins.length) continue;
    const quests = [...new Set([...accepts, ...turnins])];
    stages.push({ hub, n: ++n, npcs: npcsFor(accepts, turnins), quests, accepts, turnins, objectives: dedupObjectives(accepts, rel) });
  }

  // quests with no giver AND no turn-in coord (auto/world items) -> a final no-map stage
  const leftover = ordered.filter((q) => !gHub.has(q.entry) && !tHub.has(q.entry));
  if (leftover.length) stages.push({ hub: null, n: ++n, npcs: [], quests: leftover, accepts: leftover.slice().sort(lvlSort), turnins: leftover.slice().sort(lvlSort), objectives: dedupObjectives(leftover, rel) });
  return stages;
}

function dedupObjectives(quests, rel) {
  const m = new Map();
  for (const q of quests) for (const o of rel.objectives.get(q.entry) || []) {
    const k = `${o.is_go ? "o" : "c"}:${o.target}`;
    const cur = m.get(k);
    if (!cur || (o.count || 0) > (cur.count || 0)) m.set(k, o);
  }
  return [...m.values()];
}

// nearest-neighbour tour from `startId`, refined by 2-opt (first stop pinned). Euclidean
// on the 0-100 map coords -> the shortest hub-visiting walk.
function tspOrder(hubs, startId) {
  if (hubs.length <= 2) return hubs.map((h) => h.id);
  const d = (a, b) => Math.hypot(a.X - b.X, a.Y - b.Y);
  const rem = hubs.slice();
  let si = rem.findIndex((h) => h.id === startId); if (si < 0) si = 0;
  const order = [rem.splice(si, 1)[0]];
  while (rem.length) {
    const last = order[order.length - 1];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rem.length; i++) { const dd = d(last, rem[i]); if (dd < bd) { bd = dd; bi = i; } }
    order.push(rem.splice(bi, 1)[0]);
  }
  const len = (a) => { let s = 0; for (let i = 0; i < a.length - 1; i++) s += d(a[i], a[i + 1]); return s; };
  let best = len(order), improved = true, guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (let i = 1; i < order.length - 1; i++) for (let k = i + 1; k < order.length; k++) {
      const cand = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
      const l = len(cand);
      if (l + 1e-6 < best) { order.splice(0, order.length, ...cand); best = l; improved = true; }
    }
  }
  return order.map((h) => h.id);
}

// ---- rendering ----
function rewardHtml(q, items) {
  const parts = [];
  if (q.xp > 0) parts.push(`${q.xp.toLocaleString()} XP`);
  if (q.money > 0) parts.push(moneyHtml(q.money));
  const rew = (items || []).filter((i) => i.role === "reward").map((it) => itemLink(it.entry, it.name, it.quality, it.icon) + (it.count > 1 ? ` ×${it.count}` : ""));
  const choice = (items || []).filter((i) => i.role === "choice").map((it) => itemLink(it.entry, it.name, it.quality, it.icon));
  if (rew.length) parts.push(rew.join(", "));
  if (choice.length) parts.push(`choose ${choice.join(" / ")}`);
  return parts.length ? ` <span class="guide-rew muted">— ${parts.join(' <span class="dim">·</span> ')}</span>` : "";
}

function renderStage(st, zone, rel) {
  const wayChip = (() => {
    if (!st.hub || !zone) return "";
    const way = `/way ${zone.name || ""} ${st.hub.X.toFixed(1)} ${st.hub.Y.toFixed(1)}`.replace(/\s+/g, " ").trim();
    return ` <button type="button" class="way-copy" data-way="${esc(way)}" title="Copy /way coordinate">${st.hub.X.toFixed(1)}, ${st.hub.Y.toFixed(1)}</button>`;
  })();
  const lvls = st.quests.map((q) => q.level).filter((l) => l > 0);
  const lvlRange = lvls.length ? (Math.min(...lvls) === Math.max(...lvls) ? `Lvl ${Math.min(...lvls)}` : `Lvl ${Math.min(...lvls)}–${Math.max(...lvls)}`) : "";
  const where = st.npcs.length
    ? st.npcs.slice(0, 3).map((nn) => nn.isObj ? objectLink(nn.entry, nn.name) : npcLink(nn.entry, nn.name)).join(", ") + (st.npcs.length > 3 ? ` <span class="muted">+${st.npcs.length - 3}</span>` : "")
    : (st.hub ? "In the field" : "No map location");

  const tw = (q) => q.custom ? ' <span class="tagx tw-tag" title="Added by Turtle WoW">TW</span>' : "";
  const acceptLis = st.accepts.map((q) => `<li>${questLink(q.entry, q.title)}${q.level > 0 ? ` <span class="guide-lvl">${q.level}</span>` : ""}${tw(q)}</li>`).join("");
  const objChips = st.objectives.map((o) => {
    const link = o.is_go ? objectLink(o.target, o.name || `Object #${o.target}`) : npcLink(o.target, o.name || `NPC #${o.target}`);
    return `<span class="guide-obj-chip">${o.count > 1 ? `${o.count}× ` : ""}${link}</span>`;
  }).join(" ");
  const turninLis = st.turnins.map((q) => {
    const rw = rewardHtml(q, (rel && rel.items.get(q.entry)) || []);
    return `<li><label class="guide-turnin-l"><input type="checkbox" class="guide-check" data-q="${q.entry}"> ${questLink(q.entry, q.title)}${rw}</label></li>`;
  }).join("");

  return `<section class="guide-stage"${st.hub ? ` data-hub="${st.hub.id}"` : ""}>
    <div class="guide-stage-head">
      <span class="guide-stage-n">${st.n}</span>
      <div class="guide-stage-h">
        <b>${where}</b>${wayChip}
        ${lvlRange ? `<span class="guide-stage-lvl">${lvlRange}</span>` : ""}
      </div>
    </div>
    <div class="guide-stage-body">
      ${acceptLis ? `<div class="guide-act"><span class="guide-act-k accept">Pick up</span><ul class="guide-qlist">${acceptLis}</ul></div>` : ""}
      ${objChips ? `<div class="guide-act"><span class="guide-act-k do">Complete</span> <span class="guide-obj-chips">${objChips}</span></div>` : ""}
      ${turninLis ? `<div class="guide-act"><span class="guide-act-k turnin">Turn in</span><ul class="guide-qlist">${turninLis}</ul></div>` : ""}
    </div>
  </section>`;
}

// marker layers spotlighting one stage: giver (green), turn-in (gold), each objective
// target with all its in-zone spawns (so "kill 10 X" shows the X).
function stageMarkers(st, rel, maps, zone) {
  if (!zone || !st.hub) return null;
  const gN = new Set(), gO = new Set(), eN = new Set(), eO = new Set();
  for (const q of st.accepts) {
    for (const r of rel.giversN.get(q.entry) || []) gN.add(r.entry);
    for (const r of rel.giversG.get(q.entry) || []) gO.add(r.entry);
  }
  for (const q of st.turnins) {
    for (const r of rel.endersN.get(q.entry) || []) eN.add(r.entry);
    for (const r of rel.endersG.get(q.entry) || []) eO.add(r.entry);
  }
  const giverPts = [...spawnsFor([...gN], "c", maps, zone), ...spawnsFor([...gO], "o", maps, zone)];
  const enderPts = [...spawnsFor([...eN], "c", maps, zone), ...spawnsFor([...eO], "o", maps, zone)];
  const layers = [];
  const sameGE = gN.size + gO.size > 0 && eN.size + eO.size === gN.size + gO.size && [...eN].every((e) => gN.has(e)) && [...eO].every((e) => gO.has(e));
  if (sameGE) { if (giverPts.length) layers.push({ key: "giver", label: "Giver & turn-in", color: "#39d353", points: giverPts, on: true }); }
  else {
    if (giverPts.length) layers.push({ key: "giver", label: "Quest giver", color: "#39d353", points: giverPts, on: true });
    if (enderPts.length) layers.push({ key: "ender", label: "Turn in", color: "#ffd100", points: enderPts, on: true });
  }
  let h = 0;
  const hue = () => `hsl(${Math.round((h++ * 137.508 + 25) % 360)} 72% 52%)`;
  for (const o of st.objectives) {
    let pts = spawnsFor([o.target], o.is_go ? "o" : "c", maps, zone);
    if (!pts.length) continue;
    if (pts.length > MARKER_CAP) pts = pts.slice(0, MARKER_CAP);
    const nm = o.name || `#${o.target}`;
    layers.push({ key: `t-${o.is_go ? "o" : "c"}-${o.target}`, label: o.count > 1 ? `${nm} ×${o.count}` : nm, color: hue(), poi: o.is_go ? "Chest" : undefined, points: pts, on: true });
  }
  return layers.length ? layers : null;
}

// overview: giver + turn-in pins for the whole section + the numbered hub circuit (stage
// order == the TSP tour, so stop N == stage N).
function buildOverview(sd) {
  const { quests, rel, maps, zone, stages } = sd;
  if (!zone) return null;
  const gN = new Set(), gO = new Set(), eN = new Set(), eO = new Set();
  for (const q of quests) {
    for (const r of rel.giversN.get(q.entry) || []) gN.add(r.entry);
    for (const r of rel.endersN.get(q.entry) || []) eN.add(r.entry);
    for (const r of rel.giversG.get(q.entry) || []) gO.add(r.entry);
    for (const r of rel.endersG.get(q.entry) || []) eO.add(r.entry);
  }
  const giverPts = [...spawnsFor([...gN], "c", maps, zone), ...spawnsFor([...gO], "o", maps, zone)];
  const enderPts = [...spawnsFor([...eN], "c", maps, zone), ...spawnsFor([...eO], "o", maps, zone)];
  const sameNpc = gN.size + gO.size > 0 && eN.size + eO.size === gN.size + gO.size && [...eN].every((e) => gN.has(e)) && [...eO].every((e) => gO.has(e));
  const layers = [];
  if (sameNpc) { if (giverPts.length) layers.push({ key: "giver", label: "Quest giver & turn-in", color: "#39d353", points: giverPts, on: true }); }
  else {
    if (giverPts.length) layers.push({ key: "giver", label: "Quest giver", color: "#39d353", points: giverPts, on: true });
    if (enderPts.length) layers.push({ key: "ender", label: "Turn in", color: "#ffd100", points: enderPts, on: true });
  }
  const routePts = stages.filter((s) => s.hub).map((s) => ({ x: s.hub.wx, y: s.hub.wy }));
  const route = routePts.length >= 3 ? { points: routePts, ordered: true, on: true, mergeFrac: 0, label: "Route" } : null;
  if (!layers.length && !route) return null;
  return { markerLayers: layers, route };
}

// ---- map wiring: overview <-> per-stage focus, section switcher, reset ----
async function wireMap(sections, withMap) {
  const app = appEl();
  let initZoneMap;
  try { ({ initZoneMap } = await import("./zonemap.js")); }
  catch (_) { document.getElementById("zonemap")?.closest(".guide-map")?.remove(); return; }
  const el = document.getElementById("zonemap");
  if (!el) return;

  for (const sd of withMap) sd._overview = buildOverview(sd);
  // hubId -> { sd, markers }
  const stageIndex = new Map();
  for (const sd of withMap) for (const st of sd.stages) if (st.hub) stageIndex.set(`${sd.zone.areaid}:${st.hub.id}`, { sd, markers: stageMarkers(st, sd.rel, sd.maps, sd.zone) });

  const imgOf = (zone) => ({ ...zone, imgUrl: `${ASSETS_BASE}maps/${zone.areaid}.webp` });
  const resetBtn = app.querySelector(".guide-map-reset");
  const markSwitch = (areaid) => app.querySelectorAll("#guidemapswitch button").forEach((b) => b.classList.toggle("active", +b.dataset.zone === areaid));
  let current = withMap[0];

  const renderOverview = (sd) => {
    current = sd;
    initZoneMap(el, imgOf(sd.zone), [], [], navigate, { markerLayers: sd._overview.markerLayers, route: sd._overview.route });
    markSwitch(sd.zone.areaid);
    app.querySelectorAll(".guide-stage.focused").forEach((s) => s.classList.remove("focused"));
    if (resetBtn) resetBtn.hidden = true;
  };
  const focusStage = (areaid, hubId, el2) => {
    const info = stageIndex.get(`${areaid}:${hubId}`);
    if (!info || !info.markers) return;
    current = info.sd;
    initZoneMap(el, imgOf(info.sd.zone), [], [], navigate, { markerLayers: info.markers, route: null });
    markSwitch(areaid);
    app.querySelectorAll(".guide-stage").forEach((s) => s.classList.toggle("focused", s === el2));
    if (resetBtn) resetBtn.hidden = false;
    if (window.matchMedia("(max-width: 900px)").matches) app.querySelector(".guide-map")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  renderOverview(withMap[0]);
  app.querySelectorAll("#guidemapswitch button").forEach((b) => b.addEventListener("click", () => {
    const sd = withMap.find((x) => x.zone.areaid === +b.dataset.zone);
    if (sd) renderOverview(sd);
  }));
  resetBtn?.addEventListener("click", () => renderOverview(current));

  // click a stage (not its links/checkbox) -> spotlight it
  app.querySelector(".guide-steps-col")?.addEventListener("click", (e) => {
    if (e.target.closest("a, button, input, label")) return;
    const st = e.target.closest(".guide-stage[data-hub]");
    if (!st) return;
    const sec = st.closest(".guide-section");
    const areaid = +sec.querySelector(".guide-section-head").id.replace("sec-", "");
    focusStage(areaid, +st.dataset.hub, st);
  });
}

// checkbox <-> localStorage <-> progress bar / per-section counts
function wireProgress(id, total, sections) {
  const app = appEl();
  const done = new Set(readProgress(id));
  const bar = app.querySelector(".guide-progress > i");
  const label = app.querySelector(".guide-progress-label");
  const checks = [...app.querySelectorAll(".guide-check")];

  const apply = () => {
    let d = 0;
    for (const cb of checks) {
      const on = done.has(+cb.dataset.q);
      cb.checked = on;
      cb.closest("li")?.classList.toggle("done", on);
      if (on) d++;
    }
    const pct = total ? Math.round((100 * d) / total) : 0;
    if (bar) bar.style.width = `${pct}%`;
    if (label) label.textContent = `${d} / ${total} quests · ${pct}%`;
    for (const sd of sections) {
      const el = app.querySelector(`.guide-section-count[data-section="${sd.section.zone}"]`);
      if (!el) continue;
      const t = sd.quests.length;
      const dn = sd.quests.filter((q) => done.has(q.entry)).length;
      el.textContent = t ? `${dn} / ${t}` : "";
    }
  };
  apply();

  app.querySelector(".guide-body")?.addEventListener("change", (e) => {
    const cb = e.target.closest(".guide-check");
    if (!cb) return;
    const q = +cb.dataset.q;
    if (cb.checked) done.add(q); else done.delete(q);
    writeProgress(id, [...done]);
    apply();
  });
  app.querySelector(".guide-reset")?.addEventListener("click", () => {
    done.clear(); writeProgress(id, []); apply();
  });
}

function wireCopy() {
  appEl().querySelector(".guide-page")?.addEventListener("click", (e) => {
    const b = e.target.closest(".way-copy");
    if (!b) return;
    e.preventDefault();
    const prev = b.textContent;
    (navigator.clipboard?.writeText(b.dataset.way) || Promise.resolve())
      .then(() => { b.textContent = "copied ✓"; setTimeout(() => { b.textContent = prev; }, 1200); })
      .catch(() => {});
  });
}

// ---- chain guides (attunements + Inferno): an ordered, tickable quest checklist ----
// Unlike the zone leveling guides these are NOT hub-batched or TSP-ordered -- a chain is a
// fixed sequence of specific quest ids (per faction) from the manifest, so we resolve each
// id and render it in manifest order. NB the DB prevquest/nextquest links are unreliable for
// some of these (e.g. Inferno 40917 prev=40922), which is exactly why the order is pinned in
// the manifest rather than re-derived here. Map is intentionally omitted -- chains span many
// dungeons/zones with no single parchment; the quest/npc/item links carry their own pages.
export async function showChainGuide(id) {
  const app = appEl();
  const g = chainGuides[id];
  if (!g) { app.innerHTML = `<div class="home"><h1>Guide</h1><p>No guide named “${esc(id)}”. See <a class="nav" href="?guides">all guides</a>.</p></div>`; return; }
  document.title = `${g.name} Guide - Tortoise-WoW DB`;
  app.innerHTML = `<div class="loading">Building ${esc(g.name)} guide…</div>`;

  const variants = g.factions
    ? Object.entries(g.factions).map(([faction, v]) => ({ faction, quests: v.quests }))
    : [{ faction: g.faction || null, quests: g.quests || [] }];
  const allIds = [...new Set(variants.flatMap((v) => v.quests))];
  const rows = allIds.length ? await query(Q.qQuestsByIds(allIds.length), allIds) : [];
  const byId = new Map(rows.map((r) => [r.entry, r]));
  const rel = await loadRelations(rows);

  const terminalLabel = g.terminalLabel || (id === "inferno" ? "Inferno" : (g.category || "Final step"));
  const factionKey = (f) => `twdb:guide:${id}${f ? ":" + f : ""}`;
  let active = variants[0];

  const render = () => {
    const steps = active.quests.map((qid) => byId.get(qid)).filter(Boolean);
    // `oneOf` chains (e.g. Naxx's rep-tiered turn-ins) are alternatives: do ANY one, no terminal.
    const stepHtml = steps.map((q, i) => renderChainStep(q, i + 1, rel, !g.oneOf && i === steps.length - 1, terminalLabel, g.notes && g.notes[q.entry])).join("");
    const oneOf = !!g.oneOf;
    const oneOfBanner = oneOf ? `<div class="chain-oneof">Complete <b>one</b> of the options below — whichever matches your standing. Any single one grants the attunement.</div>` : "";
    const pills = variants.length > 1
      ? `<div class="chain-factions floor-switch">${variants.map((v) =>
          `<button data-f="${esc(v.faction)}" class="${v.faction === active.faction ? "active " : ""}${facClass(v.faction)}">${esc(v.faction)}</button>`).join("")}</div>`
      : "";
    app.innerHTML = `<div class="guide-page chain-page">
      <div class="guide-header">
        <div class="guide-head-top">
          <h1>${esc(g.name)} <span class="tagx ${facClass(g.faction)}">${esc(g.category || "")}</span></h1>
          <span class="guide-range muted">Levels ${esc(g.levelRange || "")}</span>
        </div>
        ${g.intro ? `<p class="guide-intro">${esc(g.intro)}</p>` : ""}
        <div class="guide-progress-row">
          <div class="guide-progress"><i></i></div>
          <span class="guide-progress-label"></span>
          <button type="button" class="guide-reset">Reset progress</button>
        </div>
        ${pills}
      </div>
      ${oneOfBanner}
      <ol class="chain-steps${oneOf ? " chain-oneof-list" : ""}">${stepHtml}</ol>
      <p class="muted guide-chain-back"><a class="nav" href="?guides">← All guides</a></p>
    </div>`;
    wireChainProgress(factionKey(active.faction), oneOf ? 1 : steps.length, oneOf);
    app.querySelectorAll(".chain-factions button").forEach((b) => b.addEventListener("click", () => {
      const v = variants.find((x) => x.faction === b.dataset.f);
      if (v && v !== active) { active = v; render(); }
    }));
  };
  render();
}

function renderChainStep(q, n, rel, terminal, terminalLabel, note) {
  const links = (rows, isObj) => (rows || []).map((r) => (isObj ? objectLink(r.entry, r.name) : npcLink(r.entry, r.name)));
  const givers = [...links(rel.giversN.get(q.entry), false), ...links(rel.giversG.get(q.entry), true)];
  const enders = [...links(rel.endersN.get(q.entry), false), ...links(rel.endersG.get(q.entry), true)];
  const objs = (rel.objectives.get(q.entry) || []).map((o) => {
    const link = o.is_go ? objectLink(o.target, o.name || `#${o.target}`) : npcLink(o.target, o.name || `#${o.target}`);
    return `<span class="guide-obj-chip">${o.count > 1 ? `${o.count}× ` : ""}${link}</span>`;
  }).join(" ");
  const items = rel.items.get(q.entry) || [];
  const reqs = items.filter((i) => i.role === "req" || i.role === "source")
    .map((it) => itemLink(it.entry, it.name, it.quality, it.icon) + (it.count > 1 ? ` ×${it.count}` : ""));
  const rew = rewardHtml(q, items);
  const tw = q.custom ? ' <span class="tagx tw-tag" title="Added by Turtle WoW">TW</span>' : "";
  const lvl = q.minlevel > 0 ? ` <span class="guide-lvl">${q.minlevel}</span>` : "";
  const sameGE = givers.length && enders.join("|") === givers.join("|");
  const metaRows = [
    givers.length ? `<span><b class="cs-k">From</b> ${givers.slice(0, 4).join(", ")}</span>` : "",
    objs ? `<span><b class="cs-k do">Do</b> ${objs}</span>` : "",
    reqs.length ? `<span><b class="cs-k">Bring</b> ${reqs.join(", ")}</span>` : "",
    (enders.length && !sameGE) ? `<span><b class="cs-k turnin">Turn in</b> ${enders.slice(0, 4).join(", ")}</span>` : "",
  ].filter(Boolean).join("");
  return `<li class="chain-step${terminal ? " chain-terminal" : ""}">
    <label class="chain-step-check"><input type="checkbox" class="guide-check" data-q="${q.entry}"></label>
    <div class="chain-step-body">
      <div class="chain-step-h"><span class="chain-step-n">${n}</span> ${questLink(q.entry, q.title)}${lvl}${tw}${terminal ? ` <span class="chain-badge">${esc(terminalLabel)}</span>` : ""}${rew}</div>
      ${metaRows ? `<div class="chain-step-meta">${metaRows}</div>` : ""}
      ${note ? `<div class="chain-step-note">${esc(note)}</div>` : ""}
    </div>
  </li>`;
}

// progress for one chain/faction: a set of completed quest entries in localStorage.
// oneOf chains count as done once ANY single option is ticked (total is 1).
function wireChainProgress(key, total, oneOf) {
  const app = appEl();
  let done;
  try { done = new Set(JSON.parse(localStorage.getItem(key)) || []); } catch { done = new Set(); }
  const bar = app.querySelector(".guide-progress > i");
  const label = app.querySelector(".guide-progress-label");
  const checks = [...app.querySelectorAll(".guide-check")];
  const save = () => { try { localStorage.setItem(key, JSON.stringify([...done])); } catch { /* private mode */ } };
  const apply = () => {
    let d = 0;
    for (const cb of checks) {
      const on = done.has(+cb.dataset.q);
      cb.checked = on;
      cb.closest(".chain-step")?.classList.toggle("done", on);
      if (on) d++;
    }
    const shown = oneOf ? Math.min(d, 1) : d;
    const pct = total ? Math.round((100 * shown) / total) : 0;
    if (bar) bar.style.width = `${pct}%`;
    if (label) label.textContent = `${shown} / ${total} step${total === 1 ? "" : "s"} · ${pct}%`;
  };
  apply();
  app.querySelector(".chain-steps")?.addEventListener("change", (e) => {
    const cb = e.target.closest(".guide-check");
    if (!cb) return;
    const q = +cb.dataset.q;
    if (cb.checked) done.add(q); else done.delete(q);
    save(); apply();
  });
  app.querySelector(".guide-reset")?.addEventListener("click", () => { done.clear(); save(); apply(); });
}
