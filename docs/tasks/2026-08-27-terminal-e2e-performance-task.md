# Task Plan: Terminal End-to-End Performance Audit

- Created: 2026-08-27
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求继续完成完整终端性能审计，并以真实 Debug App A/B 证明整体变快。

<!-- task-doc-section:background-goal -->
## Background and goal

上一阶段在 Node/jsdom 组件基准中确认 xterm 快照同步序列化会阻塞 renderer 主线程，并把快照回滚从 5000 行缩至 1000 行；组件基准 P50 从 21.47 ms 降至 3.96 ms。当前目标是补齐真实 macOS Tauri/WKWebView 的代表性终端 workload、主要路径审计和可重复 A/B，只有真实 App 用户可见指标与机制指标一致改善时才宣称整体变快。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：`src/src/terminals.ts` 及其测试、必要的只读/临时 benchmark instrumentation、Debug App、受控 Shell Session、真实 WebKit 本地存储和进程资源指标。审计 terminal attach/replay、持续输出、快照、resize/fit、Session 切换/重建、搜索/历史加载的成本边界。

非目标：修改非终端业务、重做 xterm、无证据升级依赖、触碰现有用户 Session Host、把合成 benchmark 冒充生产 field data、为了截图绕过 macOS 权限。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前快照序列化在 renderer 主线程同步执行，原范围为 5000 行，候选为 1000 行。 | `src/src/terminals.ts:1100-1120`；本轮 focused diff。 |
| F-002 | Node/jsdom 4 MiB ANSI workload 下，5000/1000 行完整 serialize+JSON+localStorage 的 P50 分别为 21.47/3.96 ms。 | `/tmp/agentport-xterm-snapshot-bench.mjs`，25 样本复跑。 |
| F-003 | 真实 Debug App 使用 WKWebView，本 checkout 有唯一 Bundle ID 和可读取的 WebKit LocalStorage SQLite。 | `scripts/rebuild-debug-app.sh` 输出；`~/Library/WebKit/com.agentport.desktop.debug.c9d007c8147e/.../localstorage.sqlite3`。 |
| F-004 | 终端已有 pending bytes、parse latency、fit count/duration 内部观测，但尚未外露。 | `src/src/terminals.ts:314-330,904-916,1797-1818`；handoff 记录。 |
| F-005 | 当前环境 ScreenCapture/Accessibility 权限受限；进程路径和可执行状态仍可精确验证。 | `screencapture` 无法创建图像；System Events 返回 -25211。 |
| F-006 | Debug GUI 重启必须用 `ps` 的 `comm` 精确相等，不能匹配 argv 子串。 | `AGENTS.md`；`LEARNS.md` 的 `macOS debug App restart`。 |
| F-007 | attach/replay 由 64 KiB frames 进入异步 xterm parser，已有 parser-boundary drain 与 pending-byte 指标；主要未知是实际 WKWebView drain latency。 | `src/src/terminals.ts:900-975,2070-2235`。 |
| F-008 | fit 会同步 reflow scrollback，但 resize observer 已 90 ms trailing debounce、仅 active renderer 执行且 terminal LRU 为 1；属于受控风险而非已证明瓶颈。 | `src/src/terminals.ts:63-67,1769-1869`。 |
| F-009 | 当前 buffer 搜索由 SearchAddon 在输入时同步扫描 active xterm buffer；持久日志搜索 180 ms debounce 且 request-fenced。真实输入延迟未知。 | `src/src/components/TerminalArea.tsx:386-510`。 |
| F-010 | 原生历史分页会同步序列化 tail、reset 并重建完整 xterm prefix；只在用户触顶分页时运行，成本随已加载历史增长，属于下一优先测量候选。 | `src/src/terminals.ts:1598-1705`。 |
| F-011 | Session 切换因 LRU=1 会释放旧 xterm 并对新 Session 最多 replay 4 MiB；内存有界但切换 latency 需要真实 App 测量。 | `src/src/terminals.ts:55,67`；`src/src/actions.ts` LRU 路径。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 4 MiB ANSI replay、1 秒静默后的快照和大 scrollback 是仓库已有场景中最能放大真实 terminal renderer 停顿的代表性 workload；以 50 ms long-task 阈值和同机 A/B 分布判断用户可见卡顿。
- Assumption: 为测量而创建的 Shell Session 可以在完成后通过正常 CLI stop/archive 流程清理；绝不发送系统信号给既有 Host。
- Open question: ScreenCaptureKit 权限是否会在执行期间恢复；不阻塞性能 A/B，但会限制最终视觉截图证据。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 给出 terminal 六条主要路径的证据化审计结论，区分 measured、supported inference 和 unknown，不把未测候选称为瓶颈。
- 在真实 Debug App/WKWebView 中运行固定 4 MiB ANSI workload，至少采集 baseline/candidate 各 10 个独立样本，记录用户可见主线程停顿与机制指标、平台和构建。
- Candidate 的真实 App P50/P95 主线程快照阻塞均显著降低，效应大于样本噪声；正确性、快照 cursor、历史可达性和资源指标无不可接受回归。
- 运行目标测试、完整前端测试、production build、i18n 和 diff check；按仓库规则重建并仅精确重启 Debug GUI，确认可执行路径，截图若权限允许则确认非白屏。
- 所有临时 instrumentation 和 benchmark 数据不污染产品路径；如需保留 harness，必须是明确、可重复且默认不运行的开发工具。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004。
- Parallel batches: T-001 内部的静态路径审计、真实 App 自动化可行性和 benchmark 合约可并行只读调查；其余任务串行。
- Serialization constraints: `terminals.ts`、Debug App bundle、WebKit LocalStorage 和 Session 状态均为共享可变边界，只由 coordinator 串行修改/运行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 恢复终端性能合约与完整路径审计

- Status: done
- Owner: coordinator
- Objective: 排定 terminal attach/replay、output parsing、snapshot、fit、switch、search/history 的成本假设，并确定真实 WKWebView 测量入口。
- Inputs and prerequisites: F-001 至 F-006；当前 dirty tree 视为用户所有。
- Scope or files: 只读 `src/src/terminals.ts`、TerminalArea、tests、Tauri/CLI harness、WebKit 数据布局。
- Expected output: 有证据的路径矩阵、首要瓶颈和可执行真实 App benchmark 合约。
- Dependencies: None.
- Execution steps:
  1. 审计各路径的算法、同步主线程工作、频率和已有观测。
  2. 验证真实 App 的受控 Session 选择、workload 注入和结果提取方式。
  3. 冻结 A/B workload、样本、指标、正确性和资源不变量。
- Acceptance criteria:
  - 每条路径有 measured/inference/unknown 分类。
  - benchmark 不依赖辅助功能点击，不触碰既有 Host。
- Verification method:
  - 代码引用、最小可行性命令、task document validator。
- Validation evidence: 完成 F-007 至 F-011 路径矩阵；确认真实 App 可通过隔离 CLI Shell Session + 冷启动 remembered Session + probe LocalStorage SQLite 完成 benchmark，不依赖 Accessibility/Screen Recording。`target/debug/agentport-cli --json session new` 已创建隔离 Session `ses_01M11QD0JT688PM7`，其 Host PID 92201；focused renderer 65/65 和 frontend build 验证临时 probe 可编译运行。task document validator 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 建立真实 WKWebView 可重复 benchmark

- Status: done
- Owner: coordinator
- Objective: 在真实 Debug App 中自动选择隔离 Shell Session、注入固定输出、采集 renderer long task/快照/parse/fit/内存结果。
- Inputs and prerequisites: T-001 done。
- Scope or files: 最小开发 harness 或临时 instrumentation；`/tmp` 原始样本；隔离 perf Session。
- Expected output: 同一命令可产生带构建标签的 JSON 样本，默认产品运行无额外成本。
- Dependencies: T-001.
- Execution steps:
  1. 创建隔离项目和 Shell Session，设置为冷启动选中目标。
  2. 在真实 WebKit 记录 workload 时间边界与结果到可外部读取位置。
  3. 验证样本完整、Session 正常停止且无既有 Host 受影响。
- Acceptance criteria:
  - 至少 10 次重复样本；包括用户可见和机制/资源指标。
  - harness 不需要 Screen Recording 或 Accessibility。
- Verification method:
  - 原始 JSON、进程/Host 前后清单、session cleanup 证据。
- Validation evidence: 在打包 Debug App 的真实 WKWebView 中，隔离 Shell Session 的 4 MiB retained ANSI tail 在 469 ms 内完成 transport+parser boundary，buffer 达 10,028 行；同一已解析终端交错执行 12 组 5000/1000 行 snapshot 样本并通过本地 HTTP 逐样本提取。原始数据：`/tmp/agentport-wkwebview-4mib-paired.jsonl`（SHA-256 `97cbd7020a645d80e6c3f4432c8f3d964db574957955b23eee3132b49a886473`）。隔离 Session 已通过 CLI 正常 stop 与 archive，未信号终止任何 Host。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 对首个已证明瓶颈实施最小优化

- Status: done
- Owner: coordinator
- Objective: 仅保留真实 App A/B 支持的终端优化，并补齐回归保护。
- Inputs and prerequisites: T-002 done；现有 1000 行 snapshot candidate。
- Scope or files: `src/src/terminals.ts`、`src/src/terminals-renderer.test.ts`，必要时开发 harness。
- Expected output: 最小 product diff、明确机制和兼容性权衡。
- Dependencies: T-002.
- Execution steps:
  1. 用 baseline 5000 行与 candidate 1000 行交错运行真实 App。
  2. 若预测指标和用户指标一致移动则保留；否则回退并测试下一假设。
  3. 验证 cursor、mouse mode、历史分页和异常恢复不变。
- Acceptance criteria:
  - 真实 App 指标改善超过噪声且无不可接受资源/正确性回归。
  - 不混入无关重构。
- Verification method:
  - A/B 原始样本、focused regression、diff review。
- Validation evidence: 真实 WKWebView 4 MiB workload 下，5000 行 snapshot serialize+JSON 的 P50/P95 为 11/19 ms，1000 行为 2/3 ms，分别降低 81.8%/84.2%；payload 367,106→75,106 chars（-79.5%）。保留的产品 diff 仅将 snapshot scrollback 定为 1000 行并增加回归断言；replay tail 已恢复原 4 MiB，所有 benchmark hook/CSP/强制 Session 选择均已移除。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 全量验证、Debug App 验收与结论

- Status: done
- Owner: coordinator
- Objective: 执行完整前端验证、最终真实 App candidate 复测和诚实结论。
- Inputs and prerequisites: T-003 done。
- Scope or files: 前端测试/build/i18n、Debug bundle、任务文档、原始 benchmark artifact。
- Expected output: 可复现的 before/after、完整审计、最终运行 App 和限制。
- Dependencies: T-003.
- Execution steps:
  1. 运行完整 frontend tests/build/i18n/diff check。
  2. 重建 Debug App，只用 `comm` 精确匹配关闭旧 GUI，保留所有 Host。
  3. 确认路径并尝试截图；更新任务文档和最终结论。
- Acceptance criteria:
  - 所有 required checks 通过；Debug GUI 精确路径运行。
  - 性能结论明确说明 workload、平台、build、样本、P50/P95、资源和限制。
- Verification method:
  - 命令输出、进程清单、PNG（若权限允许）、task validator。
- Validation evidence: focused renderer 67/67、完整 frontend 330/330、`npm run build`、`npm run i18n:check`、`git diff --check` 全部通过。`scripts/rebuild-debug-app.sh` 完成；最终 Debug GUI PID 42732 的 exact `comm` 为工作区 bundle，重启前后 Host PID 清单无差异，CGWindow 显示 1200×800 onscreen layer-0 主窗口。`screencapture` 因系统权限返回 `could not create image from window`，未取得像素级非白屏截图。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

组件层使用真实 xterm 依赖隔离机制成本；App 层使用打包 Debug WKWebView 与隔离 Shell Session，A/B 保持相同代码树、输出、窗口几何、机器和采样边界，仅改变 snapshot scrollback。记录 main-thread long task/快照 duration、输出 parser drain、RSS/CPU 和 snapshot bytes。正确性由既有 renderer snapshot/cursor/mouse/history tests、完整 Vitest、TypeScript/Vite build、i18n 和真实 Session clean stop 保护。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 当前工作树有大量用户改动：仅做小范围 exact edits，不 reset/stash/checkout。
- 重启命令误匹配 Host 会终止用户 Session：只读取 `ps -axo pid=,comm=` 且 `$2 == DEBUG_BIN`，打印单一 GUI PID 后再 kill。
- WebKit 数据库在线 WAL 和 UTF-16 BLOB 编码可能让外部结果提取不稳定：优先只读复制 DB/WAL 或正常关闭 GUI 后读取，不直接修改活跃 DB。
- Debug build 不等于 release field performance：同构 A/B 可证明该 App 内相对改善，不外推绝对生产指标。
- ScreenCapture/Accessibility 权限当前阻塞视觉截图，但不阻塞内部 timing 与进程证据。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-27: 用户授权继续完整终端审计与真实 App 证明；创建 execute authority document。
- 2026-08-27: T-001 开始；确认 WKWebView LocalStorage SQLite 可定位，终端内部已有 parse/fit 指标但未外露。
- 2026-08-27: 三个并行只读 subagent 两次均因 `fetch failed` 无法启动；T-001 转 blocked，等待用户授权 coordinator 串行继续。
- 2026-08-27: 用户授权 coordinator 改为串行执行；T-001 恢复 in_progress。
- 2026-08-27: T-001 done。路径审计确认 snapshot 为已测首要主线程成本；fit/search/native-history/switch 分别列为受控风险或待测候选。隔离 Shell Session 和 inert LocalStorage probe 可行；T-002 开始。
- 2026-08-28: replay first-divergence probe 确认 4 MiB transport+parser boundary 可在真实 WKWebView 469 ms 完成；此前“长期等待”源于 benchmark LocalStorage quota/结果提取失败，而不是 replay 未结束。
- 2026-08-28: T-002/T-003 done。真实 WKWebView 12 组交错 A/B 显示 snapshot task P50 11→2 ms、P95 19→3 ms，payload -79.5%；仅保留 1000 行 snapshot 优化。
- 2026-08-28: T-004 done。临时 instrumentation 清理，完整验证通过，隔离 perf Session 正常 stop/archive，最终 Debug App exact-path 重启；截图受 macOS 权限限制。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed_with_environment_limitation
- Evidence: 真实 Debug App/WKWebView、固定 4 MiB ANSI retained tail、10,028 行 xterm buffer、12 组交错 A/B：5000→1000 行使同步 snapshot serialize+JSON P50 11→2 ms（-81.8%）、P95 19→3 ms（-84.2%），payload 367,106→75,106 chars（-79.5%）。focused 67/67、frontend 330/330、build、i18n、diff check 均通过；最终 exact-path Debug GUI 正在运行且 Host 清单未变化。
- Limitations: LocalStorage 已因现有 origin 数据达到 quota，App benchmark 无法把 storage write 纳入 timed transaction，因此真实 A/B 直接证明的是同步 serialize+JSON 主线程部分；Node/jsdom 组件基准另含 storage 并显示同方向改善。Screen Recording 权限阻止最终截图，CGWindow 仅证明 1200×800 onscreen 主窗口存在，不能提供像素级非白屏证据。结论限定为“代表性终端 snapshot 路径整体更快”，不外推为 AgentPort 每个功能或所有 workload 都变快。
