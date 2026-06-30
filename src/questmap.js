// Quest map resolver -- the data-side foundation that turns a quest's relation rows
// (giver / turn-in / kill-use / collect sources) into a plottable "map plan":
// categorized marker layers + a surface decision (single-zone parchment vs the
// seamless world map) + an opt-in open-path route. Pure data; the caller (main.js)
// renders the chosen surface. Reusable by any future "plot these entities" feature.
import { query } from "./db.js";
import * as Q from "./queries.js";

// Marker colours per role (creature pins; object points use the item/POI icon).
const COLOR = { giver: "#39d353", ender: "#ffd100", kill: "#f0506e", collect: "#7cc4ff" };
const COLLECT_CAP = 80; // max collect-source markers (shown-surface only)

// sources: { giversN, endersN, giversG, endersG, qcreatures, collect }
//   giversN/endersN: [{entry,name}] creatures   giversG/endersG: [{entry,name}] objects
//   qcreatures: [{target,is_go,name}] (kill/use objectives)
//   collect: [{entry,name,kind:'c'|'o',icon}] (drop/gather sources of req items)
// Returns { markerLayers, surface, route } or { markerLayers:[], surface:null }.
export async function buildQuestMap(sources) {
  const { giversN = [], endersN = [], giversG = [], endersG = [], qcreatures = [], collect = [] } = sources;
  const tagged = [
    ...giversN.map((c) => ({ role: "giver", kind: "c", entry: c.entry, name: c.name })),
    ...giversG.map((g) => ({ role: "giver", kind: "o", entry: g.entry, name: g.name })),
    ...endersN.map((c) => ({ role: "ender", kind: "c", entry: c.entry, name: c.name })),
    ...endersG.map((g) => ({ role: "ender", kind: "o", entry: g.entry, name: g.name })),
    ...qcreatures.map((o) => ({ role: "kill", kind: o.is_go ? "o" : "c", entry: o.target, name: o.name })),
    ...collect.map((s) => ({ role: "collect", kind: s.kind, entry: s.entry, name: s.name, icon: s.icon })),
  ].filter((t) => t.entry);

  // batch entry -> spawn coordinates, one query per kind
  const coords = { c: new Map(), o: new Map() };
  const load = async (kind) => {
    const ids = [...new Set(tagged.filter((t) => t.kind === kind).map((t) => t.entry))];
    if (!ids.length) return;
    const rows = await query(Q.qSpawnPointsFor(ids.length, kind), ids);
    for (const r of rows) {
      let a = coords[kind].get(r.entry); if (!a) { a = []; coords[kind].set(r.entry, a); }
      a.push({ x: r.x, y: r.y, map: r.map, zone: r.zone });
    }
  };
  await Promise.all([load("c"), load("o")]);
  for (const t of tagged) {
    t.points = (coords[t.kind].get(t.entry) || []).map((p) => ({ ...p, entry: t.entry, name: t.name, kind: t.kind }));
  }

  const all = tagged.flatMap((t) => t.points);
  if (!all.length) return { markerLayers: [], surface: null };

  // surface: one map + one zone -> that zone's parchment; otherwise the world map of
  // the dominant (most-marked) continent.
  const zoneSet = new Set(all.map((p) => p.zone));
  const mapCount = new Map(), zoneCount = new Map();
  for (const p of all) { mapCount.set(p.map, (mapCount.get(p.map) || 0) + 1); zoneCount.set(p.zone, (zoneCount.get(p.zone) || 0) + 1); }
  let domMap = null, best = -1;
  for (const [m, n] of mapCount) if (n > best) { best = n; domMap = m; }
  let domZone = null, bz = -1;
  for (const [z, n] of zoneCount) if (n > bz) { bz = n; domZone = z; }
  // single map + single zone -> that zone's parchment; else the world map of the
  // dominant continent. `areaid` always carries the dominant zone so the caller can
  // fall back to a parchment if that continent ships no minimap pyramid (instances).
  const surface = (mapCount.size === 1 && zoneSet.size === 1)
    ? { kind: "zone", areaid: domZone, mapId: domMap, zones: 1 }
    : { kind: "world", mapId: domMap, areaid: domZone, zones: zoneSet.size };
  const inSurface = (p) => (surface.kind === "zone" ? p.zone === surface.areaid : p.map === surface.mapId);

  const rolePts = (role) => tagged.filter((t) => t.role === role).flatMap((t) => t.points).filter(inSurface);
  const giverP = rolePts("giver"), enderP = rolePts("ender"), killP = rolePts("kill");
  let collectP = rolePts("collect");
  if (collectP.length > COLLECT_CAP) collectP = collectP.slice(0, COLLECT_CAP);
  const collectIcon = (tagged.find((t) => t.role === "collect" && t.icon) || {}).icon;

  const markerLayers = [];
  const push = (key, label, color, points, extra = {}) => {
    if (points.length) markerLayers.push({ key, label, color, poi: "Quest Giver", points, on: true, ...extra });
  };
  push("giver", "Quest giver", COLOR.giver, giverP);
  push("ender", "Turn in", COLOR.ender, enderP);
  push("kill", "Kill / use", COLOR.kill, killP, { poi: "Chest" });
  if (collectP.length) markerLayers.push({ key: "collect", label: "Collect", color: COLOR.collect, icon: collectIcon, points: collectP, on: true });

  // opt-in open-path route: giver -> objective clusters -> turn-in (within the surface).
  const routePts = [...giverP, ...killP, ...collectP, ...enderP];
  const route = (giverP.length && routePts.length >= 3)
    ? { points: routePts, start: giverP[0], end: enderP[0] || undefined, label: "Suggested route" }
    : null;

  return { markerLayers, surface, route };
}
