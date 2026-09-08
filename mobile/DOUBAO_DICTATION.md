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

## 中英混合语音：撤回期间的 SP/NBSP 转换（2026-09-09）

后续真机复现发现另一条独立失效路径，不能靠此前的 Backspace 路由修复覆盖：

- 15 个临时字符已发送；实际 DOM 撤回 15 次，但 xterm/传输仅发送 6 次 DEL。
- 首次分歧为长度 9→8 的删除：保留前缀第 7 位的 U+0020 同时变成 U+00A0。
  原来的严格前缀比较失败，记录 `unproven-edit`，并放弃末尾所有权。
- 后续 8 次删除也被忽略，最后长度 15 的整句照常发送；残留 9 字符形成重复。
  这不是网络重试或同一句语音被识别两遍。

修复只对**有 beforeinput 证据、光标前后都在末尾、值确实缩短、删除未越过
ownedStart、inputType 为 deleteContentBackward**的编辑允许保留前缀 SP/NBSP
表示等价。仅对真正移除的后缀计数 DEL，不重写保留空格，不整体规范化正文。
NBSP 本身也是一个可安全撤回的 scalar，因此后续单次/批量 Backspace 都保留
DOM 所有权。光标移动、无证据编辑、非空格前缀变化和复杂字形仍不能借此删除。

验证：

- 真实 xterm 合成回归中，旧实现有 3 个新增用例失败；修复后通过。
- 新增 10 项覆盖同一按键批量撤回、分次 Backspace、连续两句相同语音、一次删
  多字符，以及缺 beforeinput/失去所有权/移动光标/错误 inputType/改字/tab/emoji。
- 移动端 330 项测试、TypeScript/Vite、iOS Debug archive 均通过，已安装并重开。
- 修复后真机捕获两轮撤回（12 和 15 字符），27 次 DOM 删除对应 27 次 xterm DEL
  和 27 次传输 DEL；4 次 SP→NBSP 分歧均记录 `space-normalized-delete`，没有
  `unproven-edit`。替换段长度 12、15，各发送一次；捕获的 45 个请求完成回执
  均为 `completed`。该证据覆盖输入链路，不宣称任意 TUI 的删除语义均相同。
- 采集仅保留事件、长度、空格类型、选区和相等关系；未保存语音正文。诊断监听、
  请求包装均已移除，终端截图遮盖正文后检查 App 非白屏。未重启任何 Host。
