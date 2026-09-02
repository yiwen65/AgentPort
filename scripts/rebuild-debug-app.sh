#!/usr/bin/env bash
# Rebuild the workspace-local debug App with a Bundle ID unique to this
# checkout. macOS routes notification clicks by Bundle ID, so sharing the
# release identity can activate another running AgentPort instance.
# Set AGENTPORT_DEBUG_SIGN_IDENTITY in the repository .env file or process
# environment to preserve macOS TCC grants; otherwise use ad-hoc signing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ -f "$ROOT/.env" ] && [ -z "${AGENTPORT_DEBUG_SIGN_IDENTITY+x}" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
APP="$ROOT/target/debug/bundle/macos/AgentPort.app"
PLIST="$APP/Contents/Info.plist"
RELEASE_BUNDLE_ID="com.agentport.desktop"
DEBUG_HASH="$(printf '%s' "$ROOT" | shasum -a 256 | awk '{print substr($1, 1, 12)}')"
DEBUG_BUNDLE_ID="com.agentport.desktop.debug.${DEBUG_HASH}"
DEBUG_DISPLAY_NAME="AgentPort Debug - $(basename "$ROOT")"
DEBUG_SIGN_IDENTITY="${AGENTPORT_DEBUG_SIGN_IDENTITY:--}"

if [ ! -f "$PLIST" ]; then
  echo "ERROR: debug App bundle is missing: $APP" >&2
  echo "Generate it once with the Tauri debug bundler before running this script." >&2
  exit 2
fi

if [ "$DEBUG_SIGN_IDENTITY" != "-" ] &&
  ! security find-identity -v -p codesigning | grep -Fq "$DEBUG_SIGN_IDENTITY"; then
  echo "ERROR: configured debug signing identity is unavailable: $DEBUG_SIGN_IDENTITY" >&2
  exit 2
fi

(cd "$ROOT/src" && npm run build)
(cd "$ROOT" && cargo build -p agentport-host -p agentport-remote-bridge -p agentport-mosh-attach)
(cd "$ROOT" && TAURI_CONFIG="{\"identifier\":\"$DEBUG_BUNDLE_ID\"}" \
  cargo build -p agentport --features tauri/custom-protocol)

if ! grep -Fq "$DEBUG_BUNDLE_ID" < <(strings "$ROOT/target/debug/agentport"); then
  echo "ERROR: debug binary does not contain the expected Bundle ID: $DEBUG_BUNDLE_ID" >&2
  exit 2
fi

cp "$ROOT/target/debug/agentport" "$APP/Contents/MacOS/agentport"
cp "$ROOT/target/debug/agentport-host" "$APP/Contents/MacOS/agentport-host"
cp "$ROOT/target/debug/agentport-remote-bridge" "$APP/Contents/MacOS/agentport-remote-bridge"
cp "$ROOT/target/debug/agentport-mosh-attach" "$APP/Contents/MacOS/agentport-mosh-attach"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $DEBUG_BUNDLE_ID" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $DEBUG_DISPLAY_NAME" "$PLIST"

codesign --force --deep --sign "$DEBUG_SIGN_IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$APP"
fi

ACTUAL_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")"
if [ "$ACTUAL_BUNDLE_ID" != "$DEBUG_BUNDLE_ID" ] || [ "$ACTUAL_BUNDLE_ID" = "$RELEASE_BUNDLE_ID" ]; then
  echo "ERROR: debug Bundle ID isolation failed: $ACTUAL_BUNDLE_ID" >&2
  exit 2
fi

printf 'debug_bundle_id=%s\n' "$ACTUAL_BUNDLE_ID"
printf 'debug_display_name=%s\n' "$DEBUG_DISPLAY_NAME"
printf 'debug_sign_identity=%s\n' "$DEBUG_SIGN_IDENTITY"
printf 'debug_app=%s\n' "$APP"
