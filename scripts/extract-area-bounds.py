#!/usr/bin/env python3
"""Extract per-AreaTable bounding boxes from the client ADTs (LOCAL, committed).

WHY
---
The SQL dumps have no exact coord->area mapping, only the loose WorldMapArea
rectangles used for the world map -- which overlap badly (a small zone's box
clips a neighbour, an oversized custom-zone box blankets several real zones), so
point-in-box mis-assigns spawns (Jory Zaga -> Moonglade instead of Darkshore,
Taerar -> Azshara instead of Ashenvale). The client ADT terrain chunks (MCNK)
each carry the real AreaTable id. Accumulating the world-coord bounds of every
chunk per area id gives TIGHT per-(sub)area boxes; the smallest box containing a
spawn is then its true area, which build-db walks up to the render zone.

CI has no client, so the output is committed source (same exception as the zone
maps / custom icons -- see CLAUDE.md). Re-run only when the client updates.

OUTPUT (committed)
  scripts/data/subzone-bounds.json  { "<mapId>": [{i:areaId, x0,x1,y0,y1}, ...] }
                                     (world coords; z dropped; ints)

REQUIREMENTS  StormLib.dll (x64) ; the Turtle WoW client.
ENV           TW_CLIENT (default F:/Game/Turtle WoW) ; STORMLIB
Run:          python scripts/extract-area-bounds.py
"""
import ctypes as C
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
STORMLIB = os.environ.get(
    "STORMLIB",
    os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"),
)
DATA = os.path.join(CLIENT, "Data")
OUT = os.path.join(ROOT, "scripts", "data", "subzone-bounds.json")
ARCHIVE_ORDER = [
    "dbc.MPQ", "interface.MPQ", "patch.MPQ", "patch-2.MPQ",
    "patch-3.mpq", "patch-4.mpq", "patch-5.mpq", "patch-6.mpq",
    "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]
TILE = 533.3333333  # one ADT tile, yards


class Storm:
    def __init__(self, dll):
        if not os.path.exists(dll):
            sys.exit(f"StormLib.dll not found: {dll}\nSet STORMLIB env var.")
        d = C.WinDLL(dll)
        d.SFileOpenArchive.argtypes = [C.c_wchar_p, C.c_uint32, C.c_uint32, C.POINTER(C.c_void_p)]; d.SFileOpenArchive.restype = C.c_int
        d.SFileOpenFileEx.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32, C.POINTER(C.c_void_p)]; d.SFileOpenFileEx.restype = C.c_int
        d.SFileGetFileSize.argtypes = [C.c_void_p, C.POINTER(C.c_uint32)]; d.SFileGetFileSize.restype = C.c_uint32
        d.SFileReadFile.argtypes = [C.c_void_p, C.c_void_p, C.c_uint32, C.POINTER(C.c_uint32), C.c_void_p]; d.SFileReadFile.restype = C.c_int
        self.d = d
        self.handles = []
        for arc in ARCHIVE_ORDER:
            p = os.path.join(DATA, arc)
            if not os.path.exists(p):
                continue
            h = C.c_void_p()
            if d.SFileOpenArchive(p, 0, 0x100, C.byref(h)):
                self.handles.append(h)

    def read(self, name):
        b = name.encode("latin1")
        for h in reversed(self.handles):
            hf = C.c_void_p()
            if not self.d.SFileOpenFileEx(h, b, 0, C.byref(hf)):
                continue
            sz = self.d.SFileGetFileSize(hf, None)
            if sz == 0xFFFFFFFF or sz == 0:
                continue
            buf = (C.c_char * sz)()
            rd = C.c_uint32()
            self.d.SFileReadFile(hf, buf, sz, C.byref(rd), None)
            return bytes(buf[: rd.value])
        return None


def map_dirs(storm):
    data = storm.read("DBFilesClient\\Map.dbc")
    rec, fields, recsize = struct.unpack_from("<III", data, 4)
    base = 20
    strbase = base + rec * recsize
    def s(off):
        e = data.index(b"\0", strbase + off)
        return data[strbase + off:e].decode("latin1")
    out = {}
    for r in range(rec):
        o = base + r * recsize
        mid = struct.unpack_from("<i", data, o)[0]
        out[mid] = s(struct.unpack_from("<I", data, o + 4)[0])
    return out


def adt_area_chunks(adt):
    """Yield (indexX, indexY, areaid) for each MCNK via the MCIN directory."""
    # find MCIN
    i = 0
    mcin = None
    n = len(adt)
    while i + 8 <= n:
        tag = adt[i:i + 4][::-1]
        sz = struct.unpack_from("<I", adt, i + 4)[0]
        if tag == b"MCIN":
            mcin = i + 8
            break
        i += 8 + sz
    if mcin is None:
        return
    for idx in range(256):
        off = struct.unpack_from("<I", adt, mcin + idx * 16)[0]
        if not off or off + 8 + 0x38 > n:
            continue
        hdr = off + 8  # skip 'MCNK'+size
        ix, iy = struct.unpack_from("<ii", adt, hdr + 4)   # IndexX (col), IndexY (row)
        areaid = struct.unpack_from("<I", adt, hdr + 0x34)[0]
        if areaid:
            yield ix, iy, areaid


def main():
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    storm = Storm(STORMLIB)
    dirs = map_dirs(storm)
    print(f"maps: {len(dirs)}")

    out = {}
    for mid, mdir in sorted(dirs.items()):
        if not mdir:
            continue
        bounds = {}  # areaId -> [x0,x1,y0,y1]
        tiles = 0
        for col in range(64):       # col indexes the world Y (west) axis
            for row in range(64):   # row indexes the world X (north) axis
                adt = storm.read(f"World\\Maps\\{mdir}\\{mdir}_{col}_{row}.adt")
                if not adt:
                    continue
                tiles += 1
                for ix, iy, aid in adt_area_chunks(adt):
                    # chunk world bounds (consistent with resolve: tx=32-y/TILE, ty=32-x/TILE)
                    xMax = (32 - (row + iy / 16)) * TILE
                    xMin = (32 - (row + (iy + 1) / 16)) * TILE
                    yMax = (32 - (col + ix / 16)) * TILE
                    yMin = (32 - (col + (ix + 1) / 16)) * TILE
                    b = bounds.get(aid)
                    if b is None:
                        bounds[aid] = [xMin, xMax, yMin, yMax]
                    else:
                        if xMin < b[0]: b[0] = xMin
                        if xMax > b[1]: b[1] = xMax
                        if yMin < b[2]: b[2] = yMin
                        if yMax > b[3]: b[3] = yMax
        if not bounds:
            continue
        out[str(mid)] = [
            {"i": aid, "x0": round(b[0]), "x1": round(b[1]), "y0": round(b[2]), "y1": round(b[3])}
            for aid, b in sorted(bounds.items())
        ]
        print(f"  map {mid} ({mdir}): {tiles} tiles, {len(bounds)} areas")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {os.path.relpath(OUT, ROOT)} ({sum(len(v) for v in out.values())} area boxes across {len(out)} maps)")


if __name__ == "__main__":
    main()
