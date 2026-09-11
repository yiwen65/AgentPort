# Agent 通知自动配置

探测全部 14 种正式 Agent 时，AgentPort 自动准备可验证的通知 hooks、插件或原生事件读取。Generic Shell 不安装 Agent 插件。**CLI 可用与通知就绪是独立状态**：配置失败不阻止基本启动。

## 使用

在「设置 → Agent」查看通知状态、三类事件来源及技术详情；「重试」重新探测并配置，「回滚」需确认。不能热加载的集成在下次启动 Session 时生效，不强制重启现有 Session，也不改变通知渠道和开关。

```sh
agentport-cli probe                  # 探测并自动配置
agentport-cli notification status    # 只读查询
agentport-cli notification rollback omp
```

回滚后启动不会偷偷重装；下一次主动/启动探测会重新配置。已有配置或插件被用户修改时，回滚和升级都拒绝覆盖。Agent 能力或插件源码变化后，探测会对未被修改的受管内容执行安全升级，无需先手动回滚。设置页只读比较已探测能力与内置集成版本，显示「安全更新集成」；按钮保留所选 CLI 路径。

升级在写入前验证全部旧文件，保留首次安装前的精确字节备份，移除退役注册/资产时恢复其原始内容。独立 `upgrade.json` 写前日志保存升级前版本；自检失败回退，中断后下次重试先恢复，检测到外部修改时停止并保留冲突。安装就绪不等于现有会话已加载新版，不强制重启 Session。

## 状态与覆盖

- **ready**：三类事件均有完整且已验证的精确信号。
- **degraded**：只有部分覆盖，或部分事件来自启发式/进程退出。
- **failed**：配置冲突、运行时缺失、设置禁用或安全检查失败。
- **unavailable**：CLI 不存在、尚无集成或已回滚。

当前各实现均有覆盖边界，不承诺所有 Agent 三类事件全部精确。`hook` 表示表中已验证子集，不代表插件自定义问题也能被捕获；`process` 只识别意外退出，不包含 TUI 仍运行时的所有模型/工具错误。

| Agent | 完成 | 待审批/回答 | 失败 |
|---|---|---|---|
| Claude Code | 现有 Hook | 现有 Hook | 意外进程退出 |
| Codex | 现有 Hook | 现有 Hook | 意外进程退出 |
| Qoder | 现有 Hook | 启发式 | 意外进程退出 |
| Kimi | 原生 TurnEnd | 启发式 | 意外进程退出 |
| Pi / easy-pi | 原生记录 | 启发式 | 意外进程退出 |
| Oh My Pi 18.0.11 | 原生记录 | 工具审批扩展；自定义问题仍不完整 | 意外进程退出 |
| OpenCode | 启发式 | permission.asked | session.error（排除取消） |
| Amp | agent.end done | 支持的审批状态；问题覆盖不完整 | agent.end error |
| Cline | afterRun completed | 启发式 | afterRun failed |
| Gemini | 启发式 | ToolPermission | 意外进程退出 |
| Cursor Agent | stop completed | 启发式 | stop error |
| Grok Build | 启发式 | permission_prompt | 当前原生轮次的主 Agent StopFailure |
| Kiro CLI | 启发式 | 启发式 | 意外进程退出 |

不把 PreToolUse 当审批、不把后台任务完成当主轮次完成、不把用户主动停止/取消当执行失败。可信完成事件跨 Hook/原生来源去重；新的轮次或审批解除会重置相应状态。

## 状态仲裁与提醒策略

- Host 内统一仲裁：准确生命周期信号不被普通 PTY 重绘或静默覆盖；当前明确的屏幕阻塞控件可补充等待状态，但不能用普通输出清除准确审批请求。
- 进程退出封闭当前 run，迟到事件不能复活它；Hook SessionEnd 不会吞掉随后真实的非零退出。AfterTool 保持 Working，SubagentStop 不代表根会话完成。
- 当前状态与语义事件继续分开：失败后 TUI 可以 Idle；只有明确 Hook/原生完成证据才产生完成事件，不把 Idle 或静默当成功。
- 桌面系统通知先去重，再延迟 1 秒复核当前 run 与最新状态。已解决的请求和被新工作取代的完成不再弹出；同一 run 已发生的失败不会因恢复工作被抹掉。当前原生窗口聚焦且选中对应 Session 时抑制系统通知。
- 待发送队列最多 64 条；超过 30 秒的历史事件不作为新系统提醒。队列替换、焦点抑制和通知开关均不改历史、未读及恢复游标。系统通知仍是尽力交付，不保证操作系统实际展示。
- 手机继续消费兼容的持久语义事件；本次没有改造 APNs、增加跨设备互斥通知或承诺全局 exactly-once。
- 保持旧报告协议兼容，尚未为全部 provider 增加 turnId/requestId、来源序号或心跳。run 隔离与服务端事件水位不能完全识别同一 run 内异步 Hook 的迟到语义报告；这需要后续逐 SDK 验证，不能把本轮仲裁等同于所有 Agent 的完整生命周期权威。

### 实时屏幕兜底的边界

Host 复用已有进程内 xterm 屏幕，最多每 300ms 取样，输出未变时跳过。不读取用户滚动 viewport，也不再用历史原始输出尾部触发状态。扫描末 64 个屏幕行，保留最后 8 行、最多 8192 字符；未完成转义前缀不解释。

首批仅两个保守通用控件规则：最后非空行的明确确认控件和 Working 控件，证据标签为 `pty:pattern:screen:v1:*`，不记录匹配正文。无匹配不生成完成/失败。审批匹配仍服从 Agent 的权限模式与能力开关。未新增品牌专属规则、OSC 规则、远程更新或 TOML DSL；这些需要真实版本样本后扩展。

屏幕内容仍是中等置信度启发式，不具有 Hook 的身份保证，也不能证明结果成功；复杂嵌套程序、历史查看器恰好展示同样控件、非英语界面等仍可能漏判/误判。不因本次改造宣称十四种 Agent 精确覆盖。

## 文件与安全边界

- 安装清单、精确字节备份及自包含资产位于应用数据目录 `notification-setup/<agent>`；写前日志支持中断后回滚。
- Claude/Codex/Qoder 保留原有会话级集成，不新增全局注册。Pi 家族保持独立目录；Oh My Pi 扩展按会话显式加载。
- OpenCode、Amp、Cline、Grok 使用独立插件/hook 文件；Gemini、Cursor 仅合并严格 JSON 数组，保留现有 hooks 和其他设置。不覆盖 JSONC、未知格式、符号链接或未归属文件。
- 自定义 `XDG_CONFIG_HOME`（Amp/OpenCode）、`GROK_HOME`、`GEMINI_CLI_HOME` 暂不猜测迁移，明确失败并保持默认目录不变。用户已禁用 Gemini hooks 时不会强行启用。
- 外部 JSON Hook 当前需要 PATH 上已有 Node；缺少时明确失败，不擅自下载未经完整性验证的运行时。Agent 主程序、登录、系统通知授权和提权不属于自动安装范围。
- 仅托管 Session 的新 run 可报告事件：使用独立随机 token、私有 0600 上下文及真实 Agent 进程身份；不复用 Host 控制 token。Gemini 的原生 TOKEN 环境脱敏保持开启。
- 事件只包含关联元数据和事件类别，不复制提示词、工具参数、模型错误正文或凭据；token 从终端输出中脱敏。普通终端和继承环境的嵌套 CLI 的主动上报会被身份校验拒绝；屏幕启发式的局限见上文。

## 验证边界

自动化覆盖安装、重复探测、真实 provider 配置生成、冲突/回滚、身份/权限拒绝、事件去重和失败分类。macOS 隔离 HOME 已验证 Oh My Pi 18.0.11、easy-pi 0.84.2、Grok Build 1.0.25 的配置、重复探测、启动、真实 ownerPid 绑定、重连、停止及回滚，另验证 Omp 同 UUID 冷恢复。

这不是已登录模型对话验收。其余 CLI、Linux、原生 hooks 的实机事件触发与用户自定义插件组合仍有验证缺口，界面应据实展示降级而非虚报就绪。

接口依据：[其他 CLI](notification-cli-evidence.md)、[Pi 家族](notification-pi-evidence.md)。初始配置验证见[原任务记录](tasks/2026-09-10-agent-notification-auto-setup-task.md)，仲裁、提醒和升级整改见[整改任务记录](tasks/2026-09-11-notification-arbitration-task.md)。
