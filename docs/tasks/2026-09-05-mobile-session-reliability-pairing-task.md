# Mobile 稳定性、待处理会话与安全扫码配对

- Created: 2026-09-05
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户11项开发要求及逐项交互确认

<!-- task-doc-section:background-goal -->
## Background and goal
修复 Mobile 键盘闪现、日志滚动、连接状态与断线恢复；将 Recent 改为可处理的任务完成/输入请求队列；完善 Session 操作、已停止会话打开流程；统一桌面文案；新增首次安全扫码配对。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
本轮实施和验收 iOS + macOS，共享代码不故意破坏 Android，但不声明 Android 原生扫码验收。保留现有用户会话、凭据及项目源码；破坏性测试仅用临时数据，不停止已有 Session。二维码不包含密码/私钥。2026-09-06 用户修订：扫码配对和终端通信全部经可自部署 Relay，不依赖 SSH；独立后台连接进程在 GUI 退出后继续服务，不配置开机自启动。本轮只在本地隔离环境验证，不部署公网服务、不创建云资源、不修改 SSH/防火墙/路由器。已有 SSH 配置/凭据继续可用。保留四份原有未提交改动：LEARNS.md、docs/mobile-app-prd.md、src/src/terminals.ts、src/src/terminals-renderer.test.ts。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence
- 基线 `50c9991`：终端采用隐式顶部控件；MobileTerminal 的点击后 blur 会在 xterm 已聚焦后执行，有可复现的闪现链路。
- `SessionDashboard.tsx` 当前 Recent 直接按时间取12条，非待处理事件队列；attention 类型已有 approval_requested / turn_completed。
- `removeSessionFlow` 当前委派归档；用户明确选择 Mobile Remove 永久删除，Archive 保持可恢复归档。
- 现有协议提供 session.attach/restart/archive/archives.delete、attention.poll/seen.mark；连接权限以 SSH 用户为主体。
- 历史：最初按已有 SSH 可达前提实现短时公钥配对（T-005）。
- 当前有效修订（2026-09-06）：用户逐项确认全程 Relay、无需 SSH、独立后台进程、可自部署 Relay（本轮不公网部署），并明确确认实施摘要。原 SSH 扫码入口须替换，已有手动 SSH 连接保留。
- 现有 RemoteClient 的请求/订阅/结果未知语义与 Bridge 的 stdio framed protocol 可复用；原生建立连接、传输所有权和 HostProfile 需要兼容 Relay。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- 已确认：Recent 的完成是本轮任务完成，不要求 Agent 进程退出；成功打开后清除，新事件可重新进入。
- 已确认：已停止/退出会话提供 Restart，不自动启动；网络重连只重新附加存活会话。
- 已确认：桌面仅将 stopped/exited 的可见标签统一为 Stoped，底层生命周期保留。
- 已确认：顶部六项菜单不含返回，标题提供按钮式返回，保留滑动返回。
- 已确认：Remove 删除会话历史/关联数据但不删除项目源码，二次确认；开发验证不对用户现有会话执行。
- Open question: 无产品阻塞；仍不以模拟器证明真机摄像头/物理软键盘/网络切换。工程上采用 WSS（仅字面 loopback 允许 WS）、端到端 Noise、Relay 服务端注册凭据与资源上限；不新增云账户体系。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- U1：非输入区触摸不触发键盘；输入区仍可输入；输出可纵向滚动，横向返回不误触。
- U2：连接显示与活动传输一致；断线可恢复附加、输出和输入；不重放不确定的写操作，不伪装存活。
- U3：Recent 仅有未处理完成/需输入会话，成功打开清除，新事件重现；黄点只位于 Recent 图标。
- U4：已停止会话可明确 Restart；长按提供 Rename/Pin/Stop/Archive/Remove；永久删除明确确认且不可删除项目源码。
- U5：终端菜单仅 Rename/Pin/Restart/Stop/A−/A＋，副标题为 Project/Branch，按钮式与手势返回可用。
- U6：桌面 Stoped/Restart/Stop/Remove/Export Markdown/Export Json 文案准确，移除 Interrupt 菜单项，不删除协议控制能力。
- U7（修订）：配对和终端通信全程 Relay，不依赖电脑 SSH 或手机直连；短时一次性二维码，桌面明确确认；私钥留本地安全存储；端到端加密并绑定电脑身份，Relay 不解密终端内容；过期/重放拒绝，撤销拒绝新连接并关闭该设备已有 Relay 通道，不停止 Session Host。
- U9：交付可自部署 Relay 及配置/TLS/安全边界说明；独立后台进程在 GUI 退出后继续提供访问；不配置自启动、不部署公网，保留既有 SSH 主机/凭据。
- U8：各阶段回归与构建通过后仅提交任务文件；最终更新 iOS 模拟器和 macOS 调试包，核对进程路径及非空白截图，记录未实测边界。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

Execution override: User explicitly authorized coordinator-led sequential execution after the interrupted DAG. Historical order T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006. Revised sequential order T-007 -> T-008 -> T-009 -> T-010 -> T-006. The original parallel partition below is retained only as historical file-scope evidence.
第一批 T-001/T-002/T-003/T-004/T-005 并行，路径独占：终端渲染、传输适配层、Session UI、桌面文案、配对独立模块及依赖。T-006 依赖前五项，协调者串行处理入口/命令注册、共享文件集成及端到端验收。各子任务不得修改任务文档、用户原有改动、直接操作运行窗口或提交 Git。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 终端触摸与日志滚动
- Status: done
- Owner: coordinator
- Objective: 定位并修复非输入区键盘闪现和日志无法滚动。
- Inputs and prerequisites: U1、MobileTerminal 与 xterm 当前实现。
- Scope or files: mobile/src/terminal/MobileTerminal.tsx、对应测试和 mobile-terminal.css。
- Expected output: 原因证据、最小修复及触摸/滚动回归。
- Dependencies: None.
- Execution steps: 重现失败；定位事件/滚动链；最小修复；定向测试。
- Acceptance criteria: U1，不破坏沉浸式顶部呼出和输入焦点。
- Verification method: 定向 Vitest、集成阶段模拟器。
- Validation evidence: Two new regressions failed on baseline (output mousedown focus and missing vertical-wheel routing); after repair all 9 MobileTerminal tests pass, TypeScript/Vite build passes. Native visual verification reserved for T-006.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 连接状态与恢复传输
- Status: done
- Owner: coordinator
- Objective: 修复已连接显示断开及断线后不能恢复的传输根因。
- Inputs and prerequisites: U2、RemoteClient/原生 remote 状态机。
- Scope or files: mobile/src/platform/tauriRemoteClient*、mobile/src-tauri/src/remote.rs、hosts/mod.rs；必要独立测试。
- Expected output: 权威状态快照、可恢复连接和回归证据。
- Dependencies: None.
- Execution steps: 重现事件/快照或重连失败；验证代际/订阅边界；修复并测试。
- Acceptance criteria: U2；不自动重试可能已提交的变更请求。
- Verification method: 适配层 Vitest、Rust 定向测试。
- Validation evidence: Snapshot/event regression failed on baseline and passes after repair; 3 adapter tests and 7 native remote tests pass. TypeScript/Vite passes. Availability retries use capped backoff and attempt ownership; auth/trust failures stop. Runtime outage test remains T-006.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Recent、Session 菜单与打开恢复
- Status: done
- Owner: coordinator
- Objective: 实施待处理队列、黄点、长按菜单、停止会话 Restart 及顶部六项操作。
- Inputs and prerequisites: U3/U4/U5，现有协议能力。
- Scope or files: mobile/src/features/sessions、mobile/src/app/App.tsx/App.test.tsx/styles.css、i18n/resources.ts；不修改 terminal 目录。
- Expected output: 可访问操作流程、事件级确认、状态恢复与回归。
- Dependencies: None.
- Execution steps: 确定事件确认边界；修复失败的停止会话附加；实现菜单与危险操作确认；回归。
- Acceptance criteria: U3/U4/U5；已停止不能盲目 attach；失败不清提醒。
- Verification method: Dashboard/Workspace/Model/App Vitest，最终模拟器。
- Validation evidence: Baseline regressions reproduced missing ended-session Restart and wrong Recent/dot placement. Mobile full suite: 17 files / 99 tests pass; frontend build passes. Added receipts/new-event, long-press cancellation, permanent-delete ordering/partial failure, keyboard menu, stopped attach and reconnect cursor tests. Runtime verification deferred to T-006.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 桌面状态及菜单文案
- Status: done
- Owner: coordinator
- Objective: 显示层统一退出标签，简化菜单并移除 Interrupt 项。
- Inputs and prerequisites: U6 和现有桌面菜单/locale。
- Scope or files: src/src/components/Sidebar.tsx、TerminalArea.tsx、相关状态显示工具/测试、locales；不修改 terminals.ts 及其原有测试。
- Expected output: UI 统一，生命周期协议不变。
- Dependencies: None.
- Execution steps: 定位所有相关 UI 消费点；修改显示/翻译；定向验证。
- Acceptance criteria: U6，保留内部控制能力和退出码诊断。
- Verification method: 桌面定向 Vitest、i18n检查、前端构建。
- Validation evidence: 4 desktop test files / 22 tests pass, TypeScript/Vite build passes. Full i18n checker is blocked by 3 pre-existing stale Rust allowlist entries in unchanged main.rs (Qoder/Pi defaults); no task-introduced translation errors reported. Runtime screenshots reserved for T-006.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 历史 SSH 扫码配对（当前方向已由 Relay 替代）
- Status: done
- Owner: coordinator
- Objective: 实现可撤销的二维码公钥配对及两端独立 UI/原生组件。
- Inputs and prerequisites: U7，SSH 可用，不修改现有用户凭据进行验证。
- Scope or files: 新配对模块/共享 crate、两端 pairing UI、原生 scanner、必要 Cargo/npm 依赖与相机权限配置；入口由T-006集成。
- Expected output: 可调用的安全配对服务/客户端/扫码 UI、过期/重放/撤销测试及集成说明。
- Dependencies: None.
- Execution steps: 基于官方能力选择最小原生扫码与加密方案；实施短时信任与明确授权；临时目录/loopback测试；报告入口接线。
- Acceptance criteria: U7；私钥不外传；授权只追加本应用标记的公钥、撤销不影响其他授权；不自动修改系统SSH或公网配置。
- Verification method: 安全协议/临时 authorized_keys 回归、两端构建、最终可行的扫码模拟验证。
- Validation evidence: 8 shared Rust security tests, 11 Mobile pairing tests, 3 desktop pairing tests and 7 native remote tests pass. Both frontends, iOS simulator bundle and signed macOS debug bundle build. Integration entries are wired. See 2026-09-05-pairing-security-notes.md. Physical camera/system-SSH onboarding remain unverified under T-006; local port22 is unavailable.
- Blocker: None.
- Unblock condition: None.

### [ ] T-006 — 集成、审查与运行验收
- Status: blocked
- Owner: coordinator
- Objective: 集成模块、补齐协议/入口并逐项验证交付。
- Inputs and prerequisites: T-001 至 T-005 的实际结果。
- Scope or files: 共享命令注册、App/Settings/HostManager入口、必要协议边界、此任务记录、构建产物。
- Expected output: 用户11项可追溯验收、task-only commits、更新后的调试窗口。
- Dependencies: T-001, T-002, T-003, T-004, T-005, T-007, T-008, T-009, T-010
- Execution steps: 检查每份diff和证据；集成；审查高风险授权/删除/重连；整体回归；构建安装截图；提交。
- Acceptance criteria: U1-U8；不以模拟器替代真机摄像头验收，不隐藏任何阻塞。
- Verification method: Mobile/desktop Vitest、相关Rust测试、构建、simctl、ps、截图。
- Validation evidence: Mobile 19 files / 112 tests; desktop 5 files / 25 tests; shared pairing 8 tests; native remote 7 tests pass. Both frontend builds, final iOS simulator bundle and signed custom-protocol macOS debug bundle pass. Runtime evidence below includes controlled transport recovery, touch/scroll behavior, lifecycle mutations on a dedicated fixture, native pairing error states and screenshots.
- Blocker: T-007 through T-010 and available isolated Relay integration gates are complete. Physical camera/soft-keyboard/real network-switch acceptance remains unavailable in simulator; system SSH is no longer a prerequisite.
- Unblock condition: Complete remaining physical-iPhone camera/keyboard/gesture/network-switch acceptance on an authorized device; no existing credentials or Sessions may be changed for testing.

### [x] T-007 — Relay 协议、加密通道与可自部署服务
- Status: done
- Owner: coordinator
- Objective: 实现不可信中转的受限路由与端到端安全通道。
- Inputs and prerequisites: 2026-09-06 已确认 Relay 修订；隔离测试，不使用现有凭据。
- Scope or files: crates/agentport-relay、Cargo manifests/lock、Relay 技术与部署说明。
- Expected output: Noise 配对/会话身份绑定、注册证明、WSS 校验、受限转发服务与攻击/重放/背压测试。
- Dependencies: None.
- Execution steps: 检查官方 crate 来源；协议与资源边界；服务端与 loopback 实测。
- Acceptance criteria: U7/U9；Relay 不解密终端数据；未授权注册/路由抢占拒绝；注册/连接/帧/时限受限。
- Verification method: 定向 Rust 测试、隔离 loopback 与服务端编译。
- Validation evidence: cargo test -p agentport-relay --features server: 13 library + 1 CLI tests pass (pinning before phone disclosure, replay/tamper, registration/Accept isolation, generation/capacity/frame bounds, multi-chunk flush and stalled-consumer deadline, private token file checks). Clippy all-targets with -D warnings, package fmt check and server build pass. Isolated CLI binds ephemeral loopback and exits cleanly on SIGINT. README documents TLS/deployment/security boundaries; TLS proxy and endpoint approval/revocation integration are not claimed. Logs: /tmp/relay-server-tests.log, /tmp/relay-clippy.log, /tmp/relay-build.log.
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 独立后台 Connector 与本地控制
- Status: done
- Owner: coordinator
- Objective: GUI 退出后保持出站 Relay、配对确认、设备授权撤销与 Bridge 承载。
- Inputs and prerequisites: T-007 协议与安全通道，现有 Bridge stdio 接口。
- Scope or files: crates/agentport-relay connector、src-tauri 控制模块、sidecar/debug bundle scripts。
- Expected output: 独立进程、受保护 IPC/Keychain、原子授权存储、撤销关闭通道，无自启动副作用。
- Dependencies: T-007
- Execution steps: 身份与本地 IPC；配对状态机；受控 Bridge 子进程；后台生命周期与隔离测试。
- Acceptance criteria: U7/U9；未授权设备不能启动 Bridge；关闭通道不停止 Session Host；不依赖 GUI。
- Verification method: 临时目录/loopback/进程测试及 desktop cargo check。
- Validation evidence: cargo test -p agentport-relay --features server,connector: 20 library + 1 CLI pass; optional real_bridge_hello test separately passes with explicit built Bridge path and isolated data/socket root. Covers exact approval, failed/expired/unknown pairing, durable restart, missing key no rekey, storage failure, selected-device-only channel closure, Relay restart and bounded IPC. Strict clippy, client-only check, sidecar build and cargo check -p agentport pass. Detached binary process check verifies PPID 1 after launching process exits, private IPC and explicit stop (unconfigured, no Keychain write). Rebuilt/signed debug app, exact GUI PID 22200/path verified, nonblank screenshot /tmp/relay-desktop-native-stage.png inspected. Tests use an in-memory vault; real Keychain authorization dialogs and configured GUI-exit end-to-end remain T-006. Logs: /tmp/relay-connector-tests.log, /tmp/relay-real-bridge.log, /tmp/relay-connector-process.log, /tmp/relay-connector-clippy.log, /tmp/relay-desktop-check.log, /tmp/relay-debug-app-build.log.
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — Mobile Relay 主机与恢复传输
- Status: done
- Owner: coordinator
- Objective: Relay 接入原生状态、请求/订阅和凭据存储，兼容原有 SSH。
- Inputs and prerequisites: T-007/T-008 协议与后台进程。
- Scope or files: mobile/src-tauri/src/hosts、remote、credentials、pairing；前端 profile types 与测试。
- Expected output: Relay profile、扫码后密钥保管、端到端附加、重连且不重放不确定操作。
- Dependencies: T-007, T-008
- Execution steps: 向后兼容字段；原生 Relay 配对/连接；复用 Bridge handshake/reader；SSH 回归。
- Acceptance criteria: U2/U7；现有 SSH 配置/凭据不迁移；身份失败不静默信任；断线保留 Session。
- Verification method: Rust/适配层测试、Mobile 前端与 iOS 构建。
- Validation evidence: 27 native library tests pass, including a real loopback Relay + native Bridge hello/request path, pinned phone key mismatch, authenticated revoke denial and explicit owner cancellation with retained split halves. Existing SSH/SFTP fixtures and uncertain-write/generation tests pass. Mobile 20 files / 113 tests and frontend build pass; shared Relay suite and strict clippy pass. iOS simulator bundle built, installed and launched as PID 70143; nonblank screenshot /tmp/mobile-relay-native-stage-late.png inspected. Initial iOS build stalled at local Tauri RPC; a process-local retry without proxy environment variables succeeded (no global settings changed). Native platform Keychain/pair approval UX is still final integration T-006. Logs: /tmp/mobile-relay-native-all.log, /tmp/mobile-relay-ui-tests.log, /tmp/mobile-relay-ui-build.log, /tmp/mobile-relay-ios-direct.log, /tmp/mobile-relay-shared-tests.log.
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 两端扫码 Relay UI 与旧入口替换
- Status: done
- Owner: coordinator
- Objective: Phone Pairing/Scan to pair 改用 Relay，并说明后台与自部署配置。
- Inputs and prerequisites: T-008/T-009 原生接口。
- Scope or files: 桌面 PairingSection、Mobile PairDevice/HostManager、locales、旧 SSH pairing 入口。
- Expected output: Relay URL/注册凭据配置、后台状态、扫码/验证码/确认/撤销、错误/取消流程及测试。
- Dependencies: T-008, T-009
- Execution steps: 沿用界面接线；移除被替代的扫码入口；状态/取消/误配/失败测试；两端构建。
- Acceptance criteria: U7/U9；扫码不再要求 SSH；配置安全落盘前不显示成功；手动 SSH 保留。
- Verification method: 两端 Vitest/构建及最终 T-006 原生验收。
- Validation evidence: Mobile 20 files / 115 tests and desktop PairingSection 5 tests pass; both frontends build. Native Mobile 27 tests and desktop cargo check pass after removal of legacy native SSH pairing commands/dependencies. Latest signed custom-protocol macOS and iOS simulator bundles rebuilt/installed; nonblank screenshots inspected (/tmp/relay-mobile-final.png, /tmp/relay-desktop-final.png). Full i18n check reports only the three pre-existing stale allowlist entries. Runtime-found Connected/Connect disagreement reproduced in a failing regression and fixed by deriving both row status and action from the authoritative snapshot/event state; all 5 HostManager tests pass with explicit cleanup. Actual native Relay acceptance recorded below.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan
先在可重复测试接缝捕获失败，再验证修复。重点覆盖触摸不聚焦、scrollback/alt-screen滚动、事件先于快照、重连代际和写请求不重试、Recent事件去重/确认/新事件、已停止会话、长按取消与危险操作、二维码篡改/过期/重放/拒绝/撤销。集成后运行 Mobile 完整套件、桌面相关套件及构建，再以临时数据验证用户关键路径。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
扫码配对是新的安全边界，禁止仅用明文 HTTP bearer token 冒充安全配对；必须证明服务身份与确认对象绑定。真实摄像头、不同网络和系统 SSH 若不可用，需要诚实记录运行限制，不擅自启用系统服务。其他用户或进程可能正在使用调试窗口，操作期间不输入终端命令或停止工作会话。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-06: T-010 started. Reuse existing pairing layout/scanner/modal; replace SSH QR controls with Relay endpoint/background state, keep explicit approval/revoke and reachable cancellation, add pending-profile reconciliation. No visual redesign or SSH credential migration.

- 2026-09-06: T-009 done: backward-compatible Relay profiles, native opaque pairing attempts with durable disabled-profile/key custody before network authorization, authenticated approval/reconciliation, immutable identity fields, metadata-only import requiring new pairing, and transport-specific cancellation sharing existing Bridge protocol. Profile writes are serialized; adapter saves omit read-only fields while retaining Relay metadata. 27 native + 113 frontend tests pass, iOS build/install/nonblank capture completed. SSH profiles/credentials preserved; UI still uses historical pairing until T-010. LEARNS.md left untouched under protected-file rule; build retry evidence is recorded here instead.

- 2026-09-06: Execution recovered: printf/pwd/git status pass; protected files unchanged by this task. T-009 resumed under the existing confirmed contract.

- 2026-09-06: T-009 blocked by execution-tool failure: several bash calls time out (5–60 seconds), including standalone printf; file read/edit tools still work. No unverified Mobile implementation retained; reverted the unused manifest dependency, and read-back confirmed hosts/mod.rs was unchanged after a timed-out edit command. T-007/T-008 are committed as 6188263/2b45fe6. This final blocker-only document update cannot be revalidated/committed until execution recovers. Resume T-009 from its recorded native seams, then T-010/T-006.

- 2026-09-06: T-009 started by coordinator. Next action: backward-compatible Relay profile metadata/native pairing custody, transport ownership cancellation and shared Bridge hello; preserve SSH establish test seam and existing manual profiles. UI switching remains T-010.

- 2026-09-06: T-008 done: independent connector, private same-user IPC/Keychain adapter, exact pairing approval, durable device gate and revoke/Bridge ownership integrated with desktop commands and sidecar scripts. 21 default tests plus explicit real Bridge test pass; launcher-exit process smoke passes without credential creation. Real Bridge test initially assumed a direct result; corrected the fixture reader to consume protocol `accepted` before `result` (no product workaround/replay). Signed debug GUI rebuilt/reopened and nonblank screenshot inspected. T-009/T-010 not started; current visible QR flow remains historical SSH until replacement.

- 2026-09-06: T-008 started by coordinator. Next seam: owned private state/Unix IPC, durable device gate, bounded pairing and Bridge channels; then independent binary/Keychain and desktop sidecar controls. No existing credentials or Session state used in tests.

- 2026-09-06: T-007 done after 14 tests, strict clippy, fmt, server build and isolated CLI startup/shutdown. Added early computer pinning regression and descriptor-based private token loading. Multi-chunk flush originally lost queued data on drop (UnexpectedEof); downstream sent-byte acknowledgement fixes it without test sleeps; stalled consumer is now verified to close within bounded deadline. LEARNS.md remains untouched because it is protected pre-existing work. Endpoint authorization/GUI-exit/revocation remain T-008+, not inferred from crypto tests.

- 2026-09-06: 用户确认 Relay 修订：配对和数据全部中转、不依赖 SSH、独立后台进程、交付自部署服务但不公网部署。保留本文件为唯一状态记录；T-005 作为历史实现，T-007 started，后续串行 T-008/T-009/T-010，再回到 T-006。

- 2026-09-06: T-006 available integration gates passed; final acceptance blocked only on the listed physical-device/system-SSH conditions. Scanner native error object was reproduced as `[object Object]`, covered by a failing test, fixed to show its message, rebuilt/reinstalled, and verified as `No camera available on this device (e.g., iOS Simulator)` with preview styles restored. No LEARNS.md edits were made because that file belongs to pre-existing user work.

- 2026-09-06: T-005 implemented and build/test verified. Secure temporary pairing, explicit desktop authorization, key custody, scanner cancellation and revocation are integrated. System SSH port22 is unavailable; no service configuration was changed. T-006 native runtime acceptance started.

- 2026-09-05: T-004 completed: both ended lifecycles use Stoped label/color, exit code remains separate diagnostic detail. Context menu and command palette have concise action names and no Interrupt entry. 22 tests and desktop build pass; i18n baseline allowlist issue documented, not silently fixed. T-005 started.

- 2026-09-05: T-003 completed. Recent uses authoritative unread attention with confirmed-open cursor receipts; hidden terminal output no longer consumes new attention. Added long-press/actions and two-step confirmed permanent deletion using existing archive/purge contracts. Stopped hosts no longer blindly attach. Top menu is portaled and contains exactly six actions; title returns to list. All 99 Mobile tests pass; T-004 started.

- 2026-09-05: T-002 completed. Native host listing hardcoded disconnected; adapter allowed older snapshots to overwrite events; native reconnect stopped after three delays. Authoritative phases, snapshot fencing, bounded-delay retry and attempt ownership now covered. T-003 started.

- 2026-09-05: T-001 completed: xterm unconditional mousedown focus preceded delayed blur; xterm touch path skips mouse-reporting TUIs. Guard compatibility mousedown before focus and route vertical gestures through existing wheel handling. Two red regressions became green; T-002 started.

- 2026-09-05: User authorized sequential execution; all implementation owners changed to coordinator, T-001 resumed, remaining tasks pending.

- 2026-09-05: Parallel DAG e656a0d2-4df2-4ec3-b9cd-9545641e58c6 returned `Interrupted DAG attempt is not recoverable` for secure-pairing. No implementation files were promoted; original dirty files unchanged. T-001 through T-005 blocked pending execution-strategy authorization.
- 2026-09-05：用户确认完整需求摘要、永久删除语义、轮次完成 Recent、首次公钥配对和 iOS/macOS 平台范围。
- 2026-09-05：确认 HEAD 50c9991 与四份既有未提交文件；建立路径独占任务图，开始第一批任务。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: partial
- Evidence: Historical T-001 through T-005 implementation is committed. Revised Relay T-007/T-008 foundations are independently verified and committed (6188263/2b45fe6); T-009 native Mobile integration is committed (21044a7); T-010 Relay UI replacement and available isolated native integration gates pass. Historical SSH verification does not validate the new architecture.
- Limitations: Relay server, native Keychain pairing, configured GUI-exit survival, terminal data and revocation are verified on loopback. Approval was exercised through exact private IPC and Mobile native commands; physical QR scanning is not verified. The final Connected/Disconnect fix has regression coverage and is installed, but was not rerun against a new native Relay fixture after cleanup. Public TLS deployment is not tested or performed. The historical SSH port22 prerequisite is superseded; the simulator still has no camera. No physical camera, physical keyboard/gesture, Android, Wi-Fi/cellular switch or full first-time SSH pairing/revocation-login claim. Full desktop i18n checker still reports only the three documented pre-existing stale Rust allowlist entries.

### Relay native isolated runtime evidence (2026-09-06)

- Real loopback server at ws://127.0.0.1:50323/v1/relay; dedicated data/socket/source root /private/tmp/agentport-relay-acceptance-16debvqa. No SSH in this path, no public deployment/autostart/system changes.
- Actual desktop Connector Keychain storage + Mobile native Keychain prepare/begin/wait. First expired invitation rejected; fresh invitation comparison codes matched and exact candidate approval enabled the phone profile. No registration token or identity private key entered diagnostic output/QR/JS.
- Mobile → encrypted Relay → Connector → real Bridge handshake, project.add and dedicated shell Session ses_01M1SKCDEJXS88C7 succeeded. One input batch completed (serverSequence 1); native pushed output decoded to RELAY_FIXTURE_OK and replay_done. No existing Session received input.
- Closed only isolated GUI PID 28365 after exact executable and isolated DB ownership verification. Configured Connector PID 43978 became PPID 1; fixture Host PID 61567 remained alive; new Session attachment and output replay succeeded through the existing Mobile Relay connection.
- Exact selected-device revoke persisted an empty allowlist, closed the live channel and triggered recovery; subsequent Mobile connect returned relay_authentication_failed. Fixture Host PID 61567 remained alive until explicit fixture cleanup.
- Cleanup used fresh project.remove.preflight revision and exact dependencies; project.remove succeeded with zero warnings and stopped/deleted only the dedicated Session. Source sentinel remained. Both fixture-only Mobile profiles/credentials deleted; original SSH profile was semantically identical (only optional relay:null serialization added). Stopped fixture Connector and Relay; deleted exactly two fixture Connector Keychain accounts and the temporary token file. No user Host, release GUI, or external debug GUI was terminated.
- Diagnostic corrections, not product defects: project.add has nested project result (no write replay); pushed attachments use native subscription events rather than session.poll; malformed revoke field was rejected before dispatch and corrected to public_key. No unknown mutation was automatically replayed.
- Latest builds: /tmp/relay-ui-ios-final.log and /tmp/relay-ui-macos-final.log. Latest Mobile suite/build: /tmp/relay-ui-mobile-tests-final.log and /tmp/relay-ui-mobile-build-final.log; desktop pairing tests: /tmp/relay-ui-desktop-tests-final.log. Normal-data debug GUI PID 5960 exact workspace executable verified; nonblank desktop and simulator screenshots inspected. External GUI left alone.

### Historical SSH-era runtime evidence (iOS 26.5 / iPhone 17 Pro simulator, macOS debug app)

| Path | Observed result | Boundary |
| --- | --- | --- |
| Output tap / touch scrolling | Actual WKWebView/xterm with dedicated shell fixture: synthetic output tap produced 0 focus events, compatibility mousedown was prevented; vertical touch moved normal-buffer viewport 119 → 104 with baseY 119. | Product event routing verified, not a physical-finger/soft-keyboard acceptance claim. No existing Session received test command input. |
| Disconnect / recovery | Verified simulator TCP endpoint/sshd parent chain, terminated only its Remote Bridge (not a Host): native events reconnecting → connected; exact same xterm DOM node and same fixture Session remained running/hostAlive. Native profile snapshot also returned connected. | Controlled transport outage, not a Wi-Fi/cellular switch. Retained-tail warning can remain when a cursor expires; no claim of unbounded historical retention. |
| Session controls | Portaled terminal menu showed exactly Rename, Pin, Restart, Stop, A−, A+, plus dialog close; subtitle `Mobile Reliability Fixture · main`. Title returned to list; 500ms synthetic long press showed Rename, Pin, Stop, Archive, Remove. | Screenshots inspected; native assistive-tech audit not performed. |
| Dedicated fixture lifecycle | Created shell in an isolated `/tmp/agentport-reliability.*` project; printed 160 numbered lines only there. UI Rename and Pin persisted; confirmed Stop produced stopped/hostAlive=false; opening displayed explicit Restart without remote-failure alert; Restart returned running. Confirmed Archive retained the archive and stopped the Host; unarchive restored its record; confirmed Remove removed live/archive DB records and Session data while source sentinel remained intact. | Only `ses_01M1S7QWYVCF5CD5` was mutated. Existing user Sessions were not stopped/archived/deleted. |
| Fixture cleanup | Removed only the now-empty test project using fresh preflight with exact revision precondition; read-only DB checks found zero fixture project/Session rows. Project source sentinel remains in `/tmp/agentport-reliability.4Vyngx`. | An initial cleanup probe omitted the required request precondition and the bridge rejected/closed it; the mutation was not blindly replayed. Corrected probe re-read authority before cleanup. No product patch was made for this test-script error. |
| Pairing native integration | Desktop Phone Pairing renders; Generate gives actionable Remote Login prerequisite error with no authorization write. Mobile scanner returns the explicit simulator camera-unavailable reason and restores its preview surface. | No key generated or existing credential changed by runtime pairing tests. Full authorization tested only in isolated loopback/temp-dir tests. |
| Debug delivery | Rebuilt via `scripts/rebuild-debug-app.sh`, restarted only the exact debug GUI, verified executable under `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport` and unique checkout bundle ID. Both updated apps rendered nonblank. | No release GUI or existing agentport-host was terminated. |

Screenshots inspected: `/tmp/reliability-mobile-dashboard.png`, `/tmp/reliability-mobile-pairing.png`, `/tmp/reliability-mobile-scrolled.png`, `/tmp/reliability-mobile-six-actions.png`, `/tmp/reliability-mobile-row-menu.png`, `/tmp/reliability-mobile-stopped-final.png`, `/tmp/reliability-mobile-camera-final.png`; desktop captures from macos-harness show Stoped/Restart and Phone Pairing. Final delivery captures are `/tmp/reliability-mobile-final.png` and `/tmp/reliability-desktop-final.png`.

Current logs: `/tmp/reliability-mobile-verified-tests.log`, `/tmp/reliability-desktop-final-tests.log`, `/tmp/reliability-pairing-final-tests.log`, `/tmp/reliability-mobile-native-final.log`, `/tmp/reliability-ios-camera-final.log`, `/tmp/reliability-macos-build-final.log`, `/tmp/reliability-pairing-i18n.log`.
