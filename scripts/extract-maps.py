#!/usr/bin/env python3
"""Extract per-zone WorldMap parchment images + zone bounds from the game client.

WHY LOCAL-ONLY (committed output)
---------------------------------
The zone maps live in the client MPQs as BLP tiles, and the zone world-coordinate
bounds live in the client WorldMapArea.dbc. CI has no client, so the stitched
images (public/maps/<areaId>.webp) and the bounds (scripts/data/zones.json) are
committed as source -- the same exception as the custom icons (see CLAUDE.md).
The `zones`/`spawn_points` DB tables are then built in CI from these + the SQL
dumps (which carry spawn coordinates).

OUTPUTS (committed)
  public/maps/<areaId>.webp      one stitched parchment map per zone (4x3 -> 1024x768)
  scripts/data/zones.json        [{areaId, mapId, dir, locleft, locright,
                                   loctop, locbottom, w, h}]

REQUIREMENTS  pip install Pillow ; StormLib.dll (x64) ; the Turtle WoW client.
ENV           TW_CLIENT (default F:/Game/Turtle WoW) ; STORMLIB
Run:          python scripts/extract-maps.py
"""
import ctypes as C
import io
import json
import os
import struct
import sys

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
DATA = os.path.join(CLIENT, "Data")
OUT_MAPS = os.path.join(ROOT, "public", "maps")
OUT_ZONES = os.path.join(ROOT, "scripts", "data", "zones.json")

# Highest precedence last (a file in a later patch overrides earlier archives).
ARCHIVE_ORDER = [
    "dbc.MPQ", "interface.MPQ", "patch.MPQ", "patch-2.MPQ",
    "patch-3.mpq", "patch-4.mpq", "patch-5.mpq", "patch-6.mpq",
    "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]

TILE = 256        # WorldMap BLP tile size
COLS, ROWS = 4, 3  # 12 tiles, row-major
W, H = COLS * TILE, ROWS * TILE  # 1024 x 768


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
        self.d = d
        # Open each present archive once, low->high precedence.
        self.handles = []
        for arc in ARCHIVE_ORDER:
            p = os.path.join(DATA, arc)
            if not os.path.exists(p):
                continue
            h = C.c_void_p()
            if d.SFileOpenArchive(p, 0, 0x100, C.byref(h)):
                self.handles.append(h)

    def read(self, name):
        # With several archives open at once, SFileOpenFileEx's bool is unreliable
        # for "file present in THIS archive" -- a bogus handle still comes back. Gate
        # on a valid file size instead, scanning highest-precedence archive first.
        b = name.encode("latin1")
        for h in reversed(self.handles):  # highest precedence first
            hf = C.c_void_p()
            if not self.d.SFileOpenFileEx(h, b, 0, C.byref(hf)):
                continue
            sz = self.d.SFileGetFileSize(hf, None)
            if sz == 0xFFFFFFFF or sz == 0:
                self.d.SFileCloseFile(hf)
                continue
            buf = (C.c_char * sz)()
            rd = C.c_uint32()
            self.d.SFileReadFile(hf, buf, sz, C.byref(rd), None)
            self.d.SFileCloseFile(hf)
            return bytes(buf[: rd.value])
        return None

    def close(self):
        for h in self.handles:
            self.d.SFileCloseArchive(h)


def parse_worldmaparea(data):
    magic, rec, fields, recsize, strsize = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit("WorldMapArea.dbc: bad magic")
    base = 20
    strbase = base + rec * recsize

    def s(off):
        if not off:
            return ""
        end = data.index(b"\0", strbase + off)
        return data[strbase + off:end].decode("latin1")

    out = []
    for r in range(rec):
        o = base + r * recsize
        _id, mapid, areaid = struct.unpack_from("<iii", data, o)
        diroff = struct.unpack_from("<I", data, o + 12)[0]
        loc_l, loc_r, loc_t, loc_b = struct.unpack_from("<ffff", data, o + 16)
        out.append({
            "areaId": areaid, "mapId": mapid, "dir": s(diroff),
            "locleft": loc_l, "locright": loc_r, "loctop": loc_t, "locbottom": loc_b,
        })
    return out


def main():
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    storm = Storm(STORMLIB)
    dbc = storm.read("DBFilesClient\\WorldMapArea.dbc")
    if not dbc:
        sys.exit("WorldMapArea.dbc not found in client")
    rows = parse_worldmaparea(dbc)
    print(f"WorldMapArea rows: {len(rows)}")

    os.makedirs(OUT_MAPS, exist_ok=True)
    zones = []
    skipped = 0
    for z in rows:
        d = z["dir"]
        if not d or z["areaId"] <= 0:
            skipped += 1
            continue
        first = storm.read(f"Interface\\WorldMap\\{d}\\{d}1.blp")
        if not first:
            skipped += 1
            continue
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        for i in range(1, COLS * ROWS + 1):
            blp = first if i == 1 else storm.read(f"Interface\\WorldMap\\{d}\\{d}{i}.blp")
            if not blp:
                continue
            try:
                tile = Image.open(io.BytesIO(blp)).convert("RGBA")
            except Exception as e:
                print(f"  ! {d}{i}.blp decode failed: {e}")
                continue
            col, row = (i - 1) % COLS, (i - 1) // COLS
            canvas.paste(tile, (col * TILE, row * TILE))
        canvas.save(os.path.join(OUT_MAPS, f"{z['areaId']}.webp"), "WEBP", quality=82, method=6)
        zones.append({**z, "w": W, "h": H})

    storm.close()
    os.makedirs(os.path.dirname(OUT_ZONES), exist_ok=True)
    with open(OUT_ZONES, "w", encoding="utf-8") as f:
        json.dump(zones, f, indent=0)
        f.write("\n")
    print(f"wrote {len(zones)} zone maps -> {os.path.relpath(OUT_MAPS, ROOT)} "
          f"(skipped {skipped} without a WorldMap image)")
    print(f"wrote bounds -> {os.path.relpath(OUT_ZONES, ROOT)}")


if __name__ == "__main__":
    main()
