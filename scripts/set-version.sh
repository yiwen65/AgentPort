#!/usr/bin/env bash
# Align every version source with one release version, then hand off to the
# normal tag → CI flow (see docs/updater.md).
#   scripts/set-version.sh 0.2.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>   e.g. $0 0.2.0" >&2
  exit 2
fi

python3 - "$VERSION" <<'PY'
import pathlib
import re
import sys

version = sys.argv[1]
if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
    sys.exit(f"not a semver version: {version!r}")

root = pathlib.Path.cwd()

def replace_once(path: pathlib.Path, pattern: str, replacement: str) -> None:
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.M)
    if count != 1:
        sys.exit(f"{path.relative_to(root)}: version declaration not found")
    path.write_text(updated, encoding="utf-8")
    print(f"updated {path.relative_to(root)}")

# Cargo workspace version: first `version = ...` after [workspace.package].
cargo = root / "Cargo.toml"
text = cargo.read_text(encoding="utf-8")
marker = text.find("[workspace.package]")
if marker < 0:
    sys.exit("Cargo.toml: [workspace.package] not found")
head, tail = text[:marker], text[marker:]
tail, count = re.subn(r'^version\s*=\s*"[^"]+"', f'version = "{version}"', tail, count=1, flags=re.M)
if count != 1:
    sys.exit("Cargo.toml: [workspace.package] version not found")
cargo.write_text(head + tail, encoding="utf-8")
print("updated Cargo.toml")

for relative in ("src-tauri/tauri.conf.json", "src/package.json"):
    replace_once(root / relative, r'^(\s*"version"\s*:\s*)"[^"]+"', rf'\g<1>"{version}"')
PY

scripts/check-version-sync.sh
echo "next: commit, then tag v$VERSION and push the tag to trigger the release workflow"
