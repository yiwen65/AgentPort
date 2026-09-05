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
本轮实施和验收 iOS + macOS，共享代码不故意破坏 Android，但不声明 Android 原生扫码验收。保留现有用户会话、凭据及项目源码；破坏性测试仅用临时数据，不停止已有 Session。二维码不包含密码/私钥，不自动开启系统 SSH、不配置路由器、不引入公网中继。保留四份原有未提交改动：LEARNS.md、docs/mobile-app-prd.md、src/src/terminals.ts、src/src/terminals-renderer.test.ts。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence
- 基线 `50c9991`：终端采用隐式顶部控件；MobileTerminal 的点击后 blur 会在 xterm 已聚焦后执行，有可复现的闪现链路。
- `SessionDashboard.tsx` 当前 Recent 直接按时间取12条，非待处理事件队列；attention 类型已有 approval_requested / turn_completed。
- `removeSessionFlow` 当前委派归档；用户明确选择 Mobile Remove 永久删除，Archive 保持可恢复归档。
- 现有协议提供 session.attach/restart/archive/archives.delete、attention.poll/seen.mark；连接权限以 SSH 用户为主体。
- 用户确认首次扫码配对、电脑确认、授权手机公钥并支持撤销；已有 SSH 可达为前提。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- 已确认：Recent 的完成是本轮任务完成，不要求 Agent 进程退出；成功打开后清除，新事件可重新进入。
- 已确认：已停止/退出会话提供 Restart，不自动启动；网络重连只重新附加存活会话。
- 已确认：桌面仅将 stopped/exited 的可见标签统一为 Stoped，底层生命周期保留。
- 已确认：顶部六项菜单不含返回，标题提供按钮式返回，保留滑动返回。
- 已确认：Remove 删除会话历史/关联数据但不删除项目源码，二次确认；开发验证不对用户现有会话执行。
- Open question: 无产品阻塞；摄像头真机和真实网络切换能力需在验证阶段按实际条件记录。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- U1：非输入区触摸不触发键盘；输入区仍可输入；输出可纵向滚动，横向返回不误触。
- U2：连接显示与活动传输一致；断线可恢复附加、输出和输入；不重放不确定的写操作，不伪装存活。
- U3：Recent 仅有未处理完成/需输入会话，成功打开清除，新事件重现；黄点只位于 Recent 图标。
- U4：已停止会话可明确 Restart；长按提供 Rename/Pin/Stop/Archive/Remove；永久删除明确确认且不可删除项目源码。
- U5：终端菜单仅 Rename/Pin/Restart/Stop/A−/A＋，副标题为 Project/Branch，按钮式与手势返回可用。
- U6：桌面 Stoped/Restart/Stop/Remove/Export Markdown/Export Json 文案准确，移除 Interrupt 菜单项，不删除协议控制能力。
- U7：短时一次性二维码，手机扫码后桌面明确确认；手机私钥留安全存储；配对具备服务端身份校验、过期/重放拒绝、授权撤销，无明文敏感凭据或静默信任。
- U8：各阶段回归与构建通过后仅提交任务文件；最终更新 iOS 模拟器和 macOS 调试包，核对进程路径及非空白截图，记录未实测边界。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

Execution override: User explicitly authorized coordinator-led sequential execution after the interrupted DAG. Current order T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006. The original parallel partition below is retained only as historical file-scope evidence.
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

### [ ] T-005 — 首次安全扫码配对
- Status: in_progress
- Owner: coordinator
- Objective: 实现可撤销的二维码公钥配对及两端独立 UI/原生组件。
- Inputs and prerequisites: U7，SSH 可用，不修改现有用户凭据进行验证。
- Scope or files: 新配对模块/共享 crate、两端 pairing UI、原生 scanner、必要 Cargo/npm 依赖与相机权限配置；入口由T-006集成。
- Expected output: 可调用的安全配对服务/客户端/扫码 UI、过期/重放/撤销测试及集成说明。
- Dependencies: None.
- Execution steps: 基于官方能力选择最小原生扫码与加密方案；实施短时信任与明确授权；临时目录/loopback测试；报告入口接线。
- Acceptance criteria: U7；私钥不外传；授权只追加本应用标记的公钥、撤销不影响其他授权；不自动修改系统SSH或公网配置。
- Verification method: 安全协议/临时 authorized_keys 回归、两端构建、最终可行的扫码模拟验证。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-006 — 集成、审查与运行验收
- Status: pending
- Owner: coordinator
- Objective: 集成模块、补齐协议/入口并逐项验证交付。
- Inputs and prerequisites: T-001 至 T-005 的实际结果。
- Scope or files: 共享命令注册、App/Settings/HostManager入口、必要协议边界、此任务记录、构建产物。
- Expected output: 用户11项可追溯验收、task-only commits、更新后的调试窗口。
- Dependencies: T-001, T-002, T-003, T-004, T-005
- Execution steps: 检查每份diff和证据；集成；审查高风险授权/删除/重连；整体回归；构建安装截图；提交。
- Acceptance criteria: U1-U8；不以模拟器替代真机摄像头验收，不隐藏任何阻塞。
- Verification method: Mobile/desktop Vitest、相关Rust测试、构建、simctl、ps、截图。
- Validation evidence: Not run.
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
- Result: not_run
- Evidence: 尚未运行本轮最终验证。
- Limitations: 真机摄像头和真实网络切换待验证能力判定；不包括 Android 原生交付。
