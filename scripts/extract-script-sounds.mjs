// LOCAL ONLY -- reads the server's ScriptDev2 C++ tree (../tortoise-wow/src/scripts) and
// writes scripts/data/script-sounds.json: creature_template.script_name -> the
// script_texts entries it speaks and the raw SoundEntries ids it plays.
//
// Why: `script_texts` carries the transcript AND the sound id for ~250 boss lines, but
// nothing in SQL says WHICH creature says them -- the binding is a C++ call:
//
//     enum { SAY_AGGRO = -1999959 };
//     DoScriptText(SAY_AGGRO, m_creature);
//     DoPlaySoundToSet(m_creature, 8272);        // a sound with no text at all
//
// EventAI covers only a fraction (measured: 66 creature/sound pairs via
// creature_ai_events -> dbscript SAY -> broadcast_text), and every Turtle custom boss
// with real voice acting is C++. Without this the voice-line page would be almost empty.
//
// Shares the enum -> AI struct -> script_name chain with extract-script-abilities.mjs
// (scripts/lib/scriptdev.mjs). CI has no server checkout, so the JSON is committed
// source; re-run + commit when the scripts change.
//
//   bun scripts/extract-script-sounds.mjs
//   SCRIPTS_DIR=... bun scripts/extract-script-sounds.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { perScript, args, numberOf } from "./lib/scriptdev.mjs";
import { parseColumns, iterRows } from "./lib/sqldump.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || join(HERE, "..", "..", "tortoise-wow", "src", "scripts");
const SQL_DIR = process.env.SQL_DIR || join(HERE, "..", "..", "tortoise-wow", "sql", "base");
const OUT = join(HERE, "data", "script-sounds.json");

if (!existsSync(SCRIPTS_DIR)) {
  console.error(`ScriptDev2 source not found: ${SCRIPTS_DIR}`);
  console.error("Set SCRIPTS_DIR to the server repo's src/scripts directory.");
  process.exit(1);
}

// Which argument carries the value, per idiom. DoScriptText's is the text entry (always
// negative -- that's script_texts.entry); the sound idioms' is a SoundEntries id.
const TEXT_CALLS = { DoScriptText: 0, DoDisplayText: 0 };
const SOUND_CALLS = { DoPlaySoundToSet: 1, PlayDirectSound: 0, PlayDistanceSound: 0, SendPlaySound: 0 };
// Sound ids below this are phase/flag constants that happen to sit in the same enum.
// build-db drops ids missing from the extracted sound map anyway; this keeps it tidy.
const MIN_SOUND_ID = 20;

// Values are tagged so one pass can carry both kinds through the shared Set: a negative
// number is a text entry, a positive one a sound id. That is the domains' own
// convention, not an encoding we invented.
function collect(src, from, to, consts) {
  const found = new Set();
  const slice = src.slice(from, to);
  const re = new RegExp(`\\b(${[...Object.keys(TEXT_CALLS), ...Object.keys(SOUND_CALLS)].join("|")})\\s*\\(`, "g");
  for (const m of slice.matchAll(re)) {
    const openParen = from + m.index + m[0].length - 1;
    const a = args(src, openParen);
    const isText = m[1] in TEXT_CALLS;
    const v = numberOf(a[isText ? TEXT_CALLS[m[1]] : SOUND_CALLS[m[1]]], consts);
    if (v === null) continue;
    if (isText) { if (v < 0) found.add(v); }
    else if (v >= MIN_SOUND_ID) found.add(v);
  }
  return found;
}

const { byScript, files, withStruct, viaFallback, unresolved } = perScript(SCRIPTS_DIR, collect);

// The sound ids a TRANSCRIPT points at. extract-sounds.py scopes itself off the client
// DBCs, which know nothing about these: a boss line's sound sits in neither
// CreatureSoundData nor the Turtle VA directory, so without this list the audio for
// almost every voice line would never be extracted (measured: 30 of ~340 survived).
// Collected here rather than in the Python because this is server data and the dump
// parser already lives on this side.
function soundIdsFromDumps() {
  const ids = new Set();
  const scan = (file, table, soundCol) => {
    const path = join(SQL_DIR, file);
    if (!existsSync(path)) { console.warn(`  ${file} not found -- skipped`); return; }
    const sql = readFileSync(path, "latin1");
    const i = parseColumns(sql).indexOf(soundCol);
    if (i < 0) { console.warn(`  ${file}: no ${soundCol} column -- skipped`); return; }
    for (const r of iterRows(sql, table)) {
      const s = Number(r[i]) || 0;
      if (s > 0) ids.add(s);
    }
  };
  scan("tw_world_script_texts.sql", "script_texts", "sound");
  scan("tw_world_broadcast_text.sql", "broadcast_text", "sound_id");
  return [...ids].sort((a, b) => a - b);
}

const out = {};
let texts = 0, sounds = 0;
for (const [name, set] of [...byScript].sort((a, b) => a[0].localeCompare(b[0]))) {
  const t = [...set].filter((v) => v < 0).sort((a, b) => b - a);
  const s = [...set].filter((v) => v > 0).sort((a, b) => a - b);
  if (!t.length && !s.length) continue;
  out[name] = {};
  if (t.length) { out[name].t = t; texts += t.length; }
  if (s.length) { out[name].s = s; sounds += s.length; }
}

// Everything the audio extractor must pull beyond what the client DBCs imply: the
// transcript-bearing sounds, plus the ones C++ plays with no line attached.
const direct = new Set();
for (const e of Object.values(out)) for (const s of e.s || []) direct.add(s);
const ids = [...new Set([...soundIdsFromDumps(), ...direct])].sort((a, b) => a - b);

writeFileSync(OUT, JSON.stringify({ scripts: out, ids }, null, 0) + "\n");

console.log(`scanned ${files.length} .cpp files in ${SCRIPTS_DIR}`);
console.log(`  resolved via struct: ${withStruct} | single-struct fallback: ${viaFallback} | unresolved: ${unresolved}`);
console.log(`  ${Object.keys(out).length} scripts -> ${texts} text links + ${sounds} direct sound links`);
console.log(`  ${ids.length} sound ids for extract-sounds.py -> ${OUT.replace(/\\/g, "/")}`);
