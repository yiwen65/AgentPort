# AgentPort 仓库规则

## 完成 Bug 修复或 Feature 后提交

完成一个 Bug 修复或 Feature 后，必须在验证通过后创建 Git commit。只提交本任务相关改动，不得混入其他未提交的工作。

## 调试任务完成后默认重启调试窗口

执行完涉及 UI/前端或 App 行为的调试（debug）任务后，**默认把更新后的调试 App 窗口打开**，让改动立刻可见，而不是只改代码/只构建 `dist` 就停手。

调试窗口运行的是 `target/debug/bundle/macos/AgentPort.app`，其前端资源在 Rust 编译期嵌入二进制。正确生效路径：

```bash
# 构建前端、Host 与带 custom-protocol 的 GUI，安装进调试 .app，
# 为当前 checkout 写入唯一 Debug Bundle ID，并重新签名。
bash scripts/rebuild-debug-app.sh
# 关闭旧 debug 窗口后，以独立实例打开。不能只用 `open`：若 release App
# 同时运行，仍需确保打开的是工作区内的调试包。
open -n "target/debug/bundle/macos/AgentPort.app"
```

注意事项：

- **不要**用裸 `cargo build -p agentport` 的产物替换 .app 二进制——没有 `tauri/custom-protocol` feature 时按 `devUrl`（localhost:1420）加载前端，没有 dev server 就是白屏。
- 调试构建使用由 checkout 绝对路径派生的唯一 Bundle ID；不得改回发布版的 `com.agentport.desktop`，否则 macOS 可能把系统通知点击路由到另一个 AgentPort 实例。
- 调试包显示名包含 checkout 名（例如 `AgentPort Debug - AgentSessions`），用于在通知来源、系统设置和多实例窗口中区分目标。
- 手动替换 `.app/Contents/MacOS` 下的主程序或 `agentport-host` 后，必须对整个 `.app` 执行上面的 ad-hoc `codesign`；否则 macOS 会以 `SIGKILL` 终止 Host，表现为 `host exited during startup`。
- Session 由独立的 `agentport-host` 进程承载，重启 GUI 窗口不会中断进行中的 session，可以放心重启。
- 重启后截图确认窗口正常渲染（非空白）再交付。
- 若同时存在 `dist-release/macos/AgentPort.app`，**不得**关闭它或任何 `agentport-host`。只定位并关闭 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport` 的旧 GUI PID，再执行上面的 `open -n`。
- 不要以窗口标题判断启动目标（两个实例都叫 AgentPort）。交付前必须用 `ps` 确认新 GUI 进程的可执行路径为 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`；随后截图确认该窗口非白屏。
- 开发期想走热更新就用 `tauri dev`（1420 端口），不适用上面的替换流程。
