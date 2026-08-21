#!/usr/bin/env python
"""LOCAL: convert client models into the compact `.m2b` the browser viewer reads.

  client MPQ (M2 v256 + BLP)  ->  public/model3d/**  (R2-only, like maps/sounds)
                                  + manifest.json (what actually exported)

Why not glTF: the semantics this viewer needs have no glTF home. Geoset ids (equipment
toggling), ADDITIVE blend, and above all the texture-unit TYPE -- 0 embedded, 1 character
skin, 2 object skin, 6 hair -- are the whole mechanism by which one model is re-textured
per item/race/skin. In glTF every one of those is an `extras` bag we would parse
ourselves, i.e. a custom format wearing a costume, plus a ~150 KB GLTFLoader. Our
sections are plain typed arrays the loader views in place.

The pose is BAKED (Stand, frame 0) in v1: identical to what render-model-thumbs.py
renders, so the two can be compared pixel-for-pixel, and the browser needs no skinning at
all. Bones and attachments still ship, because animation and hanging an item off a
character's hand both need them later.

Usage:
  python scripts/export-models.py --only Misc_1H_Bone_A_01   # one model, verbose
  python scripts/export-models.py --limit 20                 # smoke-test the run
  python scripts/export-models.py                            # the whole worklist
  python scripts/export-models.py --force                    # re-export existing files

Env: TW_CLIENT, STORMLIB.  Deps: pip install numpy pillow
Run scripts/extract-item-appearance.py first -- its JSON is the worklist.
"""
import os
import sys
import json
import struct
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from m2 import Storm, parse_m2, skin, blp_to_rgba, VANILLA_ARCHIVES  # noqa: E402
from clientprofile import archives  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
DATA = os.path.join(CLIENT, "Data")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
APPEARANCE = os.path.join(ROOT, "scripts", "data", "item-appearance.json")
OUT_DIR = os.path.join(ROOT, "public", "model3d")

MAGIC = b"M2B1"
VERSION = 1
FLAG_POSED = 1

# A section table keeps the loader honest: it reads by offset, so adding a section later
# cannot silently shift the ones a shipped client already knows.
SECTIONS = ["pos", "nrm", "uv", "idx", "sub", "tex", "att", "str"]


def build_m2b(m2):
    """Serialize one parsed model. Returns (bytes, stats)."""
    import numpy as np
    pos, nrm = skin(m2)                       # Stand frame 0, exactly like the thumbs
    verts = np.array(m2["verts"], dtype="f4")
    uv = verts[:, 6:8]
    nvert = len(verts)
    if nvert > 65535:
        raise ValueError(f"{nvert} vertices exceeds the u16 index space")

    # view[0]: `tris` indexes `indices`, which indexes the vertex array. Resolve that
    # indirection once here so the browser uploads the buffer straight to the GPU.
    idx_map = m2["indices"]
    tris = m2["tris"]
    idx = np.array([idx_map[t] for t in tris], dtype="u2")

    # submesh -> its first texture unit (the layer-0 material). Later layers are decals
    # and env-maps we do not render in v1.
    tu_of = {}
    for tu in m2["texunits"]:
        tu_of.setdefault(tu["submesh"], tu)

    strings = []
    stroff = {}

    def sid(name):
        if name not in stroff:
            stroff[name] = sum(len(s) + 1 for s in strings)
            strings.append(name)
        return stroff[name]

    texrows = []
    for t in m2["textures"]:
        texrows.append((t["type"] & 0xFF, t["flags"] & 0xFF, sid(t["name"])))

    subrows = []
    for si, sub in enumerate(m2["subs"]):
        tu = tu_of.get(si)
        mat = m2["materials"][tu["material"]] if tu and tu["material"] < len(m2["materials"]) else {"flags": 0, "blend": 0}
        tslot = 0xFF
        ttype = 0
        if tu is not None:
            combo = tu["texCombo"]
            if combo < len(m2["texlook"]):
                ti = m2["texlook"][combo]
                if ti < len(m2["textures"]):
                    tslot = ti
                    ttype = m2["textures"][ti]["type"] & 0xFF
        subrows.append((sub["part"] & 0xFFFF, ttype, sub["triStart"], sub["triCount"],
                        mat["blend"] & 0xFF, mat["flags"] & 0xFF, tslot & 0xFF))

    attrows = [(a["id"] & 0xFFFF, a["bone"] & 0xFFFF, *a["pos"]) for a in m2["attach"]
               if a["bone"] < len(m2["bones"]) and a["id"] < 64]

    strblob = b"".join(s.encode("latin1") + b"\0" for s in strings)

    body = {
        "pos": pos.astype("f4").tobytes(),
        "nrm": nrm.astype("f4").tobytes(),
        "uv": uv.astype("f4").tobytes(),
        "idx": idx.tobytes(),
        "sub": b"".join(struct.pack("<2H2I3BB", *r, 0) for r in subrows),
        "tex": b"".join(struct.pack("<2BH", *r) for r in texrows),
        "att": b"".join(struct.pack("<2H3f", *r) for r in attrows),
        "str": strblob,
    }

    head_size = 4 + 2 + 2 + 4 + 4 + 2 + 2 + 2 + 2 + 24 + 4 * len(SECTIONS)
    head_size += (-head_size) % 4
    offs, cur, chunks = [], head_size, []
    for name in SECTIONS:
        b = body[name]
        offs.append(cur)
        chunks.append(b)
        cur += len(b)
        pad = (-len(b)) % 4
        if pad:
            chunks.append(b"\0" * pad)
            cur += pad

    lo = pos.min(axis=0) if nvert else np.zeros(3, "f4")
    hi = pos.max(axis=0) if nvert else np.zeros(3, "f4")
    head = bytearray()
    head += MAGIC
    head += struct.pack("<2H", VERSION, FLAG_POSED)
    head += struct.pack("<2I", nvert, len(idx))
    head += struct.pack("<4H", len(subrows), len(texrows), len(attrows), len(m2["bones"]))
    head += struct.pack("<6f", *lo, *hi)
    head += struct.pack("<%dI" % len(SECTIONS), *offs)
    head += b"\0" * ((-len(head)) % 4)
    assert len(head) == head_size, (len(head), head_size)

    stats = dict(verts=nvert, tris=len(idx) // 3, subs=len(subrows),
                 tex=len(texrows), att=len(attrows))
    return bytes(head) + b"".join(chunks), stats


def embedded_path(name):
    """A texture named INSIDE the model (type 0) keeps its client path, lowercased and
    with forward slashes, so `SPELLS\\ZAP1.BLP` -> `spells/zap1.webp`. These are the glow
    and lightning planes an effect weapon is built from; they are shared across many
    models, so they are exported once by path rather than per item."""
    return name.lower().replace("\\", "/").rsplit(".", 1)[0] + ".webp"


def write_webp(img, path, quality=88):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "WEBP", quality=quality, method=6)
    return os.path.getsize(path)


# Item\TextureComponents\<dir>\<base>_<sex>.blp, in the Texture[8] order item_appearance
# stores. `_U` is the unisex file; a piece ships either M+F or U, never a mix.
COMP_DIRS = [
    ("arm_u", "ArmUpperTexture"), ("arm_l", "ArmLowerTexture"), ("hand", "HandTexture"),
    ("torso_u", "TorsoUpperTexture"), ("torso_l", "TorsoLowerTexture"),
    ("leg_u", "LegUpperTexture"), ("leg_l", "LegLowerTexture"), ("foot", "FootTexture"),
]


def export_components(storm, args):
    """The armor textures painted onto the character's body atlas -- the ONLY thing most
    gear has: 5,362 of 10,204 item displays carry no model at all, just these."""
    doc = json.load(open(APPEARANCE, encoding="utf-8"))
    S = doc["s"]
    want = {}                                     # (region, dir) -> {base names}
    for row in doc["d"].values():
        for i, (region, d) in enumerate(COMP_DIRS):
            si = row[9 + i] if len(row) > 9 + i else 0
            if si and S[si]:
                want.setdefault((region, d), set()).add(S[si])
    total = sum(len(v) for v in want.values())
    print(f"component textures: {total} names across {len(want)} regions")
    n = fail = skip = 0
    tbytes = 0
    for (region, d), names in sorted(want.items()):
        for base in sorted(names):
            for suf in ("M", "F", "U"):
                out = os.path.join(OUT_DIR, "comp", region, f"{base}_{suf}".lower() + ".webp")
                if os.path.exists(out) and not args.force:
                    skip += 1
                    continue
                img = blp_to_rgba(storm, f"Item\\TextureComponents\\{d}\\{base}_{suf}.blp")
                if img is None:
                    continue                      # a piece ships M+F or U, not all three
                if not args.dry_run:
                    tbytes += write_webp(img, out)
                n += 1
        # a base that resolved nothing at all is worth knowing about
    print(f"  components: {n} written ({tbytes/1e6:.1f} MB), {skip} already present")
    return n


def export_characters(storm, args):
    """The 22 playable character models (10 races x 2 genders) plus every skin/face/hair
    /underwear texture the client offers for them, and a copy of the appearance JSON the
    viewer fetches at runtime.

    The models are ~3.5 MB each in the client and come out ~40x smaller here: almost all
    of that is animation keyframes, and v1 bakes the Stand pose instead of shipping them."""
    src = os.path.join(ROOT, "scripts", "data", "char-appearance.json")
    if not os.path.exists(src):
        print(f"  (skip characters: {src} not found -- run extract-char-appearance.py)")
        return 0, 0
    doc = json.load(open(src, encoding="utf-8"))
    nm = nt = fail = 0
    mbytes = tbytes = 0
    for race in doc["races"]:
        for sex in ("m", "f"):
            path = race.get(sex)
            if not path:
                continue
            out = os.path.join(OUT_DIR, "char", f"{race['id']}-{sex}.m2b")
            if os.path.exists(out) and not args.force:
                continue
            raw = storm.read(path.rsplit(".", 1)[0] + ".m2") or storm.read(path)
            if not raw:
                print(f"  MISS char {path}"); fail += 1; continue
            try:
                blob, stats = build_m2b(parse_m2(raw))
            except Exception as e:                              # noqa: BLE001
                print(f"  FAIL char {path}: {e}"); fail += 1; continue
            if not args.dry_run:
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with open(out, "wb") as f:
                    f.write(blob)
                mbytes += len(blob)
            nm += 1
            if args.verbose:
                print(f"  char {race['name']} {sex}: {stats}")

    # Textures the character models name internally (eye glow, and Turtle's custom race
    # extras) go to the shared tex/ tree, same as an item's glow planes.
    named = set()
    for race in doc["races"]:
        for sex in ("m", "f"):
            path = race.get(sex)
            if not path:
                continue
            raw = storm.read(path.rsplit(".", 1)[0] + ".m2") or storm.read(path)
            if not raw:
                continue
            try:
                for t in parse_m2(raw)["textures"]:
                    if t["name"]:
                        named.add(t["name"])
            except Exception:                                   # noqa: BLE001
                pass
    for name in sorted(named):
        out = os.path.join(OUT_DIR, "tex", *embedded_path(name).split("/"))
        if os.path.exists(out) and not args.force:
            continue
        img = blp_to_rgba(storm, name.replace("/", "\\"))
        if img is None:
            fail += 1; continue
        if not args.dry_run:
            tbytes += write_webp(img, out)
        nt += 1

    for name in doc["textures"]:
        out = os.path.join(OUT_DIR, "chartex", *embedded_path(name).split("/"))
        if os.path.exists(out) and not args.force:
            continue
        img = blp_to_rgba(storm, name.replace("/", "\\"))
        if img is None:
            fail += 1; continue
        if not args.dry_run:
            tbytes += write_webp(img, out)
        nt += 1

    if not args.dry_run:
        # The viewer fetches this rather than bundling it: at ~1 MB it would be the
        # single largest thing in the main JS chunk, paid by every visitor, to serve one
        # page. It rides the same R2 set as the meshes it describes.
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(os.path.join(OUT_DIR, "char-appearance.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, separators=(",", ":"))
    print(f"  characters: {nm} models ({mbytes/1e6:.1f} MB), {nt} textures "
          f"({tbytes/1e6:.1f} MB), {fail} failed")
    return nm, nt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="export just this model basename")
    ap.add_argument("--sets", default="item,char,comp",
                    help="which sets to export: item (weapons/shields/...), char (playable "
                         "models), comp (armor textures painted onto the character)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true", help="re-export files that already exist")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    sets = {s.strip() for s in args.sets.split(",") if s.strip()}

    if not os.path.exists(APPEARANCE):
        sys.exit(f"{APPEARANCE} not found -- run scripts/extract-item-appearance.py first")
    doc = json.load(open(APPEARANCE, encoding="utf-8"))
    S = doc["s"]
    storm = Storm(STORMLIB, DATA, archives(VANILLA_ARCHIVES))

    # Worklist: every model that exists under its bare name, plus the model textures the
    # displays using it reference. Per-race models (helms, most shoulders) are a later
    # phase -- they need a character to sit on before they mean anything.
    models = {}          # basename -> dir
    textures = {}        # basename -> dir  (model textures live beside their model)
    for did, row in doc["d"].items():
        mi = row[0] if row else 0
        where = doc["m"].get(str(mi)) if mi else None
        tex_ids = [row[2] if len(row) > 2 else 0, row[3] if len(row) > 3 else 0]
        if where and where[1]:
            d = where[0]
            models[S[mi]] = d
            for ti in tex_ids:
                if ti and S[ti]:
                    textures[S[ti]] = d
            continue
        # A display with NO model can still carry a texture, and one kind matters: a
        # CLOAK is the character's own cape geoset textured from the item. Skipping these
        # (because the worklist was keyed on models) left every cloak painted with the
        # body atlas -- the character's own face stretched across their cape.
        for ti in tex_ids:
            name = S[ti] if ti else ""
            if not name or name in textures:
                continue
            for d in ("Cape", "Weapon", "Shield", "Head", "Shoulder", "Quiver", "Ammo", "Pouch"):
                if storm.has(rf"Item\ObjectComponents\{d}\{name}.blp"):
                    textures[name] = d.lower()
                    break
    if args.only:
        models = {k: v for k, v in models.items() if k.lower() == args.only.lower()}
        if not models:
            sys.exit(f"{args.only} is not a bare-name model in {os.path.basename(APPEARANCE)}")
        textures = {}

    names = sorted(models) if "item" in sets or args.only else []
    if not ("item" in sets or args.only):
        textures = {}
    if args.limit:
        names = names[: args.limit]
    print(f"models to export: {len(names)}   model textures: {len(textures)}")

    manifest = {"v": VERSION, "models": [], "textures": []}
    nm = nt = fail = skip = 0
    mbytes = tbytes = 0
    embedded = set()     # client paths named inside the models (effect/glow planes)
    for name in names:
        d = models[name]
        out = os.path.join(OUT_DIR, "item", name.lower() + ".m2b")
        raw = storm.read(f"Item\\ObjectComponents\\{d}\\{name}.m2") or \
            storm.read(f"Item\\ObjectComponents\\{d}\\{name}.mdx")
        if not raw:
            print(f"  MISS {d}/{name}"); fail += 1; continue
        try:
            parsed = parse_m2(raw)
            # Collected even when the .m2b itself is up to date: a model whose glow
            # texture never exported would silently fall back to the blade texture, which
            # is exactly the bug that made Thunderfury render a lit square.
            for t in parsed["textures"]:
                # ANY named texture, not just type 0. A named slot with a non-zero type
                # is still a real file the model expects (character eye-glow is type 8
                # and names its own BLP); skipping those leaves the mesh wearing whatever
                # texture the substitution rule happens to hand it.
                if t["name"]:
                    embedded.add(t["name"])
            if os.path.exists(out) and not args.force:
                manifest["models"].append(name.lower()); skip += 1; continue
            blob, stats = build_m2b(parsed)
        except Exception as e:                                  # noqa: BLE001
            print(f"  FAIL {d}/{name}: {e}"); fail += 1; continue
        if args.only or args.verbose or args.dry_run:
            print(f"  {name}: {stats}")
        if not args.dry_run:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "wb") as f:
                f.write(blob)
            mbytes += len(blob)
        manifest["models"].append(name.lower())
        nm += 1

    for name, d in sorted(textures.items()):
        out = os.path.join(OUT_DIR, "itemtex", name.lower() + ".webp")
        if os.path.exists(out) and not args.force:
            manifest["textures"].append(name.lower()); skip += 1; continue
        img = blp_to_rgba(storm, f"Item\\ObjectComponents\\{d}\\{name}.blp")
        if img is None:
            print(f"  MISS tex {d}/{name}"); fail += 1; continue
        if not args.dry_run:
            tbytes += write_webp(img, out)
        manifest["textures"].append(name.lower())
        nt += 1

    # Textures the models name internally: the glow/lightning/reflect planes an effect
    # weapon is built from. Shared across many models, so exported once by client path.
    ne = 0
    ebytes = 0
    for name in sorted(embedded):
        rel = embedded_path(name)
        out = os.path.join(OUT_DIR, "tex", *rel.split("/"))
        if os.path.exists(out) and not args.force:
            manifest["textures"].append("tex/" + rel); skip += 1; continue
        img = blp_to_rgba(storm, name.replace("/", "\\"))
        if img is None:
            print(f"  MISS embedded {name}"); fail += 1; continue
        if not args.dry_run:
            ebytes += write_webp(img, out)
        manifest["textures"].append("tex/" + rel)
        ne += 1
    if ne or embedded:
        print(f"  embedded textures: {ne} written, {len(embedded)} referenced ({ebytes/1e6:.1f} MB)")

    if "comp" in sets and not args.only:
        export_components(storm, args)

    if "char" in sets and not args.only:
        export_characters(storm, args)

    if not args.dry_run and not args.only:
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({"v": VERSION,
                       "models": sorted(set(manifest["models"])),
                       "textures": sorted(set(manifest["textures"]))}, f, separators=(",", ":"))
    print(f"DONE: {nm} models ({mbytes/1e6:.1f} MB), {nt} textures ({tbytes/1e6:.1f} MB), "
          f"{skip} already present, {fail} failed -> {OUT_DIR}")


if __name__ == "__main__":
    main()
