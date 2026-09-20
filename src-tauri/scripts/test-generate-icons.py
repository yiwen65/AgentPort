#!/usr/bin/env python3
"""Regression: eliminating transparent padding must not zoom the icon artwork."""
import importlib.util
import unittest
from pathlib import Path

from PIL import Image, ImageChops

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("generate_icons", HERE / "generate-icons.py")
icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icons)


class IconProportionsTest(unittest.TestCase):
    def test_artwork_coordinates_and_colors_are_preserved(self):
        master = Image.open(icons.MASTER).convert("RGBA")
        result = icons.derive_logo(master)
        self.assertEqual(result.size, master.size)
        self.assertEqual(result.mode, "RGB")
        mask = master.getchannel("A").point(lambda a: 255 if a >= 240 else 0)
        difference = ImageChops.difference(result, master.convert("RGB"))
        difference.paste((0, 0, 0), mask=ImageChops.invert(mask))
        self.assertIsNone(difference.getbbox(), "Opaque artwork moved, scaled, or recolored")
        for point in [(0, 0), (1023, 0), (0, 1023), (1023, 1023)]:
            self.assertGreater(max(result.getpixel(point)), 40, "Dark backing introduced")


if __name__ == "__main__":
    unittest.main()
