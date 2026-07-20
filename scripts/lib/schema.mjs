// Import specs: which dump files/columns become which SQLite tables.
// `columns: null` keeps every column from the source CREATE TABLE.
// `text` lists columns that should be stored as TEXT, `real` as REAL
// (everything else INTEGER).

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
      "health_min", "health_max", "npc_flags", "loot_id", "pickpocket_loot_id", "skinning_loot_id",
      "display_id1", "vendor_id", "beast_family", "type_flags",
      // Combat stats (the NPC page's stat block, wowhead-style). dmg_* are folded
      // by dmg_multiplier in build-db (the server applies it at damage calc), then
      // dmg_multiplier is dropped. unit_class picks the power bar (1 warrior/rage,
      // 2 paladin/mana, 4 rogue/energy, 8 mage/mana).
      "mana_min", "mana_max", "armor", "dmg_min", "dmg_max", "dmg_multiplier", "dmg_school",
      "attack_power", "base_attack_time", "ranged_attack_time", "ranged_dmg_min", "ranged_dmg_max",
      "ranged_attack_power", "unit_class", "holy_res", "fire_res", "nature_res", "frost_res",
      "shadow_res", "arcane_res", "gold_min", "gold_max", "mechanic_immune_mask", "school_immune_mask",
      // Ability sources -> the derived creature_ability table, then dropped.
      "spell_id1", "spell_id2", "spell_id3", "spell_id4", "spell_list_id", "auras",
      // script_name keys the ScriptDev2 C++ fights (script-abilities.json).
      "script_name"],
    // display_id1 -> renamed to display_id in build-db; vendor_id -> npc_vendor_template;
    // beast_family -> renamed pet_family; type_flags -> derives tameable then dropped.
    text: ["name", "subname", "auras", "script_name"],
    real: ["dmg_min", "dmg_max", "dmg_multiplier", "ranged_dmg_min", "ranged_dmg_max"],
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
    // data0 = lockId (gather skill via Lock.dbc -> gameobjects.gather); data1 = loot ref.
    columns: ["entry", "type", "displayId", "name", "data0", "data1"],
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
  {
    // Shared vendor lists referenced by creature_template.vendor_id (many Turtle
    // vendors stock via a template instead of per-entry npc_vendor rows).
    file: "tw_world_npc_vendor_template.sql",
    table: "npc_vendor_template",
    target: "npc_vendor_template",
    columns: ["entry", "item", "maxcount", "incrtime"],
    text: [],
    pk: null,
    indexes: ["item", "entry"],
  },
  {
    // Zone-name lookup for quests (positive ZoneOrSort -> area_template.entry).
    // map_id (continent) + zone_id (parent zone, 0 if top-level) give the area
    // hierarchy so a quest in a sub-zone resolves continent > zone > sub-zone.
    file: "tw_world_area_template.sql",
    table: "area_template",
    target: "areas",
    columns: ["entry", "name", "map_id", "zone_id"],
    text: ["name"],
    pk: "entry",
    indexes: [],
  },
  {
    // Faction names for quest reputation rewards + the factions feature
    // (id + English name + reputation_list_id; skip the large desc columns).
    file: "tw_world_faction.sql",
    table: "faction",
    target: "faction_names",
    columns: ["id", "name1", "reputation_list_id"],
    text: ["name1"],
    pk: "id",
    indexes: [],
  },
  {
    // FactionTemplate -> Faction (reputation) id. creature_template.faction is a
    // FactionTemplate id; this maps it to the rep Faction so a faction page can
    // list its member NPCs (faction_id = the rep Faction).
    file: "tw_world_faction_template.sql",
    table: "faction_template",
    target: "faction_template",
    columns: ["id", "faction_id"],
    text: [],
    pk: "id",
    indexes: ["faction_id"],
  },
  {
    // Reputation gained per kill (for the reputation grind calculator). Each
    // creature has up to two faction/value slots; MaxStanding caps how far kills
    // can raise you. RewOnKillRepFaction{1,2} are Faction ids (= faction_names.id).
    file: "tw_world_creature_onkill_reputation.sql",
    table: "creature_onkill_reputation",
    target: "creature_onkill_rep",
    columns: ["creature_id", "RewOnKillRepFaction1", "RewOnKillRepValue1", "MaxStanding1",
      "RewOnKillRepFaction2", "RewOnKillRepValue2", "MaxStanding2"],
    text: [],
    pk: "creature_id",
    indexes: [],
  },
  {
    // Readable book/letter/plaque text (page_text.entry -> text, chained via
    // next_page). items.page_text and type-9 gameobjects' data0 point at the first
    // page; the viewer walks the chain to show the prose. Staged so migration-added
    // pages (patch books/plaques) flow in; shipped whole (small, ~1.5k rows).
    file: "tw_world_page_text.sql",
    table: "page_text",
    target: "page_text",
    columns: ["entry", "text", "next_page"],
    text: ["text"],
    pk: "entry",
    indexes: [],
  },
  {
    // GameObjects that start a quest (e.g. a book/altar).
    file: "tw_world_gameobject_questrelation.sql",
    table: "gameobject_questrelation",
    target: "gameobject_quest_start",
    columns: ["id", "quest"],
    text: [],
    pk: null,
    indexes: ["id", "quest"],
  },
  {
    // GameObjects that complete a quest.
    file: "tw_world_gameobject_involvedrelation.sql",
    table: "gameobject_involvedrelation",
    target: "gameobject_quest_end",
    columns: ["id", "quest"],
    text: [],
    pk: null,
    indexes: ["id", "quest"],
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
