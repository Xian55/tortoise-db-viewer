#!/usr/bin/env python3
"""Extract the empty-slot paperdoll icons from the client (LOCAL).

An empty slot in the dressing room showed an empty square; the game shows the silhouette
of what belongs there. Those are UI textures (`Interface\\PaperDoll\\UI-PaperDoll-Slot-*`),
NOT item icons -- Blizzard's icon CDN 403s on them (checked: `inventoryslot_head.jpg`
redirects to render.worldofwarcraft.com and is refused), and the only public copies are
Wowhead's rehosts. So they come out of the client like every other UI sheet we use, and
are committed for the same reason: CI has no client.

OUTPUT (committed)  public/icons/slot/<slot>.webp   (slot = head, shoulder, mainhand, ...)
ENV  TW_CLIENT (default F:/Game/Turtle WoW) ; STORMLIB
Run: python scripts/extract-slot-icons.py
"""
import ctypes as C
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
DATA = os.path.join(CLIENT, "Data")
OUT = os.path.join(ROOT, "public", "icons", "slot")
ARCHIVE_ORDER = [
    "dbc.MPQ", "interface.MPQ", "misc.MPQ", "patch.MPQ", "patch-2.MPQ", "patch-3.mpq",
    "patch-4.mpq", "patch-5.mpq", "patch-6.mpq", "patch-7.mpq", "patch-8.mpq", "patch-9.mpq",
    "patch-Y.mpq", "_Patch-W.mpq",
]
# our slot key -> the client's texture name for it
SLOTS = {
    "head": "Head", "shoulder": "Shoulder", "back": "Chest", "chest": "Chest",
    "shirt": "Shirt", "tabard": "Tabard", "wrist": "Wrists", "hands": "Hands",
    "waist": "Waist", "legs": "Legs", "feet": "Feet",
    "mainhand": "MainHand", "offhand": "SecondaryHand", "ranged": "Ranged",
}
# Two names are not what you would guess and were found by probing the archive: the wrist
# texture is "Wrists" (plural, alone among the slots), and Back has no texture at all in
# 1.12 -- the paperdoll draws the cloak over the chest slot -- so it borrows Chest.
# Anything else missing is reported rather than silently guessed.
TEMPLATE = "Interface\\PaperDoll\\UI-PaperDoll-Slot-%s.blp"


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
    storm = Storm(STORMLIB)
    os.makedirs(OUT, exist_ok=True)
    got, missing = 0, []
    for slot, tex in SLOTS.items():
        blp = storm.read(TEMPLATE % tex)
        if not blp:
            missing.append(f"{slot} ({tex})")
            continue
        im = Image.open(io.BytesIO(blp)).convert("RGBA")
        # The textures are padded to a power of two with transparent margins; crop to what
        # is actually drawn so the icon fills its square in the UI.
        box = im.split()[3].getbbox()
        if box:
            im = im.crop(box)
        im.save(os.path.join(OUT, f"{slot}.webp"), "WEBP", lossless=True)
        got += 1
    print(f"wrote {got} slot icons -> {os.path.relpath(OUT, ROOT)}"
          + (f"; MISSING: {', '.join(missing)}" if missing else ""))


if __name__ == "__main__":
    main()
