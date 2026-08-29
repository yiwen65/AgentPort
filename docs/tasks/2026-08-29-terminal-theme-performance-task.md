# Task Plan: 终端主题性能审查与优化

- Created: 2026-08-29
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求“审查并优化本次 commit changes 及相关内容性能问题”

<!-- task-doc-section:background-goal -->
## Background and goal

对 commit `652e3d1 feat(terminal): add curated color themes` 的运行时路径做证据化性能审查。重点工作负载是“全屏设置页打开、后方仍挂载 Mermaid 文档块时连续切换终端主题”，同时测量已有 xterm 的主题更新路径。目标是找到首个可归因的额外成本，实施最小优化，并用相同环境、相同工作负载的 A/B 数据证明组件级工作量收益；若无法取得代表性目标引擎数据，则明确限定证据层级，不伪称产品加速。主题正确性、即时生效、失败回滚、持久化、xterm 内容/滚动状态、文档连续性和视觉范围必须保持。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**Scope**

- 审查 `terminalThemes.ts`、`actions.ts`、`terminals.ts`、`SettingsDialog.tsx`、`MermaidBlock.tsx` 及相关 CSS/测试中由本次主题功能触发的 CPU、同步布局、重绘、对象分配、异步重渲染和资源保留。
- 建立一个活动 xterm、暖机后的终端主题切换基线；同时记录帧边界耗时与标准化工作量（theme/atlas/refresh、font option、fit、native theme IPC 次数）。
- 测量全屏 Settings 覆盖期间非 Flowchart Mermaid block 的隐藏 render fan-out；只优化由调用链与测量共同支持的主导冗余工作，并增加防回归断言。
- 复跑前端完整测试、i18n/build、相关 Rust 合同测试、Debug App 实机视觉检查，并创建独立性能优化 commit。

**Non-goals**

- 不重新设计色板、设置 UI、Session 生命周期、xterm scrollback、Mermaid 语义或全局状态架构。
- 不因静态代码气味做无测量依据的 memoization、缓存、批量 CSS 重写、手工 SIMD/JIT 猜测或依赖升级。
- 不把 Chrome/jsdom 微基准结果冒充 WKWebView 端到端产品收益；跨引擎数据仅作为机制证据。
- 不优化 Rust 设置读写，除非测量显示主题切换等待由该边界主导。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 被审查 commit 为 `652e3d1`，工作区起始 clean；主题功能改动 25 files。 | `git status --short`; `git show --stat 652e3d1` |
| F-002 | 用户可见入口运行在 Tauri WKWebView 的 React/TypeScript 前端；主题切换同步路径由 `SettingsDialog -> applyThemeSettings -> applyXtermTheme/applyTerminalSettings` 驱动。 | `src/src/components/SettingsDialog.tsx:1286-1314`; `src/src/actions.ts:188-227` |
| F-003 | `switchTerminalTheme` 只改变 `terminalTheme`，但当前调用的 `applyThemeSettings()` 还会无条件调用 native `setTheme`、重设已有 xterm 的 font family/font size/screen-reader mode，并执行同步 `fitHandle(..., "settings")`。 | `src/src/components/SettingsDialog.tsx:1286-1314`; `src/src/actions.ts:205-227`; `src/src/terminals.ts:1829-1905,2543-2556` |
| F-004 | `fitHandle` 注释明确说明 fit 会同步 reflow 整个 scrollback；现有终端内存上限为一个活动 renderer，因此成本有界但直接落在主线程交互路径。 | `src/src/terminals.ts:70,1811-1859`; `LEARNS.md` 的 `xterm renderer memory` lesson |
| F-005 | 主题色本身来自模块级不可变目录，palette lookup 为常量键访问；新主题切换必须保留 xterm theme assignment、texture atlas 清理和 refresh 才能立即去除旧 canvas。 | `src/src/terminalThemes.ts`; `src/src/terminals.ts:646-657,2589-2599`; 既有 renderer regression |
| F-006 | 非 flowchart Mermaid 图会在 app 明暗或终端主题变化时重新生成；这是保持 inline SVG 色值同步的既定正确性路径，是否主导成本尚未知。 | `src/src/components/MermaidBlock.tsx:66-110` |
| F-007 | 目标平台为 Apple M5/10 cores、arm64、macOS 26.5.1；Node 24.15.0、Chrome 152、Safari/WebKit 26.5。 | `sw_vers`, `uname -m`, `sysctl`, runtime version commands |
| F-008 | 原功能验证基线为前端 62 files/372 tests、i18n/build 与 Rust 定向合同通过，Debug App 已有深浅视觉证据。 | `docs/tasks/2026-08-29-terminal-theme-switcher-task.md` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 代表性主要工作负载为一个已打开、含大量 scrollback 的活动 xterm；这是当前 `MAX_PERSISTENT_TERMINALS = 1` 的最坏正常 renderer 数量。
- Assumption: 用户未给定数值预算；采用“候选相对基线的效果大于重复样本不确定性，且同步 fit/font/native IPC 等预测资源指标按模型下降”为优化门槛，不为微小噪声提交复杂改动。
- Assumption: 主题选择保存 API 的数据库往返不在乐观即时渲染的同步关键路径内；先测前端首帧，再决定是否跨 Rust 边界。
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 保存原始、多次、暖机后的基线与候选样本，记录 revision、平台、引擎、工作负载、计时边界和局限。
- 首个成本分歧必须由调用链和至少一种运行时测量共同支持；静态候选不得直接称为瓶颈。
- 只提交达到实际收益门槛的优化；若 font/a11y/fit/native IPC 拆分在真实 xterm A/B 中低于噪声，则保留原路径并记录拒绝理由。
- Settings 覆盖期间不为每次主题点击启动隐藏、不可取消的 Mermaid parse/layout；关闭后只为最终 palette 渲染一次。已有 SVG 在覆盖和最终 palette 刷新期间保持，source 变化仍清除旧图；stale resolve/reject 不得提交。
- xterm theme、atlas 清理、refresh、CSS token、持久化与失败回滚语义保持；无 Session 重建、内容清空或滚动位置改变。
- 相同组件工作负载的标准化工作量显著优于基线；分阶段披露 Settings 内与关闭阶段的成本迁移及 DOM 连续性。若端到端 WKWebView 自动测量不可用，结论仅限 Chrome 实际组件机制/工作量证据。
- 受影响定向测试、完整 Vitest、i18n、生产 build、Rust 定向合同、diff check、task validator 和 Debug App 非白屏视觉检查通过。
- 独立 reviewer 无未处理的 correctness/performance 中高风险 finding；仅提交本任务文件并创建 Git commit。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-003 -> T-004 -> T-005 -> T-006`; `T-002 -> T-003`。
- Parallel batches: Batch A 为 T-001（基线/归因，coordinator）与 T-002（独立静态审查，analyst）并行；随后 T-003 至 T-006 串行。
- Serialization constraints: benchmark 临时资产只放 `/tmp/agentport-theme-performance`；生产文件、测试和 authority document 仅由 coordinator 修改；reviewer 只读。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立性能合同、基线与首个成本分歧

- Status: done
- Owner: coordinator
- Objective: 用代表性单 xterm 主题切换取得可复现基线，并把帧延迟与 font/fit/repaint/native IPC 工作量关联。
- Inputs and prerequisites: F-001 至 F-008；工作区 clean；目标和辅助浏览器可用。
- Scope or files: 只读源码；`/tmp/agentport-theme-performance/**` 临时 harness/raw samples；authority document。
- Expected output: 基线原始样本、汇总、不确定性、调用链和排序后的瓶颈假设。
- Dependencies: None.
- Execution steps:
  1. 固定 revision、平台、引擎、一个活动 xterm、scrollback、暖机、样本数和同步/双 RAF 计时边界。
  2. 交错测量当前完整路径与只保留颜色必要工作的模型，并记录每次操作计数。
  3. 尝试 Safari/WebKit 目标引擎；若环境阻塞则保留错误并用 Chrome 仅做补充机制测量。
  4. 用最小定向测试复现 terminal-theme-only 仍触发 font/fit/native IPC 的当前行为。
- Acceptance criteria:
  - 原始样本可重跑；基线与候选模型除目标变量外一致。
  - 至少一个用户可见时间指标和一个标准化机器工作指标有记录。
- Verification method:
  - 临时 browser component harness，多进程/交错 A/B。
  - 定向 Vitest 调用边界断言。
- Validation evidence: 临时 harness 位于 `/tmp/agentport-theme-performance`，未写入 worktree；平台为 Apple M5/macOS 26.5.1/Chrome 152。Safari 26.5 `GET /status` ready，但 WebDriver 创建 Session 返回 HTTP 500：必须在 Safari Settings 开启 `Allow remote automation`，因此未伪称目标 WKWebView/Safari 端到端数据。真实 Canvas xterm（1 handle、0 与 10,000 scrollback lines、24 samples/variant、6 warmups、独立 Chrome 进程、交错 A/B）显示 palette-only 相比当前 full apply 的同步中位数仅改善 0–0.1 ms，next-paint 中位数无一致改善（10k seeds: 23.1→23.0 ms、23.3→23.5 ms），拒绝为此单独拆分 font/fit 路径。相同浏览器下的 hypothesis-only 模型 harness 使用 4 个 3,301-char/80-message sequence diagrams、连续 5 次主题选择，5 个独立进程原始样本为当前路径 `291.8, 293.7, 286.5, 282.9, 293.2 ms`；设置打开期间延迟渲染、关闭后仅渲染最终 palette 的对应成本为 `52.7, 55.2, 52.7, 52.6, 55.1 ms`，中位数 291.8→52.7 ms（组件总工作 -81.9%），每轮 render calls 20→4。该数据仅用于确认首个显著分歧是隐藏 Mermaid fan-out 而非 bounded xterm fit，最终结论由 T-004 的实际组件 A/B 取代。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 独立审查 commit 的性能风险

- Status: done
- Owner: performance-auditor
- Objective: 只读审查主题目录、设置渲染、xterm 更新、CSS 和 Mermaid 路径，区分具体事实、条件性风险与需测量未知项。
- Inputs and prerequisites: F-001 至 F-008；commit `652e3d1`。
- Scope or files: commit diff 及直接调用方；不改文件和 task document。
- Expected output: 按影响/证据排序的 findings，指出可证伪测量和最小干预。
- Dependencies: None.
- Execution steps:
  1. 追踪一次主题点击到 DOM、xterm、React、Mermaid、native 和持久化边界。
  2. 检查重复同步工作、布局/paint 强制、render fan-out、保留对象和规模上界。
  3. 报告证据充分 finding 与应拒绝的微优化。
- Acceptance criteria:
  - 每项 finding 有文件/行号、机制、影响条件和验证方法；不把静态风险称为实测瓶颈。
- Verification method:
  - coordinator 核验报告与源码。
- Validation evidence: subagent run `bd2893d8-2aea-4f7e-be48-438c0642c246` 完成只读审查、无文件改动。报告将 terminal-theme-only 重设 font/a11y + fit 列为条件性 medium，将非 flow Mermaid 每实例重渲染且 stale cleanup 无法取消工作列为条件性 medium；同时确认 xterm repaint fan-out 被 1 handle 上界约束、CSS 变量写入不能静态等同为 16 次 layout、持久化无 write storm，且不建议无测量 memoization。coordinator 对照源码核验；运行时数据否定前一项的实际价值并确认 Mermaid fan-out 为显著成本。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 实施最小的已证实优化

- Status: done
- Owner: coordinator
- Objective: 仅删除主题切换路径中已证明主导的隐藏 Mermaid 工作，并保持最终 palette、失败与文档连续性语义。
- Inputs and prerequisites: T-001、T-002 完成；主导成本和必要不变量已确认。
- Scope or files: `src/src/components/MermaidBlock.tsx` 及定向测试；按证据拒绝无实际收益的 xterm/font/fit/native 拆分。
- Expected output: Settings 可见性 gate、最终 palette 单次刷新与直接回归保护。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 使用稳定 store selector，在不透明 Settings 覆盖期间让已挂载 Mermaid block 不响应每次 terminal theme 更新。
  2. 关闭 Settings 后只使用最终 module-level palette 渲染一次，并在刷新期间保留已有 SVG。
  3. 增加 render 次数、最终 palette、source 变化、pending resolve/reject 与关闭阶段连续性回归。
- Acceptance criteria:
  - 改动直接对应基线模型；无无关 memoization/重构。
  - 所有主题正确性和设置语义测试通过。
- Verification method:
  - 定向 Vitest 与 TypeScript build。
- Validation evidence: `MermaidBlock` 的单一 store selector 在 `dialog.kind === "settings"` 时返回稳定 `null`，使全屏设置页打开期间每次 terminal theme store 更新既不触发隐藏 block React render，也不启动不可取消的 Mermaid parse/layout；关闭后 selector 一次返回最终 module-level palette。对抗性审查发现初版在关闭时 `setSvg(null)` 会暴露 loading 闪烁，现以 `renderedSourceRef` 仅在 palette 刷新时保留上一成功 SVG、成功后原子替换；source 变化仍清空，失败仍回退代码块。8 项 focused Mermaid tests 覆盖 Graphite→Aurora 不增加 render、最终 `#60a5fa`、关闭期间 SVG 连续、source 变化、pending resolve/reject fence。未增加 SVG cache、全局 memoization 或持久对象图。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 执行可比 A/B 与完整回归

- Status: done
- Owner: coordinator
- Objective: 在相同 workload/environment 下比较 baseline commit 与候选，并验证资源和正确性无回归。
- Inputs and prerequisites: T-003 完成；基线 harness/raw samples 可用。
- Scope or files: 临时 benchmark artifacts、测试；仅修复本任务问题。
- Expected output: raw before/after、median/p95/effect size、机制指标及完整验证结果。
- Dependencies: T-003.
- Execution steps:
  1. 独立进程、交错顺序重跑候选，保留全部样本。
  2. 比较帧延迟、fit/font/native/repaint 次数及异常值。
  3. 运行完整前端、i18n/build、Rust 定向和 diff 检查。
- Acceptance criteria:
  - 候选效果超过噪声且预测指标同步改善；否则回退优化。
  - correctness/resource 门禁通过。
- Verification method:
  - benchmark summary；`cd src && npm test && npm run i18n:check && npm run build`；Rust 定向测试；`git diff --check`。
- Validation evidence: 用 `git archive 652e3d1` 提取 baseline，并让同一临时 Vite/React harness 分别加载 baseline 与当前实际 `MermaidBlock`，使用真实 Mermaid 11.16、4 blocks、每图 8 actors/80 messages/3,301 chars、Settings 内 5 次 theme switch。最终 manifest 为 `/tmp/agentport-theme-performance/audit-manifest.json`；有效样本是 seed 21–25 的 10 个唯一 Chrome 152 PID、fresh profile、严格串行、A/B/B/A 交错顺序，raw JSON 为 `raw/actual-audit-{baseline,candidate}-seed{21,22,23,24,25}.json`。旧误并行样本、缺 provenance 的 exploratory seeds 1,6–9，以及关闭时清空 SVG 的旧 candidate seeds 11–15 均由 manifest 明确隔离。最终结果：render calls `20→4`（-80.0%），render promise work median `292.9→87.9 ms`（-69.99%），React Profiler commits `56→16`（-71.43%）；含固定 settle/RAF 的 harness aggregate wall median `466.7→297.6 ms`（-36.23%），但工作从隐藏点击阶段移到一次最终刷新，故 close completion median `33.3→97.4 ms`，不得表述为产品关闭延迟改善。DOM observer 在两边全部样本均记录 close 阶段最少 4 个 SVG、未出现 loading；candidate 最终 4 SVG 且使用 Cupertino palette。最终 `cd src && npm test` 为 62 files/376 tests，`npm run i18n:check`、`npm run build`（2572 modules）、`cargo test -p agentport-core terminal_theme --lib` 3/3、`git diff --check` 全通过；仅有既有 jsdom canvas stderr。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 对抗性审查与 Debug App 验收

- Status: done
- Owner: performance-reviewer + coordinator
- Objective: 独立复核因果、API 语义、测量有效性和视觉正确性，并重建 Debug App。
- Inputs and prerequisites: T-004 完成。
- Scope or files: 本任务 diff、benchmark evidence、Debug bundle；reviewer 只读。
- Expected output: findings 清零/记录；目标 Debug GUI 非白屏且主题即时切换正常。
- Dependencies: T-004.
- Execution steps:
  1. reviewer 对照基线、候选和 diff 尝试证伪结论。
  2. 修复成立 finding 并重跑受影响验证。
  3. 按 AGENTS.md 重建、精确重启并截图检查，不终止 Host。
- Acceptance criteria:
  - 无未处理中高风险 finding；Debug GUI 路径准确、截图正常。
- Verification method:
  - reviewer report；重建脚本；`ps`；窗口截图。
- Validation evidence: 第一轮 provenance 审查要求 raw records 补齐 revision/source/harness/runner SHA、唯一 PID、顺序、fresh profile、warmup 与计时边界，并要求 pending resolve/reject race；这些均已补齐。后续 reviewer run `9e669741-a474-486b-b519-a0c4d5575203` 又发现初版关闭 Settings 时清空 SVG 的中风险闪烁，以及 task document 仍引用 superseded 样本；实现已改为 palette-only 刷新保留旧 SVG，新增 source-change/关闭连续性测试并用 seeds 21–25 重跑实际组件 A/B。`bash scripts/rebuild-debug-app.sh` 在最终源码上通过 frontend/Host/custom-protocol GUI build 与 ad-hoc signing；Bundle ID `com.agentport.desktop.debug.c9d007c8147e`。只精确终止旧 Debug GUI PID `48738`，未终止 Host；新 GUI PID `68529` 的 executable 为 workspace `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`，前后 5 个 Host PID `6452,18395,23863,66233,71647` 不变。CGWindow `4179` 截图 `/tmp/agentport-theme-qa/performance-final-debug-window.png`（SHA-256 `7b1c5be9d39c6c1b2b1e8ba830d8dc4b14d5d024d5ce51b0fedb545b373d5607`）显示 sidebar、终端/文档内容正常且非白屏。最终 reviewer run `b9559569-4ca8-4bb4-9b4d-ba50efe45b08` accepted：关闭闪烁、source/stale/fallback、保留对象与 provenance/claim scope 均复核通过，无剩余中高风险 correctness/performance finding。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 最终记录与提交

- Status: done
- Owner: coordinator
- Objective: 完成 authority document、最终范围检查和任务 commit。
- Inputs and prerequisites: T-005 完成。
- Scope or files: 本任务源码、测试、task document；必要且通过 evidence gate 的 LEARNS 记录。
- Expected output: validator 通过、工作区 clean、单一性能优化 commit。
- Dependencies: T-005.
- Execution steps:
  1. 更新全部任务和最终证据。
  2. 检查 staged diff 与无关改动。
  3. 创建语义化 commit 并复核 Debug GUI。
- Acceptance criteria:
  - commit 只含任务相关改动；所有完成声明有可检查证据。
- Verification method:
  - task validator；`git diff --cached --check`; `git show`; `git status`。
- Validation evidence: task document validator 与 `git diff --check` 通过；staged scope 仅含 `MermaidBlock.tsx`、对应 test 与本 task document，`git diff --cached --check` 通过。`git commit -m "perf(terminal): defer hidden Mermaid theme renders"` 成功创建单一任务 commit；初始 `git show --stat` 确认仅 3 个任务文件，commit 后工作区 clean。本次仅将已完成状态 amend 回同一任务 commit。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. **Correctness oracle**：既有 372 项前端回归、主题目录/设置回滚/runtime pairing/xterm repaint 测试及 Rust Settings contract。
2. **Component timing**：分别测量真实 Canvas xterm 与实际 React/Mermaid block；暖机、交错 A/B、多次独立浏览器进程，并保留分阶段 wall、render promise work 与 DOM 连续性指标。
3. **Normalized work**：xterm 记录 theme/atlas/refresh、font option、fit、native theme IPC；Mermaid 记录 render calls、Profiler commits、最终 SVG/palette 与 close 阶段最少 SVG 数。
4. **Fan-out**：设置卡 6×2 为常量规模；Mermaid fan-out 仅在文档含非 Flowchart block 时存在，单独记录且不与 xterm fit 混算。
5. **Regression**：完整 Vitest、i18n、TypeScript/Vite build、Rust 定向测试、diff/task validator。
6. **Target smoke**：重建签名 Debug App，真实主题切换及 Git/设置 scope 截图，确认非白屏与无视觉回归。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- **引擎代表性**：Chrome 与 WKWebView 的布局/paint 成本不可互换；优先 Safari/WebKit，无法自动化时把 Chrome 限定为机制测量。
- **微基准失真**：不能用虚构 sleep 或 mock fit 声称产品加速；mock 仅用于工作量断言，延迟来自真实浏览器 xterm。
- **JIT/暖机/噪声**：使用暖机、交错顺序、原始样本和多进程；不从单次均值下结论。
- **必要 repaint 被误删**：atlas clear + refresh 有真实旧 canvas 回归证据，除非目标引擎 A/B 和视觉检查证明可删，否则保留。
- **成本迁移**：candidate 把隐藏期间的 20 次 render 缩为关闭后的 4 次最终 render；close completion 在 Chrome harness 中更长。通过保留旧 SVG 保证视觉连续，并明确不声称关闭延迟或 WKWebView 产品延迟改善。
- **GUI/Host 安全**：只精确重启 Debug GUI；不终止 release App 或任何 `agentport-host`。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-29: 用户授权审查并优化 commit `652e3d1` 及相关性能路径。
- 2026-08-29: 载入 browser JavaScript 与 benchmarking 规范；确认目标平台、clean revision、单 renderer 上界和 terminal-theme-only 触发同步 font/fit/native IPC 的调用链。
- 2026-08-29: 创建 execute 模式 authority document；T-001 与 T-002 并行启动。
- 2026-08-29: T-002 独立静态审查完成；提出 xterm font/fit 与隐藏 Mermaid fan-out 两项条件性 medium，未把任何项冒充实测瓶颈。
- 2026-08-29: Safari WebDriver 因系统未启用 Allow remote automation 无法创建 Session；记录 blocker 后改用 Chrome 152 做跨引擎组件机制测量，不作 WKWebView 产品加速声明。
- 2026-08-29: T-001 完成。真实 Canvas xterm A/B 显示去除 font/fit 仅 0–0.1 ms 且 next-paint 无一致收益，拒绝该微优化；5 个独立进程的 Mermaid workload 显示设置覆盖期间 20 次隐藏 render 中位成本 291.8 ms，延迟到关闭仅 4 次/52.7 ms，组件总工作减少 81.9%。T-003 启动最小 visibility gate。
- 2026-08-29: T-003 完成。使用稳定 palette/null selector 在全屏设置覆盖期间冻结 Mermaid block，关闭后只渲染最终 palette；未缓存 SVG、未改 xterm 必要 repaint。focused 10/10 与 Mermaid 5/5 通过。T-004 启动实际组件 A/B 和完整回归。
- 2026-08-29: 一批 baseline/candidate 误以并行进程运行，因 CPU 竞争不满足可比性而整体隔离弃用；随后以 seed 1,6–9、交错 A/B 顺序串行重跑五组独立进程。
- 2026-08-29: 初轮实际组件数据因缺少完整 provenance 被 reviewer 拒绝；补齐 revision/source/harness/runner SHA、PID、fresh profile、顺序、warmup/边界，并新增 pending resolve/reject races 后以 audited seeds 11–15 重跑。
- 2026-08-29: 对抗性 reviewer run `9e669741-a474-486b-b519-a0c4d5575203` 发现 Settings 关闭时清空 SVG 会暴露 loading 闪烁，并指出文档仍引用 superseded 数据。使用成功 source ref 保留 palette-only 刷新期间的 SVG，source 变化仍清空；新增连续性/source-change tests。
- 2026-08-29: 最终实际组件 A/B 以 audited seeds 21–25 严格串行重跑。render calls 20→4，render work median -69.99%，Profiler commits -71.43%；含固定等待的 aggregate wall -36.23%，但 close completion 33.3→97.4 ms，明确记录成本迁移而不声称产品关闭延迟改善。两边 close 期间最少 4 SVG、无 loading。
- 2026-08-29: 完整前端 376/376、i18n、production build、Rust 3/3 与 diff check 通过。最终 Debug App 重建/签名成功；精确重启到 PID 68529，5 个 Host 未变，CGWindow 4179 截图正常非白屏。
- 2026-08-29: 最终 reviewer run `b9559569-4ca8-4bb4-9b4d-ba50efe45b08` accepted；先前关闭闪烁与 provenance finding 已解决，无剩余中高风险 correctness/performance finding。T-006 开始最终范围检查与提交。
- 2026-08-29: task validator、staged diff/scope/check 通过；`perf(terminal): defer hidden Mermaid theme renders` 任务 commit 创建成功，初始 `git show --stat` 仅含 3 个任务文件且提交后工作区 clean。T-006 完成。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-006 全部完成；最终源码完整前端 62 files/376 tests、i18n、production build（2572 modules）、Rust terminal-theme 3/3、diff/task checks、独立 reviewer accepted、Debug App 重建/精确重启/非白屏截图及单一任务 commit 均通过。
- Limitations: Safari/WebKit 26.5 因未启用 Allow remote automation 无法创建 WebDriver Session；性能数字仅证明 Chrome 152 实际 React/Mermaid 组件工作量和 harness 阶段边界，不是 WKWebView 产品端到端或 Settings 关闭延迟结论。
