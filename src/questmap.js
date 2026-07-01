// Quest map resolver -- the data-side foundation that turns a quest's relation rows
// (giver / turn-in / kill-use / collect sources) into a plottable "map plan":
// categorized marker layers + a surface decision (single-zone parchment vs the
// seamless world map) + an opt-in open-path route. Pure data; the caller (main.js)
// renders the chosen surface. Reusable by any future "plot these entities" feature.
import { query } from "./db.js";
import * as Q from "./queries.js";

const COLOR = { giver: "#39d353", ender: "#ffd100" }; // giver=green, turn-in=gold
const COLLECT_CAP = 80; // max markers per collect layer (shown-surface only)
// Golden-angle hue per successive objective layer -> adjacent layers are ~137 deg
// apart, so each kill target / collected item reads as a clearly distinct colour
// (e.g. Lord Vash'arj vs Lady Renirja, whose entry ids are consecutive).
function makeHue() {
  let i = 0;
  return () => `hsl(${Math.round((i++ * 137.508 + 25) % 360)} 72% 52%)`;
}
// One representative waypoint for an objective: the centroid of its DENSEST region
// (coarse 4x4 grid over the points' bounding box). A "kill 10 of X" objective with 50
// spread spawns collapses to the one spot worth walking to -> a clean route instead of
// a zig-zag through every spawn.
function routeWaypoint(pts) {
  if (pts.length <= 1) return { x: pts[0].x, y: pts[0].y };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const gx = (x1 - x0) / 4 || 1, gy = (y1 - y0) / 4 || 1;
  const cells = new Map();
  for (const p of pts) {
    const k = `${Math.floor((p.x - x0) / gx)},${Math.floor((p.y - y0) / gy)}`;
    const c = cells.get(k) || { n: 0, sx: 0, sy: 0 }; c.n++; c.sx += p.x; c.sy += p.y; cells.set(k, c);
  }
  let best = null; for (const c of cells.values()) if (!best || c.n > best.n) best = c;
  return { x: best.sx / best.n, y: best.sy / best.n };
}

// sources: { giversN, endersN, giversG, endersG, kills, collects }
//   giversN/endersN: [{entry,name}] creatures   giversG/endersG: [{entry,name}] objects
//   kills:    [{entry,name,kind:'c'|'o',count}]            (one per kill/use objective)
//   collects: [{entry,name,kind:'c'|'o',icon,group,groupName}]  (drop/gather sources,
//             grouped by the collected item: `group` id + `groupName` label)
// Returns { markerLayers, surface, route } or { markerLayers:[], surface:null }.
export async function buildQuestMap(sources) {
  const { giversN = [], endersN = [], giversG = [], endersG = [], kills = [], collects = [] } = sources;
  const tagged = [
    ...giversN.map((c) => ({ role: "giver", kind: "c", entry: c.entry, name: c.name })),
    ...giversG.map((g) => ({ role: "giver", kind: "o", entry: g.entry, name: g.name })),
    ...endersN.map((c) => ({ role: "ender", kind: "c", entry: c.entry, name: c.name })),
    ...endersG.map((g) => ({ role: "ender", kind: "o", entry: g.entry, name: g.name })),
    ...kills.map((k) => ({ role: "kill", kind: k.kind, entry: k.entry, name: k.name, count: k.count })),
    ...collects.map((s) => ({ role: "collect", kind: s.kind, entry: s.entry, name: s.name, icon: s.icon, group: s.group, groupName: s.groupName })),
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

  // pick the continent the map shows by a WEIGHTED score: the actual quest work
  // (kill/collect objectives) outweighs giver/turn-in, so a quest you pick up on one
  // continent but complete on another shows where the work is (e.g. quest 272).
  const zoneSet = new Set(all.map((p) => p.zone));
  const mapScore = new Map();
  const W = { giver: 1, ender: 1, kill: 3, collect: 3 };
  for (const t of tagged) for (const p of t.points) mapScore.set(p.map, (mapScore.get(p.map) || 0) + (W[t.role] || 1));
  let domMap = null, best = -1;
  for (const [m, s] of mapScore) if (s > best) { best = s; domMap = m; }
  // dominant zone = most-marked zone ON the chosen continent (parchment + fallback)
  const zOnDom = new Map();
  for (const p of all) if (p.map === domMap) zOnDom.set(p.zone, (zOnDom.get(p.zone) || 0) + 1);
  let domZone = null, bz = -1;
  for (const [z, n] of zOnDom) if (n > bz) { bz = n; domZone = z; }
  // roles stranded on other continents -> a note (can't plot them on this surface)
  const offRoles = new Set();
  for (const t of tagged) for (const p of t.points) if (p.map !== domMap) offRoles.add(t.role);
  const surface = (mapScore.size === 1 && zoneSet.size === 1)
    ? { kind: "zone", areaid: domZone, mapId: domMap, zones: 1, off: [] }
    : { kind: "world", mapId: domMap, areaid: domZone, zones: zoneSet.size, off: [...offRoles] };
  const inSurface = (p) => (surface.kind === "zone" ? p.zone === surface.areaid : p.map === surface.mapId);

  const ptsOf = (role) => tagged.filter((t) => t.role === role).flatMap((t) => t.points).filter(inSurface);
  const giverP = ptsOf("giver"), enderP = ptsOf("ender");

  const markerLayers = [];
  const nextHue = makeHue();
  // giver/ender: a coloured dot legend (green/gold); object givers/enders still render
  // the default "Quest Giver" POI marker (buildMarkerLayer's fallback for kind 'o').
  // When the same NPC(s) both START and END the quest, one combined marker -- two
  // overlapping pins on the same spot are redundant.
  const giverIds = new Set([...giversN, ...giversG].map((x) => x.entry));
  const enderIds = new Set([...endersN, ...endersG].map((x) => x.entry));
  const sameNpc = giverIds.size > 0 && giverIds.size === enderIds.size && [...giverIds].every((id) => enderIds.has(id));
  if (sameNpc) {
    if (giverP.length) markerLayers.push({ key: "giver", label: "Quest giver & turn-in", color: COLOR.giver, points: giverP, on: true });
  } else {
    if (giverP.length) markerLayers.push({ key: "giver", label: "Quest giver", color: COLOR.giver, points: giverP, on: true });
    if (enderP.length) markerLayers.push({ key: "ender", label: "Turn in", color: COLOR.ender, points: enderP, on: true });
  }
  // one layer PER kill/use objective target (each its own colour + toggle)
  for (const t of tagged.filter((x) => x.role === "kill")) {
    const pts = t.points.filter(inSurface);
    if (!pts.length) continue;
    markerLayers.push({ key: `kill-${t.entry}`, label: t.count > 1 ? `${t.name} ×${t.count}` : t.name, color: nextHue(), poi: t.kind === "o" ? "Chest" : undefined, points: pts, on: true });
  }
  // one layer PER collected item (sources grouped by `group`)
  const byGroup = new Map();
  for (const t of tagged.filter((x) => x.role === "collect")) {
    const g = byGroup.get(t.group) || { name: t.groupName, icon: t.icon, pts: [] };
    for (const p of t.points) g.pts.push(p);
    byGroup.set(t.group, g);
  }
  for (const [gid, g] of byGroup) {
    let pts = g.pts.filter(inSurface);
    if (!pts.length) continue;
    if (pts.length > COLLECT_CAP) pts = pts.slice(0, COLLECT_CAP);
    markerLayers.push({ key: `collect-${gid}`, label: `Collect: ${g.name}`, color: nextHue(), icon: g.icon, points: pts, on: true });
  }

  // opt-in open-path route: giver -> ONE waypoint per objective (its densest spot) ->
  // turn-in. Using a representative per objective (not every spawn) keeps the path from
  // zig-zagging out to stray far-end spawns when a dense cluster has everything.
  const objLayers = markerLayers.filter((l) => /^(kill|collect)-/.test(l.key));
  const startWp = giverP.length ? routeWaypoint(giverP) : null;
  const endWp = enderP.length ? routeWaypoint(enderP) : null;
  const objWps = objLayers.map((l) => routeWaypoint(l.points));
  const routePts = [...(startWp ? [startWp] : []), ...objWps, ...(!sameNpc && endWp ? [endWp] : [])];
  const route = (routePts.length >= 3)
    ? { points: routePts, start: startWp || undefined, end: (!sameNpc && endWp) || undefined, label: "Suggested route", mergeFrac: 0 }
    : null;

  return { markerLayers, surface, route };
}
