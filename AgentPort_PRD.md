# AgentPort PRD

## AI 速读卡

- 产品一句话：AgentPort 是 macOS/Linux 本地 AI CLI 工作台，用一个界面管理 Claude Code、Codex、Kimi Code 的持久会话与隔离 Worktree。
- 核心循环：添加项目 → 选择 Agent/Worktree → 启动任务 → 离开窗口 → 接收状态 → 回到原会话继续。
- 目标平台：macOS 13+ Universal；Ubuntu 22.04/24.04 x86_64 正式支持；Fedora/Arch 提供社区验证构建与安装文档。
- 硬约束：本地优先、关闭 GUI 不终止任务、默认不绕过 Agent 权限、Session 输入严格隔离、停止时清理完整进程组。
- 推荐默认：Tauri 2 + Rust Session Host + xterm.js + SQLite；每个 Session 一个独立 Host 进程。
- 发挥空间：品牌视觉、主题风格、动效和空状态可以优化，但搜索、可访问性与状态解释的功能结果必须满足验收。
- P0 验收：三种 Agent 均能启动；两个项目和同仓库 Worktree 可并行；退出 GUI 后继续运行；重开后完整重连。
- 交付范围：本次必须实现 P0、P1、P2 并通过统一发布门槛；P3 明确不在本次范围。
- 最容易翻车：GUI 的 PATH 与交互 Shell 不一致、PTY/进程组残留、CLI 版本变化导致恢复或状态适配失效。
- 超预期机会：恢复时间线、状态置信度、启动安全校验、Worktree 清洁度徽标。

## 第一章：产品概述

AgentPort 是一款跨平台本地 AI CLI 工作台，让开发者能够同时运行、隔离、观察并恢复多个编码 Agent，而无需在多个终端窗口、项目目录和会话恢复命令之间来回切换。

### 1.1 差异化对比表

以下竞品信息基于 2026-07-19 可访问的公开文档；涉及架构原因的表述标记为推断。

| 功能 | 竞品 | 本产品 | 实现方式 |
|---|---|---|---|
| 桌面平台 | Unpeel 文档限定原生 macOS Apple silicon | macOS + Linux | 跨平台 GUI，共享 Rust Session Host；Linux P0 明确限定 Ubuntu LTS |
| Kimi Code | Unpeel 当前支持矩阵未列出 Kimi Code | Kimi Code 一等支持 | 独立 Adapter，支持 `kimi`、Session ID 恢复和 Hook 能力探测 |
| 状态可信度 | Unpeel 展示 Busy/Done/Needs you | 每个状态同时标记来源与置信度 | 官方 Hook 为高置信度，PTY/进程状态为基础事实，启发式结果不得伪装成确定状态 |
| 并行同仓库开发 | Unpeel 提供实验性 Worktree | 最小 Worktree 进入 P0 | 自动创建分支/目录；不做自动合并；删除前强制安全检查 |
| 权限默认值 | 部分 Unpeel 内置预设使用跳过权限参数 | 默认沿用 CLI 原生确认 | 自动批准必须按预设显式开启并显示风险标识 |

竞品依据：Unpeel Getting started <https://unpeel.com/docs/getting-started>、Supported agents <https://unpeel.com/docs/agents>、Worktrees <https://unpeel.com/docs/worktrees>。Kimi Code 已验证支持 macOS/Linux、`kimi` 入口和本地会话恢复：官方快速开始 <https://www.kimi.com/help/kimi-code/cli-getting-started>、Session 文档 <https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html>。

### 1.2 三类用户画像

| 角色 | 核心目标 | 对现有工具最大的不满 | 愿意切换的那一个功能 |
|---|---|---|---|
| 独立开发者 | 同时让不同 Agent 处理实现、测试和审查 | 多窗口无法判断谁在工作、谁在等输入 | 关闭 GUI 后任务继续，重开后准确回到原会话 |
| 小型研发团队成员 | 在一个仓库并行处理多个任务且不互相覆盖 | 多 Agent 共用 Checkout 导致文件冲突 | 一键创建安全 Worktree 并绑定 Session |
| Linux/远程工作站用户 | 在 Ubuntu 桌面上获得与 macOS 一致的 Agent 控制台 | 同类桌面产品偏向 macOS，Linux 只能手工拼装终端和 tmux | macOS/Linux 一致的项目、状态和恢复语义 |

### 1.3 可行性边界

| 在范围内（及原因） | 明确排除在外（及原因） |
|---|---|
| 本机 Claude Code、Codex、Kimi Code CLI；这是验证多 Agent 工作台的最小适配面 | 内置模型账号、API Key 代购或代理；账号和费用仍由各 CLI 管理 |
| macOS 13+ Universal 构建；覆盖 Apple silicon 与仍在使用的 Intel Mac | Windows、iOS、Android；会扩大 PTY、打包、通知和生命周期测试矩阵 |
| Ubuntu 22.04/24.04 x86_64 的 `.deb`；为 Linux P0 提供可重复验收基线 | 宣称支持所有 Linux 发行版；WebKitGTK、通知和打包差异尚未逐一验证 |
| Fedora 当前稳定版、Arch 发布快照的社区验证构建与安装文档；覆盖 P2 的 Linux 扩展目标 | 将社区验证等同于正式支持；发行版滚动更新仍可能造成兼容回归 |
| 本地项目目录和 Git Worktree | SSH 主机、容器、WSL、云 Workspace；远程进程生命周期是另一类产品问题 |
| 原始终端历史、Markdown 导出、诊断包 | 结构化推理、工具调用和 Diff 解析；不同 CLI 数据格式变化频繁 |
| 系统通知和应用内状态 | 手机远程控制、云 Relay、账号同步；会引入服务端和加密运维范围 |
| 单用户、本地数据、无遥测 | 团队协作、权限组织、商业 License 门户；不影响核心循环验证 |
| 最小 Worktree 创建、进入、删除保护 | 自动 Merge、Rebase、冲突解决和 PR 创建；错误操作的代码风险过高 |
| 恢复时间线、状态置信度详情、启动安全校验、Worktree 完成提醒 | Agent 之间自动委派或互相输入；需要独立权限与安全模型 |
| macOS Keychain 与 Linux Secret Service 的可选敏感变量存储 | 明文 Secret 文件或 SQLite 回退；系统安全存储不可用时宁可禁用该能力 |
| 项目/Session/终端搜索、主题字体、键盘导航、屏幕阅读器与减少动效 | 内置代码编辑器和 Diff Viewer；会偏离终端工作台定位 |

推荐默认：首个公开版只对 macOS 与 Ubuntu LTS 承诺正式支持；Fedora/Arch 构建必须通过第十一章验收，但产品与文档始终标记为“社区验证”。AppImage 作为 Beta 分发物交付，不替代 `.deb` 的正式支持基线。

### 1.4 约束分层

| 硬约束 | 推荐默认 | 发挥空间 |
|---|---|---|
| GUI 关闭与 Session 停止是两个不同动作 | 每个 Session 使用独立 Host 进程和 Unix Domain Socket | 侧边栏密度、主题、动效和品牌语言 |
| 默认不增加 `--yolo`、跳过审批或沙箱绕过参数 | 官方支持 Claude Code、Codex、Kimi Code；其他命令以 Generic Shell 运行 | Agent 图标、状态颜色和完成提示音 |
| Session 输入、输出、工作目录、环境必须严格隔离 | 工作树目录放在应用数据目录下，不污染主仓库 | 命令面板、拖拽排序、快捷启动细节 |
| 停止 Session 必须终止完整进程组，并留下可恢复记录 | 元数据使用 SQLite，原始输出使用追加日志 | 导出 Markdown 的版式和摘要文案 |
| 删除 Worktree 前检查未提交修改，并默认阻止危险删除 | Ubuntu LTS 使用 `.deb`；Fedora/Arch 使用社区验证流程；AppImage 标记 Beta | 各发行版安装文档的呈现形式 |
| 密钥不得写入应用元数据、日志或诊断包；系统安全存储不可用时不得明文回退 | macOS Keychain、Linux Secret Service；日志默认每 Session 上限 200 MiB | Secret 命名、分组和删除确认文案 |
| Agent Adapter 必须做版本与能力探测，不能假定参数永远不变 | 启动时记录可执行文件绝对路径和版本 | 状态解释、恢复时间线的视觉表达 |
| P0-P2 的搜索、诊断、恢复时间线、启动安全校验、主题和可访问性均为交付项 | 深色主题、系统字体、减少动效跟随系统 | 主题颜色、过渡动效和空状态插画 |

本次交付硬边界：第九章前三个层级全部完成并通过第十、十一章验收后才可发布；第四层功能不得挤占本次实现时间。

## 第二章：整体布局与导航

```text
+----------------------------------------------------------------------------------+
| 顶栏（100% x 48px）  AgentPort | main-api | Claude Code ● Working | 搜索 | 设置   |
+--------------------------+-------------------------------------------------------+
| 项目/会话栏（260px）      | 终端工作区（剩余宽度）                               |
| + 添加项目               | +---------------------------------------------------+ |
|                          | | Claude Code · main-api · feat/login-timeout        | |
| main-api                 | | cwd: …/worktrees/feat-login-timeout               | |
| ├─ ● 修复登录超时        | +---------------------------------------------------+ |
| ├─ ◉ Codex 审查测试      | |                                                   | |
| └─ ◌ Kimi 等待输入       | | 真实 PTY/TUI 输出                                 | |
|                          | |                                                   | |
| docs-site                | | ❯                                                  | |
| └─ ○ 已退出              | +---------------------------------------------------+ |
|                          | | 状态：Needs input（Hook，高置信度）  〈回到最新〉 | |
+--------------------------+-------------------------------------------------------+
| 底栏（100% x 30px）  macOS arm64 | Host 在线 | 日志 18.4 MiB | 分支 clean       |
+----------------------------------------------------------------------------------+
```

层级：

```text
AgentPort
+-- 项目
|   +-- 主 Checkout Session
|   +-- Worktree
|       +-- Claude Code Session
|       +-- Codex Session
|       +-- Kimi Code Session
+-- 全局设置
|   +-- Agent 适配器
|   +-- 通知与日志
|   +-- 外观与快捷键
+-- 诊断中心
    +-- Host 列表
    +-- CLI 能力探测
    +-- 导出诊断包
```

该布局让高频操作集中在左侧“项目—任务”树，右侧保持完整终端，不加入代码编辑器、Diff 面板或聊天包装层。右侧检查信息使用抽屉而不是常驻第三栏，避免压缩 TUI 宽度。

## 第三章：核心模块详细设计

### 第 3.1 节 首次启动与 CLI 探测

#### a) ASCII 图

```text
+--------------------------------------------------------------+
| 设置 AgentPort                                               |
|                                                              |
| ✓ Claude Code   /opt/homebrew/bin/claude   v2.x   〈重新检测〉 |
| ✓ Codex         /usr/local/bin/codex       v0.x   〈重新检测〉 |
| ✓ Kimi Code     ~/.local/bin/kimi          v1.x   〈重新检测〉 |
| ! 自定义 PATH   GUI 未继承 ~/.zshrc              〈选择文件〉 |
|                                                              |
| 权限默认：沿用各 CLI 原生审批                     〈继续〉     |
+--------------------------------------------------------------+
```

#### b) 交互流程

```text
首次启动
  -> 读取系统 PATH + 登录 Shell PATH + 常见安装目录
  -> 找到候选可执行文件
  -> 执行只读版本探测
  -> 用户确认绝对路径
  -> 保存 Adapter 能力快照
  -> 进入项目空状态

失败路径 A：未找到某 CLI
  -> 显示“未安装”与官方安装链接
  -> 允许跳过，不阻塞其他 Agent

失败路径 B：命令存在但版本探测超时/崩溃
  -> 2 秒后终止探测子进程
  -> 标记“不可用”，提供复制诊断信息和手动选路径

失败路径 C：找到多个同名命令
  -> 显示绝对路径、版本和来源 PATH
  -> 用户必须选择一个，禁止静默随机选择
```

#### c) 状态清单

| 名称 | 触发条件 | 视觉标识 | 退出条件 |
|---|---|---|---|
| 未检测 | 尚未执行探测 | 灰色短横线 | 开始探测 |
| 检测中 | 正在运行版本命令 | 行内 Spinner | 成功、超时或失败 |
| 可用 | 路径存在、可执行、版本命令退出码为 0 | 绿色勾选与版本号 | 文件消失或重新探测失败 |
| 冲突 | 存在多个候选路径 | 黄色“选择路径” | 用户确认唯一绝对路径 |
| 不可用 | 未找到、无执行权限或探测失败 | 红色原因文案 | 安装/修复后重新检测 |

#### d) 依赖关系

读取：系统环境、登录 Shell PATH、文件权限、CLI `--version`/`--help`。写入：`AgentAdapterInstall` 能力快照。输出给：Preset、Session 启动和诊断中心。

#### e) 待决问题

1. 此处未解决：Claude Code 与 Codex 各版本可稳定使用的生命周期集成接口；实现时必须用官方文档和真实 CLI 做版本化验证。
2. Kimi Code 当前处于旧 `kimi-cli` 向新 Kimi Code 演进阶段；只认 `kimi` 命令，不依赖旧 Python 包目录，并在能力探测中记录版本与支持参数。

### 第 3.2 节 项目、预设与启动

#### a) ASCII 图

```text
+--------------------------------------------------+
| 新建 Session                                     |
| 项目        main-api (/Users/lin/dev/main-api)   |
| Agent       (●) Claude  ( ) Codex  ( ) Kimi      |
| 位置        (●) 主目录  ( ) 新 Worktree          |
| 预设        安全默认                             |
| 参数        --model sonnet                       |
| 权限        原生审批 ▼                           |
|                                      〈启动〉      |
+--------------------------------------------------+
```

#### b) 交互流程

```text
添加项目 -> 规范化绝对路径 -> 检查可读/可进入 -> 保存项目
选择项目 -> 选择 Agent/预设 -> 后端校验命令与目录 -> 启动 Session

失败路径 A：目录不存在或权限不足
  -> 不保存无效项目
  -> 显示系统错误和“重新选择目录”

失败路径 B：预设包含冲突参数或可执行文件已移动
  -> 启动前阻止
  -> 提供“重新检测 Agent”或“编辑预设”

失败路径 C：用户开启自动批准模式
  -> 按用户明确选择直接启动，不弹出二次风险确认
  -> 仅对本 Session 生效，标题栏持续显示警示徽标
```

#### c) 状态清单

| 名称 | 触发条件 | 视觉标识 | 退出条件 |
|---|---|---|---|
| 项目空状态 | 尚未添加项目 | “添加第一个项目”主 CTA | 项目保存成功 |
| 项目可用 | 目录存在且可访问 | 普通项目行 | 路径失效或移除 |
| 项目失联 | 目录被移动、磁盘卸载或权限变化 | 黄色断链图标 | 重新定位或恢复权限 |
| 启动校验中 | 校验命令、目录和参数 | 启动按钮内 Spinner | 成功或失败 |
| 启动失败 | Host 或 CLI 未创建成功 | 红色错误条和重试 | 重试成功或关闭错误 |

#### d) 依赖关系

读取：Adapter 能力、项目路径、预设、Git 仓库状态。写入：Project、Preset、Session 初始记录。输出给：Session Host 和 Worktree 管理器。

#### e) 待决问题

1. 环境变量默认只保存名称并从启动环境继承；是否提供系统钥匙串/Secret Service 存储敏感值放到 P2。
2. P0 不支持项目嵌套和 Workspace 文件；同一路径重复添加时直接聚焦已有项目。

### 第 3.3 节 持久 Session 与终端

#### a) ASCII 图

```text
+------------------------------------------------------------------+
| Claude Code · 修复登录超时   Host: 42418   PTY: 148x42   ● 在线 |
+------------------------------------------------------------------+
|                                                                  |
|  ▐▛███▜▌  Claude Code                                            |
|  Edit src/auth/session.ts                                        |
|  Running tests…                                                  |
|                                                                  |
|  ❯                                                               |
+------------------------------------------------------------------+
| 〈中断 Ctrl-C〉 〈重启并恢复〉 〈停止 Session〉 输出已落盘：18.4MiB |
+------------------------------------------------------------------+
```

#### b) 交互流程

```text
启动
  -> GUI 请求创建 Session
  -> 独立 Host 创建 PTY/进程组
  -> Host 启动 Agent 并追加原始输出日志
  -> GUI 通过本地 Socket attach
  -> 用户退出 GUI，Host 继续
  -> GUI 重开，读取 Host 清单、回放日志尾部并重新 attach

失败路径 A：GUI 崩溃
  -> Host 不受影响
  -> 下次启动根据 Socket/PID/心跳重新连接

失败路径 B：Host 崩溃或机器重启
  -> Session 标记“已中断，可恢复”
  -> 用户点击“重启并恢复”后用 Adapter 的精确 Session ID；无 ID 时明确提示恢复精度

失败路径 C：Socket 存在但 PID 已失效
  -> 清理陈旧 Socket，不向旧 PID 发送输入
  -> 保留日志和元数据，转入“已中断”
```

#### c) 状态清单

| 名称 | 触发条件 | 视觉标识 | 退出条件 |
|---|---|---|---|
| 创建中 | Host 尚未回报 PTY 就绪 | 终端骨架屏 | Attach 成功或失败 |
| 在线 | Host 心跳正常、PTY 可写 | 绿色 Host 标记 | 失联、退出或停止 |
| 失联重连中 | 连续 2 次心跳失败 | 黄色重连条 | 重新连接或确认 Host 已死 |
| 已中断可恢复 | Host 不存在但 Session 有恢复信息 | 灰色历史终端和“重启并恢复” | 恢复成功或归档 |
| 已退出 | CLI 正常退出 | 退出码与时间 | 重启或归档 |
| 停止中 | 用户确认停止 | 禁用输入、显示进度 | 进程组清理完成或超时告警 |

#### d) 依赖关系

GUI 写入输入和 resize；Host 写入输出日志、退出码、心跳和 Agent Session ID；SQLite 保存索引；Adapter 生成新建/恢复命令。任何输入都必须携带 Session ID，并由对应 Socket 校验。

#### e) 待决问题

1. 推荐每 Session 一个 Host，以换取故障隔离；如果压测显示进程开销超过第十章阈值，可改为监督进程 + 隔离 Worker，但“单 Session 故障不影响其他 Session”不可改变。
2. 机器重启不会伪装成任务仍在运行；只提供“重启并恢复”，不自动执行可能产生副作用的命令。

### 第 3.4 节 Agent 状态与通知

#### a) ASCII 图

```text
+---------------------------------------------------------+
| 全部 Session                                            |
| ● Claude · 修复登录超时     Working     Hook · 高置信度 |
| ◉ Codex  · 审查测试         Needs input Hook · 高置信度 |
| ◌ Kimi   · 更新文档         Idle        PTY  · 中置信度 |
| ○ Shell  · 构建前端         Exited 0    Process · 确定  |
+---------------------------------------------------------+
```

#### b) 交互流程

```text
CLI/Host 事件 -> Adapter 归一化 -> 状态机去抖 -> 写入状态历史 -> 更新侧边栏/通知

失败路径 A：Hook 配置不可用或版本不支持
  -> 降级为 PTY/进程状态
  -> 标记“状态可能不精确”，不得显示高置信度 Needs input

失败路径 B：事件顺序错乱或重复
  -> 按 Session 单调序号去重
  -> 保留最后一个合法状态并写诊断日志

失败路径 C：系统通知权限被拒绝
  -> 应用内未读状态仍工作
  -> 设置页显示开启系统通知的操作说明
```

#### c) 状态清单

| 名称 | 触发条件 | 视觉标识 | 退出条件 |
|---|---|---|---|
| Working | 官方事件确认当前 Turn 执行中 | 彩色 Spinner + 高置信度来源 | 完成、等待输入、中断或退出 |
| Needs input | 官方事件或确定的权限提示 | 高对比感叹号 + 通知 | 用户输入或 Session 退出 |
| Idle | Turn 完成或输出静默且进程仍在 | 空心圆；启发式时显示中置信度 | 新 Turn、退出或失联 |
| Exited | 进程退出 | 灰色圆 + 退出码 | 重启 |
| Unknown | Adapter 无法解释当前状态 | 问号 + 原因 | 获取有效事件或重新探测 |
| Unread | 非当前 Session 收到新输出或状态变化 | 数字/点徽标 | 用户查看该 Session |

#### d) 依赖关系

读取：Host 进程事件、PTY 输出时间、Adapter Hook、系统通知权限。写入：Session 状态、状态来源、置信度、未读时间。输出给：侧边栏、系统通知和诊断导出。

#### e) 待决问题

1. Kimi Code 官方 Hooks 已验证可提供 Session ID、Notification 等事件，但事件集合随版本演进；实现时依据 Hooks 官方文档 <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html> 建立版本化映射。
2. Claude Code/Codex 的 Hook 配置是否能做到仅作用于 AgentPort Session，需要在真实 CLI 上验证；不能静默覆盖用户现有配置。

### 第 3.5 节 Git Worktree 隔离

#### a) ASCII 图

```text
+-----------------------------------------------------------+
| 新 Worktree                                               |
| 仓库       main-api                                       |
| 任务名     fix-login-timeout                              |
| 分支       agent/fix-login-timeout                        |
| 基线       当前 HEAD  a34f9c1                             |
| 目录       …/agentport/worktrees/main-api/fix-login-timeout|
| Agent      Kimi Code                                      |
|                                      〈创建并启动〉         |
+-----------------------------------------------------------+
```

#### b) 交互流程

```text
选择“新 Worktree”
  -> 校验 Git 仓库与任务名
  -> 生成不冲突的分支/目录
  -> 执行 git worktree add
  -> 保存 Worktree 记录
  -> 在该目录启动 Agent

失败路径 A：分支或 Worktree 已存在
  -> 显示现有路径和分支
  -> 允许“使用现有 Worktree”，禁止覆盖

失败路径 B：仓库有锁、磁盘空间不足或 Git 命令失败
  -> 不创建 Session
  -> 回滚仅由本次创建的空目录，保留完整 Git stderr

失败路径 C：删除时存在未提交/未跟踪文件
  -> 默认阻止删除
  -> 提供“打开终端”和“复制 git status”，P0 不提供强制删除按钮
```

#### c) 状态清单

| 名称 | 触发条件 | 视觉标识 | 退出条件 |
|---|---|---|---|
| 创建中 | Git 命令执行中 | 分步进度条 | 成功或失败 |
| Clean | `git status --porcelain` 为空 | 绿色 clean 徽标 | 文件变化 |
| Dirty | 存在修改或未跟踪文件 | 黄色修改数量 | 提交、清理或外部删除 |
| Missing | Worktree 目录丢失 | 红色断链 | 重新定位或移除记录 |
| Locked | Git 报告 Worktree 锁定 | 锁图标 | 用户在外部解除或恢复 |
| Removing | 已通过安全检查并删除 | 禁用启动按钮 | Git prune/删除完成或失败 |

#### d) 依赖关系

读取：项目 Git 根目录、HEAD、分支、`git worktree list --porcelain`、`git status --porcelain`。写入：Worktree 记录和应用数据目录。Session 只读取绑定的 Worktree 绝对路径。

#### e) 待决问题

1. P0 基线固定为创建时的当前 HEAD；选择远程分支或指定 Base Ref 进入 P1。
2. 使用系统 `git` CLI，不嵌入 libgit2，以保留用户现有凭据、过滤器和 Git 行为；所有命令参数必须以参数数组传递，禁止字符串拼接。

### 第 3.6 节 恢复时间线、搜索与诊断

#### a) ASCII 图

```text
+------------------------------------------------------------------+
| 关闭期间发生了 3 件事                               〈全部已读〉 |
| 14:32  Kimi Code  完成“更新部署文档”     Hook · 高置信度        |
| 14:35  Codex      等待权限确认             Hook · 高置信度        |
| 14:38  Claude     Host 异常退出             Process · 确定          |
|------------------------------------------------------------------|
| 搜索：login timeout                                              |
| 会话  修复登录超时 · Claude · main-api                           |
| 输出  auth/session.ts:88  timeoutMs = 5000                       |
| 诊断  14:38 Host socket closed unexpectedly                      |
+------------------------------------------------------------------+
```

#### b) 交互流程

```text
GUI 重开
  -> 读取上次关闭时间
  -> 合并状态事件、Host 退出和未读输出位置
  -> 生成恢复时间线
  -> 用户点击事件
  -> 打开对应 Session，并定位到事件附近输出

搜索正常路径
  -> 输入至少 2 个字符
  -> 并行搜索项目/Session 元数据与已建立索引的终端文本
  -> 按 Session 分组展示

失败路径 A：某段日志已轮转，不再有原始内容
  -> 仍显示事件元数据
  -> 标记“对应输出已轮转”，不返回错误定位

失败路径 B：搜索索引损坏或版本不匹配
  -> 自动暂停索引查询并回退当前 Session 文本搜索
  -> 后台重建索引，源日志不被修改

失败路径 C：诊断 ZIP 脱敏规则失败
  -> 终止导出并删除临时包
  -> 显示失败字段类型，不显示原始敏感值
```

#### c) 状态清单

| 名称 | 触发条件 | 视觉标识 | 退出条件 |
|---|---|---|---|
| 无关闭期事件 | 重开后没有新状态和输出 | “离开期间没有待处理事项” | 新事件产生 |
| 有待处理事件 | 存在完成、等待或异常 | 顶栏数量徽标和三行摘要 | 全部查看或标记已读 |
| 搜索中 | 查询长度达到 2 个字符 | 搜索框 Spinner | 返回、取消或失败 |
| 部分结果 | 部分日志已轮转或索引待重建 | 黄色“结果可能不完整” | 索引恢复或查询清除 |
| 索引重建中 | 版本迁移或校验失败 | 设置页进度和可取消状态 | 重建成功或用户取消 |
| 诊断导出失败 | 脱敏、磁盘或压缩失败 | 红色错误和“复制原因” | 重试或关闭 |

#### d) 依赖关系

读取：状态事件、Host 生命周期、日志偏移、Worktree 状态、Adapter 能力快照。写入：搜索索引、事件已读游标、恢复摘要和诊断导出清单。源日志与 SQLite 元数据是事实源，搜索索引可以随时删除重建。

#### e) 待决问题

1. 推荐只索引去除 ANSI 后的终端文本，不索引 Secret 值和环境变量；如果脱敏不可证明，Secret 注入后的完整命令回显必须禁止进入索引。
2. P2 搜索范围包含项目名、Session 标题、分支和终端文本；模糊语义搜索不在本次范围。

### 第 3.7 节 敏感环境变量与启动安全校验

#### a) ASCII 图

```text
+--------------------------------------------------------------+
| 新建 Session · 高级设置                                     |
| Agent       Kimi Code 1.x                                   |
| 位置        agent/fix-login-timeout · clean                 |
| 权限        自动批准                                        |
| Secret      KIMI_API_KEY · macOS Keychain · 已解锁          |
|                                                              |
| 〈取消〉                                         〈启动〉      |
+--------------------------------------------------------------+
```

#### b) 交互流程

```text
用户新增敏感变量
  -> 选择环境变量名
  -> 写入 macOS Keychain 或 Linux Secret Service
  -> SQLite 仅保存 Secret 引用
  -> 创建 Session 时读取 Secret 到受限内存
  -> 仅注入目标 Agent 子进程环境
  -> 启动后立即清除临时缓冲

失败路径 A：Linux Secret Service 不可用或被锁定
  -> 禁用“保存 Secret”
  -> 允许继续使用用户 Shell 已存在的环境变量
  -> 禁止回退到明文配置文件

失败路径 B：用户取消系统凭据授权
  -> 不启动依赖该 Secret 的 Session
  -> 保留新建 Session 表单并提示重新授权或移除引用

失败路径 C：诊断/日志检测到匹配 Secret 的字节序列
  -> 写盘前替换为固定掩码
  -> 记录脱敏命中类型和计数，不记录原值
```

#### c) 状态清单

| 名称 | 触发条件 | 视觉标识 | 退出条件 |
|---|---|---|---|
| 未配置 | 预设没有 Secret 引用 | 灰色“无敏感变量” | 新增引用 |
| 已保存 | 系统安全存储写入成功 | 绿色 Keychain/Secret Service 标记 | 删除、锁定或失效 |
| 已锁定 | 系统存储存在但当前不可读取 | 黄色锁图标 | 系统解锁或移除引用 |
| 后端不可用 | Linux 无 Secret Service 或 D-Bus 不可达 | 红色“安全存储不可用” | 服务恢复 |
| 启动校验中 | 使用自动批准或 Secret | 启动按钮内加载动画，不显示二次确认弹窗 | 成功或失败 |
| 脱敏告警 | 输出命中 Secret 指纹 | 诊断中心计数，不展示原值 | Session 归档或告警确认 |

#### d) 依赖关系

读取：Preset Secret 引用、系统凭据存储、权限模式、工作目录和 Git 状态。写入：系统安全存储、Secret 引用元数据和脱敏审计计数。Secret 原值只在启动瞬间从 Credential Broker 流向 Host 子进程环境，不经过前端、SQLite、日志和导出。

#### e) 待决问题

1. 推荐 Rust Credential Broker 使用 keyring-core 和平台专用 Store；当前 keyring-rs 已将各平台 Store 拆分为独立 crate，实施前锁定版本并完成 macOS Keychain/Linux Secret Service 实机测试：<https://github.com/open-source-cooperative/keyring-rs>。
2. Headless Linux 或未运行 Secret Service 的桌面环境不提供持久 Secret；用户仍可在启动 AgentPort 前通过 Shell 环境注入。

### 第 3.8 节 跨平台分发、主题与可访问性

#### a) ASCII 图

```text
+--------------------------------------------------------------+
| 外观与可访问性                                               |
| 主题          跟随系统 ▼    当前：深色                       |
| 终端字体      JetBrains Mono  13 px                          |
| 对比度        增强  ✓                                        |
| 减少动效      跟随系统 ✓                                    |
| 屏幕阅读器    终端模式  ✓                                    |
|                                                              |
| 平台支持                                                   |
| macOS 13 Universal  正式   Ubuntu 24.04  正式               |
| Fedora 当前稳定版  社区验证 Arch 发布快照  社区验证         |
| AppImage Beta       已安装依赖检查通过                       |
+--------------------------------------------------------------+
```

#### b) 交互流程

```text
发布流水线
  -> 在目标 OS 原生 Runner 构建
  -> macOS 签名/公证；Ubuntu 生成 deb；Linux 生成 AppImage Beta
  -> 在干净 VM 执行安装、启动、PTY、IME、通知、卸载测试
  -> 记录发行版/桌面环境/架构到 release manifest
  -> 通过后发布对应支持标签

失败路径 A：Fedora/Arch 社区矩阵失败
  -> 不阻塞 macOS/Ubuntu 正式版
  -> 对失败构建标记“不兼容”，禁止发布社区验证徽标

失败路径 B：WebGL 终端渲染失败或驱动黑名单
  -> 自动降级 Canvas Renderer
  -> 保留字体、IME 和屏幕阅读器能力

失败路径 C：自定义字体缺失或字符宽度异常
  -> 回退平台等宽字体
  -> 提供字符宽度自检并允许重置
```

#### c) 状态清单

| 名称 | 触发条件 | 视觉标识 | 退出条件 |
|---|---|---|---|
| 正式支持 | 发布矩阵全部通过 | 绿色“正式” | 当前版本出现阻断回归 |
| 社区验证 | Fedora/Arch 指定快照通过 | 蓝色“社区验证” | 新快照未验证或失败 |
| 未验证 | 未进入当次发布矩阵 | 灰色“未验证” | 完成测试 |
| 渲染降级 | WebGL 初始化失败 | 设置页“Canvas 模式” | 用户重试并通过自检 |
| 减少动效 | 系统或用户启用 | Spinner 保留、位移动画移除 | 关闭设置 |
| 屏幕阅读器模式 | 用户启用或辅助技术被检测 | 终端无障碍树和状态朗读 | 关闭设置 |

#### d) 依赖关系

读取：操作系统、发行版、桌面环境、WebView/Renderer、系统主题、减少动效和辅助技术偏好。写入：本地外观设置、渲染降级原因和发布 manifest。CI 产物与支持标签是发布事实源，不能由运行时猜测替代。

#### e) 待决问题

1. AppImage 对 WebKitGTK 和系统库的封装边界需要在实际构建中确认；若无法满足干净 VM 验收，仍需交付可复现的可行性报告，但不得发布不可用 Artifact。
2. 屏幕阅读器 P2 验收限定项目树、状态、设置和 xterm.js 官方无障碍模式；完整 TUI 内部语义由各 Agent CLI 和终端控制序列决定。

## 第四章：超越竞品的差异化功能

### 第 4.1 节 macOS/Linux 一致的持久会话语义

1. 竞品为何没有这个功能：基于公开信息的推断，Unpeel 采用 Swift/AppKit 和 macOS 原生终端组件，其产品与平台能力深度绑定；将生命周期、GUI、通知和打包移植到 Linux 不是增加一个构建目标即可完成。
2. 本产品如何实现：平台 UI 使用同一 Tauri 前端；关键的 PTY、Host、日志、Adapter、Git 安全逻辑全部在 Rust 核心；平台差异限制在通知、窗口和路径层。
3. 交互流程：

```text
macOS / Ubuntu 启动
        |
        v
同一 Adapter 能力探测
        |
        v
同一 Host/PTY/日志协议
        |
        +-- macOS --> WKWebView + 系统通知
        +-- Linux --> WebKitGTK + freedesktop 通知
        |
        v
相同项目、状态、恢复和导出语义
```

4. 风险与应对：Linux 发行版碎片化可能导致 WebKitGTK 与通知差异；P0 固定 Ubuntu LTS 验收矩阵，其他发行版不做未经验证的承诺。

### 第 4.2 节 Kimi Code 一等适配与能力探测

1. 竞品为何没有这个功能：截至 2026-07-19，Unpeel 公开 Agent 矩阵未列 Kimi Code。结构性原因推断是每增加一个 CLI，都要维护启动、恢复、状态和配置兼容矩阵，而 Kimi Code 正处于快速演进期。
2. 本产品如何实现：Adapter 不只保存启动命令，还记录版本、可用参数、精确恢复能力、Hook 能力和降级策略。Kimi 使用 `kimi --session <id>` 精确恢复；无法捕获 ID 时使用 `--continue` 并标记恢复精度。官方依据：命令参考 <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html>。
3. 交互流程：

```text
检测 kimi -> 读取版本/帮助 -> 生成能力快照
   |
   +-- 支持 --session + Hook --> 精确恢复 + 高置信度状态
   +-- 仅支持 --continue ------> 最近会话恢复 + 明示风险
   +-- 命令不兼容 ------------> 禁止启动并给出升级/重选路径
```

4. 风险与应对：命令参数和 Hook 事件可能变化；每次 CLI 版本变化后重新探测，Adapter 测试夹具覆盖已支持版本，未知版本先降级而不是猜测。

### 第 4.3 节 状态置信度与恢复账本

1. 竞品为何没有这个功能：此处未验证竞品内部是否记录状态证据。多数终端只能看到输出，无法区分“正在思考”和“等待输入”；单一状态图标容易让启发式判断看起来过于确定。
2. 本产品如何实现：每次状态变化保存 `source`、`confidence`、`timestamp` 和 `evidenceType`；恢复时展示最后心跳、退出原因、Agent Session ID 是否存在。
3. 交互流程：

```text
用户看到“Needs input”
  -> 悬停查看“来源：Kimi Hook，14:32:08”
  -> 点击进入 Session
  -> 若来源降级，显示“状态可能不精确”
  -> Host 中断时打开恢复账本，选择“重启并恢复”
```

4. 风险与应对：过多技术信息会干扰普通用户；默认只显示状态，来源和恢复证据放在悬停/详情抽屉。

### 第 4.4 节 超预期机会

以下功能不扩大 P0 数据边界，但已纳入本次 P2 交付；它们必须在主链路稳定后实现并进入发布验收：

1. 恢复时间线：重开应用时用三行摘要展示“GUI 关闭期间谁完成、谁等待、谁退出”，点击直达对应输出位置。
2. 启动安全校验：创建和恢复前由后端校验 Agent、目录、权限、参数与 Secret；所选权限模式直接生效，不显示二次风险确认弹窗。
3. Worktree 清洁度徽标：Session 标题旁持续显示 clean/dirty，任务完成时提醒“结果尚未提交”。
4. 状态解释：悬停状态图标时显示“为什么判断为 Working/Needs input”，提升用户对自动化的信任。

## 第五章：数据模型

核心本地状态使用 JSONC 表达如下；实际持久化可映射为 SQLite 表，原始终端字节流不写入数据库。

```jsonc
{
  "version": 1, // 必填；顶层数据模型版本，初始值 1
  "appId": "agentport.local", // 必填；本地应用数据命名空间
  "platform": "macos", // 必填；macos 或 linux
  "deliveryScope": "p0_p2", // 必填；本次正式交付范围，固定值 p0_p2
  "adaptersByType": { // 必填；CLI 运行时能力快照，默认值: 空对象
    "kimi": {
      "executablePath": "/Users/lin/.local/bin/kimi", // 必填；探测并确认的绝对路径
      "versionText": "1.x", // 必填；CLI 原始版本文本，长度 1-200 字符
      "capabilityHash": "sha256:8bb0", // 必填；版本与帮助输出能力摘要
      "exactResume": true, // 必填；是否支持按原生 Session ID 精确恢复
      "hookStatus": "supported", // 必填；supported、degraded 或 unavailable
      "probedAt": "2026-07-19T09:50:00Z" // 必填；最近一次能力探测时间
    }
  },
  "projectsById": { // 必填；以项目 ID 为键的对象，默认值: 空对象
    "prj_01JZ8F": {
      "id": "prj_01JZ8F", // 必填；稳定项目 ID
      "name": "main-api", // 必填；用户可编辑显示名，1-80 字符
      "rootPath": "/Users/lin/dev/main-api", // 必填；规范化绝对路径
      "gitRootPath": "/Users/lin/dev/main-api", // 可空；检测到的 Git 根目录
      "createdAt": "2026-07-19T10:00:00Z" // 必填；ISO 8601 时间
    }
  },
  "presetsById": { // 必填；以预设 ID 为键的对象，默认值: 安全内置预设
    "pre_kimi_safe": {
      "id": "pre_kimi_safe", // 必填；稳定预设 ID
      "agentType": "kimi", // 必填；claude、codex、kimi 或 shell
      "name": "Kimi 安全默认", // 必填；用户可见名称
      "executablePath": "/Users/lin/.local/bin/kimi", // 必填；已确认绝对路径
      "args": [], // 必填；参数数组，默认值: []
      "permissionMode": "native", // 必填；native、auto 或 bypass，默认值: native
      "envNames": [], // 必填；允许继承的普通环境变量名数组，默认值: 空数组
      "secretRefIds": [] // 必填；系统安全存储引用 ID 数组，默认值: 空数组
    }
  },
  "secretRefsById": { // 必填；Secret 元数据，不包含 Secret 原值，默认值: 空对象
    "sec_kimi_api": {
      "id": "sec_kimi_api", // 必填；Secret 引用 ID
      "envName": "KIMI_API_KEY", // 必填；注入子进程的环境变量名
      "backend": "macos_keychain", // 必填；macos_keychain 或 linux_secret_service
      "service": "agentport", // 必填；系统安全存储服务命名空间
      "account": "pre_kimi_safe:KIMI_API_KEY", // 必填；不含原值的唯一账户键
      "updatedAt": "2026-07-19T09:55:00Z" // 必填；最近写入时间
    }
  },
  "sessionsById": { // 必填；以 Session ID 为键的索引，默认值: 空对象
    "ses_01JZ9A": {
      "id": "ses_01JZ9A", // 必填；AgentPort Session ID
      "projectId": "prj_01JZ8F", // 必填；所属项目 ID
      "worktreeId": "wt_01JZ91", // 可空；绑定 Worktree ID
      "presetId": "pre_kimi_safe", // 必填；启动所用预设 ID
      "title": "修复登录超时", // 必填；1-120 字符
      "cwd": "/Users/lin/.local/share/agentport/worktrees/main-api/fix-login-timeout", // 必填；启动目录绝对路径
      "hostPid": 42418, // 可空；当前 Host PID，仅用于诊断，不能单独作为身份依据
      "hostSocket": "/tmp/agentport/ses_01JZ9A.sock", // 可空；本地 IPC 地址
      "lifecycle": "running", // 必填；creating、running、interrupted、exited、stopped
      "agentSessionId": "01HZABCXYZ", // 可空；CLI 原生 Session ID，用于精确恢复
      "resumePrecision": "exact", // 必填；exact、latest 或 unavailable
      "logPath": "/Users/lin/Library/Application Support/AgentPort/sessions/ses_01JZ9A/output.log", // 必填；原始输出追加日志
      "createdAt": "2026-07-19T10:05:00Z", // 必填；ISO 8601 时间
      "updatedAt": "2026-07-19T10:32:00Z" // 必填；最后状态更新时间
    }
  },
  "latestStatusBySession": { // 必填；每个 Session 的最新状态证据，完整历史另存表
    "ses_01JZ9A": {
      "sequence": 42, // 必填；Session 内单调递增序号
      "state": "needs_input", // 必填；working、needs_input、idle、exited、unknown
      "source": "kimi_hook", // 必填；hook、pty、process 或 adapter
      "confidence": "high", // 必填；high、medium 或 low
      "occurredAt": "2026-07-19T10:31:58Z" // 必填；事件时间
    }
  },
  "recoverySummaryBySession": { // 必填；GUI 关闭期间的恢复摘要，默认值: 空对象
    "ses_01JZ9A": {
      "lastSeenSequence": 39, // 必填；GUI 关闭前最后已见状态序号
      "latestSequence": 42, // 必填；当前最新状态序号
      "unreadOutputOffset": 184320, // 必填；首个未读输出字节偏移，最小值 0
      "summaryState": "needs_input", // 必填；完成、等待、异常的归一化摘要状态
      "acknowledgedAt": null // 可空；用户标记已读的 ISO 8601 时间
    }
  },
  "worktreesById": { // 必填；以 Worktree ID 为键的对象，默认值: 空对象
    "wt_01JZ91": {
      "id": "wt_01JZ91", // 必填；Worktree ID
      "projectId": "prj_01JZ8F", // 必填；父项目 ID
      "branch": "agent/fix-login-timeout", // 必填；Git 分支名
      "baseCommit": "a34f9c1", // 必填；创建时基线 Commit
      "path": "/Users/lin/.local/share/agentport/worktrees/main-api/fix-login-timeout", // 必填；绝对路径
      "health": "clean", // 必填；clean、dirty、missing 或 locked
      "createdAt": "2026-07-19T10:04:00Z" // 必填；ISO 8601 时间
    }
  },
  "settings": { // 必填；单用户全局设置
    "logLimitMiB": 200, // 必填；每 Session 日志上限，默认值: 200，范围 20-2048
    "notificationsEnabled": true, // 必填；默认值: true，仍受系统权限控制
    "retentionDays": 30, // 必填；已归档 Session 保留天数，默认值: 30，范围 1-3650
    "theme": "system", // 必填；system、dark 或 light，默认值: system
    "terminalFontFamily": "system-monospace", // 必填；默认映射到内置 JetBrains Mono
    "terminalFontSize": 13, // 必填；默认值: 13，范围 10-28 px
    "reducedMotion": "system", // 必填；system、on 或 off，默认值: system
    "screenReaderMode": false, // 必填；默认值: false
    "searchIndexEnabled": true, // 必填；默认值: true，可删除并重建
    "telemetryEnabled": false // 必填；硬约束，默认值和唯一允许值均为 false
  }
}
```

设计决策：SQLite 只保存可查询元数据和有限状态事件，终端输出保持追加文件，避免高频字节流放大数据库写入。Host PID 不是 Session 身份，必须同时验证 Socket 握手中的 Session ID 和随机启动令牌。Secret 只保存系统安全存储引用，原值不进入 SQLite、前端状态、日志或导出。搜索索引和恢复摘要都是可重建派生数据。Worktree 与 Session 分离，使一个 Worktree 可以重启或顺序运行多个 Session。

## 第六章：技术架构

```text
+--------------------------------------------------------------------------------+
| 展示层：Tauri 2 + Web UI                                                      |
| 负责项目树、终端容器、状态、设置；不直接拥有 Agent 进程                       |
+------------------------------------+-------------------------------------------+
                                     | typed IPC
+------------------------------------v-------------------------------------------+
| 应用核心：Rust Core                                                           |
| 项目/预设/SQLite、Adapter 探测、Worktree、搜索/恢复、脱敏与 Credential Broker  |
+------------------------+---------------------------+---------------------------+
                         | spawn/attach              | git 参数数组 / OS 凭据 API
+------------------------v------------------+  +-----v-----------------------------+
| 独立 Session Host（每 Session 一个）       |  | 系统 Git CLI                      |
| PTY、进程组、Socket、心跳、日志、退出清理  |  | worktree add/list/status/remove   |
+------------------------+------------------+  +-----------------------------------+
                         | PTY
+------------------------v-------------------------------------------------------+
| Agent Adapter：Claude Code | Codex | Kimi Code | Generic Shell                 |
| 启动/恢复命令、Session ID、Hook 映射、版本能力与降级策略                       |
+--------------------------------------------------------------------------------+
                         |
+------------------------v-------------------------------------------------------+
| 本地数据：SQLite + 输出/诊断日志 + 搜索索引 + Worktree + Keychain/Secret Service|
+--------------------------------------------------------------------------------+
```

| 库名 | 用途 | 为何优于替代方案 | 大致包体积 |
|---|---|---|---|
| Tauri 2 | macOS/Linux 桌面壳、IPC、打包 | 单代码库覆盖目标平台，系统 WebView；官方支持跨平台桌面构建 | 未知，以 CI 的 `.app`/`.deb` 产物测量 |
| React + TypeScript | 状态驱动 UI 与设置表单 | 团队和 AI 工具生态成熟；可替换为现有前端栈 | 未知 |
| xterm.js | 终端渲染、输入、IME、CJK、搜索 | 被多种成熟开发工具使用，专注终端前端；官方说明支持 CJK、IME、可选 GPU 渲染 | 未知 |
| portable-pty | macOS/Linux PTY 创建 | Rust 层统一接口，避免 Node 子进程成为 Session 生命周期所有者 | 未知 |
| Tokio | Socket、心跳和并发 I/O | Rust 生态成熟；适合多个独立 I/O 通道 | 未知 |
| SQLite + sqlx | 项目、Session、状态索引 | 单用户本地应用无需数据库服务，事务和迁移可审计 | 未知 |
| serde | IPC 与持久化数据序列化 | Rust 类型可与协议版本绑定，减少手写解析 | 未知 |
| tracing | 结构化诊断日志 | 可按 Session/Host 关联，不依赖云端遥测 | 未知 |
| keyring-core + 平台 Store | macOS Keychain 与 Linux Secret Service | 只链接目标平台需要的安全存储后端；避免自建加密文件和主密钥恢复流程 | 未知 |
| SQLite FTS5 或 Tantivy | 本地终端文本索引 | FTS5 依赖更少；若中文/大日志压测不达标再替换 Tantivy | 未知 |

技术依据：Tauri 官方声明可由单代码库构建 Linux 与 macOS 应用，并列出了 Ubuntu/WebKitGTK 与 macOS 的前置条件：Tauri 官方站 <https://tauri.app/>、前置要求 <https://v2.tauri.app/start/prerequisites/>。xterm.js 官方定位为可连接 PTY 的终端前端，并支持 CJK、Emoji、IME 和可选 WebGL：<https://github.com/xtermjs/xterm.js/>。

最大架构风险仍是“GUI、Host、Agent 三层生命周期错位”：GUI 认为 Session 已停止但子进程仍在运行，或重连到陈旧 Socket 后把输入发给错误进程。应对方式是每次启动生成随机 Host Token，Socket 握手校验 Session ID + Token；停止时先发送优雅中断，超时后终止整个进程组，再验证不存在后代进程；所有状态转换写入恢复账本。第二风险是 Linux Secret Service 和 WebKitGTK 的桌面环境差异：凭据后端不可用时禁用持久 Secret，渲染失败时降级 Canvas，不能改用明文 Secret 或跳过发行矩阵。

可替换技术原则：推荐 Tauri 2 + Rust Host + xterm.js。如果现有项目已经使用 Electron，可保留 Electron UI；如果已有可靠的 Rust GUI，也可替换 Tauri。搜索默认 SQLite FTS5，不达标可替换 Tantivy；凭据层可替换具体 crate，但必须落到 macOS Keychain/Linux Secret Service。不可改变的是：GUI 不拥有 Session 生命周期、PTY Host 可独立存活、每个输入必须绑定唯一 Session、原始输出先落盘再展示、Secret 不明文持久化、生命周期逻辑在 macOS/Linux 共享。

发布架构：macOS 构建必须在 macOS Runner 完成 Universal 合并、签名和公证；Ubuntu `.deb` 在 Ubuntu LTS Runner 构建并进入正式回归；AppImage Beta、Fedora 当前稳定版和 Arch 发布快照分别在干净 VM 验证。每个 Release 必须生成 `release-manifest.json`，记录 OS、发行版快照、架构、WebKitGTK、Agent CLI 版本和验收结果。

## 第七章：交互细节

### 7.1 键盘快捷键

`Mod` 表示 macOS 的 `⌘`；Linux 的应用级快捷键使用 `Ctrl+Shift` 前缀，避免与终端内 `Ctrl+C/D/Z` 冲突。

| 分类 | 操作 | macOS | Linux | 备注 |
|---|---|---|---|---|
| Session | 新建 Session | `⌘N` | `Ctrl+Shift+N` | 在当前项目打开创建面板 |
| Session | 切换到第 1-9 个可见 Session | `⌘1…9` | `Alt+1…9` | 不改变终端输入内容 |
| Session | 重启并恢复 | `⌘⇧R` | `Ctrl+Shift+R` | 必须二次确认正在工作的 Session |
| 导航 | 打开命令面板 | `⌘⇧P` | `Ctrl+Shift+P` | 搜索项目、Session 和操作 |
| 终端 | 搜索当前终端历史 | `⌘F` | `Ctrl+Shift+F` | 不向 PTY 发送字符 |
| 终端 | 跳到最新输出 | `⌘↓` | `Ctrl+Shift+Down` | 用户上滚时显示“回到最新” |
| 安全 | 停止 Session | 无默认快捷键 | 无默认快捷键 | 避免误杀，只通过菜单/按钮执行 |

终端内快捷键始终优先交给 PTY；应用不得拦截 `Ctrl+C`、`Ctrl+D`、`Ctrl+Z`、`Esc` 等 Agent TUI 常用键。

### 7.2 右键菜单与上下文菜单

项目菜单：

```text
main-api
├─ 新建 Session…
├─ 新建 Worktree…
├─ 在系统文件管理器中显示
├─ 重新检测 Git 状态
├─ 重命名项目
└─ 从 AgentPort 移除（不删除目录）
```

Session 菜单：

```text
修复登录超时
├─ 打开
├─ 重命名
├─ 复制 Session ID
├─ 导出
│  ├─ Markdown
│  └─ 原始终端日志
├─ 重启并恢复…
├─ 停止 Session…
└─ 归档
```

Worktree 菜单：

```text
agent/fix-login-timeout · dirty
├─ 新建 Session…
├─ 复制路径
├─ 在系统终端中打开
├─ 复制 git status
└─ 删除 Worktree…（dirty 时禁用）
```

### 7.3 空状态

| 视图 | 空状态文案 | CTA |
|---|---|---|
| 首次启动 | “连接你已经安装的 Claude Code、Codex 或 Kimi Code。” | “检测 Agent” |
| 项目列表 | “添加一个代码目录，开始第一个持久 Session。” | “添加项目” |
| 项目无 Session | “main-api 还没有运行中的任务。” | “新建 Session” |
| Worktree 列表 | “并行任务可以使用独立分支，避免互相覆盖。” | “新建 Worktree” |
| 历史/归档 | “完成的 Session 会出现在这里。” | “返回项目” |
| 恢复时间线 | “离开期间没有新的完成、等待或异常事件。” | “查看全部 Session” |
| Secret 设置 | “尚未保存敏感环境变量；也可以继续使用 Shell 环境。” | “保存到系统安全存储” |
| 搜索 | “没有匹配的项目、Session、分支或终端文本。” | “清除筛选” |

### 7.4 错误状态

| 触发条件 | 用户可见的提示信息 | 恢复操作 |
|---|---|---|
| CLI 不存在或已移动 | “找不到 Kimi Code：原路径已失效。” | 重新检测或手动选择 `kimi` |
| PTY/Host 启动失败 | “Session 未启动；没有后台进程被保留。” | 查看 stderr、重试、导出诊断 |
| Host 心跳丢失 | “连接已中断，正在确认 Agent 是否仍在运行。” | 自动重连；确认死亡后允许恢复 |
| Worktree Dirty 删除 | “该 Worktree 有未提交或未跟踪文件，已阻止删除。” | 打开终端、提交/清理后重试 |
| 日志达到上限 | “历史日志已轮转；最近 200 MiB 保留。” | 修改上限或导出/归档旧日志 |
| Secret Service/Keychain 不可用 | “系统安全存储不可用，AgentPort 不会改用明文保存。” | 解锁系统存储、使用 Shell 环境或移除引用 |
| 搜索索引损坏 | “搜索索引需要重建，Session 和日志未受影响。” | 后台重建或暂用当前终端搜索 |

### 7.5 加载状态

| 操作 | 指示器 | 不显示阈值 | 超时/降级处理 |
|---|---|---:|---|
| CLI 探测 | 行内 Spinner | < 150 ms | 2 秒标记超时并终止探测进程 |
| Session 创建 | 终端骨架 + 阶段文案 | < 150 ms | 10 秒显示诊断入口，30 秒判定失败 |
| Session 重连 | 顶部黄色重连条 | < 100 ms | 2 秒后进入失联确认 |
| Worktree 创建 | 3 步进度：校验/创建/启动 | < 200 ms | 60 秒允许取消；不终止未知 Git 子进程前先确认 |
| 导出 | 行内进度和文件大小 | < 200 ms | 磁盘不足时停止并删除本次不完整临时文件 |
| 全局搜索 | 搜索框内 Spinner | < 120 ms | 2 秒显示部分结果；索引异常时提示重建 |
| 搜索索引重建 | 设置页确定进度条 | < 300 ms | 可取消并保留旧索引；不得锁住 Session 输入 |
| Secret 读取 | 启动按钮内加载动画 | < 100 ms | 3 秒超时并阻止依赖该 Secret 的启动 |

## 第八章：导出与输出系统

### 8.1 支持的输出格式

| 格式 | 使用场景 | 质量选项 | 备注 |
|---|---|---|---|
| `.log` | 完整保留终端原始输出，故障复现 | 全部；最近 10,000 行 | P0；可选择保留或去除 ANSI 控制序列 |
| `.md` | 粘贴到 Issue、文档或另一 Agent | 全部；最近 20/50/100 个可见输出块 | P0；包含 Session、Agent、项目、分支和时间头 |
| `.zip` | 提交 Bug 或迁移诊断 | 标准；脱敏诊断 | P1；默认不含环境变量值和模型凭据 |

Kimi Code 自身支持 Session ZIP 和 Markdown 导出，但 AgentPort 的 P0 导出以自身 PTY 日志为事实源，不解析或依赖 Kimi 内部文件格式。Kimi 官方导出能力仅作为后续增强参考：<https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html>。

### 8.2 输出文件结构

```text
agentport-export-2026-07-19/
├── manifest.json
├── sessions/
│   ├── ses_01JZ9A-fix-login-timeout.md
│   ├── ses_01JZ9A-terminal.log
│   └── ses_01JZ9A-status-events.json
├── worktrees/
│   └── main-api-fix-login-timeout-git-status.txt
└── diagnostics/
    ├── app-version.txt
    ├── platform.txt
    └── adapter-capabilities.json
```

`manifest.json` 必须声明导出版本、生成时间、包含的 Session ID 和脱敏规则；不得包含 Token、API Key 或环境变量值。

### 8.3 批量处理流程

```text
用户选择多个 Session
        |
        v
冻结导出清单与脱敏策略（不可并行）
        |
        +-- 并行读取 Session A 日志 --+
        +-- 并行读取 Session B 日志 --+--> 逐文件脱敏与校验
        +-- 并行读取 Git 状态 --------+
                                           |
                                           v
生成 manifest（不可并行） -> 写临时目录 -> 原子重命名/压缩 -> 显示保存位置
                                           |
                                           +-- 任一失败 --> 删除本次临时目录，保留源数据
```

## 第九章：开发优先级

本次版本的发布门槛覆盖前三个层级：必须按顺序完成并通过验收；第四层仅保留未来方向，不进入当前开发排期。

### P0 - 没有这个，产品根本无法使用。交付标准：功能可用，不需要完美

- macOS 13+ Universal 与 Ubuntu 22.04/24.04 x86_64 `.deb` 的可安装构建。
- Claude Code、Codex、Kimi Code 三个官方 Adapter，以及 Generic Shell 降级入口。
- CLI 路径/版本/能力探测，GUI PATH 不一致时可手动修复。
- 添加项目、创建/切换/重命名/停止/重启 Session。
- 独立 Host + PTY + 原始输出日志；关闭 GUI 后 Session 继续；重开后重新连接。
- 原生权限为默认值；自动批准必须显式设置和警示。
- 进程状态、退出码、Unread；官方事件可用时显示 Working/Needs input 和状态来源。
- 最小 Worktree：从当前 HEAD 创建、进入、显示 clean/dirty、dirty 时阻止删除。
- 原始日志与 Markdown 导出。
- 本地数据、无账号、无遥测、日志轮转、完整进程组清理。

### P1 - 没有这个，用户第一次体验后不会回来。交付标准：功能完整，体验有连续性

- 三个 Agent 的精确 Session ID 捕获与恢复测试矩阵。
- macOS/Linux 系统通知、通知权限诊断和状态历史。
- 项目/Session 搜索、命令面板、终端历史搜索。
- Worktree 采用已有分支、指定 Base Ref、归档后的安全清理。
- 脱敏诊断 ZIP 和一键复制诊断摘要。
- 应用签名、macOS 公证、版本化数据库迁移和崩溃恢复测试。

### P2 - 有了这个，用户会把产品推荐给别人。交付标准：稳定且有辨识度

- 恢复时间线、状态置信度详情、离开期间摘要与事件定位。
- 自动批准/敏感变量 Session 的无弹窗启动安全校验。
- Fedora 当前稳定版与 Arch 发布快照的社区验证构建、安装文档和发布 manifest。
- Linux AppImage Beta 构建与干净 VM 可行性验收；只有通过时才发布 Artifact。
- Linux Secret Service/macOS Keychain 的可选敏感环境变量存储，系统后端不可用时禁用持久化。
- Worktree 清洁度提醒、任务完成后的未提交状态提示。
- 项目/Session/分支/终端全文搜索和可重建索引。
- 主题、字体、WebGL/Canvas 降级、键盘导航、减少动效和屏幕阅读器验收。

### P3 - 有了这个，一部分用户会付费或强烈倡导。交付标准：精致且有完整文档

- Sessions MCP 或受控父子 Agent 委派；必须另立安全 PRD。
- Browser MCP；必须另立浏览器隔离与域名策略 PRD。
- SSH/远程主机 Session、远程控制和多设备同步。
- Windows 支持、团队策略、商业 License 与自动更新渠道。
- 插件化第三方 Agent Adapter SDK。

## 第十章：性能指标

测试基线：macOS 13+ Apple M1/8 GiB 与 Ubuntu 22.04 x86_64/4 核/8 GiB；每项连续执行 30 次，交互指标取 P95。CLI 模型网络响应时间不计入本地应用指标。

| 指标名称 | 目标值 | 测量方法 | 劣化阈值 |
|---|---:|---|---:|
| 冷启动到项目列表可交互 | macOS ≤ 1.5 s；Ubuntu ≤ 2.0 s | 从进程启动时间戳到首个可点击项目事件 | macOS > 3.0 s；Ubuntu > 4.0 s |
| 已运行 Session 重连 | P95 ≤ 300 ms | GUI 启动后发起 attach 到终端可输入 | > 800 ms |
| 本地键盘输入回显 | P95 ≤ 50 ms | keydown 到 xterm.js 对应字符 paint | > 100 ms |
| 状态通知延迟 | Hook 到 UI P95 ≤ 300 ms；系统通知 ≤ 700 ms | Hook 时间戳与 UI/通知时间戳对比 | UI > 800 ms；通知 > 1.5 s |
| 输出吞吐 | 持续 1 MiB/s，连续 60 s，无单次主线程阻塞 > 100 ms | 固定测试程序向 PTY 输出 60 MiB | 丢字节或阻塞 > 250 ms |
| 日志一致性 | 100% 字节顺序一致 | 测试流 SHA-256 与落盘解码前字节流比对 | 任意丢失、重复或重排 |
| 20 个在线 Session 的侧边栏刷新 | P95 ≤ 100 ms | 注入并发状态事件并记录提交到 paint | > 250 ms |
| GUI 空闲内存 | ≤ 250 MiB | 稳定 10 分钟后读取 RSS | > 400 MiB |
| 单 Host 空闲内存 | ≤ 35 MiB | 空 Shell Session 稳定 10 分钟后读取 RSS | > 60 MiB |
| 应用空闲 CPU | ≤ 1% 单核 | 10 个 Idle Session 下采样 5 分钟 | > 3% 单核 |
| Session 停止清理 | 5 s 内无后代进程，100/100 次通过 | 记录进程树，停止后轮询 PID/PGID | 任意残留或 > 10 s |
| Worktree 创建 | 20k 文件测试仓库 P95 ≤ 8 s | 从确认到 `git worktree list` 出现且目录可进入 | > 15 s |
| 日志上限 | 默认 200 MiB/Session，误差 ≤ 5 MiB | 连续写入直到轮转并读取磁盘占用 | > 210 MiB 且未轮转 |
| 崩溃恢复 | 30/30 次 GUI 强杀后 Host 继续且输出 SHA-256 连续 | 强杀 GUI、继续输出、重开并比对日志 | 任意任务终止或日志断裂 |
| 恢复时间线生成 | 100 个关闭期事件 P95 ≤ 300 ms | 写入固定事件后重开 GUI，记录摘要完成时间 | > 800 ms |
| 全局搜索首批结果 | 500 MiB 已索引日志 P95 ≤ 200 ms | 固定关键词查询 30 次，记录前 20 条结果返回 | > 600 ms |
| 搜索索引吞吐 | ≥ 20 MiB/s，索引磁盘占用 ≤ 原文本 35% | 导入 1 GiB 去 ANSI 文本并统计时间/大小 | < 8 MiB/s 或 > 50% |
| Secret 读取与注入 | P95 ≤ 300 ms；泄漏命中 0 次 | Keychain/Secret Service 读取到 Host spawn，扫描前端/SQLite/日志/导出 | > 1 s 或任意明文泄漏 |
| 诊断 ZIP 导出 | 200 MiB 输入 ≤ 15 s | 固定日志和状态集导出 10 次并校验 Manifest | > 30 s 或残留临时包 |
| 可访问性键盘路径 | 12 条关键路径 100% 无鼠标完成 | macOS VoiceOver、Linux Orca + 键盘人工脚本 | 任意关键路径阻断 |
| 文本对比度 | 普通文本 ≥ 4.5:1；大文本 ≥ 3:1 | 对全部主题运行自动对比度扫描 | 任一核心状态低于阈值 |
| 跨平台发布矩阵 | macOS、Ubuntu 正式矩阵 100%；Fedora/Arch 社区矩阵 100% 才标记通过 | 干净 VM 安装/PTY/IME/通知/卸载测试 | 正式矩阵任一失败或错误标记社区支持 |

## 第十一章：开发者交接说明

### a) 实现顺序建议

你应按三个交付波次实现，但全部波次都属于本次发布：

1. 核心可用波次：先构建“Rust Session Host + PTY + 追加日志 + 本地 Socket”的无 UI 垂直切片；再实现最小 Tauri/xterm.js attach 客户端、SQLite 生命周期、三个 Agent Adapter、项目/预设和最小 Worktree。
2. 连续体验波次：完成精确恢复矩阵、系统通知、状态历史、搜索入口、指定 Base Ref、诊断 ZIP、数据库迁移、签名公证和崩溃回归。
3. 可推荐体验波次：完成恢复时间线、启动安全校验、系统凭据存储、全文索引、Worktree 提醒、主题/字体/渲染降级、可访问性以及 Fedora/Arch/AppImage 发布矩阵。

不要先做完整主题或设置页；没有经过强杀和重连验证的终端 UI 不算完成核心能力。也不要在第一波次结束后宣布发布完成，第三波次通过第十章指标才达到本次范围。

### b) 最可能导致返工的三个决策

1. Session 生命周期所有权
   - 决策：由 GUI、单一守护进程还是独立 Host 拥有 PTY。
   - 安全默认：每 Session 独立 Host，GUI 只是可重连客户端。
   - 改变信号：20 个 Idle Host 持续超过 700 MiB，或进程管理在两平台无法稳定通过 100 次停止测试。

2. Agent 状态来源
   - 决策：修改用户全局 Hook 配置，还是只依赖包装器/可选集成。
   - 安全默认：不覆盖现有配置；优先使用 CLI 官方、可合并、可撤销的集成；否则降级并显示置信度。
   - 改变信号：官方 CLI 提供稳定的进程内事件协议或结构化输出，且能覆盖交互 TUI。

3. Linux 支持范围
   - 决策：首版宣称全部 Linux，还是限定 Ubuntu LTS。
   - 安全默认：只对 Ubuntu 22.04/24.04 x86_64 `.deb` 做正式承诺；Fedora/Arch/AppImage 必须实现和验收，但标记社区或 Beta。
   - 改变信号：Fedora/Arch/Wayland CI 与人工回归连续两个版本全部通过，且安装依赖可明确文档化，才可升级支持等级。

### c) 哪里要严格，哪里可以灵活

| PRD 部分 | 类型 | 对你的要求 |
|---|---|---|
| 第一章范围、平台和隐私 | 约束 | 不得擅自加入云端、账号、Windows、移动端或默认权限绕过 |
| 第二章布局 | 建议 | 可以调整宽度和组件层级，但必须保留项目树 + 主终端的高频结构 |
| 第三章生命周期、输入隔离、Worktree、Secret 和发布矩阵 | 约束 | 必须按状态机和失败路径实现并测试 |
| 第四章差异化呈现 | 建议 | 可以优化文案和详情入口，不得伪造状态确定性 |
| 第五章数据语义 | 约束 | ID、生命周期、恢复精度、状态证据和敏感数据边界不得改变 |
| 第六章具体库 | 建议 | 可替换技术栈，但 GUI 不拥有 Agent 进程这一不变量必须保留 |
| 第七章视觉与微交互 | 建议 | 可以提升设计品质；终端快捷键优先级和危险操作确认是约束 |
| 第八章脱敏和导出原子性 | 约束 | 导出失败不得破坏源数据，默认不得泄漏密钥 |
| 第九、十章全部交付层级与验收指标 | 约束 | 必须完成前三层；不得用体验功能替代核心可靠性，不得删除量化测试 |

### d) 已知的未知项

1. 此处未解决：Claude Code、Codex 当前各版本最稳定的 Session ID 和生命周期事件接口；编码前必须核对官方文档并建立真实二进制夹具。
2. Kimi Code 正从旧 CLI 形态迁移到新 Kimi Code；官方 GitHub 已提示项目演进。Adapter 必须以运行时能力探测为事实，不读取未承诺稳定的内部文件结构。
3. 此处未解决：Tauri WebKitGTK 在不同 Wayland 合成器下的 IME、剪贴板和 GPU 渲染一致性；Ubuntu 两个 LTS 版本需实机验证。
4. 此处未解决：AppImage 能否在目标发行版中可靠携带或复用 WebKitGTK 依赖；本次必须完成构建和干净 VM 可行性验收，失败时交付报告并停止发布该 Artifact，Flatpak 仍不在范围。
5. 此处未解决：Claude/Codex/Kimi 的 Hook 配置能否做到完全 Session 级隔离；若不能，P0 使用可撤销的用户授权或降级状态，不得静默修改全局配置。
6. 此处未解决：部分 Linux 桌面没有可用或已解锁的 Secret Service；本次不实现明文/自建加密文件回退，只允许 Shell 环境注入。

### e) 验收剧本

验收剧本 1：在 macOS 13+ Universal、Ubuntu 22.04/24.04 干净 VM 安装正式包，并在 Fedora 当前稳定版、Arch 发布快照验证社区/AppImage 构建；应完成启动、中文 IME、剪贴板、通知和卸载。再仅用键盘及 VoiceOver/Orca 完成添加项目、启动 Session、搜索和停止，并验证深浅主题与减少动效。用 release manifest、CI Artifact、录屏和无障碍检查报告验证。

验收剧本 2：在两个项目分别启动 Claude Code、Codex 和 Kimi Code，向三者发送持续 2 分钟输出的任务，然后强制结束 GUI 进程；应看到三个 Host 和 Agent 仍在运行。重新打开 GUI 后应在 800 ms 内恢复可输入终端，输出无缺失，并收到离开期间摘要。用进程树、Host 日志、状态历史和输出 SHA-256 验证。

验收剧本 3：分别在三个官方 Agent 完成一次 Prompt，记录捕获的原生 Session ID，停止 Host 后点击“重启并恢复”；支持精确恢复的版本必须使用同一 ID，降级版本必须明确显示恢复精度。随后搜索一个只存在于已关闭 Session 的关键词，应在 600 ms 内返回并定位；破坏索引后应自动重建且不修改源日志。用 Session 元数据、启动审计、搜索结果和日志 Hash 验证。

验收剧本 4：在 Git 项目从指定 Base Ref 创建 `agent/fix-login-timeout` Worktree 并启动 Codex，修改一个文件但不提交；Session 完成时应显示“结果尚未提交”，删除必须被阻止。提交或恢复文件后重试，应从 `git worktree list --porcelain` 消失，主 Checkout 文件不变。用通知截图、`git status`、Worktree 列表和文件 Hash 验证。

验收剧本 5：分别将测试 Secret 写入 macOS Keychain 和 Linux Secret Service，从新建 Session 表单直接启动 Kimi Session，过程中不得显示二次风险确认弹窗；Agent 应能读取变量，但前端状态、SQLite、进程参数、日志、搜索索引和脱敏诊断 ZIP 中都不得出现原值。锁定 Secret Service 后启动必须被阻止且不写明文回退。最后停止一个含三个子进程的 Session，5 秒内全部 PID 消失，超过 210 MiB 的日志完成轮转。用系统凭据条目、全目录字节扫描、ZIP 清单、PGID/PID 树和磁盘统计验证。
