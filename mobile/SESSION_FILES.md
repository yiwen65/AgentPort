# Session 项目文件（只读）

在 Session 终端向左滑动，或展开终端顶部控制区后点击文件夹按钮，进入项目文件树。文件树右滑或点击「终端」返回；预览页点击「文件树」先返回目录。预览页的横向滑动用于阅读长代码行，不切换页面。

- 根目录是电脑端记录的 Session `cwd`，不跟随终端临时 `cd`，也不会替换成项目主 checkout。
- 文件夹按需加载；每次进入、重新连接或手动刷新会重新读取已加载目录。展开状态和树的滚动位置在页面往返时保留，不停止 Session。
- 文本/代码只读，支持常见代码语言高亮；Markdown 支持渲染/源码切换。可复制相对文件路径和文件内容。大型文本跳过语法高亮，仍可阅读和复制。
- 不包含编辑/新建/删除/重命名、Git 标记、搜索、图片预览或文件系统实时监听。
- `.git` 不列出；其他普通隐藏项可见。目录最多返回 2,000 项，文本最多读取 1 MiB，截断时明确提示，复制也只包含已读取片段。
- Markdown 不执行 HTML/脚本、不自动加载图片及外部资源。仅支持根目录内相对文件链接；外部链接禁用。

## 主机与安全边界

手机与电脑均需包含本功能版本。电脑端新增 `session.files.list` / `session.files.read`，参数为 `{ sessionId, path }`，`path` 为根目录相对路径，目录根为 `.`。服务端由 Session ID 查询 cwd，客户端不能提交另一个 rootPath。

目录及文件通过真实路径包含检查、固定目录句柄和禁止跟随替换后的符号链接来读取，不回退到旧的无根限定 `document.*` 接口。指向根外、失效或特殊文件的符号链接不列出；直接请求越界路径仍返回明确错误。二进制、非 UTF-8 及非普通文件不预览。

目前安全文件访问实现支持 Unix 主机（macOS/Linux）；非 Unix 主机明确返回 `unsupported_platform`，不使用不安全的降级方案。旧版本主机返回不支持时，手机提示升级。现有 `document.*` 接口行为不变，本功能不是对已配对设备全部能力的重新授权。

## 回归验证

```bash
cd mobile
npm test -- src/features/files/SessionFiles.test.tsx src/app/App.test.tsx src/features/sessions/SessionWorkspace.test.tsx src/terminal/MobileTerminal.test.tsx
npm run build
cd ..
cargo test -p agentport-service session_files --lib
cargo test -p agentport-remote-bridge --lib
cargo test -p agentport-remote-protocol --lib
node mobile/scripts/test-session-files.mjs
```

最后一项使用隔离的无头 Chrome、真实 App/xterm 及确定性 RemoteClient 测试数据，不读取用户 Session，不代替 iOS/Android 真机网络、键盘或无障碍验证。可用 `CHROME_BIN` 指定 Chrome；设置 `AGENTPORT_FILES_SCREENSHOTS=/tmp/agentport-files-evidence` 保存手机视口截图。
