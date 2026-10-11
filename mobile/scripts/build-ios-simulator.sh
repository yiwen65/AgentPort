#!/usr/bin/env bash
# Preserve Tauri's production build context while Xcode archives for a generic
# simulator; CLI 2.11 incorrectly requires a runtime at least as new as its SDK.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Xcode inherits PATH and must use rustup's Cargo so the installed iOS target is visible.
export PATH="$HOME/.cargo/bin:$PATH"
cd "$ROOT"
exec python3 "$ROOT/scripts/build-ios-simulator.py" "$@"
