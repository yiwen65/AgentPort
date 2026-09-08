# Typeless 语音输入只剩首字

## 实机故障与根因

2026-09-08，iPhone 17 Pro Max / iOS 26.6，USB Web Inspector 在未修改输入逻辑的版本捕获到：

1. `keydown(0)`，随后一次可打印字符 `keypress`，没有 composition 事件。
2. xterm 先发送 1 个字符，`session.input` 回执 completed。
3. `beforeinput(insertText)` / `input(insertText)` 插入完整 9 个字符，选区从 `[0,0]` 到 `[9,9]`。
4. `iosIme.ts` 将 keydown 和 keypress 视为硬件输入，完整 DOM input 被标记为
   `hardware-owned` 并忽略，最后 `keyup(0)` 结束这一键周期。

第一处分歧在 DOM 输入归属判定，不是传输漏发。中性文本在真实打开的 xterm 中回放
同样顺序也只发送首字；去掉 keypress 仍会因 keydown(0) 被忽略，说明两个入口都要处理。

## 修复边界

- 无 Ctrl/Alt/Meta/Shift 的 `keydown(0)` 不再作为硬件文字输入的证据。
- 该键周期的 keydown 和 keypress 在父级 capture 截断传播，但不 preventDefault，
  保留浏览器原生编辑，由现有 DOM 差量逻辑发送完整输入。
- keyup、新 keydown、blur/paste、显式 invalidate 解除该键周期标记。
- 已知硬件键和带修饰键的事件继续走原路径；不改变 229、组合输入、豆包安全尾部删除、
  SP/NBSP 归一化或原生粘贴规则。不缓存/补发首字，不加入整句/时间去重。
- 此修复覆盖已观察到的 DOM 提交路径，不宣称支持所有仅发 keypress 而不编辑 DOM 的未知键盘。

## 验证

- 新增 12 项回归；其中 4 项 Typeless 关键用例在旧实现因提前发送首字或漏掉整句失败。
- 覆盖 0/20/1000ms 延迟、连续同句、中文及 emoji、无 keypress、所有权边界、修饰键。
- Mobile 全部 286 项测试及 TypeScript/Vite 构建通过；iOS debug archive 构建成功并安装、重新打开。
- 修复后实机捕获到相同的 `keydown(0) → keypress → beforeinput → input → keyup(0)`：
  DOM 长度 9，适配层 `append` 发出 9，xterm 一次发出 9，`session.input` 一次发送 9，
  199ms 后 completed；没有提前发出首字或额外重复请求。
- WebKit 截图确认页面及终端非白屏；保存前遮蔽终端正文。此截图不包含原生键盘。

临时证据文件（不提交转写正文）：
`/tmp/agentport-typeless-trace.json`、`/tmp/agentport-typeless-fixed-evidence.json`、
`/tmp/agentport-typeless-red.log`、`/tmp/agentport-typeless-suite.log`。
