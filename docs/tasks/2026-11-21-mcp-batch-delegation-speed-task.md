# Task Plan: 优化 MCP 批量委派速度

- Created: 2026-11-21
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户授权执行“当前整体的委派速度比较慢，模型轮次较多”的最优优化方案

<!-- task-doc-section:background-goal -->
## Background and goal

减少 AgentPort Sessions MCP 批量委派时的模型工具轮次和端到端等待，优先实现批量创建、批量等待以及批量 pane 布局应用；保留现有单 Session 工具兼容性和 prompt 投递可靠性。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### Scope

- 新增批量创建委派 Session 的 MCP 工具，返回每个任务的 Session/提交状态。
- 新增批量等待工具，单次返回多个 Session 的 settle/reply 结果。
- 批量委派只发出一次 UI pane/layout intent，避免每个 Session 触发一次布局重排。
- 更新 MCP 工具描述与文档，成功 wait 已有 reply 时不再要求额外 read_output。
- 保持既有 create_session、wait_for_task、read_output 行为兼容。

### Non-goals

- 本任务不改变 Agent 模型推理速度、Agent CLI 本身或权限语义。
- 不盲目缩短 readiness、Enter 验证、turn completion 等可靠性等待。
- 不扩大默认 Session/Host 资源上限，不改变 Session 生命周期。
- 不处理与本任务无关的移动端 ACL 工作区修改。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | MCP stdio 主循环同步处理一个请求，长 wait 会阻塞同一进程后续请求。 | `crates/agentport-mcp/src/main.rs:97-109`; `crates/agentport-mcp/src/server.rs:30-83` |
| F-002 | 单个 create_session 带 prompt 时同步执行 Host 创建、ready 等待和 prompt 投递验证。 | `crates/agentport-mcp/src/tools.rs:687-782` |
| F-003 | prompt 投递包含多次轮询、150ms Enter 间隔、600ms 重试和最多四次尝试，不能直接删除可靠性校验。 | `crates/agentport-mcp/src/ops.rs:36-67,499-571` |
| F-004 | wait_for_task 每轮同时 summary/poll，并在结束时等待 transcript reply。 | `crates/agentport-mcp/src/ops.rs:867-1093,1110-1158` |
| F-005 | MCP UI queue 每 1200ms 扫描并逐条 emit 命令，前端每条命令单独应用。 | `src-tauri/src/external_agents.rs:32-81`; `src/src/App.tsx:205-209` |
| F-006 | auto pane placement 会基于整个布局重建 grid，逐个命令应用会重复重排。 | `src/src/actions.ts:812-840`; `src/src/paneLayout.ts` grid placement helpers |
| F-007 | 当前默认每个 MCP 进程最多 16 个 live Session，但 SessionOps attachment cache 为 8。 | `crates/agentport-mcp/src/main.rs:16-22`; `crates/agentport-mcp/src/ops.rs:27-29` |
| F-008 | wait_for_task 已返回本轮 assistant reply，成功场景不需要再调用 read_output。 | `crates/agentport-mcp/src/tools.rs:960-976`; `docs/mcp.md` typical workflow |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption A-001: 以新增批量工具而非破坏性修改旧工具作为第一阶段，客户端可渐进迁移；验证方式是保留现有工具测试并新增 schema/dispatch 测试。
- Assumption A-002: 批量 pane intent 可以在 renderer 内一次规划并一次提交；若外部 Session snapshot 尚未到达，批量操作应保留安全的失败/重试语义。
- Assumption A-003: 第一阶段先保证模型轮次显著减少；内部 Host 并发启动若需要跨越可变 Toolbox/attachment 状态，则作为受控实现而不是无界线程化。
- Open question: 真实耗时中模型推理、Host 启动、ready/prompt 投递和 wait/reply 各占比尚未测量；本任务先加入可验证的批量协议，后续依据 trace 再调并发度和 attachment 策略。

<!-- task-guidance -->
## Execution guidance

- 优先交付 `create_sessions` + `wait_for_tasks`，单次批量返回按 taskId 对齐的部分成功结果。
- 通过 `batch_pane`/等价 UI intent 合并 pane 操作；不要在 MCP 中直接写 renderer localStorage。
- 旧工具继续可用；批量工具可以在内部复用成熟的单任务创建/等待逻辑，但不能让一个失败吞掉整个批次。
- 只有验证通过后才更新文档、提交代码和重启 Debug App。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- AC-001: 批量创建工具一次调用可创建多个 Session，并为每项返回 sessionId、promptSubmitted/错误等独立结果。
- AC-002: 批量等待工具一次调用可等待多个 Session，并返回每项 state、confidence、reply 或 fallback evidence。
- AC-003: 一批 auto pane 委派不会为每个 Session 单独追加并消费 pane 命令；布局至少只执行一次批量规划/提交。
- AC-004: 既有单 Session MCP 工具、权限、ownership、status baseline 和 prompt 可靠性测试继续通过。
- AC-005: MCP schema、文档和工具描述明确成功 wait 已有 reply 时无需额外 read_output，完成任务不自动 terminate。
- AC-006: 定向测试、TypeScript/Rust 编译检查、i18n 检查和 Debug App 重启/截图验证通过；只提交本任务改动，保留预-existing mobile ACL 修改。

<!-- task-guidance-end -->
<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-003`; `T-002 -> T-003`; `T-003 -> T-004`。
- Parallel batches:
  - Batch 1: T-001 MCP batch tools and tests; T-002 renderer/UI batch intent and tests (file ownership disjoint).
  - Batch 2: T-003 integration, docs, and compatibility validation.
  - Batch 3: T-004 build, Debug App restart/screenshot, final commit.
- Serialization constraints: `crates/agentport-mcp/src/tools.rs`, `ops.rs`, `server.rs` belong to T-001; `src-tauri/src/external_agents.rs`, `src/src/App.tsx`, `src/src/actions.ts`, and UI tests belong to T-002; docs and authority document remain coordinator-owned. Do not edit `mobile/src-tauri/gen/schemas/acl-manifests.json`.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — MCP 批量创建与批量等待

- Status: done
- Owner: mcp-batch-worker
- Objective: 在保持旧工具兼容的前提下减少批量委派的 MCP/model round trips。
- Inputs and prerequisites: F-001–F-004, existing Toolbox ownership/baseline/settled semantics.
- Scope or files: `crates/agentport-mcp/src/tools.rs`, `crates/agentport-mcp/src/ops.rs` only as needed, MCP tests.
- Expected output: `create_sessions` and `wait_for_tasks` schemas/dispatch/partial results, bounded internal behavior, tests.
- Dependencies: None.
- Execution steps:
  1. Define batch input/output contracts and validate per-item errors.
  2. Reuse existing create/wait correctness gates without weakening prompt evidence.
  3. Track ownership/baselines for every successful item.
  4. Add unit tests for mixed success, reply propagation, and old-tool compatibility.
- Acceptance criteria:
  - One batch call handles multiple independent tasks and never loses successful items because another item fails.
  - One wait call returns all item outcomes and replies.
  - No unsafe global mutable state or unbounded concurrency is introduced.
- Verification method:
  - `cargo test -p agentport-mcp`
  - targeted MCP schema/tool tests
- Validation evidence: `cargo test -p agentport-mcp` passed 35 tests; `rustfmt --edition 2021 --check crates/agentport-mcp/src/tools.rs crates/agentport-mcp/src/ui.rs` passed; batch schema, mixed item errors, ownership errors and batch UI queue tests passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 批量 pane intent 与一次布局应用

- Status: done
- Owner: coordinator
- Objective: 将同一批委派的 pane placement 合并，避免逐 Session 重排。
- Inputs and prerequisites: T-001 batch output contract; existing grid placement and MCP queue.
- Scope or files: `crates/agentport-mcp/src/ui.rs`, `src-tauri/src/external_agents.rs`, `src/src/App.tsx`, `src/src/actions.ts`, relevant tests.
- Expected output: one batch UI command/renderer action that applies auto placement once while preserving explicit target/focus semantics.
- Dependencies: None.
- Execution steps:
  1. Extend queue payload with a batch intent and preserve old JSONL commands.
  2. Tail/emit batch intent without breaking partial queue consumption.
  3. Apply all resolvable Sessions in one renderer state/layout transaction.
  4. Add tests for ordering, partial missing Sessions, focus and persistence behavior.
- Acceptance criteria:
  - Batch pane placement performs one layout planning/commit path.
  - Existing single UI commands remain supported.
  - Missing/late Session snapshots do not blank the workspace.
- Verification method:
  - targeted Rust queue tests
  - `src` actions/App tests
- Validation evidence: frontend targeted suite passed 96 tests; TypeScript noEmit and i18n check passed; batch grid placement and external batch pane action have regression coverage.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成、文档与兼容验证

- Status: done
- Owner: coordinator
- Objective: Integrate both batch paths and make the low-round workflow discoverable.
- Inputs and prerequisites: T-001 and T-002 done.
- Scope or files: `docs/mcp.md`, MCP tool descriptions/schema snapshots, compatibility tests.
- Expected output: canonical two-call batch workflow and no redundant read_output/terminate guidance.
- Dependencies: T-001, T-002.
- Execution steps:
  1. Update MCP docs and descriptions.
  2. Run existing single-session MCP tests and frontend action tests.
  3. Inspect diff for unrelated changes.
- Acceptance criteria:
  - Documentation tells coordinators to use batch create/wait and use reply first.
  - Existing workflow remains valid.
- Verification method:
  - `cargo test -p agentport-mcp`
  - targeted frontend tests
  - `git diff --check`
- Validation evidence: `docs/mcp.md` now documents batch create/wait, reply-first output handling and no automatic termination; existing single-session tools remain registered and MCP/frontend compatibility tests pass.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 最终构建、Debug 验证与提交

- Status: done
- Owner: coordinator
- Objective: Complete required repository validation and commit only task changes.
- Inputs and prerequisites: T-003 done.
- Scope or files: task-owned changes only; debug bundle output is generated/untracked as configured.
- Expected output: passing checks, rebuilt non-blank Debug App, task-only commit.
- Dependencies: T-003.
- Execution steps:
  1. Run targeted tests, typecheck, Rust checks, i18n check and diff review.
  2. Run `python3 scripts/restart-debug-app.py`.
  3. Verify exact GUI executable path and screenshot.
  4. Commit task changes while leaving mobile ACL modification untouched.
- Acceptance criteria:
  - All acceptance criteria have current evidence.
  - Debug App renders normally.
  - Commit contains only task changes.
- Verification method:
  - task-specific commands recorded in final evidence
- Validation evidence: `cargo test -p agentport-mcp` passed 35 tests; frontend targeted suite passed 96 tests; TypeScript noEmit, i18n check, rustfmt check and `git diff --check` passed; `python3 scripts/restart-debug-app.py` rebuilt/signed/restarted the Debug App; exact GUI executable path `/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport` verified at PID 38568 and CUA screenshot showed non-blank UI.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- MCP: existing `cargo test -p agentport-mcp`, new batch contract/partial failure/reply tests.
- Frontend: targeted action/App/grid layout tests; existing pane tests where touched.
- Static: `git diff --check`, document validator, TypeScript and i18n checks.
- Runtime: rebuild/sign/restart debug App; verify exact executable path and non-blank screenshot.
- Performance proxy: compare number of MCP tool calls and pane/layout intent count for an N-task batch; runtime latency remains a follow-up measurement unless trace instrumentation is added.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- A global mutex around Toolbox would preserve correctness but erase concurrency gains; avoid it for long waits.
- Parallel Session creation can contend on the same repository/worktree lock; use bounded concurrency or preserve service serialization for conflicting paths.
- Batch UI commands can arrive before the desktop refresh sees all Sessions; renderer must retry or safely ignore unresolved items.
- Prompt reliability guards are correctness-critical; do not remove them for a synthetic speedup.
- The current worktree contains unrelated `mobile/src-tauri/gen/schemas/acl-manifests.json` modification; it must remain unstaged.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-21: Task document created; static analysis confirmed serial MCP dispatch, synchronous create/wait path, 1.2s UI watcher cadence, and one-command-per-pane layout application.
- 2026-11-21: Started T-001/T-002 implementation planning; ownership boundaries are disjoint and authority document remains coordinator-owned.
- 2026-11-21: T-002 implementation started: pane layout can rebuild once for multiple Session ids; MCP UI queue payload now supports `sessionIds`/`batch_pane`.
- 2026-11-21: T-001 completed: added `create_sessions`/`wait_for_tasks` with per-item errors/replies and one deferred batch pane intent; MCP tests passed.
- 2026-11-21: T-002/T-003 completed: renderer batch grid action, queue schema, docs and frontend regression coverage integrated.
- 2026-11-21: T-004 completed: targeted checks, production frontend build, signed Debug App restart, exact PID/path verification and non-blank screenshot passed; task-only commit prepared.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: Batch MCP tools, batch pane queue/action, docs and regression tests are complete; required checks and Debug App smoke verification passed.
- Limitations: No representative before/after latency benchmark was collected; batch creation/wait currently preserves correctness through ordered existing readiness/wait paths, so internal Host parallelism remains a follow-up optimization.
