# Task Plan: AgentPort Mobile V2 收敛与实施

- Created: 2026-09-02
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: `docs/mobile-app-prd-v2.md`; supersedes `docs/tasks/2026-09-01-agentport-mobile-v1-task.md` as the sole execution and status authority for Mobile V2.

<!-- task-doc-section:background-goal -->
## Background and goal

V1 在当前工作区形成了可运行但尚未纳入当前分支的候选实现，产品形态仍以“桌面等价”为目标。V2 将 Mobile 收敛为一台 AgentPort 设备的遥控器和终端显示器：快速找到或启动 Session、查看桌面同源状态、只对审批请求和任务完成发送系统通知、通过原始 Agent CLI 终端继续交互，并在 Mobile/desktop 之间显式协调终端几何尺寸。

本计划先审计 V1 的真实实现状态和可复用边界，再移除与 V2 冲突的产品入口，补齐缺失的权威 DTO/状态和 resize ownership 协议，最后完成 Mobile、desktop 及双端集成验证。除本文件外不新增第二份计划或状态文档；所有实施状态、证据、阻塞和最终结论只更新于此。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:

- 复用现有 Host profile、Keychain/Keystore opaque handle、TOFU、SSH stdio Bridge、RemoteClient、Session attach/input/control/replay 和 xterm 基础。
- 每次只呈现一台远程设备的独立工作空间；支持 `Project → Session` 与 `Active Agent Sessions` 两种排版及设备内状态持久化。
- Project 行按桌面 Agent 顺序/隐藏设置提供快捷启动；Pi/Shell 保持 native 语义，其他 Agent 默认 bypass/full access 与 risk acknowledgement。
- Agent Session 只显示原始终端，不提供 Conversation、结构化卡片或 Mobile 自建审批/提问表单。
- 状态和通知使用 AgentPort 桌面端同源语义；系统通知只允许 `ApprovalRequested` 和 `TurnCompleted`。
- 列表 DTO 增加权威 `hostAlive` 等 V2 所需状态；Mobile 打开/旋转时取得终端几何 ownership，desktop 显示 revision-aware 手机尺寸提示与恢复按钮。
- 删除或隔离 V1 的跨设备聚合、五项主导航、通用创建表单、Workspace/Git/Worktree/Content/Backup/Activity 等产品入口和无用依赖。

Non-goals:

- 不在 Mobile 重新实现 Agent 的结构化提问、选择、审批或消息协议；这些交互由 Agent CLI 在 PTY 内渲染和接收。
- 不实现跨设备 Session 聚合、跨设备搜索或共享 UI 状态。
- 不实现 Project/Git/Worktree 管理、Documents/Mermaid/Search/Timeline/Backup、Secret 管理、独立 Shell/SFTP/Mosh 产品化或完整桌面设置中心。
- 不删除仍被 desktop 或 Service 内部调用的共享能力；仅收窄 Mobile 产品入口和远程公开能力边界。
- 不把 Android Maven 网络阻塞当作核心 Session UI 的阻塞条件；平台真机门槛单独记录。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | V1 task 中的主要实现存在于工作区，但 `mobile/` 和三个 Remote crate 均未跟踪；历史 foundation commit `2b7614b5` 不是当前 `HEAD` 的祖先，因此 V1 `done` 不能继承为 V2 已交付。 | `git status --short`; `git merge-base --is-ancestor 2b7614b5 HEAD` exit 1; V1 audit 2026-09-02. |
| F-002 | V1 baseline 在开始 V2 改造前可运行：Mobile 前端 9 个测试文件/24 个测试通过，生产构建通过，Mobile Tauri library 19 个测试通过。 | 2026-09-02 commands: `cd mobile && npm test -- --run`; `npm run build`; `cargo test --manifest-path src-tauri/Cargo.toml --lib`. jsdom canvas warnings and Mermaid chunk-size warning are non-failing baseline noise. |
| F-003 | 当前 App 暴露 Hosts/Activity/Workspace/Content/Settings 五入口、多 Session tabs 和探针，直接违反 V2 单设备 Session-first IA。 | `mobile/src/app/App.tsx`; frontend audit 2026-09-02. |
| F-004 | 当前 Dashboard 聚合所有 hosts，并从 Timeline 的 waiting/failed/completed 猜 attention/unread。 | `mobile/src/features/sessions/SessionDashboard.tsx`; frontend audit 2026-09-02. |
| F-005 | 当前 Workspace 默认 Conversation，解析 normalized output/structured question 并调用 `session.structured_input`；与终端唯一 Agent UI 冲突。 | `mobile/src/features/sessions/SessionWorkspace.tsx`; `sessionProtocol.ts`; frontend audit 2026-09-02. |
| F-006 | 通用 `CreateSessionDialog` 暴露 host/project/worktree/permission/transport/geometry/extraArgs，默认参数也不符合 Project 行一键启动。 | `mobile/src/features/sessions/CreateSessionDialog.tsx`; V1 audit 2026-09-02. |
| F-007 | `RemoteClient`、Tauri adapter、Host/credential/TOFU/SSH actor、Session attach/input/control/replay 和 `MobileTerminal` 可复用。 | `mobile/src/protocol/remoteClient.ts`; `mobile/src/platform/tauriRemoteClient.ts`; `mobile/src-tauri/src/{credentials,hosts,ssh,remote}`; audits 2026-09-02. |
| F-008 | Desktop quick-start 的权威参数为 Shell/Pi native，其他 Agent bypass 且 `riskAcknowledged=true`、`presetId=null`、PTY transport；Agent 顺序/隐藏设置已有权威来源。 | `src/src/actions.ts:1190`; `src/src/components/Sidebar.tsx:299`; frontend audit 2026-09-02. |
| F-009 | Active Agents 的 desktop 权威过滤为 `hostAlive`、非 Shell、非 archiving，并按 attention→working→idle→unknown、pinned/recent 排序；现有 `SessionSummary` 列表 DTO 没有 `hostAlive`。 | `src/src/components/Sidebar.tsx:1020`; `crates/agentport-service/src/lib.rs` SessionSummary; audits 2026-09-02. |
| F-010 | 当前 Remote protocol 已有 `SessionControlKind::Resize` 和 cols/rows，Host 会 resize PTY；但没有 geometry owner/revision/provenance，Mobile 每次 ResizeObserver 都直接发送 resize，desktop 没有手机尺寸提示/恢复动作。 | `crates/agentport-remote-protocol/src/lib.rs`; `crates/agentport-service/src/lib.rs`; `crates/agentport-host/src/server.rs`; `mobile/src/terminal/MobileTerminal.tsx`; audits 2026-09-02. |
| F-011 | Desktop 已有权威状态/attention/通知语义；Mobile 尚无对应系统通知产品链路。 | `src/src/components/StatusDot.tsx`; core `AttentionKind`; desktop notify mapping; audits 2026-09-02. |
| F-012 | V1 Workspace/Content UI 和 Mermaid 依赖只服务于 V2 non-goals，可从 Mobile 产品和构建依赖中删除；底层共享 Service 方法须按实际 desktop consumer 保留。 | `mobile/src/features/{workspace,content}`; `mobile/package.json`; audits 2026-09-02. |
| F-013 | Remote capability 目前只是协商展示而非授权门，Bridge 仍暴露大量 V2 排除方法；Attention 只有 attached-session push，不能覆盖全局后台 Session。 | Backend audit 2026-09-02; `crates/agentport-remote-protocol/src/lib.rs`; `crates/agentport-remote-bridge/src/lib.rs`. |
| F-014 | Host 是 desktop 与多个 Bridge 的运行时汇合点；geometry 只存 Service/SQLite 会被已打开 desktop ResizeObserver 覆盖，因此 ownership/ACK/broadcast 必须穿过 Host 控制链并绑定 run。 | Backend audit 2026-09-02; Host attach/resize paths. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: `docs/mobile-app-prd-v2.md` 的 requirement ID 与 AC 是产品验收权威；V1 task 只作为历史证据和候选实现清单。
- Assumption: “默认完全权限”严格复用 desktop quick-start 参数，而不是在 Mobile 新建权限模型。
- Assumption: geometry ownership 是 Session run 级 Host 状态；owner 至少区分 Mobile device attachment 与 desktop，revision 单调递增，提示 dismiss 只作用于当前 revision。
- Assumption: Mobile 系统通知由电脑端权威 attention/event 驱动，Mobile 不从 terminal 文本或 Timeline state 推断。
- Open question: iOS/Android 真机通知权限、后台投递和 Android Maven 依赖下载能否在当前环境完成；若不能，保留为平台验证限制，不伪造通过。
- Open question: 当前 dirty worktree 中哪些既有修改属于其他用户任务；实施采用精确文件 ownership 和 path-scoped staging，无法证明归属的文件不纳入最终 commit。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- AC-001: V1 task 的每项实现被分类为复用、重写、删除/隔离或取消，且 V2 task 是唯一当前状态源。
- AC-002: Mobile 主产品一次只加载一台设备；设备切换不聚合 Session，排版、展开、筛选、滚动和 Recent 状态按稳定 device ID 隔离。
- AC-003: 设备工作空间提供 Project→Session 与 Active Agent Sessions 两种与 desktop 同源的布局、过滤和排序。
- AC-004: Project 行 Agent 图标使用 desktop 顺序/隐藏设置并按权威参数一键启动；具有 pending、防重复和失败反馈，不出现通用创建表单。
- AC-005: Session 页面只有原始 PTY 终端和必要的导航/特殊键；无 Conversation、normalized message、structured card 或 `session.structured_input` 产品路径。
- AC-006: 状态图标与 desktop 同源；系统通知只对 ApprovalRequested 与 TurnCompleted 触发，具有稳定去重和 seen 语义，其他状态不发系统通知。
- AC-007: `session.list` 能权威表达 `hostAlive` 等 Active Agents 所需字段，不通过 attach 或文本猜测。
- AC-008: Mobile 首次进入和横竖屏稳定变化时请求 resize/ownership；普通布局噪声和软键盘变化不造成抢占或 resize loop；失败不得显示伪成功。
- AC-009: Desktop 打开 Mobile-owned Session 时保留当前手机尺寸并显示 owner/revision-aware 提示及“恢复桌面尺寸”；恢复后 Mobile 显示非 owner 并可明确重新适配。
- AC-010: Workspace/Git/Worktree/Content/Backup/Activity/五项底栏、通用创建表单和 Mermaid 不再进入 V2 Mobile 产品或生产 bundle；共享 desktop Service 能力未被误删。
- AC-011: focused unit/integration tests、Mobile production build、相关 Rust tests、desktop tests、debug App rebuild/process-path/nonblank screenshot 均有真实证据；未运行的平台门槛明确列出。
- AC-012: 最终只提交能证明属于本任务的改动，commit 不混入无关 dirty worktree 文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 → T-002`; `T-002 → {T-003, T-004}`; `T-003 → {T-005, T-006}`; `T-004 → {T-005, T-006, T-007}`; `{T-005, T-006, T-007} → T-008`.
- Parallel batches: Batch 0 audit (`T-001`); Batch 1 contract freeze (`T-002`); Batch 2 Mobile shell cleanup (`T-003`) in parallel with backend runtime (`T-004`); Batch 3 Mobile workspace/semantics (`T-005`), terminal-only/resize (`T-006`) and desktop restore UX (`T-007`) on disjoint ownership; Batch 4 integration, runtime verification and commit (`T-008`).
- Serialization constraints: `App.tsx`/`SessionDashboard.tsx` cleanup and final workspace implementation share ownership and must serialize; protocol/service geometry contract must land before Mobile/Desktop resize consumers; desktop terminal resize work must preserve synchronous viewport restoration invariants documented in `LEARNS.md`; only the coordinator edits this task document and performs final path-scoped commit.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Audit V1 progress and establish the V2 cleanup/reuse matrix

- Status: done
- Owner: coordinator
- Objective: Replace prose progress claims with current workspace evidence and classify every V1 product area against V2.
- Inputs and prerequisites: V1 task, V2 PRD, current Git state, Mobile/frontend/backend source.
- Scope or files: Read-only audit of `docs/tasks/2026-09-01-agentport-mobile-v1-task.md`, `mobile/`, Remote crates, core/host/service and desktop sources.
- Expected output: Evidence-backed reuse/cleanup/gap matrix and baseline validation results.
- Dependencies: None.
- Execution steps:
  1. Compare V1 statuses with current HEAD, tracked state and source artifacts.
  2. Audit Mobile IA/session UI and Remote/Core/Desktop support independently.
  3. Run non-platform baseline tests/build and record truthful warnings/limits.
- Acceptance criteria:
  - Every major V1 area is classified as reuse, rewrite, remove/isolate or cancel.
  - Current branch/worktree delivery status is distinguished from historical task prose.
- Verification method:
  - Three independent read-only audits; Git ancestry/status checks; baseline frontend/native commands.
- Validation evidence: Done 2026-09-02. Facts F-001 through F-014; Mobile 24 tests, production build, and 19 Tauri lib tests passed before V2 edits.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Freeze the minimal V2 shared contracts

- Status: done
- Owner: coordinator
- Objective: Define additive contracts for Session list liveness/attention, global attention polling, negotiated capability enforcement, and run-scoped terminal geometry ownership/revision.
- Inputs and prerequisites: T-001; V2 ACT/TERM requirements; existing SessionSummary, AttentionKind, attachment and Resize paths.
- Scope or files: Contract shapes across core/service/remote protocol/bridge/host and Mobile/Desktop consumers; no product UI implementation.
- Expected output: One implementation-ready contract that reuses existing launch/attach/control semantics and does not duplicate Agent CLI behavior.
- Dependencies: T-001.
- Execution steps:
  1. Trace authoritative producers for host liveness, AttentionKind/status and run identity.
  2. Freeze additive list/attention/geometry DTOs, control semantics, ACK/error/stale-revision behavior and capability names.
  3. Freeze the V2 Remote allowlist and compatibility rules for older Host/Bridge clients.
  4. Record exact file ownership and consumer migration sequence in this task's execution log before implementation dispatch.
- Acceptance criteria:
  - Active Agents needs no attach/text heuristic; notifications need no Timeline heuristic.
  - Geometry ownership converges at Host, binds to run, broadcasts revision and has explicit Mobile claim/Desktop restore semantics.
  - Capability negotiation is enforceable and backward-compatible behavior is explicit.
- Verification method:
  - Contract review against current producers/consumers and PRD requirement IDs; task-document validation.
- Validation evidence: Frozen 2026-09-02 from current producer/consumer traces: additive Session projection uses `hostAlive`, `unreadAttention`, `latestAttentionKind` and authoritative status evidence; global `attention.poll` is cursor-based and bounded; geometry is Host-owned, run-bound, revisioned, ACKed and broadcast; resize uses expected revision/source/device/attachment/orientation; attach returns run identity and geometry; capability dispatch is enforced against a V2 allowlist with explicit compatibility failure.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Remove V1 product surfaces and establish the V2 Mobile shell

- Status: done
- Owner: mobile-shell-worker
- Objective: Reduce the production Mobile app to device selection, device-local Sessions workspace and immersive Session route.
- Inputs and prerequisites: T-002 frozen DTO names/control semantics.
- Scope or files: `mobile/src/app`, obsolete `mobile/src/features/{workspace,content,transport-spike}`, CreateSessionDialog product files/tests, i18n/styles, `mobile/package.json`.
- Expected output: No five-tab IA, Activity/Content/Workspace management, probe UI, generic create form or Mermaid production dependency.
- Dependencies: T-002.
- Execution steps:
  1. Replace bottom navigation and multi-session tabs with a Sessions-first route shell.
  2. Move minimal host/device management behind the Sessions header sheet.
  3. Delete product routes/tests/styles/dependencies that exist only for V2 non-goals.
  4. Keep connection, RemoteClient and terminal primitives intact.
- Acceptance criteria:
  - Production App exposes only V2-supported entry points.
  - `mermaid` and removed features are absent from the production bundle/import graph.
  - Existing host connect/disconnect flow remains reachable.
- Verification method:
  - App-focused Vitest, import search, `npm run build`, bundle inspection.
- Validation evidence: Done 2026-09-02. Five-tab IA, multi-Session tabs, probes, Workspace/Content/transport-spike product code, CreateSessionDialog and Mermaid dependency removed; HostManager remains in a device-management sheet. Mobile full suite later passed 7 files/20 tests and production build passed; source search found no removed product imports.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Implement Session projection, attention and terminal geometry runtime

- Status: done
- Owner: backend-runtime-worker
- Objective: Implement the T-002 contracts through Core/Host/Service/Bridge and expose authoritative state consistently to Mobile and desktop.
- Inputs and prerequisites: T-002 contract decisions.
- Scope or files: `crates/agentport-core`, `crates/agentport-host`, `crates/agentport-service`, `crates/agentport-remote-protocol`, `crates/agentport-remote-bridge`, focused Rust tests and minimal desktop command/API bindings.
- Expected output: `hostAlive` list results, global deduplicated attention poll, capability enforcement, geometry snapshot/claim/restore/ACK/broadcast bound to run.
- Dependencies: T-002.
- Execution steps:
  1. Reuse a shared host-alive projection and existing AttentionKind/deduper semantics.
  2. Add bounded global attention polling rather than attaching every Session.
  3. Carry run identity and current geometry in attach/control results; make Host atomically validate revision, resize PTY, return error/ACK and broadcast accepted state.
  4. Enforce negotiated method capabilities and constrain Mobile to the V2 allowlist without deleting shared desktop Service implementations.
  5. Add backward compatibility, stale revision, new-run reset and multi-client tests.
- Acceptance criteria:
  - Backend tests cover active/dead host, both attention kinds, Mobile claim, orientation update, desktop restore, stale revision and new-run reset.
  - Existing attach/input/control consumers remain compatible and no terminal-text parsing enters backend.
- Verification method:
  - Focused and package Rust tests for protocol/service/bridge/host/core plus serialization compatibility tests.
- Validation evidence: Done 2026-09-02. `cargo check --workspace` passed; Service 27/27, Bridge 15/15, Remote protocol 11/11, Core attention cursor targeted test and real Host dual-client geometry test passed; Tauri Rust check passed. Rejected Host ACK reason is still flattened to generic `request_not_executed`, while authoritative state remains available through broadcast/reattach.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Build single-device workspace, quick launch, status and notifications

- Status: done
- Owner: coordinator
- Objective: Implement V2 home behavior from authoritative desktop-equivalent data without cross-device aggregation or Timeline heuristics.
- Inputs and prerequisites: T-003 shell; T-004 list/attention state.
- Scope or files: `mobile/src/features/sessions`, minimal device selector, notification adapter/native permission plumbing, tests and i18n/styles.
- Expected output: Project→Session and Active Agent Sessions modes, Recent sheet, Project-row Agent quick launch, status icons and two-event notification policy.
- Dependencies: T-003 and T-004.
- Execution steps:
  1. Fetch/render only selected device and persist UI state keyed by stable device ID.
  2. Match desktop Active Agents filter/order and Project grouping.
  3. Implement exact desktop quick-start parameters, ordering/hidden preferences, pending/dedup/failure states.
  4. Map desktop status icons; consume only authoritative attention/events.
  5. Deliver local system notifications only for ApprovalRequested and TurnCompleted with dedup/seen handling.
- Acceptance criteria:
  - Switching devices never shows mixed Session data or leaks per-device UI state.
  - Quick launch request payloads exactly match desktop semantics.
  - Failed/exited/working/idle changes update icons but never create prohibited system notifications.
- Verification method:
  - Focused component/protocol/native tests with two-device, ordering, quick-launch and notification matrices.
- Validation evidence: Done 2026-09-02 at source/integration level. Single selected device, device-keyed layout/expanded/recent/scroll state, Project and Active modes, exact quick launch, status mapping, cursor-based `attention.poll`, silent baseline drain, stable dedup and native Tauri notification allowlist implemented. Mobile 7 files/20 tests, production build and Tauri 19/19 tests passed; real background notification delivery remains a T-008 platform smoke.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Make Session interaction terminal-only with stable Mobile resize behavior

- Status: done
- Owner: mobile-terminal-worker
- Objective: Preserve raw Agent CLI interaction while adapting terminal dimensions to stable portrait/landscape changes under explicit ownership.
- Inputs and prerequisites: T-003 immersive shell; T-004 geometry control/state.
- Scope or files: `SessionWorkspace.tsx`, `MobileTerminal.tsx`, terminal CSS, protocol helpers/tests.
- Expected output: Full-height PTY view, raw input/special keys/replay, no structured conversation path, ownership-aware coalesced resize.
- Dependencies: T-003 and T-004.
- Execution steps:
  1. Remove Conversation, normalization, structured parsing/cards/composer and structured-input calls.
  2. Retain attach/replay/input/control and make terminal occupy available `100dvh`/safe-area space.
  3. Claim/resize after first stable layout and stable orientation changes; ignore keyboard/layout noise and coalesce duplicate sizes.
  4. Surface non-owner/failure/retry/re-adapt state truthfully.
- Acceptance criteria:
  - Full-screen TUI output and interactive Agent prompts remain byte-faithful and usable in portrait/landscape.
  - One stable geometry transition creates one acknowledged resize revision; observer noise creates none.
  - Resize failure leaves the prior ownership state visible and retryable.
- Verification method:
  - SessionWorkspace/MobileTerminal focused tests plus simulator/manual portrait-landscape-soft-keyboard smoke.
- Validation evidence: Done 2026-09-02. Terminal-only raw PTY path, geometry CAS request/ACK, stable phone device ID, first-open input gate, desktop-owner pause/re-adapt and local-only soft-keyboard/layout fits implemented. Session focused tests passed and Mobile full suite/build passed; physical rotation/keyboard smoke remains in T-008.
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — Add desktop phone-size prompt and explicit restore flow

- Status: done
- Owner: desktop-geometry-worker
- Objective: Prevent desktop auto-resize from silently fighting Mobile ownership and let the user restore desktop geometry explicitly.
- Inputs and prerequisites: T-004 geometry state/control; existing desktop terminal fit/restore invariants.
- Scope or files: desktop terminal state/types/API/UI/styles/i18n and focused tests.
- Expected output: Revision-aware “已为手机调整” banner with current C×R/source, dismiss-current-revision and “恢复桌面尺寸” action.
- Dependencies: T-004.
- Execution steps:
  1. Observe geometry owner/revision on desktop Session open/attach.
  2. Suspend ordinary desktop auto-resize while a live Mobile owner is active.
  3. Render prompt and explicit restore action; dismiss only the current revision.
  4. Restore using synchronous terminal buffer+DOM viewport handling and publish new owner/revision.
- Acceptance criteria:
  - Desktop open does not steal Mobile geometry before explicit restore.
  - A newer Mobile revision reappears after an older revision was dismissed.
  - Restore produces one desktop-owned revision with no viewport jump or resize loop.
- Verification method:
  - Focused desktop Vitest plus real desktop/Mobile concurrent attach smoke.
- Validation evidence: Done 2026-09-02. Desktop runtime consumes attach/ACK/change geometry, passive xterm fit no longer publishes while Mobile owns, overlay prompt/dismiss-current-revision/restore CAS implemented. Focused desktop tests passed 105 assertions, production build passed and scoped diff check was clean; existing i18n Rust allowlist warnings are unrelated.
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — Integrate, validate, cleanly commit and present the debug App

- Status: done
- Owner: coordinator
- Objective: Prove V2 behavior across layers, remove dead product imports, and deliver one scoped commit without unrelated dirty changes.
- Inputs and prerequisites: T-002 through T-007 complete.
- Scope or files: All V2-owned diffs, this task document, build artifacts only where repository policy requires.
- Expected output: Passing focused/full gates, platform limitations recorded, rebuilt/open debug App, screenshot/process proof and scoped Git commit.
- Dependencies: T-002, T-003, T-004, T-005, T-006 and T-007.
- Execution steps:
  1. Validate task document and reconcile every task status/evidence.
  2. Run frontend, Mobile native, shared Rust and desktop focused/full tests plus production builds.
  3. Run two-device isolation, quick launch, notification, raw terminal, portrait/landscape and concurrent desktop restore smokes where environment permits.
  4. Run `bash scripts/rebuild-debug-app.sh`, close only the old workspace debug GUI, `open -n` the exact debug bundle, verify executable path and capture a nonblank screenshot.
  5. Inspect final diff/status, stage only proven V2 paths, create required feature commit and record commit/test evidence.
- Acceptance criteria:
  - AC-001 through AC-012 have evidence or an explicit external platform limitation.
  - Debug App process path is the workspace bundle and screenshot is nonblank.
  - Commit contains no known unrelated user edits.
- Verification method:
  - Full command log, Git diff/status inspection, process path and screenshot evidence, final task-doc validator.
- Validation evidence: Done 2026-09-02. Mobile 7 files/21 tests, production build and Tauri library 19/19 passed; iOS 26.5 arm64 simulator bundle built, installed, launched, and showed the nonblank Sessions-first single-device workspace. Desktop 78 files/517 tests and production build passed. Shared Rust gates passed: Remote protocol 11/11, Service 27/27, Bridge 15/15 plus no-listener integration, Host integration 35/35, desktop Tauri 43/43, and `cargo check --workspace`. The exact workspace debug bundle was rebuilt with Bundle ID `com.agentport.desktop.debug.c9d007c8147e`, launched as PID 14705 from `/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`, and its terminal workspace was visibly nonblank. Final integration inspection caught and fixed the Mobile event consumer to match the real Host/Bridge `terminal_geometry_changed` + `geometry` contract; the regression is included in the 21 Mobile tests. Both staged and worktree diff checks and the task-document validator passed before commit.
- Blocker: None for the implemented V2 scope. Android 10/API 29 runtime, iOS 16 runtime, physical-device notification/background behavior, real phone rotation/soft-keyboard behavior, and a live two-device concurrent smoke were unavailable in this environment and remain release/platform gates rather than claimed passes. Mobile's production JS chunk is 541.42 kB and currently emits Vite's >500 kB warning. Rejected Host geometry ACK detail is flattened by Bridge to generic `request_not_executed`; clients still recover authoritative geometry via broadcast/reattach.
- Unblock condition: Run the remaining platform gates on the documented API 29, iOS 16 and physical-device fixtures before release qualification; preserving them as explicit release evidence does not reopen the completed V2 implementation task.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. Document gate after initial fill, every material dependency/status change, and finalization:
   - `python3 /Users/w/AI/.skills/wjSkill/skills/plan-and-execute-tasks/scripts/task_document.py validate --path docs/tasks/2026-09-02-agentport-mobile-v2-task.md`
2. Mobile frontend focused and full:
   - `cd mobile && npx vitest run <V2 focused test files>`
   - `cd mobile && npm test -- --run`
   - `cd mobile && npm run build`
3. Mobile native and shared Rust:
   - `cargo test --manifest-path mobile/src-tauri/Cargo.toml --lib`
   - `cargo test -p agentport-remote-protocol -p agentport-service -p agentport-remote-bridge`
   - Focused core/host tests for list liveness and geometry transitions.
4. Desktop frontend:
   - `cd src && npx vitest --run <status/active-agents/quick-start/geometry-prompt focused tests>`
   - Run the package's full non-mutating test/build scripts after inspecting script definitions.
5. Runtime/product smoke:
   - Two devices with overlapping Session/project names to prove isolation.
   - Project quick launch for Pi, Shell and one supporting Agent; duplicate tap and failure cases.
   - ApprovalRequested/TurnCompleted notification allowlist and negative cases.
   - Raw full-screen Agent CLI in portrait/landscape, soft keyboard, reconnect/replay and simultaneous desktop attach.
   - Mobile claim → desktop prompt/dismiss → newer Mobile revision → desktop restore → Mobile re-adapt.
6. Repository policy gate:
   - Rebuild exact debug `.app`, open independent instance, verify exact process path and nonblank screenshot.
   - Review path-scoped staged diff and create one task-only commit.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- The worktree contains broad pre-existing modifications and untracked V1 implementation. Risk control: explicit ownership per worker, no reset/stash/checkout, coordinator-only task doc and commit, path-scoped diff/staging.
- Geometry ownership crosses Core/Host/Service/Bridge/Mobile/Desktop. Risk control: freeze one additive contract first, test state transitions independently, and prohibit frontend heuristics.
- Desktop auto-fit can create cross-client tug-of-war or viewport desynchronization. Risk control: explicit owner/revision, stale-write guards, coalescing, and synchronous buffer+DOM restore verification.
- Notification delivery depends on platform permissions/background behavior. Risk control: authoritative event allowlist and dedup unit tests first; label simulator/real-device gaps rather than claiming success.
- Android build may remain blocked by external Maven 403/network restrictions inherited from V1. This does not block source-level V2 completion but blocks Android runtime acceptance evidence.
- Removing broad Remote registry methods could break future/desktop consumers. Risk control: distinguish Mobile public allowlist from shared Service implementation and run registry/consumer tests before deletion.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-02: Task document created in execute mode as the only Mobile V2 status authority.
- 2026-09-02: Read the requested `plan-and-execute-tasks` skill and applicable repository/mobile UI guidance; preserved dirty-worktree and commit/debug-App rules.
- 2026-09-02: Completed three-way V1/frontend/backend read-only audits; established reuse/cleanup boundaries, capability/attention gaps and Host-centered geometry requirements.
- 2026-09-02: Baseline `npm test -- --run` passed 24 tests in 9 files; `npm run build` passed with Mermaid chunk-size warning; Mobile Tauri library passed 19 tests.
- 2026-09-02: Initial plan populated; T-001 marked done from current evidence. No implementation task was marked done from V1 prose alone.
- 2026-09-02: T-002 contract frozen after backend/frontend producer-consumer review; document validation passed. Started Batch 2 with disjoint ownership: T-003 Mobile shell cleanup and T-004 Core/Host/Service/Bridge runtime.
- 2026-09-02: Started the dependency-independent T-006 terminal-only cleanup in parallel; geometry-aware resize remains gated on T-004's concrete DTO/control implementation.
- 2026-09-02: Began T-005's dependency-independent semantic model: desktop-equivalent Active Agent ordering, agent preference ordering/hiding, exact quick-start payload, status class and notification allowlist; 5 focused tests passed. UI/data integration remains gated on T-003/T-004.
- 2026-09-02: T-003 completed. Implemented single-device selector/workspace, Project and Active layouts, Recent sheet and Project-row quick launch on top of the new shell. Mobile full suite passed 7 files/20 tests and production build passed; only jsdom canvas and >500 KB terminal bundle warnings remain.
- 2026-09-02: T-006 terminal-only slice completed: Conversation/structured/history/composer paths removed, raw PTY interaction retained, observer resize coalesced and immersive `100dvh` layout added. Geometry ownership integration remains open under T-004/T-006.
- 2026-09-02: T-004 supplied the compiled geometry JSON contract. Mobile now sends expectedRevision/sourceKind/mobile device/orientation, consumes ACK geometry, pauses after a desktop geometry event and exposes explicit re-adapt; soft-keyboard/layout fits no longer publish remote resize. Started T-007 desktop frontend ownership in parallel.
- 2026-09-02: T-004 completed with authoritative Session projection, global attention polling, Host run-local geometry CAS/broadcast and desktop Tauri bindings. T-005/T-006 integrated those contracts; added least-privilege native notification plugin permissions. T-007 desktop overlay/restore flow completed. Started T-008 full validation and delivery.
- 2026-09-02: T-008 completed. Full Mobile/Desktop/Rust gates passed, iOS simulator and exact desktop debug bundle both launched nonblank, the real geometry event contract mismatch was fixed with a regression, and only explicitly listed platform/release gates remain.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-008 records the final automated suites, production builds, iOS 26.5 simulator launch, exact desktop debug process and nonblank screenshots; final task validation and diff checks passed before the scoped feature commit.
- Limitations: Android API 29 runtime, iOS 16 runtime, physical-device notification/background and rotation/soft-keyboard behavior, and live multi-device concurrency still require the documented release fixtures. The 541.42 kB Mobile JS chunk warning and generic Bridge geometry-rejection error are known follow-up quality issues, not hidden passes.
