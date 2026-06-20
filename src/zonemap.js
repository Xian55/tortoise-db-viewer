// Leaflet zone map: a per-zone parchment image (L.CRS.Simple) with one toggleable
// circle-marker layer per category. World coords -> image pixels via the zone's
// WorldMapArea bounds (same math as the reference WowClassicGrindBot viewer).
// Lazy-imported by main.js so Leaflet stays out of the main bundle.
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// category -> { label, color }. Order = legend/control order.
const CATS = [
  ["quest", "Quest Givers", "#ffd100"],
  ["vendor", "Vendors", "#39d353"],
  ["repair", "Repair", "#b9bcc4"],
  ["trainer", "Trainers", "#66c2cc"],
  ["flight", "Flight Masters", "#7fa0ff"],
  ["inn", "Innkeepers", "#e08a3c"],
  ["bank", "Bankers", "#d0b020"],
  ["mob", "Enemy Mobs", "#e0524a"],
  ["object", "Objects", "#a070d0"],
];
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

// zone: row from Q_ZONE (+ imgUrl). spawns/objects: Q_ZONE_SPAWNS / Q_ZONE_OBJECTS rows.
export function initZoneMap(el, zone, spawns, objects, navigate) {
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
  // lat = H*(x-locbottom)/(loctop-locbottom); lng = W*(locleft-y)/(locleft-locright)
  const dx = zone.loctop - zone.locbottom, dy = zone.locleft - zone.locright;
  const toLatLng = (x, y) => L.latLng(
    dx ? (H * (x - zone.locbottom)) / dx : 0,
    dy ? (W * (zone.locleft - y)) / dy : 0,
  );

  const groups = {};
  for (const [key] of CATS) groups[key] = L.layerGroup();

  const addMarker = (key, latlng, label, href) => {
    const [, , color] = CATS.find((c) => c[0] === key);
    const m = L.circleMarker(latlng, { radius: 4, color: "#000", weight: 1, fillColor: color, fillOpacity: 0.85 });
    m.bindTooltip(label, { direction: "top" });
    if (href) m.on("click", () => navigate(href));
    m.addTo(groups[key]);
  };

  for (const s of spawns) {
    const ll = toLatLng(s.x, s.y);
    const label = `${s.name || "?"} <span class="dim">(${lvl(s)})</span>`;
    for (const role of npcRolesFor(s)) addMarker(role, ll, label, `?npc=${s.entry}`);
  }
  for (const o of objects) {
    addMarker("object", toLatLng(o.x, o.y), o.name || `Object #${o.entry}`, null);
  }

  // add non-empty layers; build the layer control. Mobs default-off (dense).
  const overlays = {};
  for (const [key, label] of CATS) {
    const g = groups[key];
    if (!g.getLayers().length) continue;
    const n = g.getLayers().length;
    overlays[`${label} (${n})`] = g;
    if (key !== "mob") g.addTo(map);
  }
  L.control.layers(null, overlays, { collapsed: false }).addTo(map);

  // container may have been sized after creation; recompute once.
  setTimeout(() => map.invalidateSize(), 0);
  return map;
}
