# Task Plan: 修复原生历史按需回载与工具展开刷屏

- Created: 2026-08-24
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户报告“往上滚动查看历史日志被截断，应按需加载；expanded tools 会触发重绘刷屏”，并明确要求诊断修复。

<!-- task-doc-section:background-goal -->
## Background and goal

修复 AgentPort 原生日志阅读器的两个回归：历史应从最新内容开始，用户滚动到顶部时按游标继续读取更早事件且视口不跳；工具事件的展开/收起不能导致整页反复重绘或一次性渲染无界内容。保持“正文只从 agent 原生日志按需读取，不在 AgentPort 中另存”的既有边界。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：`agentport-core` 原生 JSONL 分页契约、Tauri 命令既有透传、React 历史阅读器与其样式/回归测试。
- 范围：如证据证明 live xterm 路径是刷屏原因，仅修改该条最早因果点及对应测试。
- 非目标：恢复 `output.log`、正文数据库/FTS、无限扩大 xterm scrollback、删除用户已有日志、重构无关终端/侧栏代码。
- 非目标：改变 agent 原生日志格式或 agent 自身的工具展开快捷键语义。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 结束会话当前首次请求 `getNativeHistory(id, null, 200)`，后续仅由底部“加载更多”按钮触发并把结果追加到列表尾部；没有顶部滚动触发器或视口锚定。 | `src/src/components/TerminalArea.tsx:360-447` 与 `src/src/components/TerminalArea.uncommitted.test.tsx:158-205`。 |
| F-002 | Core 分页的空游标从第一个 source 的 byte 0 开始向 EOF 顺序读取，因此第一页是最旧事件而非最新事件。 | `crates/agentport-core/src/history.rs:154-245`。 |
| F-003 | live PTY 仍使用 xterm，内存 scrollback 固定为 10,000 行；结束会话才切换到 `NativeHistoryPane`。 | `src/src/terminals.ts:632-635` 与 `src/src/components/TerminalArea.tsx:900-929`。 |
| F-004 | 历史事件正文当前全部直接渲染为 `<pre>`，没有工具正文的折叠边界、按需挂载或渲染隔离。 | `src/src/components/TerminalArea.tsx:428-437`。 |
| F-005 | 工作区在本任务开始前已有大量已修改/未跟踪文件，其中包含本次要接续的原生日志实现；不得清理或覆盖无关变更。 | 2026-08-24 `git status --short` 基线。 |
| F-006 | 现场 Pi PTY 会话“刷屏移动”的原生日志约 9.9 MB；旧 raw PTY run 中最大文件约 402 MB，含 285 次 clear/home 全屏重绘且未进入 alternate screen。 | 对 `ses_01M0PWB9TAFATWNK` 只读统计：文件字节数与 ANSI `CSI 2J`、`CSI H`、`CSI ?1049h` 计数。 |
| F-007 | Host 实际会覆盖子进程为 `TERM=xterm-256color`、`COLORTERM=truecolor` 并移除 `NO_COLOR`，因此 HostConfig 中继承值不是首次偏差；Pi 当前命令未传 `--tui-mode fullscreen`，而已安装 Pi 明确支持该选项且 regular 是默认值。 | `crates/agentport-host/src/main.rs:580-611`、`crates/agentport-core/src/adapters/pi.rs:14-183` 与本机 `pi --help`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 用户所说的“历史日志”指当前 agent 原生日志阅读体验；影响是分页应采用 tail-first/向前游标，而不是扩大内存缓冲。通过 Core 与 UI 失败测试验证。
- Assumption: 已被现场证据收敛为事实：expanded-tools 刷屏发生在 Pi regular/inline TUI 的 raw PTY 重绘路径，而不是 React 原生历史事件卡；T-003 在 adapter 最早启动点强制受支持的 PTY 会话使用 fullscreen。
- Open question: 无阻塞问题；可从当前代码、原生日志结构和可执行测试判定具体触发链。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 首屏只读取有界数量的最新标准化事件，绝不扫描/返回全部正文。
- 滚动到历史列表顶部自动请求前一页；加载完成后用户正在阅读的首个可见事件保持原屏幕位置，直到无更早游标。
- 并发/重复顶部触发不会重复页、乱序或覆盖新 Session 的响应。
- Pi PTY 新建与恢复均使用 native `--tui-mode fullscreen`，工具展开的全屏重绘留在 alternate screen，不再把每帧推入普通 scrollback；不影响 JSON-RPC 或 Shell。
- 不创建 `output.log`、正文缓存 DB 或 FTS；导出/搜索仍能遍历完整原生日志。
- 目标单元/组件测试、前端全量测试、构建、i18n、Rust 相关测试和差异检查通过；Debug App 重建、精确进程路径和非白屏截图验证通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004。
- Parallel batches: 无；诊断先确定统一游标契约，随后 Core 与 UI 依赖同一方向语义。
- Serialization constraints: `history.rs`、`TerminalArea.tsx` 与同一测试文件均处于脏工作树且前后任务共享，协调者串行执行并保留现有改动。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立失败基线并证明首次偏差

- Status: done
- Owner: coordinator
- Objective: 用最小失败测试证明分页方向/顶部触发缺失，并把 expanded-tools 刷屏定位到原生历史 DOM 或 live xterm 的最早错误状态。
- Inputs and prerequisites: F-001 至 F-005；当前 Debug App/原生日志元数据；现有 Vitest 与 Rust 单测设施。
- Scope or files: 只读检查 `history.rs`、`TerminalArea.tsx`、`terminals.ts`、相关测试；新增回归测试允许写入目标测试文件。
- Expected output: 修复前因预期原因失败的 Core/UI 回归用例，以及排除主要替代假设的因果记录。
- Dependencies: None.
- Execution steps:
  1. 检查真实原生日志事件类型与大小元数据，不输出会话正文。
  2. 为 tail-first 游标与顶部滚动锚定写失败测试。
  3. 用 React render/DOM 身份计数或 xterm 重放测试判定工具展开的重绘边界。
- Acceptance criteria:
  - 失败用例能区分“当前从文件头正向分页/按钮追加”与“从尾部向前按需加载”。
  - expanded-tools 的触发点有可复现 oracle，且至少一个主要替代解释被证据排除。
- Verification method:
  - `cargo test -p agentport-core history --lib -- --test-threads=1` 中新增测试修复前失败。
  - `cd src && npm test -- --run src/components/TerminalArea.uncommitted.test.tsx` 中新增测试修复前失败。
- Validation evidence: 修复前 Core 新增逆向分页测试失败，实际得到 `oldest` 而期望 `latest`；Pi 两个 launch/resume 测试均因缺少 `--tui-mode fullscreen` 失败；目标 Vitest 12 项中新增顶部滚动测试失败且仅发生首次空游标请求。现场旧 raw run 最大约 402 MB/285 次 clear+home/0 次 alternate-screen，Host 覆盖终端能力变量，证明主要替代假设不成立。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现 tail-first 原生历史游标

- Status: done
- Owner: coordinator
- Objective: 让空游标返回最新一页，并让 next cursor 严格指向更早内容，同时保持多 source、截断检测、行大小上限、搜索和导出完整性。
- Inputs and prerequisites: T-001 done。
- Scope or files: `crates/agentport-core/src/history.rs` 及其单元测试；必要时只调整前端 `HistoryPage` 类型字段。
- Expected output: 有界逆向分页契约与覆盖单/多 source、空文件、损坏/超大行、文件变化的测试。
- Dependencies: T-001.
- Execution steps:
  1. 选择不复制正文的逆向 JSONL 分页算法与不透明游标字段。
  2. 实现并保持每行分配上限与 canonical source 校验。
  3. 让 search/export 按时间正序输出完整事件，不回归既有语义。
- Acceptance criteria:
  - 第一页为最新事件，后续页向更早推进且页内事件保持时间正序。
  - 每次读取/返回有界；没有正文持久化。
- Verification method:
  - Core `history` 目标测试与完整 Core lib 测试。
- Validation evidence: `cargo test -p agentport-core history::tests:: --lib -- --test-threads=1` 8/8 通过；覆盖首屏 latest、向旧页推进、无尾换行、多 source、损坏/超大行正反向边界、搜索与导出正序。逆向扫描复用固定 64 KiB scratch，单行正文仍受 8 MiB 上限约束。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 实现顶部自动回载与 Pi fullscreen 重绘隔离

- Status: done
- Owner: coordinator
- Objective: 将 UI 改为从最新页开始、到顶自动 prepend 并锚定视口；让 Pi PTY 在 agent 原生支持点使用 fullscreen/alternate screen，隔离 expanded-tools 全屏重绘。
- Inputs and prerequisites: T-002 done；T-001 的 Pi regular TUI 重绘根因。
- Scope or files: `src/src/components/TerminalArea.tsx`、必要样式/locale、目标组件测试、`crates/agentport-core/src/adapters/pi.rs` 及测试；不修改 Shell 或 JSON-RPC 传输。
- Expected output: 可观测的按需回载、稳定滚动位置、Pi fullscreen launch/resume 契约与回归测试。
- Dependencies: T-002.
- Execution steps:
  1. 用 scrollTop/scrollHeight 锚定实现顶部阈值加载和请求去重/Session 世代防护。
  2. 在 Pi PTY launch/resume 的能力检查与 managed argv 中加入 `--tui-mode fullscreen`；JSON-RPC 保持不变。
  3. 补充加载/无更多状态与中英文文案（如需要）。
- Acceptance criteria:
  - 顶部加载发生一次且 prepend 后锚点稳定；无游标时不再请求。
  - Pi PTY 工具展开由 alternate screen 原位重绘，不再累计 inline redraw scrollback；不支持 `tui-mode` 的旧 Pi 明确阻止 PTY 启动而不是静默退化。
- Verification method:
  - 目标 Vitest 组件测试、前端全量 Vitest、build、i18n check。
- Validation evidence: `npm test -- --run src/components/TerminalArea.uncommitted.test.tsx` 13/13 通过，覆盖顶部双触发去重、prepend 顺序、300px 高度差锚定和 Session 切换时丢弃旧响应；`cargo test -p agentport-core pi_ --lib -- --test-threads=1` 8/8 通过，覆盖 PTY launch/resume fullscreen、旧版本阻止、JSON-RPC 不注入及 managed `--tui-mode` 不可覆盖。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 系统验证与 Debug App 验收

- Status: done
- Owner: coordinator
- Objective: 验证依赖链、资源边界和打包 App 中的真实滚动/展开行为。
- Inputs and prerequisites: T-003 done。
- Scope or files: 测试/构建输出、任务文档；不改发布 App，不终止任何 `agentport-host`。
- Expected output: 全量验证结果、重建签名的工作区 Debug App、精确进程路径与非白屏/交互截图证据。
- Dependencies: T-003.
- Execution steps:
  1. 运行 Rust/前端/差异验证并审查本任务 diff。
  2. 执行 `bash scripts/rebuild-debug-app.sh`。
  3. 只关闭精确 debug GUI，`open -n` 后核验可执行路径并截图测试历史回载与工具展开。
- Acceptance criteria:
  - 计划内检查通过或对无法运行项给出精确限制。
  - Debug App 路径正确、渲染非空白，交互不出现刷屏/位置跳变。
- Verification method:
  - 任务中列出的命令与 Computer Use 截图检查。
- Validation evidence: Core lib 289/289（另 6 ignored）、Host 29/29、Tauri 43/43、CLI integration 4/4、前端 305/305 全部通过；`npm run build`、`npm run i18n:check`、目标 rustfmt 与 `git diff --check` 通过。`scripts/rebuild-debug-app.sh` 成功生成并签名唯一 Bundle ID `com.agentport.desktop.debug.c9d007c8147e`；PID 20083 的可执行路径精确指向工作区 Debug App，窗口截图非白屏。真实结束会话中原生历史面板显示“不另存正文”，点击顶部“加载更早记录”后更早时间戳事件被前插。未终止任何 `agentport-host`。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

验证顺序：新增失败测试 -> 最小修复 -> 目标测试 -> 相邻测试 -> 全量 Core/Host/Tauri/CLI/前端 -> build/i18n/diff -> Debug App 真实交互。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 逆向读取 JSONL 容易在换行边界或多 source 交界丢失/重复；用小页、多页、无结尾换行和 source 切换测试约束。
- 原生日志在请求间继续增长或被轮转；游标必须绑定 source 身份/已观察边界，冲突应显式失败而非静默错序。
- prepend DOM 会自然改变 `scrollHeight`；必须在 layout 阶段用高度差恢复锚点，不能用延迟滚到底覆盖用户手势。
- 工具结果可能包含敏感/超大文本；测试只使用合成内容，真实检查只读类型与长度元数据。
- 全工作区格式检查可能受任务前脏改动影响；仅报告真实结果，不格式化无关文件。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-24: 创建 execute 任务文档；记录用户授权与脏工作树边界。
- 2026-08-24: T-001 开始。静态证据确认 Core 当前从 byte 0 正向分页，UI 仅底部按钮追加，live xterm 仍限 10,000 行，历史事件正文全部 eager `<pre>`。
- 2026-08-24: T-001 完成。失败测试复现分页方向和顶部触发；现场 raw/native 体积与 ANSI 计数把 expanded-tools 根因定位为 Pi 默认 regular/inline TUI。Host 已正确覆盖终端能力变量，排除环境继承假设。T-002 开始。
- 2026-08-24: T-002 完成。Core 改为 tail-first 逆向有界分页；search/export 保持独立正向流式遍历，目标 history 测试 8/8 通过。T-003 开始。
- 2026-08-24: T-003 完成。历史 UI 顶部自动 prepend 并以 scrollHeight 差锚定；同步请求锁和世代号阻止重复/过期响应。Pi PTY launch/resume 强制 fullscreen，旧版本明确阻止，JSON-RPC 不变。目标 UI 13/13、Pi 8/8 通过。T-004 开始。
- 2026-08-24: T-004 完成。Core/Host/Tauri/CLI/前端全量回归与 build、i18n、格式/差异检查通过；Debug App 重建后精确路径、非白屏与原生历史向前回载均完成运行态验收。既有 live Pi Host 未被中断；fullscreen 对新建或后续恢复的 Pi PTY 生效。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 目标红绿测试及全量回归均通过；工作区 Debug App 已重建并验证非白屏，原生历史真实交互能从最新页按需加载更早事件且不创建 AgentPort 正文副本。
- Limitations: 为避免中断用户正在运行的 Session，没有重启既有 Pi Host；`--tui-mode fullscreen` 将在新建或恢复 Pi PTY 时生效。运行态工具展开防刷屏由适配器 argv/能力回归测试与旧现场 ANSI 计数共同验证。
