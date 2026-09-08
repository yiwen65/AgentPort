# Mobile 粘贴快捷键

## 原因与路径

WKWebView 的 `navigator.clipboard.readText()` 即使在按钮 click 中调用，也可能拒绝
Promise 并显示网页 Paste 菜单。此前快捷键因此同时显示 Unable to paste 和系统菜单。

安装版 App 使用 Tauri Clipboard Manager 2.3.2 的 `read_text`，iOS 实现读取
`UIPasteboard.general.string`。只授予 `clipboard-manager:allow-read-text`；不在渲染、
轮询或 touchstart 时读取剪贴板。浏览器开发环境保留 Web Clipboard API；原生失败
不会回退网页读取，避免再次弹出网页菜单或重复读取。

系统的跨 App 粘贴隐私授权仍必须尊重。首次使用可能需要选择允许；若用户在 iOS
设置中禁止从其他 App 粘贴，需要恢复系统授权。这个修复不是绕过系统权限，也不
宣称可以在系统拒绝授权时直接读取。当前快捷键只粘贴文本，不上传剪贴板图片。

## 输入边界

- 读取未完成时忽略重复点击。
- reset、隐藏或卸载终端后丢弃迟到结果，不能发送到下一轮 Session。
- 成功后调用 `terminal.paste`，由 xterm 处理换行和 bracketed paste，避免把多行
  内容直接当作按键；等待授权期间切换的修饰键也不能把粘贴文字变成 Ctrl-C 等命令。
- 失败不发送任何输入，保留可再次点击的错误提示；不自动重试粘贴。

## 验证

255 项前端测试及 TypeScript/Vite 构建通过；新增的六项原生路由、重复点击及迟到
结果回归先在旧实现失败，再修复通过。iOS Debug archive 构建并安装成功。

实机元数据记录了一次真实 Paste 点击：16ms 后调用一次 xterm.paste，365 个 JS
字符生成一次含 12 个字符 bracketed-paste 边界的 onData；没有网页剪贴板读取或
粘贴错误。这里只记录长度、次数和时序，不保存剪贴板正文，不把额外终端按键或
终端协议回复当成重复粘贴。
