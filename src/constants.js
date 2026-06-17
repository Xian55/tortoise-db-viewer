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

// resistance column -> tooltip label
export const RESISTANCES = [
  ["holy_res", "Holy"], ["fire_res", "Fire"], ["nature_res", "Nature"],
  ["frost_res", "Frost"], ["shadow_res", "Shadow"], ["arcane_res", "Arcane"],
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
  return out.length ? out : null;
}

export function money(copper) {
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  return { g, s, c };
}
