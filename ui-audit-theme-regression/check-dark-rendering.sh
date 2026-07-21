#!/usr/bin/env bash
set -euo pipefail

audit_dir=$(cd "$(dirname "$0")" && pwd)
implementation=${1:-"$audit_dir/18-agentport-dark-font-final.jpeg"}
surface_reference="$audit_dir/00-unpeel-dark-user-reference.png"
font_reference="$audit_dir/03-unpeel-agent-session-font.jpeg"

for image in "$implementation" "$surface_reference" "$font_reference"; do
  if [[ ! -f "$image" ]]; then
    echo "missing visual evidence: $image" >&2
    exit 2
  fi
done

surface_target=$(
  magick "$surface_reference" -crop 500x400+500+180 \
    -colorspace HSL -channel B -separate +channel -format '%[fx:mean]' info:
)
surface_actual=$(
  magick "$implementation" -crop 500x400+500+180 \
    -colorspace HSL -channel B -separate +channel -format '%[fx:mean]' info:
)

# Both captures come from the same 1200x800 native window size (Computer Use
# returns a 1152x768 JPEG for the implementation). The edge metric is a lower
# bound for softness only; final weight/spacing fidelity is judged from the
# paired full-view comparison because the terminal strings intentionally differ.
font_target=$(
  magick "$font_reference" -crop 130x26+292+308 -colorspace Gray \
    -contrast-stretch 5%x5% -edge 1 -evaluate Abs 0 -format '%[fx:mean]' info:
)
font_actual=$(
  magick "$implementation" -crop 130x26+292+79 -colorspace Gray \
    -contrast-stretch 5%x5% -edge 1 -evaluate Abs 0 -format '%[fx:mean]' info:
)

awk \
  -v surface_target="$surface_target" \
  -v surface_actual="$surface_actual" \
  -v font_target="$font_target" \
  -v font_actual="$font_actual" '
  BEGIN {
    surface_delta = surface_actual - surface_target
    font_ratio = font_actual / font_target
    printf "surface target=%.4f actual=%.4f delta=%.4f\n", surface_target, surface_actual, surface_delta
    printf "font edge target=%.4f actual=%.4f ratio=%.3f\n", font_target, font_actual, font_ratio
    failed = 0
    if (surface_delta > 0.04) {
      print "FAIL: dark workspace is visibly foggier than Unpeel"
      failed = 1
    }
    if (font_ratio < 0.95) {
      print "FAIL: Agent Session glyph edges are visibly softer than Unpeel"
      failed = 1
    }
    if (!failed) print "PASS: dark surface and Agent Session font rendering"
    exit failed
  }
'
