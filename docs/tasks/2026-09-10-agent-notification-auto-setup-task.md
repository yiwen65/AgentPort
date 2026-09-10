# Task Plan: 探测时自动配置 Agent 通知集成

- Created: 2026-09-10
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户确认本会话自动通知集成需求并选择“确认并实施”。

<!-- task-doc-section:background-goal -->
## Background and goal

探测全部14种正式Agent时，不仅确认CLI可启动，还自动准备、安装并验证通知事件链路。覆盖一轮任务完成、待审批/待回答、失败，沿用现有通知渠道及开关。仅对AgentPort会话生效，不影响普通终端会话。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

覆盖现有五种与新增九种正式Agent；Generic Shell不安装Agent hooks。允许自动安装通知所需hooks/插件/私有依赖，必要时合并全局配置；必须保留用户已有内容、幂等、可回滚。优先会话级官方接口；无接口时采用已验证原生事件来源，剩余明确降级。提权、账号登录、系统通知授权需单独用户确认；不自动安装Agent主程序，不强制重启已有Session，不修改已有权限策略。

保持任务前未提交LEARNS.md、mobile文档/Apple工程/schema及iosIme.md原样。前一九种接入任务状态仍在原文档，本文件仅负责本轮通知功能，是本轮唯一状态权威。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 自动安装、全局配置合并、14种范围、3类事件、仅托管会话已确认 | 本会话结构化问题及最终确认 |
| F-002 | 能力probe当前纯只读；CLI、service和Tauri有各自探测入口 | core/adapters/capability.rs；cli/main.rs:cmd_probe；service/lib.rs:probe_agent/probe_all_agents；src-tauri/main.rs:probe_agents |
| F-003 | Claude/Qoder用会话settings注入；Codex用notify；Pi家族和Kimi已有原生语义读取 | core/adapters/{claude,codex,qoder}.rs；host/semantic_events.rs |
| F-004 | 新增七种目前只有PTY启发式，没有经过验证的hooks集成 | core/adapters/extended.rs；docs/agent-cli-evidence.md |
| F-005 | 当前通知去重只分类ApprovalRequested/TurnCompleted，需明确失败语义 | core/models.rs:attention_kind；core/notify.rs:NotificationDeduper；core/state.rs |
| F-006 | GUI已有Agent设置页、全量重新探测、系统通知开关 | src/src/components/SettingsDialog.tsx；src/src/api.ts |
| F-007 | 当前基线c83a7a4，任务前存在无关未提交工作 | git status --short；上一轮提交 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 已接受假设：沿用现有通知渠道及开关，不新增推送渠道；不能热加载的旧会话提示下次启动生效。
- 实施假设：优先自包含relay（使用现有系统/bin/sh或已随App分发的组件），减少下载依赖；仍须实际检查所需运行时可用，不把缺少依赖标成就绪。
- 接口契约：NotificationSetup采用camelCase字段agent、state(ready/degraded/failed/unavailable)、strategy、events{completed,needsInput,failed}（来源hook/native/process/heuristic/unavailable）、detail、checkedAt。ready只用于三类事件均具有非启发式且已验证的来源；部分覆盖标degraded。
- 核心接口：notification_setup::setup(paths,&AdapterInstall)->NotificationSetup，不让安装错误影响CLI可用；list_status(paths)->Result<Vec<NotificationSetup>>；apply_to_launch(paths,agent,&mut LaunchPlan)->Result<()>；rollback(paths,agent)->Result<NotificationSetup>。具体provider plan内部契约由T-001协调T-002/T-003固定并回报。
- Open question: 暂无产品决策阻塞；若来源、依赖安装要求、全局配置格式或权限无法安全确认，返回清楚失败/降级并记录，不猜测。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 14种探测均返回独立通知状态，自动准备可支持的集成；未安装CLI不触发主程序安装。
- 幂等安装和可回滚；已有hook/插件/其他设置不丢失；格式未知/冲突/权限不足时保留原文件并明确失败。
- 仅拥有有效AgentPort session/run标识的调用报告事件；普通终端不写事件、不弹AgentPort通知；不把prompt/tool payload或凭据复制到安装日志。
- 完成、待处理、失败准确分类并去重；不会把用户主动停止当执行失败，也不会因旧run或重复hook重复提醒。
- UI展示CLI可用与通知就绪差异、事件覆盖/失败原因/重试，配置失败不阻止基本启动。
- 自动化覆盖安装/重复探测/合并/回滚/桥接来源/事件匹配/故障；实机按已有工具安全验证，不发送模型请求或代登录。
- 验证后相关Git提交、统一脚本打开调试App并核对进程路径和截图；锁屏等限制如出现据实记录。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001、T-002、T-003、T-004、T-005、T-006 -> T-007 -> T-008。
- Parallel batches: A中前六项契约已知、文件独立；运行时最多3个并行子代理，先运行T-001/T-002/T-003及协调者T-006，T-004/T-005等空闲配额后再启动子代理，不改为协调者串行替代；T-001协调provider内部类型。B综合验证；C成品交付。
- Serialization constraints: 协调者独占任务文档、core/lib.rs、service、CLI、Tauri、host_manager集成入口；T-001独占notification_setup/mod.rs和安装器文件；T-002仅providers_pi.rs和其独立assets/fixture；T-003仅providers_cli.rs和其独立assets/fixture；T-004独占models/state/notify和host/main/semantic_events；T-005仅src/src UI。全仓Cargo构建、最终前端构建、debug App重启、全局安装实机操作和Git提交由协调者串行执行。子代理不得实际写用户全局配置，只用临时HOME测试，实际配置通过协调者已授权App探测入口。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 安装器、就绪状态、幂等与回滚

- Status: done
- Owner: notification-installer
- Objective: 实现可验证的自包含通知relay安装、配置安全合并、状态持久化和回滚。
- Inputs and prerequisites: 已确认授权、NotificationSetup公共契约及现有AppPaths。
- Scope or files: crates/agentport-core/src/notification_setup/mod.rs及该目录内除providers_pi.rs/providers_cli.rs与其assets外的安装器文件和测试。
- Expected output: setup/list_status/apply_to_launch/rollback公共API、受保护的私有文件、注册事务与测试。
- Dependencies: None.
- Execution steps:
  1. 固定provider plan类型并与T-002/T-003协调；用自包含relay避免不必要依赖。
  2. 支持已有配置保留、原子写、备份、幂等、冲突检测和安全回滚，安装仅在真实probe通过后触发。
  3. 实现session/run限定的relay，输出只含事件关联元数据，安装自测不发送系统通知。
- Acceptance criteria:
  - 安装失败不影响CLI探测可用；未知格式/符号链接/并发修改不覆盖；无会话环境不写事件；状态不夸大能力。
- Verification method:
  - 临时目录安装、重入、回滚、损坏/冲突/缺依赖测试；relay实际执行测试。
- Validation evidence: cargo test -p agentport-core notification_setup --lib -- --test-threads=1：15项通过；覆盖真实provider、Gemini禁用设置、源码指纹变化、事务回滚和冲突。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Pi、Oh My Pi、easy-pi 通知事件接入

- Status: done
- Owner: notification-pi
- Objective: 按各产品真实extension/hook API准备通知插件，避免只靠终端文本。
- Inputs and prerequisites: 本机pi和oh-my-pi源码、现有原生JSONL读取、T-001 provider契约。
- Scope or files: notification_setup/providers_pi.rs及独立pi-family assets/fixture、docs/notification-pi-evidence.md；不改旧adapter。
- Expected output: 三种产品各自的provider计划、可验证脚本、事件覆盖证据。
- Dependencies: None.
- Execution steps:
  1. 完整读取适用pi文档/源码，核实agent结束、等待与错误事件及各fork差异。
  2. 优先会话级加载，或官方独立插件目录；保留所有已有插件，不改变权限设置。
  3. 插件只在托管session/run存在时桥接事件，无法精确信号则明确native/heuristic来源。
- Acceptance criteria:
  - 三种身份和数据目录不混用；普通CLI不报告；事件名称有源码/文档依据。
- Verification method:
  - 静态fixture和脚本契约测试；通知payload最小化；与已有JSONL事件无重复计数。
- Validation evidence: Pi provider Rust测试及生产reader/relay Node fixture通过；隔离HOME的Omp18.0.11/easy-pi0.84.2启动、上下文绑定、回滚通过，Omp同UUID冷恢复通过；未发送模型请求。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 其他 Agent 官方 hooks/插件适配

- Status: done
- Owner: notification-cli
- Objective: 为OpenCode/Amp/Gemini/Cline/Kiro/Cursor/Grok研究并实现可证实的通知集成，同时保留已有Claude/Codex/Qoder/Kimi机制。
- Inputs and prerequisites: 已确认14种范围、docs/agent-cli-evidence.md、官方公开文档/本机Grok源码、T-001契约。
- Scope or files: notification_setup/providers_cli.rs及独立CLI assets/fixture、docs/notification-cli-evidence.md。
- Expected output: 其余十一种provider计划或明确有证据的降级说明；安全参数/配置形状。
- Dependencies: None.
- Execution steps:
  1. 核实官方会话级/全局hooks/插件接口、事件和最低可识别能力，不凭flag名猜测格式。
  2. 提供可合并的注册计划及资产，不直接操作真实HOME；原生支持优先，不安装Agent主程序。
  3. 标注各事件精度，未知或不支持接口不伪装ready。
- Acceptance criteria:
  - 11种无遗漏；已有hooks不会与新增注册重复；无证明时明确原因，不编造schema或强行改默认agent。
- Verification method:
  - 官方fixture/生成配置解析、注册计划和独立脚本测试；最终临时HOME集成验收。
- Validation evidence: Rust provider/安装器测试通过；Node fixture11项通过（含真实父子进程/单层shell及嵌套拒绝）；Grok1.0.25隔离配置、重复probe、启动上下文、重连/停止/回滚通过。其余未装CLI不虚报实机验证。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 运行时事件关联、失败与通知去重

- Status: done
- Owner: extended-adapters
- Objective: 将可信桥接事件贯穿Host状态与现有通知渠道，准确覆盖三类事件并去重。
- Inputs and prerequisites: relay协议与session/run关联契约、现有hook tailer/state/notify。
- Scope or files: core/models.rs中的状态注意力定义、state.rs、notify.rs；host/main.rs、semantic_events.rs及相关测试。不得改core/lib.rs或host_manager。
- Expected output: 严格事件身份校验、新失败通知分类、去重回归与Host可用事件。
- Dependencies: None.
- Execution steps:
  1. 与T-001固定relay JSON envelope与授权token/run字段；拒绝跨会话/旧run/无标识新relay事件。
  2. 加入执行失败通知，排除正常退出/主动停止/普通信息；保留旧hooks兼容。
  3. 完成事件跨hook/native来源去重，等待用户与审批按既有通知开关处理。
- Acceptance criteria:
  - 3类事件来源有证据，重复/陈旧事件不重复提醒；不将每次PreToolUse都标为待审批。
- Verification method:
  - Host事件协议、state/notify单元和集成回归，覆盖普通终端、stop、crash、重复完成。
- Validation evidence: Host单元34项通过；Host实际PTY集成40项通过（含4项新增通知测试）；状态/通知和SQL注意力矩阵定向通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 通知就绪 UI 与重试

- Status: done
- Owner: agent-ui
- Objective: 在现有Agent设置/探测UI区分CLI可用与通知配置状态，并展示覆盖/错误/重试。
- Inputs and prerequisites: NotificationSetup camelCase契约；新增api.notificationSetups()读取状态，probeAgent/probeAgents结果含notificationSetup。
- Scope or files: src/src相关UI、类型、api、语言包及测试；不改包锁/Rust。
- Expected output: 明确ready/degraded/failed/unavailable展示、逐事件来源、重试及回滚入口（api.rollbackNotificationSetup(agent)）。
- Dependencies: None.
- Execution steps:
  1. 复用现有设计风格与通知开关，不新增渠道或自动授权系统通知。
  2. 重试沿用Agent probe；展示不影响CLI启动和旧会话下次启动生效提示。
  3. 为错误/空状态/部分覆盖补中英本地化及测试。
- Acceptance criteria:
  - 不把CLI可用等同通知就绪，不在配置失败时隐藏可用Agent；无未翻译UI文案。
- Verification method:
  - 相关Vitest、i18n检查、构建，最终App截图由T-008负责。
- Validation evidence: 全量前端85文件638项通过，i18n检查和tsc/Vite构建通过；界面视觉由T-008验证。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 探测与启动全链路集成

- Status: done
- Owner: coordinator
- Objective: 将setup接入GUI/CLI/service探测与启动，保持只读capability底层和通知状态独立。
- Inputs and prerequisites: 各公共接口契约、现有probe与launch路径。
- Scope or files: core/lib.rs、host_manager.rs；CLI/service/Tauri；必要共享DTO消费层与测试；任务文档。
- Expected output: 所有实际探测入口自动准备通知；启动设置可靠的session/run环境；状态查询/回滚API。
- Dependencies: None.
- Execution steps:
  1. 包装现有probe成功结果执行setup并返回独立状态；新增状态读取与回滚命令。
  2. 在启动/恢复合适边界应用已验证插件参数和relay环境，保持失败降级和旧Session不被强制重启。
  3. 保护用户advanced参数不能覆盖托管通知身份；反馈各事件协议给Host。
- Acceptance criteria:
  - GUI/CLI/远程探测一致；无status读取副作用；不把秘密/完整payload写入安装记录。
- Verification method:
  - CLI/service契约与隔离HOME集成、事件run环境检查；全仓编译回归。
- Validation evidence: 全仓check通过；CLI/service/Host测试及三种真实CLI隔离配置/上下文/回滚通过。实际默认数据目录probe：Omp/easy-pi/Grok为available+degraded，其余正式CLI不可用不安装；Grok独立全局hook文件已安装。补齐移动端execution_failed消费，保持仅App内通知、不启用系统推送。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 集成审查与验收矩阵

- Status: done
- Owner: coordinator
- Objective: 独立审核各结果，验证真实配置安全与事件链路，记录14种覆盖矩阵。
- Inputs and prerequisites: T-001至T-006完成并有验证证据。
- Scope or files: 本任务相关代码/测试、README/用户指南及通知能力文档。
- Expected output: 自动化通过、可重复的隔离安装/事件/回滚烟测和明确实机限制。
- Dependencies: T-001, T-002, T-003, T-004, T-005, T-006
- Execution steps:
  1. 审核注册事务、旧配置保留、回滚冲突、relay注入/泄漏/跨run及去重。
  2. 运行Rust workspace与前端测试/i18n/build；临时HOME下重复探测、触发合成官方事件并回滚。
  3. 仅通过已授权App探测入口实际准备已安装工具；无登录/模型提示；更新覆盖矩阵。
- Acceptance criteria:
  - 不虚构14种全部精确支持；安装/通知状态真实、失败可重试；现有功能无回归。
- Verification method:
  - cargo test --workspace --all-targets -- --test-threads=4；src npm test/npm run i18n:check/npm run build；定向smoke。
- Validation evidence: --no-fail-fast全仓首轮678通过/6失败/8忽略；三个失败目标（probe_path、core lib、branch_safety_regressions）串行分别4/404/7项全部通过，合计684用例通过、8忽略，未声称首轮全绿。桌面638项、移动端374项、移动端tsc通过；Node外部hook11项/Omp fixture通过；桌面i18n/Vite构建通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 调试成品与提交

- Status: done
- Owner: coordinator
- Objective: 打开更新调试App并提交任务相关成果。
- Inputs and prerequisites: T-007通过、AGENTS.md安全重启规则。
- Scope or files: debug App、任务相关Git文件、本文档。
- Expected output: 构建签名、精确PID路径、截图、Git commit。
- Dependencies: T-007
- Execution steps:
  1. 统一脚本构建/签名/只重启目标GUI，不影响Host/Connector/发布实例。
  2. 核对通知就绪UI与设置页，截图确认非白屏；若锁屏请求解锁并诚实记录限制。
  3. 验证文档与diff，显式暂存相关文件并提交。
- Acceptance criteria:
  - 相关测试通过、目标App打开、提交不包含初始无关改动；视觉未完成不标记完成。
- Verification method:
  - restart-debug-app.py、ps、截图读取、git diff --check、task_document.py validate、git show。
- Validation evidence: 最终统一脚本构建签名及重启成功；ps核对PID43549为当前checkout调试App完整路径，窗口1791截图/tmp/agentport-notification-debug-final.png已读取、非白屏。脚本只报告关闭GUI82358；首次重启前13个保护进程全部保留，最终跨时段复查11个仍在，2个旧Host已退出，未推断其退出原因。相关文件经显式清单暂存，Git提交包含本记录；不混入LEARNS/已有mobile文档及Apple工程修改。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

安全优先：所有安装器单元与第一次端到端写入都使用临时HOME/数据目录；检查配置字节保留、未知格式拒绝、重复安装不重复注册、用户后续修改时回滚不覆盖。relay必须在无标识时无副作用；合成事件只写临时Host日志，不发送真实通知、不调用模型。验证session/run身份、3类事件、跨源去重与主动停止不报错。最后按实际安装工具分层验证，保留不支持事件及Linux实机缺口。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

CLI hooks文档版本漂移、全局配置JSONC/TOML/YAML差异、插件与已有hooks重复、依赖安装不可信、权限事件误判、旧run迟到/重复消息、回滚覆盖后续用户编辑、App锁屏无法截图。首次探测读写分层，所有不可安全处理情况返回明确失败/降级，不猜schema、不静默提权。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-10: 确认用户范围与自动配置授权；建立新execute权威文档，保留前一任务记录和初始未提交工作。
- 2026-09-10: T-001至T-006 -> in_progress，固定公共状态DTO、文件归属、并行批次和串行验证；委派前验证文档。
- 2026-09-10: 同批启动T-001/T-002/T-003成功；T-004/T-005因runtime limit_reached -> blocked，记录为等待配额而非改为串行执行。协调者继续独立T-006。provider和事件协商暂由协调者转发，避免向未启动代理投递。

- 2026-09-10: 配额释放，T-004/T-005 -> in_progress，分别由extended-adapters/agent-ui执行。T-001/T-002/T-003子代理实现已返回，尚待协调者集成及Rust验证，未标done。

- 2026-09-10: 集成发现并修正SQL注意力判定遗漏（含迁移v15）、嵌套外部Hook错误归属、精确恢复丢失原生ID、预设环境覆盖可信资产路径及Omp运行时依赖契约错误。新增回归均通过；Kimi等待来源纠正为启发式，不夸大wire覆盖。
- 2026-09-10: 原烟测只检查CLI启动，严格安装器拒绝macOS /var符号链接导致通知未安装；将隔离根目录规范化并新增--verify-notifications，明确验收配置状态、重复探测、真实ownerPID及回滚。Omp/easy-pi/Grok三种通过，报告/tmp/agentport-notification-real-smoke-verified.json。

- 2026-09-10: T-006/T-007 -> done，移动端原有收件箱原先会丢弃execution_failed，已补齐类型/过滤/中英标签及回归，不启用其已关闭的系统通知。移动端374项通过，不涉及手机安装/Apple工程改动。
- 2026-09-10: T-008 -> in_progress；统一脚本首次重启成功，目标PID82358/窗口1701截图非白屏，13个Host/Connector/发布实例保留。通过正式CLI probe入口实际配置Omp/easy-pi/Grok；不发送模型输入、不登录、不提升权限。

- 2026-09-10: 最终Omp隔离启动带真实扩展参数、ownerPID/回滚通过，保留的启动输出没有extension/error/failed诊断；未声称已验证认证后的审批回调。最终调试App构建签名、PID43549及窗口1791非空白截图通过；T-008 -> done并准备提交已验证的显式文件清单。LEARNS因任务前已有用户修改保持不动，经验仅记录本任务日志。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001至T-008完成；Rust684项经首轮及失败目标串行复验通过、8忽略；桌面638项/移动端374项通过，构建/i18n通过。实际探测为本机三种可用Agent完成自动配置；最终调试PID43549/窗口1791路径及非白屏截图确认，交付随本记录Git提交。
- Limitations: 多次广度测试出现2秒CLI探测、Git时限及pairing连接波动，未修改生产超时掩盖；最终失败目标已串行复验。Linux及未安装CLI无实机验证、未发送模型请求。设置页交互截图未取得；不把一般App截图当作全部通知事件实机证明。移动端消费代码已验证但未重新部署手机App。
