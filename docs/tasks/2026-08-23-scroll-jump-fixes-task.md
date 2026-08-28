# Task Plan: 修复窗口滚动与跳转异常

- Created: 2026-08-23
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求在滚动/跳转审查后执行修复。

<!-- task-doc-section:background-goal -->
## Background and goal

修复已经由代码路径和回归测试模型确认的自动回顶、滚动回拉及跳转不可见问题，并补齐直接覆盖这些行为的回归测试。目标是让 Session 激活、持续输出、恢复时间线定位、文档保存、设置分区切换和侧栏滚轮边界均保留正确的用户视口。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Scope: `src/src/terminals.ts`、终端渲染测试、`DocumentPanel` 及测试、`SettingsDialog` 及测试、`Sidebar` 及测试。
- Scope: 验证工作树中已经存在但未提交的 xterm Session 激活与 write-callback 修复，不覆盖或回退其他用户改动。
- Non-goals: 重构整个终端搜索模型；修改 xterm 上游；更改视觉样式；处理与滚动无关的现有脏工作树改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | HEAD 的 write callback 会把任何 `after.viewportY > target` 当作渲染器跳动，能把用户滚动回拉到旧行或第 0 行。 | `git show HEAD:src/src/terminals.ts` 第 587 行；当前回归场景见 `src/src/terminals-renderer.test.ts:1345-1403`。 |
| F-002 | xterm 的逻辑 viewport 与 DOM `scrollTop` 可在 Session 激活 fit 后不一致；第一次 wheel 会从 DOM 重新计算逻辑行。 | `src/node_modules/@xterm/xterm/src/browser/Viewport.ts:132-199`；当前工作树修复见 `src/src/terminals.ts:1299-1330`。 |
| F-003 | 恢复定位写入目标后的最多 256 KiB 内容，但没有在写队列排空后滚回 marker。 | `src-tauri/src/main.rs:3365-3366,3429-3432`；`src/src/terminals.ts:1615-1633,1848-1862`。 |
| F-004 | 文档保存更新 `doc` 对象，会重新触发依赖 `[mode,targetLine,doc]` 的定位 effect。 | `src/src/components/DocumentPanel.tsx:172-193,238-248`。 |
| F-005 | 快捷 Agent 横向条在横向边界仍无条件 `preventDefault`，会吞掉应传给侧栏的纵向滚轮。 | `src/src/components/Sidebar.tsx:326-336`。 |
| F-006 | Settings 各分区复用同一个可滚动 `.settings-content`，切换时没有重置 `scrollTop`。 | `src/src/components/SettingsDialog.tsx:1508,1531`；`src/src/styles.css:4029-4033`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “执行修复”授权修复上一轮审查中证据充分且可用局部补丁解决的问题；终端搜索的双控制者需要更大的交互契约设计，留作非本次范围并在最终限制中披露。
- Open question: None; 当前范围不需要产品决策即可保持既有交互语义。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Session 重入时逻辑 viewport 与原生 DOM viewport 同步，且无延迟回调覆盖下一次用户滚动。
- 持续输出期间，用户从中间或顶部向下滚动不会被 write callback 拉回。
- 恢复时间线 marker 在相关写入完成后被滚动到可视位置，且 stale handle/generation 不执行定位。
- `path:line` 文档仅对一次打开请求定位；保存、重载不会重新覆盖用户滚动，同一路径的新打开请求仍可重新定位。
- Settings 切换分区后内容从顶部显示。
- 快捷 Agent 条只有真实发生横向滚动时才阻止默认滚轮；在边界允许事件继续冒泡。
- 相关定向测试和前端构建通过；差异不覆盖无关用户修改。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001、T-002、T-003、T-004 独立；T-005 依赖全部实现任务。
- Parallel batches: 不使用并行 writer；当前工作树包含大量用户改动且相关测试文件已有修改，协调者串行执行以避免覆盖。
- Serialization constraints: `terminals.ts` 与 `terminals-renderer.test.ts` 的 T-001/T-002 必须串行；最终验证在全部任务后执行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 验证并收敛终端自动回顶修复

- Status: done
- Owner: coordinator
- Objective: 确认工作树中的 Session 激活同步和 write callback 条件准确修复两条因果链。
- Inputs and prerequisites: F-001、F-002；现有未提交实现和测试。
- Scope or files: `src/src/terminals.ts`、`src/src/terminals-renderer.test.ts`。
- Expected output: 最小且测试覆盖的 viewport 同步与回拉防护。
- Dependencies: None.
- Execution steps:
  1. 审查现有 diff 与上游 xterm 行为。
  2. 运行定向回归测试，必要时仅修改因果相关代码。
- Acceptance criteria:
  - 激活同步、无延迟覆盖、中间滚动和顶部逃离测试通过。
- Verification method:
  - `cd src && npm test -- --run src/terminals-renderer.test.ts`
- Validation evidence: `cd src && npm test -- --run src/terminals-renderer.test.ts` 通过，45/45 tests；现有激活同步和 write-callback 回归均通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 让恢复定位 marker 最终可见

- Status: done
- Owner: coordinator
- Objective: 在 xterm 写队列完成目标上下文后定位到 marker，并防止 stale callback。
- Inputs and prerequisites: F-003；xterm write callback 与 marker API。
- Scope or files: `src/src/terminals.ts`、`src/src/terminals-renderer.test.ts`。
- Expected output: live/ended 共用的 marker 跟踪与最终 reveal。
- Dependencies: None.
- Execution steps:
  1. 先添加 ended recovery 的失败回归测试。
  2. 使用 xterm marker 跟踪行，在上下文写入 sentinel 后定位并释放 marker。
  3. 验证 generation/handle fence。
- Acceptance criteria:
  - marker 在后续内容解析后仍被 `scrollToLine(marker.line)` 定位。
- Verification method:
  - 定向 terminal renderer 测试。
- Validation evidence: 新回归先以 `Expected terminal write callback` 失败；实现 xterm `IMarker` + 写队列 sentinel 后，聚焦测试通过，完整 `src/terminals-renderer.test.ts` 46/46 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 文档定位只响应打开请求

- Status: done
- Owner: coordinator
- Objective: 防止保存或重载更新 `doc` 后重复跳转，同时允许同一路径的新打开请求重新定位。
- Inputs and prerequisites: F-004。
- Scope or files: `src/src/components/DocumentPanel.tsx`、`src/src/components/DocumentPanel.test.tsx`。
- Expected output: 按打开请求身份和已加载目标路径门控的一次性 reveal。
- Dependencies: None.
- Execution steps:
  1. 添加保存后保留 scrollTop 的失败测试。
  2. 添加一次性 reveal 门控并验证新请求行为。
- Acceptance criteria:
  - 保存后用户 scrollTop 不变；初次 path:line 仍定位。
- Verification method:
  - `cd src && npm test -- --run src/components/DocumentPanel.test.tsx`
- Validation evidence: 保存后视口测试先从预期 140 失败为实际 0；加入按打开请求身份和已加载请求路径门控后，`src/components/DocumentPanel.test.tsx` 9/9 通过，并覆盖同一路径新请求再次定位。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 修复设置与侧栏边界滚动

- Status: done
- Owner: coordinator
- Objective: Settings 分区切换回顶；快捷 Agent 条仅在横向位置变化时消费 wheel。
- Inputs and prerequisites: F-005、F-006。
- Scope or files: `src/src/components/SettingsDialog.tsx`、`src/src/components/SettingsDialog.language.test.tsx`、`src/src/components/Sidebar.tsx`、`src/src/sidebar-plus-menu.test.tsx`。
- Expected output: 两个局部事件处理修复及回归测试。
- Dependencies: None.
- Execution steps:
  1. 添加边界 wheel 与分区切换测试。
  2. 实施最小 DOM scrollTop/scrollLeft 条件修复。
- Acceptance criteria:
  - 分区切换 scrollTop=0；横向边界 wheel 未被 preventDefault。
- Verification method:
  - 相关 Settings/Sidebar 测试。
- Validation evidence: Settings 回归先以 scrollTop 240 未归零失败；Sidebar 原生 preventDefault spy 先证实边界仍消费 wheel。修复后 Settings/Sidebar/Project drag 三文件共 19/19 tests 通过，并验证非边界横向滚动仍消费 wheel。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 集成验证与调试 App

- Status: done
- Owner: coordinator
- Objective: 验证相关测试、前端构建和实际调试 App 渲染。
- Inputs and prerequisites: T-001、T-002、T-003、T-004。
- Scope or files: 不新增产品代码；构建产物按仓库脚本生成。
- Expected output: 测试、构建、debug App 路径和非白屏截图证据。
- Dependencies: T-001, T-002, T-003, T-004.
- Execution steps:
  1. 运行定向测试和 `npm run build`。
  2. 执行 `scripts/rebuild-debug-app.sh`。
  3. 仅关闭工作区 debug GUI，`open -n` 重启，确认进程路径并截图非白屏。
- Acceptance criteria:
  - 所有命令通过；debug GUI 来自目标路径且截图正常。
- Verification method:
  - 命令退出码、`ps`、截图。
- Validation evidence: 定向组合测试 79/79 通过；完整 `cd src && npm test` 46 files、280/280 tests 通过（仅有 jsdom 未实现 Canvas 的既有 stderr 警告）；`npm run build` 与 `bash scripts/rebuild-debug-app.sh` 通过；debug GUI PID 53714 的 `comm` 精确为工作区 app 路径；ScreenCaptureKit 截图 `/tmp/agentport-scroll-fix/debug-app.png`（SHA-256 `74121ac6f9716210619ec8847ef2f322013a06f8f1e085b62febbe4e9e8ff39d`）确认窗口正常、非白屏；`git diff --check` 通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先运行每个缺陷的定向测试，再运行组合测试；最后运行 TypeScript/Vite 构建。由于是 UI/App 行为修复，按 `AGENTS.md` 重建并重启 debug App，确认精确可执行路径并截图非白屏。真实滚轮竞态仍以人工复现路径作为补充，不以 jsdom mock 替代所有 WKWebView 风险。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 风险：工作树已有大量未提交用户改动；所有编辑必须精确匹配，禁止格式化或覆盖邻近改动。
- 风险：xterm marker 可因 scrollback trim 被释放；实现必须检查 `marker.line >= 0` 并安全释放。
- 风险：异步定位 callback 可能属于旧 generation；必须沿用 handle/generation fence。
- Blockers: None.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: 创建 execute 任务文档并记录已确认因果链、范围与验证要求。
- 2026-08-23: T-001 设为 in_progress，由 coordinator 串行处理以保护现有脏工作树。
- 2026-08-23: T-001 定向终端测试 45/45 通过，确认现有未提交修复满足激活同步与用户滚动不回拉要求；标记 done。
- 2026-08-23: T-002 设为 in_progress，开始添加恢复 marker 可见性回归。
- 2026-08-23: T-002 回归先失败，随后以 IMarker 跟踪 marker 并在上下文 sentinel 后定位；终端测试 46/46 通过，标记 done。
- 2026-08-23: T-003 设为 in_progress，开始修复文档保存后的重复定位。
- 2026-08-23: T-003 回归先证实保存会把 scrollTop 从 140 改为 0；一次性请求门控实现后 DocumentPanel 9/9 通过，标记 done。
- 2026-08-23: T-004 设为 in_progress，开始处理 Settings 分区和侧栏 wheel 边界。
- 2026-08-23: T-004 两条回归均先失败；局部修复后相关 19/19 tests 通过，标记 done。
- 2026-08-23: T-005 设为 in_progress，开始组合测试、构建和 debug App 验证。
- 2026-08-23: 定向组合测试 79/79、完整前端测试 280/280、前端构建和 debug App 重建均通过；精确 PID/路径和 ScreenCaptureKit 截图确认新窗口非白屏，T-005 标记 done。
- 2026-08-23: 将可复用的 xterm recovery marker 写队列经验合并到 `LEARNS.md`。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-005 全部 done；定向 79/79、全量 280/280、TypeScript/Vite build、debug bundle rebuild、精确进程路径、非白屏截图及 diff check 均有当前证据。
- Limitations: 终端搜索仍同时维护 SearchAddon 与自定义 buffer hit 索引；其交互契约需要独立设计，本次未做推测性重构。真实滚轮竞态由代码级回归覆盖，未通过无障碍自动化驱动真实鼠标手势。
