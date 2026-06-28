#!/usr/bin/env python3
"""Extract a seamless continent minimap (Leaflet XYZ tile pyramid) from the client.

The client stores minimap art as one BLP per ADT block (map<col>_<row>.blp) under
World\\Minimaps\\<MapDir>\\, but the files are md5-renamed and listed in
textures\\Minimap\\md5translate.trs. This stitches the blocks of a continent into a
standard slippy-map pyramid (z/x/y, 256px webp, y-down NW origin) so the whole
continent pans/zooms as one map -- like the per-zone parchments but seamless.

The ADT grid is regular, so world (x,y) -> pixel is linear and uniform:
    gpx = TILE * (32 - worldY/ADT)      gpy = TILE * (32 - worldX/ADT)
(TILE=256, ADT=1600/3). A native tile map<col>_<row> sits at pyramid (col,row) at
the max zoom; col = 32 - worldY/ADT at its west edge, row = 32 - worldX/ADT at its
north edge. The frontend reprojects every spawn with the same formula -- no
per-zone WorldMapArea bounds needed.

LOCAL ONLY (CI has no client). Output tiles are NOT committed (too many); they are
uploaded to R2 once, and only scripts/data/minimap.json (the small transform
manifest) is committed. See CLAUDE.md "Custom icons" for the same pattern.

REQUIREMENTS  pip install Pillow ; StormLib.dll (x64) ; the Turtle WoW client.
ENV           TW_CLIENT (default F:/Game/Turtle WoW) ; STORMLIB
USAGE         python scripts/extract-minimap.py            # ship maps (0,1)
              python scripts/extract-minimap.py --maps 0   # only Eastern Kingdoms
              python scripts/extract-minimap.py --preview  # also dump a flat PNG/map
"""
import os, sys, io, json, struct, argparse, ctypes as C

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
OUT = os.path.join(ROOT, "public", "minimap")
MANIFEST = os.path.join(ROOT, "scripts", "data", "minimap.json")

# Highest precedence last (a file in a later patch overrides earlier archives).
ARCHIVE_ORDER = [
    "dbc.MPQ", "interface.MPQ", "misc.MPQ", "texture.MPQ", "patch.MPQ", "patch-2.MPQ",
    "patch-3.mpq", "patch-4.mpq", "patch-5.mpq", "patch-6.mpq",
    "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]

TILE = 256              # ADT-block minimap tile size (1.12)
ADT = 1600.0 / 3.0      # 533.3333 yards per ADT block
GRID = 64               # 64x64 ADT blocks per map
MAXZOOM = 6             # 2^6 = 64 native tiles per axis
WEBP_Q = 85

# Continents to ship: Azeroth = Eastern Kingdoms (map 0), Kalimdor (map 1).
# (Outland/Kalidar exist as client art but have no spawns -> empty; excluded.)
SHIP = {
    0: {"dir": "Azeroth", "name": "Eastern Kingdoms"},
    1: {"dir": "Kalimdor", "name": "Kalimdor"},
}


class Storm:
    def __init__(self, dll_path):
        if not os.path.exists(dll_path):
            sys.exit(f"StormLib.dll not found: {dll_path}\nSet STORMLIB env var.")
        d = C.WinDLL(dll_path)
        d.SFileOpenArchive.argtypes = [C.c_wchar_p, C.c_uint32, C.c_uint32, C.POINTER(C.c_void_p)]
        d.SFileOpenArchive.restype = C.c_int
        d.SFileOpenFileEx.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32, C.POINTER(C.c_void_p)]
        d.SFileOpenFileEx.restype = C.c_int
        d.SFileGetFileSize.argtypes = [C.c_void_p, C.POINTER(C.c_uint32)]
        d.SFileGetFileSize.restype = C.c_uint32
        d.SFileReadFile.argtypes = [C.c_void_p, C.c_void_p, C.c_uint32, C.POINTER(C.c_uint32), C.c_void_p]
        d.SFileReadFile.restype = C.c_int
        d.SFileCloseFile.argtypes = [C.c_void_p]
        d.SFileCloseArchive.argtypes = [C.c_void_p]
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
            sys.exit(f"No MPQ archives opened from {DATA}")

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


def parse_trs(storm):
    """md5translate.trs -> {mapDir: {(col,row): md5name}}."""
    raw = storm.read("textures\\Minimap\\md5translate.trs")
    if not raw:
        sys.exit("md5translate.trs not found in client MPQs")
    grid = {}
    cur = None
    for ln in raw.decode("latin1", "replace").splitlines():
        if ln.lower().startswith("dir"):
            cur = ln[4:].strip()
            continue
        if "\t" not in ln:
            continue
        left, md5 = ln.split("\t", 1)
        parts = left.split("\\")
        if len(parts) < 2:
            continue
        d, fn = "\\".join(parts[:-1]), parts[-1]
        if not fn.lower().startswith("map"):
            continue
        try:
            col, row = fn[3:].rsplit(".", 1)[0].split("_")
            col, row = int(col), int(row)
        except ValueError:
            continue
        grid.setdefault(d, {})[(col, row)] = md5.strip()
    return grid


def load_native(storm, tiles):
    """{(col,row): md5} -> {(col,row): PIL.Image (RGB 256)}. Caches by md5 (ocean
    tiles share one md5 across many blocks)."""
    cache, out = {}, {}
    for (col, row), md5 in tiles.items():
        img = cache.get(md5)
        if img is None:
            b = storm.read(f"textures\\Minimap\\{md5}")
            if not b:
                continue
            try:
                img = Image.open(io.BytesIO(b)).convert("RGB")
                if img.size != (TILE, TILE):
                    img = img.resize((TILE, TILE), Image.LANCZOS)
            except Exception as e:
                print(f"  ! decode {md5}: {e}")
                continue
            cache[md5] = img
        out[(col, row)] = img
    return out


def save_tile(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Opaque tiles save smaller as RGB; partial pyramid tiles keep alpha.
    if img.mode == "RGBA" and img.getextrema()[3][0] == 255:
        img = img.convert("RGB")
    img.save(path, "WEBP", quality=WEBP_Q, method=6)


def build_pyramid(native, out_dir):
    """native {(col,row): RGB img} -> z/x/y webp pyramid (XYZ, y-down). Returns the
    occupied bbox [col0,col1,row0,row1] and tile count."""
    cols = [c for c, _ in native]
    rows = [r for _, r in native]
    bbox = [min(cols), max(cols), min(rows), max(rows)]
    n = 0
    # z = MAXZOOM: native tiles 1:1.
    level = {}
    for (col, row), img in native.items():
        save_tile(img, os.path.join(out_dir, str(MAXZOOM), str(col), f"{row}.webp"))
        level[(col, row)] = img
        n += 1
    # reduce: each parent tile composites its <=4 children (2x2) and halves.
    for z in range(MAXZOOM - 1, -1, -1):
        groups = {}
        for (cx, cy), img in level.items():
            groups.setdefault((cx // 2, cy // 2), []).append((cx & 1, cy & 1, img))
        nxt = {}
        for (px, py), kids in groups.items():
            canvas = Image.new("RGBA", (TILE * 2, TILE * 2), (0, 0, 0, 0))
            for (qx, qy, img) in kids:
                canvas.paste(img, (qx * TILE, qy * TILE))
            small = canvas.resize((TILE, TILE), Image.LANCZOS)
            save_tile(small, os.path.join(out_dir, str(z), str(px), f"{py}.webp"))
            nxt[(px, py)] = small
            n += 1
        level = nxt
    return bbox, n


def preview(native, path):
    """Flat PNG of the whole map (downscaled) for a quick alignment eyeball."""
    cols = [c for c, _ in native]; rows = [r for _, r in native]
    c0, c1, r0, r1 = min(cols), max(cols), min(rows), max(rows)
    scale = 4  # 64px per block
    W, H = (c1 - c0 + 1) * scale, (r1 - r0 + 1) * scale
    canvas = Image.new("RGB", (W, H), (10, 12, 18))
    th = native[next(iter(native))].resize((scale, scale), Image.LANCZOS)
    for (col, row), img in native.items():
        canvas.paste(img.resize((scale, scale), Image.LANCZOS), ((col - c0) * scale, (row - r0) * scale))
    canvas.save(path)
    print(f"  preview -> {os.path.relpath(path, ROOT)} ({W}x{H}, blocks {c0}-{c1},{r0}-{r1})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--maps", default="", help="comma map ids (default: 0,1)")
    ap.add_argument("--preview", action="store_true", help="also write a flat preview PNG")
    args = ap.parse_args()
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    want = [int(x) for x in args.maps.split(",") if x.strip()] or list(SHIP)

    storm = Storm(STORMLIB)
    grid = parse_trs(storm)
    # Merge into any existing manifest so per-map runs (--maps 0 then --maps 1)
    # accumulate instead of clobbering each other.
    manifest = {"tile": TILE, "adt": ADT, "grid": GRID, "maxNativeZoom": MAXZOOM, "maps": {}}
    if os.path.exists(MANIFEST):
        try:
            with open(MANIFEST) as f:
                manifest["maps"] = json.load(f).get("maps", {})
        except (ValueError, OSError):
            pass
    for mid in want:
        meta = SHIP.get(mid)
        if not meta:
            print(f"map {mid}: not in SHIP set, skipping"); continue
        tiles = grid.get(meta["dir"])
        if not tiles:
            print(f"map {mid} ({meta['dir']}): no minimap tiles, skipping"); continue
        print(f"map {mid} {meta['name']} ({meta['dir']}): {len(tiles)} blocks")
        native = load_native(storm, tiles)
        if not native:
            print("  ! no decodable tiles"); continue
        out_dir = os.path.join(OUT, str(mid))
        bbox, n = build_pyramid(native, out_dir)
        if args.preview:
            preview(native, os.path.join(OUT, f"preview-{mid}.png"))
        manifest["maps"][str(mid)] = {"name": meta["name"], "dir": meta["dir"], "bbox": bbox}
        print(f"  -> {n} tiles in {os.path.relpath(out_dir, ROOT)}  bbox(col0,col1,row0,row1)={bbox}")
    storm.close()
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    print(f"manifest -> {os.path.relpath(MANIFEST, ROOT)} ({len(manifest['maps'])} maps)")


if __name__ == "__main__":
    main()
