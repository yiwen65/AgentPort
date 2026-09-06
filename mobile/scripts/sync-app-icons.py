#!/usr/bin/env python3
"""Sync launcher assets from the desktop master. Requires Pillow (pip install Pillow).

Run from any directory; --check verifies committed pixels and iOS catalog sizes.
iOS uses opaque RGB, leaving masking to the OS. Android adaptive layers use the
108dp canvas; the desktop mark already occupies its central ~66dp safe circle.
"""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
MOBILE = ROOT / "mobile/src-tauri"


def assets():
    master = Image.open(ROOT / "src-tauri/icons/icon.png").convert("RGB")
    yield MOBILE / "icons/icon.png", master.convert("RGBA")
    catalog = MOBILE / "gen/apple/Assets.xcassets/AppIcon.appiconset"
    for entry in json.loads((catalog / "Contents.json").read_text())["images"]:
        size = round(float(entry["size"].split("x")[0]) * float(entry["scale"].rstrip("x")))
        yield catalog / entry["filename"], master.resize((size, size), Image.Resampling.LANCZOS)
    res = MOBILE / "gen/android/app/src/main/res"
    for density, scale in [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)]:
        folder = res / f"mipmap-{density}"
        size = round(48 * scale)
        icon = master.resize((size, size), Image.Resampling.LANCZOS)
        yield folder / "ic_launcher.png", icon
        # Supersample the legacy round mask for clean edges at small densities.
        mask = Image.new("L", (size * 4, size * 4))
        ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
        rounded = icon.convert("RGBA")
        rounded.putalpha(mask.resize((size, size), Image.Resampling.LANCZOS))
        yield folder / "ic_launcher_round.png", rounded
        size = round(108 * scale)
        yield folder / "ic_launcher_foreground.png", master.resize((size, size), Image.Resampling.LANCZOS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    count = 0
    for path, expected in assets():
        if args.check:
            with Image.open(path) as actual:
                assert actual.mode == expected.mode and actual.size == expected.size, path
                assert actual.tobytes() == expected.tobytes(), path
        else:
            expected.save(path)
        count += 1
    print(f"{'Verified' if args.check else 'Generated'} {count} launcher assets from desktop master")


if __name__ == "__main__":
    main()
