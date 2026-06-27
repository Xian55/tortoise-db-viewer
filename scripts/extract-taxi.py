#!/usr/bin/env python3
"""Extract the flight-path (taxi) network + continent world maps from the client.

WHY LOCAL-ONLY (committed output)
---------------------------------
The flight nodes/routes live in the client TaxiNodes/TaxiPath/TaxiPathNode.dbc and
the continent parchments are BLP tiles in the MPQs -- CI has no client, so the
stitched continent images (public/maps/continent-<mapId>.webp) and the network
(scripts/data/taxi.json) are committed as source, like the zone maps + custom icons
(see CLAUDE.md). build-db ingests taxi.json into taxi_* tables; the world-map view
plots the nodes + routes via the continent bounds (same WorldMapArea math as zones).

OUTPUTS (committed)
  public/maps/continent-<mapId>.webp   Azeroth (0) + Kalimdor (1) stitched parchments
  scripts/data/taxi.json               { continents:[{mapId,dir,w,h,loc*}],
                                         nodes:[{id,map,x,y,name,mount0,mount1}],
                                         paths:[{id,from,to,cost}],
                                         pathnodes:[{path,idx,map,x,y}] }

REQUIREMENTS  pip install Pillow ; StormLib.dll (x64) ; the Turtle WoW client.
ENV           TW_CLIENT (default F:/Game/Turtle WoW) ; STORMLIB
Run:          python scripts/extract-taxi.py
"""
import ctypes as C
import io
import json
import math
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
OUT_TAXI = os.path.join(ROOT, "scripts", "data", "taxi.json")

ARCHIVE_ORDER = [
    "dbc.MPQ", "interface.MPQ", "patch.MPQ", "patch-2.MPQ",
    "patch-3.mpq", "patch-4.mpq", "patch-5.mpq", "patch-6.mpq",
    "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]

TILE = 256
COLS, ROWS = 4, 3
W, H = COLS * TILE, ROWS * TILE   # 1024 x 768 tile grid
CW, CH = 1002, 668                # cropped content (drops the black tile padding)
# Continents we plot flights on (mapId -> WorldMap tile directory).
CONTINENT_DIR = {0: "Azeroth", 1: "Kalimdor"}


class Storm:
    def __init__(self, dll_path):
        if not os.path.exists(dll_path):
            sys.exit(f"StormLib.dll not found: {dll_path}\nSet STORMLIB env var.")
        d = C.WinDLL(dll_path)
        d.SFileOpenArchive.argtypes = [C.c_wchar_p, C.c_uint32, C.c_uint32, C.POINTER(C.c_void_p)]
        d.SFileOpenArchive.restype = C.c_int
        d.SFileCloseArchive.argtypes = [C.c_void_p]
        d.SFileOpenFileEx.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32, C.POINTER(C.c_void_p)]
        d.SFileOpenFileEx.restype = C.c_int
        d.SFileGetFileSize.argtypes = [C.c_void_p, C.POINTER(C.c_uint32)]
        d.SFileGetFileSize.restype = C.c_uint32
        d.SFileReadFile.argtypes = [C.c_void_p, C.c_void_p, C.c_uint32, C.POINTER(C.c_uint32), C.c_void_p]
        d.SFileReadFile.restype = C.c_int
        d.SFileCloseFile.argtypes = [C.c_void_p]
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
        for h in reversed(self.handles):  # highest precedence first
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

    def close(self):
        for h in self.handles:
            self.d.SFileCloseArchive(h)


def dbc(storm, name):
    data = storm.read(f"DBFilesClient\\{name}.dbc")
    if not data:
        sys.exit(f"{name}.dbc not found in client")
    magic, rec, fields, recsize, strsize = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit(f"{name}.dbc: bad magic")
    return data, rec, fields, recsize, 20, 20 + rec * recsize, strsize


def cstr(data, strbase, strsize, off):
    if off <= 0 or off >= strsize:
        return ""
    end = data.index(b"\0", strbase + off)
    return data[strbase + off:end].decode("latin1", "replace")


def main():
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    storm = Storm(STORMLIB)

    # ---- TaxiNodes: id, mapId, x, y, z, name(field5), MountCreatureID[](14,15) ----
    data, rec, fields, recsize, base, strbase, strsize = dbc(storm, "TaxiNodes")
    nodes = []
    for r in range(rec):
        o = base + r * recsize
        i = struct.unpack_from("<" + "i" * fields, data, o)
        x, y, z = struct.unpack_from("<fff", data, o + 8)
        name = cstr(data, strbase, strsize, i[5])
        if not name:
            continue
        nodes.append({"id": i[0], "map": i[1], "x": round(x, 2), "y": round(y, 2),
                      "name": name, "mount0": i[14], "mount1": i[15]})
    print(f"TaxiNodes: {len(nodes)}")

    # ---- TaxiPath: id, from, to, cost ----
    data, rec, fields, recsize, base, _, _ = dbc(storm, "TaxiPath")
    paths = []
    for r in range(rec):
        i = struct.unpack_from("<iiii", data, base + r * recsize)
        paths.append({"id": i[0], "from": i[1], "to": i[2], "cost": i[3]})
    print(f"TaxiPath: {len(paths)}")

    # ---- TaxiPathNode: id, pathId, nodeIndex, mapId, x, y, z ----
    data, rec, fields, recsize, base, _, _ = dbc(storm, "TaxiPathNode")
    pathnodes = []
    for r in range(rec):
        o = base + r * recsize
        i = struct.unpack_from("<iiii", data, o)
        x, y = struct.unpack_from("<ff", data, o + 16)
        pathnodes.append({"path": i[1], "idx": i[2], "map": i[3], "x": round(x, 2), "y": round(y, 2)})
    print(f"TaxiPathNode: {len(pathnodes)}")

    # ---- continent bounds (WorldMapArea areaId==0 rows for maps 0/1) ----
    data, rec, fields, recsize, base, strbase, strsize = dbc(storm, "WorldMapArea")
    bounds = {}
    for r in range(rec):
        o = base + r * recsize
        _id, mapid, areaid = struct.unpack_from("<iii", data, o)
        if areaid == 0 and mapid in CONTINENT_DIR:
            diroff = struct.unpack_from("<I", data, o + 12)[0]
            ll, lr, lt, lb = struct.unpack_from("<ffff", data, o + 16)
            if cstr(data, strbase, strsize, diroff) == CONTINENT_DIR[mapid]:
                bounds[mapid] = {"locleft": ll, "locright": lr, "loctop": lt, "locbottom": lb}

    # ---- stitch the continent parchments ----
    def load_grid(d):
        sub = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        got = 0
        for n in range(1, COLS * ROWS + 1):
            b = storm.read(f"Interface\\WorldMap\\{d}\\{d}{n}.blp")
            if not b:
                continue
            try:
                t = Image.open(io.BytesIO(b)).convert("RGBA")
            except Exception:
                continue
            sub.paste(t, (((n - 1) % COLS) * TILE, ((n - 1) // COLS) * TILE))
            got += 1
        return sub.crop((0, 0, CW, CH)) if got else None

    os.makedirs(OUT_MAPS, exist_ok=True)
    continents = []
    for mapid, d in CONTINENT_DIR.items():
        if mapid not in bounds:
            print(f"  WARN no continent bounds for map {mapid} ({d})")
            continue
        img = load_grid(d)
        if img is None:
            print(f"  WARN no tiles for {d}")
            continue
        img.save(os.path.join(OUT_MAPS, f"continent-{mapid}.webp"), "WEBP", quality=82, method=6)
        continents.append({"mapId": mapid, "dir": d, "w": CW, "h": CH, **bounds[mapid]})
        print(f"  continent-{mapid}.webp ({d})")

    storm.close()
    out = {"continents": continents, "nodes": nodes, "paths": paths, "pathnodes": pathnodes}
    os.makedirs(os.path.dirname(OUT_TAXI), exist_ok=True)
    with open(OUT_TAXI, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=0)
        f.write("\n")
    print(f"wrote {os.path.relpath(OUT_TAXI, ROOT)} "
          f"({len(nodes)} nodes, {len(paths)} paths, {len(pathnodes)} path nodes, {len(continents)} continents)")


if __name__ == "__main__":
    main()
