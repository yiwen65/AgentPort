# AgentPort 安全说明

本文说明 AgentPort 的安全模型：数据边界、进程隔离、凭据处理与危险操作的默认行为，帮助你在多 Agent 并行工作的场景下判断"什么会发生、什么绝不会发生"。

## 本地优先，无遥测

- AgentPort 自己的数据（项目、Session 元数据、状态事件、Worktree、备份与用户显式导出）只保存在本机。常规历史与搜索按需只读各 Agent 的原生日志，不建立正文索引或 PTY 副本；只有用户明确创建 v2 备份时，能够唯一绑定到 Session 的原生正文才会复制进备份 ZIP。
- 无账号体系、无云端同步、无遥测上报。遥测开关在数据模型中是硬约束：默认值和唯一允许值均为 `false`，不存在开启入口。
- Agent 的模型账号、API Key 与费用仍由各 CLI 自己管理，AgentPort 不代购、不代理、不转发。

## Session 隔离与输入认证

每个 Session 由独立的 Host 进程持有：独立 PTY、独立 Unix Domain Socket、独立 4 MiB 实时输出内存尾部。Session 之间的输入、输出、工作目录和环境严格隔离。

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

- 支持权限审批的 CLI 默认使用 `native`：完全沿用 CLI 自己的审批提示，AgentPort 不添加任何跳过审批的参数，**绝不默认附加 `--yolo` 类标志**。
- Pi 与 Generic Shell 不使用 Agent 权限模式；Pi 直接启动且不附加任何权限参数。持久化的 `native` 值仅作为兼容字段。
- `auto` / `bypass` 由用户在新建 Session 的权限设置或预设中显式选择；创建和恢复时不再弹出二次风险确认，Session 存续期间标题栏仍常驻 ⚠ 警示徽标。
- 后端仍在实际创建前校验可执行文件、命令、工作目录与权限参数；校验失败时不会留下半创建的 Session。

## Secret 边界与脱敏审计

敏感环境变量（如 API Key）的存储与使用遵守以下硬边界：

- **只存系统安全存储**：macOS Keychain 或 Linux Secret Service（service 名称为 `agentport`）。SQLite 中只保存引用（变量名、后端、账户键），不保存原值。
- **AgentPort 内的流动路径**：系统安全存储 → 启动瞬间经 Credential Broker 读入受限内存 → 作为环境变量注入目标 Agent 子进程 → 立即清除临时缓冲。原值不进入 AgentPort 前端状态、SQLite、进程参数、正文索引或诊断包。目标 Agent 自己的原生日志属于其安全边界。
- **无明文回退**：后端不可用（如 Linux 未运行 Secret Service）时，保存 Secret 的功能直接禁用，绝不退化为明文配置文件；此时仍可使用 Shell 环境中已有的变量。
- **实时输出脱敏**：PTY 输出一旦命中已登记 Secret 的字节序列，进入 AgentPort 实时内存尾部和前端前即替换为固定掩码 `[redacted]`，并只记录命中计数。AgentPort 不改写 Agent 原生日志。
- 会话正文搜索按需读取 Agent 原生日志，不建立正文索引；原生日志是否含敏感信息由对应 Agent 的策略决定。

## 不修改你的全局 CLI 配置

Agent 状态 Hook 的集成遵循"按调用注入、可撤销、绝不静默改全局配置"：

- **Claude Code**：Hook 通过单次调用传入的 `--settings <文件>` 注册（该版本提供此参数时），作用范围仅限本次 AgentPort Session；绝不修改 `~/.claude/settings.json`。
- **Codex**：0.144.5 未提供可验证的 Hook 注入机制，因此不注入，状态降级为 PTY 启发式；绝不修改 `~/.codex/config.toml`。
- **Kimi Code**：0.27.0 唯一的 Hook 机制是全局 `~/.kimi-code/config.toml`，因无会话级机制而放弃注入，状态降级为 PTY 启发式并显示"状态可能不精确"。

即宁可降低状态置信度，也不碰用户的全局配置。

## Git 调用安全

- 所有 Git 操作（`worktree add/list/status/remove` 等）使用系统 `git` 命令，以**参数数组**方式调用，绝不拼接 Shell 字符串，杜绝参数注入。
- 使用系统 Git 也意味着沿用你已有的凭据、过滤器与全局配置，AgentPort 不另建凭据通道。
- Worktree 目录放在应用数据目录下，不污染主 Checkout；删除前展示未提交、未跟踪、被忽略文件与 Session 引用，确认后只对 AgentPort 托管目录执行强制清理，不因 dirty、Git 锁或引用关系阻止删除；不做自动合并。

## 日志、导出与诊断包

- PTY 输出只进入 4 MiB 有界内存尾部，用于实时展示和短暂重连；Host 不创建 `output.log`。
- 用户显式导出 `.md` / `.json` 时直接流式读取 Agent 原生日志并排他创建目标文件；失败会删除未完成产物。AgentPort 不对原生日志做原地修改。
- 诊断 ZIP 不包含会话正文或终端尾部，只包含状态事件、AgentPort 诊断信息和无 Secret 的清单；`manifest.json` 不含 Host Token 与 API Key。

## 备份的数据与安全边界

- v2 备份包含 SQLite 快照、AgentPort 管理的 Session 元数据，以及能够通过原生 Session ID（必要时同时校验 CWD）唯一定位的 Provider 原生文件。它不打包旧 `output.log`、Worktree、导出物、诊断物或整个 Provider home。
- 原生文件可能包含**完整对话、工具调用与工具输出**，也可能包含提示词、源码、路径或 Provider 自己写入的其他敏感正文。备份 ZIP **不加密**，应按敏感明文文件存储和传输。
- AgentPort 不会为备份主动读取 macOS Keychain / Linux Secret Service 的凭据原值；SQLite 中的 Secret 引用元数据会随数据库快照保留。若 Secret 已被 Agent 或工具输出到原生对话中，它仍可能随原生 Session 正文进入备份。
- 每个 v2 Manifest 记录 `nativeCoverage`。`missing` 或 `ambiguous` 非零表示正文覆盖不完整；`unsupported`（例如 Generic Shell）表示该 Provider 没有可归档的原生 Session。v1 旧版备份没有原生正文合同。
- 恢复会将原生 Session 安装到**恢复时当前配置的 Provider home**。目标文件不存在或字节完全相同时才允许继续；同路径不同内容会使恢复以冲突失败，绝不覆盖已有 Provider 文件。

## 已知限制

本文件只给出安全模型与默认行为。当前版本已确认的限制（平台支持边界、各 Agent 的 Hook 与恢复精度现状、Linux 桌面差异等）见 `docs/known-limitations.md`。发现安全问题时，请附上诊断中心导出的脱敏诊断摘要进行反馈。
