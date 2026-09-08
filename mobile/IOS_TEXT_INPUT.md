# iOS 空格后首字符丢失

## 实机根因

2026-09-08，iPhone 17 Pro Max / iOS 26.6，用户报告输入 `abc` 而终端只有 `bc`。
USB Web Inspector 捕获到 `abc abc` 的以下事件：

1. 空格键触发 `insertText`，textarea 末尾保存 U+00A0（NBSP）。
2. 下一个 `a` 仍是 `keydown(229) → beforeinput → input → keyup(65)`；没有 composition。
3. 同一次 input 把之前的 U+00A0 转回 U+0020，并追加 `a`。选区始终折叠在末尾，
   textarea 长度增加 1，但新值不再逐字节以旧值为前缀。
4. 旧 `iosIme.ts` 因此前缀差异把整次编辑标成 `unproven-edit`，不发送 `a`。
   `b`、`c` 则正常到达 xterm 和 `session.input`，并收到 completed 回执。

因此丢字发生在手机 DOM 编辑适配层，不是键盘没产生事件，也不是网络或桌面漏画。

## 修复边界

- 只有 beforeinput 证明光标折叠在旧值末尾、input 后光标仍在末尾且长度增加，
  才允许已有前缀发生 SP/NBSP 表示转换；只发送实际追加的后缀，不重写旧终端内容。
- 只有 `insertText` 的 data 与完整 DOM 插入片段一致（差异仅限 SP/NBSP），才采用
  data 的空格表示，使普通空格键发送普通空格，而不是错误地发送 NBSP。
- 不全局替换文本中的 NBSP。用户显式输入的 NBSP 保持原样；没有 beforeinput、
  选区不匹配、Tab/字母等其他前缀变化仍不猜测发送。
- 不按字母补字、不引入时间/整句去重、不让 xterm 再次消费已由适配层处理的 DOM 编辑。

## 验证

真实打开的 xterm 回归覆盖连续 `abc abc abc`、延迟事件、中文/emoji 首字符、失效
所有权前缀、显式 NBSP、不可信编辑和 full-word data 的重复通知。新增 11 项中
7 项先在旧实现失败；修复后 Mobile 274 项测试及 TypeScript/Vite 构建通过。
iOS Debug archive 已构建、安装并重新打开。豆包批量撤回、组合输入和原生粘贴的
既有回归也继续通过。

修复前的真实 DOM / xterm / transport 证据已保存为无正文的事件元数据。修复后
等待复测期间设备页面不可用，尚未取得新的真实按键序列；不能把自动化回归等同于
实机验收。随后重新打开 App 清理临时诊断，不停止任何远端 Session/Host。
