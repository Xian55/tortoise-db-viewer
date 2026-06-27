// SQL run in-browser against the fully-loaded SQLite database.
// Positional ?1 params (a single id reused across the query binds as [id]).
// Drop chances come from the precomputed `drops` table (src: c=creature,
// s=skinning, p=pickpocket, o=object, i=item-container, e=disenchant), which
// already resolves equal-chance groups and reference multipliers.
import { PROFESSION } from "./constants.js";

// profession skill ids the crafting view recognises (kept in sync with the
// PROFESSION list so adding one there is enough).
const CRAFT_SKILLS = PROFESSION.map(([id]) => id).join(",");

export const Q_ITEM = `
  SELECT i.*, di.icon, rf.name1 AS req_rep_faction
  FROM items i
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  LEFT JOIN faction_names rf ON rf.id = i.required_reputation_faction
  WHERE i.entry = ?1`;

// ---- item sets (name + members + set-bonus spells) ----
export const Q_ITEM_SET = `SELECT id, name FROM item_sets WHERE id = ?1`;
// browse: every set with a current member, + piece count and required-level span.
export const Q_BROWSE_ITEMSETS = `
  SELECT s.id, s.name,
    (SELECT COUNT(*) FROM items i WHERE i.set_id = s.id AND i.hidden = 0) AS pieces,
    (SELECT MIN(i.required_level) FROM items i WHERE i.set_id = s.id AND i.hidden = 0) AS minlvl,
    (SELECT MAX(i.required_level) FROM items i WHERE i.set_id = s.id AND i.hidden = 0) AS maxlvl
  FROM item_sets s WHERE s.name <> '' ORDER BY s.name`;
export const Q_ITEMSET_MEMBERS = `
  SELECT i.entry, i.name, i.quality, di.icon
  FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE i.set_id = ?1 AND i.hidden = 0 ORDER BY i.required_level, i.name`;
// bonuses with the bonus spell's text (s1..d3 let the viewer resolve $s tokens).
export const Q_ITEMSET_BONUSES = `
  SELECT b.threshold, s.entry AS spell, s.name AS spell_name, s.description,
         s.s1, s.s2, s.s3, s.d1, s.d2, s.d3
  FROM item_set_bonus b LEFT JOIN spells s ON s.entry = b.spell
  WHERE b.setid = ?1 ORDER BY b.threshold`;
// per-member stat rows for the set summary (item, stat, value).
export const Q_ITEMSET_STATS = `
  SELECT st.item, st.stat, st.value FROM item_stats st
  WHERE st.item IN (SELECT entry FROM items WHERE set_id = ?1 AND hidden = 0)`;

// ---- Unified search (items/NPCs/quests via FTS5; dungeons via LIKE) ----
// FTS queries: ?1 = FTS MATCH string (prefix tokens), ?2 = raw term (exact/prefix
// tiebreak), ?3 = LIMIT. Dungeons: ?1 = LIKE pattern, ?2 = raw term, ?3 = LIMIT.
export const Q_SEARCH_ITEMS = `
  SELECT i.entry, i.name, i.quality, i.item_level, i.required_level, di.icon
  FROM items_fts f JOIN items i ON i.entry = f.rowid
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE items_fts MATCH ?1
  ORDER BY (i.name = ?2) DESC, (i.name LIKE ?2 || '%') DESC, i.quality DESC, i.item_level DESC
  LIMIT ?3`;

export const Q_SEARCH_NPCS = `
  SELECT c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank, c.type
  FROM creatures_fts f JOIN creatures c ON c.entry = f.rowid
  WHERE creatures_fts MATCH ?1
  ORDER BY (c.name = ?2) DESC, (c.name LIKE ?2 || '%') DESC, c.level_max DESC
  LIMIT ?3`;

// Factions by name (LIKE over the small derived `factions` summary).
export const Q_SEARCH_FACTIONS = `
  SELECT id, name FROM factions
  WHERE name LIKE ?1
  ORDER BY (name = ?2) DESC, name
  LIMIT ?3`;

export const Q_SEARCH_QUESTS = `
  SELECT q.entry, q.title, q.level, q.zone, q.type
  FROM quests_fts f JOIN quests q ON q.entry = f.rowid
  WHERE quests_fts MATCH ?1
  ORDER BY (q.title = ?2) DESC, (q.title LIKE ?2 || '%') DESC, q.level
  LIMIT ?3`;

export const Q_SEARCH_SPELLS = `
  SELECT s.entry, s.name, s.icon, s.skill
  FROM spells_fts f JOIN spells s ON s.entry = f.rowid
  WHERE spells_fts MATCH ?1
  ORDER BY (s.name = ?2) DESC, (s.name LIKE ?2 || '%') DESC, s.name, s.entry
  LIMIT ?3`;

export const Q_SEARCH_DUNGEONS = `
  SELECT id, name, type FROM maps
  WHERE type IN (1,2) AND name LIKE ?1 AND hidden = 0
  ORDER BY (name = ?2) DESC, name
  LIMIT ?3`;

// Zones use LIKE over the ~120 named WorldMap areas (no FTS table needed).
export const Q_SEARCH_ZONES = `
  SELECT areaid, name, mapid FROM zones
  WHERE name <> '' AND name LIKE ?1
  ORDER BY (name = ?2) DESC, name
  LIMIT ?3`;

export const Q_SEARCH_ITEMSETS = `
  SELECT id, name FROM item_sets
  WHERE name <> '' AND name LIKE ?1
  ORDER BY (name = ?2) DESC, name
  LIMIT ?3`;

// Objects (interactive gameobjects) via LIKE over the small object_browse table.
export const Q_SEARCH_OBJECTS = `
  SELECT entry, name, type FROM object_browse
  WHERE name LIKE ?1
  ORDER BY (name = ?2) DESC, name
  LIMIT ?3`;

// Dropped by NPCs (creature loot / skinning / pickpocket).
export const Q_DROPPED_BY = `
SELECT c.entry, c.name, c.level_min, c.level_max, c.rank,
       MAX(CASE WHEN d.src='c' THEN d.chance END) AS drop_chance,
       MAX(CASE WHEN d.src='s' THEN d.chance END) AS skin_chance,
       MAX(CASE WHEN d.src='p' THEN d.chance END) AS pick_chance,
       (SELECT m.name FROM spawns sp JOIN maps m ON m.id=sp.map WHERE sp.id=c.entry AND m.type IN (1,2) ORDER BY m.type DESC LIMIT 1) AS dungeon,
       (SELECT m.id   FROM spawns sp JOIN maps m ON m.id=sp.map WHERE sp.id=c.entry AND m.type IN (1,2) ORDER BY m.type DESC LIMIT 1) AS dungeon_id
FROM drops d
JOIN creatures c ON (d.src='c' AND c.loot_id=d.owner) OR (d.src='s' AND c.skinning_loot_id=d.owner) OR (d.src='p' AND c.pickpocket_loot_id=d.owner)
WHERE d.item = ?1 AND d.src IN ('c','s','p')
GROUP BY c.entry ORDER BY COALESCE(drop_chance, skin_chance, pick_chance) DESC LIMIT 100`;

// Group by name: gathering nodes (herbs/ore) have several gameobject_template
// entries with the same name (different models/phases, same loot) -> one row each.
export const Q_OBJECT_SOURCE = `
  SELECT MIN(g.entry) AS entry, g.name, MAX(d.chance) AS chance
  FROM drops d JOIN gameobjects g ON g.data1 = d.owner
  WHERE d.src='o' AND d.item = ?1 GROUP BY g.name ORDER BY chance DESC LIMIT 50`;

// NPCs that sell an item: direct npc_vendor entries + creatures whose vendor_id
// references a npc_vendor_template that stocks it.
export const Q_SOLD_BY = `
  SELECT DISTINCT c.entry, c.name, c.level_min, c.level_max,
    COALESCE((SELECT maxcount FROM npc_vendor WHERE entry = c.entry AND item = ?1),
             (SELECT maxcount FROM npc_vendor_template WHERE entry = c.vendor_id AND item = ?1)) AS maxcount
  FROM creatures c
  WHERE c.entry IN (SELECT entry FROM npc_vendor WHERE item = ?1)
     OR c.vendor_id IN (SELECT entry FROM npc_vendor_template WHERE item = ?1)
  ORDER BY c.name LIMIT 100`;

export const Q_CONTAINED_IN = `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance
  FROM drops d JOIN items i ON i.entry = d.owner
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE d.src='i' AND d.item = ?1 ORDER BY d.chance DESC LIMIT 50`;

// Items this container/lockbox yields when opened (the inverse of CONTAINED_IN).
export const Q_CONTAINS = `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance
  FROM drops d JOIN items i ON i.entry = d.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE d.src='i' AND d.owner = ?1 ORDER BY d.chance DESC LIMIT 100`;

export const Q_DISENCHANTS_INTO = `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance
  FROM drops d JOIN items i ON i.entry = d.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE d.src='e' AND d.owner = (SELECT disenchant_id FROM items WHERE entry = ?1)
  ORDER BY d.chance DESC`;

export const Q_QUEST_ITEM = `SELECT q.entry, q.title, q.level, q.reqraces, qi.role, qi.count FROM quest_item qi JOIN quests q ON q.entry = qi.quest WHERE qi.item = ?1 ORDER BY qi.role, q.level LIMIT 100`;
export const Q_STARTS_QUEST = `SELECT q.entry, q.title, q.level, q.reqraces FROM quests q WHERE q.entry = (SELECT start_quest FROM items WHERE entry = ?1) AND q.entry > 0`;

export const Q_CREATED_BY = `
  SELECT s.entry, s.name, s.icon AS spell_icon, sc.skill, sc.skill_req, ci.entry AS reagent_item, ci.name AS reagent_name, ci.quality AS reagent_quality, di.icon AS reagent_icon, sr.count,
         cs.recipe_item, cs.trainer, cs.auto, cs.learn_req, rc.name AS recipe_name, rc.quality AS recipe_quality, rcdi.icon AS recipe_icon
  FROM spell_creates sc JOIN spells s ON s.entry = sc.spell
  LEFT JOIN spell_reagent sr ON sr.spell = sc.spell
  LEFT JOIN items ci ON ci.entry = sr.item
  LEFT JOIN item_display_info di ON di.ID = ci.display_id
  LEFT JOIN craft_source cs ON cs.spell = sc.spell
  LEFT JOIN items rc ON rc.entry = cs.recipe_item
  LEFT JOIN item_display_info rcdi ON rcdi.ID = rc.display_id
  WHERE sc.item = ?1 ORDER BY s.entry`;

export const Q_REAGENT_FOR = `
  SELECT s.entry AS spell, s.name AS spell_name, s.icon AS spell_icon, ci.entry AS created, ci.name AS created_name, ci.quality, di.icon AS created_icon
  FROM spell_reagent sr JOIN spells s ON s.entry = sr.spell
  LEFT JOIN spell_creates sc ON sc.spell = sr.spell
  LEFT JOIN items ci ON ci.entry = sc.item
  LEFT JOIN item_display_info di ON di.ID = ci.display_id
  WHERE sr.item = ?1 GROUP BY s.entry, ci.entry ORDER BY ci.quality DESC LIMIT 100`;

// What a recipe/pattern/plans item teaches: the craft it unlocks and the item
// that craft produces (recipe item -> craft_source -> spell -> spell_creates).
export const Q_TEACHES = `
  SELECT s.entry AS spell, s.name AS spell_name, sc.skill, sc.skill_req, sc.skill_min, sc.skill_max,
         cs.learn_req, ci.entry AS item, ci.name AS item_name, ci.quality, di.icon AS item_icon
  FROM craft_source cs
  JOIN spell_creates sc ON sc.spell = cs.spell
  JOIN spells s ON s.entry = cs.spell
  JOIN items ci ON ci.entry = sc.item
  LEFT JOIN item_display_info di ON di.ID = ci.display_id
  WHERE cs.recipe_item = ?1
  GROUP BY ci.entry ORDER BY ci.quality DESC LIMIT 50`;

export const Q_ITEM_SOURCES = `SELECT source FROM item_sources WHERE item = ?1`;

// Every spawn point of the gathering object(s) that yield this item (herb/ore
// nodes etc.), for the per-zone farm breakdown. Grouped into zones client-side.
// CROSS JOIN pins the join order to the selective driver (drops.item) instead of
// letting the planner scan every object spawn (kind='o'): ~272ms -> ~1ms for a
// common ore. drops -> gameobjects(data1) -> spawn_points(kind,id), all indexed.
export const Q_ITEM_OBJECT_SPAWNS = `
  SELECT g.entry, g.name, s.zone AS areaid, z.name AS zone
  FROM drops d
  CROSS JOIN gameobjects g ON g.data1 = d.owner
  CROSS JOIN spawn_points s ON s.kind = 'o' AND s.id = g.entry
  LEFT JOIN zones z ON z.areaid = s.zone
  WHERE d.src = 'o' AND d.item = ?1 LIMIT 30000`;

export const Q_ITEM_ICON = `SELECT i.name, di.icon FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id WHERE i.entry = ?1`;

// Spawn points within a zone of the object(s) that yield a given item -- powers
// the focused "show only Earthroot nodes" view. ?1=zone areaid, ?2=item.
// CROSS JOIN pins the order (drops -> gameobjects -> spawn_points); INDEXED BY
// keeps s on idx_spawn_id (kind,id).
export const Q_ZONE_FOCUS_SPAWNS = `
  SELECT g.name, s.x, s.y
  FROM drops d
  CROSS JOIN gameobjects g ON g.data1 = d.owner
  CROSS JOIN spawn_points s INDEXED BY idx_spawn_id ON s.kind = 'o' AND s.id = g.entry
  WHERE d.src = 'o' AND d.item = ?2 AND s.zone = ?1 LIMIT 5000`;

// All crafts (browse Crafting view). One row per (craft spell, reagent); the view
// groups reagents per spell client-side. skill_min/skill_max give the yellow/grey
// skill-up thresholds (green = midpoint). craft_source resolves trainer vs recipe.
export const Q_CRAFTING = `
  SELECT sc.spell, s.name AS spell_name, s.icon AS spell_icon, sc.skill, sc.skill_req, sc.skill_min, sc.skill_max,
         ci.entry AS item, ci.name AS item_name, ci.quality, cdi.icon AS item_icon,
         sr.item AS reagent, ri.name AS reagent_name, ri.quality AS reagent_quality, rdi.icon AS reagent_icon, sr.count,
         cs.trainer, cs.auto, cs.learn_req, cs.recipe_item, rc.name AS recipe_name, rc.quality AS recipe_quality, rcdi.icon AS recipe_icon
  FROM spell_creates sc
  JOIN spells s ON s.entry = sc.spell
  LEFT JOIN items ci ON ci.entry = sc.item
  LEFT JOIN item_display_info cdi ON cdi.ID = ci.display_id
  LEFT JOIN spell_reagent sr ON sr.spell = sc.spell
  LEFT JOIN items ri ON ri.entry = sr.item
  LEFT JOIN item_display_info rdi ON rdi.ID = ri.display_id
  LEFT JOIN craft_source cs ON cs.spell = sc.spell
  LEFT JOIN items rc ON rc.entry = cs.recipe_item
  LEFT JOIN item_display_info rcdi ON rcdi.ID = rc.display_id
  WHERE sc.skill IN (${CRAFT_SKILLS})
  ORDER BY sc.skill, COALESCE(ci.name, s.name), sc.spell`;

// SELECT * so the detailed spell page gets every combat/effect column; the item
// tooltip + quest callers just read the handful they need (name/desc/icon/teaches/sN).
export const Q_SPELL = `SELECT * FROM spells WHERE entry = ?1`;

// ---- Spell detail page ----
// Items this craft spell produces (+ the skill-up thresholds for difficulty).
export const Q_SPELL_PRODUCES = `
  SELECT sc.item, ci.name AS item_name, ci.quality, di.icon AS item_icon,
         sc.skill, sc.skill_req, sc.skill_min, sc.skill_max
  FROM spell_creates sc
  JOIN items ci ON ci.entry = sc.item
  LEFT JOIN item_display_info di ON di.ID = ci.display_id
  WHERE sc.spell = ?1 ORDER BY ci.quality DESC, ci.name`;

// Reagents the craft consumes.
export const Q_SPELL_REAGENTS = `
  SELECT sr.item, ri.name AS item_name, ri.quality, di.icon AS item_icon, sr.count
  FROM spell_reagent sr
  JOIN items ri ON ri.entry = sr.item
  LEFT JOIN item_display_info di ON di.ID = ri.display_id
  WHERE sr.spell = ?1 ORDER BY ri.name`;

// Items that grant/teach this spell (any of their 5 spell slots references it) --
// the reverse of the item tooltip's green spell lines (consumables, recipes, …).
export const Q_SPELL_USED_BY = `
  SELECT i.entry, i.name, i.quality, di.icon
  FROM items i
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE i.spellid_1 = ?1 OR i.spellid_2 = ?1 OR i.spellid_3 = ?1 OR i.spellid_4 = ?1 OR i.spellid_5 = ?1
  ORDER BY i.quality DESC, i.name LIMIT 200`;

// Trainer NPCs that teach this spell (resolved through the learn-spell indirection
// in build-db). Capped; the page notes the total separately if needed.
export const Q_SPELL_TRAINERS = `
  SELECT c.entry, c.name, c.level_min, c.level_max
  FROM spell_trainer st JOIN creatures c ON c.entry = st.npc
  WHERE st.spell = ?1 AND c.name <> ''
  ORDER BY c.level_min, c.name LIMIT 200`;

// Items (book/tome/recipe) whose Use "learn" effect teaches this spell.
export const Q_SPELL_BOOKS = `
  SELECT i.entry, i.name, i.quality, di.icon
  FROM spell_taught_item sti JOIN items i ON i.entry = sti.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE sti.spell = ?1 ORDER BY i.quality DESC, i.name LIMIT 100`;

// Quests that reward (teach) this spell (e.g. the Dreadsteed quest -> Summon Dreadsteed).
export const Q_SPELL_REWARD_QUESTS = `
  SELECT entry, title, level FROM quests
  WHERE rewspell = ?1 AND title <> '' AND hidden = 0 ORDER BY level, title LIMIT 100`;

// How the craft is learned: the recipe/pattern/plans item, or Trainer / Auto.
export const Q_SPELL_SOURCE = `
  SELECT cs.recipe_item, cs.trainer, cs.auto, cs.learn_req,
         rc.name AS recipe_name, rc.quality AS recipe_quality, rcdi.icon AS recipe_icon
  FROM craft_source cs
  LEFT JOIN items rc ON rc.entry = cs.recipe_item
  LEFT JOIN item_display_info rcdi ON rcdi.ID = rc.display_id
  WHERE cs.spell = ?1`;

// Browse Spells finder: all named spells (profession label resolved client-side).
// teaches IS NULL drops "learn" stub spells (a recipe's twin of the real craft).
export const Q_BROWSE_SPELLS = `SELECT entry, name, icon, skill, rank, school, mana_cost, power_type, cast_ms, channeled, range_max, spell_level, category, class_mask
  FROM spells WHERE name <> '' AND teaches IS NULL AND hidden = 0 ORDER BY name`;

// ---- NPC (creature) pages ----
export const Q_NPC = `SELECT entry, name, subname, level_min, level_max, rank, type, faction, health_min, health_max, npc_flags, display_id FROM creatures WHERE entry = ?1`;

const npcLoot = (src, ownerCol) => `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance, i.world_drop
  FROM creatures c JOIN drops d ON d.src='${src}' AND d.owner = c.${ownerCol}
  JOIN items i ON i.entry = d.item LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE c.entry = ?1 ORDER BY d.chance DESC LIMIT 500`;
export const Q_NPC_LOOT = npcLoot("c", "loot_id");
export const Q_NPC_SKIN = npcLoot("s", "skinning_loot_id");
export const Q_NPC_PICK = npcLoot("p", "pickpocket_loot_id");

// Items an NPC sells: per-entry npc_vendor rows + the shared npc_vendor_template
// referenced by creature_template.vendor_id (UNION dedups overlaps).
export const Q_NPC_SELLS = `
  SELECT i.entry, i.name, i.quality, di.icon, v.maxcount
  FROM (
    SELECT item, maxcount FROM npc_vendor WHERE entry = ?1
    UNION
    SELECT vt.item, vt.maxcount FROM npc_vendor_template vt
      JOIN creatures c ON c.entry = ?1 AND c.vendor_id = vt.entry
  ) v
  JOIN items i ON i.entry = v.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  ORDER BY i.quality DESC, i.name LIMIT 300`;
// Spells a trainer NPC teaches (reverse of the spell page's "Trained by").
export const Q_NPC_TRAINS = `
  SELECT s.entry, s.name, s.icon, s.rank, s.skill, s.spell_level
  FROM spell_trainer st JOIN spells s ON s.entry = st.spell
  WHERE st.npc = ?1 AND s.name <> ''
  ORDER BY s.spell_level, s.name LIMIT 500`;
export const Q_NPC_STARTS = `SELECT q.entry, q.title, q.level FROM creature_quest_start r JOIN quests q ON q.entry = r.quest WHERE r.id = ?1 ORDER BY q.level`;
export const Q_NPC_ENDS = `SELECT q.entry, q.title, q.level FROM creature_quest_end r JOIN quests q ON q.entry = r.quest WHERE r.id = ?1 ORDER BY q.level`;
export const Q_NPC_MAPS = `
  SELECT DISTINCT m.id, m.name, m.type FROM spawns s JOIN maps m ON m.id = s.map
  WHERE s.id = ?1 AND m.name <> '' ORDER BY m.type DESC, m.name`;

// This NPC's own spawn points (world coords + map + precomputed home zone), to plot
// on its zone map. INDEXED BY forces the spawn-first plan (few rows via idx_spawn_id).
export const Q_NPC_SPAWNS = `
  SELECT x, y, map, zone FROM spawn_points INDEXED BY idx_spawn_id
  WHERE kind = 'c' AND id = ?1 LIMIT 2000`;

const inList = (n) => Array.from({ length: n }, () => "?").join(",");
// Batch location lookup for a set of creature ('c') / object ('o') entries: one row
// per spawn with its precomputed home zone (+ zone name & map type to tag
// Dungeon/Raid). The caller counts per zone and picks the most common.
export const qNpcZoneSpawns = (n, kind = "c") => `
  SELECT s.id AS entry, s.zone AS areaid, z.name, z.mapid, m.type
  FROM spawn_points s INDEXED BY idx_spawn_id
  JOIN zones z ON z.areaid = s.zone
  LEFT JOIN maps m ON m.id = z.mapid
  WHERE s.kind = '${kind === "o" ? "o" : "c"}' AND s.id IN (${inList(n)}) AND s.zone IS NOT NULL`;
// Zone rows (bounds + image dims) for a set of areaids -> render the NPC-page map.
export const qZonesByIds = (n) => `
  SELECT areaid, name, mapid, locleft, locright, loctop, locbottom, img_w, img_h
  FROM zones WHERE areaid IN (${inList(n)})`;

// Start (giver) NPCs for a set of quests (the quest chain), so the chain tab can
// show where each step is picked up. `n` = number of `?` placeholders.
export const qQuestStartNpcs = (n) => `
  SELECT r.quest, c.entry, c.name FROM creature_quest_start r
  JOIN creatures c ON c.entry = r.id
  WHERE r.quest IN (${inList(n)})`;

// ---- gameobjects (browsable "objects": harvest nodes, chests, quest objects) ----
// "Interactive" = the object has loot (drops via data1), starts/ends a quest, or is
// a quest objective. Precomputed into object_browse at build time (grouped by name so
// the many per-zone copies of e.g. "Copper Vein" collapse to one row) -> instant read.
export const Q_BROWSE_OBJECTS = `SELECT entry, name, type, has_loot, spawns FROM object_browse ORDER BY name`;
// Single object header (by entry).
export const Q_OBJECT = `SELECT entry, name, type, displayId, data1 FROM gameobjects WHERE entry = ?1`;
// All entries sharing a name (the group the detail page aggregates over).
export const Q_OBJECT_SIBLINGS = `SELECT entry, data1 FROM gameobjects WHERE name = ?1`;
// Items looted from a set of object loot-ids (data1), highest chance kept per item.
export const qObjectLoot = (n) => `
  SELECT i.entry, i.name, i.quality, di.icon, MAX(d.chance) AS chance
  FROM drops d JOIN items i ON i.entry = d.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE d.src='o' AND d.owner IN (${inList(n)})
  GROUP BY i.entry ORDER BY chance DESC LIMIT 200`;
// This object('s name-group)'s spawn points to plot on the zone map.
export const qObjectSpawns = (n) => `
  SELECT x, y, map, zone FROM spawn_points INDEXED BY idx_spawn_id
  WHERE kind='o' AND id IN (${inList(n)}) AND zone IS NOT NULL LIMIT 5000`;
// Quests this object('s group) starts / ends, and is a collection objective of.
export const qObjectQuestStart = (n) => `
  SELECT DISTINCT q.entry, q.title, q.level FROM gameobject_quest_start r
  JOIN quests q ON q.entry = r.quest WHERE r.id IN (${inList(n)}) ORDER BY q.level LIMIT 100`;
export const qObjectQuestEnd = (n) => `
  SELECT DISTINCT q.entry, q.title, q.level FROM gameobject_quest_end r
  JOIN quests q ON q.entry = r.quest WHERE r.id IN (${inList(n)}) ORDER BY q.level LIMIT 100`;
export const qObjectObjectiveOf = (n) => `
  SELECT DISTINCT q.entry, q.title, q.level, o.count FROM quest_creature_objective o
  JOIN quests q ON q.entry = o.quest WHERE o.is_go=1 AND o.target IN (${inList(n)}) ORDER BY q.level LIMIT 100`;

// ---- icons (visual index; click an icon -> the items/spells that use it) ----
// Every distinct icon basename actually used by a VISIBLE item or spell. Restricting
// to in-use icons (not every row in item_display_info) drops ~1400 orphan display
// rows whose icon no item references -- placeholders like INV_BlueGem / INV_LawBoots
// that aren't real textures and would render as "?" in the grid.
export const Q_ICON_LIST = `
  SELECT DISTINCT icon FROM (
    SELECT di.icon AS icon FROM item_display_info di
      WHERE di.icon <> '' AND EXISTS (SELECT 1 FROM items i WHERE i.display_id = di.ID AND i.hidden = 0)
    UNION SELECT icon FROM spells WHERE icon IS NOT NULL AND icon <> '' AND hidden = 0
  ) ORDER BY icon`;
export const Q_ICON_ITEMS = `
  SELECT i.entry, i.name, i.quality, di.icon, i.item_level
  FROM items i JOIN item_display_info di ON di.ID = i.display_id
  WHERE di.icon = ?1 AND i.hidden = 0 ORDER BY i.quality DESC, i.name LIMIT 1000`;
export const Q_ICON_SPELLS = `
  SELECT entry, name, icon, skill FROM spells
  WHERE icon = ?1 AND hidden = 0 ORDER BY name LIMIT 1000`;

// ---- dungeons / raids ----
export const Q_DUNGEONS = `SELECT id, name, type, min_level, max_level FROM maps WHERE type IN (1,2) AND name <> '' AND hidden = 0 ORDER BY type, name`;
export const Q_DUNGEON = `SELECT id, name, type FROM maps WHERE id = ?1`;
// A zone's map type (0 open-world, 1 dungeon, 2 raid) -> lets the zone page
// auto-detect that it's actually an instance and render dungeon/raid content.
export const Q_MAP_TYPE = `SELECT id, name, type FROM maps WHERE id = ?1`;
// Boss creature entries in an instance map = unique spawns (cnt = 1), per the
// repo's "boss = unique spawn" convention. Drives the skull markers on the map.
export const Q_MAP_BOSSES = `SELECT DISTINCT id FROM spawns WHERE map = ?1 AND cnt = 1`;
export const Q_DUNGEON_NPCS = `
  SELECT DISTINCT c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank
  FROM spawns s JOIN creatures c ON c.entry = s.id
  WHERE s.map = ?1 AND c.name <> '' ORDER BY c.rank DESC, c.level_max DESC, c.name`;

export const Q_DUNGEON_LOOT = `
  SELECT DISTINCT i.entry, i.name, i.quality, i.item_level, i.required_level, di.icon
  FROM drops d JOIN creatures c ON c.loot_id = d.owner AND d.src='c'
  JOIN spawns s ON s.id = c.entry
  JOIN items i ON i.entry = d.item LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE s.map = ?1 ORDER BY i.quality DESC, i.item_level DESC LIMIT 1000`;

// boss loot: items dropped by unique-spawn (cnt=1) creatures in the map
export const Q_DUNGEON_BOSS_LOOT = `
  SELECT c.entry AS boss, c.name AS boss_name, i.entry, i.name, i.quality, di.icon, d.chance
  FROM spawns s JOIN creatures c ON c.entry = s.id AND s.cnt = 1
  JOIN drops d ON d.src='c' AND d.owner = c.loot_id
  JOIN items i ON i.entry = d.item LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE s.map = ?1 ORDER BY c.name, d.chance DESC LIMIT 2000`;

// ---- quests ----
// zone_page is non-null when q.zone is a zone that has a map page (-> link it).
// zone_page is non-null when q.zone has its own map page. The area hierarchy:
// zone_map = continent, zone_parent = parent zone id (0 if top-level), with the
// parent's name + whether IT has a map page -> continent > zone > sub-zone.
export const Q_QUEST = `SELECT q.*, a.name AS zone_name, a.map_id AS zone_map, a.zone_id AS zone_parent,
    z.areaid AS zone_page, pa.name AS parent_name, pz.areaid AS parent_page
  FROM quests q
  LEFT JOIN areas a ON a.entry = q.zone
  LEFT JOIN zones z ON z.areaid = q.zone
  LEFT JOIN areas pa ON pa.entry = a.zone_id
  LEFT JOIN zones pz ON pz.areaid = a.zone_id
  WHERE q.entry = ?1`;
export const Q_QUEST_BRIEF = `SELECT entry, title, level FROM quests WHERE entry = ?1`;

// The whole quest chain connected to ?1, in BOTH directions. Quest links are
// stored asymmetrically (prevquest is the common link; nextquest is rarer, and a
// chain may use either), so we treat the prevquest/nextquest edges as undirected
// and gather the full connected component: walk ancestors (up) and descendants
// (down) of the quest, then return every quest in either set. abs(prevquest)
// covers the negative "exclusive group" form. Ordered into a sequence client-side.
export const Q_QUEST_CHAIN = `
  WITH RECURSIVE
  up(entry) AS (
    SELECT ?1
    UNION
    SELECT abs(q.prevquest) FROM quests q JOIN up ON q.entry = up.entry WHERE q.prevquest <> 0
    UNION
    SELECT q.entry FROM quests q JOIN up ON q.nextquest = up.entry WHERE q.nextquest <> 0
  ),
  down(entry) AS (
    SELECT ?1
    UNION
    SELECT q.entry FROM quests q JOIN down ON abs(q.prevquest) = down.entry WHERE q.prevquest <> 0
    UNION
    SELECT q.nextquest FROM quests q JOIN down ON q.entry = down.entry WHERE q.nextquest <> 0
  )
  SELECT q.entry, q.title, q.level, q.prevquest, q.nextquest FROM quests q
  WHERE q.entry IN (SELECT entry FROM up UNION SELECT entry FROM down)
  LIMIT 200`;

export const Q_QUEST_GIVERS_NPC = `SELECT c.entry, c.name, c.level_min, c.level_max, c.rank FROM creature_quest_start r JOIN creatures c ON c.entry = r.id WHERE r.quest = ?1 ORDER BY c.level_max, c.name`;
export const Q_QUEST_ENDERS_NPC = `SELECT c.entry, c.name, c.level_min, c.level_max, c.rank FROM creature_quest_end r JOIN creatures c ON c.entry = r.id WHERE r.quest = ?1 ORDER BY c.level_max, c.name`;
export const Q_QUEST_GIVERS_GO = `SELECT g.entry, g.name FROM gameobject_quest_start r JOIN gameobjects g ON g.entry = r.id WHERE r.quest = ?1 ORDER BY g.name`;
export const Q_QUEST_ENDERS_GO = `SELECT g.entry, g.name FROM gameobject_quest_end r JOIN gameobjects g ON g.entry = r.id WHERE r.quest = ?1 ORDER BY g.name`;

// All quest<->item links for one quest (split by role client-side).
export const Q_QUEST_ITEMS = `
  SELECT qi.role, qi.count, i.entry, i.name, i.quality, di.icon
  FROM quest_item qi JOIN items i ON i.entry = qi.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE qi.quest = ?1`;

// Kill/interact objectives: creatures (is_go=0) and gameobjects (is_go=1).
export const Q_QUEST_CREATURES = `
  SELECT o.target, o.is_go, o.count, COALESCE(c.name, g.name) AS name, c.level_min, c.level_max, c.rank
  FROM quest_creature_objective o
  LEFT JOIN creatures c ON c.entry = o.target AND o.is_go = 0
  LEFT JOIN gameobjects g ON g.entry = o.target AND o.is_go = 1
  WHERE o.quest = ?1`;

export const Q_QUEST_REP = `SELECT r.faction, r.value, f.name1 AS faction_name FROM quest_reward_rep r LEFT JOIN faction_names f ON f.id = r.faction WHERE r.quest = ?1`;

// Reverse: quests that require killing this creature ("Objective of" on NPC page).
export const Q_NPC_OBJECTIVE_OF = `SELECT q.entry, q.title, q.level, o.count FROM quest_creature_objective o JOIN quests q ON q.entry = o.quest WHERE o.target = ?1 AND o.is_go = 0 ORDER BY q.level LIMIT 100`;

// ---- factions / reputation ----
export const Q_FACTIONS = `SELECT id, name, items, repquests FROM factions ORDER BY name`;
export const Q_FACTION = `SELECT id, name, listid, items, repquests FROM factions WHERE id = ?1`;

// Items unlocked at each standing with this faction (grouped by rank in the view).
export const Q_FACTION_ITEMS = `
  SELECT i.entry, i.name, i.quality, i.item_level, i.required_level,
         i.required_reputation_rank AS rank, di.icon
  FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE i.required_reputation_faction = ?1
  ORDER BY i.required_reputation_rank, i.quality DESC, i.item_level DESC LIMIT 1000`;

// Member NPCs of a faction: creatures whose FactionTemplate maps to this rep
// Faction (creature_template.faction -> faction_template.id -> faction_id).
export const Q_FACTION_NPCS = `
  SELECT c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank
  FROM creatures c
  WHERE c.name <> '' AND c.faction IN (SELECT id FROM faction_template WHERE faction_id = ?1)
  ORDER BY c.level_max, c.name LIMIT 1000`;

// The rep Faction an NPC belongs to (via its FactionTemplate). has_page is set
// when that faction has a faction page (is in the derived `factions` summary).
export const Q_NPC_FACTION = `
  SELECT fn.id, fn.name1 AS name, (SELECT 1 FROM factions f WHERE f.id = fn.id) AS has_page
  FROM creatures c
  JOIN faction_template ft ON ft.id = c.faction
  JOIN faction_names fn ON fn.id = ft.faction_id
  WHERE c.entry = ?1 AND fn.name1 <> ''`;

// Quests that grant reputation with this faction.
export const Q_FACTION_QUESTS = `
  SELECT q.entry, q.title, q.level, r.value
  FROM quest_reward_rep r JOIN quests q ON q.entry = r.quest
  WHERE r.faction = ?1 ORDER BY r.value DESC, q.level LIMIT 500`;

// Quests bound to a zone: directly (q.zone = areaid) or in one of its sub-zones
// (the sub-zone's area_template.zone_id points at this zone). gc = the quest's
// start NPC (alphabetically-first, for a stable pick) so the tab can show it.
export const Q_ZONE_QUESTS = `
  SELECT q.entry, q.title, q.level, q.reqraces, gc.entry AS giver_id, gc.name AS giver
  FROM quests q
  JOIN areas a ON a.entry = q.zone
  LEFT JOIN creatures gc ON gc.entry = (
    SELECT r.id FROM creature_quest_start r JOIN creatures c2 ON c2.entry = r.id
    WHERE r.quest = q.entry ORDER BY c2.name LIMIT 1)
  WHERE (q.zone = ?1 OR a.zone_id = ?1) AND q.title <> ''
  ORDER BY q.level, q.title LIMIT 1000`;

// Quests RELATED to an instance (?1 = mapId, ?2 = the dungeon's name). Instances
// don't carry their quests on the WorldMap area the page is keyed by: the gameplay
// zone the quests reference is a SEPARATE AreaTable row (same name, different id),
// so q.zone never equals the WorldMap areaid -> Q_ZONE_QUESTS comes back empty.
// Instead we union the relations that actually tie a quest to a dungeon, each one
// high-precision so we don't drag in unrelated world quests:
//   - its gameplay zone shares the dungeon's name (bridges WorldMap area <-> AreaTable zone);
//   - a quest giver / turn-in (NPC or object) physically spawns inside the instance;
//   - a required/source quest item that drops ONLY inside this instance (dungeon-
//     exclusive drop -> the legendary/boss-item quests; world-/multi-dungeon drops
//     like cloth or satyr horns are excluded by the NOT EXISTS off-map test). Map
//     451 ("Development Land", a GM copy) is ignored so it can't break exclusivity.
// gc = the alphabetically-first start NPC, for a stable Quest Giver cell.
export const Q_DUNGEON_QUESTS = `
  SELECT q.entry, q.title, q.level, q.reqraces, gc.entry AS giver_id, gc.name AS giver
  FROM quests q
  LEFT JOIN creatures gc ON gc.entry = (
    SELECT r.id FROM creature_quest_start r JOIN creatures c2 ON c2.entry = r.id
    WHERE r.quest = q.entry ORDER BY c2.name LIMIT 1)
  WHERE q.title <> '' AND q.entry IN (
    SELECT q2.entry FROM quests q2 JOIN areas a ON a.entry = q2.zone WHERE a.name = ?2
    UNION SELECT r.quest FROM creature_quest_start r JOIN spawn_points s ON s.id = r.id AND s.kind = 'c' AND s.map = ?1
    UNION SELECT r.quest FROM creature_quest_end   r JOIN spawn_points s ON s.id = r.id AND s.kind = 'c' AND s.map = ?1
    UNION SELECT r.quest FROM gameobject_quest_start r JOIN spawn_points s ON s.id = r.id AND s.kind = 'o' AND s.map = ?1
    UNION SELECT r.quest FROM gameobject_quest_end   r JOIN spawn_points s ON s.id = r.id AND s.kind = 'o' AND s.map = ?1
    UNION SELECT qi.quest FROM quest_item qi
      JOIN drops d ON d.item = qi.item AND d.src = 'c'
      JOIN creatures c ON c.loot_id = d.owner
      JOIN spawns sp ON sp.id = c.entry AND sp.map = ?1
      WHERE qi.role IN ('req', 'source')
        AND NOT EXISTS (
          SELECT 1 FROM drops d2 JOIN creatures c2 ON c2.loot_id = d2.owner
          JOIN spawns sp2 ON sp2.id = c2.entry
          WHERE d2.item = qi.item AND d2.src = 'c' AND sp2.map <> ?1 AND sp2.map <> 451)
  )
  ORDER BY q.level, q.title LIMIT 1000`;

// ---- zones (Leaflet maps) ----
export const Q_ZONES = `SELECT areaid, name, mapid, spawns FROM zones WHERE name <> '' ORDER BY name`;
export const Q_ZONE = `SELECT * FROM zones WHERE areaid = ?1`;
// All WorldMap floors of an instance map (a multi-floor dungeon/raid has several),
// ordered by how many spawns each holds -> the zone page's floor switcher.
export const Q_MAP_FLOORS = `
  SELECT areaid, name, mapid, locleft, locright, loctop, locbottom, img_w, img_h, spawns
  FROM zones WHERE mapid = ?1 AND img_w > 0 ORDER BY spawns DESC, areaid`;
// The primary (largest) WorldMap zone for an instance map id -> lets a dungeon/raid
// page render the same Leaflet map + spawn markers as an open-world zone.
export const Q_DUNGEON_ZONE = `
  SELECT areaid, name, mapid, locleft, locright, loctop, locbottom, img_w, img_h
  FROM zones WHERE mapid = ?1
  ORDER BY (loctop - locbottom) * (locleft - locright) DESC LIMIT 1`;

// Spawns assigned to a zone (?1 = areaid; see build-db home-zone assignment).
// Creature markers carry the inputs the classifier needs (npc_flags + whether the
// NPC starts/ends a quest).
export const Q_ZONE_SPAWNS = `
  SELECT s.x, s.y, s.zone, c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank, c.npc_flags,
         (EXISTS(SELECT 1 FROM creature_quest_start q WHERE q.id = c.entry)
       OR EXISTS(SELECT 1 FROM creature_quest_end q WHERE q.id = c.entry)) AS questgiver
  FROM spawn_points s JOIN creatures c ON c.entry = s.id
  WHERE s.kind = 'c' AND s.zone = ?1
  LIMIT 8000`;

export const Q_ZONE_OBJECTS = `
  SELECT s.x, s.y, s.zone, g.entry, g.name, g.type
  FROM spawn_points s JOIN gameobjects g ON g.entry = s.id
  WHERE s.kind = 'o' AND s.zone = ?1
  LIMIT 4000`;

// Same as above but across a whole INSTANCE map (all floors) -> ?1 = mapid. Each
// row keeps s.zone so the floor switcher can split markers per floor.
export const Q_MAP_SPAWNS = `
  SELECT s.x, s.y, s.zone, c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank, c.npc_flags,
         (EXISTS(SELECT 1 FROM creature_quest_start q WHERE q.id = c.entry)
       OR EXISTS(SELECT 1 FROM creature_quest_end q WHERE q.id = c.entry)) AS questgiver
  FROM spawn_points s INDEXED BY idx_spawn_map JOIN creatures c ON c.entry = s.id
  WHERE s.kind = 'c' AND s.map = ?1
  LIMIT 8000`;
export const Q_MAP_OBJECTS = `
  SELECT s.x, s.y, s.zone, g.entry, g.name, g.type
  FROM spawn_points s INDEXED BY idx_spawn_map JOIN gameobjects g ON g.entry = s.id
  WHERE s.kind = 'o' AND s.map = ?1
  LIMIT 4000`;

// Items dropped by creatures assigned to the zone (for the zone's Items tab).
// Collapse the spawns to their distinct loot tables FIRST (a few hundred), then
// join drops -> items; otherwise the loot join runs per-spawn (12x redundant) and
// a huge zone like the Barrens takes ~1.4s.
export const Q_ZONE_LOOT = `
  WITH lids(lid) AS (
    SELECT DISTINCT c.loot_id
    FROM spawn_points s INDEXED BY idx_spawn_zone
    JOIN creatures c ON c.entry = s.id
    WHERE s.kind = 'c' AND s.zone = ?1 AND c.loot_id <> 0)
  SELECT i.entry, i.name, i.quality, i.item_level, i.required_level, di.icon
  FROM lids
  JOIN drops d ON d.src = 'c' AND d.owner = lids.lid
  JOIN items i ON i.entry = d.item AND i.world_drop = 0
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  GROUP BY i.entry
  ORDER BY i.quality DESC, i.item_level DESC LIMIT 1000`;
