// SQL run in-browser against the fully-loaded SQLite database.
// Positional ?1 params (a single id reused across the query binds as [id]).
// Drop chances come from the precomputed `drops` table (src: c=creature,
// s=skinning, p=pickpocket, o=object, i=item-container, e=disenchant), which
// already resolves equal-chance groups and reference multipliers.

export const Q_ITEM = `
  SELECT i.*, di.icon FROM items i
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE i.entry = ?1`;

export const Q_SEARCH = `
  SELECT i.entry, i.name, i.quality, i.class, i.subclass, i.inventory_type, i.item_level, i.required_level, di.icon
  FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE i.name LIKE ?1
  ORDER BY (i.name = ?2) DESC, (i.name LIKE ?2 || '%') DESC, i.quality DESC, i.item_level DESC
  LIMIT 100`;

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

export const Q_OBJECT_SOURCE = `
  SELECT g.entry, g.name, MAX(d.chance) AS chance
  FROM drops d JOIN gameobjects g ON g.data1 = d.owner
  WHERE d.src='o' AND d.item = ?1 GROUP BY g.entry ORDER BY chance DESC LIMIT 50`;

export const Q_SOLD_BY = `SELECT c.entry, c.name, c.level_min, c.level_max, v.maxcount FROM npc_vendor v JOIN creatures c ON c.entry = v.entry WHERE v.item = ?1 ORDER BY c.name LIMIT 100`;

export const Q_CONTAINED_IN = `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance
  FROM drops d JOIN items i ON i.entry = d.owner
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE d.src='i' AND d.item = ?1 ORDER BY d.chance DESC LIMIT 50`;

export const Q_DISENCHANTS_INTO = `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance
  FROM drops d JOIN items i ON i.entry = d.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE d.src='e' AND d.owner = (SELECT disenchant_id FROM items WHERE entry = ?1)
  ORDER BY d.chance DESC`;

export const Q_QUEST_ITEM = `SELECT q.entry, q.title, q.level, qi.role, qi.count FROM quest_item qi JOIN quests q ON q.entry = qi.quest WHERE qi.item = ?1 ORDER BY qi.role, q.level LIMIT 100`;
export const Q_STARTS_QUEST = `SELECT q.entry, q.title, q.level FROM quests q WHERE q.entry = (SELECT start_quest FROM items WHERE entry = ?1) AND q.entry > 0`;

export const Q_CREATED_BY = `
  SELECT s.entry, s.name, sc.skill, sc.skill_req, ci.entry AS reagent_item, ci.name AS reagent_name, di.icon AS reagent_icon, sr.count
  FROM spell_creates sc JOIN spells s ON s.entry = sc.spell
  LEFT JOIN spell_reagent sr ON sr.spell = sc.spell
  LEFT JOIN items ci ON ci.entry = sr.item
  LEFT JOIN item_display_info di ON di.ID = ci.display_id
  WHERE sc.item = ?1 ORDER BY s.entry`;

export const Q_REAGENT_FOR = `
  SELECT s.entry AS spell, s.name AS spell_name, ci.entry AS created, ci.name AS created_name, ci.quality, di.icon AS created_icon
  FROM spell_reagent sr JOIN spells s ON s.entry = sr.spell
  LEFT JOIN spell_creates sc ON sc.spell = sr.spell
  LEFT JOIN items ci ON ci.entry = sc.item
  LEFT JOIN item_display_info di ON di.ID = ci.display_id
  WHERE sr.item = ?1 GROUP BY s.entry, ci.entry ORDER BY ci.quality DESC LIMIT 100`;

export const Q_ITEM_SOURCES = `SELECT source FROM item_sources WHERE item = ?1`;

// All crafts (browse Crafting view). One row per (craft spell, reagent); the view
// groups reagents per spell client-side. skill_min/skill_max give the yellow/grey
// skill-up thresholds (green = midpoint). craft_source resolves trainer vs recipe.
export const Q_CRAFTING = `
  SELECT sc.spell, s.name AS spell_name, sc.skill, sc.skill_req, sc.skill_min, sc.skill_max,
         ci.entry AS item, ci.name AS item_name, ci.quality, cdi.icon AS item_icon,
         sr.item AS reagent, ri.name AS reagent_name, ri.quality AS reagent_quality, rdi.icon AS reagent_icon, sr.count,
         cs.trainer, cs.auto, cs.learn_req, cs.recipe_item, rc.name AS recipe_name, rc.quality AS recipe_quality, rcdi.icon AS recipe_icon
  FROM spell_creates sc
  JOIN spells s ON s.entry = sc.spell
  JOIN items ci ON ci.entry = sc.item
  LEFT JOIN item_display_info cdi ON cdi.ID = ci.display_id
  LEFT JOIN spell_reagent sr ON sr.spell = sc.spell
  LEFT JOIN items ri ON ri.entry = sr.item
  LEFT JOIN item_display_info rdi ON rdi.ID = ri.display_id
  LEFT JOIN craft_source cs ON cs.spell = sc.spell
  LEFT JOIN items rc ON rc.entry = cs.recipe_item
  LEFT JOIN item_display_info rcdi ON rcdi.ID = rc.display_id
  WHERE sc.skill IN (171,164,185,333,202,129,356,182,755,165,186,393,197)
  ORDER BY sc.skill, ci.name, sc.spell`;

export const Q_SPELL = `SELECT entry, name, description, auraDescription, s1, s2, s3, d1, d2, d3 FROM spells WHERE entry = ?1`;

// ---- NPC (creature) pages ----
export const Q_NPC = `SELECT entry, name, subname, level_min, level_max, rank, type, faction, health_min, health_max, npc_flags FROM creatures WHERE entry = ?1`;

const npcLoot = (src, ownerCol) => `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance
  FROM creatures c JOIN drops d ON d.src='${src}' AND d.owner = c.${ownerCol}
  JOIN items i ON i.entry = d.item LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE c.entry = ?1 ORDER BY d.chance DESC LIMIT 500`;
export const Q_NPC_LOOT = npcLoot("c", "loot_id");
export const Q_NPC_SKIN = npcLoot("s", "skinning_loot_id");
export const Q_NPC_PICK = npcLoot("p", "pickpocket_loot_id");

export const Q_NPC_SELLS = `
  SELECT i.entry, i.name, i.quality, di.icon, v.maxcount
  FROM npc_vendor v JOIN items i ON i.entry = v.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE v.entry = ?1 ORDER BY i.quality DESC, i.name LIMIT 300`;
export const Q_NPC_STARTS = `SELECT q.entry, q.title, q.level FROM creature_quest_start r JOIN quests q ON q.entry = r.quest WHERE r.id = ?1 ORDER BY q.level`;
export const Q_NPC_ENDS = `SELECT q.entry, q.title, q.level FROM creature_quest_end r JOIN quests q ON q.entry = r.quest WHERE r.id = ?1 ORDER BY q.level`;
export const Q_NPC_MAPS = `
  SELECT DISTINCT m.id, m.name, m.type FROM spawns s JOIN maps m ON m.id = s.map
  WHERE s.id = ?1 AND m.name <> '' ORDER BY m.type DESC, m.name`;

// ---- dungeons / raids ----
export const Q_DUNGEONS = `SELECT id, name, type FROM maps WHERE type IN (1,2) AND name <> '' ORDER BY type, name`;
export const Q_DUNGEON = `SELECT id, name, type FROM maps WHERE id = ?1`;
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
