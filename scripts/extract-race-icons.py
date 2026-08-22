#!/usr/bin/env python3
"""Extract per-race portrait icons from the client (LOCAL).

The dressing room's race picker shows the same portraits the game's own character
creator does. They live in one client sheet,
`Interface\\Glues\\CharacterCreate\\UI-CharacterCreate-Races.blp`, and this crops each
cell -> one webp per race AND gender. CI has no client, so the output is committed
source, like extract-class-icons.py (see CLAUDE.md).

THE GRID IS NOT BLIZZARD'S. Vanilla ships a 4-column sheet addressed by
`RACE_ICON_TCOORDS`; Turtle widened it to FIVE columns to fit the races it added, so
those fractions are wrong here and would slice every portrait in half. The layout below
was read off the art: a 512x256 texture holding 5x4 SQUARE cells of 64px (only 322px of
it is content -- a BLP is power-of-two), rows male-A, male-B, female-A, female-B, with the
fifth column holding Turtle's Goblin and High Elf.

OUTPUT (committed)  public/icons/race/<chrRacesId>-<m|f>.webp
ENV  TW_CLIENT (default F:/Game/Turtle WoW) ; STORMLIB
Run: python scripts/extract-race-icons.py
"""
import ctypes as C
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
DATA = os.path.join(CLIENT, "Data")
OUT = os.path.join(ROOT, "public", "icons", "race")
ARCHIVE_ORDER = [
    "dbc.MPQ", "interface.MPQ", "misc.MPQ", "patch.MPQ", "patch-2.MPQ", "patch-3.mpq",
    "patch-4.mpq", "patch-5.mpq", "patch-6.mpq", "patch-7.mpq", "patch-8.mpq", "patch-9.mpq",
    "patch-Y.mpq", "_Patch-W.mpq",
]
SHEET = "Interface\\Glues\\CharacterCreate\\UI-CharacterCreate-Races.blp"
# ChrRaces id per cell. Row pairs are the two halves of one gender's list.
ROWS = [
    ("m", [1, 3, 7, 4, 9]),      # Human, Dwarf, Gnome, Night Elf, Goblin
    ("m", [6, 5, 8, 2, 10]),     # Tauren, Undead, Troll, Orc, High Elf
    ("f", [1, 3, 7, 4, 9]),
    ("f", [6, 5, 8, 2, 10]),
]


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
            sys.exit(f"no MPQ archives opened from {DATA}")

    def read(self, name):
        b = name.encode("latin1")
        for h in reversed(self.handles):      # last archive wins, as the client loads them
            hf = C.c_void_p()
            if not self.d.SFileOpenFileEx(h, b, 0, C.byref(hf)):
                continue
            sz = self.d.SFileGetFileSize(hf, None)
            if sz in (0, 0xFFFFFFFF):
                continue
            buf = (C.c_char * sz)()
            rd = C.c_uint32()
            self.d.SFileReadFile(hf, buf, sz, C.byref(rd), None)
            return bytes(buf[: rd.value])
        return None


def main():
    try:
        from PIL import Image
    except ImportError:
        sys.exit("Pillow required: pip install Pillow")
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    blp = Storm(STORMLIB).read(SHEET)
    if not blp:
        sys.exit(f"sheet not found in client: {SHEET}")
    sheet = Image.open(io.BytesIO(blp)).convert("RGBA")
    w, h = sheet.size
    # The CELL IS SQUARE AND THE SHEET IS NOT FULL. A BLP is power-of-two, so the 512x256
    # texture carries only 322px of content -- five 64px columns plus a bleed. Dividing the
    # texture width by the column count gives 102px cells that straddle their neighbours,
    # which slices every portrait. Take the cell size from the row height, which is exact.
    cw = ch = h // len(ROWS)
    os.makedirs(OUT, exist_ok=True)
    n = 0
    for r, (sex, ids) in enumerate(ROWS):
        for c, rid in enumerate(ids):
            cell = sheet.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
            cell.save(os.path.join(OUT, f"{rid}-{sex}.webp"), "WEBP", lossless=True)
            n += 1
    print(f"wrote {n} race icons -> {os.path.relpath(OUT, ROOT)} (sheet {w}x{h}, cell {cw}x{ch})")


if __name__ == "__main__":
    main()
