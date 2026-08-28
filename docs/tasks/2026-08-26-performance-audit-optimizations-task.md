# Task Plan: 性能审查优化实施

- Created: 2026-08-26
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求修复此前性能审查发现的优化项；本会话压缩摘要中的受控测量结果

<!-- task-doc-section:background-goal -->
## Background and goal

此前受控 workload 支持两条生产路径存在可优化放大：agent-native 搜索重复解析并在全局结果已满后继续扫描，以及 Host PTY 广播随客户端数重复克隆/序列化同一帧。目标是在不改变精确 Session 内搜索、Host 协议和慢客户端隔离语义的前提下消除这些重复工作，并用回归测试与同类 workload 验证。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：`crates/agentport-core/src/history.rs`、全局搜索调用方、Host 广播队列/协议编码辅助及相关测试。非目标：未观察到高耗时的 Timeline；实测约 14µs/次且前端已合并 drain 的 recovery acknowledgement；当前生产路径不调用正文索引构建的 `index_session_log/rebuild_all`；真实 GUI 搜索取消和 xterm 渲染成本（仍缺真实 workload 证据）。不实施无证据的架构重写。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 16 MiB native transcript 搜索约 24ms，`limit=1/1000` 基本相同；20 Session CLI 全局搜索约 0.34s且不随 limit 早停 | 本会话受控 workload 摘要 |
| F-002 | `search_session` 先 `source_status(resolve)`，随后 `for_each_event` 再次 `resolve`；`collect_native_ids` 每次从 Hook 文件头扫描 | `crates/agentport-core/src/history.rs:270-310,385-429,484-520` |
| F-003 | 全局 GUI 仅显示最多 20 条且已有 `partial` UI；聚焦 Session 搜索显示精确 `totalHits` | `src/src/components/SearchDialog.tsx:32,68-70`、`src/src/components/TerminalArea.tsx:500` |
| F-004 | 4 MiB fanout 1/4/8 客户端 Host 平均 CPU 约 88%/118%/164%；每客户端收到完整字节 | 本会话受控 workload 摘要 |
| F-005 | `broadcast` 对每客户端深克隆 `HostFrame`，writer 再分别 JSON/base64 序列化同一帧 | `crates/agentport-host/src/main.rs:223-256`、`crates/agentport-host/src/server.rs:630-650`、`crates/agentport-core/src/protocol.rs:315-320` |
| F-006 | Timeline 在 5,000 events 下 P95 6.847ms；ack SQLite 合成事务约14µs/次；legacy body rebuild 未发现正常生产调用 | 本会话受控 workload 摘要及 `src-tauri/src/main.rs:3353-3359` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 全局搜索达到显示 cap 后允许返回 `partial=true` 和结果下界；现有 UI 已定义该提示，精确 Session 内搜索保持完整计数。
- Assumption: Host NDJSON 字节可在 broadcast 时编码一次并以共享不可变缓冲区排队；各 writer 仍独立 write/flush，因此慢客户端隔离不变。
- Open question: 真实 UI 旧搜索请求取消仍缺证据，本任务不把 bounded scan 描述为取消实现。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 一次 Session 搜索只解析一次 native source/Hook IDs。
- 全局 GUI/CLI 搜索达到 cap 后停止继续扫描并标记 `partial`；聚焦 Session 搜索仍返回精确 `totalHits`。
- 同一 Host broadcast frame 只 JSON/base64 编码一次，客户端队列共享编码字节；队列容量、顺序、慢客户端驱逐和协议 wire format 不变。
- 相关 Rust 单元/集成测试通过；重复 workload 显示搜索 limit 生效且 fanout CPU 相比基线下降，若无法重建 harness 则明确限制。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → T-003。
- Parallel batches: 无；统一由 coordinator 串行实施，避免在大量用户未提交修改上并发写入共享 Rust 调用链。
- Serialization constraints: 不覆盖或格式化无关用户修改；协议辅助、Host channel 类型和验证必须作为一个可编译变更集提交。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 恢复优化合同与选择生产可达项

- Status: done
- Owner: coordinator
- Objective: 从测量和源码区分应实施项与不应猜测优化项。
- Inputs and prerequisites: 会话测量摘要、当前工作区源码。
- Scope or files: 只读检查 history/search/host/timeline/recovery 路径。
- Expected output: 可追溯范围、非目标和验收标准。
- Dependencies: None.
- Execution steps:
  1. 检查调用链和调用方语义。
  2. 对照测量选择重复解析、bounded global search、broadcast encode-once。
- Acceptance criteria:
  - 每个实施/不实施决定均有源码与测量证据。
- Verification method:
  - 本文 F-001 至 F-006 与范围记录。
- Validation evidence: 已检查上述源码；并确认 legacy `rebuild_search_index` 仅 purge，不调用 `rebuild_all`。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实施搜索与 Host fanout 优化

- Status: done
- Owner: coordinator
- Objective: 消除已确认重复扫描、无界全局扫描和逐客户端重复编码。
- Inputs and prerequisites: T-001 done。
- Scope or files: history、CLI/Tauri 全局搜索、protocol、Host main/server 及最小测试。
- Expected output: 保持既有精确/协议语义的最小补丁。
- Dependencies: T-001.
- Execution steps:
  1. 复用单次 resolve 并增加可提前停止的 bounded 搜索路径。
  2. 全局调用方达到 cap 后停止且返回 partial。
  3. 增加 frame encode helper，Host broadcast 共享编码缓冲区。
  4. 添加/更新回归测试。
- Acceptance criteria:
  - 满足总体 acceptance criteria 前三项。
- Verification method:
  - focused core/host tests、wire roundtrip、global search contract tests。
- Validation evidence: `cargo check --locked -p agentport-cli -p agentport-host -p agentport` 通过；history 8/8、protocol 5/5、broadcast focused test 通过；源码检查确认精确 Session 搜索仍走完整计数路径，global GUI/CLI 改用 bounded 路径。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 回归与性能验证

- Status: done
- Owner: coordinator
- Objective: 验证正确性并测量优化后的同类 workload。
- Inputs and prerequisites: T-002 done。
- Scope or files: 测试命令和 `/tmp` 合成 fixture/harness；不使用真实用户数据。
- Expected output: before/after 可比数据和残余风险。
- Dependencies: T-002.
- Execution steps:
  1. 运行 focused 与 package tests、diff check。
  2. 重跑搜索 limit/Hook 与 fanout workload。
  3. 审查仅修改目标路径。
- Acceptance criteria:
  - 测试通过，性能变化有受控数据或明确说明不可测原因。
- Verification method:
  - 命令、次数、中位数/CPU记录。
- Validation evidence: core lib 296 passed/6 ignored；CLI 4/4；Tauri 44/44；Host 28/29（唯一失败为审查前已复现的 `invalid_resume_requires_resync_then_bounded_tail` 启动竞态，broadcast/slow-client 测试均通过）。合成 search：16 MiB transcript + 16 MiB Hook 的旧双 resolve 基线 194.747ms，单 resolve 98.063ms；64 MiB 首条命中 bounded 0.062ms，对照完整精确扫描 43.624ms。4 MiB fanout 相同 Python harness 下 Host 平均 CPU：旧 1/4/8 客户端 17.67%/57.10%/123.60%，新 16.40%/24.47%/34.83%，每客户端均收到至少4,194,311 bytes。`scripts/rebuild-debug-app.sh` 成功；Debug GUI 精确路径 PID 7184，6 个 Host 保持运行；截图 `/tmp/agentport-performance-screen-3.png` 非白屏。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

运行 `cargo test --locked -p agentport-core history --lib`、相关 CLI/Tauri 测试（若已有）、`cargo test --locked -p agentport-host --test host_tests`、protocol tests、`git diff --check`。使用合成 native JSONL 和 1/4/8 客户端 4 MiB fanout workload 做同条件对比，不触碰真实 Session 数据。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

主要风险是误改全局搜索精确计数契约、共享字节队列改变 framing/flush、以及工作区已有大量用户修改导致误覆盖。通过保留聚焦搜索精确路径、复用同一 NDJSON encoder、逐 hunk 编辑和 focused diff 控制。子代理分析因本地 Pi RPC 配置错误（`--json-profile requires --mode json`）不可用，不影响 coordinator 串行执行。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-26: Task document created。
- 2026-08-26: 纠正此前误解；已精确撤销本轮误加的 Host 测试同步和 LEARNS 条目，保留用户原有修改。
- 2026-08-26: T-001 done；选择搜索重复工作和 Host encode-once，排除未达瓶颈或生产不可达项。T-002 started。
- 2026-08-26: T-002 done；搜索复用单次 resolve、global bounded scan；Host queue 改为共享预编码 NDJSON。T-003 started。
- 2026-08-26: T-003 done；相关包测试、合成 before/after workload、Debug App 重建/精确进程/非白屏截图完成。Host 全套仍仅有审查前已知的 invalid-resume 测试竞态失败。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 搜索与 fanout 验收项均有回归测试和同条件合成 workload 支持；core/CLI/Tauri 相关套件通过，Debug App 已重建并正常渲染。
- Limitations: 合成测量不代表真实用户 workload；Host 全套 29 项中已知 invalid-resume 测试竞态仍失败且本任务未修改；真实 UI 旧请求取消、xterm 成本、索引不可达路径、Timeline/ack 未优化。
