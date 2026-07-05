// Character gear loadouts. Build a "character", assign an item per equipment slot,
// and import/export the JSON produced by the GearExport addon
// (https://github.com/Xian55/GearExport): an array of { name, slots: { <Slot>:
// { itemId, obtained } } }. Everything persists to localStorage -- there is no
// backend -- so loadouts survive reloads on this browser.
import { query } from "./db.js";
import { qItemsIn, qItemStatsIn, qEnchantsIn, qRandomSuffixIn, qItemSearchInv } from "./queries.js";
import { itemLink, questLink, spellLink, sourceTags, iconImg, qualityColor, esc } from "./render.js";
import { ftsQuery, trigramQuery } from "./search.js";
import { GEAR_STAT_LABEL, STAT_WEIGHT_PRESETS, STAT_WEIGHT_PRESET_MAP, CLASS_MASK } from "./constants.js";

const KEY = "tw_characters";

// GearExport's slot keys, in paperdoll display order + which column they render in
// (l = left body, r = right body, w = weapons row). These 17 are exactly what the
// addon exports (no Shirt/Tabard).
const SLOTS = [
  { k: "Head", label: "Head", col: "l" },
  { k: "Neck", label: "Neck", col: "l" },
  { k: "Shoulder", label: "Shoulder", col: "l" },
  { k: "Back", label: "Back", col: "l" },
  { k: "Chest", label: "Chest", col: "l" },
  { k: "Wrist", label: "Wrist", col: "l" },
  { k: "Hands", label: "Hands", col: "r" },
  { k: "Waist", label: "Waist", col: "r" },
  { k: "Legs", label: "Legs", col: "r" },
  { k: "Feet", label: "Feet", col: "r" },
  { k: "Finger1", label: "Ring 1", col: "r" },
  { k: "Finger2", label: "Ring 2", col: "r" },
  { k: "Trinket1", label: "Trinket 1", col: "r" },
  { k: "Trinket2", label: "Trinket 2", col: "r" },
  { k: "MainHand", label: "Main Hand", col: "w" },
  { k: "OffHand", label: "Off Hand", col: "w" },
  { k: "Ranged", label: "Ranged", col: "w" },
];
const SLOT_KEYS = new Set(SLOTS.map((s) => s.k));

// Which inventory_types can fill each slot (for the upgrade finder): chest covers
// robes (20) too; weapons span 1H/main-hand/2H etc. Empty slots use these to
// suggest candidates from scratch.
const SLOT_INV = {
  Head: [1], Neck: [2], Shoulder: [3], Back: [16], Chest: [5, 20], Wrist: [9],
  Hands: [10], Waist: [6], Legs: [7], Feet: [8], Finger1: [11], Finger2: [11],
  Trinket1: [12], Trinket2: [12], MainHand: [13, 21, 17], OffHand: [13, 14, 22, 23], Ranged: [15, 26, 25, 28],
};
const ALL_INV = [...new Set(Object.values(SLOT_INV).flat())];

// Candidate inv-types for a weapon slot depend on what's equipped: a 1H main-hand
// should suggest 1H, not a 2H (which would drop the off-hand), and vice versa.
// inv: 13 One-Hand, 21 Main Hand, 17 Two-Hand, 14 Shield, 22 Off Hand, 23 Held-off.
function slotInvFor(k, eqInv) {
  if (k === "MainHand") {
    if (eqInv === 17) return [17];                       // 2H equipped -> 2H
    if (eqInv === 13 || eqInv === 21) return [13, 21];   // 1H equipped -> 1H
    return SLOT_INV.MainHand;                             // empty -> any weapon
  }
  if (k === "OffHand") {
    if (eqInv === 14) return [14];                       // shield -> shields
    if (eqInv === 23) return [23];                       // held-in-off-hand -> same
    if (eqInv === 13 || eqInv === 22) return [13, 22];   // off-hand weapon -> 1H
    return SLOT_INV.OffHand;                             // empty -> any off-hand
  }
  return SLOT_INV[k];
}

// Playable races (1.12 cores + Turtle customs High Elf 512 / Goblin 256) with the
// allowable_race bit + side. Lets upgrades drop items a race can't use and
// opposite-faction quest rewards. Only applied when the character's race is set.
const RACES = [
  { bit: 1, name: "Human", side: "A" }, { bit: 4, name: "Dwarf", side: "A" },
  { bit: 8, name: "Night Elf", side: "A" }, { bit: 64, name: "Gnome", side: "A" }, { bit: 512, name: "High Elf", side: "A" },
  { bit: 2, name: "Orc", side: "H" }, { bit: 16, name: "Undead", side: "H" }, { bit: 32, name: "Tauren", side: "H" },
  { bit: 128, name: "Troll", side: "H" }, { bit: 256, name: "Goblin", side: "H" },
];
const sideOfRace = (bit) => RACES.find((r) => r.bit === bit)?.side || null;
// accept a race from the addon JSON as a bit number or a name ("Night Elf"/"NightElf")
function raceBitFrom(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).toLowerCase().replace(/[^a-z]/g, "");
  return RACES.find((r) => r.name.toLowerCase().replace(/[^a-z]/g, "") === s)?.bit || null;
}
function classBitFrom(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).toLowerCase().replace(/[^a-z]/g, "");
  return CLASS_MASK.find(([, n]) => n.toLowerCase() === s)?.[0] || null;
}
// Standard 1.12 proficiencies: armor subclasses (0 Misc/1 Cloth/2 Leather/3 Mail/
// 4 Plate/6 Shield/7 Libram/8 Idol/9 Totem) and weapon subclasses (0 1H-Axe/1 2H-
// Axe/2 Bow/3 Gun/4 1H-Mace/5 2H-Mace/6 Polearm/7 1H-Sword/8 2H-Sword/10 Staff/
// 13 Fist/15 Dagger/16 Thrown/18 Crossbow/19 Wand) each class can equip. Used to
// drop e.g. plate for a mage or a staff for a paladin. allowable_class (when the
// item sets it) is authoritative and checked in addition to this.
const CLASS_PROF = {
  1:    { armor: [0, 1, 2, 3, 4, 6],    weap: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 15, 16, 18] }, // Warrior
  2:    { armor: [0, 1, 2, 3, 4, 6, 7], weap: [0, 1, 4, 5, 6, 7, 8] },                            // Paladin
  4:    { armor: [0, 1, 2, 3],          weap: [0, 1, 2, 3, 6, 7, 8, 10, 13, 15, 16, 18] },        // Hunter
  8:    { armor: [0, 1, 2],             weap: [2, 3, 4, 7, 13, 15, 16, 18] },                      // Rogue
  16:   { armor: [0, 1],                weap: [4, 10, 15, 19] },                                   // Priest
  64:   { armor: [0, 1, 2, 3, 6, 9],    weap: [0, 1, 4, 5, 10, 13, 15] },                          // Shaman
  128:  { armor: [0, 1],                weap: [7, 10, 15, 19] },                                   // Mage
  256:  { armor: [0, 1],                weap: [7, 10, 15, 19] },                                   // Warlock
  1024: { armor: [0, 1, 2, 8],          weap: [4, 5, 6, 10, 13, 15] },                             // Druid
};
// every stat the scoring fetch needs: preset keys + all gear stats (so a Custom
// spec can weight any of them). GEAR_STAT_LABEL keys are the item_stats stat keys.
const SCORE_KEYS = [...new Set([...Object.keys(GEAR_STAT_LABEL), ...STAT_WEIGHT_PRESETS.flatMap((p) => Object.keys(p.weights))])];
// weightable stats = item_stats-backed gear stats + "speed" (weapon swing time in
// seconds, injected in gearData; negative weight favours faster weapons).
const STAT_LABELS = { ...GEAR_STAT_LABEL, speed: "Weapon Speed" };
const WEIGHT_STATS = Object.entries(STAT_LABELS); // [key, label] for the custom editor
const statLabel = (k) => STAT_LABELS[k] || k;
const scoreWith = (statMap, weights) => { let s = 0; for (const k in weights) s += weights[k] * (statMap[k] || 0); return s; };
const round1 = (n) => Math.round(n * 10) / 10;

// Guess a spec from the character's own total stats: the preset whose weights best
// "explain" the gear (normalized by total weight so heavy-weight presets don't
// always win). Draws from the Leveling presets below 58, else Max level. Just a
// default -- the picker overrides it.
function guessSpec(totals, level) {
  const group = level < 58 ? "Leveling" : "Max level";
  let best = null, bestScore = -Infinity;
  for (const p of STAT_WEIGHT_PRESETS) {
    if (p.group !== group) continue;
    const wsum = Object.values(p.weights).reduce((a, b) => a + Math.abs(b), 0) || 1;
    const s = scoreWith(totals, p.weights) / wsum;
    if (s > bestScore) { bestScore = s; best = p.id; }
  }
  return best || STAT_WEIGHT_PRESETS[0].id;
}

// One-time fetch (cached) of every obtainable, equippable item + a per-item stat
// map, so re-scoring for a different spec is instant (no re-query).
let _gear = null;
async function gearData() {
  if (_gear) return _gear;
  const [cands, stats] = await Promise.all([
    query(`SELECT i.entry, i.name, i.quality, i.inventory_type AS inv, i.item_level AS ilvl, i.required_level AS req,
                  i.quest_min_level AS qml, i.quest_faction AS qf, i.allowable_race AS ar,
                  i.class AS icls, i.subclass AS isub, i.allowable_class AS ac, i.delay AS delay, di.icon
           FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id
           WHERE i.inventory_type IN (${ALL_INV.join(",")}) AND i.name <> ''
             AND EXISTS (SELECT 1 FROM item_sources s WHERE s.item = i.entry)`, []),
    query(`SELECT item, stat, value FROM item_stats WHERE stat IN (${SCORE_KEYS.map((k) => `'${k}'`).join(",")})`, []),
  ]);
  const statMap = new Map();
  for (const r of stats) { let m = statMap.get(r.item); if (!m) { m = {}; statMap.set(r.item, m); } m[r.stat] = r.value; }
  const byInv = new Map();
  for (const c of cands) {
    if (TEST_ITEM_RE.test(c.name)) continue; // drop test/deprecated/placeholder items
    // inject weapon speed (delay in seconds) as a pseudo-stat so specs can weight it
    // (a NEGATIVE weight favours faster weapons -- e.g. a paladin tank's mana regen)
    if (c.delay) { let m = statMap.get(c.entry); if (!m) { m = {}; statMap.set(c.entry, m); } m.speed = c.delay / 1000; }
    let a = byInv.get(c.inv); if (!a) { a = []; byInv.set(c.inv, a); } a.push(c);
  }
  _gear = { statMap, byInv };
  return _gear;
}
// name markers for non-real items (test/placeholder/deprecated) never to suggest.
const TEST_ITEM_RE = /\b(test|deprecated|placeholder|unused|debug|beta|qa)\b|\[ph\]|\(ph\)|\(test\)|\(old\)|do ?not ?use|monster -/i;

// For each slot, the top-N obtainable items of that slot that out-score the
// equipped item (or top-N outright for an empty slot) under the given spec, limited
// to items the character can equip now or soon: required_level <= level + lookAhead.
function weightsFor(ch, specId) {
  return specId === "custom" ? (ch.customWeights || {}) : (STAT_WEIGHT_PRESET_MAP[specId]?.weights || {});
}

const mergeStats = (a, b) => { const r = { ...a }; for (const k in b) r[k] = (r[k] || 0) + b[k]; return r; };

async function computeUpgrades(ch, specId, { level = 60, lookAhead = 3, slot = "", topN, eqInv = {}, eqBonus = {} } = {}) {
  const weights = weightsFor(ch, specId);
  const n = topN ?? (slot ? 15 : 5); // a single-slot search shows a deeper list
  const maxReq = level + lookAhead;
  // required_level alone doesn't gate content: most raid gear has required_level 0
  // but item_level 80-92. So also cap item level -- dungeon blues run ~8 ilvl over
  // the intended level; at 60 (endgame) raids open up, so drop the ilvl cap.
  const ilvlCap = level >= 60 ? Infinity : maxReq + 8;
  const race = ch.race || null;         // allowable_race bit; null = Any
  const side = race ? sideOfRace(race) : null;
  const cls = ch.cls || null;           // class bit; null = Any
  const prof = cls ? CLASS_PROF[cls] : null;
  // is candidate c usable by this race + faction + class? drops race/class-locked
  // items, opposite-faction quest rewards, and gear the class can't wield (plate on
  // a mage, a staff on a paladin).
  const allowed = (c) => {
    if (race) {
      if (c.ar && c.ar !== -1 && (c.ar & race) === 0) return false;     // race-restricted
      if (side === "A" && c.qf === 2) return false;                     // Horde-only quest reward
      if (side === "H" && c.qf === 1) return false;                     // Alliance-only quest reward
    }
    if (cls) {
      if (c.ac && c.ac !== -1 && (c.ac & cls) === 0) return false;      // class-restricted item
      if (prof) {
        if (c.icls === 4 && !prof.armor.includes(c.isub)) return false; // armor type not usable
        if (c.icls === 2 && !prof.weap.includes(c.isub)) return false;  // weapon type not usable
      }
    }
    return true;
  };
  const { statMap, byInv } = await gearData();
  const scoreOf = (id) => (id ? scoreWith(statMap.get(id) || {}, weights) : 0);
  const out = [];
  for (const s of SLOTS) {
    if (slot && s.k !== slot) continue;
    const equippedId = ch.slots?.[s.k]?.itemId || null;
    // fold the equipped item's random-suffix stats into its baseline
    const eqStats = eqBonus[s.k] ? mergeStats(statMap.get(equippedId) || {}, eqBonus[s.k]) : (statMap.get(equippedId) || {});
    const base = equippedId ? scoreWith(eqStats, weights) : 0;
    const seen = new Set([equippedId]);
    const pool = slotInvFor(s.k, eqInv[s.k]).flatMap((t) => byInv.get(t) || []);
    // effective "available at" level: the item's own required_level, or -- for a
    // quest reward with a lower/zero req -- the min level to accept that quest.
    const availAt = (c) => Math.max(c.req || 0, c.qml || 0);
    // per-stat gains/losses vs the equipped item (non-zero deltas only).
    const diffVs = (c) => {
      const cs = statMap.get(c.entry) || {};
      const diff = {};
      for (const k of new Set([...Object.keys(cs), ...Object.keys(eqStats)])) {
        if (k === "speed") continue; // a weighting factor, not a "stat gain" line
        const d = (cs[k] || 0) - (eqStats[k] || 0);
        if (d) diff[k] = d;
      }
      return diff;
    };
    const ups = pool
      .filter((c) => availAt(c) <= maxReq && (c.ilvl || 0) <= ilvlCap && allowed(c))
      .map((c) => ({ ...c, score: scoreWith(statMap.get(c.entry) || {}, weights), avail: availAt(c), diff: diffVs(c) }))
      .filter((c) => c.score > base + 0.05 && !seen.has(c.entry))
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
    if (ups.length) out.push({ slot: s, equippedId, base, ups });
  }
  return out;
}

// Annotate the displayed upgrade items with where they come from: item_sources
// tags (drop/vendor/quest/craft/...) + the quests that reward them. Fetched only
// for the ~topN×slots items actually shown, so it's a lean pair of IN queries.
async function attachSources(list) {
  const ids = [...new Set(list.flatMap((b) => b.ups.map((c) => c.entry)))];
  if (!ids.length) return;
  const ph = ids.map((_, i) => `?${i + 1}`).join(",");
  const [srcs, quests] = await Promise.all([
    query(`SELECT item, GROUP_CONCAT(DISTINCT source) s FROM item_sources WHERE item IN (${ph}) GROUP BY item`, ids),
    query(`SELECT qi.item, q.entry, q.title FROM quest_item qi JOIN quests q ON q.entry = qi.quest
           WHERE qi.role IN ('reward','choice') AND q.hidden = 0 AND qi.item IN (${ph})`, ids),
  ]);
  const srcMap = new Map(srcs.map((r) => [r.item, r.s]));
  const qMap = new Map();
  for (const r of quests) { let a = qMap.get(r.item); if (!a) { a = []; qMap.set(r.item, a); } a.push(r); }
  for (const b of list) for (const c of b.ups) { c.srcKeys = srcMap.get(c.entry) || ""; c.quests = (qMap.get(c.entry) || []).slice(0, 3); }
}

function specSelect(sel) {
  const groups = {};
  for (const p of STAT_WEIGHT_PRESETS) (groups[p.group] ??= []).push(p);
  return `<select id="charSpec">${Object.entries(groups).map(([g, ps]) =>
    `<optgroup label="${esc(g)}">${ps.map((p) => `<option value="${p.id}"${p.id === sel ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</optgroup>`).join("")}
    <option value="custom"${sel === "custom" ? " selected" : ""}>Custom…</option></select>`;
}

function slotSelect(sel) {
  return `<select id="charSlot"><option value=""${sel ? "" : " selected"}>All slots</option>${
    SLOTS.map((s) => `<option value="${s.k}"${s.k === sel ? " selected" : ""}>${esc(s.label)}</option>`).join("")}</select>`;
}

function raceSelect(sel) {
  const opt = (r) => `<option value="${r.bit}"${r.bit === sel ? " selected" : ""}>${esc(r.name)}</option>`;
  return `<select id="charRace"><option value=""${sel ? "" : " selected"}>Any</option>
    <optgroup label="Alliance">${RACES.filter((r) => r.side === "A").map(opt).join("")}</optgroup>
    <optgroup label="Horde">${RACES.filter((r) => r.side === "H").map(opt).join("")}</optgroup></select>`;
}
function classSelect(sel) {
  return `<select id="charClass"><option value=""${sel ? "" : " selected"}>Any</option>${
    CLASS_MASK.map(([b, n]) => `<option value="${b}"${b === sel ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
}

// Custom stat-weight editor (shown when spec = Custom): stat + multiplier rows.
function weightRowHtml(k, w) {
  return `<div class="cw-row">
    <select class="cw-stat"><option value="">Stat…</option>${WEIGHT_STATS.map(([v, l]) => `<option value="${v}"${v === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
    <span class="cw-x">×</span>
    <input type="number" class="cw-val" step="0.5" value="${esc(String(w))}" placeholder="1">
    <button type="button" class="cw-rm" title="Remove">✕</button>
  </div>`;
}
// Read-only view of a preset's weights (transparency) + a Customize button that
// copies them into the editable custom editor.
function specWeightsHtml(specId) {
  if (specId === "custom") return "";
  const w = STAT_WEIGHT_PRESET_MAP[specId]?.weights;
  if (!w) return "";
  const pills = Object.entries(w).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([k, v]) => `<span class="wpill">${esc(statLabel(k))} <b>×${v}</b></span>`).join("<span class=\"wsep\">·</span>");
  return `<span class="muted spec-weights-lbl">Weights:</span> ${pills} <button type="button" class="btn-sm" id="charCustomize">Customize →</button>`;
}
function customEditor(weights) {
  const entries = Object.entries(weights || {});
  const rows = (entries.length ? entries : [["", ""]]).map(([k, w]) => weightRowHtml(k, w)).join("");
  return `<div class="cw-rows">${rows}</div>
    <button type="button" class="btn-sm" id="cwAdd">+ stat</button>
    <span class="muted cw-hint">Score = Σ (stat value × weight).</span>`;
}
function readCustom(root) {
  const w = {};
  root.querySelectorAll(".cw-row").forEach((row) => {
    const k = row.querySelector(".cw-stat").value;
    const v = Number(row.querySelector(".cw-val").value);
    if (k && Number.isFinite(v) && v !== 0) w[k] = v;
  });
  return w;
}

// stat gains (green) / losses (red) vs the equipped item, in GEAR_STAT_LABEL order.
function diffHtml(diff) {
  if (!diff) return "";
  const ordered = Object.keys(GEAR_STAT_LABEL).filter((k) => diff[k]);
  const extra = Object.keys(diff).filter((k) => !GEAR_STAT_LABEL[k]);
  const all = [...ordered, ...extra];
  if (!all.length) return "";
  return `<div class="up-diff">${all.map((k) => {
    const d = diff[k];
    return `<span class="dstat ${d > 0 ? "gain" : "loss"}">${d > 0 ? "+" : ""}${d.toLocaleString()} ${esc(GEAR_STAT_LABEL[k] || k)}</span>`;
  }).join("")}</div>`;
}

function upgradesHtml(list, itemMap) {
  if (!list.length) return `<p class="muted">No higher-scoring upgrades found for this spec.</p>`;
  return list.map(({ slot, equippedId, base, ups }) => {
    const eq = equippedId && itemMap.get(equippedId);
    // equipped baseline row at the top of each slot's table
    const eqRow = `<tr class="up-eq">
      <td class="up-item">${eq ? `${itemLink(eq.entry, eq.name, eq.quality, eq.icon)} <span class="up-tag">equipped</span>` : `<span class="muted">— empty —</span>`}</td>
      <td class="up-num">${round1(base)}</td><td class="up-num">—</td><td></td><td></td></tr>`;
    const rows = ups.map((c) => {
      const quests = (c.quests || []).map((q) => questLink(q.entry, q.title)).join(" ");
      return `<tr>
        <td class="up-item">${itemLink(c.entry, c.name, c.quality, c.icon)}${c.avail ? ` <span class="up-lvl" title="Available at level">lvl ${c.avail}</span>` : ""}</td>
        <td class="up-num">${round1(c.score)}</td>
        <td class="up-num"><span class="up-gain">+${round1(c.score - base)}</span></td>
        <td class="up-change">${diffHtml(c.diff)}</td>
        <td class="up-src">${sourceTags(c.srcKeys)}${quests}</td>
      </tr>`;
    }).join("");
    return `<div class="up-table-wrap"><table class="up-table">
      <thead><tr><th>${esc(slot.label)}</th><th class="up-num">Score</th><th class="up-num">Gain</th><th>Stat change</th><th>Source</th></tr></thead>
      <tbody>${eqRow}${rows}</tbody></table></div>`;
  }).join("");
}

// ---- storage ----
function load() { try { const a = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } }
function persist(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ } }
function getChar(id) { return load().find((c) => c.id === id) || null; }
function upsert(ch) { const l = load(); const i = l.findIndex((c) => c.id === ch.id); if (i >= 0) l[i] = ch; else l.push(ch); persist(l); }
function remove(id) { persist(load().filter((c) => c.id !== id)); }
function newId() { return "c" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

const filledCount = (ch) => Object.values(ch.slots || {}).filter((s) => s && s.itemId).length;

// GearExport-compatible export: array of { name, race?, class?, slots } (drop our
// internal id/settings). race/class round-trip as names; slots keep enchantId.
const toExportJson = (ch) => {
  const out = { name: ch.name };
  if (ch.race) out.race = RACES.find((r) => r.bit === ch.race)?.name;
  if (ch.cls) out.class = CLASS_MASK.find(([b]) => b === ch.cls)?.[1];
  out.slots = ch.slots || {};
  return JSON.stringify([out], null, 2);
};

// Normalize one imported { name, race?, class?, slots } loadout into a stored
// character. Keeps only known slot keys; accepts { itemId, enchantId?, obtained }
// or a bare numeric item id.
function normalize(entry) {
  const slots = {};
  const src = entry && typeof entry.slots === "object" && entry.slots ? entry.slots : {};
  for (const k of Object.keys(src)) {
    if (!SLOT_KEYS.has(k)) continue;
    const v = src[k];
    const obj = v && typeof v === "object";
    const itemId = Number(obj ? v.itemId : v);
    if (!itemId) continue;
    const enchantId = obj && v.enchantId ? Number(v.enchantId) : 0;
    const suffixId = obj && v.suffixId ? Number(v.suffixId) : 0;
    slots[k] = { itemId, obtained: obj && "obtained" in v ? !!v.obtained : true, ...(enchantId ? { enchantId } : {}), ...(suffixId ? { suffixId } : {}) };
  }
  const race = raceBitFrom(entry && entry.race);
  const cls = classBitFrom(entry && entry.class);
  const level = Math.round(Number(entry && entry.level)) || 0;
  return {
    id: newId(), name: String((entry && entry.name) || "Imported character").slice(0, 60), slots,
    ...(race ? { race } : {}), ...(cls ? { cls } : {}), ...(level > 0 && level <= 60 ? { level } : {}),
  };
}

function exportChar(ch, msgEl) {
  if (!ch) return;
  const json = toExportJson(ch);
  navigator.clipboard?.writeText(json).catch(() => {});
  try {
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(ch.name || "character").replace(/[^\w-]+/g, "_")}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  } catch { /* download blocked -> clipboard copy still ran */ }
  if (msgEl) { msgEl.textContent = "Copied to clipboard + downloaded."; setTimeout(() => { msgEl.textContent = ""; }, 2500); }
}

const errorBox = (e) => `<div class="home"><h1>Something went wrong</h1><p class="muted">${esc(String(e && e.message || e))}</p></div>`;

// ---- manager: ?characters ----
export function showCharacters(navigate) {
  document.title = "Characters - Tortoise-WoW DB";
  const app = document.getElementById("app");
  const chars = load();
  const rows = chars.length
    ? chars.map((c) => `<li class="char-row">
        <a class="nav char-open" href="?character=${c.id}">${esc(c.name)}</a>
        <span class="muted char-count">${filledCount(c)}/${SLOTS.length} slots</span>
        <span class="char-actions">
          <button type="button" class="btn-sm" data-exp="${c.id}">Export</button>
          <button type="button" class="btn-sm danger" data-del="${c.id}">Delete</button>
        </span>
      </li>`).join("")
    : `<li class="muted">No characters yet — create one, or import a GearExport JSON below.</li>`;
  app.innerHTML = `<div class="chars">
    <h1>Characters</h1>
    <p class="muted">Build gear loadouts, saved in this browser. Import/export the
      <a class="ext" href="https://github.com/Xian55/GearExport" target="_blank" rel="noopener">GearExport</a> addon's JSON.</p>
    <div class="char-toolbar"><button type="button" class="btn" id="charNew">+ New character</button></div>
    <ul class="char-list">${rows}</ul>
    <details class="char-import"${chars.length ? "" : " open"}>
      <summary>Import GearExport JSON</summary>
      <textarea id="charJson" rows="10" spellcheck="false" placeholder='[{"name":"My Gear","slots":{"Head":{"itemId":83216,"obtained":true}, ...}}]'></textarea>
      <div class="char-import-actions"><button type="button" class="btn" id="charImport">Import</button>
        <span class="muted" id="charImportMsg"></span></div>
    </details>
  </div>`;

  app.querySelector("#charNew").onclick = () => {
    // create with a default name; the character page has inline Rename
    const ch = { id: newId(), name: "New character", slots: {} };
    upsert(ch); navigate(`?character=${ch.id}`);
  };
  app.querySelector("#charImport").onclick = () => {
    const raw = app.querySelector("#charJson").value.trim();
    const msg = app.querySelector("#charImportMsg");
    if (!raw) { msg.textContent = "Paste JSON first."; return; }
    let data; try { data = JSON.parse(raw); } catch { msg.textContent = "Invalid JSON."; return; }
    const made = (Array.isArray(data) ? data : [data]).map(normalize);
    if (!made.length) { msg.textContent = "No loadouts found."; return; }
    const l = load(); l.push(...made); persist(l);
    navigate(made.length === 1 ? `?character=${made[0].id}` : "?characters");
  };
  app.querySelectorAll("[data-del]").forEach((b) => {
    let armed = false, t = 0;
    b.onclick = () => {
      if (!armed) { armed = true; b.textContent = "Confirm?"; b.classList.add("armed"); t = setTimeout(() => { armed = false; b.textContent = "Delete"; b.classList.remove("armed"); }, 3000); }
      else { clearTimeout(t); remove(b.dataset.del); navigate("?characters", true); }
    };
  });
  app.querySelectorAll("[data-exp]").forEach((b) => { b.onclick = () => exportChar(getChar(b.dataset.exp)); });
}

// ---- gear sheet: ?character=<id> ----
export async function showCharacter(idOrChar, navigate) {
  const app = document.getElementById("app");
  // idOrChar is a localStorage id, or a decoded shared loadout object (?loadout=).
  const shared = idOrChar && typeof idOrChar === "object";
  const ch = shared ? idOrChar : getChar(idOrChar);
  const id = shared ? null : idOrChar;
  if (!ch) { app.innerHTML = `<div class="chars"><h1>Character not found</h1><p class="muted">Saved characters live only in the browser they were made in. Ask for a share link (📤 Share) instead.</p><p><a class="nav" href="?characters">← All characters</a></p></div>`; return; }
  const save = () => { if (!shared) upsert(ch); }; // shared loadouts are transient until "Save to my characters"
  document.title = `${ch.name} - Tortoise-WoW DB`;
  app.innerHTML = `<div class="loading">Loading ${esc(ch.name)}…</div>`;

  const ids = [...new Set(SLOTS.map((s) => ch.slots?.[s.k]?.itemId).filter(Boolean))];
  const enchIds = [...new Set(SLOTS.map((s) => ch.slots?.[s.k]?.enchantId).filter(Boolean))];
  const suffixIds = [...new Set(SLOTS.map((s) => ch.slots?.[s.k]?.suffixId).filter(Boolean))];
  const itemMap = new Map();
  const enchMap = new Map();
  const suffixMap = new Map();
  const statTotals = {};
  if (enchIds.length) {
    try { for (const r of await query(qEnchantsIn(enchIds.length), enchIds)) enchMap.set(r.id, r); } catch { /* enchant labels optional */ }
  }
  if (suffixIds.length) {
    try { for (const r of await query(qRandomSuffixIn(suffixIds.length), suffixIds)) suffixMap.set(r.id, { name: r.name, stats: JSON.parse(r.stats || "{}") }); } catch { /* suffix data optional */ }
  }
  // suffix stat bonus per slot (added to the equipped item's stats)
  const slotBonus = (k) => { const sid = ch.slots?.[k]?.suffixId; return sid ? (suffixMap.get(sid)?.stats || {}) : null; };
  if (ids.length) {
    let items, stats;
    try { [items, stats] = await Promise.all([query(qItemsIn(ids.length), ids), query(qItemStatsIn(ids.length), ids)]); }
    catch (e) { app.innerHTML = errorBox(e); return; }
    for (const it of items) itemMap.set(it.entry, it);
    const perItem = new Map();
    for (const r of stats) { let m = perItem.get(r.item); if (!m) { m = {}; perItem.set(r.item, m); } m[r.stat] = r.value; }
    // sum per FILLED slot so a duplicate item (e.g. two identical trinkets) counts twice
    for (const s of SLOTS) {
      const iid = ch.slots?.[s.k]?.itemId; if (!iid) continue;
      const m = perItem.get(iid);
      if (m) for (const k in m) statTotals[k] = (statTotals[k] || 0) + m[k];
      const bonus = slotBonus(s.k); // random-suffix stats
      if (bonus) for (const k in bonus) statTotals[k] = (statTotals[k] || 0) + bonus[k];
    }
  }

  // compact icon tile per slot: item icon (quality border) + tiny enchant/suffix
  // badges; name on hover (tooltip). ✎/✕ appear on hover.
  const tileHtml = (s) => {
    const slot = ch.slots?.[s.k];
    const it = slot && itemMap.get(slot.itemId);
    const suf = slot?.suffixId ? suffixMap.get(slot.suffixId) : null;
    const ench = slot?.enchantId ? enchMap.get(slot.enchantId) : null;
    const badges = [
      slot?.enchantId ? `<span class="gt-badge gt-ench" title="Enchant: ${esc(ench?.name || `#${slot.enchantId}`)}">⚚</span>` : "",
      slot?.suffixId ? `<span class="gt-badge gt-suf" title="Suffix: ${esc(suf?.name || `#${slot.suffixId}`)}">✦</span>` : "",
      slot?.obtained === false ? `<span class="gt-badge gt-unobt" title="Not yet obtained">◇</span>` : "",
    ].join("");
    const sufStatStr = suf?.stats ? Object.entries(suf.stats).map(([k, v]) => `+${v} ${GEAR_STAT_LABEL[k] || k}`).join(", ") : "";
    const ttData = [
      slot?.enchantId ? `data-tt-ench="${esc(ench?.name || `Enchant #${slot.enchantId}`)}"` : "",
      slot?.suffixId ? `data-tt-suffix="${esc(suf?.name || `Random suffix #${slot.suffixId}`)}"` : "",
      sufStatStr ? `data-tt-suffix-stats="${esc(sufStatStr)}"` : "",
    ].filter(Boolean).join(" ");
    const icon = it
      ? `<a class="ilink gear-icon" href="?item=${it.entry}" style="border-color:${qualityColor(it.quality)}" ${ttData}>${iconImg(it.icon, "gt-img")}</a>`
      : slot?.itemId
        ? `<span class="gear-icon miss" title="Item #${slot.itemId} — not in DB">?</span>`
        : `<span class="gear-icon empty"></span>`;
    return `<div class="gear-tile${slot?.itemId ? "" : " is-empty"}" data-slot="${s.k}">
      <div class="gt-wrap">${icon}${badges ? `<span class="gt-badges">${badges}</span>` : ""}
        <span class="gt-actions">
          <button type="button" class="slot-set gt-btn" data-slot="${s.k}" title="Change ${esc(s.label)}">✎</button>
          ${slot?.itemId ? `<button type="button" class="slot-clr gt-btn" data-slot="${s.k}" title="Clear">✕</button>` : ""}
        </span></div>
      <span class="gt-label">${esc(s.label)}</span>
    </div>`;
  };
  const statOrder = Object.keys(GEAR_STAT_LABEL).filter((k) => statTotals[k]);
  const summary = statOrder.length
    ? `<div class="char-summary"><h2>Total stats</h2><div class="stat-pills">
        ${statOrder.map((k) => `<span class="stat-pill">${esc(GEAR_STAT_LABEL[k])} <b>${statTotals[k].toLocaleString()}</b></span>`).join("")}
      </div></div>`
    : `<p class="muted char-nostats">No stat data for the equipped items.</p>`;

  const defaultSpec = ch.spec || guessSpec(statTotals, ch.level || 60);
  app.innerHTML = `<div class="char-view">
    <h1 class="char-title">${esc(ch.name)}</h1>
    <div class="char-toolbar">
      <a class="nav" href="?characters">← All characters</a>
      ${shared
        ? `<button type="button" class="btn" id="charSave">★ Save to my characters</button>`
        : `<button type="button" class="btn" id="charRename">Rename</button>
           <button type="button" class="btn" id="charShare">📤 Share</button>
           <button type="button" class="btn danger" id="charDelete">Delete</button>`}
      <button type="button" class="btn" id="charExport">Export JSON</button>
      <span class="muted" id="charMsg"></span>
    </div>
    ${shared ? `<p class="muted char-shared-note">Viewing a shared build. Edits won't stick — click <b>★ Save to my characters</b> to keep it.</p>` : ""}
    ${summary}
    <div class="char-sheet">${SLOTS.map(tileHtml).join("")}</div>
    <div class="char-upgrades">
      <h2>Suggested upgrades</h2>
      <div class="up-controls">
        <label>Spec ${specSelect(defaultSpec)}</label>
        <label>Class ${classSelect(ch.cls || "")}</label>
        <label>Race ${raceSelect(ch.race || "")}</label>
        <label>Slot ${slotSelect(ch.slotFilter || "")}</label>
        <label>My level <input type="number" id="charLevel" min="1" max="60" value="${ch.level || 60}"></label>
        <label>Look ahead <input type="number" id="charAhead" min="0" max="20" value="${ch.lookAhead ?? 3}"></label>
        <button type="button" class="btn" id="charFindUp">Find upgrades</button>
        <span class="muted" id="charUpMsg"></span>
      </div>
      <div id="charSpecWeights" class="spec-weights"></div>
      <div id="charCustom" class="cw-editor"${defaultSpec === "custom" ? "" : " hidden"}>${customEditor(ch.customWeights)}</div>
      <p class="muted up-note">Ranks obtainable items you could equip by level ${(ch.level || 60) + (ch.lookAhead ?? 3)} (your level + look-ahead).</p>
      <div id="charUpList"></div>
    </div>
  </div>`;

  const reload = () => showCharacter(shared ? ch : id, navigate);
  // inline rename (no prompt())
  app.querySelector("#charRename")?.addEventListener("click", () => {
    const h1 = app.querySelector(".char-title");
    h1.innerHTML = `<input type="text" class="rename-input" value="${esc(ch.name)}"> <button type="button" class="btn-sm rename-save">✓ Save</button>`;
    const input = h1.querySelector(".rename-input"); input.focus(); input.select();
    const doRename = () => { const v = input.value.trim(); if (v) ch.name = v; save(); reload(); };
    input.onkeydown = (e) => { if (e.key === "Enter") doRename(); else if (e.key === "Escape") reload(); };
    h1.querySelector(".rename-save").onclick = doRename;
  });
  // share: encode the loadout into a self-contained ?loadout= link (no localStorage)
  app.querySelector("#charShare")?.addEventListener("click", () => {
    const url = `${location.origin}${location.pathname}?loadout=${encodeLoadout(ch)}`;
    const msg = app.querySelector("#charMsg");
    Promise.resolve(navigator.clipboard?.writeText(url)).then(() => { if (msg) { msg.textContent = "Share link copied!"; setTimeout(() => { msg.textContent = ""; }, 2500); } }).catch(() => { if (msg) msg.textContent = "Copy failed"; });
  });
  // save a shared loadout into this browser's characters
  app.querySelector("#charSave")?.addEventListener("click", () => {
    const copy = { ...ch, id: newId() }; delete copy._shared;
    upsert(copy); navigate(`?character=${copy.id}`);
  });
  // two-click delete (no confirm())
  {
    const delBtn = app.querySelector("#charDelete"); let armed = false, t = 0;
    if (delBtn) delBtn.onclick = () => {
      if (!armed) { armed = true; delBtn.textContent = "Click again to delete"; delBtn.classList.add("armed"); t = setTimeout(() => { armed = false; delBtn.textContent = "Delete"; delBtn.classList.remove("armed"); }, 3000); }
      else { clearTimeout(t); remove(id); navigate("?characters"); }
    };
  }
  // upgrade finder: rank obtainable same-slot items by the chosen spec's gear score,
  // limited to items equippable by (my level + look-ahead)
  const specSel = app.querySelector("#charSpec");
  const classSel = app.querySelector("#charClass");
  const raceSel = app.querySelector("#charRace");
  const slotSel = app.querySelector("#charSlot");
  const lvlIn = app.querySelector("#charLevel");
  const aheadIn = app.querySelector("#charAhead");
  const customBox = app.querySelector("#charCustom");
  const specWeights = app.querySelector("#charSpecWeights");
  const upList = app.querySelector("#charUpList");
  const upMsg = app.querySelector("#charUpMsg");
  const note = app.querySelector(".up-note");
  const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt; };
  const runUpgrades = async () => {
    const specId = specSel.value;
    const level = clamp(lvlIn.value, 1, 60, 60);
    const lookAhead = clamp(aheadIn.value, 0, 20, 3);
    const slot = slotSel.value;
    lvlIn.value = level; aheadIn.value = lookAhead;
    if (specId === "custom") ch.customWeights = readCustom(customBox);
    ch.spec = specId; ch.level = level; ch.lookAhead = lookAhead; ch.slotFilter = slot;
    ch.race = raceSel.value ? Number(raceSel.value) : null;
    ch.cls = classSel.value ? Number(classSel.value) : null; save();
    note.textContent = `Ranks obtainable items you could equip by level ${level + lookAhead} (your level + look-ahead).`;
    // show the active preset's weights (transparency) + a Customize shortcut
    specWeights.innerHTML = specWeightsHtml(specId);
    const custBtn = specWeights.querySelector("#charCustomize");
    if (custBtn) custBtn.onclick = () => {
      ch.customWeights = { ...(STAT_WEIGHT_PRESET_MAP[specId]?.weights || {}) };
      specSel.value = "custom"; customBox.hidden = false;
      customBox.innerHTML = customEditor(ch.customWeights);
      runUpgrades();
    };
    upMsg.textContent = "Scoring…"; upList.innerHTML = "";
    // equipped inventory type + random-suffix bonus per slot
    const eqInv = {}, eqBonus = {};
    for (const s of SLOTS) { const it = itemMap.get(ch.slots?.[s.k]?.itemId); if (it) eqInv[s.k] = it.inv; const bo = slotBonus(s.k); if (bo) eqBonus[s.k] = bo; }
    try {
      const list = await computeUpgrades(ch, specId, { level, lookAhead, slot, eqInv, eqBonus });
      await attachSources(list);
      upList.innerHTML = upgradesHtml(list, itemMap);
      upMsg.textContent = list.length ? `${list.reduce((n, b) => n + b.ups.length, 0)} across ${list.length} slots` : "none found";
    } catch (e) { upMsg.textContent = "Failed: " + (e && e.message || e); }
  };
  app.querySelector("#charFindUp").onclick = runUpgrades;
  specSel.onchange = () => { customBox.hidden = specSel.value !== "custom"; runUpgrades(); };
  classSel.onchange = runUpgrades;
  raceSel.onchange = runUpgrades;
  slotSel.onchange = runUpgrades;
  lvlIn.onchange = runUpgrades;
  aheadIn.onchange = runUpgrades;
  // custom weight editor: edit a row -> re-score; +stat adds a blank row; ✕ removes
  customBox.addEventListener("change", (e) => { if (e.target.matches(".cw-stat, .cw-val")) runUpgrades(); });
  customBox.addEventListener("click", (e) => {
    if (e.target.closest("#cwAdd")) { customBox.querySelector(".cw-rows").insertAdjacentHTML("beforeend", weightRowHtml("", "")); }
    else if (e.target.matches(".cw-rm")) { e.target.closest(".cw-row").remove(); runUpgrades(); }
  });
  if (ch.spec) runUpgrades(); // remembered settings -> auto-run
  app.querySelector("#charExport").onclick = () => exportChar(ch, app.querySelector("#charMsg"));
  // inline slot editor (no browser prompt() -- some browsers suppress those):
  // ✎ swaps the item cell for a numeric input + save/cancel.
  const saveSlot = (k, v) => {
    const iid = Number(String(v).trim());
    ch.slots = ch.slots || {};
    if (iid) ch.slots[k] = { itemId: iid, obtained: true }; else delete ch.slots[k];
    save(); reload();
  };
  const closePop = () => app.querySelector(".slot-pop")?.remove();
  app.querySelectorAll(".slot-set").forEach((b) => { b.onclick = () => {
    const k = b.dataset.slot;
    const tile = b.closest(".gear-tile");
    closePop();
    const pop = document.createElement("div");
    pop.className = "slot-pop";
    pop.innerHTML = `<div class="slot-edit-row">
        <input type="text" class="slot-search" placeholder="Search ${esc(SLOTS.find((s) => s.k === k)?.label || "item")}…" autocomplete="off">
        <button type="button" class="slot-cancel" title="Cancel">✕</button></div>
      <div class="slot-results" hidden></div>`;
    tile.appendChild(pop);
    const input = pop.querySelector(".slot-search");
    const results = pop.querySelector(".slot-results");
    input.focus();
    const invCsv = SLOT_INV[k].join(",");
    let timer = 0, token = 0;
    const doSearch = async () => {
      const term = input.value.trim();
      const fts = ftsQuery(term);
      if (term.length < 2 || !fts) { results.hidden = true; results.innerHTML = ""; return; }
      const my = ++token;
      let rows;
      try { rows = await query(qItemSearchInv(invCsv), [fts, trigramQuery(term), `${term}%`]); }
      catch { return; }
      if (my !== token) return; // a newer keystroke superseded this
      results.hidden = false;
      results.innerHTML = rows.length
        ? rows.map((r) => `<button type="button" class="slot-result" data-id="${r.entry}">${iconImg(r.icon)}<span class="sr-name" style="color:${qualityColor(r.quality)}">${esc(r.name)}</span><span class="muted sr-ilvl">${r.item_level ? `iLvl ${r.item_level}` : ""}</span></button>`).join("")
        : `<div class="sr-empty muted">No matching items</div>`;
    };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(doSearch, 180); };
    input.onkeydown = (e) => { if (e.key === "Escape") closePop(); };
    results.onclick = (e) => { const rb = e.target.closest(".slot-result"); if (rb) saveSlot(k, rb.dataset.id); };
    pop.querySelector(".slot-cancel").onclick = closePop;
  }; });
  app.querySelectorAll(".slot-clr").forEach((b) => { b.onclick = () => { if (ch.slots) delete ch.slots[b.dataset.slot]; save(); reload(); }; });
}

// ---- shareable loadout links (?loadout=<b64url>) ----
// Encode the loadout (name/race/class/level/slots) into a compact URL param so a
// build is shareable without localStorage. race/class kept as internal bits.
function b64urlEncode(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlDecode(s) { return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))); }
function encodeLoadout(ch) {
  const p = { n: ch.name, r: ch.race || undefined, c: ch.cls || undefined, l: ch.level || undefined, s: ch.slots || {} };
  return b64urlEncode(JSON.stringify(p));
}
export function showSharedLoadout(encoded, navigate) {
  let ch;
  try {
    const p = JSON.parse(b64urlDecode(encoded));
    ch = { id: "shared", _shared: true, name: String(p.n || "Shared build").slice(0, 60), race: p.r || null, cls: p.c || null, level: p.l || null, slots: p.s || {} };
  } catch {
    document.getElementById("app").innerHTML = `<div class="chars"><h1>Invalid share link</h1><p><a class="nav" href="?characters">← All characters</a></p></div>`;
    return;
  }
  return showCharacter(ch, navigate);
}
