#!/usr/bin/env bash
# Opt-in device archive + local development IPA. No exportArchive / Ad Hoc export.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
: "${APPLE_DEVELOPMENT_TEAM:?Set your local Personal Team ID}"
: "${IOS_DEVICE_UDID:?Set the registered iPhone hardware UDID}"
: "${IOS_OUTPUT_DIR:?Set a new output directory outside the repository}"
[[ "$APPLE_DEVELOPMENT_TEAM" =~ ^[A-Z0-9]{10}$ ]] || { echo 'Invalid team format' >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS and Xcode required' >&2; exit 1; }
ARCHIVE="$ROOT/src-tauri/gen/apple/build/agentport-mobile_iOS.xcarchive"
[[ ! -e "$ARCHIVE" ]] || { echo 'Move the previous device archive aside first; refusing stale archive reuse.' >&2; exit 1; }
[[ ! -e "$IOS_OUTPUT_DIR" ]] || { echo 'Output directory must not exist.' >&2; exit 1; }
# XCODE_XCCONFIG_FILE overrides generated project settings without editing them.
# This also overrides any pre-existing local DEVELOPMENT_TEAM in the project.
umask 077
CONFIG="$(mktemp "${TMPDIR:-/tmp}/agentport-signing.XXXXXX")"
trap 'rm -f "$CONFIG"' EXIT
printf 'DEVELOPMENT_TEAM = %s\nCODE_SIGN_STYLE = Automatic\nCODE_SIGN_IDENTITY = Apple Development\nCODE_SIGNING_ALLOWED = YES\nCODE_SIGNING_REQUIRED = YES\nPROVISIONING_PROFILE_SPECIFIER =\nPROVISIONING_PROFILE =\n' "$APPLE_DEVELOPMENT_TEAM" > "$CONFIG"
export XCODE_XCCONFIG_FILE="$CONFIG"
cd "$ROOT"
npm run tauri -- ios build --debug --target aarch64 --archive-only --ci
python3 "$ROOT/scripts/package-ios-development.py" \
  --app "$ARCHIVE/Products/Applications/AgentPort.app" \
  --output "$IOS_OUTPUT_DIR" --team-id "$APPLE_DEVELOPMENT_TEAM" \
  --device-udid "$IOS_DEVICE_UDID" --min-valid-hours "${IOS_MIN_VALID_HOURS:-1}"
