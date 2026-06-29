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
import { iconMarker } from "./render.js";
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
// Gather nodes split out of the generic "Obj: Chest" bucket via gameobjects.gather
// (the Lock.dbc skill); everything else still buckets by GAMEOBJECT_TYPE.
const objLabel = (o) => o.gather === "mining" ? "Obj: Mining"
  : o.gather === "herbalism" ? "Obj: Herbalism" : objTypeLabel(o.type);
// URL-safe code for a category key (NPC roles + "rare" are already safe; object
// buckets "Obj: Chest" -> "o:chest"). Used to persist enabled layers in the URL.
const catCode = (key) => key.startsWith("Obj: ")
  ? "o:" + key.slice(5).toLowerCase().replace(/\s+/g, "-") : key;

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
  if (key && key.startsWith("Obj: ")) return OBJ_ICON[key.slice(5)] || OBJ_GENERIC;
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
function catLabel(key, text) {
  return `<span class="cat-ico" style="${poiSpriteStyle(catGrid(key), 16)};` +
    `display:inline-block;vertical-align:-4px;margin-right:5px"></span>${text}`;
}
// Redraw once the atlas finishes loading (frames render blank until then).
function whenPoiReady(cb) {
  if (poiBase && !poiBase.valid) poiBase.once("loaded", cb);
}

// zone: row from Q_ZONE (+ imgUrl). spawns/objects: Q_ZONE_SPAWNS / Q_ZONE_OBJECTS
// rows. focus (optional): { label, icon, points:[{x,y}], npc? } -> a highlighted
// layer with every other category off + the view zoomed to it (e.g. only herb
// nodes, or one NPC's spawns). With focus.npc set, points draw as creature pins
// (no item icon) coloured by that entry; otherwise as the focus.icon marker.
// bosses (optional): [{entry, name, x, y}] -> an always-on "Bosses" layer of skull
// markers (instance unique-spawns), drawn above the dots.
export function initZoneMap(el, zone, spawns, objects, navigate, focus = null, bosses = [], farm = null) {
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
    if (!focus) addDot(objLabel(o), objLabel(o), ll, esc(o.name) || `Object #${o.entry}`, `?object=${o.entry}`, { x: o.x, y: o.y });
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

  // ---- icon markers (few): a gathered node + toggled objects, as HTML ----
  // bubblingMouseEvents:false on every HTML marker -> its click/contextmenu don't
  // also bubble to the map-level dot hit-test (which would double-open the menu /
  // mis-navigate to a nearby category dot).
  const iconMark = (ll, icon, label) => L.marker(ll, {
    icon: L.divIcon({ html: iconMarker(icon, "map-poi"), className: "poi-div", iconSize: [22, 22], iconAnchor: [11, 11] }),
    bubblingMouseEvents: false,
  }).bindTooltip(label, { direction: "top" });
  // toggled NPC spawns: a bright pin (creatures have no item icon), a distinct
  // colour per creature so multiple toggled NPCs are tellable apart; clicking it
  // opens the NPC page.
  const npcColor = (entry) => `hsl(${(entry * 47) % 360} 70% 55%)`;
  const npcMark = (ll, label, entry) => {
    const m = L.marker(ll, {
      icon: L.divIcon({ html: `<span class="map-pin" style="background:${npcColor(entry)}"></span>`, className: "poi-div", iconSize: [16, 16], iconAnchor: [8, 8] }),
      bubblingMouseEvents: false,
    }).bindTooltip(label, { direction: "top" });
    if (entry) m.on("click", () => navigate(`?npc=${entry}`));
    return m;
  };
  // boss marker: the skull POI sprite, drawn above everything, click -> NPC page.
  const bossMark = (ll, name, entry) => {
    const m = L.marker(ll, {
      icon: L.divIcon({ html: `<span class="map-boss" style="${poiSpriteStyle(BOSS_GRID, 26)}"></span>`, className: "poi-div", iconSize: [26, 26], iconAnchor: [13, 13] }),
      zIndexOffset: 1000, bubblingMouseEvents: false,
    }).bindTooltip(esc(name), { direction: "top" });
    if (entry) m.on("click", () => navigate(`?npc=${entry}`));
    return m;
  };

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
  const routeFrom = (pts, topK, color, tip) => {
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
    const rest = pick.slice().sort((a, b) => b.w - a.w); // start at the richest/densest stop
    const ordered = [rest.shift()];
    while (rest.length) {
      const last = ordered[ordered.length - 1].center;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < rest.length; i++) { const d = map.distance(last, rest[i].center); if (d < bd) { bd = d; bi = i; } }
      ordered.push(rest.splice(bi, 1)[0]);
    }
    const layer = L.layerGroup();
    const line = ordered.map((c) => c.center); line.push(line[0]); // close the loop
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

  // ---- layer control: dot categories + the focus layer ----
  const overlays = {};
  const addCat = (key, on) => {
    const g = cats.get(key);
    if (!g || !g.sprites.length) return;
    const layer = new DotLayer(g.sprites);
    overlays[catLabel(key, `${g.label} (${g.sprites.length})`)] = layer; // icon + text
    if (on) layer.addTo(map);
  };
  // All category layers start OFF (a normal zone view is a clean map you opt into
  // via the layer control); the boss + gather/focus layers are on by default.
  if (bossLayer) {
    const bossLbl = `<span class="cat-ico" style="${poiSpriteStyle(BOSS_GRID, 16)};display:inline-block;vertical-align:-4px;margin-right:5px"></span>Bosses (${bosses.length})`;
    overlays[bossLbl] = bossLayer; bossLayer.addTo(map);
  }
  // Farming route is the default "where to farm" view for a gathered target; the
  // individual node icons then default off (toggleable) so the path reads cleanly.
  // NPC focus keeps its pins on and offers the route as an opt-in toggle.
  const routeDefault = routeLayer && !focus.npc;
  if (focusLayer) { overlays[FKEY] = focusLayer; if (!routeDefault) focusLayer.addTo(map); }
  if (routeLayer) { overlays["🧭 Farming route"] = routeLayer; if (routeDefault) routeLayer.addTo(map); }
  // Zone gold route: opt-in overlay (toggle) of the most valuable farm spots.
  if (goldLayer) overlays["💰 Gold route"] = goldLayer;
  for (const [key] of NPC_CATS) addCat(key, false);
  addCat("rare", false); // single toggle for all rare / rare-elite spawns
  const objKeys = [...cats.keys()].filter((k) => k.startsWith("Obj: "))
    .sort((a, b) => cats.get(b).sprites.length - cats.get(a).sprites.length);
  for (const key of objKeys) addCat(key, false);

  L.control.layers(null, overlays, { collapsed: true }).addTo(map);
  if (focusBounds && focusBounds.isValid()) {
    // A tight spawn/node cluster would otherwise slam to maxZoom (object pages open
    // zoomed way in, forcing a manual zoom-out). Keep zone context: pad wide and cap
    // the fit a couple levels above the whole-zone fit, for both NPC and node focus.
    const cap = { maxZoom: Math.min(map.getMaxZoom(), fitZoom + 2), padding: [30, 30] };
    map.fitBounds(focusBounds.pad(focus.npc ? 0.6 : 0.4), cap);
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
    crs, preferCanvas: true, attributionControl: false, zoomControl: true,
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
  const { zones = [], initial = {}, onState } = opts;
  const container = new PIXI.Container();
  const cats = new Map();
  const cat = (key, label) => {
    let g = cats.get(key);
    if (!g) { g = { label, code: catCode(key), sprites: [] }; cats.set(key, g); }
    return g;
  };
  // each category sprite is its atlas icon (no tint) -- categories read as real
  // POI icons instead of coloured blobs. Carry the bits zone-focus + the name
  // filter need (the source row otherwise gets discarded at sprite creation).
  const addDot = (key, label, ll, html, href, meta) => {
    const sp = new PIXI.Sprite(poiTexture(key));
    sp.anchor.set(0.5);
    sp.ll = ll; sp.label = html; sp.href = href; sp.visible = false;
    sp.catCode = catCode(key); sp.zone = meta.zone; sp.name = meta.name; sp.entry = meta.entry;
    container.addChild(sp);
    cat(key, label).sprites.push(sp);
  };

  for (const s of spawns) {
    const ll = toLatLng(s.x, s.y);
    const html = `${esc(s.name) || "?"} <span class="dim">(${lvl(s)})</span>`;
    const meta = { zone: s.zone, name: s.name || "", entry: s.entry };
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
      `?object=${o.entry}`, { zone: o.zone, name: o.name || "", entry: o.entry });
  }

  // ---- visibility = enabled layer AND zone focus AND name filter (one source) ----
  let focusZone = initial.focus != null ? initial.focus : null;
  let nameFilter = (initial.q || "").toLowerCase();
  const enabledCats = new Set(initial.cats || []);
  const matchesName = (sp) => !nameFilter
    || (sp.name && sp.name.toLowerCase().includes(nameFilter)) || String(sp.entry) === nameFilter;
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

  // Dot diameter scales with zoom: small at the continent overview (less clutter)
  // -> large when zoomed into a zone (prominent, dungeon-like). Still zoom-crisp.
  const MIN_PX = 14, MAX_PX = 30;
  const overlay = L.pixiOverlay((utils) => {
    const z = utils.getMap().getZoom();
    const lo = map.getMinZoom(), hi = NZ + 2;
    const t = hi > lo ? Math.min(1, Math.max(0, (z - lo) / (hi - lo))) : 1;
    const dotScale = ((MIN_PX + t * (MAX_PX - MIN_PX)) / POI_CELL) / utils.getScale(z);
    for (const sp of container.children) {
      if (!sp.visible) continue;
      const p = utils.latLngToLayerPoint(sp.ll);
      sp.x = p.x; sp.y = p.y; sp.scale.set(dotScale);
    }
    utils.getRenderer().render(container);
  }, container, { autoPreventDefault: false });
  overlay.addTo(map);
  currentOverlay = overlay;

  const redraw = () => overlay.redraw();
  whenPoiReady(redraw); // re-render once the atlas texture finishes loading
  const DotLayer = L.Layer.extend({
    initialize(code) { this._code = code; },
    onAdd() { enabledCats.add(this._code); applyVisibility(); writeState(); },
    onRemove() { enabledCats.delete(this._code); applyVisibility(); writeState(); },
  });

  // layer control: every category OFF by default (a clean continent you opt into),
  // except those restored from the URL. Each entry shows its atlas icon (catLabel).
  const overlays = {};
  const layerByCode = new Map();
  const addCat = (key) => {
    const g = cats.get(key);
    if (!g || !g.sprites.length) return;
    const layer = new DotLayer(g.code);
    overlays[catLabel(key, `${g.label} (${g.sprites.length})`)] = layer;
    layerByCode.set(g.code, layer);
  };
  for (const [key] of NPC_CATS) addCat(key);
  addCat("rare");
  for (const key of [...cats.keys()].filter((k) => k.startsWith("Obj: "))
    .sort((a, b) => cats.get(b).sprites.length - cats.get(a).sprites.length)) addCat(key);
  // Enable restored categories BEFORE the control is built (so checkboxes reflect
  // them) and BEFORE the state listeners attach (so it doesn't echo a write).
  for (const code of enabledCats) { const ly = layerByCode.get(code); if (ly) ly.addTo(map); }
  applyVisibility();
  L.control.layers(null, overlays, { collapsed: true }).addTo(map);

  // ---- zone-focus + name/id filter control (top-left) ----
  const focusBounds = (areaid) => {
    const lls = [];
    for (const sp of container.children) if (sp.zone === areaid) lls.push(sp.ll);
    return lls.length ? L.latLngBounds(lls) : null;
  };
  const FilterCtl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const div = L.DomUtil.create("div", "wm-filter leaflet-bar");
      const optHtml = ['<option value="">All zones</option>'].concat(zones.map((z) =>
        `<option value="${z.areaid}"${z.areaid === focusZone ? " selected" : ""}>${esc(z.name)}</option>`)).join("");
      div.innerHTML = `<select class="wm-zone" title="Focus a zone">${optHtml}</select>` +
        `<input class="wm-name" type="text" placeholder="npc name / id" value="${esc(nameFilter)}">`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      const sel = div.querySelector(".wm-zone");
      sel.addEventListener("change", () => {
        focusZone = sel.value ? Number(sel.value) : null;
        applyVisibility();
        const b = focusZone != null && focusBounds(focusZone);
        map.fitBounds(b || occupied, b ? { padding: [40, 40] } : undefined);
        writeState();
      });
      const inp = div.querySelector(".wm-name");
      inp.addEventListener("input", () => {
        nameFilter = inp.value.trim().toLowerCase();
        applyVisibility(); writeStateD();
      });
      return div;
    },
  });
  map.addControl(new FilterCtl());

  // restore the saved view (else fit the continent / the focused zone)
  if (initial.c && initial.z != null) map.setView(initial.c, initial.z);
  else if (focusZone != null) { const b = focusBounds(focusZone); if (b) map.fitBounds(b, { padding: [40, 40] }); }

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

  map.on("moveend zoomend", writeStateD); // persist pan/zoom (layer + focus + filter write directly)
  setTimeout(() => { map.invalidateSize(); redraw(); ready = true; }, 0);
  return map;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
