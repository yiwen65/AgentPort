# Mobile foreground recovery and bounded refresh

## Contract and cause

User reported a terminal that stopped receiving logs after spending minutes in the background, while navigation remained responsive, plus slow refresh. Authorized repair after read-only review.

Three relevant paths were missing bounds/recovery:

1. Workspace visibility changes only acknowledged opening. Reattach required observing reconnecting/disconnected then connected; a suspended WebView could miss these events.
2. Ordinary native requests waited indefinitely for the writer and reply. Dashboard shared the in-flight refresh promise, so later refreshes inherited the wait. Input submission had the same unbounded writer/result waits. AbortSignal only checked before submission.
3. Remote Session list probed Hosts sequentially, with a 5-second handshake timeout each, delaying other serialized Bridge requests.

## Changes

- A shared foreground hook replaces only the selected device's phone transport after a hidden→visible transition. Workspace and dashboard recovery coalesce per client/host. No Host/Agent restart or automatic mutation replay.
- Workspace invalidates old attachment events/input, retains terminal/cursor, and reattaches once even if native connection events are missed or delivered. Explicit failed-connection retry also rebuilds the transport. Short deliberate disconnection during recovery stays labeled reconnecting.
- Read and attach/detach/control requests have a 15-second deadline covering writer queue/write/result. Other mutations allow 120 seconds. Input write and result each have a 15-second bound. Expiry removes pending requests and retires only the matching connection generation; siblings are failed instead of left hanging. A submitted mutation/input is reported unknown, never silently replayed. Transport close itself has a 2-second bound.
- AbortSignal cancels an in-flight JS wait and ignores a late result. It does not claim cancellation of a submitted server operation; native deadlines still bound cleanup.
- Session list checks at most four Hosts concurrently, skips terminal historical Sessions, and limits further probe scheduling to eight seconds. A handshake already started may take its five-second timeout (approximately 13 seconds of probe work in the slow boundary case, not a hard 8-second end-to-end SLA). Budget exhaustion fails the read instead of labeling unchecked Hosts dead. Single-Session summary behavior and identity checks remain shared.

## Verification

- Foreground regression failed against the old Workspace: no reconnect after hidden→visible with missed events. New test restores from the consumed cursor, retains one terminal renderer, and asserts exactly one reattach, with both missed and delivered native events.
- Additional tests cover dashboard foreground recovery, coalesced recovery/failure retry, local abort/late response, writer-queue and result deadlines, conservative mutation outcome, obsolete-generation fencing, pending release, list-budget failure and skipping ended history.
- Mobile frontend: 355 tests passed, TypeScript/Vite build passed.
- Mobile native: 29 tests passed, including real SSH/SFTP/Relay fixtures.
- Service: 33 tests passed.
- Real bundled Bridge fixture: four task-created Hosts deliberately suspended to withhold handshake replies; Session list completed in 5.002 seconds. Only those private fixtures were resumed, archived and deleted. Evidence helper: `/tmp/agentport-parallel-status-fixture.py`.
- Physical iPhone: retained live terminal backgrounded by opening Settings for 138.630 seconds. Foreground event to live was 1.149 seconds; new output arrived without visiting dashboard, focusing input or sending input. `/tmp/agentport-recovery-phone-after.log` records the state timeline; screenshot confirms nonblank output. A final polish kept the intentional reconnect transition from briefly showing failed and retained immediate post-framing value wiping; full suites reran afterward.
- Final signed iPhone archive installed at 01:25 CST. A second 52.308-second background cycle returned through reconnecting → attaching → live in 0.818 seconds, with fresh output. `/tmp/agentport-recovery-final-phone.log` records it; temporary listeners were removed. Its screenshot has sparse upper terminal content after the intervening cold reinstall, so it is evidence of live output, not complete historical-screen recovery. Existing tracked generated-project/schema changes were preserved.
- Desktop/Bridge rebuilt and signed via `scripts/restart-debug-app.py`. Exact debug GUI PID 88939 verified; `/tmp/agentport-recovery-desktop.png` captured its window. No user Host/Agent was stopped, resumed, restarted or signaled.

## Limits

No TestFlight upload. One multi-minute physical background cycle, not an exhaustive cellular/Wi-Fi/Relay outage matrix. Cold terminal replay limitations remain unchanged. A true transport failure or request deadline can still leave a submitted long-running mutation's outcome unknown; the UI must not automatically retry it. Refresh is bounded, not guaranteed instantaneous on an unavailable network; native connect still has its existing 30-second deadline.
