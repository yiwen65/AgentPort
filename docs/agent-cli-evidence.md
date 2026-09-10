# 新增 CLI 接口证据与能力边界

核实日期：2026-09-10。本文是接口证据，不是任务状态记录；执行状态以 `docs/tasks/2026-09-10-nine-agent-support-task.md` 为准。

## 核实方法

- 通过 HTTPS GET 读取官方产品文档；没有安装工具、登录、读取凭据、发送模型提示或修改原生配置。
- 本机 `command -v` 在本组七种中仅发现 `/Users/w/.grok/bin/grok`；执行其 `--help` 与 `--version` 成功，版本 `grok 1.0.13 (5e9a58528b76)`。
- `tests/fixtures/cli/extended-*-help-reference.txt` 中六份是明确标注的**官方文档摘录**，不是伪称真实 CLI 输出的 fixture。Grok 一份为真实本机 `--help` 输出（仅去除空行尾随空格），配套 `extended-grok_build-version.txt`。
- 运行时仍重新探测实际版本的 help，能力不能由这些参考 fixture 或安装路径单独决定。未知/缺失参数不传入真实 CLI。
- 所有七种采用 PTY；状态依赖现有 PTY 启发式，没有宣称结构化 hook、原生历史导入或原生备份已支持。

## 接口与权限矩阵

| Agent / 命令 | 官方来源 | 新建与恢复参数 | AgentPort 权限映射与限制 |
| --- | --- | --- | --- |
| OpenCode / `opencode` | https://opencode.ai/docs/cli/ | 无参数启动 TUI；`--session ID` 精确选择已有会话；`--continue` 最近会话；`--fork` 会另建对话，禁止覆盖 | Native 不传参数；Auto 为 `--auto`，保留明确 deny；没有已验证的完整 Bypass 参数，拒绝该模式 |
| Amp / `amp` | https://ampcode.com/docs/markdown/cli 、 https://ampcode.com/docs/markdown/threads 、 https://ampcode.com/docs/markdown/tools | 无参数为本地交互；`amp threads continue T-…` 继续指定线程，不误用 `--resume`；没有已验证的无 ID 自动恢复参数 | 官方当前明确表示不询问工具审批；仅支持 Native，不杜撰已经变化的旧权限 flag |
| Gemini CLI / `gemini` | https://geminicli.com/docs/cli/cli-reference/ 、 https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/utils/sessionUtils.ts | `--resume UUID` 精确；`--resume latest` 最近；数字索引与 latest 不可当作稳定原生 ID | Auto：`--approval-mode auto_edit`；Bypass：`--approval-mode yolo`；Native 不传参数 |
| Cline CLI / `cline` | https://docs.cline.bot/cli/cli-reference.md 、 https://docs.cline.bot/usage/cli-overview | 当前默认命令交互；有 `--tui` 时显式选择 TUI；`--id SESSION_ID` 仅恢复已有会话，不能当新会话 ID 分配参数 | 官方 `--auto-approve <boolean>` 默认 **true**（ACP 默认 false）；Native 不改变上游默认并显式警示；Auto/Bypass 均为 `--auto-approve true`，没有承诺绕过企业规则 |
| Kiro CLI / `kiro-cli` | https://kiro.dev/docs/reference/cli-commands.md 、 https://kiro.dev/docs/cli/chat/session-management.md 、 https://kiro.dev/docs/cli/v3/permissions.md | 启动 `kiro-cli chat`；`chat --resume-id ID` 精确；`chat --resume` 为布尔最近恢复，不是 ID 参数；退出提示含 `kiro-cli chat --resume-id ID` | Auto/Bypass 使用当前仍支持的 session-scope `--trust-all-tools`；Native 不传参数；不写 permissions.yaml |
| Cursor CLI / `cursor-agent`，新版 `agent` | https://cursor.com/docs/cli/reference/parameters | 默认交互；`--resume chatId` 精确；`--continue` 等于 `--resume=-1`（最近）；禁止将 -1 存成精确 ID | Auto/Bypass：`--force`，仍保留明确 deny；Native 不传参数；不额外加 `--trust`、`--approve-mcps` 或关闭 sandbox |
| Grok Build / `grok` | https://x.ai/cli 、 https://docs.x.ai/build/overview ，本机真实 `--help` | `--session-id UUID` 为**新建**且要求不存在；已存在会话用 `--resume UUID`；`--continue` 为当前目录最近；禁止 `--fork-session`、`--restore-code` 覆盖语义 | Auto：`--permission-mode acceptEdits`；Bypass：`--permission-mode bypassPermissions`；Native 不传参数；deny、hooks、管理限制仍由原生工具执行 |

权限选项只有当前 help 确认对应 flag 时才可使用。Auto/Bypass 是 AgentPort 的跨工具 UI 模式，并不保证各工具权限行为完全相同；只有单一自动审批开关的工具两者可能映射到同一 flag。OpenCode 不存在已证实 Bypass，Amp 没有已证实内置审批模式，明确拒绝而不冒充。

### 上游原生默认不等于人工审批

核实到的官方原文：

- Amp Tools：`By default, Amp does not ask for approval before running tools.`；Permissions 节再次说明：`Amp does not ask for approval before running tools.`，通过 custom plugin 控制。
- Cline Help Menu (Source of Truth)：`prompt ... Default to start in act mode with auto-approve enabled.`；`--auto-approve <boolean> ... (default: true)`。Global Options 明确 ACP 默认 false。

因此沿用 Native 时，AgentPort 不可声称这两种工具一定会弹出批准请求；启动通知必须明确说明。AgentPort 不会把保留上游默认说成自己添加了 bypass，也不会静默写配置使其看似具有统一权限模型。

## 精确恢复的证据门槛

- Grok 在 `session-id` 与 `resume` 均存在时由 AgentPort 生成 UUID、以 `--session-id` 分配新对话并持久化身份，因此新建后具有 exact 恢复路径。
- Kiro 仅从独占一行的明确命令 `kiro-cli chat --resume-id ID` 提取 ID；不从普通 UUID、模型回复中的任意标题或链接猜测身份。
- 其他五种没有在本轮中证实可安全为新交互会话预分配 ID，也没有把猜测的 TUI 文本视作真实身份。已记录并验证格式的 ID 可使用原生精确参数；没有 ID 时 OpenCode/Gemini/Cursor 使用明确 **Latest** 降级，Amp/Cline 明确阻止自动恢复，不新建空会话冒充成功。
- Amp 需要探测 `threads continue --help`，其成功输出的 usage 必须证明 `amp threads continue`。以 `agentport:amp-threads-continue` 内部快照标记保存子命令能力，该标记不是会传入 CLI 的参数。
- Kiro 需要探测 `chat --help`，不能仅凭 root help 推断子命令选项。
- Grok 同名工具和通用 `agent` 命令具有产品混淆风险：Grok help 必须标识 `Grok Build`，Cursor help 必须标识 `Cursor`；不因 PATH 中有可执行文件就将其标为正确产品。
- 最新会话可能属于同工作目录下另一个 AgentPort Session，Latest 通知必须明确提示这一点，不宣称身份一致。

## Grok 本地源码证据的边界

额外读取 `/Users/w/Projects/easy-pi/grok-build`：

- `README.md` 说明官方发行命令为 `grok`，macOS/Linux 支持，并链接 x.ai/cli。
- `crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md` 的 Permission modes 表说明 `acceptEdits`、`bypassPermissions` 的语义。
- `.../01-getting-started.md` 说明会话通常在 `~/.grok/sessions/`，但配置路径可受 `GROK_HOME` 等影响；本适配没有据此猜测、删除或恢复原生文件。
- 本地 git origin 是用户 fork `https://github.com/yiwen65/grok-build.git`，**不是官方仓库身份的独立证明**。产品身份由用户明确要求、官方网页和本机标识为 Grok Build 的 help 交叉支持，不将 fork 名称冒充官方发布来源。

## 验证覆盖与尚未实机验证的项目

`extended.rs` 自动化覆盖七种 reference 解析、启动、不自动加权限、精确/最近/不可用恢复、缺参数、持久化权限优先、Grok UUID、原生默认风险通知、受保护长短参数/附着值/位置子命令、错误 transport/installation、误选同名工具及 Kiro ID 提取。

实际测试结果由协调者执行并写入唯一任务文档，本文不预先宣称测试通过。六种未安装 CLI 尚无真实 PTY/登录态验证；Grok 的 `--help`、`--version` 成功不等于模型调用、完整多轮或恢复实机验收。Linux 平台没有因 macOS 的只读命令成功而被标为实机通过。
