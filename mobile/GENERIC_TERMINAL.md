# 通用 SSH / Mosh 持久终端

## 两种用途

- **AgentPort 管理**：访问电脑端 AgentPort Project、Agent Session 等能力，需要电脑安装 AgentPort 组件；GUI 无需常开。
- **通用终端**：访问 SSH 账号的 Shell，不调用 AgentPort Bridge，也不要求远端安装 AgentPort。可以与 AgentPort 管理共享同一 SSH 主机配置和凭据。

Relay 扫码配对只授权 AgentPort 管理，不产生普通 SSH 登录权限。通用终端只对 SSH 主机开放。

## 远端前提

首期面向 macOS 和常见 Linux。需要自行启用 SSH 服务、准备登录账号及密码或私钥，并安装 **tmux**。使用 Mosh 还需 **mosh-server**。

示例安装命令（由用户在远端自行执行，App 不代为安装、不自动提权）：

```sh
# macOS，已有 Homebrew 时
brew install tmux mosh
# Ubuntu / Debian
sudo apt install tmux mosh
# Fedora
sudo dnf install tmux mosh
# Arch Linux
sudo pacman -S tmux mosh
```

程序必须在非交互 SSH Shell 的 PATH 中可找到。macOS Homebrew 用户尤其应确认 SSH 登录环境中的 `/opt/homebrew/bin` 或 `/usr/local/bin`。不要为了连接关闭服务器指纹校验。

普通 SSH 需要手机能访问目标 SSH 端口；可经用户自备 VPN 或单级 SSH 跳板。Mosh 由 SSH 启动服务，再通过 UDP 直接连接目标；**SSH 跳板不会转发 Mosh UDP**。通常需允许 Mosh 使用的 UDP 端口（默认范围 60000–61000，或配置的范围），并确保 NAT/防火墙和目标地址允许手机直达。不要把启用 SSH 等同于 Mosh 一定可用。

## 使用步骤

1. 打开电脑/主机管理，添加或编辑 SSH 主机，保存密码或导入私钥。需要跳板时，先保存一台可直接 SSH 登录的跳板主机，再在目标的“单级跳板机”中选择它；不能选择 Relay 或目标自身，多级跳板由原生明确拒绝。
2. Mosh UDP 范围可以在同一配置中填写起止端口；两项都留空时使用服务端默认范围。此配置不使 UDP 经过 SSH 跳板。
3. 在主机行点击“通用终端”，无需先点击 AgentPort 的连接按钮。选择 SSH 或 Mosh，为新终端命名后点击“创建 tmux 终端”；首次 SSH 连接需核对并确认指纹。
4. 已保存终端点击“连接”即可恢复。Mosh 不通时可显式点击“改用 SSH 连接同一终端”。关闭只断开；“结束”需二次确认，会停止远端任务。

## 会话与恢复语义

每次显式新建终端，App 创建一个专用、唯一命名的 tmux 会话。显示名称不作为 Shell 命令执行。记录保存在手机的 App 数据中，不包含密码、私钥或 Mosh 会话密钥。

- 同一主机可以新建多个相互独立的终端。
- 关闭终端标签、返回列表或断开连接只 detach，不结束其中的远端工作。
- App 重启后可从记录中选择终端，重新连接仍存在的 tmux 会话。
- SSH 断线后没有原 SSH channel 可恢复，必须建立新连接并 attach；App 不自动重放命令。
- Mosh 在会话仍有效、系统允许运行且网络可达时可恢复；不承诺后台永久在线。
- Mosh 缺失或不可达时，可由用户明确选择 SSH，接回同一个 tmux 会话。
- tmux 缺失时阻止进入，提供安装指引，不静默进入临时 Shell。
- 远端会话已经结束/被删除时提示会话不存在，**不会静默重建**。
- “结束会话”是独立的确认操作，会终止该 tmux 会话内的程序；只作用于 App 记录的专用会话。

远端重启、用户执行 `exit`、tmux 服务终止或管理员结束进程均可能让任务消失；tmux 不是磁盘级任务恢复。清除 App 数据或换手机也不会自动迁移终端记录。

## 安全与边界

沿用主机指纹信任和本机凭据存储。主机身份或目标账号变化后，旧记录不能用来操作另一目标。通用终端是完整 SSH 账号权限，不是 AgentPort 限权管理入口。

首期不提供通用文件管理、新中继、多级跳板、Windows 原生终端或全部已有 tmux 会话管理。通用终端不会显示仅 AgentPort 才有的项目管理、Agent 状态、审批或推送能力。

## 验证边界

自动化、浏览器渲染、平台编译、模拟器运行和真机业务验证分别记录在 `docs/tasks/2026-10-13-mobile-generic-persistent-terminal-task.md`。主机上的单元测试不证明 iOS/Android 原生 Mosh UDP 已通过；模拟器也不能替代蜂窝切网、系统后台冻结和两端真机恢复验收。
