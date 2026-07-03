#!/usr/bin/env python3
"""Extract per-class emblem icons from the client (LOCAL).

The talent calculator's class picker shows the round class emblems. They live in
one client sheet, `Interface\\Glues\\CharacterCreate\\UI-CharacterCreate-Classes.blp`
(a 4x4 grid), addressed by Blizzard's `CLASS_ICON_TCOORDS`. This crops each class
cell -> one webp per class. CI has no client, so the output is committed source,
like the other extract-*.py (see CLAUDE.md).

OUTPUT (committed)  public/icons/class/<slug>.webp   (slug = warrior, mage, …)
ENV  TW_CLIENT (default F:/Game/Turtle WoW) ; STORMLIB
Run: python scripts/extract-class-icons.py
"""
import ctypes as C
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
DATA = os.path.join(CLIENT, "Data")
OUT = os.path.join(ROOT, "public", "icons", "class")
ARCHIVE_ORDER = [
    "dbc.MPQ", "interface.MPQ", "misc.MPQ", "patch.MPQ", "patch-2.MPQ", "patch-3.mpq",
    "patch-4.mpq", "patch-5.mpq", "patch-6.mpq", "patch-7.mpq", "patch-8.mpq", "patch-9.mpq",
    "patch-Y.mpq", "_Patch-W.mpq",
]
SHEET = "Interface\\Glues\\CharacterCreate\\UI-CharacterCreate-Classes.blp"
# Blizzard CLASS_ICON_TCOORDS {left, right, top, bottom} as fractions of the sheet.
TCOORDS = {
    "warrior": (0.00, 0.25, 0.00, 0.25), "mage": (0.25, 0.50, 0.00, 0.25),
    "rogue": (0.50, 0.75, 0.00, 0.25), "druid": (0.75, 1.00, 0.00, 0.25),
    "hunter": (0.00, 0.25, 0.25, 0.50), "shaman": (0.25, 0.50, 0.25, 0.50),
    "priest": (0.50, 0.75, 0.25, 0.50), "warlock": (0.75, 1.00, 0.25, 0.50),
    "paladin": (0.00, 0.25, 0.50, 0.75),
}


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
    os.makedirs(OUT, exist_ok=True)
    for slug, (l, r, t, b) in TCOORDS.items():
        cell = sheet.crop((round(l * w), round(t * h), round(r * w), round(b * h)))
        cell.save(os.path.join(OUT, f"{slug}.webp"), "WEBP", lossless=True)
    print(f"wrote {len(TCOORDS)} class icons -> {os.path.relpath(OUT, ROOT)} (sheet {w}x{h})")


if __name__ == "__main__":
    main()
