#!/usr/bin/env python3
"""Bake the committed custom icons into one sprite-sheet atlas for the website.

Reads every ``assets/icons/custom/<name>.webp`` (produced by extract-icons.py,
committed to the repo) and composes a single square grid image plus a JSON map.
Unlike extract-icons.py this needs NO game client -- only the committed icons --
so it can run in CI before ``vite build``.

OUTPUTS (shippable; written into public/ so vite copies them to dist/)
  public/icons/custom-atlas.webp    the sprite sheet (cell = native icon size)
  public/icons/custom-atlas.json    { cell, cols, rows, count, icons: {name:i} }

The viewer (src/render.js) renders a custom icon as a <span> whose
background-image is this atlas, positioned by cell index. Positioning uses
percentages so one atlas serves every on-screen icon size.

Run:  python scripts/build-atlas.py
"""
import json
import math
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow required: pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "icons", "custom")
OUT_DIR = os.path.join(ROOT, "public", "icons")
OUT_IMG = os.path.join(OUT_DIR, "custom-atlas.webp")
OUT_JSON = os.path.join(OUT_DIR, "custom-atlas.json")


def main():
    if not os.path.isdir(SRC):
        sys.exit(f"no custom icons at {SRC} -- run extract-icons.py first")
    names = sorted(f[:-5] for f in os.listdir(SRC) if f.endswith(".webp"))
    if not names:
        sys.exit(f"no .webp icons in {SRC}")

    imgs = [Image.open(os.path.join(SRC, n + ".webp")).convert("RGBA") for n in names]
    cell = max(max(im.size) for im in imgs)  # native icon size (square; 64 for WoW)
    cols = math.ceil(math.sqrt(len(names)))
    rows = math.ceil(len(names) / cols)

    atlas = Image.new("RGBA", (cols * cell, rows * cell), (0, 0, 0, 0))
    index = {}
    for i, (name, im) in enumerate(zip(names, imgs)):
        if im.size != (cell, cell):
            im = im.resize((cell, cell), Image.LANCZOS)
        col, row = i % cols, i // cols
        atlas.paste(im, (col * cell, row * cell))
        index[name] = i

    os.makedirs(OUT_DIR, exist_ok=True)
    # method=6 = slowest/best; quality high but lossy keeps the sheet small.
    atlas.save(OUT_IMG, "WEBP", quality=92, method=6)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(
            {"cell": cell, "cols": cols, "rows": rows, "count": len(names), "icons": index},
            f, separators=(",", ":"), sort_keys=True,
        )
        f.write("\n")

    kb = os.path.getsize(OUT_IMG) / 1024
    print(f"atlas: {len(names)} icons  {cols}x{rows} grid  cell={cell}px  "
          f"{atlas.size[0]}x{atlas.size[1]}px  {kb:.0f} KB")
    print(f"  -> {os.path.relpath(OUT_IMG, ROOT)}")
    print(f"  -> {os.path.relpath(OUT_JSON, ROOT)}")


if __name__ == "__main__":
    main()
