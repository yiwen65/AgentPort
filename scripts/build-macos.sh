#!/usr/bin/env bash
# Build AgentPort for macOS (official tier: macOS 13+).
# Default: current-arch .app + .dmg with Host and Remote Bridge sidecars embedded.
# Universal (arm64+x86_64): requires rustup with both targets installed —
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
#   scripts/build-macos.sh --universal
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

UNIVERSAL=0
case "${1:-}" in
  --universal) UNIVERSAL=1 ;;
  "") ;;
  *) echo "Usage: $0 [--universal]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "Usage: $0 [--universal]" >&2; exit 2; }

python3 scripts/test-install-remote-bridge.py
python3 scripts/verify-installed-remote-bridge.py --self-test
scripts/check-version-sync.sh

echo "== cargo test (workspace all-targets gate) =="
cargo test --workspace --all-targets --quiet

echo "== frontend test gate =="
(cd src && npm test)

echo "== release build =="
cargo build --release -p agentport-host -p agentport-remote-bridge -p agentport-mosh-attach -p agentport-cli -p agentport-relay --features agentport-relay/connector

# Updater artifacts are signed with the updater key, never with the OS code
# signing identity. Without a key the bundler refuses to build as soon as
# `plugins > updater > pubkey` is configured, so opt out explicitly: this DMG
# stays installable by hand but cannot be published as an update source.
# Optional stable release signing identity. Default ad-hoc signatures change
# cdhash on every build, so macOS TCC treats each update as a new app and
# re-asks every folder permission (Documents/Desktop/Downloads/...). A stable
# certificate keeps those grants across updates. CI receives
# APPLE_SIGNING_IDENTITY from secrets; local builds may set it directly or via
# AGENTPORT_RELEASE_SIGN_IDENTITY in .env (same pattern as the debug build).
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  identity="${AGENTPORT_RELEASE_SIGN_IDENTITY:-}"
  if [ -z "$identity" ] && [ -f .env ]; then
    identity=$(sed -n 's/^AGENTPORT_RELEASE_SIGN_IDENTITY=//p' .env | tail -1 | tr -d '\"')
  fi
  if [ -n "$identity" ]; then
    export APPLE_SIGNING_IDENTITY="$identity"
    echo "release signing identity: $identity"
  else
    echo "note: no APPLE_SIGNING_IDENTITY configured; building ad-hoc signed," >&2
    echo "      which resets all macOS folder-permission grants on every update" >&2
  fi
fi

UPDATER_ARGS=()
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  if [ -f "$HOME/.tauri/agentport-updater.key" ]; then
    export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/agentport-updater.key"
  else
    echo "note: no updater signing key (set TAURI_SIGNING_PRIVATE_KEY or create ~/.tauri/agentport-updater.key)" >&2
    echo "      building without updater artifacts; do not publish this build as an update source" >&2
    UPDATER_ARGS=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
  fi
fi

TRIPLE=$(rustc -vV | awk '/^host:/ {print $2}')
mkdir -p src-tauri/binaries
for binary in agentport-host agentport-remote-bridge agentport-mosh-attach agentport-connector; do
  cp "target/release/$binary" "src-tauri/binaries/$binary-${TRIPLE}"
  chmod +x "src-tauri/binaries/$binary-${TRIPLE}"
  echo "sidecar: src-tauri/binaries/$binary-${TRIPLE}"
done

if [ "$UNIVERSAL" = 1 ]; then
  if ! command -v rustup >/dev/null; then
    echo "ERROR: universal build needs rustup-managed rust with both targets." >&2
    echo "  brew install rustup && rustup-init -y && rustup target add aarch64-apple-darwin x86_64-apple-darwin" >&2
    exit 2
  fi
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  cargo build --release -p agentport-host -p agentport-remote-bridge -p agentport-mosh-attach -p agentport-relay --features agentport-relay/connector --target aarch64-apple-darwin
  cargo build --release -p agentport-host -p agentport-remote-bridge -p agentport-mosh-attach -p agentport-relay --features agentport-relay/connector --target x86_64-apple-darwin
  for binary in agentport-host agentport-remote-bridge agentport-mosh-attach agentport-connector; do
    # Per-arch copies: tauri-build resolves externalBin for each cargo target
    # of the universal build, not only for the lipo'd file.
    cp "target/aarch64-apple-darwin/release/$binary" "src-tauri/binaries/$binary-aarch64-apple-darwin"
    cp "target/x86_64-apple-darwin/release/$binary" "src-tauri/binaries/$binary-x86_64-apple-darwin"
    chmod +x "src-tauri/binaries/$binary-aarch64-apple-darwin" "src-tauri/binaries/$binary-x86_64-apple-darwin"
    lipo -create \
      "target/aarch64-apple-darwin/release/$binary" \
      "target/x86_64-apple-darwin/release/$binary" \
      -output "src-tauri/binaries/$binary-universal-apple-darwin"
    chmod +x "src-tauri/binaries/$binary-universal-apple-darwin"
  done
  (cd src-tauri && ../src/node_modules/.bin/tauri build --ci --target universal-apple-darwin "${UPDATER_ARGS[@]+"${UPDATER_ARGS[@]}"}")
else
  (cd src-tauri && ../src/node_modules/.bin/tauri build --ci "${UPDATER_ARGS[@]+"${UPDATER_ARGS[@]}"}")
fi

RELEASE_DIR=target/release
[ "$UNIVERSAL" = 0 ] || RELEASE_DIR=target/universal-apple-darwin/release
APP_BUNDLE="$RELEASE_DIR/bundle/macos/AgentPort.app"
DMG_DIR="$RELEASE_DIR/bundle/dmg"

# Without a Developer ID identity, rustc leaves only linker-level ad-hoc
# signatures on the Mach-O files. Seal the complete bundle so Info.plist,
# resources, and the sidecar pass strict verification. Preserve a valid
# Developer ID signature when CI supplies one.
if ! codesign --verify --deep --strict "$APP_BUNDLE" 2>/dev/null; then
  echo "== applying complete local ad-hoc App signature =="
  codesign --force --deep --sign - "$APP_BUNDLE"
  codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
fi

# Always include the explicit user-run SSH installer/docs next to the App,
# never inside its signed bundle. Nothing executes when the DMG is mounted.
# Tauri created the DMG before these extras (and possibly signing), so
# regenerate it from the now-sealed bundle. --skip-jenkins is the generated
# create-dmg script's noninteractive/CI mode and avoids Finder mount races.
DMG_PATH="$(find "$DMG_DIR" -maxdepth 1 -type f -name 'AgentPort_*.dmg' -print -quit)"
[ -n "$DMG_PATH" ] || { echo "ERROR: Tauri DMG not found" >&2; exit 2; }
DMG_STAGE="$(mktemp -d /tmp/agentport-signed-dmg.XXXXXX)"
cleanup_dmg_stage() { rm -r -- "$DMG_STAGE"; }
trap cleanup_dmg_stage EXIT
cp -R "$APP_BUNDLE" "$DMG_STAGE/AgentPort.app"
cp scripts/install-remote-bridge.py scripts/verify-installed-remote-bridge.py docs/install.md "$DMG_STAGE/"
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
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

OUT=dist-release/macos
mkdir -p "$OUT"
rm -rf "$OUT/AgentPort.app"
rm -f "$OUT"/*.dmg "$OUT/sha256.txt"
cp -R "$APP_BUNDLE" "$OUT/"
cp "$DMG_DIR"/*.dmg "$OUT/"
# Updater payloads produced next to the bundle (when a key was available).
for artifact in "$RELEASE_DIR"/bundle/macos/*.app.tar.gz "$RELEASE_DIR"/bundle/macos/*.app.tar.gz.sig; do
  [ -f "$artifact" ] || continue
  cp "$artifact" "$OUT/"
done
cp scripts/install-remote-bridge.py scripts/verify-installed-remote-bridge.py docs/install.md "$OUT/"
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
