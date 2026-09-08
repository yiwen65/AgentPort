# Mobile / Desktop Session 状态同步修复

## 根因

Session ID 跨 restart 保留，但 PTY 连接、退出标记、游标、暂停状态和尺寸归属都属于
某一轮 Host run。此前桌面只在本机 `restartSessionFlow` 中清理它们，mobile 发起
restart 不会执行这条本机流程：Project 快照已变成 running，旧 `runtime.exit`
却仍使中央 Restart 卡片可见，而且 `activateAttachment` 会因此拒绝新的活连接。

同时，分屏叶子的 TerminalPane 自己订阅 Session，外层卡片却依赖根组件传来的
Session；未聚焦叶子的更新可能没有让根组件重新渲染，导致卡片与遮罩各用一份状态。

排查还确认了两条跨端竞态：

- 桌面快照合并只保护 status 的 run/sequence，却把旧快照的 lifecycle/hostAlive
  合并到新 run；全局退出事件也丢失了后端已有的 run 身份。
- Mobile 原生事件向本 Host 的所有本地订阅广播。Workspace 只过滤 Session ID，
  因而另一条旧 attachment 的 output/exit 可以污染当前窗口。

## 处理规则

| 状态/边界 | Desktop | Mobile |
| --- | --- | --- |
| 外部 restart | 新 run 或已复活快照触发本地重置、重新 attach，不重发 restart | 新 run 快照或 ended 页的只读核对触发新 attach |
| 快速 running → running | 对比 runOrdinal，不依赖是否观察到中间 stopped | 同样按 run 身份失效旧游标和待绘制输出 |
| stopped / exited / interrupted | 卡片、变暗层、分屏叶子订阅相同 Session；旧 exit 不带入下一轮 | Exit 立即撤销连接能力；当前 run 的停止快照也可补偿丢失的 Exit |
| attach / replay | 保留解析、实际绘制和 Pi startup-ready 遮罩边界 | 早到事件有界暂存，拿到服务端 attachment ID 后只消费对应流 |
| 旧回复/事件 | generation + run 身份拦截；迟到的本轮 Exit 仍优先于 attach reply | generation + attachment + run 身份拦截，resync 同步失效旧回调 |
| working / needs_input / idle | 保留按 run/sequence 单调合并 | 把当前 run 的状态、退出投影回 Session，拒绝旧 sequence |
| 尺寸归属 | 换 run 时清除旧归属与暂停标记 | 旧 revision 不回退归属；尺寸回复不能把 ended/reconnecting 改成 live |
| 操作失败/未知结果 | 不通过同步逻辑重新发送生命周期操作 | Stop/Restart 不自动重试；保留已有失败/未知结果行为 |

后端两个 `session-exit` 发布点均携带 runId/runOrdinal。Session 快照的 lifecycle、
hostAlive 与 status 一起遵守已有的 run/sequence 防回退规则。旧 attachment 只按其
服务端 capability 解绑，不能移除新 writer。

## 桌面短暂断连恢复

Host socket 暂时不可用不等于 Agent 已退出。此前桌面 `attachHandle` 失败或收到
`detached` 后只显示提示，没有自动重试；后台 monitor 恢复连接也不会让同一 run、
同一 lifecycle 的 TerminalPane 再次 attach，提示因此可能滞留。

- 可见且仍为 running/creating 的终端自动重试 attach，间隔为 500ms、1s、2s、4s，
  之后最多每 5s 一次；一次只允许一个待执行重试或连接请求。
- 保留当前终端与连续输出游标，恢复后清除断连错误；不重发输入、不执行 Restart/Stop。
- 隐藏、释放、重置或退出后停止旧重试；回调执行前再次核对 handle、generation 和生命周期。
- `detached` 立即失效旧 channel generation，迟到的 invoke 回复只能解绑它自己的 attachment。
- 真正持续不可达时仍保留错误与手动重连/诊断入口，不把缓存内容视作活连接的证据。
- 覆盖在终端上的提示条以不透明底色承载半透明 tint，避免终端文字透出、与提示重叠。

回归覆盖首次连接失败、连接中断后的游标续接、退避上限、退出/隐藏/释放/重置取消，
以及旧 channel 与迟到 attach 回复。原实现的四项自动恢复回归均先失败，再修复通过。
本次只含任务改动的暂存候选通过 Desktop 552 项测试及 TypeScript 检查；Debug App
重新构建、签名、打开并截图确认非白屏。未人为中断用户的 Host 来制造断连，故障顺序
由模拟连接/Channel 的回归测试验证。

## 验证

- 新增回归先复现旧行为：旧 exit 卡住新连接、跳过 stopped 的快速 restart、
  未聚焦分屏的卡片不更新、旧快照/退出回退生命周期、外来 attachment 关闭当前窗口。
- Desktop 542 项、Mobile 242 项前端测试通过，两端 TypeScript/Vite 构建通过。
- Rust `stale_attachment_id_cannot_remove_a_newer_writer` 通过。
- 重新签名并打开 checkout 独立 Bundle ID 的桌面 Debug App；核验 GUI 可执行路径，
  截图确认窗口正常渲染。iPhone Debug App 重新安装并启动，Inspector 确认页面可见、
  无错误提示。
- 没有停止任何用户现有 Session/Host，也没有操作发布版 GUI。为避免中断工作，
  本次没有对用户正在运行的 Session 执行跨端 Stop/Restart；竞态顺序由回归测试验证。
