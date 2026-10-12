# Task Plan: 移动端 Session 项目文件树与只读预览

- Created: 2026-10-12
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户确认需求后要求“编写计划并实施，完成该功能交付”。

<!-- task-doc-section:background-goal -->
## Background and goal

在移动端从 Session 终端左滑进入当前 cwd 的项目文件树，浏览目录和只读代码/Markdown，返回时不中断 Session、不丢失阅读位置。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

包含三页导航（列表、终端、文件树）、显式按钮入口、懒加载目录、进入及手动刷新、代码高亮、Markdown 源码/渲染、相对路径和内容复制、真实路径根目录边界、异常和截断状态。首版无编辑/写操作、Git 标记、搜索、图片预览、实时监听；不重构已有非限定文档接口的权限体系。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 已确认 cwd 为根、只读预览、根目录内访问及上述非目标 | 本轮前的结构化确认记录 |
| F-002 | App 已支持列表与终端之间横滑，并保持 Workspace 挂载 | mobile/src/app/App.tsx |
| F-003 | SessionSummary 包含 cwd、hostProfileId 位于 OpenSession | mobile/src/features/sessions/types.ts |
| F-004 | 现有 document.list/read 接收绝对路径、无 Session 根限定，目录 2000 项/文本 1 MiB 上限 | crates/agentport-service/src/lib.rs |
| F-005 | mobile 为 GPL-3.0-only，桌面/Rust 不可链接移动 GPL 实现 | AGENTS.md、mobile/package.json |
| F-006 | 初始工作区无未提交改动 | git status --short（2026-10-12） |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Accepted assumptions: 需求草案中的导航、收起键盘、状态保留、刷新、复制、.git 隐藏、资源限制和 Markdown 安全默认已由用户确认。
- Implementation decision: 新增 session.files.list/read，服务端由 sessionId 解析 cwd，客户端只传相对 path；保留现有 document 接口兼容性。不支持旧服务端时明确提示升级，不回退到无根约束接口。
- Open question: 无产品决策阻塞。原生/真机验收依赖本机可用运行设备与交互能力，需实际检查并如实记录覆盖。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 终端左滑/按钮进入目录，目录右滑/按钮返回，预览返回先回树；不抢纵向滚动、长按选择、快捷键及代码横滚。
- Session 连接与终端 DOM 保留；根按主机/Session/cwd 隔离；隐藏终端不改变其几何尺寸。
- 目录按需加载、刷新保持展开及滚动；能只读预览文本、代码高亮、Markdown 渲染/源码并复制。
- 后端真实路径验证拒绝父路径逃逸及外部符号链接，拒绝非普通文件，不产生写操作。
- 加载、空、无权限、缺失、断线、不支持格式及截断明确呈现；Markdown 不执行脚本、不自动请求外部资源。
- 定向自动化、类型/生产构建、集成检查通过；运行截图确认非空白；未能执行的设备覆盖明确记录。
- 验证后创建仅包含本任务改动的 Git commit。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001、T-002、T-003 按固定接口契约并行；T-004 依赖前三项；T-005 依赖T-004且需可用真机/已授权连接。
- Parallel batches: 第一批后端限定接口、独立文件浏览组件、协调者导航集成；第二批跨层验证交付。
- Serialization constraints: 后端仅拥有 service/bridge/protocol 及必要 Cargo 锁文件；前端子任务仅拥有 features/files、i18n、mobile package/lock/third-party licenses；协调者拥有 App、SessionWorkspace、终端手势、文档。不并行写同一文件；本文件仅协调者维护。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Session 根限定只读接口

- Status: done
- Owner: backend
- Objective: 提供受 Session cwd 限定的目录及文本读取能力。
- Inputs and prerequisites: F-003/F-004；固定协议 session.files.list/read，参数 sessionId 与相对 path（list 默认 .），响应 rootPath、相对 path；list entries 的 path 也为相对路径，包含 name/isDir；read content/sizeBytes/truncated。
- Scope or files: crates/agentport-service、crates/agentport-remote-bridge、crates/agentport-remote-protocol、Cargo.lock。
- Expected output: 根限定接口、桥接路由、边界/错误/截断回归测试。
- Dependencies: None.
- Execution steps:
  1. 检查服务结构与错误编码，新增接口并测试正常、越界、符号链接、非文本和限制。
- Acceptance criteria:
  - 由服务端 sessionId 解析根；真实目标在根内；不兼容回退及写操作；旧 document 不变。
- Verification method:
  - 定向 Cargo tests 与 bridge framing 测试。
- Validation evidence: 协调者运行 cargo test -p agentport-service session_files --lib（8/8）、cargo test -p agentport-remote-bridge --lib（19/19）、cargo test -p agentport-remote-protocol --lib（13/13）通过；后端子任务全量 service 串行 56/56。审查真实路径、固定目录句柄 NOFOLLOW 及桥接 Read registry。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 移动文件树与安全预览组件

- Status: done
- Owner: file-ui
- Objective: 实现独立 SessionFiles 组件，拥有树和下一级预览状态。
- Inputs and prerequisites: 上述固定协议；props open/client/active/onBack；组件由 App 按 host/session/cwd key 挂载，隐藏时保持挂载。
- Scope or files: mobile/src/features/files、mobile/src/i18n/resources.ts、mobile/package.json、mobile/package-lock.json、mobile/THIRD_PARTY_LICENSES.md。
- Expected output: 只读浏览、高亮、安全 Markdown、刷新/错误/复制/焦点与状态处理及测试。
- Dependencies: None.
- Execution steps:
  1. 实现组件与必要兼容许可依赖，补充本地化、样式与定向测试。
- Acceptance criteria:
  - 实现需求范围、请求隔离/过期响应防护；树根支持横滑返回、预览标记不接管横滑；禁用外部资源加载与不安全链接。
- Verification method:
  - Vitest 定向组件/安全测试、TypeScript 检查。
- Validation evidence: 组件 31 项定向测试通过，TypeScript 检查通过；协调者完整 mobile 测试中此套件通过。独立审查发现继承键目录缓存缺陷，已用 own-property 判断修复并覆盖 constructor/__proto__/toString 三例。已查看手机视口文件树、代码高亮、Markdown 与窄屏浅色截图。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 三页导航与终端手势集成

- Status: done
- Owner: coordinator
- Objective: 将文件页接入现有 Session 页面，保证终端及手势行为不回归。
- Inputs and prerequisites: 已固定的 SessionFiles props 与协议契约，集成测试待 T-002 文件可用后运行。
- Scope or files: mobile/src/app、mobile/src/features/sessions/SessionWorkspace.tsx、mobile/src/terminal 必要手势处。
- Expected output: 三页状态、按钮入口、手势隔离、保持挂载与导航测试。
- Dependencies: None.
- Execution steps:
  1. 检查并集成子任务结果，新增导航及手势回归测试。
- Acceptance criteria:
  - 左滑进入/右滑退出不重连、不丢终端位置；不干扰选择/纵向滚动/预览横滚；隐藏页不可交互。
- Verification method:
  - App 与 MobileTerminal 定向测试及完整 mobile 测试/构建。
- Validation evidence: App 13 项、MobileTerminal/SessionWorkspace 共100项通过，完整首次 mobile 600/600及构建通过。node mobile/scripts/test-session-files.mjs 真实 Chrome/xterm 触摸回归通过：左滑/按钮进入、右滑返回、预览横滚、目录纵滚/展开保留、终端 DOM/阅读位置保留、无重 attach、Markdown 无外部元素；390/320宽度、浅深色与横屏截图。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 运行验证、审查与提交交付

- Status: done
- Owner: coordinator
- Objective: 验证跨层功能，启动更新调试包，记录覆盖并提交。
- Inputs and prerequisites: T-003 完成。
- Scope or files: 本任务全部 diff、mobile/SESSION_FILES.md、mobile/scripts/test-session-files.mjs、任务文档、调试构建产物。
- Expected output: 自动化与运行证据、审查修正、独立 commit。
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. 运行测试/构建/版本检查和安全对抗审查；可用环境中完成移动视口交互和截图。
  2. 使用 scripts/restart-debug-app.py 构建签名重启，核对精确 GUI 路径及非空白截图，不关闭 Host/Connector/发布 App。
  3. 记录最终结果与验证缺口，验证任务文档并提交本次文件。
- Acceptance criteria:
  - 自动化门禁通过，运行证据真实，diff 无无关改动，形成 Git commit。
- Verification method:
  - mobile npm test/build、定向 Rust tests、scripts/check-version-sync.sh、git diff --check、调试窗口截图。
- Validation evidence: 最终定向前端145/145、service串行56/56、bridge19/19、protocol13/13通过；mobile生产构建、真实Chrome文件页触摸脚本及既有terminal-touch脚本通过。最终签名iOS模拟器包安装启动及桌面调试包重启均成功，并复核精确GUI路径及非空白截图。版本同步与diff检查通过。功能已独立提交 fde7c2c（25文件）；最后共享全量测试716/717，唯一失败在外部并行改动的AddProjectDialog测试，不纳入本任务修复。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 真机与真实连接端到端验收

- Status: blocked
- Owner: coordinator
- Objective: 补足设备/真实连接验收，不把模拟数据触摸回归当作真机证据。
- Inputs and prerequisites: 已提交功能与签名构建包、可连接的手机或已配置授权的模拟器SSH服务。
- Scope or files: iOS/Android设备交互、真实主机连接及任务验证记录；不擅自更改密钥。
- Expected output: 真机终端左滑、目录展开、真实文本/Markdown预览、返回终端及软键盘/选择无冲突的证据。
- Dependencies: T-004.
- Execution steps:
  1. 设备可用后安装已验证构建，连接用户已授权主机，完成实际文件只读浏览路径并记录截图。
- Acceptance criteria:
  - 真实连接读取的是该Session的cwd，边界与手势/返回状态符合需求；如需新授权先取得用户同意。
- Verification method:
  - 原生设备操作与真实服务返回对照，不使用fixture替代。
- Validation evidence: xcrun devicectl list devices 显示物理手机 unavailable；iOS26.5模拟器已安装启动，但已有127.0.0.1:51222配置返回ssh connection failed，lsof无监听且launchctl找不到本地调试SSH服务。未更改密钥或自动新增授权。
- Blocker: 当前没有可用的真实手机连接，模拟器也没有现成可用的本地授权服务。
- Unblock condition: 用户连接并信任开发手机，或明确授权配置本地模拟器调试SSH连接；之后继续此任务文档，不重新规划功能。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

后端测试正常根/嵌套/非法路径/外部链接/二进制/截断/会话隔离；前端测试懒加载、刷新保留、请求竞态、离线/重试、Markdown XSS/链接及复制；App 测试三页导航、持续挂载、焦点与手势隔离。完成后运行完整 mobile 测试和构建、相关 Rust 包测试、版本同步与 diff 检查。实际运行覆盖以可用设备/浏览器/调试 App 为准，不把 DOM 测试等同于真机。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 新移动端依赖新服务端接口，旧版本明确提示升级。
- 文件可被 Agent 并发修改；只读 UI 标注刷新状态，内容刷新不承诺跨请求一致快照。
- 本地真实路径检查需考虑符号链接和特殊文件；不把字符串前缀判断当安全边界。
- 手机触摸/软键盘/系统返回无法仅凭 jsdom 证明，必须区分自动化与设备覆盖。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-12: 检查工作区与现有 App/Service/测试，建立需求与固定接口契约。T-001、T-002 开始，按文件所有权并行派发。
- 2026-10-12: 接口与组件 props 已固定，确认 T-003 文件不重叠，调整为契约驱动并行；协调者开始导航工作，最终跨层验收仍串行。
- 2026-10-12: 后端发现协议 registry/mobile allowlist 必须同步，扩展其所有权至 remote-protocol；新增8个路径安全测试，协调者重跑通过，T-001 done。
- 2026-10-12: 独立只读审查发现普通对象继承键会误判目录缓存，修复并新增3项回归，组件31项通过，T-002 done。
- 2026-10-12: 完成三页/inert/焦点及长按和纵向手势隔离，隐藏终端不向主机提交 resize。真实触摸回归通过并保存 /tmp/agentport-files-evidence/ 截图，T-003 done，T-004 开始。
- 2026-10-12: npm run build:ios-simulator 已成功构建签名包并安装启动 iOS26.5模拟器，非空白；物理手机当前 unavailable。现有模拟器 localhost:51222 配置连接失败，确认该调试SSH服务未安装/监听，未更改密钥或另配主机，真实连接端到端验收缺口保留。
- 2026-10-12: scripts/restart-debug-app.py 构建签名重启成功；ps 确认新GUI路径为 target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport；精确窗口激活截图确认前端正常，未停止Host/Connector。
- 2026-10-12: 全量 mobile 首次600/600通过；后续发现并行外部任务正在修改 AddProjectDialog、projectDirectory 和 resources.project，出现对应测试失败（序列重跑604/607）；不修改或提交其工作，待其稳定后复核。Rust service曾出现既有Host input计时用例一次失败，隔离及串行全量56/56通过。
- 2026-10-12: 将非Unix的通用read_failed改为明确unsupported_platform并本地化，补充第32项文件组件测试；新增mobile/SESSION_FILES.md说明协议、行为、支持边界与回归入口。
- 2026-10-12: 最终定向145/145、Rust56+19+13通过；mobile生产构建与文件/终端两个真实Chrome脚本通过。最后共享全量716/717，唯一失败归于并行AddProjectDialog兼容任务。最终iOS模拟器重建安装启动通过；桌面统一脚本重启GUI PID12929，ps路径及debug-app-final.png确认目标正确。T-004 剩余动作是只提交本任务文件及共享文件中的本任务片段，不包含外部任务document.list allowlist/resources.project改动。
- 2026-10-12: 功能提交 fde7c2c 已创建（25文件）。暂存前确认索引为空，对resources及protocol从HEAD重建仅本任务增量并检查未纳入外部片段。T-004 done，交付含明确真机/端到端验证限制，最终验证结果保持partial而非宣称全平台通过。
- 2026-10-12: 新增T-005以显式追踪实际发生的设备验收阻塞；整体blocked仅代表该验收未闭环，代码、自动化、构建和功能提交已完成。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001 至 T-004 完成，T-005因设备/连接环境受阻，功能提交 fde7c2c；共享文件按片段暂存，仅包含本任务改动，外部项目目录兼容改动保留在工作区。最终本任务定向145项和Rust88项通过，生产构建、2个真实Chrome触摸脚本、iOS模拟器签名构建/启动、桌面调试重启截图通过。截图在 /tmp/agentport-files-evidence/；实际命令和结果见T-004及执行日志。
- Limitations: 未完成真实手机/Android/VoiceOver及真实网络端到端文件浏览（手机不可连接，模拟器已有本地SSH服务缺失，未擅自配置密钥）。Unix安全接口在macOS运行验证，Linux未实机验证；非Unix明确unsupported_platform。共享全量最后716/717，剩余失败来自外部并行旧主机兼容任务；不宣称全量通过。
