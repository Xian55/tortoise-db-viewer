import "./style.css";
import { query, queryOne, preconnect, getMeta, caps } from "./db.js";
import * as Q from "./queries.js";
import { renderTooltip, tabs, itemLink, npcLink, dungeonLink, questLink, factionLink, zoneLink, subzoneLink, spellLink, petFamilyLink, objectLink, spellTooltip, spellCost, resolveSpellText, moneyHtml, iconImg, iconGridImg, sourceTags, teamBadge, teamLabel, pct, dropQty, esc, setIconAtlas, setModelThumbs, modelThumbUrl, readableText } from "./render.js";
import { createTable } from "./table.js";
import { CREATURE_TYPE, CREATURE_RANK, PROFESSION_LABEL, QUEST_TYPE, REP_STANDING, REP_TO_STANDING, REP_EXALTED, repStandingReached, CONTINENT, GAMEOBJECT_TYPE, INV_TYPE, QUALITY, ITEM_CLASS, questZoneLabel, classRestrictions, setClassMask, raceRestrictions, questFaction, npcRoles, DMG_SCHOOL, RESISTANCES, SPELL_SCHOOL, POWER_TYPE, SPELL_DISPEL, SPELL_MECHANIC, SPELL_EFFECT, SPELL_AURA, SPELL_FLAGS, GEAR_STAT_LABEL, GEAR_CRITERIA, MAX_SKILL, skinningReq } from "./constants.js";
import { showBrowse } from "./browse.js";
import { selbarHtml, updateSelbar, wireSelbar } from "./selbar.js";
import { showCharacters, showCharacter, showSharedLoadout } from "./character.js";
import { showWeightSets, showSharedWeightSet } from "./weightsets.js";
import { externalMenuHtml, wireExternalMenu, chatMacro, chatButtonHtml, wireChatButton } from "./external.js";
import { initHovercards } from "./hovercard.js";
import { runSearch, initSearchDropdown, ftsQuery } from "./search.js";
import { ASSETS_BASE, MAPS_BASE, MAPS_BASE_MAIN, MINIMAP_BASE, MAP_SUB, DATA_BASE, API_BASE, MODEL_THUMBS_BASE, OWN_ITEM_MODELS, resolveOrigins, DATASET, DATASETS, EXPANSION, OG_BASE, HAS_OG_API, getAtlasUrls } from "./config.js";
import { buildNavHtml, wireNav, closeNav } from "./nav.js";
import { buildQuestMap } from "./questmap.js";
import { showLeveling, showGuide } from "./guide.js";
import { showPets, showPetFamily, showPetAbility } from "./pets.js";
import { showProfPlan } from "./profplan.js";
import { showTalents } from "./talents.js";
import { ratioCell, outlierLine, pctBeaten, PEER_MIN } from "./context.js";
import { soundPlayer, wireAudio, stopAudio, fmtDur } from "./audio.js";
// Seamless-minimap transform manifest (tile/adt/grid + per-continent bbox). Tiny,
// committed; bundled at build time. The tile pyramid itself lives on R2.
// Dataset-scoped minimap transform manifest (like the maps/minimap tiles): the vanilla
// client's continent geometry differs, so cMaNGOS uses minimap-vanilla-cmangos.json.
// Turtle main/dev use the base minimap.json. import.meta.glob tolerates a dataset that
// ships no manifest (falls back to the base).
const MINIMAP_MANIFESTS = import.meta.glob("../scripts/data/minimap*.json", { eager: true, import: "default" });
const minimapManifest = MINIMAP_MANIFESTS[`../scripts/data/minimap${MAP_SUB}.json`] || MINIMAP_MANIFESTS["../scripts/data/minimap.json"];

// CreatureSoundData slot -> the category it belongs to, wowhead-style. Derived from the
// slot rather than SoundEntries.type, which is a playback flag (2D/3D/looping) and says
// nothing about what the sound is.
// A machine transcript is marked, always. It is usually right, but it is a guess from
// audio -- presenting it identically to a line lifted from the server's own script would
// be asserting something we don't know.
const autoBadge = (r) => (r && r.src === "w" ? ` <span class="snd-auto" title="Automatic transcript from the audio — may be inaccurate">auto</span>` : "");

// ---- transcripts, per take ----
// A sound's numbered takes are DIFFERENT LINES, so quoting one of them as "the"
// transcript is wrong in both directions: it hides the other nine, and it disagrees with
// whichever take the player is about to play. `takesOf` builds sound -> [{take,text,src}]
// from Q_SOUND_TEXT_ALL and friends; a DB built before the `take` column simply yields an
// empty map and every page falls back to its old single-text column.
const takesOf = (rows) => {
  const m = new Map();
  for (const r of rows || []) {
    if (!m.has(r.sound)) m.set(r.sound, []);
    m.get(r.sound).push(r);
  }
  return m;
};
// One transcript line, tagged with its take so clicking it plays that take (audio.js).
const lineHtml = (t, numbered) => `<span class="snd-line"${t.take == null ? "" : ` data-take="${t.take}"`}`
  + ` title="${t.take == null ? "Play this clip" : `Play take ${t.take + 1}`}">${
    numbered && t.take != null ? `<span class="snd-linenum">${t.take + 1}</span>` : ""}${esc(t.text)}${autoBadge(t)}</span>`;
// One line per take. A sound can carry several rows for the same take -- the same words
// credited to two speakers, or a server-derived line sitting beside the machine one -- and
// the cell is about what is SAID, so it shows each take once. A take-less row is dropped
// as soon as any take-bearing row exists: it is the same sound described less precisely.
const dedupeTakes = (list) => {
  const ts = (list || []).filter((t) => t.text);
  const numbered = ts.filter((t) => t.take != null);
  const pool = numbered.length ? numbered : ts;
  const seen = new Set();
  return pool.filter((t) => {
    const k = t.take != null ? `#${t.take}` : t.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
// `row` supplies the legacy single-text fallback; `list` the per-take rows when present.
const transcriptCell = (row, list, opts = {}) => {
  const ts = dedupeTakes(list);
  if (!ts.length) return row && row.text ? esc(row.text) + autoBadge(row) : (opts.blank || "");
  // Numbered only when there is something to disambiguate. A single line needs no "1.".
  const numbered = ts.length > 1 && ts.some((t) => t.take != null);
  return `<span class="snd-lines">${ts.map((t) => lineHtml(t, numbered)).join("")}</span>`;
};
const transcriptText = (row, list) => {
  const ts = dedupeTakes(list);
  return ts.length ? ts.map((t) => t.text).join(" ") : (row && row.text) || "";
};
// Which take a search hit landed on, so the player opens on the line that matched rather
// than on take 1. Prefers a take whose own words contain the term (the FTS row's text is
// the matched line, but the term is what the reader typed).
const matchedTake = (list, term, hitText) => {
  const ts = (list || []).filter((t) => t.text && t.take != null);
  if (!ts.length) return 0;
  const lower = String(term || "").toLowerCase();
  const byTerm = lower && ts.find((t) => t.text.toLowerCase().includes(lower));
  if (byTerm) return byTerm.take;
  const byHit = hitText && ts.find((t) => t.text === hitText);
  return byHit ? byHit.take : ts[0].take;
};

const SOUND_KIND = {
  Loop: "NPC Loops",
  Greeting: "NPC Greetings", Farewell: "NPC Greetings", Annoyed: "NPC Greetings",
  Script: "Scripted", Voice: "Voice Lines",
  "Pet Attack": "Pet", "Pet Order": "Pet", "Pet Dismiss": "Pet",
};

const app = document.getElementById("app");
const searchInput = document.getElementById("search");

const lvlRange = (r) => (r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : (r.level_min || ""));

// Compact "2h" / "3h" / "12h" / "7d" / "2h13m" from a seconds value (vendor restock).
const fmtDuration = (s) => {
  if (!s || s <= 0) return "";
  if (s % 86400 === 0) return `${s / 86400}d`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}h` : "") + (m ? `${m}m` : "") + (!h && !m && sec ? `${sec}s` : "");
};
// Vendor stock cell: a limited item shows its cap + restock cadence (mangos regens
// 1 unit per `incrtime`); unlimited stock (maxcount 0) shows ∞.
const stockCell = (s) => (s.maxcount > 0
  ? `${s.maxcount}${s.incrtime > 0 ? ` <span class="dim" title="Restocks 1 every ${fmtDuration(s.incrtime)}">↻&nbsp;${fmtDuration(s.incrtime)}</span>` : ""}`
  : "∞");
const stockCol = { label: "Stock", num: true, cls: "muted", cell: stockCell, value: (s) => (s.maxcount > 0 ? s.maxcount : Infinity) };

// ---- sortable-table registry (mounted after innerHTML) ----
let pendingTables = [];
function regTable(columns, rows, opts = {}) {
  if (!rows || !rows.length) return { html: "", count: 0 };
  const id = `t${pendingTables.length}`;
  pendingTables.push({ id, columns, rows, ...opts });
  // tableId lets a caller reclaim this table's API from mountTables() -- needed by
  // anything driving the table from outside it (the selection bar).
  return { html: `<div class="tbl" data-table="${id}"></div>`, count: rows.length, tableId: id };
}
function mountTables() {
  const apis = new Map();
  for (const s of pendingTables) {
    const el = app.querySelector(`[data-table="${s.id}"]`);
    if (el) apis.set(s.id, createTable(el, s));
  }
  pendingTables = [];
  // Play buttons are delegated off #app, so sorting/paging a table (which replaces its
  // rows wholesale) can't detach the handler.
  wireAudio(app);
  return apis;
}
function wireTabs() {
  const bar = app.querySelector(".tabbar");
  if (!bar) return;
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    app.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === btn));
    app.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== btn.dataset.tab));
    // A pane whose content is expensive (the 3D viewer's chunk is ~600 KB of three.js)
    // mounts on first show rather than on page render, so opening an item page costs
    // nothing extra for the visitors who never touch the tab.
    bar.dispatchEvent(new CustomEvent("tabshow", { detail: { id: btn.dataset.tab }, bubbles: true }));
  });
}

// ---- routing ----
export function navigate(url, replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  renderRoute();
  window.scrollTo(0, 0); // new view starts at the top (SPA nav keeps scroll otherwise)
}
// Back/Forward must land at the top of the new view, exactly like an in-app click.
// navigate() scrolls itself, but the popstate path only re-rendered -- so going Back
// from a page you had scrolled down left you mid-document on the next one. (The
// replaceState callers -- browse filters, talents, the zone map -- don't route through
// here, so they keep their scroll position as intended.)
window.addEventListener("popstate", () => { renderRoute(); window.scrollTo(0, 0); });

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

// Data-source toggle (main <-> dev). Dev lives at the /dev/ path; these are plain
// cross-path <a> links (not .nav/.ilink, so the SPA interceptor above leaves them
// to a real navigation). syncDsToggle() re-points them at the *current* query on
// every render (SPA nav mutates location.search without reload), so flipping always
// keeps the entity you're on. A `ds-dev` class on <body> drives the "dev" ribbon.
{
  const ds = document.getElementById("dsToggle");
  if (ds) {
    ds.innerHTML = DATASETS.map((d) =>
      `<a data-ds="${d.id}" class="ds-btn" href=""${d.title ? ` title="${esc(d.title)}"` : ""}>${esc(d.label)}</a>`
    ).join("");
    ds.querySelector(`[data-ds="${DATASET}"]`)?.classList.add("on"); // active side (fixed per load)
  }
  if (DATASET === "dev") document.body.classList.add("ds-dev");
  syncDsToggle();
}

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

// The live 3D viewer, if any. A WebGL context is a scarce, non-GC'd resource: leave one
// behind per navigation and the browser silently kills the oldest canvas after a handful
// of pages, so the route owns its teardown exactly like it owns stopAudio().
let activeViewer = null;
function destroyViewer() {
  try { activeViewer?.destroy(); } catch { /* already torn down */ }
  activeViewer = null;
}

// Is WebGL available at all? Asked BEFORE the 3D tab is offered, and answered without
// importing the viewer chunk -- on a machine that cannot render, downloading ~600 KB of
// three.js to discover that would be the whole cost of the feature for no benefit.
let webglCached = null;
function webglOk() {
  if (webglCached === null) {
    try {
      const c = document.createElement("canvas");
      webglCached = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch { webglCached = false; }
  }
  return webglCached;
}

// Mount the 3D pane the first time its tab is opened. Deferred on purpose: the chunk is
// the largest on the site after the zone map, and most visitors to an item page never
// open it. Any failure -- chunk, model file, WebGL context -- degrades to a line of text
// inside the pane; the rest of the page has already rendered and must not be disturbed.
function mountModelTab(appearance) {
  const bar = app.querySelector(".tabbar");
  const host = app.querySelector("#mv-host");
  if (!bar || !host) return;
  let started = false;
  const mount = async () => {
    if (started) return;
    started = true;
    try {
      const { mountItemViewer } = await import("./modelviewer.js");
      host.innerHTML = "";
      destroyViewer();
      activeViewer = await mountItemViewer(host, {
        model: appearance.model_l,
        texture: appearance.tex_l,
      });
    } catch (err) {
      host.innerHTML = `<p class="muted">3D preview unavailable${err?.message ? ` — ${esc(err.message)}` : ""}.</p>`;
    }
  };
  // Mount when the pane BECOMES VISIBLE, not when its tab is clicked. The click is only
  // one way to get there, and relying on it leaves the pane stuck on "Loading model…"
  // whenever the listener is missing -- which is exactly what a Vite HMR update does, by
  // re-running this module while leaving the already-rendered DOM in place. Visibility is
  // the actual condition we care about, so observe that instead.
  if (typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      mount();
    });
    io.observe(host);
  } else {
    bar.addEventListener("tabshow", (e) => { if (e.detail?.id === "model3d") mount(); });
  }
}

function route() {
  // Audio must not outlive the page that started it -- a zone track would keep playing
  // over whatever you navigated to.
  stopAudio();
  destroyViewer();
  const params = new URLSearchParams(location.search);
  const item = params.get("item");
  const npc = params.get("npc");
  const quest = params.get("quest");
  const spell = params.get("spell");
  const itemset = params.get("itemset");
  const faction = params.get("faction");
  const zone = params.get("zone");
  const subzone = params.get("subzone");
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
  else if (subzone) return showSubzone(Number(subzone));
  else if (dungeon) return showDungeon(Number(dungeon));
  else if (object) return showObject(Number(object));
  else if (icon) return showIcon(icon);
  else if (params.get("icons") !== null) return showIcons();
  else if (params.get("voicelines") !== null) return showVoiceLines();
  else if (params.get("sounds") !== null) return showSounds();
  else if (params.get("sound")) return showSound(Number(params.get("sound")));
  else if (params.get("flights") !== null) return showFlights(params.get("cont") ? Number(params.get("cont")) : 0);
  else if (params.get("worldmap") !== null) return showWorldMap(params.get("worldmap") ? Number(params.get("worldmap")) : 0);
  else if (params.get("dungeons") !== null) return showDungeons();
  else if (params.get("changelog") !== null) return showChangelog();
  else if (params.get("random") !== null) return showRandom();
  else if (params.get("guides") !== null) return showLeveling();
  else if (params.get("guide")) return showGuide(params.get("guide"));
  else if (params.get("petability")) return showPetAbility(params.get("petability"));
  else if (params.get("petfamily")) return showPetFamily(Number(params.get("petfamily")));
  else if (params.get("pets") !== null) return showPets();
  else if (params.get("profplan") !== null) return showProfPlan(params.get("profplan"));
  else if (params.get("talents") !== null) return showTalents(params.get("talents"));
  else if (params.get("dressing") !== null) return showDressingRoom(params, navigate);
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
// Entities exposed by the public JSON API (scripts/build-api.mjs emits i/n/q/s).
// Drives the "{ } JSON" button next to Share.
const API_PREFIX = { item: "i", npc: "n", quest: "q", spell: "s" };
function addShareButton() {
  const params = new URLSearchParams(location.search);
  let param = null, id = null;
  for (const k in SHARE_PREFIX) { const v = params.get(k); if (v) { param = k; id = v; break; } }
  if (!id) return;
  // anchor: the page heading (most pages) or the meta line (item/spell pages put
  // the name in a tooltip card, not an <h1>).
  const anchor = app.querySelector("h1, .item-meta, .spell-sub");
  if (!anchor || (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains("share-btn"))) return;
  // Unfurl-capable share link (see OG_BASE / HAS_OG_API). Falls back to the plain app
  // URL when no OG origin is configured (a fork without the Worker) or when this dataset
  // has no unfurl coverage -- the fallback is built from location.pathname, NOT
  // BASE_URL, so it keeps the dataset directory (/tbc/cmangos/) instead of silently
  // sending the recipient to main's copy of a different item.
  const url = OG_BASE && HAS_OG_API
    ? `${OG_BASE}/${SHARE_PREFIX[param]}/${id}`
    : `${location.origin}${location.pathname}?${param}=${id}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "share-btn";
  btn.title = HAS_OG_API
    ? "Copy a link that shows a rich preview in Discord, Twitter, etc."
    : "Copy a link to this page";
  btn.textContent = "🔗 Share";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "✓ Link copied";
      setTimeout(() => { btn.textContent = "🔗 Share"; }, 1600);
    } catch { btn.textContent = "Copy failed"; }
  });
  anchor.insertAdjacentElement("afterend", btn);
  // "{ } JSON" — open the entity's rich JSON API endpoint (item/npc/quest/spell
  // only): the same data the page shows. Cross-origin / not .nav|.ilink, so the SPA
  // interceptor leaves it; opens in a new tab.
  if (API_PREFIX[param] && HAS_OG_API) {
    const j = document.createElement("a");
    j.className = "share-btn json-btn";
    j.href = `${API_BASE}/${API_PREFIX[param]}/${id}`;
    j.target = "_blank";
    j.rel = "noopener";
    j.title = "View this entity's data as JSON (public API)";
    j.textContent = "{ } JSON";
    btn.insertAdjacentElement("afterend", j);
  }
}

// "🌐 Open in ▾" — the same entity on TurtleDB / OctoWow / Wowhead / WoW Classic DB.
// Kept OUT of addShareButton and run separately because it is async (it looks up the
// Turtle-custom flag) and Share must not wait on a DB round-trip to appear.
async function addExternalMenu() {
  const params = new URLSearchParams(location.search);
  let param = null, id = null;
  for (const k in SHARE_PREFIX) { const v = params.get(k); if (v) { param = k; id = v; break; } }
  if (!id) return;
  // After the LAST existing button, so the row reads Share · JSON · Open in rather than
  // the menu wedging itself between Share and JSON.
  const btns = app.querySelectorAll(".share-btn:not(.xt-btn)");
  const anchor = btns[btns.length - 1] || app.querySelector("h1, .item-meta, .spell-sub");
  if (!anchor || app.querySelector(".xt-wrap")) return;
  // One row: the display name (for the chat macro) and the Turtle-custom flag. Only
  // items/creatures/quests carry the flag; the rest are offered everywhere rather than
  // greyed on an id-range guess. A DB without the column just answers null.
  const sql = Q.qEntityMeta(param);
  const row = sql ? await queryOne(sql, [Number(id)]).catch(() => null) : null;
  const custom = !!(row && row.custom);
  // The route may have changed while that query was in flight (fast clicking) -- adding
  // the buttons then would attach the previous entity's links to the new page.
  if (new URLSearchParams(location.search).get(param) !== id || app.querySelector(".xt-wrap")) return;
  const menu = externalMenuHtml(param, id, custom);
  if (menu) {
    anchor.insertAdjacentHTML("afterend", menu);
    wireExternalMenu(app.querySelector(".xt-wrap"));
  }
  // Chat link: only item/quest/spell are linkable in-game at all, so the button is
  // simply absent on an NPC/object/zone/faction rather than copying something inert.
  const macro = chatMacro(param, id, row);
  if (macro) {
    (app.querySelector(".xt-wrap") || anchor).insertAdjacentHTML("afterend", chatButtonHtml(macro));
    wireChatButton(app.querySelector(".xt-chat"));
  }
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

// Re-point the main/dev toggle links at the CURRENT query (SPA nav changes
// location.search without reload, so boot-time hrefs go stale). Strip `db` — the
// path decides the dataset, and a leftover `?db=dev` on the Main link would bounce
// you back to dev.
function syncDsToggle() {
  const ds = document.getElementById("dsToggle");
  if (!ds) return;
  const p = new URLSearchParams(location.search);
  p.delete("db");
  const qs = p.toString();
  const suffix = qs ? `?${qs}` : "";
  const B = import.meta.env.BASE_URL;
  for (const d of DATASETS) {
    const a = ds.querySelector(`[data-ds="${d.id}"]`);
    if (a) a.href = `${B}${d.path ? `${d.path}/` : ""}${suffix}`;
  }
}

// route() then drop the Share + compare buttons onto the rendered detail page.
function renderRoute() {
  syncDsToggle(); // reflect the new URL immediately -- location.search is already
                  // updated, so don't wait for a slow async render to finish
  const p = Promise.resolve(route());
  const after = () => { addShareButton(); addCompareButton(); renderCompareTray(); addExternalMenu(); };
  p.then(after, after);
  return p;
}

// ---- views ----
function showHome() {
  document.title = "Tortoise-WoW Database";
  const card = (href, icon, title, desc, cls = "") =>
    `<a class="nav home-card ${cls}" href="${href}"><span class="hc-icon">${iconImg(icon, "hc-img")}</span>
      <span class="hc-body"><span class="hc-title">${title}</span><span class="hc-desc">${desc}</span></span></a>`;
  const section = (title, cards) => `<section class="home-section"><h2>${title}</h2><div class="home-grid">${cards.join("")}</div></section>`;

  app.innerHTML = `<div class="home">
    <div class="home-hero">
      <h1>Tortoise-WoW Database</h1>
      <p class="home-tag">Everything in Turtle-WoW's world — items, NPCs, quests, spells, zones — queried right in your browser. Plus planners for your gear and talents.</p>
    </div>

    ${section("Plan your character", [
      card("?characters", "inv_shield_06", "Character Planner", "Import your gear (GearExport), see set bonuses, and get slot-by-slot upgrades ranked for your spec. Share builds by link.", "feature"),
      card("?weights", "ability_marksmanship", "Gear-Score Presets", "Build, share, and reuse stat-weight sets — 22 class/spec starters, or make your own.", "feature"),
      card("?talents", "inv_misc_book_11", "Talent Calculator", "Plan any class's 51-point build; the link saves it.", "feature"),
      card("?profplan=164", "trade_blacksmithing", "Profession Leveling", "Efficient 1→300 routes with a deduped materials shopping list, for every crafting profession.", "feature"),
    ])}

    ${section("Browse the database", [
      card("?browse=items", "inv_sword_27", "Items", "Filter by slot, stat, and source; rank by gear score."),
      card("?browse=itemsets", "inv_chest_plate01", "Item Sets", "Tier & dungeon sets with their bonuses."),
      card("?browse=npcs", "inv_misc_head_dragon_01", "NPCs", "Creatures, loot, locations."),
      card("?pets", "ability_hunter_beasttaming", "Hunter Pets", "Tameable families — diet, abilities, where to tame."),
      card("?browse=quests", "inv_scroll_03", "Quests", "Objectives, rewards, chains."),
      card("?browse=spells", "spell_holy_magicalsentry", "Spells & Abilities", "Class skills and professions."),
      card("?browse=crafting", "trade_blacksmithing", "Crafting & Professions", "Recipes, reagents, learnable skills."),
      card("?browse=factions", "inv_bannerpvp_02", "Factions", "Reputation rewards and rep grinds."),
      card("?browse=zones", "inv_misc_map_01", "Zones", "Spawns, drops, and quests per zone."),
      card("?browse=objects", "inv_crate_02", "Objects", "Gather nodes, chests, and more."),
    ])}

    ${section("Maps & travel", [
      card("?dungeons", "inv_misc_key_11", "Dungeons & Raids", "Instance maps, bosses, and loot."),
      card("?worldmap", "inv_misc_spyglass_02", "World Map", "Seamless continent minimap with spawns."),
      card("?flights", "ability_mount_gryphon_01", "Flight Paths", "Every flight master and route."),
      card("?guides", "inv_misc_book_09", "Leveling Guides", "Step-by-step zone routes."),
      card("?random", "inv_misc_orb_04", "Random Item", "Roll the dice on a random item."),
      card("?icons", "inv_misc_gem_variety_01", "Icons", "Every item & spell icon."),
      card("?voicelines", "inv_misc_horn_01", "Voice Lines", "Hear what they say — with transcripts."),
      card("?sounds", "inv_misc_drum_02", "Sounds", "Every extracted sound — music, ambience, voices."),
    ])}

    <p class="muted home-hint">Jump straight to anything with <code>?item=ID</code>, <code>?npc=ID</code>, <code>?quest=ID</code>, <code>?spell=ID</code>, <code>?faction=ID</code>, or <code>?zone=ID</code> —
      e.g. <a class="ilink" href="?item=2770">Copper Ore</a> · <a class="ilink" href="?item=7909">Aquamarine</a> · <a class="ilink" href="?npc=2376">Torn Fin Oracle</a>.</p>
    <p class="muted">Embedding elsewhere? Drop our
      <a class="nav-ext" href="${import.meta.env.BASE_URL}embed/tw-power.js">tooltip widget</a>
      on any page for Wowhead-style hover tooltips —
      <a class="nav-ext" href="${import.meta.env.BASE_URL}embed/demo.html" target="_blank" rel="noopener">see the demo</a>.</p>

    <section class="home-section home-api">
      <h2>Static JSON endpoints</h2>
      <p class="muted">No backend — the data ships as plain static files you can <code>fetch()</code> directly (CORS-open, served from the CDN). Handy for bots, addons, or your own tools:</p>
      <ul class="api-list">
        <li><code>${API_BASE.replace(/^https?:\/\//, "")}/&lt;i|n|q|s&gt;/&lt;id&gt;</code> — the <b>public API</b>: full per-entity data (item / npc / quest / spell) — stats, sources, and the rendered tooltip — as JSON. <a class="nav-ext" href="${API_BASE}/i/2770" target="_blank" rel="noopener">example: i/2770</a>${HAS_OG_API ? "" : ` <em class="muted">(ids are from the Main dataset — this endpoint doesn't cover ${esc(DATASETS.find((d) => d.id === DATASET)?.label || DATASET)})</em>`}</li>
        <li><code>tt/&lt;i|n|q|s&gt;/&lt;id&gt;.json</code> — compact name/icon/level tooltip data (a lightweight subset of the API). <a class="nav-ext" href="${ASSETS_BASE}tt/i/2770.json" target="_blank" rel="noopener">example</a></li>
        <li><code>data/version.json</code> — current build hash + timestamp. <a class="nav-ext" href="${DATA_BASE}version.json" target="_blank" rel="noopener">open</a></li>
        <li><code>data-dev/changelog.json</code> — per-deploy "What's new" for the <b>dev</b> dataset. <a class="nav" href="${import.meta.env.BASE_URL}dev/?changelog">view</a></li>
        <li><code>data/tortoise.sqlite</code> — the whole indexed database (Brotli on the wire), queryable with any SQLite tool. <span class="dim">dev copy at <code>data-dev/</code>.</span></li>
      </ul>
    </section>
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
    // quests.zone is a LEAF area -> a zone page, a subzone page, or (negative ids) a
    // sort category with no page at all. The name itself was missing from the query
    // until now, so this cell rendered empty for every real zone.
    { label: "Zone", cls: "muted",
      cell: (r) => r.zone_page ? zoneLink(r.zone, questZoneLabel(r.zone, r.zone_name))
        : r.sub_page ? subzoneLink(r.zone, questZoneLabel(r.zone, r.zone_name))
        : esc(questZoneLabel(r.zone, r.zone_name)),
      value: (r) => questZoneLabel(r.zone, r.zone_name) },
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
  // Zone column is load-bearing, not decoration: subzone names repeat across the world.
  const subzoneCols = [
    { label: "Name", cell: (r) => subzoneLink(r.entry, r.name), value: (r) => r.name },
    { label: "Zone", cls: "muted", cell: (r) => (r.zone_id ? zoneLink(r.zone_id, r.zone_name || `#${r.zone_id}`) : ""), value: (r) => r.zone_name || "" },
    { label: "Continent", cls: "muted", cell: (r) => CONTINENT[r.map_id] || "", value: (r) => CONTINENT[r.map_id] || "" },
    { label: "Spawns", num: true, cls: "muted", cell: (r) => r.spawns || "", value: (r) => r.spawns || 0 },
  ];
  // Voice lines matched either by what is SAID or by the sound's name, so both columns
  // are shown -- a name-only hit (most of Turtle's voice acting has no text row) would
  // otherwise be a blank row.
  // Gossip search: the phrase lives on the NPC, not on any sound, so a hit resolves to
  // the NPC that says it.
  const gossipSearchCols = [
    { label: "NPC", cell: (r) => npcLink(r.entry, r.name) + (r.subname ? ` <span class="muted">&lt;${esc(r.subname)}&gt;</span>` : ""), value: (r) => r.name },
    { label: "Says", cls: "gossip-text", cell: (r) => questText(r.text), value: (r) => r.text },
  ];
  const voiceSearchCols = [
    // runSearch resolves which TAKE matched; the player opens on it and the transcript
    // lists every take, with the matched one just another numbered line among them.
    { label: "Play", cls: "snd-col", cell: (r) => soundPlayer(r, { label: false, take: r.take }), value: (r) => r.name || "" },
    {
      label: "Transcript", cls: "snd-text",
      cell: (r) => transcriptCell(r, r.takes, { blank: `<span class="muted">— no transcript —</span>` }),
      value: (r) => r.text || "￿",
    },
    {
      label: "Speaker", hideEmpty: true,
      cell: (r) => (r.creature ? npcLink(r.creature, r.creature_name) : ""),
      value: (r) => r.creature_name || "",
    },
    { label: "Sound", cls: "muted", cell: (r) => esc(r.name || ""), value: (r) => r.name || "" },
    { label: "Length", num: true, cls: "muted", cell: (r) => fmtDur(r.ms), value: (r) => r.ms || 0 },
  ];
  const spellCols = [
    { label: "Name", cell: (r) => spellLink(r.entry, r.name, r.icon), value: (r) => r.name },
    // spells.rank is the client's subtext: usually "Rank N", but also "Passive",
    // "Toy", "Game Master". Sort numerically when it IS a rank so Rank 10 follows
    // Rank 9 rather than Rank 1, and push the non-numeric labels to the end.
    { label: "Rank", cls: "muted", cell: (r) => esc(r.rank || ""), value: (r) => { const m = /^Rank (\d+)$/.exec(r.rank || ""); return m ? +m[1] : (r.rank ? 1e6 : 0); } },
    { label: "Level", num: true, cls: "muted", cell: (r) => r.spell_level || "", value: (r) => r.spell_level || 0 },
    // school 0 is the default on ~21k rows (learn-stubs and non-damaging spells), so
    // printing "Physical" for all of them would invent a fact. Blank is honest.
    { label: "School", cls: "muted", cell: (r) => (r.school > 0 ? esc(SPELL_SCHOOL[r.school] || "") : ""), value: (r) => (r.school > 0 ? SPELL_SCHOOL[r.school] || "" : "") },
    { label: "Profession", cls: "muted", cell: (r) => esc(PROFESSION_LABEL[r.skill] || ""), value: (r) => PROFESSION_LABEL[r.skill] || "" },
  ];
  const factionCols = [
    { label: "Name", cell: (r) => factionLink(r.id, r.name), value: (r) => r.name },
  ];
  const itemsetCols = [
    { label: "Name", cell: (r) => `<a class="ilink" href="?itemset=${r.id}">${esc(r.name)}</a>`, value: (r) => r.name },
    { label: "Class", cls: "muted", cell: (r) => (classRestrictions(r.clsmask) || []).join(", "), value: (r) => (classRestrictions(r.clsmask) || []).join(", ") },
  ];

  const itemsets = res.itemsets || [];
  // Search results get the same selection ops as ?browse=items -- finding things by
  // name and bulk-copying their ids is the same job, and it was odd that only the
  // filter-driven view could do it. Both Items and Spells are selectable; each pane
  // carries its own bar, so the count/ops target the right table (the bar is looked
  // up per pane rather than app-wide, which would find whichever came first).
  const selPanes = [];
  const selectableTab = (id, label, cols, rows, kind) => {
    const t = regTable(cols, rows, {
      pageSize: 100, selectable: true, rowKey: (r) => r.entry,
      onSelectionChange: (count) => updateSelbar(app.querySelector(`[data-pane="${id}"] [data-selbar]`), count),
    });
    if (t.html) selPanes.push({ id, tableId: t.tableId, kind });
    return { id, label, html: (t.html ? selbarHtml(kind) : "") + t.html, count: t.count };
  };
  const tabDefs = [
    selectableTab("items", "Items", itemCols, res.items, "item"),
    { id: "npcs", label: "NPCs", ...regTable(npcCols, res.npcs, { pageSize: 100 }) },
    { id: "quests", label: "Quests", ...regTable(questCols, res.quests, { pageSize: 100 }) },
    selectableTab("spells", "Spells", spellCols, res.spells, "spell"),
    { id: "factions", label: "Factions", ...regTable(factionCols, res.factions) },
    { id: "itemsets", label: "Item Sets", ...regTable(itemsetCols, itemsets) },
    { id: "dungeons", label: "Dungeons", ...regTable(dungeonCols, res.dungeons) },
    { id: "objects", label: "Objects", ...regTable(objectCols, res.objects || []) },
    { id: "zones", label: "Zones", ...regTable(zoneCols, res.zones) },
    { id: "subzones", label: "Subzones", ...regTable(subzoneCols, res.subzones || []) },
    { id: "voice", label: "Voice Lines", ...regTable(voiceSearchCols, res.voice || [], { pageSize: 100 }) },
    { id: "gossip", label: "Dialogue", ...regTable(gossipSearchCols, res.gossip || [], { pageSize: 100 }) },
  ];
  const total = res.items.length + res.npcs.length + res.quests.length + res.spells.length + res.factions.length + itemsets.length + res.dungeons.length + (res.objects || []).length + res.zones.length + (res.subzones || []).length + (res.voice || []).length + (res.gossip || []).length;
  if (!total) { app.innerHTML = `<div class="home"><p>No results for “${esc(term)}”.</p></div>`; return; }

  app.innerHTML = `<div class="results"><h1>Results for “${esc(term)}”</h1>${tabs(tabDefs)}</div>`;
  const apis = mountTables();
  wireTabs();
  for (const p of selPanes) {
    const bar = app.querySelector(`[data-pane="${p.id}"] [data-selbar]`);
    const api = apis.get(p.tableId);
    if (bar && api) wireSelbar(bar, api, navigate, p.kind);
  }
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
  const setCls = classRestrictions(setClassMask(members));
  const clsLine = setCls ? `<div class="set-class dim">Classes: ${esc(setCls.join(", "))}</div>` : "";
  return `<div class="panel item-set">
    <div class="set-name">${head} <span class="dim">(${members.length} pieces)</span></div>
    ${clsLine}
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
    if (!g) { g = { chance: 0, stats: {}, best: 0 }; groups.set(key, g); }
    g.chance += r.chance || 0;
    // Within one suffix NAME the ids are the stat permutations, not tiers ("of the Bear"
    // = 8/8, 9/8, 8/9, 9/9), so the highest id is that suffix's MAX roll -- the one worth
    // handing someone as a chat link.
    if (r.id > g.best) g.best = r.id;
    for (const k in st) { const c = g.stats[k] || [Infinity, -Infinity]; g.stats[k] = [Math.min(c[0], st[k]), Math.max(c[1], st[k])]; }
  }
  const lis = [...groups.entries()].sort((a, b) => b[1].chance - a[1].chance).map(([name, g]) => {
    const statStr = Object.entries(g.stats).map(([k, [mn, mx]]) => `+${mn === mx ? mn : `${mn}–${mx}`} ${esc(GEAR_STAT_LABEL[k] || k)}`).join(", ");
    // The chat link's bracket text is LITERAL -- the client does not append the suffix to
    // it -- so the button carries the suffix name as well as the id.
    const copy = g.best
      ? ` <button type="button" class="suf-chat" data-ench="${g.best}" data-suf="${esc(name)}"
           title="Copy an in-game chat link for the best roll of this suffix">\u{1F4AC}</button>`
      : "";
    return `<li><span class="suf-name">${esc(name)}</span> <span class="muted suf-stats">${statStr}</span> <span class="suf-chance muted">${g.chance.toFixed(1)}%</span>${copy}</li>`;
  });
  return `<div class="item-suffixes">
    <h2>🎲 Random suffixes</h2>
    <p class="muted">This item can drop with one of these random suffixes:</p>
    <ul class="suf-list">${lis.join("")}</ul></div>`;
}

// "vs. typical Epic ilvl 60–64 Dagger" -- the item-page twin of the NPC Stats tab's
// peer column. The cohort (same class/subclass/slot/quality/ilvl band) and this item's
// rank inside it are precomputed by build-db (see scripts/lib/itempeers.mjs), so this
// is pure formatting. A metric is shown only when the cohort actually HAS it (a chest
// has no DPS) and enough members carry it to make a median mean something.
function itemPeerCard(peer) {
  if (!peer || !peer.label) return "";
  // `word` is the label as it reads mid-sentence in the headline / baseline note
  // ("Highest DPS of all 22 …", "median … — 27.3 DPS").
  const metrics = [
    { key: "dps", label: "DPS", word: "DPS", n: peer.n_dps, val: peer.dps, med: peer.med_dps, rank: peer.dps_rank, fmt: (v) => v.toFixed(1) },
    { key: "armor", label: "Armor", word: "armor", n: peer.n_armor, val: peer.armor, med: peer.med_armor, rank: peer.armor_rank, fmt: (v) => Math.round(v).toLocaleString() },
    // The five 1.12 primaries summed. Deliberately NOT a "score": +Spell Damage and
    // +Crit live on the item too, and adding them to a stat total would compare
    // unlike things (see the stat-weight ranking in Browse for that job).
    { key: "stats", label: "Base stats", word: "base stats", n: peer.n_stats, val: peer.stats, med: peer.med_stats, rank: peer.stats_rank, fmt: (v) => Math.round(v).toLocaleString(),
      hint: "Strength + Agility + Stamina + Intellect + Spirit" },
  ].filter((m) => m.val > 0 && m.rank && m.n >= PEER_MIN && m.med > 0);
  if (!metrics.length) return "";

  // Slot names are already plural or irregular ("Legs", "Hands", "Feet") -- only the
  // singular ones take an "s" ("Fingers", "One-Handed Axes").
  const plural = `${esc(peer.label)}${/(s|Feet)$/i.test(peer.label) ? "" : "s"}`;
  const head = outlierLine(metrics.map((m) => ({ label: m.word, ratio: m.val / m.med, rank: m.rank, n: m.n })), plural);
  const rows = metrics.map((m) => {
    const beat = pctBeaten(m.rank, m.n);
    // Only the ends of the distribution get a chip -- "top 47%" is not information.
    const chip = beat >= 90 ? `<span class="peer-chip hi">top ${Math.max(1, 100 - beat)}%</span>`
      : beat <= 10 ? `<span class="peer-chip lo">bottom ${Math.max(1, beat === 0 ? 1 : beat)}%</span>` : "";
    return `<tr title="Rank ${m.rank} of ${m.n} — median ${m.fmt(m.med)}${m.hint ? ` · ${m.hint}` : ""}">
      <th>${m.label}</th>
      <td class="peer-v">${m.fmt(m.val)}${chip}</td>
      <td>${ratioCell(m.val / m.med, { positive: true })}</td></tr>`;
  }).join("");
  const medNote = metrics.map((m) => `${m.fmt(m.med)} ${m.word}`).join(" · ");
  return `<div class="peer-card">
    <div class="peer-head">vs. typical <b>${esc(peer.label)}</b></div>
    ${head}
    <table class="peer-tbl">${rows}</table>
    <p class="peer-note muted">Baseline: median of ${peer.n.toLocaleString()} comparable items — ${medNote}.</p>
  </div>`;
}

async function showItem(id) {
  app.innerHTML = `<div class="loading">Loading item ${id}…</div>`;
  let it;
  try { it = await queryOne(Q.Q_ITEM, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!it) { app.innerHTML = `<div class="home"><p>No item with ID ${id}.</p></div>`; return; }
  document.title = `${it.name} - Tortoise-WoW DB`;

  // Readable items (books, letters, documents) carry a page_text chain to show.
  const readablePages = it.page_text > 0 ? await query(Q.Q_PAGE_TEXT, [it.page_text]) : [];

  const spellIds = [1, 2, 3, 4, 5].map((i) => it[`spellid_${i}`]).filter(Boolean);
  const spellMap = new Map();
  await Promise.all(spellIds.map(async (sid) => {
    const sp = await queryOne(Q.Q_SPELL, [sid]);
    if (sp) spellMap.set(sid, sp);
  }));
  // Mount items summon a creature (resolved item -> spell -> creature in build-db).
  const mountRow = it.is_mount ? await queryOne(Q.Q_ITEM_MOUNT, [id]) : null;
  const mountOpt = mountRow ? { entry: mountRow.creature, name: mountRow.creature_name, displayId: mountRow.display_id } : null;

  const [dropped, objects, sold, contained, contains, disen, quests, starts, createdBy, reagentFor, teaches, srcRows, gatherSpawns, sameModel] =
    await Promise.all([
      query(Q.Q_DROPPED_BY, [id]), query(Q.Q_OBJECT_SOURCE, [id]), query(Q.Q_SOLD_BY, [id]),
      query(Q.Q_CONTAINED_IN, [id]), query(Q.Q_CONTAINS, [id]), query(Q.Q_DISENCHANTS_INTO, [id]), query(Q.Q_QUEST_ITEM, [id]),
      query(Q.Q_STARTS_QUEST, [id]), query(Q.Q_CREATED_BY, [id]), query(Q.Q_REAGENT_FOR, [id]),
      query(Q.Q_TEACHES, [id]), query(Q.Q_ITEM_SOURCES, [id]), query(Q.Q_ITEM_OBJECT_SPAWNS, [id]),
      it.display_id ? query(Q.Q_SAME_MODEL, [it.display_id, id]) : Promise.resolve([]),
    ]);
  // Peer baseline (equippable gear only; everything else has no cohort row). The
  // dev / cMaNGOS datasets are rebuilt on their own schedule, so a DB predating the
  // item_peer tables must lose the card, not the page.
  const peer = it.inventory_type > 0
    ? await queryOne(Q.Q_ITEM_PEERS, [id]).catch(() => null)
    : null;
  // Socket/gem display text (TBC). Same graceful-degradation contract as the peer
  // card: a dataset predating enchant_text/gem_properties -- or any 1.12 one, where
  // the item simply has no sockets -- drops the lines, never the page.
  const sockets = (it.socketColor_1 || it.GemProperties)
    ? await queryOne(Q.Q_ITEM_SOCKETS, [it.socketBonus || 0, it.GemProperties || 0]).catch(() => null)
    : null;
  // What this item looks like in 3D. OPTIONAL SCHEMA (caps().appearance): a dev/cMaNGOS
  // DB built before the feature simply has no table, and the tab disappears rather than
  // the page breaking.
  const appearance = (OWN_ITEM_MODELS && it.display_id && (await caps()).appearance)
    ? await queryOne(Q.Q_ITEM_APPEARANCE, [it.display_id]).catch((e) => {
      // Losing the row silently means the 3D tab just is not there, with nothing
      // anywhere saying why -- which is exactly how this went unexplained for three
      // smoke runs.
      console.warn("item appearance lookup failed:", e?.message || e);
      return null;
    })
    : null;
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

  // where each dropping NPC / vendor lives (zone or dungeon), batched
  const [dropLoc, soldLoc] = await Promise.all([
    resolveNpcLocations(dropped.map((d) => d.entry)),
    resolveNpcLocations(sold.map((s) => s.entry)),
  ]);
  const dchance = (d) => d.drop_chance ?? d.skin_chance ?? d.pick_chance;
  const srcTag = (d) => (d.skin_chance != null ? ' <span class="muted">(skin)</span>' : d.pick_chance != null ? ' <span class="muted">(pickpocket)</span>' : "");
  // Qty = stack size dropped (blank for the usual single); value sorts by max count.
  const qtyText = (d) => ((d.maxcount || 0) > 1 ? (d.mincount > 0 && d.mincount < d.maxcount ? `${d.mincount}-${d.maxcount}` : `${d.maxcount}`) : "");
  const droppedCols = [
    { label: "NPC", cell: (d) => npcLink(d.entry, d.name) + srcTag(d), value: (d) => d.name },
    { label: "Level", num: true, cls: "muted", cell: (d) => lvlRange(d), value: (d) => d.level_max || d.level_min || 0 },
    { label: "Location", cls: "muted", cell: (d) => (dropLoc.get(d.entry) || {}).html || "", value: (d) => (dropLoc.get(d.entry) || {}).text || "" },
    { label: "Qty", num: true, cls: "muted", hideEmpty: true, cell: (d) => qtyText(d), value: (d) => d.maxcount || 0 },
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
    { label: "Faction", cls: "muted", cell: (s) => teamBadge(s.team), value: (s) => teamLabel(s.team) },
    { label: "Level", num: true, cls: "muted", cell: (s) => lvlRange(s), value: (s) => s.level_max || s.level_min || 0 },
    { label: "Location", cls: "muted", cell: (s) => (soldLoc.get(s.entry) || {}).html || "", value: (s) => (soldLoc.get(s.entry) || {}).text || "" },
    stockCol,
  ];
  const itemChanceCols = [
    { label: "Item", cell: (c) => itemLink(c.entry, c.name, c.quality, c.icon) + dropQty(c.mincount, c.maxcount), value: (c) => c.name },
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
    { label: "Creates",
      cell: (r) => (r.created
        ? itemLink(r.created, r.created_name, r.quality, r.created_icon)
        : '<span class="muted">—</span>'),
      value: (r) => r.created_name || "" },
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
    { id: "reagent", label: "Reagent for", ...regTable(reagentForCols, reagentFor) },
    { id: "samemodel", label: "Same model", ...regTable(sameModelCols, sameModel) },
  ];

  // A 3D tab, but only when there is something to show. `per_race` items (every helm,
  // most shoulders) are modelled once PER RACE AND GENDER, so they need a character to
  // sit on -- until that exists, offering an empty tab would be worse than none. Armor
  // with no model of its own is texture-only for the same reason.
  const model3d = appearance && appearance.model_l && appearance.per_race === 0 && webglOk();
  // Why the tab is absent, on the element itself. Four independent gates can hide it and
  // three of them are invisible from the outside, which turned one flaky smoke failure
  // into a long hunt; it also answers "why do I not have the 3D tab" for a visitor.
  app.dataset.model3d = model3d ? "on"
    : !OWN_ITEM_MODELS ? "dataset"
      : !it.display_id ? "no-display"
        : !appearance ? "no-appearance-row"
          : !appearance.model_l ? "texture-only"
            : appearance.per_race !== 0 ? "per-race-model"
              : "no-webgl";
  if (model3d) {
    tabDefs.push({
      id: "model3d", label: "3D", count: 1, noCount: true,
      html: `<div id="mv-host" class="mv-host"><p class="muted">Loading model…</p></div>`,
    });
  }

  // quality + item-class subtitle, each a link into the item browser filtered by it
  // (e.g. "Common · Trade Goods"). Mirrors what the embed tooltip surfaces.
  const qual = QUALITY[it.quality];
  const clsName = ITEM_CLASS[it.class];
  const classLine =
    (qual ? `<a class="nav item-qual" style="color:${qual.color}" href="?browse=items&quality=${it.quality}">${esc(qual.name)}</a>` : "") +
    (clsName ? `${qual ? ' <span class="dim">·</span> ' : ""}<a class="nav" href="?browse=items&class=${it.class}">${esc(clsName)}</a>` : "");

  app.innerHTML =
    `<div class="item-view">
      <div class="item-main">${renderTooltip(it, { spellMap, linkSpells: true, set: setOpt, mount: mountOpt, sockets })}
        ${classLine ? `<div class="item-classline">${classLine}</div>` : ""}
        <div class="item-meta muted">Item #${it.entry} · iLvl ${it.item_level || "—"}${it.world_drop ? ' · <span class="tagx">World Drop</span>' : ""}${it.rolls_suffix ? ' · <span class="tagx" title="Can drop with a random suffix">🎲 Random suffix</span>' : ""}</div>
        ${srcCsv ? `<div class="item-sources">${sourceTags(srcCsv)}</div>` : ""}
        ${itemPeerCard(peer)}
        ${suffixSection(suffixes)}
        ${readableText(readablePages)}
      </div>
      <div class="item-rel">${tabs(tabDefs)}</div>
    </div>`;
  mountTables();
  wireTabs();
  if (model3d) mountModelTab(appearance);
  // Per-suffix chat link. Delegated, so it survives nothing in particular here but keeps
  // the macro building where `it` (name + quality) already is, instead of stamping ~30
  // fully-built macros into data- attributes.
  const sufList = app.querySelector(".item-suffixes");
  if (sufList) sufList.addEventListener("click", async (e) => {
    const b = e.target.closest(".suf-chat");
    if (!b) return;
    const named = { ...it, name: `${it.name} ${b.dataset.suf}`.trim() };
    const macro = chatMacro("item", it.entry, named, Number(b.dataset.ench));
    const was = b.textContent;
    try { await navigator.clipboard.writeText(macro); b.textContent = "✓"; }
    catch { b.textContent = "✗"; }
    setTimeout(() => { b.textContent = was; }, 1400);
  });
}

// ---- dressing room (?dressing) ----
// The character mannequin. Phase one of the transmog builder: race/gender/appearance
// only, no gear yet -- the rig everything else hangs off. State rides in the URL so a
// look is shareable, the same way ?talents= and ?compare= work.
async function showDressingRoom(params, navigate) {
  if (!OWN_ITEM_MODELS) {
    app.innerHTML = errorBox(new Error("The 3D dressing room is only available on the Turtle dataset — "
      + "a display id means a different model on each game."));
    return;
  }
  if (!webglOk()) {
    app.innerHTML = `<div class="panel"><h2>Dressing room</h2>`
      + `<p class="muted">This needs WebGL, which this browser has turned off or does not support.</p></div>`;
    return;
  }
  const num = (k, d) => (params.get(k) !== null && params.get(k) !== "" ? Number(params.get(k)) : d);
  const state = {
    race: num("race", 1), sex: params.get("sex") === "f" ? "f" : "m",
    skin: num("skin", 0), face: num("face", 0),
    hair: num("hair", 0), hairColor: num("hcolor", 0), facialHair: num("facial", 0),
  };
  app.innerHTML = `<div class="dressing">
      <h1>Dressing room</h1>
      <p class="muted">Pick a race and appearance. Gear comes next.</p>
      <div class="dress-bar" id="dress-bar"></div>
      <div id="mv-host" class="mv-host"><p class="muted">Loading character…</p></div>
    </div>`;
  const host = app.querySelector("#mv-host");
  const bar = app.querySelector("#dress-bar");

  let mod;
  try {
    mod = await import("./modelviewer.js");
  } catch (e) {
    host.innerHTML = errorBox(e); return;
  }
  let data;
  try {
    data = await mod.charAppearance();
  } catch (e) {
    host.innerHTML = `<p class="muted">Character data unavailable — ${esc(e.message)}.</p>`;
    return;
  }

  // How many variations/colours this race+gender actually offers. Asked of the data
  // rather than assumed: Turtle's own races do not carry the same counts as Blizzard's.
  const opts = (kind, idx) => {
    const rows = data.sections[`${state.race}-${state.sex}-${kind}`] || [];
    return [...new Set(rows.map((r) => r[idx]))].sort((a, b) => a - b);
  };
  // Hair and facial-hair VARIATIONS come from the geoset tables, not from the texture
  // sections: a variation can exist as geometry while painting no texture at all (every
  // race's bald, and all five of the goblin's facial options), and offering only the
  // textured ones hides real choices -- while offering ones the race lacks used to leave
  // it headless.
  const hasFacialArt = () =>
    (data.sections[`${state.race}-${state.sex}-facial`] || []).some((r) => r[2].length);
  const geosetOpts = (table) =>
    [...new Set((data[table][`${state.race}-${state.sex}`] || []).map((r) => r[0]))].sort((a, b) => a - b);
  const pick = (label, key, values, cur) => values.length > 1
    ? `<label class="dress-pick">${esc(label)}<select data-key="${key}">`
      + values.map((v) => `<option value="${v}"${v === cur ? " selected" : ""}>${v + 1}</option>`).join("")
      + `</select></label>`
    : "";
  const render = () => {
    bar.innerHTML =
      `<label class="dress-pick">Race<select data-key="race">`
      + data.races.map((r) => `<option value="${r.id}"${r.id === state.race ? " selected" : ""}>${esc(r.name)}</option>`).join("")
      + `</select></label>`
      + `<label class="dress-pick">Gender<select data-key="sex">`
      + `<option value="m"${state.sex === "m" ? " selected" : ""}>Male</option>`
      + `<option value="f"${state.sex === "f" ? " selected" : ""}>Female</option></select></label>`
      + pick("Skin", "skin", opts("skin", 1), state.skin)
      + pick("Face", "face", opts("face", 0), state.face)
      + pick("Hair", "hair", geosetOpts("hair"), state.hair)
      + pick("Hair colour", "hcolor", opts("hair", 1), state.hairColor)
      // The groups 1-3 mechanism is "facial hair" only where the race HAS facial-hair
      // art. Turtle reuses it on goblin females for the eyes -- variation 0 is a
      // heavy-lidded look, 2 is open eyes with pupils -- and calling that "Facial hair"
      // sends people hunting for a bug in the eye textures. Detect it from the data:
      // no facial texture rows means the geosets are something else on this race.
      + pick(hasFacialArt() ? "Facial hair" : "Face detail", "facial",
        geosetOpts("facial"), state.facialHair);
  };
  const KEY = { hcolor: "hairColor", facial: "facialHair" };
  const mount = async () => {
    destroyViewer();
    host.innerHTML = "";
    try {
      activeViewer = await mod.mountCharacterViewer(host, state);
    } catch (e) {
      host.innerHTML = `<p class="muted">Could not load this character — ${esc(e.message)}.</p>`;
    }
  };
  bar.addEventListener("change", async (e) => {
    const sel = e.target.closest("select");
    if (!sel) return;
    const k = sel.dataset.key;
    state[KEY[k] || k] = k === "sex" ? sel.value : Number(sel.value);
    // A new race has its own option counts, so the picker list is rebuilt, and the URL
    // keeps the look shareable.
    render();
    const q = new URLSearchParams({ dressing: "", race: state.race, sex: state.sex,
      skin: state.skin, face: state.face, hair: state.hair, hcolor: state.hairColor,
      facial: state.facialHair });
    history.replaceState({}, "", `?${q}`);
    await mount();
  });
  render();
  await mount();
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

  const [produces, reagents, usedBy, source, trainers, books, rewardQuests, petAbil] = await Promise.all([
    query(Q.Q_SPELL_PRODUCES, [id]), query(Q.Q_SPELL_REAGENTS, [id]),
    query(Q.Q_SPELL_USED_BY, [id]), queryOne(Q.Q_SPELL_SOURCE, [id]),
    query(Q.Q_SPELL_TRAINERS, [id]), query(Q.Q_SPELL_BOOKS, [id]),
    query(Q.Q_SPELL_REWARD_QUESTS, [id]),
    queryOne(Q.Q_PET_ABILITY_BY_SPELL, [id]),
  ]);
  // If this spell is a hunter pet ability, list the beasts you can tame to learn this rank.
  const petLearn = petAbil ? await query(Q.Q_PET_LEARN_NPCS, [petAbil.ability_key, petAbil.level, petAbil.next_level || 0]) : [];

  const prof = PROFESSION_LABEL[sp.skill] || "";

  // "Learned from": the recipe/pattern/plans item, or Trainer / Auto -- mirrors
  // the item-page "Source" cell so a recipe-taught craft links to its item.
  let learned = "";
  if (source) {
    if (source.recipe_item) learned = itemLink(source.recipe_item, source.recipe_name, source.recipe_quality, source.recipe_icon);
    else if (source.trainer) learned = `<span class="tagx src-crafted">Trainer</span>`;
    else if (source.auto) learned = `<span class="tagx" title="Learned automatically with the profession">Auto</span>`;
  }

  // Location per trainer NPC -- the SAME resolver every other Location column uses.
  // This was the last call site still running the old "largest WorldMapArea box
  // containing the spawn" heuristic, which those boxes overlap far too badly to
  // support: Sayoc (11868) stands in Orgrimmar and the biggest box over that point
  // is Azshara's, so the spell page and his own NPC page named different zones.
  // spawn_points.zone is ADT-exact (see build-db), and the shared resolver also
  // appends the linked sub-area.
  const trainerLoc = await resolveNpcLocations(trainers.map((n) => n.entry));

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
    { label: "Location", cls: "muted", cell: (r) => (trainerLoc.get(r.entry) || {}).html || "", value: (r) => (trainerLoc.get(r.entry) || {}).text || "" },
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

  // Pet-ability "tame to learn" panel: the level band that grants exactly this rank.
  let petLearnPanel = "";
  if (petAbil) {
    const band = petAbil.next_level ? `level ${petAbil.level}–${petAbil.next_level - 1}`
      : `level ${petAbil.level}${petAbil.level > 1 ? "+" : " or higher"}`;
    meta.push(`<a class="nav" href="?petability=${esc(petAbil.ability_key)}" title="All ranks of this pet ability">🐾 Pet ability</a>`);
    petLearnPanel = `<section class="panel pet-learn">
      <h3>Tame a beast to learn this${petAbil.rank ? ` (Rank ${petAbil.rank})` : ""}
        <a class="nav pet-allranks" href="?petability=${esc(petAbil.ability_key)}">all ranks ›</a></h3>
      <p class="muted pet-note">A hunter learns a pet ability by taming a beast that already knows it.
        A fresh pet comes with the highest rank its level allows, so tame one of the beasts below at
        <b>${band}</b> to get <b>${esc(petAbil.name)}${petAbil.rank ? ` Rank ${petAbil.rank}` : ""}</b>
        (grouped by family — the family must be able to learn it).</p>
      ${petLearn.length ? `<div id="pet-learn-table"></div>`
        : `<p class="muted">No tameable beast in the data matches this rank's level band.</p>`}
    </section>`;
  }

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
      ${petLearnPanel}
      ${hasTabs ? tabs(tabDefs) : ""}
    </div>`;
  mountTables();
  wireTabs();

  if (petAbil && petLearn.length) {
    createTable(document.getElementById("pet-learn-table"), {
      columns: [
        { key: "name", label: "Creature", cell: (r) => npcLink(r.entry, r.name) + (r.subname ? ` <span class="muted">&lt;${esc(r.subname)}&gt;</span>` : "") + (r.custom ? ' <span class="tagx tw-tag" title="Turtle-WoW custom">TW</span>' : ""), value: (r) => r.name },
        { key: "family", label: "Family", cell: (r) => petFamilyLink(r.pet_family, r.family), value: (r) => r.family, group: (r) => esc(r.family) },
        { key: "level", label: "Level", num: true, cls: "num", cell: (r) => lvlRange(r), value: (r) => r.level_min || 0 },
        { key: "zone", label: "Zone", cls: "muted", cell: (r) => (r.zone ? zoneLink(r.areaid, r.zone) : "—"), value: (r) => r.zone || "", group: (r) => (r.zone ? esc(r.zone) : "Unknown") },
      ],
      rows: petLearn,
      pageSize: 25,
      groupable: true,
      group: "family",
      sort: "level",
    });
  }
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
  const rows = await query(Q.qNpcZoneSpawns(uniq.length, kind, (await caps()).spawnSub), uniq);
  const byEntry = new Map();
  for (const r of rows) {
    let m = byEntry.get(r.entry); if (!m) { m = new Map(); byEntry.set(r.entry, m); }
    const e = m.get(r.areaid) || { ...r, n: 0, subs: new Map() }; e.n++;
    if (r.subid) e.subs.set(r.subid, { name: r.subname, n: (e.subs.get(r.subid)?.n || 0) + 1 });
    m.set(r.areaid, e);
  }
  for (const [entry, m] of byEntry) {
    let best = null; for (const e of m.values()) if (!best || e.n > best.n) best = e;
    // `text` stays the ZONE name: it is this column's sort/group key on six tables,
    // and grouping by sub-area would shatter them into hundreds of one-row groups.
    out.set(entry, { html: zoneCellHtml(best.areaid, best.name, best.type) + subSuffix(best), text: best.name });
  }
  return out;
}

// The sub-area a spawn set actually lives in, when there is a dominant one. A mob
// roaming all of Elwynn shouldn't claim to live in Goldshire, so require the modal
// sub-area to hold at least a quarter of the entry's spawns in that zone.
const SUB_SHARE_MIN = 0.25;
function dominantSub(entry) {
  if (!entry.subs || !entry.subs.size) return null;
  let best = null, id = null;
  for (const [k, v] of entry.subs) if (!best || v.n > best.n) { best = v; id = k; }
  return best && best.name && best.n / entry.n >= SUB_SHARE_MIN ? { id, ...best } : null;
}
// Linked, like the zone half of the cell: a sub-area has its own page (?subzone=),
// and a name with no way to reach it is the one thing the subzone work still lacked
// on every Location column (quest givers, drop sources, vendors, faction members).
function subSuffix(entry) {
  const s = dominantSub(entry);
  return s ? ` <span class="dim">·</span> ${subzoneLink(s.id, s.name)}` : "";
}

// ---- NPC combat stats panel (creature_template, see build-db) ----
// Range-valued because a creature template spans level_min..level_max: the server
// interpolates health/mana between the two bounds when it spawns one at a level.
// Damage/armor/resists are flat per template. Everything is the raw server value
// before the rate.* config multipliers, which the world data doesn't expose.
const npcRange = (lo, hi, fmt = (v) => v.toLocaleString()) =>
  lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;

// Stat categories, in display order (the group column sorts on the ordinal).
const NPC_STAT_CATS = ["Defense", "Offense", "Resources & loot"];

// A stat's value next to the median of the creature's peers -- every non-hidden
// creature of the same level and rank (Q_NPC_PEERS). "3,379 armor" says nothing on
// its own; "×0.80 of a typical level 63 boss" is the read a hardcore player wants.
// Under PEER_MIN peers the cohort isn't representative and the column is dropped
// (the cells render empty, so the table's hideEmpty takes it out). The ratio bar +
// the outlier headline are shared with the item page -- see context.js.
const NPC_PEER_MIN = PEER_MIN;

const npcPills = (list) => list.map((v) => `<span class="stat-pill">${esc(v)}</span>`).join("");
// Long pill lists fold past `keep` into a native <details> -- no JS, keyboard-operable.
function npcPillsCapped(list, keep) {
  if (list.length <= keep + 1) return npcPills(list);
  return npcPills(list.slice(0, keep)) +
    `<details class="pill-more"><summary>+${list.length - keep} more</summary>${npcPills(list.slice(keep))}</details>`;
}

// Rows for the Stats tab. `ratio` is set only on the stats we have a peer median
// for; everything else renders an empty comparison cell.
function npcStatRows(npc, peers) {
  const rows = [];
  const med = peers && peers.n >= NPC_PEER_MIN ? peers : null;
  const ratio = (v, base) => (med && v > 0 && base > 0 ? v / base : null);
  const add = (cat, label, value, r = null, sort = 0) => { if (value) rows.push({ cat, catOrd: NPC_STAT_CATS.indexOf(cat), label, value, ratio: r, sort }); };
  const num = (v) => Math.round(v).toLocaleString();

  if (npc.health_max) add("Defense", "Health", npcRange(npc.health_min, npc.health_max), ratio(npc.health_max, med?.health), npc.health_max);
  if (npc.armor) add("Defense", "Armor", npc.armor.toLocaleString(), ratio(npc.armor, med?.armor), npc.armor);
  const resists = RESISTANCES.filter(([col]) => npc[col] > 0);
  if (resists.length) {
    add("Defense", "Resistances",
      resists.map(([col, label]) => `<span class="stat-pill">${label}<b>${npc[col]}</b></span>`).join(""),
      null, resists.reduce((a, [col]) => a + npc[col], 0));
  }
  // Immunity masks: schools are 1 << school, mechanics 1 << (mechanic - 1) (mangos).
  // The mechanic mask can exceed 2^31 (Ragnaros is 2,793,635,615) -- JS coerces `&`
  // operands to int32, which still tests bits 0..30 correctly, and mechanic 32 doesn't
  // exist in 1.12, so no masking workaround is needed.
  const schools = Object.entries(SPELL_SCHOOL).filter(([bit]) => npc.school_immune_mask & (1 << Number(bit))).map(([, l]) => l);
  const mechanics = Object.entries(SPELL_MECHANIC).filter(([m]) => npc.mechanic_immune_mask & (1 << (Number(m) - 1))).map(([, l]) => l);
  // School immunity is rare and decisive ("Fire does nothing to Ragnaros"), so it gets
  // its own row rather than being buried among the effect immunities.
  if (schools.length) add("Defense", "Immune to damage", npcPills(schools), null, schools.length);
  // Raid bosses carry a stock block of ~18 effect immunities; showing all of them at
  // once swamps the table, so past a handful the rest fold into a disclosure.
  if (mechanics.length) add("Defense", "Immune to effects", npcPillsCapped(mechanics, 6), null, mechanics.length);

  const speed = npc.base_attack_time ? npc.base_attack_time / 1000 : 0;
  if (npc.dmg_max) {
    const school = DMG_SCHOOL[npc.dmg_school];
    add("Offense", "Melee damage", npcRange(npc.dmg_min, npc.dmg_max, num) + (school ? ` <span class="dim">${esc(school)}</span>` : ""), null, npc.dmg_max);
    // Sustained white-hit DPS -- the number that decides whether a mob out-damages
    // your mitigation, and the one worth comparing against its peers.
    if (speed) {
      const dps = (npc.dmg_min + npc.dmg_max) / 2 / speed;
      add("Offense", "Melee DPS", `~${num(dps)}`, ratio(dps, med?.dps), dps);
    }
  }
  if (speed) add("Offense", "Attack speed", `${speed.toFixed(2)} sec`, null, speed);
  if (npc.attack_power) add("Offense", "Attack power", npc.attack_power.toLocaleString(), ratio(npc.attack_power, med?.attack_power), npc.attack_power);
  if (npc.ranged_dmg_max) {
    add("Offense", "Ranged damage", npcRange(npc.ranged_dmg_min, npc.ranged_dmg_max, num), null, npc.ranged_dmg_max);
    if (npc.ranged_attack_time) add("Offense", "Ranged speed", `${(npc.ranged_attack_time / 1000).toFixed(2)} sec`, null, npc.ranged_attack_time / 1000);
  }

  if (npc.mana_max) add("Resources & loot", "Mana", npcRange(npc.mana_min, npc.mana_max), null, npc.mana_max);
  if (npc.gold_max) {
    add("Resources & loot", "Money",
      `${moneyHtml(npc.gold_min)}${npc.gold_min !== npc.gold_max ? ` – ${moneyHtml(npc.gold_max)}` : ""}`, null, npc.gold_max);
  }
  return rows;
}

// Names the cohort the medians came from: "Lvl 63 World Boss" for the column header,
// "level 63 world bosses" for the prose note under the table.
const npcPeerLabel = (npc) => `Lvl ${npc.level_max || npc.level_min} ${CREATURE_RANK[npc.rank] || "mob"}`;
const npcPeerPlural = (npc) => {
  const kind = (CREATURE_RANK[npc.rank] || "mob").toLowerCase();
  return `level ${npc.level_max || npc.level_min} ${kind}${kind.endsWith("s") ? "es" : "s"}`;
};

function npcStatsPane(npc, peers) {
  const rows = npcStatRows(npc, peers);
  if (!rows.length) return { html: "", count: 0 };
  const columns = [
    // Grouping removes this column from the body and renders it as the group header,
    // so it only becomes a visible column if the reader picks "Group by: None".
    { key: "cat", label: "Category", cell: (r) => esc(r.cat), value: (r) => r.catOrd, group: (r) => esc(r.cat) },
    { key: "stat", label: "Stat", cell: (r) => esc(r.label), value: (r) => r.label },
    { key: "value", label: "Value", cls: "npc-stat-v", cell: (r) => r.value, value: (r) => r.sort, num: true },
    {
      key: "peer", label: `vs. typical ${npcPeerLabel(npc)}`, num: true, hideEmpty: true,
      cell: (r) => ratioCell(r.ratio), value: (r) => r.ratio || 0,
    },
  ];
  const t = regTable(columns, rows, { groupable: true, group: "cat" });
  const med = peers && peers.n >= NPC_PEER_MIN ? peers : null;
  // Headline the one stat that makes this creature unusual (Gor'tesh hits for ~3x a
  // typical level 54 mob) -- the ratio column already carries it, but only a reader
  // who scans every row finds it.
  const dps = npc.base_attack_time ? (npc.dmg_min + npc.dmg_max) / 2 / (npc.base_attack_time / 1000) : 0;
  const head = med ? outlierLine([
    { label: "melee DPS", ratio: dps / med.dps, rank: peers.rank_dps, n: med.n },
    { label: "health", ratio: npc.health_max / med.health, rank: peers.rank_health, n: med.n },
    { label: "armor", ratio: npc.armor / med.armor, rank: peers.rank_armor, n: med.n },
    { label: "attack power", ratio: npc.attack_power / med.attack_power, rank: peers.rank_attack_power, n: med.n },
  ], esc(npcPeerPlural(npc))) : "";
  const note = med
    ? `<p class="npc-stat-note muted">Baseline: median of ${med.n.toLocaleString()} ${esc(npcPeerPlural(npc))} —
       ${Math.round(med.health).toLocaleString()} HP · ${Math.round(med.armor).toLocaleString()} armor ·
       ~${Math.round(med.dps).toLocaleString()} DPS · ${Math.round(med.attack_power).toLocaleString()} AP.</p>`
    : `<p class="npc-stat-note muted">Too few ${esc(npcPeerPlural(npc))} in the data for a meaningful comparison.</p>`;
  return { count: rows.length, noCount: true, html: head + t.html + note };
}

// The Skinning tab's headline: the Skinning skill a player needs for THIS
// creature. It's a pure function of the creature's level (see `skinningReq`), and
// a creature that rolls a level range spans a range of requirements — show both
// ends, since a skinner has to plan for the worst case.
function skinReqNote(npc) {
  const lo = npc.level_min || npc.level_max || 0;
  const hi = npc.level_max || lo;
  if (!hi) return "";
  const reqLo = skinningReq(lo), reqHi = skinningReq(hi);
  const req = reqLo === reqHi ? `${reqHi}` : `${reqLo}–${reqHi}`;
  const lvl = lo === hi ? `level ${hi}` : `level ${lo}–${hi}`;
  // 99 skinnable creatures (the 61+ raid/dungeon bosses) sit above the profession
  // cap, so the plain number would read as "impossible" without this.
  // …and link that to the items that provide it (the derived `skinning` stat, from
  // the item's MOD_SKILL equip aura -- Zulian Slicer, Finkle's Skinner, …).
  const over = reqHi > MAX_SKILL
    ? ` <span class="dim">— above the ${MAX_SKILL} skill cap, so it needs `
      + `<a href="?browse=items&stats=${encodeURIComponent("skinning,>=,1")}">+Skinning gear</a>.</span>`
    : "";
  return `<p class="skin-req" title="Server formula: level × 5 (or (level − 10) × 10 while your Skinning is under 100)">`
    + `Requires <b>Skinning ${req}</b> <span class="dim">(${lvl})</span>${over}</p>`;
}

// How an ability reaches the creature (creature_ability.src), for the Source column.
const NPC_ABILITY_SRC = {
  l: ["Spell list", "Cast from the creature's shared spell list (creature_spells)"],
  t: ["Ability", "One of the four spell slots on the creature template"],
  e: ["Scripted", "Cast by an EventAI script (on aggro, at a health threshold, on a timer, …)"],
  c: ["Boss script", "Hardcoded in the server's C++ fight script (ScriptDev2)"],
  a: ["Aura", "A passive aura the creature spawns with"],
};

async function showNpc(id) {
  app.innerHTML = `<div class="loading">Loading NPC ${id}…</div>`;
  let npc;
  try { npc = await queryOne(Q.Q_NPC, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!npc) { app.innerHTML = `<div class="home"><p>No NPC with ID ${id}.</p></div>`; return; }
  document.title = `${npc.name} - Tortoise-WoW DB`;

  const [loot, skin, pick, sells, starts, ends, objectiveOf, maps, trains, npcSpawns, npcFaction, mountSrc, abilities, peers, petAbil, petRanks] = await Promise.all([
    query(Q.Q_NPC_LOOT, [id]), query(Q.Q_NPC_SKIN, [id]), query(Q.Q_NPC_PICK, [id]),
    query(Q.Q_NPC_SELLS, [id]), query(Q.Q_NPC_STARTS, [id]), query(Q.Q_NPC_ENDS, [id]),
    query(Q.Q_NPC_OBJECTIVE_OF, [id]), query(Q.Q_NPC_MAPS, [id]),
    query(Q.Q_NPC_TRAINS, [id]), query(Q.qNpcSpawns((await caps()).spawnSub), [id]), queryOne(Q.Q_NPC_FACTION, [id]),
    query(Q.Q_MOUNT_SOURCE, [id]), query(Q.Q_NPC_ABILITIES, [id]),
    // ?3..?6 are the creature's own health/armor/DPS/AP -- the query returns its rank
    // inside the cohort alongside the medians (see the Stats tab's outlier headline).
    queryOne(Q.Q_NPC_PEERS, [npc.level_max || npc.level_min || 0, npc.rank || 0,
      npc.health_max || 0, npc.armor || 0,
      npc.base_attack_time ? (npc.dmg_min + npc.dmg_max) / 2 / (npc.base_attack_time / 1000) : 0,
      npc.attack_power || 0]),
    npc.tameable && npc.pet_family ? query(Q.Q_PET_FAMILY_ABIL, [npc.pet_family]) : Promise.resolve([]),
    npc.tameable && npc.pet_family ? query(Q.Q_PET_ABILITY_RANKS) : Promise.resolve([]),
  ]);
  // Sounds are an optional schema (see db.js caps()): a dataset whose DB predates the
  // audio tables must degrade to no tab, not to a failed query inside the Promise.all
  // above (one rejection there would wipe out every other pane).
  const capsNow = await caps();
  const [npcSounds, npcVoice] = capsNow.sounds
    ? await Promise.all([query(Q.Q_NPC_SOUNDS, [id]), query(Q.Q_NPC_VOICE, [id])])
    : [[], []];
  // Per-take transcripts. Q_NPC_SOUNDS' own text column quotes one row per sound, which
  // for a multi-take clip is one line out of up to ten -- and not necessarily the one the
  // player is cued to. Optional schema, so a DB without the column just yields no map.
  const npcTakes = takesOf(capsNow.soundTake ? await query(Q.Q_NPC_SOUND_TAKES, [id]).catch(() => []) : []);
  // What this NPC says when you talk to it. Optional schema, same as sounds.
  const npcGossip = capsNow.gossip ? await query(Q.Q_NPC_GOSSIP, [id]).catch(() => []) : [];
  // ability_key -> ascending [{rank, spell, level}], to compute the rank a tamed pet of
  // THIS beast's level starts with (highest rank whose level <= the beast's level).
  const petRankMap = new Map();
  for (const r of petRanks) { if (!petRankMap.has(r.ability_key)) petRankMap.set(r.ability_key, []); petRankMap.get(r.ability_key).push(r); }
  for (const l of petRankMap.values()) l.sort((a, b) => a.rank - b.rank);
  const petGrantRank = (a) => { const rks = petRankMap.get(a.key) || []; let g = null; for (const r of rks) if (r.level <= npc.level_max) g = r; return g; };
  // Each spawn carries its exact precomputed home zone (build-db, ADT-derived).
  // Count per zone (and per map) -> the most-common zone is the one the map renders;
  // the Location label names the top zone for each continent map.
  const zoneCount = new Map();   // areaid -> count
  const byMapZone = new Map();   // map -> Map(areaid -> count)
  const subByZone = new Map();   // areaid -> { n, subs: Map(subid -> {name, n}) }
  for (const s of npcSpawns) {
    if (!s.zone) continue;
    zoneCount.set(s.zone, (zoneCount.get(s.zone) || 0) + 1);
    let mm = byMapZone.get(s.map); if (!mm) { mm = new Map(); byMapZone.set(s.map, mm); }
    mm.set(s.zone, (mm.get(s.zone) || 0) + 1);
    let sz = subByZone.get(s.zone); if (!sz) { sz = { n: 0, subs: new Map() }; subByZone.set(s.zone, sz); }
    sz.n++;
    if (s.sub) sz.subs.set(s.sub, { name: s.subname, n: (sz.subs.get(s.sub)?.n || 0) + 1 });
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
    // continent: append the resolved zone, then its sub-area when one dominates ->
    // "Eastern Kingdoms › Elwynn Forest › Goldshire"
    const z = bestZoneForMap(m.id);
    if (!z) return esc(m.name);
    const sub = dominantSub(subByZone.get(z.areaid) || {});
    return `${esc(m.name)} <span class="dim">›</span> ${zoneLink(z.areaid, z.name)}`
      + (sub ? ` <span class="dim">›</span> ${subzoneLink(sub.id, sub.name)}` : "");
  }).join(", ");

  const lvl = lvlRange(npc) || "??";
  const bits = [`Level ${lvl}`];
  if (CREATURE_RANK[npc.rank]) bits.push(CREATURE_RANK[npc.rank]);
  if (CREATURE_TYPE[npc.type]) bits.push(`<a class="nav" href="?browse=npcs&type=${npc.type}">${CREATURE_TYPE[npc.type]}</a>`);
  if (npc.tameable) bits.push(`<span class="npc-tame" title="Tameable by hunters">🐾 Tameable${npc.pet_family ? ` · ${petFamilyLink(npc.pet_family, npc.pet_family_name)}${npc.pet_family_custom ? ' <span class="tagx tw-tag" title="Turtle-WoW custom pet family">TW</span>' : ""}` : ""}</span>`);
  if (npcFaction) bits.push(npcFaction.has_page ? factionLink(npcFaction.id, npcFaction.name) : esc(npcFaction.name));
  const roles = npcRoles(npc.npc_flags);
  const rankClass = npc.rank === 3 ? "npc-boss" : (npc.rank === 2 || npc.rank === 4) ? "npc-rare" : npc.rank === 1 ? "npc-elite" : "";

  const lootCols = [
    { label: "Item", cell: (d) => itemLink(d.entry, d.name, d.quality, d.icon) + dropQty(d.mincount, d.maxcount), value: (d) => d.name },
    { label: "Chance", num: true, cell: (d) => pct(d.chance), value: (d) => d.chance || 0 },
  ];
  const sellCols = [
    { label: "Item", cell: (s) => itemLink(s.entry, s.name, s.quality, s.icon), value: (s) => s.name },
    stockCol,
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
  // Pet abilities: a tameable beast is a hunter-pet source; list the family's
  // trainable abilities (ability rank scales with the pet's level once tamed).
  const petAbilCols = [
    { label: "Ability", cell: (a) => spellLink(a.spell, a.name, a.icon || "inv_misc_questionmark"), value: (a) => a.name },
    // What rank a pet tamed from THIS beast starts with (highest rank its level unlocks).
    // Abilities gated above its level show the pet level they unlock at.
    {
      label: "Learn on tame", cell: (a) => {
        const g = petGrantRank(a);
        if (g) return `<a class="ilink spell" href="?spell=${g.spell}">Rank ${g.rank}</a>`;
        const first = (petRankMap.get(a.key) || [])[0];
        return first ? `<span class="muted" title="Your pet learns this once it reaches level ${first.level}">— <span class="dim">(pet Lvl ${first.level}+)</span></span>` : `<span class="muted">—</span>`;
      },
      value: (a) => { const g = petGrantRank(a); return g ? g.rank : 0; },
    },
    { label: "Max Rank", num: true, cls: "muted", cell: (a) => String(a.max_rank || ""), value: (a) => a.max_rank || 0 },
  ];
  // Spells the creature casts at you (+ its passive auras). Cooldown/chance only
  // exist for spell-list entries; scripted (EventAI) casts carry their timing in the
  // script's own trigger conditions, which we don't ingest.
  const abilityCols = [
    { label: "Spell", cell: (a) => spellLink(a.spell, a.name, a.icon || "inv_misc_questionmark") + (a.rank ? ` <span class="dim">(${esc(a.rank)})</span>` : ""), value: (a) => a.name },
    {
      label: "Source", cls: "muted", cell: (a) => {
        const [label, tip] = NPC_ABILITY_SRC[a.src] || ["", ""];
        return label ? `<span title="${esc(tip)}">${label}</span>` : "";
      },
      value: (a) => (NPC_ABILITY_SRC[a.src] || [""])[0],
      group: (a) => (NPC_ABILITY_SRC[a.src] || [""])[0],
    },
    { label: "School", cls: "muted", hideUniform: true, cell: (a) => esc(SPELL_SCHOOL[a.school] || ""), value: (a) => SPELL_SCHOOL[a.school] || "" },
    { label: "Cast", num: true, cls: "muted", hideEmpty: true, cell: (a) => (a.cast_ms ? `${(a.cast_ms / 1000).toFixed(1)}s` : ""), value: (a) => a.cast_ms || 0 },
    { label: "Range", num: true, cls: "muted", hideEmpty: true, cell: (a) => (a.range_max ? `${Math.round(a.range_max)} yd` : ""), value: (a) => a.range_max || 0 },
    { label: "Chance", num: true, cls: "muted", hideEmpty: true, cell: (a) => (a.prob != null && a.prob < 100 ? `${a.prob}%` : ""), value: (a) => (a.prob != null && a.prob < 100 ? a.prob : 0) },
    { label: "Cooldown", num: true, cls: "muted", hideEmpty: true, cell: (a) => (a.cd_max ? (a.cd_min === a.cd_max ? `${a.cd_min}s` : `${a.cd_min}–${a.cd_max}s`) : ""), value: (a) => a.cd_min || 0 },
  ];
  // Skinning leads with the skill requirement (what a skinner opens this tab for),
  // then the hide/leather table.
  const skinPane = regTable(lootCols, skin);
  if (skinPane.count) skinPane.html = skinReqNote(npc) + skinPane.html;
  // Sounds. The client's slot is the "Activity"; the category above it is derived from
  // that slot, because the SoundEntries `type` column is a playback-engine flag (2D vs
  // 3D, looping) and says nothing about what the sound IS.
  const soundRows = [
    // ord >= 200 marks a row that came from the creature's Sound\Creature folder rather
    // than a CreatureSoundData slot: its "slot" is parsed from the filename (Taunt, Slay,
    // Aggro...) and what it holds is spoken dialogue, not the combat grunt set.
    // ord 200/201 marks a row that came from the creature's Sound\Creature folder rather
    // than a CreatureSoundData slot. A folder carries both kinds -- Illidan's 19 spoken
    // lines sit beside his wing flaps -- so build-db splits them there (200 = speech,
    // 201 = noise) rather than the page re-deriving it from a label.
    ...npcSounds.map((r) => ({
      ...r,
      kind: r.ord === 200 ? "Voice Lines" : r.ord === 201 ? "NPC Effects" : (SOUND_KIND[r.slot] || "NPC Combat"),
      activity: r.slot,
    })),
    // A scripted line has no slot at all -- it is bound to the NPC by its C++ script.
    ...npcVoice.filter((v) => !npcSounds.some((s) => s.id === v.id))
      .map((r) => ({ ...r, kind: "Voice Lines", activity: "" })),
  ];
  const soundCols = [
    { label: "Sound", cls: "snd-col", cell: (r) => soundPlayer(r, { label: false }), value: (r) => r.name || "" },
    { label: "Name", cell: (r) => esc(r.name || ""), value: (r) => r.name || "" },
    {
      label: "Transcript", cls: "snd-text", hideEmpty: true,
      cell: (r) => transcriptCell(r, npcTakes.get(r.id)),
      value: (r) => transcriptText(r, npcTakes.get(r.id)),
    },
    { label: "Type", cls: "muted", group: (r) => r.kind, cell: (r) => esc(r.kind), value: (r) => r.kind },
    { label: "Activity", cls: "muted", hideEmpty: true, cell: (r) => esc(r.activity), value: (r) => r.activity },
    { label: "Length", num: true, cls: "muted", hideEmpty: true, cell: (r) => fmtDur(r.ms), value: (r) => r.ms || 0 },
  ];

  // Gossip is prose, and it carries the same $B/$N tokens quest text does, so it runs
  // through the same renderer rather than being escaped flat.
  const gossipCols = [
    { label: "Says", cls: "gossip-text", cell: (r) => questText(r.text), value: (r) => r.text },
  ];

  const tabDefs = [
    { id: "stats", label: "Stats", ...npcStatsPane(npc, peers) },
    { id: "abilities", label: "Abilities", ...regTable(abilityCols, abilities, { groupable: true }) },
    { id: "sounds", label: "Sounds", ...regTable(soundCols, soundRows, { groupable: true, group: "Type", pageSize: 100 }) },
    { id: "gossip", label: "Gossip", ...regTable(gossipCols, npcGossip, { pageSize: 50 }) },
    { id: "petabilities", label: "Pet Abilities", ...regTable(petAbilCols, petAbil) },
    { id: "teaches", label: "Teaches", ...regTable(teachesCols, trains) },
    { id: "drops", label: "Drops", ...regTable(lootCols, drops) },
    { id: "worlddrops", label: "World Drops", ...regTable(lootCols, worldDrops) },
    { id: "skinning", label: "Skinning", ...skinPane },
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
      : mountSrc.length
        ? `<div class="zone-empty muted">This creature is a summoned mount — it has no world spawn.</div>`
        : `<div class="zone-empty muted">No spawn location is recorded for this NPC (it may be placed by a script or event).</div>`;
  // Quest-inferred zone: show the parchment but caption that there are no exact coords.
  const questZoneNote = questZone
    ? `<div class="zone-empty muted">No exact spawn coordinates in the current data — this NPC is placed by a script or event; the zone above is inferred from its quests.</div>`
    : "";

  // Static model thumbnail (our render or Wowhead's), shown in the header so the
  // model is visible without hovering and without pushing the map. Floats right;
  // click opens the image in a new tab. Removes itself if no thumb exists.
  const modelUrl = npc.display_id ? modelThumbUrl(npc.display_id) : null;
  const modelThumb = modelUrl
    ? `<a class="npc-model" href="${modelUrl}" target="_blank" rel="noopener" title="Open model image in a new tab">
         <img src="${modelUrl}" alt="${esc(npc.name)} model" loading="lazy"
              onerror="this.closest('.npc-model').remove()"></a>`
    : "";

  app.innerHTML =
    `<div class="npc-page">
      <div class="npc-head">
        ${modelThumb}
        <h1 class="${rankClass}">${esc(npc.name)}</h1>
        ${npc.subname ? `<span class="npc-sub muted">&lt;${esc(npc.subname)}&gt;</span>` : ""}
        <div class="npc-meta muted">${bits.join(" · ")}
          ${roles.map((r) => `<span class="tagx">${esc(r)}</span>`).join("")}
          <span class="dim">· NPC #${npc.entry}</span>${npc.display_id ? `<span class="dim"> · </span><span class="model-link" data-display="${npc.display_id}" tabindex="0" title="Hover to preview the 3D model">Model #${npc.display_id}</span>` : ""}</div>
        ${mapHtml ? `<div class="npc-meta muted">Location: ${mapHtml}</div>`
          : questZone ? `<div class="npc-meta muted">Location: ${zoneLink(questZone.areaid, questZone.name)} <span class="dim">(from quests)</span></div>`
          : ""}
        ${mountSrc.length ? `<div class="npc-meta muted">Mount summoned by ${mountSrc.map((m) => itemLink(m.entry, m.name, m.quality, m.icon)).join(", ")}</div>` : ""}
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
      const imgUrl = `${MAPS_BASE}${drawZone.areaid}.webp`;
      const imgFallback = `${MAPS_BASE_MAIN}${drawZone.areaid}.webp`;
      // Real spawns -> focus pins; quest-inferred zone -> parchment only (no coords).
      const opts = mapZone ? { focus: { label: npc.name, npc: npc.entry, points: mapPts } } : {};
      initZoneMap(el, { ...drawZone, imgUrl, imgFallback }, [], [], navigate, opts);
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

  // A type-9 (GAMEOBJECT_TYPE_TEXT) plaque/monument/statue stores its readable
  // inscription in a page_text chain keyed by data0.
  const readablePages = obj.type === 9 && obj.data0 > 0 ? await query(Q.Q_PAGE_TEXT, [obj.data0]) : [];

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
    { label: "Item", cell: (d) => itemLink(d.entry, d.name, d.quality, d.icon) + dropQty(d.mincount, d.maxcount), value: (d) => d.name },
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
      ${readableText(readablePages, { title: "Inscription" })}
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
        const imgUrl = `${MAPS_BASE}${zone.areaid}.webp`;
        initZoneMap(el, { ...zone, imgUrl, imgFallback: `${MAPS_BASE_MAIN}${zone.areaid}.webp` }, [], [], navigate, { focus: { label: obj.name, icon: focusIcon, points: pts } });
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

// Voice lines: every extracted sound that carries a transcript, plus Turtle's custom
// voice acting (most of which the C++ plays with no line attached). Modelled on
// ?icons -- filter + page live in the URL (?voicelines=<term>) so a view is shareable.
//
// The filter is FTS5 over the transcript, not a substring scan: "find the line that goes
// ..." is the way you actually look for one of these, and sound_text_fts already indexes
// it. A term that matches no transcript falls back to matching the sound's NAME, which is
// how you find a VA clip that has no text ("satyrboss").
async function showVoiceLines() {
  document.title = "Voice Lines - Tortoise-WoW DB";
  app.innerHTML = `<div class="loading">Loading voice lines…</div>`;
  if (!(await caps()).sounds) {
    app.innerHTML = `<div class="home"><h1>Voice Lines</h1>
      <p class="muted">This dataset's database was built before audio was extracted.</p></div>`;
    return;
  }
  let all;
  try { all = await query(Q.Q_VOICE_LINES); } catch (e) { app.innerHTML = errorBox(e); return; }
  const takes = takesOf((await caps()).soundTake ? await query(Q.Q_SOUND_TEXT_ALL).catch(() => []) : []);
  // A dataset can ship audio and still have no voice LINES: the transcripts come from
  // Turtle's server scripts and its custom voice-acting directory, neither of which the
  // cmangos rows have. Saying "0 shown" over an empty table reads as a broken page, so
  // say what's actually true and point at the audio that IS there.
  if (!all.length) {
    app.innerHTML = `<div class="home"><h1>Voice Lines</h1>
      <p class="muted">This dataset has no spoken voice lines. Transcripts come from the
      Turtle server's scripts and its custom voice acting, which the ${esc(DATASET)} data
      doesn't carry — but NPC and zone audio is still there, on each
      <a class="nav" href="?browse=npcs">NPC</a> and <a class="nav" href="?browse=zones">zone</a> page.</p></div>`;
    return;
  }

  const p0 = new URLSearchParams(location.search);
  let term = (p0.get("voicelines") || "").trim();

  app.innerHTML = `<div class="voice-page">
    <h1>Voice Lines</h1>
    <p class="muted">${all.length.toLocaleString()} sounds — search the transcript, or the sound's name.</p>
    <input type="search" class="icon-search" placeholder="Search what they say… (e.g. “you are already dead”, ragnaros)"
      aria-label="Search voice lines" value="${esc(term)}">
    <p class="muted" data-count></p>
    <div data-out></div>
  </div>`;
  const out = app.querySelector("[data-out]");
  const countEl = app.querySelector("[data-count]");
  const search = app.querySelector(".icon-search");

  const cols = [
    { label: "Play", cls: "snd-col", cell: (r) => soundPlayer(r, { label: false, take: r.take }), value: (r) => r.name || "" },
    {
      label: "Transcript", cls: "snd-text",
      cell: (r) => transcriptCell(r, takes.get(r.id), { blank: `<span class="muted">— no transcript —</span>` }),
      value: (r) => transcriptText(r, takes.get(r.id)) || "￿",   // untranscribed lines sort last
    },
    {
      label: "Speaker", hideEmpty: true,
      cell: (r) => (r.creature
        ? npcLink(r.creature, r.creature_name) + (r.speakers > 1 ? ` <span class="muted">+${r.speakers - 1}</span>` : "")
        : ""),
      value: (r) => r.creature_name || "",
    },
    { label: "Sound", cls: "muted", cell: (r) => esc(r.name || ""), value: (r) => r.name || "" },
    { label: "Length", num: true, cls: "muted", cell: (r) => fmtDur(r.ms), value: (r) => r.ms || 0 },
  ];

  const render = async () => {
    let rows = all;
    if (term) {
      const m = ftsQuery(term);
      let hits = [];
      if (m) { try { hits = await query(Q.Q_VOICE_SEARCH, [m]); } catch { hits = []; } }
      // Name fallback, unioned rather than replacing: a term can legitimately hit both
      // a transcript and a sound name, and dropping either half would hide results.
      const lower = term.toLowerCase();
      const byName = all.filter((r) => (r.name || "").toLowerCase().includes(lower));
      const seen = new Set(hits.map((h) => h.id));
      // A hit carries the take that matched, so the player opens on the line the reader
      // searched for. Without it "time is money" offered take 1 of a goblin greeting set
      // where the phrase is take 4 -- the row was right and everything it showed was not.
      rows = [...hits.map((h) => ({ ...h, take: matchedTake(takes.get(h.id), term, h.text), speakers: h.creature ? 1 : 0 })),
        ...byName.filter((r) => !seen.has(r.id))];
    }
    countEl.textContent = `${rows.length.toLocaleString()} shown`;
    out.innerHTML = "";
    const spec = regTable(cols, rows, { pageSize: 100 });
    out.innerHTML = spec.html;
    mountTables();
  };
  await render();

  let t = 0;
  search.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      term = search.value.trim();
      history.replaceState({}, "", "?voicelines" + (term ? "=" + encodeURIComponent(term) : ""));
      render();
    }, 180);
  });
}

// Every extracted sound, searchable by NAME (?sounds=<term>). The voice-line page only
// ever listed the ones with words; music, ambience and creature audio -- about 1,500
// sounds -- had no page at all, so a question like "how long is Moment-Battle06" had no
// answer on the site. Filter matches the sound name AND its file path, since people know
// these by either.
async function showSounds() {
  document.title = "Sounds - Tortoise-WoW DB";
  app.innerHTML = `<div class="loading">Loading sounds…</div>`;
  if (!(await caps()).sounds) {
    app.innerHTML = `<div class="home"><h1>Sounds</h1>
      <p class="muted">This dataset's database was built before audio was extracted.</p></div>`;
    return;
  }
  let all;
  try { all = await query(Q.Q_SOUND_LIST); } catch (e) { app.innerHTML = errorBox(e); return; }
  const takes = takesOf((await caps()).soundTake ? await query(Q.Q_SOUND_TEXT_ALL).catch(() => []) : []);

  const p0 = new URLSearchParams(location.search);
  let term = (p0.get("sounds") || "").trim().toLowerCase();

  app.innerHTML = `<div class="voice-page">
    <h1>Sounds</h1>
    <p class="muted">${all.length.toLocaleString()} extracted sounds — music, ambience, voice and creature audio.</p>
    <input type="search" class="icon-search" placeholder="Search name, file or transcript… (e.g. moment-battle, ragnaros, time is money)"
      aria-label="Search sounds" value="${esc(term)}">
    <p class="muted" data-count></p>
    <div data-out></div>
  </div>`;
  const out = app.querySelector("[data-out]");
  const countEl = app.querySelector("[data-count]");
  const search = app.querySelector(".icon-search");

  const firstFile = (r) => { try { return (JSON.parse(r.files) || [])[0] || ""; } catch { return ""; } };
  const cols = [
    { label: "Play", cls: "snd-col", cell: (r) => soundPlayer(r, { label: false, take: r.take }), value: (r) => r.name || "" },
    { label: "Name", cell: (r) => `<a class="ilink" href="?sound=${r.id}">${esc(r.name || "")}</a>`, value: (r) => r.name || "" },
    { label: "Kind", cls: "muted", group: (r) => r.kind, cell: (r) => esc(r.kind), value: (r) => r.kind },
    {
      label: "Transcript", cls: "snd-text", hideEmpty: true,
      cell: (r) => transcriptCell(r, takes.get(r.id)),
      value: (r) => transcriptText(r, takes.get(r.id)),
    },
    // No Length column: the player already shows the duration, and no File column:
    // a full client path is unreadable in a table cell. Both live on ?sound=<id>, and
    // the filter still matches the path, so searching "battle06.ogg" still works.
    {
      label: "Used by", cls: "muted", hideEmpty: true,
      cell: (r) => {
        const bits = [r.npcs ? `${r.npcs} NPC${r.npcs === 1 ? "" : "s"}` : "",
          r.areas ? `${r.areas} area${r.areas === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
        return bits ? `<a class="ilink" href="?sound=${r.id}">${bits}</a>` : "";
      },
      value: (r) => (r.npcs || 0) + (r.areas || 0),
    },
  ];

  const render = () => {
    // Name, file path AND transcript. The page shows a Transcript column, so not
    // searching it was an inconsistency users hit immediately: "time is money" matched on
    // ?voicelines and ?search but not here. Substring rather than FTS because every row
    // is already in memory -- and substring also matches mid-word, which FTS would not.
    const rows = term
      ? all.filter((r) => (r.name || "").toLowerCase().includes(term)
          || firstFile(r).includes(term)
          // Every take, not just the first: "time is money" is take 6 of one of these.
          || transcriptText(r, takes.get(r.id)).toLowerCase().includes(term))
        .map((r) => ({ ...r, take: matchedTake(takes.get(r.id), term, null) }))
      : all;
    countEl.textContent = `${rows.length.toLocaleString()} shown`;
    out.innerHTML = "";
    const spec = regTable(cols, rows, { pageSize: 100, groupable: true });
    out.innerHTML = spec.html;
    mountTables();
  };
  render();
  let t = 0;
  search.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      term = search.value.trim().toLowerCase();
      history.replaceState({}, "", "?sounds" + (term ? "=" + encodeURIComponent(term) : ""));
      render();
    }, 180);
  });
}

// One sound: who plays it and where. The browse page could only say "13 areas", which
// is a dead end -- this names them, and is also where the client file paths live, since
// a full path is unreadable inside a table cell.
async function showSound(id) {
  app.innerHTML = `<div class="loading">Loading sound ${id}…</div>`;
  if (!(await caps()).sounds) { app.innerHTML = `<div class="home"><p>This dataset has no audio.</p></div>`; return; }
  let snd, npcs, zones, texts;
  try {
    [snd, npcs, zones, texts] = await Promise.all([
      queryOne(Q.Q_SOUND, [id]), query(Q.Q_SOUND_NPCS, [id]),
      query(Q.Q_SOUND_ZONES, [id]), query(Q.Q_SOUND_TEXTS, [id]),
    ]);
  } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!snd) { app.innerHTML = `<div class="home"><p>No sound with ID ${id}.</p></div>`; return; }
  document.title = `${snd.name} - Sound - Tortoise-WoW DB`;
  // Which take says which line. Fetched separately rather than added to Q_SOUND_TEXTS,
  // which sits in the Promise.all above -- an unknown column there would take the whole
  // page down on a DB built before it. Merged on the text, since that is what both
  // queries agree on.
  const takeOfText = new Map(((await caps()).soundTake ? await query(Q.Q_SOUND_TAKES, [id]).catch(() => []) : [])
    .filter((t) => t.take != null).map((t) => [t.text, t.take]));

  let files = [];
  try { files = JSON.parse(snd.files) || []; } catch { /* malformed -> no takes listed */ }

  const npcCols = [
    { label: "NPC", cell: (r) => npcLink(r.entry, r.name) + (r.subname ? ` <span class="muted">&lt;${esc(r.subname)}&gt;</span>` : ""), value: (r) => r.name },
    { label: "Level", num: true, cls: "muted", cell: (r) => (r.level_min === r.level_max ? r.level_min : `${r.level_min}-${r.level_max}`) || "", value: (r) => r.level_max || 0 },
    { label: "Plays it as", cls: "muted", cell: (r) => esc(r.slot), value: (r) => r.slot },
  ];
  const zoneCols = [
    { label: "Area", cell: (r) => (r.is_zone ? zoneLink(r.area, r.name) : esc(r.name)), value: (r) => r.name },
    { label: "Continent", cls: "muted", hideEmpty: true, cell: (r) => CONTINENT[r.map_id] || "", value: (r) => CONTINENT[r.map_id] || "" },
    { label: "Plays as", cls: "muted", cell: (r) => esc(r.kind), value: (r) => r.kind },
  ];

  const tabDefs = [];
  if (npcs.length) tabDefs.push({ id: "npcs", label: "NPCs", ...regTable(npcCols, npcs, { pageSize: 100 }) });
  if (zones.length) tabDefs.push({ id: "zones", label: "Zones", ...regTable(zoneCols, zones, { pageSize: 100 }) });

  const takeList = files.map((f, i) => `<li><span class="muted">${files.length > 1 ? `Take ${i + 1}: ` : ""}</span>
    <code class="snd-path">${esc(f)}</code></li>`).join("");
  // Ordered and labelled by take, so the transcript list reads against the numbered
  // chips in the player above it rather than as an unattributed pile of lines.
  const lines = texts.filter((t) => t.text)
    .map((t) => ({ ...t, take: takeOfText.has(t.text) ? takeOfText.get(t.text) : null }))
    .sort((a, b) => (a.take ?? 99) - (b.take ?? 99))
    .map((t) => `<li class="snd-line"${t.take == null ? "" : ` data-take="${t.take}"`}`
      + ` title="${t.take == null ? "Play this clip" : `Play take ${t.take + 1}`}">${
        t.take != null && files.length > 1 ? `<span class="muted">Take ${t.take + 1}: </span>` : ""
      }<span class="snd-text">${esc(t.text)}</span>${autoBadge(t)}
      ${t.creature ? ` — ${npcLink(t.creature, t.creature_name)}` : ""}</li>`).join("");

  app.innerHTML = `<div class="sound-page">
    <div class="npc-head">
      <h1>${esc(snd.name)}</h1>
      <div class="npc-meta muted">${fmtDur(snd.ms) || "—"} · ${files.length} take${files.length === 1 ? "" : "s"}
        <span class="dim"> · Sound #${snd.id}</span>
        · <a class="nav" href="?sounds">All sounds</a></div>
    </div>
    <div class="sound-player">${soundPlayer(snd, { label: false })}</div>
    ${lines ? `<h2>Transcript</h2><ul class="sound-lines">${lines}</ul>` : ""}
    <h2>Files</h2><ul class="sound-files">${takeList}</ul>
    ${tabDefs.length ? tabs(tabDefs) : `<p class="muted">Nothing in this build references this sound.</p>`}
  </div>`;
  mountTables();
  wireTabs();
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
  const zoneIsSub = q.zone > 0 && !q.zone_page && (await caps()).subzones
    && !!(await queryOne(Q.Q_SUBZONE_EXISTS, [q.zone]).catch(() => null));
  if (q.zone > 0 && q.zone_name) {
    const sep = ' <span class="dim">›</span> ';
    const parts = [];
    if (CONTINENT[q.zone_map]) parts.push(esc(CONTINENT[q.zone_map]));
    if (q.zone_parent && q.zone_parent !== q.zone && q.parent_name) {
      parts.push(q.parent_page ? zoneLink(q.zone_parent, q.parent_name) : esc(q.parent_name));
    }
    // The leaf is often a SUB-area with no parchment of its own (783 -> Northshire
    // Valley), which used to render as dead text. It has a page either way now.
    parts.push(q.zone_page ? zoneLink(q.zone, q.zone_name)
      : zoneIsSub ? subzoneLink(q.zone, q.zone_name) : esc(q.zone_name));
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
  //
  // 1.12 datasets only. The channel covers Turtle/vanilla content and indexes by
  // vanilla quest id, so on a TBC dataset the same id means a DIFFERENT quest -- the
  // search would confidently surface the wrong walkthrough.
  const ytUrl = EXPANSION === "vanilla"
    ? `https://www.youtube.com/@TurtleWoWQuests/search?query=${encodeURIComponent(`${q.title} (ID: ${q.entry})`)}`
    : null;

  app.innerHTML =
    `<div class="npc-page quest-page">
      <div class="npc-head">
        <h1>${esc(q.title)}${q.custom ? ' <span class="tagx tw-tag" title="Added by Turtle WoW (not in vanilla 1.12)">Turtle WoW</span>' : ""}</h1>
        <div class="npc-meta muted">${bits.join(" · ")}<span class="dim"> · Quest #${q.entry}</span></div>
        ${restr.length ? `<div class="npc-meta muted">${restr.map(esc).join(" · ")}</div>` : ""}
        ${ytUrl ? `<div class="npc-meta"><a class="yt-link" href="${ytUrl}" target="_blank" rel="noopener noreferrer">▶ Watch walkthrough on YouTube</a></div>` : ""}
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
          initZoneMap(el, { ...zone, imgUrl: `${MAPS_BASE}${zone.areaid}.webp`, imgFallback: `${MAPS_BASE_MAIN}${zone.areaid}.webp` }, [], [], navigate, opts);
        } else {
          const m = (minimapManifest.maps || {})[String(v.mapId)];
          initWorldMap(el, {
            mapId: v.mapId, name: m.name, bbox: m.bbox,
            tile: minimapManifest.tile, adt: minimapManifest.adt, grid: minimapManifest.grid,
            maxNativeZoom: minimapManifest.maxNativeZoom, tilesBase: MINIMAP_BASE,
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

// Zone profile strip: what the zone IS before you read a single table -- how busy,
// what levels live there, how much of it is elite, how much there is to do. The
// counts come from build-db's `zone_stats`; the continent ranks are the part a page
// can't derive for itself (it only ever loads its own zone).
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"][(n % 100 - n % 10 !== 10 && n % 10 < 4) ? n % 10 : 0];
  return `${n}${s}`;
};

// Zone music / ambience / intro sting. Day and night are separate SoundEntries rows,
// already collapsed to one row by build-db when they're the same track.
const zoneSoundCols = () => [
  { label: "Play", cls: "snd-col", cell: (r) => soundPlayer(r, { label: false }), value: (r) => r.name || "" },
  { label: "Track", cell: (r) => esc(r.name || ""), value: (r) => r.name || "" },
  { label: "Kind", cls: "muted", cell: (r) => esc(r.kind), value: (r) => r.kind },
  { label: "Length", num: true, cls: "muted", cell: (r) => fmtDur(r.ms), value: (r) => r.ms || 0 },
];

function zoneStatsCard(s, mapid) {
  // Zones with no spawns of their own are stubs, not empty zones: a city's NPCs are
  // attributed to its parent zone (Ironforge -> Dun Morogh), and an instance's
  // "entrance" WorldMap area holds nothing but its quests. A lone quest count there
  // is noise, and ranking it against real zones would be a lie.
  if (!s || (!s.spawns && !s.objects)) return "";
  const num = (v) => v.toLocaleString();
  const cell = (v, label) => `<div class="zs"><b>${v}</b><span>${label}</span></div>`;
  const cells = [];
  if (s.spawns) cells.push(cell(num(s.spawns), "mob spawns"));
  if (s.npcs) cells.push(cell(num(s.npcs), "distinct NPCs"));
  if (s.lvl_hi) {
    cells.push(cell(s.lvl_lo === s.lvl_hi ? `${s.lvl_hi}` : `${s.lvl_lo}–${s.lvl_hi}`,
      `mob levels <span class="dim" title="Levels are weighted by spawn count and trimmed to the 10th–90th percentile, so one stray high-level rare doesn't stretch the range">(median ${s.lvl_med})</span>`));
  }
  if (s.spawns && s.elites) cells.push(cell(`${Math.round((s.elites / s.spawns) * 100)}%`, "elite spawns"));
  if (s.rares) cells.push(cell(num(s.rares), s.rares === 1 ? "rare mob" : "rare mobs"));
  if (s.bosses) cells.push(cell(num(s.bosses), s.bosses === 1 ? "world boss" : "world bosses"));
  if (s.quests) cells.push(cell(num(s.quests), "quests"));
  if (s.gather) cells.push(cell(num(s.gather), "gather nodes"));
  if (!cells.length) return "";

  // Ranks only mean something against a real field of zones -- an instance's one or
  // two interior "zones" is not one.
  const continent = CONTINENT[mapid] || "";
  const ranked = s.n_zones >= PEER_MIN && continent;
  const ranks = [];
  if (ranked && s.spawns) ranks.push(`${ordinal(s.rank_spawns)} busiest`);
  if (ranked && s.quests) ranks.push(`${ordinal(s.rank_quests)} by quest count`);
  const rankLine = ranks.length
    ? `<p class="zs-rank muted">${ranks.join(" · ")} of ${s.n_zones} ${esc(continent)} zones.</p>` : "";
  // High side only: "the 6th busiest zone on the continent" is trivia, "this zone has
  // fewer quests than most" is just a small zone being small.
  const head = ranked ? outlierLine([
    { label: "mob spawns", sup: "Most", ratio: s.med_spawns ? s.spawns / s.med_spawns : 0, rank: s.rank_spawns, n: s.n_zones },
    { label: "quests", sup: "Most", ratio: s.med_quests ? s.quests / s.med_quests : 0, rank: s.rank_quests, n: s.n_zones },
  ].filter((m) => pctBeaten(m.rank, s.n_zones) >= 90), `${esc(continent)} zones`) : "";
  return `<div class="zone-stats">${head}<div class="zs-grid">${cells.join("")}</div>${rankLine}</div>`;
}

// ---- shared by the zone page and the subzone page ----
// Both render the same tabs over the same row shapes; only the WHERE clause differs.
// These live at module scope so ?subzone= reuses them verbatim instead of forking a
// second copy that would drift.

// dedupe spawn rows into distinct NPCs / objects (with a spawn-point count)
function dedupeSpawns(rows) {
  const m = new Map();
  for (const r of rows) {
    const g = m.get(r.entry);
    if (g) g.count++; else m.set(r.entry, { ...r, count: 1 });
  }
  return [...m.values()];
}

// representative in-game icon per object = its highest-chance loot item's icon
// (idx_drops_owner makes the per-object subquery cheap).
async function objectIconMap(objs) {
  const iconByEntry = new Map();
  if (!objs.length) return iconByEntry;
  const ph = objs.map(() => "?").join(",");
  const rows = await query(
    `SELECT g.entry, (SELECT di.icon FROM drops d JOIN items i ON i.entry = d.item
       LEFT JOIN item_display_info di ON di.ID = i.display_id
       WHERE d.src='o' AND d.owner = g.data1 ORDER BY d.chance DESC LIMIT 1) AS icon
     FROM gameobjects g WHERE g.entry IN (${ph})`, objs.map((o) => o.entry));
  for (const r of rows) if (r.icon) iconByEntry.set(r.entry, r.icon);
  return iconByEntry;
}

// `shown*` are the caller's live Sets, so a map toggle survives a table re-render.
const zoneNpcCols = (shownNpcs) => [
  { label: "NPC", cell: (r) => npcLink(r.entry, r.name) + (r.subname ? ` <span class="muted">&lt;${esc(r.subname)}&gt;</span>` : ""), value: (r) => r.name },
  { label: "Level", num: true, cls: "muted", cell: (r) => lvlRange(r), value: (r) => r.level_max || r.level_min || 0 },
  { label: "Rank", num: true, cls: "muted", cell: (r) => CREATURE_RANK[r.rank] || "Normal", value: (r) => r.rank || 0 },
  { label: "Spawns", num: true, cls: "muted", cell: (r) => r.count, value: (r) => r.count },
  { label: "Map", cls: "mapcol",
    cell: (r) => `<label class="mapchk"><input type="checkbox" data-mapnpc="${r.entry}"${shownNpcs.has(r.entry) ? " checked" : ""}></label>`,
    value: (r) => (shownNpcs.has(r.entry) ? 1 : 0) },
];
const zoneObjCols = (shownObjects, iconByEntry) => [
  { label: "Object", cell: (o) => (iconByEntry.get(o.entry) ? iconImg(iconByEntry.get(o.entry)) : "") + objectLink(o.entry, o.name), value: (o) => o.name },
  { label: "Type", cls: "muted", cell: (o) => GAMEOBJECT_TYPE[o.type] || "", value: (o) => GAMEOBJECT_TYPE[o.type] || "" },
  { label: "Spawns", num: true, cls: "muted", cell: (o) => o.count, value: (o) => o.count },
  { label: "Map", cls: "mapcol",
    cell: (o) => `<label class="mapchk"><input type="checkbox" data-mapobj="${o.entry}"${shownObjects.has(o.entry) ? " checked" : ""}></label>`,
    value: (o) => (shownObjects.has(o.entry) ? 1 : 0) },
];
const zoneLootCols = () => [
  { label: "Item", cell: (i) => itemLink(i.entry, i.name, i.quality, i.icon), value: (i) => i.name },
  { label: "iLvl", num: true, cls: "muted", cell: (i) => i.item_level || "", value: (i) => i.item_level || 0 },
  { label: "Req", num: true, cls: "muted", cell: (i) => i.required_level || "", value: (i) => i.required_level || 0 },
];
const zoneQuestCols = () => [
  { label: "Quest", cell: (r) => questLink(r.entry, r.title), value: (r) => r.title },
  { label: "Level", num: true, cls: "muted", cell: (r) => r.level || "", value: (r) => r.level || 0 },
  { label: "Faction", cell: (r) => { const f = questFaction(r.reqraces); return `<span class="tagx fac-${f.toLowerCase()}">${f}</span>`; }, value: (r) => questFaction(r.reqraces) },
  { label: "Quest Giver", cls: "muted", cell: (r) => (r.giver_id ? npcLink(r.giver_id, r.giver) : ""), value: (r) => r.giver || "" },
];
// Farming: best gold targets, sorted by total expected drop value. Each links to its
// own page focused on `fz` (the parchment zone) so its map opens here.
const zoneFarmCols = (fz) => [
  { label: "Target", cell: (r) => `<a class="ilink ${r.kind === "c" ? "npc" : "object"}" href="?${r.kind === "c" ? "npc" : "object"}=${r.entry}&fz=${fz}">${esc(r.name)}</a>`, value: (r) => r.name },
  { label: "Type", cls: "muted", cell: (r) => (r.kind === "c" ? "Mob" : (GAMEOBJECT_TYPE[r.type] || "Object")), value: (r) => (r.kind === "c" ? "Mob" : "Object") },
  { label: "Level", num: true, cls: "muted", cell: (r) => (r.kind === "c" ? lvlRange(r) : ""), value: (r) => r.level_max || r.level_min || 0 },
  { label: "Spawns", num: true, cls: "muted", cell: (r) => r.count, value: (r) => r.count },
  { label: "Value/each", num: true, cls: "muted", cell: (r) => moneyHtml(Math.round(r.value)), value: (r) => r.value },
  { label: "Total value", num: true, cell: (r) => moneyHtml(Math.round(r.total)), value: (r) => r.total },
];
// Mobs/objects ranked by total expected drop value (vendor value per kill/gather x
// spawn count) -- what's worth farming for gold here.
const farmRowsFrom = (npcs, objs) => [
  ...npcs.filter((n) => n.loot_value > 0).map((n) => ({ kind: "c", entry: n.entry, name: n.name, level_min: n.level_min, level_max: n.level_max, value: n.loot_value, count: n.count, total: n.loot_value * n.count })),
  ...objs.filter((o) => o.loot_value > 0).map((o) => ({ kind: "o", entry: o.entry, name: o.name, type: o.type, value: o.loot_value, count: o.count, total: o.loot_value * o.count })),
].sort((a, b) => b.total - a.total).slice(0, 100);
const farmPointsFrom = (spawns, objects) => [
  ...spawns.filter((s) => s.loot_value > 0).map((s) => ({ x: s.x, y: s.y, value: s.loot_value })),
  ...objects.filter((o) => o.loot_value > 0).map((o) => ({ x: o.x, y: o.y, value: o.loot_value })),
];

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
  // A dataset built before the subzones work has neither the column nor the table;
  // the page must still render exactly as it did (see caps() in db.js).
  const { subzones: hasSubzones, spawnSub, sounds: hasSounds } = await caps();
  // Zone music/ambience hangs off the AREA id, not the map -- an instance's interior
  // areas carry their own tracks, so this is queried the same way for both.
  const zoneSounds = hasSounds ? await query(Q.Q_ZONE_SOUNDS, [z.areaid]).catch(() => []) : [];
  const [spawns, objects, loot, focusPts, focusItem, bossLoot, bossEntries, zoneQuests, floors, subRows] = await Promise.all([
    isInstance ? query(Q.Q_MAP_SPAWNS, mz) : query(Q.qZoneSpawns(spawnSub), az),
    isInstance ? query(Q.Q_MAP_OBJECTS, mz) : query(Q.qZoneObjects(spawnSub), az),
    isInstance ? query(Q.Q_DUNGEON_LOOT, mz) : query(Q.Q_ZONE_LOOT, az),
    gatherItem ? query(Q.Q_ZONE_FOCUS_SPAWNS, [z.areaid, gatherItem]) : [],
    gatherItem ? queryOne(Q.Q_ITEM_ICON, [gatherItem]) : null,
    isInstance ? query(Q.Q_DUNGEON_BOSS_LOOT, mz) : [],
    isInstance ? query(Q.Q_MAP_BOSSES, mz) : [],
    isInstance ? query(Q.Q_DUNGEON_QUESTS, [z.mapid, z.name]) : query(Q.Q_ZONE_QUESTS, az),
    isInstance ? query(Q.Q_MAP_FLOORS, mz) : [],
    !isInstance && hasSubzones ? query(Q.Q_ZONE_SUBZONES, az) : [],
  ]);
  // Zone profile (absent on a DB built before zone_stats -- dev / cMaNGOS datasets
  // rebuild on their own schedule, and the strip is not worth breaking the page for).
  const zstats = await queryOne(Q.Q_ZONE_STATS, az).catch(() => null);
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

  const npcs = dedupeSpawns(spawns), objs = dedupeSpawns(objects);

  // Best farms (open-world), plus value-weighted points for the map's "Gold route".
  const farmRows = isInstance ? [] : farmRowsFrom(npcs, objs);
  const farmPoints = isInstance ? null : farmPointsFrom(spawns, objects);
  const iconByEntry = await objectIconMap(objs);

  // per-NPC/object map toggles: the sets survive table re-render (sort/page)
  const shownNpcs = new Set();
  const shownObjects = new Set();
  const bossCols = [
    { label: "Boss", cell: (r) => npcLink(r.boss, r.boss_name), value: (r) => r.boss_name },
    { label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon) + dropQty(r.mincount, r.maxcount), value: (r) => r.name },
    { label: "Chance", num: true, cell: (r) => pct(r.chance), value: (r) => r.chance || 0 },
  ];
  const subCols = [
    { label: "Subzone", cell: (r) => subzoneLink(r.entry, r.name), value: (r) => r.name },
    { label: "NPCs", num: true, cls: "muted", cell: (r) => r.npcs || "", value: (r) => r.npcs || 0 },
    { label: "Spawns", num: true, cls: "muted", cell: (r) => r.spawns || "", value: (r) => r.spawns || 0 },
    { label: "Objects", num: true, cls: "muted", cell: (r) => r.objects || "", value: (r) => r.objects || 0 },
    { label: "Quests", num: true, cls: "muted", cell: (r) => r.quests || "", value: (r) => r.quests || 0 },
  ];
  const tabDefs = [
    ...(isInstance ? [{ id: "bosses", label: "Boss Loot", ...regTable(bossCols, bossLoot, { pageSize: 500, groupable: true, group: 0 }) }] : []),
    { id: "npcs", label: "NPCs", ...regTable(zoneNpcCols(shownNpcs), npcs, { pageSize: 100 }) },
    ...(farmRows.length ? [{ id: "farm", label: "Farming", ...regTable(zoneFarmCols(z.areaid), farmRows, { pageSize: 100, sort: "Total value", dir: "d" }) }] : []),
    { id: "quests", label: "Quests", ...regTable(zoneQuestCols(), zoneQuests, { pageSize: 100 }) },
    { id: "items", label: "Items", ...regTable(zoneLootCols(), loot, { pageSize: 100 }) },
    { id: "objects", label: "Objects", ...regTable(zoneObjCols(shownObjects, iconByEntry), objs, { pageSize: 100 }) },
    // Appended LAST on purpose: the default (first) pane stays NPCs.
    ...(subRows.length ? [{ id: "subzones", label: "Subzones", ...regTable(subCols, subRows, { pageSize: 100, sort: "Spawns", dir: "d" }) }] : []),
    ...(zoneSounds.length ? [{ id: "sounds", label: "Music", ...regTable(zoneSoundCols(), zoneSounds) }] : []),
  ];

  // A few client-defined zones (e.g. not-yet-populated Turtle areas) have a map
  // texture but no spawns recorded within their bounds -> blank tabs. Show
  // an explanatory note instead.
  const hasData = npcs.length || objs.length || loot.length || bossLoot.length || zoneQuests.length || subRows.length;
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
      ${isInstance ? "" : zoneStatsCard(zstats, z.mapid)}
      ${floorSwitch}
      <div id="zonemap"></div>
      ${body}
    </div>`;
  mountTables();
  wireTabs();
  const el = document.getElementById("zonemap");
  try {
    const { initZoneMap } = await import("./zonemap.js");
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
    // Keep the focused sub-area in the URL so the view is shareable and Back-safe.
    const onSubzone = (sub) => {
      const p = new URLSearchParams(location.search);
      if (sub == null) p.delete("sub"); else p.set("sub", String(sub));
      history.replaceState(null, "", `${location.pathname}?${p}`);
    };
    // (re)draw the map for a floor: its parchment + the spawns/bosses on it.
    const renderFloor = (fl) => {
      const fs = isInstance ? spawns.filter((s) => s.zone === fl.areaid) : spawns;
      const fo = isInstance ? objects.filter((o) => o.zone === fl.areaid) : objects;
      const fb = isInstance ? bosses.filter((b) => b.zone === fl.areaid) : bosses;
      zmap = initZoneMap(el, { ...fl, imgUrl: `${MAPS_BASE}${fl.areaid}.webp`, imgFallback: `${MAPS_BASE_MAIN}${fl.areaid}.webp` }, fs, fo, navigate, {
        focus: fl.areaid === z.areaid ? focus : null, bosses: fb, farm: isInstance ? null : farmPoints, onToggle: syncSel,
        subzones: subRows, initialSub: Number(new URLSearchParams(location.search).get("sub")) || null, onSubzone,
      });
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

// One sub-area of a zone (?subzone=87 -> Goldshire). Same tabs as the zone page, but
// every read is narrowed to this leaf area, and the map draws the PARENT's parchment
// with only these spawns on it -- a subzone has no art of its own.
async function showSubzone(id) {
  app.innerHTML = `<div class="loading">Loading subzone ${id}…</div>`;
  if (!(await caps()).subzones) {
    app.innerHTML = `<div class="home"><p>Subzones aren't available in this dataset yet —
      its database predates them. Try the <a href="?db=main">main</a> dataset.</p></div>`;
    return;
  }
  let sz;
  try { sz = await queryOne(Q.Q_SUBZONE, [id]); } catch (e) { app.innerHTML = errorBox(e); return; }
  if (!sz) { app.innerHTML = `<div class="home"><p>No subzone with ID ${id}.</p></div>`; return; }
  document.title = `${sz.name} - Tortoise-WoW DB`;

  // A sub-area is its own AreaTable row, so it carries its own ZoneMusic/Ambience --
  // Northshire Valley and Moonbrook play different things from Elwynn/Westfall at large.
  const subSounds = (await caps()).sounds ? await query(Q.Q_ZONE_SOUNDS, [id]).catch(() => []) : [];
  const sp = [id, sz.zone_id];
  const [spawns, objects, loot, subQuests] = await Promise.all([
    query(Q.Q_SUBZONE_SPAWNS, sp),
    query(Q.Q_SUBZONE_OBJECTS, sp),
    query(Q.Q_SUBZONE_LOOT, sp),
    // Q_ZONE_QUESTS already rolls up `q.zone = ?1 OR a.zone_id = ?1`, which given a
    // leaf area means "this sub-area's quests, plus any of its own children's".
    query(Q.Q_ZONE_QUESTS, [id]),
  ]);

  const npcs = dedupeSpawns(spawns), objs = dedupeSpawns(objects);
  const farmRows = farmRowsFrom(npcs, objs);
  const farmPoints = farmPointsFrom(spawns, objects);
  const iconByEntry = await objectIconMap(objs);

  const shownNpcs = new Set();
  const shownObjects = new Set();
  const tabDefs = [
    { id: "npcs", label: "NPCs", ...regTable(zoneNpcCols(shownNpcs), npcs, { pageSize: 100 }) },
    ...(farmRows.length ? [{ id: "farm", label: "Farming", ...regTable(zoneFarmCols(sz.zone_id), farmRows, { pageSize: 100, sort: "Total value", dir: "d" }) }] : []),
    { id: "quests", label: "Quests", ...regTable(zoneQuestCols(), subQuests, { pageSize: 100 }) },
    { id: "items", label: "Items", ...regTable(zoneLootCols(), loot, { pageSize: 100 }) },
    { id: "objects", label: "Objects", ...regTable(zoneObjCols(shownObjects, iconByEntry), objs, { pageSize: 100 }) },
    ...(subSounds.length ? [{ id: "sounds", label: "Music", ...regTable(zoneSoundCols(), subSounds) }] : []),
  ];
  // Music counts as data: ~half of all sub-areas carry their own track or ambience, and
  // plenty of them (a lake, a mine) have no spawns or quests of their own at all -- those
  // pages would otherwise say "nothing is recorded here" while holding something to play.
  const hasData = npcs.length || objs.length || loot.length || subQuests.length || subSounds.length;
  const body = hasData ? tabs(tabDefs)
    : `<div class="zone-empty muted">Nothing is recorded inside this sub-area's bounds.</div>`;

  const meta = [
    sz.zone_id ? zoneLink(sz.zone_id, sz.zone_name || `Zone #${sz.zone_id}`) : "",
    CONTINENT[sz.map_id],
    `${spawns.length + objects.length} spawns`,
  ].filter(Boolean);

  // The parent's parchment is the only art there is. A parent with no map at all
  // (one such subzone in the current data) degrades to a tabs-only page.
  const hasMap = sz.zone_id && sz.img_w > 0;
  app.innerHTML =
    `<div class="zone-page">
      <div class="npc-head">
        <h1>${esc(sz.name)}</h1>
        <div class="npc-meta muted">${meta.join(" · ")}<span class="dim"> · Subzone #${sz.entry}</span></div>
      </div>
      ${hasMap ? `<div id="zonemap"></div>` : ""}
      ${body}
    </div>`;
  mountTables();
  wireTabs();
  if (!hasMap) return;

  const el = document.getElementById("zonemap");
  try {
    const { initZoneMap } = await import("./zonemap.js");
    const syncSel = (kind, entry, on) => {
      const set = kind === "npc" ? shownNpcs : shownObjects;
      if (on) set.add(entry); else set.delete(entry);
      const box = app.querySelector(`input[data-map${kind === "npc" ? "npc" : "obj"}="${entry}"]`);
      if (box) box.checked = on;
    };
    // The ADT bbox when we have one; otherwise the extent of what we're plotting, so
    // the map still opens on the sub-area rather than the whole parent zone.
    const pts = [...spawns, ...objects];
    const bounds = sz.x0 != null ? { x0: sz.x0, x1: sz.x1, y0: sz.y0, y1: sz.y1 }
      : pts.length ? {
          x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)),
          y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)),
        } : null;
    const zmap = initZoneMap(el, {
      areaid: sz.zone_id, name: sz.zone_name, mapid: sz.mapid,
      locleft: sz.locleft, locright: sz.locright, loctop: sz.loctop, locbottom: sz.locbottom,
      img_w: sz.img_w, img_h: sz.img_h,
      imgUrl: `${MAPS_BASE}${sz.zone_id}.webp`, imgFallback: `${MAPS_BASE_MAIN}${sz.zone_id}.webp`,
    }, spawns, objects, navigate, { farm: farmPoints, onToggle: syncSel, bounds });

    const objPane = app.querySelector('[data-pane="objects"]');
    if (objPane) objPane.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-mapobj]");
      if (!cb || !zmap) return;
      const entry = Number(cb.dataset.mapobj);
      zmap.toggleObject(entry, cb.checked, iconByEntry.get(entry));
    });
    const npcPane = app.querySelector('[data-pane="npcs"]');
    if (npcPane) npcPane.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-mapnpc]");
      if (!cb || !zmap) return;
      zmap.toggleNpc(Number(cb.dataset.mapnpc), cb.checked);
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

// "What's new" (?changelog): per-deploy diff sections built by
// scripts/build-changelog.mjs, served per-dataset at ${DATA_BASE}changelog.json
// (dev only for now). Main dataset has no file -> a pointer to the Dev view.
async function showChangelog() {
  document.title = "What's new - Tortoise-WoW DB";
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let log = null;
  try {
    const res = await fetch(`${DATA_BASE}changelog.json`, { cache: "no-store" });
    if (res.ok) log = await res.json();
  } catch { /* fall through to the empty state */ }

  const heading = `What's new${DATASET === "dev" ? " · dev" : ""}`;
  if (!Array.isArray(log) || !log.length) {
    const devUrl = `${import.meta.env.BASE_URL}dev/?changelog`;
    const note = DATASET === "dev"
      ? `No changes recorded yet — the changelog fills in as new <b>1181dev</b> builds deploy.`
      : `The changelog tracks the <b>Dev</b> dataset (server <code>1181dev</code>). <a class="nav" href="${devUrl}">View it on Dev →</a>`;
    app.innerHTML = `<div class="results changelog"><h1>${heading}</h1><p class="cl-empty">${note}</p></div>`;
    return;
  }

  const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); };
  const linkers = {
    npcs: (it) => npcLink(it.id, it.name),
    items: (it) => itemLink(it.id, it.name, it.quality),
    quests: (it) => questLink(it.id, it.name),
    objects: (it) => objectLink(it.id, it.name),
    spells: (it) => spellLink(it.id, it.name),
    sets: (it) => `<a class="ilink" href="?itemset=${it.id}">${esc(it.name)}</a>`,
  };
  const GROUPS = [["npcs", "NPCs"], ["items", "Items"], ["quests", "Quests"], ["objects", "Objects"], ["spells", "Spells"], ["sets", "Item sets"]];

  // one Added/Removed group list; `total` is the pre-cap count so we can show "+N more"
  const group = (label, items, total, linkFn, linked = true) => {
    if (!items || !items.length) return "";
    const more = total > items.length ? `<li class="cl-more">…and ${total - items.length} more</li>` : "";
    const lis = items.map((it) => `<li>${linked ? linkFn(it) : esc(it.name)}</li>`).join("");
    return `<div class="cl-group"><h4>${label} <span class="cl-n">${total}</span></h4><ul class="cl-list">${lis}${more}</ul></div>`;
  };

  const sections = log.map((s) => {
    const added = GROUPS.map(([k, l]) => group(l, s.added?.[k], s.counts?.added?.[k] ?? (s.added?.[k]?.length || 0), linkers[k])).join("");
    const removed = GROUPS.map(([k, l]) => group(l, s.removed?.[k], s.counts?.removed?.[k] ?? (s.removed?.[k]?.length || 0), linkers[k], false)).join("");
    const spawnLis = (s.spawns || []).map((x) => {
      const link = x.kind === "o" ? objectLink(x.id, x.name) : npcLink(x.id, x.name);
      const sign = x.delta > 0 ? `+${x.delta}` : `${x.delta}`;
      return `<li>${link} → ${esc(x.mapName)} <span class="cl-delta ${x.delta > 0 ? "up" : "down"}">${sign}</span></li>`;
    }).join("");
    const cols = [
      added ? `<div class="cl-col"><h3 class="cl-added">Added</h3>${added}</div>` : "",
      removed ? `<div class="cl-col"><h3 class="cl-removed">Removed</h3>${removed}</div>` : "",
      spawnLis ? `<div class="cl-col"><h3 class="cl-added">Spawns</h3><div class="cl-group"><ul class="cl-list">${spawnLis}</ul></div></div>` : "",
    ].join("");
    const badge = s.baseline ? `<span class="cl-baseline" title="Everything this dataset adds over the main branch">baseline · dev vs main</span>` : "";
    return `<section class="cl-section"><div class="cl-head"><span class="cl-date">${fmtDate(s.builtAt)}</span><code class="cl-ver">${esc(s.version || "")}</code>${badge}</div><div class="cl-cols">${cols}</div></section>`;
  }).join("");

  app.innerHTML = `<div class="results changelog"><h1>${heading}</h1>${sections}</div>`;
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
    initFlightMap(el, { ...cont, imgUrl: `${MAPS_BASE}continent-${cont.map}.webp`, imgFallback: `${MAPS_BASE_MAIN}continent-${cont.map}.webp` }, nodes, routes, navigate);
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
      maxNativeZoom: minimapManifest.maxNativeZoom, tilesBase: MINIMAP_BASE,
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
    { label: "Item", cell: (r) => itemLink(r.entry, r.name, r.quality, r.icon) + dropQty(r.mincount, r.maxcount), value: (r) => r.name },
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
  let version = "0";
  try { version = (await getMeta()).version || "0"; } catch { /* no version yet */ }
  // Try each reachable origin's atlas (R2, then the jsDelivr/Release mirrors, then
  // Pages) so custom icons still resolve when R2 is blocked.
  for (const a of getAtlasUrls(version)) {
    try {
      const res = await fetch(a.json);
      if (!res.ok) continue;
      const m = await res.json();
      setIconAtlas({ ...m, url: a.webp });
      return;
    } catch { /* try the next origin */ }
  }
}

// Load the local model-thumbnail manifest (Turtle-custom models we rendered
// ourselves); render.js then serves our webp for those and Wowhead for the rest.
async function loadModelThumbs() {
  try {
    // ?v=<version> busts Cloudflare's edge cache on redeploy — the manifest is
    // updated in place, so a plain URL would serve the stale cached copy.
    let version = "0";
    try { version = (await getMeta()).version || "0"; } catch { /* no version yet */ }
    const res = await fetch(`${MODEL_THUMBS_BASE}manifest.json?v=${version}`);
    if (!res.ok) return;
    const ids = await res.json();
    setModelThumbs({ base: MODEL_THUMBS_BASE, ids: new Set(ids), ver: version });
  } catch { /* absent -> Wowhead-only fallback (unchanged behaviour) */ }
}

// Footer: "Updated <build date>" (from version.json's builtAt) + how long the
// first page render took (performance.now() = ms since navigation start). Set once
// on boot; the footer persists across SPA navigation so it reflects initial load.
async function showFooterMeta(loadMs) {
  const load = document.getElementById("footLoad");
  if (load) load.textContent = `Loaded in ${loadMs < 1000 ? `${Math.round(loadMs)} ms` : `${(loadMs / 1000).toFixed(1)} s`}`;
  // Data-source credit is dataset-specific: the vanilla/cmangos dataset is derived from
  // cMaNGOS classic-db (GPL v3) -- attribute it (see NOTICE.md). main/dev keep the Turtle link.
  const dbLink = document.getElementById("footDb");
  if (dbLink && DATASET === "vanilla-cmangos") {
    dbLink.href = "https://github.com/cmangos/classic-db";
    dbLink.textContent = "cMaNGOS (GPL v3)";
    dbLink.title = "vanilla/cmangos dataset — data derived from cMaNGOS classic-db, licensed GPL v3";
  }
  const upd = document.getElementById("footUpdated");
  if (!upd) return;
  try {
    const { builtAt } = await getMeta();
    if (!builtAt) return;
    const d = new Date(builtAt);
    if (isNaN(d)) return;
    upd.textContent = `Updated ${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}${DATASET === "dev" ? " · dev" : ""}`;
    upd.title = d.toLocaleString() + (DATASET === "dev" ? " (1181dev dataset)" : "");
  } catch { /* no build stamp -> omit */ }
}

// ---- boot ----
// Resolve the asset origin first (probe R2, fall over to the Pages mirror if it's
// blocked) so nothing below reads DATA_BASE/ASSETS_BASE before they're settled.
resolveOrigins().finally(() => {
  preconnect();
  initHovercards();
  initSearchDropdown(searchInput, document.getElementById("searchForm"), navigate);
  // model-thumb manifest loads in parallel (non-blocking; hovercards appear later)
  loadModelThumbs();
  // Wait for the atlas (small JSON) so the first paint shows custom icons; route
  // anyway if it fails or is missing. Time the first render for the footer.
  loadIconAtlas()
    .then(renderRoute, renderRoute)
    .finally(() => showFooterMeta(performance.now()));
});
