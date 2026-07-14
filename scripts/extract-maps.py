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
# Per-dataset outputs (like TALENTS_OUT): point TW_CLIENT at a vanilla client and
# MAPS_OUT/MAPS_ZONES at dataset-scoped paths to build the cMaNGOS zone parchments.
OUT_MAPS = os.environ.get("MAPS_OUT") or os.path.join(ROOT, "public", "maps")
OUT_ZONES = os.environ.get("MAPS_ZONES") or os.path.join(ROOT, "scripts", "data", "zones.json")
if not os.path.isabs(OUT_MAPS):
    OUT_MAPS = os.path.join(ROOT, OUT_MAPS)
if not os.path.isabs(OUT_ZONES):
    OUT_ZONES = os.path.join(ROOT, OUT_ZONES)

# Highest precedence last (a file in a later patch overrides earlier archives).
ARCHIVE_ORDER = [
    "dbc.MPQ", "interface.MPQ", "patch.MPQ", "patch-2.MPQ",
    "patch-3.mpq", "patch-4.mpq", "patch-5.mpq", "patch-6.mpq",
    "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]

TILE = 256        # WorldMap BLP tile size
COLS, ROWS = 4, 3  # 12 tiles, row-major
W, H = COLS * TILE, ROWS * TILE  # 1024 x 768 tile grid
# Actual map content is 1002x668 at the top-left; the rest is black tile padding.
# Crop to it (CW x CH) -> removes the dark right/bottom bands AND makes the image
# exactly the rectangle the WorldMapArea world-bounds map to, so Leaflet markers
# align (fraction-based; size-independent as long as dims match the bounds).
CW, CH = 1002, 668
# The 1002x668 art keeps a decorative burnt-parchment frame at the edges -- this
# is authentic and wowhead's own Classic zone maps show the SAME frame, so we do
# NOT crop it (cropping would also need the bounds recomputed). (l, t, r, b) px.
FRAME = (0, 0, 0, 0)


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
            "wmaId": _id, "areaId": areaid, "mapId": mapid, "dir": s(diroff),
            "locleft": loc_l, "locright": loc_r, "loctop": loc_t, "locbottom": loc_b,
        })
    return out


# WorldMapOverlay.dbc (1.12, 17 fields, recsize 68): field 1 = worldMapAreaId,
# field 8 = textureName(str), 9 = textureWidth, 10 = textureHeight,
# 11 = offsetX, 12 = offsetY (fields 2-5 areaId[4], 6-7 mapPoint, 13-16 hitRect).
def parse_worldmapoverlay(data):
    magic, rec, fields, recsize, strsize = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        return {}
    base = 20
    strbase = base + rec * recsize

    def s(off):
        if not off:
            return ""
        end = data.index(b"\0", strbase + off)
        return data[strbase + off:end].decode("latin1")

    by_area = {}
    for r in range(rec):
        o = base + r * recsize
        wma = struct.unpack_from("<i", data, o + 4)[0]              # field 1
        texoff = struct.unpack_from("<I", data, o + 32)[0]         # field 8 = textureName
        tw, th, ox, oy = struct.unpack_from("<iiii", data, o + 36)  # fields 9-12
        tex = s(texoff)
        if not tex:
            continue
        by_area.setdefault(wma, []).append({"tex": tex, "w": tw, "h": th, "ox": ox, "oy": oy})
    return by_area


def main():
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    storm = Storm(STORMLIB)
    dbc = storm.read("DBFilesClient\\WorldMapArea.dbc")
    if not dbc:
        sys.exit("WorldMapArea.dbc not found in client")
    rows = parse_worldmaparea(dbc)
    print(f"WorldMapArea rows: {len(rows)}")
    ovl_dbc = storm.read("DBFilesClient\\WorldMapOverlay.dbc")
    overlays = parse_worldmapoverlay(ovl_dbc) if ovl_dbc else {}
    print(f"WorldMapOverlay: {sum(len(v) for v in overlays.values())} overlays across {len(overlays)} zones")

    def load_grid(d, name, w, h):
        """Stitch <d>\\<name>1..N.blp (row-major) into a w*h RGBA image, or None."""
        cols = max(1, math.ceil(w / TILE)), max(1, math.ceil(h / TILE))
        cx, cy = cols
        sub = Image.new("RGBA", (cx * TILE, cy * TILE), (0, 0, 0, 0))
        got = 0
        for i in range(1, cx * cy + 1):
            b = storm.read(f"Interface\\WorldMap\\{d}\\{name}{i}.blp")
            if not b:
                continue
            try:
                t = Image.open(io.BytesIO(b)).convert("RGBA")
            except Exception:
                continue
            sub.paste(t, (((i - 1) % cx) * TILE, ((i - 1) // cx) * TILE))
            got += 1
        return sub.crop((0, 0, w, h)) if got else None

    # Several WorldMapAreas share one areaId: an instance interior (mapId = the
    # instance map) AND a continent "entrance" mini-map (mapId 0/1). The output is
    # keyed by areaId (one image + one zones row), so pick one -- prefer the instance
    # interior (e.g. Dire Maul 2557 -> the 'DireMaul' interior on map 429). For a
    # continent tie, last-seen wins. But TWO instance interiors can share one areaId
    # (Lower Karazhan map 532 + Upper Karazhan map 814 both = areaId 3457): keep the
    # last as primary and render the other under a synthetic id (1000000 + mapId) so
    # each dungeon gets its own parchment + zones row (keyed by mapId downstream).
    CONTINENTS = {0, 1}
    SYN = 1000000
    chosen = {}
    extras = []
    for z in rows:
        if not z["dir"] or z["areaId"] <= 0:
            continue
        cur = chosen.get(z["areaId"])
        if cur is None:
            chosen[z["areaId"]] = z
            continue
        z_inst = z["mapId"] not in CONTINENTS
        cur_inst = cur["mapId"] not in CONTINENTS
        if z_inst and cur_inst:
            extras.append(cur)            # instance-vs-instance: demote earlier, keep last
            chosen[z["areaId"]] = z
        elif z_inst and not cur_inst:
            chosen[z["areaId"]] = z        # instance beats continent (drop entrance)
        # else: z is a continent entrance for an already-chosen instance -> ignore

    os.makedirs(OUT_MAPS, exist_ok=True)
    zones = []
    skipped = 0
    n_ovl = 0
    # (WMA, output areaId): primaries keyed by their real areaId; the demoted instance
    # interiors keyed by a synthetic id so they don't clobber the primary.
    to_render = [(z, z["areaId"]) for z in chosen.values()] + [(z, SYN + z["mapId"]) for z in extras]
    for z, oid in to_render:
        d = z["dir"]
        base = load_grid(d, d, W, H)   # unexplored parchment (full 1024x768)
        if base is None:
            skipped += 1
            continue
        canvas = base
        # composite explored-detail overlays on top at their pixel offsets
        for o in overlays.get(z["wmaId"], []):
            sub = load_grid(d, o["tex"], o["w"], o["h"])
            if sub is None:
                continue
            canvas.paste(sub, (o["ox"], o["oy"]), sub)  # paste clips to canvas + uses alpha
            n_ovl += 1
        # crop black padding + decorative frame in one go (content is 0,0..CW,CH)
        fl, ft, fr, fb = FRAME
        canvas = canvas.crop((fl, ft, CW - fr, CH - fb))
        cw, ch = CW - fl - fr, CH - ft - fb
        canvas.save(os.path.join(OUT_MAPS, f"{oid}.webp"), "WEBP", quality=82, method=6)
        # recompute world bounds for the cropped rectangle (locleft/right span y over
        # image width CW; loctop/bottom span x over image height CH)
        dy = z["locleft"] - z["locright"]
        dx = z["loctop"] - z["locbottom"]
        zones.append({
            **z, "areaId": oid, "w": cw, "h": ch,
            "locleft": z["locleft"] - fl / CW * dy,
            "locright": z["locright"] + fr / CW * dy,
            "loctop": z["loctop"] - ft / CH * dx,
            "locbottom": z["locbottom"] + fb / CH * dx,
        })

    storm.close()
    os.makedirs(os.path.dirname(OUT_ZONES), exist_ok=True)
    with open(OUT_ZONES, "w", encoding="utf-8") as f:
        json.dump(zones, f, indent=0)
        f.write("\n")
    print(f"wrote {len(zones)} zone maps ({n_ovl} overlays composited) "
          f"-> {os.path.relpath(OUT_MAPS, ROOT)} (skipped {skipped} without a WorldMap image)")
    print(f"wrote bounds -> {os.path.relpath(OUT_ZONES, ROOT)}")


if __name__ == "__main__":
    main()
