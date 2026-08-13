#!/usr/bin/env python
"""LOCAL: pull the game audio out of the client MPQs and transcode it for the web.

Two outputs, and they have very different lifetimes:

  public/sounds/**.ogg          the audio itself (~4.6k files, ~225 MB). NOT committed --
                                it goes to R2 like public/maps and public/minimap; see
                                "Binary assets live on R2" in CLAUDE.md.
  scripts/data/sound-map.json   the client-derived MAPPING (~1 MB, committed). CI has no
                                game client, so this is the only way build-db can learn
                                which sound an NPC or a zone plays.

Scope is deliberately narrow: only sounds that something in the database can point AT.
That is CreatureSoundData (a model's combat/idle set), NPCSounds (greeting/farewell/
pissed), ZoneMusic / SoundAmbience / ZoneIntroMusicTable, and every entry under the
Turtle-custom `Sound\\Interface\\VA` directory (voice acting the C++ boss scripts play
directly, which no DBC row references). The rest of SoundEntries -- spell impacts, UI
clicks, doodads, footsteps -- has no entity to hang off and would triple the bytes.

The resolution chain, verified by field-probing both clients (see scripts/lib/clientprofile.py):

    creature_template.display_id
      -> CreatureDisplayInfo.SoundID           (an override; only ~300 rows set it)
         else CreatureModelData[.ModelID].SoundID
      -> CreatureSoundData -> per-slot SoundEntries ids
    CreatureDisplayInfo.NPCSoundID -> NPCSounds -> 4 more SoundEntries ids
    AreaTable.{ZoneMusic,AmbienceID,IntroSound} -> {ZoneMusic,SoundAmbience,ZoneIntroMusicTable}

Transcoding: .wav is re-encoded to Opus (music/ambience 96k stereo, voice 48k mono --
measured 6% and 14% of source respectively). Already-compressed .mp3/.ogg sources are
copied through UNCHANGED: re-encoding an Ogg cost 93% of its size for pure generation
loss. Output keeps the source's directory structure, lowercased, minus the leading
"sound/" -- so a path is stable across runs and doubles as the dedupe key (5.5k
SoundEntries file refs collapse to 4.6k real files).

Usage:
    python scripts/extract-sounds.py                 # Turtle client -> public/sounds
    CLIENT_PROFILE=tbc TW_CLIENT="F:/Game/TBC-..." \
      SOUNDS_OUT=public/sounds-tbc-cmangos \
      SOUND_MAP_OUT=scripts/data/sound-map-tbc.json \
      python scripts/extract-sounds.py

    --only creature,npc,zone,va   restrict the scope sets
    --limit N                     stop after N files (smoke-test a change)
    --force                       re-transcode files that already exist
    --jobs N                      ffmpeg workers (default: cpu_count)
    --dry-run                     resolve + report, write nothing

Needs the client, StormLib.dll and ffmpeg on PATH.
"""
import argparse
import ctypes as C
import json
import os
import struct
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
DATA = os.path.join(CLIENT, "Data")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from clientprofile import PROFILE, archives, dbc_fields  # noqa: E402


def _abs(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


OUT_DIR = _abs(os.environ.get("SOUNDS_OUT") or os.path.join("public", "sounds"))
MAP_OUT = _abs(os.environ.get("SOUND_MAP_OUT") or os.path.join("scripts", "data", "sound-map.json"))
# Written by scripts/extract-script-sounds.mjs; supplies the "text" scope (below).
SCRIPT_SOUNDS = _abs(os.environ.get("SCRIPT_SOUNDS") or os.path.join("scripts", "data", "script-sounds.json"))

# Turtle's own archives. Sound lives in sound.MPQ/speech.MPQ; the patches override.
ARCHIVE_ORDER = archives([
    "base.MPQ", "dbc.MPQ", "misc.MPQ", "model.MPQ", "sound.MPQ", "speech.MPQ",
    "interface.MPQ", "texture.MPQ", "terrain.MPQ", "wmo.MPQ", "backup.MPQ",
    "patch.MPQ", "patch-2.MPQ", "patch-3.mpq", "patch-4.mpq", "patch-5.mpq",
    "patch-6.mpq", "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
])
F = dbc_fields()

# Long, looping, musical -> stereo and a higher rate; everything else is a short mono
# vocalisation where 48k mono is transparent and a third of the size.
MUSIC_ARGS = ["-c:a", "libopus", "-b:a", "96k", "-ac", "2", "-vbr", "on", "-application", "audio"]
VOICE_ARGS = ["-c:a", "libopus", "-b:a", "48k", "-ac", "1", "-vbr", "on", "-application", "voip"]
COMPRESSED = (".mp3", ".ogg")
# An already-compressed SHORT clip is copied through: re-encoding a 19 KB Ogg measured
# 18 KB, i.e. generation loss for nothing, and these are the quality-sensitive Turtle
# voice lines. A long one is not -- Turtle's custom ambience ships as 4-11 MB mp3s that
# Opus takes to well under a tenth. The threshold is far above any real voice line
# (the ~500 VA clips average 176 KB) and far below any music/ambience track.
PASSTHROUGH_MAX = 512 * 1024


class Storm:
    def __init__(self, dll):
        if not os.path.exists(dll):
            sys.exit(f"StormLib.dll not found: {dll}\nSet STORMLIB env var.")
        d = C.WinDLL(dll)
        d.SFileOpenArchive.argtypes = [C.c_wchar_p, C.c_uint32, C.c_uint32, C.POINTER(C.c_void_p)]; d.SFileOpenArchive.restype = C.c_int
        d.SFileOpenFileEx.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32, C.POINTER(C.c_void_p)]; d.SFileOpenFileEx.restype = C.c_int
        d.SFileGetFileSize.argtypes = [C.c_void_p, C.POINTER(C.c_uint32)]; d.SFileGetFileSize.restype = C.c_uint32
        d.SFileReadFile.argtypes = [C.c_void_p, C.c_void_p, C.c_uint32, C.POINTER(C.c_uint32), C.c_void_p]; d.SFileReadFile.restype = C.c_int
        d.SFileCloseFile.argtypes = [C.c_void_p]; d.SFileCloseFile.restype = C.c_int
        self.d = d
        self.handles = []
        self.opened = []
        for arc in ARCHIVE_ORDER:
            p = os.path.join(DATA, arc)
            if not os.path.exists(p):
                continue
            h = C.c_void_p()
            if d.SFileOpenArchive(p, 0, 0x100, C.byref(h)):
                self.handles.append(h)
                self.opened.append(arc)
        if not self.handles:
            sys.exit(f"no MPQ archives opened under {DATA}")
        # SFileReadFile is not thread-safe on a shared handle.
        self.lock = threading.Lock()

    def read(self, name):
        b = name.encode("latin1")
        with self.lock:
            for h in reversed(self.handles):
                hf = C.c_void_p()
                if not self.d.SFileOpenFileEx(h, b, 0, C.byref(hf)):
                    continue
                sz = self.d.SFileGetFileSize(hf, None)
                if sz in (0, 0xFFFFFFFF):
                    self.d.SFileCloseFile(hf)
                    continue
                buf = (C.c_char * sz)()
                rd = C.c_uint32()
                self.d.SFileReadFile(hf, buf, sz, C.byref(rd), None)
                self.d.SFileCloseFile(hf)
                return bytes(buf[: rd.value])
        return None

    def size(self, name):
        """Uncompressed size without decompressing, or None if no archive has it.

        The SoundEntries DBC keeps rows for files a given client doesn't ship (Turtle's
        carries TBC/WotLK leftovers -- a third of the table), so this doubles as the
        existence check, and it settles the passthrough-vs-transcode question before
        anything is read.
        """
        b = name.encode("latin1")
        with self.lock:
            for h in reversed(self.handles):
                hf = C.c_void_p()
                if not self.d.SFileOpenFileEx(h, b, 0, C.byref(hf)):
                    continue
                sz = self.d.SFileGetFileSize(hf, None)
                self.d.SFileCloseFile(hf)
                if sz not in (0, 0xFFFFFFFF):
                    return sz
        return None


def load_dbc(data, what):
    if data is None:
        sys.exit(f"{what}.dbc not found in the client archives")
    magic, rec, fields, recsize, _ = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit(f"{what}.dbc: bad magic {magic!r}")
    base, strbase = 20, 20 + rec * recsize

    def s(off):
        if not off or strbase + off >= len(data):
            return ""
        return data[strbase + off:data.index(b"\0", strbase + off)].decode("latin1")

    rows = [[struct.unpack_from("<I", data, base + r * recsize + 4 * i)[0] for i in range(fields)]
            for r in range(rec)]
    return rows, s, fields


def norm(path):
    """MPQ path -> the web-relative output path (lowercase, '/'-joined, no 'sound/' head)."""
    p = path.replace("\\", "/").lower().strip("/")
    while "//" in p:
        p = p.replace("//", "/")
    if p.startswith("sound/"):
        p = p[len("sound/"):]
    return p


def out_path(rel, kind, size):
    """Web-relative output name. Keeps the source extension only for a passthrough."""
    stem, ext = os.path.splitext(rel)
    if ext in COMPRESSED and kind == "voice" and size is not None and size <= PASSTHROUGH_MAX:
        return rel
    return stem + ".ogg"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    want = {s.strip() for s in args.only.split(",") if s.strip()} or {"creature", "npc", "zone", "va", "text"}

    if not os.path.isdir(DATA):
        sys.exit(f"client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    st = Storm(STORMLIB)
    print(f"profile={PROFILE} archives={len(st.opened)} out={OUT_DIR}")

    def dbc(name):
        return load_dbc(st.read(f"DBFilesClient\\{name}.dbc"), name)

    SE, se_s, se_fields = dbc("SoundEntries")
    CSD, _, csd_fields = dbc("CreatureSoundData")
    NS, _, _ = dbc("NPCSounds")
    CDI, _, cdi_fields = dbc("CreatureDisplayInfo")
    CMD, _, _ = dbc("CreatureModelData")
    AT, _, _ = dbc("AreaTable")
    ZM, _, _ = dbc("ZoneMusic")
    ZI, _, _ = dbc("ZoneIntroMusicTable")
    SA, _, _ = dbc("SoundAmbience")

    # The offsets below are profile-dependent; a client patched past what clientprofile.py
    # was probed against would silently mis-read. Row width is the cheapest tripwire.
    for name, got, expect in (("SoundEntries", se_fields, 29),
                              ("CreatureSoundData", csd_fields, 37 if PROFILE == "tbc" else 30),
                              ("CreatureDisplayInfo", cdi_fields, 14 if PROFILE == "tbc" else 12)):
        if got != expect:
            print(f"  WARNING: {name}.dbc has {got} fields, expected {expect} for profile "
                  f"{PROFILE!r} -- field offsets in scripts/lib/clientprofile.py may be stale")

    se_by_id = {r[0]: r for r in SE}

    def files_of(sid):
        """SoundEntries id -> [mpqPath], in the DBC's own variant order."""
        r = se_by_id.get(sid)
        if not r:
            return []
        base = se_s(r[F["se_dir"]]).strip("\\")
        out = []
        for i in range(10):
            f = se_s(r[F["se_files"] + i])
            if not f or "." not in f:
                continue
            out.append((base + "\\" + f) if base else f)
        return out

    # ---- scope sets: sound id -> the reason we want it (drives the bitrate choice) ----
    wanted = {}          # soundId -> "music" | "voice"

    def want_sound(sid, kind):
        if sid in se_by_id:
            # music wins: a sound reachable both ways is a long track either way
            if kind == "music" or sid not in wanted:
                wanted[sid] = kind

    slots = F["csd_slots"]
    slot_labels = sorted({lab for _, lab in slots})
    slot_ix = {lab: i for i, lab in enumerate(slot_labels)}

    creature_sound = {}
    if "creature" in want:
        for r in CSD:
            got = []
            for field, label in slots:
                sid = r[field] if field < len(r) else 0
                if sid and sid in se_by_id:
                    got.append([slot_ix[label], sid])
                    want_sound(sid, "music" if label == "Loop" else "voice")
            if got:
                creature_sound[r[0]] = got

    npc_sounds = {}
    if "npc" in want:
        first = F["npcsounds_first"]
        for r in NS:
            got = [r[first + i] if r[first + i] in se_by_id else 0 for i in range(4)]
            if any(got):
                npc_sounds[r[0]] = got
                for sid in got:
                    want_sound(sid, "voice")

    zone_music, ambience, intro, area_sound = {}, {}, {}, {}
    if "zone" in want:
        for r in ZM:
            day, night = r[F["zm_day"]], r[F["zm_night"]]
            if day in se_by_id or night in se_by_id:
                zone_music[r[0]] = [day if day in se_by_id else 0, night if night in se_by_id else 0]
                for sid in zone_music[r[0]]:
                    want_sound(sid, "music")
        for r in SA:
            day, night = r[F["sa_day"]], r[F["sa_night"]]
            if day in se_by_id or night in se_by_id:
                ambience[r[0]] = [day if day in se_by_id else 0, night if night in se_by_id else 0]
                for sid in ambience[r[0]]:
                    want_sound(sid, "music")
        for r in ZI:
            sid = r[F["zi_sound"]]
            if sid in se_by_id:
                intro[r[0]] = sid
                want_sound(sid, "music")
        for r in AT:
            m, a, i = r[F["area_zone_music"]], r[F["area_ambience"]], r[F["area_intro_sound"]]
            ent = {}
            if m in zone_music:
                ent["m"] = m
            if a in ambience:
                ent["a"] = a
            if i in intro:
                ent["i"] = i
            if ent:
                area_sound[r[0]] = ent

    if "va" in want:
        # Turtle's custom voice acting. Most of these are played straight from C++ and are
        # referenced by no DBC row at all, so the directory IS the scope rule.
        for r in SE:
            if norm(se_s(r[F["se_dir"]])).startswith("interface/va"):
                want_sound(r[0], "voice")

    # Voice lines. A spoken boss line's sound is in NEITHER CreatureSoundData nor the VA
    # directory -- the only thing that knows about it is the server's script_texts /
    # broadcast_text, so the id list is collected there (scripts/extract-script-sounds.mjs)
    # and read back here. Without it the transcripts would have no audio to play.
    n_text = 0
    if "text" in want:
        try:
            with open(SCRIPT_SOUNDS, encoding="utf8") as fh:
                for sid in json.load(fh).get("ids", ()):
                    if sid not in wanted:
                        n_text += 1
                    want_sound(sid, "voice")
        except OSError:
            print(f"  NOTE: {os.path.relpath(SCRIPT_SOUNDS, ROOT)} not found -- voice-line audio "
                  f"skipped (run: bun scripts/extract-script-sounds.mjs)")

    # ---- display_id -> (CreatureSoundData id, NPCSounds id) ----
    # build-db can't walk this: the whole chain is client-side.
    model_sound = {r[0]: r[F["cmd_sound"]] for r in CMD}
    display_sound = {}
    for r in CDI:
        csd = r[F["cdi_sound"]] or model_sound.get(r[F["cdi_model"]], 0)
        ns = r[F["cdi_npc_sound"]]
        csd = csd if csd in creature_sound else 0
        ns = ns if ns in npc_sounds else 0
        if csd or ns:
            display_sound[r[0]] = [csd, ns]

    # ---- resolve to files ----
    # Several SoundEntries rows share a file, so everything below is keyed by the MPQ
    # path and deduped there; a sound's `f` list is then just a lookup.
    sound_mpq = {}       # soundId -> [mpqPath]
    path_kind = {}       # mpqPath -> "music" | "voice"  (music wins a tie)
    for sid in sorted(wanted):
        paths = files_of(sid)
        if not paths:
            continue
        sound_mpq[sid] = paths
        for p in paths:
            if wanted[sid] == "music" or p not in path_kind:
                path_kind[p] = wanted[sid]

    # Size up front: it decides passthrough-vs-transcode (and so the output extension),
    # and it is how we learn which DBC rows point at a file this client doesn't ship.
    sizes = {p: st.size(p) for p in sorted(path_kind)}
    absent = {p for p, s in sizes.items() if s is None}
    rel_of = {p: out_path(norm(p), path_kind[p], sizes[p]) for p in sizes if p not in absent}
    jobs = {}            # outRel -> mpqPath
    for p, rel in rel_of.items():
        jobs.setdefault(rel, p)
    sound_files = {sid: [rel_of[p] for p in paths if p in rel_of]
                   for sid, paths in sound_mpq.items()}
    sound_files = {sid: rels for sid, rels in sound_files.items() if rels}
    rel_kind = {}
    for p, rel in rel_of.items():
        if path_kind[p] == "music" or rel not in rel_kind:
            rel_kind[rel] = path_kind[p]

    raw_bytes = sum(sizes[p] for p in rel_of)
    print(f"scope: {len(wanted)} sounds -> {len(jobs)} unique files, {raw_bytes / 1e6:,.0f} MB raw "
          f"({len(absent)} DBC refs absent from this client)")
    print(f"  creature={len(creature_sound)} npc={len(npc_sounds)} zoneMusic={len(zone_music)} "
          f"ambience={len(ambience)} intro={len(intro)} displays={len(display_sound)} voiceLines=+{n_text}")
    if args.dry_run:
        return

    todo = sorted(jobs)
    if args.limit:
        todo = todo[:args.limit]

    done, skipped, missing, failed = 0, 0, [], []
    lock = threading.Lock()
    total = len(todo)
    # ffprobe costs a process per file. A cached file's duration can't have changed, so
    # carry it over from the previous map and re-probe only what we actually wrote.
    durations = {}
    try:
        with open(MAP_OUT, encoding="utf8") as fh:
            for ent in json.load(fh).get("sounds", {}).values():
                for rel, ms in zip(ent.get("f", ()), ent.get("d", ())):
                    if ms:
                        durations[rel] = ms
    except (OSError, ValueError):
        pass

    def work(rel):
        nonlocal done, skipped
        dst = os.path.join(OUT_DIR, rel.replace("/", os.sep))
        if not args.force and os.path.exists(dst) and os.path.getsize(dst):
            with lock:
                skipped += 1
            return rel, durations.get(rel) or probe_ms(dst)
        raw = st.read(jobs[rel])
        if raw is None:
            with lock:
                missing.append(rel)
            return None
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        # out_path already decided this: same extension in and out == passthrough.
        if os.path.splitext(jobs[rel])[1].lower() == os.path.splitext(rel)[1].lower():
            with open(dst, "wb") as fh:
                fh.write(raw)
        else:
            enc = MUSIC_ARGS if rel_kind.get(rel) == "music" else VOICE_ARGS
            p = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", "pipe:0"] + enc + [dst],
                               input=raw, capture_output=True)
            if p.returncode or not os.path.exists(dst):
                with lock:
                    failed.append((rel, p.stderr.decode("utf8", "replace")[:200]))
                return None
        with lock:
            done += 1
            if (done + skipped) % 250 == 0:
                print(f"  {done + skipped}/{total} ({done} written, {skipped} cached)")
        return rel, probe_ms(dst)

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for res in pool.map(work, todo):
            if res and res[1]:
                durations[res[0]] = res[1]

    print(f"files: {done} written, {skipped} cached, {len(missing)} absent from the client, {len(failed)} failed")
    for rel, err in failed[:5]:
        print(f"  FAIL {rel}: {err}")
    if missing[:5]:
        print(f"  absent e.g.: {missing[:5]}")

    have = set(todo) - set(missing) - {r for r, _ in failed}
    # A sound whose every file is absent can't be shipped -- drop it so the DB never
    # renders a player pointing at a 404.
    sounds = {}
    for sid, rels in sound_files.items():
        keep = [r for r in rels if r in have or (args.limit and r not in todo)]
        if not keep:
            continue
        r = se_by_id[sid]
        sounds[str(sid)] = {
            "n": se_s(r[F["se_name"]]),
            "t": r[F["se_type"]],
            "f": keep,
            "d": [durations.get(x, 0) for x in keep],
        }

    payload = {
        "profile": PROFILE,
        "slots": slot_labels,
        "sounds": sounds,
        "creatureSound": {str(k): v for k, v in creature_sound.items()},
        "npcSounds": {str(k): v for k, v in npc_sounds.items()},
        "displaySound": {str(k): v for k, v in display_sound.items()},
        "zoneMusic": {str(k): v for k, v in zone_music.items()},
        "ambience": {str(k): v for k, v in ambience.items()},
        "intro": {str(k): v for k, v in intro.items()},
        "areaSound": {str(k): v for k, v in area_sound.items()},
    }
    if args.limit:
        print("--limit given: NOT rewriting the sound map (it would drop every unprocessed sound)")
    else:
        os.makedirs(os.path.dirname(MAP_OUT), exist_ok=True)
        with open(MAP_OUT, "w", encoding="utf8") as fh:
            json.dump(payload, fh, separators=(",", ":"), sort_keys=True)
        print(f"wrote {MAP_OUT} ({os.path.getsize(MAP_OUT) / 1e6:.2f} MB, {len(sounds)} sounds)")

    bytes_out = sum(os.path.getsize(os.path.join(OUT_DIR, r.replace("/", os.sep)))
                    for r in have if os.path.exists(os.path.join(OUT_DIR, r.replace("/", os.sep))))
    print(f"audio: {len(have)} files, {bytes_out / 1e6:.1f} MB in {OUT_DIR}")


def probe_ms(path):
    """Duration in ms, for the UI. 0 when ffprobe can't tell (never fatal)."""
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", path], capture_output=True)
    try:
        return int(round(float(p.stdout.decode().strip()) * 1000))
    except (ValueError, AttributeError):
        return 0


if __name__ == "__main__":
    main()
