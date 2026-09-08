# Projects viewport and scrolling

The mobile app uses a fixed body/root frame. `.main-content` owns dashboard
vertical scrolling; the document must not scroll. The toolbar remains sticky
inside that scroller. Session viewport and IME code are unchanged.

`SessionDashboard` saves the inner offset per device, restores it only after the
matching device snapshot is committed, and does not restore again on polling.
A pending offset survives unmount before the first data reply. No per-scroll
storage writes or animation-frame restoration callbacks are used.

The native app viewport explicitly fixes scale at 1. CSS `touch-action: pan-y`
alone did **not** prevent WKWebView pinch zoom. This intentionally disables page
pinch magnification throughout the app, not text selection or native editing;
it is not a claim of web zoom accessibility compliance.

## iPhone verification (2026-09-08)

On iPhone 17 Pro Max / iOS 26.6, 440 × 956 CSS viewport:

- Original folded dashboard: body/main height 956 but document scrollHeight
  2080; window scrollY 127. Folded grid contents correctly measured height 0.
- Hiding the hidden terminal stage did not remove excess document height.
- Root overflow:hidden plus an inner scroller alone still left document height
  2326. Adding a fixed body reduced document height to 956.
- With the fixed frame, a 38-row expansion produced inner height 2613 and bottom
  offset 1657. Folding at the bottom clamped both to 956/0; root stayed 956/0.
- Physical gesture test with CSS only: 17 multitouch starts, maximum viewport
  scale 4.9829, root excess up to 798 and root offset up to 527. CSS-only repair
  was rejected.
- With the explicit viewport scale limits: 81 touch starts including 46
  multitouch starts; 658 dashboard samples, scale always 1, root excess and
  root offset always 0. Inner scrolling still reached offset 124.
- Final archive installed/reopened with the viewport metadata embedded (no CSS
  probe). Dashboard root/client/main height 956, scale 1, root offset 0;
  screenshot confirmed nonblank rendering, including the Recent modal.

The precise WebKit internal trigger for the original excess height was not
established. Keyboard-open/close, rotation, and terminal IME physical regression
coverage is not complete; do not infer it from the dashboard captures.

## Regression checks

`npm test` in `mobile/`: 320 passed. `npm run build` and signed iOS debug archive
passed. New CSS/viewport and scroll-restoration guards failed against the old
implementation. Tests cover delayed device data, switching, late old-device
responses, unmount, and ordinary refresh preserving the user's offset.

To retest physically: expand a long project, scroll to its end, fold it, then
pinch and drag both content and empty background. Inspect `visualViewport.scale`,
`documentElement.scrollHeight`, `window.scrollY`, and `.main-content` scroll
metrics. Exclude terminal-visible samples; JS-dispatched clicks/scrolls cannot
stand in for physical pinch testing.
