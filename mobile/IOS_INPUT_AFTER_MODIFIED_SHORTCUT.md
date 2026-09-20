# 修改键快捷键之后输入失效（粘性文本）

## 现象（2026-09-20 用户报告）

终端里输入括号、引号，再按 Ctrl-C 清空输入口（shell 提示符重画）；此后敲任何键
都不再有字符到达终端。

## 根因

`MobileTerminal.inputHandlerRef` 对**带修饰键**的快捷键在发送前调用适配层的
`invalidate()`（`applyShortcutModifiers` 返回的字节与按键不同即视为改写过输入）：

```ts
const next = applyShortcutModifiers(data, { ctrl: controlRef.current, shift: shiftRef.current });
if (next !== data) invalidateIosImeRef.current();
```

`invalidate()` 的语义是"适配层不再拥有 textarea 里的任何文本"：

```ts
observed = textarea.value; ownedStart = observed.length; ghosts = [];
```

但它**不清空 textarea**。Ctrl-C 之前输入法配对留下的未发送尾字符（例如补出的
`）`）仍在字段里，于是这些字符从"未发送文本"变成"看起来已经发送的文本"，而
`reconcile()` 的插入分支要求"光标之后不能有已发送字符"，之后每次输入都被判为
`unproven-edit` 并静默 —— 表现就是"按键全都没反应"。

## 修复边界

`reconcile()` 的**插入**分支不再要求"编辑区域之后没有已发送字符"：

- 只要形状是"一次见证过的、单点纯插入、光标停在插入内容之后"，就把用户真正敲的
  字符发出去——终端是字节流，远程行编辑器自己管光标，粘性文本不该让人变哑。
- **删除**仍然保守：只有"光标在已拥有区域内、且待删字符属于已发送且可安全回退的
  scalar"时才由 DOM 接管发 DEL；未拥有/粘性文本一律不发 DEL（避免过度删除）。
- 配对收尾符的撤回（`lastPadding`）额外要求"它就是终端最后收到的东西"
  （`hasSentAfter`）——撤回是破坏性操作，不能凭空猜测。
- 不重写 textarea 内容、不按时间/整句去重、不改组合输入与粘贴路径。

## 验证

- 新增回归 3 项（`iOS IME text the user never typed`）：
  - `keeps forwarding typed text after a modified shortcut left stale text`（本报告场景，
    改前 `sent=['（','a']`，改后 `['（','a','x','y']`）；
  - `keeps forwarding typed text after the field content was replaced out of band`；
  - `never retracts the typed half of a pair when the user taps in front of it`（改前把
    用户敲的字符吞掉，改后转发且不产生 DEL）。
- 这三项在改动前实现上全部失败，改动后通过；Mobile 全量 462 项测试、真实 Chrome
  渲染回归、`tsc`/`vite` 构建通过。
- 真机复测：付费团队签名 archive + `devicectl device install app`（本次走数据线）
  安装后按上表流程验证通过。

## 真机复测（修复包，2026-09-20）

装上新包后按同一流程重跑（探针记录 `/tmp/ime-probe/ctrl-c-verify.jsonl`，
中文全角模式，Ctrl-C 用快捷键栏的 Ctrl + `c`）：

| t | 到达 Host 的字节 | 含义 |
|---|---|---|
| 62.6s | `（）` | 只打 `(`，配对整段发出 |
| 68.0s | `\x03` | 快捷键栏 Ctrl-C（探针记录该字节，不中断） |
| 89.5s | `abc` | **Ctrl-C 之后敲的字母照样到达**（修复前此处零字节） |
| 93.6s | `“”` | 打 `"` 再得到一对 |
| 95.9s | `\x03` | 再按 Ctrl-C |
| 99.1s | `def` | **仍然到达** |

结论：报告的现象不再复现。修复前同一流程在 Ctrl-C 之后敲什么都没反应；
修复后按键全部转发，且粘性文本不会被误发 DEL（记录里没有多余的 `\x7f`）。

## 未验证与残留

- 字节层无法区分"输入法补出的字符"与"改键前的粘性文本"，两者都按"未拥有"处理：
  只在**插入**上放行，**删除**继续拒绝，因此粘性文本上的退格依赖 xterm 的默认
  DEL（这不是本修复新引入的行为）。
- 本次只验证了 Ctrl-C 触发路径；Alt/Shift 改写的快捷键、paste 与 blur 走同一个
  `invalidate()` 入口，行为应由同一处修复覆盖，但未逐项真机验证。
- 若某输入法在"插入"形状里塞入用户没敲的文本（整词重写、替换），本修复会把它当
  用户文本转发——这种形状此前也在末尾被转发，风险范围未扩大。
