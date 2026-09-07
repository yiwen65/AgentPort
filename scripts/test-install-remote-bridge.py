#!/usr/bin/env python3
"""Temporary-directory-only tests; no installed Apps or user files are touched."""
import importlib.util
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-remote-bridge.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentport-installer-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / "Apps with spaces" / "Agent'Port.app"
        self.bin = self.root / "home/.local/bin"
        macos = self.app / "Contents/MacOS"
        macos.mkdir(parents=True)
        for name in (installer.NAME, "agentport", "agentport-host"):
            path = macos / name
            path.write_text('#!/bin/sh\nprintf "%s\\n" "$TMPDIR" "$@"\n')
            path.chmod(0o755)

    def test_install_is_idempotent_and_preserves_shell_files(self):
        zshenv = self.root / "home/.zshenv"
        zshenv.parent.mkdir()
        zshenv.write_bytes(b"# existing user configuration\n")
        entry = installer.install(self.app, self.bin)
        self.assertEqual(entry.stat().st_mode & 0o777, 0o700)
        inode = entry.stat().st_ino
        self.assertEqual(installer.install(self.app, self.bin).stat().st_ino, inode)
        self.assertEqual(zshenv.read_bytes(), b"# existing user configuration\n")
        subprocess.run(["/bin/sh", "-n", str(entry)], check=True)

    def test_refuses_existing_file_directory_and_symlink(self):
        self.bin.mkdir(parents=True)
        entry = self.bin / installer.NAME
        entry.write_bytes(b"unrelated binary")
        with self.assertRaisesRegex(ValueError, "Refusing"):
            installer.install(self.app, self.bin)
        self.assertEqual(entry.read_bytes(), b"unrelated binary")
        entry.unlink()
        for target in (self.root / "missing", self.app / "Contents/MacOS" / installer.NAME):
            entry.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "Refusing"):
                installer.install(self.app, self.bin)
            self.assertTrue(entry.is_symlink())
            entry.unlink()
        entry.mkdir()
        with self.assertRaisesRegex(ValueError, "Refusing"):
            installer.install(self.app, self.bin)

    def test_invalid_app_has_no_install_side_effect(self):
        for app in (self.root / "missing.app", self.root / "target/debug/Test.app", Path("/Volumes/Test/Test.app")):
            with self.assertRaises(ValueError):
                installer.install(app, self.bin)
            self.assertFalse(self.bin.exists())
        bridge = self.app / "Contents/MacOS" / installer.NAME
        bridge.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "Missing executable"):
            installer.install(self.app, self.bin)

    def test_racing_destination_is_not_overwritten(self):
        link = os.link
        def race(source, destination):
            Path(destination).write_text("racing user file")
            link(source, destination)
        with patch.object(installer.os, "link", side_effect=race):
            with self.assertRaises(FileExistsError):
                installer.install(self.app, self.bin)
        self.assertEqual((self.bin / installer.NAME).read_text(), "racing user file")
        self.assertEqual(len(list(self.bin.iterdir())), 1)

    def test_wrapper_quotes_path_sets_tmpdir_and_preserves_overrides(self):
        entry = installer.install(self.app, self.bin)
        bridge = self.app / "Contents/MacOS" / installer.NAME
        bridge.write_text('#!/bin/sh\nprintf "%s\\n" "$TMPDIR" "$@" "$AGENTPORT_SOCKET_DIR" "$AGENTPORT_DATA_DIR"\n')
        # Substitute only the macOS system query for a deterministic portable test.
        script = entry.read_text().replace("/usr/bin/getconf DARWIN_USER_TEMP_DIR", "printf '%s' " + shlex.quote(str(self.root)))
        entry.write_text(script)
        env = {**os.environ, "TMPDIR": "/wrong", "AGENTPORT_SOCKET_DIR": "/custom/socket", "AGENTPORT_DATA_DIR": "/custom/data"}
        result = subprocess.run([str(entry), "serve", "--stdio"], env=env, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.splitlines(), [str(self.root), "serve", "--stdio", "/custom/socket", "/custom/data"])
        self.assertEqual(result.stderr, "")
        for args in ([], ["serve"], ["serve", "--stdio", "extra"], ["bad", "--stdio"]):
            result = subprocess.run([str(entry), *args], capture_output=True)
            self.assertEqual(result.returncode, 64)
            self.assertEqual(result.stdout, b"")
        for query in ("false", "printf relative", "printf /nonexistent-agentport-test-temp"):
            entry.write_text(installer.wrapper(self.app).decode().replace("/usr/bin/getconf DARWIN_USER_TEMP_DIR", query))
            result = subprocess.run([str(entry), "serve", "--stdio"], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b"")

    def test_app_update_keeps_stable_path(self):
        entry = installer.install(self.app, self.bin)
        bridge = self.app / "Contents/MacOS" / installer.NAME
        bridge.write_text("#!/bin/sh\nexit 0\n")
        self.assertEqual(entry.read_bytes(), installer.wrapper(self.app))
        self.assertNotIn(str(Path(__file__).parent).encode(), entry.read_bytes())


class PackagingTests(unittest.TestCase):
    def test_native_and_universal_output_paths_and_dmg_extras(self):
        # Exercise the real orchestration with fake toolchain/signing tools only.
        # No release compilation, system signing, mounts, or live installs.
        for universal in (False, True):
            with self.subTest(universal=universal), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                for directory in ("scripts", "docs", "src/node_modules/.bin", "src-tauri", "tools"):
                    (root / directory).mkdir(parents=True)
                shutil.copyfile(Path(__file__).with_name("build-macos.sh"), root / "scripts/build-macos.sh")
                for name in ("test-install-remote-bridge.py", "verify-installed-remote-bridge.py", "install-remote-bridge.py"):
                    (root / "scripts" / name).write_text("# fixture\n")
                (root / "docs/install.md").write_text("fixture docs\n")
                tool = root / "tools/fake"
                tool.write_text("#!" + sys.executable + "\n" + '''
import os
from pathlib import Path
import sys
root = Path(os.environ["FAKE_ROOT"])
name = Path(sys.argv[0]).name
args = sys.argv[1:]
if name == "rustc":
    print("host: aarch64-apple-darwin")
elif name == "cargo" and args[0] == "build":
    target = args[args.index("--target") + 1] if "--target" in args else ""
    out = root / "target" / target / "release"
    out.mkdir(parents=True, exist_ok=True)
    for binary in ("agentport-host", "agentport-remote-bridge", "agentport-mosh-attach", "agentport-connector"):
        (out / binary).write_text("fake binary")
elif name == "lipo":
    Path(args[args.index("-output") + 1]).write_text("fake universal")
elif name == "tauri":
    target = "universal-apple-darwin" if "--target" in args else ""
    bundle = root / "target" / target / "release/bundle"
    app = bundle / "macos/AgentPort.app"
    app.mkdir(parents=True)
    (app / "fixture").write_text(target or "native")
    dmg = bundle / "dmg"
    dmg.mkdir()
    (dmg / "AgentPort_test.dmg").write_text("old image")
    (dmg / "icon.icns").write_text("icon")
    script = dmg / "bundle_dmg.sh"
    script.write_text("#!" + sys.executable + "\\n" + "import sys; from pathlib import Path\\n" +
        "stage = Path(sys.argv[-1])\\n" +
        "assert (stage / 'AgentPort.app').is_dir()\\n" +
        "assert all((stage / n).is_file() for n in ('install-remote-bridge.py', 'verify-installed-remote-bridge.py', 'install.md'))\\n" +
        "Path(sys.argv[-2]).write_text('new image with extras')\\n")
    script.chmod(0o755)
''')
                tool.chmod(0o755)
                for name in ("cargo", "rustc", "rustup", "lipo", "codesign", "npm"):
                    (root / "tools" / name).symlink_to(tool)
                (root / "src/node_modules/.bin/tauri").symlink_to(tool)
                env = {**os.environ, "PATH": str(root / "tools") + os.pathsep + os.environ["PATH"], "FAKE_ROOT": str(root)}
                result = subprocess.run(["bash", str(root / "scripts/build-macos.sh"), *(["--universal"] if universal else [])], env=env, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                out = root / "dist-release/macos"
                self.assertEqual((out / "AgentPort.app/fixture").read_text(), "universal-apple-darwin" if universal else "native")
                self.assertEqual((out / "AgentPort_test.dmg").read_text(), "new image with extras")
                hashes = (out / "sha256.txt").read_text()
                for name in ("install-remote-bridge.py", "verify-installed-remote-bridge.py", "install.md", "AgentPort_test.dmg"):
                    self.assertIn(name, hashes)
                triple = "universal-apple-darwin" if universal else "aarch64-apple-darwin"
                self.assertTrue((root / "src-tauri/binaries" / ("agentport-connector-" + triple)).is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
