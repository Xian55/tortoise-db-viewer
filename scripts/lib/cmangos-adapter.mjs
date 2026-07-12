// cmangos SQLite -> staging adapter. Alternative to lib/staging.mjs for building the
// viewer DB from cmangos's published Classic SQLite DB (classicmangos.sqlite) instead
// of Turtle's MySQL dumps + migrations. build-db uses SQL_SOURCE=cmangos to pick this.
//
// It returns the SAME accessor shape buildStaging does (has/columns/rows/drop/stats),
// so build-db's importers run unchanged. Mechanics: ATTACH the cmangos DB, then for
// each staged table create `stg_<table>` with the *Turtle* column names and
// INSERT..SELECT the mapped cmangos columns into it.
//
// Column mapping is mostly free: cmangos uses the same MaNGOS table names, and SQLite
// resolves column names case-insensitively, so Turtle `quality` reads cmangos `Quality`
// with no rename. Only names differing beyond case (underscores / abbreviations /
// different words) need an explicit RENAMES entry; a Turtle column absent from cmangos
// becomes NULL.
//
// SCOPE (core slice): DBC-derived tables are absent from the cmangos world DB (cmangos
// reads DBCs from the client at runtime) -> item_display_info, area_template, faction,
// faction_template, map_template, skill_line_ability come through EMPTY, so icons, zone
// names, faction data, dungeon names and spell professions are blank for now.
// spell_template is deferred to the same DBC phase (its tooltip text lives in Spell.dbc,
// not the world DB) -> EMPTY stub. Fill these from a vanilla 1.12 client next phase.

const PFX = "stg_";

// pattern helper: expand numbered column families (stat_type1.., dmg_min1..)
const seq = (n, ...names) => Array.from({ length: n }, (_, i) => names.map((s) => `${s}${i + 1}`)).flat();

// ---- Turtle target column lists (authoritative names, from the Turtle SQL dumps) ----
const T_ITEM = [
  "entry", "class", "subclass", "name", "description", "display_id", "quality", "flags",
  "buy_count", "buy_price", "sell_price", "inventory_type", "allowable_class", "allowable_race",
  "item_level", "required_level", "required_skill", "required_skill_rank", "required_spell",
  "required_honor_rank", "required_city_rank", "required_reputation_faction", "required_reputation_rank",
  "max_count", "stackable", "container_slots",
];
for (let i = 1; i <= 10; i++) T_ITEM.push(`stat_type${i}`, `stat_value${i}`); // interleaved type1,value1,...
T_ITEM.push("delay", "range_mod", "ammo_type");
for (let i = 1; i <= 5; i++) T_ITEM.push(`dmg_min${i}`, `dmg_max${i}`, `dmg_type${i}`);
T_ITEM.push("block", "armor", "holy_res", "fire_res", "nature_res", "frost_res", "shadow_res", "arcane_res");
for (let i = 1; i <= 5; i++) T_ITEM.push(`spellid_${i}`, `spelltrigger_${i}`, `spellcharges_${i}`, `spellppmrate_${i}`, `spellcooldown_${i}`, `spellcategory_${i}`, `spellcategorycooldown_${i}`);
T_ITEM.push("bonding", "page_text", "page_language", "page_material", "start_quest", "lock_id", "material",
  "sheath", "random_property", "set_id", "max_durability", "area_bound", "map_bound", "duration",
  "bag_family", "disenchant_id", "food_type", "min_money_loot", "max_money_loot", "wrapped_gift",
  "extra_flags", "other_team_entry", "script_name");

const T_CREATURE_TPL = [
  "entry", "display_id1", "display_id2", "display_id3", "display_id4", "mount_display_id", "name", "subname",
  "gossip_menu_id", "level_min", "level_max", "health_min", "health_max", "mana_min", "mana_max", "armor",
  "faction", "npc_flags", "speed_walk", "speed_run", "scale", "detection_range", "call_for_help_range",
  "leash_range", "rank", "xp_multiplier", "dmg_min", "dmg_max", "dmg_school", "attack_power", "dmg_multiplier",
  "base_attack_time", "ranged_attack_time", "unit_class", "unit_flags", "dynamic_flags", "beast_family",
  "trainer_type", "trainer_spell", "trainer_class", "trainer_race", "ranged_dmg_min", "ranged_dmg_max",
  "ranged_attack_power", "type", "type_flags", "loot_id", "pickpocket_loot_id", "skinning_loot_id",
  "holy_res", "fire_res", "nature_res", "frost_res", "shadow_res", "arcane_res", "spell_id1", "spell_id2",
  "spell_id3", "spell_id4", "spell_list_id", "pet_spell_list_id", "spawn_spell_id", "auras", "gold_min",
  "gold_max", "ai_name", "movement_type", "inhabit_type", "civilian", "racial_leader", "regeneration",
  "equipment_id", "trainer_id", "vendor_id", "mechanic_immune_mask", "school_immune_mask", "immunity_flags",
  "flags_extra", "phase_quest_id", "script_name",
];

const T_CREATURE = ["guid", "id", "id2", "id3", "id4", "map", "position_x", "position_y", "position_z",
  "orientation", "spawntimesecsmin", "spawntimesecsmax", "wander_distance", "health_percent", "mana_percent",
  "movement_type", "spawn_flags", "visibility_mod"];

const T_GAMEOBJECT = ["guid", "id", "map", "position_x", "position_y", "position_z", "orientation",
  "rotation0", "rotation1", "rotation2", "rotation3", "spawntimesecsmin", "spawntimesecsmax",
  "animprogress", "state", "spawn_flags", "visibility_mod"];

const T_QUEST = ["entry", "Method", "ZoneOrSort", "MinLevel", "MaxLevel", "QuestLevel", "Type",
  "RequiredClasses", "RequiredRaces", "RequiredSkill", "RequiredSkillValue", "RequiredCondition",
  "RepObjectiveFaction", "RepObjectiveValue", "RequiredMinRepFaction", "RequiredMinRepValue",
  "RequiredMaxRepFaction", "RequiredMaxRepValue", "SuggestedPlayers", "LimitTime", "QuestFlags",
  "SpecialFlags", "PrevQuestId", "NextQuestId", "ExclusiveGroup", "NextQuestInChain", "SrcItemId",
  "SrcItemCount", "SrcSpell", "Title", "Details", "Objectives", "OfferRewardText", "RequestItemsText",
  "EndText", ...seq(4, "ObjectiveText"), ...seq(4, "ReqItemId"), ...seq(4, "ReqItemCount"),
  ...seq(4, "ReqSourceId"), ...seq(4, "ReqSourceCount"), ...seq(4, "ReqCreatureOrGOId"),
  ...seq(4, "ReqCreatureOrGOCount"), ...seq(4, "ReqSpellCast"), ...seq(6, "RewChoiceItemId"),
  ...seq(6, "RewChoiceItemCount"), ...seq(4, "RewItemId"), ...seq(4, "RewItemCount"),
  ...seq(5, "RewRepFaction"), ...seq(5, "RewRepValue"), "RewXP", "RewOrReqMoney", "RewMoneyMaxLevel",
  "RewSpell", "RewSpellCast", "RewMailTemplateId", "RewMailDelaySecs", "RewMailMoney", "PointMapId",
  "PointX", "PointY", "PointOpt", ...seq(4, "DetailsEmote"), ...seq(4, "DetailsEmoteDelay"),
  "IncompleteEmote", "CompleteEmote", ...seq(4, "OfferRewardEmote"), ...seq(4, "OfferRewardEmoteDelay"),
  "StartScript", "CompleteScript"];

// spell_template read-set (build-db's `at(...)` names). EMPTY stub for the core slice.
const T_SPELL = ["entry", "name", "description", "auraDescription", "nameSubtext", "spellIconId", "stances",
  "school", "powerType", "manaCost", "manaCostPercentage", "castingTimeIndex", "rangeIndex", "durationIndex",
  "recoveryTime", "categoryRecoveryTime", "startRecoveryTime", "procChance", "dispel", "mechanic", "spellLevel",
  "attributes", "attributesEx", "attributesEx2", "attributesEx3", "attributesEx4",
  ...seq(3, "effect", "effectBasePoints", "effectDieSides", "effectApplyAuraName", "effectMiscValue",
    "effectItemType", "effectTriggerSpell", "effectRadiusIndex", "effectAmplitude"),
  ...seq(8, "reagent", "reagentCount")];

const LOOT = ["entry", "item", "ChanceOrQuestChance", "groupid", "mincountOrRef", "maxcount"];

// target column list per staged table (Turtle names). Missing entries fall back to the
// STAGE_SPECS `columns` (small relation/vendor tables share cmangos' own names).
const TARGET = {
  item_template: T_ITEM,
  creature_template: T_CREATURE_TPL,
  creature: T_CREATURE,
  gameobject: T_GAMEOBJECT,
  quest_template: T_QUEST,
  spell_template: T_SPELL,
  gameobject_template: ["entry", "type", "displayId", "name", "data0", "data1"],
  item_display_info: ["ID", "icon"],
  area_template: ["entry", "name", "map_id", "zone_id"],
  faction: ["id", "name1", "reputation_list_id"],
  faction_template: ["id", "faction_id"],
  map_template: ["entry", "parent", "map_type", "linked_zone", "player_limit", "reset_delay", "time_offset",
    "ghost_entrance_map", "ghost_entrance_x", "ghost_entrance_y", "map_name", "script_name"],
  skill_line_ability: ["id", "skill_id", "spell_id", "race_mask", "class_mask", "req_skill_value",
    "superseded_by_spell", "learn_on_get_skill", "max_value", "min_value", "req_train_points"],
  npc_vendor: ["entry", "item", "maxcount", "incrtime"],
  npc_vendor_template: ["entry", "item", "maxcount", "incrtime"],
  page_text: ["entry", "text", "next_page"],
  creature_onkill_reputation: ["creature_id", "RewOnKillRepFaction1", "RewOnKillRepValue1", "MaxStanding1",
    "RewOnKillRepFaction2", "RewOnKillRepValue2", "MaxStanding2"],
  creature_questrelation: ["id", "quest"],
  creature_involvedrelation: ["id", "quest"],
  gameobject_questrelation: ["id", "quest"],
  gameobject_involvedrelation: ["id", "quest"],
  npc_trainer: ["entry", "spell", "spellcost", "reqskill", "reqskillvalue", "reqlevel"],
  npc_trainer_template: ["entry", "spell", "spellcost", "reqskill", "reqskillvalue", "reqlevel"],
  item_enchantment_template: ["entry", "ench", "chance"],
};
for (const t of ["creature_loot_template", "gameobject_loot_template", "item_loot_template",
  "disenchant_loot_template", "fishing_loot_template", "pickpocketing_loot_template",
  "skinning_loot_template", "reference_loot_template"]) TARGET[t] = LOOT;

// explicit renames: turtleCol -> cmangos column (or SQL expr). Only names that don't
// match case-insensitively. Absent-in-cmangos columns need no entry (they become NULL).
const RENAMES = {
  item_template: {
    display_id: "displayid", buy_count: "BuyCount", buy_price: "BuyPrice", sell_price: "SellPrice",
    inventory_type: "InventoryType", allowable_class: "AllowableClass", allowable_race: "AllowableRace",
    item_level: "ItemLevel", required_level: "RequiredLevel", required_skill: "RequiredSkill",
    required_skill_rank: "RequiredSkillRank", required_spell: "requiredspell",
    required_honor_rank: "requiredhonorrank", required_city_rank: "RequiredCityRank",
    required_reputation_faction: "RequiredReputationFaction", required_reputation_rank: "RequiredReputationRank",
    max_count: "maxcount", container_slots: "ContainerSlots", range_mod: "RangedModRange",
    page_text: "PageText", page_language: "LanguageID", page_material: "PageMaterial",
    start_quest: "startquest", lock_id: "lockid", random_property: "RandomProperty", set_id: "itemset",
    max_durability: "MaxDurability", area_bound: "area", map_bound: "Map", bag_family: "BagFamily",
    disenchant_id: "DisenchantID", food_type: "FoodType", min_money_loot: "minMoneyLoot",
    max_money_loot: "maxMoneyLoot",
  },
  creature_template: {
    display_id1: "DisplayId1", display_id2: "DisplayId2", display_id3: "DisplayId3", display_id4: "DisplayId4",
    gossip_menu_id: "GossipMenuId", level_min: "MinLevel", level_max: "MaxLevel",
    health_min: "MinLevelHealth", health_max: "MaxLevelHealth", mana_min: "MinLevelMana", mana_max: "MaxLevelMana",
    npc_flags: "NpcFlags", detection_range: "Detection", call_for_help_range: "CallForHelp", leash_range: "Leash",
    xp_multiplier: "ExperienceMultiplier", dmg_min: "MinMeleeDmg", dmg_max: "MaxMeleeDmg", dmg_school: "DamageSchool",
    attack_power: "MeleeAttackPower", dmg_multiplier: "DamageMultiplier", base_attack_time: "MeleeBaseAttackTime",
    ranged_attack_time: "RangedBaseAttackTime", beast_family: "Family", ranged_dmg_min: "MinRangedDmg",
    ranged_dmg_max: "MaxRangedDmg", type: "CreatureType", type_flags: "CreatureTypeFlags",
    holy_res: "ResistanceHoly", fire_res: "ResistanceFire", nature_res: "ResistanceNature",
    frost_res: "ResistanceFrost", shadow_res: "ResistanceShadow", arcane_res: "ResistanceArcane",
    spell_list_id: "SpellList", gold_min: "MinLootGold", gold_max: "MaxLootGold", ai_name: "AIName",
    regeneration: "RegenerateStats", equipment_id: "EquipmentTemplateId", trainer_id: "TrainerTemplateId",
    vendor_id: "VendorTemplateId", flags_extra: "ExtraFlags",
  },
  creature: { wander_distance: "spawndist", movement_type: "MovementType" },
  spell_template: { entry: "Id" },
};

// tables cmangos lacks OR we defer -> staged empty (Turtle columns, zero rows).
const FORCE_EMPTY = new Set(["spell_template"]);

export function buildCmangosStaging(db, cmangosPath, STAGE_SPECS) {
  const p = cmangosPath.replace(/\\/g, "/").replace(/'/g, "''");
  db.exec(`ATTACH '${p}' AS cm`);

  const pkOf = Object.fromEntries(STAGE_SPECS.map((s) => [s.table, s.pk]));
  // every table build-db reads: the staged specs + item_enchantment_template (read via
  // the srcRows dump fallback in the Turtle build, so it must be provided here too).
  const tables = [...new Set([...STAGE_SPECS.map((s) => s.table), "item_enchantment_template"])];

  const cmHas = (t) => !!db.prepare(`SELECT 1 FROM cm.sqlite_master WHERE type='table' AND name=?`).get(t);
  const cmCols = (t) => new Set(db.prepare(`SELECT name FROM pragma_table_info('${t}','cm')`).all().map((r) => r.name.toLowerCase()));

  const colsByTable = {};
  const staged = new Set();
  const stats = { files: 0, applied: 0, skipped: 0, errors: 0, empty: [] };

  for (const table of tables) {
    const cols = TARGET[table];
    if (!cols) { console.warn(`  cmangos-adapter: no target columns for ${table} — skipped`); continue; }
    colsByTable[table] = cols;
    staged.add(table);
    const pk = pkOf[table];
    const hasPk = pk && cols.includes(pk);
    const defs = cols.map((c) => (c === pk && hasPk ? `\`${c}\` INTEGER PRIMARY KEY` : `\`${c}\` NUMERIC`));
    db.exec(`CREATE TABLE \`${PFX}${table}\` (${defs.join(", ")})`);

    if (FORCE_EMPTY.has(table) || !cmHas(table)) { stats.empty.push(table); continue; }

    const src = cmCols(table);
    const rn = RENAMES[table] || {};
    const exprs = cols.map((c) => {
      if (rn[c]) return `\`${rn[c]}\` AS \`${c}\``;
      if (src.has(c.toLowerCase())) return `\`${c}\` AS \`${c}\``;
      return `NULL AS \`${c}\``;
    });
    db.exec(`INSERT OR REPLACE INTO \`${PFX}${table}\` (${cols.map((c) => `\`${c}\``).join(",")}) SELECT ${exprs.join(", ")} FROM cm.\`${table}\``);
    stats.applied++;
  }

  return {
    has: (table) => staged.has(table),
    columns: (table) => colsByTable[table],
    rows: function* (table) {
      const cols = colsByTable[table];
      if (!cols) return;
      for (const r of db.prepare(`SELECT * FROM \`${PFX}${table}\``).all()) yield cols.map((c) => r[c]);
    },
    drop: () => { for (const t of staged) db.exec(`DROP TABLE \`${PFX}${t}\``); db.exec("DETACH cm"); },
    stats,
  };
}
