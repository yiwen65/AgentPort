# Task Plan: 修复动态输出回顶

- Created: 2026-08-23
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户报告输出动态刷新时仍自动滚向顶部并要求排查解决。

<!-- task-doc-section:background-goal -->
## Background and goal

修复终端原本在尾部跟随输出时，xterm 写入/重绘异常把 viewport 降到第 0 行却未被恢复的问题；同时建立显式用户滚动意图 fence，并将历史回放 burst 的尾部修复合并为解析完成后的一次操作，避免高频刷过全部历史输出。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Scope: xterm write callback、DOM wheel 意图跟踪、程序化用户导航入口及回归测试。
- Non-goals: 修改 xterm 上游、改变滚动条视觉、重做 Session 搜索或持久化日志。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | `writePreservingViewport()` 在写入前位于底部时立即 `return`，即使写入后 `viewportY === 0 && baseY > 0` 也不修复。 | `src/src/terminals.ts:633-657` 当前实现。 |
| F-002 | 用户报告的触发条件是动态输出刷新，符合 at-bottom write callback 路径。 | 当前用户消息。 |
| F-003 | 直接无条件恢复底部会覆盖写入解析期间的真实用户滚动，因此需要独立于 xterm `onScroll` 的用户输入 revision。 | 既有 `xterm viewport write-restore` 项目经验及此前 mid-write 回归。 |
| F-004 | 历史 burst 中多个 write 在 parser drain 前都捕获同一 stale tail，每个 callback 立即修复会逐次暴露中间尾部。 | 三 write 回归修复前观察到 3 次 `scrollToBottom()`，与用户报告的高频刷历史至尾部一致。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 失败表现为 normal buffer 在写入前尾随、写入后非预期落到第 0 行；回归测试以此作为最小 oracle。
- Open question: None；若真实 App 仍复现，下一步需要采集写入前后 buffer/DOM 诊断，而不是扩大本次补丁。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 写入前位于 normal-buffer 尾部、写入后异常落到第 0 行时，同步恢复 buffer 尾部和 DOM 最大 scrollTop。
- 写入期间发生 wheel、搜索、自定义滚动条等用户导航时，write callback 不覆盖用户意图。
- 多个历史 write 排队时不执行中间尾部修复；parser burst 排空后至多修复一次。
- 已有中间 scrollback、顶部逃离、Session 激活同步测试继续通过。
- 全量前端测试、构建、debug App 重建和非白屏截图通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 串行，相关改动集中在 terminal manager、TerminalArea 和同一测试组。
- Serialization constraints: 保留当前大量未提交用户改动，禁止格式化无关区域。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 尾随输出回顶修复与用户意图 fence

- Status: done
- Owner: coordinator
- Objective: 修复 at-bottom 到 row 0 的首个错误状态，并避免覆盖并发用户导航。
- Inputs and prerequisites: F-001 至 F-003。
- Scope or files: `src/src/terminals.ts`、`src/src/components/TerminalArea.tsx`、`src/src/terminals-renderer.test.ts`、必要的组件测试。
- Expected output: viewport intent revision、DOM wheel tracking、所有用户导航入口标记、write callback 尾部恢复。
- Dependencies: None.
- Execution steps:
  1. 添加动态输出从尾部掉到顶部的失败回归。
  2. 添加用户 wheel 发生时不得恢复的回归。
  3. 实施最小 revision fence 与同步尾部恢复。
- Acceptance criteria:
  - 两条新回归及现有相关回归通过。
- Verification method:
  - 定向 terminal renderer/TerminalArea 测试。
- Validation evidence: 动态写入从 tail 掉到 row 0 的回归先因 `scrollToBottom` 0 次而失败；加入 viewport intent revision、DOM wheel tracking、显式导航标记和同步 buffer/DOM 尾部恢复后，两条新回归通过，terminal 定向套件 54/54、build 和 diff check 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 集成和 Debug App 验证

- Status: done
- Owner: coordinator
- Objective: 全量验证并重启精确 debug GUI。
- Inputs and prerequisites: T-001。
- Scope or files: 不新增产品逻辑。
- Expected output: 测试、构建、diff、进程和截图证据。
- Dependencies: T-001.
- Execution steps:
  1. 运行定向及全量测试、build、diff check。
  2. 重建并精确重启 debug App，截图确认非白屏。
- Acceptance criteria:
  - 验证全部通过。
- Verification method:
  - 命令退出码、精确 `ps`、窗口 PNG。
- Validation evidence: 完整前端测试 46 files、283/283 tests 通过（仅既有 jsdom Canvas stderr）；`npm run build`、`git diff --check`、`scripts/rebuild-debug-app.sh` 通过；debug GUI PID 41914 精确来自工作区路径；窗口截图 `/tmp/agentport-streaming-scroll-fix/debug-app.png` SHA-256 `f7f6edb5dd95709281b10737f66a675b29133cb87f15d2cd423a912c62574266`，确认动态 Session 窗口正常、非白屏。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 合并历史 burst 尾部修复

- Status: done
- Owner: coordinator
- Objective: 消除上一轮逐 write 修复造成的历史输出高频刷屏回归。
- Inputs and prerequisites: F-004、T-002。
- Scope or files: `src/src/terminals.ts`、`src/src/terminals-renderer.test.ts`。
- Expected output: generation-scoped parser sentinel，每个 queued burst 至多一次尾部同步。
- Dependencies: T-002.
- Execution steps:
  1. 用三个 parser callback 复现三次中间 `scrollToBottom()`。
  2. 将尾部修复延后到 empty-write sentinel，并按 generation 合并。
  3. 验证 sentinel 等待期间的 wheel 仍能取消修复。
- Acceptance criteria:
  - burst 回归由 3 次即时修复变为 0 次中间修复、1 次最终修复。
- Verification method:
  - 定向、terminal、全量测试、build、debug App。
- Validation evidence: 红测修复前精确得到 3 次 `scrollToBottom()`；修复后 burst 和 delayed-wheel 回归通过，terminal 56/56、全量 285/285、build、diff、debug rebuild 通过；PID 62011 路径正确，截图 `/tmp/agentport-history-burst-fix/debug-app.png` SHA-256 `5376f7c252b817f15da9398ef9bcb02ad78472f878af5ffe96784aa62610f2ad` 正常非白屏。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先执行红绿回归，再运行 terminal 定向套件、全量 `npm test`、`npm run build`、`git diff --check`，最后执行仓库规定的 debug App rebuild/restart/screenshot。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 风险：若用 `onScroll` 作为用户意图会把渲染器自身跳动也当成用户操作；必须监听实际 wheel/显式 UI 入口。
- 风险：at-bottom 恢复必须同时同步 buffer 和原生 DOM viewport，否则首个 wheel 仍可能回顶。
- 风险：每个 write callback 即时同步尾部会让 queued replay 逐帧刷屏；必须通过 parser sentinel 合并。
- Blockers: None.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: 创建 execute 文档；T-001 in_progress。
- 2026-08-23: 新回归复现 at-bottom callback 提前返回、动态写入后留在 row 0；加入用户意图 fence 和 tail 同步恢复后定向 54/54、build 通过，T-001 done。
- 2026-08-23: T-002 in_progress。
- 2026-08-23: 全量 283/283、build、diff check、debug rebuild 通过；精确进程与窗口截图确认非白屏，T-002 done。
- 2026-08-23: 合并更新 `LEARNS.md` 的 xterm write-restore 经验，补充 tail exemption 失败和 user-intent fence。
- 2026-08-23: 用户报告高频刷历史至尾部；三-write 红测复现 3 次即时修复，generation-scoped sentinel 合并后变为一次最终修复，T-003 done。
- 2026-08-23: terminal 56/56、全量 285/285、build、diff、debug rebuild、PID 和非白屏截图通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-003 全部 done；burst 回归先以 3 次即时修复失败，后以 0 次中间、1 次最终修复通过；定向 56/56、全量 285/285、build、diff、debug bundle、精确 PID 和非白屏截图均通过。
- Limitations: 未通过自动化鼠标在真实 WKWebView 中统计长时间流式输出失败率；当前原始故障由 deterministic parser-queue 回归覆盖。
