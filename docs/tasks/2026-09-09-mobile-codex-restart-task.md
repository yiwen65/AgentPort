# Mobile Ctrl+C 后重启 Codex Session 修复

- Created: 2026-09-09
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求排查修复 mobile Ctrl+C 终止后无法 Restart；确认 Mac Codex、错误 request failed on the remote host。

<!-- task-doc-section:background-goal -->
## Background and goal
让手机在 Codex 通过 Ctrl+C 退出后可靠重启同一 Session，保持 Host/run 权威边界及不重复执行的约束。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
检查手机退出/重启/重新附着、Bridge 服务、持久化生命周期。只修复有证据的失败；不终止其他 Host/Session、不修改审核环境或 TestFlight 构建，不使用子代理，保留无关工作区改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence
| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 手机退出后会直接 session.restart；ShouldAttach 为真时才先 stop | SessionWorkspace.tsx action/exit handler |
| F-002 | 服务在启动前直接拒绝 DB Running/Creating | CoreService::restart_session |
| F-003 | 最新 Codex 行仍 Running，记录的 Host PID 已不存在；匹配 run 的 host-state 有退出记录 | 只读 SQLite + PID 检查 + host-state 元数据，2026-09-09 |
| F-004 | Core 已有带 PID/run fence 的生命周期对账函数 | HostManager::reconcile_session_liveness |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- Hypothesis: Host 已退出但服务未对账 DB，Restart 被旧 Running 状态拒绝。须用回放测试证明，不以猜测直接补丁。
- Open question: 完整恢复链是否还有第二处失败；先验证重启前置条件，再验证真实启动与附着。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- 有退出证据的旧 Running 行可进入正常重启流程；真实活跃 Host、错误 run 的退出记录仍不能被误判。
- 重启产生新 run 并能重新附着；不依靠额外 Stop、盲重试或固定延迟。
- 回归先失败后通过，相关测试和构建通过，更新对应调试运行组件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
- Dependency graph: T-001 -> T-002.
- Parallel batches: None; 串行，不使用子代理。
- Serialization constraints: 同一服务文件及测试由本代理负责；部署只涉及此 checkout。

<!-- task-doc-section:task-list -->
## Task list
### [x] T-001 — 捕获回放、定位并修复重启拒绝
- Status: done
- Owner: coordinator
- Objective: 证明并修复最早错误边界，保留并发/存活保护。
- Inputs and prerequisites: 用户错误与只读状态证据。
- Scope or files: agentport-service、相关 Core/Bridge/手机代码（仅证据要求时）。
- Expected output: 最小补丁、回归和反例测试。
- Dependencies: None.
- Execution steps:
  1. 用隔离 Session 及匹配退出记录复现拒绝。
  2. 对照活跃 PID/错 run/Creating 反例，按证据修复。
- Acceptance criteria:
  - 原回放失败变成功，活跃/竞态保护不退化。
- Verification method:
  - 定向 Rust/前端测试和隔离原生复现。
- Validation evidence: 新增服务测试包含匹配退出、死 PID 无记录、活跃 Host、旧 run 记录、Creating 无 PID 五个场景；旧代码匹配退出场景返回 PreconditionFailed，补丁后五场景通过。真实隔离 Codex 适配器/PTY/Host/Bridge 回放：创建后关闭创建者 Bridge，再以新 Bridge 附着并输入 Ctrl+C，DB 保持 Running；从 HEAD 构建的旧 Bridge 返回 not_executed/request_not_executed；修复 Bridge 返回 succeeded，run ordinal 1→2，重新附着及输入/输出 ECHO:RESTART_CHAIN_OK 通过。未关闭创建者 Bridge 的对照可由 reaper 更新 DB，因而不稳定触发；这解释触发前提。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 构建部署并验证手机重启闭环
- Status: done
- Owner: coordinator
- Objective: 让正确修复进入实际 Bridge/Host 路径并验证可重启。
- Inputs and prerequisites: T-001 done。
- Scope or files: checkout 调试包；如手机代码变动则构建安装手机，不修改待审包。
- Expected output: 真实请求/新 run/重新附着证据，Git commit。
- Dependencies: T-001.
- Execution steps:
  1. 构建、只重开 checkout debug GUI，不杀任何现有 Host。
  2. 验证对应 Bridge 版本与重启请求，记录可见结果与未测范围。
- Acceptance criteria:
  - 原失败链修复、窗口非白屏、无无关 Session 中断。
- Verification method:
  - 精确 PID/可执行路径、截图、实际请求或用户真机验证。
- Validation evidence: Service/Bridge 49 项、HostManager 17 项、手机 SessionWorkspace 36 项测试通过。rebuild-debug-app.sh 构建并签名通过；仅关闭原 checkout GUI，新 GUI PID 6502 的 comm 为目标 debug .app，窗口截图非白屏。手机 App 重新打开以建立新 Bridge 连接；活动 Bridge comm 指向该 debug .app。使用实际 bundled Bridge 重跑隔离 Ctrl+C→Restart→新 run→attach/input/output 全链通过。提示用户手机重试后，原 codex-15 在 18:40:35 CST 从 run 1→2，DB Running，Host 12331 与 Codex 子进程 12332 均存活；未由本代理重启该用户 Session，未终止其他 Host。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan
先回放失败，再保护反例，随后验证真实启动/附着；不要把成功进入前置检查等同于启动成功。只提交本任务改动。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
退出事件可先于 DB 更新，旧 Host 退出记录必须按 PID/run fence 验证；网络失败不证明进程死亡。用户现有 Agent 不得被测试中断。共享全局环境测试必须串行或使用隔离入口。

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-09-09: T-002 done。102 项相关测试通过，目标 debug App 和活动 Bridge 已更新；真实 bundled Bridge 隔离闭环通过。随后观察到原失败 Codex Session 新 run/新 Host/Codex 均启动。无需手机代码更新，不改变 TestFlight 或 Linux 审核环境。
- 2026-09-09: T-001 done，T-002 in_progress。确认消失的创建者 Bridge/reaper 是稳定复现旧 Running 的条件；修复是在 repository lock 内、Running/Creating guard 前调用 Core 的 PID/run-fenced reconcile，再重新读取 session。隔离新 run 与终端读写已过，准备部署调试 Bridge。
- 2026-09-09: 创建计划，已捕获最新 Codex 的 DB/Host 状态分歧；开始隔离回放。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: passed
- Evidence: 匹配退出记录+旧 Running 的回归先失败后通过；HEAD 旧 Bridge 原生回放返回 not_executed，修复后的真实 bundled Bridge 创建新 run 并完成终端输入输出。102 项相关测试、调试构建、GUI 路径与非白屏截图验证通过。原失败用户 Session 已观察到 run 2 且 Host/Codex 存活。
- Limitations: 真机屏幕未通过旧 screenshotr 工具采集；不据此声称已截图验证手机终端内容。没有修改 Codex 的历史恢复策略，也没有更新待审核手机构建。其他运行 Session 未被测试终止。
