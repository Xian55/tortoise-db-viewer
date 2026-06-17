// Import specs: which dump files/columns become which SQLite tables.
// `columns: null` keeps every column from the source CREATE TABLE.
// `text` lists columns that should be stored as TEXT (everything else INTEGER).

export const IMPORTS = [
  {
    file: "tw_world_item_template.sql",
    table: "item_template",
    target: "items",
    columns: null, // keep all 130 columns
    text: ["name", "description", "script_name"],
    pk: "entry",
    indexes: [], // name search handled by FTS5 (see build-db)
  },
  {
    file: "tw_world_item_display_info.sql",
    table: "item_display_info",
    target: "item_display_info",
    columns: ["ID", "icon"],
    text: ["icon"],
    pk: "ID",
    indexes: [],
  },
  {
    file: "tw_world_creature_template.sql",
    table: "creature_template",
    target: "creatures",
    columns: ["entry", "name", "subname", "level_min", "level_max", "rank", "type", "faction",
      "health_min", "health_max", "npc_flags", "loot_id", "pickpocket_loot_id", "skinning_loot_id"],
    text: ["name", "subname"],
    pk: "entry",
    indexes: ["loot_id", "pickpocket_loot_id", "skinning_loot_id"],
  },
  {
    file: "tw_world_creature_questrelation.sql",
    table: "creature_questrelation",
    target: "creature_quest_start",
    columns: ["id", "quest"],
    text: [],
    pk: null,
    indexes: ["id", "quest"],
  },
  {
    file: "tw_world_creature_involvedrelation.sql",
    table: "creature_involvedrelation",
    target: "creature_quest_end",
    columns: ["id", "quest"],
    text: [],
    pk: null,
    indexes: ["id", "quest"],
  },
  {
    file: "tw_world_gameobject_template.sql",
    table: "gameobject_template",
    target: "gameobjects",
    columns: ["entry", "type", "displayId", "name", "data1"],
    text: ["name"],
    pk: "entry",
    indexes: ["data1"],
  },
  {
    file: "tw_world_npc_vendor.sql",
    table: "npc_vendor",
    target: "npc_vendor",
    columns: ["entry", "item", "maxcount", "incrtime"],
    text: [],
    pk: null,
    indexes: ["item", "entry"],
  },
];

// Loot tables share the same shape; loaded in a loop.
export const LOOT_TABLES = [
  { file: "tw_world_creature_loot_template.sql", table: "creature_loot_template", target: "loot_creature" },
  { file: "tw_world_gameobject_loot_template.sql", table: "gameobject_loot_template", target: "loot_object" },
  { file: "tw_world_item_loot_template.sql", table: "item_loot_template", target: "loot_item" },
  { file: "tw_world_disenchant_loot_template.sql", table: "disenchant_loot_template", target: "loot_disenchant" },
  { file: "tw_world_fishing_loot_template.sql", table: "fishing_loot_template", target: "loot_fishing" },
  { file: "tw_world_pickpocketing_loot_template.sql", table: "pickpocketing_loot_template", target: "loot_pickpocket" },
  { file: "tw_world_skinning_loot_template.sql", table: "skinning_loot_template", target: "loot_skinning" },
  { file: "tw_world_reference_loot_template.sql", table: "reference_loot_template", target: "loot_reference" },
];

export const LOOT_COLUMNS = ["entry", "item", "ChanceOrQuestChance", "groupid", "mincountOrRef", "maxcount"];
