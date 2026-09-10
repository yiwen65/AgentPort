# Agent 通知自动配置

探测全部 14 种正式 Agent 时，AgentPort 自动准备可验证的通知 hooks、插件或原生事件读取。Generic Shell 不安装 Agent 插件。**CLI 可用与通知就绪是独立状态**：配置失败不阻止基本启动。

## 使用

在「设置 → Agent」查看通知状态、三类事件来源及技术详情；「重试」重新探测并配置，「回滚」需确认。不能热加载的集成在下次启动 Session 时生效，不强制重启现有 Session，也不改变通知渠道和开关。

```sh
agentport-cli probe                  # 探测并自动配置
agentport-cli notification status    # 只读查询
agentport-cli notification rollback omp
```

回滚后启动不会偷偷重装；下一次主动/启动探测会重新配置。已有配置或插件被用户修改时，回滚拒绝覆盖，保留文件并显示冲突。Agent 能力或插件源码变化后，需先回滚再重新探测；当前不做自动升级迁移。

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

## 文件与安全边界

- 安装清单、精确字节备份及自包含资产位于应用数据目录 `notification-setup/<agent>`；写前日志支持中断后回滚。
- Claude/Codex/Qoder 保留原有会话级集成，不新增全局注册。Pi 家族保持独立目录；Oh My Pi 扩展按会话显式加载。
- OpenCode、Amp、Cline、Grok 使用独立插件/hook 文件；Gemini、Cursor 仅合并严格 JSON 数组，保留现有 hooks 和其他设置。不覆盖 JSONC、未知格式、符号链接或未归属文件。
- 自定义 `XDG_CONFIG_HOME`（Amp/OpenCode）、`GROK_HOME`、`GEMINI_CLI_HOME` 暂不猜测迁移，明确失败并保持默认目录不变。用户已禁用 Gemini hooks 时不会强行启用。
- 外部 JSON Hook 当前需要 PATH 上已有 Node；缺少时明确失败，不擅自下载未经完整性验证的运行时。Agent 主程序、登录、系统通知授权和提权不属于自动安装范围。
- 仅托管 Session 的新 run 可报告事件：使用独立随机 token、私有 0600 上下文及真实 Agent 进程身份；不复用 Host 控制 token。Gemini 的原生 TOKEN 环境脱敏保持开启。
- 事件只包含关联元数据和事件类别，不复制提示词、工具参数、模型错误正文或凭据；token 从终端输出中脱敏。普通终端和继承环境的嵌套 CLI 不应触发 AgentPort 通知。

## 验证边界

自动化覆盖安装、重复探测、真实 provider 配置生成、冲突/回滚、身份/权限拒绝、事件去重和失败分类。macOS 隔离 HOME 已验证 Oh My Pi 18.0.11、easy-pi 0.84.2、Grok Build 1.0.25 的配置、重复探测、启动、真实 ownerPid 绑定、重连、停止及回滚，另验证 Omp 同 UUID 冷恢复。

这不是已登录模型对话验收。其余 CLI、Linux、原生 hooks 的实机事件触发与用户自定义插件组合仍有验证缺口，界面应据实展示降级而非虚报就绪。

接口依据：[其他 CLI](notification-cli-evidence.md)、[Pi 家族](notification-pi-evidence.md)。最终验证状态以[任务记录](tasks/2026-09-10-agent-notification-auto-setup-task.md)为准。
