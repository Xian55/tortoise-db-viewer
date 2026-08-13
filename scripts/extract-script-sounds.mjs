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
import { perScript, args, numberOf, walk, stripComments, constants } from "./lib/scriptdev.mjs";
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

// Three kinds share one Set, since perScript unions whatever collect() returns:
//   negative number  script_texts.entry      (ScriptDev2's own convention)
//   "b:<id>"         broadcast_text.entry    (a POSITIVE text id -- Turtle's Naxxramas
//                                             and others name their lines this way)
//   positive number  SoundEntries id
// Sign alone can't separate a broadcast_text entry from a sound id, hence the tag.
// Getting these out of collect() rather than a whole-file scan is what keeps them
// STRUCT-precise: a file holding two bosses attributes each line to the right one.
function collect(src, from, to, consts) {
  const found = new Set();
  const slice = src.slice(from, to);
  const re = new RegExp(`\\b(${[...Object.keys(TEXT_CALLS), ...Object.keys(SOUND_CALLS)].join("|")})\\s*\\(`, "g");
  for (const m of slice.matchAll(re)) {
    const openParen = from + m.index + m[0].length - 1;
    const a = args(src, openParen);
    const isText = m[1] in TEXT_CALLS;
    const raw = a[isText ? TEXT_CALLS[m[1]] : SOUND_CALLS[m[1]]];
    if (!isText) {
      const v = numberOf(raw, consts);
      if (v !== null && v >= MIN_SOUND_ID) found.add(v);
      continue;
    }
    // The text argument is often PickRandomValue(A, B, C) -- take every constant in it.
    const direct = numberOf(raw, consts);
    const ids = direct !== null ? [direct]
      : [...String(raw ?? "").matchAll(/[A-Za-z_]\w*/g)].map((t) => consts.get(t[0])).filter((v) => typeof v === "number");
    for (const v of ids) {
      if (v < 0) found.add(v);
      else if (v > 0) found.add(`b:${v}`);
    }
  }
  return found;
}

const { byScript, files, withStruct, viaFallback, unresolved } = perScript(SCRIPTS_DIR, collect);

// ---- inline yells: the transcript for most Turtle-custom voice acting ----
// A ScriptDev2 boss does NOT have to route its line through script_texts. Turtle's own
// bosses usually don't -- they yell a literal string and play the VO as two adjacent
// calls:
//
//     m_creature->MonsterYell("New guests? It has been a while ...");
//     m_creature->PlayDirectSound(60402);
//
// so DoScriptText resolution finds nothing and the clip ships with audio but no words.
// Pairing each sound with the nearest literal say recovers those.
//
// The say can come on EITHER side and both idioms are in the tree -- boss_moroes.cpp
// yells then plays, instance_crescent_grove.cpp plays then yells inside a switch over
// creature entry. Matching only backwards shifted that whole instance by one case, so
// the satyr boss was credited with the keeper's line. Misattributed dialogue is worse
// than none, hence: nearest in either direction, and a candidate is rejected if another
// sound call sits between it and this one (that say belongs to the other sound).
const SAY_RE = /\b(?:MonsterYell|MonsterSay|MonsterYellToZone|MonsterTextEmote|MonsterWhisper)\s*\(\s*"((?:[^"\\]|\\.)*)"/g;
const SND_RE = /\b(?:PlayDirectSound|PlayDistanceSound|DoPlaySoundToSet|SendPlaySound)\s*\(\s*(?:[^,()]*,\s*)?(\d{2,})\s*[,)]/g;
const NEAR = 300;   // chars; the idiom is two consecutive statements

// Each entry also carries the script names its FILE registers. Per-struct resolution
// (perScript) can't name the speaker when a file holds several AI structs it can't tell
// apart, but a whole file is one encounter often enough that its registrations are a
// sound attribution -- boss_moroes.cpp registers "boss_moroes", and that is the
// creature_template.script_name build-db joins on. This is what fills the Speaker column
// for lines that per-struct resolution leaves anonymous.
// The `case <CONST>:` label a statement sits under, resolved to a number. Only the
// nearest one before it and only within CASE_NEAR, so a sound outside any switch, or far
// past the label, resolves to nothing rather than borrowing an unrelated case's entry.
const CASE_NEAR = 400;
const CASE_RE = /\bcase\s+([A-Za-z_]\w*)\s*:/g;
function caseCreature(src, at, consts) {
  let best = null;
  for (const m of src.matchAll(CASE_RE)) {
    if (m.index < at && at - m.index < CASE_NEAR && (!best || m.index > best.index)) best = m;
  }
  if (!best) return null;
  const v = consts.get(best[1]);
  // Creature entries only. A case over a phase/event enum resolves to a small number
  // that is no creature at all, so require the id to look like one.
  return typeof v === "number" && v > 1000 ? v : null;
}

// Every DoScriptText id in a file, keyed by the script names that file registers.
//
// Two gaps this closes. First, per-struct resolution gives up on 352 registrations (a
// file whose several AI structs it can't tell apart), leaving their lines anonymous even
// though the file is plainly one encounter. Second -- and this is why Anub'Rekhan's whole
// fight had no speaker -- an id here may be POSITIVE, which is a broadcast_text.entry
// rather than a script_texts.entry. `collect()` only takes negatives, so every such call
// was discarded. Turtle's Naxxramas scripts use positives throughout.
// A file is only usable as an attribution when it registers exactly ONE script, i.e. the
// file IS that script. Two failures forced this down from a looser limit:
//   * a grab-bag like npcs_special.cpp registers dozens of unrelated scripts, and
//     attributing its text pool to each handed Majordomo Executus' "Burn mortals!" to
//     the Chicken, the Target Dummy and the Explosive Sheep -- all of which have UNIQUE
//     script names, so no downstream fan-out cap could catch it;
//   * a two-boss file like Mograine + Whitemane gave HER resurrect line to HIM, which is
//     worse than leaving it anonymous.
// Multi-script files are covered properly by collect() instead, which resolves each line
// to the AI struct that speaks it.
//
// 4 is measured, not guessed: it drops the grab-bags (which register dozens) while
// keeping real encounter files, whose lines often sit in a helper struct the per-struct
// chain can't tie back -- Anub'Rekhan's taunts live in `anub_doorAI`, not the boss AI.
// Tightening this to 1 cost him half his lines and Lady Blaumeux two thirds of hers,
// while fixing nothing: the one cross-boss attribution reported (Whitemane's resurrect
// line credited to Mograine) survived at 1, because it comes from the server's own
// EventAI data rather than from this pass.
const MAX_REGS = 4;

function fileTexts() {
  const out = new Map();      // scriptName -> { t: Set(negative), b: Set(positive) }
  for (const f of walk(SCRIPTS_DIR)) {
    const src = stripComments(readFileSync(f, "utf8"));
    const registered = [...new Set([...src.matchAll(/Name\s*=\s*"([^"]+)"/g)].map((m) => m[1]))];
    if (!registered.length || registered.length > MAX_REGS) continue;
    const consts = constants(src);
    const neg = new Set(), pos = new Set();
    for (const m of src.matchAll(/\bDoScriptText\s*\(/g)) {
      // The first argument is often PickRandomValue(A, B, C), so take every constant in
      // it rather than only a lone literal.
      const raw = String(args(src, m.index + m[0].length - 1)[0] ?? "");
      const direct = numberOf(raw, consts);
      const ids = direct !== null ? [direct]
        : [...raw.matchAll(/[A-Za-z_]\w*/g)].map((t) => consts.get(t[0])).filter((v) => typeof v === "number");
      for (const v of ids) { if (v < 0) neg.add(v); else if (v > 0) pos.add(v); }
    }
    if (!neg.size && !pos.size) continue;
    for (const n of registered) {
      if (!out.has(n)) out.set(n, { t: new Set(), b: new Set() });
      for (const v of neg) out.get(n).t.add(v);
      for (const v of pos) out.get(n).b.add(v);
    }
  }
  return out;
}

function inlineLines() {
  const out = new Map();      // soundId -> { t: text, s: [scriptName], c?: creatureEntry }
  for (const f of walk(SCRIPTS_DIR)) {
    const src = stripComments(readFileSync(f, "utf8"));
    const consts = constants(src);
    const says = [...src.matchAll(SAY_RE)].map((m) => ({ i: m.index, text: m[1] }));
    if (!says.length) continue;
    const registered = [...new Set([...src.matchAll(/Name\s*=\s*"([^"]+)"/g)].map((m) => m[1]))];
    const snds = [...src.matchAll(SND_RE)].map((m) => ({ i: m.index, id: Number(m[1]) }));
    const used = new Set();
    for (const s of snds) {
      // Nearest say either way, closest first, skipping any that another sound call sits
      // between -- that one is the other sound's line, not ours.
      const cands = says
        .filter((y) => !used.has(y.i) && Math.abs(y.i - s.i) < NEAR)
        .sort((a, b) => Math.abs(a.i - s.i) - Math.abs(b.i - s.i));
      const best = cands.find((y) => {
        const lo = Math.min(y.i, s.i), hi = Math.max(y.i, s.i);
        return !snds.some((o) => o !== s && o.i > lo && o.i < hi);
      });
      if (!best) continue;
      used.add(best.i);         // one say per sound, so a loop can't reuse the same line
      if (!out.has(s.id)) {
        const ent = { t: best.text.replace(/\\"/g, '"').replace(/\\n/g, " ").trim(), s: registered };
        // An instance script dispatches on creature entry -- `case fenektis_the_deceiver:`
        // -- which names the speaker outright, where the file's registration only names
        // the INSTANCE script and can't. That is the difference between a credited line
        // and a blank Speaker column for every boss in Crescent Grove and its like.
        const c = caseCreature(src, s.i, consts);
        if (c) ent.c = c;
        out.set(s.id, ent);
      }
    }
  }
  return out;
}
const lines = inlineLines();
const perFile = fileTexts();

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
  const t = [...set].filter((v) => typeof v === "number" && v < 0).sort((a, b) => b - a);
  const s = [...set].filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
  const b = [...set].filter((v) => typeof v === "string").map((v) => +v.slice(2)).sort((a, b2) => a - b2);
  if (!t.length && !s.length && !b.length) continue;
  out[name] = {};
  if (t.length) { out[name].t = t; texts += t.length; }
  if (s.length) { out[name].s = s; sounds += s.length; }
  if (b.length) out[name].b = b;      // struct-resolved broadcast_text ids -- precise
}

// The file-level pass is kept SEPARATE from the struct-resolved ids rather than merged
// into them. It is a superset (same file, no struct filter), so it rescues scripts
// per-struct resolution skipped and adds the broadcast_text ids -- but it is also
// coarser, and build-db has to be able to tell the two apart: a generic script shared by
// dozens of creatures must not hand all of them the same boss line, whereas a
// struct-resolved id is precise however many creatures use it.
//   t  struct-resolved script_texts entries (precise)
//   tf file-level script_texts entries (fallback, fan-out capped downstream)
//   b  file-level broadcast_text entries (same)
let btIds = 0, fileOnly = 0;
for (const [name, e] of perFile) {
  if (!out[name]) { out[name] = {}; fileOnly++; }
  const already = new Set(out[name].t || []);
  const extra = [...e.t].filter((v) => !already.has(v));
  if (extra.length) out[name].tf = extra.sort((a, b) => b - a);
  const bAlready = new Set(out[name].b || []);
  const bExtra = [...e.b].filter((v) => !bAlready.has(v));
  if (bExtra.length) { out[name].bf = bExtra.sort((a, b) => a - b); btIds += bExtra.length; }
}

// Everything the audio extractor must pull beyond what the client DBCs imply: the
// transcript-bearing sounds, plus the ones C++ plays with no line attached.
const direct = new Set();
for (const e of Object.values(out)) for (const s of e.s || []) direct.add(s);
const ids = [...new Set([...soundIdsFromDumps(), ...direct, ...lines.keys()])].sort((a, b) => a - b);

writeFileSync(OUT, JSON.stringify({
  scripts: out,
  lines: Object.fromEntries([...lines].sort((a, b) => a[0] - b[0])),
  ids,
}, null, 0) + "\n");

console.log(`scanned ${files.length} .cpp files in ${SCRIPTS_DIR}`);
console.log(`  resolved via struct: ${withStruct} | single-struct fallback: ${viaFallback} | unresolved: ${unresolved}`);
console.log(`  ${Object.keys(out).length} scripts -> ${texts} text links + ${sounds} direct sound links`);
console.log(`  file-level pass: +${fileOnly} scripts, ${btIds} broadcast_text ids`);
console.log(`  ${lines.size} inline yell transcripts (literal MonsterYell next to a sound)`);
console.log(`  ${ids.length} sound ids for extract-sounds.py -> ${OUT.replace(/\\/g, "/")}`);
