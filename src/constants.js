// WoW 1.12 enum tables used to render item tooltips.

export const QUALITY = [
  { name: "Poor", color: "#9d9d9d" },
  { name: "Common", color: "#ffffff" },
  { name: "Uncommon", color: "#1eff00" },
  { name: "Rare", color: "#0070dd" },
  { name: "Epic", color: "#a335ee" },
  { name: "Legendary", color: "#ff8000" },
  { name: "Artifact", color: "#e6cc80" },
  { name: "Heirloom", color: "#e6cc80" },
];

export const ITEM_CLASS = {
  0: "Consumable", 1: "Container", 2: "Weapon", 3: "Gem", 4: "Armor",
  5: "Reagent", 6: "Projectile", 7: "Trade Goods", 8: "Generic", 9: "Recipe",
  10: "Money", 11: "Quiver", 12: "Quest", 13: "Key", 14: "Permanent", 15: "Miscellaneous",
};

export const WEAPON_SUBCLASS = {
  0: "Axe", 1: "Axe", 2: "Bow", 3: "Gun", 4: "Mace", 5: "Mace", 6: "Polearm",
  7: "Sword", 8: "Sword", 10: "Staff", 13: "Fist Weapon", 14: "Miscellaneous",
  15: "Dagger", 16: "Thrown", 17: "Spear", 18: "Crossbow", 19: "Wand", 20: "Fishing Pole",
};

export const ARMOR_SUBCLASS = {
  0: "Miscellaneous", 1: "Cloth", 2: "Leather", 3: "Mail", 4: "Plate",
  6: "Shield", 7: "Libram", 8: "Idol", 9: "Totem", 10: "Sigil",
};

// inventory_type -> equip slot label
export const INV_TYPE = {
  1: "Head", 2: "Neck", 3: "Shoulder", 4: "Shirt", 5: "Chest", 6: "Waist", 7: "Legs",
  8: "Feet", 9: "Wrist", 10: "Hands", 11: "Finger", 12: "Trinket", 13: "One-Hand",
  14: "Off Hand", 15: "Ranged (Bow)", 16: "Back", 17: "Two-Hand", 18: "Bag", 19: "Tabard",
  20: "Chest", 21: "Main Hand", 22: "Off Hand", 23: "Held In Off-hand", 24: "Ammo",
  25: "Thrown", 26: "Ranged (Gun/Wand)", 28: "Relic",
};

// stat_type -> label (1.12 used a small subset)
export const STAT_TYPE = {
  0: "Mana", 1: "Health", 3: "Agility", 4: "Strength", 5: "Intellect",
  6: "Spirit", 7: "Stamina",
};

export const BONDING = {
  1: "Binds when picked up", 2: "Binds when equipped",
  3: "Binds when used", 4: "Quest Item",
};

export const DMG_SCHOOL = {
  0: "", 1: "Holy", 2: "Fire", 3: "Nature", 4: "Frost", 5: "Shadow", 6: "Arcane",
};

export const SPELL_TRIGGER = {
  0: "Use:", 1: "Equip:", 2: "Chance on hit:", 5: "Use:",
};

// allowable_class bitmask (1.12)
export const CLASS_MASK = [
  [1, "Warrior"], [2, "Paladin"], [4, "Hunter"], [8, "Rogue"], [16, "Priest"],
  [64, "Shaman"], [128, "Mage"], [256, "Warlock"], [1024, "Druid"],
];

// allowable_race bitmask (1.12) grouped by faction (for the browse Faction filter
// + tooltip). Alliance: Human/Dwarf/NightElf/Gnome. Horde: Orc/Undead/Tauren/Troll.
export const RACE_ALLIANCE = 1 + 4 + 8 + 64;   // 77
export const RACE_HORDE = 2 + 16 + 32 + 128;   // 178

// profession skill_id -> name. Covers crafting + gathering (Jewelcrafting 755 is
// backported on Tortoise). Used by the "Requires profession" browse filter
// (items.required_skill) and the crafted-by profession shown on the item page.
export const PROFESSION = [
  [171, "Alchemy"], [164, "Blacksmithing"], [185, "Cooking"], [333, "Enchanting"],
  [202, "Engineering"], [129, "First Aid"], [356, "Fishing"], [182, "Herbalism"],
  [755, "Jewelcrafting"], [165, "Leatherworking"], [186, "Mining"], [393, "Skinning"],
  [142, "Survival"], [197, "Tailoring"],
];
export const PROFESSION_LABEL = Object.fromEntries(PROFESSION);

// resistance column -> tooltip label
export const RESISTANCES = [
  ["holy_res", "Holy"], ["fire_res", "Fire"], ["nature_res", "Nature"],
  ["frost_res", "Frost"], ["shadow_res", "Shadow"], ["arcane_res", "Arcane"],
];

// Multi-criteria gear filter (item browse): ordered groups mirroring the keys in
// the derived item_stats table. Keys MUST match item_stats.stat and the maps in
// scripts/lib/itemstats.mjs.
export const GEAR_CRITERIA = [
  { group: "Base Stats", options: [["str", "Strength"], ["agi", "Agility"], ["sta", "Stamina"], ["int", "Intellect"], ["spi", "Spirit"]] },
  { group: "Defense", options: [["armor", "Armor"], ["def", "Defense"], ["dodge", "Dodge %"], ["parry", "Parry %"], ["block", "Block %"], ["firRes", "Fire Res"], ["natRes", "Nature Res"], ["froRes", "Frost Res"], ["shaRes", "Shadow Res"], ["arcRes", "Arcane Res"]] },
  { group: "Offensive", options: [["ap", "Attack Power"], ["sp", "Spell Power"], ["heal", "Healing Power"], ["crit", "Crit %"], ["spCrit", "Spell Crit %"], ["hit", "Hit %"], ["spHit", "Spell Hit %"], ["dps", "Weapon DPS"]] },
  { group: "Utility", options: [["mp5", "Mana per 5"], ["hp5", "Health per 5"], ["haste", "Haste %"]] },
  { group: "Weapon Skill", options: [["wSwords", "Swords"], ["wAxes", "Axes"], ["wMaces", "Maces"], ["wDaggers", "Daggers"], ["wPolearms", "Polearms"], ["w2hSwords", "2H Swords"], ["w2hAxes", "2H Axes"], ["w2hMaces", "2H Maces"], ["wBows", "Bows"], ["wGuns", "Guns"], ["wCrossbows", "Crossbows"]] },
];

// flat key -> label (column headers + valid-key whitelist for the stats= URL param)
export const GEAR_STAT_LABEL = Object.fromEntries(GEAR_CRITERIA.flatMap((g) => g.options));

// item acquisition sources (key/label, in display order) — powers the browse
// Source filter + tag column and the item-detail header tags. Derived at build
// time into the item_sources table (see scripts/build-db.mjs).
export const ITEM_SOURCE = [
  ["drop", "Drop"], ["skin", "Skinning"], ["pick", "Pickpocket"],
  ["object", "Object"], ["container", "Container"], ["disenchant", "Disenchant"],
  ["vendor", "Vendor"], ["quest", "Quest"], ["crafted", "Crafted"], ["pvp", "PvP"],
  ["worlddrop", "World Drop"], ["unobtainable", "Unobtainable"],
];

export const CREATURE_TYPE = {
  1: "Beast", 2: "Dragonkin", 3: "Demon", 4: "Elemental", 5: "Giant", 6: "Undead",
  7: "Humanoid", 8: "Critter", 9: "Mechanical", 10: "Not specified", 11: "Totem",
  12: "Non-combat Pet", 13: "Gas Cloud",
};

export const CREATURE_RANK = {
  1: "Elite", 2: "Rare Elite", 3: "World Boss", 4: "Rare",
};

// npc_flags bits -> role label
export const NPC_FLAGS = [
  [2, "Quest Giver"], [16, "Trainer"], [128, "Vendor"], [4096, "Repair"],
  [8192, "Flight Master"], [65536, "Banker"], [131072, "Innkeeper"], [4194304, "Auctioneer"],
];

export function npcRoles(flags) {
  if (!flags) return [];
  return NPC_FLAGS.filter(([bit]) => flags & bit).map(([, name]) => name);
}

export function classRestrictions(mask) {
  if (mask === -1 || mask === 0) return null;
  const out = [];
  for (const [bit, name] of CLASS_MASK) if (mask & bit) out.push(name);
  // all classes set == no restriction; don't render the line
  if (!out.length || out.length === CLASS_MASK.length) return null;
  return out;
}

// allowable_race bitmask (1.12). Goblin (256) isn't playable.
export const RACE_MASK = [
  [1, "Human"], [2, "Orc"], [4, "Dwarf"], [8, "Night Elf"],
  [16, "Undead"], [32, "Tauren"], [64, "Gnome"], [128, "Troll"],
];
const RACE_ALL = RACE_MASK.reduce((a, [b]) => a | b, 0);

export function raceRestrictions(mask) {
  if (!mask || mask === -1 || (mask & RACE_ALL) === RACE_ALL) return null;
  if (mask === RACE_ALLIANCE) return ["Alliance"];
  if (mask === RACE_HORDE) return ["Horde"];
  const out = RACE_MASK.filter(([b]) => mask & b).map(([, n]) => n);
  return out.length ? out : null;
}

// quest_template.Type -> label (1.12 subset present in the data; unknown -> blank)
export const QUEST_TYPE = { 1: "Group", 41: "PvP", 62: "Raid", 81: "Dungeon", 82: "World Event" };

// map id -> continent label (open-world). Others are instances.
export const CONTINENT = { 0: "Eastern Kingdoms", 1: "Kalimdor", 530: "Outland" };

// gameobject_template.type -> label (1.12; only the player-facing ones named).
export const GAMEOBJECT_TYPE = {
  0: "Door", 1: "Button", 2: "Quest Giver", 3: "Chest", 5: "Generic", 6: "Trap",
  7: "Chair", 8: "Spell Focus", 9: "Text", 10: "Goober", 11: "Transport",
  17: "Fishing Node", 18: "Summoning Ritual", 19: "Mailbox", 22: "Spell Caster",
  23: "Meeting Stone", 25: "Fishing Hole",
};

// reputation standing index (required_reputation_rank / quest gates)
export const REP_STANDING = {
  0: "Hated", 1: "Hostile", 2: "Unfriendly", 3: "Neutral",
  4: "Friendly", 5: "Honored", 6: "Revered", 7: "Exalted",
};

// Negative ZoneOrSort -> category, from the client QuestSort.dbc (positive
// ZoneOrSort is an areas.entry zone name instead). Authoritative, extracted once.
export const QUEST_SORT = {
  "-1": "Epic", "-22": "Seasonal", "-24": "Herbalism", "-25": "Survival",
  "-61": "Warlock", "-81": "Warrior", "-82": "Shaman", "-101": "Fishing",
  "-121": "Blacksmithing", "-141": "Paladin", "-161": "Mage", "-162": "Rogue",
  "-181": "Alchemy", "-182": "Leatherworking", "-201": "Engineering", "-221": "Treasure Map",
  "-241": "Daily Quest", "-261": "Hunter", "-262": "Priest", "-263": "Druid",
  "-264": "Tailoring", "-284": "Special", "-304": "Cooking", "-324": "First Aid",
  "-344": "Legendary", "-364": "Darkmoon Faire", "-365": "Ahn'Qiraj War",
  "-366": "Lunar Festival", "-367": "Reputation", "-368": "Invasion",
  "-369": "Midsummer", "-371": "Inscription", "-374": "Noblegarden",
};

// Quest "zone" field: positive -> area name (passed in), negative -> sort category.
export function questZoneLabel(zone, zoneName) {
  if (zone > 0) return zoneName || "";
  if (zone < 0) return QUEST_SORT[zone] || "";
  return "";
}

export function money(copper) {
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  return { g, s, c };
}

// ---- Spell detail (WoW 1.12 enums) ----
// Maps are partial by design: the spell page falls back to "#N" for unmapped
// values, so only high-confidence entries are listed (no fabricated labels).
export const SPELL_SCHOOL = { 0: "Physical", 1: "Holy", 2: "Fire", 3: "Nature", 4: "Frost", 5: "Shadow", 6: "Arcane" };
export const POWER_TYPE = { 0: "Mana", 1: "Rage", 2: "Focus", 3: "Energy", 4: "Happiness" };
export const SPELL_DISPEL = { 1: "Magic", 2: "Curse", 3: "Disease", 4: "Poison", 5: "Stealth", 6: "Invisibility" };
export const SPELL_MECHANIC = {
  1: "Charmed", 2: "Disoriented", 3: "Disarmed", 4: "Distracted", 5: "Fleeing",
  6: "Fumbling", 7: "Rooted", 8: "Pacified", 9: "Silenced", 10: "Asleep",
  11: "Ensnared", 12: "Stunned", 13: "Frozen", 14: "Incapacitated", 15: "Bleeding",
  16: "Healing", 17: "Polymorphed", 18: "Banished", 19: "Shielded", 20: "Shackled",
  21: "Mounted", 23: "Slowed", 24: "Horrified", 25: "Invulnerable", 26: "Interrupted",
  27: "Dazed", 28: "Discovery", 29: "Immune Shield", 30: "Sapped", 31: "Enraged",
};
export const SPELL_EFFECT = {
  1: "Instakill", 2: "School Damage", 3: "Dummy", 4: "Portal Teleport", 5: "Teleport Units",
  6: "Apply Aura", 7: "Environmental Damage", 8: "Power Drain", 9: "Health Leech", 10: "Heal",
  11: "Bind", 16: "Quest Complete", 17: "Weapon Damage", 18: "Resurrect", 19: "Extra Attacks",
  24: "Create Item", 27: "Persistent Area Aura", 28: "Summon", 29: "Leap", 30: "Energize",
  31: "Weapon % Damage", 32: "Trigger Missile", 33: "Open Lock", 35: "Apply Area Aura (Party)",
  36: "Learn Spell", 38: "Dispel", 39: "Language", 40: "Dual Wield", 41: "Summon Wild",
  42: "Summon Guardian", 44: "Skill Step", 48: "Stealth", 49: "Detect", 53: "Enchant Item",
  54: "Enchant Item (Temporary)", 55: "Tame Creature", 56: "Summon Pet", 58: "Skill",
  64: "Trigger Spell", 67: "Heal Max Health", 68: "Interrupt Cast", 69: "Distract", 70: "Pull",
  71: "Pickpocket", 77: "Script Effect", 78: "Attack", 80: "Add Combo Points",
  92: "Enchant Held Item", 94: "Self Resurrect", 95: "Skinning", 96: "Charge",
  102: "Trigger Spell (Value)", 108: "Dispel Mechanic", 121: "Weapon Damage (No School)",
};
export const SPELL_AURA = {
  1: "Bind Sight", 2: "Mod Possess", 3: "Periodic Damage", 4: "Dummy", 5: "Mod Confuse",
  6: "Mod Charm", 7: "Mod Fear", 8: "Periodic Heal", 9: "Mod Attack Speed", 10: "Mod Threat",
  11: "Mod Taunt", 12: "Mod Stun", 13: "Mod Damage Done", 14: "Mod Damage Taken",
  15: "Damage Shield", 16: "Mod Stealth", 17: "Mod Stealth Detect", 18: "Mod Invisibility",
  19: "Mod Invisibility Detection", 20: "Mod Health Regen %", 22: "Mod Resistance",
  23: "Periodic Trigger Spell", 24: "Periodic Energize", 25: "Mod Pacify", 26: "Mod Root",
  27: "Mod Silence", 28: "Reflect Spells", 29: "Mod Stat", 30: "Mod Skill",
  31: "Mod Increase Speed", 32: "Mod Increase Mounted Speed", 33: "Mod Decrease Speed",
  34: "Mod Increase Health", 35: "Mod Increase Energy", 36: "Mod Shapeshift",
  37: "Effect Immunity", 38: "State Immunity", 39: "School Immunity", 40: "Damage Immunity",
  41: "Dispel Immunity", 42: "Proc Trigger Spell", 43: "Proc Trigger Damage",
  44: "Track Creatures", 45: "Track Resources", 47: "Mod Parry %", 49: "Mod Dodge %",
  51: "Mod Block %", 52: "Mod Crit %", 53: "Periodic Leech", 54: "Mod Hit Chance",
  55: "Mod Spell Hit Chance", 56: "Transform", 57: "Mod Spell Crit Chance",
  58: "Mod Swim Speed", 60: "Mod Pacify Silence", 61: "Mod Scale", 64: "Periodic Mana Leech",
  65: "Mod Casting Speed", 69: "School Absorb", 77: "Mechanic Immunity",
  78: "Mounted", 79: "Mod Damage % Done", 85: "Mod Power Regen", 99: "Mod Attack Power",
  123: "Mod Target Resistance", 124: "Mod Ranged Attack Power", 135: "Mod Healing Done",
  138: "Mod Melee Haste",
};
// Decoded spell flags: [field, bitmask, label]. field 'a' = attributes, 'e' = attributesEx.
// Curated to high-confidence vanilla bits; unrecognized bits are simply not shown.
export const SPELL_FLAGS = [
  ["a", 0x00000002, "On Next Ranged"], ["a", 0x00000010, "Ability"], ["a", 0x00000020, "Trade Spell"],
  ["a", 0x00000040, "Passive"], ["a", 0x00000080, "No Aura Icon"], ["a", 0x00000100, "Hidden in Combat Log"],
  ["a", 0x00001000, "Daytime Only"], ["a", 0x00002000, "Night Only"], ["a", 0x00004000, "Indoors Only"],
  ["a", 0x00008000, "Outdoors Only"], ["a", 0x00010000, "Cannot be used while shapeshifted"],
  ["a", 0x00020000, "Only while Stealthed"], ["a", 0x00100000, "Stops Attack"],
  ["a", 0x00200000, "Cannot Dodge/Parry/Block"], ["a", 0x00800000, "Castable while Dead"],
  ["a", 0x01000000, "Castable while Mounted"], ["a", 0x04000000, "All spell effects are harmful"],
  ["a", 0x08000000, "Castable while Sitting"], ["a", 0x10000000, "Cannot be used in Combat"],
  ["a", 0x80000000, "Cannot Cancel"],
  ["e", 0x00000001, "Dismiss Pet"], ["e", 0x00000002, "Drains all Power"], ["e", 0x00000004, "Channeled"],
  ["e", 0x00000008, "Cannot be Redirected"], ["e", 0x00000020, "Does not break Stealth"],
  ["e", 0x00000040, "Channeled"], ["e", 0x00000080, "Cannot be reflected"], ["e", 0x00000200, "No initial Threat"],
  ["e", 0x00010000, "Cannot Crit"], ["e", 0x00100000, "Cannot be Stolen"],
];
