# Cross-client Restart reconciliation

Status: done (component/build validation; live two-client acceptance remains manual).

## Cause and scope

Run-scoped subscriptions terminate at exit. Mobile's locally-stopped latch disabled attachment/subscription, so an external Restart could not clear its ended page. Desktop lacked discovery of externally changed durable lifecycle, and visible PTY/structured attachment effects did not depend on lifecycle changes.

## Change

- Mobile: only an active ended workspace polls the existing read-only session.list API every 2 seconds after the previous read completes. Confirm running/creating plus authoritative hostAlive before clearing old replay state and attaching. Cancel late responses on hiding/unmount/local actions. Do not send Restart/Stop/input.
- Desktop: visible ended panes share one non-overlapping projects refresh timer; remove it when no ended pane remains. Lifecycle changes trigger PTY and structured reattachment.
- Normal live workspaces do not acquire a new polling loop. This is bounded fallback reconciliation, not a new global lifecycle push protocol. Large session collections still incur list-read cost while an ended page is visible.
- Preserved the four pre-existing dirty files; no existing user Session was restarted or given input.

## Verification

- Mobile full suite: 176 passed. Regressions cover external running snapshot, attach-only behavior, polling termination, bounded in-flight reads and ignored late response after hiding.
- Desktop targeted suite: 28 passed across pane/structured attachments, shared polling and project snapshot authority.
- Both frontend builds, iOS simulator bundle and signed custom-protocol desktop debug rebuild passed.
- Updated simulator app and exact debug GUI (PID 30445 at target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport). Screenshot inspected: GUI renders, Mobile renders Disconnected — Cached. No live SSH/Relay two-end Restart acceptance claimed.
- Evidence: /tmp/ap-cross-restart/. Physical devices and public-network behavior not verified.
