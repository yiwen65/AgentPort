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

没有任何已验证机制的 Agent（Kimi Code、oh-my-pi、OpenCode、Amp、Gemini、Cline、Kiro、Generic Shell）
开关置灰并给出原因 —— 不猜、不改它们的配置文件。

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
| `list_agents` | 列出可用的 CLI Agent；`probe: true` 会重新探测（较慢） |
| `resolve_project` | 把绝对路径解析成项目，不存在则注册（幂等） |
| `list_sessions` / `session_status` | 只读观察；状态带 source / confidence / evidence |
| `create_session` | 建 Session；带 `prompt` 时在后端等 CLI ready 再发 |
| `send_prompt` | 给**本 MCP 创建**的 Session 追加一句话（自动回车） |
| `wait_for_task` | 等当前回合 settle，返回 `idle` / `needs_input` / `exited` / `timeout` + 依据 |
| `read_output` | 读终端尾部（去 ANSI、有上限） |
| `cancel_turn` | 发 Ctrl-C，会话保留 |
| `terminate_session` | 停止并清理整个进程组，不可逆 |
| `open_pane` | 请求桌面 App 把这个 Session 放进可见布局并聚焦 |

一次典型委派：

```text
resolve_project {path: "/repo"}
create_session  {agent: "claude", projectId: "...", title: "fix flaky test", prompt: "..."}
wait_for_task  {sessionId: "...", timeoutMs: 600000}
read_output    {sessionId: "..."}
terminate_session {sessionId: "..."}
```

## 语义与边界

**作用域**：只有本 MCP 创建的 Session 可以被驱动。用户自己开的 Session 在这里是只读的 ——
一个 Agent 不应该能往你正在操作的窗格里打字。归属记录在 `<数据目录>/mcp/agent-sessions.json`。

**权限**：`permission` 默认 `native`（沿用 CLI 自己的审批）；`auto` 必须同时传
`allowAutoApprove: true`；`bypass` 永远拒绝。

**输入**：没有裸字节输入工具。`send_prompt` 只接受一行文本，拒绝 ESC 与控制字符，上限 8 KiB。

**首发任务**：交互式 TUI 启动期间会把提前写入的字节丢掉，所以 `create_session` 自己等
"已有输出 + 终端静默 500 ms"或状态 `idle` 后才发送，并回报 `ready` 与 `readyEvidence`；
等不到就返回 `promptSent: false`，由调用方用 `send_prompt` 自己决定。

**完成判定**：`wait_for_task` 先看 `needs_input`（Agent 在等审批，这是委派最常见的死结），
再看 `state` 帧上的 `working → idle` 迁移与 `exited`。`create_session`/`send_prompt` 会返回
`statusSequence`，`wait_for_task` 只承认**比它更新**的状态迁移，所以"发出任务后 0.9 秒就报空闲"
这种误判不会再出现；也可以显式传 `sinceSequence`。

只有当这个 Agent 完全不提供回合信号（例如 Shell：状态只是进程事实）时才退回到"终端静默 3.5 秒"，
并且一律报 `confidence: "low"` 与 `source: "quiet_window"`，不会把不确定当成完成。
重复调用 `wait_for_task` 会直接返回上一次已结算的结论（`alreadySettled: true`），不会重新等满超时。

**尾部完整性**：Host 报告日志缺口（`resync_required`）时，`read_output`/`wait_for_task` 返回
`incomplete: true`，不会把有缺口的片段当作完整输出。

**会话结束**：`terminate_session` 之后 Host 的内存尾部就没了。再调 `wait_for_task` 会得到
`state: "exited"`，`read_output` 返回 `ended: true` 并明确提示"正文需从 Agent 原生历史读取"，
不会报成连接错误，也不会伪造内容。

**递归与并发**：委派深度默认 2 层（`AGENTPORT_MCP_MAX_DEPTH`），单个服务器同时驱动的存活 Session
默认 8 个（`AGENTPORT_MCP_MAX_SESSIONS`）。深度由 `AGENTPORT_SESSION_ID` + 归属表推导，
不需要向子会话注入环境变量。

已知限制：Host 只为非 Shell 的 Agent 注入 `AGENTPORT_SESSION_ID`，所以纯 Shell 的嵌套链几乎测不出
真实深度（并发上限仍是硬约束）。归属表由多个 MCP 进程用文件锁合并写入，互不覆盖。

## 与界面的关系

AgentPort 界面本身是"可重连客户端"，它并没有轮询本机数据库。因此外部进程写入的 Session
由 App 内的观察者接手：检测到别的连接提交了事务，就采纳运行中的 Session（挂上 Host monitor，
状态、未读、通知随之而来）并广播一次 `projects-changed`。`open_pane` 走的是同一套机制里的
命令行队列（`<数据目录>/mcp/ui-commands.jsonl`），由渲染层用自己的 action 应用 ——
分屏布局的权威始终在前端，MCP 只能"请求"。

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
