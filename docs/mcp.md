# AgentPort Sessions MCP

`agentport-mcp` 是一个 stdio MCP（Model Context Protocol）服务器，让外部 Agent 直接驱动这台机器上的
AgentPort Session：在指定项目里用指定 Agent 开一个 Session、把任务派给它、等它settle、读输出、收尾，
并让这个 Session 出现在 AgentPort 的可见布局里。

它不重造编排：创建出来的 Session 与界面里手动开的完全一样 —— 同一个 `agentport-host` 进程、
同一条状态置信度链路、同样的进程组清理与原生恢复能力。区别只在于发起者是一个 Agent 而不是一只手。

## 注册

**最简单的方式：设置 → Agent 适配器 → 每个 Agent 后面的「MCP 注册」开关。**

开关直接调用该 Agent 自己的 MCP 管理命令（`claude mcp add -s user …`、`codex mcp add …`、
`epi/pi mcp add …`、`qodercli mcp add -s user …`、`grok mcp add …`），Cursor 走它的
`~/.cursor/mcp.json`；只写名为 `agentport` 的条目，关掉开关就移除，其它配置一字不动。
注册的命令路径取自**当前运行的这个 App**（`.app/Contents/MacOS/agentport-mcp`），所以升级 App
后仍然指向同一份。

没有 MCP 客户端可写的 Agent（目前只有 Generic Shell）开关置灰并给出原因 —— 不猜。

其余客户端按各自文档的**用户级配置文件**合并写入（只动名为 `agentport` 的那一条，原子写、解析失败拒改）：

| Agent | 文件 | 顶层键 | 条目形状 |
| --- | --- | --- | --- |
| Claude Code / Codex / Pi / easy-pi / Qoder / Grok | 各自的 `mcp add`（见上） | — | — |
| Cursor CLI | `~/.cursor/mcp.json` | `mcpServers` | `{command, args}` |
| Kimi Code | `~/.kimi-code/mcp.json`（`KIMI_CODE_HOME`） | `mcpServers` | `{command, args}` |
| oh-my-pi | `~/.omp/agent/mcp.json`（`PI_CODING_AGENT_DIR`） | `mcpServers` | `{command, args}` |
| Gemini CLI | `~/.gemini/settings.json`（`GEMINI_CLI_HOME`） | `mcpServers` | `{command, args}` |
| Kiro CLI | `~/.kiro/settings/mcp.json` | `mcpServers` | `{command, args}` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp` | `{type:"local", command:[…], enabled:true}` |
| Amp | `~/.config/amp/settings.json` | `amp.mcpServers`（带点号） | `{command, args}` |
| Cline CLI | `~/.cline/data/settings/cline_mcp_settings.json`（`CLINE_MCP_SETTINGS_PATH`） | `mcpServers` | `{command, args, disabled:false, autoApprove:[]}` |

若 OpenCode 用的是 `opencode.jsonc`（带注释，无法无损回写），开关会拒绝并说明原因，不会偷偷改写另一个文件。

也可以手动注册，MCP 客户端以 stdio 方式启动它：

```json
{
  "mcpServers": {
    "agentport": {
      "command": "/Applications/AgentPort.app/Contents/MacOS/agentport-mcp",
      "args": ["serve", "--stdio"]
    }
  }
}
```

- 二进制作随 App 一起分发（`Contents/MacOS/agentport-mcp`），旁边就是它需要的
  `agentport-host`，无需额外配置。
- 用 easy-pi 时：`epi mcp add agentport -- /Applications/AgentPort.app/Contents/MacOS/agentport-mcp serve --stdio`。
  调试构建请指向 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport-mcp`。
- 数据目录、Agent 探测结果、Secret、通知配置全部沿用 AgentPort 自己的（`AGENTPORT_DATA_DIR` 可覆盖）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `list_agents` | 只列出**已安装且未在设置里关掉**的 Agent；`probe: true` 会重新探测（较慢） |
| `list_roles` | 查询设置中**已启用**的角色 metadata（roleId、名称、说明、输出契约和 revision）；不会返回完整角色指令。委派工具的 tools/list 描述也会直接携带这些 metadata |
| `resolve_project` | 把绝对路径解析成项目，不存在则注册（幂等）。**通常用不到**：`create_session` 自己解析项目（显式 id/path → 否则当前工作目录；cwd 在已注册项目内时归到那个项目） |
| `list_sessions` / `session_status` | **只显示本 MCP 创建的会话**；状态带 source / confidence / evidence；完成后 `session_status.completion` 也会给本轮最终答复 |
| `create_session` | 建单个 Session；模型可根据 tools/list 中的已启用 Role name/description 自行传 `roleId`，也可以省略；带 `prompt` 时在后端等 CLI ready 再发；**默认 `pane=auto`**：渲染层按"整体最优"重排布局并把它放进新窗格 |
| `create_sessions` | 一次创建多个独立委派任务；每个 task 可传一个 `roleId` 或省略；返回按 index/taskId 对齐的独立结果；批量任务的 pane 只支持 `auto`/`none`，auto 只提交一次整体布局 intent |
| `handoff` | 接收完整 Markdown handoff，直接委派到指定 Agent 的新分屏并立即返回；这是一次性移交，不通过 wait 工具获取结果，也不写 `docs/handoff/` |
| `send_prompt` | 给**本 MCP 创建**的 Session 追加一句话（自动回车） |
| `wait_for_task` | 等当前委派回合 settle，返回 `idle` / `needs_input` / `exited` / `timeout`、依据和**本轮最终 `reply`**；`timeout` 是继续等待的结构化结果，应再次调用本工具，不要用 `read_output` 判断完成 |
| `wait_for_tasks` | 一次同步等待多个 MCP-owned Session；兼容旧客户端，按共享预算返回各项结果 |
| `start_wait_group` / `get_wait_group` | 注册并非阻塞地并行等待多个 Session；各项独立返回 `waiting` / `completed` / `needs_input` / `failed` / `cancelled` / `timeout` 和最终 reply |
| `cancel_wait_group` | 取消后台等待，不停止 Agent Session |
| `read_output` | 读取进度/输出证据：`screen`（Host 的 VT 网格投影）/ `stream`（游标行流）/ `transcript`（Agent 原生历史）；不是回合完成信号 |
| `cancel_turn` | 发 Ctrl-C，会话保留 |
| `terminate_session` | 停止并清理整个进程组；会话记录仍在（可恢复） |
| `archive_session` | 从侧栏移出并停止；历史保留，可在 App 里取消归档 |
| `delete_session` | **彻底删除**：停进程 + 删 Agent 原生 transcript + 删会话记录；需要 `confirm: "delete <sessionId>"` |
| `open_pane` | 请求桌面 App 把这个 Session 放进可见布局并聚焦 |
| `split_pane` | 请求给这个 Session 新开一个窗格：`direction=right\|down`，`targetSessionId` 指定参照窗格（默认当前聚焦的），`focus` 决定是否夺焦 |
| `focus_pane` | 请求聚焦这个 Session 的窗格（不在屏上就先放上去） |
| `close_pane` | 请求把这个 Session 的窗格从布局移除；**只改视图，不停会话** |

单任务委派：

```text
tools/list       // create_session 与 handoff 描述中包含已启用 Role 的 name/description
handoff         {agent: "claude", projectPath: "/repo", title: "continue handoff", handoff: "# Session Handoff ..."}  // 一次性移交，不等待结果
create_session  {agent: "claude", roleId: "role_implementer", projectPath: "/repo", title: "fix flaky test", prompt: "..."}
// 如果没有 Role 适用，模型省略 roleId；list_roles 仅在需要刷新 metadata 时调用
wait_for_task  {sessionId: "..."}  // 默认 45s；超时后继续调用本工具
```

批量委派优先使用非阻塞等待组，减少一个慢 Agent 对其他 Agent 的阻塞；`get_wait_group` 已返回每个完成 Session 的 `reply`，成功时不需要再调用 `read_output`。完成任务也不要自动 `terminate_session`，Session 会保留给用户查看或继续接管：

```text
resolve_project {path: "/repo"}
create_sessions {
  tasks: [
    {taskId: "lint", agent: "claude", projectId: "...", prompt: "run lint"},
    {taskId: "tests", agent: "codex", projectId: "...", prompt: "run tests"}
  ]
}
start_wait_group {
  tasks: [
    {taskId: "lint", sessionId: "...", sinceSequence: 12},
    {taskId: "tests", sessionId: "...", sinceSequence: 8}
  ]
}
get_wait_group {waitGroupId: "..."}
```

## 语义与边界

**作用域**：只有本 MCP 创建的 Session 存在于此。用户自己开的 Session **既不列出也不可寻址**（不是"只读"，是不可见）；`list_agents` 同样只给已安装且未被设置关掉的 Agent ——
一个 Agent 不应该能往你正在操作的窗格里打字。归属记录在 `<数据目录>/mcp/agent-sessions.json`。

**handoff**：`handoff` 接收调用方已经整理好的完整 Markdown，直接创建新分屏 Agent Session；它不使用 Role、不创建 handoff 文件，也不等待 Agent 完成。它是一次性移交，调用方不需要再通过 `wait_for_task` 或 wait group 获取结果。JSON-RPC Agent 通过 `structured_prompt` 原样保留 Markdown 换行；PTY/Shell 为兼容 TUI 使用单行压缩回退，并在结果的 `handoff.formatPreserved=false` 与 `fallbackReason` 中明确说明。PTY handoff 正文只发送一次，若 Enter 被 TUI 吞掉只重试 Enter，避免 Cursor 的 `[Pasted text #N]` 占位符重复累积。`agent` 与 `handoff` 必填，内容沿用 8 KiB/控制字符限制。

**角色**：角色在设置 → Agent 角色中全局管理。内置角色可编辑但不可删除，可恢复默认；DIY 角色新建时默认关闭。
`tools/list` 会把所有已启用 Role 的 `roleId`、name、description 动态放入 `create_session` / `create_sessions` 的工具说明；handoff 不展示或接受 Role。模型自行判断传入哪个 `roleId`，或在没有合适 Role 时省略；不需要先调用 `list_roles`。这一步只返回 metadata，不加载完整指令。
当模型传入 `roleId` 后，MCP 才按 ID 加载完整 Role 内容；创建时或第一次 `send_prompt` 时把当时的 roleId、revision 和完整内容快照写入归属记录，并只注入一次。禁用、删除或不存在的 roleId 会在创建/发送前拒绝，不会静默替换。
角色指令以受约束的单行 delegation preamble 注入，只是行为指导，不能改变 AgentPort 的权限、Agent、工具、窗格、所有权或生命周期规则。
角色编辑不会影响已有 Session。Generic Shell 不是对话型 Agent，不能安全应用角色，因此传 roleId 给 Shell 会被拒绝。

**权限**：委派默认就是**各自的完全权限模式**（`permission: "bypass"`），因为委派本来就是无人值守的：
子 Agent 停在审批提示上没人回答，任务就死在那里。各 Agent 的映射沿用 AgentPort 自己的适配器验证
过的原生 flag —— Claude/Qoder `--dangerously-skip-permissions`、Codex
`--dangerously-bypass-approvals-and-sandbox`、Kimi `--yolo`、Cursor/Grok 各自的对应 flag；
Pi、Amp、Generic Shell 上游没有审批概念，`effectivePermissionMode` 会如实回 `native`。

需要保留 CLI 自己的审批时显式传 `permission: "native"`（那就意味着会阻塞等人在 AgentPort 窗格里
批准），或传 `"auto"` 只放宽一部分。这些 Session 在标题栏照常带 ⚠ 警示，`list_sessions` 也会显示
`permissionMode`。

**输入**：没有裸字节输入工具。`send_prompt` 只接受一行文本，拒绝 ESC 与控制字符，上限 8 KiB。角色指令允许在设置中多行编辑，但注入时会压缩为空格并与任务一起受 8 KiB 限制。

**首发任务**：交互式 TUI 启动期间会把提前写入的字节丢掉（尤其 Qoder：它先画出输入框，再继续加载
MCP servers，此时打进去的字会被丢弃）。所以：

- `create_session` / `send_prompt` 都会先过 ready 门：已有输出 + 终端静默 **1.2 s**，并且启动
  宽限期内（6 s）不接受"状态来源仍是 `process`"（那只是 spawn 事实，不代表 TUI 能收键盘）。启动
  宽限后不再等，避免 hooks 装不上的会话永远不就绪。
- 打完字会**验证文本是否真的进了输入框**（屏幕投影优先；日志里的 tty 回显不算，raw mode 之前的
  回显是假证据），没进就再打一次；回车后没看到回合开始也会重发回车。整轮最多 4 次。
- 回执带 `promptAttempts` / `enterRetries` / `promptSubmitted`，并如实给出 `hint`（比如"可能卡在
  信任/登录弹窗"）。正常路径下调用方**不需要**手工重发。

**完成判定**：`wait_for_task` 先看 `needs_input`（Agent 在等审批，这是委派最常见的死结），
再看**本次 prompt 之后**的 `state` 帧上的 `working → idle` 迁移与 `exited`。`create_session`/`send_prompt` 会返回
`statusSequence` / `statusRunOrdinal`，MCP 同时保留完整的 run/sequence 基线，只承认**比它更新**的状态迁移，所以"发出任务后 0.9 秒就报空闲"
这种误判不会再出现；也可以显式传配对的 `sinceSequence` + `sinceRunOrdinal`。

非阻塞等待组不会占用 MCP 请求；每个后台任务独立监控，调用 `get_wait_group` 读取结果。兼容模式的同步等待每次最多 45 秒，低于常见 MCP 客户端的 60 秒请求期限。长任务返回 `state: "timeout"`、
`stillRunning` 和 `nextAction: "wait_for_task"`；保持同一个 Session 和 prompt，不要重新发送，也不要改用
`read_output` 冒充完成判断，继续调用 `wait_for_task`，直到拿到本轮 `reply`。

只有当这个 Agent 完全不提供回合信号（例如 Shell：状态只是进程事实）时才退回到"终端静默 4 秒"，
并且一律报 `confidence: "low"` 与 `source: "quiet_window"`，不会把不确定当成完成。
重复调用 `wait_for_task` 对已有最终 reply 的高置信结论直接返回 `alreadySettled: true`。

**输出读取**（对齐 Orca 的三层设计）：

| `source` | 语义 |
|---|---|
| `screen`（默认 `auto` 的首选） | 取 Host 的 `terminal_snapshot_v1` 序列化网格，投影成**当前屏幕**：TUI 的重绘覆盖已被解析，不会得到一堆互相覆盖的原始字节 |
| `stream` | 从 Host 日志按**不透明游标**继续读行；先不带游标读一次，后续用返回的 `nextCursor` 续读，不会把两段不相干的窗口拼起来 |
| `transcript` | 读 Agent 自己的历史（Claude/Codex/Pi 的 JSONL），会话结束后仍然可读；没有历史时返回 `transcript-unavailable` + `fallbackReason` |

`source: "reply"` 只给**本轮**助手的回答：从原生历史倒着走，必须匹配本次 prompt 的 user 消息，再跳过 tool 事件
和 thinking；没有匹配的 prompt fence 时不会泄漏上一轮答案。`wait_for_task` 的 `reply` 字段就是这个东西；`session_status.completion.reply` 是同一份恢复入口；拿不到时给
`replyUnavailableReason`，并用 `outputTail`（screen/stream）作为进度证据兜底。

返回 `{source, lines[], returnedLineCount, truncated, limited, nextCursor}`：`truncated` 表示为了 `limit`
丢掉了更早的行，`limited` 表示 Host 无法兑现游标（日志轮转或 resync）；`incomplete: true` 表示有缺口，
不会把片段当作完整输出。`wait_for_task` 的 `outputTail` 同样优先 `transcript` → `screen` → `stream`，
并回 `outputSource` / `outputFallbackReason`，判定与依据一起交付。

**会话生命周期**：委派出来的会话**不会自己关闭**。它答完问题后仍然活着（像你开着的终端窗口），
你可以继续看、继续追问、直接接管；Host 是独立进程，MCP 退出或 GUI 关掉都不会结束它。
只有这几种情况会停：调用方显式 `terminate_session`、你在界面里停止/归档/删除、删除所属项目或
Worktree、或 Agent 进程自己退出。**任务完成不是终止的理由**（MCP 的说明里也是这么写的）。

**会话结束**：`terminate_session` 之后 Host 的内存尾部就没了。再调 `wait_for_task` 会得到
`state: "exited"`，`read_output` 返回 `ended: true` 并明确提示"正文需从 Agent 原生历史读取"，
不会报成连接错误，也不会伪造内容。

**递归与并发**：委派深度默认 2 层（`AGENTPORT_MCP_MAX_DEPTH`）；**每个 MCP 进程**同时驱动的存活
Session 默认 **16 个**（`AGENTPORT_MCP_MAX_SESSIONS`）。额度是 per-process 的：两个协调者窗口各有一份，
互不挤占；只统计该进程自己创建、且仍 `running`/`creating` 的会话，跑完就释放名额。深度由 `AGENTPORT_SESSION_ID` + 归属表推导，
不需要向子会话注入环境变量。

已知限制：Host 只为非 Shell 的 Agent 注入 `AGENTPORT_SESSION_ID`，所以纯 Shell 的嵌套链几乎测不出
真实深度（并发上限仍是硬约束）。归属表由多个 MCP 进程用文件锁合并写入，互不覆盖。

## 与界面的关系

AgentPort 界面本身是"可重连客户端"，它并没有轮询本机数据库。因此外部进程写入的 Session
由 App 内的观察者接手：检测到别的连接提交了事务，就采纳运行中的 Session（挂上 Host monitor，
状态、未读、通知随之而来）并广播一次 `projects-changed`。分屏/聚焦/关窗格走的是同一套机制里的
命令行队列（`<数据目录>/mcp/ui-commands.jsonl`），由渲染层用自己的 action 应用 ——
分屏布局的权威始终在前端，MCP 只能"请求"，所以回执说的是 `queued`，不是"窗格已存在"。

**委派必定分屏，且按整体最优网格**：`create_session` / `create_sessions` 没有"不占窗格"的选项（传
`pane: "none"` 会被拒，`pane_not_optional`）。渲染层拿到意图后按**整张布局**重排：按窗格数量选最合适的
网格（2 → 两列，4 → 2×2，9 → 3×3，11 → 4×3），每个窗格都拿到当前工作区允许的最大尺寸 —— 连续委派多个
Agent 会长成棋盘，而不是一排越切越窄的竖条。

**父会话只决定插入顺序，不改变网格形状**：新窗格插在发起委派的那个 Agent 的窗格旁边（`targetSessionId`
= 父会话），但列数/行数仍由最优网格规则决定。显式 `split_pane` 仍可强制 `right` / `down`（局部切分）。
回执里的 `pane` 带队列命令 id。

语义细节：已经上屏的 Session 再请求 `split_pane` 只会聚焦、不会重复开窗格；窗格太小放不下
（320×180 门限）或找不到参照窗格时，退化为"就在当前视图显示它"，不会留下空白工作区；
`focus: false` 保持用户原来的焦点，而不是把焦点扔给新窗格。

桌面 App 没在运行时：Session 照常创建和运行，`open_pane` 命令留在队列里，等 App 起来后消费。

## 各 Agent 的实测结果

2026-11-20 用真实安装的 CLI 逐个跑 `create_session(prompt) → wait_for_task → read_output`：

| Agent | 首发任务提交 | 完成判定 | 备注 |
| --- | --- | --- | --- |
| Claude Code | ✅ | `idle/hook`（高） | |
| Codex | ✅ | `idle/hook`（高） | |
| easy-pi / Pi / oh-my-pi | ✅ | `idle/adapter`（高） | 原生 TurnEnd 语义事件 |
| Kimi Code | 被信任提示拦住 | `needs_input`（中） | 新目录会弹「Trust this folder?」 |
| Qoder CLI | 被信任提示拦住 | `needs_input`（中） | 「1. Trust folder / 2. Don't trust」 |
| Cursor CLI | 被首启菜单拦住 | `needs_input`（中） | 首次启动是方向键菜单 |
| Grok Build | 被登录拦住 | `needs_input`（中） | 「Approve in your browser」 |

两条实践结论：

1. **委派到 Agent 已经信任过的目录**（用户平时干活的仓库）就不会碰到信任提示。
2. 遇到提示时 MCP 会返回 `needs_input` + `blockedOn`，**不会**把提示当成"任务完成"或"提交成功"；
   在 AgentPort 那个窗格里回答一次，之后 `send_prompt` 就能正常派活。

## 故障排查

| 现象 | 原因 |
| --- | --- |
| `Permission denied` / 立即退出 | `agentport-mcp` 需要与 `agentport-host` 在同一目录，或设 `AGENTPORT_HOST_BIN` |
| `list_agents` 全是 `installed: false` | 该数据目录还没跑过探测；用 `probe: true` 或在 AgentPort 设置里探测一次 |
| `session_not_owned` | 目标 Session 不是这个 MCP 创建的；用 `create_session` 自己开一个 |
| `open_pane` 返回 `ui_queue_failed` | 队列超过 1 MiB（桌面 App 长时间未运行），先启动 App 让它消费 |
| `wait_for_task` 返回 `timeout` | 任务比 `timeoutMs` 更久；继续等或先 `cancel_turn` |

## 验证

```bash
cargo test -p agentport-mcp
python3 scripts/test-agentport-mcp.py   # 临时数据目录 + Shell Agent 的端到端冒烟
```
