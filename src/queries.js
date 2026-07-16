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

// Other items sharing this one's display_id (same in-game model/appearance).
// ?1 = display_id, ?2 = this item's entry (excluded). LIMIT bounds generic models
// (a few display_ids are placeholders shared by 300+ items).
export const Q_SAME_MODEL = `
  SELECT i.entry, i.name, i.quality, di.icon, i.item_level, i.required_level, i.inventory_type
  FROM items i JOIN item_display_info di ON di.ID = i.display_id
  WHERE i.display_id = ?1 AND i.entry <> ?2 AND i.hidden = 0
  ORDER BY i.quality DESC, i.item_level DESC, i.name LIMIT 250`;

// all derived gear stats for one item (compare view stat-delta table).
export const Q_ITEM_STATS = `SELECT stat, value FROM item_stats WHERE item = ?1`;

// Batch fetch for the character loadout page (17 gear slots -> one query each).
// n positional params (?1..?n) matching the distinct item ids passed in.
export const qItemsIn = (n) => `SELECT i.entry, i.name, i.quality, i.item_level, i.required_level, i.inventory_type AS inv, i.set_id, di.icon
  FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE i.entry IN (${Array.from({ length: n }, (_, k) => `?${k + 1}`).join(",")})`;
export const qItemStatsIn = (n) => `SELECT item, stat, value FROM item_stats
  WHERE item IN (${Array.from({ length: n }, (_, k) => `?${k + 1}`).join(",")})`;
// enchant id -> applying spell (name), for the character sheet's per-slot enchant label.
export const qEnchantsIn = (n) => `SELECT id, spell, name FROM item_enchant
  WHERE id IN (${Array.from({ length: n }, (_, k) => `?${k + 1}`).join(",")})`;
// random-property (suffix) id -> name + stats json, for the "of the Bear"-style rolls.
export const qRandomSuffixIn = (n) => `SELECT id, name, stats FROM random_suffix
  WHERE id IN (${Array.from({ length: n }, (_, k) => `?${k + 1}`).join(",")})`;
// Name search for the character sheet's per-slot item picker: FTS prefix (?1) OR
// trigram substring (?2), restricted to the slot's inventory types (inlined ints),
// exact-prefix (?3) ranked first. Excludes obvious test/placeholder items.
// ?4 = the term as a numeric item id (or -1 when the term isn't numeric): a direct
// id paste matches i.entry exactly (bypassing the test/deprecated name filters) but
// still honours the slot's inventory_type so you can't drop a chest into the head slot.
export const qItemSearchInv = (invCsv) => `
  SELECT i.entry, i.name, i.quality, i.item_level, i.inventory_type AS inv, di.icon
  FROM items i LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE i.inventory_type IN (${invCsv}) AND (
      i.entry = ?4
      OR (i.name <> ''
          AND (i.entry IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?1)
            OR i.entry IN (SELECT rowid FROM items_tg WHERE items_tg MATCH ?2))
          AND i.name NOT LIKE '%(test)%' AND i.name NOT LIKE 'Test %' AND i.name NOT LIKE 'Deprecated %'))
  ORDER BY (i.entry = ?4) DESC, (i.name LIKE ?3) DESC, i.quality DESC, i.item_level DESC
  LIMIT 12`;

// compact NPC info for the hover tooltip (name/subname/level/rank/type).
export const Q_NPC_CARD = `SELECT entry, name, subname, level_min, level_max, rank, type FROM creatures WHERE entry = ?1`;

// ---- random page (surprise-me button) ----
export const Q_RANDOM_ITEM = `SELECT entry FROM items WHERE hidden = 0 AND quality >= 2 AND name <> '' ORDER BY RANDOM() LIMIT 1`;
export const Q_RANDOM_NPC = `SELECT entry FROM creatures WHERE name <> '' AND COALESCE(hidden,0) = 0 ORDER BY RANDOM() LIMIT 1`;
export const Q_RANDOM_QUEST = `SELECT entry FROM quests WHERE title <> '' AND hidden = 0 ORDER BY RANDOM() LIMIT 1`;

// ---- item sets (name + members + set-bonus spells) ----
export const Q_ITEM_SET = `SELECT id, name FROM item_sets WHERE id = ?1`;
// browse: every set with a current member, + piece count and required-level span.
export const Q_BROWSE_ITEMSETS = `
  SELECT s.id, s.name,
    (SELECT COUNT(*) FROM items i WHERE i.set_id = s.id AND i.hidden = 0) AS pieces,
    (SELECT MIN(i.required_level) FROM items i WHERE i.set_id = s.id AND i.hidden = 0) AS minlvl,
    (SELECT MAX(i.required_level) FROM items i WHERE i.set_id = s.id AND i.hidden = 0) AS maxlvl,
    -- representative class mask: smallest positive member mask (the real class bit;
    -- skips all-classes shared pieces). NULL => not class-restricted.
    (SELECT MIN(i.allowable_class) FROM items i WHERE i.set_id = s.id AND i.hidden = 0 AND i.allowable_class > 0) AS clsmask
  FROM item_sets s WHERE s.name <> '' ORDER BY s.name`;
export const Q_ITEMSET_MEMBERS = `
  SELECT i.entry, i.name, i.quality, i.allowable_class AS ac, di.icon
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
// FTS queries: ?1 = prefix MATCH string (unicode61 tokens), ?2 = raw term
// (exact/prefix tiebreak), ?3 = LIMIT, ?4 = trigram MATCH string (substring/infix;
// a no-match sentinel when the term is <3 chars). Each row matches the prefix index
// OR the trigram index, so "fang" finds "Shadowfang" while short terms still work.
// Dungeons: ?1 = LIKE pattern, ?2 = raw term, ?3 = LIMIT.
export const Q_SEARCH_ITEMS = `
  SELECT i.entry, i.name, i.quality, i.item_level, i.required_level, di.icon
  FROM items i
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE (i.entry IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?1)
      OR i.entry IN (SELECT rowid FROM items_tg WHERE items_tg MATCH ?4))
  ORDER BY (i.name = ?2) DESC, (i.name LIKE ?2 || '%') DESC, i.quality DESC, i.item_level DESC
  LIMIT ?3`;

export const Q_SEARCH_NPCS = `
  SELECT c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank, c.type
  FROM creatures c
  WHERE (c.entry IN (SELECT rowid FROM creatures_fts WHERE creatures_fts MATCH ?1)
      OR c.entry IN (SELECT rowid FROM creatures_tg WHERE creatures_tg MATCH ?4))
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
  FROM quests q
  WHERE (q.entry IN (SELECT rowid FROM quests_fts WHERE quests_fts MATCH ?1)
      OR q.entry IN (SELECT rowid FROM quests_tg WHERE quests_tg MATCH ?4))
  ORDER BY (q.title = ?2) DESC, (q.title LIKE ?2 || '%') DESC, q.level
  LIMIT ?3`;

export const Q_SEARCH_SPELLS = `
  SELECT s.entry, s.name, s.icon, s.skill
  FROM spells s
  WHERE (s.entry IN (SELECT rowid FROM spells_fts WHERE spells_fts MATCH ?1)
      OR s.entry IN (SELECT rowid FROM spells_tg WHERE spells_tg MATCH ?4))
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
  SELECT s.id, s.name,
    (SELECT MIN(i.allowable_class) FROM items i WHERE i.set_id = s.id AND i.hidden = 0 AND i.allowable_class > 0) AS clsmask
  FROM item_sets s
  WHERE s.name <> '' AND s.name LIKE ?1
  ORDER BY (s.name = ?2) DESC, s.name
  LIMIT ?3`;

// Objects (interactive gameobjects) via LIKE over the small object_browse table.
export const Q_SEARCH_OBJECTS = `
  SELECT entry, name, type FROM object_browse
  WHERE name LIKE ?1
  ORDER BY (name = ?2) DESC, name
  LIMIT ?3`;

// Direct entry-id lookups: pasting a numeric id into search jumps straight to the
// matching entity (item/NPC/quest/spell/object). One row max each; ?1 = the id.
export const Q_ID_ITEM = `
  SELECT i.entry, i.name, i.quality, di.icon FROM items i
  LEFT JOIN item_display_info di ON di.ID = i.display_id WHERE i.entry = ?1`;
export const Q_ID_NPC = `SELECT entry, name, subname FROM creatures WHERE entry = ?1`;
export const Q_ID_QUEST = `SELECT entry, title FROM quests WHERE entry = ?1`;
export const Q_ID_SPELL = `SELECT entry, name, icon FROM spells WHERE entry = ?1`;
export const Q_ID_OBJECT = `SELECT entry, name FROM object_browse WHERE entry = ?1`;

// Dropped by NPCs (creature loot / skinning / pickpocket).
export const Q_DROPPED_BY = `
SELECT c.entry, c.name, c.level_min, c.level_max, c.rank,
       MAX(CASE WHEN d.src='c' THEN d.chance END) AS drop_chance,
       MAX(CASE WHEN d.src='s' THEN d.chance END) AS skin_chance,
       MAX(CASE WHEN d.src='p' THEN d.chance END) AS pick_chance,
       MIN(d.mincount) AS mincount, MAX(d.maxcount) AS maxcount,
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
// EVERY gameobject entry that drops an item (one row per entry, not name-collapsed) ->
// so the quest map can plot all of an object's distinct spawn locations.
export const Q_OBJECT_SOURCE_ENTRIES = `
  SELECT g.entry, g.name, MAX(d.chance) AS chance
  FROM drops d JOIN gameobjects g ON g.data1 = d.owner
  WHERE d.src='o' AND d.item = ?1 GROUP BY g.entry ORDER BY chance DESC LIMIT 200`;

// Create-recipe reagents of a set of result items: for a quest item that is itself
// crafted/combined (e.g. two half-pendants -> the pendant), resolve the components so
// the quest map/required-items can fall back to where the REAGENTS are collected.
export const qItemReagents = (n) => `
  SELECT sc.item AS result, sr.item AS reagent, i.name AS reagent_name, i.quality, di.icon
  FROM spell_creates sc
  JOIN spell_reagent sr ON sr.spell = sc.spell
  JOIN items i ON i.entry = sr.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE sc.item IN (${inList(n)}) AND sr.item <> sc.item`;

// NPCs that sell an item: direct npc_vendor entries + creatures whose vendor_id
// references a npc_vendor_template that stocks it.
export const Q_SOLD_BY = `
  SELECT DISTINCT c.entry, c.name, c.level_min, c.level_max,
    COALESCE((SELECT maxcount FROM npc_vendor WHERE entry = c.entry AND item = ?1),
             (SELECT maxcount FROM npc_vendor_template WHERE entry = c.vendor_id AND item = ?1)) AS maxcount,
    COALESCE((SELECT incrtime FROM npc_vendor WHERE entry = c.entry AND item = ?1),
             (SELECT incrtime FROM npc_vendor_template WHERE entry = c.vendor_id AND item = ?1)) AS incrtime
  FROM creatures c
  WHERE c.entry IN (SELECT entry FROM npc_vendor WHERE item = ?1)
     OR c.vendor_id IN (SELECT entry FROM npc_vendor_template WHERE item = ?1)
  ORDER BY c.name LIMIT 100`;

export const Q_CONTAINED_IN = `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance, d.mincount, d.maxcount
  FROM drops d JOIN items i ON i.entry = d.owner
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE d.src='i' AND d.item = ?1 ORDER BY d.chance DESC LIMIT 50`;

// Items this container/lockbox yields when opened (the inverse of CONTAINED_IN).
export const Q_CONTAINS = `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance, d.mincount, d.maxcount
  FROM drops d JOIN items i ON i.entry = d.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE d.src='i' AND d.owner = ?1 ORDER BY d.chance DESC LIMIT 100`;

export const Q_DISENCHANTS_INTO = `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance
  FROM drops d JOIN items i ON i.entry = d.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE d.src='e' AND d.owner = (SELECT disenchant_id FROM items WHERE entry = ?1)
  ORDER BY d.chance DESC`;

export const Q_QUEST_ITEM = `SELECT q.entry, q.title, q.level, q.minlevel, q.reqraces, qi.role, qi.count FROM quest_item qi JOIN quests q ON q.entry = qi.quest WHERE qi.item = ?1 ORDER BY qi.role, q.level LIMIT 100`;
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
  WHERE sc.item = ?1 AND sc.skill IN (171,164,185,333,202,129,356,182,755,165,186,393,142,197)
  ORDER BY s.entry`;

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

// Dungeon/raid drop sources for a set of items (character upgrade finder): each item
// that drops from a creature living in a dungeon/raid map (type 1=dungeon, 2=raid),
// with the instance + creature name, so a suggested-upgrade row can say where to farm
// it. Two sources, UNION-ed:
//   1. Spawn-backed: the creature has a `spawns` row on the instance map. It qualifies
//      if it's a boss (unique spawn, cnt=1 -- the repo's boss convention) OR its drop
//      chance is meaningful (>= 1%). The chance floor is what keeps out the noise:
//      shared/reference loot pools sprinkle an item across dozens of dungeon trash mobs
//      at ~0.00-0.06% each (a named mob's real drop is >= ~1.3%), so without it a single
//      item resolves to 50-200+ trash "sources"; cnt=1 still lets a genuine but
//      low-chance boss through.
//   2. Script-spawned: bosses placed by the instance's C++ script carry NO spawn row,
//      so part 1 misses them (e.g. Tuten'kash -> Razorfen Downs). `creature_instance`
//      (built from scripts/data/instance-bosses.json) maps such an entry to its map.
// creature_instance holds only spawn-less creatures, so the two parts never overlap ->
// UNION ALL needs no dedup. Best chance per (item, creature, map); ordered so the
// frontend keeps the top few. Bind the item id list TWICE (parts 1 and 2).
export const qInstanceDropsIn = (n) => {
  const ph = (off) => Array.from({ length: n }, (_, k) => `?${off + k + 1}`).join(",");
  return `
  SELECT * FROM (
    SELECT d.item AS item, c.entry AS npc, c.name AS npc_name,
           m.id AS map_id, m.name AS dungeon, m.type AS map_type, MAX(d.chance) AS chance
    FROM drops d
    JOIN creatures c ON c.loot_id = d.owner AND d.src = 'c'
    JOIN spawns sp ON sp.id = c.entry
    JOIN maps m ON m.id = sp.map AND m.type IN (1,2) AND m.hidden = 0 AND m.name <> ''
    WHERE d.item IN (${ph(0)}) AND (sp.cnt = 1 OR d.chance >= 1)
    GROUP BY d.item, c.entry, m.id
    UNION ALL
    SELECT d.item AS item, c.entry AS npc, c.name AS npc_name,
           m.id AS map_id, m.name AS dungeon, m.type AS map_type, MAX(d.chance) AS chance
    FROM drops d
    JOIN creatures c ON c.loot_id = d.owner AND d.src = 'c'
    JOIN creature_instance ci ON ci.entry = c.entry
    JOIN maps m ON m.id = ci.map AND m.type IN (1,2) AND m.hidden = 0 AND m.name <> ''
    WHERE d.item IN (${ph(n)}) AND d.chance >= 1
    GROUP BY d.item, c.entry, m.id
  ) ORDER BY chance DESC`;
};

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
         s.cooldown_ms, s.cat_cooldown_ms,
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

// Mount an item summons: item -> collection/own spell -> creature (item_mount is
// precomputed in build-db). Creature may be NULL for the odd special mount (e.g.
// the AQ Black Qiraji tank, whose summon effect carries no misc creature id).
export const Q_ITEM_MOUNT = `
  SELECT im.spell, im.creature, c.name AS creature_name, c.display_id, s.name AS spell_name
  FROM item_mount im
  LEFT JOIN creatures c ON c.entry = im.creature
  LEFT JOIN spells s ON s.entry = im.spell
  WHERE im.item = ?1`;

// Reverse: item(s) that summon this creature as a mount (NPC page). Usually one.
export const Q_MOUNT_SOURCE = `
  SELECT i.entry, i.name, i.quality, di.icon
  FROM item_mount im
  JOIN items i ON i.entry = im.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE im.creature = ?1
  ORDER BY i.quality DESC, i.name`;

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
  SELECT c.entry, c.name, c.level_min, c.level_max, c.team
  FROM spell_trainer st JOIN creatures c ON c.entry = st.npc
  WHERE st.spell = ?1 AND c.name <> ''
  ORDER BY c.level_min, c.name LIMIT 200`;

// Learnable abilities of a gathering profession (Fishing/Herbalism/Skinning have
// no crafted output -> no spell_creates rows, so the Crafting browse is empty for
// them). Lists each learnable spell of the skill + the trainer NPCs that teach it,
// carrying the trainer's faction team. One row per (spell, trainer); browse.js
// folds trainers into each spell. learnable=1 keeps only trainer/book-taught
// spells (drops passive utility like "Open Fishing Hole"); teaches IS NULL drops
// recipe learn-stub twins.
export const Q_PROFESSION_LEARN = `
  SELECT s.entry AS spell, s.name, s.rank, s.icon,
         c.entry AS npc, c.name AS npc_name, c.level_min AS npc_level, c.team
  FROM spells s
  LEFT JOIN spell_trainer st ON st.spell = s.entry
  LEFT JOIN creatures c ON c.entry = st.npc AND c.name <> ''
  WHERE s.skill = ?1 AND s.name <> '' AND s.learnable = 1
        AND s.teaches IS NULL AND s.hidden = 0
  ORDER BY s.entry, c.team, c.level_min, c.name`;

// Profession trainer NPCs for a skill + WHERE they stand -- powers the profplan
// "Where to train" panel (which NPC, which zone, which faction to seek for each
// rank-up). A trainer is any creature that teaches at least one spell of the skill
// (recipes carry the profession's skill id); it carries the creature's team
// (1 Alliance / 2 Horde / 3 both / 0 neutral) and every zone it spawns in with a
// per-zone spawn count, so the caller folds each trainer to its most-common zone.
// One row per (trainer, zone); trainers with no static spawn keep one areaid=NULL row.
export const Q_PROFESSION_TRAINERS = `
  SELECT c.entry, c.name, c.team, c.level_min AS lvl,
         s.zone AS areaid, z.name AS zone, z.mapid, m.type AS mtype, COUNT(s.id) AS n
  FROM (SELECT DISTINCT st.npc FROM spell_trainer st
        JOIN spells sp ON sp.entry = st.spell AND sp.skill = ?1) t
  JOIN creatures c ON c.entry = t.npc AND c.name <> ''
  LEFT JOIN spawn_points s INDEXED BY idx_spawn_id ON s.kind = 'c' AND s.id = c.entry AND s.zone IS NOT NULL
  LEFT JOIN zones z ON z.areaid = s.zone
  LEFT JOIN maps m ON m.id = z.mapid
  GROUP BY c.entry, s.zone`;

// The four player-facing rank-up spells (Apprentice/Journeyman/Expert/Artisan) for every
// profession — the trainer-taught ones (name = the profession, e.g. "Blacksmithing",
// rank = the tier, learnable = 1). Identified by the SKILL effect (id 118): its misc =
// the skill-line id, its value = the tier (1..4). NOT the internal SKILL_STEP twin
// (effect 44, name "Journeyman Blacksmith", no trainer). Small set (~80 rows) — the
// caller filters to its skill in JS and links each tier's spell in the training timeline.
export const Q_PROFESSION_RANKS = `
  SELECT entry, name, icon, effects FROM spells
  WHERE effects LIKE '%"effect":118%' AND name <> ''`;

// The skill window each profession trainer covers: MIN/MAX required-skill of the
// recipes they teach (from craft_source.learn_req). Lets the panel show "teaches
// skill 15-230" so a player picks a trainer whose range covers their bracket.
// Empty for gathering skills (no craft_source rows) -> the caller omits the badge.
export const Q_PROFESSION_TRAINER_RANGE = `
  SELECT st.npc AS entry, MIN(NULLIF(cs.learn_req, 0)) AS lo, MAX(cs.learn_req) AS hi
  FROM spell_trainer st
  JOIN spells sp ON sp.entry = st.spell AND sp.skill = ?1
  JOIN craft_source cs ON cs.spell = sp.entry
  GROUP BY st.npc`;

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

// Possible random suffixes an item can roll (item.random_property -> suffix_pool ->
// random_suffix). One row per rollable ItemRandomProperties variant + its chance.
export const Q_ITEM_SUFFIXES = `
  SELECT rs.name, rs.stats, sp.chance
  FROM items i JOIN suffix_pool sp ON sp.entry = i.random_property
  JOIN random_suffix rs ON rs.id = sp.ench
  WHERE i.entry = ?1 ORDER BY rs.name, sp.chance DESC`;

// Browse Spells finder: all named spells (profession label resolved client-side).
// teaches IS NULL drops "learn" stub spells (a recipe's twin of the real craft).
export const Q_BROWSE_SPELLS = `SELECT entry, name, icon, skill, rank, school, mana_cost, power_type, cast_ms, channeled, range_max, spell_level, category, class_mask
  FROM spells WHERE name <> '' AND teaches IS NULL AND hidden = 0 ORDER BY name`;

// ---- NPC (creature) pages ----
export const Q_NPC = `SELECT entry, name, subname, level_min, level_max, rank, type, faction, health_min, health_max, npc_flags, display_id FROM creatures WHERE entry = ?1`;

const npcLoot = (src, ownerCol) => `
  SELECT i.entry, i.name, i.quality, di.icon, d.chance, d.mincount, d.maxcount, i.world_drop
  FROM creatures c JOIN drops d ON d.src='${src}' AND d.owner = c.${ownerCol}
  JOIN items i ON i.entry = d.item LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE c.entry = ?1 ORDER BY d.chance DESC LIMIT 500`;
export const Q_NPC_LOOT = npcLoot("c", "loot_id");
export const Q_NPC_SKIN = npcLoot("s", "skinning_loot_id");
export const Q_NPC_PICK = npcLoot("p", "pickpocket_loot_id");

// Items an NPC sells: per-entry npc_vendor rows + the shared npc_vendor_template
// referenced by creature_template.vendor_id (UNION dedups overlaps).
export const Q_NPC_SELLS = `
  SELECT i.entry, i.name, i.quality, di.icon, v.maxcount, v.incrtime
  FROM (
    SELECT item, maxcount, incrtime FROM npc_vendor WHERE entry = ?1
    UNION
    SELECT vt.item, vt.maxcount, vt.incrtime FROM npc_vendor_template vt
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
// Batch spawn COORDINATES for a set of creature ('c') / object ('o') entries -> plot
// them on a map (quest giver/turn-in/kill/collect markers). Returns one row per spawn.
export const qSpawnPointsFor = (n, kind = "c") => `
  SELECT s.id AS entry, s.x, s.y, s.map, s.zone
  FROM spawn_points s INDEXED BY idx_spawn_id
  WHERE s.kind = '${kind === "o" ? "o" : "c"}' AND s.id IN (${inList(n)}) AND s.zone IS NOT NULL LIMIT 8000`;
// Fallback location for a spawn-less NPC (script/pool/event-placed bosses like
// Kilrogg Deadeye carry no static coordinates in the server data): the zones of the
// quests it gives or turns in, most-common first, limited to zones that have a
// parchment map. Lets such an NPC still name + render its zone (no pins -- no exact
// coords). Returns zone rows shaped like qZonesByIds so the page can draw the map.
export const Q_NPC_QUEST_ZONES = `
  SELECT z.areaid, z.name, z.mapid, z.locleft, z.locright, z.loctop, z.locbottom, z.img_w, z.img_h, COUNT(*) AS n
  FROM (
    SELECT quest FROM creature_quest_start WHERE id = ?1
    UNION ALL
    SELECT quest FROM creature_quest_end WHERE id = ?1
  ) x
  JOIN quests q ON q.entry = x.quest
  JOIN zones z ON z.areaid = q.zone
  GROUP BY z.areaid ORDER BY n DESC, z.areaid`;

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
export const Q_OBJECT = `SELECT entry, name, type, displayId, data0, data1 FROM gameobjects WHERE entry = ?1`;

// Readable "book" text, followed page-by-page down the next_page linked list.
// ?1 = the first page id (items.page_text, or a type-9 gameobject's data0).
// depth guard prevents an infinite walk on a malformed self-referential chain.
export const Q_PAGE_TEXT = `
  WITH RECURSIVE chain(entry, text, next_page, depth) AS (
    SELECT entry, text, next_page, 0 FROM page_text WHERE entry = ?1
    UNION ALL
    SELECT p.entry, p.text, p.next_page, chain.depth + 1
    FROM page_text p JOIN chain ON p.entry = chain.next_page
    WHERE chain.next_page <> 0 AND chain.depth < 50
  )
  SELECT text, depth FROM chain ORDER BY depth`;
// All entries sharing a name (the group the detail page aggregates over).
export const Q_OBJECT_SIBLINGS = `SELECT entry, data1 FROM gameobjects WHERE name = ?1`;
// Items looted from a set of object loot-ids (data1), highest chance kept per item.
export const qObjectLoot = (n) => `
  SELECT i.entry, i.name, i.quality, di.icon, MAX(d.chance) AS chance,
         MIN(d.mincount) AS mincount, MAX(d.maxcount) AS maxcount
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

// ---- flight (taxi) network world map ----
export const Q_TAXI_CONTINENTS = `SELECT map, dir, w, h, locleft, locright, loctop, locbottom FROM taxi_continents ORDER BY map`;
export const Q_TAXI_NODES = `SELECT id, x, y, name, faction FROM taxi_nodes WHERE map = ?1 ORDER BY name`;
// every route's waypoints on a continent (grouped by path client-side into polylines).
export const Q_TAXI_ROUTES = `
  SELECT pn.path, pn.x, pn.y, p.faction
  FROM taxi_pathnodes pn JOIN taxi_paths p ON p.id = pn.path
  WHERE pn.map = ?1 ORDER BY pn.path, pn.idx`;

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
  SELECT c.entry AS boss, c.name AS boss_name, i.entry, i.name, i.quality, di.icon, d.chance, d.mincount, d.maxcount
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

// ---- leveling guides (?guide=) ----
// Clean, race-appropriate quests bound to a zone: directly (q.zone = areaid) or in
// one of its sub-zones (mirrors Q_ZONE_QUESTS), excluding hidden/deprecated rows and
// gating on the guide race bit. ?1 = areaid, ?2 = race bitmask (512 High Elf, 256
// Goblin). reqraces=0 (all races) always passes. Ordered by level then title; the
// caller re-sequences chains via orderQuestChain.
export const Q_GUIDE_QUESTS = `
  SELECT q.entry, q.title, q.level, q.minlevel, q.type, q.reqraces, q.custom,
         q.prevquest, q.nextquest, q.xp, q.money, q.objectives
  FROM quests q JOIN areas a ON a.entry = q.zone
  WHERE (q.zone = ?1 OR a.zone_id = ?1)
    AND q.title <> '' AND q.hidden = 0
    AND (q.reqraces = 0 OR (q.reqraces & ?2) <> 0)
  ORDER BY q.level, q.title LIMIT 1000`;

// Explicit-id quest fetch for the chain guides (attunements / Inferno): the manifest
// gives an ordered id list, so unlike Q_GUIDE_QUESTS there's no zone/race filter here.
export const qQuestsByIds = (n) => `
  SELECT q.entry, q.title, q.level, q.minlevel, q.type, q.reqraces, q.custom,
         q.prevquest, q.nextquest, q.xp, q.money, q.objectives
  FROM quests q WHERE q.entry IN (${inList(n)})`;

// Batched quest relations for a set of quests (the guide's section) -- one round-trip
// each, grouped client-side by quest entry. Creature givers reuse qQuestStartNpcs.
export const qQuestEndNpcs = (n) => `
  SELECT r.quest, c.entry, c.name FROM creature_quest_end r
  JOIN creatures c ON c.entry = r.id WHERE r.quest IN (${inList(n)})`;
export const qQuestStartObjects = (n) => `
  SELECT r.quest, g.entry, g.name FROM gameobject_quest_start r
  JOIN gameobjects g ON g.entry = r.id WHERE r.quest IN (${inList(n)})`;
export const qQuestEndObjects = (n) => `
  SELECT r.quest, g.entry, g.name FROM gameobject_quest_end r
  JOIN gameobjects g ON g.entry = r.id WHERE r.quest IN (${inList(n)})`;
// Kill/use objectives for a set of quests (creature is_go=0, object is_go=1).
export const qGuideObjectives = (n) => `
  SELECT o.quest, o.target, o.is_go, o.count, COALESCE(c.name, g.name) AS name
  FROM quest_creature_objective o
  LEFT JOIN creatures  c ON c.entry = o.target AND o.is_go = 0
  LEFT JOIN gameobjects g ON g.entry = o.target AND o.is_go = 1
  WHERE o.quest IN (${inList(n)})`;
// All quest<->item links (req/source/reward/choice) for a set of quests.
export const qGuideItems = (n) => `
  SELECT qi.quest, qi.role, qi.count, i.entry, i.name, i.quality, di.icon
  FROM quest_item qi JOIN items i ON i.entry = qi.item
  LEFT JOIN item_display_info di ON di.ID = i.display_id
  WHERE qi.quest IN (${inList(n)})`;

// ---- factions / reputation ----
export const Q_FACTIONS = `SELECT id, name, items, repquests FROM factions ORDER BY name`;
export const Q_FACTION = `SELECT id, name, listid, items, repquests, repmobs FROM factions WHERE id = ?1`;

// Creatures that grant reputation with this faction on kill (rep grind calculator).
// value = rep per kill; maxstanding = the standing (index) kills cap out at.
export const Q_FACTION_MOBS = `
  SELECT cr.creature AS entry, cr.value, cr.maxstanding,
         c.name, c.level_min, c.level_max, c.rank
  FROM creature_rep cr JOIN creatures c ON c.entry = cr.creature
  WHERE cr.faction = ?1 AND cr.value > 0
  ORDER BY cr.value DESC, c.level_max DESC LIMIT 1000`;

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
// A dropper's location comes from the `cloc` CTE = static `spawns` UNION
// `creature_instance` (script-spawned bosses carry NO static spawn -> the old
// spawns-only join missed e.g. Baron Aquanis, whose Strange Water Globe drops from
// a C++-placed boss in Blackfathom Deeps). Both the inclusion join AND the
// exclusivity guard read cloc, so the off-map test stays honest for such bosses.
// gc = the alphabetically-first start NPC, for a stable Quest Giver cell.
// Branch (c) — "quest needs an item that drops EXCLUSIVELY inside this instance" — reads
// the build-time `item_dungeon` table (item -> the one instance map it drops in; see
// build-db). That replaces a per-call NOT-EXISTS over drops joined to a materialized
// spawns∪creature_instance CTE (SQLite rebuilt an AUTOMATIC index every call): ~95ms ->
// ~4ms per dungeon, result-identical. The other branches are already index-driven.
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
      JOIN item_dungeon idg ON idg.item = qi.item AND idg.map = ?1
      WHERE qi.role IN ('req', 'source')
  )
  ORDER BY q.level, q.title LIMIT 1000`;

// ---- zones (Leaflet maps) ----
export const Q_ZONES = `SELECT areaid, name, mapid, spawns FROM zones WHERE name <> '' ORDER BY name`;
// Zones on one continent that have spawns -> the world-map zone-focus dropdown.
export const Q_CONTINENT_ZONES = `SELECT areaid, name FROM zones WHERE mapid = ?1 AND spawns > 0 AND name <> '' ORDER BY name`;
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
  SELECT s.x, s.y, s.zone, c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank, c.npc_flags, c.loot_value,
         (EXISTS(SELECT 1 FROM creature_quest_start q WHERE q.id = c.entry)
       OR EXISTS(SELECT 1 FROM creature_quest_end q WHERE q.id = c.entry)) AS questgiver
  FROM spawn_points s JOIN creatures c ON c.entry = s.id
  WHERE s.kind = 'c' AND s.zone = ?1
  LIMIT 8000`;

export const Q_ZONE_OBJECTS = `
  SELECT s.x, s.y, s.zone, g.entry, g.name, g.type, g.gather, g.gather_icon, g.loot_value
  FROM spawn_points s JOIN gameobjects g ON g.entry = s.id
  WHERE s.kind = 'o' AND s.zone = ?1
  LIMIT 4000`;

// Same as above but across a whole INSTANCE map (all floors) -> ?1 = mapid. Each
// row keeps s.zone so the floor switcher can split markers per floor.
export const Q_MAP_SPAWNS = `
  SELECT s.x, s.y, s.zone, c.entry, c.name, c.subname, c.level_min, c.level_max, c.rank, c.npc_flags, c.loot_value,
         (EXISTS(SELECT 1 FROM creature_quest_start q WHERE q.id = c.entry)
       OR EXISTS(SELECT 1 FROM creature_quest_end q WHERE q.id = c.entry)) AS questgiver
  FROM spawn_points s INDEXED BY idx_spawn_map JOIN creatures c ON c.entry = s.id
  WHERE s.kind = 'c' AND s.map = ?1
  LIMIT 8000`;
export const Q_MAP_OBJECTS = `
  SELECT s.x, s.y, s.zone, g.entry, g.name, g.type, g.gather, g.gather_icon, g.loot_value
  FROM spawn_points s INDEXED BY idx_spawn_map JOIN gameobjects g ON g.entry = s.id
  WHERE s.kind = 'o' AND s.map = ?1
  LIMIT 4000`;

// Seamless continent minimap (?worldmap=mapid): every spawn on an OVERWORLD map,
// reprojected onto the tile pyramid. A continent has ~67k creature spawns, so the
// instance-map LIMITs above are far too tight -> generous caps (categories render
// lazily and default off, so the cost is paid only when a layer is toggled on).
export const Q_WORLD_SPAWNS = `
  SELECT s.x, s.y, s.zone, c.entry, c.name, c.level_min, c.level_max, c.rank, c.npc_flags,
         (EXISTS(SELECT 1 FROM creature_quest_start q WHERE q.id = c.entry)
       OR EXISTS(SELECT 1 FROM creature_quest_end q WHERE q.id = c.entry)) AS questgiver
  FROM spawn_points s INDEXED BY idx_spawn_map JOIN creatures c ON c.entry = s.id
  WHERE s.kind = 'c' AND s.map = ?1
  LIMIT 120000`;
export const Q_WORLD_OBJECTS = `
  SELECT s.x, s.y, s.zone, g.entry, g.name, g.type, g.gather, g.gather_icon, g.loot_value
  FROM spawn_points s INDEXED BY idx_spawn_map JOIN gameobjects g ON g.entry = s.id
  WHERE s.kind = 'o' AND s.map = ?1
  LIMIT 60000`;
// World-map npc name filter, FTS-backed (prefix ?1 + trigram/infix ?2, same indexes
// as the global search) -> matching creature entries; the map filters its markers.
export const Q_WORLD_NPC_FILTER = `
  SELECT c.entry FROM creatures c
  WHERE c.entry IN (SELECT rowid FROM creatures_fts WHERE creatures_fts MATCH ?1)
     OR c.entry IN (SELECT rowid FROM creatures_tg WHERE creatures_tg MATCH ?2)
  LIMIT 8000`;

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
