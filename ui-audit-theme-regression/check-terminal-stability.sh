#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <light-theme-screenshot>" >&2
  exit 2
fi

screenshot=$1
root_dir=$(cd "$(dirname "$0")/.." && pwd)

if ! command -v magick >/dev/null 2>&1; then
  echo "FAIL: ImageMagick is required" >&2
  exit 2
fi

# The supplied regression frame contains a dense terminal transcript in the
# right-hand pane. When xterm's glyph atlas breaks, most foreground/background
# cells disappear and this ratio drops well below the healthy baseline.
dark_ratio=$(
  magick "$screenshot" \
    -gravity NorthWest \
    -crop '70%x70%+26%+8%' +repage \
    -colorspace Gray -threshold 80% \
    -format '%[fx:1-mean]' info:
)

status=0
if ! awk -v ratio="$dark_ratio" 'BEGIN { exit !(ratio >= 0.05) }'; then
  echo "FAIL: terminal glyph/background density ${dark_ratio} is below 0.05" >&2
  status=1
else
  echo "PASS: terminal glyph/background density ${dark_ratio}"
fi

if rg -q '@xterm/addon-webgl|WebglAddon' \
  "$root_dir/src/package.json" "$root_dir/src/src/terminals.ts"; then
  echo "FAIL: unstable WebGL terminal renderer is still enabled" >&2
  status=1
else
  echo "PASS: unstable WebGL renderer is absent"
fi

if ! rg -q '@xterm/addon-canvas' \
  "$root_dir/src/package.json" "$root_dir/src/src/terminals.ts"; then
  echo "FAIL: xterm Canvas renderer is not installed and loaded" >&2
  status=1
else
  echo "PASS: xterm Canvas renderer owns glyph and background painting"
fi

if ! rg -q '"transparent"[[:space:]]*:[[:space:]]*false' \
  "$root_dir/src-tauri/tauri.conf.json"; then
  echo "FAIL: native window is still transparent" >&2
  status=1
else
  echo "PASS: native window is opaque"
fi

if rg -q '\.setTheme\(' "$root_dir/src/src/actions.ts"; then
  echo "FAIL: theme switch still forces a native window repaint" >&2
  status=1
else
  echo "PASS: theme switching stays inside the rendered app surface"
fi

if ! rg -q 'dataset\.theme = prepaintTheme' "$root_dir/src/index.html"; then
  echo "FAIL: first paint does not use the persisted effective theme" >&2
  status=1
else
  echo "PASS: startup and runtime theme use the same first-paint token"
fi

if ! rg -q 'white: "#52525b"' "$root_dir/src/src/terminals.ts" ||
  ! rg -q 'brightWhite: "#18181b"' "$root_dir/src/src/terminals.ts"; then
  echo "FAIL: light ANSI white slots are not mapped to readable dark colors" >&2
  status=1
else
  echo "PASS: light ANSI white slots remain readable on white"
fi

if ! rg -q 'minimumContrastRatio: 7' "$root_dir/src/src/terminals.ts"; then
  echo "FAIL: truecolor Agent output has no light-theme contrast correction" >&2
  status=1
else
  echo "PASS: truecolor Agent output is contrast-corrected across themes"
fi

if ! rg -q "font-src 'self' data:" "$root_dir/src-tauri/tauri.conf.json"; then
  echo "FAIL: bundled terminal fonts are blocked by the native CSP" >&2
  status=1
else
  echo "PASS: bundled terminal fonts are allowed by the native CSP"
fi

exit "$status"
