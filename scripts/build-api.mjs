// Wowhead-style public JSON API: one file per entity, the SAME data the detail page
// shows (structured fields + sources + a rendered in-game tooltip), served static
// from R2 at api.tortoiseclothing.org/<i|n|q|s>/<id>(.json). Richer superset of the
// compact tt/*.json the embed widget uses.
//
// Reuses the app's real query SQL (src/queries.js) + tooltip renderer
// (src/render.js renderTooltip -- pure, Node-safe) so the API can never drift from
// the page. Content-hashed so CI skips regeneration + the 50k-file R2 sync when the
// DB (and this script) are unchanged (HASH_ONLY=1 prints only the hash).
//
// Out:  <OUT>/api/<prefix>/<id>.json  +  <OUT>/api/manifest.json  (OUT defaults dist)
// Env:  OUT_DIR (default "dist"), DB_PATH, API_ONLY (i,n,q,s), API_LIMIT (row cap for
//       a fast local subset), HASH_ONLY=1.
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { openDatabase } from "./lib/sqlite.mjs";
import * as Q from "../src/queries.js";
import { renderTooltip, spellTooltip, esc } from "../src/render.js";
import { QUALITY, ITEM_CLASS, WEAPON_SUBCLASS, ARMOR_SUBCLASS, INV_TYPE, BONDING,
  CREATURE_TYPE, CREATURE_RANK, QUEST_TYPE, questZoneLabel, npcRoles, DMG_SCHOOL, RESISTANCES } from "../src/constants.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = resolve(ROOT, process.env.OUT_DIR || "dist");
const DB = process.env.DB_PATH || join(ROOT, "public", "data", "tortoise.sqlite");
const API_VERSION = "2"; // bump when the JSON shape changes (shifts the CI hash-gate)
const HASH_ONLY = process.env.HASH_ONLY === "1";
const ONLY = new Set((process.env.API_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean));
const LIMIT = Number(process.env.API_LIMIT) || 0;

// Canonical site for absolutizing the tooltip's relative SPA links so the HTML is
// portable when embedded off-site.
const SITE = "https://xian55.github.io/tortoise-db-viewer/";
const absLinks = (html) => html.replace(/href="\?/g, `href="${SITE}?`);
const link = (type, id) => `${SITE}?${type}=${id}`;
let dataVersion = "";
try { dataVersion = JSON.parse(readFileSync(join(ROOT, "public", "data", "version.json"), "utf8")).version || ""; } catch { /* absent */ }

const db = await openDatabase(DB);

// ---- label helpers ----
const qual = (q) => ({ id: q || 0, name: (QUALITY[q] || QUALITY[1]).name, color: (QUALITY[q] || QUALITY[1]).color });
const subclassOf = (it) => {
  const n = it.class === 2 ? WEAPON_SUBCLASS[it.subclass] : it.class === 4 ? ARMOR_SUBCLASS[it.subclass] : null;
  return n ? { id: it.subclass, name: n } : null;
};
const slotOf = (it) => (INV_TYPE[it.inventory_type] ? { id: it.inventory_type, name: INV_TYPE[it.inventory_type] } : null);
const lvlRange = (r) => (r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : `${r.level_min || "?"}`);
const itemRef = (r) => ({ id: r.entry, name: r.name, quality: r.quality || 0 });
// Source/relation lists are ordered best-first (chance/quality) by their queries;
// cap them so drop-heavy items (world drops, lockboxes) don't balloon the JSON.
const CAP = 25;
const cap = (arr) => (arr.length > CAP ? arr.slice(0, CAP) : arr);

// ---- items ----
// Prepare every item query once; reuse across ~50k ids (prepared statements keep
// the ~14-queries-per-item cost to seconds, not minutes).
const iq = {
  item: db.prepare(Q.Q_ITEM), stats: db.prepare(Q.Q_ITEM_STATS), spell: db.prepare(Q.Q_SPELL),
  set: db.prepare(Q.Q_ITEM_SET), setMembers: db.prepare(Q.Q_ITEMSET_MEMBERS), setBonuses: db.prepare(Q.Q_ITEMSET_BONUSES),
  sameModel: db.prepare(Q.Q_SAME_MODEL), sources: db.prepare(Q.Q_ITEM_SOURCES),
  dropped: db.prepare(Q.Q_DROPPED_BY), objSrc: db.prepare(Q.Q_OBJECT_SOURCE), sold: db.prepare(Q.Q_SOLD_BY),
  containedIn: db.prepare(Q.Q_CONTAINED_IN), contains: db.prepare(Q.Q_CONTAINS), disen: db.prepare(Q.Q_DISENCHANTS_INTO),
  questItem: db.prepare(Q.Q_QUEST_ITEM), startsQuest: db.prepare(Q.Q_STARTS_QUEST),
  createdBy: db.prepare(Q.Q_CREATED_BY), reagentFor: db.prepare(Q.Q_REAGENT_FOR), teaches: db.prepare(Q.Q_TEACHES),
};

function itemCreatedBy(id) {
  // Q_CREATED_BY returns one row per (spell × reagent); group into one entry per spell.
  const bySpell = new Map();
  for (const r of iq.createdBy.all(id)) {
    let g = bySpell.get(r.entry);
    if (!g) { g = { spell: { id: r.entry, name: r.name }, skill: r.skill || 0, reagents: [] }; bySpell.set(r.entry, g); }
    if (r.reagent_item) g.reagents.push({ item: { id: r.reagent_item, name: r.reagent_name, quality: r.reagent_quality || 0 }, count: r.count || 1 });
  }
  return [...bySpell.values()];
}

function itemJson(id) {
  const it = iq.item.get(id);
  if (!it) return null;

  const stats = {};
  for (const r of iq.stats.all(id)) stats[r.stat] = r.value;

  const spellMap = new Map();
  for (let k = 1; k <= 5; k++) { const sid = it[`spellid_${k}`]; if (sid) { const sp = iq.spell.get(sid); if (sp) spellMap.set(sid, sp); } }

  let setOpt = null;
  if (it.set_id) {
    const s = iq.set.get(it.set_id);
    if (s) setOpt = { id: s.id, name: s.name, members: iq.setMembers.all(it.set_id), bonuses: iq.setBonuses.all(it.set_id) };
  }
  const tooltipHtml = absLinks(renderTooltip(it, { spellMap, linkSpells: true, set: setOpt }));

  const sources = {
    droppedBy: cap(iq.dropped.all(id)).map((r) => ({
      npc: { id: r.entry, name: r.name }, level: lvlRange(r), rank: r.rank || 0,
      chance: r.drop_chance ?? r.skin_chance ?? r.pick_chance ?? null,
      mode: r.drop_chance != null ? "loot" : r.skin_chance != null ? "skin" : "pickpocket",
      count: { min: r.mincount || 1, max: r.maxcount || 1 }, dungeon: r.dungeon || null,
    })),
    objectSource: cap(iq.objSrc.all(id)).map((r) => ({ object: { id: r.entry, name: r.name }, chance: r.chance })),
    soldBy: cap(iq.sold.all(id)).map((r) => ({ npc: { id: r.entry, name: r.name }, stock: r.maxcount ?? null, restock: r.incrtime ?? null })),
    containedIn: cap(iq.containedIn.all(id)).map((r) => ({ item: itemRef(r), chance: r.chance, count: { min: r.mincount || 1, max: r.maxcount || 1 } })),
    contains: cap(iq.contains.all(id)).map((r) => ({ item: itemRef(r), chance: r.chance, count: { min: r.mincount || 1, max: r.maxcount || 1 } })),
    disenchant: cap(iq.disen.all(id)).map((r) => ({ item: itemRef(r), chance: r.chance })),
    quests: cap(iq.questItem.all(id)).map((r) => ({ quest: { id: r.entry, title: r.title }, role: r.role, count: r.count || 1, level: r.level || 0 })),
    startsQuest: (() => { const q = iq.startsQuest.get(id); return q ? { id: q.entry, title: q.title } : null; })(),
    createdBy: cap(itemCreatedBy(id)),
    reagentFor: cap(iq.reagentFor.all(id)).map((r) => ({ spell: { id: r.spell, name: r.spell_name }, creates: r.created ? { id: r.created, name: r.created_name, quality: r.quality || 0 } : null })),
    teaches: cap(iq.teaches.all(id)).map((r) => ({ spell: { id: r.spell, name: r.spell_name }, creates: { id: r.item, name: r.item_name, quality: r.quality || 0 } })),
    tags: iq.sources.all(id).map((r) => r.source),
  };

  return {
    id: it.entry, type: "item", dataVersion,
    name: it.name,
    quality: qual(it.quality),
    icon: it.icon || "",
    class: { id: it.class, name: ITEM_CLASS[it.class] || "" },
    subclass: subclassOf(it),
    slot: slotOf(it),
    itemLevel: it.item_level || 0,
    requiredLevel: it.required_level || 0,
    bind: BONDING[it.bonding] || null,
    maxDurability: it.max_durability || 0,
    price: { buy: it.buy_price || 0, sell: it.sell_price || 0 },
    stats,
    sources,
    set: setOpt ? { id: setOpt.id, name: setOpt.name, bonuses: setOpt.bonuses.map((b) => ({ threshold: b.threshold, spell: b.spell ? { id: b.spell, name: b.spell_name } : null, text: b.description || "" })) } : null,
    sameModel: it.display_id ? cap(iq.sameModel.all(it.display_id, it.entry)).map((r) => ({ id: r.entry, name: r.name, quality: r.quality || 0 })) : [],
    flags: { worldDrop: !!it.world_drop, rollsSuffix: !!it.rolls_suffix },
    tooltipHtml,
    link: link("item", it.entry),
  };
}

// ---- npc ----
const nq = {
  npc: db.prepare(Q.Q_NPC), loot: db.prepare(Q.Q_NPC_LOOT), skin: db.prepare(Q.Q_NPC_SKIN), pick: db.prepare(Q.Q_NPC_PICK),
  sells: db.prepare(Q.Q_NPC_SELLS), trains: db.prepare(Q.Q_NPC_TRAINS), starts: db.prepare(Q.Q_NPC_STARTS),
  ends: db.prepare(Q.Q_NPC_ENDS), maps: db.prepare(Q.Q_NPC_MAPS), objectiveOf: db.prepare(Q.Q_NPC_OBJECTIVE_OF),
  abilities: db.prepare(Q.Q_NPC_ABILITIES),
};
// npc/quest tooltip cards (pure, mirrored from src/hovercard.js which doesn't export them)
function npcCardHtml(c) {
  const bits = [`Level ${lvlRange(c)}`];
  if (CREATURE_RANK[c.rank]) bits.push(CREATURE_RANK[c.rank]);
  if (CREATURE_TYPE[c.type] && c.type !== 10) bits.push(CREATURE_TYPE[c.type]);
  const sub = c.subname ? `<div class="tt-line muted">&lt;${esc(c.subname)}&gt;</div>` : "";
  return `<div class="tooltip"><div class="tt-name">${esc(c.name)}</div>${sub}<div class="tt-line muted">${bits.join(" · ")}</div></div>`;
}
const lootRow = (r) => ({ item: { id: r.entry, name: r.name, quality: r.quality || 0 }, chance: r.chance, count: { min: r.mincount || 1, max: r.maxcount || 1 } });

function npcJson(id) {
  const c = nq.npc.get(id);
  if (!c) return null;
  return {
    id: c.entry, type: "npc", dataVersion,
    name: c.name, subname: c.subname || null,
    level: lvlRange(c), rank: CREATURE_RANK[c.rank] || null, creatureType: CREATURE_TYPE[c.type] || null,
    faction: c.faction || 0, health: { min: c.health_min || 0, max: c.health_max || 0 },
    roles: npcRoles(c.npc_flags),
    // Combat stats + cast list, same source as the page's Stats/Abilities tabs.
    stats: {
      armor: c.armor || 0, attackPower: c.attack_power || 0, attackSpeed: c.base_attack_time || 0,
      mana: { min: c.mana_min || 0, max: c.mana_max || 0 },
      damage: { min: c.dmg_min || 0, max: c.dmg_max || 0, school: DMG_SCHOOL[c.dmg_school] || null },
      ranged: { min: c.ranged_dmg_min || 0, max: c.ranged_dmg_max || 0, attackSpeed: c.ranged_attack_time || 0 },
      resistances: Object.fromEntries(RESISTANCES.map(([col, label]) => [label.toLowerCase(), c[col] || 0])),
      money: { min: c.gold_min || 0, max: c.gold_max || 0 },
    },
    abilities: cap(nq.abilities.all(id)).map((r) => ({
      spell: { id: r.spell, name: r.name }, source: r.src,
      chance: r.prob ?? null, cooldown: r.cd_max ? { min: r.cd_min, max: r.cd_max } : null,
    })),
    drops: cap(nq.loot.all(id)).map(lootRow),
    skinned: cap(nq.skin.all(id)).map(lootRow),
    pickpocketed: cap(nq.pick.all(id)).map(lootRow),
    sells: cap(nq.sells.all(id)).map((r) => ({ item: { id: r.entry, name: r.name, quality: r.quality || 0 }, stock: r.maxcount ?? null, restock: r.incrtime ?? null })),
    teaches: cap(nq.trains.all(id)).map((r) => ({ spell: { id: r.entry, name: r.name }, rank: r.rank || null })),
    startsQuests: nq.starts.all(id).map((r) => ({ id: r.entry, title: r.title, level: r.level || 0 })),
    endsQuests: nq.ends.all(id).map((r) => ({ id: r.entry, title: r.title, level: r.level || 0 })),
    objectiveOf: cap(nq.objectiveOf.all(id)).map((r) => ({ quest: { id: r.entry, title: r.title }, count: r.count || 1 })),
    maps: nq.maps.all(id).map((r) => ({ id: r.id, name: r.name, type: r.type })),
    tooltipHtml: npcCardHtml(c),
    link: link("npc", c.entry),
  };
}

// ---- quest ----
const qq = {
  quest: db.prepare(Q.Q_QUEST), giversNpc: db.prepare(Q.Q_QUEST_GIVERS_NPC), endersNpc: db.prepare(Q.Q_QUEST_ENDERS_NPC),
  giversGo: db.prepare(Q.Q_QUEST_GIVERS_GO), endersGo: db.prepare(Q.Q_QUEST_ENDERS_GO), items: db.prepare(Q.Q_QUEST_ITEMS),
  creatures: db.prepare(Q.Q_QUEST_CREATURES), rep: db.prepare(Q.Q_QUEST_REP), chain: db.prepare(Q.Q_QUEST_CHAIN), spell: db.prepare(Q.Q_SPELL),
};
function questCardHtml(q) {
  const bits = [];
  if (q.level > 0) bits.push(`Level ${q.level}`);
  const z = questZoneLabel(q.zone, q.zone_name); if (z) bits.push(esc(z));
  if (QUEST_TYPE[q.type]) bits.push(QUEST_TYPE[q.type]);
  const obj = q.objectives ? `<div class="tt-line">${esc(q.objectives)}</div>` : "";
  return `<div class="tooltip"><div class="tt-name" style="color:var(--gold)">${esc(q.title)}</div><div class="tt-line muted">${bits.join(" · ")}</div>${obj}</div>`;
}
function questJson(id) {
  const q = qq.quest.get(id);
  if (!q) return null;
  const sp = q.rewspell ? qq.spell.get(q.rewspell) : null;
  return {
    id: q.entry, type: "quest", dataVersion,
    title: q.title, level: q.level || 0, minLevel: q.minlevel || 0,
    questType: QUEST_TYPE[q.type] || null, zone: questZoneLabel(q.zone, q.zone_name) || null,
    objectives: q.objectives || "", details: q.details || "", requestText: q.requesttext || "", offerText: q.offertext || "", endText: q.endtext || "",
    givers: { npc: qq.giversNpc.all(id).map((r) => ({ id: r.entry, name: r.name })), object: qq.giversGo.all(id).map((r) => ({ id: r.entry, name: r.name })) },
    enders: { npc: qq.endersNpc.all(id).map((r) => ({ id: r.entry, name: r.name })), object: qq.endersGo.all(id).map((r) => ({ id: r.entry, name: r.name })) },
    items: qq.items.all(id).map((r) => ({ item: { id: r.entry, name: r.name, quality: r.quality || 0 }, role: r.role, count: r.count || 1 })),
    killObjectives: qq.creatures.all(id).map((r) => ({ target: { id: r.target, name: r.name, isObject: !!r.is_go }, count: r.count || 1 })),
    rewards: { money: q.money || 0, xp: q.xp || 0, spell: sp ? { id: sp.entry, name: sp.name } : null,
      reputation: qq.rep.all(id).map((r) => ({ faction: { id: r.faction, name: r.faction_name }, value: r.value })) },
    chain: cap(qq.chain.all(id)).map((r) => ({ id: r.entry, title: r.title, level: r.level || 0 })),
    tooltipHtml: questCardHtml(q),
    link: link("quest", q.entry),
  };
}

// ---- spell ----
const sq = {
  spell: db.prepare(Q.Q_SPELL), produces: db.prepare(Q.Q_SPELL_PRODUCES), reagents: db.prepare(Q.Q_SPELL_REAGENTS),
  usedBy: db.prepare(Q.Q_SPELL_USED_BY), trainers: db.prepare(Q.Q_SPELL_TRAINERS), books: db.prepare(Q.Q_SPELL_BOOKS),
  rewardQuests: db.prepare(Q.Q_SPELL_REWARD_QUESTS), source: db.prepare(Q.Q_SPELL_SOURCE),
};
function spellJson(id) {
  const sp = sq.spell.get(id);
  if (!sp) return null;
  const src = sq.source.get(id);
  return {
    id: sp.entry, type: "spell", dataVersion,
    name: sp.name, icon: sp.icon || "", rank: sp.rank || null, description: sp.description || "", skill: sp.skill || 0,
    produces: sq.produces.all(id).map((r) => ({ item: { id: r.item, name: r.item_name, quality: r.quality || 0 }, skill: r.skill || 0 })),
    reagents: sq.reagents.all(id).map((r) => ({ item: { id: r.item, name: r.item_name, quality: r.quality || 0 }, count: r.count || 1 })),
    usedBy: cap(sq.usedBy.all(id)).map((r) => ({ id: r.entry, name: r.name, quality: r.quality || 0 })),
    taughtBy: {
      trainers: cap(sq.trainers.all(id)).map((r) => ({ id: r.entry, name: r.name })),
      books: cap(sq.books.all(id)).map((r) => ({ id: r.entry, name: r.name, quality: r.quality || 0 })),
      quests: cap(sq.rewardQuests.all(id)).map((r) => ({ id: r.entry, title: r.title, level: r.level || 0 })),
    },
    learnedFrom: src ? { recipe: src.recipe_item ? { id: src.recipe_item, name: src.recipe_name } : null, trainer: !!src.trainer, auto: !!src.auto } : null,
    tooltipHtml: spellTooltip(sp),
    link: link("spell", sp.entry),
  };
}

// ---- type registry ----
const TYPES = [
  { prefix: "i", enumSql: "SELECT entry FROM items WHERE name <> '' AND COALESCE(hidden,0) = 0 ORDER BY entry", build: itemJson },
  { prefix: "n", enumSql: "SELECT entry FROM creatures WHERE name <> '' AND COALESCE(hidden,0) = 0 ORDER BY entry", build: npcJson },
  { prefix: "q", enumSql: "SELECT entry FROM quests WHERE title <> '' AND hidden = 0 ORDER BY entry", build: questJson },
  { prefix: "s", enumSql: "SELECT entry FROM spells WHERE name <> '' AND COALESCE(hidden,0) = 0 ORDER BY entry", build: spellJson },
];

// ---- generate ----
const hash = createHash("sha256");
hash.update(`v${API_VERSION}|${[...ONLY].sort().join(",")}|${LIMIT}\n`);
let total = 0;
for (const t of TYPES) {
  if (ONLY.size && !ONLY.has(t.prefix)) continue;
  let ids;
  try { ids = db.prepare(t.enumSql + (LIMIT ? ` LIMIT ${LIMIT}` : "")).all(); }
  catch (err) { console.warn(`skip ${t.prefix}: ${err.message}`); continue; }
  if (!HASH_ONLY) mkdirSync(join(OUT, "api", t.prefix), { recursive: true });
  let n = 0;
  for (const row of ids) {
    const obj = t.build(row.entry);
    if (!obj) continue;
    const json = JSON.stringify(obj);
    hash.update(`${t.prefix}\t${row.entry}\t${json}\n`);
    total++; n++;
    if (HASH_ONLY) continue;
    writeFileSync(join(OUT, "api", t.prefix, `${row.entry}.json`), json);
  }
  if (!HASH_ONLY) console.log(`  ${t.prefix}: ${n}`);
}
db.close();

const digest = hash.digest("hex").slice(0, 16);
if (HASH_ONLY) { process.stdout.write(digest + "\n"); }
else {
  writeFileSync(join(OUT, "api", "manifest.json"), JSON.stringify({ count: total, hash: digest, version: API_VERSION }) + "\n");
  console.log(`API JSON: ${total} files -> ${OUT}/api (content hash ${digest})`);
}
