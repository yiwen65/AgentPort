# AgentPort 国际化术语表

本表是 GUI、应用提示、错误消息、系统通知和无障碍文本的中英文用词基线。翻译应先判断控件作用和用户下一步，再选择对应表达；不得把中文原文当作翻译键。

## 保留的产品与技术术语

以下名称在中英文界面中保持原样：`AgentPort`、`Agent`、`Session`、`Host`、`Worktree`、`checkout`、`Secret`、`CLI`、`PTY`、`Hook`、`RPC`。路径、项目名、Session 名、分支名、用户自定义预设名、ID、PID、OID、socket、命令参数、版本号、环境变量、PTY/TUI 输出、日志和 Git/CLI 原始输出也不得翻译或改写。

## 核心术语

| 中文语境 | 推荐英文 | 使用说明 | 禁用或易混表达 |
| --- | --- | --- | --- |
| 恢复 Session / 继续 Agent 对话 | Resume | 恢复交互上下文或继续最近一次 Session | 不用 Restore |
| 恢复备份、归档或 stash | Restore | 把保存的数据恢复到可用状态 | 不用 Resume |
| 恢复时间线 | Recovery Timeline | 产品功能名，标题式大小写 | 不用 Resume Timeline |
| 移除项目 | Remove project | 只移除 AgentPort 记录，不删除目录 | 不用 Delete project |
| 删除 Worktree | Delete Worktree | 删除 Worktree 目录与记录的危险操作 | 不用 Remove Worktree |
| 永久删除归档 | Permanently delete archive | 不可撤销地删除归档数据 | 不省略 Permanently |
| Agent 正在处理 | Working | Agent 状态，表示正在思考或执行任务 | 不用 Running |
| Session / 进程仍存活 | Running | 生命周期状态，表示运行实例存在 | 不用 Working |
| 中断 | Interrupt | 向仍连接的 Session 发送中断（例如 Ctrl-C） | 不用 Disconnect |
| 已断开连接 | Disconnected | Renderer 与 Host 的连接状态 | 不用 Interrupted |
| 项目根目录 | Project root | 用户项目的根路径 | 不用 Home directory |
| 原生审批 | Native approvals | 由 Agent CLI 自身提供的审批流程 | 不用 Original approvals |
| 绕过权限检查 | Bypass permission checks | 明确表示跳过权限检查的高风险模式 | 不用 Ignore permissions |
| 最近 Session 恢复 | Resume most recent Session | 无原生 Session ID 时的降级能力 | 不暗示精确恢复 |
| 精确恢复 | Exact resume | 使用已验证的原生 Session ID 恢复 | 不用 Full restore |

## 文案风格

- 按钮使用简短动作动词，如 `Add`、`Save`、`Resume`、`Interrupt`；危险操作应在按钮本身说明对象，必要时增加 `Permanently`。
- 页面和弹窗标题使用桌面工具常见的标题式表达；字段标签使用简洁名词短语；帮助文本使用完整句子并说明结果或限制。
- 空状态先说明当前事实，再给出可执行的下一步；不得把内部实现状态直接暴露成无解释的枚举值。
- 错误消息先说明失败的用户操作，再附原始技术详情。原始详情用于诊断，不作为翻译键，也不得改写其中的路径、命令或 CLI 输出。
- 系统通知保持短句：标题使用原样的 Session 名，正文使用本地化的状态消息预览；来源、置信度等技术证据只在应用内诊断和时间线中展示。
- 英文操作文案采用 sentence case；产品功能名（如 `Recovery Timeline`）采用固定大小写；省略号统一使用 `…`。
- ARIA 文本描述控件目的，而不是视觉位置。例如使用 `Terminal input`，不使用 `Text area at the bottom`。

## 同词异译规则

同一中文词必须按对象和结果选择英文，而不是全局替换：

- “恢复 Session”是 `Resume Session`；“恢复归档”是 `Restore archive`；“恢复时间线”固定为 `Recovery Timeline`。
- “移除”用于保留磁盘数据的解除关联；“删除”用于真实删除；不可逆删除必须在确认文案中明确。
- “运行中”用于进程或 Session 生命周期；“工作中”用于 Agent 当前活动状态。
- “中断”表示主动发送信号；“断开”表示连接事实；两者不得合并为同一个状态词。

新增语言或文案时，中英文资源必须同时提交，并通过 `npm run i18n:check` 的键集合、插值、复数、空值和遗漏文本检查。
