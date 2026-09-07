# 豆包 iPhone 语音输入：批量撤回事件

## 真机根因（2026-09-08）

设备：iPhone 17 Pro Max / iOS 26.6，AgentPort WKWebView，xterm 5.5。
通过 USB Web Inspector 观察原有终端直接输入，不增加草稿框。
只记录事件类型、长度、选区、相等关系和发送长度，不记录语音正文。

修复前捕获到的顺序：

1. 九次 `keydown(229) → beforeinput/input(insertText, 长度 1) → keyup`。
2. **一次** `keydown(Backspace, keyCode 8)`。
3. 同一按键周期内，八对 `beforeinput/input(deleteContentBackward)`，
   textarea 长度从 9 变成 1。
4. `keyup(8)` 后，输入法再插入长度 9 的最终句。

这里没有 composition 事件。旧路由把 Backspace 交给 xterm，xterm 发出一次
DEL 并取消默认操作；路由同时把直到 keyup 的所有 DOM 编辑都标为
`hardware-owned`。八次实际删除全部被忽略，最终句却继续发送，因此出现重复。
只有不带 Backspace 的软删除测试，无法覆盖这条真实事件路径。

## 修复边界

`src/terminal/iosIme.ts` 在以下条件同时成立时，让 DOM 拥有普通 Backspace：

- textarea 与已观察值一致，有已发送、可安全撤回的末尾文本；
- 光标折叠在末尾，没有 Ctrl/Alt/Meta/Shift，且不在 composition 中；
- 待撤回部分是 ASCII、独立汉字或标点，可按 Unicode scalar 计数退格。

只阻止按键传给 xterm，**不调用 preventDefault**。之后逐个通过
`beforeinput` 选区和实际 DOM 差异确认删除、发出 DEL；不假设一次按键只对应一次
编辑，也不凭按键猜测额外删除。标点包括中文句号等，不能把它们当作无法撤回的字形。

空 textarea、失去所有权、移动光标、组合快捷键和复杂字形仍交给 xterm。
不加入时间窗口/整句去重，不重置终端，不改变粘贴或工具栏的所有权边界。
这是常规行编辑器的末尾编辑映射，不承诺任意 TUI/光标位置/复杂字形的文档编辑语义。

## 验证

- 先加真实 xterm 回归：旧实现的四个新增用例失败，明确只发一次 DEL。
- 修复后覆盖批量撤回、中文标点、连续相同语音、按住退格、空尾部回退、
  修饰键、失效边界和待提交 composition；移动端全部 234 项测试通过。
- TypeScript/Vite 构建及 iOS Debug archive、签名、安装、启动成功。
- 安装后两轮豆包真机复测均观察到：九次单字插入，**九次实际删除且每次发送
  一个 DEL**，最后一次长度 9 的整句插入。没有 `hardware-owned` 丢弃。
  新路径恢复九次 DOM 删除，支持原来首个删除被 xterm 默认取消所抑制的判断。
- 第二轮不清空、故意再说同一句；渲染行中约定测试句的出现次数从 1 增加到 2，
  没有重放临时文本，也没有吞掉有意重复。仅记录出现次数，不保存行正文。
- 已检查可见页面渲染，截图在内存中遮盖终端正文后保存；没有关闭任何 Host。
  临时构建 SSH 授权已删除，设备上的诊断监听器和记录已清空。

真机结论仅覆盖上述设备、输入法和复测序列，不能用合成测试代替其他键盘的验收。
