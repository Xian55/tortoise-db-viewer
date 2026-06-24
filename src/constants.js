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
  0: "One-Handed Axe", 1: "Two-Handed Axe", 2: "Bow", 3: "Gun",
  4: "One-Handed Mace", 5: "Two-Handed Mace", 6: "Polearm",
  7: "One-Handed Sword", 8: "Two-Handed Sword", 10: "Staff",
  13: "Fist Weapon", 14: "Miscellaneous", 15: "Dagger", 16: "Thrown",
  17: "Spear", 18: "Crossbow", 19: "Wand", 20: "Fishing Pole",
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

// Faction a quest is offered to, from its allowable-race gate (quests.reqraces).
// Turtle adds custom playable races on top of the 1.12 cores — High Elf (512,
// Alliance) and Goblin (256, Horde) — so the common quest masks are 589 (Alliance)
// and 434 (Horde). No gate (0), or both sides set, means anyone can pick it up.
export const RACE_ALLIANCE_ALL = RACE_ALLIANCE | 512;  // + High Elf
export const RACE_HORDE_ALL = RACE_HORDE | 256;        // + Goblin
export function questFaction(reqraces) {
  const a = reqraces & RACE_ALLIANCE_ALL, h = reqraces & RACE_HORDE_ALL;
  if (a && !h) return "Alliance";
  if (h && !a) return "Horde";
  return "Neutral";
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
// Spell effect + aura type names, generated from the server source enums
// (SpellDefines.h SpellEffects / SpellAuraDefines.h AuraType, 1.12). Authoritative
// for this MaNGOS fork; ids beyond the enums (Turtle-custom auras >=200) fall back
// to "Aura #id" in the viewer.
export const SPELL_EFFECT = {
  0: "None", 1: "Instakill", 2: "School Damage", 3: "Dummy", 4: "Portal Teleport", 5: "Teleport Units",
  6: "Apply Aura", 7: "Environmental Damage", 8: "Power Drain", 9: "Health Leech", 10: "Heal", 11: "Bind",
  12: "Portal", 13: "Ritual Base", 14: "Ritual Specialize", 15: "Ritual Activate Portal", 16: "Quest Complete",
  17: "Weapon Damage Noschool", 18: "Resurrect", 19: "Add Extra Attacks", 20: "Dodge", 21: "Evade",
  22: "Parry", 23: "Block", 24: "Create Item", 25: "Weapon", 26: "Defense", 27: "Persistent Area Aura",
  28: "Summon", 29: "Leap", 30: "Energize", 31: "Weapon % Damage", 32: "Trigger Missile", 33: "Open Lock",
  34: "Summon Change Item", 35: "Apply Area Aura Party", 36: "Learn Spell", 37: "Spell Defense", 38: "Dispel",
  39: "Language", 40: "Dual Wield", 41: "Summon Wild", 42: "Summon Guardian", 43: "Teleport Units Face Caster",
  44: "Skill Step", 45: "Add Honor", 46: "Spawn", 47: "Trade Skill", 48: "Stealth", 49: "Detect",
  50: "Trans Door", 51: "Force Critical Hit", 52: "Guarantee Hit", 53: "Enchant Item",
  54: "Enchant Item Temporary", 55: "Tamecreature", 56: "Summon Pet", 57: "Learn Pet Spell",
  58: "Weapon Damage", 59: "Open Lock Item", 60: "Proficiency", 61: "Send Event", 62: "Power Burn",
  63: "Threat", 64: "Trigger Spell", 65: "Health Funnel", 66: "Power Funnel", 67: "Heal Max Health",
  68: "Interrupt Cast", 69: "Distract", 70: "Pull", 71: "Pickpocket", 72: "Add Farsight",
  73: "Summon Possessed", 74: "Summon Totem", 75: "Heal Mechanical", 76: "Summon Object Wild",
  77: "Script Effect", 78: "Attack", 79: "Sanctuary", 80: "Add Combo Points", 81: "Create House",
  82: "Bind Sight", 83: "Duel", 84: "Stuck", 85: "Summon Player", 86: "Activate Object",
  87: "Summon Totem Slot1", 88: "Summon Totem Slot2", 89: "Summon Totem Slot3", 90: "Summon Totem Slot4",
  91: "Threat All", 92: "Enchant Held Item", 93: "Summon Phantasm", 94: "Self Resurrect", 95: "Skinning",
  96: "Charge", 97: "Summon Critter", 98: "Knock Back", 99: "Disenchant", 100: "Inebriate", 101: "Feed Pet",
  102: "Dismiss Pet", 103: "Reputation", 104: "Summon Object Slot1", 105: "Summon Object Slot2",
  106: "Summon Object Slot3", 107: "Summon Object Slot4", 108: "Dispel Mechanic", 109: "Summon Dead Pet",
  110: "Destroy All Totems", 111: "Durability Damage", 112: "Summon Demon", 113: "Resurrect New",
  114: "Attack Me", 115: "Durability Damage %", 116: "Skin Player Corpse", 117: "Spirit Heal", 118: "Skill",
  119: "Apply Area Aura Pet", 120: "Teleport Graveyard", 121: "Normalized Weapon Dmg", 123: "Send Taxi",
  124: "Player Pull", 125: "Modify Threat %", 128: "Apply Area Aura Friend", 129: "Apply Area Aura Enemy",
  130: "Despawn Object", 131: "Nostalrius", 132: "Apply Area Aura Raid", 133: "Apply Area Aura Owner",
};
export const SPELL_AURA = {
  0: "None", 1: "Bind Sight", 2: "Mod Possess", 3: "Periodic Damage", 4: "Dummy", 5: "Mod Confuse",
  6: "Mod Charm", 7: "Mod Fear", 8: "Periodic Heal", 9: "Mod Attackspeed", 10: "Mod Threat", 11: "Mod Taunt",
  12: "Mod Stun", 13: "Mod Damage Done", 14: "Mod Damage Taken", 15: "Damage Shield", 16: "Mod Stealth",
  17: "Mod Stealth Detect", 18: "Mod Invisibility", 19: "Mod Invisibility Detection", 20: "Obs Mod Health",
  21: "Obs Mod Mana", 22: "Mod Resistance", 23: "Periodic Trigger Spell", 24: "Periodic Energize",
  25: "Mod Pacify", 26: "Mod Root", 27: "Mod Silence", 28: "Reflect Spells", 29: "Mod Stat", 30: "Mod Skill",
  31: "Mod Increase Speed", 32: "Mod Increase Mounted Speed", 33: "Mod Decrease Speed",
  34: "Mod Increase Health", 35: "Mod Increase Energy", 36: "Mod Shapeshift", 37: "Effect Immunity",
  38: "State Immunity", 39: "School Immunity", 40: "Damage Immunity", 41: "Dispel Immunity",
  42: "Proc Trigger Spell", 43: "Proc Trigger Damage", 44: "Track Creatures", 45: "Track Resources",
  46: "Mod Parry Skill", 47: "Mod Parry %", 48: "Mod Dodge Skill", 49: "Mod Dodge %", 50: "Mod Block Skill",
  51: "Mod Block %", 52: "Mod Crit %", 53: "Periodic Leech", 54: "Mod Hit Chance", 55: "Mod Spell Hit Chance",
  56: "Transform", 57: "Mod Spell Crit Chance", 58: "Mod Increase Swim Speed", 59: "Mod Damage Done Creature",
  60: "Mod Pacify Silence", 61: "Mod Scale", 62: "Periodic Health Funnel", 63: "Periodic Mana Funnel",
  64: "Periodic Mana Leech", 65: "Mod Casting Speed Not Stack", 66: "Feign Death", 67: "Mod Disarm",
  68: "Mod Stalked", 69: "School Absorb", 70: "Extra Attacks", 71: "Mod Spell Crit Chance School",
  72: "Mod Power Cost School %", 73: "Mod Power Cost School", 74: "Reflect Spells School", 75: "Mod Language",
  76: "Far Sight", 77: "Mechanic Immunity", 78: "Mounted", 79: "Mod Damage % Done", 80: "Mod % Stat",
  81: "Split Damage %", 82: "Water Breathing", 83: "Mod Base Resistance", 84: "Mod Regen",
  85: "Mod Power Regen", 86: "Channel Death Item", 87: "Mod Damage % Taken", 88: "Mod Health Regen %",
  89: "Periodic Damage %", 90: "Mod Resist Chance", 91: "Mod Detect Range", 92: "Prevents Fleeing",
  93: "Mod Unattackable", 94: "Interrupt Regen", 95: "Ghost", 96: "Spell Magnet", 97: "Mana Shield",
  98: "Mod Skill Talent", 99: "Mod Attack Power", 100: "Auras Visible", 101: "Mod Resistance %",
  102: "Mod Melee Attack Power Versus", 103: "Mod Total Threat", 104: "Water Walk", 105: "Feather Fall",
  106: "Hover", 107: "Add Flat Modifier", 108: "Add % Modifier", 109: "Add Target Trigger",
  110: "Mod Power Regen %", 111: "Add Caster Hit Trigger", 112: "Override Class Scripts",
  113: "Mod Ranged Damage Taken", 114: "Mod Ranged Damage Taken %", 115: "Mod Healing",
  116: "Mod Regen During Combat", 117: "Mod Mechanic Resistance", 118: "Mod Healing %",
  119: "Share Pet Tracking", 120: "Untrackable", 121: "Empathy", 122: "Mod Offhand Damage %",
  123: "Mod Target Resistance", 124: "Mod Ranged Attack Power", 125: "Mod Melee Damage Taken",
  126: "Mod Melee Damage Taken %", 127: "Ranged Attack Power Attacker Bonus", 128: "Mod Possess Pet",
  129: "Mod Speed Always", 130: "Mod Mounted Speed Always", 131: "Mod Ranged Attack Power Versus",
  132: "Mod Increase Energy %", 133: "Mod Increase Health %", 134: "Mod Mana Regen Interrupt",
  135: "Mod Healing Done", 136: "Mod Healing Done %", 137: "Mod Total Stat Percentage", 138: "Mod Melee Haste",
  139: "Force Reaction", 140: "Mod Ranged Haste", 141: "Mod Ranged Ammo Haste", 142: "Mod Base Resistance %",
  143: "Mod Resistance Exclusive", 144: "Safe Fall", 145: "Charisma", 146: "Persuaded",
  147: "Mechanic Immunity Mask", 148: "Retain Combo Points", 149: "Resist Pushback",
  150: "Mod Shield Blockvalue %", 151: "Track Stealthed", 152: "Mod Detected Range", 153: "Split Damage Flat",
  154: "Mod Stealth Level", 155: "Mod Water Breathing", 156: "Mod Reputation Gain", 157: "Pet Damage Multi",
  158: "Mod Shield Blockvalue", 159: "No Pvp Credit", 160: "Mod Aoe Avoidance",
  161: "Mod Health Regen In Combat", 162: "Power Burn Mana", 163: "Mod Crit Damage Bonus",
  165: "Melee Attack Power Attacker Bonus", 166: "Mod Attack Power %", 167: "Mod Ranged Attack Power %",
  168: "Mod Damage Done Versus", 169: "Mod Crit % Versus", 170: "Detect Amore", 171: "Mod Speed Not Stack",
  172: "Mod Mounted Speed Not Stack", 173: "Allow Champion Spells", 174: "Mod Spell Damage Of Stat %",
  175: "Mod Spell Healing Of Stat %", 176: "Spirit Of Redemption", 177: "Aoe Charm",
  178: "Mod Debuff Resistance", 179: "Mod Attacker Spell Crit Chance", 180: "Mod Flat Spell Damage Versus",
  181: "Mod Flat Spell Crit Damage Versus", 182: "Mod Resistance Of Stat %", 183: "Mod Critical Threat",
  184: "Mod Attacker Melee Hit Chance", 185: "Mod Attacker Ranged Hit Chance",
  186: "Mod Attacker Spell Hit Chance", 187: "Mod Attacker Melee Crit Chance",
  188: "Mod Attacker Ranged Crit Chance", 189: "Mod Rating", 190: "Mod Faction Reputation Gain",
  191: "Use Normal Movement Speed", 192: "Aura Spell", 193: "Split Damage Group %",
  194: "Mod Aoe Damage % Taken", 195: "Mod Honor Gain", 196: "Enable Flying",
  197: "Mod Periodic Damage % Taken", 198: "Mod Crit Damage Bonus Taken", 199: "Mod Spell Healing Of Armor %",
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
