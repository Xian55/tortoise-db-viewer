// LOCAL ONLY -- reads the server's ScriptDev2 C++ tree (../tortoise-wow/src/scripts)
// and writes scripts/data/script-abilities.json: creature_template.script_name ->
// the spell ids that script hardcodes.
//
// Why: a boss whose fight lives in C++ has NO row in creature_spells, no spell_id1..4
// and no EventAI events, so `creature_ability` (build-db) lists nothing for it --
// Ragnaros, Nefarian and most raid bosses came out blank. Their spells only exist as
// enum constants cast from the AI struct, e.g.
//
//     enum eSpells { SpellShadowShock = 19460, ... };
//     struct boss_lucifronAI : ScriptedAI { ...
//         DoCastSpellIfCan(m_creature, eSpells::SpellShadowShock); }
//     newscript->Name = "boss_lucifron";        // == creature_template.script_name
//
// The enum -> AI struct -> script_name chain lives in scripts/lib/scriptdev.mjs, shared
// with extract-script-sounds.mjs; this file only says which calls carry a spell id.
//
// CI has no server checkout, so the JSON is committed source (like
// instance-bosses.json). Re-run + commit when the scripts change.
//
//   bun scripts/extract-script-abilities.mjs
//   SCRIPTS_DIR=... bun scripts/extract-script-abilities.mjs

import { writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { perScript, args, numberOf } from "./lib/scriptdev.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || join(HERE, "..", "..", "tortoise-wow", "src", "scripts");
const OUT = join(HERE, "data", "script-abilities.json");

if (!existsSync(SCRIPTS_DIR)) {
  console.error(`ScriptDev2 source not found: ${SCRIPTS_DIR}`);
  console.error("Set SCRIPTS_DIR to the server repo's src/scripts directory.");
  process.exit(1);
}

// A spell id below this is almost always a non-spell constant that happens to sit in
// an enum (a phase number, a faction, a display id). build-db drops ids missing from
// the shipped `spells` table anyway, this just keeps the JSON tidy.
const MIN_SPELL_ID = 20;

// Which argument carries the spell for each cast idiom.
const CASTS = { DoCastSpellIfCan: 1, CastSpell: 1, DoCast: 0, DoCastAOE: 0 };

function collect(src, from, to, consts) {
  const found = new Set();
  const slice = src.slice(from, to);
  for (const m of slice.matchAll(/\b(DoCastSpellIfCan|DoCastAOE|DoCast|CastSpell)\s*\(/g)) {
    const openParen = from + m.index + m[0].length - 1;
    const id = numberOf(args(src, openParen)[CASTS[m[1]]], consts);
    if (id && id >= MIN_SPELL_ID) found.add(id);
  }
  return found;
}

const { byScript, files, withStruct, viaFallback, unresolved } = perScript(SCRIPTS_DIR, collect);

const out = {};
for (const [name, set] of [...byScript].sort((a, b) => a[0].localeCompare(b[0]))) {
  out[name] = [...set].sort((a, b) => a - b);
}
writeFileSync(OUT, JSON.stringify(out, null, 0) + "\n");

const total = Object.values(out).reduce((a, s) => a + s.length, 0);
console.log(`scanned ${files.length} .cpp files in ${SCRIPTS_DIR}`);
console.log(`  resolved via struct: ${withStruct} | single-struct fallback: ${viaFallback} | unresolved: ${unresolved}`);
console.log(`  ${Object.keys(out).length} scripts -> ${total} spell links -> ${OUT.replace(/\\/g, "/")}`);
