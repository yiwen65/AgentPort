# AgentPort 仓库规则

## 调试任务完成后默认重启调试窗口

执行完涉及 UI/前端或 App 行为的调试（debug）任务后，**默认把更新后的调试 App 窗口打开**，让改动立刻可见，而不是只改代码/只构建 `dist` 就停手。

调试窗口运行的是 `target/debug/bundle/macos/AgentPort.app`，其前端资源在 Rust 编译期嵌入二进制。正确生效路径：

```bash
cd src && npm run build
cd .. && cargo build -p agentport --features tauri/custom-protocol
cp target/debug/agentport "target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport"
cp target/debug/agentport-host "target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport-host"
# 手动替换 .app 内二进制会使原有签名失效；必须重新签名，否则 macOS 会杀掉 sidecar。
codesign --force --deep --sign - "target/debug/bundle/macos/AgentPort.app"
codesign --verify --deep --strict "target/debug/bundle/macos/AgentPort.app"
# 关闭旧 debug 窗口后，以独立实例打开。不能只用 `open`：若 release App
# 同时运行且 Bundle ID 相同，macOS 可能把焦点路由到 release 窗口。
open -n "target/debug/bundle/macos/AgentPort.app"
```

注意事项：

- **不要**用裸 `cargo build -p agentport` 的产物替换 .app 二进制——没有 `tauri/custom-protocol` feature 时按 `devUrl`（localhost:1420）加载前端，没有 dev server 就是白屏。
- 手动替换 `.app/Contents/MacOS` 下的主程序或 `agentport-host` 后，必须对整个 `.app` 执行上面的 ad-hoc `codesign`；否则 macOS 会以 `SIGKILL` 终止 Host，表现为 `host exited during startup`。
- Session 由独立的 `agentport-host` 进程承载，重启 GUI 窗口不会中断进行中的 session，可以放心重启。
- 重启后截图确认窗口正常渲染（非空白）再交付。
- 若同时存在 `dist-release/macos/AgentPort.app`，**不得**关闭它或任何 `agentport-host`。只定位并关闭 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport` 的旧 GUI PID，再执行上面的 `open -n`。
- 不要以窗口标题判断启动目标（两个实例都叫 AgentPort）。交付前必须用 `ps` 确认新 GUI 进程的可执行路径为 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`；随后截图确认该窗口非白屏。
- 开发期想走热更新就用 `tauri dev`（1420 端口），不适用上面的替换流程。
