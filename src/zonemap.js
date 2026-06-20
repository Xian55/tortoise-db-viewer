// Leaflet zone map: a per-zone parchment image (L.CRS.Simple) with toggleable
// circle-marker layers. NPCs split by role; objects split by gameobject type so
// the clutter (doors/signs) can be hidden and only nodes/chests shown. World
// coords -> image pixels via the zone's WorldMapArea bounds (same math as the
// reference WowClassicGrindBot viewer). Lazy-imported so Leaflet stays out of
// the main bundle.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { GAMEOBJECT_TYPE } from "./constants.js";
import { iconImg } from "./render.js";

// NPC categories: key -> [label, color]. Order = control order.
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
const NPC_DEFAULT_OFF = new Set(["mob"]);          // dense -> off by default
const OBJ_COLOR = "#a070d0";
// object types worth showing by default (lootable/useful); the rest (doors,
// buttons, generic clutter) start hidden.
const OBJ_DEFAULT_ON = new Set(["Chest", "Fishing Node", "Fishing Hole", "Mailbox", "Herb", "Mining"]);
const objTypeLabel = (t) => `Obj: ${GAMEOBJECT_TYPE[t] || "Other"}`;

// npc_flags bits -> role
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

let currentMap = null;

// zone: row from Q_ZONE (+ imgUrl). spawns/objects: Q_ZONE_SPAWNS / Q_ZONE_OBJECTS
// rows. focus (optional): { label, points:[{x,y}] } -> a highlighted layer with
// every other category off + the view zoomed to it (e.g. only Earthroot nodes).
export function initZoneMap(el, zone, spawns, objects, navigate, focus = null) {
  if (currentMap) { currentMap.remove(); currentMap = null; }

  const W = zone.img_w, H = zone.img_h;
  const map = L.map(el, {
    crs: L.CRS.Simple, minZoom: -2, maxZoom: 3, preferCanvas: true,
    attributionControl: false, zoomControl: true,
  });
  currentMap = map;
  const bounds = [[0, 0], [H, W]];
  L.imageOverlay(zone.imgUrl, bounds).addTo(map);
  map.fitBounds(bounds);

  // world (x,y) -> Leaflet latlng in image-pixel space (CRS.Simple, y up).
  const dx = zone.loctop - zone.locbottom, dy = zone.locleft - zone.locright;
  const toLatLng = (x, y) => L.latLng(
    dx ? (H * (x - zone.locbottom)) / dx : 0,
    dy ? (W * (zone.locleft - y)) / dy : 0,
  );

  // a layer group per category, created on demand
  const groups = new Map();
  const group = (key) => {
    let g = groups.get(key);
    if (!g) { g = L.layerGroup(); groups.set(key, g); }
    return g;
  };
  const marker = (key, color, latlng, label, href) => {
    const m = L.circleMarker(latlng, { radius: 4, color: "#000", weight: 1, fillColor: color, fillOpacity: 0.85 });
    m.bindTooltip(label, { direction: "top" });
    if (href) m.on("click", () => navigate(href));
    m.addTo(group(key));
  };

  for (const s of spawns) {
    const ll = toLatLng(s.x, s.y);
    const label = `${s.name || "?"} <span class="dim">(${lvl(s)})</span>`;
    for (const role of npcRolesFor(s)) marker(role, NPC_COLOR[role], ll, label, `?npc=${s.entry}`);
  }
  const objByEntry = new Map(); // entry -> { name, lls:[latlng] } for per-object toggles
  for (const o of objects) {
    const ll = toLatLng(o.x, o.y);
    marker(objTypeLabel(o.type), OBJ_COLOR, ll, o.name || `Object #${o.entry}`, null);
    let e = objByEntry.get(o.entry);
    if (!e) { e = { name: o.name || `Object #${o.entry}`, lls: [] }; objByEntry.set(o.entry, e); }
    e.lls.push(ll);
  }

  // focus layer (e.g. only Earthroot nodes): bright, on; everything else off.
  let focusBounds = null;
  const FKEY = focus ? `★ ${focus.label}` : null;
  if (focus && focus.points.length) {
    // marker uses the item's own icon (atlas sprite or CDN img via iconImg)
    const poi = L.divIcon({ html: iconImg(focus.icon, "map-poi"), className: "poi-div", iconSize: [22, 22], iconAnchor: [11, 11] });
    const lls = [];
    for (const p of focus.points) {
      const ll = toLatLng(p.x, p.y);
      lls.push(ll);
      L.marker(ll, { icon: poi }).bindTooltip(focus.label, { direction: "top" }).addTo(group(FKEY));
    }
    focusBounds = L.latLngBounds(lls);
  }

  // Build the overlay control. In focus mode only the focus layer is on; otherwise
  // NPC categories (control order) then object types by count desc, per whitelist.
  const overlays = {};
  const addLayer = (key, label, on) => {
    const g = groups.get(key);
    if (!g || !g.getLayers().length) return;
    overlays[`${label} (${g.getLayers().length})`] = g;
    if (on) g.addTo(map);
  };
  if (FKEY) addLayer(FKEY, FKEY, true);
  for (const [key, label] of NPC_CATS) addLayer(key, label, !focus && !NPC_DEFAULT_OFF.has(key));
  const objKeys = [...groups.keys()].filter((k) => k.startsWith("Obj: "))
    .sort((a, b) => groups.get(b).getLayers().length - groups.get(a).getLayers().length);
  for (const key of objKeys) addLayer(key, key, !focus && OBJ_DEFAULT_ON.has(key.slice(5)));

  L.control.layers(null, overlays, { collapsed: false }).addTo(map);
  if (focusBounds && focusBounds.isValid()) map.fitBounds(focusBounds.pad(0.3));
  setTimeout(() => map.invalidateSize(), 0);

  // Per-object layers toggled from the zone page's Objects tab. Each gets a
  // distinct palette color; returns the color so the row can show a swatch.
  const PALETTE = ["#ff5e5e", "#5ec8ff", "#ffd24d", "#7dff7d", "#c98bff", "#ff9f4d", "#4dffd2", "#ff7de0", "#ff4da6", "#9dd34d"];
  const objLayers = new Map();
  let palIdx = 0;
  function toggleObject(entry, on) {
    let rec = objLayers.get(entry);
    if (on) {
      if (!rec) {
        const color = PALETTE[palIdx++ % PALETTE.length];
        const layer = L.layerGroup();
        const e = objByEntry.get(entry);
        if (e) for (const ll of e.lls) {
          L.circleMarker(ll, { radius: 5, color: "#000", weight: 1, fillColor: color, fillOpacity: 0.9 })
            .bindTooltip(e.name, { direction: "top" }).addTo(layer);
        }
        rec = { layer, color };
        objLayers.set(entry, rec);
      }
      rec.layer.addTo(map);
      return rec.color;
    }
    if (rec) map.removeLayer(rec.layer);
    return rec ? rec.color : null;
  }

  return { map, toggleObject };
}
