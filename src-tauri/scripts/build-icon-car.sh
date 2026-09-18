#!/usr/bin/env bash
# Regenerate src-tauri/gen/icon-car/Assets.car from src-tauri/icons/AgentPort.icon.
#
# macOS 26 (Tahoe) renders app icons from a layered Icon Composer document
# (.icon) compiled into an asset catalog; plain .icns icons are shown ~20%
# smaller inside a gray "icon jail" background. The compiled car also embeds
# classic pre-rendered renditions (16..1024) so macOS 13-15 still gets a
# normal icon via CFBundleIconName, with icons/icon.icns as CFBundleIconFile
# fallback.
#
# The car is COMMITTED (src-tauri/gen/icon-car/Assets.car) and is what the
# bundler ships (bundle.resources in tauri.conf.json) — builds do not depend
# on Xcode tooling. Re-run this script after editing icons/AgentPort.icon and
# commit the result. Requires Xcode 26+ (actool with .icon support).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUNDLE="$ROOT/src-tauri/icons/AgentPort.icon"
OUT="$ROOT/src-tauri/gen/icon-car"
PLIST="$(mktemp /tmp/agentport-icon-partial.XXXXXX.plist)"
trap 'rm -f "$PLIST"' EXIT

if ! command -v xcrun >/dev/null || ! xcrun -f actool >/dev/null 2>&1; then
  echo "error: actool unavailable; install Xcode 26+ to rebuild Assets.car" >&2
  exit 2
fi

mkdir -p "$OUT"
xcrun actool "$BUNDLE" \
  --compile "$OUT" \
  --app-icon AgentPort \
  --include-all-app-icons \
  --platform macosx \
  --minimum-deployment-target 13.0 \
  --target-device mac \
  --output-partial-info-plist "$PLIST" \
  --errors --warnings --notices \
  --output-format human-readable-text

[ -f "$OUT/Assets.car" ] || { echo "error: actool produced no Assets.car" >&2; exit 1; }
NAME=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' "$PLIST" 2>/dev/null || true)
[ "$NAME" = "AgentPort" ] || { echo "error: partial plist CFBundleIconName=$NAME" >&2; exit 1; }
# The loose fallback icns rendered alongside is redundant with the hand-tuned
# icons/icon.icns; keep the directory clean.
rm -f "$OUT/AgentPort.icns" "$OUT/partial-info.plist"
echo "wrote $OUT/Assets.car"
