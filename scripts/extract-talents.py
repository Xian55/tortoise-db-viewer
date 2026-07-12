#!/usr/bin/env python3
"""Extract talent trees from the client Talent.dbc + TalentTab.dbc (LOCAL).

Turtle-WoW ships custom talent trees no other site renders correctly. The tree
STRUCTURE (which talent sits at which row/column of which tab, its rank spell ids,
and its prerequisite) lives only in the client DBCs; the server SQL dump has none
of it. This writes that structure to scripts/data/talents.json. Talent NAMES,
ICONS and tooltips are NOT stored here -- the viewer resolves them from the rank
spell ids against the `spells` table it already ships (see src/talents.js).

CI has no client, so the output is committed source, like the other extract-*.py
(zones / skill-lines / locks). Re-run + commit when the client's talents change.
The committed talents.json holds the real all-class Turtle trees (9 classes).

DBC layouts (WDBC, verified against the Turtle 1.12 client)
  TalentTab.dbc (15 fields): [0] id, [1] name(enUS), [12] ClassMask (one class bit),
                  [13] OrderIndex (tab order 0..2 within the class).
  Talent.dbc (21 fields): [0] id, [1] tabId, [2] row, [3] col, [4..12] rankSpell[9]
                  (vanilla uses <=5), [13] requiredTalentId, [16] requiredRank
                  (0-based; stored here as points = value + 1).

OUTPUT (committed)
  scripts/data/talents.json
    { "maxPoints": 51,
      "classes": { "<slug>": { "name": str, "mask": int, "tabs": [
        { "id": int, "name": str, "order": int, "talents": [
          { "id": int, "row": int, "col": int, "ranks": [spellId,...],
            "req": talentId, "reqRank": int } ] } ] } } }

Talent trees are a per-dataset (client-derived) asset -- Turtle's tree is reworked and
its custom talent spell-ids don't exist in a vanilla `spells` table, so the vanilla/cmangos
dataset needs its OWN file (src/talents.js loads talents-<dataset>.json). To produce it,
point TW_CLIENT at a vanilla 1.12 client and TALENTS_OUT at the dataset file:
  TW_CLIENT="/path/to/vanilla-1.12" TALENTS_OUT=scripts/data/talents-vanilla-cmangos.json \
    python scripts/extract-talents.py

ENV  TW_CLIENT (default F:/Game/Turtle WoW) ; TALENTS_OUT (default talents.json) ; STORMLIB
Run: python scripts/extract-talents.py
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
OUT = os.environ.get("TALENTS_OUT") or os.path.join(ROOT, "scripts", "data", "talents.json")
if not os.path.isabs(OUT):
    OUT = os.path.join(ROOT, OUT)
ARCHIVE_ORDER = [
    "dbc.MPQ", "patch.MPQ", "patch-2.MPQ", "patch-3.mpq", "patch-4.mpq", "patch-5.mpq",
    "patch-6.mpq", "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]
# class bit (allowable_class mask) -> viewer slug (matches src/constants.js CLASS_MASK)
CLASS_SLUG = {
    1: "warrior", 2: "paladin", 4: "hunter", 8: "rogue", 16: "priest",
    64: "shaman", 128: "mage", 256: "warlock", 1024: "druid",
}
CLASS_NAME = {
    "warrior": "Warrior", "paladin": "Paladin", "hunter": "Hunter", "rogue": "Rogue",
    "priest": "Priest", "shaman": "Shaman", "mage": "Mage", "warlock": "Warlock", "druid": "Druid",
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


def load_dbc(data):
    """Return (records, string_reader). Each record is a list of uint32 fields."""
    magic, rec, fields, recsize, strsize = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit("bad DBC magic")
    base = 20
    strbase = base + rec * recsize

    def s(off):
        if not off or strbase + off >= len(data):
            return ""
        end = data.index(b"\0", strbase + off)
        return data[strbase + off:end].decode("latin1")

    rows = []
    for r in range(rec):
        o = base + r * recsize
        rows.append([struct.unpack_from("<I", data, o + 4 * i)[0] for i in range(fields)])
    return rows, s


def main():
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    storm = Storm(STORMLIB)
    tab_raw = storm.read("DBFilesClient\\TalentTab.dbc")
    tal_raw = storm.read("DBFilesClient\\Talent.dbc")
    if not tab_raw or not tal_raw:
        sys.exit("Talent.dbc / TalentTab.dbc not found in client")

    tab_rows, tab_str = load_dbc(tab_raw)
    tal_rows, _ = load_dbc(tal_raw)

    # TalentTab (15 fields): id[0], name[1], ClassMask[12], OrderIndex[13] — verified
    # against the client (every tab's [12] is exactly one class bit; [13] gives the
    # correct in-game tab order, e.g. Arms/Fury/Protection = 0/1/2).
    tabs = {}
    for v in tab_rows:
        tid, name = v[0], tab_str(v[1])
        mask = v[12] if len(v) > 12 else 0
        order = v[13] if len(v) > 13 else 0
        if mask in CLASS_SLUG:
            tabs[tid] = {"id": tid, "name": name, "mask": mask, "order": order, "talents": []}

    # Talent (21 fields): id[0] tab[1] row[2] col[3] rankSpell[4:13] (9 slots, vanilla
    # uses <=5) reqTalent[13] reqRank[16]. reqRank is 0-based in the DBC (0 => "1 point"
    # required), so store points = reqRank + 1 to match the viewer's rank counting.
    for v in tal_rows:
        tid, tab, row, col = v[0], v[1], v[2], v[3]
        if tab not in tabs:
            continue
        ranks = [x for x in v[4:13] if x]
        if not ranks:
            continue
        t = {"id": tid, "row": row, "col": col, "ranks": ranks}
        req = v[13] if len(v) > 13 else 0
        if req:
            t["req"] = req
            t["reqRank"] = (v[16] if len(v) > 16 else 0) + 1
        tabs[tab]["talents"].append(t)

    classes = {}
    for tab in tabs.values():
        slug = CLASS_SLUG[tab["mask"]]
        c = classes.setdefault(slug, {"name": CLASS_NAME[slug], "mask": tab["mask"], "tabs": []})
        tab["talents"].sort(key=lambda t: (t["row"], t["col"]))
        c["tabs"].append({"id": tab["id"], "name": tab["name"], "order": tab["order"], "talents": tab["talents"]})
    for c in classes.values():
        c["tabs"].sort(key=lambda t: t["order"])

    out = {"maxPoints": 51, "classes": classes}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    ntal = sum(len(t["talents"]) for c in classes.values() for t in c["tabs"])
    print(f"wrote {os.path.relpath(OUT, ROOT)} ({len(classes)} classes, {ntal} talents)")


if __name__ == "__main__":
    main()
