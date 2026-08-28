# Task Plan: 统一终端搜索滚动控制

- Created: 2026-08-23
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求修复上一轮披露的终端搜索双滚动控制者限制。

<!-- task-doc-section:background-goal -->
## Background and goal

终端搜索一次导航同时调用 SearchAddon 和自定义 `scrollToLine`，两者匹配顺序与可见 buffer 范围不同，可能连续跳转到不同位置。目标是让 SearchAddon 成为当前可见 xterm buffer 的唯一搜索与滚动权威，持久化日志搜索继续独立提供完整历史结果。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Scope: `TerminalArea` 搜索状态/导航、`terminals.ts` 已失去用途的自定义内存搜索 API、对应组件测试。
- Non-goals: 修改持久化日志索引、搜索匹配算法、xterm 上游、其他滚动修复或无关脏工作树改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | `navigate()` 先调用 SearchAddon `findNext/findPrevious`，随后调用 `locateTerminalBufferMatch()`，一次动作有两个滚动写入者。 | `src/src/components/TerminalArea.tsx:470-480`。 |
| F-002 | 自定义 hits 会在 alternate buffer 活跃时先枚举 normal buffer，而 `locateTerminalBufferMatch()` 只能定位 active buffer。 | `src/src/terminals.ts:435-462`。 |
| F-003 | SearchAddon 提供 `onDidChangeResults`，可直接返回其权威的 active index 与 total count。 | `src/node_modules/@xterm/addon-search/typings/addon-search.d.ts:81-91,155-158`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “当前终端”计数应对应 SearchAddon 当前可见 buffer；完整历史仍由 `searchSessionLog` 区域承担。
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 输入和前后导航只由 SearchAddon 改变当前终端 viewport。
- UI 的当前结果序号和总数来自 SearchAddon `onDidChangeResults`。
- 查询清空/关闭时结果状态和 decorations 正确清理。
- normal/alternate buffer 不再维护一套不可定位的并行索引。
- 定向测试、完整前端测试、构建、debug App 重建和非白屏截图通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002。
- Parallel batches: 串行；组件与测试及终端 API 相互依赖。
- Serialization constraints: 工作树已有相关未提交修改，协调者执行精确编辑。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 单一搜索滚动权威

- Status: done
- Owner: coordinator
- Objective: 以 SearchAddon 事件作为当前 buffer 搜索状态，以 SearchAddon 作为唯一导航者。
- Inputs and prerequisites: F-001 至 F-003。
- Scope or files: `src/src/components/TerminalArea.tsx`、`src/src/terminals.ts`、`src/src/components/TerminalArea.uncommitted.test.tsx`。
- Expected output: 删除双导航与失效自定义内存索引，新增回归测试。
- Dependencies: None.
- Execution steps:
  1. 添加一次 Enter 仅调用 SearchAddon、不调用自定义 locate 的失败测试。
  2. 订阅 `onDidChangeResults` 并改造展示状态。
  3. 删除无调用的自定义搜索 API 和类型。
- Acceptance criteria:
  - 单次导航没有第二个 `scrollToLine` 权威；结果计数由 addon 事件驱动。
- Verification method:
  - 定向 TerminalArea 与 terminal renderer 测试。
- Validation evidence: 新回归先因 `locateTerminalBufferMatch` 被调用而失败；改为 SearchAddon `onDidChangeResults` 权威状态并删除并行 buffer 索引后，TerminalArea/renderer 52/52 通过，TypeScript/Vite build 通过，相关符号仅剩测试哨兵 mock。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 集成与 debug App 验证

- Status: done
- Owner: coordinator
- Objective: 验证全套前端并重启精确 debug App。
- Inputs and prerequisites: T-001。
- Scope or files: 不新增产品逻辑。
- Expected output: 测试、构建、进程路径与截图证据。
- Dependencies: T-001.
- Execution steps:
  1. 运行定向、全量测试、构建和 diff check。
  2. 重建、精确重启 debug GUI 并截图。
- Acceptance criteria:
  - 所有验证通过且窗口非白屏。
- Verification method:
  - 命令退出码、精确 `ps`、ScreenCaptureKit PNG。
- Validation evidence: 完整前端测试 46 files、281/281 tests 通过（仅既有 jsdom Canvas stderr）；`npm run build`、`git diff --check`、`scripts/rebuild-debug-app.sh` 通过；debug GUI PID 87071 精确来自工作区路径；窗口截图 `/tmp/agentport-terminal-search-fix/debug-app.png` SHA-256 `f886ae7318706e22e23e6d3e5d709c0dae95c4d1fbfa992a1c464780a55dd0f9`，确认非白屏。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先红绿验证单一导航，再运行相关 terminal suites、完整 `npm test`、`npm run build`、`git diff --check`。最后执行仓库 debug rebuild/restart 流程并确认截图。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 风险：SearchAddon 事件可能在查询清空后晚到；事件处理必须按当前 query 状态清理，卸载时 dispose。
- 风险：移除自定义 buffer 搜索会改变“当前终端”计数口径；保留持久化日志作为完整历史权威。
- Blockers: None.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: 创建 execute 文档；T-001 设为 in_progress。
- 2026-08-23: 回归先证实一次 Enter 触发第二个 locate；实现单一 SearchAddon 权威并删除自定义内存索引。首次 build 暴露测试 mock 的 `never[]` 类型，收窄显式返回类型后修复；定向 52/52 和 build 通过，T-001 done。
- 2026-08-23: T-002 设为 in_progress。
- 2026-08-23: 全量 281/281、build、diff check、debug rebuild 通过；精确进程路径与窗口截图确认非白屏，T-002 done。
- 2026-08-23: 将单一终端搜索 viewport 权威经验追加到 `LEARNS.md`。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001、T-002 全部 done；红绿回归、定向 52/52、全量 281/281、build、diff check、debug bundle、精确 PID 和非白屏截图均通过。
- Limitations: 持久化日志结果仍是独立的完整历史索引，不会直接改变 xterm viewport；这是有意的权威边界。
