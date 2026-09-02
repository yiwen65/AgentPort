# Task Plan: AgentPort Mobile v1.0 实施

- Created: 2026-09-01
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: `docs/mobile-app-prd.md`（已确认，commit `bbf2025`）与用户明确要求“拆解 PRD 为开发任务计划并执行，完成交付”

<!-- task-doc-section:background-goal -->
## Background and goal

AgentPort 当前是 macOS/Linux 本地优先工作台，GUI 通过 `agentport-core` 与每 Session 独立 `agentport-host` 管理 PTY、状态、原生日志、Git Worktree、Secret 和恢复。目标是在不破坏这些安全与生命周期语义的前提下，交付 AgentPort Mobile v1.0：iOS 16+ 与 Android 10+ 客户端通过用户自管 SSH/Mosh 连接多台电脑，提供移动端重设计的完整桌面业务等价、独立 SSH/Mosh Shell、完整 SFTP、断线续接、无账号/无官方云/无遥测，并满足 PRD AC-01 至 AC-21。

本文件是本次执行唯一权威状态记录。实现先经过并行可行性与架构取证，再冻结技术方案、文件所有权和协议，随后按依赖批次实施、集成、验证和提交。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### Scope

- 依据 `docs/mobile-app-prd.md` 实现并验收 Remote Bridge、协议协商、SSH/Mosh、主机与凭据、Session、桌面全功能等价、独立终端、SFTP、多主机聚合、通知、本地数据、安全、无障碍、中英文、构建与签名模板。
- 新增移动端源码、自动化测试、协议/架构文档和电脑端必要的 Bridge/Core 能力；保持桌面 GUI 现有行为兼容。
- 按 PRD 规定只以模拟器/仿真器作为 v1.0 必须验收环境，同时如实记录无法由模拟器证明的真机风险。
- 所有验证通过后，创建只包含本任务改动的 Git commit；不得吸收执行开始前或并发产生的无关工作区修改。

### Non-goals

- AgentPort 账号、官方云、中继、遥测、离线推送、团队权限或远程操作审计。
- SSH 端口转发/SOCKS、Wake-on-LAN、硬件密钥、任意多级跳板、Mosh UDP 中继或自动安装远端依赖。
- 通用代码 IDE、平板专项体验、应用商店发布、预签名安装包或真机强制验收。
- 修改 PRD 已确认的产品决策；发现技术不可行时必须记录 blocker 和可证伪证据，不得静默缩减范围。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户已明确授权计划与完整实施，不是仅计划模式。 | 当前用户请求“拆解PRD需求为开发任务计划并执行，完成交付”。 |
| F-002 | PRD 已确认 iOS 16+/Android 10+、SSH/Mosh 双通道、完整桌面等价、独立 Shell、完整 SFTP、无账号/云/遥测和 AC-01 至 AC-21。 | `docs/mobile-app-prd.md`，commit `bbf2025`。 |
| F-003 | 桌面基线由 Tauri 2 + React + xterm.js、Rust Core、每 Session 独立 Host/PTY/Socket 组成，GUI 是可重连客户端。 | `README.md:3-12`、`src/package.json`。 |
| F-004 | 桌面业务已有广泛 Tauri command contract，覆盖 Project、Session、Worktree、Git、历史、导出、备份、设置、Secret、诊断和文档。 | `src/src/api.ts`、`src/src/types.ts`。 |
| F-005 | 安全基线包括 Host Token、完整进程组停止、Secret 系统安全存储与实时脱敏、Hook 不修改全局配置、Git 参数数组调用。 | `docs/security.md`、`README.md:66-73`。 |
| F-006 | 仓库当前没有已提交的移动端工程或 Remote Bridge 实现；具体移动框架、Bridge wire protocol 和 Mosh 库仍需取证后冻结。 | `git ls-tree`、`Cargo.toml`、`src/package.json`；PRD 第 1 节明确技术方案待后续确定。 |
| F-007 | 仓库要求 UI/App 行为调试完成后重建并打开精确 debug App、核对进程和截图；Feature 验证后必须提交。 | `/Users/w/Projects/AgentSessions/AGENTS.md`。 |
| F-008 | 执行开始前工作区已有与本任务无关的未提交修改，且并发工作可能继续产生改动。 | 2026-09-01 `git status --short`：`LEARNS.md`、多个 `TerminalArea`/`terminals`/`store.ts` 文件、现有 task 文档与测试。 |
| F-009 | 终端实现的既有项目经验要求区分 transport completion 与 xterm parser completion，并同步 buffer 与 DOM viewport。 | `LEARNS.md` 中 `xterm replay visibility`、`xterm viewport restoration`、`xterm synchronized output`。 |
| F-010 | PRD 明确只要求模拟器/仿真器，真机网络、后台和安全存储风险须披露而不能宣称通过。 | `docs/mobile-app-prd.md` 第 10、12 节。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption A-001: 移动框架、SSH/Mosh 库和 Bridge 编码属于技术实现决策，可由 T-001 至 T-004 基于仓库与可运行原型选择；影响是后续文件边界与验证命令尚未冻结。验证方式：架构 ADR 必须比较至少两个可行选项并以模拟器原型证据决策。
- Assumption A-002: 桌面等价应复用 Core/Host 业务语义而不是在移动端复制业务规则；影响是 Remote Bridge 需提供稳定、可协商、可游标续接的远程 facade。验证方式：协议契约测试和 PAR-01 至 PAR-27 矩阵。
- Assumption A-003: 当前无关脏文件属于其他工作，必须按初始状态保留且不得进入本任务 commit；若必要实现与其路径冲突，先等待或采用新文件边界，不能覆盖。验证方式：每批前后 `git status`/diff 与最终 staged path audit。
- Assumption A-004: 本机已安装的 Rust/Node/Xcode/Android 工具链是否足以完成双端模拟器构建尚未确认；影响是对应任务可能因外部 SDK 缺失 blocked。验证方式：T-003 工具链盘点与最小构建探针。
- Assumption A-005: PRD 的“完整交付”不授权购买开发者证书、外部服务、云资源或修改生产环境；只交付源码、开发制品、构建说明和签名模板。验证方式：构建与发布检查不使用外部写操作或真实凭据。
- Resolved question Q-001: 用户选择“移动子项目采用 GPLv3”。桌面端、Core、Service、Bridge 和共享协议继续 MIT；独立移动 App 及其链接的 Mosh 组件采用 GPLv3，并提供对应源码、许可证文本与合规说明。该记录是工程边界，不替代法律意见。
- Resolved question Q-002: 用户于 2026-09-02 明确要求删除 iOS/Android 全部生物识别与 credential lease 功能，并同步 PRD/架构；Keychain/Keystore 安全存储保留，连接按 opaque credential handle 即时读取凭据，不替换为设备密码认证。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- AC-001: `docs/mobile-app-prd.md` 第 6.7 节 PAR-01 至 PAR-27 全部具有实现、移动替代或明确平台不适用证据，无静默缺项。
- AC-002: PRD AC-01 至 AC-21 全部通过并记录命令、环境和限制。
- AC-003: iOS 16+ 与 Android 10+ 模拟器工程可从干净依赖状态构建并启动；构建与团队签名配置模板完整。
- AC-004: Remote Bridge 不监听公网端口，GUI 关闭时可用，协议支持能力协商、请求完成状态、游标续接、多客户端和输入批次原子性。
- AC-005: SSH 密码/密钥、Ed25519 生成、系统安全存储按需读取、TOFU、跳板机逐跳指纹和断线不重放通过自动化或规定模拟器验证；代码与产物不含生物识别或 credential lease 路径。
- AC-006: Mosh 实时通道 + SSH 控制通道、UDP 不可达提示、缺少 `mosh-server` 指引通过可重复测试。
- AC-007: Session、Project、Agent、Worktree、Git、文档、搜索、时间线、导出、备份、Secret、设置和诊断保持 Core 安全语义与桌面等价。
- AC-008: 独立多标签 Shell 和 SFTP 全操作、确认、临时文件原子落位、上传后向 Session 发送路径通过测试。
- AC-009: 5 台在线主机/100 Session、PRD PERF-01 至 PERF-06、无障碍核心流程、中英文和安全检查达标。
- AC-010: 完整 Rust/前端/移动自动化与静态构建通过；涉及桌面行为时按 AGENTS.md 重建并打开 debug App、核对路径和截图非白屏。
- AC-011: task document validator 通过，所有任务 `[x] done`，最终验证为 `passed`，且单一任务 commit 不包含 F-008 的无关改动。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `{T-001,T-002,T-003} -> T-004 -> {T-005,T-006} -> T-017 -> T-007 -> {T-008,T-009,T-018}`；`T-018 -> {T-010,T-011,T-012,T-013,T-014}`，且 `{T-007,T-008} -> T-014`；`{T-008,T-009,T-010,T-011,T-012,T-013,T-014,T-018} -> T-015 -> T-016`。T-016 还依赖 T-001 至 T-007、T-017 与 T-018。
- Parallel batches:
  - Batch A（done）：T-001 移动框架、T-002 Bridge/Core、T-003 工具链/测试/安全并行只读取证。
  - Batch B（当前）：T-004 协调者冻结 ADR、模块边界、协议和文件所有权。
  - Batch C：T-005 Remote Bridge/协议与 T-006 移动工程骨架并行，文件所有权必须不重叠。
  - Batch D：T-017 串行完成双端 SSH/SFTP/Mosh/secure-storage/xterm prerequisite spike；不通过不得释放产品功能。
  - Batch E：T-007 串行集成主机、认证、信任、连接状态和 Bridge 端到端最小闭环；T-018 随后删除已撤销需求的全部生物识别/lease 路径并重验安全存储连接。
  - Batch F：已在需求撤销前完成的 T-008/T-009 由 T-018 回归验证其 credential 连接路径；尚未完成的 T-010 至 T-013 在 T-018 完成后继续，T-014 等 T-008/T-018 完成后启动。禁止共享生成文件和 lockfile 并发写入。
  - Batch G：T-015 跨功能硬化；T-016 全量集成、debug App、任务文档和提交。
- Serialization constraints: 根 `Cargo.toml`、移动依赖 lockfile、Bridge wire schema、共享客户端 store/router、Tauri/移动配置、authority document 和最终 commit 只能由协调者或单一指定 owner 串行修改。F-008 的脏路径在所有 writer 中默认禁写，除非协调者确认其外部改动已提交并重新分配。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 移动框架与终端/SSH/Mosh 可行性取证

- Status: done
- Owner: mobile-platform-analyst
- Objective: 基于当前仓库和可用生态确定能同时满足 iOS/Android、Rust/Core 复用、xterm/终端、SSH、SFTP 与 Mosh 的最小可行移动技术路线。
- Inputs and prerequisites: F-002、F-003、F-006、A-001。
- Scope or files: 只读 `Cargo.toml`、`src/package.json`、`src-tauri/**`、现有终端实现及本机工具链；不得修改文件。
- Expected output: 选项比较、依赖与许可证/平台约束、推荐路线、最小原型步骤、已证实 blocker 与建议模块路径。
- Dependencies: None.
- Execution steps:
  1. 盘点 Tauri 2/React/Rust 复用边界和现有终端依赖。
  2. 比较至少两个移动方案及 SSH/SFTP/Mosh 集成路径。
  3. 给出模拟器可验证性、关键技术风险和最小闭环。
- Acceptance criteria:
  - 推荐可追溯到仓库证据，不把未运行能力写成事实。
  - 明确 Mosh 与系统安全存储的原生边界。
- Verification method:
  - 只读路径核对与可用命令/SDK版本探针；报告实际结果。
- Validation evidence: 只读取证完成：比较 Tauri 2 Mobile/React、Flutter 与双原生路线；仓库证据显示现有 React/Tauri/xterm 与 typed invoke 可复用，因此推荐独立 Tauri 2 Mobile 子项目，但手机只复用 Bridge DTO/framing，不链接完整 host-local Core。探针确认 Rust/Node/Xcode 可用但移动 targets 未安装；russh/russh-sftp 为 Apache-2.0 候选且仍需双端编译证明；Mosh 官方代码为 GPLv3，iOS `COPYING.iOS` 仍要求完整 GPL 合规。无仓库文件被分析任务修改。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Remote Bridge、Core 与桌面等价接口取证

- Status: done
- Owner: remote-bridge-analyst
- Objective: 确定如何复用现有 Core/Host/Tauri commands 构建无公网监听的 Remote Bridge，并形成桌面能力到远程接口的完整映射。
- Inputs and prerequisites: F-003、F-004、F-005、A-002。
- Scope or files: 只读 `crates/**`、`src-tauri/**`、`src/src/api.ts`、`src/src/types.ts`、CLI 与测试；不得修改文件。
- Expected output: 进程/数据流、可复用 API、缺口、协议状态机、游标/幂等/多客户端安全边界、PAR-01 至 PAR-27 映射建议。
- Dependencies: None.
- Execution steps:
  1. 追踪 boot、Session attach/input、历史、Git、Secret、备份和诊断路径。
  2. 找出 Tauri-only/UI-only 能力及 Bridge 所需最小抽取。
  3. 提出 crate/command 边界和契约测试策略。
- Acceptance criteria:
  - 覆盖 PRD 全部能力域和安全硬约束。
  - 明确 GUI 关闭、Host Token、进程组停止和 Secret 脱敏如何保持。
- Verification method:
  - 只读代码引用、现有测试与 CLI 命令证据。
- Validation evidence: 只读追踪完成：Core/Host/Tauri/CLI 路径表明 Tauri 仍承载大量 use-case orchestration，不能直接把现有 Tauri commands 包装成完整 Bridge；推荐抽取 Tauri-free `agentport-service` facade，并由 stdio-only Bridge、Tauri 与 CLI 复用。确认 Host 已有 Token、redaction、bounded multi-client 与 replay/resync，但跨 client 严格输入 FIFO/batch ack、unknown write、stop `group_cleaned` 验证和完整 PAR facade 是实现缺口。无文件被分析任务修改。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 双端工具链、测试矩阵与交付环境取证

- Status: done
- Owner: mobile-delivery-analyst
- Objective: 盘点本机 iOS/Android/Rust/Node 工具链，定义可实际执行的构建、模拟器、性能、安全和签名模板验证路径。
- Inputs and prerequisites: F-007、F-010、A-004、A-005。
- Scope or files: 只读配置和版本命令；不得安装 SDK、登录账号、修改证书或写项目文件。
- Expected output: 工具链事实、缺失依赖、可运行命令、模拟器矩阵、CI建议、签名模板边界和潜在 blocker。
- Dependencies: None.
- Execution steps:
  1. 检查 Xcode/simctl、Android SDK/emulator/Gradle、Rust targets、Node 包管理器。
  2. 对照 PRD PERF/AC 定义可重复验证命令与环境记录。
  3. 识别必须外部安装或真实设备才能证明的边界。
- Acceptance criteria:
  - 每项可用性均有命令输出，不凭空假设。
  - 不执行外部写入、购买、证书或生产操作。
- Verification method:
  - 版本与只读列表命令。
- Validation evidence: 本机只读探针完成：macOS 26.5.1、Apple M5/24 GB、Xcode 26.6、仅 iOS 26.5 runtime 与两个 shutdown iPhone 17 模拟器；缺 iOS 16 runtime。Android SDK/Studio/adb/emulator/sdkmanager/Gradle/JDK 均不可用。Homebrew Rust 1.95 只有 `aarch64-apple-darwin`，无 rustup/mobile targets；Node 24.15/npm 11.12 可用但 `src/node_modules` 不存在。已形成最低/最新模拟器、性能、安全和签名模板命令合同。无安装、凭据或仓库写入。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 冻结移动架构、协议与实施边界

- Status: done
- Owner: coordinator
- Objective: 综合 T-001 至 T-003 证据，产出唯一 ADR、wire contract 草案、模块拓扑、路径所有权和更新后的可执行批次。
- Inputs and prerequisites: T-001、T-002、T-003 报告。
- Scope or files: `docs/design/mobile-architecture.md`、本 authority document；必要时新增协议 schema 目录但不实现功能。
- Expected output: 已决技术方案、替代方案取舍、Remote Bridge 状态机、Mosh→Host attach、Secret write-only contract、history cursor、共享类型策略、依赖许可记录、目录/ownership 和验证命令。
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. 对照 PRD 确认架构能到达所有 AC。
  2. 通过最小只读/临时探针消除关键未知，不把猜测下放给 writer。
  3. 更新 T-005 至 T-016 的具体 owned paths 与批次。
- Acceptance criteria:
  - 无未处理的高后果架构假设。
  - writer 文件所有权不重叠，协议和 lockfile 写入串行。
- Verification method:
  - ADR 对照 PRD traceability review；task document validator。
- Validation evidence: 已创建 `docs/design/mobile-architecture.md`，冻结独立 Tauri 2 Mobile、MIT service/protocol/stdio Bridge、GPLv3 移动边界、Mosh→本机 Host attach、write-only Secret、安全 history cursor、T-017 prerequisite gate 与逐任务 ownership。两轮独立 review：首轮发现 5 个实质问题并全部修正；终审确认 Gate DAG、Mosh Host 安全路径、ownership、Secret ingress 和 cursor 合同均已解决。`task_document.py validate` 与 scoped `git diff --check` 通过。
- Blocker: None.
- Unblock condition: T-001、T-002、T-003 done 且 Q-001 已解决。

### [x] T-005 — 实现 Remote Bridge 与版本化协议

- Status: done
- Owner: coordinator（按用户要求顺序手工完成剩余 facade 与验证，不使用 subagent）
- Objective: 实现随桌面 AgentPort 内置、通过 SSH stdio 启动、无公网监听的 Remote Bridge 与可协商协议。
- Inputs and prerequisites: T-004 ADR、现有 Core/Host 安全语义。
- Scope or files: 由 T-004 冻结的 Rust crate、CLI/打包配置、协议契约测试；不得修改移动 UI。
- Expected output: boot/capabilities、请求完成状态、事件/日志游标、Session attach/input/控制、多客户端、全桌面业务 facade。
- Dependencies: T-004.
- Execution steps:
  1. 抽取/复用 Core application service，不复制安全规则。
  2. 实现 framed stdio、版本/能力协商、request ID、错误与结果未知语义。
  3. 增加无监听、GUI关闭、多客户端、原子输入和安全回归测试。
- Acceptance criteria:
  - BRIDGE-01 至 BRIDGE-10、AC-04、AC-16、AC-21 的 Bridge 部分通过。
- Verification method:
  - 冻结后的 Rust unit/integration/e2e 命令。
- Validation evidence: Foundation slice integrated from writer commit `2b7614b5`。后续 Host/Core slice 已实现：1 MiB 增量 bounded NDJSON reader、additive `input_batch_v1` capability、所有 legacy/new input 共用单一 bounded Host FIFO、accepted/completed/not-executed/unknown ack、partial-write fail-closed、HostClient token-redacted Debug；双客户端真实 PTY 测试按 `server_sequence` 证明 batch 不交错。Service/Bridge slice 已实现安全 `attach_with_resume`、opaque attachment、zeroizing base64 input、resize/interrupt/continue、poll/replay/resync event projection、closed cleanup 与 unknown-write result；Host Token/socket/PID/argv/log path 不进入 DTO。打包脚本与 Tauri externalBin 已加入 Bridge。验证：`cargo test -p agentport-host --test host_tests -- --test-threads=1` 34/34；protocol/service/bridge 16/16；`cargo check --workspace --all-targets`；desktop custom-protocol build；真实 GUI-off E2E 以临时 data/socket 启动 CLI Session，经 Bridge hello→list→attach→input→poll 观察 `AGENTPORT_REMOTE_E2E_OK`→detach，11 frames，stop 后 Host 进程 0。后续又增加 Remote `session.stop`：只有收到 `Exit.group_cleaned=true` 或匹配 PID/run 的 durable host-state proof 才成功；真实 Bridge E2E 已用该方法 stop 并确认进程 0。Secret write 已接入 zeroizing DTO、唯一 staged Keychain account、SQLite metadata+preset 单事务发布和失败补偿；真实安全存储仍因交互式 Keychain 测试默认 ignored。异步 push 与安装包级 smoke 后续已完成：协议 additive 升为 v1.1，只有显式请求且协商成功时启用 `session.event_push`，v1.0/未请求客户端继续 poll-only；Bridge 使用唯一 bounded stdout writer、per-attachment 公平队列、attach Result publication barrier、detach/EOF cancellation barrier 与显式 overflow gap。Service 每 attachment 只有一个 Host reader，input/control ack 不会被 push 抢读；clean Exit→EOF 不再误报 gap，abrupt EOF 仍要求 resync；client batch ID 通过 attachment-local monotonic Host wire ID 关联，允许 client ID 复用但旧/wrong-sequence ack 不能误完成，且不保留无界 tombstone。当前 protocol 8 tests、service 12 tests、Bridge 12 unit + 1 no-listener integration 全通过，三 crate all-target check 通过，两轮 adversarial review findings 已关闭。真实 v1.1 GUI-off E2E 以异步 Event（未调用 `session.poll`）观察跨 3 个 output event 分片的 `AGENTPORT_REMOTE_PUSH_E2E_OK`，input receipt 保持 client batch ID，Remote stop 返回 `groupCleaned:true`，Host 进程 0。新增 `scripts/verify-installed-remote-bridge.py`：精确拒绝运行中的 packaged GUI、isolated data/socket、bounded framed hello、direct Bridge no-socket、installed Host PID set unchanged、EOF clean exit、child-only cleanup、可选 codesign；5 个 self-tests、known-listener probe 与两轮 review 通过。最新 debug bundle 已在清理 stale Core artifacts 后成功重建，packaged Bridge 的 hello smoke 与同一 v1.1 async E2E 均通过，deep/strict codesign 通过；仅精确重启 workspace GUI，新 PID 30476，截图 `/tmp/agentport-debug-async-push-final.png`（1312×912，SHA-256 `fd1c87f180ac76e3e0e9b4daa05226d704c5fe3c441a9e64874f47f0d44bc6be`）非白屏。PAR facade Batch 1 现已覆盖 typed Agent/Preset、Project 与 Secret metadata：六 Adapter snapshot/probe、lossless future-adapter preferences、preset 安全投影、Project CRUD/layout/完整 versioned preflight/cascade、Secret status/list/add/delete；registry/prepare/dispatch exact。审查发现的 5 项已顺序修复：桌面确认 echo 完整 snapshot；桌面/Remote 在 Host group cleanup 未证明时 fail-closed 并保留 authority/data；Project fence 原子阻止 branch/commit journal；active `secret.status` 禁止自动重试；future adapter 字符串可 round-trip。另将随机 u64 Project revision 改为 decimal string，避免 JS IEEE-754 损失。验证：frontend focused 8/8 + production build；Core Project/fence/branch/commit targeted tests；protocol 9、service 17、Bridge 14+no-listener；Tauri all-target check。PAR facade Batch 2 的 Session metadata/lifecycle 子批次现已完成：rename/pin、stop-before-archive + generation-scoped rollback、unarchive、archive list/delete/delete-all、status history、精确 seen/unread cursors、auto-title、generation-fenced bounded recovery context，以及 direct/push attachment 的 structured prompt/turn abort；structured/auto-title ingress DTO 为 non-Debug/non-Clone zeroizing allocation，push 命令仍由唯一 Host reader actor 串行处理。Bridge registry/strict prepare/dispatch 已覆盖全部新增方法，敏感 prompt/input 不进入 stdout/stderr；当前 protocol 9、service 18、Bridge 15 + no-listener 全通过，三 crate 与 Tauri all-target check、scoped rustfmt/diff check 通过。Session create/restart shared orchestration 也已完成：repo lock、Adapter/permission/risk acknowledgement、Worktree ownership、Secret materialization、private helpers、token rotation、Host launch 与 resume identity 现由 Tauri-free `agentport-service` 单一路径承载，桌面 Tauri create/restart 已改为薄 adapter；Remote response 序列化明确排除 desktop-only Host PID/argv。同步错误在副作用前返回 `not_executed`，进入持久化/launch 后的不确定失败才返回 `unknown`。真实 isolated GUI-off Bridge E2E 完成 project.add→session.create→push attach/input/output→authoritative stop→session.restart→再次 authoritative stop，输出 `AGENTPORT_REMOTE_CREATE_RESTART_E2E_OK`，两轮均 `groupCleaned:true` 且无残留测试 Host。当前 protocol 9、service 19、Bridge 15 + no-listener、desktop Rust 48 tests 通过。Worktree facade 子批次现也已覆盖 preview/reconcile/create/list/status/delete preflight/remove 与 explicit auto/new/existing branch selection。Worktree removal fence 改为单 owner，桌面与 Remote 均在删除 authority/files 前要求所有关联 Host 的 authoritative group cleanup；失败时撤销自身 fence 并保留 Worktree/Session，成功路径使用 `remove_after_fence` 防止二次抢占。当前 protocol 9、service 20、Bridge 15 + no-listener、desktop 48 tests 通过，Core fence regression 通过。Git Workspace 与 Branch facade 子批次现已覆盖 context/status tokens、changes/diff/history/commit detail、stage/unstage/discard/ignore/trash/file resolve/remote sync、commit prepare/execute/reconcile，以及 branch status/list/create/create-switch/switch/delete/auto-stash reconcile/list/restore/cleanup；所有入口由 Service `deny_unknown_fields` typed wrapper 严格解析，`branch.autostash.list` 因 reconcile 可能更新 journal 而分类为 idempotent write。真实临时 Git fixture 验证 backend token stage 与 branch create/list，invalid strategy/unknown fields fail closed；当前 protocol 9、service 22、Bridge 15 + no-listener、三 Remote crate 与 Tauri all-target checks、scoped rustfmt/diff check 通过。Commit-AI facade 也已完成 config get/save/key clear/generate：API key 通过 non-Debug/non-Clone zeroizing DTO 进入共享 Service，桌面命令改为同一 Service 薄 adapter；provider URL 禁止 credentials/query/fragment 与 redirect，响应 128 KiB bounded，生成前后复验 checkout/status tokens，网络发送结果不明返回 `unknown`。系统凭据先唯一 staging，再与 settings/metadata 在 SQLite IMMEDIATE transaction 原子发布，失败补偿 staged credential；替换/清除先原子移除 authority，再 best-effort 清理旧系统凭据，避免设置引用缺失凭据。Core failure-injection regression 证明 metadata INSERT 冲突会回滚 settings；OpenAI/Anthropic endpoint、语言/Conventional Commit shape、sensitive header/staged-only prompt tests 通过。当前 protocol 9、service 26、Bridge 15 + no-listener、Tauri all-target check 与 diff check 通过。Content/history/settings/diagnostics 子批次现覆盖 global/session search、native history page、legacy log inventory/confirmed delete、body-index purge、timeline get/snapshot ack、完整 strict Settings get/save，以及 Host/summary/capabilities diagnostics。所有 limit 后端 capped 1000；短搜索词 fail closed；`timeline.get` 因 hidden-only acknowledgement 分类为 idempotent write；settings DTO 明确枚举全部字段并拒绝 unknown fields。当前 protocol 9、service 27、Bridge 15 + no-listener、三 Remote crate与 Tauri all-target checks、scoped rustfmt/diff check 通过。最终 documents/export/backup 子批次覆盖 1 MiB bounded 文本读取与 binary sniff、2000-entry bounded 目录浏览、create-new 文件/目录、8 MiB zeroizing content ingress + sibling temp/fsync/rename 原子保存、`.md`/`.json`/diagnostics `.zip` 导出，以及 backup create/list/verify/restore-to-new-directory；host path 必须 absolute 且拒绝 `..`，live data root 与 ancestor/descendant restore target fail closed。Bridge 输出/诊断不回显文档正文。最终验证：protocol 9、service 27、Bridge 15 + no-listener、desktop 43 tests，三 Remote crate与 Tauri all-target checks、scoped rustfmt/diff check 全通过。T-005 完成；交互式真实系统 credential-store roundtrip 没有在未获凭据写入授权时执行，该平台 evidence 由 T-017 的双端 secure-storage gate 承担，不影响 Bridge/Core 原子性验收。
- Blocker: None.
- Unblock condition: T-004 done；已完成。

### [x] T-006 — 建立 iOS/Android 移动工程骨架与共享基础设施

- Status: done
- Owner: coordinator（两次 writer WebSocket failure 后接管）
- Objective: 建立可构建启动的双端移动工程、导航、主题、i18n、持久化、安全存储抽象、终端容器和测试基线。
- Inputs and prerequisites: T-004 ADR 与工具链证据。
- Scope or files: 由 T-004 冻结的移动根目录、平台配置、依赖 lockfile、构建脚本；不得实现 Remote Bridge 后端。
- Expected output: iOS/Android 模拟器可启动骨架、`zh-CN`/`en-US`、system/light/dark、测试 harness 与签名占位配置。
- Dependencies: T-004.
- Execution steps:
  1. 初始化最小工程并固定依赖。
  2. 建立 feature 边界、共享 store/router、错误与加载状态。
  3. 添加双端 build/smoke test。
- Acceptance criteria:
  - 用户于 2026-09-02 明确授权开发期以本机 iOS 26.5 simulator 代替不可获得的 iOS 16 runtime；iOS deployment target 仍保持 16.0，但本次不把 iOS 16 runtime smoke 作为下游开发 gate。
  - Android API29 emulator 与 iOS 26.5 simulator 构建并显示非空白应用壳。
  - 无账号、云、遥测或广告依赖。
- Verification method:
  - 冻结后的 iOS/Android build、unit 和 smoke 命令。
- Validation evidence: 已创建 GPL-3.0-only `mobile/` Tauri 2 + React/Vite scaffold、独立 Rust workspace、生成 iOS/Android 工程、iOS deployment target 16.0、Android minSdk 29、中英文、system light/dark、响应式/可访问空状态、typed `RemoteClient`/Tauri adapter 边界、许可证/第三方清单、签名模板与构建说明。当前 `npm test` 3/3、`npm run build`、`cargo test --manifest-path mobile/src-tauri/Cargo.toml` 1/1 均通过。Android API29 arm64 emulator：debug APK SHA-256 `2f48502d728085dfce6cefe02905421437d145f81c4b496e8b5b69546d19f80e`，安装/冷启动成功，`mResumedActivity` 为 `com.agentport.mobile/.MainActivity`，截图 `/tmp/agentport-mobile-api29-fixed.png` 非白屏且显示 `No hosts yet`。iOS 26.5 arm64 simulator：debug bundle 构建、安装和启动成功，进程 `com.agentport.mobile` 存活，截图 `/tmp/agentport-mobile-ios26.png` 非白屏且显示同一空状态。用户于 2026-09-02 明确接受开发与当前验收仅使用 iOS 26.5，故该 scaffold gate 以现有双端证据完成；iOS 16 runtime 未验证仍作为最终兼容性限制如实保留，不再阻塞下游开发。
- Blocker: None. iOS 16 runtime unavailable is an accepted validation limitation, not a development blocker.
- Unblock condition: T-004 done；用户已授权 iOS 26.5-only development validation。

### [x] T-017 — 双端 transport、secure-storage、xterm 与 Mosh prerequisite spike

- Status: done
- Owner: coordinator
- Objective: 在产品 feature 开发前，用可运行双端证据证明 SSH/SFTP、Keychain/Keystore 安全存储、xterm 移动交互，以及普通/AgentPort Session Mosh 的完整技术路径。
- Inputs and prerequisites: T-005 Bridge/Host FIFO 与 T-006 移动 scaffold；T-004 ADR 第 7、10 节。
- Scope or files: `crates/agentport-mosh-attach/**`、`mobile/src-tauri/src/{ssh,sftp,credentials,mosh}/**`、`mobile/src/terminal/**`、`mobile/src/features/transport-spike/**`；root/移动 lockfile 由协调者串行更新。
- Expected output: 双端 buildable transport plugin；direct/jump SSH、逐跳 TOFU、SFTP 原子 transfer、secure credential handle、xterm touch/IME basics、GPL Mosh source build、普通 Shell 与现有 AgentPort Host Session attach。
- Dependencies: T-005, T-006.
- Execution steps:
  1. 在 iOS latest 与 Android API29 环境编译并运行 SSH/SFTP、secure storage 和 terminal spike。
  2. 从源码构建 Mosh client binding；通过 SSH bootstrap 启动普通 Shell 与 `agentport-mosh-attach`。
  3. 验证 Host Token 不出电脑、output 先脱敏、input FIFO/resize、UDP/roaming、SSH control independent recovery 和不重复 writer。
  4. 固定通过验证的版本/API；失败则记录具体平台、命令和唯一解锁条件。
- Acceptance criteria:
  - ADR Gate C 全部通过；任何 SSH mock、普通 Mosh Shell 或仅单平台结果都不能替代 AgentPort Session 双端证据。
  - 移动 GPL 边界和对应 source build 可复现。
- Verification method:
  - iOS/Android build + simulator/emulator fixture；SSH/SFTP/Mosh network fault tests；terminal/credential plugin tests。
- Validation evidence: T-017 prerequisite gate complete. SSH/SFTP/credential foundation pins `russh=0.62.7`, `russh-sftp=2.4.0`, OS-keyring-only opaque handles; real fixtures prove strict first-seen/changed-key rejection, password and imported/generated Ed25519 auth, single jump with per-hop TOFU, bounded Bridge v1.1 stdio, and atomic OpenSSH SFTP operations. Signed Android API29 and iOS 26.5 simulator probes prove Keystore/Keychain writes and cleanup, xterm touch/IME/special keys and Android real Select-all. Reproducible GPL Mosh builds are pinned in `mobile/native/mosh/versions.env`; both platforms prove ordinary Mosh and `agentport-mosh-attach` to an existing Host Session, output/input/resize/stop, actionable UDP-unreachable state, and SIGSTOP/SIGCONT UDP recovery while independent SSH Bridge control remains successful, with exactly-once durable markers. Android private-key SSH bootstrap→AgentPort Session passed with marker `AGENTPORT_ANDROID_SSH_BOOTSTRAP_OK`. Signed simulator builds use `mobile/scripts/build-ios-simulator.sh`. The final iOS private-key SSH bootstrap keeps the Mosh key native via `mobile_mosh_bootstrap_start`, then passes AgentPort Session output/input/resize/stop with `AGENTPORT_IOS_SSH_BOOTSTRAP_OK` exactly once; App PID 62275 and Host PID 86866 remained alive, screenshot `/tmp/agentport-mobile-ios-ssh-bootstrap-passed.png` is nonblank and passed (1206×2622, SHA-256 `538641032d02359bb95ac572eb2e70167d6bc6ef5f8c6a5837d68984090dde78`). The fixture Session was authoritatively stopped and all sshd/key/source roots removed. Host redaction focused E2E confirms secret bytes never enter its live output; `agentport-mosh-attach` decodes only that projected terminal stream and has no raw PTY path, so Mosh receives only pre-redacted bytes. Lifecycle review caps native Sessions at 16, reaps abandoned exited entries under cap pressure without sacrificing normal final polling, makes stop/exited races idempotent, and signals all live native threads on App-state drop. Packaging includes `agentport-mosh-attach` in macOS/Linux sidecars; rebuilt workspace debug bundle contains it, strict codesign passed, exact debug GUI path was PID 36264, and `/tmp/agentport-debug-t017-packaging.png` was nonblank. Final focused verification: mobile Web 7/7 + production build; mobile Rust 13/13 + doc-tests; Host `secret_redaction`; attach 2/2; iOS simulator and Android API29 target checks; shell syntax and scoped diff check. iOS deployment target remains 16.0, while runtime evidence remains limited to the user-approved iOS 26.5 simulator.
- Blocker: None.
- Unblock condition: T-005、T-006 done，且所需本地/CI mobile toolchains 可用；条件已满足，按 iOS 26.5 waiver 执行。

### [ ] T-018 — 移除全部移动生物识别与凭据租约

- Status: blocked
- Owner: coordinator
- Objective: 按用户修订后的安全边界删除 iOS/Android 生物识别、credential lease 及其产品/探针/配置/依赖代码，同时保留系统安全存储。
- Inputs and prerequisites: 用户确认的 Q-002；T-017/T-007 当前 secure-storage 与连接实现。
- Scope or files: `mobile/src-tauri/src/{credentials,ssh,remote,sftp,mosh}/**`、移动 Host/transport probes、Cargo/config/generated permission schema、PRD/ADR/task 文档及相关测试。
- Expected output: 连接和有限重连按 opaque credential handle 即时读取 Keychain/Keystore；无生物识别插件、命令、权限、usage description、lease state、UI 或测试路径。
- Dependencies: T-007, T-017.
- Execution steps:
  1. 删除 plugin/lease 原生状态和命令，将 SSH/SFTP/Mosh/Remote 改为按 credential ID 从安全存储短暂读取并 zeroize。
  2. 删除前端 unlock/probe 流程与平台配置，更新测试和生成 schema。
  3. 同步 PRD/ADR/任务门禁并执行 Web、Rust、双 target、iOS/Android artifact 扫描与运行验证。
- Acceptance criteria:
  - 全部产品源、依赖、权限/schema 和最终移动产物不含生物识别或 credential lease 功能。
  - Keychain/Keystore 不降级为普通存储；密码/私钥仍不进入 profile、日志或导出。
  - SSH/SFTP/Mosh/Remote 编译与相关测试通过，iOS simulator 与 Android API29 artifact 可启动且不出现认证弹层。
- Verification method:
  - scoped source/artifact scan；Web/Rust tests；iOS/Android target check/build/install/launch；安全存储与 SSH fixture。
- Validation evidence: 产品源、Cargo/npm 依赖、iOS plist、五份 permission schema 与生成 Android 源码的精确扫描均不含 biometric plugin、lease command/state、usage-description 或前端 unlock marker；系统安全存储 opaque handle 保留。Web 9 files/24 tests 与 production build、Rust 19/19 + all-target、iOS simulator target、Android arm64 target checks 均通过。iOS 26.5 隔离 OpenSSH 产品 actor 真实完成私钥 Keychain 写入、首次 TOFU、按 profile credential ID 直接连接、Bridge v1.1 `boot`、断开及 actor profile/credential/trust cleanup，全程无认证弹层；`/tmp/agentport-t018-product-actor.png`（1206×2622，SHA-256 `c303b4226892b4c911a5dc95022d1235e48b3b9670f21c5f6ef7a66c2572635a`）。fixture PID/目录已删除，既有外部 sshd PID 47443 与 simulator 内用户已有 `W` profile 未改动。随后无 probe env 的 clean iOS bundle 重建，deep/strict codesign 及精确 artifact marker scan通过，Info.plist 无 `NSFaceIDUsageDescription`；安装启动非白屏且无认证 overlay，`/tmp/agentport-t018-clean-final.png`（1206×2622，SHA-256 `8260ca12096e2674e39596426fa1b64b2dc1cf3a3376a08f2c78f75f39763ec2`）。Android Rust library 已重新编译，但 APK wrapper 尚未产出，不能声称 Android runtime gate 通过。
- Blocker: Android Gradle 配置所需 Kotlin 2.0.21 artifacts 未缓存，Maven Central、repo1 与 search.maven.org 在当前网络均返回 HTTP 403；`android build --debug --apk --target aarch64 --ci` 在 Rust arm64 library 成功后于 `:buildSrc` dependency resolution 失败。不得在未获批准时引入第三方镜像。
- Unblock condition: 提供团队批准且可访问的 Maven/Gradle mirror/cache，或 Maven Central 访问恢复后完成 APK 构建、精确 artifact scan、API29 安装启动与无认证弹层检查。

### [x] T-007 — 集成 SSH、凭据、主机信任与 Bridge 最小闭环

- Status: done
- Owner: coordinator
- Objective: 从移动端完成主机配置、密码/密钥系统安全存储、逐跳 TOFU、单级跳板和 Bridge 连接闭环。
- Inputs and prerequisites: T-017 已证明并冻结 transport/plugin API。
- Scope or files: `mobile/src/features/hosts-auth/**` 与端到端 fixture；复用 T-017 plugin，不并发修改共享 schema/lockfile/native plugin。
- Expected output: 主机 CRUD、Ed25519 生成/导入绑定、手动多主机连接、能力协商、错误与断线状态。
- Dependencies: T-017.
- Execution steps:
  1. 实现凭据安全存储和按 opaque handle 的即时读取。
  2. 实现直连、单跳、逐跳 host key 与 SSH stdio Bridge。
  3. 建立自动重连、结果未知和不重放门禁。
- Acceptance criteria:
  - AUTH-01 至 AUTH-09、HOST-01 至 HOST-08、NET-01/05/06 与修订后的 AC-01、AC-02、AC-05、AC-19、AC-20 通过。
- Verification method:
  - 单元、模拟器和本地 SSH fixture e2e。
- Validation evidence: native profile store 覆盖 256 条上限、CRUD/复制/排序/启停、IPv4/IPv6/非默认端口、单级跳板、Mosh UDP 参数、共享 opaque credential 引用和 endpoint-scoped trust；删除可独立选择凭据与指纹，共享凭据 fail closed。Host UI 接入密码安全存储、OpenSSH 导入、Ed25519 生成、TOFU/changed-key hard block、逐跳确认、连接取消与中英文状态。HOST-06 使用 Argon2id（19 MiB/t2/p1）+ AES-256-GCM 加密导入导出，并排除 credential/trust。persistent SSH stdio Bridge actor 完成 typed v1.1 hello/capability negotiation、最多 5 台在线/连接中、1/2/4 秒有限重连和主动取消；Remote request 按共享 protocol 分类，断线后 accepted 或所有 write 均返回 `unknown` 且不重放，未 accepted read 返回 `not_executed`。T-017 的直连密码/导入密钥/生成 Ed25519、单跳逐跳 TOFU/changed-key、UDP 不可达与恢复和断线不重放证据，与本任务产品 actor E2E 共同覆盖 AC-01/02/05/19/20。iOS 26.5 simulator 上的真实产品流程已通过：临时私钥写入 Keychain、首次连接精确 TOFU、保存 trust、persistent actor Bridge v1.1 协商、真实 `boot` request、disconnect，以及 profile/credential/trust cleanup；运行截图 `/tmp/agentport-t007-product-running.png` 为 1206×2622、SHA-256 `ae5d83bbaa1e4ecc9b59ab72528eee05f4a8dff1d1c542219aa93f19bbbbc7ca`。隔离 sshd log 证明 simulator public-key auth/command session，Bridge 创建隔离数据库；清理后 profile 为 `[]`、trust 为 `{}`，fixture sshd/key/data/env 均删除。随后 clean rebuild 的 bundle 经直接字节检查不含 fixture fingerprint/private-key base64，已重新签名、安装和运行；`/tmp/agentport-mobile-t007-clean-final.png`（1206×2622，SHA-256 `40ccb838497a6374b41425d731ee3a695aa9147dd2b52d0933d5f4651775e370`）显示无主机首页且非白屏。运行中 Simulator 的 Apple Accessibility bridge 验证 `Your computers` heading、Import/Export/Add host 与底部导航按钮，以及 Add Host 表单的 heading、Close、文本框和下拉框均有正确 role、非空 description/value 与非零 frame；这是 runtime semantic evidence，不冒充完整 VoiceOver walkthrough。临时 XCUITest 路线因 iOS 26.5 WebKit 同时加载 `WebCore.axbundle`/`WebKit.axbundle` 后 snapshot query timeout 而放弃，测试 target 和工程修改已移除。最终复验：mobile Web 10/10、production build、mobile Rust 20/20；此前 iOS simulator/Android API29 target checks 仍通过。
- Blocker: None.
- Unblock condition: T-017 done。

### [x] T-008 — 实现多主机首页与 Session 核心体验

- Status: done
- Owner: coordinator
- Objective: 实现聚合首页、Session 对话/终端、状态、未读、并发输入和重连续接核心闭环。
- Inputs and prerequisites: T-007 稳定 connection/client contract。
- Scope or files: 移动 dashboard/session features 及测试；不得修改其他 feature。
- Expected output: DASH-01 至 DASH-05、SES-01 至 SES-10、结构化卡片 fallback、终端特殊键和多 Session 标签。
- Dependencies: T-007.
- Execution steps:
  1. 实现主机/Session 聚合和缓存状态标记。
  2. 实现对话、完整终端、生命周期控制和历史。
  3. 验证多客户端输入批次与断线游标。
- Acceptance criteria:
  - PRD AC-03 至 AC-06、AC-08、AC-12 的相关部分通过。
- Verification method:
  - 组件、协议 fixture、并发与断网 e2e。
- Validation evidence: Dashboard/Session 产品层现已覆盖 5-host 聚合与离线缓存标识、主机/项目/Agent/attention 筛选、创建参数与风险确认、规范化对话/完整 xterm 切换、512 KiB 有界 tail 与原生 history、搜索/字号/复制粘贴/特殊键、结构化卡片 fail-safe fallback、实时 push、多客户端 typing 提示、UTF-8 原子输入批次、本地发送队列、cursor/resync、生命周期操作、归档恢复删除及多 Session 标签。协议 fixture 发现并修复真实 Remote `HostFrame` 的 snake_case `session_id` 和输出字段 `data` 兼容性，回归测试同时覆盖 camel/snake payload。iOS 26.5 simulator 的隔离 OpenSSH 产品 actor 两阶段 E2E 真实完成 Keychain 私钥、TOFU、Bridge、project/session create/list、两 attachment 并发输入；两个输入 marker 各出现一次且 sequence 不同。外部 `simctl terminate` 后电脑 Host/child 仍存活，重启 App 从保存 cursor attach 时旧 marker 未重复且新 marker 精确一次；随后 authoritative stop 返回 `groupCleaned:true`，archive/list/unarchive/archive/permanent delete、disconnect 与 profile/credential/trust cleanup 全部通过。Phase 1 截图 `/tmp/agentport-t008-phase1.png` SHA-256 `88b1e6f353c2fd6b66482ef8998315d5f3ea12d0793e4aa8ecbeff5e6889232e`；最终产品 actor 截图 `/tmp/agentport-t008-passed.png` SHA-256 `f412606f9c99f8ef0bb163b1dbc62a413099092d11c1b66bc4e86011bdcb75d1`。fixture sshd/key/data 均已删除；一次因仅依赖 sshd `SetEnv` 造成的默认 AgentPort DB 误写已通过真实 facade 精确清理并复验 project/session 均为 0。PERF-05 固定 5 台 online host/100 Session，先进行 10 帧非计分 warm-up，再执行 100 次筛选和 100 个滚动帧：iOS 26.5 为 p95 28.0 ms、>50 ms 0 帧，截图 `/tmp/agentport-t008-perf-ios.png` SHA-256 `69dc7dc69e7f4f3a20ffa32524cf43e4ede60d3aff06ab7008afc7fe7096c850`；Android API29 arm64 emulator 为 p95 118.4 ms、>50 ms 1 帧，截图 `/tmp/agentport-t008-perf-android.png` SHA-256 `ca23451414cee078e1ee8f19d9be69390b92cc17544b34642c2c2fe3ea3e8c58`。列表项使用 `content-visibility`/intrinsic containment 后 Android 从 9 个慢帧降至计分 warm-up 后 1 个，符合 1% 门槛。最终 `cd mobile && npm test -- --run` 为 7 files、17/17；`npm run build` 通过（仅既有 >500 kB chunk warning）；无 probe env 的 iOS clean bundle deep/strict codesign 通过，且扫描不含 `T008 Product Fixture`、`T008_ATOMIC_A`、performance probe heading/result marker，未声称已删除 fixture key bytes 的直接扫描。clean bundle 已安装并显示非白屏空 Host 首页；`/tmp/agentport-mobile-t008-clean-final.png` SHA-256 `46d7391e0a1e65a83a5fc697453a13c12a3598164ba5b9805deee113664d4815`。iOS deployment target 仍为 16.0，但本任务 runtime 证据仅来自用户已接受的 iOS 26.5 simulator；未运行 iOS 16 runtime。
- Blocker: None.
- Unblock condition: T-007 done。

### [x] T-009 — 实现 Agent、Project、Worktree 与 Git 等价

- Status: done
- Owner: coordinator
- Objective: 完成 PAR-01 至 PAR-14 的移动业务工作流和安全确认。
- Inputs and prerequisites: T-007、T-005 的完整业务 facade。
- Scope or files: 移动 agents/projects/worktrees/git feature 目录及测试。
- Expected output: 探测/候选/预设、项目、六 Adapter、恢复/权限、Worktree、分支、Changes、History/Remote、Commit/AI。
- Dependencies: T-007.
- Execution steps:
  1. 按 PAR ID 实现 view model 与移动页面。
  2. 保留危险操作预检、Git 参数安全与错误语义。
  3. 对六 Adapter 建立数据驱动验收。
- Acceptance criteria:
  - PAR-01 至 PAR-14 与 AC-07、AC-21 相关部分通过。
- Verification method:
  - feature tests、Bridge contract tests、Git fixture e2e。
- Validation evidence: Workspace 产品层覆盖六 Adapter 探测/候选/手动远端路径、能力/恢复/Hook/传输/权限呈现、排序/隐藏/恢复及 future preference 保留；Project 远端目录、添加/重命名/置顶/排序与 authoritative removal preflight；Worktree preview/create/Base Ref/分支模式/status/reconcile/removal preflight；branch create/create-switch/switch/delete 与 auto-stash restore/cleanup；checkout-scoped token-fenced Changes/diff/stage/unstage/discard/ignore/trash/file resolve、fetch/pull/rebase/autostash/push/force-push、paged History/detail/patch、AI message、Review 与 confirmed commit。真实 iOS 26.5 隔离 OpenSSH actor 通过 Keychain 私钥、TOFU、Bridge v1.1、六 Adapter registry、Generic Shell 手动候选、preference replace/restore、远端目录、Project layout、tokenized Git 全流程、commit/History、branch lifecycle、Worktree lifecycle、lossless decimal revision Project removal及 profile/credential/trust cleanup；截图 `/tmp/agentport-t009-product-final.png` SHA-256 `7a28dd50d8976fce365a8bec50c55b8f1359ec02387a4262d49b46743c85aec9`。actor 暴露并修复 `project.remove` 将含 computed preflight 字段原样发送而被 strict `deny_unknown_fields` 拒绝的问题；回归测试要求只发送六个 authoritative echo 字段并保留 `9007199254740993` precondition，结构化 Bridge error 也不再显示 `[object Object]`。隔离 DB 的 Project/Worktree/Session/branch/commit rows 均为 0，临时 branch/worktree、sshd、key/data/env 已删除；simulator profiles `[]`、trust `{}`。删除 key 前直接扫描 fixture bundle 未发现 raw private-key bytes。最终 Web 8 files/21 tests 与 production build 通过（仅 >500 kB warning）；无 probe env 的 iOS bundle deep/strict codesign 通过，且扫描不含 fixture path、fingerprint、probe heading、profile name或 commit marker。clean bundle 已安装并显示非白屏空 Host 首页；`/tmp/agentport-mobile-t009-clean-final.png` SHA-256 `d0e0a15d3224fea465c33cf9485471affa3d43537b392cd6d8527555e61fab63`。结合 T-008 的 Session/多标签/authoritative stop 与 T-017 的 Hook/global-config、redaction及六 Adapter native safety evidence，PAR-01 至 PAR-14 和 AC-07/AC-21 本任务相关门禁通过。iOS target 仍为 16.0，runtime evidence 仅 iOS 26.5。
- Blocker: None.
- Unblock condition: T-007 done。

### [ ] T-010 — 实现文档、搜索、时间线、导出与备份等价

- Status: in_progress
- Owner: coordinator
- Objective: 完成 PAR-15 至 PAR-20 和远端产物下载/恢复上传流程。
- Inputs and prerequisites: T-007、Remote Bridge file transfer contract。
- Scope or files: 移动 documents/search/timeline/export/backup features 及测试。
- Expected output: 文档树/编辑/Markdown/Mermaid、搜索定位、时间线、导出、备份创建验证恢复、旧日志/索引管理。
- Dependencies: T-007, T-018.
- Execution steps:
  1. 实现只在对应业务入口需要的文件 transfer。
  2. 保持导出/恢复原子性和正文边界。
  3. 添加中断、冲突和大文件测试。
- Acceptance criteria:
  - PAR-15 至 PAR-20、AC-07、AC-11 相关部分通过。
- Verification method:
  - feature tests、fixture integration、文件失败原子性 e2e。
- Validation evidence: 第一产品切片已加入第五个 Content 导航和 host-scoped Documents/Search/Timeline/Storage 页面：bounded remote directory/read、create-new file/folder、原子文本保存与 truncated save block；安全 Markdown preview 和 Mermaid `securityLevel: strict` 动态 SVG；global metadata/native-history search、partial/rotated-away 显示与 index rebuild；exact rendered snapshot timeline ack；Session `.md`/`.json`/diagnostics `.zip` 远端导出、backup create+verify/list/verify/restore-to-new-directory、native history 分页、legacy inventory/active protection/confirmed selected deletion。当前明确将 artifact download 标成需 Files/SFTP 显式后续，未伪装已下载；受控 download/upload、中断/冲突/大文件 actor 尚待完成，因此 T-010 保持 `in_progress`。Focused Content tests 3/3，full Web 9 files/24 tests，production build passed；Mermaid 按需拆分为独立 chunks，base bundle 仍有 >500 kB warning。clean iOS 26.5 simulator bundle 已重建、安装并显示非白屏五项导航；`/tmp/agentport-mobile-t010-foundation.png` SHA-256 `b9ddb04a4125751d7968ffcb2e28af4c796fbe6864adde65008a19cc5cc7772f`。
- Blocker: None.
- Unblock condition: T-007 done。

### [ ] T-011 — 实现 Secret、设置、诊断与移动系统替代

- Status: pending
- Owner: unassigned
- Objective: 完成 PAR-21 至 PAR-27，保持 Secret 脱敏与无明文回退，并实现移动替代/平台不适用登记。
- Inputs and prerequisites: T-007、T-005 security contract。
- Scope or files: 移动 secrets/settings/diagnostics/system-adapters features 及测试。
- Expected output: Secret、Commit AI 凭据、设置、通知设置、诊断、主题/i18n、桌面系统能力替代矩阵。
- Dependencies: T-007, T-018.
- Execution steps:
  1. 实现 Secret 元数据操作但不缓存原值。
  2. 实现设置和诊断下载/分享。
  3. 验证实时输出只接收 `[redacted]` 结果。
- Acceptance criteria:
  - PAR-21 至 PAR-27、AC-07、AC-13、AC-14、AC-21 相关部分通过。
- Verification method:
  - feature、安全存储、脱敏和依赖扫描测试。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: T-007 done。

### [ ] T-012 — 实现独立 SSH Shell 与完整 SFTP

- Status: pending
- Owner: unassigned
- Objective: 交付多标签普通 Shell 和账户权限范围内完整 SFTP 文件管理。
- Inputs and prerequisites: T-007 SSH transport 与 T-006 终端容器。
- Scope or files: 移动 shell/sftp features、文件 transfer core 与测试。
- Expected output: TERM-01 至 TERM-05、SFTP-01 至 SFTP-07、上传后向 Session 发送远端路径。
- Dependencies: T-007, T-018.
- Execution steps:
  1. 实现 Shell 标签生命周期、终端交互和清晰身份区分。
  2. 实现 SFTP 浏览与全部操作、确认、进度、临时文件原子落位。
  3. 覆盖 symlink、权限、磁盘满、冲突、取消和断网。
- Acceptance criteria:
  - AC-09、AC-10、AC-17 通过。
- Verification method:
  - SFTP fixture、故障注入、终端组件与模拟器 e2e。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: T-007 done。

### [ ] T-013 — 实现 Mosh 双通道与漫游

- Status: pending
- Owner: unassigned
- Objective: 实现 Mosh 实时终端 + SSH 控制通道、网络漫游和受限能力提示。
- Inputs and prerequisites: T-007 与 T-017 已验证的原生 Mosh/AgentPort attach 集成。
- Scope or files: `mobile/src/features/mosh/**`；`mobile/src-tauri/src/mosh/**` 只在 T-017 handoff 后串行扩展，含 fixture 与测试。
- Expected output: NET-02 至 NET-04、普通 Mosh Shell、AgentPort Session attach、UDP 直达检测、缺依赖指引和 SSH fallback 建议。
- Dependencies: T-007, T-017, T-018.
- Execution steps:
  1. 集成/封装 mosh client 与 server bootstrap。
  2. 保持控制/实时通道独立状态和恢复。
  3. 注入 UDP 不可达、网络切换和缺 `mosh-server` 场景。
- Acceptance criteria:
  - AC-02、AC-06、AC-17 的 Mosh 部分通过。
- Verification method:
  - transport unit、容器/VM server fixture、模拟网络 e2e。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: T-007、T-017 done。

### [ ] T-014 — 实现通知、数据边界、配置迁移与多主机恢复

- Status: pending
- Owner: unassigned
- Objective: 完成在线通知、本地最小数据、加密主机配置迁移和多主机连接恢复策略。
- Inputs and prerequisites: T-007 connection contract、T-008 dashboard state。
- Scope or files: 移动 notifications/local-data/profile-transfer features 与测试。
- Expected output: NOTIFY-01 至 NOTIFY-05、DATA-01 至 DATA-06、配置加密导入导出、缓存过期标识。
- Dependencies: T-007, T-008, T-018.
- Execution steps:
  1. 实现短时后台通知和明确离线限制。
  2. 实现最小加密持久化、无正文缓存和凭据排除。
  3. 验证任务切换器与 App 锁按已确认边界不额外处理。
- Acceptance criteria:
  - AC-12、AC-13、AC-14、AC-19 相关部分通过。
- Verification method:
  - lifecycle tests、存储/导出扫描、模拟器通知测试。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: T-007、T-008 done。

### [ ] T-015 — 跨功能安全、性能、无障碍与兼容硬化

- Status: pending
- Owner: unassigned
- Objective: 对完整实现执行协议兼容、容量、性能、安全、无障碍和国际化硬化。
- Inputs and prerequisites: T-008 至 T-014 全部功能输出。
- Scope or files: 测试/基准/修复所需的任务文件、发布验证脚本和报告；不扩大功能。
- Expected output: PERF-01 至 PERF-06、AC-08、AC-13 至 AC-16、AC-21 的当前证据与修复。
- Dependencies: T-008, T-009, T-010, T-011, T-012, T-013, T-014, T-018.
- Execution steps:
  1. 运行 5 主机/100 Session、终端吞吐和输入延迟基准。
  2. 运行凭据/日志/导出/监听端口/重放/脱敏安全测试。
  3. 使用 VoiceOver/TalkBack 模拟器能力和语义测试完成核心流程。
- Acceptance criteria:
  - 第 7、8、10 节及 AC-08、AC-13 至 AC-16、AC-21 通过；限制如实记录。
- Verification method:
  - ADR 冻结的 benchmark、安全扫描、a11y 与兼容命令。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: T-008 至 T-014 done。

### [ ] T-016 — 全量集成、双端制品、桌面 debug 验证与提交

- Status: pending
- Owner: coordinator
- Objective: 完成全仓验证、模拟器制品、构建/签名文档、桌面 debug 可视验证、任务状态和隔离提交。
- Inputs and prerequisites: T-001 至 T-015 及 T-017 done；初始脏文件快照。
- Scope or files: 本任务所有已实现路径、authority document、最终验证报告；不得包含 F-008 无关改动。
- Expected output: 可启动 iOS/Android 开发制品、完整验证证据、debug App 截图、最终 task document 和单一 feature commit。
- Dependencies: T-001, T-002, T-003, T-004, T-005, T-006, T-007, T-008, T-009, T-010, T-011, T-012, T-013, T-014, T-015, T-017, T-018.
- Execution steps:
  1. 审查完整 diff、依赖和 PRD traceability，运行全量 Rust/Web/Mobile tests/build。
  2. 启动最低版本 iOS/Android 模拟器并截图确认非空白与关键闭环。
  3. 若桌面行为改变，按 AGENTS.md 重建、精确重启 debug App、核对进程并截图。
  4. 完成构建/签名/已知限制文档，更新所有状态和 validator。
  5. 只 stage 本任务路径，核对 staged diff，提交并复核无关改动仍未提交。
- Acceptance criteria:
  - AC-001 至 AC-011（本任务计划）与 PRD AC-01 至 AC-21 均有当前通过证据。
  - final validation 为 `passed`，任务 commit 隔离正确。
- Verification method:
  - 全仓测试/build、iOS/Android simulator smoke、`scripts/rebuild-debug-app.sh`、进程/截图、task validator、staged diff audit。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: T-001 至 T-015 及 T-017 done。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. **架构/协议**：ADR traceability；wire schema golden tests；版本/能力协商、幂等、结果未知、游标去重、多客户端、无公网监听。
2. **Rust/Core/Bridge**：targeted unit/integration、workspace tests、CLI/GUI关闭 e2e、Host Token/进程组/脱敏/Git 参数安全回归。
3. **移动单元/组件**：host/auth/store/router、所有 feature view model、终端、SFTP、i18n、a11y semantics。
4. **连接 e2e**：密码/密钥、逐跳 TOFU、断网/重连/不重放、SSH/Mosh、UDP 不可达、缺依赖、多客户端原子输入。
5. **业务等价**：PAR-01 至 PAR-27 与六 Adapter 数据驱动矩阵；Project/Session/Worktree/Git/文档/搜索/导出/备份/Secret/诊断。
6. **故障与安全**：权限拒绝、磁盘满、冲突、取消、半文件、敏感存储/日志/导出扫描、监听端口、依赖网络/遥测扫描。
7. **非功能**：5 主机/100 Session、PERF-01 至 PERF-06、最小系统模拟器、VoiceOver/TalkBack、`zh-CN`/`en-US`、主题/动态字号。
8. **全量回归**：`cargo test --workspace --all-targets`、现有前端 `npm test`/i18n/build、移动双端 tests/build/smoke。
9. **可视交付**：iOS/Android 模拟器截图；涉及桌面行为时按 AGENTS.md 重建精确 debug App、核对 executable path、截图非白屏。
10. **提交隔离**：每批 `git diff --check`，最终 staged path audit、task validator 和单一任务 commit；F-008 原改动保持未提交。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- R-001（高）：PRD 是完整产品级范围，通常跨多个迭代；必须以 task 状态和可运行证据为准，不能因生成大量骨架或 mock 宣称完成。
- R-002（高）：Mosh 客户端、iOS/Android binding、许可证和模拟器 UDP 行为可能成为技术 blocker；T-001/T-003/T-004 必须先证明可构建路径。
- R-003（高）：本机可能缺 Android SDK、模拟器镜像、Rust targets 或可用 Xcode；不得自动购买、登录或修改证书，缺失时按具体命令证据标 blocked。
- R-004（高）：完整桌面等价若绕过 Core 会破坏 Host Token、进程组、Secret 脱敏和 Git 安全；Bridge 必须作为 Core facade，不复制规则。
- R-005（中）：移动后台和模拟器不能代表真机；只按确认边界验收并披露，不声称真机行为。
- R-006（中）：大吞吐终端需要区分 transport、parser、viewport 完成，避免 replay veil、首轮滚动和同步输出回归。
- R-007（中）：当前工作区存在并发脏改动，shared file/lockfile 冲突可能阻塞 writer；所有权不明时串行，绝不覆盖或提交无关修改。
- R-008（中）：完整 SFTP 访问 SSH 账户权限范围，误操作影响大；危险操作确认、临时文件原子落位和故障注入是 done gate。
- Current blockers: T-018 的 Android APK/runtime gate 被外部依赖访问阻塞：Gradle 所需 Kotlin 2.0.21 artifacts 未缓存，Maven Central 当前 HTTP 403；需要团队批准的 mirror/cache 或网络恢复。Apple catalog 已确认 iOS 16.0/16.4 runtime 不可下载；用户于 2026-09-02 接受仅以 iOS 26.5 继续开发与当前验收，该缺口保留为最终兼容性限制而非 dependency blocker。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-01 03:58 +0800: Task document created in execute mode from confirmed PRD and explicit implementation authorization.
- 2026-09-01 04:05 +0800: Recorded initial dirty-worktree boundary, PRD traceability, 16-task DAG and validation gates; T-001/T-002/T-003 moved to `in_progress` for parallel read-only analysis.
- 2026-09-01 04:33 +0800: Batch A reports integrated. T-001/T-002/T-003 marked `done` from read-only evidence. Recommended architecture is a separate Tauri 2 Mobile app plus Tauri-free `agentport-service` and stdio Bridge; toolchain probe found missing Android stack, Rust mobile targets and iOS 16 runtime.
- 2026-09-01 04:36 +0800: Verified workspace license is MIT (`Cargo.toml:13`) and upstream Mosh is GPLv3; upstream `COPYING.iOS` preserves GPL obligations. T-004 moved to `blocked` pending user license strategy Q-001.
- 2026-09-01 04:41 +0800: User selected a GPLv3-licensed separate mobile subproject while retaining MIT for desktop/Core/Service/Bridge/shared protocol. Q-001 resolved; T-004 resumed `in_progress`.
- 2026-09-01 04:54 +0800: T-004 ADR completed after two reviews. First review found circular transport gate, undefined Mosh→Host path, ownership gaps, missing Secret ingress and cursor mismatch; all were corrected. Final review accepted the revised architecture. T-004 marked `done`; T-005/T-006 started in parallel.
- 2026-09-01 09:44 +0800: Integrated T-005 foundation writer output; root workspace tests for the three new crates passed 13/13. T-005 remains `in_progress` with explicit missing vertical slices.
- 2026-09-01 09:49 +0800: Two T-006 writer attempts failed from model WebSocket errors; coordinator created the mobile scaffold. Web/unit/Rust host build/audit passed, but required mobile init/simulator verification is blocked by missing SDKs and third-party license acceptance. T-006 moved to `blocked` pending user authorization.
- 2026-09-01 09:54 +0800: User authorized local JDK/Android SDK/emulator/API29+latest/rustup targets installation, Android SDK license acceptance, and an official-channel iOS 16 runtime attempt. T-006 resumed `in_progress`.
- 2026-09-01 10:36 +0800: T-006 platform evidence updated. Android API29 debug APK rebuilt after registering `mobile_list_host_profiles`, installed and cold-launched with authoritative `No hosts yet` empty state. iOS project initialized after installing CocoaPods/libimobiledevice, iOS 26.5 arm64 debug bundle built and launched with the same nonblank state. Official Xcode catalog reports both iOS 16.0 and 16.4 arm64 runtimes unavailable; T-006 moved to `blocked` pending an official old runtime or fixed CI runner.
- 2026-09-01 14:02 +0800: T-005 Host FIFO and Session Remote vertical slices integrated. Two review rounds closed unbounded Host framing, false Ctrl-Z completion, replay cursor regression and macOS EOF/EINVAL lifecycle findings. Host full 34/34, Remote crates tests, workspace all-target check and desktop custom-protocol build passed. A real GUI-off CLI/Host/Bridge E2E completed hello/list/attach/input/poll/detach and verified process cleanup.
- 2026-09-01 14:40 +0800: T-005 authoritative stop and Secret write slices added. Remote stop now requires `group_cleaned` frame or matching durable PID/run proof; real Bridge E2E returned `groupCleaned:true` and left zero Host processes. Secret metadata/preset linkage is one SQLite IMMEDIATE transaction after a unique staged system credential, with compensation on publication failure; DB atomicity test passes, while real Keychain test remains intentionally ignored because it requires interactive system-store access. T-005 remains `in_progress` for async push, full PAR facade and installed-artifact smoke.
- 2026-09-01 14:45 +0800: Prepared `.github/workflows/mobile-ios16.yml`, a manual fixed-runner gate that refuses latest-runtime substitution and captures an iOS 16 simulator screenshot. No matching self-hosted runner is currently available or authorized, so T-006 correctly remains `blocked`; workflow existence is not pass evidence.
- 2026-09-01 14:44 +0800 (system clock observed): Reopened the latest rebuilt debug bundle using exact executable PID matching only. New GUI PID 33286 is the workspace debug executable; packaged Bridge exists and deep/strict codesign passes. Activated the exact process, confirmed a visible layer-0 1200×800 window, and captured `/tmp/agentport-debug-mobile-bridge-latest.png`, which is fully rendered and nonblank. No release GUI or `agentport-host` was stopped.
- 2026-09-01 14:44 +0800 (system clock observed): Started bounded read-only T-005 analyses for async push, PAR facade mapping, and installed-artifact smoke. Analyses confirmed the remaining gaps and proposed a single stdout writer/subscription barrier design, complete PAR ownership map, and safe installed-package harness; isolated writers started for async push and installed smoke. T-005 remains `in_progress`.
- 2026-09-01 19:32 +0800: Completed and reviewed the T-005 async push and installed-artifact smoke slices. Protocol/service/Bridge now pass 8+12+12 unit tests plus the no-listener integration test and all-target check. Reviews found and closed false clean-EOF gaps, stale ack reuse, unbounded batch-ID tombstones, and three functional-smoke false-PASS paths. Real target and packaged debug Bridge v1.1 E2Es observed unsolicited output Events without `session.poll`, preserved client batch ID, proved authoritative stop/group cleanup and zero test Hosts. Rebuilt/signed debug bundle, exact-restarted PID 30476, and captured the nonblank latest window. T-005 remains `in_progress` only for complete PAR facade and stronger real credential-store evidence.
- 2026-09-01 21:37 +0800: Per user direction, stopped all subagent use and continued strictly in task order. Integrated PAR facade Batch 1, then manually fixed all five review findings. Desktop and Remote Project removal now echo lossless complete snapshots and fail closed on unproven Host cleanup; Project fences cover Session/Worktree/branch/commit creation; `secret.status` is non-retryable; unknown future adapter preferences round-trip; Project digest revisions cross JS as decimal text. Focused frontend 8/8/build, Core DB/branch/commit tests, remote 9+17+14/no-listener, and Tauri check passed. T-005 remains `in_progress` for subsequent facade batches.
- 2026-09-01 22:04 +0800: Manually completed the T-005 Session metadata/lifecycle facade sub-batch without subagents. Added lossless Session rename/pin/archive/history/attention/recovery operations and zeroizing structured prompt/auto-title ingress; archive is fenced before authoritative stop and rolls back only its own generation on failure, recovery reads are bounded and log-generation fenced, and push structured commands stay behind the sole Host reader actor. Protocol/service/Bridge tests now pass 9+18+15 plus no-listener; scoped format/diff checks, three-crate all-target checks, Tauri all-target check, and task validator pass. T-005 remains `in_progress`; create/restart shared orchestration is next before Worktree/Git facade work.
- 2026-09-01 22:28 +0800: Extracted Session create/restart into the shared Tauri-free service and switched desktop commands to the same orchestration. Added Remote create/restart DTOs and dispatch, desktop-only launch fields with `skip_serializing`, risk-ack preservation, and explicit pre-side-effect `not_executed` versus post-side-effect `unknown` errors. Remote 9+19+15/no-listener and desktop 48 tests pass; all-target checks and diff/format checks pass. A real isolated Bridge create→push input/output→stop→restart→stop E2E returned `AGENTPORT_REMOTE_CREATE_RESTART_E2E_OK`, proved both group cleanups, and left no test Host. T-005 continues with Worktree/branch facade next.
- 2026-09-01 22:32 +0800: Rebuilt and signed the workspace debug App after the desktop thin-adapter migration. Precisely retained the live `agentport-host`, removed the stale debug GUI, and opened the rebuilt bundle as PID 36592 at the exact workspace executable path. Deep/strict codesign passes; `/tmp/agentport-debug-shared-session-launch.png` is 2940×1912, SHA-256 `b1fc6a21b3ecc33a1117917bdf6b28951f9bd35ab74d2f601854a3184f8d6960`, and visibly nonblank.
- 2026-09-01 23:06 +0800: Continued in task order with the Worktree facade: preview/reconcile/create/list/preflight/status/remove are now registered, strictly parsed and dispatched. Hardened Worktree deletion so its fence has a single owner and both desktop/Remote fail closed on unproven process-group cleanup, releasing only their own fence for retry. Remote 9+20+15/no-listener, desktop 48 tests, and the focused Core fence regression pass. T-005 continues with branch/Git facade.
- 2026-09-02 02:40 +0800: User explicitly waived the unavailable iOS 16 simulator runtime as a development/current-validation gate and authorized iOS 26.5-only validation. T-006 moved from `blocked` to `done` using its existing Android API29 and iOS 26.5 build/install/launch/nonblank evidence; deployment target remains 16.0 and the missing iOS 16 runtime evidence remains disclosed as a final compatibility limitation. Downstream tasks still wait for T-005 by dependency.
- 2026-09-02 02:59 +0800: Completed the Git Workspace and Branch Remote facade sub-batch manually and in task order. Bridge exact registry/prepare/dispatch now includes all Git/branch methods; Service strictly parses all params, reuses Core managers, reconciles optional all-project auto-stash listing, and rejects invalid restore strategies. Retry classification treats auto-stash listing as an idempotent write because reconciliation may persist journal state. Real temporary repositories cover token-gated staging and branch create/list plus strict rejection. Protocol 9, Service 22, Bridge 15 + no-listener, all-target checks for the three Remote crates and Tauri, rustfmt, and diff check pass. T-005 continues with Commit-AI and content/history/diagnostics/settings facade batches.
- 2026-09-02 03:18 +0800: Completed Commit-AI Remote facade and moved desktop commands onto the same Tauri-free Service implementation. Config credentials use a zeroizing direct DTO; staged system credentials and settings/metadata publish atomically, with compensation and rollback regression evidence. Generation preserves the desktop prompt/validation contract, forbids credential-bearing/redirecting provider URLs, bounds responses, and revalidates Git tokens after the provider call. Provider send ambiguity maps to `unknown`; API key markers do not reach Bridge stdout/stderr. Core atomic regression, Service 26, Protocol 9, Bridge 15 + no-listener, provider request/shape tests, Tauri all-target check, scoped rustfmt and diff check pass. T-005 continues with content/history/diagnostics/settings facade batches and real system-store evidence.
- 2026-09-02 03:31 +0800: Completed the content/history/settings/diagnostics facade sub-batch. Added bounded global/session transcript search, native history pagination, legacy-log inventory/confirmed deletion, transcript-body index purge, timeline reconciliation/snapshot acknowledgement, strict full Settings round-trip, and Host/summary/capability diagnostics. Retry policy accounts for timeline reconciliation writes; Bridge exact registry/prepare/dispatch completeness includes every method. Protocol 9, Service 27, Bridge 15 + no-listener, three Remote crate and Tauri all-target checks, scoped rustfmt and diff check pass. T-005 continues with documents/export/backup and real system-store evidence.
- 2026-09-02 03:46 +0800: Completed documents/export/backup and closed T-005. Added bounded document read/list, atomic content write with zeroizing ingress, create-new file/directory, host-side session/diagnostics export, and verified create/list/verify/restore-to-new-root backups with strict absolute paths. Full Protocol 9, Service 27, Bridge 15 + no-listener, desktop 43 tests, all Remote/Tauri all-target checks and diff check pass. Existing installed-artifact/GUI-off E2E evidence remains valid for Bridge transport and packaging; final rebuilt artifact is reserved for T-016. Interactive host Keychain writes were not performed without explicit credential-write authorization; T-017 owns current dual-platform secure-storage runtime evidence. T-005 marked `done`; T-017 started sequentially under the iOS 26.5 waiver.
- 2026-09-02 04:06 +0800: Began T-017 with pinned mobile-native dependencies and executable credential/SSH foundation. Added OS keyring storage with no in-memory fallback and zeroizing credential paths, strict per-host TOFU/change rejection, russh password authentication, and bounded Bridge hello over remote stdio. Host tests pass 5/5. Initial direct target checks failed only because Homebrew cargo bypassed installed rustup targets and Android clang was not on PATH; rerunning with rustup 1.98 and explicit NDK API29 compiler passed both iOS simulator and Android arm64 target checks. No runtime transport/Mosh claim yet; T-017 remains `in_progress`.

- 2026-09-02 11:25 +0800: Closed T-017 after completing real private-key SSH bootstrap into an existing AgentPort Session. The Mosh bootstrap key now remains native, the final iOS marker appeared exactly once, lifecycle cap/abandoned-exit/stop-race handling was hardened, dual target checks and focused redaction/attach/Web/Rust tests pass, and every temporary Session, key, sshd and source fixture was removed. T-007 is now unblocked.

- 2026-09-02 11:28 +0800: Started T-007 manually after T-017 closed. Per the user constraint, no subagent is used; implementation is serialized in `mobile/src/features/hosts-auth/**` and reuses the frozen native transport commands.
- 2026-09-02 12:18 +0800: Completed the first T-007 product slice without subagents. Host CRUD/auth UI and Tauri adapter now cover secure password/key creation, copy/sort/enable/delete, optional jump/Mosh parameters, explicit TOFU and changed-key blocking. Native endpoint-scoped trust avoids carrying fingerprints across address changes; encrypted profile transfer uses Argon2id + AES-256-GCM and excludes credentials/trust. A persistent SSH stdio actor performs typed Bridge negotiation, bounded five-host admission, local event fanout, finite cancellable reconnect and fail-closed unknown-write handling with no replay. Web 10/10/build, Rust 20/20, and both mobile target checks pass. The real Rust SSH fixture now also exercises product typed hello plus persistent-channel `boot` accepted→result. A clean signed iOS 26.5 debug bundle (no fixture credentials) was rebuilt, installed and launched as PID 65760; `/tmp/agentport-mobile-t007-form2.png` (1206×2622, SHA-256 `ddd8627f5706c5168fe74dee60a34b08df499b7e6cb6bf6982afc5177b6447b0`) visibly confirms the Host page and full Add Host form. T-007 remains `in_progress` pending simulator product-actor and runtime accessibility evidence.
- 2026-09-02 13:05 +0800: Closed T-007 after the signed iOS 26.5 product actor E2E completed Keychain import, exact TOFU confirmation, persistent Bridge v1.1 negotiation, real `boot`, disconnect, and full profile/credential/trust cleanup against an isolated SSH fixture. The clean rebuilt bundle contains neither fixture fingerprint nor key bytes and is installed with the empty Host page visible. Runtime Apple Accessibility inspection verified named roles/values/nonzero frames for the Host page and Add Host form; this is semantic runtime evidence, not a claimed VoiceOver walkthrough. XCUITest was discarded after an iOS 26.5 WebKit duplicate AX bundle/snapshot timeout, with all temporary target changes removed. Final Web 10/10, production build, Rust 20/20, task validator and scoped diff checks pass. T-008 is unblocked.
- 2026-09-02 13:12 +0800: Started T-008 manually and without subagents. The implementation is limited to the mobile dashboard/Session feature, shared terminal presentation, App navigation wiring and focused tests, reusing T-007's stable `RemoteClient` connection/request/subscription contract.
- 2026-09-02 14:38 +0800: Closed T-008 after the iOS product actor proved GUI-off Session survival, two-client atomic batches, cursor resume without duplicates, authoritative cleanup and archive lifecycle; the real Bridge snake_case/data payload mismatch was fixed and regression-covered. PERF-05 passed on iOS 26.5 at 28.0 ms p95/0 slow frames and Android API29 at 118.4 ms p95/1 slow frame for 100 filters plus 100 measured scroll frames after a fixed 10-frame warm-up. Final Web 17/17/build and clean signed iOS install/nonblank checks pass; probe/fixture markers are absent from the clean bundle. T-009 through T-013 are dependency-ready, while execution remains serialized per user direction.
- 2026-09-02 14:40 +0800: Started T-009 manually and without subagents, after T-008 validation and task-document gates passed. Work remains serialized and scoped to mobile Agent/Project/Worktree/Git product workflows over the existing T-005 Remote facade.
- 2026-09-02 14:57 +0800: Completed the first T-009 product UI slice over the existing Remote facade. The new Workspace route covers six-Adapter discovery/candidate selection/manual remote path, exact/latest/unavailable and permission semantics, ordering/hide/restore with unknown future preference preservation; remote-folder Project add, canonical pin/order/rename and lossless revision preflight removal; Worktree preview/create/status/reconcile/preflight removal; branch create/switch/delete and auto-stash recovery; token-fenced Git Changes/diff/stage/unstage/discard/ignore/trash, remote sync, paged history/detail/patch, AI message, Review and confirmed commit. Destructive operations retain explicit target/impact confirmation. Focused tests prove disconnected gating, decimal revision preservation beyond JS safe integer, and exact tokenized stage params; full Web now passes 8 files/20 tests and production build. A clean iOS 26.5 simulator bundle rebuilt, installed and rendered with the new four-item navigation; `/tmp/agentport-mobile-t009-foundation.png` SHA-256 `27e33b1d7e0e7ff82a7f3fe711017498876c322639d67e9659becb82e8af07fc`. T-009 remains `in_progress` pending real Git/Worktree/Adapter actor coverage and final acceptance review.
- 2026-09-02 15:30 +0800: Closed T-009 after the iOS 26.5 product actor passed all isolated Agent/Project/Worktree/Git phases and full cleanup. The first actor run proved `/tmp` is canonicalized to `/private/tmp`; the next run reached Project deletion and exposed a real strict-protocol defect: the UI echoed computed preflight display fields into `project.remove`, which `deny_unknown_fields` correctly rejected. The product and actor now project only authoritative confirmation fields, preserve decimal revision text, and render structured Bridge failures. The rerun passed six adapters, remote paths, tokenized Git mutations, fetch, commit Review/History, branch and Worktree lifecycles, and Project removal. Isolated DB rows, simulator profiles/trust and all fixture processes/files were cleaned; raw key-byte and clean marker scans passed. Final Web is 8 files/21 tests plus production build; a final clean signed iOS bundle rebuild/install/nonblank check is recorded in T-009 evidence. T-010 is dependency-ready, with execution still manual and serialized.
- 2026-09-02 15:36 +0800: Started T-010 manually and without subagents after T-009's clean bundle and task-document gates passed. Work remains serialized and scoped to mobile document/search/timeline/export/backup and transfer workflows over the existing strict T-005 facade.
- 2026-09-02 15:48 +0800: Completed the first T-010 UI slice. Added Content navigation with host-scoped Documents, Search, Timeline and Storage workflows; document writes remain host-atomic and truncated previews are read-only, Mermaid uses strict dynamic rendering, timeline acknowledgement echoes only rendered snapshots, restore requires an explicit new target and confirmation, active legacy logs cannot be selected for deletion. Native history is paged separately from the live tail. Focused tests cover disconnected gating, exact remote read/write payloads and exact timeline ACK; full Web passes 9 files/24 tests and production build. Explicit artifact download/upload and real fixture failure gates remain, so T-010 stays `in_progress`.
- 2026-09-02 16:42 +0800: Completed all locally executable T-018 removal and iOS gates. Exact source/config/dependency scans are clean; Web 24/24, Rust 19/19/all-target and both mobile Rust target checks pass. A fresh iOS 26.5 OpenSSH product actor proved profile → Keychain credential handle → SSH/TOFU/Bridge v1.1 without an authentication overlay and cleaned only its isolated state; a subsequent clean signed bundle passed exact artifact scans and nonblank launch. Android Rust arm64 compilation also succeeds, but Gradle cannot resolve uncached Kotlin 2.0.21 artifacts because current Maven Central paths return HTTP 403. T-018 is `blocked` and blocks dependency release until an approved mirror/cache or restored access permits APK/API29 runtime verification.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: not_run
- Evidence: T-001 至 T-006 done；T-005 Bridge/Host FIFO/Session push与 authoritative stop、完整 PAR backend facade、无 listener、installed-artifact smoke 和真实 GUI-off E2E 均有记录；最新 Remote 9+27+15 tests、desktop 43 tests 与 all-target checks 通过。T-006 Web/Rust、Android API29 与 iOS 26.5 simulator smoke 通过。T-017 prerequisite gate 已完成并记录双端 runtime evidence。
- Limitations: T-007 至 T-016 产品任务尚未完成；iOS deployment target 16.0 缺对应 runtime smoke evidence但按用户 waiver 不阻塞开发；系统 secure-storage 仅有模拟器/模拟设备 runtime evidence，尚未在真实移动设备验证。
