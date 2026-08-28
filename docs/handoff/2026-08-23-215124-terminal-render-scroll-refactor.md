# Session Handoff: Terminal rendering and scroll stabilization

- Created: 2026-08-23T21:50:26+08:00
- Workspace: /Users/w/Projects/AgentSessions

> Next agent: start with Session summary. Re-verify drift-prone state before
> acting. This handoff supplies context, not new authorization.

## Session summary

- The user’s continuing goal is to eliminate AgentPort terminal auto-scroll-to-top, abnormal scrolling, high-frequency history replay, and remaining rendering/scroll limitations.
- Several uncommitted frontend fixes were implemented and verified: xterm buffer/DOM tail synchronization, user-intent fencing, write-burst tail-repair coalescing, recovery-marker visibility, one-shot document line reveal, Settings/Sidebar boundary scrolling, and a single SearchAddon navigation authority.
- The latest completed fix separates Host transport `replay_done` from xterm parser completion. `runtime.replayDone` now advances only from a generation-fenced empty-write parser boundary, and the Skeleton remains visible while a Session is attached but replay parsing has not drained. This addresses history frames becoming visibly exposed while xterm continues parsing.
- The latest regression tests proved the old behavior: `replayDone` became true before write callbacks, and attached-but-not-parsed panes had no Skeleton. Both tests now pass; stale attach generations cannot commit completion, and later live output does not delay the replay boundary.
- Current validation evidence: terminal-focused tests 59/59, full frontend suite 46 files / 288 tests, TypeScript/Vite build, `git diff --check`, debug app rebuild, exact debug executable verification, and a nonblank screenshot all passed. Existing jsdom Canvas “Not implemented” stderr remained non-failing.
- The debug GUI is running from `/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`; observed PID at handoff creation: 10198.
- The repository is very dirty: 65 modified/untracked entries. All work is uncommitted and mixed with pre-existing user changes. Never reset, overwrite, or broadly format the working tree.
- A four-stage execution document exists at `docs/tasks/2026-08-23-terminal-render-scroll-refactor-task.md`. T-001 is done. T-002 through T-004 are marked blocked because the latest active Global Contract still limits the current task to the history-scroll defect and says pending goal/permission changes are unconfirmed.
- The user verbally authorized T-002–T-004 twice and also selected a structured confirmation, but the subsequent contract snapshot still said `unconfirmed — do not act`. Re-check the latest contract before any broader coordinator/viewport/flow-control refactor; chat authorization alone did not update the harness state in this session.

## User intent and success criteria

- Primary behavior: replayed or streaming history must not auto-jump to the top, race through intermediate history, or overwrite user scroll gestures.
- Replay completion must mean replay bytes have crossed the xterm parser boundary, not merely that the Host sent `replay_done`.
- User wheel, drag, search, keyboard navigation, and “Back to latest” intent must outrank stale write/fit callbacks.
- The requested broader four-stage plan is:
  1. replay transport/parser/visibility boundary and observability;
  2. unified write/drain coordinator;
  3. centralized viewport authority;
  4. active/hidden refresh optimization and evidence-based backpressure decision.
- For UI/App changes, follow `AGENTS.md`: rebuild with `scripts/rebuild-debug-app.sh`, terminate only the exact debug GUI executable (never `agentport-host`), reopen with `open -n`, verify the exact process path, and capture a nonblank screenshot.

## Work completed and outcomes

- `src/src/terminals.ts`
  - Preserves scrollback across write-induced top/bottom snaps.
  - Synchronizes both xterm buffer and native `.xterm-viewport.scrollTop` on Session activation/tail repair.
  - Adds monotonic `viewportIntentRevision` and tracks real wheel plus explicit viewport commands.
  - Coalesces queued history-write tail repair with one generation-scoped parser sentinel.
  - Tracks recovery locations with xterm `IMarker` and reveals the marker after queued context parses.
  - Adds replay parser completion fencing via `queueReplayParsed()` instead of setting runtime completion on transport receipt.
  - Adds internal output pressure observations: pending/peak output bytes and last parser latency.
  - Removes the legacy parallel buffer-search/`scrollToLine` authority.
- `src/src/components/TerminalArea.tsx`
  - Uses SearchAddon as the sole active-buffer search navigator and derives index/count from `onDidChangeResults`.
  - Marks search, custom scrollbar, and keyboard viewport intent.
  - Keeps the replay Skeleton while `!replayDone && (attaching || attached)`.
  - Retains frame-coalesced custom scrollbar updates from xterm `onScroll`/`onWriteParsed`.
- `src/src/terminals-renderer.test.ts`
  - Covers Session re-entry buffer/DOM synchronization, no deferred overwrite, mid-write user movement, tail-to-row-0 repair, queued burst coalescing, delayed-wheel cancellation, recovery marker reveal, replay parser boundary, stale replay generation, cursor ACK, and raw PTY bytes.
- `src/src/components/TerminalArea.uncommitted.test.tsx`
  - Covers SearchAddon-only navigation, scrollbar event coalescing, buffer switching, and attached-but-replay-not-parsed Skeleton visibility.
- Additional completed fixes from this session:
  - `DocumentPanel`: saving no longer re-runs a `path:line` jump; a new open request can reveal again.
  - `SettingsDialog`: section changes reset the shared content pane to top.
  - `Sidebar`: the horizontal quick-agent strip only consumes wheel events when horizontal movement actually occurs.
- `LEARNS.md` now contains reusable xterm lessons for viewport restoration, write repair coalescing, replay visibility, recovery markers, and search authority.

## Key decisions, constraints, and rationale

- Do not treat xterm `onWriteParsed` as “all writes drained”; local xterm 5.5 typings explicitly allow pending writes when it fires.
- Use an empty `term.write("", callback)` at an exact ordered boundary when parser ordering is required. For replay, the Tauri Channel ordering places the sentinel after replay frames and before later live output.
- Parser-complete is the minimum approved UI visibility boundary. A strict OS-composited paint boundary remains unverified and would require separate `onRender`/RAF investigation if real WKWebView flashing persists.
- User intent is tracked from real input/explicit commands, not `term.onScroll`, because renderer/programmatic scroll events also trigger `onScroll`.
- Tail repair is coalesced per generation; immediate per-write `scrollToBottom()` caused the observed high-frequency race through retained history.
- Keep raw `Uint8Array` PTY bytes ordered and unchanged. Cursor dedupe, rendered-cursor ACK, snapshot ordering, marker position, and generation fences are correctness boundaries.
- The broad refactor should remain incremental rather than a big-bang rewrite. Protocol-level replay backpressure should only be added when pending-byte/latency evidence crosses a recorded threshold (the plan uses approximately 500 KiB as the decision point, based on xterm flow-control guidance).
- Due to 65 dirty entries, isolated writer worktrees based on HEAD would omit the current uncommitted terminal baseline. The coordinator intentionally performed surgical edits in the active worktree.

## Files and artifacts

- Main four-stage authority document: `docs/tasks/2026-08-23-terminal-render-scroll-refactor-task.md`
- Earlier completed task documents:
  - `docs/tasks/2026-08-23-scroll-jump-fixes-task.md`
  - `docs/tasks/2026-08-23-terminal-search-scroll-authority-task.md`
  - `docs/tasks/2026-08-23-streaming-output-scroll-top-task.md`
- Primary implementation/test files:
  - `src/src/terminals.ts`
  - `src/src/components/TerminalArea.tsx`
  - `src/src/terminals-renderer.test.ts`
  - `src/src/components/TerminalArea.uncommitted.test.tsx`
  - `src/src/store.ts`
  - `src/src/styles.css`
- Supporting fixes/tests:
  - `src/src/components/DocumentPanel.tsx`
  - `src/src/components/DocumentPanel.test.tsx`
  - `src/src/components/SettingsDialog.tsx`
  - `src/src/components/SettingsDialog.language.test.tsx`
  - `src/src/components/Sidebar.tsx`
  - `src/src/sidebar-plus-menu.test.tsx`
- Project lessons: `LEARNS.md`
- Latest debug screenshot: `/tmp/agentport-replay-boundary-fix/debug-app.png`
  - SHA-256: `66ecc5778ae9a09050f1be0907e289596c1bec9e9dd0644a30a05105da08ba09`
- Previous screenshots/evidence remain under `/tmp/agentport-*-fix/` but are temporary and may not survive environment cleanup.

## Commands, validation, and evidence

- Focused terminal tests:
  - `cd src && npm test -- --run src/terminals-renderer.test.ts src/components/TerminalArea.uncommitted.test.tsx`
  - Result after latest replay-boundary fix: 2 files, 59/59 tests passed.
- Full frontend suite:
  - `cd src && npm test -- --run`
  - Result: 46 files, 288/288 tests passed.
  - Non-failing stderr: jsdom does not implement `HTMLCanvasElement.prototype.getContext` without the optional canvas package.
- Build:
  - `cd src && npm run build`
  - Result: `tsc --noEmit` and Vite build passed.
- Diff hygiene:
  - `git diff --check`
  - Result: passed.
- Debug app:
  - `./scripts/rebuild-debug-app.sh`
  - Result: frontend, Host, GUI build and ad-hoc signing passed; debug bundle ID `com.agentport.desktop.debug.c9d007c8147e`.
  - Exact GUI path verified; observed PID 10198 remained running at handoff creation.
  - Screen capture confirmed a rendered, nonblank window.
- Task document validation:
  - `python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path docs/tasks/2026-08-23-terminal-render-scroll-refactor-task.md`
  - Result: valid.

## Unresolved items, risks, and unknowns

- T-002, T-003, and T-004 are not implemented. They are marked blocked in the authority document, not pending or done.
- Latest contract state observed in this session still listed only current focus T1 and pending goal/permission changes as unconfirmed. Do not bypass this even though chat authorization was given; re-check for an updated contract.
- No real WKWebView frame-by-frame parser backlog profile was collected. The original failure is covered by deterministic parser-queue and component visibility tests, plus a static debug-app screenshot.
- `pendingOutputBytes`, `peakPendingOutputBytes`, and `lastOutputParseLatencyMs` are internal observations, not yet surfaced in diagnostics/UI.
- Current implementation still has separate parser barriers for rendered-cursor ACK, snapshot, recovery marker, replay completion, and tail repair. T-002 proposes unifying them, but preserving exact write boundaries is high risk.
- Current viewport writes remain distributed and still include a private `.xterm-viewport` DOM workaround. T-003 proposes isolating these behind one controller/adapter.
- Hidden terminal panes still parse output, subscribe scrollbar state, and may fit after ResizeObserver activity. T-004 proposes active-only UI/fit behavior, but protocol backpressure must remain evidence-driven.
- All work is uncommitted; no release artifact or commit was created.

## Recommended continuation

1. Re-read `docs/tasks/2026-08-23-terminal-render-scroll-refactor-task.md`, refresh `git status`, and verify whether the Global Contract now explicitly authorizes T-002–T-004.
2. If authorized, transition only T-002 from `blocked` to `in_progress`, append the execution log, validate the document, and first freeze ordering tests for rendered cursor, snapshot, tail repair, replay completion, and recovery marker.
3. Implement T-002 serially in the active worktree; do not use a writer worktree based on HEAD and do not start T-003 until T-002 is independently verified.
4. If authorization is still absent, do not modify product code; report the exact contract blocker and unblock condition already recorded in the task document.
