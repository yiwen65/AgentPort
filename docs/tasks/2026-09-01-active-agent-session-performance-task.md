# Task Plan: 活跃 Agent Session 切换性能优化

- Created: 2026-09-01
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: passed
- Source: 用户报告切换 Session 时短暂显示 “Connecting to Session Host”，要求正常切换低延迟且不显示连接提示，并继续排查优化。

<!-- task-doc-section:background-goal -->
## Background and goal

定位正常活跃 PTY Session 切换时连接遮罩短暂出现的第一处分歧；在不提高 `MAX_PERSISTENT_TERMINALS=1`、不降低 4 MiB replay、不中断 Host、不中断冷启动/恢复遮罩保护的前提下，让已有一致 terminal checkpoint 的 warm switch 立即进入无文案恢复阶段，并在 xterm 实际绘制 checkpoint 后显示内容；attach/replay 继续在后台完成。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：`src/src/terminals.ts`、`src/src/components/TerminalArea.tsx`、`src/src/store.ts` 的 terminal preview 通知、focused frontend tests、最终 Debug App。

非目标：提高隐藏 xterm LRU、保留多个 Canvas renderer、跳过 backend attach/replay、改变 cold attach/restart/resync/recovery 的 solid veil、缩小 replay tail、修改 Session lifecycle 或 Host 协议。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 旧 SessionOverlay 在 `(!replayDone || startupPending) && (attaching || attached)` 时无条件显示含 Connecting 文案的 SkeletonOverlay。 | Red regression `terminal-session-switch.test.ts` 的 warm-checkpoint case 在旧判定下失败：expected `true` to be `false`。 |
| F-002 | 每次真实 attach generation 都重置 `replayDone=false`；该语义必须保留，不能复用旧 generation 的完成状态。 | `src/src/terminals.ts` attach path 与 replay parser-boundary tests。 |
| F-003 | 新 handle 从 LocalStorage 恢复 cursor+1000 行 snapshot，随后只 replay 缺失 suffix。 | `readTerminalSnapshot` / `getOrCreateHandle` / `attachHandle`。 |
| F-004 | LRU=1 是既有 renderer 内存边界；本轮保持 `MAX_PERSISTENT_TERMINALS=1`，解析 snapshot cache 也被限制为相同 cardinality。 | Product constant、cache-eviction regression。 |
| F-005 | Cold attach 的 solid veil 用于隐藏大 replay 的中间绘制，不能全局删除。 | `terminal-attach-veil-css.test.ts`。 |
| F-006 | xterm 5.5 的 parser callback 早于 Canvas `onRender`；仅以 parser drain 去除 veil 仍存在一帧空白/旧画面窗口。 | 安装依赖的 WriteBuffer/RenderDebouncer 顺序、adversarial review、parser-vs-render regression。 |
| F-007 | release 前若直接 reset write coordinator，会丢弃已被 durable cursor 覆盖的 open DEC-2026 frame；仅按 cursor 判断 snapshot 相同也会漏掉 cursorless transient/local output。 | Adversarial review；新增 open-frame release 与 transient-output regressions。 |
| F-008 | Debug App exact-path 重启后 6 个既有 Host PID/path 全部保持不变。 | `/tmp/agentport-warm-switch-hosts-before.txt` vs `...-after.txt` 空 diff。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- “正常切换”指 live PTY Session 已有 parser/renderer-ready handle 或有效持久 snapshot；首次打开、restart、resync、recovery target、无 checkpoint 的 cold attach 仍显示连接 veil。
- warm preview 只改变可见 gating，不跳过 attach/replay；输入仍只在 `attached=true` 后开放。
- 无未决 blocker。真实 App 的观察是像素序列，不把 `screencapture` 调用间隔当成产品 latency benchmark。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- [x] 建立 deterministic FAIL oracle，证明旧逻辑对 warm checkpoint 仍返回 show-overlay。
- [x] warm handle 或有效 snapshot 存在时不渲染 Connecting card；snapshot parser 与 Canvas render 之间仅保留无文案 solid veil。
- [x] cold attach、restart、resync、gap、无效 Pi snapshot、recovery target 仍显示 solid skeleton veil。
- [x] 不提高 renderer LRU；parsed snapshot cache bounded；Session input/attach capability、cursor fence、replay ordering 不变。
- [x] release checkpoint 与 durable cursor 一致，包含 open synchronized output 与 cursorless screen mutations。
- [x] Focused/full frontend tests、build、i18n、diff check 通过；Debug App exact-path 重建/重启，窗口可见且非白屏。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- 两轮独立 adversarial review 在 T-002 期间发现并验证了 release ordering、stale snapshot、cursorless output、cache bound 与 parser-to-render 边界。
- 保留 dirty tree；未 reset/stash/checkout，未 signal 任何 `agentport-host`。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 复现并定位 warm switch overlay

- Status: passed
- Owner: coordinator
- Objective: 固定 warm/cold overlay 判定与 switch 关键阶段。
- Result:
  - 控制链固定为 `selectSession → releaseTerminal(previous) → mountTerminal(next) → snapshot restore → attach → replay_done/parser drain → Canvas render`。
  - 旧 overlay 判定在 warm checkpoint case 明确 Red；cold/restart cases 保持 overlay。
- Validation evidence:
  - `src/src/terminal-session-switch.test.ts`: 4/4。

### [x] T-002 — 实施 warm preview 可见性修复

- Status: passed
- Owner: coordinator
- Objective: 只对可证明可显示的 checkpoint 去除 Connecting 文案并缩短 mount-to-visible 路径。
- Result:
  - `TermHandle.displayReady/displayRenderPending` 将 parser-ready 与实际 `onRender` 分离。
  - persisted warm snapshot 恢复期使用无文案 solid veil；实际 render 后立即揭示；suffix attach/replay 继续后台执行。
  - `releaseTerminal` 在 generation fence/reset 前 materialize open DEC-2026 output，再以 parser drain 形成一致 checkpoint。
  - snapshot revision 覆盖 durable、transient 与 local writes，防止 same-cursor fast path 丢画面。
  - parsed snapshot cache 限制为 `MAX_PERSISTENT_TERMINALS`；run rollover/output gap/resync/restart/recovery 清除 stale warm state。
  - `useLayoutEffect` 在浏览器 paint 前 mount xterm。
- Validation evidence:
  - focused terminal/component/CSS suite: 130/130。
  - 两轮 reviewer：首轮 4 个 blocker + 1 个 render timing risk 均已处理；复审未发现其他 blocker。

### [x] T-003 — 全量与真实 Debug App 验收

- Status: passed
- Owner: coordinator
- Objective: repeated Session switch 验证视觉结果、资源与 Host preservation。
- Result:
  - Full frontend: 76 files, 506/506 tests。
  - Production frontend build、i18n、`git diff --check` 通过。
  - `scripts/rebuild-debug-app.sh` 成功；exact debug GUI PID `55041`，可执行路径为 workspace Debug bundle。
  - CGWindow: window id `3804`, layer 0, 1200×800；最终截图非白屏。
  - 两个方向各 10 张连续 post-click window captures（20 张）均显示完整 terminal 内容；未出现 Connecting card、skeleton card 或空白 frame。Contact sheets: `/tmp/agentport-direct-switch-a-sheet.png`、`/tmp/agentport-direct-switch-b-sheet.png`。
  - Debug restart 的 6 个 Host PID/path 空 diff；另一个紧邻的双向 switch pair 也有空 Host diff（`/tmp/agentport-switch-pair-hosts-{before,after}.txt`）。
- Limitation:
  - 长达约 18 分钟的全部 UI 调测期间，一个旧 Host 自然退出且另一个新 Host 启动（活跃 Session 本身仍在运行任务）；未把该长窗口作为 switch-preservation 证据。重启即时对比与独立的 bounded switch pair 均保持 Host 清单不变。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

已执行：纯 overlay decision Red/Green；renderer/component regressions；full frontend；production build；i18n；diff check；Debug bundle exact-path restart；CGWindow/screenshot；两个方向连续 capture；bounded Host PID/path compare。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 无当前 blocker。
- 像素 capture 证明观察窗口内没有 Connecting/空白，但不是纳秒或百分位 latency benchmark；本轮性能结论限定为删除同步可见的错误 overlay 路径并缩短到 snapshot 的首次实际 render。
- LocalStorage 可禁用或 quota failure；该情况下自然降级为 cold attach solid skeleton，不降低 correctness。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-01: 建立 warm/cold overlay Red oracle，定位 unconditional skeleton gate。
- 2026-09-01: 实施 parser-drained checkpoint、release-time snapshot 与 layout mount。
- 2026-09-01: Full suite 暴露两个 complete module mocks 缺少新 export；补齐并加入 warm component assertion。
- 2026-09-01: 首轮 adversarial review 找到 open DEC frame、gap stale snapshot、transient same-cursor 与 unbounded cache；全部修复并加 regression。
- 2026-09-01: 二轮 review 指出 parser callback 不等于 Canvas render；增加 `onRender` fence 与 silent warm veil。
- 2026-09-01: 130 focused、506 full、build/i18n/diff 通过；Debug App 重建、exact-path 重启、Host compare 与真实像素序列验收完成。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence:
  - Focused: 130/130。
  - Full frontend: 506/506（76 files）。
  - `npm --prefix src run build`: passed。
  - `npm --prefix src run i18n:check`: passed。
  - `git diff --check`: passed。
  - Debug GUI: PID 55041, exact workspace path；CGWindow 3804, 1200×800；非白屏 screenshot。
  - 20-frame two-direction warm switch capture: no Connecting card, no blank frame。
  - Immediate rebuild Host diff and bounded two-switch Host diff: empty。
- Limitations: capture sequence is visual correctness evidence, not a calibrated latency percentile benchmark。
