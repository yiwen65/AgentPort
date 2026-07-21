# AgentPort fixed short scrollbar QA

## Evidence

- Source visual truth:
  `/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/codex-clipboard-3f56560a-c026-4038-b53d-5372c5224f3c.png`.
- Rendered native implementation screenshot:
  `ui-audit-theme-regression/77-short-scrollbar-final-72px-light.jpg`.
- Focused implementation crop:
  `ui-audit-theme-regression/78-short-scrollbar-final-72px-focused.jpg`.
- Focused side-by-side comparison:
  `ui-audit-theme-regression/79-short-scrollbar-final-72px-comparison.png`.
- Drag-range evidence:
  `ui-audit-theme-regression/67-short-scrollbar-drag-range.jpg`.
- Viewport: 1152 x 768 native macOS application capture. The source was a
  120 x 585 crop; the final implementation was cropped to the same dimensions
  and aligned to the same scrollbar position for focused comparison.
- State: Light theme, real `seq 1 200` Session, 25% scroll position. The same
  Session was tested at 0% and 100% in Dark and Light themes.

## Findings and comparison history

### Pass 1 - blocked

- **P1 / interaction:** the xterm native proportional thumb did not provide the
  requested fixed short handle or whole-history drag mapping.
- **P2 / visual fidelity:** the first custom handle was 64 px, 5 px wide, too
  dark in Light theme, and inset too far from the window edge.
- **P2 / track artifact:** xterm's fractional right gutter remained visibly
  tinted, reading as a full-height scrollbar track behind the short handle.

### Fixes

- Replaced the native visual thumb with a fixed 72 px overlay handle and a
  transparent 14 px hit target.
- Mapped the handle's complete travel directly to xterm's complete scrollback;
  dragging to either endpoint calls `scrollToTop` or `scrollToBottom` exactly.
- Added pointer capture and synchronous drag state so a single fast gesture
  remains active even when the pointer outruns React rendering.
- Added keyboard operation for Arrow, Page Up/Down, Home, and End and exposed
  an accessible vertical scrollbar value.
- Calibrated the Light thumb to the source's measured pale grey, width, length,
  and right-edge spacing.
- Painted the terminal host's fractional gutter with the terminal surface,
  removing the long tinted strip while preserving the invisible drag target.

### Pass 2 - passed

- The final focused comparison shows only a pale short line; no full-height
  track, border, or shadow remains.
- Source and implementation handle geometry and tone are visually aligned. The
  implementation intentionally omits the source crop's window divider because
  the prior requirement removed the Session-body vertical divider.
- A real drag moved the Session from 100% to 0% and back, and a single long drag
  reached 25% without incremental wheel scrolling.
- Keyboard Home and End reached 0% and 100% after tab-focusing the scrollbar.

## Required fidelity surfaces

- **Fonts and typography:** unchanged. Terminal family, CJK fallback, size,
  weight, line height, and antialiasing are outside this scrollbar-only change.
- **Spacing and layout rhythm:** the fixed 72 px handle, right-edge spacing, and
  14 px hit target match the compact reference without changing terminal
  padding or Session layout.
- **Colors and visual tokens:** Light uses the measured pale grey thumb on a
  continuous white terminal surface; Dark retains a theme-aware translucent
  thumb. There is no visible track or shadow in either theme.
- **Image and asset quality:** no images, logos, icons, or raster assets were
  added or replaced.
- **Copy and content:** no application copy changed; the accessibility label is
  `Session 历史滚动位置`.
- **Interaction and accessibility:** pointer capture, full-range mapping,
  keyboard controls, ARIA min/max/current values, and focus-visible treatment
  were verified.

## Verification

- `npm run build`: passed.
- `npm audit --omit=dev`: passed with 0 production vulnerabilities.
- `cargo fmt --all -- --check`: passed.
- `cargo test --workspace`: passed (123 core tests and 10 host integration
  tests; no failures).
- Tauri Debug `.app` and `.dmg`: built successfully.
- Cold-started the final Debug application and verified the real Session with
  Computer Use in Light and Dark themes.
- Primary interactions tested: fast pointer drag, exact top/bottom endpoints,
  intermediate position mapping, keyboard Home/End, theme switching, terminal
  scrolling, and return-to-bottom behavior.
- Runtime errors checked: no renderer failure, error overlay, or broken state
  was visible during the final native interaction pass.
- Code review across correctness, readability, architecture, security, and
  performance found no actionable issue.

No actionable P0, P1, or P2 issue remains.

final result: passed
