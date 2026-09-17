#!/usr/bin/env bash
# One release = one version for the Tauri shell, the embedded Vite/React dist
# and every bundled sidecar (agentport-host, agentport-remote-bridge, ...).
# The updater compares the version published in tauri.conf.json against the
# release manifest, so a Cargo/package drift would ship an app that never
# updates or updates twice. Fails the build instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 - <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path.cwd()
errors = []

def read_version(path: pathlib.Path, extractor) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        errors.append(f"{path.relative_to(root)}: {error}")
        return ""
    value = extractor(text)
    if not value:
        errors.append(f"{path.relative_to(root)}: version not found")
        return ""
    return value

def cargo_workspace_version(text: str) -> str:
    section = re.search(r"^\[workspace\.package\]\s*$(.*?)(?=^\[)", text, re.M | re.S)
    if not section:
        return ""
    match = re.search(r'^version\s*=\s*"([^"]+)"', section.group(1), re.M)
    return match.group(1) if match else ""

def tauri_version(text: str) -> str:
    return json.loads(text).get("version", "")

def package_version(text: str) -> str:
    return json.loads(text).get("version", "")

cargo = read_version(root / "Cargo.toml", cargo_workspace_version)
tauri = read_version(root / "src-tauri/tauri.conf.json", tauri_version)
frontend = read_version(root / "src/package.json", package_version)

if errors:
    print("version sync check failed:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    sys.exit(1)

versions = {
    "Cargo.toml [workspace.package]": cargo,
    "src-tauri/tauri.conf.json": tauri,
    "src/package.json": frontend,
}
semver = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
for label, version in versions.items():
    if not semver.match(version):
        errors.append(f"{label}: not a semver version: {version!r}")
if len(set(versions.values())) != 1:
    for label, version in versions.items():
        errors.append(f"{label}: {version}")

if errors:
    print("version sync check failed:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    print("run scripts/set-version.sh <version> to align them", file=sys.stderr)
    sys.exit(1)

print(f"version sync ok: AgentPort {cargo} (Tauri shell = frontend dist = sidecars)")
PY
