# 通用 SSH / Mosh 终端

## 两种用途

- **AgentPort 管理**：访问电脑端 AgentPort Project、Agent Session 等能力，需要电脑安装 AgentPort 组件；GUI 无需常开。
- **通用终端**：访问 SSH 账号的 Shell，不调用 AgentPort Bridge，也不要求远端安装 AgentPort。可以与 AgentPort 管理共享同一 SSH 主机配置和凭据。

Relay 扫码配对只授权 AgentPort 管理，不产生普通 SSH 登录权限。通用终端只对 SSH 主机开放。

## 默认普通 Shell，tmux 可选

| 模式 | 远端前提 | 再次打开的含义 |
| --- | --- | --- |
| 普通 SSH Shell（默认） | SSH 服务、可登录账号 | 启动一个新 Shell，不能恢复上次 SSH Shell |
| 普通 Mosh Shell | SSH、mosh-server、手机可直达的 UDP | 原客户端/会话仍存活时可以恢复网络通信；重新建立连接或 App 重启后不保证接回原 Shell |
| tmux 持久终端（可选，SSH/Mosh） | 以上相应传输条件，再加 tmux | attach App 创建且仍存在的同一个 tmux 会话 |

**没有安装 tmux 也能进入默认普通 Shell。**只有显式选择 tmux 模式才检查和要求安装 tmux；App 不自动安装软件或修改远端环境。

首期面向 macOS 和常见 Linux。密码/私钥凭据只保存在手机安全存储；首次 SSH 连接需核对并确认服务器指纹。

## 可选依赖与网络

需要 Mosh 或 tmux 时，由用户在远端自行安装相应组件。例如 macOS 已有 Homebrew 时可执行 `brew install mosh` 或 `brew install tmux`；Ubuntu/Debian 可执行 `sudo apt install mosh` 或 `sudo apt install tmux`；Fedora/Arch 使用各自包管理器。

这些程序需要在非交互 SSH Shell 的 PATH 中可找到。macOS Homebrew 用户尤其应确认 `/opt/homebrew/bin` 或 `/usr/local/bin`。普通 SSH Shell 本身不要求安装以上组件，也不执行 tmux 探测。

普通 SSH 需要手机能访问目标 SSH 端口，可经用户自备 VPN 或单级 SSH 跳板。Mosh 由 SSH 启动服务，再通过 UDP 直接连接目标；**SSH 跳板不会转发 Mosh UDP**。通常需允许默认 UDP 范围 60000–61000 或配置的范围，并确保 NAT/防火墙和目标地址允许手机直达。不要把启用 SSH 等同于 Mosh 一定可用。

## 使用步骤

1. 打开电脑/主机管理，添加或编辑 SSH 主机，保存密码或导入私钥。需要跳板时，先保存一台可直接 SSH 登录的跳板主机，再在目标的“单级跳板机”中选择它；不能选择 Relay 或目标自身，多级跳板由原生明确拒绝。
2. Mosh UDP 范围可在同一配置中填写起止端口；两项都留空时使用服务端默认范围。此配置不使 UDP 经过跳板。
3. 在主机行点击“通用终端”，无需先连接 AgentPort。选择 SSH/Mosh，为终端命名；新建默认为普通 Shell，需要持久会话时主动选择 tmux。
4. 已有普通记录是启动新 Shell 的快捷入口，不是远端存活会话列表。tmux 记录才用于恢复同一持久会话。
5. 普通 Mosh 改用 SSH 会断开当前连接并启动**新 Shell**，界面需要明确确认；tmux 模式则可通过 SSH 接回同一个 tmux 会话。

## 生命周期与数据兼容

### 普通 Shell

- 保存的名称、主机与模式只是本机快捷入口，不包含密码、私钥、Mosh 会话密钥，也不表示远端任务仍在运行。
- 关闭页面或连接可能结束前台任务；不承诺 `nohup`/`disown` 等后台任务也会结束。
- SSH 断线或重新打开后，只能由用户明确启动新 Shell，App 不重放历史命令，也不自动伪装恢复原 Shell。
- Mosh 的网络漫游限于原客户端与服务端会话仍有效、系统允许运行的情况；不承诺永久后台在线或 App 重启恢复。
- 删除普通记录只断开该记录的 App 连接并删除本机快捷入口，不登录远端执行 tmux kill 或任何远端终止脚本；不保证停止远端全部后台工作。

### tmux 持久终端

- 每次显式新建，App 创建唯一、专用的 tmux 会话；显示名称不作为 Shell 命令执行。
- 关闭仅 detach，任务通常继续运行；App 重启后可重新 attach 仍存在的会话。
- 仅在选择 tmux 模式时，缺少 tmux 才阻止进入并给安装指引。
- 会话已消失时明确提示，**不会静默重建**。结束会话需确认，只终止该 App 记录对应的精确 tmux 会话。
- 旧版没有 mode 字段的记录按 tmux 处理，不改变旧终端的恢复与结束语义。新建默认普通 Shell 与旧数据兼容默认值是两回事。

远端重启、用户执行 `exit`、tmux 服务终止或管理员结束进程均可能让任务消失；tmux 不是磁盘级任务恢复。清除 App 数据或换手机也不会自动迁移记录。

## 安全与边界

沿用主机指纹信任、本机凭据和原服务器密钥绑定。主机身份或账号变化后，旧记录不能被用来操作另一目标；普通快捷入口的本机删除不需要访问远端。通用终端是完整 SSH 账号权限，不是 AgentPort 限权管理入口。

不提供通用文件管理、新中继、多级跳板、Windows 原生终端或全部已有 tmux 会话管理。通用终端不会显示 AgentPort 专属项目管理、Agent 状态、审批或推送能力。

## 验证边界

本次可选 tmux 改造与本地 iPhone 构建证据见 `docs/tasks/2026-10-16-mobile-optional-tmux-shell-task.md`；原始功能证据见 `docs/tasks/2026-10-13-mobile-generic-persistent-terminal-task.md`。单元测试、浏览器、原生编译、模拟器启动与真机业务是不同证据，不能互相替代；实际 Mosh UDP、蜂窝切网、后台冻结及当前手机安装版本需分别核验。
