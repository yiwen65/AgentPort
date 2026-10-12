# AgentPort Mobile

AgentPort 的 GPL-3.0-only 移动客户端子项目，采用独立的 Tauri 2 Mobile + React 应用。

## 两种连接用途

- **AgentPort 管理**：通过 SSH Remote Bridge 或用户配置的 Relay 访问电脑端 Project、Agent Session、终端与相关能力。目标需安装 AgentPort 组件，桌面 GUI 无需常开。
- **通用 SSH / Mosh 终端**：连接普通 macOS/Linux 主机，不要求目标安装 AgentPort。通过 App 专用 tmux 会话支持多个终端和显式恢复；远端必须安装 tmux，Mosh 还需 mosh-server 与直达 UDP。SSH 主机配置与凭据可共用，Relay 身份不授予普通 SSH 权限。

通用终端的安装前提、使用语义及限制见 [GENERIC_TERMINAL.md](GENERIC_TERMINAL.md)。平台编译、模拟器与真机验证是不同的验收层级；最新实现与验证记录见仓库 `docs/tasks/2026-10-13-mobile-generic-persistent-terminal-task.md`。

## 快速验证

```bash
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

生成原生工程、模拟器与签名构建见 [BUILDING.md](BUILDING.md)。

## 许可证

移动 App 整体采用 GPL-3.0-only，见 [COPYING](COPYING)，它链接的上游 Mosh 同样采用 GPLv3。桌面 Rust workspace、`src/` 与 `src-tauri/` 采用 PolyForm Noncommercial License 1.0.0；共享依赖的具体许可依各组件声明。详见仓库 `LICENSING.md` 与 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
