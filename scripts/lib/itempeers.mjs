// Derive the item-page peer baseline: "×1.12 armor of a typical Rare ilvl 60-64
// Plate Chest". Same idea as the NPC Stats tab's peer column (Q_NPC_PEERS), but the
// cohort key here is a composite (class/subclass/slot/quality/ilvl band) that no
// index can group at runtime -- so the whole thing is precomputed into two small
// tables and the page does a single primary-key lookup.
//
// Medians, not averages: one 1000-armor outlier in a 30-item cohort drags a mean
// far off the piece a player actually compares against (the same lesson the NPC
// peer query learned from dmg_multiplier bosses).

import { QUALITY, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE } from "../../src/constants.js";

// Under this many members a cohort isn't representative -- the key falls back to a
// coarser one (see COHORT_LEVELS), and if even the coarsest misses, the item gets
// no peer row at all and the page shows nothing.
export const PEER_MIN = 10;

// Equip slots that mean the same thing for comparison purposes.
const SLOT_ALIAS = { 20: 5 };                     // Robe -> Chest
const WEAPON_1H = new Set([21, 22]);              // Main Hand / Off Hand -> One-Hand

function slotOf(it) {
  const iv = SLOT_ALIAS[it.inventory_type] || it.inventory_type;
  return it.class === 2 && WEAPON_1H.has(iv) ? 13 : iv;
}

// The item's three comparable metrics. `stats` (the sum of the five base stats) is
// passed in from item_stats -- it's the only one not readable off the item row.
const armorOf = (it) => it.armor || 0;
// Both damage lines, exactly like the tooltip's "(53.9 damage per second)" -- the
// card sits directly under that line, so a different number would read as a bug
// (Thunderfury's second, Nature line is a quarter of its damage).
const dpsOf = (it) =>
  it.delay > 0 ? (((it.dmg_min1 + it.dmg_max1) / 2) + ((it.dmg_min2 + it.dmg_max2) / 2)) / (it.delay / 1000) : 0;

// Cohort keys from finest to coarsest. An item takes the FIRST one whose cohort has
// PEER_MIN members: an epic gets compared with epics of its own ilvl band where the
// data supports it, and only widens (dropping quality, then widening the band) when
// its niche is too thin. Measured coverage on the Turtle DB: ~99% of gear lands on
// L1 or L2.
const band = (lvl, w) => Math.floor((lvl || 0) / w) * w;
// Quality is given up LAST: "vs. typical Epic ilvl 60–79 Dagger" is a better read
// than the same band mixing greens in, so the ilvl band widens first.
const COHORT_LEVELS = [
  { w: 5, quality: true, subclass: true },
  { w: 10, quality: true, subclass: true },
  { w: 20, quality: true, subclass: true },
  { w: 10, quality: false, subclass: true },
  { w: 20, quality: false, subclass: true },
  { w: 20, quality: false, subclass: false },
];
const keyOf = (it, L) =>
  `${it.class}|${L.subclass ? it.subclass : "*"}|${slotOf(it)}|${L.quality ? it.quality : "*"}|${band(it.item_level, L.w)}|${L.w}`;

// "Rare ilvl 60-64 Plate Chest" -- the phrase the page prints as "vs. typical <label>".
// Weapon subclasses already carry the hand ("One-Handed Sword"), so the slot is
// dropped there; Miscellaneous armor (rings, trinkets, cloaks, necks) is the reverse
// -- its subclass says nothing, so the slot carries the label.
function labelOf(it, L) {
  const lo = band(it.item_level, L.w);
  const parts = [];
  if (L.quality) parts.push(QUALITY[it.quality]?.name || "");
  parts.push(`ilvl ${lo}–${lo + L.w - 1}`);
  if (it.class === 2) {
    // Without the subclass the slot has to carry the label ("One-Hand Weapon"),
    // or every weapon cohort at that level would read just "Weapon".
    parts.push((L.subclass && WEAPON_SUBCLASS[it.subclass]) ||
      `${INV_TYPE[slotOf(it)] || ""} Weapon`.trim());
  } else {
    const sub = L.subclass ? ARMOR_SUBCLASS[it.subclass] : "";
    if (sub && it.subclass !== 0) parts.push(sub);
    parts.push(INV_TYPE[it.inventory_type] || "Armor");
  }
  return parts.filter(Boolean).join(" ");
}

const median = (sorted) => (sorted.length ? sorted[sorted.length >> 1] : 0);

// Competition rank (1 = highest, ties share a rank) of each value in `vals`.
function ranks(vals) {
  const sorted = [...vals].sort((a, b) => b - a);
  const rank = new Map();
  for (let i = 0; i < sorted.length; i++) if (!rank.has(sorted[i])) rank.set(sorted[i], i + 1);
  return rank;
}

/**
 * @param {Array} items  gear rows: entry, class, subclass, inventory_type, quality,
 *                       item_level, armor, dmg_min1, dmg_max1, delay
 * @param {Map<number, number>} statTotal  entry -> sum of the five base stats
 * @returns {{cohorts: Array, peers: Array}}
 */
export function deriveItemPeers(items, statTotal) {
  // Pass 1: group every item under every candidate key. A cohort's membership is
  // ALL items that share its key -- including ones that end up assigned to a finer
  // cohort of their own. (Counting only the fall-through items would leave the
  // coarse cohorts a handful of leftovers, i.e. exactly the un-representative
  // baseline PEER_MIN exists to prevent.)
  const groups = COHORT_LEVELS.map(() => new Map());
  for (const it of items) {
    for (let i = 0; i < COHORT_LEVELS.length; i++) {
      const k = keyOf(it, COHORT_LEVELS[i]);
      let g = groups[i].get(k);
      if (!g) groups[i].set(k, (g = []));
      g.push(it);
    }
  }
  // Pass 2: assign every item the finest cohort that clears PEER_MIN.
  const used = new Map();     // "level|key" -> { level, sample, items }
  const assigned = new Map(); // entry -> cohort key
  for (const it of items) {
    for (let i = 0; i < COHORT_LEVELS.length; i++) {
      const k = keyOf(it, COHORT_LEVELS[i]);
      const g = groups[i].get(k);
      if (g.length < PEER_MIN) continue;
      const uk = `${i}|${k}`;
      if (!used.has(uk)) used.set(uk, { level: COHORT_LEVELS[i], sample: it, items: g });
      assigned.set(it.entry, uk);
      break;
    }
  }
  // Pass 3: per cohort, median + rank each metric over the members that HAVE it
  // (an off-hand held item has no armor; a chest has no DPS). Ranks cover the whole
  // key group, but only the items ASSIGNED to this cohort get a peer row -- an item
  // assigned to a finer cohort is a peer here, not a member.
  const cohorts = [], peers = [];
  let id = 0;
  for (const [uk, m] of used) {
    id++;
    const vals = { armor: [], dps: [], stats: [] };
    const own = new Map();
    for (const it of m.items) {
      const v = { armor: armorOf(it), dps: dpsOf(it), stats: statTotal.get(it.entry) || 0 };
      own.set(it.entry, v);
      for (const k in vals) if (v[k] > 0) vals[k].push(v[k]);
    }
    const sorted = { armor: [...vals.armor].sort((a, b) => a - b), dps: [...vals.dps].sort((a, b) => a - b), stats: [...vals.stats].sort((a, b) => a - b) };
    const rk = { armor: ranks(vals.armor), dps: ranks(vals.dps), stats: ranks(vals.stats) };
    cohorts.push({
      id, label: labelOf(m.sample, m.level), n: m.items.length,
      n_armor: vals.armor.length, n_dps: vals.dps.length, n_stats: vals.stats.length,
      armor: median(sorted.armor), dps: median(sorted.dps), stats: median(sorted.stats),
    });
    let rows = 0;
    for (const it of m.items) {
      if (assigned.get(it.entry) !== uk) continue;
      const v = own.get(it.entry);
      // Nothing to compare (shirts, tabards, empty off-hands) -> no row at all.
      if (!(v.armor > 0 || v.dps > 0 || v.stats > 0)) continue;
      rows++;
      peers.push({
        item: it.entry, cohort: id,
        armor: v.armor, dps: Math.round(v.dps * 10) / 10, stats: v.stats,
        armor_rank: v.armor > 0 ? rk.armor.get(v.armor) : null,
        dps_rank: v.dps > 0 ? rk.dps.get(v.dps) : null,
        stats_rank: v.stats > 0 ? rk.stats.get(v.stats) : null,
      });
    }
    if (!rows) { cohorts.pop(); id--; }  // every member was metric-less
  }
  return { cohorts, peers, unassigned: items.length - assigned.size };
}
