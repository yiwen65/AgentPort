# Task Plan: 跨设备 Active Agent Session 聚合与跨设备终端

- Created: 2026-11-14
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 2026-11-14 用户通过 clarify-requirements 流程确认的需求合同（见本会话“最终需求简报”）。

<!-- task-doc-section:background-goal -->
## Background and goal

桌面端 Active Agent Session 视图当前只读取 `state.projects`，即当前活动设备的项目快照；桌面端同时只保持一条远端连接，设备选择器绿点只是历史 `lastConnectedAt`。目标是：

- Active 视图聚合“本机 + 所有实时连接设备”中 `hostAlive` 且未归档的 Session，并支持设备条上的手动连接/断开。
- 用户显式建立的连接保持到显式断开或 App 退出；重启后自动重连并恢复 pane。
- 不同设备的终端 pane 可在同一窗口/布局中并存；活动设备由 pane 焦点驱动。
- 非活动设备的非终端操作通过该设备后台连接执行；终端操作先转移焦点再执行。
- 全局面板（Git Center、项目树、文档、搜索、Timeline、新建 Session）仍跟随焦点/活动设备。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**范围**

- 设备连接生命周期：显式连接集合持久化、启动恢复、意外断线标记、显式断开（有 pane 时确认关闭）。
- 设备快照与 Active 聚合：后台设备 `project.list`/`session.list`/`worktree.list` 读取、5 秒前台可见轮询、单设备失败隔离、旧数据保留并标记未确认。
- 会话复合身份：远端 Session 在布局、runtime、handle、archiving、attached 中以 `deviceId:sessionId` 标识；本机保持原 plain ID，避免无谓迁移。
- 全局 pane 布局：布局持久化改为全局键，旧布局迁移到原活动设备；pane 携带设备身份并在 UI 上显示设备徽标。
- 终端 per-device 路由：attach/detach/input/resize/事件/快照/项目刷新按 handle 所属设备路由，不再依赖全局活动设备代理。
- 焦点驱动：选择后台设备 Session、聚焦跨设备 pane、设备选择器切换都会把活动设备切到对应设备；其他设备 pane 保持连接与附着。
- 行操作对等：重命名、置顶、归档、停止、重启、恢复、移除、拖拽/分屏等按目标设备路由；本地专属操作对远端保持降级。
- 通知焦点：当前焦点同时携带设备与 Session，远端 attention 通知按该复合身份抑制。
- 迁移、回归和交付：旧布局/选中 Session 迁移、全套前端与 Rust 测试、Debug App 重建签名截图、按 AGENTS.md 提交。

**非目标**

- 未连接设备自动连接、在线探测、自动重连（启动恢复显式连接集合除外）。
- 跨设备通知聚合、跨设备搜索、跨设备项目树、跨设备批量操作、多窗口设备工作区。
- 设置面板管理远端；远端协议扩展；移动端改动。
- Git Center/文档/搜索/Timeline 的跨设备数据聚合。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户确认“只聚合实时连接设备 + 手动连接”的连接策略。 | 本会话结构化问题答复。 |
| F-002 | 用户确认手动连接保持到显式断开/退出；切换活动设备不隐式断开。 | 本会话结构化问题答复。 |
| F-003 | 用户确认本次一并重构跨设备同屏 pane。 | 本会话结构化问题答复。 |
| F-004 | 用户确认焦点驱动活动设备；设备选择器切设备并转移焦点。 | 本会话结构化问题答复。 |
| F-005 | 用户确认本机始终参与聚合；重启自动重连并恢复 pane；断开有 pane 的设备需确认关闭。 | 本会话结构化问题答复。 |
| F-006 | Active 视图当前只读取 `state.projects`，过滤 `hostAlive && !archiving`。 | `src/src/components/Sidebar.tsx:1116-1209`。 |
| F-007 | 桌面端切换设备会释放所有终端并断开旧远端连接。 | `src/src/deviceSwitch.ts:108-146`。 |
| F-008 | Rust `RemoteConnectionManager` 已支持每设备一条并发连接；`remote_connect/disconnect/request/subscribe` 已注册。 | `src-tauri/src/remote/manager.rs:145-481`、`src-tauri/src/remote/commands.rs:15-88`。 |
| F-009 | 远端 `session.list` 返回权威 `hostAlive`、状态、pin、unreadAttention；`project.list` 返回项目名。 | `crates/agentport-service/src/lib.rs:285-361`、`src/src/remote/types.ts:97-133`。 |
| F-010 | 远端无全局事件推送，活动远端由 `remoteSync` 5 秒轮询合成快照。 | `src/src/remote/remoteSync.ts:1-8,140-163`。 |
| F-011 | 终端 attach/input/resize/detach 当前全部走全局 `api`，且 handle/runtime/layout 使用 plain sessionId。 | `src/src/terminals.ts:2050,3065,3130,3173,3293,3667,3825`、`src/src/store.ts:349-360`。 |
| F-012 | pane 布局存储按活动设备作用域持久化，布局 prune 只认活动设备 projects。 | `src/src/paneLayout.ts:1-20`、`src/src/store.ts:888-1022`。 |
| F-013 | 设备选择器绿点语义是 `lastConnectedAt`/`lastError`，不是实时连接。 | `src/src/components/DevicePicker.tsx:129-161`。 |
| F-014 | 活动设备为远端时，本地项目快照只能直接走 `localApi.listProjects`，不能经过活动设备代理。 | `src/src/api.ts:250,662`、`src/src/remote/dispatch.ts:56-117`。 |
| F-015 | 现有教训：设备切换清空 selection 不会卸载 remembered panes，释放终端会造成误报断连。 | `LEARNS.md` `desktop device switching` 节。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 设备 ID 与 Session ID 均不含 `:`；远端 Session 键采用 `${deviceId}:${sessionId}`，本机保持 plain ID。影响：迁移与同 ID 隔离；通过键解析单测验证。
- Assumption: 后台设备每 5 秒仅需 `session.list` 刷新活跃状态；项目/Worktree 元数据在连接或视图进入时刷新，不参与每次轮询。影响：分支来源可能短暂为缺失；通过聚合器测试验证。
- Assumption: 活动设备继续由 `state.projects` 供稿；非活动设备由新的设备快照存储供稿。影响：避免两套活动快照竞争；通过 store/aggregator 测试验证。
- Assumption: 旧布局只迁移持久化活动设备的那一份；其他设备旧布局不合并，避免启动时意外打开大量 pane。影响：迁移行为明确；通过 paneLayout 迁移测试验证。
- Assumption: 跨设备 pane 的终端操作以 pane 所属设备路由；全局面板仍使用 `activeDeviceContext()`。影响：混合上下文可解释；通过终端路由与 Git Center 回归验证。
- Open question: 无阻塞产品问题；真实双设备验收需用户现有 SSH/Relay 设备授权或由用户执行。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

1. Active 视图同时显示本机与所有已实时连接设备的 `hostAlive` 未归档 Session，来源行含设备名，排序沿用现有优先级。
2. 顶部设备条显示本机、活动设备、其他已连接设备、未连接已配对设备；可连接/断开；单设备失败隔离并保留旧快照。
3. 显式连接保持到断开/退出；切换活动设备不隐式断开；重启自动重连持久化连接并恢复跨设备 pane；断开有 pane 的设备需确认关闭 pane。
4. 不同设备的终端可在同一布局/分组内并存；pane 显示设备标识；终端 I/O、attach/detach、尺寸、恢复按 pane 设备路由。
5. 聚焦跨设备 pane 或在 Active 列表打开后台 Session 会切换活动设备并转移焦点；其他设备 pane 持续附着。
6. 后台设备 Session 的重命名、置顶、归档、停止、重启、恢复、移除、拖拽/分屏按目标设备执行；本地专属操作对远端降级。
7. 同 Session ID 跨设备在布局、runtime、未读、操作、焦点上互不串扰。
8. 旧布局迁移、断线/重连、设备移除、重启恢复、迟到响应均有回归覆盖。
9. `npm --prefix src test`、`npm --prefix src run build`、`npm --prefix src run i18n:check`、相关 Rust 测试通过；Debug App 重建签名、精确 PID、截图非白屏。
10. 提交只包含本任务文件；版本不变时通过 `scripts/check-version-sync.sh`。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006 -> T-007`。
- Parallel batches: 默认串行；T-005 中的 Rust 通知焦点改动文件与前端不重叠，可在前端集成测试期间单独执行，但仍由 coordinator 串行提交与复核。
- Serialization constraints: `src/src/store.ts`、`src/src/actions.ts`、`src/src/terminals.ts`、`src/src/components/TerminalArea.tsx`、`src/src/components/Sidebar.tsx`、`src/src/deviceSwitch.ts`、`src/src/paneLayout.ts` 为共享串行修改文件，不得并行编辑。全仓库同一时刻只跑一个 cargo 进程。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 会话复合键、设备连接与设备快照基础

- Status: done
- Owner: coordinator
- Objective: 新增会话键 helper、前端设备连接状态存储、后台设备快照存储；定义本机 plain ID / 远端 `deviceId:sessionId` 的身份契约。
- Inputs and prerequisites: F-001/F-002/F-008/F-009/F-013/F-014。
- Scope or files: 新增 `src/src/sessionIdentity.ts`、`src/src/deviceConnections.ts`、`src/src/deviceSessions.ts` 及单测；必要时最小修改 `devicesStore.ts`。
- Expected output: 纯函数键解析、连接状态机（显式集合持久化、connect/disconnect/startup restore）、设备快照读取（本机绕过活动代理、远端 session/project/worktree）、快照查找/补丁 API。
- Dependencies: None.
- Execution steps:
  1. 定义 `sessionKeyFor`/`parseSessionKey`/`activeSessionKey`/`deviceKeyForContext`。
  2. 实现 `deviceConnections` 状态存储与 localStorage 显式集合。
  3. 实现 `deviceSessions` 快照存储与 refresh/find/patch/remove API。
  4. 添加键、连接、快照的定向单测。
- Acceptance criteria:
  - 本机 key 与旧 plain ID 完全一致；远端 key 稳定且可解析；同 ID 跨设备不冲突。
  - 显式连接集合可持久化、恢复、删除；连接失败进入 error 且不自动重连。
  - 活动设备快照走 `state.projects`；本机后台快照走 `localApi.listProjects`；远端后台快照走对应 backend。
- Verification method:
  - `npm --prefix src test -- src/sessionIdentity.test.ts src/deviceConnections.test.ts src/deviceSessions.test.ts`
- Validation evidence: `sessionIdentity.test.ts` 5 passed、`deviceConnections.test.ts` 7 passed、`deviceSessions.test.ts` 7 passed；`npx tsc --noEmit` passed。覆盖本地 plain key、远端 `deviceId:sessionId`、同 ID 隔离、显式连接持久化/恢复/失败、活动设备快照跳过、本机后台绕过活动代理、迟到响应与轻量轮询。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 连接生命周期、设备切换与重启恢复

- Status: done
- Owner: coordinator
- Objective: 让切换活动设备不再释放 pane/断开旧设备；接入显式连接/断开、设备选择器实时状态、启动恢复与断开清理。
- Inputs and prerequisites: T-001。
- Scope or files: `src/src/deviceSwitch.ts`、`src/src/components/DevicePicker.tsx`、`src/src/devicesStore.ts`、`src/src/bootApply.ts`、`src/src/App.tsx` 相关接线、相关测试。
- Expected output: 连接保持、切换转移焦点、启动自动重连、显式断开（含 pane 确认）、选择器实时状态。
- Dependencies: T-001.
- Execution steps:
  1. 移除 switchTeardown 的 release/disconnect/drop backend；保留旧 pane。
  2. connectAndBoot 走 `deviceConnections.connectDevice`；切换后聚焦目标最近 Session 或清空焦点。
  3. 启动后恢复显式连接集合；设备列表加载后连接。
  4. 断开流程统计/关闭 pane、必要时先切回本机；设备移除级联。
  5. 选择器显示实时 connected/connecting/error。
- Acceptance criteria:
  - 切走设备后旧设备连接与 pane 保持；切回不重复 dial。
  - 显式断开有 pane 设备需确认；确认后 pane 关闭、handle/runtime/layout 清理。
  - 重启恢复显式连接；失败 pane 保留重连入口。
- Verification method:
  - `npm --prefix src test -- src/deviceSwitch.test.ts src/components/DevicePicker.test.tsx src/deviceConnections.test.ts`
- Validation evidence: `deviceSwitch.test.ts` 17 passed（含 focusSessionKey、reconnectActiveDevice、切走后旧设备快照 seed、失败回滚、串行切换）；`DevicePicker.test.tsx` 9 passed；`DeviceSettings.test.tsx` 6 passed；`deviceTeardown.test.ts` 5 passed（确认关闭 pane、取消保留、活动设备先回本机、无 pane 不确认）。启动恢复在 `App.tsx` 接线，由 `deviceConnections.restoreExplicitConnections` 覆盖。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 全局 pane 布局与终端 per-device 路由

- Status: done
- Owner: coordinator
- Objective: 将布局/终端/runtime/handle 改为稳定复合键；布局存储全局化并迁移；终端 I/O 按 handle 设备路由；pane 渲染支持后台设备与断连占位。
- Inputs and prerequisites: T-001、T-002、F-011、F-012。
- Scope or files: `src/src/paneLayout.ts`、`src/src/terminals.ts`、`src/src/store.ts`、`src/src/actions.ts`、`src/src/components/TerminalArea.tsx`、`src/src/paneSessionDrag.ts`、`src/src/terminalDrop.ts`、相关测试。
- Expected output: 跨设备布局持久化/迁移、复合 runtime/handle、per-device attach/input/resize/detach、pane 设备徽标与断连占位。
- Dependencies: T-002.
- Execution steps:
  1. 布局存储改全局键并迁移旧活动设备布局；plain 本机键保持不变。
  2. store 的 runtime/archiving/attached/suspended/maximized 改稳定键；设备感知 prune。
  3. terminals.ts 增加设备字段与 per-device api；所有 session 查找改 `findSessionByKey`。
  4. TerminalArea 用 key 解析 session、渲染设备徽标、断连 pane 占位。
- Acceptance criteria:
  - 本机布局测试保持通过；远端键为 `deviceId:sessionId`。
  - 后台设备 pane 可 attach/input/resize/detach，不污染活动设备。
  - 断连设备 pane 显示重连入口，不自动反复 attach。
- Verification method:
  - `npm --prefix src test -- src/paneLayout.test.ts src/terminals-renderer.test.ts src/components/TerminalArea.split.test.tsx src/actions-session-selection.test.ts`
- Validation evidence: `paneLayout.test.ts` 22 passed；`terminals-renderer.test.ts` 142 passed；`TerminalArea.split.test.tsx` 22 passed；`actions-session-selection.test.ts` 29 passed；`device-storage-isolation.test.ts` 9 passed（全局布局、旧布局迁移、复合 snapshot key）；`TerminalArea.cross-device.test.tsx` 4 passed（远端 pane 渲染/设备徽标/按 key attach/焦点/断连占位/切换中保持）。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Active 视图聚合、设备条与行操作路由

- Status: done
- Owner: coordinator
- Objective: Active 视图跨设备混排、设备条连接/断开、来源设备标签；SessionRow 的会话操作按设备路由并刷新目标快照。
- Inputs and prerequisites: T-003、F-006。
- Scope or files: `src/src/components/Sidebar.tsx`、`src/src/styles.css`、`src/src/locales/fragments/*`、`src/src/actions.ts` 的行操作、相关测试。
- Expected output: 多设备 Active 列表、设备条、后台设备行操作、空/加载/失败状态。
- Dependencies: T-003.
- Execution steps:
  1. 聚合 active projects + deviceSessions，生成带 key/deviceId 的条目与来源标签。
  2. 设备条渲染本机/活动/已连接/未连接设备与连接状态。
  3. SessionRow 接收 key/deviceId；非终端操作路由到设备 backend 并刷新快照。
  4. 分屏/拖拽/点击后台行走焦点切换。
- Acceptance criteria:
  - 至少两台设备同时显示；排序、来源、设备标签正确。
  - 后台行重命名/置顶/归档/停止/重启/恢复/移除生效；同 ID 不串扰。
  - 设备失败保留旧数据并标记未确认；空/加载状态可区分。
- Verification method:
  - `npm --prefix src test -- src/sidebar-active-agents.test.tsx src/sidebar-active-devices.test.tsx src/sidebar-session-pane-drag.test.tsx`
- Validation evidence: `sidebar-active-agents.test.tsx` 6 passed；`sidebar-active-devices.test.tsx` 4 passed（本机+远端同 ID 混排、设备来源、后台行焦点、pin/archive 路由、设备条连接）；`sidebar-session-pane-drag.test.tsx` 8 passed；全量前端 147 文件/1212 tests passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 焦点驱动切换、跨设备分屏与通知/Git Center 一致性

- Status: done
- Owner: coordinator
- Objective: 聚焦跨设备 pane/打开后台 Session 时切换活动设备并转移焦点；数字快捷键与通知焦点复合化；Git Center/文档跟随焦点设备。
- Inputs and prerequisites: T-004。
- Scope or files: `src/src/actions.ts`、`src/src/App.tsx`、`src/src/components/TerminalArea.tsx`、`src/src/components/Sidebar.tsx`、`src-tauri/src/remote/attention_notify.rs`、`src-tauri/src/remote/commands.rs`、相关测试。
- Expected output: 焦点驱动切换、跨设备分屏/拖拽、⌘1…9 跨设备、通知抑制设备化。
- Dependencies: T-004.
- Execution steps:
  1. 选中后台 key 时先 `switchDevice` 再 select；切换后焦点同步。
  2. 布局 leaf 全键化；拖拽/分屏目标解析设备。
  3. ⌘1…9 使用可见布局第 n 个 key。
  4. 通知焦点输入增加设备维度，Rust 侧按 device+session 抑制。
- Acceptance criteria:
  - 聚焦 B pane 后活动设备/项目树/Git Center 全部为 B；A pane 保持。
  - 跨设备拖拽/分屏成功；⌘1…9 正确切换。
  - 活动远端 Session 不因同 ID 的本地通知焦点被误抑制。
- Verification method:
  - 定向前端测试 + `cargo test -p agentport remote_attention`
- Validation evidence: `deviceSwitch.test.ts` 17 passed（跨设备 focusSessionKey、已激活远端不重复 boot、reconnectActiveDevice）；`TerminalArea.cross-device.test.tsx` 4 passed；`cargo test -p agentport remote::attention_notify --quiet` 6 passed；`cargo test -p agentport remote --quiet` 62 passed/3 ignored；`cargo test -p agentport --quiet` 138 passed/3 ignored。通知焦点输入新增 `focusedDeviceId`/`focusedSessionId`，Rust `is_focused()` 要求设备与会话同时匹配。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 迁移、回归与全套验证

- Status: done
- Owner: coordinator
- Objective: 修复全套回归、补迁移与竞态测试，完成前端/Rust 构建与静态检查。
- Inputs and prerequisites: T-005。
- Scope or files: 本任务全部源码与测试；仅在验证失败时做最小修复。
- Expected output: 全绿测试、构建、i18n、Rust 目标测试；明确的限制说明。
- Dependencies: T-005.
- Execution steps:
  1. 跑全套前端测试，修复本任务导致的失败。
  2. 跑 TypeScript/Vite build、i18n check、版本同步。
  3. 跑相关 Rust 测试（至少 `cargo test -p agentport remote`）。
  4. 审查 diff、并发/迟到响应/迁移边界。
- Acceptance criteria:
  - 所有可运行验证通过；不可运行项有证据和限制说明。
  - 无任务外文件混入。
- Verification method:
  - `npm --prefix src test`、`npm --prefix src run build`、`npm --prefix src run i18n:check`、`scripts/check-version-sync.sh`、`cargo test -p agentport ...`。
- Validation evidence: 前端 `npm --prefix src test` 147 文件/1212 tests passed；`npm --prefix src run build`（tsc + Vite）passed；`scripts/check-version-sync.sh` passed（0.1.6）；`cargo test -p agentport --quiet` 138 passed/3 ignored；`rustfmt --check` 对修改的两个 Rust 文件 passed。`npm --prefix src run i18n:check` 仅剩 HEAD 已存在的 `crates/agentport-core/src/adapters/capability.rs:539` 中文 Rust UI literal 未翻译；本任务新增 key 无 i18n 问题，未修改该无关基线。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — Debug App 可视验收与任务提交

- Status: done
- Owner: coordinator
- Objective: 按 AGENTS.md 重建签名 Debug App、精确重启、截图确认非白屏；创建仅含本任务的 commit。
- Inputs and prerequisites: T-006。
- Scope or files: `target/debug/bundle/macos/AgentPort.app`（构建产物）、任务文档、本任务源文件。
- Expected output: 非白屏截图、精确 PID 路径证据、任务 commit。
- Dependencies: T-006.
- Execution steps:
  1. `python3 scripts/restart-debug-app.py` 构建签名并重启精确 GUI。
  2. `ps` 核对 GUI 可执行路径；截图确认窗口正常。
  3. 若用户授权，使用已配置设备做双设备 smoke；否则记录为待用户验证的限制。
  4. 显式暂存本任务文件，检查 staged diff，创建 commit。
- Acceptance criteria:
  - Debug GUI 路径为当前 checkout；截图非白屏。
  - commit 不包含无关文件；任务文档 final validation 更新。
- Verification method:
  - 脚本退出码、`ps`、截图、`git diff --cached`、`git show --stat`。
- Validation evidence: `python3 scripts/restart-debug-app.py` 构建并固定证书签名成功，仅关闭精确 GUI PID 58113，打开新 PID 68491；`ps -p 68491 -o pid=,comm=` 精确为当前 checkout 的 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`。通过 cua-driver 按 AX 点击铃铛打开 Active 视图并截图 `/tmp/agentport-final-active9.png`：设备条显示 This computer（Active/Connected）、5070 SSH（Connected/Disconnect）、5070 RELAY（Connect），列表混排本机与 5070 的 hostAlive Session，来源分别为 `This computer · …` 与 `5070 · …`；窗口正常渲染非白屏。未停止任何 agentport-host/connector，未关闭 release App。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 单元/组件：会话键解析、连接状态机、设备快照隔离/迟到响应、布局迁移、per-device 终端路由、Active 聚合/设备条/行操作、焦点切换、通知焦点。
- 集成：后台设备连接后打开 pane、切设备后旧 pane 保持、断开关闭 pane、重启恢复、跨设备拖拽/分屏。
- 静态/构建：`npm --prefix src run build`（tsc + Vite）、`npm --prefix src run i18n:check`、`scripts/check-version-sync.sh`。
- Rust：`cargo test -p agentport remote`（通知焦点与远程命令相关）；如修改 core/service 则补相应 crate 测试。
- 真实环境：用 Debug App 与至少两台已配置设备做连接、聚合、跨设备分屏、断开/重连、重启恢复 smoke；若未获授权，明确列为限制而不是伪造。
- 交付：Debug App 重建签名、精确 PID、截图；仅本任务文件 commit。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 终端/布局重构回归面大：attach/handle/runtime/layout/prune/input/resize/replay/snapshot。
- 连接所有权与切换/断开/重启恢复/迟到响应的竞态。
- 同 Session ID 跨设备与旧布局迁移。
- N 设备轮询 `session.list` 的 Host 存活探测成本；需单设备超时隔离与前台可见门控。
- 真实双设备验证需要用户已配置设备的连接授权；未授权时只能以测试与 loopback 证明。
- 关键文件高度共享，必须串行修改；同一时刻只跑一个 cargo 进程。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-14: Task document created and filled; execution begins with T-001.
- 2026-11-14: T-001 complete — session key helpers, explicit connection registry, device snapshot store and directed tests (19 passed).
- 2026-11-14: T-002 complete — switch preserves transports/panes, seeds the old device snapshot, startup restores explicit connections, disconnect closes confirmed panes; device tests passed.
- 2026-11-14: T-003 complete — global pane layout + legacy migration, composite runtime/handles, per-device terminal API routing, remote pane badges/missing-pane reconnect; terminal/layout tests passed.
- 2026-11-14: T-004 complete — cross-device Active aggregation, device strip with transport/status/connect/disconnect, device-qualified row actions; sidebar tests passed.
- 2026-11-14: T-005 complete — focus-driven cross-device switching, numeric shortcuts via focus registry, device-qualified notification focus; Rust attention tests passed.
- 2026-11-14: T-006 complete — `npm --prefix src test` 147 files/1212 tests passed; build and version sync passed; `cargo test -p agentport` 138 passed/3 ignored. i18n check only reports the pre-existing `capability.rs` literal.
- 2026-11-14: T-007 complete — signed Debug App rebuilt/restarted with exact PID path; real 5070 connection restored on startup and Active view showed This computer + 5070 SSH/RELAY strip with mixed hostAlive rows; screenshot non-blank. No host/connector was stopped.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: `npm --prefix src test` 147 files/1212 tests passed; `npm --prefix src run build` passed; `scripts/check-version-sync.sh` passed; `cargo test -p agentport --quiet` 138 passed/3 ignored; `cargo test -p agentport remote --quiet` 62 passed/3 ignored; `rustfmt --check` on the two changed Rust files passed; signed Debug App rebuilt/restarted with exact PID `68491` and screenshot `/tmp/agentport-final-active9.png` showing the cross-device Active view non-blank.
- Limitations: `npm --prefix src run i18n:check` still reports only the pre-existing HEAD literal in `crates/agentport-core/src/adapters/capability.rs:539`, which this task did not touch. A deliberate remote terminal input/attach-completion smoke was not performed against the user's live 5070 Session to avoid interfering with running work; the debug app did restore the explicit 5070 SSH connection, display both devices in the strip, aggregate their hostAlive Sessions, and render a remote pane header in the preceding state.
