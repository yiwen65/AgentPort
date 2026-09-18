#!/usr/bin/env python3
"""Regenerate AgentPort macOS icon assets from the 1024x1024 master.

    python3 src-tauri/scripts/generate-icons.py [--check]

Source of truth: src-tauri/icons/icon.png — the macOS-style master with the
rounded-rect ("squircle") artwork on a transparent canvas. macOS displays app
icons exactly as shipped: a full-bleed square master renders as a square icon
with a visible rectangle border (regression once introduced in 836b697 and
reported as "更新后图标异常"). Never replace the master with opaque-corner
artwork.

Outputs (all derived from the master, Lanczos):
  32x32.png, 128x128.png, 128x128@2x.png (256px), 512x512.png  (bundle.icon /
  Linux hicolor; keep the largest PNG first in tauri.conf.json — tauri-codegen
  embeds the first .png as the runtime window icon)
  icon.icns (via iconutil, 10 entries 16..1024)

--check verifies every output plus the masters has fully transparent corners
and exits non-zero otherwise. Requires Pillow (`python3 -m pip install Pillow`).
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ICONS = Path(__file__).resolve().parent.parent / "icons"
MASTER = ICONS / "icon.png"
SIZES = [("512x512.png", 512), ("128x128.png", 128), ("128x128@2x.png", 256), ("32x32.png", 32)]
ICONSET = {
    "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
}


def transparent_corners(path: Path) -> bool:
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    return all(im.getpixel(p)[3] == 0 for p in corners)


def generate() -> None:
    master = Image.open(MASTER).convert("RGBA")
    if master.size != (1024, 1024):
        raise SystemExit(f"{MASTER} must be 1024x1024, got {master.size}")
    for name, size in SIZES:
        master.resize((size, size), Image.LANCZOS).save(ICONS / name)
        print(f"wrote {ICONS / name}")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "agentport.iconset"
        iconset.mkdir()
        for name, size in ICONSET.items():
            master.resize((size, size), Image.LANCZOS).save(iconset / name)
        subprocess.run(["iconutil", "-c", "icns", "-o", str(ICONS / "icon.icns"), str(iconset)], check=True)
        print(f"wrote {ICONS / 'icon.icns'}")


def check() -> None:
    bad: list[str] = []
    for name in ["icon.png", "icon-runtime-8bit.png"] + [n for n, _ in SIZES]:
        path = ICONS / name
        if not path.exists() or not transparent_corners(path):
            bad.append(name)
    icns = ICONS / "icon.icns"
    if icns.exists():
        with tempfile.TemporaryDirectory() as tmp:
            iconset = Path(tmp) / "check.iconset"
            subprocess.run(["iconutil", "-c", "iconset", "-o", str(iconset), str(icns)], check=True)
            for entry in sorted(iconset.iterdir()):
                if not transparent_corners(entry):
                    bad.append(f"icon.icns:{entry.name}")
    else:
        bad.append("icon.icns (missing)")
    if bad:
        raise SystemExit("opaque corners (square icon regression): " + ", ".join(bad))
    print("all icon assets have transparent corners")


if __name__ == "__main__":
    check() if "--check" in sys.argv[1:] else generate()
