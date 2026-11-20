# Task Plan: Trace terminal output latency and batch PTY frames

- Created: 2026-11-20
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: User request: add offset-correlated stage timestamps, batch PTY output to 4–16 KiB with a few-ms bound, and preserve DEC 2026 atomic redraws.

<!-- task-doc-section:background-goal -->
## Background and goal

实体 iPhone 全屏 TUI 仍有操作延迟。已有证据显示 WebGL 帧和 xterm parser 通常很快，但现有诊断无法把 Host、Bridge、移动端 native、JS 与 xterm 阶段按同一输出 offset 对齐。目标是在不改变协议语义、不记录终端正文的前提下：

1. 为 Host/Bridge/mobile native/JS 记录同一 output offset 的阶段时间戳；
2. 在 Host 侧将过小的 PTY 读块合并到 4–16 KiB，或最多等待几毫秒；
3. 不拆开 DEC 2026 同步帧，保持全屏 TUI 原子重绘；
4. 用测试和构建验证顺序、超时、flush、断线和普通 shell 输出没有回归。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**Scope**

- Host PTY reader/output broadcast batching and offset-preserving diagnostics.
- Remote service/Bridge output event offset propagation and gated stage timing.
- Mobile native receive/decode/emit timing and mobile JS output/parser/render correlation.
- DEC 2026 boundary-preserving batching tests.

**Non-goals**

- 不改变 Relay/SSH 加密协议或重写整个 remote transport。
- 不记录终端正文、输入内容、Host/session 身份或凭据。
- 不在当前用户正在使用的 iPhone 上强行操作或抢占前台；真机复测需用户保持 AgentPort Session 可操作。
- 不把尚未测量的网络延迟假定为唯一根因。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Mobile WebGL frame intervals were approximately P50/P95 17/18 ms in prior physical-device traces. | `/tmp/agentport-device-current/.../diag.log` summaries captured from iPhone. |
| F-002 | Existing `outputReceived`/`render` diagnostics cannot identify Host, Bridge, native decode, or network timing. | `mobile/README.md` diagnostic limitations; no stage timestamps in current protocol. |
| F-003 | Host PTY reader has a 256 KiB buffer but broadcasts each `read()` result immediately. | `crates/agentport-host/src/main.rs:2354-2413`. |
| F-004 | Host/service/Bridge output events carry ordered run/generation/byte offsets that can correlate chunks without logging content. | `crates/agentport-host/src/main.rs`, `crates/agentport-service/src/lib.rs`, remote protocol cursors. |
| F-005 | Bridge binary output is frame-based and mobile currently reconstructs `dataBase64` before emitting the event to JS. | `crates/agentport-remote-protocol/src/binary_output.rs`, `mobile/src-tauri/src/remote.rs:730-808`. |
| F-006 | DEC 2026 synchronization must remain atomic; current mobile gate holds parser/render paints until the end marker or bounded timeout. | `mobile/src/terminal/synchronizedOutput.ts` and tests. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: A batching window of 4–16 KiB with a maximum wait of a few milliseconds is acceptable for interactive TUI output when a DEC 2026 frame is still open.
- Assumption: Offset-only diagnostics are sufficient and safer than adding terminal payloads to logs.
- Open question: Whether the dominant remote delay is relay/network, remote Agent processing, or event scheduling will remain open until stage timestamps are collected on a controlled physical-device run.
- Open question: The current user may be using the iPhone; no device interaction is authorized beyond a later user-provided test window.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- [ ] A fixed output offset can be correlated across Host read/append, service/Bridge, mobile native receive/decode/emit, JS callback, parser and render diagnostics.
- [ ] Diagnostics are gated, bounded, content-free, and disabled in normal builds.
- [ ] PTY output batches are at least 4 KiB when available, flush after a small maximum wait, and preserve byte order/offsets.
- [ ] DEC 2026 begin/end boundaries are never split by batching; unmatched frames still release on timeout/reset/RIS.
- [ ] Focused and full relevant tests pass, TypeScript/build checks pass, and the diff is limited to this task.
- [ ] A physical-device controlled run is either completed with stage p50/p95/max results or explicitly blocked by device availability; no unsupported bottleneck claim is made.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 (instrumentation contract) -> T-002 (Host batching) -> T-003 (Bridge/mobile/JS stage plumbing) -> T-004 (integration tests/build) -> T-005 (physical-device measurement and final diagnosis).
- Parallel batches: None initially; shared protocol offsets and diagnostics files require serialized integration.
- Serialization constraints: Host batching and DEC2026 framing share PTY/output ordering; mobile native and JS stage records must agree on the same offset schema; generated mobile build artifacts and user device state are not to be edited concurrently.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Define content-free offset-correlated diagnostics

- Status: done
- Owner: coordinator
- Objective: Define one bounded schema and stage names for the full output path.
- Inputs and prerequisites: F-002, F-004, F-006; current diagnostics implementation.
- Scope or files: `mobile/src/terminal/scrollDiagnostics.ts`, `mobile/src/features/sessions/SessionWorkspace.tsx`, relevant Rust diagnostic helper/protocol types.
- Expected output: Stable offset/stage record format, caps, and tests.
- Dependencies: None.
- Execution steps:
  1. Re-read current diagnostics and output cursor structures.
  2. Add only offset, raw byte length, stage and monotonic timestamp/relative trace data.
  3. Bound records and keep normal builds silent.
  4. Add unit coverage for offset correlation and malformed/missing offsets.
- Acceptance criteria:
  - No terminal text or identity is emitted.
  - Same chunk offset and length are represented consistently at each stage.
  - Existing scroll diagnostics remain backward compatible.
- Verification method:
  - Focused mobile diagnostics tests and TypeScript check.
- Validation evidence: `npx tsc --noEmit`; mobile focused tests passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Batch Host PTY output while preserving DEC 2026

- Status: done
- Owner: coordinator
- Objective: Coalesce small PTY reads into 4–16 KiB or a small time-bounded batch without changing output bytes or cursor semantics.
- Inputs and prerequisites: T-001; F-003; DEC 2026 parser/marker behavior.
- Scope or files: `crates/agentport-host/src/main.rs`, host tests or a new focused batching module/test.
- Expected output: Bounded output batcher with offset-preserving flush and marker-aware behavior.
- Dependencies: T-001.
- Execution steps:
  1. Add a testable batcher receiving raw chunks and monotonic time.
  2. Flush at target size, maximum wait, explicit frame boundary, EOF/error, and pressure.
  3. Track DEC 2026 parser state sufficiently to avoid emitting a batch that splits a synchronized redraw block.
  4. Preserve exact bytes and offset progression.
- Acceptance criteria:
  - Ordinary shell output is delayed no more than the configured few-ms ceiling.
  - Large output does not grow unbounded memory.
  - DEC 2026 begin/end bytes remain ordered and atomic to downstream consumers.
  - Tests cover marker splits at arbitrary input boundaries, timeout, EOF and error flush.
- Verification method:
  - Focused Rust unit tests; package test/check for `agentport-host`.
- Validation evidence: `cargo test -p agentport-host output_batcher` passed 5/5; `cargo check -p agentport-host -p agentport-service -p agentport-remote-bridge` passed. Batcher target is 8 KiB with a 4 ms active-stream check and DEC 2026 boundary/EOF flush; a blocking PTY read cannot be interrupted by the batcher timer itself.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Carry stage timestamps through Bridge, mobile native and JS

- Status: done
- Owner: coordinator
- Objective: Record Host/Bridge/native/JS stage times keyed by output offset without changing normal event semantics.
- Inputs and prerequisites: T-001 and T-002; F-004/F-005.
- Scope or files: `crates/agentport-service/src/lib.rs`, `crates/agentport-remote-bridge/src/lib.rs`, `mobile/src-tauri/src/remote.rs`, `mobile/src/platform/tauriRemoteClient.ts`, `mobile/src/features/sessions/SessionWorkspace.tsx`.
- Expected output: Gated diagnostics that report stage deltas through JS parser handoff and chunk-size histogram for a controlled run; existing frame timing remains the render proxy.
- Dependencies: T-002.
- Execution steps:
  1. Add monotonic stage observations at output enqueue/write/decode/emit/callback/parser/render.
  2. Correlate using run/generation/offset and raw length.
  3. Ensure diagnostics are disabled and zero-cost enough in ordinary builds.
  4. Add synthetic event tests for out-of-order/missing offset handling.
- Acceptance criteria:
  - A controlled run can distinguish remote delivery delay from JS/parser delay; render remains represented by existing frame timing because xterm render callbacks do not carry a stable output offset.
  - No event payload semantic changes are required for non-diagnostic builds.
  - No payload text or secrets are logged.
- Verification method:
  - Rust crate tests; mobile focused tests/build; inspect generated diagnostic schema.
- Validation evidence: Added debug-only `output_trace` at Host append, service host event, Bridge enqueue, mobile native decode, JS callback and JS parser handoff. Existing frame diagnostics remain separate because xterm render callbacks cannot safely be joined to a specific offset. Rust checks, TypeScript and focused tests passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Integration validation and build

- Status: done
- Owner: coordinator
- Objective: Verify ordering, performance safeguards and packaging after integration.
- Inputs and prerequisites: T-001 through T-003.
- Scope or files: focused tests, mobile build, relevant Rust packages.
- Expected output: Passing test/build evidence and scoped diff review.
- Dependencies: T-003.
- Execution steps:
  1. Run focused Rust and mobile tests.
  2. Run mobile full tests and production build.
  3. Run terminal touch/WebGL regressions.
  4. Review `git diff --check`, status and task-owned files.
- Acceptance criteria:
  - Required checks pass or limitations are explicitly recorded.
  - No unrelated dirty work is staged.
- Verification method: Commands recorded in execution log and final validation.
- Validation evidence: `npm test` passed 66 files/1025 tests; `npm run build` passed; focused Rust tests/checks passed; `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — Controlled physical-device measurement and bottleneck report

- Status: blocked
- Owner: coordinator
- Objective: Run the same fixed output/input workload on the physical iPhone and report p50/p95/max per stage.
- Inputs and prerequisites: T-004; user leaves AgentPort Session active and permits a short controlled run.
- Scope or files: device diagnostics only; no production source changes expected.
- Expected output: Offset-correlated stage table and conclusion about network/Bridge/Host/JS/parser bottleneck.
- Dependencies: T-004.
- Execution steps:
  1. Install the diagnostic build without clearing data.
  2. Capture a fixed workload and retrieve bounded diagnostic logs.
  3. Join stages by run/generation/offset; reject gaps instead of guessing.
  4. Compare chunk-size distribution and stage percentiles.
- Acceptance criteria:
  - Bottleneck attribution is based on stage evidence, not outputReceived alone.
  - If device is unavailable, status is blocked with exact unblock condition.
- Verification method: `devicectl` install/launch/copy plus an offline correlation script.
- Validation evidence: Not run for the new stage trace; prior iPhone sampling remains partial evidence.
- Blocker: Physical device currently may be occupied by another app; no controlled AgentPort Session workload was authorized in this turn.
- Unblock condition: User provides a short window with AgentPort Session visible and active.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Mobile focused: diagnostics, SessionWorkspace output scheduling, synchronized output, xterm replay.
- Rust focused: Host batcher, host/service output cursor behavior, Bridge binary output tests.
- Integration: `npm test`, `npm run build`, relevant `cargo test`/`cargo check`, `node mobile/scripts/test-terminal-touch.mjs`.
- Device: install diagnostic build, run fixed workload, retrieve logs, correlate offset stages, and report missing/gapped records.
- Safety: no production release, no credentials, no terminal payloads in diagnostics, no device interaction while user is using it.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Batching can add perceived latency if the maximum wait is too large; keep it in the low-ms range and flush immediately at DEC 2026 boundaries where required.
- A naive marker parser can split or duplicate escape sequences; tests must feed markers one byte at a time and preserve exact bytes.
- Native diagnostic logging can itself perturb timing; use bounded sampling and keep the diagnostic build opt-in.
- The physical iPhone may be unavailable or occupied; do not interrupt it.
- Existing unrelated dirty files (`Cargo.lock`, generated mobile schema, prior fixtures/scripts) must remain untouched and unstaged.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-20: Task document created in execute mode. Existing evidence confirmed local WebGL/parser are fast but stage-level network attribution is missing.
- 2026-11-20: T-001 started; implementation serialized because offset schema is shared by all downstream stages.
- 2026-11-20: T-001–T-004 implemented and validated. Host batcher target is 8 KiB with a 4 ms active-stream check and DEC 2026 boundary flush; debug-only offset traces added across Host/service/Bridge/mobile native/JS through parser handoff. Render remains a separate frame metric.
- 2026-11-20: T-005 blocked because the physical iPhone is occupied; no final stage percentile attribution claimed.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001–T-004 done; Host batcher/Rust tests, mobile 1025-test suite, TypeScript/Vite build and focused checks passed.
- Limitations: T-005 blocked. The new debug trace has not yet been collected from a controlled physical-iPhone AgentPort Session, so network/Bridge/Host bottleneck attribution remains pending.
