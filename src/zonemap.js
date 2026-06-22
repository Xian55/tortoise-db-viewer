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

const NPC_CATS = [
  ["quest", "Quest Givers", "#ffd100"],
  ["vendor", "Vendors", "#39d353"],
  ["repair", "Repair", "#b9bcc4"],
  ["trainer", "Trainers", "#66c2cc"],
  ["flight", "Flight Masters", "#7fa0ff"],
  ["inn", "Innkeepers", "#e08a3c"],
  ["bank", "Bankers", "#d0b020"],
  ["mob", "Enemy Mobs", "#e0524a"],
];
const NPC_COLOR = Object.fromEntries(NPC_CATS.map(([k, , c]) => [k, c]));
const OBJ_COLOR = "#a070d0";
// rare (rank 2) + rare elite (rank 4): one cross-cutting category, distinct hue
const RARE_COLOR = "#ff66cc";
const objTypeLabel = (t) => `Obj: ${GAMEOBJECT_TYPE[t] || "Other"}`;

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
const hexToNum = (h) => parseInt(h.replace("#", ""), 16);

// One small white disc texture, tinted per category for the dot markers.
let discTex = null;
function discTexture() {
  if (discTex) return discTex;
  const s = 16, c = document.createElement("canvas");
  c.width = c.height = s;
  const x = c.getContext("2d");
  x.beginPath(); x.arc(s / 2, s / 2, 5.5, 0, Math.PI * 2);
  x.fillStyle = "#fff"; x.fill();
  x.lineWidth = 1.5; x.strokeStyle = "rgba(0,0,0,.85)"; x.stroke();
  discTex = PIXI.Texture.from(c);
  return discTex;
}

let currentMap = null, currentOverlay = null;

// zone: row from Q_ZONE (+ imgUrl). spawns/objects: Q_ZONE_SPAWNS / Q_ZONE_OBJECTS
// rows. focus (optional): { label, icon, points:[{x,y}], npc? } -> a highlighted
// layer with every other category off + the view zoomed to it (e.g. only herb
// nodes, or one NPC's spawns). With focus.npc set, points draw as creature pins
// (no item icon) coloured by that entry; otherwise as the focus.icon marker.
export function initZoneMap(el, zone, spawns, objects, navigate, focus = null) {
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

  // ---- Pixi overlay: category dots (high volume) ----
  const container = new PIXI.Container();
  const cats = new Map(); // key -> { label, sprites:[] }
  const cat = (key, label) => {
    let g = cats.get(key);
    if (!g) { g = { label, sprites: [] }; cats.set(key, g); }
    return g;
  };
  const disc = discTexture();
  const addDot = (key, label, color, ll, html, href) => {
    const sp = new PIXI.Sprite(disc);
    sp.anchor.set(0.5);
    sp.tint = color;
    sp.ll = ll; sp.label = html; sp.href = href; sp.visible = false;
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
    if (!e) { e = { name: s.name || `NPC #${s.entry}`, lls: [] }; npcByEntry.set(s.entry, e); }
    e.lls.push(ll);
    if (!focus) {
      const html = `${esc(s.name) || "?"} <span class="dim">(${lvl(s)})</span>`;
      for (const role of npcRolesFor(s)) {
        const def = NPC_CATS.find((c) => c[0] === role);
        addDot(role, def ? def[1] : role, hexToNum(NPC_COLOR[role]), ll, html, `?npc=${s.entry}`);
      }
      // rares get an extra dot in their own cross-cutting category (rank 2/4)
      if (s.rank === 2 || s.rank === 4) {
        const rk = s.rank === 4 ? "Rare Elite" : "Rare";
        addDot("rare", "Rare / Rare Elite", hexToNum(RARE_COLOR), ll,
          `${esc(s.name) || "?"} <span class="dim">(${lvl(s)}) · ${rk}</span>`, `?npc=${s.entry}`);
      }
    }
  }
  const objByEntry = new Map();
  for (const o of objects) {
    const ll = toLatLng(o.x, o.y);
    if (!focus) addDot(objTypeLabel(o.type), objTypeLabel(o.type), hexToNum(OBJ_COLOR), ll, esc(o.name) || `Object #${o.entry}`, null);
    let e = objByEntry.get(o.entry);
    if (!e) { e = { name: o.name || `Object #${o.entry}`, lls: [] }; objByEntry.set(o.entry, e); }
    e.lls.push(ll);
  }

  const DOT_PX = 11; // on-screen diameter, constant across zoom
  const overlay = L.pixiOverlay((utils) => {
    // the overlay scales the whole container by utils.getScale(zoom); counter it
    // so dots stay a fixed screen size instead of growing as you zoom in.
    const dotScale = (DOT_PX / disc.width) / utils.getScale(utils.getMap().getZoom());
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
  const DotLayer = L.Layer.extend({
    initialize(sprites) { this._s = sprites; },
    onAdd() { for (const s of this._s) s.visible = true; redraw(); },
    onRemove() { for (const s of this._s) s.visible = false; redraw(); },
  });

  // ---- icon markers (few): a gathered node + toggled objects, as HTML ----
  const iconMark = (ll, icon, label) => L.marker(ll, {
    icon: L.divIcon({ html: iconMarker(icon, "map-poi"), className: "poi-div", iconSize: [22, 22], iconAnchor: [11, 11] }),
  }).bindTooltip(label, { direction: "top" });
  // toggled NPC spawns: a bright pin (creatures have no item icon), a distinct
  // colour per creature so multiple toggled NPCs are tellable apart; clicking it
  // opens the NPC page.
  const npcColor = (entry) => `hsl(${(entry * 47) % 360} 70% 55%)`;
  const npcMark = (ll, label, entry) => {
    const m = L.marker(ll, {
      icon: L.divIcon({ html: `<span class="map-pin" style="background:${npcColor(entry)}"></span>`, className: "poi-div", iconSize: [16, 16], iconAnchor: [8, 8] }),
    }).bindTooltip(label, { direction: "top" });
    if (entry) m.on("click", () => navigate(`?npc=${entry}`));
    return m;
  };

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
      mark.addTo(focusLayer);
    }
    focusBounds = L.latLngBounds(lls);
  }

  // ---- layer control: dot categories + the focus layer ----
  const overlays = {};
  const addCat = (key, on) => {
    const g = cats.get(key);
    if (!g || !g.sprites.length) return;
    const layer = new DotLayer(g.sprites);
    overlays[`${g.label} (${g.sprites.length})`] = layer;
    if (on) layer.addTo(map);
  };
  // All category layers start OFF (a normal zone view is a clean map you opt into
  // via the layer control); only the gather/focus layer is on by default.
  if (focusLayer) { overlays[FKEY] = focusLayer; focusLayer.addTo(map); }
  for (const [key] of NPC_CATS) addCat(key, false);
  addCat("rare", false); // single toggle for all rare / rare-elite spawns
  const objKeys = [...cats.keys()].filter((k) => k.startsWith("Obj: "))
    .sort((a, b) => cats.get(b).sprites.length - cats.get(a).sprites.length);
  for (const key of objKeys) addCat(key, false);

  L.control.layers(null, overlays, { collapsed: true }).addTo(map);
  if (focusBounds && focusBounds.isValid()) {
    // NPC view: a tight spawn cluster would otherwise slam to maxZoom. Keep zone
    // context -- pad wide and cap the fit a couple levels above the whole-zone fit.
    if (focus.npc) map.fitBounds(focusBounds.pad(0.6), { maxZoom: Math.min(map.getMaxZoom(), fitZoom + 2), padding: [30, 30] });
    else map.fitBounds(focusBounds.pad(0.3));
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
        if (e) for (const ll of e.lls) npcMark(ll, e.name, entry).addTo(rec);
        npcLayers.set(entry, rec);
      }
      rec.addTo(map);
    } else if (rec) map.removeLayer(rec);
  }

  return { map, toggleObject, toggleNpc };
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
