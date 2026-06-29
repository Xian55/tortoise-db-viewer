#!/usr/bin/env python3
"""Extract gather-skill per lock from the client Lock.dbc (LOCAL).

Mining veins, herb nodes, and treasure chests are ALL gameobject type 3 (Chest)
and look identical in the server SQL dump (item subclass is even zeroed there, so
loot can't tell ore from herb). The real distinction is the gathering SKILL on the
object's lock: gameobject_template.data0 is the lockId, and Lock.dbc maps that lock
to a LockType (2=Herbalism, 3=Mining) on its skill slot. CI has no client, so the
output is committed source (see CLAUDE.md), like the other extract-*.py DBC dumps.

Lock.dbc (1.12, 33 fields): [0] id, [1..8] Type[8] (2=SKILL), [9..16] Property[8]
(for a SKILL slot = LockType id), [17..24] RequiredSkill[8], [25..32] Action[8].
LockType: 2 Herbalism, 3 Mining (1 Lockpicking / others -> not a gather node).

OUTPUT (committed)
  scripts/data/locks.json   { "<lockId>": "mining" | "herbalism" }

ENV  TW_CLIENT (default F:/Game/Turtle WoW) ; STORMLIB
Run: python scripts/extract-locks.py
"""
import ctypes as C
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
DATA = os.path.join(CLIENT, "Data")
OUT = os.path.join(ROOT, "scripts", "data", "locks.json")
ARCHIVE_ORDER = [
    "dbc.MPQ", "patch.MPQ", "patch-2.MPQ", "patch-3.mpq", "patch-4.mpq", "patch-5.mpq",
    "patch-6.mpq", "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]
# LockType (from LockType.dbc) -> gather skill we care about.
LOCKTYPE = {2: "herbalism", 3: "mining"}
TYPE_SKILL = 2  # Lock.dbc Type[i] == LOCK_KEY_SKILL


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
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    data = Storm(STORMLIB).read("DBFilesClient\\Lock.dbc")
    if not data:
        sys.exit("Lock.dbc not found in client")
    magic, rec, fields, recsize, strsize = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit("Lock.dbc: bad magic")
    if fields < 33:
        sys.exit(f"Lock.dbc: unexpected field count {fields} (want >= 33)")
    base = 20

    out = {}
    for r in range(rec):
        o = base + r * recsize
        v = [struct.unpack_from("<I", data, o + 4 * i)[0] for i in range(fields)]
        lock_id = v[0]
        if not lock_id:
            continue
        for i in range(8):
            if v[1 + i] == TYPE_SKILL:
                kind = LOCKTYPE.get(v[9 + i])
                if kind:
                    out[str(lock_id)] = kind
                    break

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        f.write("\n")
    mining = sum(1 for x in out.values() if x == "mining")
    herb = sum(1 for x in out.values() if x == "herbalism")
    print(f"wrote {os.path.relpath(OUT, ROOT)} ({len(out)} gather locks: {mining} mining, {herb} herbalism)")
    if "38" in out:
        print(f"  sanity: lock 38 (Copper Vein) -> {out['38']}")


if __name__ == "__main__":
    main()
