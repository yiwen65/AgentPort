# Task Plan: 精简终端历史与搜索

- Created: 2026-09-14
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户在只读评估后要求“执行整改”。

<!-- task-doc-section:background-goal -->
## Background and goal

按已确认的最小化方案整改桌面终端：Shell 普通 attach 继续保留 4 MiB，fullscreen Pi 继续使用 64 KiB；终端搜索只保留当前 xterm buffer 的字符搜索；恢复时间线只打开 Session 最新状态，不再执行精确 raw PTY cursor 定位。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围包括桌面 React/xterm 搜索 UI、Session 选择与恢复时间线、对应 Tauri 命令和仅服务于被移除桌面流程的代码及测试。保留 Agent-native 历史分页、全局项目搜索、NativeHistory 核心搜索能力、Shell 4 MiB replay、Pi 64 KiB replay。为兼容已运行 Host 和跨版本协议，不删除 wire protocol 中的可选 recovery 字段及 Host 解析能力。不得修改用户已有未提交文件。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Shell 没有 Agent-owned native conversation log。 | `crates/agentport-core/src/history.rs:489-493` |
| F-002 | 终端搜索同时使用 xterm `SearchAddon` 与自动 `searchSessionLog`。 | `src/src/components/TerminalArea.tsx:452-655` |
| F-003 | 时间线精确定位只对 live PTY 条目开放。 | `src/src/components/TimelineDialog.tsx:15-52`、`src/src/actions.ts:489-559` |
| F-004 | 有效 recovery target 由 Host 固定限制为前 128 KiB、后 256 KiB。 | `crates/agentport-host/src/server.rs:951-961` |
| F-005 | 工作区已有用户未提交修改。 | 任务开始时 `git status --short` 输出。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “执行整改”授权实施上一轮回复中的“推荐的最小化最终形态”；影响是移除终端内自动 Agent-native 全历史查询和恢复时间线精确定位。
- Assumption: wire protocol 属于跨进程、可能跨版本边界；本次保留其兼容字段，避免新 GUI 与已运行旧 Host 的连接风险。
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Shell attach 仍请求 4 MiB，普通 fullscreen Pi attach 仍请求 64 KiB。
- Cmd/Ctrl+F 仍可在当前 xterm buffer 高亮并前后导航，但不再自动调用 Session 原生历史搜索。
- 恢复时间线点击存在的 Session 时只选择最新 Session，不再传 cursor 或重建 terminal 定位。
- 桌面前端和 Tauri 不再暴露仅服务于上述两项已移除 UI 流程的命令。
- 相关测试、桌面全量测试和构建通过；调试 App 按统一脚本重启并确认非白屏。
- 只提交本任务文件，不包含任务开始前的用户修改。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；当前运行时无 subagent 工具，且前端 API、共享测试 mock 与最终验证存在重叠。
- Serialization constraints: `src/src/terminals.ts`、`api.ts`、测试 mock 和任务文档需要串行维护。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 精简终端字符搜索

- Status: done
- Owner: coordinator
- Objective: 仅保留当前 xterm buffer 的 SearchAddon 搜索和导航。
- Inputs and prerequisites: F-001、F-002；用户已授权执行。
- Scope or files: `src/src/components/TerminalArea.tsx`、`src/src/api.ts`、相关 locale 与测试。
- Expected output: 不再自动查询或显示 Agent-native 全历史结果，当前缓冲搜索保持可用。
- Dependencies: None.
- Execution steps:
  1. 删除 TermSearchBar 的原生历史请求、状态和展示。
  2. 删除无消费者的桌面 Tauri API/命令并更新 mock/测试。
- Acceptance criteria:
  - 当前缓冲搜索仍调用 SearchAddon。
  - `searchSessionLog`/`search_session_log` 不再存在于桌面边界。
- Verification method:
  - 引用搜索、相关 Vitest、TypeScript 构建。
- Validation evidence: `npm test -- --run src/components/TerminalArea.split.test.tsx`（`src/`）通过，12 tests；全仓引用搜索确认桌面 `searchSessionLog`、`search_session_log` 和完整历史搜索 UI key 已清除。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 移除时间线精确 raw PTY 定位

- Status: done
- Owner: coordinator
- Objective: 时间线只打开 Session 最新状态，删除 renderer/Tauri 精确定位路径。
- Inputs and prerequisites: T-001 完成；F-003、F-004。
- Scope or files: `TimelineDialog.tsx`、`actions.ts`、`terminals.ts`、`api.ts`、`types.ts`、`runtimeMessages.ts`、Tauri command、locale 与相关测试。
- Expected output: UI 不再传 cursor，terminal attach 仅处理普通 tail/resume；兼容 wire 字段保留。
- Dependencies: T-001.
- Execution steps:
  1. 简化时间线和 `selectSession` 接口。
  2. 删除 `jumpToRecoveryOutput`、marker/gap 状态和 ended-context Tauri 命令。
  3. 更新测试与无消费者文案。
- Acceptance criteria:
  - 前端不存在精确定位调用链。
  - 时间线仍可打开已有 Session。
  - replay 常量策略不变。
- Verification method:
  - 引用搜索、renderer/action 测试、Rust check/test。
- Validation evidence: 受影响的 5 个 Vitest 文件共 166 tests 通过；`npm run build` 通过；`cargo check -p agentport` 通过；引用搜索确认桌面精确定位调用链和文案已清除；新增 TimelineDialog 测试确认只以 Session ID 打开最新状态。
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — 集成验证、重启与提交

- Status: blocked
- Owner: coordinator
- Objective: 验证完整变更，打开更新后的调试 App，并创建隔离 commit。
- Inputs and prerequisites: T-001、T-002 完成。
- Scope or files: 本任务 diff、桌面测试/构建、调试 App、Git index。
- Expected output: 验证通过、非白屏调试窗口、仅含任务改动的 commit。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 运行相关与全量桌面测试、构建和 Rust 检查。
  2. 检查 diff 与任务文档。
  3. 使用 `scripts/restart-debug-app.py` 重启并截图确认。
  4. 仅暂存任务文件并提交。
- Acceptance criteria:
  - 所有要求验证通过或明确报告 blocker。
  - commit 不包含用户既有修改。
- Verification method:
  - 命令输出、进程路径、截图、`git show --stat` 与最终 status。
- Validation evidence: 桌面全量 Vitest 91 files / 670 tests 通过；`npm run build` 通过；`cargo test -p agentport` 55 tests 通过；`git diff --check` 通过；统一脚本成功构建、固定证书签名并打开 PID 38358，`ps` 确认路径为目标 debug App。截图未完成：ScreenCaptureKit 返回 `SCStreamErrorDomain Code=-3811`，整屏截图全黑；System Events 显示前台进程为 `loginwindow`，表明当前 macOS GUI Session 被锁定。
- Blocker: 当前 macOS GUI Session 锁定，无法取得可用于确认非白屏的截图；代码、测试、构建、签名、重启和进程路径验证均已完成。
- Unblock condition: 解锁当前 macOS GUI Session 后激活 PID 38358 并重新截图确认窗口内容。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先运行受影响 Vitest；再运行桌面全量测试和 TypeScript/Vite 构建；运行针对 `agentport` 的 Rust check/相关测试；用引用搜索确认 UI 调用链清理完整；最后按仓库脚本构建签名重启 App，确认目标 GUI 可执行路径并截图检查非白屏。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 删除 Tauri command 可能留下前端 mock、invoke 注册或类型引用，使用全仓引用搜索和编译发现。
- 修改 `selectSession` 参数次序可能影响内部调用，所有调用点必须更新并由 TS/测试覆盖。
- 删除 wire 字段会影响已运行 Host；本次明确保留 protocol/Host 兼容实现。
- 用户既有修改不得暂存、格式化或覆盖。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-14: 创建 execute 模式任务文档。
- 2026-09-14: T-001 开始，由 coordinator 串行执行；确认保留跨版本 Host protocol recovery 字段。
- 2026-09-14: T-001 完成；TerminalArea 相关 12 个测试通过，桌面完整历史自动搜索边界已清除。
- 2026-09-14: T-002 开始，由 coordinator 串行执行。
- 2026-09-14: 首次前端构建发现 `TerminalArea.tsx` 的 `api` import 已无消费者；移除该 import 后构建通过。
- 2026-09-14: T-002 完成；166 个受影响测试、前端构建与 `cargo check -p agentport` 通过。
- 2026-09-14: T-003 开始，进入全量验证、调试 App 重启和隔离提交。
- 2026-09-14: 首次全量测试暴露 5 个随内部签名/文案变化而失效的测试；同步更新后，桌面全量 91 files / 670 tests 通过。
- 2026-09-14: `cargo test -p agentport` 55 tests、前端构建和 diff check 通过。
- 2026-09-14: 统一脚本成功构建签名并打开目标 debug GUI PID 38358；进程路径核验通过。
- 2026-09-14: 截图被锁定的 macOS GUI Session 阻塞：ScreenCaptureKit 报 -3811，整屏截图全黑，System Events 前台为 loginwindow。T-003 标记 blocked，等待解锁后补截图。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001、T-002 已完成；670 个桌面测试、55 个 Rust 测试、TypeScript/Vite 构建、diff check、签名重启和目标 GUI 进程路径均通过。
- Limitations: 当前 GUI Session 锁定，无法截图确认窗口非白屏；T-003 因此保持 blocked。
