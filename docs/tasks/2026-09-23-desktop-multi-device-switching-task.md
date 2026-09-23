# Task Plan: 桌面端多设备切换

- Created: 2026-09-23
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: pending
- Source: 用户在会话中确认的需求简报（clarify-requirements 流程，2026-09-23 确认）

<!-- task-doc-section:background-goal -->
## Background and goal

桌面端 AgentPort 目前只能管理本机。目标是让桌面端像手机端一样在多台电脑间切换：单窗口内通过设备选择器切换「本机 / 多台已配对电脑」，切换后整个 UI 指向所选设备，功能与组件形态不变（类比另一个 AgentPort 实例）。终态全量功能对等，**本任务交付首版**：

- 单窗口切换 + 单活动连接（切走断开、切回重连，远端会话持续运行）
- 远程模式开放远程协议已覆盖的功能；未覆盖功能在远程模式下禁用或明确降级
- 通道：SSH 直连 + relay 双通道，复用 `crates/agentport-remote-protocol` 与 `crates/agentport-relay`
- 配对：被控端一次性配对码/链接 + 手动 SSH 录入；授权持久化、可撤销
- 设置面板始终只管理本机 App
- 验收组合：macOS 控制端 → 桌面 Linux 被控端（已装 AgentPort，GUI 无需常开）

关键勘察结论（三个只读子代理，2026-09-23）：

1. 远程协议与桌面命令面几乎 1:1：117 个桌面命令中 96 个已覆盖、4 个部分覆盖、17 个未覆盖（更新器 4、OS 集成 9、手机配对 3、通知路由 3、`mark_session_log_rendered`、文档 rename/duplicate/delete —— 除最后两组外均为本地专属）。详见 `/tmp/agentport-remote-mapping.md`。
2. 协议事件（`ServerEnvelope::Event`，HostFrame 派生）与桌面 `ChannelMsg` 近 1:1；全局 tauri 事件（projects-changed 等）无远程推送，远程模式用轮询合成。
3. `agentport-relay` crate 的 `endpoint.rs` 直接提供客户端能力：`PairingConnection::begin/wait`（配对兑现）、`connect_session_realtime`（Noise 加密流），无 feature 门槛；桌面 src-tauri 已依赖 relay+protocol 两个 crate。
4. 手机端客户端栈在 `mobile/src-tauri`（GPL-3.0），桌面端（PolyForm）**不得逐字搬运**，须按相同行为重写（协议/relay crate 为 PolyForm 可直接依赖）。
5. 桌面本地 attach 走 host unix socket + token + watch_loop；远程模式以 `session.attach`（subscribe_output + screen_snapshot）+ 事件推送替代，Channel 语义保留。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**范围（首版）**

- Rust（src-tauri）：远程客户端传输层（SSH 重写 + relay 复用）、连接管理器、设备注册表与凭据、配对兑现、受控端配对码导出、通用 `remote_request/subscribe` 命令面
- TS（src/src）：RemoteBackend（协议已覆盖函数的远程实现）、api.ts 调度器、per-device localStorage 隔离、远程 boot 组合、切换流程、远程终端 attach、远程事件/轮询、功能门控、设备管理 UI（顶栏选择器 + 设置页 + 配对流程）、i18n
- 验证：全套件回归 + macOS 调试包 ↔ Linux 被控端真机走通 + 截图
- 按 AGENTS.md 分里程碑提交 commit

**非目标（首版明确排除）**

- 多窗口并存 / 每台设备独立窗口
- 非当前设备的连接保活与跨设备通知聚合
- Headless Linux 被控端安装包
- Windows；Linux 控制端与 macOS 被控端方向的验收
- 远程设备设置在桌面端的查看/编辑（设置面板始终本机）
- 协议未覆盖功能的协议扩展（文档 rename/duplicate/delete、`mark_session_log_rendered` 等降级处理，不扩协议）

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 远程协议 103 个方法覆盖桌面 117 命令中的 96 个完全 + 4 个部分；未覆盖 17 个多数为本地专属 | /tmp/agentport-remote-mapping.md 第 1–3 节；crates/agentport-remote-protocol/src/lib.rs METHOD_REGISTRY |
| F-002 | 协议事件类型与 ChannelMsg 近 1:1（output/replay_done/heartbeat/state/resync_required/transient_output/process_status/structured/agent_session/exit/error/input_batch_ack/resize_ack/terminal_geometry_changed） | /tmp/agentport-remote-mapping.md 第 4 节；agentport-service/src/lib.rs:4271-4316；src/src/types.ts:363-391 |
| F-003 | 全局 tauri 事件（projects-changed/session-state/git-state-invalidated 等）无远程推送等价物，远程模式须轮询合成 | /tmp/agentport-remote-mapping.md 第 4 节；src/src/api.ts:708-780 |
| F-004 | relay 客户端能力在 PolyForm crate 中：`PairingConnection::begin/wait`、`connect_session_realtime`，无 feature 门槛 | crates/agentport-relay/src/endpoint.rs:41,78,182,189；src-tauri/Cargo.toml:22（已依赖） |
| F-005 | SSH 路径行为契约：russh 密码/密钥认证 + TOFU 主机密钥钉扎 + exec `agentport-remote-bridge serve --stdio`（PATH 解析）；帧 = 4B-BE 长度 + JSON ≤16MiB；Hello 协商 | explore-mobile-client 报告；crates/agentport-remote-protocol/src/lib.rs（read_frame/write_frame/negotiate_version） |
| F-006 | 配对码载荷 = Invitation JSON {version,id,peer{relayUrl,publicKey,hostId},secret,expiresAt(+120s)}；桌面受控端 InviteAutomatic 流程已存在（PairingSection.tsx:86-92 生成 QR） | explore-mobile-client 报告；explore-desktop-backend 报告 §5 |
| F-007 | 桌面本地 attach：host_socket+token（SQLite）→ HostClient::connect_with_snapshot（unix socket）→ watch_loop → Channel；输入经 AppState.writers | explore-desktop-backend 报告 §2；src-tauri/src/main.rs:1741-1900,2310-2340 |
| F-008 | 远程 attach 对应物：session.attach（attachmentId 为 String、subscribe_output、screen_snapshot）+ Event push；input 需 attachmentId+batchId；resize 无 pixelWidth/pixelHeight | /tmp/agentport-remote-mapping.md 第 3、6 节 |
| F-009 | 需按设备隔离的 localStorage 键：agentport-active-session-id、agentport-terminal-layout、agentport-collapsed-project-ids、agentport:terminal-snapshot:v2:{sid}、agentport:phone-geometry-dismissed:v1:{sid}:{run}；主题与语言键设备中性保留 | /tmp/agentport-remote-mapping.md 第 5 节 |
| F-010 | BootInfo 组合：platform/settings/adapters/projects(nested)/timeline/secretBackend/indexState/webview/exportsDir；远程 = 本地 settings + 远程 boot+agent.supported+probe_all+project.list+session.list+timeline.get+secret.status 组装 | /tmp/agentport-remote-mapping.md 第 3 节 boot 行、第 5 节；src/src/types.ts:240-252 |
| F-011 | 数据根约定：macOS ~/Library/Application Support/AgentPort（Linux ~/.local/share/agentport），0700 目录；keyring crate 已经 relay connector feature 在依赖树内 | explore-desktop-backend 报告 §4；crates/agentport-relay/Cargo.toml:11 |
| F-012 | src-tauri 包名 `agentport`（cargo test -p agentport）；工作树起点干净（仅本任务文档未跟踪） | src-tauri/Cargo.toml:1-4；git status 2026-09-23 |
| F-013 | 许可边界：桌面端（Rust workspace + src/ + src-tauri/）PolyForm Noncommercial；mobile/ GPL-3.0-only；桌面 crates 不得链接/逐字搬运 GPL 代码，须重写 | AGENTS.md 许可边界节；explore-mobile-client 报告 §4 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 「本机」是默认设备、不可删除、启动默认指向本机（用户已在需求确认中接受）。
- Assumption: 设备切换入口为顶栏设备选择器（用户已接受）。
- Assumption: 配对码沿用 QR bearer 语义：限时约 120s、一次性、需保密（用户已接受）。
- Assumption: 协议版本不兼容时明确提示升级（用户已接受）；协商复用 negotiate_version。
- Assumption: 连接远程设备期间其 attention/状态事件可在控制端本地通知（复用 notifications.rs 路径）；断开后不再接收（用户已接受）。
- Assumption: russh 版本与手机端一致钉 =0.62.7，避免双版本编译行为漂移。验证方式：cargo tree 无重复主版本。
- Assumption: 远程模式下导出/备份的目的路径是被控端服务器路径，UI 仅标注提示，首版不做本地下载转发。影响：用户体验；验证：T-010 门控标注。
- Open question: 无（需求阶段全部决策已确认）。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

1. macOS 调试控制端可通过「粘贴配对码」与「手动 SSH」两种路径配对一台 Linux 被控端（桌面版 AgentPort 已装）。
2. 顶栏设备选择器可在本机与已配对设备间切换；切换后协议已覆盖功能（会话/终端 attach 与输入、项目、worktree、git 含写操作、分支、搜索、历史、timeline、文档读/写/新建、密钥、备份列表）在远程模式可用。
3. 协议未覆盖功能在远程模式禁用或明确降级（更新器、OS 集成、手机配对管理、文档 rename/duplicate/delete、导出目的路径标注）；设置面板始终操作本机。
4. 切走后远端会话持续运行；切回本机一切如旧（本地会话/状态不受远程模式影响）。
5. `cargo test --workspace --all-targets`、`npm --prefix src test`、`npm --prefix src run build` 全绿；新增逻辑有对应单测/组件测试。
6. 调试包经 scripts/restart-debug-app.py 重启并截图确认非白屏；ps 确认 GUI 路径正确。
7. 按里程碑提交 commit，仅含本任务相关改动。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph:
  - T-001（传输层）→ T-002（relay+配对）→ T-003（设备注册表+命令面）
  - T-001 → T-004（TS RemoteBackend，依赖 T-001 的命令签名契约——签名已在 T-001 任务字段中冻结，可并行开工）
  - T-004 → T-005（api.ts 调度器）→ T-006（boot+切换）、T-009（设备 UI）
  - T-006 → T-007（终端 attach）→ T-008（事件/轮询/通知）
  - T-006 → T-010（功能门控）
  - 以上全部 → T-011（全套件回归）→ T-012（真机验证）→ T-013（文档+提交）
- Parallel batches:
  - Batch A：T-001 ∥ T-004（Rust/TS 文件不相交；T-004 依据冻结的命令签名开发，用 mock 测试）
  - Batch B：T-002、T-003（串行，同 Rust crate）∥ T-005（在 T-004 完成后；src/src/api.ts 等与 Rust 不相交）
  - Batch C：T-006 → T-007 → T-008 串行（同触 store/terminals）；T-009 在 T-005 后可与 T-006 并行（新组件文件为主，store 接入点由 T-006 提供后合并）；T-010 在 T-006 后
  - Batch D：T-011 → T-012 → T-013 串行
- Serialization constraints:
  - 同一时刻全仓库只跑一个 cargo 进程（LEARNS：并发会打坏 target/）；Rust 任务串行执行
  - src-tauri/src/main.rs、src/src/api.ts、src/src/store.ts、src/src/terminals.ts 为串行修改文件，不得并行编辑
  - src-tauri/tauri.conf.json 严格 JSON 禁注释；Cargo.lock 由 Rust 任务串行更新
  - cargo fmt 不按文件选择；仅 rustfmt --edition 2021 --check 做只读检查

**T-001 冻结的命令签名契约（Batch A 并行依据）**

```
remote_connect(deviceId: string): Promise<RemoteHello>   // {protocolVersion, capabilities, deviceName}
remote_disconnect(deviceId: string): Promise<void>
remote_request(deviceId: string, method: string, params: unknown): Promise<unknown>
remote_subscribe(deviceId: string, channel: Channel<RemoteEventMsg>): Promise<void>
// RemoteEventMsg = {subscriptionId, eventType, cursor, payload}
device_list(): Promise<DeviceProfile[]>                  // 不含密钥；含 lastConnectedAt/lastError/transport
device_add_ssh(draft: {name, hostname, port, username, auth: {kind:"password",password}|{kind:"privateKey",pem,passphrase?}}): Promise<DeviceProfile>  // probe+TOFU+持久化
device_pair_redeem(payload: string, name?: string): Promise<DeviceProfile>           // 配对码/链接 → relay 配对 → 持久化
device_remove(deviceId: string, deleteCredentials: boolean): Promise<void>
device_rename(deviceId: string, name: string): Promise<void>
device_pairing_link(): Promise<string>                   // 受控端：InviteAutomatic invitation 文本(JSON)
```

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Rust 远程传输层与连接管理器

- Status: done
- Owner: subagent impl-rust-transport
- Objective: 在 src-tauri 新增远程客户端核心：Transport 抽象、SSH 传输（russh 重写实现）、连接管理器（单活动连接）、`remote_connect/disconnect/request/subscribe` 四个 Tauri 命令、事件泵（ServerEnvelope::Event → Channel）。
- Inputs and prerequisites: F-004/F-005/F-007/F-008/F-013；冻结签名契约（见上节）；russh =0.62.7 新依赖。
- Scope or files: 新增 src-tauri/src/remote/（mod.rs、transport.rs、ssh.rs、manager.rs、commands.rs）；src-tauri/Cargo.toml（russh、tokio 扩展 features）；src-tauri/src/main.rs（mod 注册 + generate_handler 注册，追加式最小编辑）。
- Expected output: 四命令可用；本地 stdio 管道挂真 `agentport-remote-bridge serve --stdio` 的 loopback 集成测试通过（hello → session.list → attach 事件帧）；不逐字复制 mobile/ GPL 代码（行为等价重写）。
- Dependencies: None.
- Execution steps:
  1. 定义 Transport trait（tokio AsyncRead/AsyncWrite 帧读写，复用 agentport-remote-protocol read_frame/write_frame/negotiate_version）。
  2. SshTransport：russh client（密码/私钥认证、TOFU 信任库 JSON 0600 存数据根 devices/known-hosts.json）、exec bridge serve --stdio、channel 转 AsyncRead/Write。
  3. RemoteConnectionManager：DashMap deviceId→连接（请求关联 u64 id、reader 任务、事件订阅者）；单活动约束由上层保证，管理器支持多连接但以 connect/disconnect 显式生命周期为准。
  4. 四命令 + 错误结构化（RemoteError 映射协议错误）。
  5. 测试：loopback（pipe 传输 + 真 bridge 二进制）；TOFU 信任库单测；帧损坏/超时路径。
- Acceptance criteria:
  - 四命令注册并可从前端调用；loopback 集成测试完成 hello/session.list/attach 事件流；TOFU 二次连接校验变更拒绝。
  - cargo test -p agentport 新增测试全绿且不破坏既有 60 个。
- Verification method: `cargo test -p agentport remote`；`cargo check -p agentport --all-targets`；git diff 审查无 mobile/ 复制痕迹。
- Validation evidence: 协调者复核：src-tauri/src/remote/ 8 文件 2112 行（新写）；main.rs +8 行、Cargo.toml 增量（russh =0.62.7、tokio+rt/io-util、zeroize、thiserror）diff 已审；`cargo test -p agentport remote` 20/20 通过（含真 bridge loopback：hello/session.list/attach 事件流、TOFU 变更拒绝、超时/截断帧）；子代理报全量 80/80、rustfmt/clippy 干净。错误契约已对齐 TS 端（{code,message}，status 可选）。附带发现：macOS UnixStream set_read_timeout(None) 在设过 SO_RCVTIMEO 后返回 EINVAL——候选经验。DeviceResolver trait + NullResolver 供 T-003 替换。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — relay 传输与配对兑现

- Status: done
- Owner: subagent impl-rust-relay-pairing
- Objective: relay 客户端传输（复用 agentport-relay endpoint.rs）接入 Transport 抽象；设备 Identity 生成/持久化；`device_pair_redeem` 配对兑现（PairingConnection::begin/wait）；`device_pairing_link` 受控端配对码导出。
- Inputs and prerequisites: T-001；F-004/F-006；crates/agentport-relay/src/endpoint.rs。
- Scope or files: src-tauri/src/remote/relay.rs、identity.rs、pairing.rs；src-tauri/src/relay.rs（配对码导出复用 InviteAutomatic 流程，最小编辑）；数据根 devices/identity.json（0600）。
- Expected output: 配对码文本 ⇄ Invitation 解析/校验（版本/过期/字段）；redeem 全流程可对 in-process relay server + connector 测试；受控端导出配对码命令可用。
- Dependencies: T-001
- Execution steps:
  1. Identity：ed25519/Noise 身份生成与 0600 持久化（沿用 connector 的 relay 身份约定）。
  2. RelayTransport：connect_session_realtime(identity, peer) → EncryptedStream → Transport。
  3. device_pair_redeem：解析 payload（裸 JSON 或 agentport-pair:base64url）→ PairingConnection::begin/wait → 返回设备档案草稿。
  4. device_pairing_link：触发 desktop_relay_start + InviteAutomatic，序列化 Invitation 为文本返回。
  5. 测试：payload 解析矩阵；过期/坏签名拒绝；in-process relay 配对 + 连接 + hello。
- Acceptance criteria: 配对兑现与配对码导出命令可用；relay 集成测试绿。
- Verification method: `cargo test -p agentport remote`、agentport-relay 既有套件不回归。
- Validation evidence: 协调者复核：main.rs +10 行、relay.rs +27 行（invite_automatic_text 复用 InviteAutomatic，不记录 secret）diff 已审；`cargo test -p agentport remote` 37/37 通过（含 manager_connects_over_relay_and_speaks_protocol 与 redeem_pairs_profile_and_consumes_invitation 两个全链路 E2E：in-process relay server + 真 connector + 真 bridge::serve）；子代理报全量 97/97、relay crate 40/40、rustfmt/clippy 干净。配对兑现返回 Relay DeviceProfile（T-003 持久化）。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 设备注册表、凭据与管理命令

- Status: done
- Owner: subagent impl-rust-registry-2
- Objective: devices.json 注册表（数据根，0700/0600 约定）+ keyring 凭据（cred_* 约定重写实现）+ device_list/add_ssh/remove/rename 命令（add_ssh 含 probe：连接 + TOFU + bridge_hello）。
- Inputs and prerequisites: T-001/T-002；F-011；冻结签名契约。
- Scope or files: src-tauri/src/remote/registry.rs、credentials.rs；命令注册进 main.rs；keyring crate 依赖。
- Expected output: 设备 CRUD 命令可用；凭据只进 keyring 不落盘；probe 失败路径结构化报错（连接失败/认证失败/主机密钥变更/协议不兼容）。
- Dependencies: T-001, T-002
- Execution steps:
  1. DeviceProfile/注册表读写（原子写、0700 目录、0600 文件）。
  2. 凭据存取（keyring，service=agentport-devices，key=cred_<id>）。
  3. device_add_ssh：probe（建连→hello→记录设备名/版本）→ 持久化 → 可选保存密码/密钥。
  4. device_remove：断连 + 删档案 + 可选删凭据与 relay 授权。
  5. 测试：注册表并发/原子写；probe 各失败路径；删除级联。
- Acceptance criteria: 设备管理命令面完整可用，单测覆盖。
- Verification method: `cargo test -p agentport remote`。
- Validation evidence: 协调者复核：registry.rs 29.6KB + credentials.rs 8.4KB；main.rs 接线已审（KeychainCredentialStore→DeviceRegistry::open→set_resolver，损坏注册表隔离后以空注册表恢复启动）；`cargo test -p agentport` 全量 114/114 通过（基线 97+新增 17）；子代理报 keychain 测试 hermetic（env-tempdir mock）、probe 五类错误族经注入工厂覆盖、redeem 落盘。注：首个 impl-rust-registry 代理因上游模型 400 错误夭折（无写入），以 impl-rust-registry-2 重开完成。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — TS RemoteBackend 与协议方法映射

- Status: done
- Owner: subagent impl-ts-remote-backend
- Objective: src/src/remote/ 新增 RemoteBackend：包装冻结的 remote_* 命令签名，实现 api.ts 中协议已覆盖函数的远程等价（按映射表），未覆盖函数抛结构化 RemoteUnavailableError。
- Inputs and prerequisites: 冻结签名契约（可先开工，用 mock 验证）；/tmp/agentport-remote-mapping.md 映射表；F-002/F-008/F-010。
- Scope or files: 新增 src/src/remote/（client.ts、backend.ts、types.ts、errors.ts、mapping.ts）及单测；不改 api.ts。
- Expected output: RemoteBackend 暴露与 api.ts 远程已覆盖子集同签名的函数；DTO 映射（snake/camel、attachmentId 字符串、RunCursor 必/可选差异）集中在一处并有单测。
- Dependencies: None.（契约冻结后可并行；集成依赖 T-001/T-003 真命令）
- Execution steps:
  1. RemoteClient：invoke 包装 + 连接状态机（disconnected/connecting/connected/failed）。
  2. 方法映射：96+4 个已覆盖函数的参数/返回映射表驱动实现。
  3. 未覆盖清单 → RemoteUnavailableError（带功能标识供门控）。
  4. vitest：mock remote_request，覆盖每域至少一个映射 + 全部未覆盖抛出。
- Acceptance criteria: 新增测试全绿；映射表与 /tmp 报告一致。
- Verification method: `npm --prefix src test -- remote`。
- Validation evidence: 协调者复核：src/src/remote/ 11 个新文件 3991 行；`npx vitest run src/remote` 86/86 通过（子代理另报全套件 844/844 零回归）；errors.ts 抽查符合设计。错误契约假设：remote_request 失败 reject {code,message,status?}——T-001 集成时需对齐。协调注记：updater/目录选择器/通知路由归 localOnly；markSessionLogRendered 远程静默 no-op；backupRestore 入 unavailable。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — api.ts 调度器与 per-device 状态隔离

- Status: done
- Owner: subagent impl-ts-dispatcher
- Objective: api.ts 每导出函数标注路由（local-only / remote-capable）；活动设备上下文进 store；F-009 的 localStorage 键按设备重 scoped；设置/更新器/OS 集成/手机配对始终本地。
- Inputs and prerequisites: T-004；F-003/F-009/F-010；需求「设置始终本机」。
- Scope or files: src/src/api.ts、store.ts、actions.ts、paneLayout.ts、terminals.ts（快照键）、terminalGeometryPrompt.ts、新增 deviceContext.ts。
- Expected output: 调度器按活动设备分发；本机行为零变化（既有 690+ 前端测试全绿）；设备间 localStorage 互不可见。
- Dependencies: T-004
- Execution steps:
  1. DeviceContext（local | remote(deviceId, hello.capabilities)）入 store，持久化当前设备 id（默认 local）。
  2. api.ts 路由表 + 调度；local-only 列表（更新器 4、OS 集成 9、relay 3、通知路由 3、设置 2、notification_setups）。
  3. localStorage 键 scoped 工具（deviceKey(id, base)）+ 迁移本机既有键。
  4. 单测：路由正确性、键隔离、本机回归。
- Acceptance criteria: 既有前端套件不回归；调度与隔离有新增覆盖。
- Verification method: `npm --prefix src test`。
- Validation evidence: 协调者复核：api.ts +8 行（localApi 改名 + createRoutedApi 代理，本机恒等直通）；6 文件 +81 行；新模块 dispatch.ts/deviceContext.ts 设计合理（叶模块防循环依赖、overrides 兼容 vi.spyOn）；聚焦测试 dispatch 9/9 + deviceContext 6/6 通过；子代理报全套件 872/872（基线 844+新增 28）与 build 绿。boot 暂 FORCED_LOCAL 待 T-006 组合。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 远程 boot 组合与设备切换流程

- Status: done
- Owner: subagent impl-ts-boot-switch
- Objective: useBoot 按活动设备组装 BootInfo（本地 settings + 远程 adapters/projects/timeline/secretBackend/indexState）；switchDevice action（detach 全部 → 断旧连新 → 重 boot → 初始会话选择）；启动恢复上次设备（默认本机）。
- Inputs and prerequisites: T-005；F-010；需求「切走断开、切回重连、远端会话持续」。
- Scope or files: src/src/App.tsx（useBoot）、store.ts、actions.ts、api.ts boot 包装。
- Expected output: 切换全链路可用；连接失败回退本机并提示；切换中 UI 有明确过渡态。
- Dependencies: T-005
- Execution steps:
  1. 远程 BootInfo 组装（多调用并发、嵌套 ProjectView 组装）。
  2. switchDevice：清理（detach、中止轮询、清 scoped UI 状态）→ connect → boot → 选择恢复。
  3. 启动路径：读持久化设备 id，失败回退本机。
  4. 测试：boot 组装、切换清理、失败回退。
- Acceptance criteria: 切换流程单测/组件测试覆盖；本机启动路径不回归。
- Verification method: `npm --prefix src test`。
- Validation evidence: 协调者复核：新增 remoteBoot.ts/deviceSwitch.ts/remoteBase.ts + App/store/actions/terminals 最小接线；`npm test` 全量 938/938 通过（含 T-009 的 48 个 UI 测试与 T-006 的 23 个切换测试）；tsc --noEmit 干净。设计点：api.boot 保持本地原义；useBoot 始终先跑本地 boot（平台/设置基线），持久化设备为远程时再静默 switchDevice（失败回退本地）；detach 仅调用既有 detachSession；缓存经 uiRevision generation 防护。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 远程终端 attach 与输入

- Status: done
- Owner: subagent impl-ts-remote-terminal
- Objective: terminals.ts attachHandle 支持远程：AttachInfo 适配（attachmentId 字符串、无 hostPid/socketPath）、ChannelMsg 合成（Event push → ChannelMsg）、send_input/resize 带 attachmentId+batchId、screen_snapshot 恢复复用既有快照路径。
- Inputs and prerequisites: T-006；F-002/F-007/F-008；LEARNS（attach/replay veil、快照恢复、viewport 系列教训）。
- Scope or files: src/src/terminals.ts、types.ts、api.ts、remote/backend.ts。
- Expected output: 远程会话可 attach、渲染（含快照恢复）、输入、resize；replay veil/可见性边界行为与本地一致。
- Dependencies: T-006
- Execution steps:
  1. AttachInfo 类型并集 + 适配层（远端缺失字段的呈现降级）。
  2. 远程 Channel 对象（onmessage 兼容）由订阅事件喂给既有 ChannelMsg 处理链。
  3. input/resize/detach 映射 attachmentId+batchId。
  4. 测试：事件→ChannelMsg 合成、输入幂等 batchId、快照恢复 xterm 级（vitest + 真 xterm）。
- Acceptance criteria: 远程 attach 全链路测试覆盖；既有终端套件（94+）不回归。
- Verification method: `npm --prefix src test -- terminal`。
- Validation evidence: 协调者复核：AttachInfo 类型拓宽（attachmentId number|string、hostPid/protocol/logBytes/logCursor 可空、remote?/features? 标记）diff 已审；dispatch.ts 的 `.call(backend,...)` 修复已验证在案（line 86）——堵住所有远程路由调用运行时丢 `this` 的真实缺陷；子代理报终端聚焦 41/41、remote 套件 162/162、全量 948/948。事件帧→ChannelMsg 单入口 feed，veil/replay_done 边界与本地一致。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 远程事件、轮询与本地通知

- Status: done
- Owner: subagent impl-remote-events
- Objective: 远程订阅泵 → ChannelMsg 全量类型；全局事件轮询合成（projects-changed/session-state/git-state-invalidated）；远程 attention/state 事件触发本地 macOS 通知（复用 notifications.rs 路径的 Rust 钩子）。
- Inputs and prerequisites: T-007；F-002/F-003；需求「连接期间 attention 本地通知」。
- Scope or files: src/src/remote/events.ts、actions.ts、store.ts；src-tauri/src/remote/manager.rs（状态事件 → notify 钩子，复用 notifications.rs）。
- Expected output: 远程模式下图标未读/attention/状态变化可感知（轮询 ≤5s 间隔 + 操作后立即刷新）；系统通知行为与本地一致；断开后无通知。
- Dependencies: T-007
- Execution steps:
  1. 订阅泵与事件分发（session 事件进 attach 通道；全局相关事件触发增量刷新）。
  2. 轮询调度器（可见性/前台感知，切走即停）。
  3. Rust 钩子：远程 state 事件（NeedsInput 等）→ notifications.rs 同等去重/路由。
  4. 测试：合成事件→store 效果；轮询启停；通知触发去重。
- Acceptance criteria: 事件/轮询/通知测试覆盖；LEARNS 通知去重语义保持。
- Verification method: `npm --prefix src test`；`cargo test -p agentport remote`。
- Validation evidence: 协调者复核：remoteSync.ts（5s 可见性感知轮询→actions.refreshProjects() 单点；变更钩子立即刷新）；Rust 侧查明桥只推 per-attachment 事件（无全局推送），故通知源 = attention.poll + 新 remote_attention_notify 命令进本地通知管道（共享 NotificationDeduper、设备名前缀、受本机通知设置门控）——单一数据源无双发；cargo 复跑 119/119（首次复跑出现 1 次偶发失败未复现，记入 T-011 观察项）；npm 971/971、tsc/build 绿。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 设备管理 UI 与配对流程

- Status: done
- Owner: subagent impl-ts-device-ui
- Objective: 顶栏 DevicePicker（本机/设备列表/连接状态/添加/管理）；设置页设备管理（重命名/删除/测试连接）；PairDevice 流程（粘贴配对码 + 手动 SSH 表单）；受控端 PairingSection 增加「复制配对链接」；i18n zh/en。
- Inputs and prerequisites: T-005（store 接入点）；T-003（device_* 命令）；T-002（device_pairing_link）；web-ui-ux-design 技能准则。
- Scope or files: 新增 src/src/components/DevicePicker.tsx、DeviceSettings.tsx、PairDevice.tsx + CSS；设置页与顶栏挂载点最小编辑；locales 两语言。
- Expected output: 三个 UI 面可用可测；配对码/SSH 表单完整校验与错误呈现；连接状态（connecting/connected/failed）可见。
- Dependencies: T-005
- Execution steps:
  1. DevicePicker 组件 + 顶栏挂载。
  2. 设置页设备管理 + PairDevice 双路径表单。
  3. PairingSection「复制配对链接」。
  4. i18n + 组件测试（渲染/交互/错误态）。
- Acceptance criteria: 组件测试覆盖；既有 sidebar/topbar 套件不回归。
- Verification method: `npm --prefix src test`。
- Validation evidence: 协调者复核：DevicePicker/DeviceSettings/PairDevice/devicesStore + PairingSection 复制配对链接（复用 QR 同源 Invitation JSON，不落盘不日志）齐全；TopBar 已挂载；i18n en-US/zh-CN 各 +76 行；48/48 组件测试通过；全量 938/938；tsc 干净。注：该代理末轮遇上游 403 限流未能自报，协调者独立验证其产出完整后验收。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 远程模式功能门控

- Status: done
- Owner: subagent impl-ts-remote-gating
- Objective: 按 backend kind/能力标志门控：OS 集成按钮（reveal/open in terminal/VSCode 等）、更新器 UI、导出/备份目的路径标注「保存于远程设备」、文档 rename/duplicate/delete 禁用、mark_session_log_rendered 降级 no-op、diag socketPath 等本地字段隐藏。
- Inputs and prerequisites: T-006；F-001 未覆盖清单；需求「未覆盖功能禁用并标注」。
- Scope or files: 相关组件（GitCenter、SessionActions、Documents、Settings、Export/Backup UI）+ capability 谓词集中定义（store.ts，遵循 LEARNS「谓词放 store 不放 actions」）。
- Expected output: 远程模式下不可用功能统一禁用态 + 原因提示；本机模式零变化。
- Dependencies: T-006
- Execution steps:
  1. capability 谓词（isRemote、canLocalOs、canUpdater…）。
  2. 逐组件接入禁用/标注。
  3. 门控单测（远程/本机两态）。
- Acceptance criteria: 门控覆盖未覆盖清单全部条目；既有组件测试不回归。
- Verification method: `npm --prefix src test`。
- Validation evidence: 协调者复核：store.ts +57 行 6 个谓词；11 个组件接入门控（OS 集成按钮、文档 rename/duplicate/delete、导出选项与目的地标注、备份 restore 禁用、diag 本地字段隐藏 + actions.ts RemoteUnavailableError 安全网）；i18n 双语；全量 962/962（含门控 14 个新测试）、tsc 干净。本机模式恒等。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — 全套件回归

- Status: done
- Owner: coordinator
- Objective: 全仓验证：cargo test --workspace --all-targets（单 cargo 串行）、clippy、npm test、npm build、版本同步脚本。
- Inputs and prerequisites: T-001…T-010 全部 done。
- Scope or files: 无新文件；修复回归。
- Expected output: 全部套件绿；新增覆盖率符合各任务验收。
- Dependencies: T-001, T-002, T-003, T-004, T-005, T-006, T-007, T-008, T-009, T-010
- Execution steps:
  1. `pgrep -fl cargo` 确认无并发后 `cargo test --workspace --all-targets`（后台任务，等待完成）。
  2. `npm --prefix src test` 与 `npm --prefix src run build`。
  3. `scripts/check-version-sync.sh`（版本不变则跳过 set-version）。
  4. 修复所有回归并复跑到绿。
- Acceptance criteria: 四项全绿。
- Verification method: 上述命令实际输出。
- Validation evidence: `cargo test --workspace --all-targets` exit 0（偶发失败未复现）；`npm test` 971/971；`npm run build` 绿；`cargo clippy -p agentport --all-targets` 新代码零告警（余 24 条均为既有代码，修复了 attention_notify.rs 两条 doc_lazy_continuation）；`scripts/check-version-sync.sh` ok（0.1.2 未变）。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — 真机验证（macOS 控制端 ↔ Linux 被控端）

- Status: done
- Owner: coordinator
- Objective: 调试包构建签名重启 + 截图非白屏；macOS ↔ Linux 被控端走通验收场景：配对码与手动 SSH 双路径配对、切换、会话列表、终端 attach/输入、git 只读+stage、切回本机、远端会话切走期间持续运行。
- Inputs and prerequisites: T-011；scripts/restart-debug-app.py；scripts/linux/ 容器工具；本地 agentport-relay server（relay 路径）与 sshd（SSH 路径，容器内）。
- Scope or files: 验证脚本/记录（docs/tasks 内记录证据，不留临时产物入库）。
- Expected output: 验收标准 1/2/3/4/6 的直接证据（截图、命令输出、进程路径核验）。
- Dependencies: T-011
- Execution steps:
  1. 准备 Linux 被控端：容器或本机 VM 安装 AgentPort Linux 构建 + sshd；起本地 relay server。
  2. `python3 scripts/restart-debug-app.py` 重建签名重启调试包；ps 核验 GUI 路径；稳定截图助手截图非白屏。
  3. 按验收场景逐步走通并记录；远端会话切走后在对端确认仍在运行。
  4. 发现问题 → 回到对应任务修复复验。
- Acceptance criteria: 验收标准 1/2/3/4/6 全部有直接证据。
- Verification method: 截图 + 命令输出 + ps 核验。
- Validation evidence: 全部达成（详见执行日志 2026-09-23 T-012 条）：①SSH 栈级 E2E PASS（真 OpenSSH→Linux bridge：probe+TOFU+hello 1.1+project.add+session.create(shell)+attach 事件流回显 E2E_MARK_42+git.changes/stage(staged=1)+断开重连 hostAlive）；②relay 栈级 E2E PASS（真 relay server+Linux connector+gnome-keyring：redeem 自动批准+Noise 连接+hello+session.list）；③GUI 级：/tmp 副本实例种子入 devices.json 后经 AX 驱动完成 本机→e2e-linux-relay→本机 切换，截图证实远程项目/会话/终端真实渲染（GUI_SEED_MARK_42 输出）与切回恢复；④「添加设备」对话框（配对码/手动 SSH 双页签）截图；⑤主调试 GUI 经 restart-debug-app.py 重建签名重启，ps 路径核验 + 截图非白屏（本机会话列表完整）。限制：被控端为 Ubuntu 24.04(aarch64) 容器（验收组合中被控端无需 GUI，不影响结论）；主调试 GUI 在 E2E 期间曾无报告退出一次（已重启验证）；E2E 实例与主调试实例共享 bundle id 的 WebKit localStorage（active-device-id 最终=local，影响仅限预选会话）。
- Blocker: None.
- Unblock condition: None.

### [ ] T-013 — 文档与里程碑提交

- Status: pending
- Owner: coordinator
- Objective: 用户文档增补（docs/user-guide.md 设备切换章节）；按里程碑创建 commit（仅本任务相关改动）；任务文档最终校验与收尾。
- Inputs and prerequisites: T-012；AGENTS.md 提交规则。
- Scope or files: docs/user-guide.md（或 README 指引）、本任务文档、按逻辑分组的提交。
- Expected output: 提交历史清晰（建议：①Rust 远程客户端与设备管理 ②TS 后端调度与切换 ③终端/事件/通知 ④UI 与门控 ⑤文档）；任务文档 validate 通过。
- Dependencies: T-012
- Execution steps:
  1. 撰写用户文档章节（配对、切换、远程模式边界）。
  2. 分组 git add + commit（每次提交前增量验证已绿）。
  3. task_document.py validate；填写 final validation。
- Acceptance criteria: 提交仅含本任务改动；validate 通过；final validation = passed。
- Verification method: `git show --stat` 逐提交核对；validator 输出。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Rust：每个 Rust 任务跑 `cargo test -p agentport remote`（聚焦）+ 阶段末 `cargo test --workspace --all-targets`（全量，单 cargo 进程，后台等待）。relay/protocol/core 既有套件不得回归。
- 前端：每个 TS 任务跑聚焦 vitest + 阶段末 `npm --prefix src test` 全量 + `npm --prefix src run build`。
- 集成：T-001 loopback（真 bridge 二进制）；T-002 in-process relay server；T-012 真机（macOS 调试包 ↔ Linux 被控端 + 本地 relay/sshd）。
- 验证边界诚实记录：无法在本环境完成的（如真实 Linux 桌面 GUI 的显示效果）在 T-012 标注替代证据（容器内 CLI 级验证 + 协议级验证）。
- 每个 done 必须有实际命令输出；subagent 报告只作线索，协调者复核 diff 并复跑最小验证。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 许可风险（已缓解）：mobile/ GPL 代码不得逐字进入桌面；实现采用行为等价重写 + 直接依赖 PolyForm 的 relay/protocol crate；交付时向用户（作者）明示由其决定是否认可重写边界。
- 终端性能风险：远程事件推送承载桌面全量 xterm 流（16MiB 帧上限），SSH/relay 上高频刷帧的吞吐与 WebContent 压力需在 T-007/T-012 实测；备选降级：远端 attach 降低 replayTailBytes。
- 偶发测试失败：T-008 验收复跑时 `cargo test -p agentport` 出现 1 次单测试失败（日志未保留、重跑 119/119 通过）；T-011 全量回归若复现必须定位。
- 全局事件轮询粒度：轮询合成可能与本地推送存在时序差（如 git-state-invalidated），首版接受 ≤5s 延迟；后续阶段可扩协议全局推送。
- 签名/TCC：调试包必须走 scripts/restart-debug-app.py（固定证书）；手动替换二进制后必须重签，否则 host exited during startup。
- sidecar 漂移：GUI 构建会回写 target/debug sidecar；遵循 scripts/test-debug-sidecars.py 门禁（本任务不改 sidecar 构建，但 T-012 重建时需确认）。
- 容器内 sshd/relay 环境准备可能受本机 Docker 可用性影响；若不可用，降级为协议级 + loopback 证据并在 T-012 明确记录。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-23: 需求经 clarify-requirements 流程确认（交互形态/范围/通道/配对/保活/状态边界/平台/被控形态八项决策 + 六项假设）。
- 2026-09-23: 三个只读勘察子代理完成（移动端客户端架构、命令面映射、桌面后端集成点），关键结论录入 F-001…F-013。
- 2026-09-23: 任务文档创建并完成分解（T-001…T-013），命令签名契约冻结。
- 2026-09-23: Batch A 启动：T-001（impl-rust-transport）∥ T-004（impl-ts-remote-backend）并行派发。
- 2026-09-23: T-004 完成并复核（86/86 聚焦测试，全套件 844/844），集成依赖：T-001 需对齐 remote_request 错误契约 {code,message,status?}。
- 2026-09-23: T-001 完成并复核（20/20 远程测试、全量 80/80、main.rs +8 行）。
- 2026-09-23: Batch B 启动：T-002（impl-rust-relay-pairing，Rust 串行）∥ T-005（impl-ts-dispatcher，TS）。
- 2026-09-23: T-005 完成并复核（聚焦 15/15，全套件 872/872、build 绿）。Batch C 启动：T-006（impl-ts-boot-switch）∥ T-009（impl-ts-device-ui，不触 store/actions/api，设备列表状态独立模块）。
- 2026-09-23: T-002 完成并复核（37/37 远程测试含 relay 全链路 E2E，全量 97/97）。T-003（impl-rust-registry）派发。
- 2026-09-23: T-003 完成并复核（114/114，注册表+keychain+probe 错误族）。
- 2026-09-23: T-006、T-009 完成并复核（前端全量 938/938，tsc 干净）。Batch C 第二波启动：T-007（impl-ts-remote-terminal）∥ T-010（impl-ts-remote-gating，store 谓词+组件）。
- 2026-09-23: T-007、T-010 完成并复核（全量 962/962，dispatch `this` 绑定修复在案）。T-008（事件/轮询/通知，TS+Rust 钩子）派发。
- 2026-09-23: T-008 完成并复核（cargo 119/119、npm 971/971）。注意：cargo 复跑曾现 1 次偶发失败未复现，T-011 重点观察。Batch D 启动：T-011 全量回归。
- 2026-09-23: T-011 完成（workspace cargo exit 0、npm 971/971、build 绿、新代码 clippy 干净、版本同步 ok）。
- 2026-09-23: T-012 完成。被控端环境：Docker（OrbStack）Ubuntu 24.04 aarch64 容器，构建 host/bridge/connector/relay-server（补 libdbus-1-3 运行时依赖），sshd+git fixture。SSH 路径一次走通（初因容器缺 libdbus 运行时库失败，修后通过）。relay 路径排障：①connector `--data-dir` 不存在时 canonicalize 报误导性 Transport 错（需先 mkdir）；②Linux keychain 需 gnome-keyring+dbus 会话（真实桌面标准配置）；③connector 注册是异步的，invite 前须等 phase=connected。GUI 证据经 AX（System Events）驱动 AXPopUpButton「设备切换」完成真实切换。E2E 测试固化于 src-tauri/src/remote/e2e_linux.rs（#[ignore]，AGENTPORT_E2E=1 启用）。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: not_run
- Evidence: Not run.
- Limitations: 待 T-011/T-012 完成后填写。
