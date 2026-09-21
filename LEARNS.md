# Project Learnings

## `fullscreen Pi attach` — a bounded replay tail cannot rebuild a differential screen

- Wrong approach: Bounding the fullscreen Pi replay tail to 64 KiB and treating any live byte stream as sufficient to reconstruct the pane on a cold/resume-failed attach.
- Why it failed: Pi brackets every redraw in DEC mode 2026 and repaints DIFFERENTIALLY — an idle "Working" tail touches only the spinner/status rows (measured: 291 complete frames in 64 KiB touched rows 29/30/32 only, zero full repaints). A cold xterm therefore paints exactly those rows on an empty alternate screen: blank pane with only "Working...", or a hollow editor box. An unchanged-geometry resize is a Host no-op (no SIGWINCH), so nothing repaints until the user actually changes the window size.
- Recognition signal: A live fullscreen Session shows only the spinner/status rows (or a partial editor) until a window resize; the Host's `terminal_geometry` revision is unchanged across the blank attach; the 64 KiB tail replayed into a fresh xterm leaves most rows empty.
- Correct approach: For `pty` Sessions in `FULLSCREEN_PI_ADAPTERS`, attach with `screen_snapshot=true` and replace the renderer from the Host's authoritative mirror (`terminal_snapshot_v1`): queue reset+resize, serialized content, parser-state poke, then pending prefix bytes through the write coordinator so the replay_done drain/live frames keep transport order. Mobile already restores this way; the desktop Tauri attach previously hardcoded `screen_snapshot=false`.
- Prevention: Bisect render-blank bugs at the wire first — a 30-line python socket client can dump the exact replay/snapshot frames; verify xterm-buffer correctness with the real `@xterm/xterm` in vitest before suspecting Canvas. Any future bound on the replay tail must be checked against "does this window still contain a full repaint".
- Verified by: The captured live tail rebuilt only 3 of 38 rows in a real xterm while the served snapshot rebuilt the complete screen (chat, editor box, status bar); wiped-WebKit debug-GUI cold start with unchanged geometry rev rendered the full Session before any resize. Frontend 707/707, Tauri 60/60, Host/Core suites green.

## `macOS debug App restart` — match the GUI executable exactly

- Wrong approach: Selecting PIDs with a substring match on `.../Contents/MacOS/agentport` before restarting the debug GUI.
- Why it failed: The path is also a prefix of `agentport-host`, so the command terminated a Session host and stopped that Session.
- Recognition signal: The candidate PID list contains commands ending in `agentport-host --config ...`, not only the exact GUI executable.
- Correct approach: Use `python3 scripts/restart-debug-app.py` (or `--skip-build` for an already signed bundle). It matches the complete `ps comm` path, rechecks each PID, and never signals helpers or escalates to SIGKILL.
- Prevention: Use `--dry-run` to inspect targets and `python3 scripts/test-restart-debug-app.py` for the selector/reuse/failure guards. Do not hand-roll `pgrep -f`, `pkill`, or `killall` restarts; the prefix also matches the mobile Connector.
- Verified by: The failure recurred on 2026-09-09: recorded `pgrep -f "$APP"; kill $pids` commands aligned with Host `sig=15` and GUI SIGTERM from bash. The replacement passes 8 isolated tests; actual GUI restart preserved all 20 observed Hosts, Connectors and direct Agent children, with a nonblank screenshot.

## `macOS debug App screenshot` — activate the exact debug process before judging a black capture

- Wrong approach: Treating an all-black `screencapture` or inactive-window capture as proof that the debug WebView was blank.
- Why it failed: The exact debug window existed on-screen but was behind the frontmost app; capture showed only the transparent window surface until the debug process was activated.
- Recognition signal: `CGWindowListCopyWindowInfo` reports a layer-0 window owned by `AgentPort Debug - <checkout>`, while the capture is black or shows only traffic lights.
- Correct approach: Resolve the exact debug GUI PID and `CGWindowID`, activate that `NSRunningApplication`, then capture the window with ScreenCaptureKit and inspect the resulting PNG.
- Prevention: Confirm both process path and window owner, activate before capture, and never classify the UI as blank from an inactive transparent-window screenshot alone.
- Verified by: The inactive capture was black; after activating PID 92957, ScreenCaptureKit captured the fully rendered sidebar and Session view.

## `scoped Rust formatting` — `cargo fmt -- <paths>` does not select files

- Wrong approach: Running `cargo fmt -- crates/agentport-core/src/models.rs crates/agentport-core/src/db/mod.rs` to format only the two task files.
- Why it failed: Arguments after `--` are rustfmt options, while `cargo fmt` formats all bin and lib targets in the selected crate/workspace; unrelated Rust files were changed.
- Recognition signal: `git status` suddenly lists Rust files outside the task scope immediately after a supposedly file-scoped format command.
- Correct approach: For a bounded read-only check, run `rustfmt --edition 2021 --check <path>...`; use `cargo fmt --check -p <package>` only when package-wide formatting is intended and baseline-compatible.
- Prevention: Inspect `git status` before and after formatting, and never pass source paths after `cargo fmt --` as selectors.
- Verified by: The command changed six unrelated workspace files; restoring those files and pre-existing formatting in the two task files returned the diff to terminal-theme-only hunks.

## `xterm viewport restoration` — reconcile both buffer and DOM on Session activation

- Wrong approach: Restoring tail-following inside generic `fitHandle()`, or deferring an activation-only repair while checking only `buffer.viewportY`.
- Why it failed: Generic fits can race a live wheel gesture, while the deferred repair left xterm's native `.xterm-viewport.scrollTop` at `0` even when the buffer model was at the tail; the first upward wheel then mapped that stale DOM position back to row `0`.
- Recognition signal: After switching to a bottomed Session, the first upward wheel jumps to the oldest output; the buffer can report `viewportY === baseY` while the native viewport still has `scrollTop === 0`.
- Correct approach: Keep generic fits neutral. In `fitSession()`, synchronously restore the buffer tail and set the native viewport to its maximum scroll position before activation returns; do not queue a callback that can overwrite the user's next gesture.
- Prevention: Regression-test all three boundaries: fit-induced buffer snaps are restored, the DOM viewport is synchronized, and no deferred repair remains after the user starts scrolling.
- Verified by: The native-viewport regression failed at `scrollTop 0` before the repair and passed at `9500` after it; the focused terminal suites pass 50/50.

## `macOS sidebar window drag` — compare CSS specificity before trusting a drag override

- Wrong approach: Adding `body.is-window-dragging .sidebar { backdrop-filter: none; }` and assuming its later source order overrides every vibrancy rule.
- Why it failed: The dark/light selectors `:root[data-vibrancy][data-theme] .sidebar` have greater specificity, so WKWebView kept recomputing the backdrop filter while the window moved.
- Recognition signal: The Tauri move listener toggles `is-window-dragging`, but the sidebar's computed cascade still selects the themed blur declaration.
- Correct approach: Give the drag rule at least equal class/attribute specificity, keep it after the themed rules, and disable both standard and WebKit-prefixed backdrop filters.
- Prevention: Keep `sidebar-window-drag-css.test.ts` checking selector presence, relative specificity, and both `none` declarations whenever sidebar theme selectors change.
- Verified by: The focused CSS contract passes, the frontend production build succeeds, and the rebuilt signed Debug App remains rendered after repeated real window drags.

## `xterm viewport write-restore` — fence and coalesce renderer repair

- Wrong approach: Infer every post-write movement from coordinates alone, exempt all tail writes, or immediately call `scrollToBottom()` from every tail-write callback that observes row 0.
- Why it failed: Coordinates cannot distinguish renderer movement from user intent; additionally, a retained-history burst queues many writes while they all still capture the same stale bottom state, so immediate callbacks repeatedly reveal each intermediate tail and visibly race through history.
- Recognition signal: Only streaming/replayed output reproduces it: the viewport jumps to the oldest row, user gestures are pulled backward, or historical output rapidly scrolls until replay reaches the final tail.
- Correct approach: Fence callbacks with a monotonic user viewport-intent revision. When a tail write lands at row 0, queue at most one generation-scoped empty-write sentinel behind the parser burst; after it drains, repair the xterm buffer and native DOM viewport once, unless user intent changed.
- Prevention: Regression-test ownership and queueing: user movement wins before either callback, scrollback extremes restore their reading row, and several queued bottom-to-row-0 writes produce zero intermediate repairs plus exactly one final repair.
- Verified by: The three-write burst reproduced three immediate `scrollToBottom` calls before the fix and one deferred call after it; delayed-wheel cancellation passes, focused terminal tests pass 56/56, and the full frontend suite passes 285/285.

## `xterm replay visibility` — transport, input capability, parser, and renderer completion are distinct

- Wrong approach: Hide the replay Skeleton immediately on the Host's `replay_done` message, treat a visible warm checkpoint as proof that input is writable, drop `onData` until the attach invoke response resolves, reuse `replayDone=true` from an earlier generation, or treat xterm's write callback as proof that Canvas already painted.
- Why it failed: The backend can install the attachment writer before replay, while retained Channel messages can occupy the WebView queue ahead of the invoke response; waiting for that response drops or delays warm-switch input behind replay. Separately, xterm drains writes asynchronously and schedules Canvas rendering on `requestAnimationFrame`, so earlier visibility boundaries can expose intermediate, blank, or stale screens.
- Recognition signal: A warm switch paints valid content but its first keystrokes appear seconds later or vanish; alternatively `replayDone` is true while no matching `onRender` fired, causing replay flicker or blank frames.
- Correct approach: Publish a generation-fenced writable attachment capability before starting replay delivery, buffer only the pre-capability input and FIFO-flush it when that event arrives, while keeping Host replay/live output order unchanged. Independently reset `replayDone=false`, fence the ordered `replay_done` parser boundary, and require the following xterm `onRender` before revealing cold content.
- Prevention: Test pre-ready plus post-ready input ordering while the invoke reply remains unresolved, no duplication on its late resolution, stale generations, transport receipt, parser drain, next render, later live writes, and warm/cold visibility as separate boundaries; never infer writability from visibility or paint from `onWriteParsed`.
- Verified by: The input regression failed with zero `sendInput` calls before the fix, then FIFO-sent all buffered/live inputs before resolving the invoke with no duplicates; the parser-vs-render regression still requires `emitRender()`. Frontend 512/512 and Tauri 48/48 passed.

## `xterm synchronized output` — preserve redraw atomicity without exploding parser writes

- Wrong approach: Treat a one-frame fullscreen-TUI blank as a Canvas/resize repaint failure, or turn every complete DEC 2026 redraw in a retained Host frame into a separate xterm write.
- Why it failed: The bad frame's xterm buffer already had empty bottom rows, while the replay path expanded 64 bounded Host frames into 65,536 parser writes. Pi brackets each redraw with DEC mode 2026, but xterm 5.5 does not support it; raw chunking paints partial redraws, while per-redraw coalescing can starve the renderer on spinner-heavy tails.
- Recognition signal: A transient blank has an all-empty xterm tail; a Session that stays behind the attach veil has a 4 MiB tail dominated by `ESC[?2026h` / `ESC[?2026l` pairs and high WebContent CPU.
- Correct approach: Preserve raw bytes and complete mode-2026 blocks, but batch a pathological burst back to one xterm write per Host output frame. Once collapse is inevitable, reuse the frame's byte views until the final copy; arm the unmatched-frame timeout only if a frame remains open when synchronous Channel delivery returns. Flush output before deferred parser/local actions, including exceptional sink cleanup.
- Prevention: Regress marker splits at every byte, ordinary prefix/suffix ordering, replay/render drains, false prefixes, timeout/cap release, snapshots, stale handles, throwing sinks, and a 4 MiB synchronized-TUI replay delivered without parser callbacks; assert transport-bounded writes, exact bytes, and zero per-redraw timers.
- Verified by: Explorer resize stress produced three all-empty-tail frames before the first coalescing fix and `BAD=0` after it. The replay regression moved from 65,536 writes to 64; the follow-up removed 65,536 timer pairs and reduced concat buffers from 65,600 to 4,160. Across 20 randomized fresh-process pairs, component duration median ratio was 0.867 (bootstrap 95% CI 0.860–0.877); focused terminal tests pass 94/94 and the full frontend suite passes 495/495.
- Mobile DOM renderer: Gating only `RenderService._renderRows` still painted partial DEC 2026 frames because cursor/focus handlers call the DOM renderer directly. Gate both render paths until DECRST 2026, with bounded timeout and API/RIS reset cleanup; keep parsing and snapshot barriers live. The real-browser regression exposed `partial redraw` while the service callback was already gated, and preserved the old screen only after gating direct DOM paints too. Re-run `node mobile/scripts/test-terminal-touch.mjs` when upgrading xterm.


## `session env inheritance` — proxy/secret 过滤是双层机制，缺一层就会静默断网

- Wrong approach: 只检查 GUI 或 Host 其中一层是否传环境变量，看到父进程有 `HTTPS_PROXY` 就断定 Agent 能继承。
- Why it failed: 环境过滤曾是两层独立设计——GUI 侧 `launch_environment_name_is_safe()` 白名单（`capability.rs`，显式排除 proxy/API key，防凭证泄露）+ Host 侧 spawn 前 `env_clear()`（`agentport-host/main.rs`）。祖先进程（launchd→GUI→Host）全都有代理变量时，codex 子进程仍然 0 个；且 codex/reqwest 只读环境变量，不认 macOS 系统代理。
- Recognition signal: Session 内模型请求失败但终端里同一 CLI 正常；`ps eww <host_pid>` 有 proxy 而 `ps eww <child_pid>` 没有；session 的 `host.json` 里 `env` 无 proxy 条目。
- Correct approach: 2026-08 起两层过滤均已按用户要求移除——login shell 环境全量继承 + Host 不再 `env_clear()`（`cfg.env` 只做 overlay）。注意后果：shell rc 里的凭证会进 Agent 环境并以明文落进 `host.json`；如需恢复过滤必须两层同时评估。
- Prevention: 排查 Agent 环境问题时对比三层：GUI 进程 env、`host.json` 的 `env`、Agent 子进程 env（`ps eww`），逐层定位丢失点；改任何一层过滤逻辑时同步检查另一层。
- Verified by: 实测 codex 子进程 0 个 proxy 变量而父 Host 有 12 个；修复后手写 `host.json` 直启新 Host 二进制，PTY 子进程同时拿到父进程独有的 `AGENTPORT_PROXY_PROBE` 与 `cfg.env` overlay 标记；`agentport-core` 271 测试与 `agentport-host` 28 测试全绿。

## `Project archived-Session purge` — bind destructive confirmation and fence archived runs

- Wrong approach: Confirm only an archived Session count, send only the Project ID, then re-query and purge every archive after stopping Hosts.
- Why it failed: The confirmed set or an individual Session's archive generation could change before purge, while a Session could reserve, claim, or bind a new Host run between stop and deletion.
- Recognition signal: A destructive command accepts only `project_id` or bare Session IDs, independently lists archives before and inside the purge, or run reservation/claim/bind does not reject `archived_at IS NOT NULL`.
- Correct approach: Pass each confirmed `(Session ID, archive generation)`, transactionally compare and purge exactly that versioned set, generation-fence stale rollback, and make archived state a database-level run-creation/binding fence.
- Prevention: Bind destructive execution to versioned identities rather than counts or IDs alone; revalidate under the authoritative transaction, keep dependency checks and deletion in one write transaction, and fence state transitions that could recreate the resource during cleanup.
- Verified by: The project purge tests preserve archives on membership and unarchive/rearchive drift; `stale_archive_rollback_cannot_clear_a_newer_generation` and `archived_sessions_cannot_reserve_or_claim_a_new_host_run` cover rollback and Host-run fences.

## `xterm recovery location` — track the marker through the complete write queue

- Wrong approach: Insert the recovery marker and then append the target's trailing context without a final viewport restore.
- Why it failed: A reset terminal follows the tail, so up to 256 KiB of trailing context moved the selected marker out of view; the “jump” landed at the context end instead of the event.
- Recognition signal: Timeline recovery reports a successful location and the marker exists in scrollback, but the visible viewport shows only later output.
- Correct approach: Register an xterm `IMarker` in the marker write callback, queue all trailing/filter output, then use an empty-write sentinel to `scrollToLine(marker.line)` under the handle/generation fence and dispose the marker.
- Prevention: Recovery-location tests must execute the marker and sentinel callbacks and assert the tracked line is revealed after trailing context parses.
- Verified by: The new ended-Session regression failed because no reveal callback existed, then passed with `registerMarker(-1)` and final `scrollToLine(123)`; the full frontend suite passes 280/280.

## `terminal search navigation` — keep one viewport authority

- Wrong approach: Call SearchAddon navigation and then independently map a second line-based hit index to `scrollToLine()` for the same Enter/click.
- Why it failed: SearchAddon counts wrapped/multiple matches in the active buffer, while the parallel index counted physical lines and even enumerated an inactive normal buffer before an alternate screen; one action could therefore issue two different jumps.
- Recognition signal: `navigate()` invokes both `findNext/findPrevious` and a custom locate function, or the displayed match index comes from a search implementation other than the one moving the viewport.
- Correct approach: Make SearchAddon the sole active-buffer navigator and derive current/count/scope from `onDidChangeResults`; keep persisted-log search as the separate full-history authority.
- Prevention: A component regression should assert one Enter calls SearchAddon but never the legacy buffer scan/locate path, and that the displayed index follows the addon event.
- Verified by: The regression failed with one custom locate call before the change and passed after removing the parallel index; focused tests pass 52/52 and the full frontend suite passes 281/281.

## `xterm replay veil` — the attach skeleton must be opaque, not just present

- Wrong approach: Treating the SkeletonOverlay's presence and parser-boundary timing as sufficient to hide replay painting.
- Why it failed: `.term-overlay` is `rgba(16,17,21,0.2)` / light `rgba(245,245,245,0.28)` by design — ended-session overlays must let read-only history show through. The attach/replay skeleton reused the same translucent veil, so xterm still painted every intermediate replay state in plain view and the user watched the retained tail race by (高频刷屏). Restart always hits the full replay: `resetForRestart()` clears `logCursor`, so the next attach replays the complete 4 MiB tail.
- Recognition signal: During attach the "Connecting to Session Host…" card is up yet terminal content is clearly readable around it and changes between frames (burst capture: row 31918 → 39999 within ~310 ms).
- Correct approach: Render `SkeletonOverlay` with `term-overlay term-overlay-solid` whose background is `var(--bg)`; keep ended/interrupted overlays translucent. The light-theme solid rule needs its own `:root[data-theme="light"]` selector to out-specific the translucent light override.
- Prevention: `terminal-attach-veil-css.test.ts` checks the modifier, opacity (no `rgba(`), and specificity vs both translucent defaults; when touching overlay CSS, decide per-overlay whether content behind may remain visible.
- Verified by: Before fix, burst screenshots showed replay rows racing behind the skeleton; after fix the regression passes red→green and the full frontend suite passes 298/298.

## `agentport-cli perf measurement` — never time replay with `session read --until`

- Wrong approach: Timing 4 MiB replay delivery with `session read <id> --tail-bytes N --until GENDONE`.
- Why it failed: The CLI scans `output.windows(needle)` over the *accumulated* buffer after every frame (O(n²) total), so the measured 1.55 s was dominated by the scan, not the transport.
- Recognition signal: Measured time grows superlinearly with tail size (256 KiB→0.03 s, 1 MiB→0.19 s, 4 MiB→1.59 s) while user≈real (CPU-bound client side).
- Correct approach: Measure with a short fixed `--timeout` and inspect the `bytes` field (all 4 MiB arrived within 0.3 s), or add a dedicated perf scenario; treat any O(n)-per-frame scan over accumulated output as suspect first.
- Prevention: Same rule for any transport benchmark in this repo — exclude client-side post-processing from the timed path.
- Verified by: `--timeout 0.3` received the full 4 109 127 bytes three times in a row.

## `macOS GUI screenshot helpers` — ad-hoc recompiles burn the TCC grant mid-verification

- Wrong approach: Recompiling a throwaway ScreenCaptureKit helper binary between baseline and post-fix captures.
- Why it failed: macOS attributes screen-recording permission per binary cdhash; a recompiled helper is a new TCC client and re-prompts. A decline is sticky — all subsequent ScreenCaptureKit/`screencapture` attempts fail with `SCStreamErrorDomain -3801`, and assistive access for keystrokes is a separate grant that may also be absent.
- Recognition signal: Captures succeed, then after rebuilding the helper every call returns `The user declined TCCs for application, window, display capture`.
- Correct approach: Compile the capture helper once per task and freeze it; batch all needed captures through it; if a prompt is declined, stop retrying (each attempt just re-fails) and fall back to non-pixel evidence (CGWindowList geometry needs no grant).
- Prevention: Keep one stable `burst` binary under /tmp for the whole verify cycle; never `swiftc` over it mid-task.
- Verified by: First binary captured 80+ frames across two runs; after one recompile every capture returned -3801 while `CGWindowListCopyWindowInfo` still reported the window geometry.

## `xterm renderer memory` — bound hidden instances and cell history together

- Wrong approach: Treating an LRU of three mounted terminals as a sufficient renderer-memory limit while each xterm retained 50,000 lines and continued receiving hidden-session output.
- Why it failed: ANSI/TUI history is stored as xterm cell structures, not raw log bytes; each hidden renderer kept a live IPC channel and a large parsed buffer, while WebKit retained its allocation high-water mark after eviction.
- Recognition signal: `agentport-host` stays near 10–20 MiB but `footprint -p <WebContent PID>` is dominated by WebKit malloc; restarting only the GUI sharply lowers memory, and visiting additional PTY Sessions raises it again.
- Correct approach: Keep only live visible PTY renderers, release xterm when selecting JSON-RPC or ended Sessions, and cap xterm scrollback at 10,000 lines. Keep only a 4 MiB Host memory tail for live reconnect; read ended history/search/export from verified Agent-native logs without a PTY copy or body index.
- Prevention: For terminal resource regressions, measure GUI, WebContent, GPU, Host, and Agent children separately; replay the same multi-Session sequence and require WebContent footprint to stabilize rather than grow with every visited Session.
- Verified by: Before the fix WebContent footprint rose from about 206 to 253 MiB after two live Sessions and reached about 679 MiB after a long run; after the fix it measured about 146, 163, then 160 MiB across one, two, and four visited Sessions, with the active scrollbar reporting 10,000 rows.

## `agent-native JSONL` — enforce line limits before allocation

- Wrong approach: Read a complete JSONL record with `read_until('\n')`, then reject it when `line.len()` exceeds the configured maximum.
- Why it failed: The limit was checked only after the complete record had already been allocated, so one malformed or adversarial native-log line could cause an unbounded transient memory spike.
- Recognition signal: A parser advertises a maximum line size but calls `read_line`, `.lines()`, or `read_until` into a growing buffer before comparing the resulting length.
- Correct approach: Use `BufRead::fill_buf()` and `consume()` to retain at most the limit, drain an oversized record through its newline, and advance the opaque cursor by every consumed byte so the next page stays on a record boundary. Polling followers must also cap bytes per poll and persist an “oversized drain” state; a bounded buffer alone still permits unbounded work or repeated rereads of the same newline-free prefix.
- Prevention: Keep oversized-record regressions that assert the immediately following valid JSONL record is still readable and a newline-free prefix advances by only the per-poll budget; cache bounded Provider discovery metadata once per request instead of rescanning roots for every Session.
- Verified by: Native-history oversized coverage passes with an 8 MiB-plus record; Host semantic followers additionally pass `oversized_record_is_drained_across_bounded_polls_before_the_next_event` and `hook_poller_drains_an_oversized_record_before_a_valid_stop`.

## `Pi PTY rendering` — keep full-screen redraws out of durable scrollback

- Wrong approach: Launch Pi with its default regular/inline TUI while treating PTY scrollback as durable conversation history.
- Why it failed: Expanding a tool made Pi clear, home, and repaint the full conversation in the normal screen on every frame, so each redraw was appended to raw scrollback.
- Recognition signal: Raw PTY output is far larger than the agent-native JSONL, repeatedly contains `CSI 2J` plus `CSI H`, and contains no alternate-screen entry.
- Correct approach: Capability-gate Pi PTY launch/resume on `tui-mode`, force `--tui-mode fullscreen`, and keep the agent-native JSONL as the durable on-demand history source; leave JSON-RPC unchanged.
- Prevention: Protect `--tui-mode` from preset overrides and regression-test launch, resume, unsupported versions, and JSON-RPC separately.
- Verified by: One affected run had about 402 MB of raw output with 285 clear/home redraws and no alternate-screen entry versus about 9.9 MB of native JSONL; Pi adapter tests pass 8/8 with fullscreen enforcement.

## `agent-native history pagination` — page backward but preserve source chronology

- Wrong approach: Start the first page at byte zero, or place a persisted latest transcript ID before append-only Hook rollover IDs when assembling native sources.
- Why it failed: Byte-zero paging returned the oldest events first; latest-ID-first source ordering could make reverse paging begin in an older transcript after clear/fork/compact rollover.
- Recognition signal: An empty cursor returns the oldest fixture, or the first reverse page skips the newest Hook-era transcript despite a valid persisted Session ID.
- Correct approach: Read bounded pages backward from the final source EOF, return each page chronologically, discover Hook IDs in append order with persisted scalars as fallback, and stream search/export independently forward.
- Prevention: Keep regressions for latest-to-oldest paging, no trailing newline, oversized reverse records, multi-source rollover ordering, and viewport anchoring after prepend.
- Verified by: Native-history tests pass 8/8, including Hook rollover, bounded reverse scanning, and chronological search/export; the Debug App prepended earlier timestamped events on demand.

## `live PTY history boundary` — prepend native history inside the one xterm

- Wrong approach: Bridge xterm to a separate DOM history renderer, or restore the viewport after an xterm rebuild with only the `baseY` delta.
- Why it failed: The renderer bridge introduced a visible intermediate page and competing scroll/selection state. After that page was removed, `baseY` still changed with reserialization, wrapping, and terminal geometry, so its delta did not identify the same logical content after a second prepend.
- Recognition signal: Reaching normal-buffer `viewportY === 0` either opens a Header/Export/Return page, or the first native page looks correct but the second page jumps back to the native/live boundary.
- Correct approach: Keep one xterm mounted for running, interrupted, and ended PTY Sessions. Read agent-native pages only at the normal-buffer top, sanitize them, rebuild at a parser-drain boundary, and preserve the viewport by its row distance from an explicit native/live boundary marker. Never intercept alternate-screen TUI input or Shell.
- Prevention: Cover first and consecutive pages, request deduplication, source cursor order, marker-relative viewport restoration, no standalone history DOM, alternate-screen behavior, selection, and clipboard copy. Verify the packaged Debug App because jsdom cannot prove xterm geometry.
- Verified by: The marker-relative consecutive-page regression passes after a real Debug App run exposed the `baseY` failure. The packaged app keeps native history in the same xterm; an ended Pi Session scrolls, forms a visible selection, and copies 38 bytes without stopping any Host.

## `interrupted Session cold start` — restore selection, recovery UI, and PTY mount together

- Wrong approach: Classify `interrupted` as an ordinary ended-history page, restart its Host without re-adding the active PTY to `attachedIds`, and let boot always select `flattenSessions()[0]`.
- Why it failed: The top-level history branch made the existing recovery card unreachable; after Restart the live renderer had no mounted `TerminalPane`; after a GUI cold start the user's interrupted Session could be replaced by an unrelated first Session.
- Recognition signal: Opening an interrupted Session shows Export controls instead of the recovery card, Restart publishes `running` but no xterm appears, or reopening the GUI selects a different Session.
- Correct approach: Persist the last selected Session id, restore it after notification routing when it still exists, render interrupted history only as passive context behind the recovery card, and re-run active Session selection after restart publishes a fresh project snapshot.
- Prevention: Keep separate regressions for boot selection priority, interrupted rendering, and interrupted-to-running `attachedIds`; finish with a packaged Debug App cycle of select → close/open GUI → Restart → live prompt.
- Verified by: All three regressions failed before their respective fixes and pass afterward; the full frontend suite passes 321/321, and a dedicated Shell Session survived GUI cold-start selection, displayed the recovery card, then returned to a live prompt while the user's existing Host remained running.

## `output readers` — opt readable text back into selection

- Wrong approach: Add a plain `<pre>` output reader under the app-wide `user-select: none` rule and assume a working clipboard API makes its text copyable.
- Why it failed: The browser could not form a DOM selection, so the standard copy command had no output to place on the clipboard.
- Recognition signal: Buttons and scrolling work, but dragging across rendered output produces no highlight; the output node lacks the existing `.selectable` opt-in.
- Correct approach: Apply `.selectable` only to the readable output body, preserving non-selectable UI chrome and keeping xterm's separate selection-copy handler unchanged.
- Prevention: Every new document/log/output renderer must have a regression asserting its body explicitly opts into selection when global selection is disabled.
- Verified by: The native-history regression failed with `selectable=false`, passed after the one-line opt-in, all 305 frontend tests passed, and the rebuilt Debug App visibly formed a text selection in native history.

## `xterm terminal snapshots` — restore mouse tracking and report encoding independently

- Wrong approach: Resume a live fullscreen TUI from `SerializeAddon.serialize()` plus its Host log cursor and assume every mouse mode is present; restoring only alternate screen (`1049h`) and SGR encoding (`1006h`) on a cold attach also looks complete but leaves tracking disabled.
- Why it failed: Mouse tracking (`9/1000/1002/1003`) and report encoding (`1006/1016`) are independent xterm states. SerializeAddon saves active tracking but omits encoding, while bounded tails and snapshots produced after a tracking-less cold fallback can omit tracking too; enabling SGR alone leaves `mouseTrackingMode: "none"`, so wheel events never reach Pi.
- Recognition signal: The Host output contains launch-time alternate-screen, tracking, and SGR sequences, but after a GUI restart the fullscreen screen remains visible while wheel and drag stop; replaying `1049h+1006h` in xterm yields the alternate buffer with tracking `none`.
- Correct approach: Track and persist the omitted report encoding separately. When restoring fullscreen Pi, preserve an explicit tracking DECSET serialized at the end of a valid snapshot; otherwise append Pi's common button-motion fallback (`1002h`), then restore SGR. Reset tracked encoding on terminal reset/RIS.
- Prevention: Regression-test no-snapshot cold attach, legacy and current snapshots missing tracking, snapshots with explicit tracking, and encoding restoration. Validate the resulting xterm mode state, not only visible screen equality.
- Verified by: Before the fix, three renderer regressions omitted `1002h`; afterward 73/73 focused and 360/360 frontend tests passed. A real xterm 5.5 probe changed the fallback from tracking `none` to `drag`, and the rebuilt Debug App visibly scrolled the live Pi transcript from 87% to 2%.

## `Qoder exact resume` — do not reuse the launch-only Session ID flag

- Wrong approach: Reopen an existing Qoder transcript with `qodercli --session-id <existing-id>` because launch uses that flag to assign a stable native ID.
- Why it failed: Qoder treats `--session-id` as new-Session identity assignment; reusing a persisted ID exits 42 instead of attaching the terminal. Exact recovery is `--resume <id>`.
- Recognition signal: The native ID appears in `qodercli --list-sessions`, but every AgentPort restart exits within seconds with code 42 and `host.json` contains `--session-id <that-id>`.
- Correct approach: Require both `session-id` and `resume` capabilities for Qoder exact-resume support; use the former only for launch and the latter with the persisted ID for recovery.
- Prevention: Keep separate argv regressions for launch and resume, and verify a packaged Debug App restart against a real Qoder transcript rather than inferring semantics from the shared ID value.
- Verified by: The argv regression failed before the adapter change and Qoder tests pass 5/5 afterward; the same previously failing Session runs with `--resume <id>`, preserves its prior message, reaches Ready, and remains alive past the old failure window.

## `native backup manifest` — validate Provider semantics, not only archive paths

- Wrong approach: Treat zip-slip checks, hashes, and a Provider-root enum as sufficient validation for an untrusted native-Session backup manifest.
- Why it failed: A forged but internally consistent v2 manifest could map a Claude payload to a safe relative path such as `settings.json`; extraction stayed inside the declared root but restoration could still create Provider configuration unrelated to the AgentPort Session.
- Recognition signal: Restore validation proves `target_path` is relative but never proves it matches the descriptor's Provider, native ID, CWD, and AgentPort Session ID.
- Correct approach: Before extraction/materialization, enforce Provider-specific target prefixes: Claude/Qoder ID+CWD paths, Pi's exact `sessions/<agentport-id>/pi`, Kimi indexed session directories, and Codex session JSONL scope; reject incomplete or duplicate Kimi bindings.
- Prevention: Keep a malicious-manifest regression that uses valid hashes and a traversal-free Provider configuration target, and require verification to reject it before any Provider write.
- Verified by: `native_manifest_cannot_target_provider_configuration_files` initially exposed the semantic gap and passes after provider/session target validation; the complete backup-focused suite passes 22/22.

## `Project expansion persistence` — startup selection must not reveal the active Project

- Wrong approach: Persist collapsed Project IDs and treat a successful storage round trip as a complete restart fix.
- Why it failed: GUI boot restores the last Session through `selectSession()`, whose normal user-navigation behavior expands that Session's Project and immediately overwrites the restored collapse state.
- Recognition signal: WebKit LocalStorage contains the expected collapsed Project ID before launch, but the remembered Session belongs to that Project and it expands during boot.
- Correct approach: Keep explicit Session navigation revealing its Project, but call startup selection with `revealInSidebar: false` so boot does not mutate Project or Worktree disclosure state.
- Prevention: Restart regressions must cover the remembered Session being inside a collapsed Project; verify the packaged WebView's stored value both before and after boot, not only module initialization.
- Verified by: The startup-selection regression failed with `expandedProjects.prj_1 === true` before the fix and passed afterward; a packaged Debug App probe retained the active Project ID across cold launch, and all 327 frontend tests pass.

## `WKWebView terminal benchmarks` — report stage boundaries before blaming replay

- Wrong approach: Treating a missing benchmark completion record in WebKit LocalStorage as proof that a 4 MiB terminal replay was still parsing.
- Why it failed: The replay transport and xterm parser had completed, but the benchmark then threw on `localStorage.setItem()` because the origin was at quota; the unreported exception made an instrumentation failure look like product latency.
- Recognition signal: An external probe receives only `started`, while the Host remains attached and no stage-specific transport/parser/storage events exist; LocalStorage writes may silently fail inside product catch blocks.
- Correct approach: Emit externally readable milestones at transport receipt and parser drain before snapshot/storage work, then catch and report each benchmark-stage failure separately.
- Prevention: For terminal E2E timing, establish the first missing stage with out-of-origin HTTP or another independent sink; never infer an earlier stage is pending from a later sink's absent completion record.
- Verified by: Direct milestones measured the 4 MiB replay parser boundary at 469 ms, followed by a captured `setItem@[native code]` error; omitting the quota-blocked storage stage produced all 12 paired WKWebView snapshot samples.

## `Project collapse persistence` — compact UI state must recover from terminal-snapshot quota

- Wrong approach: Catch and ignore `localStorage.setItem()` failures while assuming a small collapsed-Project ID list would always fit.
- Why it failed: Terminal snapshots share WKWebView LocalStorage; 74 obsolete v1 snapshots occupied about 5 MB, so new collapse-state writes failed silently and the one previously stored Project ID (`apollo-isoftstone`) was the only state restored.
- Recognition signal: Only one old Project remains collapsed across restarts, the collapse key never changes, and `ItemTable` is dominated by `agentport:terminal-snapshot:v1:` values.
- Correct approach: On a failed collapse-state write, remove obsolete v1 terminal snapshots and retry the compact state write; Host replay remains the safe fallback for those snapshots.
- Prevention: Test persistence under an exhausted LocalStorage quota and inspect per-prefix storage size before blaming startup selection or serialization.
- Verified by: The packaged WebKit database contained 74 v1 entries totaling 5,063,542 bytes versus a 48-byte one-ID collapse value; the quota regression failed before retry/reclamation and passes afterward, with the full frontend suite at 333/333.

## `Host binary A/B benchmarks` — rebuild the standalone executable after test-harness builds

- Wrong approach: Run `cargo test -p agentport-host --bin agentport-host` and then benchmark `target/debug/agentport-host` as the candidate executable.
- Why it failed: Cargo rebuilt the unit-test harness under `target/debug/deps`, not the standalone binary at `target/debug/agentport-host`, so the first A/B run unknowingly measured the pre-fix executable.
- Recognition signal: Source and unit tests contain the candidate cadence, but the standalone binary hash is unchanged and its process-scan count exactly matches baseline.
- Correct approach: Run `cargo build -p agentport-host` (or the matching `--release` build), record candidate/baseline hashes, then execute the exact hashed paths.
- Prevention: Every Host A/B script must print and retain revision, profile, executable path, and SHA-256 before collecting samples.
- Verified by: The stale candidate produced 4 `ps` executions in 12 seconds, identical to baseline; after an explicit build changed the binary hash, the same workload produced 1 versus 4 in all three paired runs.

## `Pi idle cleanup` — exact resume must inherit completed-turn authority

- Wrong approach: Start every semantic follower at transcript EOF and arm idle cleanup only from a new `AdapterTurnEnd` observed in that Host run.
- Why it failed: Exact resume of an already completed Pi transcript emits no new TurnEnd until another prompt finishes, so a quiet resumed process can remain alive indefinitely.
- Recognition signal: The current run has only PTY activity/silence events, while its exact native transcript ends with a high-confidence assistant `stop` from the prior run.
- Correct approach: At startup, boundedly verify the hinted Pi transcript and use its latest committed message only as an inherited idle-timer hint; do not replay it as a new status event.
- Prevention: Resume regressions must separately assert timer inheritance, no duplicate TurnEnd event, mismatched native IDs, incomplete records, and later user activity cancellation.
- Verified by: Session `ses_01M1182N3M0YMGTB` remained idle for over 15 hours with no run-local TurnEnd although its exact transcript ended in assistant `stop`; the integration regression confirms a resumed completed transcript arms the timer without replaying old state.

## `xterm remote input` — do not infer key hold from a lone keydown

- Wrong approach: Synthesize macOS key hold from every initial printable `keydown`, assuming a matching `keyup`, blur, `InputEvent`, or later keydown will always cancel the unbounded timer.
- Why it failed: UU Remote's phone keyboard emitted one trusted `keydown` per character, reported every character as physical `KeyA`, and emitted neither `keyup` nor `InputEvent`. That stream is indistinguishable in WebKit from a physical key held down, so the 500 ms timer repeated the final character every 40 ms forever.
- Recognition signal: Remote text is correct while typing, then its final character begins repeating after exactly the synthetic hold delay; DOM metadata shows keydown-only text followed by internal repeat ticks.
- Correct approach: Never infer hold from the absence of keyup. Forward xterm's ordinary keydown once and use only observed `KeyboardEvent.repeat=true` events for repeat fallback; accept that WebKit configurations suppressing native repeats no longer get speculative hold synthesis.
- Prevention: Keep the exact UU regression of several keydown-only characters sharing one physical code, alongside native-repeat, third-party IME, de-duplication, and disposal coverage.
- Verified by: A metadata-only trace captured three keydowns and no release/input before the synthetic timer started; the regression failed with one extra final character before the fix, 89/89 renderer tests pass afterward, and the same UU path changed from repeated output to exactly `abc` in the rebuilt Debug App.

## `review pairing portal` — align Referrer-Policy with strict form Origin validation

- Wrong approach: Send `Referrer-Policy: no-referrer` on a protected HTML form while requiring its navigation POST to carry the exact HTTPS `Origin`.
- Why it failed: The real browser sent `Origin: null`; the portal rejected the legitimate request before issuing a pairing code. A hand-built HTTP test with an explicit Origin did not reproduce browser policy behavior.
- Recognition signal: Login works but Get connection code returns `Invalid request origin`; metadata-only diagnostics report a null origin and no same-origin Referer.
- Correct approach: Use `Referrer-Policy: same-origin` for this same-site form, retaining exact Origin and CSRF validation and suppressing cross-origin Referer. Do not simply accept null origins or remove CSRF checks.
- Prevention: Verify the response policy as well as rejection paths, then exercise a real browser form; synthetic HTTP headers cannot establish browser compatibility.
- Verified by: The response-policy regression failed before the change; after deployment, real form submission issued a new code and the user's device was approved and connected. See `mobile/scripts/test-review-gateway.py` and `mobile/REVIEW_ACCESS.md`.

## `Remote Session restart` — reproduce the missing creator reaper, then reconcile before the lifecycle guard

- Wrong approach: Reproduce Ctrl+C/restart while keeping the creating Bridge alive, or assume a mobile Exit event means the Session row is already terminal.
- Why it failed: The launcher's detached reaper updates the DB only while its owning process exists. The independent Host survives a Bridge reconnect, so its later Exit can leave a stale Running row that the restart guard rejects.
- Recognition signal: The phone shows Restart, but the service returns request_not_executed; DB lifecycle is Running while a matching PID/run host-state records exit.
- Correct approach: Under the restart repository lock, run Core's PID/run-fenced liveness reconciliation, reread the Session, then enforce the existing live/creating/archived guards. Do not blindly Stop, retry, or equate a socket failure with death.
- Prevention: In isolated native regressions, close only the creating Bridge, reconnect before Ctrl+C, then assert the actual Restart result, new run ordinal and terminal input/output; include live-PID, mismatched-run and creating-without-PID counterexamples.
- Verified by: The isolated old Bridge returned not_executed with DB Running after Ctrl+C; the fixed bundled Bridge produced run 1→2 and echoed new-run input. The service regression failed before the fix and passes all five cases afterward.

## `Codex restart identity` — missing native ID must not select the latest conversation

- Wrong approach: Use `codex resume --last` when the AgentPort Session has no native ID, and treat a new Host/run with working terminal I/O as proof of correct recovery.
- Why it failed: An unused Codex Session may exit before any ID is captured; `--last` selects a different conversation in the same working directory, not the original AgentPort Session.
- Recognition signal: A never-used Session reopens another conversation; its persisted native ID is absent and its launch command contains `resume --last`.
- Correct approach: Start a fresh conversation for missing/blank IDs, report resume precision as unavailable, and emit an explicit notice. Preserve exact `resume <id>` when a verified ID exists; never guess a target from recency.
- Prevention: Assert the selected native identity or fresh-conversation output in restart tests, in addition to lifecycle, new run and terminal I/O. Do not automatically rewrite IDs/history of previously misdirected Sessions.
- Verified by: The isolated pre-fix Bridge passed restart/I/O but failed an argv identity assertion with `['resume', '--last']`; the fixed bundled Bridge passed both fresh-conversation and I/O assertions. The real retry also launched without `resume` or `--last`.

## `Tauri debug sidecars` — GUI builds can overwrite freshly built helper executables

- Wrong approach: Build native helpers into `target/debug`, then build the GUI without refreshing `src-tauri/binaries`, and install helpers from `target/debug`.
- Why it failed: tauri-build copies configured externalBin inputs back into that same output directory. Stale staged sidecars replaced the fresh binaries; Cargo can subsequently regard the overwritten output as Fresh.
- Recognition signal: Relay remains connected but Mobile reports `bridge_hello_failed`; the bundled Bridge exits at service startup while the GUI opens the current DB. Top-level helper timestamps/content match old staged sidecars.
- Correct approach: Build debug sidecars under an explicit host target, stage those isolated artifacts before the GUI build, and compare staged versus GUI-output helpers before installation/signing.
- Prevention: Run `python3 scripts/test-debug-sidecars.py`; test stale externalBin inputs, contaminated Fresh outputs, and unexpected replacements. Do not downgrade the real DB to make an old helper start.
- Verified by: The old bundled Bridge failed on a private v14 DB copy but started when only the copy's schema marker was v13. Three build regressions fail before/pass after; the updated signed Bridge opens the real v14 DB, and the existing iPhone pairing completes hello and lists 8 projects without restarting its Connector.

## `embedded xterm Host` — validate bulk ingestion in the actual debug profile

- Wrong approach: Accept a small embedded QuickJS screen test as sufficient evidence that maintaining VT state synchronously will not delay PTY ingestion.
- Why it failed: The default unoptimized QuickJS C interpreter put the 4 MiB flood beyond the existing monitor test deadline under parallel load; per-ASCII-byte prefix arrays added avoidable work.
- Recognition signal: `broadcast_evicts_nonreading_output_client_without_stalling_monitor` fails at the ingestion marker with the screen enabled, but the same full suite passes with only the screen initialization disabled.
- Correct approach: Optimize `rquickjs-sys` in the dev profile and skip prefix allocation for ground-state ASCII. Keep memory/interrupt limits and preserve raw streaming if the screen engine fails.
- Prevention: Run the complete Host integration suite, not only the snapshot unit test, when changing the engine or build profile; run `node scripts/build-terminal-snapshot.mjs --check` after shared parser changes.
- Verified by: Screen-enabled parallel runs failed twice; the screen-disabled control passed 35/35. With the dependency optimization, the unchanged deadlines passed all 36 Host integration tests; the iPhone then restored a >128 KiB differential TUI after cold launch.

## `SQLite live backups` — pin the read view and avoid the GUI connection mutex

- Wrong approach: Accept idle-database backup tests, then run incremental `run_to_completion(32, 50ms)` while holding the GUI's Db mutex.
- Why it failed: Independent Host writes repeatedly restarted the unpinned source snapshot; the unconditional sleeps widened the restart window, while other GUI database work waited behind the same mutex indefinitely.
- Recognition signal: A backup produces only a small temporary DB, workers wait on Db mutex, and the backup worker repeatedly sleeps in `run_to_completion`; page progress moves backwards while `PRAGMA data_version` changes.
- Correct approach: Open a separate read-only connection, begin a read transaction and perform a read to pin its WAL view, then copy bounded page batches without sleeping on successful progress. Bound lock retries and report phase/count/elapsed status.
- Prevention: Test sustained writes from a second connection, monotonic snapshot progress, exclusion of post-snapshot writes, an available GUI mutex during copying, and lock-deadline failure. Include a real busy-database read-only probe when validating backup changes.
- Verified by: The sustained-writer regression failed before the fix and passed after it. The unpinned live probe restarted three times in three seconds; the corrected Rust snapshot copied 11,699 pages in 0.269 seconds with integrity OK. The packaged GUI subsequently published and verified the Codex archive and released its buttons.

## `Tauri before* commands` — 运行目录既不是仓库根也不是配置目录

- Wrong approach: 假设 `beforeDevCommand` / `beforeBuildCommand` 在仓库根执行，写成 `bash src-tauri/scripts/build-sidecar.sh release && npm --prefix src run build`，并且只在 `cd src-tauri && tauri build` 这一种入口下验证过。
- Why it failed: Tauri 自己推导执行目录：在仓库根执行 `tauri build` 时实测落在 `<repo>/mobile`，在 CI runner（tauri-action，全局 CLI）上落在没有 `src-tauri` 的目录，两条路径都报 `bash: src-tauri/scripts/build-sidecar.sh: No such file or directory`（exit 127）。
- Recognition signal: 本地 `cd src-tauri && tauri build` 正常，但从仓库根或 CI 触发时 beforeBuildCommand 立即 127；把 beforeBuildCommand 临时换成 `bash -c "echo $(pwd)"` 就能打印真实目录。
- Correct approach: 让命令自己定位 checkout：`bash -c 'cd "$(git rev-parse --show-toplevel)" && …'`（已应用于 `src-tauri/tauri.conf.json` 的 beforeDev/beforeBuildCommand）。
- Prevention: 任何 before*/构建脚本都不得依赖调用者目录；改动后用 `--config '{"build":{"beforeBuildCommand":"bash -c \"echo CWD=$(pwd); exit 7\""}}'` 在**仓库根**与 `src-tauri` 两个入口各验证一次。
- Verified by: 本地两个入口都打印 `/Users/w/Projects/AgentSessions`；CI v0.1.0 发布在修正后通过了 sidecar 暂存步骤。

## `Tauri universal bundle` — externalBin 需要每个 cargo target 各一份

- Wrong approach: 只为 `universal-apple-darwin` 准备 lipo 合并后的 sidecar（`agentport-host-universal-apple-darwin`）。
- Why it failed: `--target universal-apple-darwin` 会分两次编译（`x86_64-apple-darwin`、`aarch64-apple-darwin`），tauri-build 按**当前 cargo target** 解析 externalBin，报 `resource path binaries/agentport-host-x86_64-apple-darwin doesn't exist`。
- Recognition signal: 构建日志出现 `TAURI_ENV_TARGET_TRIPLE=x86_64-apple-darwin` 紧跟 `resource path ... doesn't exist`，而 `-universal-apple-darwin` 文件确实存在。
- Correct approach: 同时暂存每个架构的副本（`-aarch64-apple-darwin`、`-x86_64-apple-darwin`）**和** lipo 合并的 `-universal-apple-darwin`（`scripts/build-macos.sh --universal` 与 `.github/workflows/release.yml` 均已如此）。
- Prevention: 改动 universal 打包流程时，先确认 `src-tauri/binaries/` 同时具备每架构与 universal 三种命名。
- Verified by: CI 在补齐每架构副本后完成 universal 构建并产出 `AgentPort_universal.app.tar.gz`（lipo -info 显示 x86_64 + arm64）。

## `GitHub Actions Apple 签名变量` — 缺失的 secret 是空字符串，不是“未设置”

- Wrong approach: 在 tauri-action 步骤里无条件写 `APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}` 等，认为没配置 secret 就等同于没有该环境变量。
- Why it failed: 未配置的 secret 会展开为空字符串，变量依然存在；Tauri 看到 `APPLE_CERTIFICATE` 就尝试导入证书，失败于 `security: SecKeychainItemImport: One or more parameters passed to a function were not valid`，整个打包中止。
- Recognition signal: 未做任何 macOS 签名的仓库在 bundling 后立刻出现 `failed to import keychain certificate`。
- Correct approach: 用一个准备步骤把非空值写进 `$GITHUB_ENV`（`emit name value` 跳过空值），tauri-action 步骤本身不再直接引用这些 secret。
- Prevention: 任何“可选签名/公证”secret 都必须经过“非空才导出”的一层，禁止直接 `env: X: ${{ secrets.X }}`。
- Verified by: 修正后 CI 通过 bundling、生成 `AgentPort.app.tar.gz.sig` 并完成发布（run 35182159184）。

## `updater feed` — 私有仓库的 Release 资产匿名拉不到

- Wrong approach: 把 `https://github.com/<owner>/<repo>/releases/latest/download/latest.json` 当作公开 feed，同时在私有仓库里发布。
- Why it failed: 私有仓库的 Release 资产对未认证请求返回 404，客户端 `check()` 报 `update endpoint did not respond with a successful status code`（app.log 里可见），应用内更新永远失败。
- Recognition signal: `curl -o /dev/null -w '%{http_code}' <feed>` 得到 404，而 `gh release view` 里资产齐全。
- Correct approach: feed 所在仓库必须匿名可读（本仓库 v0.1.0 起已设为 public）；若必须保留源码私有，就另建 public 的 releases-only 仓库并在 workflow 里发布到那里。
- Prevention: 每次发布后用未认证 curl 校验 `latest.json` 与安装包均为 200/302，再宣布可用。
- Verified by: 仓库转 public 后匿名 `latest.json` 302、DMG 200，本地 0.0.9 客户端从真实 feed 升级到 0.1.0 成功。

## `macOS 更新安装路径` — 符号链接路径会被 updater 拒绝

- Wrong approach: 把待升级的 `AgentPort.app` 放在 `/tmp`（或任何含符号链接的路径）里测试应用内升级。
- Why it failed: `/tmp` 是 `/private/tmp` 的符号链接，插件定位安装路径时报 `StartingBinary found current_exe() that contains a symlink on a non-allowed platform: /tmp`，check 阶段即失败。
- Recognition signal: `update endpoint…` 之前先出现 current_exe 符号链接错误；换到 `~/…` 后立刻正常。
- Correct approach: 用真实路径（`/Applications`、`~/AgentPortE2E` 等）验证升级；正式分发本就不应从 DMG 或符号链接目录直接运行。
- Prevention: 复现应用内升级前先 `python3 -c "import os;print(os.path.realpath(<path>))"` 确认路径无符号链接。
- Verified by: 同一二进制在 `/tmp` 下失败、在 `~/AgentPortE2E` 下完成下载→校验→安装→重启全过程。

## `tauri-action release creation` — 用 gh 预建 release 绕过 403

- Wrong approach: 完全交给 `tauri-action` 在 tag push 时创建 Release（`releaseDraft: false`）。
- Why it failed: 同一 workflow 声明了 `permissions: contents: write`，用相同 token 手工 `POST /releases`（以及 `gh release create`）都能成功，但 tauri-action 的创建调用返回 `Resource not accessible by integration`（根因未定位）。
- Recognition signal: 构建、updater 签名、资产收集全部成功后，日志停在 `Couldn't find release with tag <tag>. Creating one.` 紧跟 403。
- Correct approach: 在构建前用 `gh release create "$GITHUB_REF_NAME" --verify-tag`（或 `gh release view` 复用）先建好 release，tauri-action 之后只做上传与 `latest.json` 合并。
- Prevention: 把 release 创建放在昂贵的构建之前，权限问题会在几秒内暴露，而不是等 10 分钟构建结束。
- Verified by: 加入预建步骤后同一 tag 的 run 35182159184 全绿，产出 DMG、`.app.tar.gz`、`.sig` 与 `latest.json`。

## `gh 在无 checkout 的 job` — 必须显式给仓库

- Wrong approach: 在只做上传的 job（没有 `actions/checkout`）里直接 `gh release view "$TAG"` / `gh release upload "$TAG" ...`。
- Why it failed: gh 需要 git 仓库上下文来推断 `owner/repo`，没有 checkout 时报 `failed to run git: fatal: not a git repository`；重试循环因此空转 20 次后失败，而三个 Linux 构建 job 都已经成功。
- Recognition signal: 上传 job 的日志里全是 `waiting for release <tag>`，最后紧跟 `fatal: not a git repository`。
- Correct approach: 每个 gh 调用都带 `--repo "$GITHUB_REPOSITORY"`（或补一个 checkout）。
- Prevention: 任何"只读/只写远端"的 job 都当作没有仓库上下文来写；本地跑通不代表 CI 能跑通。
- Verified by: run 35205952385 修正后 `Attach Linux assets: success`，v0.1.1 Release 同时具备 macOS 与 Linux 资产。

## `Release 资产上传` — 以 `state` 为准，且本机大文件上传不可靠

- Wrong approach: 用 `gh release upload` / `curl` 从本机往 `uploads.github.com` 传 5–23 MB 的资产，并把"API 里能看到该名字 + size 相同"当作上传成功。
- Why it failed: 该端点在本机上行链路上会静默停滞（约 41 KB/s，最终 `0 bytes received`），服务端只留下 `state=starter` 的占位记录（size 是请求声明的值），`releases/download/...` 下载返回 404；绕开本机代理（127.0.0.1:7890）直连同样失败，而 `git push` 到 `github.com`、下载 CDN 都正常。
- Recognition signal: 资产列表里 `state=starter`；`curl -sSL .../releases/download/<tag>/<asset>` 得到 9 字节的 404；客户端只看到 size 相同就以为成功。
- Correct approach: 发布走 CI（GitHub runner 上传自己家的资产）；需要补发历史 tag 时用 `gh workflow run release.yml -f tag=<tag> -f platforms=linux` 重建并上传，不要从本机硬传；判成功看 `GET /releases/{id}/assets` 的 `state == uploaded`。
- Prevention: 资产校验脚本里禁止用 size 作为成功判据；上传后必须回读下载 URL（匿名）并核对 sha256。
- Verified by: 同一批资产本地直传 40 分钟未成功（starter），CI 重跑后三个资产全部 `state=uploaded`，匿名下载 sha256 与 `SHA256SUMS-linux` 完全一致。

## `Pi 恢复后的首个 turn end` — 不能把继承的 idle 写进去重基线

- Wrong approach: 恢复已完成 Pi 回合时，用常规观察路径（`sm.observe(Observation::AdapterTurnEnd)`）发布 idle，然后靠"状态+来源相同则去重"抑制重复通知。
- Why it failed: 该发布把状态机的去重基线设成 `(Idle, Adapter)`，而本次运行真正的回合结束携带的是同一对值，于是被当作重复丢掉：没有完成事件，也就没有"回合完成"通知（RPC 路径没有 TurnStart 来打断去重）。
- Recognition signal: 恢复了已完成 Pi 回合的会话，用户下一轮输入结束后 Host 只发 Heartbeat，无 `adapter:pi:TurnEnd` 的 State 帧。
- Correct approach: 用 `StateMachine::publish_inherited_turn_end` 发布继承快照：照常写持久状态与精确生命周期权威（`lifecycle=Idle`），但**不写** `last`/`last_evidence`/`last_completion`。
- Prevention: 任何"合成的状态发布"都必须与"本次运行真实观察到的状态"区分开，回归测试同时断言"首个真实完成会被上报"和"重复完成仍被去重"。
- Verified by: `pi_rpc_pipe_accepts_prompt_abort_and_persists_structured_events` 与新增的 `inherited_turn_end_does_not_swallow_the_runs_first_completion` 通过；host 集成 42/42、core 状态 19/19。

## `macOS accept()` — 继承的 non-blocking 会吞掉超时语义

- Wrong approach: 只对 listener 调 `set_nonblocking(true)` 做轮询 accept，然后给 accepted socket 设 `set_read_timeout` 就以为读会阻塞到超时。
- Why it failed: macOS/BSD 上 accepted socket 继承 listener 的 O_NONBLOCK（Linux 不会），read 立即返回 EAGAIN；客户端字节稍晚到达就被判定为超时并关闭连接（客户端只看到 `Pairing connection interrupted`）。20 次套件运行中复现 2 次。
- Recognition signal: `read_before` 的首个 read 立即 `WouldBlock (os error 35)`，`remaining` 仍是 ~3s；负载越高越容易出现；Linux 上从不复现。
- Correct approach: accept 之后显式 `stream.set_nonblocking(false)`；并把 `WouldBlock`/`TimedOut` 当作"继续等协议 deadline"，而不是连接级错误。
- Prevention: 任何"轮询 accept + 阻塞式读写"的服务器都要在 accept 后显式设置阻塞模式；跨平台服务必须在本机（macOS）与 CI（Linux）两端各跑一遍带负载的循环验证。
- Verified by: 修复后 40/40 连续套件运行全绿（修复前 20 次里失败 2 次）。

## `worktree remove` — 同一道栅栏不能被取两次

- Wrong approach: CLI 先 `db.begin_worktree_removal(id)` 再调用 `WorktreeManager::remove(id)`（后者内部又取一次同一道栅栏）。
- Why it failed: 第二次取栅栏必然失败，于是 `worktree remove` 对**任何**工作区都返回 "removal is already in progress"；GUI 走的是 `remove_after_fence`，所以只有 CLI 受影响，长期无人发现。
- Recognition signal: 新建的干净 worktree 立刻删除也报 "already in progress"；`git worktree list` 仍注册该目录。
- Correct approach: 已持有栅栏的调用方必须走 `remove_after_fence`（service 层是这样做的）。
- Prevention: 凡是"先占栅栏再委托"的流程，委托函数要显式区分"自己取栅栏"和"沿用调用方栅栏"两个入口，并为 CLI 这类少走的路径保留一个最小回归（create → health → remove）。
- Verified by: 修复后 create（`--base-ref`）→ health=dirty → remove 成功，`git worktree list` 条目消失，主 checkout 内容不变。

## `e2e harness 漂移` — 断言已移除的产物会让门禁长期红灯

- Wrong approach: 把 e2e 断言绑在具体实现产物上（`runs/<id>/output.log`、`export log`、诊断包里的 terminal 正文），架构改成"不保存 PTY 正文副本"后没有同步。
- Why it failed: 每次重跑必然失败，失败原因还指向错误的层（看起来像导出/搜索坏了，其实是断言过期）；同时掩盖了真正的产品缺陷（例如同一轮里发现的 `worktree remove` 与 pairing 缺陷）。
- Recognition signal: 失败信息显示文件/成员/命令"不存在或被移除"，而对应能力在文档里已明确删除（docs/user-guide.md 的"不保存正文索引"、"raw terminal log export was removed"）。
- Correct approach: 把断言重新表述为当前契约（重连读取字节连续、raw 导出显式报错、md/json 说明缺原生历史、诊断包只带状态事件、CLI 检索只覆盖原生日志），内容级导出/检索继续由 core 的原生历史集成测试用 fixture 覆盖。
- Prevention: 删除或替换某个持久化产物时，同一提交里搜索并更新 e2e/脚本中的引用（`rg 'output\\.log|export log' e2e scripts`）。
- Verified by: wave1/wave2 重新基线后双双 PASS，发布清单五项门禁全绿。

## `移除 PTY 日志后的遗留面` — 先删“会读它的活路径”，再谈字段

- Wrong approach: 架构改成"不保存 PTY 正文副本"后，只删掉写日志的代码，把读它的路径（导出、远端能力、诊断字节数）留着，认为"反正文件不存在，报错就报错"。
- Why it failed: 这些路径不是无害的空转——`Exporter::export_log/export_markdown` 会 `std::fs::read` 一个永不存在的文件并在 CLI/Service 之外仍可被调用；远端 `session.recovery_context.read` 永久失败（`metadata` NotFound）；`diag hosts` 的 `logBytes` 永远 0；`perf` 的 crash-recovery 场景把空文件当"输出连续"的证据，log_rotation 场景整个前提消失。
- Recognition signal: 调用方是测试自己写出来的产物（`index_session_log`、`rebuild_all`、`query` 只有单测调用），或实现里出现 `unwrap_or_default()`/`unwrap_or(0)` 掩盖"读不到"的事实。
- Correct approach: 先用 `rg 'log_path|output\.log'` 列出全部读写点并逐个判定：活路径 → 改读真实来源（Host socket / 原生日志 / durable cursor）；纯死代码 → 连同测试删除；仅剩兼容字段 → 注释标明"legacy、只读不写"并记录待清理。
- Prevention: 删除任何持久化产物时，同一任务里搜索并处理 `read/export/metadata/perf` 四类消费者；不确定是否可达时，用"该函数是否有非测试调用方"作为判据（`rg '\.func\(' --glob '!*test*'`）。
- Verified by: 删除后 workspace 全绿（30 套件），`npm test` 683/683，两条 e2e PASS；`diag hosts` 的 logBytes 改为 durable cursor（其单测改为写入 cursor 而非文件）。

## `探针超时 2s` — 负载下的假阴性比慢更贵

- Wrong approach: 把只读 CLI 探测（`--version`/`--help`）的硬超时定为 2s，并用固定绝对时间（`elapsed < 6s`）写测试断言。
- Why it failed: 满负载套件运行时，连 `#!/bin/sh` + `echo` 这样的小脚本都可能超过 2s（实测 `Timeout("… --version exceeded 2s")`），于是"可用 CLI"被判为不可用；同类断言还会随常量调整一起失效。
- Recognition signal: 单测单独跑稳定通过、全量运行时随机失败，且失败信息是 `Timeout(... exceeded 2s)`；断言里出现与常量无关的硬编码秒数。
- Correct approach: 把探针预算提到 5s（对 node 系 CLI 冷启动也更真实），并把测试断言写成 `PROBE_TIMEOUT + slack` 的形式。
- Prevention: 超时相关断言永远引用常量；评估超时时把"负载机器 + 冷启动 CLI"作为默认场景，而不是理想情况。
- Verified by: `cargo test --workspace --all-targets` 连续两轮 EXIT=0（修复前每轮约 1 个 adapter 探针失败）。

## `并发 cargo 与目标目录` — 同一 target 上的并行构建会把缓存打坏

- Wrong approach: 在一个长跑的后台 `cargo test --workspace` 还没结束时，又并行执行 `cargo check` / `cargo test`，并在发现报错后直接 `cargo clean`。
- Why it failed: 两个 cargo 进程同时写 `target/`，随后出现 `extern location for serde_core does not exist`、`found possibly newer version of crate bitflags`、`failed to remove file … No such file or directory`（clean 与仍在运行的构建互相踩）。
- Recognition signal: 报错指向 **registry 依赖**（bitflags/serde/zerofrom 等）而不是自己的代码；同一命令重跑结果不同；`cargo clean` 自身失败并报"文件不存在"。
- Correct approach: 先确认没有 cargo/rustc 在跑（`pgrep -fl cargo`），必要时 `pkill -f 'cargo (test|check|build)'`，再 `cargo clean` 后串行重建；**一次只跑一个 cargo**。
- Prevention: 长测试放后台时不要再起第二个构建命令；把 `cargo` 的并发交给 `cargo test` 内部的 test 线程，而不是多进程。
- Verified by: 并发损坏后 `cargo clean` 失败；清干净进程、串行 `cargo clean && cargo check --workspace --all-targets` 后恢复，最终 30 套件全绿。

## `跨文件删除字段` — 用编译器逐条驱动，别用全局正则

- Wrong approach: 为了退役 `Session.log_path`，用脚本按 `^\s*log_path: .*,$` 删行、并用宽松正则删 `claim_session_run(..., path)` 的第四个参数。
- Why it failed: 正则跨行匹配吞掉了相邻代码——删掉了 `format!` 的参数（`let sql = format!();`）、删掉了 `assert_eq!` 的期望值行、把 `adapter_type` 与 `log_path` 同行的那一行整体删除、还给无关的 `insert_pending_branch_operation` 去掉了一个参数。
- Recognition signal: 编译器报"必须有格式字符串""意外的宏结束""缺少字段 adapter_type"等与本任务无关的错误；`git diff` 里出现与目标字段无关的行。
- Correct approach: 一次只改一处、anchor 必须唯一且**断言出现次数**（`assert count == 1`）；结构体字面量里的字段用**精确的整块 old/new**替换（含相邻字段做锚点），删除函数用花括号配对而不是正则；每改一处立刻 `cargo check`。若已经改坏，直接 `git checkout HEAD -- <file>` 重来比修补更快。
- Prevention: 批量删除前先枚举全部引用点（`rg -F -n`）并分类（列定义 / 字段 / fixture / SQL / 断言），对"多行表达式 + 同行多字段"两类单独手改。
- Verified by: 重做后 `cargo check --workspace --all-targets` 与 `cargo test --workspace --all-targets` 全绿（30 套件），且迁移测试覆盖 v15→v16 的 `DROP COLUMN`。

## `macOS/mobile icon padding` — removing dark edges must not zoom the artwork

- Wrong approach: Crop 14% from each side of the master and resize to 1024px to eliminate transparent padding.
- Why it failed: The shared Tahoe/mobile artwork enlarged the central C by 1.388×, violating the supplied image's proportions.
- Recognition signal: User reports an oversized C; original-coordinate RGB comparison fails on solid artwork pixels.
- Correct approach: Keep source coordinates and colors; extend edge colors only into transparent padding for opaque platform assets. Retain the transparent macOS ICNS master.
- Prevention: Run `python3 src-tauri/scripts/test-generate-icons.py` before regeneration; inspect opaque and masked previews, not just asset dimensions.
- Verified by: The pixel-preservation regression failed on the crop implementation and passed after edge extension; both icon generators' checks passed.

## `Linux deb desktop icon` — hicolor index stops at 512x512; bundler maps PNG dims to size dirs

- Wrong approach: Shipping only the 1024x1024 master PNG in `bundle.icon` and assuming the launcher will downscale it.
- Why it failed: tauri-bundler (`freedesktop::list_icon_files`) installs each configured PNG at `usr/share/icons/hicolor/<W>x<H>/apps/<bin>.png` using the file's actual pixel dimensions. The hicolor `index.theme` only indexes up to `512x512` (+ `scalable`); `1024x1024/apps` is not listed, so every GTK/KDE launcher lookup misses and shows the generic placeholder.
- Recognition signal: Installed deb contains exactly `usr/share/icons/hicolor/1024x1024/apps/agentport.png`; `grep '^\[1024x1024/apps\]$' index.theme` is empty; `Gtk.IconTheme.lookup_icon('agentport', size, 0)` returns None at 16–256 while the file exists on disk.
- Correct approach: Provide standard sizes in `src-tauri/tauri.conf.json` `bundle.icon` — `32x32.png`, `128x128.png`, `128x128@2x.png` (256px, `@2x` stem → `@2` scale dir), `512x512.png` — generated from `icons/icon-runtime-8bit.png` with `magick -filter Lanczos`. Keep the largest PNG first: tauri-codegen embeds the first `.png` in the list as the runtime window icon (`find_icon(... ends_with(".png") ...)`).
- Prevention: `scripts/linux/verify-in-container.sh` now fails the release verification unless at least one installed `hicolor/<size>/apps/agentport.png` sits in a size dir listed by `index.theme`.
- Verified by: Ubuntu 24.04 container on the published 0.1.1 deb: GTK lookup NOT FOUND at 16/24/32/48/64/128/256 (bug reproduced); after installing the new set at bundler-computed paths, lookup resolves and loads pixbufs at every size; the new gate flags the old deb as FAIL.

## `Linux frameless window` — platform config file beats runtime set_decorations; predicate belongs in store

- Wrong approach: Calling `window.set_decorations(false)` from Rust `setup()` on Linux, or duplicating `app.windows[0]` into a `--config` JSON string in each Linux Dockerfile.
- Why it failed: The config window is created decorated before setup runs, so the native title bar flashes and the layout jumps on every launch. Separately, the Tauri CLI merges config overrides with JSON-merge-patch semantics — arrays are REPLACED wholesale — so inline `--config` window patches must duplicate the entire window object per Dockerfile and silently drift.
- Recognition signal: Linux release shows the WM title bar above the app's own TopBar; `grep decorations` on the binary proves nothing (embedded config is not greppable text).
- Correct approach: Drop `src-tauri/tauri.linux.conf.json` next to `tauri.conf.json` — both the CLI and tauri-build auto-discover `tauri.<target>.conf.json` and merge it for Linux builds only (bundling AND the runtime-embedded config), with `windows[0]` = the base window plus `"decorations": false`. Guard drift with `scripts/linux/check-linux-window-config.mjs` (runs inside the Linux Docker builds). Frontend owns the chrome gated on `platform.os === "linux" && platform.windowDecorated === false` (real state injected by `boot` from `window.is_decorated()`): TopBar min/max/close + double-click maximize, `WindowResizeHandles` edge zones via `startResizeDragging` (decorations off also removes the native resize border), and matching `core:window:allow-*` capabilities.
- Prevention: Keep platform predicates like `isLinuxFramelessChrome` in `store.ts`, not `actions.ts` — many component tests mock `./actions` wholesale, and an action-living predicate crashes those renders with "not a function".
- Verified by: Frontend 691/691 (incl. new TopBar-controls and resize-handles suites), Tauri 60/60, production build green; merge semantics confirmed against tauri-cli 2.11.4 `load_config`/`read_platform` and tauri-build `try_build` sources.

## `wry drag-drop coordinates` — positions are already logical on macOS+Linux; never divide by devicePixelRatio

- Wrong approach: Consuming wry `DragDropEvent` positions as physical pixels and dividing by `window.devicePixelRatio` before `elementFromPoint` (and naming helpers `...AtPhysicalPosition`).
- Why it failed: wry fills positions with whatever the native toolkit reports — GTK widget coordinates and NSView points are both LOGICAL (CSS) pixels; only webview2 (GetCursorPos/ScreenToClient) is physical, and this app ships no Windows build. On any HiDPI display (DPR=2) the division halves the coordinates, so every internal Session drag misses its split-zone target and OS file drops can hit the wrong pane. DPR=1 divides to a no-op, which is why it only breaks for some users. A unit test had even locked in `200/2=100` as "correct".
- Recognition signal: On Linux HiDPI, dragging a Session onto a split group never highlights/accepts the drop, and the drag ghost balloons ~2x (separate WebKitGTK bug: the default drag snapshot is rasterized at device scale).
- Correct approach: Use wry positions as CSS pixels directly (comment cites per-backend coordinate spaces from wry 0.55.1 sources). For the ghost, `dataTransfer.setDragImage(<shared 1px transparent element>, 0, 0)` on Linux only — wry consumes the native drag there anyway, so targeting runs through `sessionNativeDrag` forwarding and the ghost carries no information.
- Prevention: Regression test stubs `devicePixelRatio=2` and asserts `elementFromPoint` receives the RAW position (200,100), not the halved one; ghost suppression asserts Linux swaps the image while macOS/unknown platforms keep the native one. When a platform quirk needs a predicate, keep it in `store.ts` (tests mock `./actions` wholesale). Apply a dragstart workaround to EVERY drag entry point — the tree drag (`terminalDrop.writeDragPayload`) was missed until a later audit; embed the suppression in the shared payload writer where it has a single caller.
- Verified by: Frontend 693/693, production build green; coordinate spaces confirmed against wry 0.55.1 `webkitgtk/drag_drop.rs` (gtk drag-motion widget coords), `wkwebview/drag_drop.rs` (NSView points), `webview2/drag_drop.rs` (physical). Real HiDPI-Linux hardware verification remains pending (no local device).

## `macOS TCC grants vs app updates` — ad-hoc cdhash resets every folder permission; sign releases with a stable certificate

- Wrong approach: Shipping Release builds with the default ad-hoc signature and treating repeated "AgentPort 想访问文稿/桌面/下载文件夹" prompts as an app bug in directory-scanning code.
- Why it failed: TCC matches grants by designated requirement. Ad-hoc DR = `cdhash H"..."` which changes on EVERY build, so each update makes macOS treat the app as brand new (`tccd` log: `Failed to match existing code requirement for subject com.agentport.desktop`) and every previously granted folder permission re-prompts. The actual disk access came from terminals' child processes (an easy-pi agent's `find ~` at 11:18 hit Documents/Desktop/Downloads and produced a prompt cascade — attribution rolls up to the app), which is legitimate and unfixable app-side; the bug was that grants never survived an update.
- Recognition signal: `codesign -dv /Applications/AgentPort.app` → `Signature=adhoc`; TCC log `AUTHREQ_ATTRIBUTION` shows `binary_path=/usr/bin/find` or `/bin/bash` with `responsible_path=.../AgentPort.app`; the same "permission prompts come back after every update" complaint.
- Correct approach: Sign releases with a long-lived certificate so DR becomes `certificate leaf = H"<cert hash>"` (stable across builds). A 10-year self-signed codesigning cert is strictly better than ad-hoc (same Gatekeeper trust, TCC-stable); material lives in `~/.agentport-release-signing/` + CI secrets `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_SIGNING_IDENTITY` (`release.yml` already gates on their presence). First stable-signed update still re-prompts once (DR changes from cdhash to cert hash), then never again. Declare `NSDocumentsFolderUsageDescription` etc. in `src-tauri/Info.plist` so the prompt explains terminal/agent access.
- Prevention: Local release builds pick the identity via `.env` `AGENTPORT_RELEASE_SIGN_IDENTITY` (read by `scripts/build-macos.sh`, exported as `APPLE_SIGNING_IDENTITY` — honored by `tauri build` per Tauri v2 env docs). Never publish ad-hoc releases; check `codesign -d -r-` shows `certificate leaf =` not `cdhash` before tagging.
- Verified by: Fresh keychain + p12 import + `codesign -s "AgentPort Release Signing"` produces `designated => identifier ... and certificate leaf = H"ca6e4e1d..."`; same DR across two independently signed binaries.

## `security find-identity` — "0 valid identities found" is a false negative for imported identities

- Wrong approach: Concluding a LibreSSL-generated p12 "cannot pair cert+key on macOS" because `security find-identity -v -p codesigning <custom.keychain>` lists nothing, and rebuilding cert generation (certtool, native APIs) to fix a non-existent pairing bug.
- Why it failed: The identity was correctly formed all along — `SecIdentityCreateWithCertificate` returned OK and `codesign -s <name>` signed successfully with the expected DR. `security find-identity` simply does not list these identities (custom keychain/import-path quirk), sending the investigation down a certtool/p12-attribute rabbit hole.
- Recognition signal: `security import` says "1 identity imported" yet `find-identity` shows none; the same name still resolves in `codesign -s`.
- Correct approach: Verify identities by USE, not by listing: import into a throwaway keychain (`security create-keychain` + `import` + add to `list-keychains -s`), then `codesign -s <name> --force /usr/bin/true-copy` and inspect `codesign -d -r-`.
- Prevention: Same rule as LEARNS screenshot helpers — trust the end-to-end operation over the enumeration API whenever the two disagree.
- Verified by: p12 imported into `/tmp/ap-verify.keychain` signed `/tmp/sigtest4` with `certificate leaf = H"ca6e..."` despite `find-identity` reporting 0.

## `rebuild-debug-app.sh bundle reuse` — Resources/icon.icns and new Info.plist keys never refresh

- Wrong approach: Assuming editing `src-tauri/icons/*` or adding keys to `src-tauri/Info.plist` reaches the debug App on the next `restart-debug-app.py`.
- Why it failed: the script reuses the already-generated `target/debug/bundle/macos/AgentPort.app` and only swaps `Contents/MacOS/*` binaries — `Contents/Resources/icon.icns` and `Info.plist` keep whatever the last full `tauri build` produced (the icon regression fix initially shipped into the bundle as the old square icon; bundled-icns corner pixels stayed opaque).
- Recognition signal: `iconutil -c iconset` on the BUNDLED icns disagrees with `src-tauri/icons/icon.icns`; bundled plist lacks a key present in the source plist.
- Correct approach: The script now syncs `src-tauri/icons/icon.icns` (when changed) and the `NS*UsageDescription` keys before re-signing. Release builds are unaffected (full `tauri build` re-bundles every time).
- Prevention: When adding bundle resources (icons, plist keys, entitlements), check the sync list in `scripts/rebuild-debug-app.sh`; icon artwork itself is guarded by `python3 src-tauri/scripts/generate-icons.py --check` (transparent corners — full-bleed square masters render as the "rectangle icon" regression from 836b697).
- Verified by: After the sync, bundled icns corner alpha = 0 and Finder renders the rounded icon; before, corners were opaque dark.

## `.env sourced by bash` — quote values containing spaces

- Wrong approach: Adding `AGENTPORT_RELEASE_SIGN_IDENTITY=AgentPort Release Signing` unquoted to `.env`.
- Why it failed: `rebuild-debug-app.sh` does `source .env`, so the unquoted line executed `Release` as a command (`line 2: Release: command not found`, exit 127) and the whole debug rebuild/restart failed.
- Recognition signal: A previously green restart script dying with `command not found` naming a word from the new .env value.
- Correct approach: Always quote space-bearing values in `.env` (`VAR="a b"`); extraction with `sed 's/^VAR=//' | tr -d '"'` strips them again.
- Prevention: Keep `.env` lines in `KEY=value` (no spaces) or `KEY="value with spaces"` form only; `bash -c 'source .env'` smoke-check after editing.
- Verified by: `source .env` now yields both identities cleanly and `restart-debug-app.py` completes.

## `src-tauri/tauri.conf.json` — the repo's toolchain does not accept `//` comments

- Wrong approach: Writing `//` comment lines inside `src-tauri/tauri.conf.json` (e.g. to explain a `resources` entry).
- Why it failed: `tauri-build` parses the config as strict JSON (`unable to parse JSON Tauri config file ... because key must be a string at line X column Y`), and `src/src/terminal-drag-drop-config.test.mjs` reads the same file with `JSON.parse` — one comment breaks both the Rust build and that frontend test at once.
- Recognition signal: Debug/release build dies in the tauri build script with "key must be a string at line X column Y", or the frontend suite shows exactly one failure: `Expected double-quoted property name in JSON` in terminal-drag-drop-config.test.mjs.
- Correct approach: Keep explanations out of the JSON (commit message or docs/ instead). When such a parse error appears, first run `git diff src-tauri/tauri.conf.json` — the cause may be someone's uncommitted WIP in the shared working tree, not your own change.
- Prevention: Before committing, syntax-check with `python3 -c "import json; json.load(open('src-tauri/tauri.conf.json'))"`; when a build/test fails on a config you did not touch, `git status` the repo before debugging the toolchain.
- Verified by: On 2026-09-18 the debug build failed on an uncommitted `//` comment at line 43 while the same file made terminal-drag-drop-config.test.mjs the single failure out of 731 frontend tests; stashing the file made both the build and the suite pass.

## `macOS 26 (Tahoe) icon jail` — plain .icns renders ~20% smaller on a gray tile; ship a compiled Icon Composer .icon

- Wrong approach: Fixing the "square icon" regression by restoring a rounded-corner .icns and calling it done.
- Why it failed: macOS 26 renders any app whose icon is only a plain .icns inset on a gray glass tile ("icon jail") — users see "图标未被填充满，周围存在透明/灰底". Only a layered **Icon Composer** document (`.icon`) compiled into `Assets.car` gets full-size rendering (plus Liquid Glass effects). Verified empirically: same bundle rendered by LaunchServices at ~70% tile fill with .icns-only vs ~87% full-bleed squircle with the car.
- Recognition signal: On Tahoe the Dock icon sits on a light-gray rounded background clearly smaller than system icons; `assetutil --info Assets.car` shows `IconGroup`/`.iconstack` only when a real .icon is compiled in.
- Correct approach: Author `src-tauri/icons/AgentPort.icon/icon.json` (kebab-case schema: top-level `fill`, `groups[].layers[]` with `image-name`/`position`; colors as `srgb:r,g,b,a`; `fill` is one of `orientation|solid|linear-gradient|automatic-gradient`), compile with `src-tauri/scripts/build-icon-car.sh` (`actool BUNDLE --compile OUT --app-icon AgentPort --include-all-app-icons --platform macosx --minimum-deployment-target 13.0 --target-device mac`), COMMIT the car, and ship it via `bundle.resources` + `CFBundleIconName` (older macOS falls back to `CFBundleIconFile` = icon.icns; the car also embeds classic renditions 16..1024, so 13–15 get a normal icon too).
- Prevention: `ictool <doc> --export-image --platform macOS --rendition Default` (inside Icon Composer.app/Contents/Executables) previews the exact system render headlessly — iterate design there, not in the Dock. The glass material mutes artwork: lift midtones (~gamma 0.62 + 1.18 gain) when deriving layers. JSON type errors surface one key at a time ("fill should be one of…", "Invalid color encoding, missing ':'"), so build the document incrementally. `tauri.conf.json` is strict JSON — no `//` comments (breaks both tauri CLI and python json). LaunchServices caches icons aggressively by path: after rewriting bundle resources, verify with a FRESH throwaway .app (`NSWorkspace.icon(forFile:)`), not the repeatedly re-registered debug bundle (it returned the generic document icon for the real one).
- Verified by: Throwaway app with only Assets.car + icon.icns + CFBundleIconName renders the full-size glass icon via NSWorkspace; `generate-icons.py --check` covers .icns corners + .icon inputs + car presence.

## `CLI probe timeout` — a CLI that never prints `--version` is macOS quarantine, not a slow CLI

- Wrong approach: Treating `发现 N 个候选，但均无法通过只读探测：<path>: timeout: … --version exceeded 5s` (plus a session that opens with a permanently empty terminal) as an AgentPort spawn/PATH bug, or trying to widen the 5 s probe budget.
- Why it failed: the Homebrew cask had stamped `com.apple.quarantine` on the download and on its unpacked directories (`Caskroom/codex/0.155.0/`, `bin/`, `codex-resources/`). macOS runs the Gatekeeper assessment *before* the process reaches `main`: `codex --version` sat in `_dyld_start` printing nothing and never exiting, `sample <pid>` showed a single `_dyld_start` frame, and `syspolicyd` logged a fast retry loop (`Unable to initialize qtn_proc: 3`, repeated `GK evaluateScanResult` CFNetwork tasks). The stall is bounded but huge — the first exec of one file completed after **5m41s**, after which the attribute was rewritten with flag `0x40` (user-approved) and later execs were instant. A quarantined **copy** stalls identically; the same copy with the attribute removed runs in milliseconds — the parent process (Terminal, `launchctl`, AgentPort host) makes no difference.
- Recognition signal: `xattr -r <cli>` shows `com.apple.quarantine` on the binary or an install directory; the process exists but never writes a byte; everything else on PATH starts normally. `spctl --status` may read "assessments disabled" — with Gatekeeper's approval path off, the wait has no upper bound.
- Correct approach: `xattr -dr com.apple.quarantine /opt/homebrew/Caskroom/<cask>` (Apple-signed bundles: `xattr -cr <app>`), then re-probe; no assessment is needed afterwards, so `--version` returns immediately and sessions render. `brew upgrade`/`reinstall` re-adds the attribute — repeat after each upgrade. If the timeout survives the cleanup, that path carries an unfinished assessment: move to a fresh path (new version directory) or reboot.
- Prevention: the probe failure reason now names the attribute and the path to clean (`capability.rs` → `quarantine_origin` checks the executable plus 6 ancestors and reports the outermost quarantined path), and `docs/troubleshooting.md` has the symptom→cause→fix entry. For any agent CLI that starts nowhere and prints nothing, check `xattr -r` before blaming AgentPort.
- Verified by: `agentport-cli probe codex` went unavailable (5 s timeout) → available (`codex-cli 0.155.0`), and a codex session went from 0 bytes to a rendered TUI banner after the cleanup; the next `brew upgrade --cask codex` (0.155.1) re-quarantined the tree and needed the same one-liner.

## `iOS IME text the user never typed` — 归属模型必须把"未发送文本"当成一等状态

- Wrong approach: 把"终端收不到输入"当作传输/Host 问题，或把适配层的"无法证明就不发"当成安全默认值 —— 只要每次拒绝都顺带清空归属，用户看到的就是"以后什么都打不进去"，而不是"这一次没发"。
- Why it failed: `iosIme.ts` 的 `reconcile()` 只用 `atEnd`（光标在 textarea 末尾）判定追加/删除。输入法自动补全（打 `(` 补出 `()`、智能引号补成对）会把光标留在自己补出的字符**前面**，`atEnd` 从此永不成立，之后每次编辑都判 `unproven-edit` 且 `input` 仍在捕获阶段 `stopImmediatePropagation`，xterm 兜底也拿不到事件。真实 xterm + 合成事件复现：配对后 `sent=[]`（一次事件插入）或 `sent=["("]` 之后全空（两次编辑），且该状态下退格会由 xterm 发出一个 DEL —— 抹掉终端没收到过的字符。
- Correct approach: 在适配层跟踪 `ghosts`（输入法插入、用户没敲过的区间，偏移基于基线）：一次插入中光标越过的前缀算用户输入，其余登记为 ghost；ghost 永不发送、永不计入 DEL；只有"编辑区域之后没有已发送字符"（终端是追加式的）时才映射这次编辑。切分有歧义时拒绝猜测；无法映射的编辑仍放弃归属，但不再因此停止映射后续编辑。配对插入没有 `beforeinput` 时，只有 `(base, value)` 切分唯一才接受。
- Recognition signal: 用户报告"输入 `()`/引号后打不进去"；`iosImeDiagnostics.snapshot()` 里连续 `unproven-edit` 且 `selection` 停在 `[1,1]` 这类非末尾位置；编辑后 `textarea.value` 比已发送内容多出字符（自动补出的收尾符号）。
- Prevention: 给探针本身先做自测再交给真人复现 —— 第一版真机字节记录程序在收到第一块数据后就因 `bytes.endswith("\r")` 混用 `str` 崩溃，只留下一条证据。用 `pty.openpty()` + 写入全角字符串自测一次（含 stop 路径）成本几十秒。
- Correct approach (third instance): 同一个陷阱还有别的触发方式 —— 带修饰键的快捷键（Ctrl-C）会让 app 调用 `invalidate()`，它把"适配层不拥有任何文本"（`ownedStart = value.length`）但**不清空 textarea**，于是输入法先前的未发送尾字符变成"看起来已发送"，之后每次插入都判 `unproven-edit`，用户彻底打不进去。结论：**只有破坏性操作（DEL/撤回）该保守，转发用户输入的插入不该被"光标之后有已发送字符"拦住**；判定条件放在"形状是否是一次见证过的单点纯插入"上。
- Correct approach (second half): 字节证据不足以推断 DOM 形状。真机第二轮实测显示：配对字符**整段已经发出**（插入时光标还在末尾），输入法随后把光标移进括号内且不发 DOM 事件 —— 此时只跟踪"未发送文本"没用，因为收尾符已经在终端里。必须再记 `lastPadding`（该按键插入的收尾符区间），当且仅当用户的下一次输入**正好落在它前面**（或按键离开适配层前光标停在它前面）时，先发一个 DEL 撤回它、把它登记为 ghost，再发用户文本；配对里的开括号永不撤回。`input.data` 与 DOM 插入长度是否一致仍未验证 —— 该修复不依赖这个差异。
- Verified by（真机）: 付费团队签名 archive + `devicectl device install app` 装到 iPhone 17 Pro Max（iOS 27.0）后按同一组步骤复测：修复前台账为“配对整段到达→之后文本零字节→回车仍有效”，修复后台账为“配对整段到达→用户一打字先发 `\x7f` 撤回补出字符再发用户文本”，另一形状下补出字符作为 ghost 从未发出；两种形状均覆盖（`/tmp/ime-probe/fix-verify*.jsonl`，见 `mobile/IME_PAIRED_PUNCTUATION.md`）。
- Verified by（回归）: 新增 `iOS IME text the user never typed` 15 项回归：6 项在最初实现上失败（含两处为未发送字符发 DEL），另有 4 项（整段发出后的输入、按键前撤回）在"只修 ghost"的第一版修复上失败；最终 Mobile 460 项、真实 Chrome 渲染回归与 `npm run build` 全通过。真机字节探针两轮实测：全角 `（）`、弯引号 `“”` 均整块到达 Host，其后用户输入的文本**一个字节都没到**而回车照常到达（会话 `.zsh_history` 亦记录到完整命令行），与适配层复现的第一处分歧一致（见 `mobile/IME_PAIRED_PUNCTUATION.md`）。

## `HTTPS push 卡死` — 本机推 GitHub 用 SSH

- Wrong approach: 反复用 HTTPS 远端（`origin` = https://github.com/…）推送 release 提交，失败后只是重试同一个协议，甚至用 `--config http.version=HTTP/1.1` 再试。
- Why it failed: 本机上行到 github.com 的 HTTPS 推送会挂住（实测单次 10+ 分钟无进展，多个提交/小体积也一样），而同一时刻 `api.github.com` 请求、下行下载与 SSH 都正常；`uploads.github.com` 早前也是同类症状。
- Recognition signal: `git push` 长时间无输出（可 `git ls-remote` 看到远端未更新），`ps` 里 `git remote-https` 一直存在，但 `curl` 小请求 1s 内返回。
- Correct approach: 走 SSH —— `git push git@github.com:<owner>/<repo>.git main`（本机 key 已验证可用，实测瞬间完成）；需要时给 push 加看门狗（后台 sleep 90s 后 kill 再重试），因为 macOS 没有 `timeout`。
- Prevention: 发布流程里先 `ssh -T git@github.com` 探活；HTTPS 推送连续两次无进展就切 SSH，不要无限重试。
- Verified by: v0.1.2 的 main 与 tag 在 HTTPS 连续 4 次挂住后，SSH 一次推送成功（`MAIN_OK` + `[new tag] v0.1.2`）。

## `macOS codesign 身份解析` — 证书名必须落在 Tauri 认的前缀里

- Wrong approach: 先怀疑 `APPLE_SIGNING_IDENTITY` 值不对，改成"有证书就不转发 identity"（让 Tauri 从证书推导），然后重跑期望通过。
- Why it failed: Tauri 的推导同样会失败——`tauri-macos-sign` 只用 7 个固定前缀（`iOS Distribution:`、`Apple Distribution:`、`Developer ID Application:`、`Mac App Distribution:`、`Apple Development:`、`iOS App Development:`、`Mac Development:`）去 `security find-certificate -c <prefix>` 枚举，命中为空即 `ResolveSigningIdentity`；证书即使导入成功（日志 `1 identity imported.`）也会在这个环节失败。
- Recognition signal: 失败信息是 `failed to bundle project: failed codesign application: failed to resolve signing identity`，紧跟在 `1 identity imported.` 与一段 keychain dump 之后；把 `APPLE_SIGNING_IDENTITY` 去掉后仍然如此。
- Correct approach: 确认 `APPLE_CERTIFICATE` 里的证书 CN 属于上述前缀之一（例如 `Developer ID Application: <名字> (<TEAMID>)`）；不属于就先修证书/换证书。发布不能被它卡住时，用 `gh workflow run release.yml -f tag=… -f platforms=macos -f skip_macos_signing=true` 先发 ad-hoc 包（应用内更新只校验 Tauri 签名）。
- Prevention: 本地先 `security find-identity -v -p codesigning | rg 'Developer ID Application|Apple Development'` 看 CN 形态，再往 CI 塞 secret。
- Verified by: 两次 macOS job（带 identity / 不带 identity）都在同一处失败；`skip_macos_signing=true` 的第三次运行成功产出 DMG + updater 载荷 + latest.json。
