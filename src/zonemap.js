// Zone map: a per-zone parchment image (L.CRS.Simple) with toggleable marker
// layers. The high-volume category markers (NPC roles, object types -- the
// Barrens has ~12k) are GPU sprites on a Pixi overlay (leaflet-pixi-overlay) so
// pan/zoom stays smooth. The few icon markers (a gathered node's icon, a toggled
// object) stay as Leaflet HTML markers -- no WebGL texture / CORS fuss, and there
// are not many. World coords -> image px via the zone's WorldMapArea bounds.
// Lazy-imported so Pixi/Leaflet stay out of the main bundle.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as PIXI from "pixi.js";
import "leaflet-pixi-overlay";
import { GAMEOBJECT_TYPE } from "./constants.js";
import { iconMarker, getIconAtlas } from "./render.js";
import { ASSETS_BASE } from "./config.js";

// [key, label] per NPC role; the marker/legend icon comes from CAT_ICON (below).
const NPC_CATS = [
  ["quest", "Quest Givers"],
  ["vendor", "Vendors"],
  ["repair", "Repair"],
  ["trainer", "Trainers"],
  ["flight", "Flight Masters"],
  ["inn", "Innkeepers"],
  ["bank", "Bankers"],
  ["mob", "Enemy Mobs"],
];
const objTypeLabel = (t) => `Obj: ${GAMEOBJECT_TYPE[t] || "Other"}`;
// World map: gather nodes get a per-node category (e.g. "Mining: Copper Vein",
// "Herb: Peacebloom") via gameobjects.gather, so each ore/herb is a separate toggle
// with its own icon. Zone map: the coarser "Obj: Mining"/"Obj: Herbalism" buckets
// (a single zone has few node types; the per-node split is a continent-scale need).
const objLabel = (o) => o.gather === "mining" ? `Mining: ${o.name}`
  : o.gather === "herbalism" ? `Herb: ${o.name}` : objTypeLabel(o.type);
const objLabelCoarse = (o) => o.gather === "mining" ? "Obj: Mining"
  : o.gather === "herbalism" ? "Obj: Herbalism" : objTypeLabel(o.type);
// URL-safe code for a category key. NPC roles + "rare" are already safe; the
// "<Prefix>: <name>" buckets slug to "<p>:<name>" so enabled layers persist.
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const catCode = (key) =>
  key.startsWith("Mining: ") ? "m:" + slug(key.slice(8)) :
  key.startsWith("Herb: ") ? "h:" + slug(key.slice(6)) :
  key.startsWith("Obj: ") ? "o:" + slug(key.slice(5)) : key;

// Gather-node markers/legends draw the yielded item's real icon from the Blizzard
// CDN (CORS-enabled, so it textures the WebGL overlay). Turtle-custom icons aren't
// on the CDN (they live only in the sprite atlas), so those fall back to the
// generic Mining/Herbalism POI cell instead of a broken texture.
const ICON_CDN = "https://render-us.worldofwarcraft.com/icons/56";
// Sprites start on the generic Mining/Herb POI cell and get UPGRADED to the real
// item icon once it loads. We preload via a plain Image (not PIXI.Texture.from) so
// a 404 (stale / Turtle-only icon name) never reaches Pixi's error path -- it just
// leaves the sprite on its generic cell. One request per distinct basename.
const iconReq = new Map();
function requestIcon(basename, sp) {
  const key = basename.toLowerCase();
  let r = iconReq.get(key);
  if (r && r.tex) { sp.texture = r.tex; sp.basePx = r.tex.width || 56; return; }
  if (r) { if (!r.failed) r.sprites.push(sp); return; }
  r = { tex: null, failed: false, sprites: [sp] };
  iconReq.set(key, r);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    r.tex = PIXI.Texture.from(img);
    const px = img.naturalWidth || 56;
    for (const s of r.sprites) { s.texture = r.tex; s.basePx = px; }
    r.sprites = [];
    if (currentOverlay) currentOverlay.redraw();
  };
  img.onerror = () => { r.failed = true; r.sprites = []; }; // keep the generic cell
  img.src = `${ICON_CDN}/${key}.jpg`;
}
// CDN-usable icon basename for a gather node, or null (custom/none -> generic cell).
const cdnIconOf = (o) => {
  const b = o.gather_icon;
  if (!b) return null;
  const atlas = getIconAtlas();
  return atlas && atlas.icons[b.toLowerCase()] != null ? null : b;
};

const FLAG = { vendor: 128, repair: 4096, trainer: 16, flight: 8192, inn: 131072, bank: 65536 };
function npcRolesFor(s) {
  const r = [];
  if (s.questgiver || (s.npc_flags & 2)) r.push("quest");
  if (s.npc_flags & FLAG.vendor) r.push("vendor");
  if (s.npc_flags & FLAG.repair) r.push("repair");
  if (s.npc_flags & FLAG.trainer) r.push("trainer");
  if (s.npc_flags & FLAG.flight) r.push("flight");
  if (s.npc_flags & FLAG.inn) r.push("inn");
  if (s.npc_flags & FLAG.bank) r.push("bank");
  if (!r.length) r.push("mob");
  return r;
}
const lvl = (s) => (s.level_max && s.level_max !== s.level_min ? `${s.level_min}-${s.level_max}` : (s.level_min || "?"));

let currentMap = null, currentOverlay = null;

// Right-click marker menu (wowhead-style): copy a spawn's in-game map coordinate or
// a TomTom /way command -- for the clicked marker, or every spawn of that NPC/node.
// One body-level element, refilled + repositioned per open (it must escape the map's
// clipped overflow). No "In-Game Map Pin": the /way map-pin API doesn't exist in 1.12.
let ctxEl = null;
function ctxMenuEl() {
  if (ctxEl) return ctxEl;
  ctxEl = document.createElement("div");
  ctxEl.className = "map-ctx";
  ctxEl.style.display = "none";
  document.body.appendChild(ctxEl);
  const hide = () => { ctxEl.style.display = "none"; };
  // Dismiss on an outside left-click (a right-click fires `contextmenu`, not
  // `click`, so the opening gesture can't immediately self-close the menu), Escape,
  // or window blur. (No scroll-dismiss: the menu is position:fixed, and Leaflet's
  // init layout fires a window scroll that would otherwise close it instantly.)
  document.addEventListener("click", (e) => { if (!ctxEl.contains(e.target)) hide(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  window.addEventListener("blur", hide);
  return ctxEl;
}

// The "minimap" POI sprite sheet (16 cols, 32px cells; src: WowClassicGrindBot).
// Elite (the skull) sits at grid [11,14] -> used for boss markers.
const POI_URL = `${ASSETS_BASE}icons/poi-atlas.webp`;
const POI_CELL = 32, POI_COLS = 16;
const BOSS_GRID = [11, 14]; // "Elite" = skull
// CSS background for a POI sprite scaled to `size` px.
function poiSpriteStyle([col, row], size) {
  return `background-image:url(${POI_URL});background-size:${POI_COLS * size}px auto;` +
    `background-position:-${col * size}px -${row * size}px;width:${size}px;height:${size}px`;
}

// Marker/legend icons drawn from the POI atlas (so categories read as real icons,
// not coloured blobs). [col,row] cells verified against the atlas art -- a few
// differ from the upstream icon_atlas.js names, which are unreliable. Boss keeps
// BOSS_GRID (the skull). Object categories key off their GAMEOBJECT_TYPE name.
const CAT_ICON = {
  quest: [9, 3], vendor: [6, 16], repair: [8, 20], trainer: [3, 17],
  flight: [7, 16], inn: [4, 4], bank: [8, 16], mob: [1, 18], rare: [13, 14],
};
const OBJ_ICON = {
  Chest: [14, 17], Mailbox: [5, 16], "Fishing Hole": [0, 3], "Fishing Node": [0, 3],
  Door: [5, 8], "Quest Giver": [9, 3], "Meeting Stone": [2, 16],
  Mining: [4, 17], Herbalism: [4, 13], // gather nodes (ore vein / green sprout)
};
const OBJ_GENERIC = [12, 3]; // blue cog -- generic gameobject
// category key -> atlas [col,row]
function catGrid(key) {
  if (CAT_ICON[key]) return CAT_ICON[key];
  if (key.startsWith("Mining: ")) return OBJ_ICON.Mining;     // generic fallback for
  if (key.startsWith("Herb: ")) return OBJ_ICON.Herbalism;    // gather nodes w/o a CDN icon
  if (key.startsWith("Obj: ")) return OBJ_ICON[key.slice(5)] || OBJ_GENERIC;
  return OBJ_GENERIC;
}
// One POI atlas BaseTexture shared across maps; per-category sub-textures are 32px
// frames into it. (BaseTexture.from caches by URL, so re-inits reuse it.)
let poiBase = null;
const poiTexCache = new Map();
function poiTexture(key) {
  if (!poiBase) poiBase = PIXI.BaseTexture.from(POI_URL);
  let t = poiTexCache.get(key);
  if (!t) {
    const [col, row] = catGrid(key);
    t = new PIXI.Texture(poiBase, new PIXI.Rectangle(col * POI_CELL, row * POI_CELL, POI_CELL, POI_CELL));
    poiTexCache.set(key, t);
  }
  return t;
}
// Layer-control label: a small atlas sprite + the text (Leaflet renders the name
// via innerHTML, so HTML here is fine).
function catLabel(key, text, icon) {
  if (icon) return `<img class="cat-ico" src="${ICON_CDN}/${icon.toLowerCase()}.jpg" alt="" ` +
    `onerror="this.style.visibility='hidden'" ` +
    `style="width:16px;height:16px;vertical-align:-4px;margin-right:5px">${text}`;
  return `<span class="cat-ico" style="${poiSpriteStyle(catGrid(key), 16)};` +
    `display:inline-block;vertical-align:-4px;margin-right:5px"></span>${text}`;
}
// Redraw once the atlas finishes loading (frames render blank until then).
function whenPoiReady(cb) {
  if (poiBase && !poiBase.valid) poiBase.once("loaded", cb);
}

// Shared docked layer panel -- replaces Leaflet's stock `L.control.layers` on both
// maps. A persistent, collapsible sidebar (top-right) with ONE global search and
// collapsible groups, instead of a flat hover-expanded checkbox list. UI-only: each
// row carries { label, count, html, on, toggle(bool) }, so the world map (mutating
// `enabledCats`) and the zone map (adding/removing layers) wire their own semantics
// without the panel knowing about either. `header` (optional DOM node) mounts above
// the groups (world map: the zone-focus select + npc name/id filter). `groups`:
// [{ title, open?, rows:[...] }]. Returns an L.Control.
function buildLayerPanel(map, { groups = [], header = null } = {}) {
  const Ctl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const root = L.DomUtil.create("div", "wm-panel"); // not .leaflet-bar (avoid its <a> button styling)
      // reopen button (CSS shows it only while the panel is collapsed)
      const showBtn = L.DomUtil.create("button", "wm-panel-show", root);
      showBtn.type = "button"; showBtn.title = "Layers";
      const full = L.DomUtil.create("div", "wm-panel-full", root);
      const head = L.DomUtil.create("div", "wm-panel-head", full);
      const search = L.DomUtil.create("input", "wm-search", head);
      search.type = "text"; search.placeholder = "Search layers…";
      const hideBtn = L.DomUtil.create("button", "wm-panel-hide", head);
      hideBtn.type = "button"; hideBtn.title = "Hide panel"; hideBtn.textContent = "✕";
      if (header) full.appendChild(header);
      const body = L.DomUtil.create("div", "wm-panel-body", full);

      const allRows = []; // { el, label, cb, toggle } across every group, for search
      for (const g of groups) {
        if (!g.rows || !g.rows.length) continue;
        const gEl = L.DomUtil.create("div", "wm-group" + (g.open ? "" : " collapsed"), body);
        const gh = L.DomUtil.create("div", "wm-group-head", gEl);
        L.DomUtil.create("span", "wm-caret", gh);
        const title = L.DomUtil.create("span", "wm-group-title", gh);
        title.textContent = g.title;
        const cnt = L.DomUtil.create("span", "wm-group-count", gh);
        cnt.textContent = `${g.rows.length}`;
        const acts = L.DomUtil.create("span", "wm-group-acts", gh);
        const allB = L.DomUtil.create("a", "wm-all", acts); allB.textContent = "all";
        const noneB = L.DomUtil.create("a", "wm-none", acts); noneB.textContent = "none";
        const rowsBox = L.DomUtil.create("div", "wm-group-rows", gEl);
        L.DomEvent.on(gh, "click", (e) => {
          if (e.target === allB || e.target === noneB) return; // those have their own action
          L.DomUtil.toggleClass(gEl, "collapsed");
        });
        const groupRows = [];
        for (const r of g.rows) {
          const lab = L.DomUtil.create("label", "wm-row", rowsBox);
          const cb = L.DomUtil.create("input", "", lab); cb.type = "checkbox"; cb.checked = !!r.on;
          const main = L.DomUtil.create("span", "wm-row-main", lab); main.innerHTML = r.html;
          if (r.count != null) { const n = L.DomUtil.create("span", "wm-row-n", lab); n.textContent = `${r.count}`; }
          L.DomEvent.on(cb, "change", () => r.toggle(cb.checked));
          const rec = { el: lab, label: (r.label || "").toLowerCase(), cb, toggle: r.toggle };
          allRows.push(rec); groupRows.push(rec);
        }
        const setAll = (on) => { for (const rr of groupRows) {
          if (rr.el.style.display === "none" || rr.cb.checked === on) continue; // skip filtered/no-op
          rr.cb.checked = on; rr.toggle(on);
        } };
        L.DomEvent.on(allB, "click", (e) => { L.DomEvent.stop(e); setAll(true); });
        L.DomEvent.on(noneB, "click", (e) => { L.DomEvent.stop(e); setAll(false); });
      }

      // global search: hide rows whose label lacks the term, hide emptied groups, and
      // force-expand groups (via `.searching`) so matches in collapsed groups show.
      const groupEls = [...body.querySelectorAll(".wm-group")];
      L.DomEvent.on(search, "input", () => {
        const q = search.value.trim().toLowerCase();
        L.DomUtil[q ? "addClass" : "removeClass"](body, "searching");
        for (const r of allRows) r.el.style.display = (!q || r.label.includes(q)) ? "" : "none";
        for (const gEl of groupEls) {
          const any = [...gEl.querySelectorAll(".wm-row")].some((e) => e.style.display !== "none");
          gEl.style.display = any ? "" : "none";
        }
      });

      L.DomEvent.on(hideBtn, "click", () => L.DomUtil.addClass(root, "wm-collapsed"));
      L.DomEvent.on(showBtn, "click", () => L.DomUtil.removeClass(root, "wm-collapsed"));
      L.DomEvent.disableClickPropagation(root);
      L.DomEvent.disableScrollPropagation(root);
      return root;
    },
  });
  return new Ctl();
}

// ---- shared HTML-marker kit + generic categorized overlay (used by BOTH maps) ----
// The reusable foundation for plotting an arbitrary set of categorized entity points
// (quest giver/turn-in/kill/collect, future guides, etc.) as toggleable layers.
const npcColor = (entry) => `hsl(${((entry || 0) * 47) % 360} 70% 55%)`;
// Marker primitives, parameterised by `navigate` (the only map-specific dep). Reused
// by initZoneMap's focus/boss layers and by buildMarkerLayer on both maps.
function makeMarkerKit(navigate) {
  const div = (html, size, cls = "poi-div") => L.divIcon({ html, className: cls, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  // item/POI icon marker (gather node, object); `icon` is a CDN/atlas basename.
  const iconMark = (ll, icon, label) => L.marker(ll, { icon: div(iconMarker(icon, "map-poi"), 22), bubblingMouseEvents: false }).bindTooltip(label, { direction: "top" });
  // a POI-atlas sprite marker (giver/turn-in/objective cells) keyed by category.
  const poiMark = (ll, poiKey, label) => L.marker(ll, { icon: div(`<span class="map-poi" style="${poiSpriteStyle(catGrid(poiKey), 22)}"></span>`, 22), bubblingMouseEvents: false }).bindTooltip(label, { direction: "top" });
  // coloured creature pin (click -> npc page); `color` overrides the per-entry hue.
  const npcMark = (ll, label, entry, color) => {
    const m = L.marker(ll, { icon: div(`<span class="map-pin" style="background:${color || npcColor(entry)}"></span>`, 16), bubblingMouseEvents: false }).bindTooltip(label, { direction: "top" });
    if (entry) m.on("click", () => navigate(`?npc=${entry}`));
    return m;
  };
  // boss skull, drawn above everything (click -> npc page).
  const bossMark = (ll, name, entry) => {
    const m = L.marker(ll, { icon: div(`<span class="map-boss" style="${poiSpriteStyle(BOSS_GRID, 26)}"></span>`, 26), bubblingMouseEvents: false }).bindTooltip(esc(name), { direction: "top" });
    m.options.zIndexOffset = 1000;
    if (entry) m.on("click", () => navigate(`?npc=${entry}`));
    return m;
  };
  return { iconMark, poiMark, npcMark, bossMark };
}
// Turn one marker-layer spec into an L.layerGroup + its lat/lng bounds. Per-point
// style: kind 'o' (object) -> icon/POI marker + click ?object=; else creature pin.
// `ctx` = { toLatLng, openMarkerMenu?, kit, navigate } (per-map projection + menu).
// spec: { key, label, kind?, color?, icon?, poi?, on?, points:[{x,y,entry,name,kind}] }.
function buildMarkerLayer(spec, ctx) {
  const { toLatLng, openMarkerMenu, kit, navigate } = ctx;
  const grp = L.layerGroup(); const lls = [];
  for (const p of spec.points) {
    const ll = toLatLng(p.x, p.y); lls.push(ll);
    const label = p.name || spec.label;
    let mk;
    if (p.kind === "o") {
      mk = spec.icon ? kit.iconMark(ll, spec.icon, label) : kit.poiMark(ll, spec.poi || "Quest Giver", label);
      if (p.entry) mk.on("click", () => navigate(`?object=${p.entry}`));
    } else {
      mk = kit.npcMark(ll, label, p.entry, spec.color);
    }
    if (openMarkerMenu) mk.on("contextmenu", (e) => openMarkerMenu(e.originalEvent, p, spec.points, label));
    mk.addTo(grp);
  }
  return { grp, bounds: lls.length ? L.latLngBounds(lls) : null };
}
// Layer-panel legend HTML for a marker-layer row (icon/POI sprite or a coloured dot).
function layerLegendHtml(spec) {
  if (spec.icon) return catLabel(spec.label, esc(spec.label), spec.icon);
  if (spec.poi) return catLabel(spec.poi, esc(spec.label));
  return `<span class="wm-legdot" style="background:${spec.color || "#888"}"></span>${esc(spec.label)}`;
}

// zone: row from Q_ZONE (+ imgUrl). spawns/objects: Q_ZONE_SPAWNS / Q_ZONE_OBJECTS rows.
// opts (all optional):
//   focus { label, icon, points:[{x,y}], npc? } -> a single highlighted layer + zoom-to
//     (one NPC's spawns / a gather node). With focus.npc set, points are creature pins.
//   bosses [{entry,name,x,y}] -> an always-on "Bosses" skull layer (instance bosses).
//   farm   -> value-weighted points for the opt-in "Gold route" overlay.
//   markerLayers [spec,...] -> N categorized toggleable highlight layers (see buildMarkerLayer).
//   route { points, start?, end?, color?, label? } -> an opt-in open-path circuit overlay.
export function initZoneMap(el, zone, spawns, objects, navigate, opts = {}) {
  const { focus = null, bosses = [], farm = null, markerLayers = null, route = null } = opts;
  // destroy the previous overlay first -> frees its WebGL context (browsers cap
  // these, so leaking one per zone navigation would eventually break the map).
  if (currentOverlay) { try { currentOverlay.destroy(); } catch (_) { /* gone */ } currentOverlay = null; }
  if (currentMap) { currentMap.remove(); currentMap = null; }

  const W = zone.img_w, H = zone.img_h;
  const map = L.map(el, {
    crs: L.CRS.Simple, maxZoom: 3, preferCanvas: true,
    attributionControl: false, zoomControl: true,
  });
  currentMap = map;
  const bounds = [[0, 0], [H, W]];
  // parchment in tilePane (below overlayPane) so the Pixi markers draw on top
  L.imageOverlay(zone.imgUrl, bounds, { pane: "tilePane" }).addTo(map);
  map.fitBounds(bounds);
  // don't let the zone shrink into a sea of grey: floor zoom at the whole-zone
  // fit, and keep panning within the image.
  const fitZoom = map.getBoundsZoom(bounds);
  map.setMinZoom(fitZoom);
  map.setMaxBounds(L.latLngBounds(bounds).pad(0.2));

  const dx = zone.loctop - zone.locbottom, dy = zone.locleft - zone.locright;
  const toLatLng = (x, y) => L.latLng(
    dx ? (H * (x - zone.locbottom)) / dx : 0,
    dy ? (W * (zone.locleft - y)) / dy : 0,
  );

  // world (x,y) -> the in-game zone map coordinate WoW shows as "X, Y" (0-100).
  const toMapCoord = (x, y) => [
    dy ? (100 * (zone.locleft - y)) / dy : 0,   // X (horizontal)
    dx ? (100 * (zone.loctop - x)) / dx : 0,    // Y (vertical)
  ];
  const fmtCoord = (p) => { const [cx, cy] = toMapCoord(p.x, p.y); return `${cx.toFixed(1)} ${cy.toFixed(1)}`; };
  const fmtWay = (p, label) => {
    const [cx, cy] = toMapCoord(p.x, p.y);
    return `/way ${zone.name || ""} ${cx.toFixed(1)} ${cy.toFixed(1)}${label ? " " + label : ""}`.replace(/\s+/g, " ").trim();
  };
  const copyText = (t) => { try { return navigator.clipboard.writeText(t); } catch (_) { return Promise.resolve(); } };
  // Open the copy menu at the cursor for a marker: `point` is its world coord,
  // `all` every world coord of the same entry (>1 -> a "Copy All" section).
  function openMarkerMenu(domEv, point, all, label) {
    if (!domEv) return;
    domEv.preventDefault();
    const m = ctxMenuEl();
    m.innerHTML = "";
    const section = (title, rows) => {
      const h = L.DomUtil.create("div", "map-ctx-h", m);
      h.textContent = title;
      for (const [t, fn] of rows) {
        const b = L.DomUtil.create("button", "map-ctx-i", m);
        b.type = "button"; b.textContent = t;
        b.addEventListener("click", () => { fn(); m.style.display = "none"; });
      }
    };
    section("Copy", [
      ["Coordinates", () => copyText(fmtCoord(point))],
      ["TomTom Command", () => copyText(fmtWay(point, label))],
    ]);
    if (all && all.length > 1) section("Copy All", [
      ["Coordinates", () => copyText(all.map(fmtCoord).join("\n"))],
      ["TomTom Command", () => copyText(all.map((p) => fmtWay(p, label)).join("\n"))],
    ]);
    m.style.display = "block";
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(6, Math.min(domEv.clientX, window.innerWidth - r.width - 6))}px`;
    m.style.top = `${Math.max(6, Math.min(domEv.clientY, window.innerHeight - r.height - 6))}px`;
  }

  // ---- Pixi overlay: category dots (high volume) ----
  const container = new PIXI.Container();
  const cats = new Map(); // key -> { label, sprites:[] }
  const cat = (key, label) => {
    let g = cats.get(key);
    if (!g) { g = { label, sprites: [] }; cats.set(key, g); }
    return g;
  };
  // each category sprite is its atlas icon (no tint) -- real POI icons, not blobs.
  const addDot = (key, label, ll, html, href, wpt) => {
    const sp = new PIXI.Sprite(poiTexture(key));
    sp.anchor.set(0.5);
    sp.ll = ll; sp.label = html; sp.href = href; sp.wpt = wpt; sp.visible = false;
    container.addChild(sp);
    cat(key, label).sprites.push(sp);
  };

  // npcByEntry/objByEntry power the per-row "show on map" toggles; built always
  // (cheap). In focus mode the category dots are off by default, so don't build
  // the ~12k hidden sprites -- just the lat/lng index.
  const npcByEntry = new Map();
  for (const s of spawns) {
    const ll = toLatLng(s.x, s.y);
    let e = npcByEntry.get(s.entry);
    if (!e) { e = { name: s.name || `NPC #${s.entry}`, lls: [], pts: [] }; npcByEntry.set(s.entry, e); }
    e.lls.push(ll); e.pts.push({ x: s.x, y: s.y });
    if (!focus) {
      const html = `${esc(s.name) || "?"} <span class="dim">(${lvl(s)})</span>`;
      const wpt = { x: s.x, y: s.y };
      for (const role of npcRolesFor(s)) {
        const def = NPC_CATS.find((c) => c[0] === role);
        addDot(role, def ? def[1] : role, ll, html, `?npc=${s.entry}`, wpt);
      }
      // rares get an extra dot in their own cross-cutting category (rank 2/4)
      if (s.rank === 2 || s.rank === 4) {
        const rk = s.rank === 4 ? "Rare Elite" : "Rare";
        addDot("rare", "Rare / Rare Elite", ll,
          `${esc(s.name) || "?"} <span class="dim">(${lvl(s)}) · ${rk}</span>`, `?npc=${s.entry}`, wpt);
      }
    }
  }
  const objByEntry = new Map();
  for (const o of objects) {
    const ll = toLatLng(o.x, o.y);
    if (!focus) addDot(objLabelCoarse(o), objLabelCoarse(o), ll, esc(o.name) || `Object #${o.entry}`, `?object=${o.entry}`, { x: o.x, y: o.y });
    let e = objByEntry.get(o.entry);
    if (!e) { e = { name: o.name || `Object #${o.entry}`, lls: [], pts: [] }; objByEntry.set(o.entry, e); }
    e.lls.push(ll); e.pts.push({ x: o.x, y: o.y });
  }

  const ICON_PX = 20; // on-screen icon diameter, constant across zoom
  const overlay = L.pixiOverlay((utils) => {
    // the overlay scales the whole container by utils.getScale(zoom); counter it
    // so icons stay a fixed screen size instead of growing as you zoom in.
    const dotScale = (ICON_PX / POI_CELL) / utils.getScale(utils.getMap().getZoom());
    for (const sp of container.children) {
      if (!sp.visible) continue;
      const p = utils.latLngToLayerPoint(sp.ll);
      sp.x = p.x; sp.y = p.y;
      sp.scale.set(dotScale);
    }
    utils.getRenderer().render(container);
  }, container, { autoPreventDefault: false });
  overlay.addTo(map);
  currentOverlay = overlay;

  const redraw = () => overlay.redraw();
  whenPoiReady(redraw); // re-render once the atlas texture finishes loading
  const DotLayer = L.Layer.extend({
    initialize(sprites) { this._s = sprites; },
    onAdd() { for (const s of this._s) s.visible = true; redraw(); },
    onRemove() { for (const s of this._s) s.visible = false; redraw(); },
  });

  // HTML-marker kit (shared with the world map). bubblingMouseEvents:false keeps a
  // marker's click/contextmenu off the map-level dot hit-test.
  const kit = makeMarkerKit(navigate);
  const { iconMark, npcMark, bossMark } = kit;

  // ---- boss layer (always on): skull markers for bosses / world bosses ----
  let bossLayer = null;
  if (bosses && bosses.length) {
    bossLayer = L.layerGroup();
    for (const b of bosses) {
      const m = bossMark(toLatLng(b.x, b.y), b.name, b.entry);
      m.on("contextmenu", (e) => openMarkerMenu(e.originalEvent, b, [b], b.name));
      m.addTo(bossLayer);
    }
  }

  // focus layer: the gathered node's own icon, bright, zoomed-to.
  let focusBounds = null, focusLayer = null;
  const FKEY = focus ? `★ ${focus.label}` : null;
  if (focus && focus.points.length) {
    const lls = [];
    focusLayer = L.layerGroup();
    for (const p of focus.points) {
      const ll = toLatLng(p.x, p.y);
      lls.push(ll);
      const mark = focus.npc ? npcMark(ll, focus.label, focus.npc) : iconMark(ll, focus.icon, focus.label);
      mark.on("contextmenu", (e) => openMarkerMenu(e.originalEvent, p, focus.points, focus.label));
      mark.addTo(focusLayer);
    }
    focusBounds = L.latLngBounds(lls);
  }

  // Farming route: cluster the points into stops, order them nearest-neighbor into a
  // circuit, and draw a numbered dashed loop -- the path to walk while farming (the
  // gathering/grinding TSP, approximated greedily). Used for a per-target focus
  // (every cluster, equal weight) and the zone gold route (value-weighted, top stops).
  // routeOpts: { closed=true } closes the loop (farming circuit); closed:false draws an
  // OPEN path and pins the first stop to the cluster nearest `start` (latLng) and the
  // last to the one nearest `end` -- e.g. a quest's giver -> objectives -> turn-in walk.
  const routeFrom = (pts, topK, color, tip, routeOpts = {}) => {
    if (!pts || pts.length < 3) return null;
    const R = Math.max(H, W) * 0.08; // merge points within ~8% of the map into one stop
    const clusters = [];
    for (const p of pts) {
      const ll = toLatLng(p.x, p.y), w = p.value || 1;
      let best = null, bd = R;
      for (const c of clusters) { const d = map.distance(c.center, ll); if (d < bd) { bd = d; best = c; } }
      if (best) {
        best.n++; best.w += w;
        best.center = L.latLng(best.center.lat + (ll.lat - best.center.lat) / best.n, best.center.lng + (ll.lng - best.center.lng) / best.n);
      } else clusters.push({ center: ll, n: 1, w });
    }
    let pick = clusters;
    if (topK && clusters.length > topK) pick = clusters.slice().sort((a, b) => b.w - a.w).slice(0, topK);
    if (pick.length < 2) return null;
    const { closed = true, start, end } = routeOpts;
    const nearest = (ll, arr) => arr.reduce((b, c) => (map.distance(c.center, ll) < map.distance(b.center, ll) ? c : b), arr[0]);
    const greedy = (seed, pool) => { const ord = [seed]; const rem = pool.slice();
      while (rem.length) { const last = ord[ord.length - 1].center; let bi = 0, bd = Infinity;
        for (let i = 0; i < rem.length; i++) { const d = map.distance(last, rem[i].center); if (d < bd) { bd = d; bi = i; } }
        ord.push(rem.splice(bi, 1)[0]); } return ord; };
    let ordered;
    if (!closed && start) {
      const s = nearest(start, pick);
      const e = end ? nearest(end, pick.filter((c) => c !== s)) : null;
      const mid = pick.filter((c) => c !== s && c !== e);
      ordered = greedy(s, mid); if (e) ordered.push(e);
    } else {
      const rest = pick.slice().sort((a, b) => b.w - a.w); // start at the richest/densest stop
      ordered = greedy(rest.shift(), rest);
    }
    const layer = L.layerGroup();
    const line = ordered.map((c) => c.center); if (closed) line.push(line[0]);
    L.polyline(line, { color, weight: 3, opacity: 0.85, dashArray: "7 7" }).addTo(layer);
    ordered.forEach((c, i) => {
      L.marker(c.center, { icon: L.divIcon({ html: `<span class="route-stop">${i + 1}</span>`, className: "route-div", iconSize: [22, 22], iconAnchor: [11, 11] }) })
        .bindTooltip(`Stop ${i + 1} · ${tip(c)}`, { direction: "top" }).addTo(layer);
    });
    return layer;
  };
  const routeLayer = focus ? routeFrom(focus.points, null, "#ffd100", (c) => `${c.n} spot${c.n === 1 ? "" : "s"}`) : null;
  // zone gold route: value-weighted, keep the ~12 most valuable stops.
  const goldG = (c) => (c.w >= 10000 ? `~${(c.w / 10000).toFixed(1)}g` : c.w >= 100 ? `~${Math.round(c.w / 100)}s` : `~${Math.round(c.w)}c`);
  const goldLayer = routeFrom(farm, 12, "#39d353", goldG);

  // ---- docked layer panel: a "Highlights" group (boss + focus/route specials, on
  // by default) then the dot categories (NPCs, Objects), all OFF -- a clean zone you
  // opt into. Each row toggles its layer's add/remove on the map (sprite visibility
  // flips via DotLayer.onAdd/onRemove). Replaces Leaflet's stock layer control. ----
  const toggleLayer = (layer) => (on) => { if (on) layer.addTo(map); else map.removeLayer(layer); };
  const highlights = [];
  if (bossLayer) {
    bossLayer.addTo(map);
    highlights.push({
      label: "Bosses", count: bosses.length,
      html: `<span class="cat-ico" style="${poiSpriteStyle(BOSS_GRID, 16)};display:inline-block;vertical-align:-4px;margin-right:5px"></span>Bosses`,
      on: true, toggle: toggleLayer(bossLayer),
    });
  }
  // Farming route is the default "where to farm" view for a gathered target; node
  // icons default off so the path reads cleanly. NPC focus keeps its pins on instead.
  const routeDefault = routeLayer && !focus.npc;
  if (focusLayer) { if (!routeDefault) focusLayer.addTo(map);
    highlights.push({ label: focus.label, html: `★ ${esc(focus.label)}`, on: !routeDefault, toggle: toggleLayer(focusLayer) }); }
  if (routeLayer) { if (routeDefault) routeLayer.addTo(map);
    highlights.push({ label: "Farming route", html: "🧭 Farming route", on: routeDefault, toggle: toggleLayer(routeLayer) }); }
  if (goldLayer) highlights.push({ label: "Gold route", html: "💰 Gold route", on: false, toggle: toggleLayer(goldLayer) });

  // generic categorized highlight layers (quest giver/turn-in/kill/collect, etc.) +
  // an opt-in open-path route -- the reusable foundation, plotted as Highlights rows.
  let markerBounds = null;
  if (markerLayers) {
    const ctx = { toLatLng, openMarkerMenu, kit, navigate };
    for (const spec of markerLayers) {
      if (!spec.points || !spec.points.length) continue;
      const { grp, bounds } = buildMarkerLayer(spec, ctx);
      if (bounds) markerBounds = markerBounds ? markerBounds.extend(bounds) : bounds;
      const on = spec.on !== false;
      if (on) grp.addTo(map);
      highlights.push({ label: spec.label, count: spec.points.length, html: layerLegendHtml(spec), on, toggle: toggleLayer(grp) });
    }
    if (route && route.points && route.points.length >= 3) {
      const rl = routeFrom(route.points, null, route.color || "#7cc4ff", (c) => `${c.n} stop${c.n === 1 ? "" : "s"}`,
        { closed: false, start: route.start && toLatLng(route.start.x, route.start.y), end: route.end && toLatLng(route.end.x, route.end.y) });
      if (rl) highlights.push({ label: route.label || "Route", html: `🧭 ${esc(route.label || "Route")}`, on: false, toggle: toggleLayer(rl) });
    }
  }

  const catRow = (key) => {
    const g = cats.get(key);
    if (!g || !g.sprites.length) return null;
    const layer = new DotLayer(g.sprites);
    return { label: g.label, count: g.sprites.length, html: catLabel(key, esc(g.label.replace(/^Obj: /, ""))), on: false, toggle: toggleLayer(layer) };
  };
  const npcKeys = [...NPC_CATS.map((c) => c[0]), "rare"];
  const objKeys = [...cats.keys()].filter((k) => k.startsWith("Obj: "))
    .sort((a, b) => cats.get(b).sprites.length - cats.get(a).sprites.length);
  const groups = [
    highlights.length ? { title: "Highlights", open: true, rows: highlights } : null,
    { title: "NPCs", open: !highlights.length, rows: npcKeys.map(catRow).filter(Boolean) },
    { title: "Objects", rows: objKeys.map(catRow).filter(Boolean) },
  ].filter(Boolean);
  map.addControl(buildLayerPanel(map, { groups }));
  const fitTo = (focusBounds && focusBounds.isValid() && focusBounds) || (markerBounds && markerBounds.isValid() && markerBounds);
  if (fitTo) {
    // A tight spawn/node cluster would otherwise slam to maxZoom (object pages open
    // zoomed way in, forcing a manual zoom-out). Keep zone context: pad wide and cap
    // the fit a couple levels above the whole-zone fit, for both NPC and node focus.
    const cap = { maxZoom: Math.min(map.getMaxZoom(), fitZoom + 2), padding: [30, 30] };
    map.fitBounds(fitTo.pad(focus && focus.npc ? 0.6 : 0.4), cap);
  }
  setTimeout(() => { map.invalidateSize(); redraw(); }, 0);

  // ---- hover tooltip + click for the Pixi dots (no per-marker DOM) ----
  const tip = L.DomUtil.create("div", "pixi-tip", el);
  tip.style.cssText = "position:absolute;z-index:1000;pointer-events:none;display:none;" +
    "background:#16181f;border:1px solid #2a2e3a;border-radius:6px;padding:3px 7px;" +
    "font-size:12px;color:#e6e8ee;white-space:nowrap;transform:translate(-50%,-140%)";
  const HIT = 9;
  let raf = 0;
  const nearest = (cp) => {
    let best = null, bd = HIT * HIT;
    for (const sp of container.children) {
      if (!sp.visible) continue;
      const p = map.latLngToContainerPoint(sp.ll);
      const d = (p.x - cp.x) ** 2 + (p.y - cp.y) ** 2;
      if (d <= bd) { bd = d; best = sp; }
    }
    return best;
  };
  map.on("mousemove", (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const sp = nearest(e.containerPoint);
      el.style.cursor = sp && sp.href ? "pointer" : "";
      if (!sp) { tip.style.display = "none"; return; }
      tip.innerHTML = sp.label;
      tip.style.left = `${e.containerPoint.x}px`;
      tip.style.top = `${e.containerPoint.y}px`;
      tip.style.display = "block";
    });
  });
  map.on("mouseout", () => { tip.style.display = "none"; });
  map.on("click", (e) => {
    const sp = nearest(e.containerPoint);
    if (sp && sp.href) navigate(sp.href);
  });
  // middle-click -> open the dot's entity in a new tab, leaving the map open
  el.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }); // kill autoscroll glyph
  el.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const sp = nearest(map.mouseEventToContainerPoint(e));
    if (sp && sp.href) { e.preventDefault(); window.open(new URL(sp.href, location.href).href, "_blank", "noopener"); }
  });
  // right-click a category dot -> the same copy menu. "Copy All" pulls every spawn
  // of that entry (resolved from the npc/obj index via the dot's href).
  map.on("contextmenu", (e) => {
    const sp = nearest(e.containerPoint);
    if (!sp || !sp.wpt) return;
    let all = [sp.wpt], label = "";
    const mm = /\?(npc|object)=(\d+)/.exec(sp.href || "");
    if (mm) {
      const ent = (mm[1] === "npc" ? npcByEntry : objByEntry).get(Number(mm[2]));
      if (ent) { label = ent.name; if (ent.pts && ent.pts.length) all = ent.pts; }
    }
    if (!label && sp.label) label = sp.label.replace(/<[^>]*>/g, "").trim();
    openMarkerMenu(e.originalEvent, sp.wpt, all, label);
  });

  // ---- Objects-tab toggle: show/hide one object's icon markers (HTML) ----
  const objLayers = new Map();
  function toggleObject(entry, on, icon) {
    let rec = objLayers.get(entry);
    if (on) {
      if (!rec) {
        const e = objByEntry.get(entry);
        rec = L.layerGroup();
        if (e) for (const ll of e.lls) iconMark(ll, icon, e.name).addTo(rec);
        objLayers.set(entry, rec);
      }
      rec.addTo(map);
    } else if (rec) map.removeLayer(rec);
  }

  // ---- NPCs-tab toggle: show/hide one creature's spawn pins ----
  const npcLayers = new Map();
  function toggleNpc(entry, on) {
    let rec = npcLayers.get(entry);
    if (on) {
      if (!rec) {
        const e = npcByEntry.get(entry);
        rec = L.layerGroup();
        if (e) e.lls.forEach((ll, i) => {
          const m = npcMark(ll, e.name, entry);
          m.on("contextmenu", (ev) => openMarkerMenu(ev.originalEvent, e.pts[i], e.pts, e.name));
          m.addTo(rec);
        });
        npcLayers.set(entry, rec);
      }
      rec.addTo(map);
    } else if (rec) map.removeLayer(rec);
  }

  return { map, toggleObject, toggleNpc };
}

// Flight-path world map: a continent parchment with the taxi nodes (faction-coloured
// markers) + every route as a faint polyline. continent: { imgUrl, w, h, loc* }.
// nodes: [{ x, y, name, faction }]. routes: [{ faction, pts:[{x,y}] }]. Reuses the
// CRS.Simple + WorldMapArea-bounds projection from the zone map.
const FACTION_COLOR = { A: "#5b86ff", H: "#e0524a", N: "#ffce4a" };
export function initFlightMap(el, continent, nodes, routes, navigate) {
  if (currentOverlay) { try { currentOverlay.destroy(); } catch (_) { /* gone */ } currentOverlay = null; }
  if (currentMap) { currentMap.remove(); currentMap = null; }

  const W = continent.w, H = continent.h;
  const map = L.map(el, { crs: L.CRS.Simple, maxZoom: 4, preferCanvas: true, attributionControl: false, zoomControl: true });
  currentMap = map;
  const bounds = [[0, 0], [H, W]];
  L.imageOverlay(continent.imgUrl, bounds, { pane: "tilePane" }).addTo(map);
  map.fitBounds(bounds);
  map.setMinZoom(map.getBoundsZoom(bounds));
  map.setMaxBounds(L.latLngBounds(bounds).pad(0.2));

  const dx = continent.loctop - continent.locbottom, dy = continent.locleft - continent.locright;
  const toLatLng = (x, y) => L.latLng(dx ? (H * (x - continent.locbottom)) / dx : 0, dy ? (W * (continent.locleft - y)) / dy : 0);

  // routes first (under the node markers), faint + faction-coloured
  for (const r of routes) {
    if (r.pts.length < 2) continue;
    L.polyline(r.pts.map((p) => toLatLng(p.x, p.y)), { color: FACTION_COLOR[r.faction] || FACTION_COLOR.N, weight: 1.5, opacity: 0.35 }).addTo(map);
  }
  // nodes: a coloured dot per flight master, click-to-search by name
  for (const n of nodes) {
    L.marker(toLatLng(n.x, n.y), {
      icon: L.divIcon({ html: `<span class="flight-node" style="background:${FACTION_COLOR[n.faction] || FACTION_COLOR.N}"></span>`, className: "flight-div", iconSize: [13, 13], iconAnchor: [6, 6] }),
    }).bindTooltip(esc(n.name), { direction: "top" })
      .on("click", () => navigate(`?search=${encodeURIComponent(n.name.split(",")[0])}`))
      .addTo(map);
  }
  setTimeout(() => map.invalidateSize(), 0);
  return map;
}

// 1x1 transparent webp -> Leaflet draws nothing for the sparse (unexplored) tiles
// instead of a broken-image box.
const BLANK_TILE =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

// fullscreen-toggle glyphs (corner brackets): out = enter, in = exit
const FS_ENTER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const FS_EXIT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';

// Seamless continent minimap (?worldmap=mapid): one Leaflet CRS.Simple slippy map
// over the client's stitched minimap tile PYRAMID (z/x/y webp on R2, built by
// scripts/extract-minimap.py), with every spawn reprojected onto it. Unlike the
// per-zone parchment, the projection is uniform: the ADT grid is regular, so
//   gpx = tile*(grid/2 - worldY/adt)   gpy = tile*(grid/2 - worldX/adt)
// and one CRS unit = native px / 2^maxNativeZoom (= tile/grid). Reuses the Pixi
// dot overlay + category toggles + hover/click from the zone map.
// conf: { mapId, name, bbox:[c0,c1,r0,r1], tile, adt, grid, maxNativeZoom, tilesBase }.
export function initWorldMap(el, conf, spawns, objects, navigate, opts = {}) {
  if (currentOverlay) { try { currentOverlay.destroy(); } catch (_) { /* gone */ } currentOverlay = null; }
  if (currentMap) { currentMap.remove(); currentMap = null; }

  const { tile, adt, grid, maxNativeZoom: NZ, bbox } = conf;
  const div = Math.pow(2, NZ);          // 1 CRS unit = native px / div
  const upt = tile / div;               // CRS units per ADT tile
  const [c0, c1, r0, r1] = bbox;
  // y-down identity transform -> standard XYZ tile addressing (x=col, y=row).
  const crs = L.extend({}, L.CRS.Simple, { transformation: new L.Transformation(1, 0, 1, 0) });
  const map = L.map(el, {
    crs, preferCanvas: true, attributionControl: false, zoomControl: false,
    maxZoom: NZ + 2, zoomSnap: 0.5, wheelPxPerZoomLevel: 120,
  });
  currentMap = map;
  // Fill the area beyond the continent (and the unexplored, transparent tiles)
  // with the in-game ocean colour instead of the default black.
  map.getContainer().style.background = "#061d28";

  // world (x,y) -> latLng (lat=row axis/down, lng=col axis/right)
  const toLatLng = (x, y) => L.latLng(
    (tile * (grid / 2 - x / adt)) / div,
    (tile * (grid / 2 - y / adt)) / div,
  );
  const occupied = L.latLngBounds([[r0 * upt, c0 * upt], [(r1 + 1) * upt, (c1 + 1) * upt]]);

  L.tileLayer(`${conf.tilesBase}${conf.mapId}/{z}/{x}/{y}.webp`, {
    tileSize: tile, minZoom: 0, maxNativeZoom: NZ, bounds: occupied,
    noWrap: true, errorTileUrl: BLANK_TILE, keepBuffer: 4, pane: "tilePane",
  }).addTo(map);

  map.fitBounds(occupied);
  map.setMinZoom(map.getBoundsZoom(occupied));
  map.setMaxBounds(occupied.pad(0.1));

  // ---- Pixi overlay: category dots (reused machinery from the zone map) ----
  const { zones = [], initial = {}, onState, searchNpcs, markerLayers = null, route = null } = opts;
  const container = new PIXI.Container();
  const cats = new Map();
  const cat = (key, label) => {
    let g = cats.get(key);
    if (!g) { g = { label, code: catCode(key), sprites: [] }; cats.set(key, g); }
    return g;
  };
  // each sprite is its category's POI icon, or (gather nodes) the yielded item's
  // CDN icon. Carry the bits zone-focus + the name filter need (zone/name/entry/
  // isNpc), otherwise discarded at sprite creation. `icon` = CDN basename or null.
  const addDot = (key, label, ll, html, href, meta, icon) => {
    const sp = new PIXI.Sprite(poiTexture(key)); // generic cell; upgraded by requestIcon
    sp.anchor.set(0.5);
    sp.basePx = POI_CELL; // POI cells are 32px; bumped to the icon's size on upgrade
    sp.ll = ll; sp.label = html; sp.href = href; sp.visible = false;
    sp.catCode = catCode(key); sp.zone = meta.zone; sp.name = meta.name; sp.entry = meta.entry; sp.isNpc = !!meta.isNpc;
    container.addChild(sp);
    if (icon) requestIcon(icon, sp);
    const g = cat(key, label);
    g.sprites.push(sp);
    if (icon && !g.icon) g.icon = icon; // legend icon for this category
  };

  for (const s of spawns) {
    const ll = toLatLng(s.x, s.y);
    const html = `${esc(s.name) || "?"} <span class="dim">(${lvl(s)})</span>`;
    const meta = { zone: s.zone, name: s.name || "", entry: s.entry, isNpc: true };
    for (const role of npcRolesFor(s)) {
      const def = NPC_CATS.find((c) => c[0] === role);
      addDot(role, def ? def[1] : role, ll, html, `?npc=${s.entry}`, meta);
    }
    if (s.rank === 2 || s.rank === 4) {
      const rk = s.rank === 4 ? "Rare Elite" : "Rare";
      addDot("rare", "Rare / Rare Elite", ll,
        `${esc(s.name) || "?"} <span class="dim">(${lvl(s)}) · ${rk}</span>`, `?npc=${s.entry}`, meta);
    }
  }
  for (const o of objects) {
    const key = objLabel(o);
    addDot(key, key, toLatLng(o.x, o.y), esc(o.name) || `Object #${o.entry}`,
      `?object=${o.entry}`, { zone: o.zone, name: o.name || "", entry: o.entry, isNpc: false }, cdnIconOf(o));
  }

  // ---- visibility = enabled layer AND zone focus AND npc name filter (one source) ----
  // The name filter is FTS-backed: `matchedNpcs` is the Set of creature entries the
  // DB matched (or null = inactive); it only narrows npc sprites, not objects.
  let focusZone = initial.focus != null ? initial.focus : null;
  let nameFilter = (initial.q || "").trim();
  let matchedNpcs = null;
  const enabledCats = new Set(initial.cats || []);
  const matchesName = (sp) => !sp.isNpc || matchedNpcs == null || matchedNpcs.has(sp.entry);
  const applyVisibility = () => {
    for (const sp of container.children)
      sp.visible = enabledCats.has(sp.catCode)
        && (focusZone == null || sp.zone === focusZone)
        && matchesName(sp);
    redraw();
  };

  // ---- URL state persistence (debounced replaceState; reuses browse.js shape) ----
  // `ready` gates out the writes from the initial restore (layer adds + setView)
  // so a passive load/Back doesn't clobber the URL before the user interacts.
  const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
  let ready = false;
  const writeState = () => {
    if (!ready || !onState) return;
    const c = map.getCenter();
    onState({
      cats: [...enabledCats],
      z: Math.round(map.getZoom() * 2) / 2,
      c: [Math.round(c.lat * 100) / 100, Math.round(c.lng * 100) / 100],
      focus: focusZone, q: nameFilter,
    });
  };
  const writeStateD = debounce(writeState, 200);

  // FTS-backed npc name filter: a pure number is an instant entry-id match; text
  // goes to the DB full-text index (prefix + trigram/infix) via the injected
  // searchNpcs, narrowing only npc sprites. Empty -> filter off.
  const setNameFilter = async (term) => {
    nameFilter = (term || "").trim();
    if (!nameFilter) matchedNpcs = null;
    else if (/^\d+$/.test(nameFilter)) matchedNpcs = new Set([Number(nameFilter)]);
    else matchedNpcs = (searchNpcs ? await searchNpcs(nameFilter) : null) || new Set();
    applyVisibility();
  };

  // Dot diameter scales with zoom: small at the continent overview (less clutter)
  // -> large when zoomed into a zone (prominent, dungeon-like). Still zoom-crisp.
  const MIN_PX = 14, MAX_PX = 30;
  const overlay = L.pixiOverlay((utils) => {
    const z = utils.getMap().getZoom();
    const lo = map.getMinZoom(), hi = NZ + 2;
    const t = hi > lo ? Math.min(1, Math.max(0, (z - lo) / (hi - lo))) : 1;
    const target = (MIN_PX + t * (MAX_PX - MIN_PX)) / utils.getScale(z);
    for (const sp of container.children) {
      if (!sp.visible) continue;
      const p = utils.latLngToLayerPoint(sp.ll);
      sp.x = p.x; sp.y = p.y; sp.scale.set(target / sp.basePx); // basePx: 56 icon / 32 POI
    }
    utils.getRenderer().render(container);
  }, container, { autoPreventDefault: false });
  overlay.addTo(map);
  currentOverlay = overlay;

  const redraw = () => overlay.redraw();
  whenPoiReady(redraw); // re-render once the atlas texture finishes loading

  // smallest WMA box per zone, for the focus-zone fit (used by the panel header).
  const focusBounds = (areaid) => {
    const lls = [];
    for (const sp of container.children) if (sp.zone === areaid) lls.push(sp.ll);
    return lls.length ? L.latLngBounds(lls) : null;
  };

  // ---- docked layer panel (top-right): grouped + searchable category toggles ----
  // Categories default OFF (a clean continent you opt into), except those restored
  // from the URL `cats=`; applyVisibility() below paints that initial state. Each
  // row's toggle mutates `enabledCats` directly (no DotLayer) then re-paints + persists.
  const keysWith = (pfx, cmp) => [...cats.keys()].filter((k) => k.startsWith(pfx)).sort(cmp);
  const byName = (a, b) => a.localeCompare(b);
  const byCount = (a, b) => cats.get(b).sprites.length - cats.get(a).sprites.length;
  const PFX = /^(Mining: |Herb: |Obj: )/;
  const rowFor = (key) => {
    const g = cats.get(key);
    if (!g || !g.sprites.length) return null;
    const disp = g.label.replace(PFX, ""); // group name already carries the prefix
    return {
      label: g.label, count: g.sprites.length, html: catLabel(key, esc(disp), g.icon),
      on: enabledCats.has(g.code),
      toggle: (on) => {
        if (on) enabledCats.add(g.code); else enabledCats.delete(g.code);
        applyVisibility(); writeState();
      },
    };
  };
  const groupRows = (keys) => keys.map(rowFor).filter(Boolean);
  const npcKeys = [...NPC_CATS.map((c) => c[0]), "rare"];

  // generic categorized highlight layers (quest giver/turn-in/kill/collect, etc.) over
  // the continent -- HTML markers, not Pixi dots. Same `markerLayers` contract as the
  // zone map; no copy menu here (the continent map has no per-zone /way coords).
  const toggleLayerW = (layer) => (on) => { if (on) layer.addTo(map); else map.removeLayer(layer); };
  const highlights = [];
  let markerBounds = null;
  if (markerLayers) {
    const ctx = { toLatLng, kit: makeMarkerKit(navigate), navigate };
    for (const spec of markerLayers) {
      if (!spec.points || !spec.points.length) continue;
      const { grp, bounds } = buildMarkerLayer(spec, ctx);
      if (bounds) markerBounds = markerBounds ? markerBounds.extend(bounds) : bounds;
      const on = spec.on !== false;
      if (on) grp.addTo(map);
      highlights.push({ label: spec.label, count: spec.points.length, html: layerLegendHtml(spec), on, toggle: toggleLayerW(grp) });
    }
    if (route && route.points && route.points.length >= 3) {
      const stops = route.points.map((p) => ({ ...p }));
      const R2 = (Math.max(Math.abs(occupied.getNorth() - occupied.getSouth()), Math.abs(occupied.getEast() - occupied.getWest()))) * 0.04;
      const clusters = [];
      for (const p of stops) { const ll = toLatLng(p.x, p.y); let best = null, bd = R2;
        for (const c of clusters) { const d = map.distance(c.center, ll); if (d < bd) { bd = d; best = c; } }
        if (best) { best.n++; best.center = L.latLng((best.center.lat + ll.lat) / 2, (best.center.lng + ll.lng) / 2); } else clusters.push({ center: ll, n: 1 }); }
      if (clusters.length >= 2) {
        const start = route.start && toLatLng(route.start.x, route.start.y);
        const near = (ll, arr) => arr.reduce((b, c) => (map.distance(c.center, ll) < map.distance(b.center, ll) ? c : b), arr[0]);
        const end = route.end && toLatLng(route.end.x, route.end.y);
        const s = start ? near(start, clusters) : clusters[0];
        const e = end ? near(end, clusters.filter((c) => c !== s)) : null;
        const rem = clusters.filter((c) => c !== s && c !== e);
        const ord = [s];
        while (rem.length) { const last = ord[ord.length - 1].center; let bi = 0, bd = Infinity;
          for (let i = 0; i < rem.length; i++) { const d = map.distance(last, rem[i].center); if (d < bd) { bd = d; bi = i; } } ord.push(rem.splice(bi, 1)[0]); }
        if (e) ord.push(e);
        const rl = L.layerGroup();
        L.polyline(ord.map((c) => c.center), { color: route.color || "#7cc4ff", weight: 3, opacity: 0.85, dashArray: "7 7" }).addTo(rl);
        ord.forEach((c, i) => L.marker(c.center, { icon: L.divIcon({ html: `<span class="route-stop">${i + 1}</span>`, className: "route-div", iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(rl));
        highlights.push({ label: route.label || "Route", html: `🧭 ${esc(route.label || "Route")}`, on: false, toggle: toggleLayerW(rl) });
      }
    }
  }

  const groups = [
    highlights.length ? { title: "Highlights", open: true, rows: highlights } : null,
    { title: "NPCs", open: !highlights.length, rows: groupRows(npcKeys) },
    { title: "Herbs", rows: groupRows(keysWith("Herb: ", byName)) },
    { title: "Mining Veins", rows: groupRows(keysWith("Mining: ", byName)) },
    { title: "Objects", rows: groupRows(keysWith("Obj: ", byCount)) },
  ].filter(Boolean);
  applyVisibility(); // paint the URL-restored categories before the user touches anything

  // panel header: the zone-focus select + npc name/id FTS filter (folded in here).
  const header = L.DomUtil.create("div", "wm-filter");
  const optHtml = ['<option value="">All zones</option>'].concat(zones.map((z) =>
    `<option value="${z.areaid}"${z.areaid === focusZone ? " selected" : ""}>${esc(z.name)}</option>`)).join("");
  header.innerHTML = `<select class="wm-zone" title="Focus a zone">${optHtml}</select>` +
    `<input class="wm-name" type="text" placeholder="npc name / id" value="${esc(nameFilter)}">`;
  const sel = header.querySelector(".wm-zone");
  sel.addEventListener("change", () => {
    focusZone = sel.value ? Number(sel.value) : null;
    applyVisibility();
    const b = focusZone != null && focusBounds(focusZone);
    map.fitBounds(b || occupied, b ? { padding: [40, 40] } : undefined);
    writeState();
  });
  const inp = header.querySelector(".wm-name");
  inp.addEventListener("input", debounce(() => { setNameFilter(inp.value).then(writeState); }, 250));

  map.addControl(buildLayerPanel(map, { groups, header }));
  L.control.zoom({ position: "topleft" }).addTo(map);

  // ---- fullscreen toggle (top-left) -> the map fills the screen, reclaiming the
  // unused page margins. Uses the browser Fullscreen API on the #zonemap element;
  // invalidateSize+redraw on every change so Leaflet/Pixi refit (incl. Esc-exit). ----
  if (el.requestFullscreen) {
    let fsBtn = null;
    const FsCtl = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const div = L.DomUtil.create("div", "leaflet-bar wm-fs");
        fsBtn = L.DomUtil.create("a", "", div);
        fsBtn.href = "#"; fsBtn.title = "Fullscreen"; fsBtn.setAttribute("role", "button");
        fsBtn.innerHTML = FS_ENTER;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.on(fsBtn, "click", (e) => {
          L.DomEvent.preventDefault(e);
          if (document.fullscreenElement) document.exitFullscreen();
          else el.requestFullscreen();
        });
        return div;
      },
    });
    map.addControl(new FsCtl());
    const onFsChange = () => {
      const on = document.fullscreenElement === el;
      if (fsBtn) { fsBtn.innerHTML = on ? FS_EXIT : FS_ENTER; fsBtn.title = on ? "Exit fullscreen" : "Fullscreen"; }
      map.invalidateSize();
      redraw();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    map.on("unload", () => document.removeEventListener("fullscreenchange", onFsChange));
  }

  // restore the saved view (else fit the continent / the focused zone) + npc filter
  if (initial.c && initial.z != null) map.setView(initial.c, initial.z);
  else if (focusZone != null) { const b = focusBounds(focusZone); if (b) map.fitBounds(b, { padding: [40, 40] }); }
  else if (markerBounds && markerBounds.isValid()) map.fitBounds(markerBounds.pad(0.3), { padding: [40, 40] });
  if (nameFilter) setNameFilter(nameFilter);

  // ---- hover tooltip + click for the dots (throttled nearest hit-test) ----
  const tip = L.DomUtil.create("div", "pixi-tip", el);
  tip.style.cssText = "position:absolute;z-index:1000;pointer-events:none;display:none;" +
    "background:#16181f;border:1px solid #2a2e3a;border-radius:6px;padding:3px 7px;" +
    "font-size:12px;color:#e6e8ee;white-space:nowrap;transform:translate(-50%,-140%)";
  const HIT = 8;
  let raf = 0;
  const nearest = (cp) => {
    let best = null, bd = HIT * HIT;
    for (const sp of container.children) {
      if (!sp.visible) continue;
      const p = map.latLngToContainerPoint(sp.ll);
      const d = (p.x - cp.x) ** 2 + (p.y - cp.y) ** 2;
      if (d <= bd) { bd = d; best = sp; }
    }
    return best;
  };
  map.on("mousemove", (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const sp = nearest(e.containerPoint);
      el.style.cursor = sp && sp.href ? "pointer" : "";
      if (!sp) { tip.style.display = "none"; return; }
      tip.innerHTML = sp.label;
      tip.style.left = `${e.containerPoint.x}px`;
      tip.style.top = `${e.containerPoint.y}px`;
      tip.style.display = "block";
    });
  });
  map.on("mouseout", () => { tip.style.display = "none"; });
  map.on("click", (e) => { const sp = nearest(e.containerPoint); if (sp && sp.href) navigate(sp.href); });
  // middle-click -> open the dot's entity in a new tab, leaving the map open
  el.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }); // kill autoscroll glyph
  el.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const sp = nearest(map.mouseEventToContainerPoint(e));
    if (sp && sp.href) { e.preventDefault(); window.open(new URL(sp.href, location.href).href, "_blank", "noopener"); }
  });

  map.on("moveend zoomend", writeStateD); // persist pan/zoom (layer + focus + filter write directly)
  setTimeout(() => { map.invalidateSize(); redraw(); ready = true; }, 0);
  return map;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
