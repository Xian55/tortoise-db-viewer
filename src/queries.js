// SQL run in-browser against the fully-loaded SQLite database.
// Positional ?1 params (a single id reused across the query binds as [id]).
// Every query that returns an item also LEFT JOINs item_display_info for its
// icon name, so item names can be shown with icons everywhere (no icons.json).

export const Q_ITEM = `
  SELECT i.*, di.icon FROM items i
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE i.entry = ?1`;

// Substring search over the whole table — trivial since the DB is in memory.
export const Q_SEARCH = `
  SELECT i.entry, i.name, i.quality, i.class, i.subclass, i.inventory_type, i.item_level, i.required_level, di.icon
  FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE i.name LIKE ?1
  ORDER BY (i.name = ?2) DESC, (i.name LIKE ?2 || '%') DESC, i.quality DESC, i.item_level DESC
  LIMIT 100`;

// Dropped by NPCs. Resolves loot references recursively, then maps loot ids
// back to creatures via loot_id / skinning_loot_id / pickpocket_loot_id.
export const Q_DROPPED_BY = `
WITH RECURSIVE refs(refentry) AS (
    SELECT entry FROM loot_reference WHERE item = ?1
  UNION
    SELECT lr.entry FROM loot_reference lr JOIN refs ON lr.mincountOrRef < 0 AND -lr.mincountOrRef = refs.refentry
),
hit(e, chance, src) AS (
    SELECT entry, ABS(chance), 'loot' FROM loot_creature   WHERE item = ?1
  UNION ALL
    SELECT entry, ABS(chance), 'skin' FROM loot_skinning   WHERE item = ?1
  UNION ALL
    SELECT entry, ABS(chance), 'pick' FROM loot_pickpocket WHERE item = ?1
  UNION ALL
    SELECT lc.entry, ABS(lc.chance), 'loot' FROM loot_creature lc JOIN refs ON lc.mincountOrRef < 0 AND -lc.mincountOrRef = refs.refentry
)
SELECT c.entry, c.name, c.level_min, c.level_max, c.rank,
       MAX(CASE WHEN hit.src='loot' THEN hit.chance END) AS drop_chance,
       MAX(CASE WHEN hit.src='skin' THEN hit.chance END) AS skin_chance,
       MAX(CASE WHEN hit.src='pick' THEN hit.chance END) AS pick_chance,
       (SELECT m.name FROM spawns sp JOIN maps m ON m.id=sp.map WHERE sp.id=c.entry AND m.type IN (1,2) ORDER BY m.type DESC LIMIT 1) AS dungeon,
       (SELECT m.id   FROM spawns sp JOIN maps m ON m.id=sp.map WHERE sp.id=c.entry AND m.type IN (1,2) ORDER BY m.type DESC LIMIT 1) AS dungeon_id
FROM hit JOIN creatures c
  ON (hit.src='loot' AND c.loot_id=hit.e) OR (hit.src='skin' AND c.skinning_loot_id=hit.e) OR (hit.src='pick' AND c.pickpocket_loot_id=hit.e)
GROUP BY c.entry ORDER BY COALESCE(drop_chance, skin_chance, pick_chance) DESC LIMIT 100`;

export const Q_OBJECT_SOURCE = `
WITH RECURSIVE refs(refentry) AS (
    SELECT entry FROM loot_reference WHERE item = ?1
  UNION
    SELECT lr.entry FROM loot_reference lr JOIN refs ON lr.mincountOrRef < 0 AND -lr.mincountOrRef = refs.refentry
),
hit(e, chance) AS (
    SELECT entry, ABS(chance) FROM loot_object WHERE item = ?1
  UNION ALL
    SELECT lo.entry, ABS(lo.chance) FROM loot_object lo JOIN refs ON lo.mincountOrRef < 0 AND -lo.mincountOrRef = refs.refentry
)
SELECT g.entry, g.name, MAX(hit.chance) AS chance FROM hit JOIN gameobjects g ON g.data1 = hit.e GROUP BY g.entry ORDER BY chance DESC LIMIT 50`;

export const Q_SOLD_BY = `SELECT c.entry, c.name, c.level_min, c.level_max, v.maxcount FROM npc_vendor v JOIN creatures c ON c.entry = v.entry WHERE v.item = ?1 ORDER BY c.name LIMIT 100`;

export const Q_CONTAINED_IN = `
  SELECT i.entry, i.name, i.quality, di.icon, ABS(li.chance) AS chance
  FROM loot_item li JOIN items i ON i.entry = li.entry
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE li.item = ?1 ORDER BY chance DESC LIMIT 50`;

export const Q_DISENCHANTS_INTO = `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance, d.mincountOrRef AS minc, d.maxcount AS maxc
  FROM loot_disenchant d JOIN items i ON i.entry = d.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE d.entry = (SELECT disenchant_id FROM items WHERE entry = ?1) ORDER BY d.chance DESC`;

export const Q_QUEST_ITEM = `SELECT q.entry, q.title, q.level, qi.role, qi.count FROM quest_item qi JOIN quests q ON q.entry = qi.quest WHERE qi.item = ?1 ORDER BY qi.role, q.level LIMIT 100`;
export const Q_STARTS_QUEST = `SELECT q.entry, q.title, q.level FROM quests q WHERE q.entry = (SELECT start_quest FROM items WHERE entry = ?1) AND q.entry > 0`;

export const Q_CREATED_BY = `
  SELECT s.entry, s.name, ci.entry AS reagent_item, ci.name AS reagent_name, di.icon AS reagent_icon, sr.count
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

export const Q_SPELL = `SELECT entry, name, description, auraDescription, s1, s2, s3, d1, d2, d3 FROM spells WHERE entry = ?1`;

// ---- NPC (creature) pages ----
export const Q_NPC = `SELECT entry, name, subname, level_min, level_max, rank, type, faction, health_min, health_max, npc_flags FROM creatures WHERE entry = ?1`;

// Items an NPC yields from one loot source (loot/skinning/pickpocket), with the
// loot set + referenced sets resolved recursively. ?2 = loot table, but SQL
// can't parameterize table names, so there is one query per source below.
function npcLoot(lootTable, lootIdCol) {
  return `
WITH RECURSIVE refs(refentry) AS (
    SELECT -l.mincountOrRef FROM ${lootTable} l JOIN creatures c ON c.entry = ?1 AND l.entry = c.${lootIdCol} WHERE l.mincountOrRef < 0
  UNION
    SELECT -lr.mincountOrRef FROM loot_reference lr JOIN refs ON lr.entry = refs.refentry AND lr.mincountOrRef < 0
),
drops(item, chance) AS (
    SELECT l.item, ABS(l.chance) FROM ${lootTable} l JOIN creatures c ON c.entry = ?1 AND l.entry = c.${lootIdCol} WHERE l.item > 0
  UNION ALL
    SELECT lr.item, ABS(lr.chance) FROM loot_reference lr JOIN refs ON lr.entry = refs.refentry WHERE lr.item > 0
)
SELECT d.item AS entry, i.name, i.quality, di.icon, MAX(d.chance) AS chance
FROM drops d JOIN items i ON i.entry = d.item
LEFT JOIN item_display_info di ON di.ID = i.display_id
GROUP BY d.item ORDER BY chance DESC LIMIT 300`;
}

export const Q_NPC_LOOT = npcLoot("loot_creature", "loot_id");
export const Q_NPC_SKIN = npcLoot("loot_skinning", "skinning_loot_id");
export const Q_NPC_PICK = npcLoot("loot_pickpocket", "pickpocket_loot_id");

export const Q_NPC_SELLS = `
  SELECT i.entry, i.name, i.quality, di.icon, v.maxcount
  FROM npc_vendor v JOIN items i ON i.entry = v.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE v.entry = ?1 ORDER BY i.quality DESC, i.name LIMIT 300`;

export const Q_NPC_STARTS = `SELECT q.entry, q.title, q.level FROM creature_quest_start r JOIN quests q ON q.entry = r.quest WHERE r.id = ?1 ORDER BY q.level`;
export const Q_NPC_ENDS = `SELECT q.entry, q.title, q.level FROM creature_quest_end r JOIN quests q ON q.entry = r.quest WHERE r.id = ?1 ORDER BY q.level`;

// maps an NPC spawns on (dungeon/raid first, then world)
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

// all items dropped by creatures spawning in a map (loot sets + references)
export const Q_DUNGEON_LOOT = `
WITH RECURSIVE
setids(e) AS (
  SELECT DISTINCT c.loot_id FROM spawns s JOIN creatures c ON c.entry = s.id WHERE s.map = ?1 AND c.loot_id > 0
),
refs(refentry) AS (
    SELECT -lc.mincountOrRef FROM loot_creature lc JOIN setids ON lc.entry = setids.e AND lc.mincountOrRef < 0
  UNION
    SELECT -lr.mincountOrRef FROM loot_reference lr JOIN refs ON lr.entry = refs.refentry AND lr.mincountOrRef < 0
),
items_from(item) AS (
    SELECT lc.item FROM loot_creature lc JOIN setids ON lc.entry = setids.e WHERE lc.item > 0
  UNION
    SELECT lr.item FROM loot_reference lr JOIN refs ON lr.entry = refs.refentry WHERE lr.item > 0
)
SELECT i.entry, i.name, i.quality, i.item_level, i.required_level, di.icon
FROM items_from f JOIN items i ON i.entry = f.item
LEFT JOIN item_display_info di ON di.ID = i.display_id
ORDER BY i.quality DESC, i.item_level DESC LIMIT 1000`;
