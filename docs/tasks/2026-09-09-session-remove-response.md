# Responsive Remove on desktop and mobile

## Contract

Confirmed Remove of a live Session should leave the list/dialog/active pane immediately, without waiting for safe process termination. Other UI operations already remained responsive. Preserve archive-before-delete, the backend stop grace and verified cleanup. On failure report the error and recover navigation without overriding subsequent user choices. Never remove existing user Sessions for testing.

## Cause and evidence

An isolated real bundled Bridge/Host fixture (`/tmp/agentport-remove-latency.py`, private temporary HOME/data, fake Codex) measured archive at 120–124 ms when SIGINT was handled, versus 3158–3202 ms when ignored; permanent delete took 1 ms. Host logs locate the difference in the existing 3000 ms safe-stop grace. This is interaction latency, not a global rendering freeze. No backend termination timing or safety fence was changed.

Desktop already filtered archiving Sidebar rows but retained the selected pane until completion. Mobile retained both confirmation and row while awaiting archive/delete. New immediate-response regressions failed against the respective old production files before the repair.

## Implementation

- Desktop leaves the target pane immediately and selects a remaining Session if necessary. Stop failure restores the previous layout only if selection intent and layout remain unchanged. Delete failure after successful archive refreshes authoritative state rather than resurrecting a live pane.
- Mobile hides confirmed pending removals and dismisses the confirmation. Per the user's follow-up, background removal is silent; only failures show a message. Pending filters survive stale refresh snapshots until mutation and refresh complete. Failures surface in the dashboard. Host/Session-keyed actions isolate independent menus; an earlier completion cannot close another Session's menu.
- Backend archive → verified stop → permanent delete ordering is unchanged. Actual process cleanup can still take approximately three seconds.

## Verification

- Mobile: all 350 tests passed; TypeScript and Vite build passed.
- Desktop: 41 focused selection/state-authority tests passed; TypeScript and Vite build passed. Added singleton, split/nonfocused-pane, failure/navigation, and archive-success/delete-failure coverage.
- Desktop full suite: 556 passed, 9 failed in App notification/native-cleanup/git-center-mount suites (`metadata` access in the test environment). The same nine failures reproduce with HEAD's unchanged `actions.ts`; unrelated tests were not modified.
- Mobile concurrency regression initially exposed retained local `removing` state when opening another menu. Host/Session component keys corrected this; all 43 dashboard/action tests pass.
- Built and signed both Apps. Desktop restarted exclusively through `scripts/restart-debug-app.py`; exact GUI PID 37216 executable verified as the checkout's debug bundle. No user Host/Connector was signaled.
- Installed and launched iPhone build at 21:14 CST, September 9. Inspector screenshot `/tmp/agentport-remove-iphone-window.png` confirms a connected, nonblank project dashboard.
- Desktop screenshot initially blocked by confirmed macOS lock screen; this is not evidence of a blank WebView. User asked to unlock for final visual confirmation.
- Immediate removal and failure/concurrency behavior validated with controlled frontend promises; no existing user Session was removed for acceptance. No claim of a completed physical Remove gesture trial.

## Scope

No TestFlight upload, backend stop policy change, SSH change, native IME change, or unrelated cleanup. Existing generated iOS project/schema edits were backed up and restored during the build.
