#!/usr/bin/env python3
r"""Extract random-suffix ("... of the Bear") data from the game client into the repo.

WHY THIS IS A SEPARATE, LOCAL-ONLY STEP
----------------------------------------
GearExport reports a rolled item's random-property id (the item link's suffixId,
e.g. 1199 -> "of the Bear"). The suffix NAME and its stat bonuses live in the
client ``ItemRandomProperties.dbc`` + ``SpellItemEnchantment.dbc`` -- NOT in the
server SQL dump. CI has no client, so the resolved map is committed as *source*
(like extract-icons / extract-spell-icons), and build-db.mjs loads it into the
``random_suffix`` table; src/character.js resolves each equipped slot's suffixId.

OUTPUT (committed source)
  scripts/data/random-suffix.json
    { "<suffixId>": { "suffix": "of the Bear", "stats": { "sta": 9, "str": 9 } }, ... }
    Stat keys match GEAR_STAT_LABEL / item_stats.stat (str/agi/sta/int/spi/…).

REQUIREMENTS / ENV: TW_CLIENT (client dir), STORMLIB (StormLib.dll). No Pillow.

!!! VERIFY DBC OFFSETS AGAINST YOUR CLIENT !!!
The 1.12 field layouts below are best-effort. After running, CHECK the printed
samples (especially id 1199 -> "of the Bear" -> Stamina/Strength). If a field is
off, adjust the *_FIELDS indices near the top and re-run. The record size printed
per DBC helps: fields = recsize / 4.

Run:  python scripts/extract-random-suffix.py
"""
import ctypes as C
import json
import os
import re
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
STORMLIB = os.environ.get(
    "STORMLIB",
    os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"),
)
DATA = os.path.join(CLIENT, "Data")
OUT = os.path.join(ROOT, "scripts", "data", "random-suffix.json")

ARCHIVE_ORDER = [
    "base.MPQ", "dbc.MPQ", "misc.MPQ", "patch.MPQ", "patch-2.MPQ",
    "patch-3.mpq", "patch-4.mpq", "patch-5.mpq", "patch-6.mpq",
    "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]

STREAM_FLAG_READ_ONLY = 0x00000100

# ---- 1.12 Turtle DBC field indices (verified against the client) ----------
# ItemRandomProperties.dbc (16 fields): ID(0), Name_enUS(1), Enchantment[3](2,3,4),
#   then the other-locale name strings + flags.
IRP_ID = 0
IRP_NAME = 1
IRP_ENCHANTS = (2, 3, 4)
# SpellItemEnchantment.dbc (24 fields): ID(0), Effect[3](1,2,3), PointsMin[3](4,5,6),
#   PointsMax[3](7,8,9), Arg[3](10,11,12), Name_enUS(13), other locales…
SIE_ID = 0
SIE_EFFECT = (1, 2, 3)
SIE_MIN = (4, 5, 6)
SIE_ARG = (10, 11, 12)
SIE_NAME = 13
EFFECT_STAT = 5          # ITEM_ENCHANTMENT_TYPE_STAT: arg = ItemMod, amount = min
EFFECT_RESISTANCE = 4    # arg = resistance school

# The suffix stat is usually carried in the enchant NAME ("+7 Stamina", "+8 Strength",
# "+5 Fire Resistance") -- the of-the-X enchants apply it via an equip-spell, so the
# type-5 arg path doesn't fire. Parse the name; fall back to type-5 arg/amount.
STAT_NAME_KEY = {
    "strength": "str", "agility": "agi", "stamina": "sta", "intellect": "int", "spirit": "spi",
    "fire resistance": "firRes", "frost resistance": "froRes", "nature resistance": "natRes",
    "shadow resistance": "shaRes", "arcane resistance": "arcRes",
    "spell damage": "sp", "damage and healing spells": "sp", "healing spells": "heal",
    "attack power": "ap", "defense": "def", "dodge": "dodge", "block": "block",
    "hit rating": "hit", "critical strike": "crit", "mana every 5 sec": "mp5", "mana per 5 sec": "mp5",
}
ITEMMOD_KEY = {3: "agi", 4: "str", 5: "int", 6: "spi", 7: "sta"}
RESIST_KEY = {2: "firRes", 3: "natRes", 4: "froRes", 5: "shaRes", 6: "arcRes"}
NAME_RE = re.compile(r"^\+(\d+)\s+(.+?)\s*$")

def parse_enchant_name(name):
    m = NAME_RE.match(name or "")
    if not m:
        return None
    amt = int(m.group(1))
    key = STAT_NAME_KEY.get(m.group(2).strip().lower())
    return (key, amt) if key else None


class Storm:
    def __init__(self, dll_path):
        if not os.path.exists(dll_path):
            sys.exit(f"StormLib.dll not found: {dll_path}\nSet STORMLIB env var.")
        d = C.WinDLL(dll_path)
        d.SFileOpenArchive.argtypes = [C.c_wchar_p, C.c_uint32, C.c_uint32, C.POINTER(C.c_void_p)]
        d.SFileOpenArchive.restype = C.c_int
        d.SFileCloseArchive.argtypes = [C.c_void_p]
        d.SFileOpenFileEx.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32, C.POINTER(C.c_void_p)]
        d.SFileOpenFileEx.restype = C.c_int
        d.SFileGetFileSize.argtypes = [C.c_void_p, C.POINTER(C.c_uint32)]
        d.SFileGetFileSize.restype = C.c_uint32
        d.SFileReadFile.argtypes = [C.c_void_p, C.c_void_p, C.c_uint32, C.POINTER(C.c_uint32), C.c_void_p]
        d.SFileReadFile.restype = C.c_int
        d.SFileCloseFile.argtypes = [C.c_void_p]
        self.d = d

    def open(self, mpq):
        h = C.c_void_p()
        if not self.d.SFileOpenArchive(mpq, 0, STREAM_FLAG_READ_ONLY, C.byref(h)):
            return None
        return h

    def read(self, h, name):
        hf = C.c_void_p()
        if not self.d.SFileOpenFileEx(h, name.encode("latin1"), 0, C.byref(hf)):
            return None
        sz = self.d.SFileGetFileSize(hf, None)
        buf = (C.c_char * sz)()
        rd = C.c_uint32()
        self.d.SFileReadFile(hf, buf, sz, C.byref(rd), None)
        self.d.SFileCloseFile(hf)
        return bytes(buf[: rd.value])


def read_dbc_from_client(storm, name):
    """Return the newest copy of a DBC across the patch chain (later overrides)."""
    data = None
    for arc in ARCHIVE_ORDER:
        p = os.path.join(DATA, arc)
        if not os.path.exists(p):
            continue
        h = storm.open(p)
        if not h:
            continue
        d = storm.read(h, f"DBFilesClient\\{name}")
        storm.d.SFileCloseArchive(h)
        if d:
            data = d  # keep looking; latest archive wins
    return data


def parse_wdbc(data, label):
    magic, rec, fields, recsize, _strsz = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit(f"{label}: bad magic {magic!r}")
    base = 20
    strbase = base + rec * recsize
    print(f"  {label}: {rec} records, {fields} fields, recsize {recsize}")

    def u(o, idx):
        return struct.unpack_from("<I", data, o + idx * 4)[0]

    def s(o, idx):
        off = u(o, idx)
        if not off or strbase + off >= len(data):
            return ""
        end = data.index(b"\0", strbase + off)
        return data[strbase + off:end].decode("latin1")

    rows = []
    for r in range(rec):
        o = base + r * recsize
        rows.append((o, u, s))
    return rec, recsize, base, u, s


def main():
    storm = Storm(STORMLIB)
    print("Reading client DBCs…")
    irp = read_dbc_from_client(storm, "ItemRandomProperties.dbc")
    sie = read_dbc_from_client(storm, "SpellItemEnchantment.dbc")
    if not irp or not sie:
        sys.exit("Missing ItemRandomProperties.dbc or SpellItemEnchantment.dbc in the client.")

    # SpellItemEnchantment: enchant id -> { stat_key: amount }. Prefer the name
    # ("+7 Stamina"); fall back to a type-5 STAT / type-4 RESISTANCE arg.
    rec, recsize, base, u, s = parse_wdbc(sie, "SpellItemEnchantment.dbc")
    ench_stats = {}
    for r in range(rec):
        o = base + r * recsize
        eid = u(o, SIE_ID)
        stats = {}
        named = parse_enchant_name(s(o, SIE_NAME))
        if named:
            stats[named[0]] = stats.get(named[0], 0) + named[1]
        else:
            for slot in range(3):
                eff, amt, arg = u(o, SIE_EFFECT[slot]), u(o, SIE_MIN[slot]), u(o, SIE_ARG[slot])
                if not eff or not amt:
                    continue
                key = ITEMMOD_KEY.get(arg) if eff == EFFECT_STAT else (RESIST_KEY.get(arg) if eff == EFFECT_RESISTANCE else None)
                if key:
                    stats[key] = stats.get(key, 0) + amt
        if stats:
            ench_stats[eid] = stats

    # ItemRandomProperties: suffix id -> { suffix, stats }
    rec, recsize, base, u, s = parse_wdbc(irp, "ItemRandomProperties.dbc")
    out = {}
    for r in range(rec):
        o = base + r * recsize
        sid = u(o, IRP_ID)
        name = s(o, IRP_NAME)
        stats = {}
        for f in IRP_ENCHANTS:
            eid = u(o, f)
            if eid and eid in ench_stats:
                for k, v in ench_stats[eid].items():
                    stats[k] = stats.get(k, 0) + v
        if stats:
            out[str(sid)] = {"suffix": name, "stats": stats}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0, sort_keys=True)
    print(f"Wrote {len(out)} suffixes -> {OUT}")

    # ---- verification samples ----
    for probe in ("1199",):
        v = out.get(probe)
        print(f"  sample {probe}: {v}")
    print("VERIFY the samples above (1199 should be 'of the Bear' with Stamina/Strength).")
    print("If wrong, adjust the *_FIELDS indices at the top of this script and re-run.")


if __name__ == "__main__":
    main()
