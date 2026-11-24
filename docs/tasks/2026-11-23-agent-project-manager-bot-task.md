# Task Plan: Agent PM Bot 委派与长期记忆架构

- Created: 2026-11-23
- Workspace: /home/w/Project/AgentPort
- Mode: execute
- Overall status: in_progress
- Source: 用户需求：增加 Project Manager Bot 模板；用户只与 Bot 对话，Bot 通过 AgentPort MCP 拆解、委派、监督子 Agent；子 Agent 自动分屏，用户可选择观察或干预；Bot 具有项目长期记忆和稳定身份，可接收 issue/task。

<!-- task-doc-section:background-goal -->
## Background and goal

AgentPort 当前已经具备“外部 Agent 通过 MCP 创建真实 AgentPort Session”的基础：MCP 可以创建 Session、发送 prompt、等待最终 reply、并行等待多个 Session，并通过 UI 命令队列请求分屏。现有 Agent Role 主要是一次委派时注入的行为指令，不是长期运行的管理者，也没有任务图、Bot 身份或项目长期记忆。

本任务的目标是设计一个 **Project Manager Bot**：

1. 用户只需要与一个 Bot Session 对话；
2. Bot 负责澄清需求、拆解任务、选择 Agent/Role、创建子 Session、安排 worktree、等待结果、复核证据和重新规划；
3. 每个子 Agent 仍是普通 AgentPort Session，可自动进入分屏；
4. 用户可以只看 Bot 汇总，也可以打开子 Agent 分屏进行观察；需要时可取得干预权，暂停 Bot 对该子 Session 的写入后直接操作；
5. Bot 的项目记忆、身份、任务记录和委派关系在重启后可恢复；
6. issue/task 可以从 AgentPort UI、MCP、CLI 或未来外部集成进入 Bot，而不要求用户手工管理多个 Session。

推荐的产品定位是：**Bot 是唯一的决策入口；子 Agent 是可观察、可审计、可接管的执行单元；AgentPort 是任务编排和进程/窗格生命周期的控制平面。**

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### Scope

- Bot 模板/定义：名称、身份、使命、项目范围、默认 Manager Agent、记忆策略、委派策略和权限策略。
- Bot Session：一个用户可见的长期管理 Session，优先使用 ACP structured transport，PTY/TUI 作为兼容回退。
- Durable Bot Task Graph：任务、依赖、状态、子 Session、验收标准、结果、阻塞和审计。
- Bot-specific MCP contract：任务创建/更新、子 Agent 委派、并行等待、观察、追问、取消、暂停和结果确认。
- 自动分屏与 pane 生命周期：复用现有 `PaneIntent`/UI queue；新增 Bot workspace/dashboard 所需的最小 UI。
- 观察/干预仲裁：Bot 驱动、用户观察、用户接管三种状态，避免两个写入者同时向子 Session 输入。
- 项目长期记忆：身份、项目事实、约束、决策、惯例、任务结果、来源、置信度和过期/复核信息。
- 恢复、配额、递归深度、权限、worktree 隔离、审计和测试方案。

### Non-goals

- 第一阶段不实现通用自主 swarm、无限递归 Agent 或跨项目共享的全知记忆。
- 不把所有原始 TUI 功能复制到 Bot UI；Bot 界面优先使用结构化 ACP/任务视图，原始 TUI 仍由子 Session 的 PTY 窗格提供。
- 不让 Bot 默认自动合并或发布代码；集成、合并、删除 worktree、发布等高风险动作必须有明确策略/用户确认。
- 不在第一阶段实现 GitHub/Jira/Linear 等每个 issue 系统的完整双向同步；先定义统一 issue 输入模型和一个本地/MCP入口。
- 不把原有 Agent Role 直接改造成 Bot；Role 继续表示子 Agent 的行为画像，Bot 使用独立的持久化模型。
- 不让 Bot 读取或操控未由它创建/授权的用户 Session；现有 MCP ownership 安全边界必须保留。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | MCP `create_session` 创建真实 AgentPort Session，默认带首个 prompt，并在成功后请求新分屏。 | `crates/agentport-mcp/src/tools.rs:1455-1770`; `docs/mcp.md:63-70,203-216` |
| F-002 | MCP 已有批量创建、同步等待、非阻塞 wait group 和最终 reply 返回，适合 Bot 的 fan-out/fan-in 基础。 | `crates/agentport-mcp/src/tools.rs:1773-1888,2057-2375`; `crates/agentport-mcp/src/wait_jobs.rs`; `docs/mcp.md:93-109` |
| F-003 | MCP ownership registry 已持久化 Session、父 Session、委派深度、Agent、权限和不可变 RoleSnapshot，并以文件锁合并多进程写入。 | `crates/agentport-mcp/src/registry.rs:35-176,214-275` |
| F-004 | Agent Role 当前是 instruction profile，不负责 Agent 选择、权限、worktree、生命周期或任务状态。 | `crates/agentport-core/src/agent_roles.rs:1-14,60-107`; `docs/mcp.md:120-121` |
| F-005 | Role 已有 SQLite 存储、revision CAS、启用/禁用、内置 seed 和 UI 编辑；可复用其校验/版本化模式，但不应把 Bot 记忆塞进 Role。 | `crates/agentport-core/src/db/mod.rs:415-432,1835-2072`; `src/src/components/SettingsDialog.tsx:350-612` |
| F-006 | MCP 只能通过 UI queue 请求 pane；GUI external watcher 以 data_version 接管外部 Session，并消费 `ui-commands.jsonl`。 | `crates/agentport-mcp/src/ui.rs:1-196`; `src-tauri/src/external_agents.rs:1-210`; `src/src/actions.ts:733-805,939-980` |
| F-007 | 现有委派有 per-process 16 个 live Session、默认递归深度 2 等限制；这些限制不足以表达重启后仍存在的 Bot 任务配额和预算。 | `crates/agentport-mcp/src/main.rs:16-22,83-93`; `docs/mcp.md:187-194` |
| F-008 | 现有 child Session 仍以 PTY 为主；AgentPort 已有 Pi 专用 `json_rpc`，但不是 ACP，且非 PTY 创建路径仍受 Service 门禁限制。 | `crates/agentport-service/src/lib.rs:2352-2358,3235-3244`; `crates/agentport-core/src/models.rs:253-273`; `crates/agentport-host/src/server.rs:509-561` |
| F-009 | AgentPort 的 MCP handoff 已区分结构化 transport 与 PTY 回退，说明可逐步引入 structured Bot Session 而不破坏既有子 Agent。 | `crates/agentport-mcp/src/tools.rs:1348-1450`; `docs/mcp.md:117-121` |
| F-010 | AgentPort 当前 data backup 也已把 `agent_roles` 纳入备份边界，新的 Bot/Memory 数据必须明确备份、隐私和删除语义。 | `crates/agentport-core/src/db/backup.rs:86`; `AGENTS.md` 许可/备份规则 |
| F-011 | Claude Code 的官方模型区分了单 Session subagent 与可直接通信、共享任务列表、可分屏显示的 agent team；team 仍有实验性限制。 | 官方文档：https://code.claude.com/docs/en/sub-agents.md；https://code.claude.com/docs/en/agent-teams.md |
| F-012 | Devin 官方文档描述了 coordinator 自动拆解任务、并行委派隔离 VM、监控冲突并汇总结果的 Manager 模式。 | 官方文档：https://docs.devin.ai/work-with-devin/advanced-capabilities |
| F-013 | OpenHands SDK 的官方 Task Tool Set 采用“主 Agent 委派专门子 Agent，子 Agent 独立执行并返回结果”的模型；适合参考角色化 worker 和结果边界。 | 官方文档：https://docs.openhands.dev/sdk/guides/task-tool-set |
| F-014 | 外部产品的共同模式是 manager/coordinator + worker isolation + centralized summary；AgentPort 与它们的差异在于本地 Host、可见 PTY pane、既有 MCP ownership 和桌面 UI。 | F-001~F-009 与 F-011~F-013 的交叉分析 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

### Proposed decisions / assumptions

- **A-001（推荐）**：Bot 本身是一个 AgentPort 长期 Session，而不是另起一个隐藏 LLM 服务。Bot 可以选 ACP Agent；不支持 ACP 时回退到现有 PTY。这样复用 Host、Session、MCP、pane、通知和恢复链路。
- **A-002（推荐）**：Bot 使用独立 `BotDefinition`/`BotInstance`/`BotMemory`/`BotTask` 数据模型；Role 只作为子 Agent 的可选行为画像。
- **A-003（推荐）**：Bot 只允许操作自己创建或被明确移交的子 Session；用户可以通过接管租约取得直接输入权，但接管期间 Bot 不得发送 prompt。
- **A-004（推荐）**：并行写代码的子任务默认使用独立 AgentPort worktree；共享主工作目录只用于只读研究或明确串行任务。
- **A-005（推荐）**：Bot 的长期记忆不是“自动把所有对话存下来”，而是带来源、置信度、时间、scope、revision 和复核状态的受控事实库；模型输出和子 Agent 输出默认属于候选记忆，不能无审核永久升级为事实。
- **A-006（推荐）**：第一阶段 issue/task 输入先支持 Bot Session、MCP 和本地 CLI/UI；外部 GitHub/Jira/Linear 适配留到统一 issue contract 稳定后。
- **A-007（推荐）**：Bot 可以自动拆解和派发低风险任务，但涉及写入、删除、合并、发布、权限提升或跨项目访问时按 Bot policy 请求用户确认。

### Open questions requiring product confirmation before implementation

- **Q-001**：Bot 是每个项目一个，还是用户可创建多个 Bot（例如 PM、Release、Research）？本方案默认“每个项目至少一个，可扩展多个”。
- **Q-002**：Bot 默认使用哪个 Agent/model？本方案默认由 Bot 模板选择 Agent，优先 ACP；不要求把 Bot 固定为某一家模型。
- **Q-003**：用户是否要求 GitHub/Jira/Linear issue 自动同步？本方案 MVP 不依赖外部同步，但保留 `ExternalIssueRef`。
- **Q-004**：用户接管子 Agent 后，Bot 是否继续接收其输出并自动重新规划？本方案默认继续观察，但暂停自动写入和自动收尾，直到用户交还控制权。
- **Q-005**：长期记忆是否允许跨项目共享？本方案默认项目隔离；跨项目只允许显式复制/引用，避免事实和权限串线。
- **Q-006**：Bot 是否拥有默认完整权限？本方案默认 Bot 与子 Agent 权限分离：Bot 可管理 Session/MCP，但代码写入仍由子 Agent policy 与 worktree 决定；高风险操作需显式确认。
- **Q-007**：是否需要 Bot 自己创建/删除 worktree？本方案默认由 AgentPort 后端 Bot Orchestrator 负责创建和清理，而不是让模型直接拼接 Git 命令。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- AC-001：用户可以从 Bot 模板创建一个项目级 Bot，并看到稳定的 Bot 名称、身份、项目范围和运行状态。
- AC-002：用户发送一个 issue/task 后，Bot 能形成带验收标准和依赖的任务图；Bot 可以将独立任务批量委派给不同 Agent/Role，并返回每个子任务的 Session、pane、状态和 correlation id。
- AC-003：子 Agent 创建、等待、最终 reply、needs-input、失败、取消和超时均能归属到 Bot Task；MCP 重启或 GUI 重启后任务图和子 Session 仍可恢复，不重复派发同一任务。
- AC-004：子 Agent 默认自动分屏；用户可在 Bot 主视图看到任务摘要，并打开任意子 Session 观察完整输出。
- AC-005：用户可对任一子 Session 执行“观察 → 请求接管 → 直接干预 → 交还 Bot”；接管期间没有 Bot/用户并发写入，所有切换有审计记录。
- AC-006：Bot 能把子 Agent 的最终 reply、测试证据、变更摘要和阻塞原因合并为面向用户的阶段性报告；没有证据时不能报告“已完成”。
- AC-007：Bot 记忆分为身份/项目事实/决策/惯例/任务经验/当前工作摘要，支持来源、置信度、更新时间、复核和删除；不会默认保存 secrets 或未经确认的 prompt injection。
- AC-008：并行写任务不会默认共享同一工作目录；每个写任务有 worktree/冲突策略，集成任务由 Bot 安排专门的 integrator/reviewer Session，并由用户确认最终合并/发布。
- AC-009：Bot/子 Agent 受 project scope、ownership、递归深度、并发数、预算、工具权限和生命周期限制；删除 Bot 可以按策略删除或保留任务/记忆/子 Session 历史。
- AC-010：Bot 状态、任务图、记忆和子 Session 变化可在桌面、远程和移动查看；移动端可先支持摘要、通知、打开子 Session 和接管，不要求首版完整任务图编辑。
- AC-011：未知 Agent/MCP/子 Session 事件不会破坏 Bot 状态；会保留有界诊断信息，并将任务标为 `needs_review` 或 `blocked`。
- AC-012：实现前必须先完成领域模型、权限边界、恢复语义、worktree policy 和 Bot prompt contract 的设计评审；本计划阶段不修改实现文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph：
  - `T-001 Bot domain model + lifecycle` → `T-002 task graph/recovery` → `T-003 Bot MCP contract` → `T-005 Bot runtime prompt/identity` → `T-007 integrated validation`。
  - `T-001` → `T-004 memory model/policy` → `T-005`。
  - `T-001` + `T-002` → `T-006 UI observation/intervention`。
  - `T-002` + `T-003` + `T-004` + `T-006` → `T-007`。
  - `T-008 issue integrations` depends on `T-003` and is explicitly post-MVP.
- Parallel batches（实现阶段）：
  - Batch 0：产品确认 Q-001~Q-007、领域模型和安全边界（必须串行）。
  - Batch 1：`T-001`/`T-002`/`T-004` 可在模型边界确认后由不同 owner 设计；DB/schema/registry 文件仍需串行合并。
  - Batch 2：`T-003` Bot MCP surface 与 `T-006` UI 草案可并行；二者共享 event/task contract，最终接线串行。
  - Batch 3：`T-005` Bot runtime prompt/ACP integration、worktree policy、recovery tests 串行完成。
  - Batch 4：`T-007` 集成验证、E2E、文档和安全审查。
- Serialization constraints：
  - Bot/Task/Memory 数据模型、SQLite migration、backup/restore 和 JSON ownership registry 是共享持久化契约，不能并发修改。
  - MCP tool schema、Bot system prompt contract、task state transitions 和 UI event payload 必须先定版本再实现消费者。
  - worktree manager、Session ownership、intervention lease、stop/update lifecycle 共享并发状态，必须由一个 owner 串行实现。
  - 不修改 `LEARNS.md`；不混入当前工作树已有的 `src-tauri/Cargo.toml` 改动。

<!-- task-doc-section:task-list -->
## Task list

### [ ] T-001 — Bot/Task/Memory 领域模型与持久化边界

- Status: in_progress
- Owner: coordinator
- Objective: 定义 `BotDefinition`、`BotInstance`、`BotTask`、`BotTaskAttempt`、`BotMemory`、`BotEvent`、`InterventionLease`、`ExternalIssueRef` 的字段、状态机、scope、revision 和删除语义。
- Inputs and prerequisites: F-001~F-010；Q-001~Q-007 的确认；现有 SQLite schema/backup/Session/Role 模型。
- Scope or files: `crates/agentport-core/src/models.rs`, `crates/agentport-core/src/db/mod.rs`, `crates/agentport-core/src/agent_roles.rs` 的边界评估，`crates/agentport-core/src/backup.rs`, `crates/agentport-mcp/src/registry.rs`，必要的新 core modules。
- Expected output: versioned schema proposal、状态转移表、ownership/revision/backup/delete contract、migration rollback/compatibility notes。
- Dependencies: None.
- Execution steps:
  1. 将 Bot identity、Role instructions、project memory、task ledger 和 Session ownership 分离建模。
  2. 定义 Bot Task 状态：`inbox`、`clarifying`、`planned`、`dispatching`、`running`、`waiting_user`、`needs_review`、`integrating`、`completed`、`failed`、`cancelled`、`paused`。
  3. 定义 attempt、idempotency key、dependency、acceptance criteria、result evidence 和 child Session binding。
  4. 定义 Bot memory provenance/confidence/review/expiry/conflict/version 字段和敏感内容边界。
  5. 定义跨进程并发写、CAS、恢复和 backup/restore 语义。
- Acceptance criteria:
  - 所有实体有稳定 ID、scope、revision、created/updated 时间和删除/归档规则。
  - 每个状态转移有触发者（Bot/user/system/child Agent）、允许条件和失败恢复路径。
  - 可以由 task/attempt/Session 三者恢复“是否已经派发”，不会因 MCP 重启重复创建子 Agent。
- Verification method:
  - 领域模型评审；状态机表覆盖正常、超时、取消、接管、重启、孤儿 Session 和冲突场景。
  - `task_document.py validate` 与后续 schema 单元测试设计审查。
- Validation evidence: Not run.
- Blocker: Q-001、Q-004、Q-005、Q-007 未确认会影响 schema 细节。
- Unblock condition: 记录产品决策或采用本计划中的推荐默认值。

### [ ] T-002 — Task Graph、MCP ownership 与恢复控制面

- Status: in_progress
- Owner: bot-mcp-implementation
- Objective: 设计 Bot 作为唯一 manager 时的任务编排 API、幂等派发、依赖调度、wait group、状态汇总、恢复和配额。
- Inputs and prerequisites: T-001；现有 `create_sessions`、`start_wait_group`、`get_wait_group`、PaneIntent 和 ownership registry。
- Scope or files: `crates/agentport-mcp/src/tools.rs`, `ops.rs`, `wait_jobs.rs`, `registry.rs`, `protocol.rs`, `crates/agentport-service/src/lib.rs`, 必要的新 `bot_*` modules。
- Expected output: Bot-only MCP tool schema、task graph transition contract、idempotency/retry policy、quota policy 和 parent/child ownership rules。
- Dependencies: T-001.
- Execution steps:
  1. 定义 Bot MCP tools：`bot_get_context`、`bot_submit_issue`、`bot_plan_task`、`bot_dispatch_tasks`、`bot_get_task_graph`、`bot_wait`、`bot_send_followup`、`bot_pause`、`bot_resume`、`bot_cancel_task`、`bot_report`、`bot_memory_*`。
  2. 明确普通 Agent 仍只能使用受限 delegation tools，Bot 才能取得 project-scoped orchestration tools。
  3. 将现有 `create_sessions`/wait group 封装为 Bot Task Attempt，不让模型直接维护裸 Session ID 列表。
  4. 为每次 dispatch 设计 `dispatchKey = botId/taskId/attempt`，重试时先查询 durable binding。
  5. 将现有 per-process 限制升级为 Bot/project 总并发、总深度、预算、单任务和子任务上限。
  6. 设计 AgentPort/GUI 重启时的 reconciliation：running task、dead child、unknown dispatch、late reply。
- Acceptance criteria:
  - Bot 可用一个调用创建一组带依赖/role/agent/worktree policy 的任务，并收到稳定 task IDs。
  - 同一 dispatchKey 重试不会创建重复 Session；每个子 Session 都能反查 Bot/Task/Attempt。
  - wait 返回 task-level completion/reply/evidence，不把 read_output 当完成信号。
  - 所有 destructive/ownership-sensitive 操作有授权和错误码。
- Verification method:
  - MCP schema contract tests、idempotency/restart state-machine tests、并发/取消/超时测试设计。
  - 用临时数据目录执行 Bot create→dispatch→wait→restart→recover 的 E2E 方案。
- Validation evidence: Not run.
- Blocker: T-001 持久化契约未完成。
- Unblock condition: T-001 领域模型和状态转移表获确认。

### [ ] T-003 — Bot Manager Prompt、Role Template 与 ACP/PTY 适配

- Status: in_progress
- Owner: bot-mcp-implementation
- Objective: 定义 PM Bot 的稳定身份、管理规则、任务分解协议、结果验收协议和记忆读取/写入行为；将其作为模板安装到 Bot Session。
- Inputs and prerequisites: T-001、T-002；现有 RoleSnapshot/role preamble；ACP 结构化 transport 研究；`docs/mcp.md`。
- Scope or files: `crates/agentport-core/src/agent_roles.rs` 或新 `bot_templates.rs`、`crates/agentport-mcp/src/tools.rs`、`registry.rs`、`ops.rs`、`docs/mcp.md`，未来 ACP transport/structured UI contract。
- Expected output: PM Bot system prompt contract、Bot template schema、memory injection contract、ACP-first/PTY-fallback behavior、prompt-injection rules。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 定义 Bot identity：名称、使命、项目范围、不可逾越边界、何时询问用户、何时委派、何时停止。
  2. 定义 Bot 的工作循环：intake → clarify → plan → dispatch → monitor → verify → replan → report。
  3. 强制 Bot 先建立 task graph，再派发；禁止直接把用户一句话无审计地转给多个 Agent。
  4. 定义子 Agent prompt contract：任务目标、上下文、范围、验收标准、禁止事项、输出格式、父 Task ID。
  5. 定义 Bot 读取 memory 的优先级和写 memory 的候选/确认/冲突流程。
  6. 优先用 ACP structured prompt/status；无 ACP 时通过现有 PTY Role/prompt fallback，但不把 PTY 文本当可靠状态。
- Acceptance criteria:
  - Bot 能解释自己是谁、管理什么、哪些决定必须问用户；不会假称自己直接完成了子任务。
  - Bot 输出必须携带 task status、child Session、evidence、blocker 或 next action。
  - 仓库文本、子 Agent 输出、issue 描述都被当作不可信输入；不能通过它们改写 Bot 权限/身份/记忆规则。
  - ACP/PTY 差异在工具描述和用户可见状态中明确。
- Verification method:
  - Prompt contract review；使用 replay/mock Agent 验证缺上下文、注入、重复派发、needs_input、冲突结果场景。
- Validation evidence: Not run.
- Blocker: Bot 是普通 Agent Session 还是独立后端 LLM runner 需确认；本计划采用普通 Session。
- Unblock condition: 确认 A-001 或调整运行时边界。

### [ ] T-004 — Project Memory 与 Bot 身份/知识治理

- Status: in_progress
- Owner: unassigned
- Objective: 设计项目长期记忆的分层、检索、写入、复核、冲突和隐私策略，使 Bot 有连续性但不会无限吸收错误或秘密。
- Inputs and prerequisites: T-001、T-003；项目路径/Role/backup 现有边界。
- Scope or files: 新 core memory module、`crates/agentport-core/src/db/mod.rs`、`backup.rs`、MCP memory tools、设置 UI/文档设计。
- Expected output: memory taxonomy、record schema、retrieval ranking、write gate、redaction policy、migration/backup/delete contract。
- Dependencies: T-001, T-003.
- Execution steps:
  1. 分层：Bot identity、project constitution、verified facts、decisions、conventions、task lessons、current working summary。
  2. 每条记忆记录 source（user/AgentPort/child/session/file/issue）、引用、confidence、verifiedAt、expiresAt、scope、supersedes/conflicts。
  3. 仅允许 Bot memory tools 写入；默认写候选，用户确认或高置信系统证据后才升级为 durable fact。
  4. 对 secrets、tokens、凭据、原始大 prompt、任意指令注入做过滤；memory 读取按 project/Bot scope 和权限过滤。
  5. 将记忆摘要按 token budget 注入 Bot；不把整个历史/所有子 Agent输出塞进 prompt。
  6. 为用户提供 inspect/edit/forget/lock memory 的最小入口。
- Acceptance criteria:
  - Bot 重启后可以恢复身份、项目关键约束和未完成任务上下文。
  - 记忆具有可追溯来源和置信度；冲突记忆不会静默覆盖。
  - 用户可以查看、删除、锁定或要求重新验证记忆。
  - backup/restore、项目删除、Bot 删除对记忆有明确结果。
- Verification method:
  - memory unit tests（scope、CAS、conflict、expiry、redaction）；安全审查；恢复/删除 E2E 设计。
- Validation evidence: Not run.
- Blocker: Q-005 跨项目共享策略未确认。
- Unblock condition: 采用项目默认隔离或记录显式共享授权模型。

### [ ] T-005 — 子 Agent worktree、权限与观察/干预仲裁

- Status: in_progress
- Owner: unassigned
- Objective: 防止 Bot 与用户、多个子 Agent 之间并发写入冲突，并实现用户可选择观察或干预的控制权模型。
- Inputs and prerequisites: T-001、T-002；现有 Host/Session ownership、worktree manager、PaneIntent、MCP permission。
- Scope or files: `crates/agentport-core/src/git/worktree.rs`, `git/mod.rs`, `host_manager.rs`, `crates/agentport-service/src/lib.rs`, MCP registry/tools, 前端 Session actions。
- Expected output: task-to-worktree policy、intervention lease state machine、permission matrix、orphan cleanup/reconciliation design。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 只读任务允许共享项目；写任务默认创建独立 AgentPort worktree；集成任务使用专用 integration worktree。
  2. Bot 持有 child control lease；用户点击接管后进入 `user_owned`，Bot dispatch/prompt/cancel 被拒或排队。
  3. 用户交还后 Bot 先读取当前 status/reply/diff，再决定继续、重试或重新规划。
  4. 观察模式只读；直接写入、停止、删除、归档和切换 worktree 都记录操作者和时间。
  5. Bot 停止/删除时递归处理 children，但必须保留可恢复的审计/结果，避免孤儿 Host。
  6. 分屏只表示可见性，不改变 ownership；close pane 不停止 task。
- Acceptance criteria:
  - 两个写任务不会默认进入同一 worktree；冲突能被 Bot 看到并升级为 `needs_review`。
  - Bot 与用户不会同时向同一 Session 写入；lease 失效/断线可安全恢复。
  - 用户能在 Bot 主界面和 child pane 间切换，不会误把观察操作当作任务完成。
  - 强制停止后所有子进程组、worktree 和 task 状态均可验证。
- Verification method:
  - 并发 lease、worktree conflict、stop/restart/orphan tests；人工操作 flow 设计和 UI E2E。
- Validation evidence: Not run.
- Blocker: Q-004、Q-007 未确认。
- Unblock condition: 采用本计划默认接管租约和后端 worktree provisioning。

### [ ] T-006 — Bot Workspace、任务视图与子 Session 分屏 UI

- Status: in_progress
- Owner: unassigned
- Objective: 让用户只对接 Bot，同时保留对子 Agent 的可发现、可观察和可干预入口。
- Inputs and prerequisites: T-001/T-002/T-005；现有 Sidebar、TerminalArea、MCP pane queue、Session status API。
- Scope or files: `src/src/components/`, `src/src/actions.ts`, `src/src/api.ts`, `src/src/types.ts`, `src-tauri/src/external_agents.rs`, 新 Bot workspace components/tests/locales。
- Expected output: Bot main pane/dashboard、task graph/list、child pane badges、observe/takeover controls、memory inspector entry、mobile degradation design。
- Dependencies: T-001, T-002, T-005.
- Execution steps:
  1. Bot 主视图：对话、当前目标、阶段、需要用户决定的事项、子任务摘要和下一步。
  2. Task board/list：pending/running/blocked/review/completed，显示 Agent、Role、worktree、attempt、证据和依赖。
  3. Child pane：复用现有 pane layout；标题显示 Bot/Task 归属、控制状态和风险，不修改 Session 原始输出语义。
  4. 添加“观察”“打开窗格”“请求接管”“交还 Bot”“取消任务”“查看 diff/证据”动作。
  5. 在 Bot/child 状态变化时使用通知/未读标记，但不抢夺用户焦点。
  6. 移动端首版只实现 Bot 摘要、任务状态、通知、打开 child、接管确认；复杂图视图可降级为列表。
- Acceptance criteria:
  - Bot 视图不要求用户手工维护多个 Session ID。
  - 子 Agent 可一键观察/聚焦，分屏请求有明确 queued/visible 状态。
  - 接管前后 UI 显示谁拥有输入权；Bot 的自动动作暂停可见。
  - task summary 与 child pane 的状态一致，旧/重复事件不会造成重复任务卡。
- Verification method:
  - React unit/UI tests；pane layout/command queue tests；桌面、远程、移动至少各一条观察/接管集成路径。
- Validation evidence: Not run.
- Blocker: 依赖 T-001/T-002/T-005 的 wire contract。
- Unblock condition: 任务状态和干预 lease payload 固化。

### [ ] T-007 — 安全、审计、恢复、预算与验证闭环

- Status: in_progress
- Owner: unassigned
- Objective: 以可恢复、可审计和可控成本为完成标准，验证 Bot 不会重复派发、越权或吞掉失败。
- Inputs and prerequisites: T-001~T-006；现有 MCP tests/E2E、Host cleanup、backup、版本/签名规则。
- Scope or files: Core/Service/MCP/GUI tests、`scripts/test-agentport-mcp.py`、新增 Bot E2E/replay fixtures、`docs/mcp.md`/新 Bot 文档、任务验证。
- Expected output: focused test matrix、failure injection/replay fixtures、security review checklist、performance/resource limits、release/rollback checklist。
- Dependencies: T-001, T-002, T-003, T-004, T-005, T-006.
- Execution steps:
  1. 验证 intake→plan→dispatch→wait→verify→report 全链路。
  2. 注入 child timeout、needs_input、malformed output、duplicate reply、MCP restart、GUI offline、Bot crash、orphan Host、worktree conflict。
  3. 验证 token/session/role/project ownership、prompt injection、memory poisoning、secret redaction、Bot recursion 和 quota。
  4. 验证 1/4/16 child 并发下 MCP RSS/FD/thread、UI queue、数据库写入和输出节流。
  5. 验证 stop/archive/delete/restore/backup/upgrade 后 task/memory/Session 语义。
  6. 运行最小 Core/Service/MCP/UI/E2E checks；实现阶段遵守 AgentPort 提交、版本和 debug UI 规则。
- Acceptance criteria:
  - 失败不会被 Bot 汇报为成功；每个结果均有 evidence/unknown/next action。
  - 重启/断线/超时不会重复派发或遗留无法控制的 child。
  - 安全审查确认 Bot 无权访问未授权 Session/项目/记忆；高风险动作有用户确认。
  - 任务文档 validator、针对性测试和最终工作树检查通过。
- Verification method:
  - `cargo test -p agentport-core --lib`、`cargo test -p agentport-service --lib`、`cargo test -p agentport-mcp --lib`、前端 targeted tests、MCP E2E 和 task-specific replay；具体命令以实现变更后的最小有效集合为准。
- Validation evidence: Not run.
- Blocker: 所有上游实现任务未完成；本计划阶段不执行。
- Unblock condition: T-001~T-006 达到可测试的实现契约。

### [ ] T-008 — 外部 issue/task 接入（post-MVP）

- Status: pending
- Owner: unassigned
- Objective: 在 Bot task contract 稳定后接入 GitHub/Jira/Linear 等 issue 来源，并保持 Bot 作为唯一入口。
- Inputs and prerequisites: T-002、T-004、T-007；用户确认 Q-003；具体 provider/API 权限。
- Scope or files: 新 issue connector modules、MCP/CLI/UI import commands、secret/credential policy、docs。
- Expected output: `ExternalIssueRef` 映射、去重/idempotency、webhook/polling policy、import/update audit contract。
- Dependencies: T-002, T-004, T-007.
- Execution steps:
  1. 先支持显式 `bot_submit_issue` payload 和本地 issue file/CLI。
  2. 再按用户确认选择一个外部系统做只读 import + 手动同步。
  3. 设计外部 comment/status 更新前的用户授权和防循环机制。
- Acceptance criteria:
  - 外部 issue 可映射到稳定 Bot Task，重复 webhook 不创建重复任务。
  - 外部内容只作为不可信输入，权限和 secrets 不进入 Bot memory。
- Verification method:
  - connector fixture tests、idempotency、权限和 webhook replay tests。
- Validation evidence: Not run.
- Blocker: 明确 Q-003 和外部 API/凭据授权。
- Unblock condition: 用户选择首个外部 issue 系统并提供接口边界。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

本文件为 plan 模式；不执行实现、不会启动 AgentPort Debug App，也不会运行实现测试。实现阶段应按以下层次验证：

1. **Domain/state**：Bot/Task/Attempt/Memory/Lease 状态转移、CAS、idempotency、scope、backup/restore、删除语义。
2. **MCP contract**：Bot-only tools schema、权限/ownership、批量派发、wait group、取消、重启恢复和 duplicate dispatch。
3. **Host/service**：child Session 创建/停止、worktree、进程组清理、Bot/child parent binding、late event quarantine。
4. **UI**：Bot workspace、task list、pane observe/focus、takeover lease、return control、通知和移动降级。
5. **Failure injection**：Bot/child/MCP/GUI crash、needs_input、timeout、unreadable output、orphan Session、worktree conflict、memory conflict。
6. **Performance**：1/4/16 child 并发下 MCP resource、DB writes、UI queue、event coalescing、memory prompt token budget。
7. **Repository gates**：实现变更后使用最小相关 Rust/frontend/MCP/E2E checks；涉及 UI 行为时按 `AGENTS.md` 重启签名 Debug App，确认目标 GUI 路径和非空窗口；验证通过后只提交本任务相关改动。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- **R-001 Manager single point of failure**：Bot Session 崩溃会让用户失去唯一入口；必须持久化 Task Graph，并提供恢复/接管入口，不把状态只放在 Bot prompt。
- **R-002 Recursive fan-out/cost explosion**：Bot 可能无限创建 child；需要 project/Bot/global 并发、深度、token/time/budget 和单次 dispatch 上限。
- **R-003 Duplicate dispatch after restart**：模型或 MCP 请求重试可能重复开 Session；必须以 durable dispatchKey 和 Session binding 去重。
- **R-004 Concurrent writes/worktree conflicts**：多个 Agent 修改同一目录会互相覆盖；默认独立 worktree，集成步骤串行且有 diff/review gate。
- **R-005 Bot memory poisoning**：子 Agent/仓库文件可注入错误身份、秘密或恶意指令；记忆写入必须有 provenance、schema、redaction、review/lock。
- **R-006 User/Bot write race**：用户在 child pane 直接输入时 Bot 仍可能发送 prompt；必须有 intervention lease 和明确的 owner arbitration。
- **R-007 Permission mismatch**：Bot 默认 bypass 与用户期望不一致；Bot、child、MCP tool、worktree、外部 issue token 必须分别授权并审计。
- **R-008 ACP capability fragmentation**：不同 Agent 的 ACP 能力、resume、slash command、subagent、permission 不同；必须能力驱动降级，不能假设统一行为。
- **R-009 UI overload**：所有 child 输出直接进入主 Bot UI 会淹没用户；默认只显示摘要/风险/阻塞，child 原始输出按需打开，工具输出有界并可 lazy load。
- **R-010 Existing MCP scope**：现有 registry 以 MCP 进程为 ownership 边界；Bot 长期任务需要跨 MCP/GUI 重启的更强 durable binding，不能只扩展内存中的 `created_here`。
- **R-011 External issue scope creep**：同时做 GitHub/Jira/Linear 会显著扩大 OAuth/webhook/同步冲突范围；MVP 只做统一输入 contract。
- **R-012 Existing uncommitted change**：当前 AgentPort 工作树已有 `src-tauri/Cargo.toml` 修改；未来实现或提交不得混入该改动。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-23: Task document created in plan mode; no implementation or subagent execution authorized.
- 2026-11-24: User explicitly authorized implementation and delivery; execution mode activated using the existing task document as authority. MVP scope prioritizes a durable Bot control plane, PM template, task/memory MCP tools, and safe delegation/recovery before external issue integrations.
- 2026-11-24: T-001/T-002/T-003 implementation started with a bounded MCP/core vertical slice; external issue connectors and full dashboard remain downstream until the durable control contract is verified.
- 2026-11-24: Implemented the durable MCP Bot store, manager-only task tools, atomic dispatch reservation, attempt history, project-scoped memory candidates, per-task permission/write isolation, user control leases, Bot role template, desktop Bot IPC/dashboard, pane observation, and backup inclusion for `mcp/bots.json`/ownership state. ACP remains a future transport; this slice uses the existing PTY lifecycle with evidence gates.
- 2026-11-23: Read AgentPort `AGENTS.md`, current MCP/Role/registry/UI queue sources, and relevant `LEARNS.md` retrieval; confirmed existing delegation/pane/wait/role foundations and their limits.
- 2026-11-23: Researched comparable patterns from Claude Code subagents/agent teams, Devin managed Devins, and OpenHands Task Tool Set; used official documentation URLs where available. Public-page capture was partially limited by the browser tunnel, so product claims are kept bounded to the retrieved official excerpts/pages.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: `cargo test -p agentport-mcp --lib` (51 passed), `cargo test -p agentport-core backup::tests::backup_verify_restore_roundtrip` (passed), `cargo check -p agentport`, frontend `npm run build` (passed), targeted external-pane tests (39 passed), and task validator (passed).
- Limitations: ACP transport, remote/mobile Bot APIs, external issue connectors, full end-to-end live Agent dispatch, and signed Debug App screenshot verification remain outstanding. The current implementation deliberately fails closed on unproven prompt delivery, low-confidence completion, corrupt state, and user-held intervention leases.
