# Task Plan: 活跃侧栏扩展性能优化

- Created: 2026-09-01
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户明确要求“执行优化性能，scope：本次提交相关代码”；目标功能提交为 `814be41 feat: add active agent session sidebar`。

<!-- task-doc-section:background-goal -->
## Background and goal

对 `814be41` 新增的全局活跃 Agent Session 视图做有测量依据的性能优化。降低多 Project/Session 下高频 store/runtime 更新的主线程开销和无效 repository status 探测，同时保持过滤、排序、来源、suspended 与 Host liveness 语义不变。Rust 路径仅在测量证明有主导成本时修改。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**Scope**

- `814be41` 新增的 active sidebar/store/action 路径及直接测试。
- `814be41` 新增的 Rust Host liveness/monitor 路径只读复核，证据支持时才改。
- baseline 固定在 `814be41` detached worktree；临时 harness/raw samples 位于 `/private/tmp/agentport-perf`。
- 相同 workload 做多进程 A/B、正确性、build、Debug App 和 commit 验证。

**Non-goals**

- 不优化 terminal renderer、Session warm-switch、Git Center 或普通 Project tree。
- 不触碰/提交当前并发任务和用户文件：`LEARNS.md`、`src/src/terminals.ts`、`src/src/terminals-renderer.test.ts`、`docs/tasks/2026-09-01-active-agent-session-performance-task.md`、`src/src/terminal-session-switch.test.ts`、`src/src/terminalAttachVisibility.ts`。
- 不把静态气味、单次计时或 jsdom 绝对值声称为 field/WebKit 性能提升。
- 不引入虚拟列表、worker、宽泛缓存或架构重写，除非测量证明必要。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 功能 baseline 是 `814be41`；执行开始时 HEAD 已被并发 terminal 工作推进到 `678db36`，其修改不涉及 active sidebar，但工作区有多处任务外改动/新文件。 | `git log -3 --oneline`、`git status --short`。 |
| F-002 | active view 的 suspended selector 在每次 store emit 对全量 runtime 执行 `Object.entries/filter/map/sort/join`；primitive 只避免 React commit，不能避免扫描和分配。 | `src/src/components/Sidebar.tsx:1062-1069`、`src/src/store.ts:501-505,598-616`。 |
| F-003 | active view mount/focus 对所有 Project 调用 `refreshRepositoryStatus`，包含没有活跃 Agent 的 Project。 | `src/src/components/Sidebar.tsx:1070-1090`。 |
| F-004 | active filter/map/sort 在每次组件 render 重建；组件订阅全量 `repositoryStatuses`，每个 probe 结果都可触发该路径。 | `src/src/components/Sidebar.tsx:1092-1148`。 |
| F-005 | Session row 已使用标量 bitmask selector 和 reference cache；不是本次第一成本分歧。 | `src/src/components/Sidebar.tsx:650-711`。 |
| F-006 | Rust liveness reconciliation 仅连接失败/EOF 触发，cap 后每 2 秒一次；健康 frame loop不运行。 | `src-tauri/src/main.rs:1664-1890`。 |
| F-007 | 平台 Apple M5、macOS 26.5.1、Node 24.15.0；external Vitest/jsdom harness 可加载 detached production source。 | 环境命令与 `/private/tmp/agentport-perf` smoke/baseline。 |
| F-008 | 2,000-entry baseline 中 500 次无关 emit median 76.500 ms，而无 subscriber control 为 0.040 ms；300 Project/30 active mount 每次发 300 probes。 | `/private/tmp/agentport-perf/baseline-exploratory.json`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 扩展 workload 是多 Project/Session 下打开/刷新 active view 与 `logBytes` 等高频 runtime patch；synthetic scale只用于同代码 A/B，不外推绝对 field 延迟。
- Assumption: repository branch 只需为实际显示的活跃 Agent 所属 Project 刷新；通过多 Project 动态测试验证。
- Assumption: 用户未给数值预算；候选必须同时移动 component latency 和预测机器成本，效果大于重复样本噪声，否则撤销。
- Open question: None；真实 field 分布未提供，作为最终限制。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- benchmark 记录 revision、平台、规模、warm-up、重复次数、raw samples；baseline/candidate 多进程交错 A/B。
- 高频无关 runtime/store patch 不再全量创建 suspended entries/filter/map/sort 临时集合；suspended 变化仍即时重排。
- repository status refresh 仅覆盖活跃、非 Shell、未归档 Agent 所属 Project；focus/visibility 与 branch fallback 不变。
- active filter/project-map/sort 不因单个 repository status 更新重复执行；repository 更新只重算轻量 source labels，memoized rows 保持稳定。
- 相同 2,000-entry workload 的 component latency 与 300/30 workload 的 probe count 显著下降且无 correctness/resource regression。
- Rust 健康/断线路径语义不回归；无主导成本证据时不改 Rust。
- targeted/full frontend、build、i18n、相关 Rust、diff/format 通过；Debug App 正常；commit 只含本任务。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004`。
- Parallel batches: A/B 需同环境串行交错；当前有并发 terminal writer，active sidebar paths 与 Git index 由 coordinator 独占并串行维护。
- Serialization constraints: 不 reset/stash/checkout 主工作区；不编辑并发任务文件；benchmark 使用 detached `/private/tmp` worktree。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立 baseline 并定位成本分歧

- Status: done
- Owner: coordinator
- Objective: 量化 active view store update、runtime patch、mount 与 repository probe 成本，定位第一分歧。
- Inputs and prerequisites: F-001 至 F-007。
- Scope or files: production source read-only；`/private/tmp/agentport-perf/*`；本任务文档。
- Expected output: raw baseline、成本模型与可证伪候选。
- Dependencies: None.
- Execution steps:
  1. 固定 synthetic data、warm-up 和 repeated samples。
  2. 分离 bare store、active subscription、runtime patch、mount/probe。
  3. 复核 Rust 调用频率。
- Acceptance criteria:
  - baseline 可重复；候选有预测 metric 与反证条件。
- Verification method:
  - external Vitest/jsdom component harness。
- Validation evidence: `AGENTPORT_TARGET=/private/tmp/agentport-perf/baseline AGENTPORT_REVISION=814be41 PERF_LABEL=baseline-exploratory ./node_modules/.bin/vitest run --root /private/tmp/agentport-perf --config /private/tmp/agentport-perf/vitest.config.ts --reporter=verbose` passed。Apple M5/Node 24.15；2,000 entries、10 active、warm-up 200：15×500 unrelated emits median 76.500 ms（75.926–79.248），bare control 0.040 ms；15×100 runtime patches median 33.848 ms（33.620–34.602）。300 Projects/30 active 的 12 mounts median 17.668 ms（14.665–27.157），每次 300 probes。源码斜率与全量 suspended selector 一致；预测候选应让 aggregate suspension lookup 对无关 emit O(1)，并把 probes 降至 30。Rust 路径不在健康 render workload，无改动证据。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实施并 A/B 验证最小前端优化

- Status: done
- Owner: coordinator
- Objective: 增量维护 suspended ID 集合、memoize active entries/rows，并把 branch status refresh 缩到实际活跃 Project。
- Inputs and prerequisites: T-001 evidence。
- Scope or files: `src/src/store.ts`、`src/src/components/Sidebar.tsx`、`src/src/store-performance.test.tsx`、`src/src/sidebar-active-agents.test.tsx`。
- Expected output: 最小生产改动、资源调用量 regression 和重复 A/B。
- Dependencies: T-001.
- Execution steps:
  1. 添加 derived suspension reference stability 与 active-project probe regression。
  2. 实施无关 runtime patch O(1) aggregate suspension state、memoized entries/rows 与 active-only repository refresh。
  3. 在 baseline detached worktree 与 candidate 间多进程交错 A/B。
  4. 效果不超过噪声则撤销对应候选。
- Acceptance criteria:
  - predicted metrics 与 component latency 同向改善；active behavior tests 全通过。
- Verification method:
  - raw A/B、targeted Vitest、TypeScript build。
- Validation evidence: 实施 `AppState.suspendedSessionIds` 增量 index：direct runtime replacement 自动重建，`patchRuntime` 仅在 suspended membership 变化时复制 Set，无关 patch 保持 reference；active entries/project IDs 用 `useMemo`，branch source 轻量重算且 row 用 stable entry/source props memoize，refresh 仅遍历 active Project。新增 store reference/transition regression，并扩展 sidebar 测试覆盖 inactive Project、archive 后 effect scope 与 focus refresh。首次 per-row branch selector 候选在 500 全 active/200 emits workload 出现 6.846→9.275 ms（+35.5%）回退，已拒绝并替换为单一 parent status subscription + memoized rows；最终同 workload 6.899→5.038 ms（-26.97%）。最终 5 个 baseline 与 5 个 candidate 独立进程按 B/A 交错，每进程 warm-up + repeated samples；median-of-process-medians：500 unrelated emits/2,000 entries 75.787→0.186 ms（-99.75%）；100 runtime patches 33.780→18.775 ms（-44.42%）；300 Project/30 active mount+repository updates 15.739→11.395 ms（-27.60%）；probes 300→30（-90%）。各 candidate process median ranges 均不与 baseline 重叠。Targeted 2 files/7 tests、`tsc --noEmit`、task diff check passed。Raw：`/private/tmp/agentport-perf/final-ab-{baseline,candidate}-*.json`；汇总：`/private/tmp/agentport-perf/final-ab-summary.json`。
- Blocker: None.
- Unblock condition: T-001 done。

### [x] T-003 — 后端边界与集成回归

- Status: done
- Owner: coordinator
- Objective: 确认 Rust 新路径不是当前主导成本且 Host liveness 语义不回归，完成全量集成验证。
- Inputs and prerequisites: T-002 candidate。
- Scope or files: Rust active-liveness files只读或证据支持的最小改动；前端全量。
- Expected output: 有证据的“无需 Rust 改动”或测得收益的最小改动，及全套回归结果。
- Dependencies: T-002.
- Execution steps:
  1. 复核健康/断线频率、DB/FS/PID 边界。
  2. 运行 frontend/full、build/i18n、targeted Rust、diff/format。
  3. 审计并发工作区边界。
- Acceptance criteria:
  - 不因静态气味扩大 Rust 改动；Host liveness 和 2 秒收敛语义保持。
- Verification method:
  - tests/build/source boundary。
- Validation evidence: 源码调用边界复核确认 `reconcile_session_liveness` 只在 connection failure/stream EOF 进入，健康 monitor frame path 无新增 DB/FS/PID work；断线 cap 后每 2 秒一次，当前 active-render workload 没有支持 Rust 改动的测量证据，因此 Rust source 保持不变。`cargo test -p agentport-core liveness_reconciliation --quiet` 2 passed；`cargo test -p agentport session_monitor_retry_delay --quiet` 1 passed。`npm --prefix src test` 76 files/502 tests passed（仅既有 jsdom canvas/act stderr）；`npm --prefix src run build` passed；`npm --prefix src run i18n:check` passed；task-path `git diff --check` passed。审查确认 Set 仅在 membership 变化复制、direct replacement fail-safe rebuild、memo entry 对 branch/project/suspension dependencies 完整，并发 terminal 文件未编辑。
- Blocker: None.
- Unblock condition: T-002 done。

### [x] T-004 — Debug App 验收与提交

- Status: done
- Owner: coordinator
- Objective: 重建、精确重启、可视验证 Debug App，并提交仅本任务改动。
- Inputs and prerequisites: T-003 done；`AGENTS.md`。
- Scope or files: 本任务代码/测试/文档；Debug bundle 不提交。
- Expected output: 正常 active view、task validator、独立 performance commit。
- Dependencies: T-003.
- Execution steps:
  1. 执行 `scripts/rebuild-debug-app.sh`。
  2. exact `ps -axo pid=,comm=` 只重启 Debug GUI，不 signal Host/release App。
  3. 复用 in-process WebView snapshot 验证非白屏。
  4. 显式 staging、boundary check、commit、最终 status。
- Acceptance criteria:
  - Debug GUI 正常；commit 不含并发/用户文件。
- Verification method:
  - rebuild/process/snapshot/task validator/git show。
- Validation evidence: `bash scripts/rebuild-debug-app.sh` passed，Bundle ID=`com.agentport.desktop.debug.c9d007c8147e`，Debug App=`/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app`。仅用 exact `ps -axo pid=,comm=` 终止/重开 GUI；pre/final Host PID 均为 `3574 7327 9165 14038 77288 91674`，diff empty。一次性未落库 helper 调用当前 App 的 `WKWebView.takeSnapshot`：DOM leading buttons=3、Bell `aria-pressed=true`、label=`Show projects and Sessions`；生成 `/private/tmp/agentport-perf/active-sidebar-performance-debug.png`（2400×1600，SHA-256 `b1ed5bdf8bbf9f0d577eeb77d714244bc271a1d9769f6dfda6e1d70a4db95d09`），人工检查 active flat list、Bell 与 terminal UI 正常非白屏。helper 后已无注入干净重启，最终 GUI PID 50522 精确路径正确。`git commit -m "perf(sidebar): avoid redundant active-session work"` 成功；`git show --name-only HEAD` 仅含本任务 5 个文件，并发 terminal/用户文件均保持未暂存或 untracked。
- Blocker: None.
- Unblock condition: T-003 done。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Performance: `/private/tmp/agentport-perf` harness；fixed workload、15 within-process samples、至少 5 个 baseline/candidate 独立进程按 B/A 交错，汇总 median/range/effect ratio。
- Targeted: `npm --prefix src test -- src/store-performance.test.tsx src/sidebar-active-agents.test.tsx`。
- Regression: `npm --prefix src test`、`npm --prefix src run build`、`npm --prefix src run i18n:check`。
- Backend: `cargo test -p agentport-core liveness_reconciliation --quiet`、`cargo test -p agentport session_monitor_retry_delay --quiet`。
- Static: `git diff --check`；Rust 未改则不触发无关 rustfmt。
- UI/commit: rebuild script、exact process、WebView snapshot、explicit staged paths、`git show`。
- Document: `python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/AgentSessions/docs/tasks/2026-09-01-active-sidebar-scaling-performance-task.md`。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- jsdom 与 WebKit成本不同；只用于相同代码路径 A/B，不外推绝对延迟。
- synthetic 规模可能高于常见用户；报告规模与限制，不声称 field speedup。
- derived state/memoization可能 stale；直接测试 direct `setState(runtime)`、`patchRuntime` suspended transition、archive、branch/status。
- 减少 probes 可能漏 branch；只按实际 active entry Project 去重，测试 focus/visibility。
- liveness CAS 是正确性边界；无测量不得删 DB/FS/PID 验证。
- 并发 terminal 任务持续推进 HEAD/dirty tree；编辑和提交必须严格 path-bound。
- Blockers: None.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-01: 创建独立 execute authority；原先同名 task path 被并发 terminal warm-switch 工作占用，未再编辑该文件。
- 2026-09-01: T-001 完成。baseline 将第一成本分歧定位为 aggregate suspended 全量扫描/分配及全 Project probes；T-002 启动。
- 2026-09-01: T-002 候选审查发现 per-row branch selectors 在 500 全 active workload 回退 35.5%，拒绝该版本；改为单一 status subscription + memoized rows 后同 workload 改善 26.97%。最终 5×5 独立进程交错 A/B：unrelated emit -99.75%、runtime patch -44.42%、mount/update -27.60%、probe -90%；T-002 done，T-003 启动。
- 2026-09-01: T-003 完成。全前端 76 files/502 tests、build/i18n 与 targeted Rust liveness/retry tests 通过；Rust 健康路径不调用 reconciliation，未发现支持后端改动的 measured bottleneck，保持 Rust source 不变。T-004 启动。
- 2026-09-01: Debug App rebuild、exact clean restart、Host PID preservation 与 2400×1600 in-process WebView active-view snapshot 均验证通过；最终 clean GUI PID 50522 正常运行。
- 2026-09-01: 显式暂存 5 个任务文件，staged diff/name/whitespace boundary 通过；performance commit 成功且 `git show` 确认未包含并发 terminal/用户改动，T-004 done。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-004 全部完成。最终 5×5 独立进程交错 component A/B 显示 unrelated emits -99.75%、全 active emits -26.97%、runtime patches -44.42%、mount/repository updates -27.60%，probes -90%；targeted 7 tests、全前端 76 files/502 tests、production build、i18n、targeted core/Tauri liveness tests、diff check 均通过。Debug App rebuild、exact GUI、6 Host PID preservation、2400×1600 非白屏 active-view snapshot、task validator 与 5-file commit boundary 通过。
- Limitations: benchmark 是 Apple M5 上 Vitest/jsdom development component workload，证明相同代码路径和 synthetic scale 的因果改善，不代表真实用户分布或 WebKit field latency；Debug App 从共享 dirty worktree 构建，包含并发 terminal task 的未提交 UI 改动，但 active-sidebar 验收、性能 harness imports 和最终 Git commit 均严格限定本任务路径。Rust liveness 在健康路径不执行、断线最多每 2 秒检查一次，本轮没有支持后端改动的 measured bottleneck，故有意保持 Rust source 不变。
