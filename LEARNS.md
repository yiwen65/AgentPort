# Project Learnings

## `macOS debug App restart` — match the GUI executable exactly

- Wrong approach: Selecting PIDs with a substring match on `.../Contents/MacOS/agentport` before restarting the debug GUI.
- Why it failed: The path is also a prefix of `agentport-host`, so the command terminated a Session host and stopped that Session.
- Recognition signal: The candidate PID list contains commands ending in `agentport-host --config ...`, not only the exact GUI executable.
- Correct approach: Select from macOS `ps`'s executable column and require exact equality: `ps -axo pid=,comm= | awk -v bin="$DEBUG_BIN" '$2 == bin { print $1 }'`.
- Prevention: Print and inspect the exact-match PID list before `kill`; never match the full argv by substring and never terminate any `agentport-host`.
- Verified by: A substring match selected both the GUI and a Host; exact `comm` output distinguished the GUI path from `agentport-host`, and the affected Session required a restart.

## `macOS debug App screenshot` — activate the exact debug process before judging a black capture

- Wrong approach: Treating an all-black `screencapture` or inactive-window capture as proof that the debug WebView was blank.
- Why it failed: The exact debug window existed on-screen but was behind the frontmost app; capture showed only the transparent window surface until the debug process was activated.
- Recognition signal: `CGWindowListCopyWindowInfo` reports a layer-0 window owned by `AgentPort Debug - <checkout>`, while the capture is black or shows only traffic lights.
- Correct approach: Resolve the exact debug GUI PID and `CGWindowID`, activate that `NSRunningApplication`, then capture the window with ScreenCaptureKit and inspect the resulting PNG.
- Prevention: Confirm both process path and window owner, activate before capture, and never classify the UI as blank from an inactive transparent-window screenshot alone.
- Verified by: The inactive capture was black; after activating PID 92957, ScreenCaptureKit captured the fully rendered sidebar and Session view.

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

## `xterm replay visibility` — transport completion is not parser completion

- Wrong approach: Hide the replay Skeleton immediately on the Host's `replay_done` message, or only while `runtime.attaching` is true.
- Why it failed: `attach_session` can resolve before xterm drains its asynchronous write queue; the transport marker therefore exposed Canvas while retained-history frames were still being parsed and painted, which looked like high-frequency scrolling to the tail even after tail-repair callbacks were coalesced.
- Recognition signal: The terminal rapidly displays intermediate history after attach although application `scrollToBottom()` calls are already bounded; `replayDone` becomes true before the replay write callbacks run.
- Correct approach: Insert a generation-fenced parser sentinel exactly when the ordered `replay_done` message arrives, keep the overlay while attached-but-not-parsed, and advance runtime completion only from that boundary callback. Later live writes must remain behind the boundary and must not delay replay completion.
- Prevention: Test transport receipt, parser drain, later live writes, stale generations, and overlay visibility as separate boundaries; never use `onWriteParsed` as an all-writes-drained signal.
- Verified by: The runtime regression failed with immediate `replayDone=true` and the component regression failed with no Skeleton before the fix; both pass with the parser boundary, focused terminal tests pass 59/59, and the full frontend suite passes 288/288.

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
- Correct approach: Use `BufRead::fill_buf()` and `consume()` to retain at most the limit, drain an oversized record through its newline, and advance the opaque cursor by every consumed byte so the next page stays on a record boundary.
- Prevention: Keep an oversized-record regression that asserts the buffer is empty after rejection and the immediately following valid JSONL record is still readable; cache bounded Provider discovery metadata once per request instead of rescanning roots for every Session.
- Verified by: `oversized_jsonl_record_is_drained_without_losing_the_next_boundary` passes with an 8 MiB-plus record, and all six native-history tests pass after Codex ID/CWD verification and per-request Codex/Kimi discovery caching.

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

## `xterm terminal snapshots` — persist mouse report encoding separately

- Wrong approach: Resume a live fullscreen TUI from `SerializeAddon.serialize()` plus its Host log cursor and assume the snapshot restores every terminal mode; also restoring SGR only when a new-format snapshot explicitly recorded it leaves cold attaches and migrated snapshots broken.
- Why it failed: xterm serializes mouse tracking such as `DECSET 1003`, but omits the SGR/SGR-pixels report encoding (`DECSET 1006/1016`); Pi emits `1006h` only once at process start, so a bounded tail, missing snapshot, or legacy snapshot can omit it and make the renderer send default mouse reports while Pi still expects SGR, breaking wheel and drag selection together.
- Recognition signal: The Host output contains alternate-screen, mouse tracking, and SGR enable sequences, but a GUI restart leaves the fullscreen screen visible while both wheel and drag stop working; a serialized xterm probe has `1003h` but no `1006h`.
- Correct approach: Observe supported mouse-encoding DECSET/DECRST sequences alongside xterm parsing, store that mode in the versioned terminal snapshot, restore it before continuing from the saved log cursor, and reset the tracked mode on terminal reset/RIS. For fullscreen Pi, also restore SGR on a cold attach and repair legacy/default snapshots because their one-time launch sequence is behind the replay boundary.
- Prevention: When a snapshot resumes after an output cursor, audit every non-content parser mode that the serializer omits; regression-test explicit snapshots, migrated snapshots, and no-snapshot bounded tails rather than relying only on visible screen equality.
- Verified by: The active Pi stream contained one launch-time `1006h`; both cold-attach and legacy-snapshot regressions failed before the fallback and passed afterward, terminal renderer tests pass 69/69, and the frontend suite passes 333/333.

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
