# Task Plan: Terminal Performance Optimization Round 2

- Created: 2026-08-28
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求制定并执行下一轮 AgentPort 终端性能优化计划，使用 `$code-performance` 完成分析、调测、最小优化与真实 App 验证。

<!-- task-doc-section:background-goal -->
## Background and goal

上一轮已证明并优化终端 snapshot：真实 WKWebView 4 MiB workload 下同步 serialize+JSON P50/P95 从 11/19 ms 降至 2/3 ms。第二轮从尚未证明的候选中继续定位最早成本分歧，优先覆盖 Agent-native history 分页/重建、当前 buffer 搜索、Session 冷切换和 resize/reflow；只实施有可重复数据支持且不破坏历史可达性、viewport、输入响应和 renderer 内存上限的最小改动。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：`src/src/terminals.ts`、`src/src/components/TerminalArea.tsx`、相关测试、必要的 `/tmp` benchmark、打包 Debug App。测量同步主线程延迟、parser drain、数据量和 WebContent 内存；保留用户现有 dirty tree。

非目标：重做 xterm、增加隐藏 terminal LRU、缩小 4 MiB replay tail、牺牲完整历史/搜索语义、无测量升级依赖、触碰非隔离 Session Host、把 Node 组件结果冒充真实 App 结果。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Snapshot 1000 行优化已通过真实 WKWebView A/B，当前不是本轮首要候选。 | `docs/tasks/2026-08-27-terminal-e2e-performance-task.md`。 |
| F-002 | Native-history 每页把累计 events 转为 prefix，序列化 live tail、reset 并重新解析 prefix+tail；累计成本可能随已加载页增长。 | `src/src/terminals.ts:1590-1735`。 |
| F-003 | SearchAddon 在每次输入 `onChange` 上同步执行 incremental `findNext`，当前 xterm buffer 上限约 10,000 行。 | `src/src/components/TerminalArea.tsx:470-560`；`MAX_PERSISTENT_TERMINALS=1`。 |
| F-004 | LRU=1 是已验证的 renderer 内存约束；提高隐藏 terminal 数曾造成 WebContent footprint 随访问 Session 增长。 | `LEARNS.md` 的 `xterm renderer memory`。 |
| F-005 | Fit 已有 90 ms debounce、active-only 和计时字段；尚无证据证明它是当前瓶颈。 | `src/src/terminals.ts` 的 resize/fit 路径。 |
| F-006 | Debug App 重启只能 exact-match GUI `comm`，不能信号终止 `agentport-host`。 | `AGENTS.md` 与 `LEARNS.md`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 10,000 行 ANSI buffer、短高频搜索词、连续 200-event native-history pages 是可放大当前实现成本且不改变语义的代表性场景；先用真实 xterm 组件基准排序，再把胜出候选带到 WKWebView。
- Assumption: 若候选只减少微基准成本但真实 App 用户可见指标未移动，则不保留产品改动。
- Open question: Native-history、搜索、切换、fit 中哪一条在当前版本首先跨越可感知主线程预算；由 T-001 测量决定，不预设答案。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 为四条候选路径给出 measured / supported inference / unknown 分类及原始样本。
- 至少对首个已证明瓶颈实施一个最小候选，或在无候选超过噪声时给出有界停止结论；不得凭静态猜测提交优化。
- 保留完整历史、单 xterm viewport authority、4 MiB replay、LRU=1、搜索导航语义和 Session lifecycle。
- 候选必须有同 workload A/B，P50/P95 与机制指标同向改善且效应大于噪声；真实 App 可行时必须复测。
- Focused tests、完整 frontend tests、build、i18n、diff check 通过；最终 Debug App exact-path 重建/重启且 Host 清单不变，截图受权限限制时如实记录。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004。
- Parallel batches: 本轮修改和真实 App 状态集中在同一 terminal renderer，按证据链串行执行，避免共享 `terminals.ts`、WebKit 与 benchmark 状态冲突。
- Serialization constraints: 所有产品编辑、Debug bundle、Session/WebKit 操作由 coordinator 串行持有；dirty tree 不 reset/stash/checkout。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立第二轮候选基准并定位首个成本分歧

- Status: done
- Owner: coordinator
- Objective: 用真实 xterm 组件与现有 Debug App 指标比较 native-history rebuild、incremental search、cold switch/replay 和 fit/reflow 的成本级别。
- Inputs and prerequisites: F-001 至 F-006；上一轮原始 artifact。
- Scope or files: 只读产品路径；`/tmp` benchmark；必要的临时、可完全移除 instrumentation。
- Expected output: 固定 workload、原始样本、P50/P95、排名与首个可证伪候选。
- Dependencies: None.
- Execution steps:
  1. 构造 10,000 行真实 xterm 搜索基准与累计 native-history rebuild 基准。
  2. 使用现有 replay/fit 观测与最小 Debug App probe 补齐系统边界。
  3. 选择效应最大且能保持语义的单一干预点。
- Acceptance criteria:
  - 至少 10 个重复样本并保存原始数据。
  - 明确排除 benchmark 自身 O(n²)、LocalStorage quota 和 observer 失败。
- Verification method:
  - 可重复命令、JSON artifact、静态调用链和最小 correctness oracle。
- Validation evidence: 真实 xterm 10,040 行 SearchAddon 24 样本：warm missing-query 约 0.38–1.09 ms，命中查询更低，排除为当前瓶颈（`/tmp/agentport-terminal-round2-search.json`）。精确模拟 native-history marker-range 重建的 12×8 页样本显示：200→1600 events 时 total P50 25.24→30.80 ms、P95 34.61→37.69 ms；其中每页重复序列化未变化的 532,000-char live tail 占 P50 12.09–14.63 ms，parse 随累计 prefix 增至 18.71 ms（`/tmp/agentport-terminal-round2-history-range.json`）。Session LRU=1 与 fit debounce 有既有资源/频率证据，不作为本轮干预。首个可证伪候选：缓存 unchanged native-history tail，只在新 output 或 reflow 后失效。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实施首个证据支持的最小优化

- Status: done
- Owner: coordinator
- Objective: 只修改已证明的主线程成本来源，并增加防回归测试。
- Inputs and prerequisites: T-001 done。
- Scope or files: 胜出路径及对应 focused tests。
- Expected output: 单一机制产品 diff、回归保护、组件 A/B。
- Dependencies: T-001.
- Execution steps:
  1. 先固定 correctness/ordering/viewport/search oracle。
  2. 实施删除工作量、减少重复解析或降低同步调用频率的最小候选。
  3. 同 workload 交错 A/B，失败则回退候选而非叠加补丁。
- Acceptance criteria:
  - 机制指标和用户可见延迟改善超过噪声。
  - 无历史、viewport、搜索结果或资源上限回归。
- Verification method:
  - 原始 A/B、focused test、diff review。
- Validation evidence: 新增 `nativeHistoryTailDirty` fence：首个 native page 捕获 tail 后，连续页直接复用；任何 live/transient output 或尺寸 reflow 都失效并在下一页重新捕获。12 组交错真实 xterm A/B（pages 2–8 聚合）baseline P50/P95 28.16/37.68 ms，candidate 11.87/17.07 ms，分别降低 57.8%/54.7%；page 8 P50 30.84→14.99 ms。原始 artifact `/tmp/agentport-terminal-round2-history-ab.json`，SHA-256 `a80f1a6dc668795c877f729164e91c1c54dd633e21e519f5c5ae823bf942f933`。Focused renderer 69/69 与 production build 通过；回归覆盖 unchanged 连续页复用、live output 失效和 reflow 失效。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 真实 Debug App 复测与资源检查

- Status: done
- Owner: coordinator
- Objective: 在 WKWebView 中确认候选对代表性操作的整体延迟改善，并检查内存/CPU 权衡。
- Inputs and prerequisites: T-002 done。
- Scope or files: 临时 benchmark instrumentation、`/tmp` raw data、Debug App。
- Expected output: baseline/candidate 各至少 10 样本或明确的环境阻塞证据。
- Dependencies: T-002.
- Execution steps:
  1. 保持窗口、数据、build class 和操作边界一致收集 A/B。
  2. 记录主线程同步耗时、parser drain、payload/调用次数和 WebContent footprint。
  3. 移除所有 instrumentation，恢复产品 CSP/选择逻辑。
- Acceptance criteria:
  - P50/P95 与机制成本同向移动，无不可接受内存回归。
  - 原始 artifact 可复核，临时代码零残留。
- Verification method:
  - JSON 样本、进程清单、artifact hash、临时标记 `rg`。
- Validation evidence: 打包 Debug App/WKWebView（WebKit 605.1.15）执行 12 组交错 A/B、每组 8 个累计 history pages、每页 200 events、532,000-char unchanged tail。连续页 pages 2–8 聚合 baseline P50/P95 37/47 ms，candidate 24/25 ms，降低 35.1%/46.8%；page 8 P50 41.5→24 ms（-42.2%）；tail serialization P50 11→0 ms。原始 artifact `/tmp/agentport-terminal-round2-wkwebview.jsonl`，SHA-256 `a1b2a6fae86e01702d217fc4fcd391f204eefab024621e2783cf95f3896e532b`。临时 function/App call/CSP 已全部移除，`rg` 零命中；benchmark 的 898 MiB WebContent high-water 来自连续创建/销毁 24 个 standalone xterm，最终 clean restart 将验证产品 steady footprint。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 全量验证、Debug App 验收和结论

- Status: done
- Owner: coordinator
- Objective: 完成全量 correctness/build 验证、最终 bundle 验收和审计报告。
- Inputs and prerequisites: T-003 done，或 T-002 的候选因真实 App 证据失败而已回退。
- Scope or files: frontend tests/build/i18n、task doc、Debug bundle。
- Expected output: 最终保留 diff、检查结果、限制和运行中的 Debug App。
- Dependencies: T-003.
- Execution steps:
  1. 运行 focused/full tests、build、i18n、diff check。
  2. exact `comm` 重启 Debug GUI并对比 Host 清单。
  3. 尝试既有稳定截图路径；权限阻塞则记录 CGWindow/process 证据。
- Acceptance criteria:
  - 所有 required checks 通过，任务文档 validator 通过。
  - 性能结论不超出实际 workload 与证据。
- Verification method:
  - 命令输出、process/window evidence、任务 validator。
- Validation evidence: focused renderer 69/69、完整 frontend 332/332、`npm run build`、`npm run i18n:check`、`git diff --check` 全部通过。最终 `scripts/rebuild-debug-app.sh` 成功；当前 exact-path Debug GUI PID 45184，1200×800 onscreen 主窗口稳定运行；重启前后 Host PID 清单无差异。Clean restart 后 GUI RSS 约 139,360 KiB、对应 WebContent RSS 约 259,000 KiB，已从 standalone stress benchmark 的 898,064 KiB high-water 恢复且没有提高 renderer LRU/scrollback。CGWindow 显示 1200×800 onscreen 主窗口；`screencapture` 仍因系统权限返回 `could not create image from window`。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先用 Node/jsdom 加真实 xterm packages 隔离 search/rebuild 算法成本，至少 12 样本并交错 A/B；再用打包 Debug WKWebView 验证用户可见同步任务和资源。Correctness 使用现有 consecutive native pages、viewport anchor、SearchAddon single-authority、snapshot/mouse/replay suites；最终运行 330+ frontend tests、TypeScript/Vite build、i18n 和 diff check。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 工作树有大量用户改动：仅 exact edit，不 reset/stash/checkout。
- Native-history prepend 受 xterm 无前插 API 限制；若避免重建会破坏“一份 xterm/一套 selection/viewport”约束，则停止而不引入第二 renderer。
- 搜索 debounce 会改变即时反馈；只有真实输入延迟证明收益且结果/Enter 语义保留时才采用。
- LRU 提高违反已验证内存边界，排除为候选。
- Screen Recording/Accessibility 可能阻止截图，不阻止内部 timing；Debug 重启只 exact-match GUI。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-28: 用户授权 plan+execute；创建第二轮 execute authority document，T-001 由 coordinator 串行开始。
- 2026-08-28: T-001 done。SearchAddon warm scan低于 1.1 ms；native-history 连续页每次重复序列化 unchanged 532k tail 消耗约 12–15 ms，选择 dirty-fenced tail cache；T-002 开始。
- 2026-08-28: T-002 done。Dirty-fenced cache 在真实 xterm 组件 A/B 中使连续页聚合 P50/P95 降低 57.8%/54.7%，focused 69/69 和 build 通过；T-003 开始。
- 2026-08-28: T-003 done。真实 WKWebView 连续页聚合 P50/P95 37/47→24/25 ms，tail serialize 11→0 ms；临时 instrumentation/CSP 已移除，T-004 开始。
- 2026-08-28: T-004 done。Frontend 332/332、build、i18n、diff check 通过；final Debug App exact-path 重启，Host 清单不变，clean WebContent 241,952 KiB；截图权限仍阻塞。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 首个成本分歧为连续 native-history pages 对 unchanged live tail 的重复同步 serialize。产品增加 dirty fence 并复用已有 tail snapshot；真实 WKWebView 12 组交错 A/B、pages 2–8 聚合 P50/P95 37/47→24/25 ms（-35.1%/-46.8%），page 8 P50 41.5→24 ms（-42.2%），机制指标 tail serialize 11→0 ms。Focused 69/69、frontend 332/332、build、i18n、diff check 与 final Debug bundle 验收通过。
- Limitations: 真实 App benchmark 使用打包 WKWebView 内的可见 standalone xterm 重放相同 rebuild/serialize 算法，而不是依赖某个用户 Provider transcript；绝对值不外推到所有 transcript/窗口尺寸。首个 page 必须捕获 tail，无法受益；任何 live output 或 reflow 会正确失效 cache，下一页也必须重新序列化。SearchAddon warm 10k-line scan低于 1.1 ms，因此未改搜索；fit 与 Session switching 本轮没有新的瓶颈证据。Screen Recording 权限仍阻止像素截图。
