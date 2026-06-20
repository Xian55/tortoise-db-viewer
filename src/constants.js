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
  [197, "Tailoring"],
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
  ["unobtainable", "Unobtainable"],
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
