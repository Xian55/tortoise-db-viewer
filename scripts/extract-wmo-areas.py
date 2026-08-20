#!/usr/bin/env python3
"""Extract per-WMO interior area boxes from the client (LOCAL, committed).

WHY
---
extract-area-bounds.py reads the ADT *terrain* chunks (MCNK areaid), which is what
the client uses when you stand on the ground -- but NOT what it shows you inside a
building or a cave. There the client overrides the area from the WMO you are in
(WMOAreaTable, keyed by the root WMO's id + the placement's name set), and that
override frequently names a DIFFERENT area than the terrain above it.

The case that found this: Highlord Mastrogonde (NPC 8282) sits in the Firewatch
Ridge cave. Turtle painted the terrain above that cave as Sherwood Quarry
(Northwind), so every spawn in the northern half of the cave was filed under
Northwind while the southern half stayed in Searing Gorge -- one cave, two zones,
and the half the game itself calls "Firewatch Ridge" labelled as a different
continent zone entirely. The cave is
WORLD\\WMO\\DUNGEON\\MD_MOUNTAINCAVE\\MD_MUSHROOMCAVE03, placed with nameSet 1, and
WMOAreaTable says nameSet 1 = Firewatch Ridge -- the same model with nameSet 2/3/4
is Raptor Ridge / Crystalvein Mine / Emberstrife's Den, which is exactly why the
terrain under a generic cave model can never name its interior.

OUTPUT (committed)
  scripts/data/wmo-areas.json
      { "<mapId>": [{i:areaId, x0,x1,y0,y1,z0,z1, g:[[x0,x1,y0,y1,z0,z1], ...]}, ...] }

Two levels, because one level is not enough either way. The outer box is the
placement's own world AABB (the MODF bounds) -- a cheap reject, and far too coarse
to decide with: Stormwind's AABB is 1488x1488 yards and swallows the Valley of
Heroes, Orgrimmar's swallows Rocktusk Farm, and both of those the terrain already
names correctly. `g` holds the model's per-GROUP boxes (MOGI, transformed by the
placement), which hug the actual rooms and tunnels; a point counts as inside only
when a GROUP contains it. Boxes are 3D: the z range is what keeps a spawn standing
on the mountain ABOVE a cave out of the cave's box. build-db prefers the smallest
containing group box over the terrain box; see homeZone().

Only placements whose ROOT WMOAreaTable row (WMOGroupID = -1) carries a non-zero
AreaTableID are emitted. A zero there means "keep the terrain area", which is what
most buildings do. Per-GROUP overrides are deliberately NOT followed: the group's
own bounds live in the group files, and applying a group's area to the whole
model's AABB would drag a whole city block into one inn.

REQUIREMENTS  StormLib.dll (x64) ; the game client.
ENV           TW_CLIENT (default F:/Game/Turtle WoW) ; STORMLIB
              CLIENT_PROFILE=tbc + WMO_AREAS_OUT for the TBC 2.4.3 client
Run:          python scripts/extract-wmo-areas.py
"""
import ctypes as C
import json
import math
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
OUT = os.environ.get("WMO_AREAS_OUT") or os.path.join(ROOT, "scripts", "data", "wmo-areas.json")
if not os.path.isabs(OUT):
    OUT = os.path.join(ROOT, OUT)
sys.path.insert(0, os.path.join(ROOT, "scripts", "lib"))
from clientprofile import archives, dbc_fields  # noqa: E402

F = dbc_fields()

# The WMO models live in their own archives (wmo.MPQ / base.MPQ on Turtle), which none
# of the other extractors open -- reading only the DBC/terrain set finds no root WMO at
# all and the run emits nothing while looking perfectly healthy.
ARCHIVE_ORDER = archives([
    "base.MPQ", "misc.MPQ", "model.MPQ", "terrain.MPQ", "texture.MPQ", "wmo.MPQ",
    "dbc.MPQ", "interface.MPQ", "patch.MPQ", "patch-2.MPQ",
    "patch-3.mpq", "patch-4.mpq", "patch-5.mpq", "patch-6.mpq",
    "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
])
MAPMID = 32 * 533.3333333  # world origin offset: world = MAPMID - stored


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
        if not self.handles:
            sys.exit(f"no MPQ archives opened under {DATA}")

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


def iff(data):
    """Yield (tag, payloadOffset, size) for a flat IFF chunk stream."""
    i, n = 0, len(data)
    while i + 8 <= n:
        tag = data[i:i + 4][::-1]
        sz = struct.unpack_from("<I", data, i + 4)[0]
        yield tag, i + 8, sz
        i += 8 + sz


def dbc_rows(data):
    rec, fields, recsize = struct.unpack_from("<III", data, 4)
    base = 20
    return [struct.unpack_from("<%di" % fields, data, base + r * recsize) for r in range(rec)], fields


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
        out[struct.unpack_from("<i", data, o)[0]] = s(struct.unpack_from("<I", data, o + 4)[0])
    return out


def wmo_root(storm, path, cache):
    """Root WMO path -> (wmoID, [(localMin, localMax) per group]). (None, []) if unreadable.

    wmoID is MOHD's own id, the thing WMOAreaTable keys on. The group boxes come from
    MOGI in the same root file, so no group file has to be opened.
    """
    key = path.upper()
    if key in cache:
        return cache[key]
    d = storm.read(path)
    wid, groups = None, []
    if d:
        for tag, off, sz in iff(d):
            if tag == b"MOHD" and sz >= 36:
                wid = struct.unpack_from("<I", d, off + 32)[0]
            elif tag == b"MOGI":
                for k in range(sz // 32):
                    o = off + k * 32
                    groups.append((struct.unpack_from("<3f", d, o + 4),
                                   struct.unpack_from("<3f", d, o + 16)))
    cache[key] = (wid, groups)
    return wid, groups


def place_box(lo, hi, pos, ry):
    """A WMO-local AABB -> its world AABB under a MODF placement.

    Derived from the client, not from memory: for an unrotated placement the MODF
    extents come out at pos + (min.y, min.z, min.x) .. pos + (max.y, max.z, max.x),
    i.e. the model's local (X, Y, Z) maps to ADT (y, z, x) -- local Z is up, matching
    ADT's Y. Rotation is a turn about the local up axis by the MODF's second angle:
    checked against exterior_piece03 (rot.y -45), which reproduces its stored extents
    to 0.1 yd. The other two angles are model tilt on a handful of placements; they
    are ignored here and the caller clips to the stored extents, which bounds the
    error to something smaller than the box itself.
    """
    a = math.radians(ry)
    ca, sa = math.cos(a), math.sin(a)
    xs, ys, zs = [], [], []
    for lx in (lo[0], hi[0]):
        for ly in (lo[1], hi[1]):
            for lz in (lo[2], hi[2]):
                rx_ = ca * lx - sa * ly
                ry_ = sa * lx + ca * ly
                # local -> ADT, then ADT -> world (worldX = MAPMID - adtZ, etc.)
                xs.append(MAPMID - (pos[2] + rx_))
                ys.append(MAPMID - (pos[0] + ry_))
                zs.append(pos[1] + lz)
    return [min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)]


def adt_placements(adt):
    """Yield (wmoPath, uniqueId, nameSet, worldAABB) for every MODF entry in an ADT."""
    mwmo = mwid = modf = None
    for tag, off, sz in iff(adt):
        if tag == b"MWMO":
            mwmo = (off, sz)
        elif tag == b"MWID":
            mwid = (off, sz)
        elif tag == b"MODF":
            modf = (off, sz)
    if not (mwmo and mwid and modf):
        return
    names = []
    for k in range(mwid[1] // 4):
        o = struct.unpack_from("<I", adt, mwid[0] + k * 4)[0]
        e = adt.index(b"\0", mwmo[0] + o)
        names.append(adt[mwmo[0] + o:e].decode("latin1"))
    for k in range(modf[1] // 64):
        o = modf[0] + k * 64
        nameId, uniq = struct.unpack_from("<II", adt, o)
        pos = struct.unpack_from("<3f", adt, o + 8)
        ry = struct.unpack_from("<3f", adt, o + 20)[1]
        lx, ly, lz = struct.unpack_from("<3f", adt, o + 32)
        ux, uy, uz = struct.unpack_from("<3f", adt, o + 44)
        nameSet = struct.unpack_from("<H", adt, o + 60)[0]
        if nameId >= len(names):
            continue
        # ADT space -> world: worldX = MAPMID - z, worldY = MAPMID - x, worldZ = y.
        box = [MAPMID - uz, MAPMID - lz, MAPMID - ux, MAPMID - lx, ly, uy]
        yield names[nameId], uniq, nameSet, box, pos, ry


def main():
    if not os.path.isdir(DATA):
        sys.exit(f"client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    storm = Storm(STORMLIB)

    wat, nf = dbc_rows(storm.read("DBFilesClient\\WMOAreaTable.dbc"))
    if nf < F["wmo_area"] + 1:
        sys.exit(f"WMOAreaTable.dbc has {nf} fields -- clientprofile offsets are stale")
    # (rootId, nameSet) -> AreaTableID, from the ROOT row only (WMOGroupID = -1).
    root_area = {}
    group_only = set()
    for r in wat:
        key = (r[F["wmo_root"]], r[F["wmo_nameset"]])
        if r[F["wmo_group"]] == -1:
            if r[F["wmo_area"]]:
                root_area[key] = r[F["wmo_area"]]
        elif r[F["wmo_area"]]:
            group_only.add(key)
    group_only -= set(root_area)
    print(f"WMOAreaTable: {len(wat)} rows -> {len(root_area)} (wmo,nameSet) interiors with a "
          f"root area override ({len(group_only)} more override per-group only, skipped)")

    dirs = map_dirs(storm)
    idcache = {}
    out = {}
    for mid, mdir in sorted(dirs.items()):
        if not mdir:
            continue
        seen = {}   # uniqueId -> (areaId, box, groups); a WMO spanning tiles repeats per tile
        tiles = 0
        for col in range(64):
            for row in range(64):
                adt = storm.read(f"World\\Maps\\{mdir}\\{mdir}_{col}_{row}.adt")
                if not adt:
                    continue
                tiles += 1
                for path, uniq, nameSet, box, pos, ry in adt_placements(adt):
                    if uniq in seen:
                        continue
                    rid, groups = wmo_root(storm, path, idcache)
                    if rid is None:
                        continue
                    area = root_area.get((rid, nameSet))
                    if not area:
                        continue
                    # Clip each group to the placement's own stored extents: it costs
                    # nothing and caps the error from the tilt angles place_box drops.
                    g = []
                    for lo, hi in groups:
                        b = place_box(lo, hi, pos, ry)
                        b[0] = max(b[0], box[0]); b[1] = min(b[1], box[1])
                        b[2] = max(b[2], box[2]); b[3] = min(b[3], box[3])
                        b[4] = max(b[4], box[4]); b[5] = min(b[5], box[5])
                        if b[0] < b[1] and b[2] < b[3] and b[4] < b[5]:
                            g.append([round(v, 1) for v in b])
                    if g:
                        seen[uniq] = (area, box, g)
        if not tiles:
            continue
        rows = [
            {"i": area, "x0": round(b[0], 1), "x1": round(b[1], 1), "y0": round(b[2], 1),
             "y1": round(b[3], 1), "z0": round(b[4], 1), "z1": round(b[5], 1), "g": g}
            for area, b, g in seen.values()
        ]
        rows.sort(key=lambda r: (r["i"], r["x0"], r["y0"]))
        if rows:
            out[str(mid)] = rows
        ng = sum(len(r["g"]) for r in rows)
        print(f"  map {mid} ({mdir}): {tiles} tiles, {len(rows)} interiors / {ng} group boxes")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {os.path.relpath(OUT, ROOT)} "
          f"({sum(len(v) for v in out.values())} interiors, "
          f"{sum(len(r['g']) for v in out.values() for r in v)} group boxes, across {len(out)} maps)")


if __name__ == "__main__":
    main()
