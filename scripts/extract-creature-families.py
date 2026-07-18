#!/usr/bin/env python3
"""Extract hunter pet families from the client CreatureFamily.dbc (LOCAL).

Each tamable creature carries a `beast_family` id (server SQL), but the family's
NAME, DIET (PetFoodMask) and ability SKILL LINE live only in the client
CreatureFamily.dbc -- absent from the server dump. This writes that per-family
metadata to scripts/data/creature-families.json. The viewer (src/pets.js) joins
it onto the tamable creatures and resolves the family's abilities from the
skill line against the shipped `spells` table; curated stat modifiers / ability
membership live in the hand-authored scripts/data/pet-families.json.

CI has no client, so the output is committed source, like the other extract-*.py
(talents / skill-lines / locks). Re-run + commit when the client adds pet
families (Turtle ships custom ones beyond the standard 17).

DBC layout (WDBC, vanilla 1.12 build 5875 -- 18 fields; VERIFIED at runtime,
the script prints the field count and a few sample rows and aborts on a
mismatch so a client-schema change can't write garbage):
  CreatureFamily.dbc
    [0] ID
    [1] MinScale (float)   [2] MinScaleLevel
    [3] MaxScale (float)   [4] MaxScaleLevel
    [5] SkillLine[0]       [6] SkillLine[1]   (pet ability skill line, e.g. 208 Pet-Wolf)
    [7] PetFoodMask        (diet bitmask)
    [8..16] Name_Lang      (loc = 8 locale offsets + 1 flags; enUS = [8])
    [17] IconFile (string, e.g. Interface\\Icons\\Ability_Hunter_Pet_Wolf)
  (1.12 has NO PetTalentType / CategoryEnumID columns -- Name follows PetFoodMask.)

PetFoodMask bits -> diet label (vanilla):
  0x01 Meat  0x02 Fish  0x04 Cheese  0x08 Bread  0x10 Fungus  0x20 Fruit
  0x40 Raw Meat  0x80 Raw Fish

OUTPUT (committed)
  scripts/data/creature-families.json
    { "<id>": { "name": str, "diet": [str,...], "skillLine": int, "foodMask": int, "icon": str } }
  icon = the IconFile basename lowercased (served like spell/item icons).

ENV  TW_CLIENT (default F:/Game/Turtle WoW) ; FAMILIES_OUT ; STORMLIB
Run: python scripts/extract-creature-families.py
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
OUT = os.environ.get("FAMILIES_OUT") or os.path.join(ROOT, "scripts", "data", "creature-families.json")
if not os.path.isabs(OUT):
    OUT = os.path.join(ROOT, OUT)
ARCHIVE_ORDER = [
    "dbc.MPQ", "patch.MPQ", "patch-2.MPQ", "patch-3.mpq", "patch-4.mpq", "patch-5.mpq",
    "patch-6.mpq", "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]

FOOD_BITS = [
    (0x01, "Meat"), (0x02, "Fish"), (0x04, "Cheese"), (0x08, "Bread"),
    (0x10, "Fungus"), (0x20, "Fruit"), (0x40, "Raw Meat"), (0x80, "Raw Fish"),
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
            if sz in (0, 0xFFFFFFFF):
                continue
            buf = (C.c_char * sz)()
            rd = C.c_uint32()
            self.d.SFileReadFile(hf, buf, sz, C.byref(rd), None)
            return bytes(buf[: rd.value])
        return None


def load_dbc(data):
    """Return (records, string_reader, field_count). Each record is a list of uint32 fields."""
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
    return rows, s, fields


def diet(mask):
    return [label for bit, label in FOOD_BITS if mask & bit]


def main():
    if not os.path.isdir(DATA):
        sys.exit(f"Turtle client Data dir not found: {DATA}\nSet TW_CLIENT env var.")
    storm = Storm(STORMLIB)
    raw = storm.read("DBFilesClient\\CreatureFamily.dbc")
    if not raw:
        sys.exit("CreatureFamily.dbc not found in client")
    rows, s, fields = load_dbc(raw)

    # Field-count guard: vanilla 1.12 layout is 18 fields, enUS name at [8], icon last.
    # If the client changed the schema, the fixed offsets would silently read the wrong
    # columns -- abort (or warn) so garbage isn't committed.
    I_SKILL, I_FOOD, I_NAME, I_ICON = 5, 7, 8, fields - 1
    if fields < I_NAME + 1:
        sys.exit(f"CreatureFamily.dbc has {fields} fields, expected >= {I_NAME + 1} -- schema changed, verify offsets")
    if fields != 18:
        print(f"WARNING: CreatureFamily.dbc has {fields} fields (expected 18). "
              f"Verify offsets skill={I_SKILL} food={I_FOOD} name={I_NAME} icon={I_ICON}.", file=sys.stderr)

    print(f"CreatureFamily.dbc: {len(rows)} rows, {fields} fields")
    print("sample rows (id | name | skillLine | foodMask -> diet | icon):")
    for v in rows[:24]:
        icon = os.path.basename(s(v[I_ICON]).replace("\\", "/"))
        print(f"  {v[0]:>3} | {s(v[I_NAME])!r:16} | skill={v[I_SKILL]:>4} | food=0x{v[I_FOOD]:02x} {str(diet(v[I_FOOD])):40} | {icon}")

    out = {}
    for v in rows:
        fid = v[0]
        name = s(v[I_NAME])
        if not name:
            continue
        icon = os.path.basename(s(v[I_ICON]).replace("\\", "/")).lower()
        out[str(fid)] = {
            "name": name,
            "diet": diet(v[I_FOOD]),
            "skillLine": v[I_SKILL],
            "foodMask": v[I_FOOD],
            "icon": icon,
        }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    print(f"wrote {os.path.relpath(OUT, ROOT)} ({len(out)} families)")


if __name__ == "__main__":
    main()
