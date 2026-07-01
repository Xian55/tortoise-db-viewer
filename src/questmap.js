// Quest map resolver -- the data-side foundation that turns a quest's relation rows
// (giver / turn-in / kill-use / collect sources) into a plottable "map plan": one
// VIEW per zone the quest touches (its own categorized marker layers + opt-in route),
// plus a seamless world-map overview of the busiest continent when it spans >1 zone.
// Pure data; the caller (main.js) renders a switcher over the views. Reusable by any
// future "plot these entities" feature.
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
// One representative waypoint for an objective. Bucket its spawns into a coarse 6x6
// grid (each cell = a candidate cluster), keep the SUBSTANTIAL cells (>= 40% of the
// densest), then pick the one CLOSEST to `anchor` (the giver/turn-in). So a "kill 10
// of X" objective that has both a far dense camp and a nearer decent cluster routes to
// the nearer one -- you don't get dragged across the zone when a closer spot works.
// Without an anchor, falls back to the densest cell.
function routeWaypoint(pts, anchor) {
  if (!pts.length) return null;
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const gx = (x1 - x0) / 6 || 1, gy = (y1 - y0) / 6 || 1;
  const cells = new Map();
  for (const p of pts) {
    const k = `${Math.floor((p.x - x0) / gx)},${Math.floor((p.y - y0) / gy)}`;
    const c = cells.get(k) || { n: 0, sx: 0, sy: 0 }; c.n++; c.sx += p.x; c.sy += p.y; cells.set(k, c);
  }
  const list = [...cells.values()].map((c) => ({ n: c.n, x: c.sx / c.n, y: c.sy / c.n }));
  const maxN = Math.max(...list.map((c) => c.n));
  // substantial cells; if none clear the threshold (every point in its own cell -- a
  // scattered objective), fall back to all cells so we still return a waypoint.
  const cand = list.filter((c) => c.n >= Math.max(2, 0.4 * maxN));
  const pool = cand.length ? cand : list;
  if (anchor) {
    let best = null;
    for (const c of pool) { const d = (c.x - anchor.x) ** 2 + (c.y - anchor.y) ** 2; if (!best || d < best.d) best = { c, d }; }
    return { x: best.c.x, y: best.c.y };
  }
  let best = null; for (const c of pool) if (!best || c.n > best.n) best = c;
  return { x: best.x, y: best.y };
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
  if (!all.length) return { views: [] };

  // Stable colour per objective (kill target / collected item) so the same objective
  // reads the same across every zone view AND the world overview. giver/turn-in keep
  // the fixed green/gold.
  const nextHue = makeHue();
  const killColor = new Map();
  for (const t of tagged) if (t.role === "kill" && !killColor.has(t.entry)) killColor.set(t.entry, nextHue());
  const collectColor = new Map();
  for (const t of tagged) if (t.role === "collect" && !collectColor.has(t.group)) collectColor.set(t.group, nextHue());

  // When the same NPC(s) both START and END the quest, one combined marker -- two
  // overlapping pins on the same spot are redundant.
  const giverIds = new Set([...giversN, ...giversG].map((x) => x.entry));
  const enderIds = new Set([...endersN, ...endersG].map((x) => x.entry));
  const sameNpc = giverIds.size > 0 && giverIds.size === enderIds.size && [...giverIds].every((id) => enderIds.has(id));

  // Build the categorised marker layers + suggested route for the subset of points
  // passing `inView` (one zone's parchment, or a whole continent for the world view).
  const layersFor = (inView) => {
    const giverP = tagged.filter((t) => t.role === "giver").flatMap((t) => t.points).filter(inView);
    const enderP = tagged.filter((t) => t.role === "ender").flatMap((t) => t.points).filter(inView);
    const markerLayers = [];
    if (sameNpc) {
      if (giverP.length) markerLayers.push({ key: "giver", label: "Quest giver & turn-in", color: COLOR.giver, points: giverP, on: true });
    } else {
      if (giverP.length) markerLayers.push({ key: "giver", label: "Quest giver", color: COLOR.giver, points: giverP, on: true });
      if (enderP.length) markerLayers.push({ key: "ender", label: "Turn in", color: COLOR.ender, points: enderP, on: true });
    }
    // one layer PER kill/use objective target (each its own stable colour + toggle)
    for (const t of tagged.filter((x) => x.role === "kill")) {
      const pts = t.points.filter(inView);
      if (!pts.length) continue;
      markerLayers.push({ key: `kill-${t.entry}`, label: t.count > 1 ? `${t.name} ×${t.count}` : t.name, color: killColor.get(t.entry), poi: t.kind === "o" ? "Chest" : undefined, points: pts, on: true });
    }
    // one layer PER collected item (sources grouped by `group`)
    const byGroup = new Map();
    for (const t of tagged.filter((x) => x.role === "collect")) {
      const g = byGroup.get(t.group) || { name: t.groupName, icon: t.icon, pts: [] };
      for (const p of t.points) if (inView(p)) g.pts.push(p);
      byGroup.set(t.group, g);
    }
    for (const [gid, g] of byGroup) {
      let pts = g.pts;
      if (!pts.length) continue;
      if (pts.length > COLLECT_CAP) pts = pts.slice(0, COLLECT_CAP);
      markerLayers.push({ key: `collect-${gid}`, label: `Collect: ${g.name}`, color: collectColor.get(gid), icon: g.icon, points: pts, on: true });
    }

    // opt-in open-path route: giver -> ONE waypoint per objective (its densest spot) ->
    // turn-in. Using a representative per objective (not every spawn) keeps the path from
    // zig-zagging out to stray far-end spawns when a dense cluster has everything.
    const objLayers = markerLayers.filter((l) => /^(kill|collect)-/.test(l.key));
    const startWp = giverP.length ? routeWaypoint(giverP) : null;
    const endWp = enderP.length ? routeWaypoint(enderP) : null;
    const anchor = startWp && endWp ? { x: (startWp.x + endWp.x) / 2, y: (startWp.y + endWp.y) / 2 } : (startWp || endWp || null);
    const objWps = objLayers.map((l) => routeWaypoint(l.points, anchor)).filter(Boolean);
    const routePts = [...(startWp ? [startWp] : []), ...objWps, ...(!sameNpc && endWp ? [endWp] : [])];
    const route = (routePts.length >= 3)
      ? { points: routePts, start: startWp || undefined, end: (!sameNpc && endWp) || undefined, label: "Suggested route", mergeFrac: 0 }
      : null;
    return { markerLayers, route };
  };

  // One view per zone that has markers (busiest first, weighting the actual quest work
  // -- kill/collect -- over the giver/turn-in), plus a seamless world-map overview of
  // the busiest continent when that continent spans more than one zone.
  const W = { giver: 1, ender: 1, kill: 3, collect: 3 };
  const zoneMapId = new Map(); // zone -> its continent map id
  const zoneWeight = new Map();
  for (const t of tagged) for (const p of t.points) {
    zoneMapId.set(p.zone, p.map);
    zoneWeight.set(p.zone, (zoneWeight.get(p.zone) || 0) + (W[t.role] || 1));
  }
  const views = [...zoneWeight.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([areaid, weight]) => ({ key: `z-${areaid}`, kind: "zone", areaid, mapId: zoneMapId.get(areaid), weight, ...layersFor((p) => p.zone === areaid) }));

  const mapWeight = new Map(), zonesPerMap = new Map();
  for (const [z, w] of zoneWeight) {
    const m = zoneMapId.get(z);
    mapWeight.set(m, (mapWeight.get(m) || 0) + w);
    if (!zonesPerMap.has(m)) zonesPerMap.set(m, new Set());
    zonesPerMap.get(m).add(z);
  }
  let domMap = null, bestW = -1;
  for (const [m, w] of mapWeight) if (w > bestW) { bestW = w; domMap = m; }
  if (domMap != null && zonesPerMap.get(domMap).size > 1) {
    views.push({ key: `world-${domMap}`, kind: "world", mapId: domMap, zones: zonesPerMap.get(domMap).size, ...layersFor((p) => p.map === domMap) });
  }

  return { views };
}
