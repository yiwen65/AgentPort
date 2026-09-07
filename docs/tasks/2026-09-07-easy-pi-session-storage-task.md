# Task Plan: AgentPort Pi 会话统一使用 easy-pi 存储

- Created: 2026-09-07
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户要求在 AgentPort 保留旧 session 入口、host 使用 easy-pi，且新旧历史统一到 .epi；明确回复“执行调整”。

<!-- task-doc-section:background-goal -->
## Background and goal

AgentPort 当前以 --session-dir 覆盖 easy-pi 默认目录。本任务将新建和显式重启 Pi 会话的运行目录切换到 ~/.epi/agent/sessions 内，同时保持 AgentPort/native session ID、工作目录和历史入口。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

修改 AgentPort 启动/恢复、历史发现、备份与测试。新根下为每个 AgentPort session 建立稳定独立子目录，避免不同 AgentPort 数据实例互相覆盖；不改变 easy-pi 的 --session-dir 公共语义。旧会话仅在停止后显式重启时进行字节保真的保留源副本迁移，不批量碰运行中会话。可构建并按 AGENTS.md 重开 debug GUI；不停止任何 agentport-host 或 release GUI，不替换 release 包，不调用真实 provider，不读写凭据，不清理原始历史。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Pi launch/resume 固定使用 session_dir/pi 和原生 ID | crates/agentport-core/src/adapters/pi.rs |
| F-002 | GUI service 与 CLI 各自构建 launch/resume plan | crates/agentport-service/src/lib.rs；crates/agentport-cli/src/main.rs |
| F-003 | history 与 native_backup 硬编码旧目录；backup restore 目标为 AgentPort 专属目录 | core history.rs、native_backup.rs、backup.rs |
| F-004 | 当前 pi executable 链接到 easy-pi checkout 的 dist/cli.js | fnm 安装路径 symlink 检查，前轮只读核对 |
| F-005 | 既有 dirty：LEARNS.md、mobile PRD/Xcode 文件、terminals.ts 和其测试 | 开工 git status --short；全部不编辑/提交 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 使用默认 ~/.epi/agent/sessions；显式 EASY_PI_CODING_AGENT_DIR 时跟随其 sessions 子目录。内部迁移方法支持测试注入临时根，不读取真实历史做测试。
- 自动完成切换只能发生在下一次显式新建/停止后重启；正在运行的 host 保留原路径直到用户停止。
- 备份恢复继续先恢复到隔离 AgentPort 数据目录；恢复后的 Pi 首次显式重启再安全迁移，禁止 restore 写入正在使用的 .epi 会话。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- GUI/CLI 的新建与重启最终 argv 指向 .epi，原生 ID 和 AgentPort ID 不变。
- 迁移复制完整旧 Pi 专属目录含附属文件；拒绝符号链接/冲突/未知归属/源变化；失败不发布不完整目标，不删除原件。
- 历史/搜索/导出/备份使用已发布目标；未切换的旧会话仍可读。删除 AgentPort 会话不自动删除 .epi 中的外部历史。
- 定向 Rust 测试与离线编译通过；调试 App 构建/启动结果如实记录。不改动其他 dirty 文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002.
- Parallel batches: 无；存储协议及消费闭包串行实施。
- Serialization constraints: coordinator 独占本任务新增模块/相关接线和本文；沿用用户在 easy-pi 任务中确认的串行许可，不重试委派。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 存储切换、迁移和消费者闭包

- Status: done
- Owner: coordinator
- Objective: 安全切换新建/恢复，打通历史读取与备份，不回退到分叉旧副本。
- Inputs and prerequisites: F-001 至 F-005；用户执行许可。
- Scope or files: core pi_storage 新模块、lib/adapters/history/native_backup/backup 的必要接线；service/CLI launch/resume；定向测试和存储说明。
- Expected output: 单一存储路径解析、显式迁移入口、发布/归属协议、消费者一致性测试。
- Dependencies: None.
- Execution steps:
  1. 保持读取接口无副作用，迁移只在 cold launch/resume 调用。
  2. 原子发布目录/归属标记，冲突不覆盖，旧文件保留。
  3. 历史及备份使用相同目录解析；保留安全 restore staging。
  4. 临时目录测试迁移/恢复/冲突/备份，不调用 provider。
- Acceptance criteria:
  - 新 argv 正确；原生 ID 不变；字节/副作用边界和只读消费路径有测试证据。
- Verification method:
  - cargo test --offline 的 pi_storage/相关 Pi adapter/history/backup 指定过滤器；目标 cargo check；逐文件 rustfmt。
- Validation evidence: core `cargo test --offline -p agentport-core pi_ --lib` 19/19；service `pi_launch_plan_finalizes_epi_storage` 1/1；service/CLI cargo check --offline 通过。仅临时目录，无真实 provider。说明见 docs/easy-pi-storage.md。
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — 调试包生效和交付

- Status: blocked
- Owner: coordinator
- Objective: 构建 debug App 并明确运行中/旧版本的切换边界。
- Inputs and prerequisites: T-001 通过；现有 debug App 模板及本机依赖。
- Scope or files: debug build artifacts；scripts/rebuild-debug-app.sh 改为原子安装 executable，避免截断 live host inode；本文；仅精确定位的 debug GUI 进程。
- Expected output: 更新后的 debug GUI、进程/非白屏证据、自有源码提交。
- Dependencies: T-001.
- Execution steps:
  1. 按仓库脚本离线构建并签名 debug 包，不读取 .env 凭据。
  2. 只重启精确 debug GUI，绝不停止 host/release GUI。
  3. 验证运行路径及窗口，记录剩余限制，提交自有改动。
- Acceptance criteria:
  - 更新运行实例可识别，无真实 provider 调用和旧历史删除。
- Verification method:
  - rebuild-debug-app.sh、ps 精确 comm、窗口截图/可用性检查、git scope 审查、task validator。
- Validation evidence: 显式 AGENTPORT_DEBUG_SIGN_IDENTITY=- / CARGO_NET_OFFLINE=true 构建成功，bash -n 和 codesign verify 通过。Bundle ID com.agentport.desktop.debug.c9d007c8147e。仅停止精确 debug GUI PID 969，新 PID 39957 路径为工作区 debug 包；旧 host PID 2520/2757/3511/15848/18128 均保留。CoreGraphics 确认窗口 238，2560×1409；窗口/全屏 screencapture 均返回 could not create image，不能确认非白屏。
- Blocker: 系统截图不可用，视觉验收未完成。
- Unblock condition: 在可截图的桌面上下文取得非白屏证据，或用户直接确认。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

所有存储测试只用临时目录。至少覆盖新建、旧数据含附属目录、重复迁移、发布后新写入、源分叉冲突、符号链接、破损归属、native ID 保持、历史/备份读取同一已发布副本。运行限定 cargo filters，不运行真实 CLI/provider 探测集。逐文件格式化，避免 cargo fmt 改写其他文件。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 运行中 host 不参与即时迁移；若 metadata 与实际写入者不一致，源快照变化拒绝迁移，但不承诺 OS sandbox。
- .epi 目录与 AgentPort 元数据是不同持久介质；使用归属/发布标记而非靠文件是否存在猜测是否迁移。
- 用户若之后修改保留的旧副本，不自动覆盖新历史；明确冲突要求人工处理。
- 当前工作区包含其他未提交改动；debug build 可能包含其现有前端效果，但不提交那些文件。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-07: 只读检查 launch/resume/history/backup 消费闭包与 dirty 基线；T-001 开始。本轮不主动重启真实 session，不处理其正文或认证。
- 2026-09-07: T-001 实现及定向验证完成；读取/复制按源大小+1 有界，重复 primary native ID 拒绝。新 debug 包构建签名并打开，原 hosts 保留；系统截图不可用，T-002 保持 blocked。自有源码单独提交，不含既有或并发 mobile/terminal/LEARNS 改动。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 20 项定向测试及 service/CLI 离线 check 通过；debug 构建/签名/启动路径通过。构建日志 /tmp/agentport-epi-debug-build.log。未宣称全套测试通过。
- Limitations: T-002 缺截图验收；仅 debug 包更新。真实旧 session 未迁移，下一次显式停止后重启才切换；未替换 release、未调用 provider、未改 easy-pi dist 或暂停中的 Subagent 默认实现。
