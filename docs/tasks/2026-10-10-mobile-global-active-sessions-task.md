# Task Plan: Mobile 全设备 Active Session 汇总

- Created: 2026-10-10
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户已确认需求基线，并授权“编写计划并实施，完成该功能交付”。

<!-- task-doc-section:background-goal -->
## Background and goal

Mobile Active Session 同时展示所有手机已连接设备的活动会话，免逐台切换。保留 Projects 单设备行为、既有活动定义和会话操作。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 全局混排，逐行设备名；顶部显示所有已连接设备及数量，不提供单设备过滤。
- 活动为 hostAlive=true 且未归档，包含 Agent、Shell、空闲；沿用优先级、置顶、状态时间排序。
- 正确按设备路由打开和长按操作；返回保留 Active；Projects 恢复此前设备。
- 前台约 5 秒轮询，手动刷新所有已连接设备；后台暂停列表读取，不主动断连接。
- 断线移除；连接中但列表读取失败保留旧数据、明确状态未确认并禁用操作；单设备失败隔离。
- 不自动连接未连接设备、不新增在线探测、不新增批量操作、不改桌面展示和协议。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Active 目前使用单一 selectedDeviceId/snapshot | mobile/src/features/sessions/SessionDashboard.tsx |
| F-002 | 活动包含活着且未归档的 Shell，现有排序可复用 | mobile/src/features/sessions/sessionModel.ts 和 sessionModel.test.ts |
| F-003 | RemoteClient 支持按 profileId 请求和连接事件，connected 是本次在线边界 | mobile/src/protocol/remoteClient.ts；用户确认 |
| F-004 | Dashboard 既有 Projects 恢复、移除、通知与前台恢复回归覆盖 | mobile/src/features/sessions/SessionDashboard.test.tsx |
| F-005 | App 返回焦点目前只匹配 sessionId，跨设备同 ID 需补设备维度 | mobile/src/app/App.tsx |
| F-006 | 工作区开始时 git status --short 为空 | 2026-10-10 初始检查 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 无新增产品假设。用户已接受沿用活动定义、排序、既有操作和约 5 秒刷新。
- 验证边界：浏览器受控多设备数据可验证渲染和交互；真实 iOS 多电脑传输验证依赖真实设备，不以 mock 结果冒充真机验证。
- Open question: 无阻塞产品问题。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 至少两台 connected 设备同时显示，非 connected 不显示且无主动 connect/disconnect。
- 活动规则和全局排序正确，设备标签明确；同 Session ID 不串行、未读、打开、操作或焦点。
- 手动和定时刷新覆盖全部在线设备，慢设备不阻塞快设备，无重叠轮询；后台/终端内暂停列表读取。
- 断线及删除设备立即移出，迟到响应不重新加入；重连成功读取恢复。
- 读取失败保留旧列表但禁操作，明确设备和未确认状态，重试恢复；首次失败不伪装空列表。
- 无已连接设备、加载、无活动、部分失败可区分；Projects、通知、已有会话操作保持通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 + T-002 -> T-003 -> T-004。
- Parallel batches: 第一批 T-001 数据 hook（子代理）和 T-002 界面/路由（coordinator），通过预先确定的 hook API 解耦；第二批集成验证与独立只读审查；最后交付。
- Serialization constraints: 子代理只拥有 useActiveSessionSnapshots.ts/.test.tsx；coordinator 拥有其余修改及本计划。审查不编辑文件。所有提交由 coordinator 执行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 多设备独立快照与轮询

- Status: done
- Owner: /root/active-data
- Objective: 实现仅 connected 设备的独立读取、缓存错误、生命周期隔离、可见性轮询和统一刷新。
- Inputs and prerequisites: RemoteClient、HostProfileSummary、SessionSummary；预定 hook API；已确认需求。
- Scope or files: mobile/src/features/sessions/useActiveSessionSnapshots.ts 和 useActiveSessionSnapshots.test.tsx。
- Expected output: 返回 snapshots、refreshing、refresh(hostId?, afterPending?)；独立单测。
- Dependencies: None.
- Execution steps:
  1. 按 host ID 管理快照、请求代次与每设备合并读取；不建立/断开连接。
  2. 可见且 Active 时初读与 5 秒轮询，离开暂停；断线/删除失效迟到响应。
  3. 测试并返回文件与真实验证结果。
- Acceptance criteria:
  - 多设备独立，错误保留缓存；后台和断线不发列表读取；重连/返回重新读取；旧响应不污染。
- Verification method:
  - cd mobile && npm test -- src/features/sessions/useActiveSessionSnapshots.test.tsx。
- Validation evidence: coordinator 阅读实现/全部测试后复跑同一命令，1 文件 12 测试通过；客户端替换、StrictMode、迟到响应和尾随读取均有覆盖。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 全局 Active 界面与设备路由

- Status: done
- Owner: coordinator
- Objective: 接入多设备列表、全局范围、来源标签、异常状态、正确路由和焦点。
- Inputs and prerequisites: 预定 hook API；现有 Dashboard/App/排序/样式/i18n/测试。
- Scope or files: mobile/src/features/sessions/SessionDashboard.tsx、sessionModel.ts、dashboard.css、相关测试；mobile/src/app/App.tsx 及测试；mobile/src/i18n/resources.ts。
- Expected output: 完整全局 Active 用户行为及回归覆盖。
- Dependencies: None.
- Execution steps:
  1. 保留 Projects 路径，Active 独立数据源；复用单行渲染与排序。
  2. 设备+Session 组合标识贯穿未读、打开、动作、移除和返回焦点。
  3. 实现状态、统一刷新和项目设备恢复，补双语文案及窄屏来源布局。
- Acceptance criteria:
  - UI 满足范围、路由、失败和恢复要求；Projects 原回归通过。
- Verification method:
  - Dashboard、App 和 model 定向测试；集成后 TypeScript/build。
- Validation evidence: npm test -- src/features/sessions/GlobalActiveDashboard.test.tsx src/features/sessions/SessionDashboard.test.tsx src/features/sessions/sessionModel.test.ts src/app/App.test.tsx：4 文件 67 测试通过；npm run build：tsc --noEmit 与 Vite 构建通过。新增 GlobalActiveDashboard.test.tsx 覆盖双设备同 ID、未读、路由、失败禁操作、来源说明、断线和 Projects 恢复。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成审查和验证

- Status: done
- Owner: coordinator
- Objective: 检查异步边界、全套 mobile 回归和可视渲染，修复本任务发现的问题。
- Inputs and prerequisites: T-001 和 T-002 完成产物。
- Scope or files: 本任务修改文件；必要的回归测试。
- Expected output: 审查结论、单测/build 和受控 mobile 截图证据。
- Dependencies: T-001, T-002
- Execution steps:
  1. 阅读子代理 diff 并复跑定向测试；委派独立只读审查。
  2. 跑 mobile 全套测试与 build；浏览器受控双设备窄屏 smoke，记录截图路径与边界。
  3. 检查 git diff --check 和版本同步。
- Acceptance criteria:
  - 自动回归和构建通过；无未解决重要审查问题；非空白且来源可读的真实浏览器渲染。
- Verification method:
  - npm test / npm run build（mobile）；git diff --check；scripts/check-version-sync.sh；浏览器 screenshot。
- Validation evidence: mobile npm test 最终 41 文件/496 测试通过；npm run build（TypeScript/Vite）通过；git diff --check 与版本同步通过。独立只读审查发现 4 个 lifecycle/scroll 问题，分别用坏基线 3 failed/9 passed 及 1 failed/13 skipped 复现；修复后对应回归与全套通过。Chrome CDP 受控 320/390 CSS px smoke 覆盖混排、设备说明、实际行/time 边界、打开/置顶设备路由、部分失败、重试、断线/重连、Projects 恢复，runtimeErrors=[]；截图位于 /tmp/agentport-global-active-smoke/{active-dark-390,active-dark-320,partial-failure-320,active-light-320}.png，已读取确认。
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 状态收敛与提交交付

- Status: in_progress
- Owner: coordinator
- Objective: 启动调试窗口并核验精确目标，收敛验证证据与限制，完成计划和任务专属 Git commit；遵守用户后续禁止 computer 的约束。
- Inputs and prerequisites: T-003 验证通过。
- Scope or files: 本计划及本任务修改；LEARNS.md 的本任务窄屏验证经验；target/debug/bundle/macos/AgentPort.app（统一脚本）。
- Expected output: verified 计划、任务 commit、简洁交付说明。
- Dependencies: T-003
- Execution steps:
  1. 执行 python3 scripts/restart-debug-app.py，ps 核对精确 GUI 路径；不误杀 host/connector/release。记录已有窗口渲染证据；禁止 computer 后不再调用或重放暂停的截图操作。
  2. 记录验收证据及真机限制，验证计划文档；只 stage 本任务文件并 commit。
- Acceptance criteria:
  - 改动验证且提交；调试 GUI 精确路径已核对并保持打开；已有 mobile 浏览器截图正常；未完成的桌面截图与真机验证明确披露。
- Verification method:
  - 统一脚本、ps、已有 mobile 截图与窗口结构证据；task_document.py validate；git status/show。
- Validation evidence: python3 scripts/restart-debug-app.py 成功构建、固定证书签名并仅重启精确 GUI；ps 两次核对 PID 300 的 executable=/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport。用户禁止 computer 前已观察到 Project tree/Session 页面非空的 AXWebArea，截图调用因中断保持 paused、结果未核实且不重放。mobile 实际 Chrome 渲染截图已完成（T-003）。临时 harness 和两个自建服务已清理；diff/计划校验通过。任务 Git commit 待完成。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

定向 hook/model/Dashboard/App 用例覆盖双设备、同 ID、排序、手动刷新、轮询/后台、部分失败、迟到断线/重连、Projects 恢复。随后 mobile 全套 Vitest 和 TypeScript/Vite build。浏览器窄屏 smoke 使用受控 connected 数据，不冒充真实 iOS 通信；补更新后桌面调试窗口的精确进程/非空白截图。版本不变，执行版本同步门禁。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 快照跨设备非原子；连接状态不等于所有已配对电脑在线，均属于已确认边界。
- 原单设备全局 refreshEpoch 不适合复用为多设备请求代次，采用独立 hook 而不扩展其 Projects 行为。
- 断线/删除/视图暂停时的迟到读取、相同 Session ID、未读来源、弹窗失效和返回焦点需要对抗性验证。
- 无已知阻塞；真实多电脑 iOS 验证尚未执行。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-10: 建立唯一任务文档；检查仓库干净、相关源与回归测试；确认 execute 授权。
- 2026-10-10: T-001/T-002 进入 in_progress；确定并行文件边界和 hook API，开始数据层委派和界面工作。
- 2026-10-10 23:56: 收到 T-001 报告，阅读两文件并复跑 12 测试通过；T-001 done。coordinator 完成 T-002，67 定向测试和 mobile build 通过；T-002 done；T-003 in_progress，开始独立审查和整体/视觉验证。
- 2026-10-11 00:02: Chrome 截图发现 320 CSS px 隐式 grid 的 min-content 导致行/time 被裁切，root overflow 检查仍通过；改 minmax(0,1fr)，增加元素真实边界检查和 CSS 契约测试；dark/light 320 与 dark 390 均正常。
- 2026-10-11 00:03: 独立审查的 recovery 锁、选中设备变更导致退出全局、冷启动 Active scroll 三条用回归复现为 3 failed；按 ownership 修复后通过；管理删除设备亦覆盖。
- 2026-10-11 00:07: 连续复核发现已加载快照下安装 pending scroll 未触发 layout effect；新增用例先失败（期望75实际0），补 workspace 依赖修复，避免下一轮 poll 突然覆盖用户滚动。
- 2026-10-11 00:08: 最终 mobile 496/496 与 build 通过，Chrome smoke 通过，diff/版本检查通过；T-003 done。T-004 in_progress，记录一条已验证 grid 经验并开始调试包/提交交付。
- 2026-10-11: 统一脚本完成 debug build/sign/reopen，ps 核对 GUI PID 300 的精确路径。已观察窗口 AX 内容非空；用户随后禁止 computer，立即停止该工具。暂停的 capture 结果未确认，不当作成功、不重放；桌面截图保留为明确验证限制。清理临时 mock 页面与自建 Chrome/Vite 服务。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: not_run
- Evidence: Not run.
- Limitations: 真实 iOS 多电脑传输尚未验证；后续记录实际验证结果。
