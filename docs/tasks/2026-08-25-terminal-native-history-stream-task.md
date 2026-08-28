# Task Plan: 统一终端按需加载原生历史

- Created: 2026-08-25
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求取消原生历史中间页，不兼容旧 Session output log，统一在 xterm 内按需无感加载 agent 原生日志。

<!-- task-doc-section:background-goal -->
## Background and goal

AgentPort 现有实现会在 live Session 触顶时覆盖一层 DOM 原生历史页，在 stopped/exited 时完全切换到该页面，在 interrupted 时又把该页面作为模糊背景。这导致滚动切页、冷启动落入历史页，以及渲染器/选择行为不一致。目标是让 PTY Session 始终只有一个 xterm 渲染器：原生日志尾页直接渲染进终端，触顶时分页加载更早内容并保持当前可见行不动；生命周期操作只作为同一终端上的 overlay。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：`src/src/terminals.ts` 的原生日志分页、ANSI 文本化、缓冲区重建与视口锚定；`TerminalArea.tsx` 的统一终端布局和触顶加载；Session 选择时挂载已结束/中断 PTY；相关 CSS、单元回归、调试 App 构建与实机验证。
- 非目标：不改 agent 原生日志解析/归一化后端；不兼容或回放 AgentPort 历史 `output.log`；不迁移/删除用户已有日志文件；JSON-RPC structured timeline 保持原有渲染。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | live PTY 触顶当前通过 `.native-history-pane.live` 覆盖 DOM 页面。 | `src/src/components/TerminalArea.tsx:384-568,1060-1082` |
| F-002 | stopped/exited 完全渲染 `NativeHistoryPane`，interrupted 以其作为恢复背景。 | `src/src/components/TerminalArea.tsx:1033-1046` |
| F-003 | ended PTY 的 xterm 旧路径调用 `readLogTail` 回放 AgentPort `output.log`。 | `src/src/terminals.ts:1437-1538` |
| F-004 | 原生日志 API 已支持从尾部开始的反向游标分页，并把每页事件恢复为正序。 | `crates/agentport-core/src/history.rs:141-286`；`src/src/api.ts:533-534` |
| F-005 | xterm 的写入、parser drain 和视口意图已经有单一协调器，可用于重建后的同帧锚定。 | `src/src/terminals.ts:72-226,837-918`；`LEARNS.md` xterm viewport lessons |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “无感加载”要求加载前后同一可见内容保持在同一视口位置；加载过程中不出现独立页面、空白帧或自动跳到底部。验证通过单元测试的 parser-boundary 锚定以及 Debug App 实际滚动完成。
- Assumption: 原生日志事件以只读、无控制序列的 ANSI 文本块写入 xterm；文本中的 ESC/C0 控制字符必须转义，避免日志内容操纵终端状态。
- Open question: None. 用户已明确取消中间页、旧日志兼容和保留要求。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- PTY Session（running/interrupted/stopped/exited）均使用同一 `TerminalPane`/xterm，不再渲染 `NativeHistoryPane`。
- 首次进入无可用 live replay 的 PTY Session 时只请求原生日志最新页，绝不调用 `readLogTail`。
- normal buffer 触顶向上滚动时请求上一游标页；同一页并发只请求一次，旧 Session 的迟到响应不污染当前终端。
- 历史页直接成为 xterm scrollback 前缀；加载完成后用户原先看到的行保持原位，继续上滚即可看到新加载内容。
- alternate-screen TUI 不拦截滚轮，不触发原生日志加载；到达最老页后不重复请求。
- 生命周期恢复/重启操作仍是终端上的 overlay；无页面切换，文本选择/复制保持 xterm 原生行为。
- 聚焦前端回归、全量前端测试、构建、i18n 和 Debug App 实机检查通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004.
- Parallel batches: 全部串行；核心状态、React 布局和测试共享同一终端契约。
- Serialization constraints: `terminals.ts` 与 `TerminalArea.tsx` 的接口必须先稳定，再更新既有测试和 CSS；无边界清晰的并行任务。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立失败回归与终端历史契约

- Status: done
- Owner: coordinator
- Objective: 用测试锁定单一 xterm、原生日志分页、旧 log 禁用、并发去重和视口锚定。
- Inputs and prerequisites: F-001 至 F-005；现有 TerminalArea 与 renderer 测试夹具。
- Scope or files: `src/src/components/TerminalArea.uncommitted.test.tsx`、`src/src/terminals-renderer.test.ts`、`src/src/actions-session-selection.test.ts`。
- Expected output: 修改前能稳定失败、覆盖用户报告回归的测试。
- Dependencies: None.
- Execution steps:
  1. 替换 DOM 历史页断言为统一 xterm 断言。
  2. 增加原生日志尾页/上一页、锚定、去重、alternate-screen 和 `readLogTail` 禁用测试。
- Acceptance criteria:
  - 目标测试在旧实现失败且失败原因匹配页面切换/旧日志回放。
- Verification method:
  - `npm test -- --run <focused files>`（Red）。
- Validation evidence: `cd src && npm test -- --run src/components/TerminalArea.uncommitted.test.tsx src/actions-session-selection.test.ts src/terminals-renderer.test.ts`：旧实现 6 个目标失败（ended/interrupted 无 term-host、触顶未调用终端分页器、ended 未请求 native API、仍无分页函数），其余 78 个通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现 xterm 内原生日志按需分页

- Status: done
- Owner: coordinator
- Objective: 在终端管理器内格式化安全历史文本，维护分页状态，通过重建 scrollback 前缀并恢复锚点实现无感 prepend。
- Inputs and prerequisites: T-001 done.
- Scope or files: `src/src/terminals.ts`、必要的类型/测试夹具。
- Expected output: `loadOlderNativeHistory`/初始加载路径及严格 generation、cursor、parser drain 防护。
- Dependencies: T-001.
- Execution steps:
  1. 移除 ended `readLogTail` 路径和旧 historyLoaded 语义。
  2. 建立每 handle 的 native page 状态与安全文本化。
  3. 以 snapshot + 全量前缀重放重建 normal buffer，在 parser drain 后同步 buffer/DOM 视口。
- Acceptance criteria:
  - T-001 的 renderer 测试 Green；无重复请求、无跨 Session 污染、无控制字符注入。
- Verification method:
  - focused renderer tests + TypeScript build。
- Validation evidence: `cd src && npm test -- --run src/components/TerminalArea.uncommitted.test.tsx src/actions-session-selection.test.ts src/terminals-renderer.test.ts`：85/85 通过，包含连续两页 prepend、in-flight 去重、视口增量锚定、控制字符净化和禁止 `readLogTail`。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 统一 Session 视图和选择生命周期

- Status: done
- Owner: coordinator
- Objective: 删除 DOM 历史页模式，确保所有 PTY 生命周期都挂载同一 TerminalPane 并以 overlay 表示不可写状态。
- Inputs and prerequisites: T-002 done.
- Scope or files: `src/src/components/TerminalArea.tsx`、`src/src/actions.ts`、`src/src/styles.css`、相关测试。
- Expected output: 无 `NativeHistoryPane`、无历史页 CSS/状态；触顶直接调用终端分页接口。
- Dependencies: T-002.
- Execution steps:
  1. 删除历史页组件与 live-history React 状态。
  2. PTY 的 ended/interrupted Session 纳入单实例 attachedIds 挂载。
  3. 保留 alternate-screen、恢复 overlay、状态栏与复制/滚动行为。
- Acceptance criteria:
  - DOM 中无 native-history page；ended/interrupted PTY 有 term-host；恢复操作仍可用。
- Verification method:
  - focused TerminalArea/actions tests + CSS contract checks。
- Validation evidence: TerminalArea 回归确认 running/interrupted/stopped PTY 均保留 `.term-host` 且 DOM 无 `.native-history-pane`；actions 回归确认 ended PTY 进入单实例 xterm LRU。聚焦测试 85/85 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成验证与 Debug App 实机检查

- Status: done
- Owner: coordinator
- Objective: 验证无回归并按仓库规则重建、重启精确 Debug App，检查真实滚动/选择/恢复。
- Inputs and prerequisites: T-003 done.
- Scope or files: 全量前端验证、`scripts/rebuild-debug-app.sh`、工作区 Debug bundle。
- Expected output: 测试/构建通过，Debug GUI 精确进程运行且非白屏，目标 Session 无历史页跳转。
- Dependencies: T-003.
- Execution steps:
  1. 运行 focused/full tests、build、i18n、diff/check。
  2. 重建 Debug App，仅关闭精确 debug GUI PID 并 `open -n`。
  3. `ps` 核验可执行路径，截图及真实滚动/选择/恢复冒烟。
- Acceptance criteria:
  - 所有计划验证通过；真实 App 只显示终端并能触顶连续加载。
- Verification method:
  - 命令输出、进程路径、截图/交互记录。
- Validation evidence: `npm test -- --run` 全量 48 files / 321 tests 通过；`npm run build`、`npm run i18n:check` 与 `git diff --check` 通过；`scripts/rebuild-debug-app.sh` 成功完成前端、Host、custom-protocol GUI 构建和签名。最终精确 Debug GUI PID 67647 的可执行路径为 `/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`，窗口截图非白屏。真实 ended Pi Session 在同一 xterm 中显示原生历史，滚动与拖选正常，Cmd+C 从选择复制出 38 bytes；live Session 触顶加载未进入 Header/Export 历史页。连续第二页曾在实机暴露 `baseY` 锚定错误，改为 native/live marker 相对锚定后对应回归通过。最终 frontend/Tauri 中已无 `read_log_tail` IPC；新 Host 的既有回归保证不创建重复 `output.log`。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Red：聚焦 TerminalArea/actions/renderer 回归证明旧实现仍会切页或读旧 log。
- Green：聚焦回归 + `npm test -- --run` 全量前端。
- 静态：`npm run build`、`npm run i18n:check`、`git diff --check`。
- 运行时：按 AGENTS.md 重建 Debug App，确认精确 GUI 路径和非白屏，并在真实长 Session 上触顶滚动、选择文本、测试 interrupted 恢复入口。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- xterm 没有公开 prepend API，需重建 normal buffer；风险是 parser 未完成时短暂跳动。通过 write coordinator drain、generation fence、视口增量和 DOM scrollTop 同步控制。
- 原生日志与 live PTY 尾部可能语义重叠。此次不做脆弱文本去重；仅在进入 native prefix 时显示稳定边界标记，且同一 API cursor 只消费一次。
- 原生日志含任意模型文本，必须移除 ESC/C0（保留换行/制表）后再送入 xterm。
- 工作树已有大量无关改动；仅修改任务列出的前端/文档文件，不重置、不覆盖其他改动。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-25: Task document created and filled from current source evidence; execution authorized by the user's fix request.
- 2026-08-25: T-001 done; focused Red run produced 6 expected failures and 78 passes. T-002 started.
- 2026-08-25: T-002/T-003 done. Focused Green 85/85；全量前端 48 files / 321 tests 通过；`npm run build`、`npm run i18n:check`、`git diff --check` 通过。T-004 开始 Debug App 验证。
- 2026-08-25: Debug App 首轮实机验证确认同一 xterm 内加载、滚动、选择和复制；连续第二页暴露 `baseY` 锚定不足，改为 native/live boundary marker 相对锚定并补回归。重新构建、签名和启动精确 Debug bundle 后，聚焦 85/85、全量 321/321、i18n 与 diff check 均通过。T-004 done。
- 2026-08-25: 按“不兼容旧 Session log”要求移除最后一个无人调用的 `read_log_tail` frontend/Tauri IPC；保留显式 legacy-file 清理能力，不自动删除用户磁盘数据。重新全量测试、生产构建并重建 Debug bundle，最终 PID 67647、窗口非白屏。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 聚焦回归 85/85；全量前端 48 files / 321 tests；构建、i18n、diff check 通过；Debug App 精确进程路径与非白屏窗口已核验；真实 xterm 原生历史滚动、选择与 38-byte clipboard copy 已核验。
- Limitations: alternate-screen TUI 保留滚轮输入权，不在全屏 TUI 内触发原生日志分页；切回 normal buffer 并到达顶部后才加载。这是避免破坏应用内滚动/鼠标协议的预期边界。既有磁盘日志文件未执行破坏性删除，但 PTY 历史渲染已不再读取 AgentPort `output.log`。
