#!/usr/bin/env python3
"""Regenerate AgentPort macOS icon assets from the 1024x1024 master.

    python3 src-tauri/scripts/generate-icons.py [--check]

Sources of truth:
  - src-tauri/icons/icon.png — the macOS-style master with the rounded-rect
    ("squircle") artwork on a transparent canvas. macOS <26 displays app
    icons exactly as shipped: a full-bleed square master renders as a square
    icon with a visible rectangle border (regression once introduced in
    836b697 and reported as "更新后图标异常"). Never replace the master with
    opaque-corner artwork.
  - src-tauri/icons/AgentPort.icon/ — the macOS 26 (Tahoe) Liquid Glass
    layered icon. Without it, Tahoe renders the app ~20% smaller on a gray
    "icon jail" background. Its foreground layer (Assets/logo.png) is
    copied from the master without color keying or radial trimming, preserving
    the supplied galaxy artwork and its rounded border.

Outputs (all derived from the master, Lanczos):
  32x32.png, 128x128.png, 128x128@2x.png (256px), 512x512.png  (bundle.icon /
  Linux hicolor; keep the largest PNG first in tauri.conf.json — tauri-codegen
  embeds the first .png as the runtime window icon)
  icon.icns (via iconutil, 10 entries 16..1024)
  icons/AgentPort.icon/Assets/logo.png
  gen/icon-car/Assets.car (via src-tauri/scripts/build-icon-car.sh when
  actool is available; the committed car is what the bundler ships)

--check verifies the PNG/icns outputs have fully transparent corners and the
Tahoe icon inputs exist, exiting non-zero otherwise.
Requires Pillow (`python3 -m pip install Pillow`).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
MASTER = ICONS / "icon.png"
SIZES = [("512x512.png", 512), ("128x128.png", 128), ("128x128@2x.png", 256), ("32x32.png", 32)]
ICONSET = {
    "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
}
ICON_DOC = ICONS / "AgentPort.icon"
LOGO = ICON_DOC / "Assets" / "logo.png"
CAR = ROOT / "gen" / "icon-car" / "Assets.car"


def transparent_corners(path: Path) -> bool:
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    return all(im.getpixel(p)[3] == 0 for p in corners)


def derive_logo(master: Image.Image) -> Image.Image:
    """Preserve the complete supplied artwork, including its colors and border."""
    return master.convert("RGBA")


def resize_icon(master: Image.Image, size: int) -> Image.Image:
    image = master.resize((size, size), Image.Resampling.LANCZOS)
    # Lanczos ringing can leave faint alpha in the 16px icon's outer corners.
    for point in [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)]:
        image.putpixel(point, (0, 0, 0, 0))
    return image


def generate() -> None:
    master = Image.open(MASTER).convert("RGBA")
    if master.size != (1024, 1024):
        raise SystemExit(f"{MASTER} must be 1024x1024, got {master.size}")
    master.save(ICONS / "icon-runtime-8bit.png")
    for name, size in SIZES:
        resize_icon(master, size).save(ICONS / name)
        print(f"wrote {ICONS / name}")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "agentport.iconset"
        iconset.mkdir()
        for name, size in ICONSET.items():
            resize_icon(master, size).save(iconset / name)
        subprocess.run(["iconutil", "-c", "icns", "-o", str(ICONS / "icon.icns"), str(iconset)], check=True)
        print(f"wrote {ICONS / 'icon.icns'}")
    LOGO.parent.mkdir(parents=True, exist_ok=True)
    derive_logo(master).save(LOGO)
    print(f"wrote {LOGO}")
    car_script = ROOT / "scripts" / "build-icon-car.sh"
    if shutil.which("xcrun"):
        subprocess.run(["bash", str(car_script)], check=True)
    else:
        print(f"note: no xcrun; skipped Assets.car rebuild (run {car_script} on macOS)")


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
    doc = json.loads((ICON_DOC / "icon.json").read_text()) if (ICON_DOC / "icon.json").exists() else None
    if doc is None:
        bad.append("AgentPort.icon/icon.json (missing)")
    else:
        images = [layer["image-name"] for g in doc.get("groups", []) for layer in g.get("layers", [])]
        for image in images:
            if not (ICON_DOC / "Assets" / image).exists():
                bad.append(f"AgentPort.icon/Assets/{image} (missing)")
    if not CAR.exists():
        bad.append("gen/icon-car/Assets.car (missing; run src-tauri/scripts/build-icon-car.sh)")
    if bad:
        raise SystemExit("icon check failed: " + ", ".join(bad))
    print("all icon assets OK (transparent corners + Tahoe .icon + Assets.car)")


if __name__ == "__main__":
    check() if "--check" in sys.argv[1:] else generate()
