// SQL run in-browser against the SQLite file via sql.js-httpvfs.
// Only the pages needed to answer each query are fetched over HTTP range requests.

export const Q_ITEM = `SELECT * FROM items WHERE entry = ?`;

export const Q_SEARCH = `
  SELECT i.entry, i.name, i.quality, i.class, i.subclass, i.inventory_type, i.item_level, i.required_level
  FROM items_fts f JOIN items i ON i.entry = f.rowid
  WHERE items_fts MATCH ? ORDER BY i.quality DESC, i.item_level DESC LIMIT 50`;

// Dropped by NPCs. Resolves loot references recursively, then maps loot ids
// back to creatures via their loot_id / skinning_loot_id / pickpocket_loot_id.
export const Q_DROPPED_BY = `
WITH RECURSIVE refs(refentry) AS (
    SELECT entry FROM loot_reference WHERE item = @item
  UNION
    SELECT lr.entry FROM loot_reference lr
    JOIN refs ON lr.mincountOrRef < 0 AND -lr.mincountOrRef = refs.refentry
),
hit(e, chance, src) AS (
    SELECT entry, ABS(chance), 'loot'   FROM loot_creature   WHERE item = @item
  UNION ALL
    SELECT entry, ABS(chance), 'skin'   FROM loot_skinning   WHERE item = @item
  UNION ALL
    SELECT entry, ABS(chance), 'pick'   FROM loot_pickpocket WHERE item = @item
  UNION ALL
    SELECT lc.entry, ABS(lc.chance), 'loot'
      FROM loot_creature lc JOIN refs ON lc.mincountOrRef < 0 AND -lc.mincountOrRef = refs.refentry
)
SELECT c.entry, c.name, c.level_min, c.level_max, c.rank,
       MAX(CASE WHEN hit.src='loot' THEN hit.chance END) AS drop_chance,
       MAX(CASE WHEN hit.src='skin' THEN hit.chance END) AS skin_chance,
       MAX(CASE WHEN hit.src='pick' THEN hit.chance END) AS pick_chance
FROM hit
JOIN creatures c
  ON (hit.src='loot' AND c.loot_id = hit.e)
  OR (hit.src='skin' AND c.skinning_loot_id = hit.e)
  OR (hit.src='pick' AND c.pickpocket_loot_id = hit.e)
GROUP BY c.entry
ORDER BY COALESCE(drop_chance, skin_chance, pick_chance) DESC
LIMIT 100`;

// Object/chest sources, resolving references too.
export const Q_OBJECT_SOURCE = `
WITH RECURSIVE refs(refentry) AS (
    SELECT entry FROM loot_reference WHERE item = @item
  UNION
    SELECT lr.entry FROM loot_reference lr
    JOIN refs ON lr.mincountOrRef < 0 AND -lr.mincountOrRef = refs.refentry
),
hit(e, chance) AS (
    SELECT entry, ABS(chance) FROM loot_object WHERE item = @item
  UNION ALL
    SELECT lo.entry, ABS(lo.chance)
      FROM loot_object lo JOIN refs ON lo.mincountOrRef < 0 AND -lo.mincountOrRef = refs.refentry
)
SELECT g.entry, g.name, MAX(hit.chance) AS chance
FROM hit JOIN gameobjects g ON g.data1 = hit.e
GROUP BY g.entry ORDER BY chance DESC LIMIT 50`;

export const Q_SOLD_BY = `
  SELECT c.entry, c.name, c.level_min, c.level_max, v.maxcount
  FROM npc_vendor v JOIN creatures c ON c.entry = v.entry
  WHERE v.item = ? ORDER BY c.name LIMIT 100`;

// Containers (lockboxes, bags, sacks) that yield this item when opened.
export const Q_CONTAINED_IN = `
  SELECT i.entry, i.name, i.quality, ABS(li.chance) AS chance
  FROM loot_item li JOIN items i ON i.entry = li.entry
  WHERE li.item = ? ORDER BY chance DESC LIMIT 50`;

export const Q_DISENCHANTS_INTO = `
  SELECT i.entry, i.name, i.quality, d.chance, d.mincountOrRef AS minc, d.maxcount AS maxc
  FROM loot_disenchant d JOIN items i ON i.entry = d.item
  WHERE d.entry = (SELECT disenchant_id FROM items WHERE entry = ?)
  ORDER BY d.chance DESC`;

export const Q_QUEST_ITEM = `
  SELECT q.entry, q.title, q.level, qi.role, qi.count
  FROM quest_item qi JOIN quests q ON q.entry = qi.quest
  WHERE qi.item = ? ORDER BY qi.role, q.level LIMIT 100`;

export const Q_STARTS_QUEST = `
  SELECT q.entry, q.title, q.level FROM quests q WHERE q.entry =
    (SELECT start_quest FROM items WHERE entry = ?) AND q.entry > 0`;

export const Q_CREATED_BY = `
  SELECT s.entry, s.name, ci.entry AS reagent_item, ci.name AS reagent_name, sr.count
  FROM spell_creates sc
  JOIN spells s ON s.entry = sc.spell
  LEFT JOIN spell_reagent sr ON sr.spell = sc.spell
  LEFT JOIN items ci ON ci.entry = sr.item
  WHERE sc.item = ? ORDER BY s.entry`;

export const Q_REAGENT_FOR = `
  SELECT s.entry AS spell, s.name AS spell_name, ci.entry AS created, ci.name AS created_name, ci.quality
  FROM spell_reagent sr
  JOIN spells s ON s.entry = sr.spell
  LEFT JOIN spell_creates sc ON sc.spell = sr.spell
  LEFT JOIN items ci ON ci.entry = sc.item
  WHERE sr.item = ? GROUP BY s.entry, ci.entry ORDER BY ci.quality DESC LIMIT 100`;

export const Q_SPELL = `SELECT entry, name, description, auraDescription, s1, s2, s3, d1, d2, d3 FROM spells WHERE entry = ?`;
