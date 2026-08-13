// Shared parser for the server's ScriptDev2 C++ tree (../tortoise-wow/src/scripts).
//
// A boss whose fight lives in C++ exposes nothing to SQL: no creature_spells rows, no
// spell_id1..4, no EventAI events, no text bindings. Everything -- the spells it casts,
// the lines it says, the sounds it plays -- is enum constants used inside an AI struct
// that a registration block ties back to creature_template.script_name:
//
//     enum { SAY_AGGRO = -1999959, SpellShadowShock = 19460 };
//     struct boss_lucifronAI : ScriptedAI { ...
//         DoCastSpellIfCan(m_creature, SpellShadowShock);
//         DoScriptText(SAY_AGGRO, m_creature); }
//     newscript->Name = "boss_lucifron";        // == creature_template.script_name
//     newscript->GetAI = &GetAI_boss_lucifron;
//
// `perScript()` walks that chain once and hands each caller the brace range of the AI
// struct plus its resolved constants; the caller decides what to pull out of it.
// extract-script-abilities.mjs pulls spell ids, extract-script-sounds.mjs pulls text
// entries and sound ids.
//
// CI has no server checkout, so both extractors' outputs are committed source.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".cpp")) out.push(p);
  }
  return out;
}

/** Strip comments so a commented-out call, or an id quoted in prose, can't be picked up. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** NAME = 12345 (enum bodies), #define NAME 12345, const uint32 NAME = 12345. */
export function constants(src) {
  const map = new Map();
  // Text ids are negative (script_texts.entry), spell/sound ids positive.
  for (const m of src.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*(?=[,;}])/g)) map.set(m[1], Number(m[2]));
  for (const m of src.matchAll(/#define\s+([A-Za-z_]\w*)\s+(-?\d+)\b/g)) map.set(m[1], Number(m[2]));
  return map;
}

/** Index pair for the `{`...`}` at or after `from`. */
export function braceRange(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [open, i];
  }
  return null;
}

/** Split a call's argument list on top-level commas (nested calls stay intact). */
export function args(src, openParen) {
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

/** An argument -> a number: a literal, or a constant (optionally namespaced). */
export function numberOf(arg, consts) {
  const t = String(arg ?? "").trim().replace(/^\(.*?\)\s*/, "");   // drop a leading cast
  if (/^-?\d+$/.test(t)) return Number(t);
  const m = /^(?:\w+::)?([A-Za-z_]\w*)$/.exec(t);
  return m && consts.has(m[1]) ? consts.get(m[1]) : null;
}

/**
 * Collect per script_name across the whole tree.
 *
 * `collect(src, from, to, consts)` is called with each AI struct's brace range and must
 * return an iterable of values; they are unioned into a Set per registered script name.
 * Returns { byScript: Map<string, Set>, files, withStruct, viaFallback, unresolved }.
 */
export function perScript(dir, collect) {
  const files = walk(dir);
  const byScript = new Map();
  let withStruct = 0, viaFallback = 0, unresolved = 0;

  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    const consts = constants(src);

    // AI structs and their brace ranges (`struct X : ScriptedAI` / `: public ScriptedAI`).
    const structs = new Map();
    for (const m of src.matchAll(/\bstruct\s+(\w+)\s*:\s*(?:public\s+)?[\w:]+/g)) {
      const range = braceRange(src, m.index + m[0].length);
      if (range) structs.set(m[1], new Set(collect(src, range[0], range[1], consts)));
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

    // A file whose registrations don't name a resolvable struct, but which holds exactly
    // one AI struct, can only mean that struct -- attribute it.
    const only = structs.size === 1 ? [...structs.values()][0] : null;

    for (const r of regs) {
      const structName = r.fn && aiFn.get(r.fn);
      let vals = structName && structs.get(structName);
      if (vals) withStruct++;
      else if (only) { vals = only; viaFallback++; }
      else { unresolved++; continue; }
      if (!vals.size) continue;
      if (!byScript.has(r.name)) byScript.set(r.name, new Set());
      for (const v of vals) byScript.get(r.name).add(v);
    }
  }
  return { byScript, files, withStruct, viaFallback, unresolved };
}
