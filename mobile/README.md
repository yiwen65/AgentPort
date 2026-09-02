# AgentPort Mobile

AgentPort 的 GPL-3.0-only 移动客户端子项目。它通过用户自管 SSH/Mosh 连接电脑端 AgentPort；不包含账号、官方云、中继、遥测或广告 SDK。

当前状态：**T-006 application scaffold**。Web/Tauri 壳、移动最低版本配置、i18n、主题、可访问空状态和 `RemoteClient` 边界可构建；SSH/SFTP/Mosh、安全存储和真实业务命令必须通过 T-017 transport gate 后接入。当前 UI 不把 scaffold 呈现为已连接产品。

## 快速验证

```bash
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

生成原生工程和模拟器验证见 [`BUILDING.md`](BUILDING.md)。

## 许可证

移动 App 整体采用 GPL-3.0-only，见 [`COPYING`](COPYING)。桌面 AgentPort、Remote Bridge、Service 和共享协议继续采用 MIT；详情与第三方组件见 [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)。
