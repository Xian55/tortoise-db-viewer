#!/usr/bin/env python3
"""Extract Turtle-WoW *custom* item icons from the game client into the repo.

WHY THIS IS A SEPARATE, LOCAL-ONLY STEP
----------------------------------------
Turtle adds items whose icons do not exist on Blizzard's CDN
(``render-us.worldofwarcraft.com``). Those icons ship only inside the client's
patch MPQs as BLP textures, and the display->icon mapping for them lives in the
client ``ItemDisplayInfo.dbc`` -- NOT in the server SQL dump this repo builds
from. CI has no access to the client, so the extracted icons and the
display->icon supplement are committed to the repo as *source* (see README /
CLAUDE.md). The shippable atlas is built from them by ``build-atlas.py``.

OUTPUTS (committed source)
  assets/icons/custom/<icon>.webp        one lossless WebP per custom icon (RGBA)
  scripts/data/item-display-supplement.json
        { "<display_id>": "<icon>" } -- every item display row the server SQL
        dump is missing or has stale vs the client DBC (covers BOTH the custom
        icons above AND standard CDN icons on Turtle's newer items). Merged into
        item_display_info by build-db.mjs.

REQUIREMENTS
  pip install Pillow            (BLP2 decode + WebP encode)
  StormLib.dll (x64)            MPQ reader, ../StormLib build by default
  The Turtle WoW client         the patch MPQs + DBCs

ENV OVERRIDES
  TW_CLIENT   client root        (default: F:/Game/Turtle WoW)
  STORMLIB    path to StormLib.dll
  SQL_DIR     server sql/base    (default: ../tortoise-wow/sql/base)
  CDN         icon CDN url tmpl  (default: blizzard 56px)

Run:  python scripts/extract-icons.py
"""
import ctypes as C
import io
import json
import os
import re
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
SQL_DIR = os.environ.get("SQL_DIR", os.path.join(ROOT, "..", "tortoise-wow", "sql", "base"))
STORMLIB = os.environ.get(
    "STORMLIB",
    os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"),
)
CDN = os.environ.get("CDN", "https://render-us.worldofwarcraft.com/icons/56/{}.jpg")

DATA = os.path.join(CLIENT, "Data")
OUT_ICONS = os.path.join(ROOT, "assets", "icons", "custom")
OUT_SUPPLEMENT = os.path.join(ROOT, "scripts", "data", "item-display-supplement.json")

# Archive load order, lowest precedence first. A file (BLP or DBC) present in a
# later archive overrides an earlier one -- this is how the client patches data.
ARCHIVE_ORDER = [
    "base.MPQ", "dbc.MPQ", "misc.MPQ", "model.MPQ", "texture.MPQ",
    "interface.MPQ", "fonts.MPQ", "backup.MPQ",
    "patch.MPQ", "patch-2.MPQ",
    "patch-3.mpq", "patch-4.mpq", "patch-5.mpq", "patch-6.mpq",
    "patch-7.mpq", "patch-8.mpq", "patch-9.mpq",
    "patch-Y.mpq", "_Patch-W.mpq",
]

# ---------------------------------------------------------------------------
# StormLib (MPQ) via ctypes
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
# Minimal mysqldump tuple parser (mirrors scripts/lib/sqldump.mjs)
# ---------------------------------------------------------------------------
_ESC = {"n": "\n", "r": "\r", "t": "\t", "0": "\0", "b": "\b", "Z": "\x1a"}


def parse_columns(sql):
    start = sql.index("CREATE TABLE")
    open_p = sql.index("(", start)
    cols, depth, line, i = [], 1, "", open_p + 1
    while i < len(sql):
        c = sql[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                break
        if c == "\n":
            m = re.match(r"\s*`([^`]+)`\s", line)
            if m:
                cols.append(m.group(1))
            line = ""
        else:
            line += c
        i += 1
    return cols


def iter_rows(sql, table):
    needle = "INSERT INTO `" + table + "`"
    pos, n = 0, len(sql)
    while True:
        pos = sql.find(needle, pos)
        if pos < 0:
            return
        i = sql.find("VALUES", pos)
        if i < 0:
            return
        i = sql.find("(", i)
        while i < n:
            c = sql[i]
            if c == "(":
                row, i = _parse_tuple(sql, i)
                yield row
                while i < n and sql[i] not in ",;":
                    i += 1
                if i >= n or sql[i] == ";":
                    pos = i + 1
                    break
                i += 1
            elif c == ";":
                pos = i + 1
                break
            else:
                i += 1


def _parse_tuple(sql, start):
    vals, i, n = [], start + 1, len(sql)
    while i < n:
        c = sql[i]
        if c == ")":
            i += 1
            break
        if c in ", \n\r\t":
            i += 1
            continue
        if c == "'":
            s = []
            i += 1
            while i < n:
                ch = sql[i]
                if ch == "\\":
                    nx = sql[i + 1]
                    s.append(_ESC.get(nx, nx))
                    i += 2
                    continue
                if ch == "'":
                    if sql[i + 1] == "'":
                        s.append("'")
                        i += 2
                        continue
                    i += 1
                    break
                s.append(ch)
                i += 1
            vals.append("".join(s))
        else:
            tok = ""
            while i < n and sql[i] not in ",)":
                tok += sql[i]
                i += 1
            tok = tok.strip()
            vals.append(None if tok == "NULL" else tok)
    return vals, i


# ---------------------------------------------------------------------------
# ItemDisplayInfo.dbc  ->  { id: icon_basename }
# ---------------------------------------------------------------------------
def parse_item_display_dbc(data):
    magic, rec, fields, recsize, _ = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit("ItemDisplayInfo.dbc: bad magic")
    base = 20
    strbase = base + rec * recsize
    icon_field = 5  # InventoryIcon[0] in 1.12 ItemDisplayInfo

    def s(off):
        if not off:
            return ""
        end = data.index(b"\0", strbase + off)
        return data[strbase + off:end].decode("latin1")

    out = {}
    for r in range(rec):
        o = base + r * recsize
        rid = struct.unpack_from("<I", data, o)[0]
        icon = s(struct.unpack_from("<I", data, o + icon_field * 4)[0])
        # icon values are texture names; some carry a .tga/.blp suffix
        icon = re.sub(r"\.(blp|tga)$", "", icon, flags=re.I).lower()
        out[rid] = icon
    return out


def icon_basename(name):
    return re.sub(r"\.(blp|tga)$", "", name, flags=re.I).lower()


# ---------------------------------------------------------------------------
def main():
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    storm = Storm(STORMLIB)

    present = [a for a in ARCHIVE_ORDER if os.path.exists(os.path.join(DATA, a))]
    print(f"client: {CLIENT}  ({len(present)} archives)")

    # 1. items -> distinct display_ids
    item_sql = open(os.path.join(SQL_DIR, "tw_world_item_template.sql"), encoding="latin1").read()
    cols = parse_columns(item_sql)
    di = cols.index("display_id")
    display_ids = {row[di] for row in iter_rows(item_sql, "item_template")}
    display_ids = {int(x) for x in display_ids if x is not None}
    print(f"items: {len(display_ids)} distinct display_ids")

    # 2. id -> icon from the highest-precedence ItemDisplayInfo.dbc
    id_icon = {}
    dbc_src = None
    for arc in present:  # low..high; last wins
        h = storm.open(os.path.join(DATA, arc))
        if not h:
            continue
        if storm.has(h, "DBFilesClient\\ItemDisplayInfo.dbc"):
            data = storm.read(h, "DBFilesClient\\ItemDisplayInfo.dbc")
            if data:
                id_icon = parse_item_display_dbc(data)
                dbc_src = arc
        storm.close(h)
    if not id_icon:
        sys.exit("ItemDisplayInfo.dbc not found in client")
    print(f"ItemDisplayInfo.dbc: {len(id_icon)} rows (from {dbc_src})")

    used_icons = {id_icon[d] for d in display_ids if d in id_icon and id_icon[d]}
    print(f"distinct icons used by items: {len(used_icons)}")

    # 3. which icons exist in the client + where (highest archive wins)
    icon_archive = {}
    for arc in present:  # low..high; last wins
        h = storm.open(os.path.join(DATA, arc))
        if not h:
            continue
        for name in storm.list_icons(h):
            icon_archive[name] = arc
        storm.close(h)

    # 4. CDN probe -> custom = used & NOT on CDN & present in client
    candidates = sorted(i for i in used_icons if i in icon_archive)

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
    missing = sorted(i for i in used_icons if i not in icon_archive and status.get(i, 404) != 200)
    print(f"custom icons (not on CDN, present in client): {len(custom)}")
    if missing:
        print(f"  note: {len(missing)} icons missing from both CDN and client (skipped)")

    # 5. extract each custom BLP and convert -> individual lossless WebP
    os.makedirs(OUT_ICONS, exist_ok=True)
    open_archives = {}

    def get_archive(arc):
        if arc not in open_archives:
            open_archives[arc] = storm.open(os.path.join(DATA, arc))
        return open_archives[arc]

    written = 0
    for name in custom:
        arc = icon_archive[name]
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
    print(f"wrote {written} icons -> {os.path.relpath(OUT_ICONS, ROOT)}")

    # 6. display_id -> icon supplement: correct EVERY item display row that the
    # server SQL dump is missing or has stale vs the client DBC. This covers the
    # custom icons above AND standard CDN icons on Turtle's newer items (whose
    # display rows are simply absent from the server dump). Empty DBC icons are
    # genuinely iconless and skipped.
    disp_sql = open(os.path.join(SQL_DIR, "tw_world_item_display_info.sql"), encoding="latin1").read()
    dcols = parse_columns(disp_sql)
    d_id, d_icon = dcols.index("ID"), dcols.index("icon")
    sqlmap = {}
    for row in iter_rows(disp_sql, "item_display_info"):
        if row[d_id] is not None:
            sqlmap[int(row[d_id])] = (row[d_icon] or "").lower()
    supplement = {}
    for d in sorted(display_ids):
        icon = id_icon.get(d, "")
        if icon and (d not in sqlmap or sqlmap[d] != icon):
            supplement[str(d)] = icon
    os.makedirs(os.path.dirname(OUT_SUPPLEMENT), exist_ok=True)
    with open(OUT_SUPPLEMENT, "w", encoding="utf-8") as f:
        json.dump(supplement, f, indent=0, sort_keys=True)
        f.write("\n")
    n_custom = sum(1 for v in supplement.values() if v in set(custom))
    print(f"wrote {len(supplement)} corrective display rows "
          f"({n_custom} custom, {len(supplement) - n_custom} standard) "
          f"-> {os.path.relpath(OUT_SUPPLEMENT, ROOT)}")


if __name__ == "__main__":
    main()
