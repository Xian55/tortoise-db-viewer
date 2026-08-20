#!/usr/bin/env python
"""LOCAL: the playable character models and every way they can look.

Feeds the mannequin the dressing room is built on: which model file a race+gender uses,
and the skin / face / hair / facial-hair / underwear options the client offers for it.
All of it is client-only (ChrRaces, CharSections, CharHairGeosets,
CharacterFacialHairStyles, HelmetGeosetVisData), so the output is COMMITTED, like
talents.json -- CI has no client.

  THIS  ->  scripts/data/char-appearance.json  (committed, bundled by Vite)
        ->  export-models.py --only char,chartex  (the meshes + textures, R2)

Usage:
  python scripts/extract-char-appearance.py --probe   # print the layout evidence
  python scripts/extract-char-appearance.py           # write the JSON

Env: TW_CLIENT, STORMLIB.

Field layouts are derived from the client, not recited. Two traps this ran into:
  * CharacterFacialHairStyles has THREE junk fields (3-5) holding 0xCCCCCCCC -- literal
    uninitialised memory shipped in the DBC. The geoset ids are fields 6-8. Reading it
    positionally from a "Race, Sex, Variation, Geoset[3]" description gets garbage.
  * ChrRaces has more than one field that resolves to a valid character model; only 4/5
    are Male/FemaleDisplayID (field 3 resolves too, and points at the WRONG race).
"""
import os
import sys
import json
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from m2 import Storm, load_dbc, VANILLA_ARCHIVES  # noqa: E402
from clientprofile import archives  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
DATA = os.path.join(CLIENT, "Data")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
OUT = os.environ.get("CHAR_APPEARANCE_OUT", os.path.join(ROOT, "scripts", "data", "char-appearance.json"))

# ChrRaces
# 15 is the internal name ("BloodElf"); 17 starts the localized block, whose first
# slot is enUS ("Blood Elf") -- 20/21/22 are deDE/zhCN/ruRU, which is how the block
# was located rather than assumed.
CR_MALE, CR_FEMALE, CR_PREFIX, CR_NAME, CR_INTERNAL = 4, 5, 6, 17, 15
# CharSections: ID, Race, Sex, BaseSection, Variation, Color, Texture[3], Flags
CS_RACE, CS_SEX, CS_SECTION, CS_VAR, CS_COLOR, CS_TEX = 1, 2, 3, 4, 5, 6
# CharHairGeosets: ID, Race, Sex, Variation, GeosetID, ShowScalp
CHG_RACE, CHG_SEX, CHG_VAR, CHG_GEOSET, CHG_SCALP = 1, 2, 3, 4, 5
# CharacterFacialHairStyles: Race, Sex, Variation, <3 junk>, Geoset[3]
CFH_RACE, CFH_SEX, CFH_VAR, CFH_GEOSET = 0, 1, 2, 6

# CharSections.BaseSection
SECTIONS = {0: "skin", 1: "face", 2: "facial", 3: "hair", 4: "underwear"}


def sex_key(v):
    return "m" if v == 0 else "f"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true", help="print the layout evidence, write nothing")
    args = ap.parse_args()

    storm = Storm(STORMLIB, DATA, archives(VANILLA_ARCHIVES))

    def dbc(name):
        raw = storm.read("DBFilesClient\\" + name)
        if not raw:
            sys.exit(f"{name} not found in the client archives")
        return load_dbc(raw)

    cr, crs = dbc("ChrRaces.dbc")
    cdi, _ = dbc("CreatureDisplayInfo.dbc")
    cmd, cmds = dbc("CreatureModelData.dbc")
    cs, css = dbc("CharSections.dbc")
    chg, _ = dbc("CharHairGeosets.dbc")
    cfh, _ = dbc("CharacterFacialHairStyles.dbc")
    hgv, _ = dbc("HelmetGeosetVisData.dbc")

    disp_model = {r[0]: r[1] for r in cdi}
    model_path = {r[0]: cmds(r[2]) for r in cmd}

    def path_of(display_id):
        p = model_path.get(disp_model.get(display_id, -1), "")
        return p if p.lower().startswith("character") else ""

    races = []
    for r in cr:
        male, female = path_of(r[CR_MALE]), path_of(r[CR_FEMALE])
        if not male and not female:
            continue
        races.append({
            "id": r[0], "prefix": crs(r[CR_PREFIX]),
            "name": crs(r[CR_NAME]) or crs(r[CR_INTERNAL]),
            "m": male, "f": female,
        })

    if args.probe:
        print(f"ChrRaces: {len(races)} playable races resolve to a character model")
        for r in races:
            # The model directory must match the race prefix, which is what proves fields
            # 4/5 are the male/female display ids and not some other id that also resolves.
            ok = r["prefix"].lower() in r["m"].lower() or r["prefix"].lower() in r["f"].lower()
            print(f"  {r['id']:2d} {r['prefix']:3s} {r['name']:12s} {'OK ' if ok else '?? '}{r['m']}")
        for name, rows, race_i, sex_i in (("CharSections", cs, CS_RACE, CS_SEX),
                                          ("CharHairGeosets", chg, CHG_RACE, CHG_SEX),
                                          ("CharacterFacialHairStyles", cfh, CFH_RACE, CFH_SEX)):
            ids = {r[race_i] for r in rows}
            sexes = {r[sex_i] for r in rows}
            known = {r["id"] for r in races}
            print(f"  {name}: {len(rows)} rows, races {sorted(ids)} "
                  f"({'all known' if ids <= known else 'UNKNOWN RACE IDS'}), sexes {sorted(sexes)}")
        junk = {r[3] for r in cfh} | {r[4] for r in cfh} | {r[5] for r in cfh}
        print(f"  CharacterFacialHairStyles fields 3-5 hold {sorted(junk)[:4]}… "
              f"(0xCCCCCCCC = {0xCCCCCCCC} -> uninitialised, geosets are 6-8)")
        return

    # skin/face/facial/hair/underwear options, keyed race-sex-section.
    #
    # Every texture is VERIFIED against the archives, because CharSections references art
    # the client does not ship: 100 distinct files are missing, referenced 1,262 times,
    # mostly at high colour indices and mostly on the races Turtle added. Trusting the
    # table means a
    # character whose underwear texture is one of those renders nude, and one whose scalp
    # is missing renders with a bald patch. A row that loses every texture is dropped, so
    # the option disappears from the picker and the viewer falls back to a row that can
    # actually be painted -- an appearance the client cannot draw is not worth offering.
    sections = {}
    textures = set()
    dropped_tex = dropped_rows = 0
    seen = {}

    def exists(path):
        if path not in seen:
            seen[path] = storm.has(path.replace("/", "\\"))
        return seen[path]

    for r in cs:
        sec = SECTIONS.get(r[CS_SECTION])
        if sec is None:
            continue
        tex = []
        referenced = 0
        for i in range(3):
            t = css(r[CS_TEX + i])
            if not t:
                continue
            referenced += 1
            if exists(t):
                tex.append(t)
                textures.add(t)
            else:
                dropped_tex += 1
        # A row with NO texture references is not broken, it is an option that paints
        # nothing -- "bald", "no facial hair". Dropping those (as an earlier version did,
        # by testing `not tex`) deleted hair variation 0 for every race, so choosing bald
        # fell through to whatever hairstyle happened to be first.
        if referenced and not tex:
            dropped_rows += 1
            continue
        key = f"{r[CS_RACE]}-{sex_key(r[CS_SEX])}-{sec}"
        sections.setdefault(key, []).append([r[CS_VAR], r[CS_COLOR], tex])

    hair = {}
    for r in chg:
        hair.setdefault(f"{r[CHG_RACE]}-{sex_key(r[CHG_SEX])}", []).append(
            [r[CHG_VAR], r[CHG_GEOSET], r[CHG_SCALP]])
    facial = {}
    for r in cfh:
        facial.setdefault(f"{r[CFH_RACE]}-{sex_key(r[CFH_SEX])}", []).append(
            [r[CFH_VAR], r[CFH_GEOSET], r[CFH_GEOSET + 1], r[CFH_GEOSET + 2]])

    doc = {
        "v": 1,
        "races": races,
        "sections": sections,
        "hair": hair,
        "facial": facial,
        # Which character geosets a helm hides (hair, facial hair, ears...). Tiny table,
        # inlined whole so the frontend never needs a query for it.
        "helmVis": {str(r[0]): list(r[1:6]) for r in hgv},
        # Every texture the options above reference, so export-models.py has its worklist
        # without re-reading the DBCs.
        "textures": sorted(textures),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"wrote {OUT}  ({os.path.getsize(OUT)/1e6:.2f} MB)")
    print(f"  {len(races)} races x 2 genders, {len(cs)} section rows, "
          f"{len(textures)} distinct textures, {len(chg)} hair + {len(cfh)} facial-hair styles")
    if dropped_tex or dropped_rows:
        print(f"  dropped {dropped_tex} texture references the client does not ship "
              f"({dropped_rows} rows lost every texture and were removed)")


if __name__ == "__main__":
    main()
