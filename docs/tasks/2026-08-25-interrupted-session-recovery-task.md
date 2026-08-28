# Task Plan: 修复中断 Session 冷启动恢复

- Created: 2026-08-25
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户报告：Session 中断后关闭并重启 AgentPort，会直接进入历史页，且无法恢复中断 Session。

<!-- task-doc-section:background-goal -->
## Background and goal

恢复冷启动后的中断 Session 工作流：首先显示明确的中断恢复界面，而不是把用户直接送进普通“已结束历史”页；点击重启后必须重新挂载该 PTY Session 并恢复实时终端。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Scope: `TerminalArea` 的 interrupted 渲染分支、`restartSessionFlow` 的终端挂载状态、对应前端回归测试及 Debug App 实机验证。
- Non-goals: 不改变 exited/stopped Session 的原生日志历史页；不恢复另存的 `output.log` 持久化；不改变后端 Agent 原生会话恢复协议。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | `TerminalArea` 把 `interrupted` 与 `exited/stopped` 一起直接渲染为 `NativeHistoryPane`，因此 `SessionOverlay` 中已有的中断恢复卡片不可达。 | `src/src/components/TerminalArea.tsx` 的 `sessionEnded` 顶层分支与 `SessionOverlay` interrupted 分支。 |
| F-002 | `selectSession` 只把 creating/running PTY 放入 `attachedIds`；冷启动选择 interrupted Session 时挂载集合为空。 | `src/src/actions.ts` 的 `selectSession`。 |
| F-003 | `restartSessionFlow` 重启并刷新项目后直接调用 `attachHandle`，没有重新执行选择逻辑，因此 running Session 仍可能没有已挂载的 `TerminalPane`。 | `src/src/actions.ts` 的 `restartSessionFlow`。 |
| F-004 | 后端 `restart_session` 会从持久化的 Agent session id 构造 resume plan，并在 Host launch 后发布 Running。 | `src-tauri/src/main.rs` 的 `restart_session`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 中断恢复页可以按需读取原生日志作为弱化背景，但主交互必须是可见的中断恢复卡片。
- Open question: 无阻塞问题；最终以打包 Debug App 的冷启动/重启交互确认实际行为。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- interrupted Session 打开时显示中断恢复卡片，不显示普通历史页头部操作区。
- 点击重启后 Session 进入 live 分支，PTY id 被加入 `attachedIds`，xterm 容器可见并连接新 Host。
- exited/stopped Session 仍保持现有原生日志历史页。
- 聚焦回归、完整前端测试、构建和打包 Debug App 均通过，并验证正确的 Debug GUI 进程与非白屏窗口。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → T-003。
- Parallel batches: 无；本任务改动集中且共享同一渲染/状态边界，串行更利于证明首个分歧。
- Serialization constraints: 先以失败测试锁定行为，再修改产品代码，最后进行全量与实机验证。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立冷启动中断视图回归

- Status: done
- Owner: primary agent
- Objective: 证明 interrupted 被错误路由到普通历史页，并约束恢复卡片可达。
- Inputs and prerequisites: F-001；现有 `TerminalArea.uncommitted.test.tsx` 测试支架。
- Scope or files: `src/src/components/TerminalArea.uncommitted.test.tsx`。
- Expected output: 一个修复前失败、修复后通过的组件测试。
- Dependencies: None.
- Execution steps:
  1. 构造冷启动式 interrupted Session（无 attachedIds）。
  2. 断言中断卡片和 Restart 按钮可见，普通历史页 header 不可见。
- Acceptance criteria:
  - 测试能在修复前复现错误路由。
- Verification method:
  - 运行聚焦 Vitest 用例。
- Validation evidence: 修复前 `session-state-card` 缺失；修复后聚焦组件测试通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 恢复重启后的 PTY 挂载

- Status: done
- Owner: primary agent
- Objective: 让 active interrupted Session 重启后重新加入 `attachedIds` 并显示实时 xterm。
- Inputs and prerequisites: F-002、F-003、T-001。
- Scope or files: `src/src/actions.ts`、`src/src/actions-session-selection.test.ts`。
- Expected output: 重启后 active Session 被重新选择和挂载。
- Dependencies: T-001。
- Execution steps:
  1. 为 interrupted → running 状态转换增加 action-level 回归。
  2. 项目快照刷新后重新执行 active Session 选择，再连接 Host。
- Acceptance criteria:
  - `attachedIds` 包含重启后的 PTY id，`attachHandle` 被调用。
- Verification method:
  - 运行聚焦 Vitest 与 Debug App 实际 Restart。
- Validation evidence: action 回归通过；实机 Restart 后出现 `Terminal input` 与 shell prompt。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 持久化并恢复最后活动 Session

- Status: done
- Owner: primary agent
- Objective: GUI 冷启动优先恢复关闭前用户选择的 Session，而不是无条件打开列表第一项。
- Inputs and prerequisites: 实机首次验证发现 boot 固定选择 `flattenSessions()[0]`。
- Scope or files: `src/src/actions.ts`、`src/src/App.tsx`、`src/src/App.notification.test.tsx`。
- Expected output: 最后选择 id 写入 WebView localStorage；boot 在通知导航之后、默认首项之前恢复该 id。
- Dependencies: T-001。
- Execution steps:
  1. 添加 interrupted Session 冷启动选择回归并确认修复前失败。
  2. 选择时持久化 id；boot 仅在该 id 仍存在时恢复。
  3. 保持通知点击拥有更高优先级。
- Acceptance criteria:
  - 关闭并重开 GUI 后仍打开同一 interrupted Session 的恢复卡片。
  - 已删除/归档的记忆 id 自动回退，不阻塞启动。
- Verification method:
  - App boot 单测与打包 Debug App 两次冷启动。
- Validation evidence: `App.notification.test.tsx` 5/5；实机冷启动后 AX 树仍含 `debug-interrupted-recovery`、`Session interrupted`、`Restart`。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 全量与打包实机验证

- Status: done
- Owner: primary agent
- Objective: 验证无回归并按仓库规则交付可见 Debug App。
- Inputs and prerequisites: T-001、T-002、T-003。
- Scope or files: 全前端测试/构建、Debug bundle、专用临时 Shell Session。
- Expected output: 完整自动化与真实中断恢复链路通过。
- Dependencies: T-001、T-002、T-003。
- Execution steps:
  1. 运行完整 Vitest、TypeScript/Vite build、i18n 与 diff 检查。
  2. 重建/签名 Debug App，仅重启精确 GUI 进程。
  3. 创建专用 Shell Session，验证 interrupted 冷启动和 Restart，随后停止并归档测试 Session。
- Acceptance criteria:
  - Debug GUI 非白屏且进程路径准确；用户原有 Host 不被中断。
- Verification method:
  - 进程检查、AX 树、截图、CLI lifecycle/Host PID 查询。
- Validation evidence: 48 files / 321 tests；build/i18n/diff 通过；Debug GUI PID 9916；用户 `性能优化` Host PID 5053 仍 running；专用测试 Session 已 stop+archive。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. Red: 新增 interrupted 冷启动视图测试与 restart 后挂载状态测试，确认当前实现失败。
2. Green: 最小修改渲染分支与 restart flow，使两项聚焦测试通过。
3. Regression: 运行 `TerminalArea.uncommitted.test.tsx`、`actions-session-selection.test.ts`，再运行完整前端测试与构建/i18n 检查。
4. Runtime: 按仓库规则重建并重启 Debug App，确认精确进程路径、窗口非白屏，并在实际 interrupted Session 上验证恢复。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 风险：原生日志异步读取失败不应遮挡 Restart 主操作；恢复卡片必须独立于历史加载状态。
- 风险：调用 `selectSession` 会触发 seen 状态后台刷新；测试需隔离该异步请求，产品流程需避免重复 Host attach 的可见副作用。
- Blocker: None.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-25: 完成静态首个分歧定位；确认顶层渲染绕过恢复卡片，以及重启后未恢复 PTY 挂载集合。
- 2026-08-25: 两项首因修复完成；首次打包验证暴露 boot 无条件选择首个 Session，补充最后活动 Session 持久化与回归。
- 2026-08-25: 完整自动化及专用 Shell 的 interrupted → GUI cold start → Restart → live terminal 链路通过，测试 Session 已清理。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 48 个 Vitest 文件、321 项测试全部通过；Vite/TypeScript build、i18n、`git diff --check` 通过；Debug App 冷启动保持 interrupted 恢复卡片，Restart 后显示实时 shell prompt。
- Limitations: 原生日志不可用时背景会显示弱化的 unavailable 状态，但 Restart 主操作不依赖历史加载；localStorage 被系统禁用时仍会安全回退到列表首项。
