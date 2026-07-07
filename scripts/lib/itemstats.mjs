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
// omitted to avoid double counting: ranged AP 124 ~ melee AP 99; ranged/spell haste
// 140/65 ~ melee haste 138; block VALUE 158 vs reference's Block% 51.)
// NOTE: aura 13 (MOD_DAMAGE_DONE) is handled separately in statsFromAuras -- its misc
// value is a spell-school mask, so school-specific spell power (+Fire dmg, +Shadow dmg)
// is split from generic "sp" (see SP_SCHOOL) instead of all lumping into `sp`.
export const AURA_STAT = {
  135: "heal",  // MOD_HEALING_DONE
  99: "ap",     // MOD_ATTACK_POWER
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
};

// MOD_SKILL (aura 30) misc value = skill-line id -> stat key. Fishing (356) is
// included so fishing poles can show their "+N Fishing" bonus (the Fishing-Pole
// browse swaps DPS/Speed for this column); it is NOT a gear criterion (not in
// GEAR_CRITERIA), so it never appears in the stat dropdown. The other professions
// (Mining 186, …) and Fist Weapons (162, no reference option) stay excluded.
export const MOD_SKILL_AURA = 30;
export const SKILL_STAT = {
  95: "def",
  356: "fishing",
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
const STAT_TYPE_KEY = { 4: "str", 3: "agi", 7: "sta", 5: "int", 6: "spi" };
// resistance column -> stat key (no holy: the reference has no Holy Resistance option).
const RES_COL = {
  fire_res: "firRes", nature_res: "natRes", frost_res: "froRes",
  shadow_res: "shaRes", arcane_res: "arcRes",
};

// Sum a contribution into an accumulator, ignoring falsy values.
function add(out, key, v) {
  if (key && v) out[key] = (out[key] || 0) + v;
}

// Stats readable directly from item columns (base stats, armor, resistances, DPS).
export function statsFromColumns(it, out = {}) {
  for (let i = 1; i <= 10; i++) add(out, STAT_TYPE_KEY[it[`stat_type${i}`]], it[`stat_value${i}`] || 0);
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
export function statsFromAuras(effects, out = {}, spellName = "") {
  const isVampirism = /^vampirism\b/i.test(spellName || ""); // "Vampirism 1".."Vampirism 5"
  for (const e of effects) {
    const v = (e.base || 0) + 1; // $sN convention: basePoints + 1
    if (e.aura === MOD_SKILL_AURA) add(out, SKILL_STAT[e.misc], v);
    else if (e.aura === 4) { if (isVampirism) add(out, "leech", v); } // % damage dealt -> healing
    else if (e.aura === 13) { // MOD_DAMAGE_DONE: split school-specific vs generic sp
      const school = e.misc & SCHOOL_MAGIC;   // magic-school bits only
      if (school) add(out, SP_SCHOOL[school] || "sp", v); // single school -> spX, multi/all -> sp
    } else add(out, AURA_STAT[e.aura], v);
  }
  return out;
}
