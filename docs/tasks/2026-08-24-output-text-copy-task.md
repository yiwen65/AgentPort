# Task Plan: 修复输出文本无法复制

- Created: 2026-08-24
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户报告“输出的文本内容无法 copy，请排查修复”。

<!-- task-doc-section:background-goal -->
## Background and goal

修复 AgentPort 输出正文无法通过鼠标选择并复制的问题。以真实渲染路径为边界，保持 live xterm 已有原生剪贴板兼容逻辑，并让结束会话的 agent 原生日志正文具备明确的文本选择能力。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：结束会话 `NativeHistoryPane` 正文的选择/复制契约、目标组件或 CSS 回归测试、Debug App 运行态验收。
- 非目标：改写 xterm 剪贴板协议、增加会话正文副本、重构通用快捷键或修改 agent 原生日志。
- 保留任务前脏工作树与上一任务未提交改动；不关闭 release App 或任何 `agentport-host`。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 全局 `body` 设置 `-webkit-user-select: none` 与 `user-select: none`，只有输入控件、contenteditable 和 `.selectable` 明确恢复文本选择。 | `src/src/styles.css:250-270`。 |
| F-002 | 新的原生历史正文使用无 class 的 `<pre>{event.text}</pre>`，其 `.native-history-event pre` 样式没有恢复 `user-select`。 | `src/src/components/TerminalArea.tsx:491-500`、`src/src/styles.css:2687-2693`。 |
| F-003 | live xterm 已在捕获阶段读取 `term.getSelection()` 并调用共享 `copyText`，其目标测试覆盖 Unicode 选区复制；因此当前首次偏差不在 xterm 原生剪贴板链路。 | `src/src/terminals.ts:1214-1230`、`src/src/terminals-renderer.test.ts:685-705`。 |
| F-004 | 工作区任务开始前已有大量已修改与未跟踪文件。 | 2026-08-24 `git status --short` 基线。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “输出的文本内容”至少包含刚交付的结束会话原生历史正文；该路径存在可静态和运行态判定的确定缺陷。若真实验收显示 live xterm 也失败，再沿其独立事件链扩展修复。
- Open question: 无阻塞问题；Debug App 可分别验收原生历史和 live xterm。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 原生历史事件正文可用鼠标形成选区，并由系统标准复制命令写入剪贴板。
- 不让标题、按钮和其他 UI chrome 意外变为可选择；live xterm 的原生剪贴板兼容路径保持不变。
- 目标回归测试修复前因缺少选择 opt-in 失败，修复后通过。
- 前端相关与全量测试、build、i18n、差异检查通过；Debug App 重建后路径正确、非白屏并完成真实复制验收。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；改动与验证均集中在同一前端输出路径，按因果顺序串行执行。
- Serialization constraints: `TerminalArea.tsx`、`styles.css` 与相关测试已含其他未提交改动，协调者保留现状并仅做聚焦编辑。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固定复制失败基线并验证首次偏差

- Status: done
- Owner: coordinator
- Objective: 用最低稳定层的测试证明原生历史正文没有恢复文本选择，并确认 live xterm 复制路径不受同一缺陷影响。
- Inputs and prerequisites: F-001 至 F-004。
- Scope or files: `TerminalArea.uncommitted.test.tsx` 或聚焦 CSS 契约测试；只读检查 `TerminalArea.tsx`、`styles.css`、`terminals.ts`。
- Expected output: 修复前因正文缺少 `.selectable` 或等价 CSS 选择能力而失败的回归用例。
- Dependencies: None.
- Execution steps:
  1. 添加原生历史正文必须明确 opt-in 文本选择的断言。
  2. 在生产代码未改动时运行目标测试，记录预期失败。
- Acceptance criteria:
  - 失败原因直接对应全局 `user-select: none` 下缺少正文 opt-in，而非 fixture、导入或环境失败。
- Verification method:
  - `cd src && npm test -- --run src/components/TerminalArea.uncommitted.test.tsx`。
- Validation evidence: 修复前目标 Vitest 13 项中仅新增正文选择契约失败，实际 `classList.contains("selectable")` 为 false；其余 12 项通过，证明失败直接对应原生历史正文缺少选择 opt-in。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现最小选择修复并验证剪贴板邻接路径

- Status: done
- Owner: coordinator
- Objective: 仅让原生历史事件正文恢复文本选择，不改变外围 UI 或 xterm 事件处理。
- Inputs and prerequisites: T-001 done。
- Scope or files: `src/src/components/TerminalArea.tsx` 或 `src/src/styles.css`，目标测试。
- Expected output: 正文可选择的最小实现与通过的回归测试。
- Dependencies: T-001.
- Execution steps:
  1. 使用仓库既有 `.selectable` opt-in 约定修复正文。
  2. 运行目标组件测试、xterm renderer 邻接测试和剪贴板 API 测试。
- Acceptance criteria:
  - 原生历史正文可选择；live xterm Unicode 复制和原生 clipboard-manager 优先级不回归。
- Verification method:
  - 目标 Vitest、`terminals-renderer.test.ts`、`clipboard.test.ts`。
- Validation evidence: 在原生历史事件 `<pre>` 上复用既有 `.selectable` opt-in；目标组件 13/13、xterm renderer 59/59、clipboard API 2/2，共 74/74 通过。全局热键检查确认未拦截标准 Cmd/Ctrl+C。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 全量验证与 Debug App 真实复制验收

- Status: done
- Owner: coordinator
- Objective: 在签名 Debug App 中证明文本选区与系统剪贴板结果真实可用。
- Inputs and prerequisites: T-002 done。
- Scope or files: 测试/构建输出与任务文档；不终止任何 Session Host。
- Expected output: 全量前端验证、重建 Debug App、精确进程路径、非白屏与真实复制结果。
- Dependencies: T-002.
- Execution steps:
  1. 运行前端全量测试、build、i18n 与 diff 检查。
  2. 执行仓库标准 Debug App 重建/重启流程。
  3. 用真实原生历史正文形成选区，复制后读取剪贴板确认内容一致。
- Acceptance criteria:
  - 构建与检查通过；真实选区和剪贴板内容一致；Debug GUI 路径正确且非白屏。
- Verification method:
  - Vitest/build/i18n/diff、`scripts/rebuild-debug-app.sh`、Computer Use 与只读剪贴板确认。
- Validation evidence: 前端全量 47 files/305 tests 通过；`npm run build`、`npm run i18n:check` 与 `git diff --check` 通过。`scripts/rebuild-debug-app.sh` 成功，旧 debug GUI PID 20083 被精确关闭且未终止任何 `agentport-host`；新 PID 29622 的路径精确指向工作区 Debug App。Computer Use 中原生历史短文本形成可见高亮选区，Cmd+C 后 `pbpaste` 与预期短文本精确匹配，最终窗口截图非白屏。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

验证顺序：失败回归 -> 最小 opt-in 修复 -> 目标组件/clipboard/xterm 测试 -> 前端全量/build/i18n/diff -> Debug App 真实选择复制。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- JSDOM 不计算真实 WebKit 选择行为；自动测试约束明确的选择契约，最终必须用打包 Debug App 手动验收。
- 复制内容可能包含敏感会话正文；运行态验收选择无敏感的短文本，只比较长度或预先可控文本，不在日志中输出用户会话内容。
- 全工作区已有大量脏改动；不做无关格式化或清理。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-24: 创建 execute 任务文档并完成事实、范围和验收契约；T-001 开始。
- 2026-08-24: T-001 完成。新增回归在修复前得到 `selectable=false`，目标文件其余 12 项通过；首次偏差固定在原生历史正文未恢复全局禁用的文本选择。T-002 开始。
- 2026-08-24: T-002 完成。仅给原生历史正文增加既有 `.selectable` opt-in；目标组件、xterm 复制与原生 clipboard-manager 邻接测试共 74/74 通过。T-003 开始。
- 2026-08-24: T-003 完成。前端 305/305、build、i18n、diff 通过；Debug App 重建并以精确 GUI 路径启动，真实原生历史正文拖选、Cmd+C 和系统剪贴板匹配全部通过。新增可复用项目经验，未修改 xterm 复制路径。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 修复前回归明确失败、最小 opt-in 后通过；邻接剪贴板与 xterm 测试、前端全量、构建和打包 App 真实复制均通过。
- Limitations: 本次缺陷位于结束会话原生历史 DOM；live xterm 复制路径未改动，并由既有 59 项 renderer 测试中的 Unicode 选区复制用例继续保护。
