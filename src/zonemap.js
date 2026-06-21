// Zone map: a per-zone parchment image (L.CRS.Simple) with toggleable marker
// layers, rendered on a GPU Pixi overlay (leaflet-pixi-overlay) so huge zones
// (the Barrens has ~12k spawns) stay smooth. NPCs split by role, objects by
// gameobject type, so clutter can be hidden. World coords -> image pixels via the
// zone's WorldMapArea bounds. Lazy-imported so Pixi/Leaflet stay out of the main
// bundle.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as PIXI from "pixi.js";
import "leaflet-pixi-overlay";
import { GAMEOBJECT_TYPE } from "./constants.js";
import { iconUrl, getIconAtlas } from "./render.js";

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
const OBJ_DEFAULT_ON = new Set(["Chest", "Fishing Node", "Fishing Hole", "Mailbox", "Herb", "Mining"]);
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

// Texture for an item/object icon: an atlas frame (Turtle custom icons) or the
// CDN image. Atlas frame dims come from the shared base texture once it loads.
let atlasBase = null;
function iconTexture(icon) {
  const atlas = getIconAtlas();
  const key = (icon || "").toLowerCase();
  if (atlas && atlas.icons && atlas.icons[key] != null) {
    if (!atlasBase) atlasBase = PIXI.BaseTexture.from(atlas.url);
    const i = atlas.icons[key];
    const frame = () => {
      const cw = atlasBase.width / atlas.cols, ch = atlasBase.height / atlas.rows;
      return new PIXI.Rectangle((i % atlas.cols) * cw, Math.floor(i / atlas.cols) * ch, cw, ch);
    };
    if (atlasBase.valid) return new PIXI.Texture(atlasBase, frame());
    const tex = new PIXI.Texture(atlasBase);
    atlasBase.once("loaded", () => { tex.frame = frame(); tex.updateUvs(); });
    return tex;
  }
  return PIXI.Texture.from(iconUrl(icon));
}

let currentMap = null, currentOverlay = null;

// zone: row from Q_ZONE (+ imgUrl). spawns/objects: Q_ZONE_SPAWNS / Q_ZONE_OBJECTS
// rows. focus (optional): { label, icon, points:[{x,y}] } -> a highlighted layer
// with every other category off + the view zoomed to it (e.g. only herb nodes).
export function initZoneMap(el, zone, spawns, objects, navigate, focus = null) {
  // destroy the previous overlay first -> frees its WebGL context (browsers cap
  // these, so leaking one per zone navigation would eventually break the map).
  if (currentOverlay) { try { currentOverlay.destroy(); } catch (_) { /* already gone */ } currentOverlay = null; }
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

  const dx = zone.loctop - zone.locbottom, dy = zone.locleft - zone.locright;
  const toLatLng = (x, y) => L.latLng(
    dx ? (H * (x - zone.locbottom)) / dx : 0,
    dy ? (W * (zone.locleft - y)) / dy : 0,
  );

  // ---- Pixi overlay: one container of sprites; categories toggle visibility ----
  const container = new PIXI.Container();
  const cats = new Map(); // key -> { label, sprites:[], on }
  const cat = (key, label) => {
    let g = cats.get(key);
    if (!g) { g = { label, sprites: [] }; cats.set(key, g); }
    return g;
  };
  const disc = discTexture();

  // sprite carries .ll (latlng), .label (tooltip html), .href (click target)
  const addDot = (key, label, color, ll, html, href) => {
    const sp = new PIXI.Sprite(disc);
    sp.anchor.set(0.5);
    sp.tint = color;
    sp.ll = ll; sp.label = html; sp.href = href;
    container.addChild(sp);
    cat(key, label).sprites.push(sp);
    return sp;
  };
  const addIcon = (key, label, tex, ll, html, href) => {
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5);
    sp.ll = ll; sp.label = html; sp.href = href; sp.isIcon = true;
    container.addChild(sp);
    cat(key, label).sprites.push(sp);
    return sp;
  };

  // In focus mode the category layers are off by default, so don't build them;
  // a huge zone's ~12k dots would just be hidden. objByEntry is still populated
  // for the Objects-tab toggle.
  if (!focus) {
    for (const s of spawns) {
      const ll = toLatLng(s.x, s.y);
      const html = `${esc(s.name) || "?"} <span class="dim">(${lvl(s)})</span>`;
      for (const role of npcRolesFor(s)) {
        const [, label] = NPC_CATS.find((c) => c[0] === role) || [role, role];
        addDot(role, label, hexToNum(NPC_COLOR[role]), ll, html, `?npc=${s.entry}`);
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

  // focus layer: the gathered node's own icon, bright, zoomed-to.
  let focusBounds = null;
  const FKEY = focus ? `★ ${focus.label}` : null;
  if (focus && focus.points.length) {
    const tex = iconTexture(focus.icon);
    const lls = [];
    for (const p of focus.points) {
      const ll = toLatLng(p.x, p.y);
      lls.push(ll);
      addIcon(FKEY, FKEY, tex, ll, esc(focus.label), null);
    }
    focusBounds = L.latLngBounds(lls);
  }

  // project + scale every visible sprite each redraw
  const overlay = L.pixiOverlay((utils) => {
    const zoom = utils.getMap().getZoom();
    const scale = utils.getMap().getZoomScale(zoom, 0);
    const renderer = utils.getRenderer();
    const dotScale = Math.max(0.5, Math.min(2, scale)); // keep dots readable
    for (const sp of container.children) {
      if (!sp.visible) continue;
      const p = utils.latLngToLayerPoint(sp.ll);
      sp.x = p.x; sp.y = p.y;
      if (sp.isIcon) sp.scale.set((22 / sp.texture.width) * Math.max(0.6, Math.min(2.2, scale)));
      else sp.scale.set(dotScale);
    }
    renderer.render(container);
  }, container, { autoPreventDefault: false });
  overlay.addTo(map);
  currentOverlay = overlay;

  // ---- category visibility as toggleable Leaflet layers ----
  const redraw = () => overlay.redraw();
  const GroupLayer = L.Layer.extend({
    initialize(sprites) { this._s = sprites; },
    onAdd() { for (const s of this._s) s.visible = true; redraw(); },
    onRemove() { for (const s of this._s) s.visible = false; redraw(); },
  });
  // start hidden; addLayer below turns the default-on ones on
  for (const g of cats.values()) for (const s of g.sprites) s.visible = false;

  const overlays = {};
  const addCat = (key, on) => {
    const g = cats.get(key);
    if (!g || !g.sprites.length) return;
    const layer = new GroupLayer(g.sprites);
    overlays[`${g.label} (${g.sprites.length})`] = layer;
    if (on) layer.addTo(map);
  };
  if (FKEY) addCat(FKEY, true);
  for (const [key] of NPC_CATS) addCat(key, !focus && !NPC_DEFAULT_OFF.has(key));
  const objKeys = [...cats.keys()].filter((k) => k.startsWith("Obj: "))
    .sort((a, b) => cats.get(b).sprites.length - cats.get(a).sprites.length);
  for (const key of objKeys) addCat(key, !focus && OBJ_DEFAULT_ON.has(key.slice(5)));

  L.control.layers(null, overlays, { collapsed: false }).addTo(map);
  if (focusBounds && focusBounds.isValid()) map.fitBounds(focusBounds.pad(0.3));
  setTimeout(() => { map.invalidateSize(); redraw(); }, 0);

  // ---- hover tooltip + click, via nearest-visible-sprite hit-test ----
  const tip = L.DomUtil.create("div", "pixi-tip", el);
  tip.style.cssText = "position:absolute;z-index:1000;pointer-events:none;display:none;" +
    "background:#16181f;border:1px solid #2a2e3a;border-radius:6px;padding:3px 7px;" +
    "font-size:12px;color:#e6e8ee;white-space:nowrap;transform:translate(-50%,-140%)";
  const HIT = 9; // px
  let hover = null, raf = 0;
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
      hover = sp;
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

  // ---- Objects-tab toggle: show/hide one object's icon markers ----
  const objLayers = new Map();
  function toggleObject(entry, on, icon) {
    let rec = objLayers.get(entry);
    if (on) {
      if (!rec) {
        const e = objByEntry.get(entry);
        const tex = iconTexture(icon);
        const sprites = [];
        if (e) for (const ll of e.lls) sprites.push(addIcon(`obj-${entry}`, e.name, tex, ll, esc(e.name), null));
        rec = new GroupLayer(sprites);
        objLayers.set(entry, rec);
      }
      rec.addTo(map);
    } else if (rec) map.removeLayer(rec);
  }

  return { map, toggleObject };
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
