# Task Plan: Backend Performance Optimization Round

- Created: 2026-08-28
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求把 backend 性能分析中的 1–5 项加入 task 并完成修复。

<!-- task-doc-section:background-goal -->
## Background and goal

在保留现有 Session 恢复、状态投影、搜索结果、历史顺序、Host 协议与内存上限的前提下，测量并消除五类 backend 无效工作：空闲心跳重复 SQLite 写、项目列表 N+1 查询、每次启动重复 legacy search purge、async command 中同步重活阻塞，以及 Host output tail/replay 的逐字节淘汰或多余拷贝。只保留有机制证据和可重复 A/B 支持的最小优化。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：`crates/agentport-core/src/db/mod.rs`、`crates/agentport-core/src/search.rs`、`crates/agentport-host/src/main.rs`、`src-tauri/src/main.rs`、对应 Rust tests/bench fixture、任务文档和最终 Debug App 验收。

非目标：改变 UI 契约、降低恢复精度、放宽 run/generation fence、修改 Host wire protocol、无界并发文件扫描、自动 VACUUM 生产数据库、重置或覆盖现有 dirty tree、信号终止任何 `agentport-host`。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Host 每秒广播 heartbeat；相同 cursor 仍以 `IMMEDIATE` transaction 更新 observed timestamp。 | `crates/agentport-host/src/main.rs:1048`；`crates/agentport-core/src/db/mod.rs:813,3294`。 |
| F-002 | `collect_projects` 正常路径约执行 `1 + 2P + 4S` 次查询；当前 7 projects/86 active Sessions 约 359 次。 | `src-tauri/src/main.rs:448-519` 与 DB 查询实现。 |
| F-003 | `boot` 每次调用一次性 `purge_transcript_bodies`，后者 DROP/CREATE/DELETE legacy index tables。 | `src-tauri/src/main.rs:660`；`crates/agentport-core/src/search.rs:133`。 |
| F-004 | 多个 async Tauri command 直接运行同步 rusqlite/provider-file 扫描。 | `src-tauri/src/main.rs:660,722,3324,3431,3462,3512`。 |
| F-005 | Host 4 MiB tail 使用 `VecDeque` 并逐 byte 淘汰，replay materializes a `Vec<u8>`；此前 fanout encode-once 已完成，不能重复实现。 | `crates/agentport-host/src/main.rs`/`server.rs`；`docs/tasks/2026-08-26-performance-audit-optimizations-task.md`。 |
| F-006 | 工作树含大量用户改动，Debug GUI 只能按 exact `comm` 重启且不得 signal Host。 | `git status --short`；`AGENTS.md`；`LEARNS.md`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: copied SQLite DB、temp fixture 和 synthetic Host workload 可代表机制成本且避免污染真实数据；最终只把组件收益外推到相同 workload。
- Assumption: 对 item 5，若 profiling 证明当前实现低于噪声或替代方案增加资源/语义风险，则以有界“不改产品代码”结论完成该项；不为满足形式而提交未经证明的容器替换。
- Open question: 五项中实际产品延迟和资源收益大小由 T-001 基线及各项 A/B 决定，不预设百分比。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 五项均有固定 workload、机制指标和 measured/supported/unknown 结论；原始产物放在 `/tmp`，不修改真实 DB。
- 相同 idle cursor 不再每秒提交 recovery cursor write，同时 run/generation/offset 推进和 crash recovery 保持正确。
- 项目列表投影消除 Session 级 N+1，输出与旧实现逐字段等价，查询次数不再随 Session 以多次往返增长。
- legacy purge 成功后持久标记并跳过后续 boot；旧数据库升级、失败重试保持安全，不在 boot VACUUM。
- 已证明的长同步 command 离开 async executor 或进入现有有界 blocking 模式；并发请求不得无界放大。
- Host output candidate 仅在 A/B 证明机制收益后保留；保持 4 MiB bound、replay ordering、offset 和 slow-client isolation。
- 相关 Rust tests、workspace/targeted tests、format、diff check、Debug bundle rebuild/restart 通过；Host PID 清单不变，窗口非空白证据按仓库规则记录。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> {T-002,T-003,T-004,T-005,T-006} -> T-007。
- Parallel batches: T-001 的五个只读调查可并行；实现因 `db/mod.rs`、`main.rs` 与 Host shared state 重叠，由 coordinator 按 T-002 至 T-006 串行集成。
- Serialization constraints: task document、产品编辑、真实 App、SQLite fixture 和最终验证只由 coordinator 写；不 reset/stash/checkout，不触碰真实 Host 生命周期。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立五项基线与设计约束

- Status: done
- Owner: coordinator
- Objective: 为五项恢复准确调用链、correctness oracle、最小基准和可实施方案。
- Inputs and prerequisites: F-001 至 F-006。
- Scope or files: 只读相关 Rust code/tests；`/tmp` fixture/benchmark。
- Expected output: 每项基线、风险、首个成本分歧和修改边界。
- Dependencies: None.
- Execution steps:
  1. 并行检查 heartbeat、projection、purge/blocking、Host tail 与现有测试。
  2. 在 copied/temp DB 和 synthetic buffers 上建立最小计数/耗时基线。
  3. 固定 correctness/resource oracle 后批准最小实现。
- Acceptance criteria:
  - 不访问写入真实数据库；不把静态候选称为已证瓶颈。
  - 五项均有可证伪的验证方法。
- Verification method:
  - 代码引用、临时 benchmark raw samples、现有测试定位。
- Validation evidence: 五个只读调查并行完成（subagent run `87bc6683-a2c5-4131-b42b-17b322d329de`）：确认 heartbeat 两条 GUI 连接可重复提交相同 cursor；projection 正常查询公式 `1+2P+4S`；purge 缺独立 marker/transaction；heavy commands 缺统一 blocking gate；OutputTail 满环后每 16 KiB append 最多逐 byte eviction 16,384 次且 full replay 在 encode 前双份 payload copy。现有 correctness tests、temp DB/4 MiB synthetic benchmark 边界和风险均已定位；未写真实 DB、未 signal Host。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 消除相同 heartbeat cursor 重复写

- Status: done
- Owner: coordinator
- Objective: 只在 cursor 前进或身份切换时持久化，保留恢复 fence。
- Inputs and prerequisites: T-001 done。
- Scope or files: `db/mod.rs` 和/或 `src-tauri/src/main.rs`、相关 tests。
- Expected output: dirty/no-op fence 与写计数 A/B。
- Dependencies: T-001.
- Execution steps:
  1. 增加相同 cursor no-op 与推进 cursor 回归测试。
  2. 在最早安全边界实施严格推进判断。
  3. 测量 idle/active transaction 或 WAL 指标。
- Acceptance criteria:
  - equal cursor 不产生 UPDATE/commit；run/generation/offset advance 正确。
- Verification method:
  - focused DB/monitor tests 和 copied DB A/B。
- Validation evidence: `identical_latest_log_cursor_is_a_read_only_noop` 通过：首次写后 100 次 identical cursor 的 `total_changes` 增量为 0，advance cursor 正确持久化。Synthetic temp SQLite 1000 次 idle heartbeat：baseline 1000 changes，candidate 0 changes；artifact `/tmp/agentport-backend-db-bench.json`。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 批量化项目列表 projection

- Status: done
- Owner: coordinator
- Objective: 用批量 DB projection 替代 Session 级 status/recovery/unread 查询。
- Inputs and prerequisites: T-001 done。
- Scope or files: `db/mod.rs`、`src-tauri/src/main.rs`、相关 tests。
- Expected output: O(固定批次数 + 输出行数) 查询形状和 JSON 等价 A/B。
- Dependencies: T-001.
- Execution steps:
  1. 固定 notification filter、latest ordering 与 attention evidence 语义。
  2. 新增最小 batch API 并在 Rust 分组。
  3. 对 10/100/500 Session 比较 query count、latency 和输出。
- Acceptance criteria:
  - 无 per-Session DB call；旧/新投影逐字段等价。
- Verification method:
  - focused tests、query counter/trace、fixture benchmark。
- Validation evidence: 新 `list_session_projections` 在一个 read transaction 中以固定 3 statements 投影 Session/status/unread，worktrees/projects 各 1 query；等价测试覆盖 Notification、NULL evidence、attention、archive 并通过。20 projects/2000 Sessions/40000 events synthetic A/B：8041→5 queries，P50/P95 11.720/11.857→5.027/5.089 ms；artifact SHA-256 `6f9767b1f5bdca9a8f4241a239d65017b80ce6aae68a6fb146a73e40b39635be`。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 将 legacy search purge 变成一次性 migration

- Status: done
- Owner: purge-writer + coordinator
- Objective: 成功 purge 后持久跳过，失败可安全重试。
- Inputs and prerequisites: T-001 done。
- Scope or files: `search.rs`、`src-tauri/src/main.rs`、相关 tests。
- Expected output: version marker/idempotent migration 与 boot A/B。
- Dependencies: T-001.
- Execution steps:
  1. 定义 marker 与旧/新 DB 行为测试。
  2. 事务化 purge+marker，boot 调用 migrate API。
  3. 对 copied DB 测量 first/subsequent invocation。
- Acceptance criteria:
  - 后续 boot 无 DROP/CREATE/DELETE；失败不写完成 marker；不 VACUUM。
- Verification method:
  - search tests、SQLite schema/state assertions、copied DB timing。
- Validation evidence: once/force 与 marker failure rollback/retry tests 通过；清理和 marker 位于同一 `IMMEDIATE` transaction，二次 once 调用 `total_changes` 不增加，显式 rebuild 仍 force purge。Boot 已切换 once API，不执行 VACUUM。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 隔离 async command 的同步重活

- Status: done
- Owner: coordinator
- Objective: 对已证明阻塞的 search/history/project/timeline/boot 路径使用有界 blocking 边界。
- Inputs and prerequisites: T-001 done；T-003/T-004 API 形状稳定后集成。
- Scope or files: `src-tauri/src/main.rs`、必要 helper/tests。
- Expected output: 轻量 IPC 在并发重活下不被同一 executor 阻塞。
- Dependencies: T-001, T-003, T-004.
- Execution steps:
  1. 确认 AppState clone/Send 边界与现有 spawn_blocking pattern。
  2. 只移动已证明的 command，保持错误和 serialization contract。
  3. 并发 heavy/light A/B，检查队列和资源上限。
- Acceptance criteria:
  - heavy work 不在 async executor 直接运行；无无界 worker/扫描并发。
- Verification method:
  - focused command tests、并发 latency harness、clippy/build。
- Validation evidence: Boot reconcile/cleanup/purge、boot snapshot、list projects、global/focused native search、native history、timeline 与 force rebuild 均在 `spawn_blocking` 边界运行；process-wide permit 将 interactive heavy jobs 限为 4，required startup 等待 permit 而不跳过 ordering。Gate test 与 46/46 Tauri tests 通过；当前只证明 executor 隔离机制和并发上限，未宣称已测用户延迟百分比。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 优化或有界关闭 Host tail/replay 候选

- Status: done
- Owner: coordinator
- Objective: profile 逐 byte eviction/replay copy；只保留可证明且语义等价的最小改动。
- Inputs and prerequisites: T-001 done。
- Scope or files: `agentport-host/src/main.rs`/`server.rs`、Host tests/bench。
- Expected output: 4 MiB wrap/replay A/B；若优化则有 ordering/offset/resource 回归保护。
- Dependencies: T-001.
- Execution steps:
  1. 构造 sustained output、wrap 和 replay workload。
  2. 比较现实现与最小候选的 CPU/alloc/latency。
  3. 收益不足则移除候选并记录停止理由。
- Acceptance criteria:
  - 4 MiB bound、byte-exact replay、offset/order、slow client isolation 不变。
- Verification method:
  - Host focused tests、raw benchmark、RSS/allocation检查。
- Validation evidence: Append 使用 bulk drain，replay 单遍构造最终 64 KiB owned chunks，移除 full-tail intermediate Vec；2 个私有 correctness tests 与 29/29 Host integration tests 通过。12 组交错 optimized Rust synthetic A/B（64 MiB append + 32×4 MiB replay）：append P50/P95 155.769/156.948→0.526/0.549 ms，replay 4.372/4.400→2.335/2.358 ms；artifact SHA-256 `6c64ede348ce7fbca35432a5d61338469192300bbe502301ceb2b449f88333d2`。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 全量验证与 Debug App 验收

- Status: done
- Owner: coordinator
- Objective: 集成五项结果，完成 correctness/performance/resource 和真实 App 验收。
- Inputs and prerequisites: T-002 至 T-006 done。
- Scope or files: targeted/full Rust tests、task doc、Debug bundle。
- Expected output: 可复核最终 diff、A/B、运行中的 exact-path Debug App。
- Dependencies: T-002, T-003, T-004, T-005, T-006.
- Execution steps:
  1. 运行 targeted/full checks、format 与 diff review。
  2. 用脚本 rebuild Debug App，exact `comm` 关闭旧 GUI并 `open -n`。
  3. 对比 Host PID，确认窗口 onscreen 非白屏；更新任务证据。
- Acceptance criteria:
  - 所有 required checks 和 task validator 通过；限制如实记录。
- Verification method:
  - 命令输出、artifact hashes、process/window evidence。
- Validation evidence: Core serial 318 passed/6 ignored；Host 40/40；Tauri 46/46；frontend production build、custom-protocol GUI/Host bundle、codesign 与 `git diff --check` 通过。Debug GUI exact executable PID 28189，CGWindow layer 0 onscreen 1200×800；重启前后 7 个 Host PID/path 完全一致。Screen Recording 仍拒绝 window screenshot。全量 `cargo fmt --check` 与 `clippy -D warnings` 被 preserved dirty tree 中本任务外既有格式/Clippy findings 阻塞，未擅自格式化或修复 unrelated files。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先以 focused unit/integration tests 固定 cursor 单调性、projection 等价、migration 幂等、command 错误契约和 replay byte equality；性能使用 copied/temp SQLite 与 synthetic 4 MiB tail，至少多次交错 A/B并保存 `/tmp` raw artifact。集成后运行相关 crates/workspace checks、`cargo fmt --check`、`git diff --check`；UI/App 行为受影响时按 `scripts/rebuild-debug-app.sh` 完整重建并 exact-path 重启验收。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- SQLite migration、recovery cursor 与 run fence 属于数据正确性高风险路径，必须 test-first 固定语义并使用 copied/temp DB。
- `src-tauri/src/main.rs` 和 `db/mod.rs` 已有大量用户改动；只做 targeted edits，不 reset/stash/checkout。
- blocking pool 若无界会把 executor starvation 转成磁盘/内存争用；必须复用有界策略或加明确 limiter。
- ring buffer 改动可能降低逐 byte 淘汰成本但增加 replay copy/内存；无整体收益即停止。
- Debug restart 严禁 substring PID matching，严禁 signal `agentport-host`；截图权限可能继续阻塞像素证明。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-28: 用户授权五项 plan+execute；创建 authority document。确认 dirty tree 全部保留，T-001 由 coordinator 开始。
- 2026-08-28: T-001 done。五项只读设计调查完成并固定 correctness/benchmark 边界；T-002 由 coordinator 开始，独立的 T-004 search core 与 T-006 Host tail 交给隔离 writer 并行实现。
- 2026-08-28: T-002–T-006 done。Adversarial review 发现并修正 projection snapshot/error propagation、NULL evidence、purge deferred upgrade 和 boot fail-fast ordering；Core 318 passed/6 ignored（serial）、Host 40/40、Tauri 46/46。T-007 开始。
- 2026-08-28: T-007 done。Final Debug bundle 重建并 exact-path 重启，Host 清单不变；CGWindow 确认 onscreen 1200×800 window，截图受 Screen Recording 权限阻塞。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 五项均完成最小产品修复与 focused/full correctness 验证。Synthetic DB A/B 将 2000 Sessions project projection 从 8041 降至 5 queries、P50/P95 11.720/11.857→5.027/5.089 ms，并把 1000 idle heartbeat writes 从 1000 降至 0；optimized Rust Host A/B 将 64 MiB bulk append P50/P95 155.769/156.948→0.526/0.549 ms、32×4 MiB replay 4.372/4.400→2.335/2.358 ms。Core/Host/Tauri suites、frontend/build/bundle/diff 与 exact GUI/Host preservation 通过。
- Limitations: 数值来自 synthetic component workload，不外推为真实 App 端到端百分比；blocking-pool 项只验证 executor 边界与最多 4 个 interactive heavy jobs，未采集真实 IPC tail-latency A/B。Screen Recording 权限阻止像素截图，但 CGWindow/process 证明窗口 onscreen。全局 fmt/clippy 被 unrelated dirty-tree findings 阻塞，未修改这些用户内容。
