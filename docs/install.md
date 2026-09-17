# AgentPort 安装文档

本文介绍 AgentPort 在各平台上的安装、首次启动与卸载步骤；安装后的日常使用见 `docs/user-guide.md`。

## 支持的平台

| 平台 | 分发物 | 支持等级 |
|---|---|---|
| macOS 13+（Universal） | `.dmg` | 正式支持 |
| Ubuntu 22.04 / 24.04 x86_64 | `.deb` | 正式支持 |
| Fedora 当前稳定版 | tarball | 社区验证 |
| Arch 发布快照 | tarball | 社区验证 |
| Linux 通用 | AppImage | Beta |

此表描述桌面分发支持；Windows、容器与通用远程主机部署不在该范围内。AgentPort Mobile 可通过 SSH 连接已安装的 macOS 桌面端，需单独启用下述 Bridge 入口（不是独立 SSH 服务）。"社区验证"与 Beta 不等同于正式支持：发行版滚动更新可能带来兼容回归。

## macOS（正式支持）

要求 macOS 13 或更高版本，Apple silicon 与 Intel 均可（Universal 构建）。

1. 打开下载的 `.dmg`，把 `AgentPort.app` 拖入"应用程序"。
2. 首次启动：在"应用程序"中打开 AgentPort，进入 CLI 探测向导（确认各 Agent 的路径与版本）。

### Gatekeeper 说明

以下步骤**仅适用于未使用 Developer ID 签名或未公证的构建**（例如本地自行构建的产物）。本地构建脚本会应用 ad-hoc Bundle 签名来校验 App、资源和 Sidecar 的完整性，但它不提供开发者身份信任，也不等同于 Apple 公证：

- 首次打开被拦截时，到"系统设置 → 隐私与安全性"中，对 AgentPort 点击"仍要打开"；
- 或者用命令去除隔离属性：

```bash
xattr -cr /Applications/AgentPort.app
```

经过 Developer ID 签名与公证的构建无需上述操作；本仓库当前构建仅有 ad-hoc 完整性签名，未执行 Developer ID 签名与公证（见 release-manifest.json）。

### Mobile SSH Bridge（macOS，可选、显式安装）

先把完整的发布版 `AgentPort.app` 复制到 `/Applications`（或稳定的自选目录），不要从 DMG、checkout 的 `target/debug` 或临时构建目录运行。App 包内已带 `Contents/MacOS/agentport-remote-bridge`、Host 等 Sidecar。发布 DMG 和 `dist-release/macos/` 同时附带 `install-remote-bridge.py`、`verify-installed-remote-bridge.py` 和本文；挂载 DMG、复制或启动 App **不会**自动安装 SSH 入口。

需要 Python 3。以手机 SSH 登录的同一 macOS 用户执行，不要用 `sudo`：

```bash
# 在下载的安装脚本所在目录运行；默认 App 为 /Applications/AgentPort.app
python3 install-remote-bridge.py
# 自选稳定路径（含空格也支持）
python3 install-remote-bridge.py --app "$HOME/Applications/AgentPort.app"
```

脚本只创建 `~/.local/bin/agentport-remote-bridge`（可用 `--bin-dir` 指定目录）。这是指向已安装 App 的小型 wrapper，不依赖源码 checkout、Python 运行时或开发服务器；同路径替换整个 App 后自动使用新版。相同配置可重复安装；其他已有文件、目录或符号链接一律拒绝覆盖，包括旧的 debug wrapper。**先自行检查旧文件，再手动改名备份**后重试；脚本不提供强制覆盖，不修改 `.zshenv`、SSH 配置、密钥、系统服务或运行中的 App。

手机执行固定命令 `agentport-remote-bridge serve --stdio`，所以该目录必须在 **非交互 SSH shell** 的 PATH 中。macOS 默认 zsh 用户可检查 `${ZDOTDIR:-$HOME}/.zshenv`，若尚无等效配置，手动追加下面一行；保留已有内容，不要覆盖文件或重复追加：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

若已用 `.zshenv` 将同一个 `~/.local/bin` 加入 PATH，无需再改。其他 shell 按其非交互启动规则配置，`.zshrc` / `.zprofile` 通常不足以覆盖 SSH 命令。启动文件不可向 stdout 输出欢迎语，否则会破坏二进制协议。用另一台电脑检查（不要加 `-t`）：

```bash
ssh user@mac 'command -v agentport-remote-bridge'
```

应显示新入口的绝对路径，而不是 checkout/debug 路径。wrapper 每次通过 `/usr/bin/getconf DARWIN_USER_TEMP_DIR` 设置当前用户的 `TMPDIR`，避免 SSH 环境缺失该值而找不到桌面 Host 的 socket；查询失败则终止，不退回 `/tmp`。显式的 `AGENTPORT_DATA_DIR` / `AGENTPORT_SOCKET_DIR` 仍保留，若设置它们，必须与目标桌面实例一致。

在 macOS「系统设置 → 通用 → 共享 → 远程登录」中自行启用 SSH，仅允许需要的用户，按 Mobile 的连接流程配置公钥并核对服务器指纹。安装器不启用 sshd、不监听端口、不配置防火墙或 `authorized_keys`。仅在受信任网络/VPN 使用，SSH 登录权限是安全边界；此 wrapper 的参数检查**不是**受限 SSH 账号或授权策略，也不会限制同一密钥执行其他 SSH 命令。GUI 不必一直打开，Bridge 通过本地 Host 操作会话。

可选本机打包/入口自检（先自行退出该安装路径的 GUI；不要停止 Host 或其他 App 实例）：

```bash
python3 verify-installed-remote-bridge.py --app /Applications/AgentPort.app \
  --bridge "$HOME/.local/bin/agentport-remote-bridge"
```

该检查验证签名、隔离数据目录中的 hello/EOF、无 Bridge socket 和 Host 进程集合不变；不会启动 GUI/Host，也不验证 SSH 身份认证、网络可达性或真实会话 attach。完整验收还需从 Mobile 建立 SSH 连接并选择真实会话。

卸载入口：先检查 `~/.local/bin/agentport-remote-bridge` 确为本安装器创建的 wrapper，再手动删除该文件；仅在不影响其他工具时移除自行添加的 PATH 行。保留旧文件备份以便回滚。更换 App 安装路径时也先手动备份旧 wrapper，再重新运行安装器。

## Ubuntu 22.04 / 24.04（正式支持）

正式发布的 Linux `.deb` 以 Ubuntu 22.04 x86_64 为编译基线，并同时在 Ubuntu 22.04 与 24.04 验证。Ubuntu 24.04 原生构建依赖更新的 glibc，不应用作 Ubuntu 22.04 的通用安装包。

下载 `.deb` 后安装：

```bash
sudo apt install ./AgentPort_<版本>_amd64.deb
```

`apt` 会自动拉取运行依赖（WebKitGTK、GTK 与 Git）。安装完成后桌面环境中可直接启动 `agentport`。包还推荐安装 `libnotify-bin`、`xdg-utils` 与 `xterm`，以提供系统通知、在文件管理器中显示目录和默认终端入口；使用 `--no-install-recommends` 的最小化系统应手动安装这些包或在设置中指定已有终端的可执行文件。随发布产物同时提供独立的 headless 二进制 `agentport-cli`（放入 PATH 即可使用）。

## Fedora / Arch（社区验证）

社区验证层级以 tarball 分发（当前产物内含 headless 组件 `agentport-cli` 与 `agentport-host`）。

先安装系统依赖——AgentPort 的 GUI 基于 WebKitGTK 4.1，另需托盘、通知与凭据相关库：

```bash
# Fedora
sudo dnf install webkit2gtk4.1 libayatana-appindicator libxdo dbus

# Arch
sudo pacman -S --needed webkit2gtk-4.1 libayatana-appindicator libxdo dbus
```

然后解压 tarball 并把二进制放入 PATH：

```bash
tar -xzf agentport-fedora-x86_64.tar.gz   # Arch 为 agentport-arch-x86_64.tar.gz
sudo install -m 0755 agentport-cli agentport-host /usr/local/bin/
```

注意：该层级为社区验证，未承诺与正式支持相同的回归覆盖；如遇问题请附上发行版版本与桌面环境信息反馈。

## AppImage（Beta）

AppImage 为 Beta 分发物，在 Ubuntu 22.04 基线上构建以兼顾运行兼容性：

```bash
chmod +x AgentPort-<版本>-x86_64.AppImage

# 系统装有 FUSE 时直接运行
./AgentPort-<版本>-x86_64.AppImage

# 无 FUSE 的环境（容器、部分最小化系统）解包运行
./AgentPort-<版本>-x86_64.AppImage --appimage-extract-and-run
```

Beta 意味着它不作为正式支持基线；在 Ubuntu 上请优先使用 `.deb`。

## 数据目录

安装后所有数据存放在本机（无账号、无云端同步）：

| 内容 | macOS | Linux |
|---|---|---|
| 应用数据 | `~/Library/Application Support/AgentPort` | `~/.local/share/agentport` |
| Worktree | `~/Library/Application Support/AgentPort/worktrees` | `~/.local/share/agentport/worktrees` |
| Socket | 系统临时目录下 `agentport-<uid>/` | 同左 |

可以用 `AGENTPORT_DATA_DIR` 覆盖应用数据目录（测试或多实例场景），用 `AGENTPORT_SOCKET_DIR` 覆盖 Socket 目录。

## 应用内更新

已安装的 AgentPort 会在启动后检查新版本，并在后台下载；下载完成后窗口内会出现「AgentPort vX.Y.Z 已准备好」，点「退出并更新」即可整包升级。安装前 AgentPort 会优雅停止正在运行的 Session（Sidecar 与 Shell 属于同一个包，必须一起替换），升级后这些 Session 以 `interrupted` 状态保留历史，可自行 Restart。

升级包由 Tauri Updater 校验签名，来源为本仓库的 GitHub Releases（`latest.json`）；也可以通过系统包管理器（`.deb`）自行升级。开发构建（`tauri dev`、checkout 内的调试包）不会触发正式更新。细节与发布流程见 `docs/updater.md`。

## 首次启动之后

首次启动会进入 CLI 探测向导：AgentPort 依次读取系统 PATH、登录 Shell 的 PATH 和常见安装目录，找到 Claude Code / Codex / Kimi Code 后做只读版本探测，由你确认每个 CLI 的绝对路径。找不到的 Agent 可以跳过；GUI 的 PATH 与终端不一致时可手动选择路径。详见 `docs/user-guide.md` 的"首次启动：CLI 探测"。

## 卸载

卸载分两部分：删除应用本体，以及手动删除应用数据（数据目录不会被安装器代为清理，避免误删你的会话日志与 Worktree）。

### macOS

```bash
# 1. 删除应用
rm -rf /Applications/AgentPort.app

# 2. 删除应用数据与 Worktree（确认不再需要后再执行）
rm -rf ~/Library/Application\ Support/AgentPort
```

Keychain 中 `service=agentport` 的条目需手动删除：打开"钥匙串访问"搜索 `agentport` 删除，或使用命令：

```bash
security delete-generic-password -s agentport
```

保存过多个敏感变量时条目不止一条，可重复执行直至提示找不到。

### Ubuntu

```bash
sudo apt remove agentport
rm -rf ~/.local/share/agentport   # 应用数据与 Worktree，确认后手动删除
```

### Fedora / Arch / AppImage

删除解压/安装的二进制与 AppImage 文件，再手动删除 `~/.local/share/agentport`。Linux 上 Secret Service 中保存的条目（service 为 `agentport`）请用桌面环境的密码管理工具（如 GNOME 的"密码和密钥"）手动删除。
