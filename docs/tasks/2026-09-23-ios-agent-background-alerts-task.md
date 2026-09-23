# Task Plan: 个人 iPhone 后台 Agent 提醒

- Created: 2026-09-23
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done (代码、自动化和调试窗口验证完成；真机 APNs 仍待用户外部配置)
- Source: 用户确认个人自用 Mac 直发 APNs、三类语义事件、稍后配置真实凭据。

<!-- task-doc-section:background-goal -->
## Background and goal

手机锁屏、挂起或退出时仍由 iOS 展示 Mac 上 Agent 的待审批、轮次完成、执行失败提醒；点击后回连并同步已有持久消息箱。实施个人自用的 Mac→APNs→iPhone 可见提醒链路。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

包含 iOS 原生注册和点击路由、经已认证的 Relay 配对设备登记 token、Mac 独立 connector 的 APNs 配置及事件投递、失败处理、相关文档和测试。不将 APNs 密钥打包/提交；用户稍后提供 .p8/Key ID/Team ID，不能宣称已完成真实锁屏投递。不增加公开多用户服务，不推送 Agent 正文，不用静默推送、后台保活或持续移动轮询。不修改 Apple Developer 网站或生产部署。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 手机当前仅可见时执行 attention.poll，系统投递被禁用 | mobile/src/features/sessions/useAttentionInbox.ts; attentionNotifications.ts |
| F-002 | Mac 有三类持久 attention 元数据和独立 connector，后者关闭 GUI 后继续运行，机器重启无登录自启 | crates/agentport-service/src/lib.rs::poll_attention; crates/agentport-relay/README.md |
| F-003 | iOS entitlement 为空；APNs 需 Push Notifications capability 与 token 注册 | mobile/src-tauri/gen/apple/agentport-mobile_iOS/agentport-mobile_iOS.entitlements; https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns |
| F-004 | 可见 APNs 警报由系统展示；后台静默推送会受限且不保证交付 | https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server; https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app |
| F-005 | 现有产品约束禁止 APNs/离线提醒，用户已明确确认变更这一边界 | docs/mobile-app-prd.md NOTIFY-03/05; 本轮确认 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 个人自用设备且 Mac 可访问公网；凭据仅由用户在 Mac 上单独导入，测试替身覆盖无凭据场景。
- Assumption: 推送只是尽力展示，现有 attention inbox/回连同步是可靠的消息状态渠道。
- Open question: 无；真实密钥及 Apple App ID capability 的外部配置由用户稍后提供，作为实机验收限制。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 已配对 iPhone 能注册、更新 token；未经授权或撤销的设备不能登记或继续接收推送。
- Mac connector 独立于 GUI 对新三类事件投递 APNs 可见提醒，重启后不对既有历史大量补发；投递失败可重试且游标不越过未处理事件。
- 通知不含终端正文/秘密；用户点击后恢复既有消息同步并定位主机/Session，不以 APNs 请求成功作为已读。
- 缺少 APNs 凭据时不假装投递成功；替身测试、适用平台编译、相关文档一致。真实锁屏推送只在用户提供密钥及 Apple capability 后验收。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002,T-003; T-002,T-003 -> T-004.
- Parallel batches: T-002 iOS 与 T-003 Mac 可在 T-001 合约确定后并行，分别拥有 mobile/ 与 crates/agentport-relay/；最终由 coordinator 集成。
- Serialization constraints: T-001 协议和认证边界先确定；Cargo.lock、任务文档及跨端联调由 coordinator 独占。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固定配对设备 token 注册与事件投递边界

- Status: done
- Owner: /root/relay-push-registration
- Objective: 定义不会将 APNs token 或密钥交给未认证渠道的最小跨端合约。
- Inputs and prerequisites: 现有 Relay/Bridge/DB 实现；独立检查结果。
- Scope or files: 协议/connector/mobile 对接设计；需要时改 remote protocol。
- Expected output: 明确 API、持久化、撤销、游标、点击 ID 与可验证安全条件。
- Dependencies: None.
- Execution steps:
  1. 核对现有认证边界与启动路径，确定最少跨端消息和状态所有权。
  2. 实现必要的公共合约并覆盖异常输入测试。
- Acceptance criteria:
  - 只能在已有认证和设备授权边界登记，撤销后不会发送。
- Verification method:
  - 协议/connector 的针对性测试及源码审查。
- Validation evidence: `cargo test -p agentport-relay --features server,connector push_registration -- --nocapture`: 3 tests passed; checked encrypted registration offer, unauthorized/revoked/storage-failure behavior and status redaction. APNs worker checkpoint belongs to T-003.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — iOS 可见推送和消息定位

- Status: done
- Owner: /root/ios-native-reception + coordinator (JS/remote)
- Objective: 实现 APNs 权限、token 注册、原生通知点击与前台补收。
- Inputs and prerequisites: T-001 合约。
- Scope or files: mobile/src-tauri、mobile/src；不修改 Mac connector。
- Expected output: iOS 原生与 UI 接入，无凭据时能独立构建。
- Dependencies: T-001.
- Execution steps:
  1. 配 entitlement 与原生 delegate，登记 token 并回连上报。
  2. 点击时通过现有消息箱定位、去重。
- Acceptance criteria:
  - token 更新、点击冷启动、权限拒绝分支可验证；不依赖静默推送。
- Verification method:
  - mobile 单元测试、iOS 构建与生成配置检查。
- Validation evidence: iOS Simulator `IPHONEOS_DEPLOYMENT_TARGET=16.0 bash scripts/build-ios-simulator.sh` BUILD SUCCEEDED；`npm test -- src/app/usePushAlerts.test.tsx src/app/ios-packaging.test.ts src/app/App.test.tsx` 18/18；`npm run build` 通过；原生点击目标在认证查证后显式确认，webview 重载前不会丢失。模拟器 ad-hoc 签名不代表真实 APNs 能力。
- Blocker: 真机锁屏投递等待 Apple 签名能力与凭据（不阻碍本次代码实现）。
- Unblock condition: 用户配置正确签名和 APNs 凭据后实机验收。

### [x] T-003 — Mac connector APNs 投递与本地配置

- Status: done
- Owner: /root/apns-http-provider + /root/apns-durable-worker + coordinator (IPC/config)
- Objective: 对已有持久语义事件给已授权设备投递可见 APNs 通知。
- Inputs and prerequisites: T-001 合约。
- Scope or files: crates/agentport-relay、必要的桌面配置入口；不修改 mobile/。
- Expected output: 私钥安全导入、独立 connector worker、失败可重试。
- Dependencies: T-001.
- Execution steps:
  1. 实现凭据导入、设备令牌和撤销关联；不在发行二进制中包含密钥。
  2. 实现事件游标、APNs JWT/HTTP2 请求和可注入测试传输。
- Acceptance criteria:
  - 不因失败丢未处理事件，发送无需 GUI 常驻，配置缺失时状态诚实。
- Verification method:
  - connector 单元/集成测试及签名/请求合约检查。
- Validation evidence: `cargo test -p agentport-relay --features server,connector --lib` 38 passed/3 ignored；connector CLI 单测 1 passed；私有 IPC、密钥仅入 Keychain、授权撤销和游标测试覆盖；错 topic 不会永久禁用设备；同 token 重新批准用新注册时间隔离旧游标。私有 IPC `apnsDeliveryActive` 区分配置成功和实际 worker 运行。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 跨端验证、文档和提交

- Status: done
- Owner: coordinator
- Objective: 验证跨端可构建、回归与无密钥边界；更新与前产品决策冲突的文档并提交。
- Inputs and prerequisites: T-002/T-003。
- Scope or files: docs/mobile-app-prd.md、mobile 文档、任务文档、仅本任务修改。
- Expected output: 可复现验证与单独 Git commit。
- Dependencies: T-002, T-003.
- Execution steps:
  1. 运行针对性测试、检查 diff 与版本同步；记录缺少真实凭据时的限制。
  2. 如执行 App 调试，按脚本重启 debug GUI 并确认窗口；仅提交相关改动。
- Acceptance criteria:
  - 自动化验证通过，无真实凭据绝不宣称锁屏实机送达。
- Verification method:
  - rust/mobile 检查、状态检查、Git commit。
- Validation evidence: Rust Relay 38 passed/3 ignored，connector CLI 1 passed，桌面 `cargo test -p agentport relay::tests::existing_connector_is_reused_without_a_binary` 1 passed；mobile 18 passed，`npm run build` 与 iOS Simulator Bundle 构建成功；`git diff --check` 和 `scripts/check-version-sync.sh` 通过。`python3 scripts/restart-debug-app.py` 重建签名并重启，`ps` 确认精确 debug GUI 可执行路径，窗口截图 `/tmp/agentport-debug-apns.png` 显示正常非空白；只提交本任务文件。
- Blocker: 真实 APNs 送达待用户提供凭据及 Apple profile 后单独验收。
- Unblock condition: 对个人签名 iPhone 配置 capability/Team ID/Key ID/.p8，然后测试锁屏提醒。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先测认证与幂等/撤销、发送失败/无密钥、token 生命周期与通知点击；再运行精确 cargo/mobile 检查及 iOS 签名能力检查。用户未提供凭据，不调用生产 APNs、不读私钥；实机推送验收留待后续。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

APNs capability、Team ID、Key ID 和 .p8 未提供，实际送达不可验收；个人 Mac 私钥存在被本机恶意程序读取风险，不可随公开发行包打包。Apple 可限流、合并、丢通知；收到的提醒不是可靠消息通道。关闭 GUI 不影响 connector，但 Mac 重启后需打开 App 启动 connector。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-23: 用户确认个人自用 Mac 直发、三类语义事件、稍后提供密钥和冲突 PRD 变更；开始只读并行边界调查。
- 2026-09-23: T-001 开始；基于已认证 Relay 会话的独立注册 offer 设计设备身份绑定，不信任 JS 自报设备 key。
- 2026-09-23: T-001 已验证完成：Relay 加密注册路径、设备撤销及持久失败测试 3/3 通过。开始 T-002/T-003 并行。
- 2026-09-23: T-002/T-003 自动化检查通过；审查后修复错 topic 分类、重新批准设备的游标世代、worker 状态诚实以及冷启动点击在 webview 恢复期的保留与定位优先级。真实设备 APNs 待外部配置。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: 代码与模拟器验收通过；真实 APNs 投递未验收。
- Evidence: Relay 38 passed/3 ignored，connector CLI 1 passed，桌面 Relay 1 passed，mobile 18 passed、frontend build 通过，iOS Simulator BUILD SUCCEEDED，版本同步和 diff whitespace 检查通过；debug GUI 进程 PID 41969 路径精确匹配 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`，截图 `/tmp/agentport-debug-apns.png` 非白屏。
- Limitations: 缺少 APNs 实际凭据与 Apple capability 设置，不能进行真实锁屏投递；撤销前在途／已接受的警报仍可能显示。
