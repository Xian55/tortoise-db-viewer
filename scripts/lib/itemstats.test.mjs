// Unit tests for the gear-stat derivation (no DB, no browser): `bun run test:unit`.
//
// Focused on statsFromEnchant -- the TBC gem/socket-bonus path -- because two of its
// failure modes are invisible in the UI (a gem quietly worth nothing, or quietly worth
// double) and both actually happened while it was being written.
import { test, expect } from "bun:test";
import { statsFromAuras, statsFromColumns, statsFromEnchant } from "./itemstats.mjs";

// enchant effects, as the DBC stores them: {type, amount, arg}.
// type 5 = STAT (arg = ITEM_MOD id), 4 = RESISTANCE, 3 = EQUIP_SPELL (arg = spell id).
const ST = (arg, amount) => ({ type: 5, amount, arg });
const SPELL = (arg) => ({ type: 3, amount: 0, arg });

test("type-5 stat effect maps ITEM_MOD id -> gear stat key", () => {
  // enchant 2693 "+6 Agility" (Delicate Blood Garnet)
  expect(statsFromEnchant([ST(3, 6)], new Map())).toEqual({ agi: 6 });
});

test("a rating split across attack types counts ONCE, not summed", () => {
  // enchant 2735 is named "+8 Critical Strike Rating" but stores it twice:
  // CRIT_MELEE_RATING(19)=8 and CRIT_RANGED_RATING(20)=8. Summing reads it as +16.
  expect(statsFromEnchant([ST(19, 8), ST(20, 8)], new Map())).toEqual({ crit: 8 });
});

test("distinct stats sharing one enchant both land", () => {
  // melee hit (->hit) and spell hit (->spHit) are different stats, not a split rating.
  expect(statsFromEnchant([ST(16, 5), ST(18, 7)], new Map())).toEqual({ hit: 5, spHit: 7 });
});

test("type-3 effect takes the stats of the spell it names", () => {
  const spellStats = new Map([[9398, { sp: 8, heal: 8 }]]);
  // enchant 2924 "+8 Spell Damage" -- a SPELL, which is why parsing the display
  // string would not have been enough.
  expect(statsFromEnchant([SPELL(9398)], spellStats)).toEqual({ sp: 8, heal: 8 });
});

test("a spell we didn't ship contributes nothing rather than throwing", () => {
  expect(statsFromEnchant([SPELL(999999)], new Map())).toEqual({});
});

test("mixed spell + stat effects combine", () => {
  // enchant 3107 "+8 Attack Power and +6 Stamina"
  const spellStats = new Map([[9139, { ap: 8, rangedAp: 8 }]]);
  expect(statsFromEnchant([SPELL(9139), ST(7, 6)], spellStats)).toEqual({ ap: 8, rangedAp: 8, sta: 6 });
});

test("an ITEM_MOD with no gear-criteria key is dropped, not guessed", () => {
  // 44 = ARMOR_PENETRATION_RATING, 47 = SPELL_PENETRATION. Neither has a 1.12 stat to
  // map onto, so there is no key to score them against; the gem still shows its own
  // text on the page, it just can't move a number.
  expect(statsFromEnchant([ST(44, 10)], new Map())).toEqual({});
  expect(statsFromEnchant([ST(47, 10)], new Map())).toEqual({});
});

test("TBC-only stats resilience and expertise DO map", () => {
  // These two are the most-itemised TBC ratings (1,221 and 82 rows), so they get real
  // GEAR_CRITERIA keys -- added on TBC only, since no 1.12 item can ever set them.
  expect(statsFromEnchant([ST(35, 10)], new Map())).toEqual({ resil: 10 });
  expect(statsFromEnchant([ST(37, 8)], new Map())).toEqual({ expertise: 8 });
});

test("empty / missing effects are safe", () => {
  expect(statsFromEnchant(null, new Map())).toEqual({});
  expect(statsFromEnchant([], new Map())).toEqual({});
  expect(statsFromEnchant([{}, null], new Map())).toEqual({});
});

// --- the baseStats opt-in ------------------------------------------------------
// Aura 29 (MOD_STAT) is how "+8 Strength" is granted by a spell. item_stats must NOT
// pick it up (base stats come from item columns; ~120 Turtle items also carry this
// aura and would change score), but gems must.

test("aura 29 is ignored by default and honoured with baseStats", () => {
  const eff = [{ aura: 29, misc: 0, base: 7 }]; // $s convention: base+1 = 8
  expect(statsFromAuras(eff)).toEqual({});
  expect(statsFromAuras(eff, {}, "", 0, { baseStats: true })).toEqual({ str: 8 });
});

test("aura 29 with misc -1 grants all five base stats", () => {
  const out = statsFromAuras([{ aura: 29, misc: -1, base: 4 }], {}, "", 0, { baseStats: true });
  expect(out).toEqual({ str: 5, agi: 5, sta: 5, int: 5, spi: 5 });
});

test("aura 22 spreads a resistance mask over its schools", () => {
  // "+3 Resist All" = mask 126 (all magic schools).
  const out = statsFromAuras([{ aura: 22, misc: 126, base: 2 }], {}, "", 0, { baseStats: true });
  expect(out).toEqual({ firRes: 3, natRes: 3, froRes: 3, shaRes: 3, arcRes: 3 });
});

test("existing aura handling is unchanged by the opt-in", () => {
  // aura 99 = attack power; must behave identically with and without baseStats.
  const eff = [{ aura: 99, misc: 0, base: 15 }];
  expect(statsFromAuras(eff)).toEqual({ ap: 16 });
  expect(statsFromAuras(eff, {}, "", 0, { baseStats: true })).toEqual({ ap: 16 });
});

// --- TBC rating columns --------------------------------------------------------
// TBC itemises crit/hit/haste/resilience on the item's stat_type COLUMNS, where 1.12
// used equip-spell auras. statsFromColumns read only the five primaries, so ~4,700 TBC
// rating rows were silently dropped and TBC gear scored nearly blind.
test("statsFromColumns reads TBC rating stat_types", () => {
  const it = { stat_type1: 32, stat_value1: 24, stat_type2: 35, stat_value2: 18, stat_type3: 7, stat_value3: 30 };
  expect(statsFromColumns(it)).toEqual({ crit: 24, resil: 18, sta: 30 });
});

test("vanilla items are unaffected -- only the five primaries are ever set", () => {
  const it = { stat_type1: 4, stat_value1: 10, stat_type2: 3, stat_value2: 7, stat_type3: 5, stat_value3: 5 };
  expect(statsFromColumns(it)).toEqual({ str: 10, agi: 7, int: 5 });
});

test("stat_type 1 (Health) stays unmapped -- the one id vanilla sets that we drop", () => {
  expect(statsFromColumns({ stat_type1: 1, stat_value1: 50 })).toEqual({});
});
