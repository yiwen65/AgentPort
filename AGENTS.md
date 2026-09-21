# AgentPort 仓库规则

## 完成 Bug 修复或 Feature 后提交

完成一个 Bug 修复或 Feature 后，必须在验证通过后创建 Git commit。只提交本任务相关改动，不得混入其他未提交的工作。

## 调试任务完成后默认重启调试窗口

执行完涉及 UI/前端或 App 行为的调试（debug）任务后，**默认把更新后的调试 App 窗口打开**，让改动立刻可见，而不是只改代码/只构建 `dist` 就停手。

调试窗口运行的是 `target/debug/bundle/macos/AgentPort.app`，其前端资源在 Rust 编译期嵌入二进制。正确生效路径：

```bash
# 统一入口：构建并签名，然后仅关闭路径完全匹配的旧 GUI，再独立打开。
python3 scripts/restart-debug-app.py
# 已完成构建且签名有效时，可只重启 GUI：
python3 scripts/restart-debug-app.py --skip-build
# 仅查看目标，不构建、不发送信号、不打开窗口：
python3 scripts/restart-debug-app.py --dry-run
```

注意事项：

- **不要**用裸 `cargo build -p agentport` 的产物替换 .app 二进制——没有 `tauri/custom-protocol` feature 时按 `devUrl`（localhost:1420）加载前端，没有 dev server 就是白屏。
- 调试构建使用由 checkout 绝对路径派生的唯一 Bundle ID；不得改回发布版的 `com.agentport.desktop`，否则 macOS 可能把系统通知点击路由到另一个 AgentPort 实例。
- 调试包显示名包含 checkout 名（例如 `AgentPort Debug - AgentSessions`），用于在通知来源、系统设置和多实例窗口中区分目标。
- 调试构建必须使用 `.env` 中配置的固定 `AGENTPORT_DEBUG_SIGN_IDENTITY` 证书，不能用环境变量 `AGENTPORT_DEBUG_SIGN_IDENTITY=-` 覆盖它：ad-hoc 签名按二进制哈希识别 App，重编译会导致录屏等 TCC 授权反复失效。证书不可用时应报错并修复签名配置；只有明确接受权限重置的临时包才可设置 `AGENTPORT_DEBUG_ALLOW_ADHOC=1`。
- 手动替换 `.app/Contents/MacOS` 下的主程序或 `agentport-host` 后，必须通过上述统一脚本重新签名整个 `.app`；否则 macOS 会以 `SIGKILL` 终止 Host，表现为 `host exited during startup`。
- Session 由独立的 `agentport-host` 进程承载。**重启必须使用上述统一脚本，不得自行拼接查杀命令。** 禁止 `pgrep -f "$APP"` / `pkill -f` / `killall`：GUI 路径也是 `agentport-host`、`agentport-connector` 等程序的前缀，会误杀 Session 并切断手机连接。只有精确关闭 GUI 才不会中断现有 Session。
- 重启后截图确认窗口正常渲染（非空白）再交付。
- 若同时存在 `dist-release/macos/AgentPort.app`，**不得**关闭它、任何 `agentport-host` 或 `agentport-connector`。统一脚本通过 `ps` 的可执行路径完全匹配当前 checkout 的旧 GUI，并在发送信号前再次核验 PID；关闭失败会报错，不会升级为强制查杀。
- 不要以窗口标题判断启动目标（两个实例都叫 AgentPort）。交付前必须用 `ps` 确认新 GUI 进程的可执行路径为 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`；随后截图确认该窗口非白屏。
- 开发期想走热更新就用 `tauri dev`（1420 端口），不适用上面的替换流程。

## 版本与自动更新

- **一个 Release 只有一个版本**：`Cargo.toml [workspace.package]`、`src-tauri/tauri.conf.json`、`src/package.json` 必须一致；`agentport-host` 等 Sidecar 通过 `bundle.externalBin` 随 App 一起升级，**不要**为 Sidecar 单独做下载/替换。改动版本用 `scripts/set-version.sh <x.y.z>`，提交前跑 `scripts/check-version-sync.sh`。
- 升级流程由 Rust 拥有（`src-tauri/src/updater.rs`）：检查 → 后台下载 → 用户点「退出并更新」→ `stop_live_sessions_for_update` 优雅停止并复核所有 Session Host → `Update::install` → `app.restart()`。任何 Session 无法证明进程组已清理都必须中止安装并保留旧版本。
- Debug/开发构建永远不访问正式 feed（`cfg!(debug_assertions)` 或 `AGENTPORT_UPDATER_DISABLED=1`），调试包不会被自动升级。
- Tauri Updater 签名（`TAURI_SIGNING_PRIVATE_KEY`，私钥在 `~/.tauri/agentport-updater.key`，切勿提交）与 macOS/Windows 代码签名是两套机制，不得互相替代。发布与密钥细节见 `docs/updater.md`。
- 发布：`scripts/set-version.sh` → 提交 → `git tag vX.Y.Z && git push origin vX.Y.Z`。`.github/workflows/release.yml` 在同一个 tag 上发布 macOS（universal + `latest.json`）与 Linux（deb + Fedora/Arch tarball + `SHA256SUMS-linux`）；应用内更新仅 macOS，Linux 走包管理器。补发某个平台不要移动 tag，用 `gh workflow run release.yml -f tag=vX.Y.Z -f platforms=linux`。本地 `scripts/build-macos.sh` 在没有密钥时会以 `createUpdaterArtifacts=false` 跳过 updater 产物，这类 DMG 不能作为更新源发布。
- **本地不要直接往上发布**：本机上行到 `uploads.github.com` 的大文件 POST 会静默失败（只留 `state=starter` 占位），发布一律走 CI；判断资产是否真的上传成功要看 API 的 `state=uploaded`，不能只看 size。
- **推送走 SSH**：本机直连 github.com 被封，HTTPS 必须经本地代理（127.0.0.1:7890），而该代理上行只有 60–500 KB/s 且约 20% 完全停住。本仓库已设置 `git remote set-url --push origin git@github.com:yiwen65/AgentPort.git`（fetch 仍 HTTPS），并全局启用 `http.lowSpeedLimit=1000` / `http.lowSpeedTime=45` 让 HTTPS 传输停住时 45s 内失败；推送循环务必带看门狗（macOS 无 `timeout`）。
- **承载更新 feed 的仓库必须匿名可读**：客户端拉取 `latest.json` 不带凭据，私有仓库的 Release 资产返回 404，更新会静默失败。发布后用未认证 `curl` 校验 `latest.json`（期望 302）与安装包（200）。

## 许可边界（2026-09-18 确认）

- **桌面端**（Rust workspace + `src/` + `src-tauri/`）采用 **PolyForm Noncommercial License 1.0.0**（`LICENSE`，中文说明 `LICENSING.md`）：个人与非商业组织使用免费，**任何商业用途必须先取得作者书面授权（1053909200@qq.com）**。新增代码或资源不得引入与本许可冲突的条款，也不得在仓库根重新声明整仓 MIT。
- **移动端**（`mobile/`）采用 **GPL-3.0-only**（`mobile/COPYING`），**不禁止商用**：分发时按 GPLv3 提供对应源码与许可证文本即可。它链接的上游 Mosh 同样是 GPLv3。不要把它改成专有/闭源许可，也不要在桌面 crates 里链接 GPL 代码。
- 快照引擎：`scripts/build-terminal-snapshot.mjs` 依赖仓库内 `mobile/` 的 xterm 与 `mobile/src/terminal/hostSnapshotEngine.ts` 生成 `crates/agentport-host/assets/terminal-snapshot/`；改引擎或升级 xterm 后重跑该脚本（`--check` 是漂移门禁）。
- 历史说明：2026-09-18 曾把移动端拆成私有子项目并重写公开历史，同日按用户决定撤销——历史已恢复到重写前的 `9142341` 与原始 tag，桌面许可改动作为新提交叠加。再次做类似拆分或历史重写前，先确认仍然需要。
