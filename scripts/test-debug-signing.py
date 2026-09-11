#!/usr/bin/env python3
"""Ensure routine debug rebuilds cannot silently lose macOS TCC identity."""
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parent.parent


class DebugSigningTests(unittest.TestCase):
    def test_unstable_signing_is_rejected_before_build(self):
        for identity in ("", "-"):
            with self.subTest(identity=identity):
                result = subprocess.run(
                    ["bash", str(ROOT / "scripts/rebuild-debug-app.sh")],
                    env={**os.environ, "AGENTPORT_DEBUG_SIGN_IDENTITY": identity,
                         "AGENTPORT_DEBUG_ALLOW_ADHOC": "0"},
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("stable debug signing identity required", result.stderr)
                self.assertNotIn("vite", result.stdout)


if __name__ == "__main__":
    unittest.main()
