#!/usr/bin/env python3
"""Extract the spellIconId -> icon-basename map (and any custom spell icons) from
the game client into the repo.

WHY THIS IS A SEPARATE, LOCAL-ONLY STEP
----------------------------------------
The server ``spell_template`` dump stores only a numeric ``spellIconId``; the
``spellIconId -> texture basename`` mapping lives in the client
``SpellIcon.dbc`` -- NOT in the server SQL. Spells share the same
``Interface\\Icons`` texture pool as items, so once we know the basename the
existing Blizzard CDN (``render-us.worldofwarcraft.com``) serves the standard
spell icons too; only Turtle's *custom* spell icons (absent from the CDN) need
the BLP extracted into the shipped atlas. CI has no client, so the map JSON and
any custom icons are committed as *source* (see README / CLAUDE.md), exactly like
``extract-icons.py`` does for items.

OUTPUTS (committed source)
  scripts/data/spell-icon-map.json   { "<spellIconId>": "<icon_basename>" } for
        every spell-icon the DB uses -- build-db.mjs joins this onto spells.icon.
  assets/icons/custom/<icon>.webp    one lossless WebP per *custom* spell icon
        (not on the CDN, present in the client) -- packed by build-atlas.py.

REQUIREMENTS / ENV OVERRIDES: identical to extract-icons.py (TW_CLIENT, STORMLIB,
CDN, Pillow). Reads the used spellIconIds from the built
``public/data/tortoise.sqlite`` -- run ``build-db`` first.

Run:  python scripts/extract-spell-icons.py
"""
import ctypes as C
import io
import json
import os
import re
import sqlite3
import struct
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow required: pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
STORMLIB = os.environ.get(
    "STORMLIB",
    os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"),
)
CDN = os.environ.get("CDN", "https://render-us.worldofwarcraft.com/icons/56/{}.jpg")

DATA = os.path.join(CLIENT, "Data")
DB_PATH = os.path.join(ROOT, "public", "data", "tortoise.sqlite")
OUT_ICONS = os.path.join(ROOT, "assets", "icons", "custom")
OUT_MAP = os.path.join(ROOT, "scripts", "data", "spell-icon-map.json")

# Archive load order, lowest precedence first (a later archive overrides earlier).
ARCHIVE_ORDER = [
    "base.MPQ", "dbc.MPQ", "misc.MPQ", "model.MPQ", "texture.MPQ",
    "interface.MPQ", "fonts.MPQ", "backup.MPQ",
    "patch.MPQ", "patch-2.MPQ",
    "patch-3.mpq", "patch-4.mpq", "patch-5.mpq", "patch-6.mpq",
    "patch-7.mpq", "patch-8.mpq", "patch-9.mpq",
    "patch-Y.mpq", "_Patch-W.mpq",
]

# ---------------------------------------------------------------------------
# StormLib (MPQ) via ctypes  -- same surface as extract-icons.py
# ---------------------------------------------------------------------------
STREAM_FLAG_READ_ONLY = 0x00000100


class _FindData(C.Structure):
    _fields_ = [
        ("cFileName", C.c_char * 1024), ("szPlainName", C.c_char_p),
        ("dwHashIndex", C.c_uint32), ("dwBlockIndex", C.c_uint32),
        ("dwFileSize", C.c_uint32), ("dwFileFlags", C.c_uint32),
        ("dwCompSize", C.c_uint32), ("dwFileTimeLo", C.c_uint32),
        ("dwFileTimeHi", C.c_uint32), ("lcLocale", C.c_uint32),
    ]


class Storm:
    def __init__(self, dll_path):
        if not os.path.exists(dll_path):
            sys.exit(f"StormLib.dll not found: {dll_path}\nSet STORMLIB env var.")
        d = C.WinDLL(dll_path)
        d.SFileOpenArchive.argtypes = [C.c_wchar_p, C.c_uint32, C.c_uint32, C.POINTER(C.c_void_p)]
        d.SFileOpenArchive.restype = C.c_int
        d.SFileCloseArchive.argtypes = [C.c_void_p]
        d.SFileHasFile.argtypes = [C.c_void_p, C.c_char_p]
        d.SFileHasFile.restype = C.c_int
        d.SFileOpenFileEx.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32, C.POINTER(C.c_void_p)]
        d.SFileOpenFileEx.restype = C.c_int
        d.SFileGetFileSize.argtypes = [C.c_void_p, C.POINTER(C.c_uint32)]
        d.SFileGetFileSize.restype = C.c_uint32
        d.SFileReadFile.argtypes = [C.c_void_p, C.c_void_p, C.c_uint32, C.POINTER(C.c_uint32), C.c_void_p]
        d.SFileReadFile.restype = C.c_int
        d.SFileCloseFile.argtypes = [C.c_void_p]
        d.SFileFindFirstFile.argtypes = [C.c_void_p, C.c_char_p, C.POINTER(_FindData), C.c_char_p]
        d.SFileFindFirstFile.restype = C.c_void_p
        d.SFileFindNextFile.argtypes = [C.c_void_p, C.POINTER(_FindData)]
        d.SFileFindNextFile.restype = C.c_int
        d.SFileFindClose.argtypes = [C.c_void_p]
        self.d = d

    def open(self, mpq):
        h = C.c_void_p()
        if not self.d.SFileOpenArchive(mpq, 0, STREAM_FLAG_READ_ONLY, C.byref(h)):
            return None
        return h

    def close(self, h):
        self.d.SFileCloseArchive(h)

    def has(self, h, name):
        return bool(self.d.SFileHasFile(h, name.encode("latin1")))

    def read(self, h, name):
        hf = C.c_void_p()
        if not self.d.SFileOpenFileEx(h, name.encode("latin1"), 0, C.byref(hf)):
            return None
        sz = self.d.SFileGetFileSize(hf, None)
        buf = (C.c_char * sz)()
        rd = C.c_uint32()
        self.d.SFileReadFile(hf, buf, sz, C.byref(rd), None)
        self.d.SFileCloseFile(hf)
        return bytes(buf[: rd.value])

    def list_icons(self, h):
        """Return set of lowercase icon basenames (no ext) under Interface\\Icons."""
        fd = _FindData()
        hf = self.d.SFileFindFirstFile(h, b"Interface\\Icons\\*.blp", C.byref(fd), None)
        out = set()
        if not hf:
            return out
        while True:
            name = fd.cFileName.decode("latin1").split("\\")[-1]
            if name.lower().endswith(".blp"):
                out.add(name[:-4].lower())
            if not self.d.SFileFindNextFile(hf, C.byref(fd)):
                break
        self.d.SFileFindClose(hf)
        return out


# ---------------------------------------------------------------------------
# SpellIcon.dbc  ->  { id: icon_basename }
# 1.12 layout: 2 fields [ID, TextureFilename(string offset)].
# ---------------------------------------------------------------------------
def parse_spell_icon_dbc(data):
    magic, rec, fields, recsize, _ = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit("SpellIcon.dbc: bad magic")
    base = 20
    strbase = base + rec * recsize

    def s(off):
        if not off:
            return ""
        end = data.index(b"\0", strbase + off)
        return data[strbase + off:end].decode("latin1")

    out = {}
    for r in range(rec):
        o = base + r * recsize
        rid = struct.unpack_from("<I", data, o)[0]
        path = s(struct.unpack_from("<I", data, o + 4)[0])  # TextureFilename (field 1)
        name = path.replace("/", "\\").split("\\")[-1]
        name = re.sub(r"\.(blp|tga)$", "", name, flags=re.I).lower()
        out[rid] = name
    return out


# ---------------------------------------------------------------------------
def main():
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    if not os.path.exists(DB_PATH):
        sys.exit(f"built DB not found: {DB_PATH}\nRun `bun scripts/build-db.mjs` first.")
    storm = Storm(STORMLIB)

    present = [a for a in ARCHIVE_ORDER if os.path.exists(os.path.join(DATA, a))]
    print(f"client: {CLIENT}  ({len(present)} archives)")

    # 1. spells -> distinct spellIconIds (from the built, migrated DB)
    con = sqlite3.connect(DB_PATH)
    icon_ids = {int(r[0]) for r in con.execute(
        "SELECT DISTINCT spellIconId FROM spells WHERE spellIconId IS NOT NULL AND spellIconId > 0")}
    con.close()
    print(f"spells: {len(icon_ids)} distinct spellIconIds")

    # 2. id -> icon basename from the highest-precedence SpellIcon.dbc
    id_icon = {}
    dbc_src = None
    for arc in present:  # low..high; last wins
        h = storm.open(os.path.join(DATA, arc))
        if not h:
            continue
        if storm.has(h, "DBFilesClient\\SpellIcon.dbc"):
            data = storm.read(h, "DBFilesClient\\SpellIcon.dbc")
            if data:
                id_icon = parse_spell_icon_dbc(data)
                dbc_src = arc
        storm.close(h)
    if not id_icon:
        sys.exit("SpellIcon.dbc not found in client")
    print(f"SpellIcon.dbc: {len(id_icon)} rows (from {dbc_src})")

    # used spell icons: id -> basename, only ids the DB actually references
    used = {iid: id_icon[iid] for iid in icon_ids if iid in id_icon and id_icon[iid]}
    used_basenames = set(used.values())
    print(f"distinct icons used by spells: {len(used_basenames)}")

    # 3. which icons exist in the client + where (highest archive wins)
    icon_archive = {}
    for arc in present:  # low..high; last wins
        h = storm.open(os.path.join(DATA, arc))
        if not h:
            continue
        for name in storm.list_icons(h):
            icon_archive[name] = arc
        storm.close(h)

    # 4. CDN probe -> custom = used & present in client & NOT on CDN
    candidates = sorted(b for b in used_basenames if b in icon_archive)

    def probe(name):
        try:
            req = urllib.request.Request(CDN.format(name), method="HEAD")
            with urllib.request.urlopen(req, timeout=15) as r:
                return name, r.status
        except urllib.error.HTTPError as e:
            return name, e.code
        except Exception:
            return name, -1

    print(f"probing CDN for {len(candidates)} candidate icons ...")
    status = {}
    with ThreadPoolExecutor(max_workers=48) as ex:
        for name, code in ex.map(probe, candidates):
            status[name] = code
    custom = sorted(n for n in candidates if status[n] != 200)
    # icons used but missing from the enumerated client listfiles -- probe whether
    # the BLP really exists (listfile gaps, same recovery as extract-icons.py).
    missing = sorted(b for b in used_basenames if b not in icon_archive)
    print(f"custom icons (not on CDN, present in client): {len(custom)}")
    if missing:
        recovered = []
        for name in missing:
            on_cdn = status.get(name)
            if on_cdn is None:
                _, on_cdn = probe(name)
                status[name] = on_cdn
            if on_cdn == 200:
                continue
            for arc in present:  # low..high; last wins
                h = storm.open(os.path.join(DATA, arc))
                if not h:
                    continue
                if storm.has(h, f"Interface\\Icons\\{name}.blp"):
                    icon_archive[name] = arc
                storm.close(h)
            if name in icon_archive:
                recovered.append(name)
        if recovered:
            custom = sorted(set(custom) | set(recovered))
            print(f"  recovered {len(recovered)} icon(s) via direct probe (listfile gaps)")

    # 5. extract each custom BLP -> individual lossless WebP (shared custom pool)
    os.makedirs(OUT_ICONS, exist_ok=True)
    open_archives = {}

    def get_archive(arc):
        if arc not in open_archives:
            open_archives[arc] = storm.open(os.path.join(DATA, arc))
        return open_archives[arc]

    written = 0
    for name in custom:
        arc = icon_archive.get(name)
        if not arc:
            continue
        h = get_archive(arc)
        blp = storm.read(h, f"Interface\\Icons\\{name}.blp") if h else None
        if not blp:
            print(f"  ! could not read {name}.blp from {arc}")
            continue
        try:
            img = Image.open(io.BytesIO(blp)).convert("RGBA")
        except Exception as e:
            print(f"  ! decode failed {name}: {e}")
            continue
        img.save(os.path.join(OUT_ICONS, f"{name}.webp"), "WEBP", lossless=True)
        written += 1
    for h in open_archives.values():
        if h:
            storm.close(h)
    print(f"wrote {written} custom spell icons -> {os.path.relpath(OUT_ICONS, ROOT)}")

    # 6. spellIconId -> basename map (CDN + custom). Standard icons resolve from
    # the CDN by basename; custom ones from the atlas. build-db.mjs merges this
    # into spells.icon.
    os.makedirs(os.path.dirname(OUT_MAP), exist_ok=True)
    out = {str(iid): name for iid, name in sorted(used.items())}
    with open(OUT_MAP, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=0, sort_keys=True)
        f.write("\n")
    print(f"wrote {len(out)} spellIcon rows ({len(custom)} custom) "
          f"-> {os.path.relpath(OUT_MAP, ROOT)}")


if __name__ == "__main__":
    main()
