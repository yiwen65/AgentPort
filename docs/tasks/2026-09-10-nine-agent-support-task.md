# Task Plan: 九种 Coding Agent 完整接入与交付

- Created: 2026-09-10
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 本会话已确认九种 Agent 需求，以及用户“编写计划并执行，成功目标是完成成品交付”。

<!-- task-doc-section:background-goal -->
## Background and goal

在 AgentPort 现有持久 Session 工作台中正式接入 Oh My Pi、OpenCode、Amp、Gemini CLI、Cline CLI、Kiro CLI、Cursor CLI、easy-pi 和 xAI Grok Build。交付可运行的调试 App、验证证据与相关 Git commit，而非仅添加选项。本文档为唯一执行状态记录。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

覆盖 macOS + Linux 的公共后端、GUI、无头 CLI；按上游真实能力支持启动、权限、状态和原生恢复。保留 Pi，easy-pi 使用 ~/.epi 并隔离数据。新增九种图标优先下载 LobeHub 资源并适配 light/dark，缺失则优先官方资源且遵守许可。公共 PTY、日志、Worktree 与存活重连不能退化。

不自动安装或代登录、不修改 CLI 全局配置、不绕过默认审批、不接入编辑器扩展、不伪造会话恢复。仅执行已授权本地开发、资源下载、测试、调试包重启和相关提交；不修改现有其他工作，不操作发布版 GUI 或 Session Host/Connector。实际调用模型、账号操作和不可确认的官方资源如需额外权限则阻塞相关验收并询问。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 九种工具、双平台、按能力完整接入、分层实机验收及图标策略已确认 | 本会话需求确认 |
| F-002 | AgentType 是 Rust 枚举，ALL 是探测注册表；目前六种类型 | crates/agentport-core/src/models.rs:42-149 |
| F-003 | Adapter 负责能力快照、launch/resume 及 PTY 信号；禁止假设参数 | crates/agentport-core/src/adapters/mod.rs |
| F-004 | 预设、历史、原生备份、CLI 和远程服务存在类型分支，需要跨层集成 | rg AgentType::Pi/AgentType::Qoder crates src-tauri；db/mod.rs:1645；history.rs:504；service/src/lib.rs:3030 |
| F-005 | 前端图标、类型、排序、名称和选择器有固定列表 | src/src/components/AgentIcons.tsx；types.ts；agentOrder.ts；SplitAgentPicker.tsx |
| F-006 | 本机 PATH 可找到 omp、grok、pi；相邻 checkout 含 easy-pi/pi、oh-my-pi、grok-build | command -v 与 ls /Users/w/Projects/easy-pi，2026-09-10 |
| F-007 | 已有无关未提交修改，必须保留 | 初始 git status：LEARNS.md、docs/mobile-app-prd.md、mobile Apple 工程/生成 schema、mobile/src/terminal/iosIme.md |
| F-008 | 调试包必须通过统一脚本构建签名并精确重启，交付须截图与 commit | AGENTS.md |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 已接受假设：正式 Agent 覆盖 GUI 与无头 CLI；明暗主题适配不要求两份源图；Grok Build 遵循同样验收要求。
- 实施契约：canonical ID 为 omp、opencode、amp、gemini、cline、kiro_cli、cursor_agent、easy_pi、grok_build；Rust variant 为 Omp、Opencode、Amp、Gemini、Cline、KiroCli、CursorAgent、EasyPi、GrokBuild。可执行名以官方证据为准；显示名保持产品原名。
- 待验证假设：CLI help 与官方源码足以证明本轮可适配能力。影响：无法证实的 flag、权限或 exact-resume 必须拒绝或明确降级，而非猜测。
- 待验证假设：Linux CLI 可用性因发行版本而异。通过源码、测试和可用本地环境验证，不把 macOS 实机结果表述为 Linux 实机通过。
- Open question: 无产品范围待决策；官方来源无法确认、图标无合法来源、账号或外部调用要求如出现则记录任务阻塞并提问。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 九种独立类型可从 GUI 与无头 CLI 发现、选择和按正确命令启动，默认沿用原生权限；未知/缺失能力有清楚错误或降级通知。
- 自动化覆盖九种探测、启动、恢复和不支持分支；不恢复错误对话、不串用 Pi/easy-pi/omp 配置与会话。
- 新增图标有可追溯来源和许可记录，明暗主题可辨识；原有 Agent 图标与行为不被无关修改。
- 后端/前端相关回归与构建通过；已安装工具至少完成安全探测及可用真实 PTY 冒烟，未验证能力明确列出。
- 更新文档解释能力与验证矩阵；统一脚本重启目标 debug App，ps 确认路径并截图确认非白屏；只提交任务相关文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-003 -> T-007；T-001、T-004 -> T-008；T-001、T-002、T-003、T-004、T-007、T-008 -> T-005 -> T-006。
- Parallel batches: A = T-001 七种非 Pi 派生适配、T-002 Pi 派生适配、T-003 前端图标与交互、T-004 协调者跨层注册和集成；B = T-005 集成验证与修正；C = T-006 成品验证和提交。
- Serialization constraints: adapters/mod.rs 与 models.rs、其余 Rust 消费层仅协调者修改；T-001 只修改 extended.rs 和独立 fixture；T-002 只修改 pi_family.rs、pi.rs 和独立 fixture；T-003 只修改 src/src 前端及图标来源文档。任务文档始终仅协调者修改。公共 build、锁文件、调试 App 重启和 Git 提交串行。A 批任务无依赖且契约输入已具备，可并行；后续按依赖 done gate 启动。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 七种非 Pi 派生 CLI 证据与适配

- Status: done
- Owner: extended-adapters
- Objective: 实现 OpenCode、Amp、Gemini、Cline、Kiro、Cursor、Grok Build 的证据驱动适配。
- Inputs and prerequisites: 已确认范围、AgentAdapter trait 与 canonical 类型契约。
- Scope or files: crates/agentport-core/src/adapters/extended.rs；tests/fixtures/cli 中新增对应 fixture；新增官方能力证据文档 docs/agent-cli-evidence.md。
- Expected output: 七种可测试的 adapter、官方接口证据及明确能力降级。
- Dependencies: None.
- Execution steps:
  1. 读取官方文档/源码与本机安全 help，确认来源、参数、恢复与权限语义。
  2. 实现可验证 launch/resume、状态提示和保守能力处理，补充纯解析及命令测试。
- Acceptance criteria:
  - 七种分别覆盖启动/恢复/缺参数行为，Grok 不接错同名项目；不伪造 exact-resume 或权限能力。
- Verification method:
  - 定向 adapter 单元测试；fixture 与官方来源核对；集成编译由 T-005 串行执行。
- Validation evidence: 2026-09-10 cargo test --workspace --all-targets 成功，648 passed / 8 ignored；extended 12 项测试通过，覆盖七类型矩阵；真实 grok probe1.0.13成功，同名非 Cursor agent 正确被拒绝。docs/agent-cli-evidence.md 与 fixture 均已审阅。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Oh My Pi 与 easy-pi 隔离适配

- Status: done
- Owner: pi-family
- Objective: 依据本机源码为 omp 和 easy-pi 增加独立适配，保留原 Pi。
- Inputs and prerequisites: 相邻 easy-pi 与 oh-my-pi checkout；现有 pi adapter；canonical 类型契约。
- Scope or files: crates/agentport-core/src/adapters/pi_family.rs；必要时 pi.rs；新增 omp/easy-pi fixture。
- Expected output: 分离的命令、配置/会话目录与恢复逻辑及回归测试；向协调者提供生命周期接入接口。
- Dependencies: None.
- Execution steps:
  1. 核实 CLI bin、数据目录、帮助与会话格式；遵循 pi 专题文档要求。
  2. 实现适配与参数防护测试，反馈 history/backup 等集成要求。
- Acceptance criteria:
  - 原 Pi 行为保留，easy-pi 不读取 ~/.pi，omp 不假设与 Pi 参数完全相同；恢复目标可验证。
- Verification method:
  - Pi 家族定向单元测试与真实只读 probe；最终由 T-005 统一测试。
- Validation evidence: workspace 测试通过，pi_family10项及原Pi6项通过；实际 Omp18.0.11/easy-pi0.84.2 探测、隔离HOME下 Host/PTY启动/两次attach/停止通过；Omp cold restart 保留同一原生UUID且渲染成功。实际身份判据为 help品牌+产品环境变量契约，而非单靠包名。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 前端九种入口与主题图标

- Status: done
- Owner: agent-ui
- Objective: 九种在现有 UI 正式可用，图标可追溯且适配明暗主题。
- Inputs and prerequisites: canonical ID、现有 AgentIcons/类型/选择器与用户图标策略。
- Scope or files: src/src 前端相关文件和测试；新增 docs/agent-icon-sources.md；不改包锁或 Rust 文件。
- Expected output: 类型、名称、排序、预设本地化、选择器、图标与必要能力提示。
- Dependencies: None.
- Execution steps:
  1. 获取 LobeHub 或官方合法资源，记录来源与主题处理。
  2. 更新入口和能力提示，补充九种注册及主题相关测试。
- Acceptance criteria:
  - 九种均正确呈现，不退化为错误品牌图标；所有现有 Agent 图标不变；原生权限与无能力提示一致。
- Verification method:
  - 相关 Vitest 与 npm run build；T-006 检查实际 App 截图。
- Validation evidence: 本任务所有新增/修改组件测试通过；整体npm test为614 passed/9 failed，9项均是未改动App测试缺少Tauri Webview mock，已在git archive HEAD隔离副本复现完全相同失败（T-007处理）。npm run build成功，图标来源/许可及light-dark语义色测试通过；实际像素验收仍属T-006。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 跨层类型、探测、持久化与生命周期集成

- Status: done
- Owner: coordinator
- Objective: 将九种贯穿核心注册表、预设、CLI、服务和数据生命周期，不遗留穷举分支或错误备份路径。
- Inputs and prerequisites: 已有代码证据、canonical 契约；模块入口与子任务协调。
- Scope or files: models.rs、adapters/mod.rs、capability.rs、db、history、backup/native_backup/native_cleanup、agentport-cli、service、remote-protocol、host semantic_events 及必要 Tauri 消费层；mobile/src/features/sessions/sessionModel.ts 和其测试仅修正新类型默认权限的远程兼容；排除子代理所有文件与无关 mobile 改动。
- Expected output: 全链路注册、默认预设、保护性生命周期分支、集成测试。
- Dependencies: None.
- Execution steps:
  1. 添加独立类型及真实命令候选；更新远程枚举兼容和入口。
  2. 补齐预设、恢复/备份/历史消费层，未知原生格式明确不可用，不猜文件路径。
  3. 与子代理确认模块接口并添加注册/存储回归测试。
- Acceptance criteria:
  - 九种可被注册和持久化；不会把新类型误当 Pi 或 Shell；现有数据无破坏性迁移。
- Verification method:
  - 定向模型/DB/CLI 测试，T-005 全 workspace 编译与回归。
- Validation evidence: workspace648 passed/8 ignored；core新增类型/预设/保护参数/history/backup隔离与service远程序列化通过；host29测试通过（包含三种Pi家族semantic source），mobile sessionModel4测试通过。实际probe15种，已安装新增三种可用，六种未安装明确不可用；原Pi缓存行为保留。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 集成审查、回归与能力交付矩阵

- Status: done
- Owner: coordinator
- Objective: 独立检查各子任务结果并验证九种跨层行为，修正本任务缺陷。
- Inputs and prerequisites: A 批任务输出与可运行测试。
- Scope or files: 本任务相关代码/测试、README.md、docs/user-guide.md 和能力证据文档；不得引入无关清理。
- Expected output: 通过的自动化验证、真实 CLI 探测/冒烟及明确验证矩阵。
- Dependencies: T-001, T-002, T-003, T-004, T-007, T-008
- Execution steps:
  1. 审查所有 diff，验证参数语义、权限、恢复、安全边界和不同客户端类型兼容。
  2. 运行 Rust workspace 与前端测试/构建；对已安装且可安全启动工具做隔离临时目录 PTY 冒烟，不发送模型请求或修改账号。
  3. 记录实际命令、能力、平台及未实机验证项，修复相关回归。
- Acceptance criteria:
  - 所需自动化通过，真实运行证据与局限透明，九种无遗漏；无用户原生会话被修改。
- Verification method:
  - cargo test --workspace --all-targets；cd src && npm test && npm run build；定向 probe/PTY 冒烟。
- Validation evidence: 最终cargo test --workspace --all-targets全部650 passed/8 ignored（系统凭据/手动环境测试不执行）；前端83文件623 passed，npm run build和npm run i18n:check通过；mobile sessionModel4 passed；CLI/Host开发构建通过。新增子命令成功/失败能力探测回归通过。真实CLI probe + e2e/nine-agent-smoke.py三种启动/重连/停止通过，Omp额外cold resume同UUID通过；全部隔离HOME、无模型输入。README/用户指南/官方接口证据/图标许可证已审查。日志/tmp/agentport-nine-{workspace-final,frontend,frontend-build}.log和/tmp/agentport-nine-{smoke,resume-smoke}.json。
- Blocker: None.
- Unblock condition: None.

### [ ] T-006 — 调试成品、截图与 Git 交付

- Status: blocked
- Owner: coordinator
- Objective: 打开更新后的可运行调试 App 并提交所有且仅相关成果。
- Inputs and prerequisites: T-005 验证通过；AGENTS.md 安全重启规则。
- Scope or files: target/debug/bundle/macos/AgentPort.app；任务相关 Git diff；本文档。
- Expected output: 正确路径运行的已签名 debug App、非白屏截图、相关 Git commit 和最终报告。
- Dependencies: T-005, T-009
- Execution steps:
  1. 执行 python3 scripts/restart-debug-app.py，不手工查杀进程。
  2. 用 ps 确认 exact GUI 路径，激活并截图检查真实窗口与主题。
  3. 验证任务文档、检查 diff，显式 git add 相关文件并提交。
- Acceptance criteria:
  - 构建签名成功、目标窗口正常渲染、现有 Session/发布 GUI 未受干扰；提交不含初始无关改动。
- Verification method:
  - 统一重启脚本、ps、截图读取、git diff --check、任务文档 validator、git show --stat。
- Validation evidence: python3 scripts/restart-debug-app.py构建签名成功；新GUI PID32401路径精确为target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport；重启前后5个既有Host/Connector/发布GUI均保留。CGWindowList识别目标窗口781；窗口截图失败，屏幕截图全黑。CGPreflightScreenCaptureAccess=true，但frontmost=com.apple.loginwindow，ioreg确认CGSSessionScreenIsLocked=true。并非证明App白屏；无法在锁屏下做实际视觉验收。现已按用户最终指令创建Git提交（主题：feat: add nine coding agent integrations with themed icons），仅含本任务74个文件；最新构建最终截图仍未完成。
- Blocker: 最新构建的设置页/明暗最终截图尚未完成；macOS再次锁屏。用户已明确要求“直接提交”，因此不等待截图，保留该验收限制，不把视觉验收标记通过。
- Unblock condition: 后续解锁后可补最新构建设置页去重与明暗截图；当前按用户指令直接创建相关Git提交。

### [x] T-007 — 恢复 App 测试的原生 Webview 边界 mock

- Status: done
- Owner: coordinator
- Objective: 消除已在干净HEAD复现的测试环境阻塞，确保完整前端回归能够执行。
- Inputs and prerequisites: npm test 的9项失败堆栈；git archive HEAD导出到/tmp的同样9项失败；现有App原生drag-drop effect。
- Scope or files: src/src/test-setup.ts，仅测试环境，不改生产App。
- Expected output: 对Tauri getCurrentWebview/onDragDropEvent的最小无副作用mock。
- Dependencies: T-003
- Execution steps:
  1. 在公共Vitest setup补齐原生Webview监听的注册/释放stub，保持业务组件和断言不变。
  2. 重跑此前失败三文件及完整前端测试。
- Acceptance criteria:
  - 原9项失败通过，其余测试不回退；未通过忽略测试或修改生产行为规避失败。
- Verification method:
  - npm test；检查diff只增加原生桥接测试边界。
- Validation evidence: 修复前当前checkout与git archive HEAD隔离副本同样9项metadata缺失；添加单个原生Webview stub后npm test全部83文件623测试通过（/tmp/agentport-nine-frontend.log），无生产App修改。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — CLI 显式权限贯穿启动计划

- Status: done
- Owner: coordinator
- Objective: 修复审查发现的CLI权限覆盖丢失，保证新Agent的实际命令与用户选项、保存状态一致。
- Inputs and prerequisites: launch_session的permission与LaunchContext.preset.permission_mode存在首个分歧；无头CLI回归已复现。
- Scope or files: crates/agentport-cli/src/main.rs及内嵌测试；必要i18n allowlist仅同步被修改文案。
- Expected output: 生效权限写入adapter输入；不支持模式在启动前拒绝；准确描述CLI权限边界。
- Dependencies: T-001, T-004
- Execution steps:
  1. 验证OpenCode原生预设+显式Bypass应在adapter拒绝，不能先到risk-ack阶段。
  2. 在构造LaunchContext前用已解析effective permission覆盖克隆预设，不改变已保存预设。
  3. 重跑最小CLI回归与workspace测试。
- Acceptance criteria:
  - 回归从预期错误的blocked risk-ack变为正确的unsupported permission Validation；没有会话或进程被创建。
- Verification method:
  - cargo test -p agentport-cli --bin agentport-cli explicit_permission_reaches_adapter_before_preflight_or_spawn；workspace回归。
- Validation evidence: 修复前最小回归失败，stderr显示permission=bypass但完整命令没有任何权限参数；错误到达risk-ack而非adapter的unsupported Validation，证实原生预设覆盖显式模式。仅将effective permission传入克隆LaunchContext preset后，同一cargo test -p agentport-cli --bin agentport-cli explicit_permission_reaches_adapter_before_preflight_or_spawn通过，无Session创建。首次fixture路径缺失的无关失败未当作产品证据。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 升级缓存的 Pi/easy-pi 身份去重

- Status: done
- Owner: coordinator
- Objective: 修复真实设置页发现的同一pi可执行文件被旧缓存同时展示为Pi/easy-pi，保留旧Session恢复记录。
- Inputs and prerequisites: /tmp/agentport-nine-adapters-dark.png显示相同路径被列为Pi与easy-pi；实时probe已正确仅接受easy-pi。首个分歧为db.list_adapters无条件返回旧缓存。
- Scope or files: core db适配器选择视图和测试、service supported_agents/新建入口、CLI新建入口；不删除旧adapter缓存或迁移Session。
- Expected output: 相同可执行身份的Pi/easy-pi按最近成功探测去重；旧get_adapter仍可供既有Session恢复；错误新建选择明确拒绝。
- Dependencies: T-002, T-004, T-005
- Execution steps:
  1. 编码旧Pi与新easy-pi同路径缓存的失败回归，包括反向升级及符号链接。
  2. 可选列表使用最近验证的身份，保留原始缓存供恢复。
  3. 回归后统一脚本重新构建/打开，再次截图确认去重与明暗图标。
- Acceptance criteria:
  - 同一可执行文件不在新建列表中重复作为两种产品；原Pi旧会话无破坏性迁移。
- Verification method:
  - core/service/CLI回归、workspace；真实设置页截图。
- Validation evidence: 修复前DB回归明确得到2条而非1条；修复后同路径、符号链接、反向升级及保留原始get_adapter缓存测试通过，service可选API回归通过。最终cargo test --workspace --all-targets -- --test-threads=4为653 passed/8 ignored；默认并发一次合成probe因系统负载触发2秒超时，未放宽生产timeout，限制测试并发后全通过。统一脚本重建签名打开新GUI PID89132，最终像素检查由T-006完成。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先以 fixture/纯函数测试核对 CLI 能力和参数，集成后统一运行 cargo test --workspace --all-targets 与前端 npm test/npm run build。网络仅获取公共文档/资源；真实工具用 --help/--version 及不发送提示的临时目录 PTY 冒烟，禁止将安装/登录缺失视为通过。Linux 如无可用执行环境仅记录静态/自动化覆盖，不宣称实机通过。最终调试包通过统一脚本构建嵌入前端并签名，精确核对 GUI 路径和截图，保留 Session 进程。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

CLI 版本变化、同名命令误识别、恢复语义不同、easy-pi/Pi 共用命令造成误探测、权限 flag 误传、原生格式不可用、图标许可及缺失、远程客户端枚举拒绝新类型。未知能力以清晰不可用/降级处理。现有用户未提交工作只读保留。当前无阻塞，所有产品能力完成仍需验证。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-10: 创建 execute 模式文档，核实根目录、AGENTS.md、初始 git status、核心注册/消费层和本机命令位置。
- 2026-09-10: T-001/T-002/T-003/T-004 -> in_progress；固定类型契约与不重叠文件归属，协调者独占任务文档。计划通过 validator 后通过 parallel wrapper 同批启动三个 spawn_agent 子代理（运行时无 DAG 专用工具）。
- 2026-09-10 03:55 UTC: T-004 完成九种类型、预设和远程映射初稿，增加跨层 round-trip、namespace history/backup 测试。发现 mobile quick-start 会给未知类型传 bypass，增加两文件最小兼容修正，保留旧四种策略及现有未提交 mobile 工作。
- 2026-09-10 03:55 UTC: T-001 官方证据确认 Amp 原生不逐次审批、Cline CLI 默认 auto-approve=true，必须准确提示而非承诺 native=逐次审批。T-002 确认 easy-pi bin 仍为 pi，候选身份需读包元数据 piConfig.configDir 区分。权限模型临时假设已通知子代理不得当成确认事实，待源码核实后统一。
- 2026-09-10 03:55 UTC: Kiro/Amp 只读探测补充 chat --help / threads continue --help；失败不合成能力。原生历史未知的七种明确标记 unsupported，终端重连仍可用。
- 2026-09-10 04:12 UTC: T-001/T-002/T-003/T-004 -> done，独立审阅代码与验证。workspace648通过8忽略；frontend614通过9失败、build通过；mobile4通过。新增失败并非本任务引入：从git archive HEAD隔离导出src并复现完全相同9项Tauri Webview mock缺失。
- 2026-09-10 04:12 UTC: 新增T-007 -> in_progress，作为完整测试交付必要的单文件测试基础设施修正，不改生产App或跳过断言。T-005依赖增加T-007。
- 2026-09-10 04:14 UTC: T-007 -> done，完整前端623项通过。发现CLI已有显式权限被预设覆盖会影响新增Agent，新建T-008 -> in_progress并补最小失败回归，T-005依赖加入T-008。
- 2026-09-10 04:18 UTC: T-008 -> done，最小回归由正确原因失败转为通过；CLI风险文本不再宣称所有检查必然绕过，i18n allowlist同步删除两个已替换文案及三个已在HEAD失效的Tauri旧预设条目。T-005 -> in_progress，审查各diff、补用户指南并进行最终综合回归。
- 2026-09-10 04:22 UTC: T-005 -> done，最终Rust650通过8忽略，前端623通过，i18n/build/mobile通过。新增三种本机CLI隔离无输入冒烟通过、Omp同UUID冷恢复通过。T-006 -> in_progress，统一脚本dry-run精确目标旧GUI PID1013，不查杀Host/Connector/发布GUI。
- 2026-09-10 05:12 UTC: 统一脚本构建/签名/重启成功，新GUI PID32401，5个既有受保护进程均存活。目标窗口存在但捕获黑屏；只读诊断确认系统锁屏且屏幕录制权限已具备（loginwindow frontmost、CGSSessionScreenIsLocked=true）。T-006 -> blocked，等待用户解锁后进行真实截图，尚不宣称成品视觉验收完成。
- 2026-09-10 05:40 UTC: 用户明确已解锁；核对PID/路径未变，目标窗口截图非白屏。进一步设置页截图发现旧缓存仍把同一pi路径显示两次（Pi+easy-pi），实时probe却已只接受easy-pi；新增T-009 -> in_progress，T-006依赖加入T-009，以实际界面验收修正遗漏而非接受假完成。
- 2026-09-10 05:52 UTC: T-009 -> done，同路径/符号链接/反向升级/保留旧恢复缓存测试及全仓653项通过8忽略；已重建签名并精确重启到PID89132。系统再次自动锁屏，前台loginwindow，点击助手因PID前台校验失败拒绝点击，未把输入发送其他窗口；T-006仍blocked等待再次解锁。
- 2026-09-10: 用户最终指令“直接提交”，不再等待最终截图；代码/自动化/已打开调试成品交付继续，最终视觉检查保持未完成的明确限制。LEARNS.md是任务前已有用户修改，保持未动；本次可复用验证细节仅记在本文档与烟测脚本中。
- 2026-09-10: 已创建Git提交 feat: add nine coding agent integrations with themed icons（74个相关文件）。提交前cached diff检查发现新fixture空行尾随空格和Markdown硬换行；仅去除空格并注明fixture规范化，重新运行extended12测试通过，cached diff --check通过。原有LEARNS/mobile文档/Apple工程/schema及iosIme文件均未暂存或提交。本文更新随同一提交记录交付事实。
- 2026-09-10 04:12 UTC: 新增e2e/nine-agent-smoke.py安全实机脚本；最初按output.log判断输出错误，源码证明Host只保留内存回放，改走session read API。Omp冷启动超过3秒，改为30秒有界等待。三种真实CLI在隔离HOME无账号/无输入下启动、两次attach和正常停止通过；另Omp原生cold resume保持UUID并渲染通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001/T-002/T-003/T-004/T-005/T-007/T-008/T-009完成；最终Rust653与前端623、mobile4测试通过，i18n/build通过；三种真实CLI隔离启动/重连/停止及Omp精确冷恢复通过；已构建签名并打开最新debug App PID89132。上一构建非白屏截图已确认，最新后端缓存修正尚未最终截图。已按用户“直接提交”指令创建相关Git提交（主题：feat: add nine coding agent integrations with themed icons），74个文件，不含任务前其他未提交改动。
- Limitations: T-006仅剩最新构建的最终视觉截图未完成（macOS锁屏），不宣称全项视觉验收通过。六种未安装CLI及Linux未实机验证；无登录态模型多轮验证，8项环境/凭据相关Rust测试按原规则忽略。
