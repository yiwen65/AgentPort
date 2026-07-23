# AgentPort 用户指南

本文面向 AgentPort 的最终用户，介绍安装完成后如何使用各项功能；安装步骤见 `docs/install.md`，遇到问题见 `docs/troubleshooting.md`。

## AgentPort 是什么

AgentPort 是 macOS/Linux 上的本地 AI CLI 工作台：用一个界面同时运行、隔离、观察并恢复多个编码 Agent（Claude Code、Codex、Kimi Code），不必在多个终端窗口、项目目录和会话恢复命令之间来回切换。

架构上只需要记住一句话：**GUI 只是一个可重连的客户端**。每个 Session 背后是一个独立的 Host 进程、一个独立 PTY、一个独立本地 Socket 和一份独立日志文件。关闭（甚至强杀）GUI 不会终止任何任务；重新打开 GUI 后会重新连接（attach）到正在运行的 Session。

核心使用循环：

```text
添加项目 → 选择 Agent/Worktree → 启动任务 → 离开窗口 → 接收状态 → 回到原会话继续
```

## 平台支持等级

| 平台 | 支持等级 |
|---|---|
| macOS 13+（Universal，Apple silicon 与 Intel） | 正式支持 |
| Ubuntu 22.04 / 24.04 x86_64（`.deb`） | 正式支持 |
| Fedora 当前稳定版、Arch 发布快照 | 社区验证 |
| AppImage | Beta |
| Windows、iOS、Android、SSH 主机、容器、WSL、远程主机 | 明确不支持 |

"社区验证"表示构建与安装流程经过指定快照验证，但滚动更新仍可能带来兼容回归，不等同于正式支持。

## 首次启动：CLI 探测

首次启动时，AgentPort 会依次读取系统 PATH、登录 Shell 的 PATH 和常见安装目录，找到候选可执行文件后执行只读的版本探测（2 秒超时，超时即终止探测子进程），然后请你确认每个 CLI 的绝对路径并保存"能力快照"（版本、可用参数、精确恢复能力、Hook 能力）。

可能遇到的情况：

- **未找到某个 CLI**：显示"未安装"与官方安装链接，可以跳过，不阻塞其他 Agent。
- **GUI 的 PATH 与你的终端不一致**：GUI 应用有时不会继承 `~/.zshrc` 等配置。此时用"选择文件"手动指定 CLI 的绝对路径即可。
- **找到多个同名命令**：列出每个候选的绝对路径、版本和来源，必须由你选择一个，AgentPort 不会静默随机挑选。
- **CLI 升级后能力可能变化**：AgentPort 不假定参数永远不变。版本变化后请重新探测（设置页或诊断中心的"重新检测"），未知版本会优先降级而不是猜测参数。

## 项目与 Session

### 添加项目

"添加项目"选择一个本地代码目录（会被规范化为绝对路径并检查可读可进入）。同一路径重复添加只会聚焦到已有项目。移除项目不会删除磁盘上的目录。

### 新建 Session

新建 Session 时需要选择：

- **Agent**：Claude Code、Codex、Kimi Code，或 Generic Shell（其他任意命令的降级入口）。
- **位置**：项目主目录，或新建/已有 Worktree。
- **预设**：启动参数、权限模式与环境变量的组合；内置"安全默认"预设。
- **参数**：附加给 CLI 的参数（如 `--model sonnet`）。
- **权限模式**：见下文"权限模型"。

启动时 AgentPort 会在后端校验命令、目录和参数；可执行文件已移动或参数冲突时会阻止创建并提示重新检测。

### 停止、中断与恢复

- **中断**：向 Agent 发送 Ctrl-C 等价信号，不结束 Session。
- **停止 Session**：终止整个进程组（包括 Agent 启动的后台任务），保留日志和可恢复记录。停止没有快捷键，只能经菜单/按钮执行，避免误杀。
- **重启并恢复**：Host 崩溃或机器重启后，Session 显示为"已中断，可恢复"。AgentPort 不会伪装任务仍在运行，也不会自动执行恢复命令——由你点击"重启并恢复"触发。对正在工作的 Session 执行此操作会二次确认。

## 支持的 Agent 与恢复精度

| Agent | 本机验证版本 | 精确恢复 | 降级行为 |
|---|---|---|---|
| Claude Code | 2.1.214 | 启动时由 AgentPort 用 `--session-id` 指定原生会话 ID，因此恢复始终精确 | — |
| Codex | 0.144.5 | 成功捕获原生会话 ID 时用 `codex resume <id>` 精确恢复 | 未捕获到 ID 时用 `codex resume --last` 恢复该目录最近会话，并在界面明示恢复精度 |
| Kimi Code | 0.27.0（只认 `kimi` 命令，不支持旧版 kimi-cli） | 成功捕获 ID 时用 `kimi --session <id>` 精确恢复 | 未捕获到 ID 时用 `kimi --continue` 恢复最近会话，并明示恢复精度 |
| Generic Shell | 系统 shell | 不支持恢复 | "重启并恢复"只会重新打开一个新 shell，并明确提示无法恢复 |

恢复精度分为 exact（精确）/ latest（最近会话）/ unavailable（不可恢复）三档，始终展示在 Session 信息中；降级恢复不会被伪装成精确恢复。

状态 Hook 的支持现状（详见"状态与置信度"）：

- Claude Code：通过按调用注入的 `--settings` 文件接入官方 Hook（该版本提供 `--settings` 时）；绝不修改你的全局 `~/.claude/settings.json`。
- Codex 0.144.5：未找到可验证的 Hook 注入机制，降级为 PTY 启发式；绝不修改 `~/.codex/config.toml`。
- Kimi Code 0.27.0：没有会话级 Hook 机制（唯一的全局配置 `~/.kimi-code/config.toml` 不会被 AgentPort 修改），降级为 PTY 启发式。
- Generic Shell：无 Hook，状态来自 PTY 启发式与进程事实。

## 权限模型

三种权限模式，**默认是 native（沿用各 CLI 原生审批）**：

- **native**：不加任何跳过审批的参数，Agent 的每次确认都由该 CLI 自己的界面完成。
- **auto / bypass**：在新建 Session 的高级设置或预设中显式选择。创建和恢复时直接使用所选模式，不再弹出二次风险确认；Session 存续期间标题栏常驻 ⚠ 警示徽标。

AgentPort 绝不会默认添加 `--yolo` 类的跳过审批参数。

## Git Worktree 隔离

并行任务可以放在独立 Worktree 中，避免多个 Agent 互相覆盖文件：

- 目录位于应用数据目录下，不污染主仓库：
  - macOS：`~/Library/Application Support/AgentPort/worktrees/<项目>/<任务名>`
  - Linux：`~/.local/share/agentport/worktrees/<项目>/<任务名>`
- 分支名默认为 `agent/<任务名>`；默认从当前 HEAD 创建，也可以指定 Base Ref，或采用已有分支/已有 Worktree（已存在时只允许"使用现有"，禁止覆盖）。
- Session 标题旁持续显示 clean/dirty 徽标；任务完成但还有未提交修改时会提醒"结果尚未提交"。
- **删除保护**：删除前检查未提交修改和未跟踪文件，dirty 状态默认阻止删除，且不提供强制删除按钮——请先在终端里提交或清理（Worktree 菜单提供"在系统终端中打开"和"复制 git status"）。
- AgentPort 不做自动合并（无 auto-merge/rebase/PR 创建）；合并请在你的主 Checkout 中按正常 Git 流程完成。
- 所有 Git 调用使用系统 `git` 命令，保留你已有的凭据与配置。

## 状态与置信度

每个 Session 的状态都同时标注**来源**和**置信度**，悬停状态图标可以看到判断依据（如"来源：Kimi Hook，14:32:08"）：

| 状态 | 含义 |
|---|---|
| Working | 当前 Turn 正在执行 |
| Needs input | 等待你输入或确认权限 |
| Idle | Turn 完成或输出静默，进程仍在 |
| Exited | 进程已退出（显示退出码） |
| Unknown | Adapter 无法解释当前状态（附原因） |
| Unread | Session 出现单轮完成或请求批准，选择或再次点击后标记已读 |

来源有四种：Hook（官方事件，高置信度）、PTY（输出启发式）、Process（进程级事实）、Adapter（适配器报告）。当 Hook 不可用或未接入时，状态降级为中置信度的 PTY/进程启发式，并显示"状态可能不精确"——启发式结果不会伪装成确定状态。

## 通知

- macOS：GUI 由 AgentPort 自己的 Bundle ID 通过系统原生通知通道发送；headless CLI 诊断命令使用 `osascript` 后备。Linux 通过 freedesktop 通知（`notify-send`）发送。
- 系统通知是"尽力投递"；**应用内未读状态才是可靠通道**。通知权限被拒绝时，应用内未读徽标照常工作，设置页会显示在系统设置中开启通知的指引。

## 恢复时间线

重新打开 GUI 时，"恢复时间线"用摘要展示你离开期间发生的事件：谁完成了、谁在等待、谁异常退出。点击事件直达对应 Session 并定位到事件附近的输出；可一键"全部已读"。

## 日志与导出

- 每个 Session 的原始终端输出按字节流追加落盘（先落盘再展示），默认上限 **200 MiB**（可在 20–2048 MiB 间调整）。到达上限后轮转，只保留最近的窗口，界面会提示"历史日志已轮转"。
- 导出格式：
  - `.log` 原始终端日志（全部或最近 10,000 行；可保留或去除 ANSI 控制序列）；
  - `.md` Markdown（全部或最近 20/50/100 个可见输出块，含 Session、Agent、项目、分支和时间头）；
  - `.zip` 诊断包（标准或脱敏诊断，默认不含环境变量值和凭据）。
- 导出是原子操作：任何一步失败都会删除本次临时文件，**不破坏源日志和元数据**。

## 搜索

- 输入至少 2 个字符开始搜索；范围覆盖项目、Session、分支等元数据和终端文本全文（索引的是去除 ANSI 后的文本）。
- 结果按 Session 分组展示；命中内容的原始输出如果已被轮转，会保留事件元数据并明示"对应输出已轮转"。
- 搜索索引是派生数据，可在设置页删除并重建；重建不修改源日志，重建期间可取消、不阻塞 Session 输入。索引损坏时会自动回退为当前 Session 文本搜索并在后台重建。

## 敏感环境变量（Secret）

- API Key 等敏感值只保存在 **macOS Keychain 或 Linux Secret Service** 中；AgentPort 的 SQLite 只保存引用（变量名、后端、账户键），绝不保存原值。
- 原值只在启动瞬间经环境变量注入目标 Agent 子进程；不出现在进程参数、日志、搜索索引、前端状态和诊断包中。
- 系统安全存储不可用（如未运行 Secret Service 的 Linux 桌面）时，保存 Secret 的功能被禁用，**不会回退到明文文件**；你仍可在启动 AgentPort 前通过 Shell 环境注入变量。
- Agent 输出中一旦出现与 Secret 相同的内容，写盘前会被替换为 `[redacted]` 并在诊断中心计数（不展示原值）。

## 诊断中心

诊断中心提供：

- **Host 列表**：每个 Session 的 Host 进程、Socket、日志大小与存活状态；
- **CLI 能力快照**：各 Agent 探测到的版本与能力；
- **复制诊断摘要**：一键复制文本摘要，方便贴到 Issue；
- **导出诊断 ZIP**：默认脱敏，不含环境变量值与凭据。

## 设置项与默认值

| 设置 | 默认值 | 范围/取值 |
|---|---|---|
| 每 Session 日志上限 | 200 MiB | 20–2048 MiB |
| 通知 | 开启 | 仍受系统权限控制 |
| 界面语言 | 简体中文 | zh-CN / en-US；切换后立即生效并独立自动保存 |
| 主题 | 跟随系统 | system / dark / light；点击后立即生效并保存 |
| 终端字体 | 内置 JetBrains Mono | 配置值 system-monospace；可自定义 |
| 终端字号 | 13 px | 10–28 px |
| 减少动效 | 跟随系统 | system / on / off |
| 屏幕阅读器模式 | 关闭 | — |
| 搜索索引 | 开启 | 可删除并重建 |
| 遥测 | 关闭 | **恒为关闭，无开启选项** |

## 键盘快捷键

| 操作 | macOS | Linux | 备注 |
|---|---|---|---|
| 新建 Session | `⌘N` | `Ctrl+Shift+N` | 在当前项目打开创建面板 |
| 切换到第 1–9 个可见 Session | `⌘1…9` | `Alt+1…9` | 不改变终端输入内容 |
| 重启并恢复 | `⌘⇧R` | `Ctrl+Shift+R` | 对正在工作的 Session 二次确认 |
| 打开命令面板 | `⌘⇧P` | `Ctrl+Shift+P` | 搜索项目、Session 和操作 |
| 搜索当前终端历史 | `⌘F` | `Ctrl+Shift+F` | 不向 PTY 发送字符 |
| 跳到最新输出 | `⌘↓` | `Ctrl+Shift+↓` | 上滚时显示"回到最新" |
| 停止 Session | 无默认快捷键 | 无默认快捷键 | 避免误杀，只经菜单/按钮 |

终端内的按键始终优先交给 PTY：AgentPort 不拦截 `Ctrl+C`、`Ctrl+D`、`Ctrl+Z`、`Esc` 等 Agent TUI 常用键。

## 数据位置

| 内容 | macOS | Linux |
|---|---|---|
| 应用数据（SQLite、日志、搜索索引、导出、诊断） | `~/Library/Application Support/AgentPort` | `~/.local/share/agentport` |
| Worktree | `~/Library/Application Support/AgentPort/worktrees` | `~/.local/share/agentport/worktrees` |
| Socket | 系统临时目录下 `agentport-<uid>/`（权限 0700） | 同左 |

可用环境变量 `AGENTPORT_DATA_DIR` 覆盖应用数据目录，`AGENTPORT_SOCKET_DIR` 覆盖 Socket 目录。

## 附：agentport-cli（headless 命令行）

AgentPort 附带 headless CLI `agentport-cli`，用于 E2E 测试、验收和高级用户脚本化操作；所有命令支持 `--json` 输出。命令一览：

```text
agentport-cli [--json] <command>

  probe [agent] [--path <exe>]           探测 CLI 能力
  project add <path> [--name N]          注册项目（路径重复则聚焦已有项目）
  project list | rename <id> <name> | remove <id>
  preset list [--agent A]
  session new --project P --agent A [--title T] [--preset ID] [--worktree-id W]
             [--permission native|auto|bypass] [--risk-ack] [--cols N --rows N]
  session list [--all] | status <id> | stop <id> | interrupt <id>
  session input <id> [--data TEXT]       发送输入（转义：\n \r \t \x1b；或从 stdin）
  session read <id> [--until SUBSTR] [--timeout SEC] [--tail-bytes N]
  session attach <id>                    交互式透传（Ctrl-] 脱离）
  session rename <id> <title> | archive <id> | restart <id> [--risk-ack]
  worktree create --project P --task T [--base-ref R] [--branch B]
  worktree list --project P | health <id> | remove <id>
  reconcile                              重新核对运行中 Session 与存活 Host
```

另有 `export`（导出 .log/.md/.zip）、`search`（搜索与 `--reindex` 重建索引）、`timeline`、`diag`（诊断中心）、`secret`（敏感变量，`secret add` 的值只从 stdin 读取）、`settings`、`perf` 等子命令组，与 GUI 共享同一份本地数据。
