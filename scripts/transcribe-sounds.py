#!/usr/bin/env python
"""LOCAL: machine-transcribe the extracted voice clips with Whisper (GPU).

Most NPC voice acting is never written down anywhere. The client picks a clip from an
NPC's VOICE TYPE and the words exist only in the audio, so no amount of parsing the world
DB or the C++ reaches them -- measured, ~250 VA/script clips plus 372 gossip
greeting/farewell/annoyed sounds have audio and no line. This transcribes them from the
audio we already extracted, which also means the text is OURS: no third-party wiki
licensing, and each line is tied to the exact TAKE rather than to a voice type.

Output is scripts/data/voice-transcripts-auto.json (committed, machine-generated).
Hand-verified lines live in the separate voice-transcripts.json and always win; nothing
here ever overwrites them. build-db loads both and tags machine rows so the UI can mark
them as automatic rather than asserting them as fact.

Scope is deliberately VOICE only. Zone music and ambience are excluded outright -- running
speech recognition over a 5-minute orchestral loop produces confident nonsense and would
dominate the runtime.

    python scripts/transcribe-sounds.py                 # every untranscribed voice clip
    python scripts/transcribe-sounds.py --limit 20      # try a handful first
    python scripts/transcribe-sounds.py --model small.en --compute int8
    python scripts/transcribe-sounds.py --only "Goblin%"  # SQL LIKE over the sound name
    python scripts/transcribe-sounds.py --force         # redo ones already in the file

Needs the built DB (public/data/tortoise.sqlite), the extracted audio (public/sounds),
and faster-whisper:

    pip install faster-whisper

GPU notes: --compute defaults to whatever the device actually supports, asked at
runtime via ctranslate2.get_supported_compute_types(). That matters: a GTX 1070 (Pascal,
compute 6.1) reports {int8_float32, int8, float32} and NO fp16, so hardcoding
"int8_float16" fails to initialise and silently drops the run onto the CPU. Falls back to
CPU with a printed reason if CUDA isn't usable at all.
"""
import argparse
import json
import os
import re
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.environ.get("TW_DB") or os.path.join(ROOT, "public", "data", "tortoise.sqlite")
SOUNDS = os.environ.get("SOUNDS_OUT") or os.path.join(ROOT, "public", "sounds")
OUT = os.environ.get("TRANSCRIPTS_OUT") or os.path.join(ROOT, "scripts", "data", "voice-transcripts-auto.json")
HAND = os.path.join(ROOT, "scripts", "data", "voice-transcripts.json")

# Whisper invents speech in silence, and it invents the SAME things -- YouTube outros it
# saw in training. A game grunt or a 0.6s door creak reliably becomes one of these, so
# they are dropped outright rather than trusted to the confidence gate.
HALLUCINATIONS = re.compile(
    r"^[\s\"'.,!?-]*(thanks? (you )?(for|4) watching|please subscribe|subscribe to"
    r"|like and subscribe|thanks for listening|see you (next time|in the next video)"
    r"|bye|you|\[.*\]|\(.*\)|♪.*)[\s\"'.,!?-]*$", re.I)
# Non-lexical vocalisations. A combat death IS "Hmph! Oomph!", and Whisper transcribes it
# confidently enough to clear the logprob gate -- but it is a grunt, not a line, and
# listing it as dialogue would be noise in every search. Matched only when the WHOLE
# result is such tokens, so "Ugh, you again" survives.
GRUNT = re.compile(
    r"^[\s.,!?-]*((h?mph|oo?mph|ugh|argh|aah?|ah|oh|ooh|uh|hu?h|hmm+|mmm+|grr+|rr+|roar"
    r"|cough|gasp|groan|grunt|scream|yell|laugh|sigh|hiss|growl|snarl|yah|hah?|ha)"
    r"[\s.,!?-]*)+$", re.I)
# Below this the model is guessing. Tuned for clean studio speech, where a real line
# scores well above it; noisy-but-real lines are rarer here than hallucinated ones.
MIN_LOGPROB = -1.0
MAX_NO_SPEECH = 0.6
# Real greetings are SHORT -- measured: "Yo" 0.40s, "What's up?" 0.41s, "Talk to me!"
# 0.52s. An 0.8s floor threw away three of four takes of a perfectly good sound. Length
# turns out to be a poor speech/grunt discriminator anyway; avg_logprob is a good one
# (greetings measured -0.21..-0.44, grunts -0.79..-1.14), so lean on that instead and keep
# only enough of a floor to skip clips too short to contain a word at all.
MIN_SECONDS = 0.25


# CreatureSoundData slots that are vocalisations, not speech. A creature's Aggro roar,
# death cry, exertion grunt and wound yelp contain no words in any language -- measured,
# they were ~55% of the worklist and produced nothing but rejected takes and GPU time.
# Loop is an ambient drone (RagnarosLoop), equally wordless.
# A sound is skipped only when EVERY slot pointing at it is one of these: the same file
# can be a creature's death cry and a scripted line elsewhere, and that one has words.
GRUNT_SLOTS = ("Aggro", "Death", "Exertion", "Exertion Critical", "Injury",
               "Injury Critical", "Injury Crushing Blow", "Loop", "Stun", "Wound")


def worklist(conn, only, include_done, done):
    """Voice clips lacking a transcript: (soundId, name, [file], creatureName|None).

    Voice-ness is decided by what POINTS at the sound, not by its path: anything an NPC
    plays plus the Turtle VA directory, minus the purely-vocal combat slots. A sound that
    only ever appears in zone_sound is music or ambience and is skipped.
    """
    rows = conn.execute("""
        SELECT s.id, s.name, s.files, s.ms,
               (SELECT c.name FROM creature_sound cs JOIN creatures c ON c.entry = cs.creature
                 WHERE cs.sound = s.id ORDER BY cs.ord LIMIT 1) AS who
        FROM sounds s
        WHERE (EXISTS (SELECT 1 FROM creature_sound cs WHERE cs.sound = s.id
                        AND cs.slot NOT IN ({slots}))
               OR s.files LIKE '["interface/va/%')
          AND NOT EXISTS (SELECT 1 FROM zone_sound z WHERE z.sound = s.id)
          AND NOT EXISTS (SELECT 1 FROM sound_text t WHERE t.sound = s.id)
        ORDER BY s.name
    """.format(slots=",".join("?" * len(GRUNT_SLOTS))), GRUNT_SLOTS).fetchall()
    out = []
    for sid, name, files, ms, who in rows:
        if only and not _like(name, only):
            continue
        if not include_done and name in done:
            continue
        try:
            fl = json.loads(files)
        except (TypeError, ValueError):
            continue
        if fl:
            out.append((sid, name, fl, who))
    return out


def _like(name, pattern):
    rx = "^" + re.escape(pattern).replace(r"\%", ".*").replace(r"\_", ".") + "$"
    return re.match(rx, name, re.I) is not None


def clean(text):
    t = " ".join(str(text or "").split())
    if not t or HALLUCINATIONS.match(t) or GRUNT.match(t):
        return None
    # Whisper likes to end a fragment with an ellipsis or stray dash; harmless but noisy.
    return t.strip(" -–—")


def add_cuda_dll_dirs():
    """Make the pip-installed CUDA 12 runtime visible to ctranslate2 on Windows.

    `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` drops its DLLs under
    site-packages/nvidia/*/bin, which Windows does not search. Without this the model
    LOADS fine (VRAM fills, it looks like the GPU is working) and then every encode dies
    with "Library cublas64_12.dll is not found" -- a systemic failure that reads exactly
    like a per-file one.
    """
    if not hasattr(os, "add_dll_directory"):
        return                                   # not Windows
    try:
        import nvidia
    except ImportError:
        return
    for base in nvidia.__path__:
        for sub in ("cublas", "cudnn", "cuda_nvrtc", "cuda_runtime"):
            d = os.path.join(base, sub, "bin")
            if os.path.isdir(d):
                try:
                    os.add_dll_directory(d)
                except OSError:
                    pass
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def best_compute(device):
    """Fastest compute type this device actually supports.

    Asked at runtime rather than hardcoded, because the answer is not guessable from the
    GPU name. A GTX 1070 (Pascal, compute 6.1) reports {int8_float32, int8, float32} --
    no fp16 at all -- so a hardcoded "int8_float16" fails to initialise and silently
    drops the whole run onto the CPU. Newer cards do offer fp16 and are faster with it,
    so neither value is right for everyone; ask the library.
    """
    order = ["int8_float16", "int8_float32", "int8", "float16", "float32"]
    try:
        import ctranslate2
        have = ctranslate2.get_supported_compute_types(device)
    except Exception:                            # noqa: BLE001 - no CUDA, bad driver, ...
        return "int8"
    for c in order:
        if c in have:
            return c
    return "int8"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "medium.en"))
    ap.add_argument("--device", default=os.environ.get("WHISPER_DEVICE", "cuda"))
    ap.add_argument("--compute", default=os.environ.get("WHISPER_COMPUTE", ""))  # "" = negotiate
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(DB):
        sys.exit(f"built DB not found: {DB}\nRun: bun scripts/build-db.mjs")
    if not os.path.isdir(SOUNDS):
        sys.exit(f"audio not found: {SOUNDS}\nRun scripts/extract-sounds.py, or `bun run assets -- --only sounds`")

    out = {}
    if os.path.exists(OUT):
        try:
            out = {k: v for k, v in json.load(open(OUT, encoding="utf8")).items() if not k.startswith("_")}
        except ValueError:
            out = {}
    hand = {}
    if os.path.exists(HAND):
        try:
            hand = {k: v for k, v in json.load(open(HAND, encoding="utf8")).items() if not k.startswith("_")}
        except ValueError:
            hand = {}

    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    work = worklist(conn, args.only, args.force, set(out))
    # A take already transcribed BY HAND is authoritative; never spend GPU on it and never
    # let a machine guess sit next to it.
    work = [w for w in work if w[1] not in hand or not hand[w[1]]]
    if args.limit:
        work = work[:args.limit]
    clips = sum(len(f) for _, _, f, _ in work)
    print(f"{len(work)} sounds / {clips} takes to transcribe  (model={args.model} device={args.device} compute={args.compute})")
    if args.dry_run or not work:
        return

    add_cuda_dll_dirs()
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper not installed.\n  pip install faster-whisper")

    device, compute = args.device, args.compute
    if not compute:
        compute = best_compute(device)
    try:
        model = WhisperModel(args.model, device=device, compute_type=compute)
    except Exception as e:                       # noqa: BLE001 - any CUDA/cuDNN problem
        if device != "cpu":
            print(f"  {device}/{compute} unavailable ({str(e).splitlines()[0][:120]}); falling back to CPU")
            device = "cpu"
            compute = args.compute or best_compute(device)
            model = WhisperModel(args.model, device=device, compute_type=compute)
        else:
            raise
    print(f"  running on {device} / {compute}")

    done = skipped = 0
    fails = []
    for i, (sid, name, files, who) in enumerate(work, 1):
        takes = []
        for rel in files:
            path = os.path.join(SOUNDS, rel.replace("/", os.sep))
            if not os.path.exists(path):
                takes.append(None)
                continue
            # Naming the speaker in the prompt is what gets Anub'Rekhan and Vek'nilash
            # spelled right; a general model has never seen them.
            prompt = f"{who} says:" if who else None
            try:
                # repetition_penalty / no_repeat_ngram_size guard against Whisper's
                # degenerate loop, where it emits the same token until the window cap.
                # Observed: one clip stalled a run for ~48 minutes on a 3-second file.
                # compression_ratio_threshold makes it give up on such output instead of
                # returning it.
                segs, info = model.transcribe(
                    path, language="en", beam_size=5, vad_filter=True,
                    initial_prompt=prompt, condition_on_previous_text=False,
                    repetition_penalty=1.1, no_repeat_ngram_size=3,
                    compression_ratio_threshold=2.4)
                segs = list(segs)
            except Exception as e:               # noqa: BLE001 - one bad file must not stop the run
                msg = str(e).splitlines()[0][:120]
                print(f"  FAIL {rel}: {msg}")
                takes.append(None)
                fails.append(msg)
                # A per-file error is fine to skip; the SAME error every time is systemic
                # (a missing CUDA DLL, a bad model) and skipping it 4,000 times would
                # report a clean run that transcribed nothing. Stop and say so.
                if len(fails) >= 5 and len(set(fails[-5:])) == 1:
                    sys.exit(f"\naborting: 5 consecutive identical failures -- {msg}\n"
                             "This is not a bad file. Fix the environment and re-run.")
                continue
            if info.duration < MIN_SECONDS:
                takes.append(None); skipped += 1; continue
            good = [s for s in segs
                    if getattr(s, "avg_logprob", 0) >= MIN_LOGPROB
                    and getattr(s, "no_speech_prob", 0) <= MAX_NO_SPEECH]
            text = clean(" ".join(s.text for s in good))
            if not text:
                skipped += 1
            takes.append(text)
        while takes and takes[-1] is None:       # don't store trailing nulls
            takes.pop()
        if any(takes):
            out[name] = takes
            done += 1
        if i % 25 == 0 or i == len(work):
            print(f"  {i}/{len(work)} sounds  ({done} transcribed, {skipped} takes rejected)")
            # Checkpoint. A full pass is ~80 minutes; without this a crash, a Ctrl-C or a
            # bad threshold choice throws all of it away, and there is no way to eyeball
            # quality until the very end. Written every 25 sounds so the file is always
            # inspectable and the run is always resumable (a rerun skips what's in it).
            write_out(out)

    write_out(out)


def write_out(out):
    payload = {"_comment": [
        "MACHINE-GENERATED by scripts/transcribe-sounds.py -- Whisper over the extracted",
        "audio. Keyed by SoundEntries name, indexed by TAKE (same order as the player's",
        "numbered chips). null = no confident speech in that take.",
        "",
        "These are automatic and can be wrong, especially on proper nouns. build-db marks",
        "them so the UI can show them as machine transcripts rather than asserting them.",
        "To correct one, put the right line in voice-transcripts.json -- that file is",
        "hand-verified, always wins, and is never rewritten by this script.",
        "",
        "A take can be marked BAD by putting an empty string at that index in",
        "voice-transcripts.json -- that suppresses this one without inventing a line.",
    ]}
    payload.update({k: out[k] for k in sorted(out)})
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf8") as fh:
        json.dump(payload, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {OUT} ({len(out)} sounds, {os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
