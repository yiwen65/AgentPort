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

Windows、移动端、SSH 主机、容器和远程主机不在支持范围内。"社区验证"与 Beta 不等同于正式支持：发行版滚动更新可能带来兼容回归。

## macOS（正式支持）

要求 macOS 13 或更高版本，Apple silicon 与 Intel 均可（Universal 构建）。

1. 打开下载的 `.dmg`，把 `AgentPort.app` 拖入"应用程序"。
2. 首次启动：在"应用程序"中打开 AgentPort，进入 CLI 探测向导（确认各 Agent 的路径与版本）。

### Gatekeeper 说明

以下步骤**仅适用于未签名/未公证的构建**（例如本地自行构建的产物）：

- 首次打开被拦截时，到"系统设置 → 隐私与安全性"中，对 AgentPort 点击"仍要打开"；
- 或者用命令去除隔离属性：

```bash
xattr -cr /Applications/AgentPort.app
```

经过签名与公证的构建无需上述操作；本仓库当前构建未签名（见 release-manifest.json）。

## Ubuntu 22.04 / 24.04（正式支持）

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
