# Task Plan: 终端渲染与滚动四阶段重构

- Created: 2026-08-23
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求基于当前机制分析和 Web 调研结论，制定并执行四阶段终端渲染、回放与滚动重构；当前焦点仍是消除历史输出高频刷屏至尾部。

<!-- task-doc-section:background-goal -->
## Background and goal

当前 Host 最多回放 4 MiB 日志并按 64 KiB frame 投递；前端收到 `replay_done` 时会立即隐藏加载层，但 xterm write 是异步 parser queue，传输完成不等于解析完成。与此同时，write drain、尾部修复、恢复定位和 snapshot 分别使用空 write sentinel，viewport 又由 terminal manager、React 滚动条、搜索和 fit 多处直接修改。目标是以四个串行阶段修正回放可见边界、统一 write drain、集中 viewport authority，并减少隐藏 pane 的无效刷新；所有改动保持原始 PTY 字节、cursor 去重、用户滚动优先和 Session LRU 行为。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Scope: `src/src/terminals.ts`、`src/src/components/TerminalArea.tsx`、相关 store/types/api、terminal 单元/组件测试；必要时调整 Host/Tauri 回放流控协议和对应 Rust 测试。
- Scope: 四阶段分别为回放完成边界与观测、write/drain coordinator、viewport controller、active/hidden geometry 与基于证据的背压决策。
- Non-goals: 替换 xterm、重做终端视觉、把 terminal buffer/输出文本放进 React Store、无证据地升级 xterm、修改非终端业务或清理当前大量无关未提交改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Host replay 上限 4 MiB，按 64 KiB frame 构造。 | `crates/agentport-host/src/server.rs:30,509,586`；`src-tauri/src/main.rs:1712`。 |
| F-002 | xterm `write()` 异步解析，callback 仅保证 parser 已处理；`onWriteParsed` 即使触发仍可能有 pending writes。 | 本地 `@xterm/xterm` 5.5.0 typings `src/node_modules/@xterm/xterm/typings/xterm.d.ts:936-944,1213-1216`；xterm 官方 API。 |
| F-003 | 当前 `replay_done` 收到后立即设置 runtime `replayDone=true`，Skeleton 仅检查该字段。 | `src/src/terminals.ts:1697-1706`；`src/src/components/TerminalArea.tsx:707`。 |
| F-004 | 当前有四类独立 parser barrier：tail repair、recovery marker、snapshot、rendered cursor。 | `src/src/terminals.ts:608,655,734,1548`。 |
| F-005 | viewport 修改入口分散于 write/fit/session 激活、搜索、自定义滚动条、快捷键和 recovery marker。 | `src/src/terminals.ts:557-623,640-668,1236-1354,1384-1394`；`src/src/components/TerminalArea.tsx:82-246,379-486`。 |
| F-006 | 最多三个 PTY pane 保持挂载；隐藏 pane 使用 `visibility:hidden`，仍保留 ResizeObserver 和 scrollbar 订阅。 | `src/src/terminals.ts:59,1063`；`src/src/actions.ts:274-299`；`src/src/components/TerminalArea.tsx:811`；`src/src/styles.css:3287-3293`。 |
| F-007 | 当前工作树含大量既有未提交变更，终端文件也已修改。 | 2026-08-23 `git status --short`：65 个 dirty/untracked 条目。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: Tauri Channel 对同一 attachment 的 replay frames 与 `replay_done` 保序；通过在处理 `replay_done` 时登记 parser boundary，可准确界定 replay，而不吞入随后 live frame。验证方式：fake terminal write 顺序测试和现有 Host replay 测试。
- Assumption: parser-drained 足以作为隐藏 Skeleton 的最低完成语义；严格 OS composited paint 不可直接观测，若真实 WKWebView 仍闪烁，再增加 active-pane `onRender`/RAF 可见门槛。
- Assumption: 协议级背压只在 queued-byte/parse-latency 证据显示需要时实施；否则 T-004 以记录决策阈值和完成 active/hidden 刷新优化为通过。
- Open question: None；以上均可通过测试和运行指标在授权范围内判定。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 收到 `replay_done` 后，加载层保持到 replay boundary 之前的 xterm writes 全部 parser-drained；后续 live write 不阻塞该边界。
- 历史 replay 不出现逐 frame 的中间 tail repair；一个 burst 至多一次最终修复，用户滚动可取消旧修复。
- write 顺序、cursor 去重、recovery marker、snapshot cursor 一致性和 rendered cursor ACK 保持或增强，并由统一 coordinator 管理 drain 任务。
- 所有用户 viewport 命令通过单一 controller；用户 intent epoch 优先于旧 write/fit callback，DOM workaround 仅存在于一个 adapter 边界。
- hidden pane 不因窗口尺寸变化执行昂贵 fit 或高频 React scrollbar 同步；激活后完成一次最新 geometry fit/refresh。
- 增加 queued bytes、parse latency/replay drain、fit 原因/耗时等最小诊断数据或测试可观察量；按阈值明确记录是否需要协议背压。
- terminal 定向测试、全量前端测试、前端 build、相关 Rust 测试（若 Rust 改动）、`git diff --check` 和 Debug App rebuild/restart/nonblank screenshot 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004。
- Parallel batches: 无；四阶段共享 `terminals.ts` 及同一异步状态协议，必须串行。
- Serialization constraints: coordinator 独占任务文档；保留当前所有无关未提交变更；禁止全文件格式化和基于 HEAD 覆盖工作树；每阶段通过定向验证后才能进入下一阶段。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 回放传输、解析与可见边界

- Status: done
- Owner: coordinator
- Objective: 将 transport `replay_done` 与 parser-drained 完成分离，并建立可测试的 replay phase/观测。
- Inputs and prerequisites: F-001 至 F-003；现有 `queueRenderedLogObservation()` parser barrier。
- Scope or files: `src/src/terminals.ts`、`src/src/components/TerminalArea.tsx`、store/types（仅必要字段）、terminal 测试。
- Expected output: transport-done 和 parsed-done 双阶段；Skeleton 依赖 parsed-done；queued bytes/parse latency 的最小内部观测。
- Dependencies: None.
- Execution steps:
  1. 添加 replay frames 已接收但 callbacks 未 drain 时 Skeleton 不消失的失败回归。
  2. 添加 replay boundary 后 live frame 不延迟 replay parsed 完成的顺序回归。
  3. 实现 generation-fenced replay parser boundary 和最小队列指标。
  4. 运行阶段定向测试并检查无额外滚动修复。
- Acceptance criteria:
  - 两条边界回归修复前因过早完成而失败、修复后通过。
  - stale generation/reconnect 不得提交旧 replay 完成。
- Verification method:
  - `vitest` terminal renderer/TerminalArea 定向测试；TypeScript build。
- Validation evidence: parser-boundary 回归修复前在 `replay_done` 后立即得到 `true`，修复后仅在目标 empty-write callback 后完成，且不等待随后 live write；stale generation 回归通过。Overlay 回归修复前 attached-but-not-parsed 时无 Skeleton，修复后保持到 parsed boundary。terminal 定向 59/59、全量前端 46 files/288 tests、`npm run build`、`git diff --check`、debug rebuild 均通过；Debug PID 10198 路径正确，截图 `/tmp/agentport-replay-boundary-fix/debug-app.png` SHA-256 `66ecc5778ae9a09050f1be0907e289596c1bec9e9dd0644a30a05105da08ba09` 非白屏。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 统一 write/drain coordinator

- Status: done
- Owner: coordinator
- Objective: 将 parser sequence 和 drain task 调度集中，减少散落 sentinel 及重复 generation 校验。
- Inputs and prerequisites: T-001 done；F-004。
- Scope or files: `src/src/terminals.ts`、`src/src/terminals-renderer.test.ts`。
- Expected output: 单一 write/drain coordinator API，承载 replay boundary、rendered cursor、snapshot、tail repair；recovery marker 保持精确插入顺序。
- Dependencies: T-001.
- Execution steps:
  1. 为现有四种 barrier 建立顺序契约测试。
  2. 引入最小 coordinator，不改变 PTY bytes/cursor 语义。
  3. 逐项迁移并删除被替代的独立 sentinel 状态。
  4. 验证 burst 合并和 marker 定位。
- Acceptance criteria:
  - 每个 drain task 在目标 sequence 后且至多执行一次。
  - snapshot/ACK 不得越过对应 cursor；recovery marker 位置不变。
- Verification method:
  - terminal renderer 定向测试、原始字节测试、recovery/ACK/snapshot 测试。
- Validation evidence: 新增 `TerminalWriteCoordinator`，所有 xterm write 与 replay/rendered-cursor/snapshot/tail-repair/recovery drain 均通过统一 API 排序并按 generation fence；新增 rendered-cursor 至多一次/后续 cursor 独立 boundary 与 snapshot cursor 一致性回归。`cd src && npm test -- --run src/terminals-renderer.test.ts src/components/TerminalArea.uncommitted.test.tsx` 通过 61/61；`cd src && npm run build` 通过；相关 `git diff --check` 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集中 viewport authority

- Status: done
- Owner: coordinator
- Objective: 用 controller 统一用户和 renderer viewport 命令，保留明确 follow/reading/locating 状态与 intent epoch。
- Inputs and prerequisites: T-002 done；F-005；现有 viewport regression。
- Scope or files: `src/src/terminals.ts`、`src/src/components/TerminalArea.tsx`、相关组件/renderer 测试。
- Expected output: `ViewportController`/等价最小模块；React/search/快捷键不再直接分散修改 term viewport；私有 DOM 同步隔离。
- Dependencies: T-002.
- Execution steps:
  1. 固化所有 scroll authority 和 alternate-buffer/fit/recovery 边界测试。
  2. 引入 controller 命令和 user intent epoch。
  3. 迁移 scrollbar、search、latest、write、fit、recovery 调用。
  4. 删除重复直接访问并运行邻近测试。
- Acceptance criteria:
  - 用户 wheel/drag/search/keyboard/latest 在并发 write/fit 下拥有确定优先级。
  - follow-tail、reading anchor、locating marker 和 alternate buffer 行为保持。
  - `.xterm-viewport` 只在一个 adapter/controller 边界访问。
- Verification method:
  - terminal renderer + TerminalArea 测试；搜索/自定义滚动条/Session 激活回归。
- Validation evidence: 新增单一 `TerminalViewportController`，集中 wheel/drag/keyboard/latest/search/write/fit/recovery 命令与 follow/reading/locating、intent revision；`.xterm-viewport` 私有 DOM 同步仅保留在 controller。新增 controller 路由、keyboard authority、recovery 被后续 wheel 取消回归；阶段定向 63/63、前端 build、相关 diff check 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Active/hidden 刷新优化与背压决策

- Status: done
- Owner: coordinator
- Objective: 避免 hidden pane 的无效 fit/UI 同步，并根据 queue 指标决定是否实施协议级 replay 背压。
- Inputs and prerequisites: T-003 done；F-006；T-001 指标。
- Scope or files: `src/src/terminals.ts`、`src/src/components/TerminalArea.tsx`、`src/src/actions.ts`（如需 active 通知）、测试；仅在阈值触发时涉及 `src-tauri/src/main.rs`、Host protocol/server 及 Rust 测试。
- Expected output: hidden geometry dirty/activate fit；active-only scrollbar subscription；带证据的背压实施或不实施决策。
- Dependencies: T-003.
- Execution steps:
  1. 添加 hidden resize 不 fit、激活只 fit 一次的回归。
  2. 停止 hidden pane 的 React scrollbar 高频订阅，同时保留 xterm output 解析。
  3. 用 4 MiB/64-frame 测试或运行指标评估 pending bytes/parse latency。
  4. 若超过 500 KiB pending 或交互延迟阈值，实现 bounded replay window/ACK；否则记录不增加协议复杂度的证据。
  5. 运行全量集成、构建和 Debug App 验证。
- Acceptance criteria:
  - hidden pane resize fit 次数为 0，激活后为 1；active pane 行为不回归。
  - 背压决策有可重复证据和明确阈值，不能仅凭推测。
  - 所有总体 acceptance criteria 通过。
- Verification method:
  - 前端定向/全量测试、build、必要 Rust tests、diff check、debug rebuild/restart/screenshot。
- Validation evidence: hidden pane 的 ResizeObserver 仅标记 geometry dirty，不执行 fit；激活后单次 fit/refresh，并记录 fit count/reason/duration；hidden `TerminalScrollbar` 不订阅 `onScroll`/`onWriteParsed`。4 MiB/64×64 KiB frame 的逐 frame drain 回归测得 peak pending 64 KiB，低于 500 KiB 阈值，因此未增加协议 ACK/window。定向 66/66、全量前端 46 files/295 tests、`npm run build`、`git diff --check`、Debug App rebuild 均通过；最终精确 Debug GUI PID 98728，截图 `/tmp/agentport-terminal-refactor-final/debug-app.png` 为 2624×1824、SHA-256 `1d57e485ae01668f156de4459d0b6b201f26289f8a9c66304ab8dd921fe8e069`，人工检查为正常渲染且非白屏。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

每阶段先添加能在旧行为上失败的最小回归，再实施代码；依次运行阶段定向测试。T-004 后运行 terminal 全套、完整前端 `npm test -- --run`、`npm run build`、`git diff --check`；若修改 Rust，运行最小对应 package tests。最后按 `AGENTS.md` 执行 `scripts/rebuild-debug-app.sh`，只重启工作区 Debug GUI，确认精确进程路径并截图非白屏。真实性能结论需记录输入大小、frame 数、pending bytes、parser drain 时间和 fit 次数。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 风险：把 `onWriteParsed` 当作完整 drain；官方语义明确允许 pending writes，必须使用目标 sequence/parser callback。
- 风险：统一 coordinator 时破坏 ANSI raw-byte 顺序、cursor ACK 或 marker 插入点；必须先固化测试。
- 风险：viewport state machine 过度抽象；只引入当前已证明的 follow/reading/locating 和 intent epoch，不新增策略配置。
- 风险：协议背压跨 Host/Tauri/WebView，错误阈值会停流；没有指标触发时不实施。
- 风险：工作树已有大量用户改动；任何阶段不得还原、覆盖或格式化无关内容。
- Blockers: None.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: 创建 execute 文档并完成四阶段分解；T-001 设为 in_progress，由 coordinator 串行执行。
- 2026-08-23: 记录工作树 65 个 dirty/untracked 条目；决定不使用隔离 writer worktree，避免丢失当前终端改动基线。
- 2026-08-23: T-001 红测证明 transport `replay_done` 过早；实现 generation-fenced parser boundary、pending output 指标和 attached-but-parsing Skeleton 门槛。
- 2026-08-23: T-001 定向 59/59、全量 288/288、build、diff、debug rebuild、精确 PID 和非白屏截图通过，标记 done。
- 2026-08-23: 活跃 Global Contract 仍只确认历史刷屏缺陷；T-002 至 T-004 属未确认范围扩展，按要求标记 blocked，未继续修改。
- 2026-08-23: 用户明确要求“完成剩余task”，范围阻塞已解除；T-002 转为 in_progress，由 coordinator 串行执行。
- 2026-08-23: T-002 实现统一 write/drain coordinator；新增 ordering 回归，定向 61/61、前端 build、相关 diff check 通过，标记 done。T-003 转为 in_progress。
- 2026-08-23: T-003 集中 viewport controller、intent fence 与 DOM adapter；定向 63/63、前端 build、相关 diff check 通过，标记 done。T-004 转为 in_progress。
- 2026-08-23: T-004 完成 hidden-fit/active-scrollbar 优化、fit 诊断与 4 MiB/64-frame 压力回归；peak pending 64 KiB，未触发 500 KiB 协议背压阈值。定向 66/66、全量 295/295、build、diff check、debug rebuild、精确 PID/window 验证通过。
- 2026-08-23: 当前环境截图被 macOS TCC 拒绝（ScreenCaptureKit -3801；Accessibility 亦拒绝），T-004 从 in_progress 转为 blocked；产品实现和其余验证均完成，待授权后只需补截图。
- 2026-08-23: 用户选择授予 Screen Recording 后立即重试；`screencapture` 仍无法创建图像，ScreenCaptureKit 仍返回 -3801。进程树确认 Pi 由 PID 67793 的 `agentport-host` 承载，权限需重启该负责进程后生效；按仓库规则未终止 Host。
- 2026-08-23: Debug GUI 随权限变更重新启动为精确 PID 98728；window-ID 截图成功，2624×1824 图像经人工检查非白屏。T-004 标记 done，四阶段全部完成。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-004 全部完成；定向 66/66、全量 46 files/295 tests、TypeScript/Vite build、`git diff --check`、Debug rebuild、精确 PID 98728 与当前构建非白屏截图均通过；任务文档最终 validator 通过。
- Limitations: 4 MiB 压力结论来自可重复的逐 frame drain 单元回归，不是真实 WKWebView frame-by-frame profile；因未超过 500 KiB 阈值，本阶段未增加协议级背压。
