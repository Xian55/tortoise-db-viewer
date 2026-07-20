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
// so this resolves that chain per file:
//   1. every `NAME = <number>` constant (enum / #define / const uint32)
//   2. each AI struct's brace range, and the cast calls inside it
//   3. registration name -> GetAI_* function -> the struct it news up
// and emits {scriptName: [spellId, ...]}.
//
// CI has no server checkout, so the JSON is committed source (like
// instance-bosses.json). Re-run + commit when the scripts change.
//
//   bun scripts/extract-script-abilities.mjs
//   SCRIPTS_DIR=... bun scripts/extract-script-abilities.mjs

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

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

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".cpp")) out.push(p);
  }
  return out;
}

// Strip comments so a commented-out cast or a spell id in prose can't be picked up.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

// NAME = 12345 (enum bodies), #define NAME 12345, const uint32 NAME = 12345.
function constants(src) {
  const map = new Map();
  for (const m of src.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(\d+)\s*(?=[,;}])/g)) map.set(m[1], Number(m[2]));
  for (const m of src.matchAll(/#define\s+([A-Za-z_]\w*)\s+(\d+)\b/g)) map.set(m[1], Number(m[2]));
  return map;
}

// Index of the matching close brace for the `{` at or after `from`.
function braceRange(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [open, i];
  }
  return null;
}

// Split a call's argument list on top-level commas (so nested calls stay intact).
function args(src, openParen) {
  let depth = 0, start = openParen + 1;
  const out = [];
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") { if (--depth === 0) { out.push(src.slice(start, i)); return out; } }
    else if (c === "," && depth === 1) { out.push(src.slice(start, i)); start = i + 1; }
  }
  return out;
}

// Which argument carries the spell for each cast idiom.
const CASTS = { DoCastSpellIfCan: 1, CastSpell: 1, DoCast: 0, DoCastAOE: 0 };

// Resolve an argument to a spell id: a bare literal, or a constant (optionally
// namespaced, `eSpells::SpellShadowShock`).
function spellOf(arg, consts) {
  const t = arg.trim().replace(/^\(.*?\)\s*/, "");           // drop a leading cast
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:\w+::)?([A-Za-z_]\w*)$/.exec(t);
  return m && consts.has(m[1]) ? consts.get(m[1]) : null;
}

function spellsIn(src, from, to, consts) {
  const found = new Set();
  const slice = src.slice(from, to);
  for (const m of slice.matchAll(/\b(DoCastSpellIfCan|DoCastAOE|DoCast|CastSpell)\s*\(/g)) {
    const openParen = from + m.index + m[0].length - 1;
    const a = args(src, openParen);
    const id = spellOf(a[CASTS[m[1]]] ?? "", consts);
    if (id && id >= MIN_SPELL_ID) found.add(id);
  }
  return found;
}

const files = walk(SCRIPTS_DIR);
const byScript = new Map();   // script_name -> Set(spellId)
let withStruct = 0, viaFallback = 0, noSpells = 0;

for (const file of files) {
  const src = stripComments(readFileSync(file, "utf8"));
  const consts = constants(src);

  // AI structs and their brace ranges (`struct X : ScriptedAI` / `: public ScriptedAI`).
  const structs = new Map();  // struct name -> Set(spellId)
  for (const m of src.matchAll(/\bstruct\s+(\w+)\s*:\s*(?:public\s+)?[\w:]+/g)) {
    const range = braceRange(src, m.index + m[0].length);
    if (range) structs.set(m[1], spellsIn(src, range[0], range[1], consts));
  }

  // GetAI_foo() { return new fooAI(...) }  ->  fn name -> struct name
  const aiFn = new Map();
  for (const m of src.matchAll(/\b(\w+)\s*\([^)]*\)\s*\{[^{}]*?return\s+new\s+(\w+)\s*\(/g)) aiFn.set(m[1], m[2]);

  // newscript->Name = "..."; ... newscript->GetAI = &GetAI_...;
  const regs = [];
  for (const m of src.matchAll(/Name\s*=\s*"([^"]+)"/g)) {
    const tail = src.slice(m.index, m.index + 400);
    const g = /GetAI\s*=\s*&(\w+)/.exec(tail);
    regs.push({ name: m[1], fn: g ? g[1] : null });
  }
  if (!regs.length) continue;

  // A file whose registrations don't name a struct we can resolve, but which holds
  // exactly one AI struct, can only mean that struct -- attribute it.
  const only = structs.size === 1 ? [...structs.values()][0] : null;

  for (const r of regs) {
    const structName = r.fn && aiFn.get(r.fn);
    let spells = structName && structs.get(structName);
    if (spells) withStruct++;
    else if (only) { spells = only; viaFallback++; }
    else { noSpells++; continue; }
    if (!spells.size) continue;
    if (!byScript.has(r.name)) byScript.set(r.name, new Set());
    for (const s of spells) byScript.get(r.name).add(s);
  }
}

const out = {};
for (const [name, set] of [...byScript].sort((a, b) => a[0].localeCompare(b[0]))) {
  out[name] = [...set].sort((a, b) => a - b);
}
writeFileSync(OUT, JSON.stringify(out, null, 0) + "\n");

const total = Object.values(out).reduce((a, s) => a + s.length, 0);
console.log(`scanned ${files.length} .cpp files in ${SCRIPTS_DIR}`);
console.log(`  resolved via struct: ${withStruct} | single-struct fallback: ${viaFallback} | unresolved: ${noSpells}`);
console.log(`  ${Object.keys(out).length} scripts -> ${total} spell links -> ${OUT.replace(/\\/g, "/")}`);
