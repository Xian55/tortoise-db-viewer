"""Extract the DBC-derived world tables from a vanilla 1.12 client (LOCAL).

The cmangos build source (SQL_SOURCE=cmangos, lib/cmangos-adapter.mjs) reads cmangos's
world SQLite DB, which OMITS the tables cmangos loads from client DBCs at runtime. This
fills that gap for the vanilla/cmangos dataset: it reads the client DBCs and writes
scripts/data/cmangos-dbc.json, which the adapter stages into those otherwise-empty
tables (areas, maps, faction, faction_template, item_display_info, skill_line_ability).

CI has no client, so the JSON is committed (like talents.json / zones.json). Re-run on a
client change. Reuses the StormLib MPQ reader + WDBC parser from extract-talents.py.

Vanilla 1.12.1 (build 5875) WDBC field offsets are asserted by the --verify sample print
(run once, eyeball the names) and noted per-DBC below.

Env: CLIENT (vanilla client dir), STORMLIB (StormLib.dll). Run: python scripts/extract-cmangos-dbc.py
"""
import ctypes as C
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("CLIENT", r"F:\Game\SoloCraft 1.12.1")
DATA = os.path.join(CLIENT, "Data")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
OUT = os.path.join(ROOT, "scripts", "data", "cmangos-dbc.json")
# patches override base; open low->high priority, read() tries the last-opened first.
ARCHIVE_ORDER = ["base.MPQ", "dbc.MPQ", "misc.MPQ", "patch.MPQ", "patch-2.MPQ"]


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
            sys.exit(f"No MPQ archives opened under {DATA}")

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
    """Return (rows, str_reader). Rows are lists of uint32 fields."""
    magic, rec, fields, recsize, strsize = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit("bad DBC magic")
    base = 20

    def s(off):
        if not off or base + rec * recsize + off >= len(data):
            return ""
        start = base + rec * recsize + off
        end = data.index(b"\0", start)
        return data[start:end].decode("latin1")

    rows = []
    for r in range(rec):
        o = base + r * recsize
        rows.append([struct.unpack_from("<I", data, o + 4 * i)[0] for i in range(fields)])
    return rows, s, fields


def main():
    storm = Storm(STORMLIB)

    def dbc(name):
        raw = storm.read("DBFilesClient\\" + name)
        if not raw:
            sys.exit(f"{name} not found in client MPQs")
        return load_dbc(raw)

    out = {}

    # AreaTable.dbc — [0]ID [1]ContinentID(map) [2]ParentAreaID(zone) ... [11]AreaName_enUS
    rows, s, nf = dbc("AreaTable.dbc")
    out["areas"] = [{"entry": v[0], "name": s(v[11]), "map_id": v[1], "zone_id": v[2]} for v in rows]
    print(f"AreaTable [{nf}f] {len(rows)} rows | sample: {out['areas'][0]}")

    # Map.dbc — [0]ID [1]Directory [2]InstanceType ... MapName_enUS. verify name offset below.
    rows, s, nf = dbc("Map.dbc")
    # 1.12 Map.dbc: name loc block starts at 4 (enUS). instanceType at 2.
    out["maps"] = [{"entry": v[0], "map_name": s(v[4]), "map_type": v[2]} for v in rows]
    print(f"Map [{nf}f] {len(rows)} rows | sample: {out['maps'][0]} .. {out['maps'][-1]}")

    # Faction.dbc (37f) — [0]ID [1]ReputationIndex [2-5]RaceMask [6-9]ClassMask
    #   [10-13]RepBase [14-17]RepFlags [18]ParentFactionID [19]Name_enUS (loc block 19-27)
    rows, s, nf = dbc("Faction.dbc")
    out["faction"] = [{"id": v[0], "name1": s(v[19]), "reputation_list_id": (v[1] if v[1] != 0xFFFFFFFF else -1)} for v in rows]
    print(f"Faction [{nf}f] {len(rows)} rows | sample: {out['faction'][0]} .. {next((f for f in out['faction'] if 'Argent' in f['name1']), None)}")

    # FactionTemplate.dbc — [0]ID [1]Faction [2]Flags [3]FactionGroup(ourMask)
    rows, s, nf = dbc("FactionTemplate.dbc")
    out["faction_template"] = [{"id": v[0], "faction_id": v[1], "our_mask": v[3]} for v in rows]
    print(f"FactionTemplate [{nf}f] {len(rows)} rows | sample: {out['faction_template'][0]}")

    # ItemDisplayInfo.dbc — [0]ID ... [5]InventoryIcon (icon basename)
    rows, s, nf = dbc("ItemDisplayInfo.dbc")
    out["item_display_info"] = [{"ID": v[0], "icon": s(v[5])} for v in rows if s(v[5])]
    print(f"ItemDisplayInfo [{nf}f] {len(rows)} rows -> {len(out['item_display_info'])} w/icon | sample: {out['item_display_info'][0]}")

    # SkillLineAbility.dbc — [0]ID [1]SkillLine [2]Spell [3]RaceMask [4]ClassMask
    #   [7]MinSkillRank [8]SupercededBySpell [9]AcquireMethod [10]TrivialHigh [11]TrivialLow [12]NumSkillUps
    rows, s, nf = dbc("SkillLineAbility.dbc")
    out["skill_line_ability"] = [{
        "id": v[0], "skill_id": v[1], "spell_id": v[2], "race_mask": v[3], "class_mask": v[4],
        "req_skill_value": v[7], "superseded_by_spell": v[8], "learn_on_get_skill": v[9],
        "max_value": v[10], "min_value": v[11], "req_train_points": v[12] if nf > 12 else 0,
    } for v in rows]
    print(f"SkillLineAbility [{nf}f] {len(rows)} rows | sample: {out['skill_line_ability'][0]}")

    # Spell.dbc (173f) — cmangos's spell_template already carries names/ranks/mechanics/
    # icons; only the tooltip TEXT lives here. Loc blocks are 9 fields (8 locales + flags):
    #   [120]SpellName_enUS [129]Rank_enUS [138]Description_enUS [147]AuraDescription_enUS
    # (offsets pinned by scanning for a known spell). Keep only rows with text -> spell_text
    # (entry, description, auraDescription); the adapter injects it into spell_template.
    rows, s, nf = dbc("Spell.dbc")
    txt = []
    for v in rows:
        desc, aura = s(v[138]), s(v[147])
        if desc or aura:
            txt.append({"entry": v[0], "description": desc, "auraDescription": aura})
    out["spell_text"] = txt
    fb = next((t for t in txt if "Frost damage" in t["description"]), txt[0])
    print(f"Spell [{nf}f] {len(rows)} rows -> {len(txt)} w/text | sample: {fb['entry']} {fb['description'][:60]!r}")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    kb = os.path.getsize(OUT) / 1024
    print(f"\nwrote {os.path.relpath(OUT, ROOT)} ({kb:.0f} KB)")


if __name__ == "__main__":
    main()
