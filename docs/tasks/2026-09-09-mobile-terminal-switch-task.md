# Mobile cross-Session terminal restoration

## Contract
Fix loss/overlap when switching A → main → B → main → A without focusing input or scrolling to repair it. Do not stop any existing Host/Session. Preserve unrelated changes; install the verified mobile build directly on the connected iPhone, not TestFlight.

## Evidence
- Same-Session navigation did not exercise terminal replacement. Cross-Session navigation reproduced the fault on the physical iPhone.
- Bad frame: xterm and DOM both lack transcript rows; pending parser writes = 0; 47×53 matches Host geometry. Screenshot `/tmp/agentport-ios-render-cross-session.png` also shows an ANSI parameter fragment.
- New mobile renderer requests only a raw 64 KiB tail. TUI differential updates are not a screen snapshot. Same-size attachment does not guarantee a remote full redraw.
- Real iPhone xterm controlled replay: 130047-byte complete stream retains `HISTORY_MUST_SURVIVE`; 65536-byte suffix at identical geometry loses it.
- Clicking input changed rows and elicited remote full redraw. Not evidence that a local refresh repairs the buffer.

## Repair scope
Use bounded in-memory serialized screen + matching consumed cursor for warm cross-Session restoration, following the desktop checkpoint approach. Fence parser drain, late captures/events, rapid reselect, run changes and geometry. Preserve parser prefixes and mouse encoding omitted by serialization. No hidden terminals or background subscriptions retained.

Cold first-open / cache eviction / expired Host-tail recovery remain bounded raw replay: this change does not invent a complete screen from an arbitrary tail. Do not claim those separate cases solved.

## Work
- [x] Checkpoint storage and regression guards
- [x] Terminal capture/restore lifecycle and Workspace cursor integration
- [x] Targeted tests, build, adversarial review
- [x] Direct iPhone install and physical A/B switching acceptance
- [x] Task-only commit (this document is included in the fix commit)

## Verification
- Old HEAD Workspace fails `restores a replaced terminal screen...`: no screen checkpoint survives release. Candidate passes with queued output included and `resumeFrom` exactly matching the captured consumed cursor.
- Real xterm tests compare restored full screen/cursor against continuous parsing, including splits inside UTF-8, CSI, OSC and character-set selection. Unsafe control prefixes and oversized strings skip capture rather than replay side effects twice.
- Cache: at most 8 serialized entries / 8 MiB, LRU, failed/late capture fencing; no LocalStorage persistence. Old runs and replay resync invalidate checkpoints.
- `cd mobile && npm test`: **32 files / 347 tests pass**. jsdom emits its existing Canvas getContext unsupported diagnostic; real buffer/serializer tests do not use a Canvas renderer.
- `npm run build` and physical iOS debug archive build passed; codesign verification passed. Installed and launched `com.agentport.mobile` at 19:44 CST. Generated tracked files restored from pre-build copies; TestFlight build unchanged.
- Physical acceptance: 8 alternating opens between live `Mobile` and `herdr`, all live at 47×53; returning Mobile retained 37 nonempty rows each time, without input focus or scrolling. Screenshot `/tmp/agentport-checkpoint-iphone-acceptance.png` confirms transcript and input frame intact. Original alternate target `desktop` was no longer in Active Sessions, so the script stopped on missing-card and was rerun against `herdr`; that stopped run is not counted.
- Existing Hosts and Sessions were not terminated. No desktop code changed, so no desktop bundle replacement was needed.
- A later optional mouse-mode inspection/temporary-reference cleanup was unavailable because AgentPort was no longer inspectable. Diagnostic trace listeners had already expired; remaining `window.__agentport*` metadata references disappear with page teardown. No diagnostic hooks were added to production.

## Remaining boundary
This is a warm-switch repair, not a Host screen-snapshot protocol. Cache misses (first open, memory eviction, app restart), unsafe parser-prefix captures, and output gaps beyond the Host retained tail still fall back to raw bounded replay. A complete cold-state solution remains separate work.
