# Task Plan: 修复 fullscreen Session 滚动与选择回归

- Created: 2026-08-24
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户报告上一轮修改后 Session 无法滚动和选中内容，并提供当前 Pi fullscreen Session 截图。

<!-- task-doc-section:background-goal -->
## Background and goal

修复 AgentPort 强制 Pi fullscreen 后引入的交互回归：运行中的 Session 必须可用鼠标滚动历史、拖选并复制文本，同时不能恢复 regular/inline 模式的 expanded-tools 重绘刷屏和巨大 PTY scrollback。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：Pi fullscreen 启动契约、xterm 与 fullscreen TUI 的鼠标/滚动/选择事件边界、目标回归测试和 Debug App 真实验收。
- 非目标：修改用户的 easy-pi/Pi 源码或配置、恢复 AgentPort 正文日志副本、删除已有会话、重构无关终端渲染逻辑。
- 保留任务前脏工作树；不关闭 release App 或任何 `agentport-host`。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 截图中的 Pi Session 显示 fullscreen transcript 百分比指示器；该行为由上一任务注入 `--tui-mode fullscreen` 后出现。 | 用户截图；`crates/agentport-core/src/adapters/pi.rs:94-187`。 |
| F-002 | 当前受影响 Session `/` 的实际 Host argv 以 `--tui-mode fullscreen` 启动，并处于 running/idle。 | `host.json` 的最小字段与 `agentport-cli session list`；Session `ses_01M0S65N2Z0JKTF2`。 |
| F-003 | 当前 Host ring tail 包含 alternate-screen、all-motion、button-motion 与 SGR mouse 启用序列，证明 Pi 请求由应用接管鼠标。 | 只读 `session read` 结果：`alt_enter=true`、`mouse_all=true`、`mouse_button=true`、`mouse_sgr=true`。 |
| F-004 | Pi fullscreen 本身实现应用内 `ScrollView`、wheel 路由、鼠标拖选与松开后复制；regular 模式不具备同一隔离边界。 | `/Users/w/Projects/easy-pi/pi/packages/tui/src/tui-alt-screen.ts:144-160,255-290,561-690,960-1093`（只读上游证据）。 |
| F-005 | xterm 的 custom scrollbar 当前读取 `term.buffer.active.baseY`；alternate screen 不具有普通 scrollback，既有经验也明确不在 alternate buffer 恢复普通 viewport。 | `src/src/components/TerminalArea.tsx:69-240`、项目经验与当前截图。 |
| F-006 | 工作区在任务开始前已有大量修改/未跟踪文件，其中包括上一轮实现。 | 2026-08-24 `git status --short` 基线。
| F-007 | Debug App 中 wheel 后百分比仍为 2% 且屏幕逐像素不变；拖拽后没有高亮，两个用户症状均已复现。 | Computer Use 对 Session `/` 的滚轮前后与拖拽后截图。
| F-008 | xterm 的 SerializeAddon 会保存 mouse tracking (`?1003h`)，但不会保存 SGR mouse encoding (`?1006h`)；独立实验证实序列化结果 `has1003=true, has1006=false`。 | 当前依赖 `@xterm/addon-serialize/src/SerializeAddon.ts:481-534` 与 Node 最小实验。
| F-009 | AgentPort 从终端快照的 log cursor 续读 Host；因此恢复画面后跳过旧的 `?1006h`，xterm 以默认编码发送鼠标，而仍处于 SGR 模式的 Pi 无法解析，wheel 与 drag/release 同时失效。 | `src/src/terminals.ts:760-767,940-1021,1685-1755`；修复前两个目标 Vitest 均失败。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: fullscreen 仍是阻止 inline redraw 累积的正确隔离层；修复应让 xterm 把用户鼠标意图可靠交给 Pi 的应用内 viewport/selection，而不是把 alternate screen 冒充普通 scrollback。
- Confirmed: 首次偏差是快照只恢复 tracking、遗漏 SGR encoding；输入队列没有过滤或重排鼠标数据，custom scrollbar 也不是 fullscreen 应用内 viewport 的所有者。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 运行中的 Pi fullscreen Session 使用鼠标滚轮后 transcript 百分比/可见内容发生预期变化，且可回到底部。
- 鼠标拖选产生可见高亮，复制后系统剪贴板与所选无敏感短文本一致。
- expanded-tools 仍留在 alternate screen 原位重绘，不回归 normal scrollback 爆炸；Pi launch/resume 仍保持 fullscreen。
- 非 Pi、JSON-RPC 与结束会话原生历史不受影响。
- 目标红绿测试、前端/Core 邻接测试、全量前端、build、i18n、diff 与 Debug App 真实交互通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；必须先确定鼠标输入首次偏差，随后修复和真实 App 验收依赖同一终端交互状态。
- Serialization constraints: `terminals.ts`、`TerminalArea.tsx`、Pi adapter 与测试均含其他未提交改动，协调者串行保留现状并只改因果路径。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 复现并定位 fullscreen 输入首次偏差

- Status: done
- Owner: coordinator
- Objective: 在真实 Debug App 和最低稳定测试层确定 wheel/drag 从 WebView 到 Pi `TuiAltScreen` 的首次丢失点，排除普通 scrollback 与原生历史路径。
- Inputs and prerequisites: F-001 至 F-006；受影响的 idle Pi Session。
- Scope or files: 只读检查 `TerminalArea.tsx`、`terminals.ts`、xterm API、Pi fullscreen 源码与 Host ring；新增目标失败测试允许写入现有终端测试。
- Expected output: 可重复的滚动/选择失败 oracle、首次偏差证据与修复前失败回归。
- Dependencies: None.
- Execution steps:
  1. 在 Debug App 对同一 fullscreen Session 记录滚轮前后屏幕/百分比与拖选高亮。
  2. 检查 xterm 输入/鼠标处理器和 Pi 期望的 SGR mouse 序列。
  3. 在 AgentPort 最低稳定边界增加修复前失败测试。
- Acceptance criteria:
  - 失败测试能区分“普通 xterm viewport 滚动”与“把事件交给 fullscreen TUI”，并直接对应用户症状。
- Verification method:
  - 目标 Vitest/适配器测试与 Computer Use 前后截图或剪贴板 oracle。
- Validation evidence: Debug App 坏基线已复现；`npm test -- --run src/terminals-renderer.test.ts` 在修复前产生 2 个直接相关失败：无法恢复 SGR 编码、快照未记录 SGR 编码。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 修复 fullscreen 滚动与选择事件路径

- Status: done
- Owner: coordinator
- Objective: 在已证明的首次偏差处恢复 Pi 应用内滚动/拖选/复制，同时维持 fullscreen 重绘隔离。
- Inputs and prerequisites: T-001 done。
- Scope or files: 由 T-001 证据限定的 AgentPort 前端终端事件层及目标测试；必要时 Pi adapter 参数契约。
- Expected output: 最小生产修复和通过的滚动、选择、复制、fullscreen 回归。
- Dependencies: T-001.
- Execution steps:
  1. 修复事件所有权/转发，不创建第二份 transcript 状态。
  2. 验证 normal buffer、alternate buffer、其他 agent 与原生历史邻接行为。
- Acceptance criteria:
  - wheel/drag 到达 fullscreen TUI；Pi fullscreen 契约和 native JSONL 历史边界保持。
- Verification method:
  - 目标 Vitest、Pi adapter/Core 测试、clipboard 与 terminal renderer 邻接测试。
- Validation evidence: 目标 renderer 测试 61/61；前端全量 307/307；TypeScript/Vite build、i18n、`git diff --check` 通过；Pi adapter 目标测试 5/5，仍保持 `--tui-mode fullscreen`。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 全量验证与 Debug App 运行态验收

- Status: done
- Owner: coordinator
- Objective: 在打包 Debug App 中证明滚动、拖选、复制和 expanded-tools 稳定性。
- Inputs and prerequisites: T-002 done。
- Scope or files: 测试/构建输出、任务文档；不终止任何 Session Host。
- Expected output: 全量验证、重建签名 App、精确 GUI 路径和真实交互证据。
- Dependencies: T-002.
- Execution steps:
  1. 运行前端/Core 相关与全量检查。
  2. 执行标准 Debug App 重建，只重启精确 debug GUI。
  3. 对 fullscreen Session 验收滚轮、拖选、复制与 expanded tool 展开。
- Acceptance criteria:
  - 计划检查通过；真实 fullscreen 交互满足全部用户契约；窗口非白屏。
- Verification method:
  - 测试/build/i18n/diff、`scripts/rebuild-debug-app.sh`、Computer Use 和只读运行态指标。
- Validation evidence: 标准脚本重建并签名 Debug App；GUI PID 55889 的可执行路径精确匹配工作区 debug bundle，三个既有 Host PID 31549/35102/43623 均保持存活。窗口截图非白屏；同一 Session wheel 前后画面不同且历史上移；drag 出现可见高亮与 `Copied!`，系统剪贴板发生变化并已恢复；输入框验收后为空。Core 串行全量通过（289 passed、6 ignored），一次并行全量中的无关 Git fixture 失败已单测与串行全量复验通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

验证顺序：真实坏基线 -> 最低稳定红测 -> 最小修复 -> 目标/邻接测试 -> 全量前端与 Core -> build/i18n/diff -> Debug App wheel/selection/copy/expanded-tools 验收。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- fullscreen 的历史属于 Pi 应用内 ScrollView，不是 xterm normal scrollback；错误地操作 `buffer.active.baseY` 会继续无效或造成状态竞争。
- 鼠标协议同时承担滚动、选择、链接与右键；修复必须保持事件所有权一致，不能只补 wheel 丢掉 drag/release。
- 运行态会话包含用户内容；验收只选取无敏感短文本并比较匹配结果，不输出正文。
- 不能为验证而重启用户正在运行的 Host；必要时只重启 GUI 并复用现有 Session。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-24: 创建 execute 任务文档；记录用户回归、截图、真实 Host argv/mouse capability 与上游 fullscreen ScrollView 证据；T-001 开始。
- 2026-08-24: T-001 完成。真实坏基线与 Node/Vitest 最小实验共同定位为 xterm SerializeAddon 遗漏 `?1006h`，而 AgentPort 又从快照 cursor 续读，造成 Host/Pi 与 xterm 的鼠标编码状态分裂；T-002 开始。
- 2026-08-24: T-002 完成。快照 v2 显式跟踪并恢复 SGR/SGR-pixels mouse encoding，所有 reset 路径同步清空；目标与全量前端、build、i18n、diff、Pi adapter 测试通过；T-003 开始。
- 2026-08-24: T-003 完成。Debug App PID 55889 精确启动且非白屏，原 Session Host 未重启；真实 wheel/drag/copy 通过，clipboard 已恢复，输入框清空。记录 `xterm terminal snapshots` 项目教训并完成最终检查。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: renderer 61/61，frontend 307/307，Core 289/295 passed + 6 ignored，Pi adapter 5/5；build、i18n、diff check；签名 Debug App 的真实 wheel/selection/copy 截图与精确进程路径。
- Limitations: 运行态复制以可见选区、Pi `Copied!` 与系统剪贴板变化为 oracle，未在交付文本中暴露 Session 正文；expanded-tools 的隔离由仍处于 alternate/fullscreen 的运行态与 adapter 回归覆盖，没有导出用户会话正文作二次统计。
