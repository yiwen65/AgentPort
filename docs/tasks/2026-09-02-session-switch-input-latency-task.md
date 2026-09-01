# Task Plan: Session 切换后的终端输入延迟

- Created: 2026-09-02
- Workspace: `/Users/w/Projects/AgentSessions`
- Mode: measured debug + fix
- Overall status: passed

## Goal

消除 warm Session 切换后首批终端输入被 replay/invoke 响应阻塞或丢弃的问题，同时保持 Host replay 顺序、attachment capability、generation fence、输入 FIFO 与 `MAX_PERSISTENT_TERMINALS=1`。

## Performance contract

- Workload: 已有 warm terminal checkpoint 的 live PTY Session；切换后立即输入，attach invoke 响应仍可能排在 replay Channel 消息之后。
- User-visible target: 首批输入不再等待 replay/invoke 完成才进入 Host；不丢首字符、不重复、不越过 attachment 建立边界。
- Correctness invariants: replay/live output 顺序不变；只向当前 generation/attachment 写入；退出、detach、失败时不重放缓存输入；独立输入事件保持 FIFO。
- Platform/build: macOS Debug App + WKWebView，当前 dirty worktree；保留全部无关 mobile/UU Remote 改动。

## Baseline and root cause

1. `getOrCreateHandle` 的 `term.onData` 在 `handle.attached === false` 时直接丢弃输入。
2. warm preview 修复使 xterm 可在后台 attach/replay 时提前获得焦点。
3. Rust `attach_session` 先安装 writer、再启动 replay watcher，但 frontend 只在 `invoke<AttachInfo>` resolve 后才设置 `attached=true`。大量 replay Channel 消息可以先占用 WebView 事件队列。
4. Host 将 `HelloOk`、retained replay、后续 live output 放入同一 FIFO；因此应在 watcher 开始转发 replay 前单独发布“writer 已可用”的 attachment capability，而不能跳过 replay 或本地伪造 echo。

Deterministic Red oracle:

```bash
npm --prefix src test -- --run src/terminals-renderer.test.ts \
  -t "accepts input when the attach channel becomes writable before the invoke reply"
```

旧实现结果：FAIL，`sendInput` 0 calls。该测试保持 invoke promise 未 resolve，并在 readiness 前输入，直接覆盖用户报告的切换后首批输入窗口。

## Fix

- Backend 在 writer capability 安装完成后、spawn replay watcher 前，按 Channel 顺序发送 `{ t: "attached", info }`。
- Frontend generation-fence 该消息并立即激活相同 attachment capability，不等待可能排在 replay 后面的 invoke response。
- readiness 前到达的 xterm 输入暂存在 handle；readiness 到达后通过既有 per-Session input queue FIFO flush。
- invoke response 仍作为兼容 fallback，并通过 attachment ID 幂等；exit/detach/attach failure/restart/release 清除待发送输入。
- 不改变 Host replay/live FIFO，不做 optimistic local echo，不增加 renderer retention。

## Acceptance criteria

- [x] Red regression 在旧逻辑下以预期原因失败。
- [x] readiness 前的多个输入与 readiness 后输入按原顺序发送。
- [x] 输入在 invoke reply 未 resolve 时已进入 `send_input`，late reply 不重复发送。
- [x] focused renderer、Session-switch/component tests、frontend build 通过。
- [x] Tauri Rust tests 通过。
- [x] full frontend、i18n、diff checks 通过。
- [x] Debug App exact-path rebuild/restart；Host 不被 signal，窗口非白屏。
- [x] 仅提交本任务 hunks，保留全部无关 dirty-tree 工作。

## Evidence so far

- Red: focused regression failed with `expected spy ... Number of calls: 0`。
- Green: `src/terminals-renderer.test.ts` 100/100。
- Neighbor switch/component tests: 31/31。
- Frontend production build: passed。
- Tauri: 48/48。
- Adversarial review: no correctness blocker；确认 Host replay FIFO、backend readiness-before-watcher、frontend generation fence 与 input FIFO 的因果链。测试已加强为多输入 FIFO + late invoke no-dup。
- Full frontend: 77 files, 512/512；i18n 与 `git diff --check` passed。
- Debug rebuild: `scripts/rebuild-debug-app.sh` passed；exact GUI PID `21940`，window id `5867`，1200×800，截图 `/tmp/agentport-input-latency-debug.png` 非白屏。
- Debug restart 前后 5 个 Host PID/path 完全一致；未 signal `agentport-host`。
- 仅应用 `git diff --cached` 的 detached worktree 复验：frontend 512/512、build、i18n、Tauri 48/48、diff check 全部通过；Rust candidate 使用现有 ignored Debug sidecar symlink 后运行。

## Residual risks

- deterministic Red/Green proves the original queue/capability failure and removes replay/invoke from the input-admission critical path, but macOS denied synthetic keystroke permission (`System Events ... not allowed to send keystrokes` / CG post-event access false)，因此真实 Debug App 的自动化逐键 latency capture 未执行；不把非白屏截图冒充输入 latency benchmark。
- pre-readiness input queue exists only during bounded Host handshake；超大 paste 可暂时增加 renderer memory，正常逐键输入不受影响。
