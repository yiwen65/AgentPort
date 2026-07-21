# AgentPort 仓库规则

## 调试任务完成后默认重启调试窗口

执行完涉及 UI/前端或 App 行为的调试（debug）任务后，**默认把更新后的调试 App 窗口打开**，让改动立刻可见，而不是只改代码/只构建 `dist` 就停手。

调试窗口运行的是 `target/debug/bundle/macos/AgentPort.app`，其前端资源在 Rust 编译期嵌入二进制。正确生效路径：

```bash
cd src && npm run build
cd .. && cargo build -p agentport --features tauri/custom-protocol
cp target/debug/agentport "target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport"
# 关闭旧窗口后重新打开：
open "target/debug/bundle/macos/AgentPort.app"
```

注意事项：

- **不要**用裸 `cargo build -p agentport` 的产物替换 .app 二进制——没有 `tauri/custom-protocol` feature 时按 `devUrl`（localhost:1420）加载前端，没有 dev server 就是白屏。
- Session 由独立的 `agentport-host` 进程承载，重启 GUI 窗口不会中断进行中的 session，可以放心重启。
- 重启后截图确认窗口正常渲染（非空白）再交付。
- 开发期想走热更新就用 `tauri dev`（1420 端口），不适用上面的替换流程。
