#!/usr/bin/env bash
# Build AgentPort for macOS (official tier: macOS 13+).
# Default: current-arch .app + .dmg with the agentport-host sidecar embedded.
# Universal (arm64+x86_64): requires rustup with both targets installed —
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
#   scripts/build-macos.sh --universal
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

UNIVERSAL=0
[ "${1:-}" = "--universal" ] && UNIVERSAL=1

echo "== cargo test (core gate) =="
cargo test -p agentport-core -p agentport-host --quiet

echo "== release build =="
cargo build --release -p agentport-host -p agentport-cli

TRIPLE=$(rustc -vV | awk '/^host:/ {print $2}')
mkdir -p src-tauri/binaries
cp target/release/agentport-host "src-tauri/binaries/agentport-host-${TRIPLE}"
chmod +x "src-tauri/binaries/agentport-host-${TRIPLE}"
echo "sidecar: src-tauri/binaries/agentport-host-${TRIPLE}"

if [ "$UNIVERSAL" = 1 ]; then
  if ! command -v rustup >/dev/null; then
    echo "ERROR: universal build needs rustup-managed rust with both targets." >&2
    echo "  brew install rustup && rustup-init -y && rustup target add aarch64-apple-darwin x86_64-apple-darwin" >&2
    exit 2
  fi
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  cargo build --release -p agentport-host --target aarch64-apple-darwin
  cargo build --release -p agentport-host --target x86_64-apple-darwin
  lipo -create \
    target/aarch64-apple-darwin/release/agentport-host \
    target/x86_64-apple-darwin/release/agentport-host \
    -output src-tauri/binaries/agentport-host-universal-apple-darwin
  (cd src-tauri && ../src/node_modules/.bin/tauri build --target universal-apple-darwin)
else
  (cd src-tauri && ../src/node_modules/.bin/tauri build)
fi

OUT=dist-release/macos
mkdir -p "$OUT"
rm -rf "$OUT/AgentPort.app"
cp -R target/release/bundle/macos/AgentPort.app "$OUT/" 2>/dev/null || true
cp target/release/bundle/dmg/*.dmg "$OUT/" 2>/dev/null || true
( cd "$OUT" && shasum -a 256 ./* 2>/dev/null | tee sha256.txt )
echo "== macOS artifacts in $OUT =="
ls -la "$OUT"
