#!/usr/bin/env python3
"""Sample one representative colour per skin / hair-colour option (LOCAL).

The dressing room's skin and hair pickers show colours, not numbers -- "3" tells a
visitor nothing about what they are choosing. Every option is a TEXTURE, so the colour
is already there to be read; this averages each one down to a single hex and writes the
result as a small committed JSON the app bundles.

Deliberately NOT part of char-appearance.json: that file is ~1 MB and lives on R2, which
the viewer fetches at runtime. The palette is a few KB and needs to be in the first paint
of the picker, so it ships in the JS bundle instead.

Reads the textures that `export-models.py --sets char` already wrote, so it needs no
client and no MPQ. Run `bun run assets -- --only model3d` first on a fresh checkout.

INPUT   scripts/data/char-appearance.json + public/model3d/chartex/**.webp
OUTPUT  scripts/data/char-palette.json   {"<race>-<sex>-skin": ["#rrggbb", ...], ...}
Run: python scripts/build-char-palette.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPEARANCE = os.path.join(ROOT, "scripts", "data", "char-appearance.json")
TEXDIR = os.path.join(ROOT, "public", "model3d", "chartex")
OUT = os.path.join(ROOT, "scripts", "data", "char-palette.json")

# Where in each texture the colour actually is. A skin texture is a body ATLAS -- torso,
# arms and legs in separate rectangles with dead space between them -- so averaging the
# whole thing drags the tone toward whatever fills the gaps. The upper-left quadrant is
# torso skin on every race. A hair texture is a cutout sheet: most of it is transparent,
# so there the alpha does the selecting and the whole image is fair game.
SKIN_BOX = (0.0, 0.0, 0.5, 0.5)


def texpath(blp):
    """Client path -> the exported webp, mirroring export-models.py's naming."""
    rel = blp.replace("\\", "/").lower()
    if rel.endswith(".blp"):
        rel = rel[:-4] + ".webp"
    return os.path.join(TEXDIR, *rel.split("/"))


def average(path, box=None):
    from PIL import Image
    try:
        im = Image.open(path).convert("RGBA")
    except (FileNotFoundError, OSError):
        return None
    if box:
        w, h = im.size
        im = im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))
    im.thumbnail((64, 64))
    r = g = b = n = 0
    raw = im.tobytes()
    for i in range(0, len(raw), 4):
        px = raw[i:i + 4]
        # Ignore anything the alpha test would drop, and the near-black bleed around a
        # cutout -- both pull an average toward a colour nothing on screen shows.
        if px[3] < 200 or (px[0] + px[1] + px[2]) < 24:
            continue
        r += px[0]; g += px[1]; b += px[2]; n += 1
    if not n:
        return None
    return "#%02x%02x%02x" % (r // n, g // n, b // n)


def main():
    try:
        import PIL  # noqa: F401
    except ImportError:
        sys.exit("Pillow required: pip install Pillow")
    if not os.path.isdir(TEXDIR):
        sys.exit(f"character textures not found: {TEXDIR}\n"
                 "Run `bun run assets -- --only model3d` (or export-models.py --sets char).")
    app = json.load(open(APPEARANCE, encoding="utf-8"))
    out, missing = {}, 0
    for key, rows in app["sections"].items():
        kind = key.rsplit("-", 1)[-1]
        if kind not in ("skin", "hair"):
            continue
        # rows are [variation, colour, [textures]]. One colour can appear under several
        # variations (every hairstyle in every colour); the first that carries art wins,
        # since the colour is the same whichever style shows it.
        by_colour = {}
        for variation, colour, texs in rows:
            if not texs or colour in by_colour:
                continue
            hexv = average(texpath(texs[0]), SKIN_BOX if kind == "skin" else None)
            if hexv:
                by_colour[colour] = hexv
        if not by_colour:
            missing += 1
            continue
        top = max(by_colour)
        out[key] = [by_colour.get(i) for i in range(top + 1)]
    # A colour index means the same colour on both genders of a race, but the art does
    # not always exist for both (tauren females carry no hair textures at all -- 8 of 9
    # holes). Fill from the sibling rather than showing a numbered circle for a colour we
    # can name.
    for key, vals in out.items():
        race, sex, kind = key.split("-")
        other = out.get(f"{race}-{'f' if sex == 'm' else 'm'}-{kind}") or []
        for i, v in enumerate(vals):
            if v is None and i < len(other) and other[i]:
                vals[i] = other[i]
    # A palette that samples the SAME colour for every index is not a colour picker, it
    # is nine identical circles. Tauren hair is exactly that -- the option changes geometry
    # the texture does not follow -- so drop it and let the UI number those instead, which
    # at least tells the truth about what is being chosen.
    flat = [k for k, v in out.items() if len(set(v)) < 2]
    for k in flat:
        del out[k]
    json.dump(out, open(OUT, "w", encoding="utf-8"), separators=(",", ":"), sort_keys=True)
    size = os.path.getsize(OUT)
    print(f"wrote {len(out)} palettes ({sum(len(v) for v in out.values())} colours, "
          f"{size / 1024:.1f} KB) -> {os.path.relpath(OUT, ROOT)}"
          + (f"; {missing} section(s) had no usable art" if missing else "")
          + (f"; dropped {len(flat)} single-colour: {', '.join(flat)}" if flat else ""))


if __name__ == "__main__":
    main()
