// Derive per-item gear stats for the multi-criteria browse filter.
//
// In 1.12 only base stats, resistances, armor and weapon damage are item_template
// columns. Everything else (spell power, hit, crit, attack power, weapon skills, …)
// lives in the item's EQUIP spell effects (spelltrigger == 1) as auras. The maps
// below were derived empirically from the server's own spell_template — see the
// (now-deleted) scripts/_discover_auras.mjs / _skill30.mjs that grouped every
// equip-spell effect by aura id and printed sample tooltip text. Each `value` is
// `effectBasePoints + 1` (the same $sN convention render.js uses), which matched
// the tooltip numbers exactly in discovery (e.g. "+4 Attack Power" -> base 3).
//
// Keys here MUST match GEAR_CRITERIA keys in src/constants.js and item_stats.stat.

// effectApplyAuraName id -> stat key. (Synonymous duplicate auras are intentionally
// omitted to avoid double counting: ranged/spell haste 140/65 ~ melee haste 138;
// block VALUE 158 vs reference's Block% 51.) Ranged AP (124, MOD_RANGED_ATTACK_POWER)
// IS tracked separately as its own `rangedAp` key so hunters can weight it independently
// of generic melee AP (99); generic "+N Attack Power" items carry both auras, which is
// correct in-game (generic AP raises ranged AP too).
// NOTE: aura 13 (MOD_DAMAGE_DONE) is handled separately in statsFromAuras -- its misc
// value is a spell-school mask, so school-specific spell power (+Fire dmg, +Shadow dmg)
// is split from generic "sp" (see SP_SCHOOL) instead of all lumping into `sp`.
export const AURA_STAT = {
  135: "heal",  // MOD_HEALING_DONE
  99: "ap",     // MOD_ATTACK_POWER
  124: "rangedAp", // MOD_RANGED_ATTACK_POWER (scopes, hunter-specific ranged AP)
  85: "mp5",    // MOD_POWER_REGEN ("Restores N mana per 5 sec")
  161: "hp5",   // health regen per 5
  8: "hp5",     // "Regenerate N health every 5 seconds"
  51: "block",  // chance to block % (NOT block value)
  52: "crit",   // melee/ranged crit %
  71: "spCrit", // spell crit %
  54: "hit",    // melee/ranged hit %
  55: "spHit",  // spell hit %
  47: "parry",  // parry %
  49: "dodge",  // dodge %
  138: "haste", // attack/casting speed %
  31: "runSpeed",  // MOD_INCREASE_SPEED -> movement/run speed % (boots, Highlander sets)
  58: "swimSpeed", // MOD_INCREASE_SWIM_SPEED -> swim speed %
  130: "mountSpeed", // MOD_INCREASE_MOUNTED_SPEED -> mount speed % (Carrot on a Stick, etc.)
};

// MOD_SKILL (aura 30) misc value = skill-line id -> stat key. Fishing (356) is
// included so fishing poles can show their "+N Fishing" bonus (the Fishing-Pole
// browse swaps DPS/Speed for this column); it is NOT a gear criterion (not in
// GEAR_CRITERIA), so it never appears in the stat dropdown -- browse already owns
// a `fishing` column, and a second one would collide with it.
// The other GATHERING professions are criteria (GEAR_CRITERIA "Profession Skill"):
// a skinner wanting the 61+ bosses needs more than the 300 cap, so "which items
// give +Skinning" is a real question -- likewise +Herbalism/+Mining. Fist Weapons
// (162, no reference option) and the crafting professions (no items grant them)
// stay excluded.
export const MOD_SKILL_AURA = 30;
export const SKILL_STAT = {
  95: "def",
  356: "fishing",
  393: "skinning", 182: "herbalism", 186: "mining",
  43: "wSwords", 44: "wAxes", 54: "wMaces", 173: "wDaggers", 229: "wPolearms",
  55: "w2hSwords", 172: "w2hAxes", 160: "w2hMaces", 45: "wBows", 46: "wGuns", 226: "wCrossbows",
};

// aura 13 (MOD_DAMAGE_DONE) misc = spell-school MASK. A single school bit -> that
// school's spell-power key; a multi-school mask (126 = all magic, 127 = +physical)
// -> generic "sp". This lets the gear scorer ignore off-school spell power (e.g.
// +Fire damage is dead weight for a Frost mage). School bits: 2 holy, 4 fire,
// 8 nature, 16 frost, 32 shadow, 64 arcane (1 = physical, not spell power).
const SCHOOL_MAGIC = 126; // 2|4|8|16|32|64
const SP_SCHOOL = { 2: "spHoly", 4: "spFire", 8: "spNature", 16: "spFrost", 32: "spShadow", 64: "spArcane" };

// item_template stat_type id -> base stat key (see STAT_TYPE in src/constants.js).
// The five 1.12 primaries are the only ids a vanilla item ever sets in these columns
// -- everything else (crit, hit, ...) is an equip-spell aura there, read by
// statsFromAuras. TBC moved the rest ONTO these columns as ratings, so the wider
// ITEM_MOD_STAT map is folded in below; see statsFromColumns.
const STAT_TYPE_KEY = { 4: "str", 3: "agi", 7: "sta", 5: "int", 6: "spi" };

// ITEM_MOD id -> gear stat key. Ids match src/constants.js STAT_TYPE. Shared by two
// readers: TBC item COLUMNS (statsFromColumns) and SpellItemEnchantment's type-5
// effects (statsFromEnchant) -- both speak this same enum. Ids omitted here are the
// ones with no GEAR_CRITERIA counterpart (resilience, expertise, armor pen, spell
// penetration): 1.12 has no such stat, so there is no key to score them against.
export const ITEM_MOD_STAT = {
  3: "agi", 4: "str", 5: "int", 6: "spi", 7: "sta",
  12: "def", 13: "dodge", 14: "parry", 15: "block",
  16: "hit", 17: "hit", 18: "spHit",
  19: "crit", 20: "crit", 21: "spCrit",
  28: "haste", 29: "haste", 30: "haste", 36: "haste",
  31: "hit", 32: "crit",
  38: "ap", 39: "rangedAp", 40: "feralAp",
  41: "heal", 42: "sp", 43: "mp5", 45: "sp", 46: "hp5",
  // TBC-only stats. Safe to map unconditionally: a 1.12 item never sets these ids
  // (measured across all of Turtle), so on a vanilla build they simply never fire --
  // and GEAR_CRITERIA only offers them as filters on a TBC dataset.
  35: "resil", 37: "expertise",
};
// resistance column -> stat key (no holy: the reference has no Holy Resistance option).
const RES_COL = {
  fire_res: "firRes", nature_res: "natRes", frost_res: "froRes",
  shadow_res: "shaRes", arcane_res: "arcRes",
};

// Sum a contribution into an accumulator, ignoring falsy values.
function add(out, key, v) {
  if (key && v) out[key] = (out[key] || 0) + v;
}

// Every stat_type id we can read off an item's columns. Vanilla items only ever set
// the five primaries, so this is identical to STAT_TYPE_KEY on a 1.12 dataset (measured:
// one stray Health row across all of Turtle). On TBC it recovers the ~4,700 rating rows
// -- resilience, crit, spell crit, hit, defense, haste, expertise -- that item scoring
// was otherwise blind to, since TBC itemises them as columns rather than equip auras.
const COLUMN_STAT_KEY = { ...ITEM_MOD_STAT, ...STAT_TYPE_KEY };

// Stats readable directly from item columns (base stats, armor, resistances, DPS).
export function statsFromColumns(it, out = {}) {
  for (let i = 1; i <= 10; i++) add(out, COLUMN_STAT_KEY[it[`stat_type${i}`]], it[`stat_value${i}`] || 0);
  add(out, "armor", it.armor || 0);
  for (const col in RES_COL) add(out, RES_COL[col], it[col] || 0);
  if (it.delay > 0) {
    const dps = ((it.dmg_min1 + it.dmg_max1) / 2) / (it.delay / 1000);
    if (dps > 0) out.dps = (out.dps || 0) + Math.round(dps * 10) / 10;
  }
  return out;
}

// Stats contributed by one equip spell's effects. `effects`: [{aura, misc, base}].
// `spellName` is used to recognise the Turtle-custom "Vampirism" family (a dummy
// aura 4 whose $s value is a life-leech %; the name is the only reliable marker).
// `stances` is the spell's shapeshift-form mask: a non-zero mask means the whole
// spell only applies while shapeshifted, so its attack power is druid-form-only
// ("feral") AP that must NOT be scored as generic AP for other classes.
// MOD_STAT (aura 29) misc = base-stat index; -1 (0xFFFFFFFF unsigned) = all five.
// MOD_RESISTANCE (aura 22) misc = a school MASK, like aura 13.
const MOD_STAT_AURA = 29, MOD_RESISTANCE_AURA = 22;
const MOD_STAT_KEY = { 0: "str", 1: "agi", 2: "sta", 3: "int", 4: "spi" };
const RES_MASK = { 2: "firRes", 4: "natRes", 8: "froRes", 16: "shaRes", 64: "arcRes" };

// `opts.baseStats` opts IN to auras 29/22 -- "+8 Strength" or "+3 Resist All" granted
// by an equip SPELL rather than by an item column. Off by default, and deliberately:
// item_stats reads base stats and resistances from the item's own columns, and ~120
// Turtle / ~170 TBC items also carry one of these auras, so switching it on globally
// would move existing item scores, peer medians and upgrade rankings. Gems need it
// (most TBC base-stat gems ARE such a spell), so the enchant pass opts in; items keep
// their long-standing behaviour. Enabling it for items is a real fix, but its own one.
export function statsFromAuras(effects, out = {}, spellName = "", stances = 0, opts = {}) {
  const isVampirism = /^vampirism\b/i.test(spellName || ""); // "Vampirism 1".."Vampirism 5"
  for (const e of effects) {
    const v = (e.base || 0) + 1; // $sN convention: basePoints + 1
    if (opts.baseStats && e.aura === MOD_STAT_AURA) {
      // misc arrives unsigned; -1 means "all stats" (Increased All Stats N).
      if (e.misc === -1 || e.misc === 0xffffffff) for (const k in MOD_STAT_KEY) add(out, MOD_STAT_KEY[k], v);
      else add(out, MOD_STAT_KEY[e.misc], v);
    } else if (opts.baseStats && e.aura === MOD_RESISTANCE_AURA) {
      for (const bit in RES_MASK) if (e.misc & bit) add(out, RES_MASK[bit], v);
    } else if (e.aura === MOD_SKILL_AURA) add(out, SKILL_STAT[e.misc], v);
    else if (e.aura === 4) { if (isVampirism) add(out, "leech", v); } // % damage dealt -> healing
    else if (e.aura === 13) { // MOD_DAMAGE_DONE: split school-specific vs generic sp
      const school = e.misc & SCHOOL_MAGIC;   // magic-school bits only
      if (school) add(out, SP_SCHOOL[school] || "sp", v); // single school -> spX, multi/all -> sp
    } else if (e.aura === 99) add(out, stances ? "feralAp" : "ap", v); // form-gated AP = feral
    else add(out, AURA_STAT[e.aura], v);
  }
  return out;
}

// ---- SpellItemEnchantment effects (TBC gems + socket bonuses) ----------------
//
// A gem's granted effect and an item's socketBonus are both SpellItemEnchantment
// rows, whose DBC carries three (type, amount, arg) triples. Only three of the
// types can contribute a gear stat:
//
//   5 STAT       arg = ITEM_MOD id (the same enum item_template.stat_type uses),
//                amount = the value. "+6 Agility" -> {type:5, amount:6, arg:3}.
//   4 RESISTANCE arg = spell-school index, amount = the value.
//   3 EQUIP_SPELL arg = a spell id, and the STATS ARE THE SPELL'S. Most TBC gems
//                are this shape -- "+8 Spell Damage" is spell 9398, not a stat --
//                so they resolve through the very same spell-aura derivation that
//                produced item_stats. That is the point of routing it here: a gem
//                and an item granting the same effect can never disagree.
//
// Everything else (2 DAMAGE, 6 TOTEM, 7 USE_SPELL, 8 PRISMATIC_SOCKET) and any
// ITEM_MOD without a gear-criteria key (resilience, expertise, armor pen, spell
// penetration -- 1.12 has no such stats, so GEAR_CRITERIA has no key for them)
// contribute nothing. They still SHOW, via the enchant's own display text; they
// just don't move a score. Widening GEAR_CRITERIA for them would ripple into the
// browse filter UI and every stat-weight preset, which is a separate change.
const ENCH_STAT = 5, ENCH_RESISTANCE = 4, ENCH_EQUIP_SPELL = 3;

// (ITEM_MOD_STAT is declared near the top -- statsFromColumns needs it too.)

// spell-school index -> resistance stat key (0 = physical/armor, 1 = holy: neither
// is a gear criterion, matching RES_COL above).
const RES_SCHOOL = { 2: "firRes", 3: "natRes", 4: "froRes", 5: "shaRes", 6: "arcRes" };

// Stats granted by one SpellItemEnchantment. `effects`: [{type, amount, arg}].
// `spellStats` maps spell id -> already-derived stats (build-db fills it during the
// spells pass), which is how type-3 effects resolve. Absent entry -> contributes
// nothing, which is correct: a spell we didn't ship can't be scored.
export function statsFromEnchant(effects, spellStats, out = {}) {
  // ITEM_MOD contributions are collected as a per-key MAX, not a sum. TBC splits one
  // displayed rating across per-attack-type ids -- "+8 Critical Strike Rating" is
  // stored as CRIT_MELEE_RATING 8 *and* CRIT_RANGED_RATING 8 (enchant 2735), and the
  // same shape exists for hit and haste. Summing them reads the gem as +16 crit.
  // Distinct keys are unaffected: melee hit (->hit) and spell hit (->spHit) still both
  // land, because they are different stats that happen to share an enchant.
  const mods = {};
  for (const e of effects || []) {
    if (!e || !e.type) continue;
    if (e.type === ENCH_STAT) {
      const k = ITEM_MOD_STAT[e.arg];
      if (k) mods[k] = Math.max(mods[k] || 0, e.amount || 0);
    } else if (e.type === ENCH_RESISTANCE) {
      const k = RES_SCHOOL[e.arg];
      if (k) mods[k] = Math.max(mods[k] || 0, e.amount || 0);
    } else if (e.type === ENCH_EQUIP_SPELL) {
      const st = spellStats && spellStats.get(e.arg);
      if (st) for (const k in st) add(out, k, st[k]);
    }
  }
  for (const k in mods) add(out, k, mods[k]);
  return out;
}
