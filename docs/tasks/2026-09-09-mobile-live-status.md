# Mobile-created Session shows Unknown despite Host status

## Cause

Phone inspection identified `pi-18` (`ses_01M235H5SH8R2MAX`) as Unknown. Its live Host journal already contained Working/Idle transitions, while SQLite had no `latest_status` row. The remote service returned only the SQLite projection, discarding `current_status` from the liveness handshake. A mobile-created Session need not have a desktop monitor projecting its events into SQLite.

This is a missing live-status read, not a reason to label every living process Working. At final inspection `pi-18` was idle; the Working report concerned an earlier interval.

## Fix

- `HostManager::live_snapshot` reuses authenticated PID/run-bound handshake validation, reads zero replay bytes without output subscription, and rejects a binding changed during the read. Status must match the handshake's Session and run.
- Remote list and single-Session summaries use the same live-status projection. A current Host snapshot can fill a missing DB status or supersede an older one; newer DB sequence/run data is retained.
- Unavailable Hosts and missing/invalid status snapshots retain DB fallback. No synthetic status, lifecycle mutation, new attention event, or persistent status write is introduced by polling.

## Verification

- Regression initially failed against old behavior: live Host true, expected `Some("working")`, received None.
- Nine fixture cases cover Working, Idle, Needs input, stale DB, wrong run, wrong Session, missing snapshot with/without DB fallback, and newer DB status. Reads assert zero replay and no output subscription.
- `cargo test -p agentport-service`: 33 passed.
- `cargo test -p agentport-core host_manager::tests`: 17 passed.
- Real bundled Bridge/Host fixture, isolated private data/HOME and fake Codex, without any desktop monitor: `session.list` returned Working while SQLite contained zero status rows, then Idle after quiet. Repeated against final bundled binary. Only these disposable fixtures were archived/deleted.
- Built/signed/reopened debug App with `scripts/restart-debug-app.py`; exact GUI PID 39471 path verified. Screenshot `/tmp/agentport-live-status-debug.png` confirms nonblank rendering.
- Phone DOM after deployment reports `pi-18` Idle instead of Unknown and `Mobile` Working. `/tmp/agentport-live-status-phone.png` confirms nonblank terminal rendering, not a visible dashboard badge screenshot. A later Inspector attempt after reconnect was unavailable; no repeated blind attempts.
- Existing `pi-18` Host PID 51795 remained alive. No existing user Session was stopped/restarted. Phone GUI was relaunched to reconnect to the updated Bridge; no mobile binary or TestFlight upload required.

## Limits

The fix exposes the Host's existing classification; it does not improve PTY/semantic state detection itself or implement background journal-to-DB history projection. Legacy Hosts with no status snapshot still use DB fallback.
