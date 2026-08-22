#!/usr/bin/env python
"""LOCAL: what an item LOOKS like -- the client-only half of the transmog/3D feature.

The server dump knows an item has `display_id`; only the client's ItemDisplayInfo.dbc
knows that display 19501 is the model `Misc_1H_Bone_A_01` textured `…Black`, or that
display 25865 is not a model at all but two armor textures painted onto the character.
CI has no client, so the output is COMMITTED source, exactly like spell-icon-map.json.

  build-db  ->  THIS  ->  build-db (loads the JSON into the item_appearance table)

Usage:
  python scripts/extract-item-appearance.py --probe   # print the field-layout evidence
  python scripts/extract-item-appearance.py           # write scripts/data/item-appearance.json

Env: TW_CLIENT (F:/Game/Turtle WoW), STORMLIB (StormLib.dll path), TW_DB (built DB).

Run build-db FIRST: display ids move with the world migrations, so the set of displays
worth emitting is read from the built DB, not from sql/base (same rule extract-icons.py
already documents). Without it we would emit all 45,251 DBC rows instead of the ~9.9k
that any item actually uses.
"""
import os
import sys
import json
import struct
import sqlite3
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from m2 import Storm, load_dbc, VANILLA_ARCHIVES  # noqa: E402
from clientprofile import archives, dbc_fields  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
DATA = os.path.join(CLIENT, "Data")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
DB_PATH = os.environ.get("TW_DB", os.path.join(ROOT, "public", "data", "tortoise.sqlite"))
OUT = os.environ.get("ITEM_APPEARANCE_OUT", os.path.join(ROOT, "scripts", "data", "item-appearance.json"))

# Item\ObjectComponents\<dir>\<ModelName>. ItemDisplayInfo stores only the basename, so
# the directory is recovered by probing -- and a name can legitimately exist in none of
# them (a head model exists ONLY as per-race variants; see RACE_CODES).
OBJ_DIRS = ["Weapon", "Shield", "Head", "Shoulder", "Cape", "Quiver", "Ammo", "Pouch"]

# Item\TextureComponents\<region>\<Texture[i]>_<sex>.blp, in Texture[8] order.
REGION_DIRS = [
    "ArmUpperTexture", "ArmLowerTexture", "HandTexture",
    "TorsoUpperTexture", "TorsoLowerTexture",
    "LegUpperTexture", "LegLowerTexture", "FootTexture",
]
REGION_KEYS = ["arm_u", "arm_l", "hand", "torso_u", "torso_l", "leg_u", "leg_l", "foot"]

# Helms and shoulders are modelled PER RACE AND GENDER: `Helm_Mail_D_01` does not exist,
# `Helm_Mail_D_01_HuM` .. `_BeF` do (20 on the Turtle client -- the 8 vanilla races plus
# Turtle's Goblin and High/Blood Elf). Codes are ChrRaces client prefixes + M/F.
RACE_CODES = ["hu", "or", "dw", "ni", "sc", "ta", "gn", "tr", "go", "be"]
SEXES = ["m", "f"]


def used_displays():
    """display_id -> inventory_type for every equippable, non-hidden item. Falls back
    to None (= emit every DBC row) when the built DB is absent."""
    if not os.path.exists(DB_PATH):
        print(f"WARNING: {DB_PATH} not found -- emitting every ItemDisplayInfo row.")
        print("         Run `bun scripts/build-db.mjs` first for the trimmed output.")
        return None
    con = sqlite3.connect("file:" + DB_PATH.replace(os.sep, "/") + "?mode=ro", uri=True)
    out = {}
    for did, inv in con.execute(
            "SELECT display_id, MAX(inventory_type) FROM items "
            "WHERE display_id > 0 AND inventory_type > 0 AND hidden = 0 GROUP BY display_id"):
        out[did] = inv
    con.close()
    return out


def read_display_info(storm):
    data = storm.read("DBFilesClient\\ItemDisplayInfo.dbc")
    if not data:
        sys.exit("ItemDisplayInfo.dbc not found in the client archives")
    magic, rec, fields, recsize, strsize = struct.unpack_from("<4sIIII", data, 0)
    rows, s = load_dbc(data)
    return {r[0]: r for r in rows}, s, fields


def probe(storm, by_id, s, fields, used):
    """Print the evidence the field mapping rests on. Writes nothing.

    Every index below is checked against something external -- a DBC id set, a value
    range, or an actual file in the archives -- because the layout everyone quotes for
    ItemDisplayInfo is WotLK's, which has a second icon field and would shift the whole
    Texture[8] block by one."""
    F = dbc_fields()
    rows = list(by_id.values())
    print(f"ItemDisplayInfo.dbc: {len(rows)} rows, {fields} fields")

    hv, _ = load_dbc(storm.read("DBFilesClient\\HelmetGeosetVisData.dbc"))
    hvids = {r[0] for r in hv}
    igs = storm.read("DBFilesClient\\ItemGroupSounds.dbc")
    igids = {r[0] for r in load_dbc(igs)[0]} if igs else set()

    def vals(i):
        return {r[i] for r in rows if r[i]}
    checks = [
        (F["idi_group_sound"], "GroupSoundIndex", igids, "ItemGroupSounds ids"),
        (F["idi_helm_vis"], "HelmetGeosetVis[0]", hvids, "HelmetGeosetVisData ids"),
        (F["idi_helm_vis"] + 1, "HelmetGeosetVis[1]", hvids, "HelmetGeosetVisData ids"),
    ]
    for idx, label, ref, refname in checks:
        v = vals(idx)
        hit = len(v & ref)
        print(f"  field {idx:2d} {label:20s} {hit}/{len(v)} values are valid {refname}"
              + ("  OK" if v and hit == len(v) else "  <-- MISMATCH"))
    fl = vals(F["idi_flags"])
    print(f"  field {F['idi_flags']:2d} {'Flags':20s} distinct {sorted(fl)}"
          + ("  OK (bits)" if fl and all(x & (x - 1) == 0 for x in fl) else "  <-- not bit-like"))

    # The Texture[8] block: a glove must write arm-lower + hand, a chest torso-upper +
    # torso-lower. Checked over every item, not a sample.
    inv_of = used or {}
    want = {10: {1, 2}, 5: {3, 4}, 7: {5, 6}, 8: {7}}   # invType -> expected region slots
    t0 = F["idi_texture"]
    for inv, expect in sorted(want.items()):
        hits = tot = 0
        for did, iv in inv_of.items():
            if iv != inv or did not in by_id:
                continue
            r = by_id[did]
            wrote = {i for i in range(8) if r[t0 + i]}
            if not wrote:
                continue
            tot += 1
            hits += 1 if wrote & expect else 0
        if tot:
            print(f"  inv {inv:2d}: {hits}/{tot} write a texture in region slots {sorted(expect)}"
                  f" ({', '.join(REGION_KEYS[i] for i in sorted(expect))})")

    # Model names must resolve to real files.
    m0 = F["idi_model"]
    named = {s(r[m0]) for r in rows if s(r[m0])}
    found = plain = suffixed = 0
    for n in list(named)[:400]:
        where = resolve_model(storm, n)
        if where:
            found += 1
            plain += 1 if where[1] else 0
            suffixed += 0 if where[1] else 1
    print(f"  field {m0:2d} ModelName[0]: {found}/400 sampled names resolve"
          f" ({plain} directly, {suffixed} only as per-race variants)")


_model_cache = {}


def resolve_model(storm, name):
    """(dir, plain) for a ModelName, or None. `plain` is False when the basename only
    exists as per-race variants (`<name>_HuM.m2`), which is how every helm ships."""
    if not name:
        return None
    key = name.lower()
    if key in _model_cache:
        return _model_cache[key]
    base = name.rsplit(".", 1)[0]
    hit = None
    for d in OBJ_DIRS:
        for ext in (".m2", ".mdx"):
            if storm.has(f"Item\\ObjectComponents\\{d}\\{base}{ext}"):
                hit = (d.lower(), True)
                break
        if hit:
            break
    if not hit:
        for d in ("Head", "Shoulder"):
            for ext in (".m2", ".mdx"):
                if storm.has(f"Item\\ObjectComponents\\{d}\\{base}_{RACE_CODES[0]}m{ext}"):
                    hit = (d.lower(), False)
                    break
            if hit:
                break
    # Shoulders are a mirrored PAIR stored as L/R prefixes rather than one model.
    if not hit and not base.lower().startswith(("l", "r")):
        for ext in (".m2", ".mdx"):
            if storm.has(f"Item\\ObjectComponents\\Shoulder\\l{base}{ext}"):
                hit = ("shoulder", True)
                break
    _model_cache[key] = hit
    return hit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true", help="print the field-layout evidence, write nothing")
    ap.add_argument("--limit", type=int, default=0, help="stop after N displays (smoke-testing the run)")
    args = ap.parse_args()

    storm = Storm(STORMLIB, DATA, archives(VANILLA_ARCHIVES))
    by_id, s, fields = read_display_info(storm)
    used = used_displays()
    if args.probe:
        probe(storm, by_id, s, fields, used)
        return

    F = dbc_fields()
    m0, t0, g0, hv0 = F["idi_model"], F["idi_model_tex"], F["idi_geoset"], F["idi_helm_vis"]
    c0, vis = F["idi_texture"], F["idi_item_visual"]

    strings = [""]
    index = {"": 0}

    def sid(v):
        v = (v or "").rsplit(".", 1)[0]      # ".mdx" is noise: the file may be either
        if v not in index:
            index[v] = len(strings)
            strings.append(v)
        return index[v]

    ids = sorted(used) if used is not None else sorted(by_id)
    if args.limit:
        ids = ids[: args.limit]
    out = {}
    models = {}
    missing = []
    for did in ids:
        r = by_id.get(did)
        if not r:
            missing.append(did)
            continue
        row = [
            sid(s(r[m0])), sid(s(r[m0 + 1])),          # model L / R
            sid(s(r[t0])), sid(s(r[t0 + 1])),          # model texture L / R
            r[g0], r[g0 + 1], r[g0 + 2],               # geoset groups
            r[hv0], r[hv0 + 1],                        # helmet geoset vis (male/female)
        ] + [sid(s(r[c0 + i])) for i in range(8)] + [  # the 8 component textures
            0 if r[vis] == 0xFFFFFFFF else r[vis],     # ItemVisual (-1 = none)
        ]
        while len(row) > 1 and not row[-1]:            # trailing zeros are implied
            row.pop()
        out[str(did)] = row
        for mi in (row[0], row[1] if len(row) > 1 else 0):
            if mi and mi not in models:
                where = resolve_model(storm, strings[mi])
                if where:
                    models[mi] = [where[0], 1 if where[1] else 0]

    doc = {
        "v": 1,
        "regions": REGION_KEYS,
        "s": strings,
        "m": {str(k): v for k, v in sorted(models.items())},
        "d": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    size = os.path.getsize(OUT)
    withmodel = sum(1 for r in out.values() if r and r[0])
    withtex = sum(1 for r in out.values() if len(r) > 9 and any(r[9:17]))
    print(f"wrote {OUT}  ({size/1e6:.2f} MB)")
    print(f"  displays {len(out)} of {len(ids)} requested"
          + (f" ({len(missing)} absent from the DBC: {missing[:6]})" if missing else ""))
    print(f"  {withmodel} carry a 3D model, {withtex} carry armor textures,"
          f" {len(strings)} distinct strings, {len(models)} models located")


if __name__ == "__main__":
    main()
