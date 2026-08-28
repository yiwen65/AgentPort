# Task Plan: 修复运行中 Session 原生历史按需回载

- Created: 2026-08-25
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户现场报告“当前 session 被截断，往上滑滚也没有加载更多历史日志”，并要求诊断修复。

<!-- task-doc-section:background-goal -->
## Background and goal

修复运行中 PTY Session 的历史边界：实时终端继续由 xterm 展示并保持有界内存；当用户已经滚到 xterm 最早保留行并继续向上滚时，自动进入按需读取 agent 原生日志的历史阅读层，可继续向前分页，并能明确返回实时终端。正文不得在 AgentPort 中另行保存。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：live PTY 顶部边界检测、原生历史阅读层的 live 模式、分页/切换回归测试、必要的样式与中英文文案。
- 非目标：扩大 xterm 10,000 行上限、恢复 `output.log`、把结构化原生事件写回 xterm、修改 JSON-RPC Session 或 agent 日志格式。
- 不触碰用户既有脏工作树中的无关改动，不中断任何 `agentport-host`。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前 `NativeHistoryPane` 只在 Session ended 时渲染；live PTY 固定走 `TerminalPane`，其 xterm scrollback 为 10,000 行且顶部没有调用 `getNativeHistory`。 | `src/src/components/TerminalArea.tsx` 的 `sessionEnded` 分支与 `src/src/terminals.ts` 的 xterm 配置/`onScroll`。 |
| F-002 | 现场 Session `ses_01M0VBM8JKBZPY19` 的 xterm/Host 已累计约 5.9 MB 输出，而对应 Pi 原生日志仍存在（约 1.43 MB、85 条 JSONL）；当前缺的是 live UI 到原生分页 API 的桥接。 | 2026-08-25 对 Host attach 元数据与 Session `pi/*.jsonl` 的只读统计。 |
| F-003 | 既有 Core/Tauri/API 已支持 tail-first `getNativeHistory(sessionId, cursor, 200)`；结束会话阅读器已有顶部去重、prepend 和视口锚定。 | `crates/agentport-core/src/history.rs`、`src/src/api.ts`、`src/src/components/TerminalArea.tsx`。 |
| F-004 | 现场 Host 已使用 Pi `--tui-mode fullscreen`，因此本缺陷不是此前 expanded-tools 的 regular TUI 启动参数回归。 | 现场 `host.json.command`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: xterm 原始 ANSI 回滚与 agent 结构化历史不能安全拼接；到达有界终端顶部后应显式切换到原生历史阅读层，而不是伪造连续的终端字节流。
- Open question: 无阻塞问题；交互通过“顶部继续向上滚自动进入历史、按钮返回实时终端”明确两个数据所有者。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- live PTY 位于 normal buffer 最早保留行时，继续向上滚只触发一次原生历史模式；未到顶部、向下滚、alternate buffer 均不触发。
- 原生历史首屏 tail-first，有游标时滚到顶部继续加载并保持视口锚定；并发请求与 Session 切换不重复/污染。
- live 历史层提供清晰的“返回实时终端”，不停止 Host、不丢失实时 xterm、返回后可继续交互。
- 不创建正文副本、不扩大 xterm scrollback；目标测试、前端全量测试、build、i18n、diff 检查通过。
- 按仓库规则重建并只重启精确 Debug GUI，核验进程路径与非白屏，并完成现场滚动验收。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；边界事件、React 模式和验收共享同一交互契约，串行更可控。
- Serialization constraints: `TerminalArea.tsx`、其测试、样式/locale 已有用户或前序任务改动；仅做局部补丁并保留现状。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固化 live 顶部缺口的失败回归

- Status: done
- Owner: coordinator
- Objective: 用组件测试证明 live PTY 到顶继续上滚没有进入原生历史，并锁定不应触发的边界。
- Inputs and prerequisites: F-001 至 F-004。
- Scope or files: `src/src/components/TerminalArea.uncommitted.test.tsx`，只读检查终端组件/API。
- Expected output: 修复前因原生历史未出现而失败的测试，以及未到顶/alternate 不触发的负例。
- Dependencies: None.
- Execution steps:
  1. 构造 live xterm normal buffer 的 `viewportY=0/baseY>0`。
  2. 在 pane 上发送向上 wheel，断言出现 live 原生历史并调用既有分页 API。
  3. 增加返回实时终端与非边界负例。
- Acceptance criteria:
  - 失败原因精确指向 live 分支没有历史入口，而非 Core/API 缺失。
- Verification method:
  - `cd src && npm test -- --run src/components/TerminalArea.uncommitted.test.tsx`。
- Validation evidence: 修复前目标用例稳定失败：live normal buffer `viewportY=0` 上滑后 `getNativeHistory` 仍为 0 次，DOM 中没有原生历史；失败同时暴露的测试 fixture `onScroll` 缺口已独立修正，产品断言仍按预期为红。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现 live 原生历史边界层

- Status: done
- Owner: coordinator
- Objective: 在不拼接 ANSI/结构化正文的前提下，让顶部继续上滚进入可分页历史层，并可返回仍在运行的终端。
- Inputs and prerequisites: T-001。
- Scope or files: `src/src/components/TerminalArea.tsx`、`src/src/styles.css`、session locale 及目标测试。
- Expected output: 最小 live history 状态、顶部 wheel 判定、复用的分页面板和返回入口。
- Dependencies: T-001.
- Execution steps:
  1. 给活动 `TerminalPane` 增加 normal-buffer 顶部向上 wheel 边界判定。
  2. 复用 `NativeHistoryPane` 的有界分页，在 `term-stack` 上层显示 live 模式，不卸载 xterm。
  3. live 模式隐藏破坏性 Restart，显示“返回实时终端”，Session 切换自动退出旧历史层。
- Acceptance criteria:
  - 满足总体 acceptance criteria，且终端 Host/handle 不被 detach。
- Verification method:
  - 目标组件测试、`npm run i18n:check`、`npm run build`。
- Validation evidence: 目标组件测试 16/16 通过，覆盖 normal-buffer 顶部进入、返回实时终端、未到顶部不触发、alternate-screen 不截获；`npm run build` 与 `npm run i18n:check` 通过。live 历史作为 `term-stack` 覆盖层渲染，底层 xterm 未卸载。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 全量回归与 Debug App 现场验收

- Status: done
- Owner: coordinator
- Objective: 验证交互、资源边界与打包 Debug App 的真实行为。
- Inputs and prerequisites: T-002。
- Scope or files: 验证输出与任务文档；不关闭 release App 或任何 Host。
- Expected output: 全量测试证据、精确 Debug GUI 进程路径、非白屏及 live 向前历史截图。
- Dependencies: T-002.
- Execution steps:
  1. 运行前端全量测试/build/i18n 与差异检查。
  2. 按 `scripts/rebuild-debug-app.sh` 重建，仅重启精确 debug GUI。
  3. 在现场 Session 滚到 xterm 顶部继续上滑，确认原生历史出现、可继续分页和返回实时终端。
- Acceptance criteria:
  - 所有可执行检查通过，真实交互不影响 Host 存活。
- Verification method:
  - 测试命令、`ps` 精确路径、Computer Use 截图。
- Validation evidence: 前端全量 48 files/318 tests 通过；build、i18n、`git diff --check` 通过。`scripts/rebuild-debug-app.sh` 成功并签名 Bundle ID `com.agentport.desktop.debug.c9d007c8147e`；精确 Debug GUI PID 45264 路径正确。现场 live Session 在顶部继续上滑后显示 1 个原生来源及更早事件，点击“返回实时终端”回到 100% tail 且输入区仍可用；Host PID 5053 全程存活。截图 `/tmp/agentport-live-native-history-fix/{native-history,live-terminal}.png` SHA-256 分别为 `711ca2d7d787bee67ad85cb4ce2ae1711877459e2b4f752165df4d11c4171752`、`4578ca1a0c58729a2849cc470b77419ee1f06b650942cfdd35c74111e84f7b64`。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 修复 live 历史整页跳转回归

- Status: done
- Owner: coordinator
- Objective: 将用户否决的整页历史切换改为保持终端画面的连续滚动桥。
- Inputs and prerequisites: 用户 2026-08-25 现场截图；T-003 的 live 覆盖层实现。
- Scope or files: `TerminalArea.tsx`、目标测试、live history 局部样式/文案；结束会话历史面板保持不变。
- Expected output: 首次越过顶部不改变当前画面，继续上滚才从上方显露原生历史；向下回到底部自动退出桥接。
- Dependencies: T-003.
- Execution steps:
  1. 增加红测，禁止 live 模式渲染独立 header/export/大按钮页面，并要求一个与终端等高的透明 spacer。
  2. 将原生事件放在 spacer 上方，初始锚定 spacer 底部；保持 xterm 挂载和可见。
  3. 在桥接底部向下滚时自动退出，进入历史后只保留轻量返回控件。
- Acceptance criteria:
  - 触发边界的那一帧不发生视觉页面切换；惯性上滚以连续滚动方式显露历史。
  - live 模式不显示 ended-history 的标题栏、导出按钮或独立页面背景。
  - 返回 live、分页锚定、alternate-screen/Shell 排除均不回归。
- Verification method:
  - 目标组件/CSS 回归、前端全量/build/i18n、Debug App 现场滚动截图。
- Validation evidence: 新回归修复前因缺少 `.native-history-live-spacer` 失败，修复后目标 16/16、前端全量 48 files/318 tests、build、i18n、`git diff --check` 全部通过。打包 Debug App 现场显示扁平 inline 历史，无 Header/Export 整页；轻量返回后回到 live 100% tail。GUI PID 61300 路径正确，Host PID 5053 全程存活。截图 `/tmp/agentport-live-history-bridge-fix/{inline-history,live-terminal}.png` SHA-256 分别为 `1a6f7f7f90522953cf2322239ed76cc93977ae5f53c4951f68e4c320a0917b93`、`8493fc92511aba1a213b8acf8fa6f67019ee3d919400eda1fdf3432c24b5941a`。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

目标失败测试 -> 最小修复 -> 目标测试 -> 前端全量/build/i18n -> diff 检查 -> Debug App 重建与现场交互。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- xterm 顶部 wheel 在输入交给 TUI 时可能有应用自有语义；只在 normal buffer 且确已到最旧行时接管，alternate buffer 不接管。
- 原生日志可能在 live 期间增长；首屏每次进入重新 tail-first 读取，旧页游标继续由 Core 的 source 边界校验保护。
- 阅读历史时 live xterm 仍接收并解析输出；返回后需 fit/刷新但不得重连或停止 Host。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-25: 建立 execute 计划。现场证据确认 live xterm 的有界回滚与原生 Pi JSONL 同时存在，缺口是 live renderer 没有进入原生历史的边界；T-001 开始。
- 2026-08-25: T-001 红测确认 live 顶部没有原生历史入口；T-002 复用现有 tail-first 阅读器为覆盖层，只在 supported-agent normal buffer 顶部继续上滑时进入，alternate screen/Shell 不接管。目标 16/16、build、i18n 通过；T-003 开始。
- 2026-08-25: T-003 完成。前端 318/318、build、i18n 与差异检查通过；重建后精确 Debug App 完成非白屏、live 原生历史进入/返回验收，现场 Host 未中断。项目经验合并了一条 live PTY renderer 边界教训。
- 2026-08-25: 用户现场否决整页切换交互：顶部上滚会异常跳到带 Header/Export/Return 的原生历史页。重新打开任务并启动 T-004，以透明 spacer 保持终端画面、从上方连续显露历史。
- 2026-08-25: T-004 完成。live 层改为原生事件 + viewport-height 透明 spacer；初始锚定底部保留 xterm 画面，上滚连续显露扁平历史，下滚到底或轻量按钮退出。全量回归与打包 App 现场验收通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 两轮红绿回归分别覆盖 live 数据入口与整页跳转；最终前端 318/318、build、i18n、差异检查和打包 Debug App 连续滚动/返回现场验收均通过。
- Limitations: alternate-screen TUI 的 wheel 仍完全归 agent 所有，必须先回到 normal buffer 才会触发 AgentPort 的历史边界；这是避免破坏 TUI 交互的设计边界。
