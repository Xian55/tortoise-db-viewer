import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = new Database(join(ROOT, "public", "data", "tortoise.sqlite"), { readonly: true });

const id = Number(process.argv[2] || 55356);

const item = db.prepare("SELECT entry,name,quality,class,subclass,inventory_type,item_level,required_level,armor,bonding,sell_price FROM items WHERE entry=?").get(id);
console.log("ITEM:", item);

// Dropped by creatures (resolve loot references recursively)
const DROP = `
WITH RECURSIVE refs(refentry) AS (
    SELECT entry FROM loot_reference WHERE item=@item
  UNION
    SELECT lr.entry FROM loot_reference lr JOIN refs ON lr.mincountOrRef<0 AND -lr.mincountOrRef=refs.refentry
),
entries(e,chance) AS (
    SELECT entry, ABS(chance) FROM loot_creature WHERE item=@item
  UNION
    SELECT lc.entry, ABS(lc.chance) FROM loot_creature lc JOIN refs ON lc.mincountOrRef<0 AND -lc.mincountOrRef=refs.refentry
)
SELECT c.entry, c.name, c.level_min, c.level_max, MAX(entries.chance) chance
FROM entries JOIN creatures c ON c.loot_id=entries.e
GROUP BY c.entry ORDER BY chance DESC LIMIT 10`;
console.log("\nDROPPED BY:", db.prepare(DROP).all({ item: id }));

console.log("\nSOLD BY:", db.prepare(
  `SELECT c.entry,c.name,v.maxcount FROM npc_vendor v JOIN creatures c ON c.entry=v.entry WHERE v.item=? LIMIT 10`
).all(id));

console.log("\nQUEST (req/reward):", db.prepare(
  `SELECT q.entry,q.title,qi.role,qi.count FROM quest_item qi JOIN quests q ON q.entry=qi.quest WHERE qi.item=? LIMIT 10`
).all(id));

console.log("\nDISENCHANTS INTO:", db.prepare(
  `SELECT d.item,i.name,d.chance FROM loot_disenchant d JOIN items i ON i.entry=d.item WHERE d.entry=(SELECT disenchant_id FROM items WHERE entry=?) LIMIT 10`
).all(id));

console.log("\nCONTAINED IN (opening item yields it):", db.prepare(
  `SELECT li.entry container, i.name, ABS(li.chance) chance FROM loot_item li JOIN items i ON i.entry=li.entry WHERE li.item=? LIMIT 10`
).all(id));

console.log("\nCREATED BY spell:", db.prepare(
  `SELECT sc.spell, s.name FROM spell_creates sc JOIN spells s ON s.entry=sc.spell WHERE sc.item=? LIMIT 10`
).all(id));

console.log("\nREAGENT FOR (creates):", db.prepare(
  `SELECT sr.spell,s.name, sc.item created, ci.name created_name FROM spell_reagent sr JOIN spells s ON s.entry=sr.spell LEFT JOIN spell_creates sc ON sc.spell=sr.spell LEFT JOIN items ci ON ci.entry=sc.item WHERE sr.item=? LIMIT 10`
).all(id));

console.log("\nFTS search 'thunder':", db.prepare(
  `SELECT i.entry,i.name,i.quality FROM items_fts f JOIN items i ON i.entry=f.rowid WHERE items_fts MATCH 'thunder*' LIMIT 8`
).all());

db.close();
