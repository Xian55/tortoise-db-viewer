// LOCAL: derive the canonical vanilla-1.12 ID allowlist from the cmangos Classic DB,
// published as SQLite at github.com/cmangos/classic-db/releases/latest
// (classic-sqlite-db.zip -> classicmangos.sqlite). build-db reads the committed output
// to flag Turtle-WoW custom content: an item/creature/quest is "custom" iff its id is
// NOT in the vanilla set. This is strictly more accurate than the old ID-threshold
// heuristic -- it catches Turtle additions that squat INSIDE the vanilla id range
// (e.g. items 10000-24283) which a threshold misses, and it isn't fooled by vanilla
// entries that legitimately use very high ids (gameobjects reach ~328k).
//
// SECOND OUTPUT — the `edited` set (closes the "in-place edit" gap the id-list can't
// see). If the built Turtle DB (public/data/tortoise.sqlite) is present, we field-DIFF
// every shared id against cmangos and record the ones Turtle changed, so build-db can
// badge them custom too. Coverage matches the chosen policy:
//   items     -> normalized NAME differs OR any curated gameplay field differs
//                (repurposed ids AND in-place rebalances)
//   creatures -> normalized NAME differs        (repurposed ids only)
//   quests    -> normalized TITLE differs        (repurposed/retitled ids)
// NPC/quest field-level diffs are intentionally NOT used: their comparable columns are
// FP-prone (derived health, NULL-vs-empty subname, npc-flag drift, quest text/typo
// fixes) and would mass-mistag genuine vanilla rows. Items compare cleanly (validated:
// organic per-field diff spread, no mapping artifacts).
//
// CI has no cmangos DB, so scripts/data/vanilla-ids.json is COMMITTED source (same deal
// as the other client/reference-derived JSON). Run order for a full refresh:
//   build-db  ->  extract-vanilla-ids  ->  build-db
// (the first build produces the Turtle DB this diffs; the second consumes the merged
// custom flags). Re-run + commit when cmangos ships a new Classic DB release or the
// Turtle world data changes materially. `edited` is absent (id-list only) if the built
// Turtle DB isn't found.
//
// Env: CMANGOS_DB overrides the cmangos path; TW_DB overrides the built Turtle DB path.
// Run: bun scripts/extract-vanilla-ids.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDatabase } from "./lib/sqlite.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.CMANGOS_DB || "C:/Users/poler/Downloads/classic-sqlite-db/classicmangos.sqlite";
const TW_DB = process.env.TW_DB || join(ROOT, "public", "data", "tortoise.sqlite");
const OUT = join(ROOT, "scripts", "data", "vanilla-ids.json");

const db = await openDatabase(DB);
const ver = (() => { try { return db.prepare("SELECT version FROM db_version LIMIT 1").get()?.version; } catch { return null; } })();

// (table, primary-key column) -> the manifest key. cmangos uses mixed-case PKs.
const SPECS = [
  ["item_template", "entry", "items"],
  ["creature_template", "Entry", "creatures"],
  ["quest_template", "entry", "quests"],
];

const out = { source: "cmangos classic-db", db_version: ver, generated_from: DB.split(/[\\/]/).pop() };
for (const [table, pk, key] of SPECS) {
  const ids = db.prepare(`SELECT ${pk} AS id FROM ${table}`).all().map((r) => r.id).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  out[key] = ids;
  console.log(`  ${key}: ${ids.length} vanilla ids (max ${ids[ids.length - 1]})`);
}

// ---- edited-entry field diff (Turtle vs cmangos) ----------------------------------
// name/title equality after stripping case + punctuation, so a pure formatting tweak
// isn't a "diff" but a genuine rename/repurpose is.
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Item gameplay fields to diff: viewer(items) column -> cmangos(item_template) column.
// All numeric (compared as Number, NULL->0). Chosen for clean cross-schema semantics;
// text/derived fields are excluded on purpose (see header).
const ITEM_FIELDS = {
  quality: "Quality", class: "class", subclass: "subclass", inventory_type: "InventoryType",
  item_level: "ItemLevel", required_level: "RequiredLevel", required_skill: "RequiredSkill",
  delay: "delay", armor: "armor", block: "block", bonding: "bonding", max_durability: "MaxDurability",
  buy_price: "BuyPrice", sell_price: "SellPrice", set_id: "itemset", start_quest: "startquest",
  holy_res: "holy_res", fire_res: "fire_res", nature_res: "nature_res",
  frost_res: "frost_res", shadow_res: "shadow_res", arcane_res: "arcane_res",
  dmg_min1: "dmg_min1", dmg_max1: "dmg_max1", dmg_min2: "dmg_min2", dmg_max2: "dmg_max2",
};
for (let i = 1; i <= 10; i++) { ITEM_FIELDS[`stat_type${i}`] = `stat_type${i}`; ITEM_FIELDS[`stat_value${i}`] = `stat_value${i}`; }
for (let i = 1; i <= 5; i++) ITEM_FIELDS[`spellid_${i}`] = `spellid_${i}`;

if (existsSync(TW_DB)) {
  const tw = await openDatabase(TW_DB);
  out.edited = {};
  const num = (v) => Number(v ?? 0);

  // Items: name differs OR any curated gameplay field differs.
  {
    const cmGet = db.prepare("SELECT * FROM item_template WHERE entry = ?");
    const rows = tw.prepare("SELECT * FROM items WHERE name <> ''").all();
    const edited = [];
    for (const t of rows) {
      const c = cmGet.get(t.entry);
      if (!c) continue; // not a vanilla id -> already custom by the allowlist
      let diff = norm(t.name) !== norm(c.name);
      if (!diff) for (const f in ITEM_FIELDS) { if (num(t[f]) !== num(c[ITEM_FIELDS[f]])) { diff = true; break; } }
      if (diff) edited.push(t.entry);
    }
    out.edited.items = edited.sort((a, b) => a - b);
    console.log(`  edited items: ${edited.length} (name or gameplay-field diff vs cmangos)`);
  }

  // Creatures / quests: repurpose only -> normalized name/title differs.
  const nameDiffs = (twSql, nameCol, cmTable, cmName, cmPk) => {
    const cmGet = db.prepare(`SELECT ${cmName} AS nm FROM ${cmTable} WHERE ${cmPk} = ?`);
    const rows = tw.prepare(twSql).all();
    const edited = [];
    for (const t of rows) { const c = cmGet.get(t.entry); if (c && norm(t[nameCol]) !== norm(c.nm)) edited.push(t.entry); }
    return edited.sort((a, b) => a - b);
  };
  out.edited.creatures = nameDiffs("SELECT entry, name FROM creatures WHERE name <> ''", "name", "creature_template", "Name", "Entry");
  console.log(`  edited creatures: ${out.edited.creatures.length} (name repurposed vs cmangos)`);
  out.edited.quests = nameDiffs("SELECT entry, title FROM quests WHERE title <> ''", "title", "quest_template", "Title", "entry");
  console.log(`  edited quests: ${out.edited.quests.length} (title repurposed vs cmangos)`);
} else {
  console.log(`  edited set SKIPPED — built Turtle DB not found at ${TW_DB} (run build-db first). id-list only.`);
}

writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)} KB) — db_version: ${ver || "unknown"}`);
