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

echo "== cargo test (workspace all-targets gate) =="
cargo test --workspace --all-targets --quiet

echo "== frontend test gate =="
(cd src && npm test)

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
  (cd src-tauri && ../src/node_modules/.bin/tauri build --ci --target universal-apple-darwin)
else
  (cd src-tauri && ../src/node_modules/.bin/tauri build --ci)
fi

APP_BUNDLE=target/release/bundle/macos/AgentPort.app
DMG_DIR=target/release/bundle/dmg

# Without a Developer ID identity, rustc leaves only linker-level ad-hoc
# signatures on the Mach-O files. Seal the complete bundle so Info.plist,
# resources, and the sidecar pass strict verification. Preserve a valid
# Developer ID signature when CI supplies one.
if ! codesign --verify --deep --strict "$APP_BUNDLE" 2>/dev/null; then
  echo "== applying complete local ad-hoc App signature =="
  codesign --force --deep --sign - "$APP_BUNDLE"
  codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

  # Tauri created the DMG before the complete App signature existed, so
  # regenerate it from the now-sealed bundle. --skip-jenkins is the generated
  # create-dmg script's noninteractive/CI mode and avoids Finder mount races.
  DMG_PATH="$(find "$DMG_DIR" -maxdepth 1 -type f -name 'AgentPort_*.dmg' -print -quit)"
  [ -n "$DMG_PATH" ] || { echo "ERROR: Tauri DMG not found" >&2; exit 2; }
  DMG_STAGE="$(mktemp -d /tmp/agentport-signed-dmg.XXXXXX)"
  cleanup_dmg_stage() { rm -r -- "$DMG_STAGE"; }
  trap cleanup_dmg_stage EXIT
  cp -R "$APP_BUNDLE" "$DMG_STAGE/AgentPort.app"
  rm -f -- "$DMG_PATH"
  "$DMG_DIR/bundle_dmg.sh" \
    --volname AgentPort \
    --volicon "$DMG_DIR/icon.icns" \
    --window-size 660 400 \
    --icon-size 128 \
    --icon AgentPort.app 180 170 \
    --hide-extension AgentPort.app \
    --app-drop-link 480 170 \
    --skip-jenkins \
    "$DMG_PATH" \
    "$DMG_STAGE"
  cleanup_dmg_stage
  trap - EXIT
fi
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

OUT=dist-release/macos
mkdir -p "$OUT"
rm -rf "$OUT/AgentPort.app"
rm -f "$OUT"/*.dmg "$OUT/sha256.txt"
cp -R target/release/bundle/macos/AgentPort.app "$OUT/" 2>/dev/null || true
cp target/release/bundle/dmg/*.dmg "$OUT/" 2>/dev/null || true
(
  cd "$OUT"
  for artifact in ./*; do
    [ -f "$artifact" ] || continue
    [ "$artifact" = "./sha256.txt" ] && continue
    shasum -a 256 "$artifact"
  done > sha256.txt
  test -s sha256.txt
  cat sha256.txt
)
echo "== macOS artifacts in $OUT =="
ls -la "$OUT"
