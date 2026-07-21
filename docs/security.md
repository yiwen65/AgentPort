# AgentPort 安全说明

本文说明 AgentPort 的安全模型：数据边界、进程隔离、凭据处理与危险操作的默认行为，帮助你在多 Agent 并行工作的场景下判断"什么会发生、什么绝不会发生"。

## 本地优先，无遥测

- 所有数据（项目、Session 元数据、原始终端日志、搜索索引、Worktree）只保存在本机应用数据目录：macOS 为 `~/Library/Application Support/AgentPort`，Linux 为 `~/.local/share/agentport`。
- 无账号体系、无云端同步、无遥测上报。遥测开关在数据模型中是硬约束：默认值和唯一允许值均为 `false`，不存在开启入口。
- Agent 的模型账号、API Key 与费用仍由各 CLI 自己管理，AgentPort 不代购、不代理、不转发。

## Session 隔离与输入认证

每个 Session 由独立的 Host 进程持有：独立 PTY、独立 Unix Domain Socket、独立日志文件。Session 之间的输入、输出、工作目录和环境严格隔离。

- GUI（以及 `agentport-cli`）只是可重连的客户端，不拥有 Agent 进程的生命周期。
- 每次启动生成一个随机 Host Token。客户端连接 Socket 时的握手必须同时出示 **Session ID + Token**，缺一即被拒绝并断开；此后每一条输入帧都重新校验 Session ID。Host PID 只用于诊断，绝不作为身份依据。
- Socket 目录位于系统临时目录下 `agentport-<uid>/`，权限为 `0700`（仅当前用户可进入）；Host 配置文件权限为 `0600`，且其中不含任何 Secret。
- 重连时会清理陈旧 Socket，绝不向已失效的旧 PID 发送输入。

## 停止语义：清理完整进程组

"停止 Session"针对的是**整个进程组**，而不只是 Agent 主进程：

1. Agent 子进程以新的会话首进程（session leader）方式启动，进程组 ID 即其子进程 PID，所有信号都发往整组；
2. 停止流程为 SIGINT → 宽限 → SIGTERM → 宽限 → SIGKILL（逐组发送），随后验证组内已无存活进程并回收；
3. 因此 Agent 通过 job control 放到后台的任务（`&`、`nohup` 风格的组内后代）同样会被清理，不会在停止后残留；
4. Host 进程自身收到 SIGINT/SIGTERM/SIGHUP 时也执行同一套组清理——任何路径下都不会把 Agent 变成孤儿进程。

停止操作没有快捷键，只能经菜单/按钮触发；"重启并恢复"对正在工作的 Session 需二次确认。机器重启后 AgentPort 不伪装任务仍在运行，也不自动执行有副作用的恢复命令。

## 权限模型边界

- 默认权限模式为 `native`：完全沿用各 CLI 自己的审批提示，AgentPort 不添加任何跳过审批的参数，**绝不默认附加 `--yolo` 类标志**。
- `auto` / `bypass` 由用户在新建 Session 的权限设置或预设中显式选择；创建和恢复时不再弹出二次风险确认，Session 存续期间标题栏仍常驻 ⚠ 警示徽标。
- 后端仍在实际创建前校验可执行文件、命令、工作目录与权限参数；校验失败时不会留下半创建的 Session。

## Secret 边界与脱敏审计

敏感环境变量（如 API Key）的存储与使用遵守以下硬边界：

- **只存系统安全存储**：macOS Keychain 或 Linux Secret Service（service 名称为 `agentport`）。SQLite 中只保存引用（变量名、后端、账户键），不保存原值。
- **原值的唯一流动路径**：系统安全存储 → 启动瞬间经 Credential Broker 读入受限内存 → 作为环境变量注入目标 Agent 子进程 → 立即清除临时缓冲。原值不经过前端、不进入 SQLite、不出现在进程参数、日志、搜索索引、导出和诊断包中。
- **无明文回退**：后端不可用（如 Linux 未运行 Secret Service）时，保存 Secret 的功能直接禁用，绝不退化为明文配置文件；此时仍可使用 Shell 环境中已有的变量。
- **输出脱敏**：Agent 输出一旦命中已登记 Secret 的字节序列，写盘前即替换为固定掩码 `[redacted]`（掩码长度与原值无关），并在诊断中心记录命中类型与计数——计数不含原值。短于 4 字节的值无法可靠脱敏，保存时会被直接拒绝。
- 搜索索引只收录经脱敏、去 ANSI 的终端文本；Secret 值与环境变量值不进入索引。

## 不修改你的全局 CLI 配置

Agent 状态 Hook 的集成遵循"按调用注入、可撤销、绝不静默改全局配置"：

- **Claude Code**：Hook 通过单次调用传入的 `--settings <文件>` 注册（该版本提供此参数时），作用范围仅限本次 AgentPort Session；绝不修改 `~/.claude/settings.json`。
- **Codex**：0.144.5 未提供可验证的 Hook 注入机制，因此不注入，状态降级为 PTY 启发式；绝不修改 `~/.codex/config.toml`。
- **Kimi Code**：0.27.0 唯一的 Hook 机制是全局 `~/.kimi-code/config.toml`，因无会话级机制而放弃注入，状态降级为 PTY 启发式并显示"状态可能不精确"。

即宁可降低状态置信度，也不碰用户的全局配置。

## Git 调用安全

- 所有 Git 操作（`worktree add/list/status/remove` 等）使用系统 `git` 命令，以**参数数组**方式调用，绝不拼接 Shell 字符串，杜绝参数注入。
- 使用系统 Git 也意味着沿用你已有的凭据、过滤器与全局配置，AgentPort 不另建凭据通道。
- Worktree 目录放在应用数据目录下，不污染主 Checkout；删除前强制检查未提交/未跟踪文件，dirty 默认阻止删除且不提供强制删除按钮；不做自动合并。

## 日志、导出与诊断包

- 原始输出先落盘再展示；日志文件以受限权限创建；到达上限（默认 200 MiB）后轮转，只保留最近窗口。
- 导出（`.log` / `.md` / `.zip`）经脱敏器处理并在临时目录构建后原子落位：任一步失败都会删除临时产物，源日志与元数据不受破坏；若脱敏本身失败，导出中止。
- 诊断 ZIP **默认脱敏**：不含环境变量值与模型凭据，每个 Session 只打包日志尾部片段；随包的 `manifest.json` 声明导出版本、时间与脱敏规则，不含 Token 与 API Key。

## 已知限制

本文件只给出安全模型与默认行为。当前版本已确认的限制（平台支持边界、各 Agent 的 Hook 与恢复精度现状、Linux 桌面差异等）见 `docs/known-limitations.md`。发现安全问题时，请附上诊断中心导出的脱敏诊断摘要进行反馈。
