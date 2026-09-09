# Desktop stale Active Sessions / endless disconnected check

## Evidence

Affected Session: `ses_01M2353Q1GKPA63K` (`tui-beauty`). At diagnosis SQLite retained `running`, PID 57853, while its matching run-5 `host-state.json` recorded `turn_complete`, `group_cleaned=true`, exit at 2026-09-10 00:15:15 CST. Host log shows `semantic_turn_complete`, completed cleanup and shutdown; neither Host PID 57853 nor Agent PID 57854 existed.

Mobile's verified handshake correctly excluded it from Active Sessions. Desktop derives `hostAlive` from persisted running/creating lifecycle plus a valid PID value, relying on its monitor to reconcile actual termination. Monitor discovery previously ran at GUI boot and desktop create/restart only. An externally created/restarted Session could lack a monitor. Renderer attach failure returned an error without reconciling, and the frontend's follow-up project read returned the same stale lifecycle, perpetuating the checking banner.

## Repair

- Project refresh discovers missing live-session monitors, including external launches. Existing monitor registrations deduplicate repeated refreshes.
- Successful renderer attachment also establishes the independent status monitor.
- Failed renderer attachment invokes existing run/PID-fenced liveness reconciliation before returning. A matching durable exit or verified dead PID ends the session; a transient socket failure with a living Host does not.
- No signal, session restart, mobile filter change, or Host idle-stop policy change.

## Validation

- Desktop Rust tests: 48 passed.
- Core HostManager tests: 17 passed, including retaining a living PID after socket failure, dead-PID reconciliation and idempotent interruption events.
- Renderer tests: 117 passed, including attach-failure refresh / terminal-state retry handling.
- Safe debug rebuild/restart completed; GUI PID 29307 exact bundle executable verified. Nonblank screenshot: `/tmp/agentport-stale-active-fixed.png`.
- A read-only post-restart DB check shows the affected Session is now `exited`. Its dead Host was not restarted. GUI boot also reconciles state, so this alone is not an isolated end-to-end test of the new discovery wiring.
- New command wiring is covered by compilation, code-path inspection and the existing reconciliation/renderer tests; no new GUI-closed external-launch end-to-end fixture was added in this bounded repair. No unrelated working-tree changes were included.
