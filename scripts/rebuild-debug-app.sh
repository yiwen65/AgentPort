#!/usr/bin/env bash
# Rebuild the workspace-local debug App with a Bundle ID unique to this
# checkout. macOS routes notification clicks by Bundle ID, so sharing the
# release identity can activate another running AgentPort instance.
# Set AGENTPORT_DEBUG_SIGN_IDENTITY in the repository .env file or process
# environment to preserve macOS TCC grants. Ad-hoc signing requires explicit
# opt-in because its hash-based identity invalidates grants after rebuilds.
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
DEBUG_SIGN_IDENTITY="${AGENTPORT_DEBUG_SIGN_IDENTITY:-}"

if [ -z "$DEBUG_SIGN_IDENTITY" ] || [ "$DEBUG_SIGN_IDENTITY" = "-" ]; then
  if [ "${AGENTPORT_DEBUG_ALLOW_ADHOC:-0}" != "1" ]; then
    echo "ERROR: stable debug signing identity required to preserve macOS permissions." >&2
    echo "Set AGENTPORT_DEBUG_SIGN_IDENTITY to a codesigning certificate in .env." >&2
    echo "For disposable builds only, set AGENTPORT_DEBUG_ALLOW_ADHOC=1 (permissions may reset)." >&2
    exit 2
  fi
  DEBUG_SIGN_IDENTITY="-"
  echo "WARNING: ad-hoc debug signing; macOS permissions may reset after rebuilds." >&2
fi

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
# tauri-build copies externalBin from src-tauri/binaries back into target/debug
# while building the GUI. Refresh those inputs FIRST or it overwrites current
# Host/Bridge binaries with stale versions (including an older DB schema).
(cd "$ROOT" && bash src-tauri/scripts/build-sidecar.sh debug)
(cd "$ROOT" && TAURI_CONFIG="{\"identifier\":\"$DEBUG_BUNDLE_ID\"}" \
  cargo build -p agentport --features tauri/custom-protocol)

TARGET_TRIPLE="$(rustc -vV | awk '/^host: / { print $2 }')"
for name in agentport-host agentport-remote-bridge agentport-mosh-attach agentport-connector; do
  if ! cmp -s "$ROOT/src-tauri/binaries/$name-$TARGET_TRIPLE" "$ROOT/target/debug/$name"; then
    echo "ERROR: GUI build changed staged sidecar $name; refusing to install a mixed bundle" >&2
    exit 2
  fi
done

if ! grep -Fq "$DEBUG_BUNDLE_ID" < <(strings "$ROOT/target/debug/agentport"); then
  echo "ERROR: debug binary does not contain the expected Bundle ID: $DEBUG_BUNDLE_ID" >&2
  exit 2
fi

# Replace inodes rather than truncating executables used by live hosts.
# Signing below then touches only the newly installed executables.
install_binary() {
  local name="$1" temporary
  temporary="$(mktemp "$APP/Contents/MacOS/.${name}.XXXXXX")"
  if cp "$ROOT/target/debug/$name" "$temporary" &&
    chmod 755 "$temporary" &&
    mv -f "$temporary" "$APP/Contents/MacOS/$name"; then
    return 0
  fi
  rm -f "$temporary"
  return 1
}
for name in agentport agentport-host agentport-remote-bridge agentport-mosh-attach agentport-connector; do
  install_binary "$name"
done
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $DEBUG_BUNDLE_ID" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $DEBUG_DISPLAY_NAME" "$PLIST"

# This script reuses the generated bundle; carry the usage descriptions from
# the source plist as well as the binary's embedded front-end resources.
sync_usage_description() {
  local key="$1" value
  value="$(/usr/libexec/PlistBuddy -c "Print :$key" "$ROOT/src-tauri/Info.plist")" || return 0
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$PLIST" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Add :$key string $value" "$PLIST"
}
sync_usage_description NSLocalNetworkUsageDescription
sync_usage_description NSDocumentsFolderUsageDescription
sync_usage_description NSDesktopFolderUsageDescription
sync_usage_description NSDownloadsFolderUsageDescription

# The reused bundle also keeps the icon from whatever full `tauri build` last
# produced; sync the current artwork so icon changes reach the debug App.
if ! cmp -s "$ROOT/src-tauri/icons/icon.icns" "$APP/Contents/Resources/icon.icns"; then
  cp "$ROOT/src-tauri/icons/icon.icns" "$APP/Contents/Resources/icon.icns"
  touch "$APP"
fi

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
