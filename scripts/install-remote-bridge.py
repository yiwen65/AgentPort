#!/usr/bin/env python3
"""Explicit per-user macOS SSH entry installation; never edits shell/SSH files."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shlex
import sys
import tempfile

NAME = "agentport-remote-bridge"


def wrapper(app: Path) -> bytes:
    # Keep the installed path (not a resolved symlink/version path) for upgrades.
    bridge = app / "Contents/MacOS" / NAME
    return ("#!/bin/sh\n# AgentPort installed SSH entry v1\nset -eu\n"
            'if [ "$#" -ne 2 ] || [ "$1" != serve ] || [ "$2" != --stdio ]; then\n'
            '  echo "usage: agentport-remote-bridge serve --stdio" >&2; exit 64\nfi\n'
            '# sshd may omit TMPDIR or inherit a different temp directory.\n'
            'TMPDIR="$(/usr/bin/getconf DARWIN_USER_TEMP_DIR)"\n'
            'case "$TMPDIR" in /*) ;; *) echo "Cannot determine macOS user temp directory" >&2; exit 1;; esac\n'
            '[ -d "$TMPDIR" ] && [ -w "$TMPDIR" ] || { echo "Invalid user temp directory" >&2; exit 1; }\n'
            'export TMPDIR\n'
            f'exec {shlex.quote(str(bridge))} "$@"\n').encode()


def install(app: Path, bin_dir: Path) -> Path:
    app = app.expanduser().absolute()
    if app.suffix != ".app" or any(c in str(app) for c in "\n\r\x00"):
        raise ValueError("--app must be an installed .app path without control characters")
    # Prevent the two common ephemeral installation mistakes, including symlinks.
    for candidate in (app, app.resolve()):
        if str(candidate).startswith("/Volumes/") or "target" in candidate.parts:
            raise ValueError("Copy the release App to a stable installed location, not /Volumes or target")
    for name in (NAME, "agentport", "agentport-host"):
        executable = app / "Contents/MacOS" / name
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise ValueError(f"Missing executable in installed App: {executable}")
    bin_dir = bin_dir.expanduser().absolute()
    bin_dir.mkdir(parents=True, exist_ok=True)
    destination = bin_dir / NAME
    content = wrapper(app)
    if os.path.lexists(destination):
        if (not destination.is_symlink() and destination.is_file()
                and destination.read_bytes() == content
                and os.access(destination, os.X_OK)):
            return destination
        raise ValueError(f"Refusing to overwrite {destination}; inspect and move it aside yourself first")
    # Publish a complete executable atomically, without replacing a racing file.
    fd, temporary = tempfile.mkstemp(prefix=".agentport-bridge-", dir=bin_dir)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            os.fchmod(stream.fileno(), 0o700)
        os.link(temporary, destination)
    finally:
        os.unlink(temporary)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=Path("/Applications/AgentPort.app"))
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local/bin")
    args = parser.parse_args()
    if sys.platform != "darwin" or os.getuid() == 0:
        parser.error("Run as your macOS SSH login user, without sudo")
    try:
        entry = install(args.app, args.bin_dir)
    except (OSError, ValueError) as error:
        print(f"Installation refused: {error}", file=sys.stderr)
        return 1
    print(f"Installed: {entry}\nEnsure {entry.parent} is in the non-interactive SSH shell PATH.\n"
          "No shell files, SSH keys, sshd settings, or running apps were changed. See install.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
