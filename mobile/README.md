# AgentPort Mobile

AgentPort 的 GPL-3.0-only 移动客户端子项目，采用独立的 Tauri 2 Mobile + React 应用。

## 两种连接用途

- **AgentPort 管理**：通过 SSH Remote Bridge 或用户配置的 Relay 访问电脑端 Project、Agent Session、终端与相关能力。目标需安装 AgentPort 组件，桌面 GUI 无需常开。
- **通用 SSH / Mosh 终端**：连接普通 macOS/Linux 主机，不要求目标安装 AgentPort。默认普通 Shell，无需 tmux；需要持久恢复时可主动选择 tmux 模式，旧 tmux 记录保持兼容。普通 Shell 再次打开会启动新 Shell，不会重放命令或伪装恢复上次任务。Mosh 仍需 mosh-server 与直达 UDP。SSH 主机配置与凭据可共用，Relay 身份不授予普通 SSH 权限。

通用终端的安装前提、使用语义及限制见 [GENERIC_TERMINAL.md](GENERIC_TERMINAL.md)。平台编译、模拟器与真机验证是不同的验收层级；可选 tmux 的实现与验证记录见仓库 `docs/tasks/2026-10-16-mobile-optional-tmux-shell-task.md`，原始功能记录见 `docs/tasks/2026-10-13-mobile-generic-persistent-terminal-task.md`。

## 快速验证

```bash
npm ci
npm test
npm run build
npm run test:startup # 校验生产模块图：首页不提前加载 xterm/终端视图
cargo test --manifest-path src-tauri/Cargo.toml
```

生成原生工程、模拟器与签名构建见 [BUILDING.md](BUILDING.md)。

## 终端滚动时序诊断（默认关闭）

仅在本机诊断构建设置 `VITE_SCROLL_DIAGNOSTICS=1`。例如按 [RELEASE.md](RELEASE.md) 配好本机签名变量后：

```bash
VITE_SCROLL_DIAGNOSTICS=1 bash scripts/build-ios-personal-team.sh
```

打开 Agent Session，保持键盘关闭、不切页，第一次有效竖向拖动会开始一次 15 秒采集。只缓存事件时间、数量和 buffer/mouse/renderer 模式；窗口结束后才写 `Library/Application Support/com.agentport.mobile/diag.log` 中的 `scroll_diag_*` 记录，不记录输入/终端原文或主机/Session 身份。每个挂载 workspace 仅采一次；切页会提前结束，卸载会丢弃尚未完成的采样。事件最多保留 4096 条，溢出量会写入 summary。默认构建不启动采样或写这些日志。

`submissionReleased` 是本地输入提交等待释放（也可能由错误释放），不是远端已绘制；`outputReceived` 是 JS 收到输出事件，单位为 base64 字符数；`queuedWrite` 的单位是字节数组长度或字符串 UTF-16 code units。rAF 间隔不是物理屏幕帧率，xterm `render` 回调也不是 GPU 呈现完成。输入到输出的间隔包括网络、队列与远端处理；不能只凭平均 CPU 或这些记录直接归因网络。`terminalInput` 在 xterm 产生输入、进入 Session 输入守卫前记录，`paintBlocked` 记录实际被同步门控抑制的绘制尝试。`inputCorrelation/inputAck/inputFailed` 的 units 是采集器内部序号（不是远端 batch/Session ID）；按序号匹配可测输入到完成回执，但仍包含 IPC、网络和 Host 处理，不是纯网络 RTT。`syncBegin/syncEnd` 记录实际 DEC2026 绘制门控转换，syncEnd 的 units 为 marker=1、timeout=2、reset=3；开始前已打开、结束后尚未关闭或溢出的区间不可强行配对。`wheelFlush` 的 units 为合并后、倍率前的绝对像素位移，`wheelOutside` 只表示最后坐标在屏幕 bounds 外，不等于已丢弃输入。`mouseEncoding` 从当前 xterm 状态读取（快照恢复不会经过 CSI 监听）。诊断完成后移除该环境变量并重建普通包。

## 许可证

移动 App 整体采用 GPL-3.0-only，见 [COPYING](COPYING)，它链接的上游 Mosh 同样采用 GPLv3。桌面 Rust workspace、`src/` 与 `src-tauri/` 采用 PolyForm Noncommercial License 1.0.0；共享依赖的具体许可依各组件声明。详见仓库 `LICENSING.md` 与 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
