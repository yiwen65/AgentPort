#!/usr/bin/env bash
# Tauri 2.11 does not replace an existing simulator bundle after archiving;
# remove only that generated destination so repeated builds remain deterministic.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Xcode inherits PATH and must use rustup's Cargo so the installed iOS target is visible.
export PATH="$HOME/.cargo/bin:$PATH"
rm -rf -- "$ROOT/src-tauri/gen/apple/build/arm64-sim/AgentPort.app"
cd "$ROOT"
exec npm run tauri -- ios build --debug --target aarch64-sim --ci "$@"
