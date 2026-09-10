# Dashboard foreground refresh recovery

Status: verified. User authorized the fix. No Host/Agent restart or mutation; no subagents.

## Root cause

- Foreground recovery invalidated the old refresh epoch, but did not prevent the visibility/connection effects from starting new reads while disconnect/connect was pending.
- The deterministic regression delayed disconnect and observed **5 selected-host reads** (Session list, three metadata calls, attention poll) against the retiring transport. The assertion requiring zero reads failed before the fix (`/tmp/agentport-dashboard-recovery-red.log`).
- `useAttentionInbox` formatted plain native rejection objects using `String(failure)`, producing `[object Object]` rather than their `message`.

## Changes

- A synchronous per-device recovery guard fences Dashboard requests before foreground effects run. Existing epochs continue to reject late results.
- Inbox polling treats only the recovering device as reconnecting; other devices remain independent.
- Existing rows stay visible; stale error presentation is cleared/withheld during recovery. Successful reconnection starts fresh reads. A real connection/read failure still shows Retry; failure updates connection state so Retry reconnects rather than rereading a dead transport.
- Native errors share a bounded message extractor; arbitrary objects are never coerced or dumped into UI.
- Existing icon work in the same files was preserved and committed separately by its owning session (`b85424b`), not folded into this fix.

## Verification

- TypeScript and all **408 Mobile tests** passed at17:36. Final focused rerun at17:59: **53/53** pass. Coverage includes paused Dashboard/inbox reads, successful recovery, genuine connect/read failures with working retry and retained rows, and native-object error messages.
- A later full run at17:57 had405 passes/3 failures, all desktop/mobile artwork-equality assertions for amp/gemini/kiro_cli while another session was updating those assets. Those unrelated files were not repaired or staged here. The final53 focused tests remain green; this report does not claim the concurrently changing full tree is all-green.
- iPhone build/install succeeded (final install17:57). One observed active-list background cycle (about15s) recorded35 DOM samples, no error banner/object text, retained rows, and busy→idle in about1.1s after foreground. Screenshot: `/tmp/agentport-dashboard-recovery-final.png`; trace: `/tmp/agentport-dashboard-watch-result.log`.
- A second intended Project-list cycle recorded no error text but the page was switched to a terminal during observation; it is **not counted** as complete Project-list visual acceptance. Project-list behavior uses the same tested recovery seam. No general network-outage/long-suspension success claim.
- Temporary Inspector observers were stopped/deleted. No Agent inputs or lifecycle commands were sent.
- Unmodified desktop debug GUI reopened only through `scripts/restart-debug-app.py --skip-build`; PID52764 exact executable path verified, `/tmp/agentport-dashboard-debug.png` confirms rendered content.
- Generated Apple/schema files restored from their pre-build copies. Unrelated dirty files remain uncommitted.
