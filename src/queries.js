// SQL run in-browser against the fully-loaded SQLite database.
// Positional ?1 params (a single id reused across the query binds as [id]).
// Drop chances come from the precomputed `drops` table (src: c=creature,
// s=skinning, p=pickpocket, o=object, i=item-container, e=disenchant), which
// already resolves equal-chance groups and reference multipliers.

export const Q_ITEM = `
  SELECT i.*, di.icon, rf.name1 AS req_rep_faction
  FROM items i
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  LEFT JOIN faction_names rf ON rf.id = i.required_reputation_faction
  WHERE i.entry = ?1`;

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
  SELECT c.entry, c.name, c.level_min, c.level_max, c.rank, c.type
  FROM creatures_fts f JOIN creatures c ON c.entry = f.rowid
  WHERE creatures_fts MATCH ?1
  ORDER BY (c.name = ?2) DESC, (c.name LIKE ?2 || '%') DESC, c.level_max DESC
  LIMIT ?3`;

export const Q_SEARCH_QUESTS = `
  SELECT q.entry, q.title, q.level, q.zone, q.type
  FROM quests_fts f JOIN quests q ON q.entry = f.rowid
  WHERE quests_fts MATCH ?1
  ORDER BY (q.title = ?2) DESC, (q.title LIKE ?2 || '%') DESC, q.level
  LIMIT ?3`;

export const Q_SEARCH_DUNGEONS = `
  SELECT id, name, type FROM maps
  WHERE type IN (1,2) AND name LIKE ?1
  ORDER BY (name = ?2) DESC, name
  LIMIT ?3`;

// Zones use LIKE over the ~120 named WorldMap areas (no FTS table needed).
export const Q_SEARCH_ZONES = `
  SELECT areaid, name, mapid FROM zones
  WHERE name <> '' AND name LIKE ?1
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

export const Q_SOLD_BY = `SELECT c.entry, c.name, c.level_min, c.level_max, v.maxcount FROM npc_vendor v JOIN creatures c ON c.entry = v.entry WHERE v.item = ?1 ORDER BY c.name LIMIT 100`;

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

export const Q_QUEST_ITEM = `SELECT q.entry, q.title, q.level, qi.role, qi.count FROM quest_item qi JOIN quests q ON q.entry = qi.quest WHERE qi.item = ?1 ORDER BY qi.role, q.level LIMIT 100`;
export const Q_STARTS_QUEST = `SELECT q.entry, q.title, q.level FROM quests q WHERE q.entry = (SELECT start_quest FROM items WHERE entry = ?1) AND q.entry > 0`;

export const Q_CREATED_BY = `
  SELECT s.entry, s.name, sc.skill, sc.skill_req, ci.entry AS reagent_item, ci.name AS reagent_name, ci.quality AS reagent_quality, di.icon AS reagent_icon, sr.count,
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
  SELECT s.entry AS spell, s.name AS spell_name, ci.entry AS created, ci.name AS created_name, ci.quality, di.icon AS created_icon
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
  SELECT g.name, s.x, s.y, s.map
  FROM drops d
  CROSS JOIN gameobjects g ON g.data1 = d.owner
  CROSS JOIN spawn_points s ON s.kind = 'o' AND s.id = g.entry
  WHERE d.src = 'o' AND d.item = ?1 LIMIT 30000`;

// All zone rectangles (for assigning a spawn point to its zone).
export const Q_ZONE_BOXES = `SELECT areaid, name, mapid, locleft, locright, loctop, locbottom FROM zones`;

export const Q_ITEM_ICON = `SELECT i.name, di.icon FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id WHERE i.entry = ?1`;

// Spawn points within a zone of the object(s) that yield a given item -- powers
// the focused "show only Earthroot nodes" view. ?1=map, ?2-5=rect, ?6=item.
// CROSS JOIN pins the order (drops -> gameobjects -> spawn_points); INDEXED BY
// keeps s on idx_spawn_id (kind,id) -- otherwise the s.map predicate lures the
// planner onto idx_spawn_map (all of map 0) and it balloons to ~400ms.
export const Q_ZONE_FOCUS_SPAWNS = `
  SELECT g.name, s.x, s.y
  FROM drops d
  CROSS JOIN gameobjects g ON g.data1 = d.owner
  CROSS JOIN spawn_points s INDEXED BY idx_spawn_id ON s.kind = 'o' AND s.id = g.entry
  WHERE d.src = 'o' AND d.item = ?6 AND s.map = ?1
    AND s.x BETWEEN ?2 AND ?3 AND s.y BETWEEN ?4 AND ?5 LIMIT 5000`;

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

// Candidate zones whose rectangle contains a spawn of this NPC (with bounds, so
// showNpc can pick the most-interior zone per spawn -- WMA boxes overlap at
// borders, so plain containment is ambiguous).
// INDEXED BY forces the spawn-first plan (find this NPC's few spawns via
// idx_spawn_id, then test the ~129 zone boxes). Without the hint the planner
// scans zones and reads every spawn per continent map -> ~700ms/page.
export const Q_NPC_ZONES = `
  SELECT DISTINCT z.areaid, z.name, z.mapid, z.locleft, z.locright, z.loctop, z.locbottom
  FROM spawn_points s INDEXED BY idx_spawn_id
  JOIN zones z ON z.mapid = s.map
    AND s.x BETWEEN z.locbottom AND z.loctop AND s.y BETWEEN z.locright AND z.locleft
  WHERE s.kind = 'c' AND s.id = ?1 AND z.name <> ''`;

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

// ---- quests ----
export const Q_QUEST = `SELECT q.*, a.name AS zone_name FROM quests q LEFT JOIN areas a ON a.entry = q.zone WHERE q.entry = ?1`;
export const Q_QUEST_BRIEF = `SELECT entry, title, level FROM quests WHERE entry = ?1`;

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

// Quests that grant reputation with this faction.
export const Q_FACTION_QUESTS = `
  SELECT q.entry, q.title, q.level, r.value
  FROM quest_reward_rep r JOIN quests q ON q.entry = r.quest
  WHERE r.faction = ?1 ORDER BY r.value DESC, q.level LIMIT 500`;

// ---- zones (Leaflet maps) ----
export const Q_ZONES = `SELECT areaid, name, mapid, spawns FROM zones WHERE name <> '' ORDER BY name`;
export const Q_ZONE = `SELECT * FROM zones WHERE areaid = ?1`;
// The primary (largest) WorldMap zone for an instance map id -> lets a dungeon/raid
// page render the same Leaflet map + spawn markers as an open-world zone.
export const Q_DUNGEON_ZONE = `
  SELECT areaid, name, mapid, locleft, locright, loctop, locbottom, img_w, img_h
  FROM zones WHERE mapid = ?1
  ORDER BY (loctop - locbottom) * (locleft - locright) DESC LIMIT 1`;

// Spawns inside a zone's world rectangle (?1=mapid, ?2=locbottom, ?3=loctop,
// ?4=locright, ?5=locleft). Creature markers carry the inputs the classifier
// needs (npc_flags + whether the NPC starts/ends a quest).
export const Q_ZONE_SPAWNS = `
  SELECT s.x, s.y, c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank, c.npc_flags,
         (EXISTS(SELECT 1 FROM creature_quest_start q WHERE q.id = c.entry)
       OR EXISTS(SELECT 1 FROM creature_quest_end q WHERE q.id = c.entry)) AS questgiver
  FROM spawn_points s JOIN creatures c ON c.entry = s.id
  WHERE s.kind = 'c' AND s.map = ?1 AND s.x BETWEEN ?2 AND ?3 AND s.y BETWEEN ?4 AND ?5
  LIMIT 8000`;

export const Q_ZONE_OBJECTS = `
  SELECT s.x, s.y, g.entry, g.name, g.type
  FROM spawn_points s JOIN gameobjects g ON g.entry = s.id
  WHERE s.kind = 'o' AND s.map = ?1 AND s.x BETWEEN ?2 AND ?3 AND s.y BETWEEN ?4 AND ?5
  LIMIT 4000`;

// Items dropped by creatures that spawn in the zone (for the zone's Items tab).
export const Q_ZONE_LOOT = `
  SELECT DISTINCT i.entry, i.name, i.quality, i.item_level, i.required_level, di.icon
  FROM spawn_points s INDEXED BY idx_spawn_map
  JOIN creatures c ON c.entry = s.id
  JOIN drops d ON d.src = 'c' AND d.owner = c.loot_id
  JOIN items i ON i.entry = d.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE s.kind = 'c' AND s.map = ?1 AND s.x BETWEEN ?2 AND ?3 AND s.y BETWEEN ?4 AND ?5
  ORDER BY i.quality DESC, i.item_level DESC LIMIT 1000`;
