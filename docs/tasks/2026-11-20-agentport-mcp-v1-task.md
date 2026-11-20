# Task Plan: AgentPort Sessions MCP v1

- Created: 2026-11-20
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in-progress
- Source: 2026-11-20 会话中用户确认的需求讨论结论（"按照你的建议来"）

<!-- task-doc-section:background-goal -->
## Background and goal

AgentPort 的界面只是可重连客户端，真正拥有进程的是 `agentport-host`，业务语义集中在 Tauri-free 的
`agentport-service`。手机端已经通过 `agentport-remote-bridge`（stdio + `agentport-remote-protocol`）
在另一个进程里创建会话、发输入、读输出。本任务把同一层能力以 **MCP（Model Context Protocol）**
暴露给外部 Agent：Agent 注册该 MCP 后，可以直接在 AgentPort 里创建指定 Agent 的 Session、委派任务、
等待结果、收尾，并在用户的可见布局里打开对应窗格。

目标不是"再造一套 Agent 编排"，而是让委派出来的任务**在 AgentPort 里可见、可接管、可回收**，
并复用既有的状态置信度、Hook、进程组清理与原生恢复能力。

<!-- task-doc-section:scope-non-goals -->
### Scope

- 新增 stdio MCP server `agentport-mcp`（新 crate），直接依赖 `agentport-service`，进程常驻。
- 工具集（v1）：`list_agents`、`resolve_project`、`list_sessions`、`session_status`、
  `create_session`（含首发任务与 ready 门）、`send_prompt`、`wait_for_task`、`read_output`、
  `cancel_turn`、`terminate_session`、`open_pane`。
- 会话归属：MCP 创建的 Session 记录在数据目录的 MCP 注册表里，默认**只能操作自己创建的 Session**。
- GUI 可见性：外部写入的会话必须实时出现在侧栏（不为 MCP 单独开轮询路径，用既有的
  `projects-changed` 语义驱动一次 `refreshProjects()`）。
- 打开窗格：MCP 写 UI 命令，GUI 消费并走既有 `actions`，分屏布局权威仍留在前端。

### Non-goals

- 任意分屏树操作（split/move/maximize/多组管理）、布局后端持久化或跨设备布局同步。
- Git 写操作、`document.write`、`secret.add`、worktree 删除、archive/delete、backup/restore、
  `settings.save` 等破坏性或凭据相关能力。
- 裸字节 `send_input`（可向任意会话注入任意控制序列）、`permission=bypass` 建会话。
- 结构化（`json_rpc`）首发任务通道；v1 统一走 PTY，结构化作为 v1.1 增强。
- 递归委派的完整配额系统；v1 只做深度上限与并发上限。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 无需 GUI 即可创建/输入/读取/停止会话：临时数据目录实测 `session new` 862 ms 返回 `hostPid`，`input`/`read --until`/`stop` 全部生效 | 2026-11-20 实测（`AGENTPORT_DATA_DIR=/tmp/ap-mcp-feas`，已清理） |
| F-002 | `agentport-service` 是 Tauri-free 门面，提供 create/attach/poll/input/control/stop/restart/worktree/project 等用例 | `crates/agentport-service/src/lib.rs:588-767`（`RemoteService` trait） |
| F-003 | `list_sessions` 会对运行中会话做 Host 握手并叠加 `current_status`，带按 status journal 失效的缓存 | `crates/agentport-service/src/lib.rs:3990-4022` |
| F-004 | `SessionSummary` 已含 `latestAttentionKind` / `unreadAttention`，可把"等待审批"作为一等结果返回 | `crates/agentport-service/src/lib.rs:287-356` |
| F-005 | 状态事实由 Host 写入 `sessions/<id>/status-events.jsonl`，DB 投影需客户端导入；Host 不直接写库 | `crates/agentport-core/src/host_manager.rs:1061-1098` |
| F-006 | 分屏布局只存在前端 localStorage，服务与协议层没有 pane 方法 | `src/src/paneLayout.ts:15`、`crates/agentport-remote-protocol/src/lib.rs:63-77` |
| F-007 | 本机设备没有会话轮询：GUI 刷新由同进程 `projects-changed` / `session-state` 事件驱动；`Sidebar` 的 10 s 轮询只刷新**非活跃设备** | `src-tauri/src/main.rs:1442`、`src/src/api.ts:801`、`src/src/deviceSessions.ts:241` |
| F-008 | `spawn_host_reaper` 是**启动进程内的线程**，因此 MCP 必须是常驻进程，不能 per-call 包装 CLI | `crates/agentport-core/src/host_manager.rs:548`、`:1240-1283` |
| F-009 | 已有的外部入口安装模式：`~/.local/bin` wrapper 指向 `.app` 内 sidecar | `docs/install.md:48` |
| F-010 | `host_binary_path()` 支持"自身可执行文件旁"，MCP sidecar 放进 `Contents/MacOS` 即可拉起 Host | `crates/agentport-core/src/host_manager.rs:56-105` |
| F-011 | Kimi/Codex 的状态是 PTY 启发式（中置信度），完成判定必须分层并如实报告置信度 | `docs/known-limitations.md` 第 6 条 |
| F-012 | PRD 把 Sessions MCP 列为 P3 并要求另立安全 PRD | `AgentPort_PRD.md:1028` |

<!-- task-doc-section:design -->
## Design decisions

| ID | Decision | Rationale |
| --- | --- | --- |
| D-001 | 形态：独立 stdio sidecar `agentport-mcp`，进程常驻，直接 `CoreService::open` | 与手机 Bridge 同构；常驻才能持有 reaper；stdio 被 Claude Code / Codex / pi 普遍支持 |
| D-002 | 会话归属记录在 `<data>/mcp/agent-sessions.json`，不新增 DB 迁移 | 避免 schema 版本联动；归属只影响 MCP 自身作用域 |
| D-003 | 默认作用域只含本 MCP 创建的 Session；`open_pane` 同样受限 | 防止向用户正在操作的会话注入输入 |
| D-004 | 委派默认 `permission: "bypass"`（各自的完全权限 flag），可用 `native` / `auto` 收窄 | 委派是无人值守的：停在审批提示上等于任务失败；风险由用户确认的默认策略承担，Session 带 ⚠ 警示 |
| D-005 | 不暴露裸字节输入；`send_prompt` 追加 `\r`、限制长度并拒绝 ESC/控制序列 | 只保留"派一句话"的语义 |
| D-006 | 首发任务由后端做 ready 门：等到"已出现输出且静默 quiet 窗口"或状态 idle 后再发送 | 交互式 TUI 启动窗口期早发会丢字节；不能让模型自己 sleep |
| D-007 | `wait_for_task` 分层判定：attention/状态 → 输出静默 → 生命周期，并返回 source/confidence | 各 Agent 判定精度不同，不能伪装确定性 |
| D-008 | `cancel_turn`（Ctrl-C，不结束会话）与 `terminate_session`（杀进程组，不可逆）**分成两个工具** | AgentPort 两者语义差别大，合并必错 |
| D-009 | `open_pane` 走 GUI 消费的命令队列，布局权威仍在前端 | 后端没有 pane 权威；改造它为权威需重写 1174 行前端状态机 |
| D-010 | 递归深度由 `AGENTPORT_SESSION_ID` + 归属表推导（不注入环境变量），超过上限拒绝创建；并发上限另设 | 防止 A→B→C 进程爆炸；服务协议没有设置子会话环境变量的入口 |

<!-- task-doc-section:contracts -->
## Tool contracts (v1)

| Tool | Input | Output | Notes |
| --- | --- | --- | --- |
| `list_agents` | – | 每个 Agent：`installed`、`path`、`version`、`exactResume`、`approvalModel`、`defaultTransport`、`unavailableReason` | 对应 `supported_agents()`；未安装的 Agent 不能建会话 |
| `resolve_project` | `path`（绝对路径） | `projectId`、`name`、`rootPath`、`created`、`focusedExisting` | 不存在则注册（幂等） |
| `list_sessions` | `includeArchived?` | 会话摘要：id/title/agent/lifecycle/status/attention/hostAlive/cwd | 只读 |
| `session_status` | `sessionId` | 同上单条 + 状态历史尾部 | 只读 |
| `create_session` | `agent`、`projectPath`/`projectId`、`title?`、`permission?`(bypass\|auto\|native，默认 bypass)、`prompt?`、`promptTimeoutMs?`、`worktreeId?` | `sessionId`、`title`、`cwd`、`permissionMode`、`effectivePermissionMode`、`ready`、`promptSent`、`statusSequence`、`blockedOn?`、`notices` | 归属注册；首发任务走 ready 门 |
| `send_prompt` | `sessionId`、`text` | `sent`、`bytes` | 仅归属内会话；长度/字符限制 |
| `wait_for_task` | `sessionId`、`timeoutMs?`（默认 120 s，上限 600 s）、`sinceSequence?` | `state`(idle\|needs_input\|exited\|timeout)、`source`、`confidence`、`evidence`、`outputTail`、`outputIncomplete`、`alreadySettled?` | 只承认比基线更新的状态迁移；重复调用直接返回上次结论 |
| `read_output` | `sessionId`、`tailBytes?`（默认 16 KiB，上限 64 KiB） | `text`、`truncated`、`incomplete`、`bytes`、`ended?` | Host 尾部重放；始终去除 ANSI；会话已结束时明确 `ended` |
| `cancel_turn` | `sessionId` | `accepted` | 等价 Ctrl-C，不结束会话 |
| `terminate_session` | `sessionId`、`graceMs?` | `groupCleaned` | 杀整个进程组，不可逆 |
| `open_pane` | `sessionId`、`focus?` | `queued` | GUI 消费后进入可见布局 |

<!-- task-doc-section:phases -->
## Phases

| Phase | Work | Status |
| --- | --- | --- |
| P1 | `agentport-mcp` crate：stdio JSON-RPC、工具框架、只读工具、归属注册表 | done |
| P2 | 写入工具：`create_session`（ready 门）、`send_prompt`、`wait_for_task`、`read_output`、`cancel_turn`、`terminate_session` | done |
| P3 | GUI 可见性：本地 DB 变更观察（`PRAGMA data_version`）→ 采纳 Session + 广播 `projects-changed` | done |
| P4 | `open_pane`：命令队列 + GUI 消费 + 前端 `openSessionForExternalAgent` | done |
| P5 | 打包与文档：`externalBin`、macOS/CI/Linux 构建脚本、`docs/mcp.md`、README | done（安装 wrapper 未做，见 R-005） |

<!-- task-doc-section:verification -->
## Verification

- `cargo test -p agentport-mcp`（协议帧、工具 schema、参数校验、归属作用域、文本裁剪）。
- 端到端脚本：临时数据目录 + `Shell` Agent 跑完 `initialize → tools/list → resolve_project →
  create_session → send_prompt → wait_for_task → read_output → terminate_session`。
- `cargo test --workspace --all-targets` 不回归；前端 `npm test`、`npm run build` 不回归（P3/P4）。
- 调试 App 重建/签名/打开并截图确认非白屏（P3/P4 涉及 UI 行为时）。
- 文档：新增 MCP 注册说明（stdio 命令、可用工具、安全边界）。

<!-- task-doc-section:risks -->
## Risks and open questions

| ID | Risk | Mitigation |
| --- | --- | --- |
| R-001 | 与 GUI 同时创建/停止会话的并发行为未验证 | P2 完成后用真实 GUI + MCP 双写做一次冒烟 |
| R-002 | 无状态启发式的 Agent（shell、降级 Kimi/Codex）完成判定只能靠输出静默 | `wait_for_task` 返回 `source`/`confidence`，不伪装确定性 |
| R-003 | 会话 stop 后 Host 内存尾部消失 | `read_output` 明确报告"会话已结束，正文需原生历史"（v1.1 接 `history.page`） |
| R-004 | 安全评审（PRD 要求的独立安全 PRD）尚未编写 | 本任务只实现受限工具集，安全 PRD 作为后续独立交付 |
| R-005 | 没有 `~/.local/bin` 安装 wrapper，注册需手填 `.app` 内绝对路径 | 与 mobile bridge 的安装器同构，留给 P5 后续切片 |
| R-006 | 纯 Shell 嵌套链拿不到真实委派深度（Host 只为非 Shell 适配器注入 `AGENTPORT_SESSION_ID`） | 并发上限仍是硬约束；已在 `docs/mcp.md` 标注 |
