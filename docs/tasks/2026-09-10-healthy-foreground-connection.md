# Preserve healthy foreground connections

Status: verified. User requested a fix for forced disconnect/reconnect on every terminal foreground transition. No subagents, no Host/Agent lifecycle changes.

## Cause and red evidence

`useForegroundRecovery` unconditionally called onStart then `recoverConnection`, whose first operation is `client.disconnect`. Even a fully usable connection therefore lost its attachment and required connect, attach, snapshot/replay, and a render veil. The regression `keeps a healthy foreground connection, attachment and terminal immediately usable` failed with one disconnect call before the change (`/tmp/agentport-healthy-foreground-red.log`).

## Repair

- First issue a cheap existing read-only Bridge request (`agent.preferences`), never infer liveness solely from a cached connection flag.
- The probe is coalesced by client+host and bounded to1500ms independently of native waits. Completion clears its timer/aborts the local wait; late results cannot initiate another recovery.
- Healthy: preserve transport, attachment, cursor, mounted xterm, and normal input; do not show a recovery veil. No health-probe wait is inserted in the input path.
- Rejected/timed-out: enter the existing bounded transport replacement and generation-fenced terminal restore. No mutations or keystrokes are replayed.
- Generation/active/visibility/unmount fences stop obsolete probes from replacing a connection after another background transition or device/page switch.
- Dashboard uses onChecking to pause its metadata reads until the probe/recovery settles. Its previous transient-error fix remains intact. The recovery's own native disconnected event cannot deactivate the in-progress operation and leave its spinner stuck; a delayed failed-connect regression covers this boundary. Explicit Retry still replaces the transport as before.

## Validation

- TypeScript and all420 Mobile tests pass (`/tmp/agentport-foreground-health-all-tests.log`), including healthy terminal reuse, failed/timed-out probe fallback, late replies, obsolete/hidden/unmounted/inactive/new-device probes, coalescing, and Dashboard failure/retry coverage.
- iPhone rebuilt and installed18:18; final build including the Dashboard self-disconnect fence installed18:34. Metadata-only temporary method wrappers and RAF samples verified the active Mobile terminal, then were restored/removed:
  - ~5s background: **zero disconnect/connect/attach calls**, probe161ms; all2026 observed visible samples stayed live with no veil. `/tmp/agentport-foreground-healthy-short.json`, `.png`.
  - ~60s background: probe reached1500ms without a reply, then exactly one disconnect/connect/attach recovered the terminal; final screen live and rendered. `/tmp/agentport-foreground-healthy-long.json`, `.png`. This validates fallback, **not** uninterrupted long-background transport. GUI-only restart also occurred during this interval; do not attribute the timeout specifically to iOS or claim the transport was proven dead.
- Long-background recovery can still take time if the check fails or times out; the change removes unconditional recovery, not all real network/transport delay.
- Only the unmodified debug GUI was reopened via `restart-debug-app.py --skip-build`; PID23060 exact executable path verified and `/tmp/agentport-foreground-health-debug.png` confirms nonblank content. No Hosts/Agents were stopped or restarted.
- Apple/schema files were preserved across builds. No unrelated source changes are included.
