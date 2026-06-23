#!/usr/bin/env python3
"""Extract item-set names + set-bonus spells from the client ItemSet.dbc (LOCAL).

The server SQL dump gives item_template.set_id per item, but the set NAME and the
set-bonus spells (the "(N) Set:" tooltips) live only in the client ItemSet.dbc.
CI has no client, so the output is committed source (same exception as the zone
maps / icons -- see CLAUDE.md). Members are derived in build-db from set_id.

ItemSet.dbc (1.12, 45 fields): [0] id, [1-8] name (loc; [1]=enUS), [9] nameFlags,
[10-26] itemId[17], [27-34] setSpellID[8], [35-42] setThreshold[8], [43-44] reqSkill.

OUTPUT (committed)
  scripts/data/item-sets.json  { "<setId>": { "name": str, "bonuses": [[threshold, spell], ...] } }

REQUIREMENTS  StormLib.dll (x64) ; the Turtle WoW client.
ENV           TW_CLIENT (default F:/Game/Turtle WoW) ; STORMLIB
Run:          python scripts/extract-item-sets.py
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
OUT = os.path.join(ROOT, "scripts", "data", "item-sets.json")
ARCHIVE_ORDER = [
    "dbc.MPQ", "patch.MPQ", "patch-2.MPQ", "patch-3.mpq", "patch-4.mpq", "patch-5.mpq",
    "patch-6.mpq", "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
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


def main():
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    storm = Storm(STORMLIB)
    data = storm.read("DBFilesClient\\ItemSet.dbc")
    if not data:
        sys.exit("ItemSet.dbc not found in client")
    magic, rec, fields, recsize, strsize = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit("ItemSet.dbc: bad magic")
    base = 20
    strbase = base + rec * recsize

    def s(off):
        if not off or strbase + off >= len(data):
            return ""
        end = data.index(b"\0", strbase + off)
        return data[strbase + off:end].decode("latin1")

    out = {}
    for r in range(rec):
        o = base + r * recsize
        v = [struct.unpack_from("<I", data, o + 4 * i)[0] for i in range(fields)]
        sid, name = v[0], s(v[1])
        if not sid or not name:
            continue
        bonuses = []
        for k in range(8):
            spell, thr = v[27 + k], v[35 + k]
            if spell and thr:
                bonuses.append([thr, spell])
        bonuses.sort()
        out[str(sid)] = {"name": name, "bonuses": bonuses}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {os.path.relpath(OUT, ROOT)} ({len(out)} item sets, "
          f"{sum(len(v['bonuses']) for v in out.values())} bonuses)")


if __name__ == "__main__":
    main()
