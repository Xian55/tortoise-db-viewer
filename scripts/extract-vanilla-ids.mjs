// LOCAL: derive the canonical vanilla-1.12 ID allowlist from the cmangos Classic DB,
// published as SQLite at github.com/cmangos/classic-db/releases/latest
// (classic-sqlite-db.zip -> classicmangos.sqlite). build-db reads the committed output
// to flag Turtle-WoW custom content: an item/creature/quest is "custom" iff its id is
// NOT in the vanilla set. This is strictly more accurate than the old ID-threshold
// heuristic -- it catches Turtle additions that squat INSIDE the vanilla id range
// (e.g. items 10000-24283) which a threshold misses, and it isn't fooled by vanilla
// entries that legitimately use very high ids (gameobjects reach ~328k).
//
// CI has no cmangos DB, so scripts/data/vanilla-ids.json is COMMITTED source (same
// deal as the other client/reference-derived JSON). Re-run + commit when cmangos ships
// a new Classic DB release. It can't detect an in-place *rebalance* of a vanilla entry
// (same id, changed stats) -- that needs a field-level diff (the cross-server variant
// work), not an id list.
//
// Env: CMANGOS_DB overrides the input path. Run: bun scripts/extract-vanilla-ids.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDatabase } from "./lib/sqlite.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.CMANGOS_DB || "C:/Users/poler/Downloads/classic-sqlite-db/classicmangos.sqlite";
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

writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)} KB) — db_version: ${ver || "unknown"}`);
