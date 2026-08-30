# Task Plan: 终端 Session 分屏工作区

- Created: 2026-08-30
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 2026-08-30 用户确认的“终端区域分屏”共同理解摘要与最终需求简报

<!-- task-doc-section:background-goal -->
## Background and goal

AgentPort 当前以一个 `activeSessionId` 驱动单一终端/结构化时间线视图。目标是在不改变 Session 后端生命周期语义的前提下，引入一个可持久化的递归 pane 工作区：每个叶子 pane 唯一绑定一个侧栏 Session，支持向右/向下切分、拖入或移动现有 Session、分隔线调节、工作区内最大化、仅从视图移除，并让所有可见 PTY/JSON-RPC Session 持续工作。最终交付必须保持单 pane、文档面板、剪贴板菜单、未读确认和现有终端渲染行为兼容。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### Scope

- 新增二叉递归 pane 布局模型、结构变换、失效 Session 清理和本机持久化。
- 将 session 选择语义改为“布局内聚焦、布局外独立”，同步所有布局内 PTY attachment。
- 复用完整 New Session 表单完成“新建并向右/向下分屏”。
- 支持侧栏 Session HTML5 拖放、双方向落点、布局内 Session 移动和次级入屏标记。
- 递归渲染 PTY 与 JSON-RPC pane、紧凑标题栏、焦点、右键菜单、最大化、移除、可拖动/键盘可操作的分隔线和最小尺寸门禁。
- 保留共享文档面板；搜索、重启、跳到最新等既有全局操作继续作用于聚焦 Session。
- 增加中英文文案、单元/组件/集成回归验证，重建并打开 macOS 调试 App，截图确认非白屏，创建仅包含本任务改动的 Git commit。

### Non-goals

- 多个可保存工作区、布局历史或标签组。
- 同一 Session 在多个 pane 镜像显示。
- 系统原生全屏、每 pane 独立文档面板、四方向插入或按拖入边缘自动决定方向。
- 快捷键自定义或关闭 pane 的默认快捷键。
- 关闭 pane 时停止、归档或删除 Session。
- 修改后端 Session/PTY 协议或处理当前工作区中与本功能无关的远程输入改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户已确认向右/向下递归切分、50/50 初始比例、320×180 最小尺寸、跨项目混排、布局内聚焦/布局外独立、完整持久化、工作区内最大化、关闭仅移出视图等行为。 | 本会话中已确认的最终需求简报。 |
| F-002 | 当前终端工作区只根据 `activeSessionId` 展示一个 PTY 或一个 `PiStructuredTimeline`，PTY pane 通过 hidden 切换。 | `src/src/components/TerminalArea.tsx` 的 `TerminalArea` 与 `TerminalPane`。 |
| F-003 | 当前选择逻辑把 PTY attachment 当作容量为 1 的 LRU；JSON-RPC 不进入 xterm attachment。 | `src/src/actions.ts` 的 `selectSession`；`src/src/terminals.ts` 导出的 `MAX_PERSISTENT_TERMINALS = 1`。 |
| F-004 | `AppState` 已集中维护 `activeSessionId`、`attachedIds`、文档面板、搜索和对话框状态，且已有 localStorage UI 状态持久化惯例。 | `src/src/store.ts` 的 `AppState`、`initialState`、Project 展开持久化。 |
| F-005 | 完整 New Session 表单已支持项目、worktree、Agent、标题、Preset 与权限，但创建成功后固定调用 `selectSession`。 | `src/src/components/NewSessionDialog.tsx`。 |
| F-006 | PTY 右键菜单当前由 `terminals.ts` 提供复制、粘贴、全选和查找；新增 pane 菜单必须保留这些能力。 | `src/src/terminals.ts` 的 `installClipboardCompatibility`。 |
| F-007 | JSON-RPC Session 由 `PiStructuredTimeline` 自己 attach/detach，组件可按 Session 独立挂载。 | `src/src/components/PiStructuredTimeline.tsx`。 |
| F-008 | 仓库已有针对 actions、TerminalArea、NewSessionDialog、Sidebar、i18n 和 CSS 契约的 Vitest/jsdom 测试，并提供 `npm run build` 与 `npm run i18n:check`。 | `src/package.json` 与 `src/src/**/*.test.*`。 |
| F-009 | 当前工作区已有未提交的、与本任务无关的修改。 | `git status --short`：`LEARNS.md`、`src/src/terminals.ts`、`src/src/terminals-renderer.test.ts`。 |
| F-010 | UI/App 行为变更交付前必须重建调试 App、只关闭目标 debug GUI、重新打开、核对进程路径并截图确认，验证后必须提交任务相关改动。 | `/Users/w/Projects/AgentSessions/AGENTS.md`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption A-001: 使用版本化 localStorage 保存当前 pane 树、比例和焦点即可满足“重启恢复”；影响是布局仅在本机当前用户配置中持久化。验证方式：模块重载与损坏/失效 Session 测试。
- Assumption A-002: 使用带稳定 split ID 和比例的二叉树是满足递归向右/向下切分及 unary collapse 的最小完整模型。验证方式：纯函数变换测试覆盖 split/move/remove/resize/sanitize。
- Assumption A-003: 最大化为 transient UI 状态，不写入持久化；所有布局内 attachment 仍保持连接，只有可见 PTY 参与 fit。验证方式：组件测试与调试 App 手工切换。
- Assumption A-004: 窗口缩小可暂时使既有 pane 低于 320×180；门禁只阻止新的切分，分隔线拖动按当前轴向最小尺寸夹紧。验证方式：尺寸判定和 separator 测试。
- Assumption A-005: 当前未提交的 `terminals.ts`/renderer/LEARNS 改动属于用户已有工作，必须保留且不得进入本任务 commit；本功能优先通过 TerminalArea 捕获右键来避免修改该脏文件。验证方式：提交前比较初始 diff 与 staged diff。
- Open question: None；所有会 materially 改变范围或行为的决策已由用户确认。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- AC-001: 任意叶子 pane 可通过右键或固定平台快捷键向右/向下新建 Session；表单取消/失败不改布局，成功后新 pane 聚焦。
- AC-002: 任意侧栏 Session 可拖到目标 pane 的“向右/向下”覆盖区；布局外 Session 被加入，布局内 Session 被移动，同一 Session 永不重复。
- AC-003: 分隔线支持指针和键盘调整，初始 50/50，比例持久化；不能创建小于 320×180 的新 pane。
- AC-004: 多个 PTY/JSON-RPC pane 同时保持实时连接；只有聚焦 Session 接收键盘焦点并清除未读，侧栏区分 focused 与 in-layout。
- AC-005: 点击布局内 Session 聚焦；点击布局外 Session 丢弃旧布局并独立显示；编号切换和通知跳转复用同一规则。
- AC-006: 最大化只隐藏其他 pane 并保留应用框架；可直接切换最大化 Session；再次切换恢复；最大化时切分退出最大化。
- AC-007: 移除 pane 不停止 Session，树正确折叠；移除最后 pane 后为空；随后点击该 Session 独立打开。
- AC-008: 重启恢复有效 pane 树、比例和焦点；删除/归档 Session 被剪除且 unary 节点折叠；全部失效为空。
- AC-009: PTY 右键仍提供复制、粘贴、全选、查找，同时增加切分/最大化/移除；共享文档面板与聚焦 Session 协作。
- AC-010: 中英文、焦点/ARIA、单 pane 和现有终端 fit/滚动/剪贴板行为通过自动化和调试 App 验证。
- AC-011: 所有验证通过后存在一个仅包含本功能与本任务文档的 Git commit，初始未提交用户改动保持未提交且内容不被覆盖。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> {T-003, T-004} -> T-006`; `T-005 -> T-006`; `T-003` 与 `T-004` 都依赖 `T-002` 提供稳定 action/drag contract。
- Parallel batches:
  - Batch 1: T-001（布局模型/Store）与 T-005（i18n）并行。
  - Batch 2: T-002（选择、创建、快捷键与 action contract）。
  - Batch 3: T-003（Sidebar drag source/marker）与 T-004（Terminal workspace/drop target/rendering）并行，文件所有权不重叠。
  - Batch 4: T-006（协调者集成、回归、调试 App、提交）。
- Serialization constraints: `store.ts` 先由 T-001 建立布局状态，再由 T-002 串行地仅扩展 new-session dialog descriptor；`actions.ts`/`App.tsx`/`NewSessionDialog.tsx` 仅由 T-002 修改；`Sidebar.tsx` 仅由 T-003 修改；`TerminalArea.tsx`/`styles.css` 仅由 T-004 修改；authority document 仅由协调者修改。当前脏文件 `LEARNS.md`、`terminals.ts`、`terminals-renderer.test.ts` 不分配给任何 writer。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立 pane 布局模型、持久化与 Store 权威状态

- Status: done
- Owner: layout-core-retry
- Objective: 提供可验证的递归布局数据模型及 Store 集成，成为后续 UI/action 的唯一布局权威。
- Inputs and prerequisites: F-001、F-003、F-004；用户确认的持久化和唯一 Session 规则。
- Scope or files: `src/src/paneLayout.ts`（新）、`src/src/paneLayout.test.ts`（新）、`src/src/store.ts`。
- Expected output: split/move/remove/ratio/sanitize/contains/leaf-order/persistence API；`AppState` 布局与 transient maximize 字段；Project snapshot 清理失效叶子并恢复焦点/PTY attachments。
- Dependencies: None.
- Execution steps:
  1. 定义版本化二叉 pane 类型、方向、常量和纯变换。
  2. 实现防重复、失效剪枝、unary collapse、稳定 split ID 与持久化解析边界。
  3. 把持久化工作区接入 Store 初始化及 Project snapshot/session cleanup。
  4. 添加纯函数、损坏持久化和恢复测试。
- Acceptance criteria:
  - 变换不会制造重复 Session，move/remove 选择合理邻近焦点，ratio 合法。
  - 损坏、过深、重复或失效持久化不会破坏启动。
  - Store 可从有效布局恢复 active Session 和全部布局内 PTY ID。
- Verification method:
  - `cd src && npm test -- paneLayout.test.ts actions-state-authority.test.ts`
  - `cd src && npx tsc --noEmit`
- Validation evidence: Coordinator inspected commit `81573e6f6325b55697884796813bad9d5387c113`, applied only the three owned paths, and ran `cd src && npm test -- paneLayout.test.ts actions-state-authority.test.ts actions-session-selection.test.ts project-expansion-persistence.test.ts` (4 files, 37/37 tests passed), `cd src && npx tsc --noEmit` (exit 0), and scoped `git diff --check` (exit 0). Initial subagent attempt failed path audit because it created an ignored node_modules artifact; retry removed that approach and passed owned-path audit.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现 Session 选择、pane actions、新建流程与全局快捷键

- Status: done
- Owner: coordinator
- Objective: 将现有选择和新建流程接到布局权威状态，并提供 UI 可调用的稳定操作 contract。
- Inputs and prerequisites: T-001 输出；F-003、F-005；已确认快捷键和焦点语义。
- Scope or files: `src/src/actions.ts`、`src/src/App.tsx`、`src/src/store.ts`（仅扩展 new-session dialog descriptor）、`src/src/components/NewSessionDialog.tsx`、`src/src/paneSessionDrag.ts`、`src/src/paneShortcuts.ts`（新）及对应 actions/App/NewSession/drag/shortcut 测试；必要的现有 App 测试 mock。
- Expected output: 布局内 focus/布局外 singleton selection；所有布局内 PTY attachment 同步；open split dialog、split/move、close、maximize、ratio、尺寸门禁 API；创建成功定向插入；macOS/Linux 快捷键；Session drag payload contract。
- Dependencies: T-001.
- Execution steps:
  1. 重构 `selectSession`，保留 stale snapshot intent、recovery、seen 和 sidebar reveal 语义。
  2. 实现 split/move/close/maximize/resize/open-dialog actions 与 attachment release。
  3. 扩展 NewSession dialog descriptor 和成功回调路径。
  4. 增加平台快捷键并更新受影响测试 mocks。
  5. 添加 action、创建流程、拖放 payload 和快捷键回归测试。
- Acceptance criteria:
  - AC-001、AC-005、AC-006、AC-007 的状态变换通过测试。
  - split 取消/失败保持布局，成功后只出现一次且聚焦。
  - 初始脏 `terminals.ts` 不被修改。
- Verification method:
  - `cd src && npm test -- actions-session-selection.test.ts components/NewSessionDialog.test.tsx paneSessionDrag.test.ts App.notification.test.tsx`
  - `cd src && npx tsc --noEmit`
- Validation evidence: Coordinator implemented and inspected the serialized action/dialog/hotkey path, then ran `cd src && npm test -- actions-session-selection.test.ts components/NewSessionDialog.test.tsx paneSessionDrag.test.ts paneShortcuts.test.ts` (4 files, 21/21 passed), `cd src && npm test -- App.notification.test.tsx App.native-cleanup.test.tsx App.git-center-mount.test.tsx` (3 files, 7/7 passed), `cd src && npx tsc --noEmit` (exit 0), and scoped `git diff --check` (exit 0). Tests cover layout-in focus/all PTYs, layout-out singleton release, split/move/remove/maximize/ratio, min size, typed dialog success/fallback, dedicated MIME, and exact platform combos including plain Ctrl+D pass-through.
- Blocker: None.
- Unblock condition: T-001 done.

### [x] T-003 — 实现侧栏 Session 拖动源与入屏标记

- Status: done
- Owner: coordinator
- Objective: 让任何侧栏 Session 可作为 pane 拖动源，并清楚区分 focused 和已在分屏中的非聚焦 Session。
- Inputs and prerequisites: T-002 的 drag payload contract、布局选择器和 action 语义。
- Scope or files: `src/src/components/Sidebar.tsx`、`src/src/sidebar-session-pane-drag.test.tsx`（新）。样式类由 T-004 在 `styles.css` 统一提供。
- Expected output: 不破坏点击、双击重命名、快捷操作和项目排序的 Session row drag source；in-layout 标记及 ARIA 描述。
- Dependencies: T-002.
- Execution steps:
  1. 为非编辑 Session row 增加专用 MIME dragstart/dragend。
  2. 从布局状态计算次级 in-layout class/marker，focused 仍只有一个。
  3. 添加点击与拖动不冲突、payload、标记状态组件测试。
- Acceptance criteria:
  - 跨项目/跨 worktree Session 均可生成正确 payload。
  - active row 强高亮；其他布局成员仅显示次级标记。
  - 原有 row 菜单、重命名、pin/archive 操作不回归。
- Verification method:
  - `cd src && npm test -- sidebar-session-pane-drag.test.tsx sidebar-project-layout.test.tsx sidebar-plus-menu.test.tsx`
- Validation evidence: `cd src && npm test -- sidebar-session-pane-drag.test.tsx sidebar-plus-menu.test.tsx sidebar-project-layout.test.tsx` passed 3 files / 17 tests; the new tests verify active vs secondary in-layout marker, dedicated MIME payload, drag class cleanup, click coexistence, and editing drag disable. `cd src && npx tsc --noEmit` and `git diff --check` passed. T-004 supplied the agreed marker styles without modifying Sidebar ownership.
- Blocker: None.
- Unblock condition: T-002 done.

### [x] T-004 — 实现递归 TerminalArea、drop target、标题栏、分隔线与上下文菜单

- Status: done
- Owner: coordinator
- Objective: 将 pane 树渲染成可操作、多 transport、可 resize/maximize 的工作区，同时保留共享文档面板与终端兼容行为。
- Inputs and prerequisites: T-002 action/drag contract；F-002、F-006、F-007；T-003 约定的 class 名。
- Scope or files: `src/src/components/TerminalArea.tsx`、`src/src/styles.css`、`src/src/components/TerminalArea.split.test.tsx`（新）及必要的 `TerminalArea.uncommitted.test.tsx` mock 更新。
- Expected output: 递归 pane tree、所有可见 PTY attach/fit、JSON-RPC panes、focused chrome、双方向 drop overlay、pointer/keyboard separator、最大化/关闭、保留 clipboard 的 pane context menu、共享 DocumentPanel。
- Dependencies: T-002.
- Execution steps:
  1. 将单 active renderer 改为递归 leaf/split renderer，并区分 visible/focused。
  2. 把 banners/search/overlay/status 放入对应 pane，DocumentPanel 保持工作区共享。
  3. 增加 pane header、右键菜单、最大化/移除按钮和 drag overlay。
  4. 实现 separator 指针/键盘 resize、最小尺寸夹紧和 fit。
  5. 增加完整组件与 CSS 回归测试。
- Acceptance criteria:
  - AC-002、AC-003、AC-004、AC-006、AC-009、AC-010 通过。
  - PTY 右键仍可 copy/paste/select-all/search；不修改脏 `terminals.ts`。
  - 单 pane 不显示额外 chrome，多个 pane/最大化不卸载 Session 组件。
- Verification method:
  - `cd src && npm test -- components/TerminalArea.split.test.tsx components/TerminalArea.uncommitted.test.tsx terminal-attach-veil-css.test.ts`
  - `cd src && npx tsc --noEmit`
- Validation evidence: Final focused UI/CSS run `cd src && npm test -- components/TerminalArea.split.test.tsx components/TerminalArea.uncommitted.test.tsx terminal-attach-veil-css.test.ts` passed 3 files / 25 tests (7 recursive-pane, 14 legacy TerminalArea, 4 overlay CSS tests). Coverage includes nested right/down PTY+JSON panes, all PTYs active, one focus, one shared document panel, max-hidden while mounted, clipboard/search plus pane menu, dedicated drop routing, keyboard separator, chrome-free singleton, and the pane-local overlay cascade. Integration review additionally corrected recursive subtree minimum clamping, maximized-pane restored-size checks, and the overlay selector specificity before the final full suite. Dirty `terminals.ts` and renderer test remained byte-identical to the pre-review snapshot.
- Blocker: None.
- Unblock condition: T-002 done.

### [x] T-005 — 增加 pane 分屏中英文文案与 i18n 契约

- Status: done
- Owner: pane-i18n
- Objective: 为所有新增菜单、按钮、drop zone、提示和 ARIA 文案提供中英文资源。
- Inputs and prerequisites: 用户确认的术语“向右分屏/向下分屏”、既有 shell namespace 资源约定。
- Scope or files: `src/src/locales/zh-CN/shell.json`、`src/src/locales/en-US/shell.json`、`src/src/pane-split-i18n.test.ts`（新）。
- Expected output: 对称、无硬编码用户可见文字的 pane 文案 key，并通过仓库 i18n 检查。
- Dependencies: None.
- Execution steps:
  1. 增加 pane namespace 下的中英文 key。
  2. 添加关键值与语言切换测试。
  3. 运行 i18n 检查。
- Acceptance criteria:
  - 新交互所需文案完整且中英文 key 对称。
  - `npm run i18n:check` 通过。
- Verification method:
  - `cd src && npm test -- pane-split-i18n.test.ts`
  - `cd src && npm run i18n:check`
- Validation evidence: Coordinator inspected commit `c5c16c6c4c19aef936d0d3e45816b822e685396a`, applied only the three owned paths, and ran `cd src && npm test -- pane-split-i18n.test.ts` (1 file, 3/3 tests passed), `cd src && npm run i18n:check` (passed: 2 locales, 6 namespaces, 8 fragments, no untranslated UI literals), `cd src && npx tsc --noEmit` (exit 0), and scoped `git diff --check` (exit 0).
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 集成审查、全量验证、调试 App 可视确认与提交

- Status: done
- Owner: coordinator
- Objective: 对所有任务结果做独立集成检查，修复必要回归，按仓库规则完成可运行交付和隔离提交。
- Inputs and prerequisites: T-001、T-002、T-003、T-004、T-005 均 done；初始 dirty diff 快照。
- Scope or files: 仅集成所需的本任务文件、authority document；不得吸收 F-009 的原有改动。
- Expected output: 自动化、静态、构建、调试 App 和截图证据；最终任务文档；单一 feature commit。
- Dependencies: T-001, T-002, T-003, T-004, T-005.
- Execution steps:
  1. 审查完整 diff、依赖路径、循环 import、DnD 冲突、持久化和 focus/attachment 边界。
  2. 运行 targeted tests、全量前端测试、i18n、TypeScript/Vite build。
  3. 运行 `scripts/rebuild-debug-app.sh`；只关闭目标 debug GUI，`open -n` 重开，核对可执行路径并截图确认非白屏。
  4. 更新任务状态和最终验证，运行 task document validator。
  5. 仅 stage 本任务改动，核对 staged diff，创建 Git commit，再核对原有 dirty files 仍未提交。
- Acceptance criteria:
  - AC-001 至 AC-011 均有当前证据。
  - 所有任务 done、文档 validator 通过、最终验证为 passed。
  - Debug App 路径与截图正确；commit 不包含初始用户改动。
- Verification method:
  - `cd src && npm test`
  - `cd src && npm run i18n:check`
  - `cd src && npm run build`
  - `bash scripts/rebuild-debug-app.sh`
  - `ps` 核对 debug GUI 路径并使用 `screencapture` 生成截图检查。
  - `python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/AgentSessions/docs/tasks/2026-08-30-terminal-session-split-task.md`
  - `git diff --cached --check` 与 `git status --short`。
- Validation evidence: Automated and packaged-App validation passed: final `cd src && npm test` passed 70 files / 443 tests; `npm run i18n:check`, `npm run build` (including `tsc --noEmit`), and `git diff --check` passed. `bash scripts/rebuild-debug-app.sh` rebuilt Host + custom-protocol GUI, installed bundle ID `com.agentport.desktop.debug.c9d007c8147e`, signed and verified the debug bundle. Only exact debug GUI PID 900 was stopped; all `agentport-host` processes were preserved. `open -n` started exact executable PID 8627 at `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`. Window ID 585 was owned by `AgentPort Debug - AgentSessions`; `/tmp/agentport-terminal-split-context.png` (3164×2068, SHA-256 `3a9b1a3a79071e7d278a6a7bcba79434113695a6d85637cf7f88ba63465af755`) visibly showed a rendered two-pane workspace, compact headers, focused marker, divider, sidebar in-layout state, and the preserved clipboard/search plus split/maximize/remove context menu. Explicit staging contained only the 22 task paths, `git diff --cached --check` passed, and initial commit `5376c5b` succeeded without `LEARNS.md`, `terminals.ts`, or `terminals-renderer.test.ts`; the final status-only document update is folded into that same feature commit by amend.
- Blocker: None.
- Unblock condition: T-001 through T-005 done.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. **Pure model:** split/move/remove/duplicate prevention/ratio update/tree pruning/depth and malformed persistence/session restore。
2. **Action integration:** layout-in/layout-out selection、all PTY attachment sync/release、stale refresh intent、seen acknowledgement、split create success/failure、close/maximize、platform hotkeys。
3. **Component behavior:** recursive rows/columns、multi-transport panes、focused chrome、drop zones、move、separator pointer/keyboard、context menu preservation、single-pane compatibility、shared document panel。
4. **Sidebar/i18n:** payload、drag/click coexistence、in-layout marker、双语言 key 和仓库 i18n checker。
5. **Regression gates:** targeted Vitest 后运行完整 `npm test`、`npm run build`；不通过时不得将任务标 done。
6. **App smoke:** 按 AGENTS.md 重建 debug bundle、精确关闭/重开目标 GUI、`ps` 核对路径、截图检查非白屏和分屏入口可见。
7. **Commit isolation:** 以初始 dirty diff 为基准，stage 后确认不包含 `LEARNS.md`、`terminals.ts`、`terminals-renderer.test.ts` 的已有修改；文档与功能文件一并提交。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- R-001: xterm 的 `active` 标志同时影响 ResizeObserver fit；必须区分“可见/参与 fit”和“聚焦/接收键盘”，否则非聚焦 pane 可能黑屏或被错误 resize。
- R-002: 当前 PTY attachment LRU 容量为 1；选择逻辑若只提高常量会引入无界后台保留，正确边界应是“当前布局全部 PTY，布局外释放”。
- R-003: TerminalArea 现有文件/文本 drop 与新增 Session drop 共存，必须以专用 MIME 优先判定，避免把 Session ID 粘贴进终端。
- R-004: 右键由 xterm container capture listener 拦截；TerminalArea 的 capture 菜单必须明确保留 clipboard/search 功能并有回归测试。
- R-005: JSON-RPC pane mount/unmount 会 attach/detach；最大化必须用 CSS 隐藏而非删除 React 子树，避免无谓重放。
- R-006: Store 是跨测试共享单例；新增持久化字段必须在测试中明确重置，避免文件内 case 泄漏。
- R-007: 当前用户改动与终端核心文件重叠，任何格式化、全文件重写或宽泛 staging 都可能污染提交；这些文件列为禁止修改。
- R-008: 调试 App 重建耗时且需要 macOS 窗口级检查；若环境命令失败，T-006 必须 blocked 并记录实际证据，不能假称可视验证完成。
- Current blockers: None.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-30: Task document created in execute mode。
- 2026-08-30: Requirements、repository instructions、current architecture、tests and initial dirty diff inspected；execution graph established，未开始实现。
- 2026-08-30 22:13:16 +0800: T-001 assigned to `layout-core` and T-005 assigned to `pane-i18n`; both moved pending -> in_progress for parallel Batch 1.
- 2026-08-30 22:48 +0800: Initial T-001 writer failed owned-path audit after creating an ignored node_modules artifact; retry `layout-core-retry` succeeded with only owned paths. T-005 writer succeeded.
- 2026-08-30 22:49 +0800: Coordinator integrated/audited both candidate commits. T-001 targeted suite passed 37/37 plus TypeScript; T-005 passed 3/3 plus i18n check; both moved in_progress -> done. An initial coordinator validation invocation from repository root failed because package.json lives under `src`; commands were immediately rerun from `src` and passed.
- 2026-08-30 22:52 +0800: T-002 moved pending -> in_progress and assigned to `pane-actions`; authority document validated before Batch 2 implementation.
- 2026-08-30 22:54 +0800: Repository evidence showed split intent must travel through the typed `DialogState`; T-002 scope was explicitly extended to make only that serialized `store.ts` descriptor change after T-001.
- 2026-08-30 23:22:24 +0800: `pane-actions` writer exhausted the bounded DAG wall-time without a report or integrable commit. T-002 remains in_progress and is reassigned to coordinator; the dependency graph is serial at this point, so coordinator continues within the recorded scope.
- 2026-08-30 23:33 +0800: Coordinator completed T-002, including a small pure `paneShortcuts` contract discovered necessary for exact platform mapping. Targeted action/dialog/drag/shortcut tests passed 21/21, App regressions passed 7/7, TypeScript passed; T-002 moved in_progress -> done.
- 2026-08-30 23:36 +0800: Batch 3 released in parallel: T-003 -> `sidebar-pane-drag`, T-004 -> `terminal-pane-ui`; both moved pending -> in_progress with disjoint owned paths.
- 2026-08-31 00:06:54 +0800: Both Batch 3 writers exhausted bounded token/wall-time budgets without reports or integrable commits. T-003/T-004 remain in_progress and are reassigned to coordinator; their paths are still disjoint and no child changes reached the live checkout.
- 2026-08-31 00:22 +0800: Coordinator completed T-003/T-004. Sidebar suite passed 17/17; recursive TerminalArea suite passed 20/20; combined feature path passed 49/49, i18n/build/TypeScript/diff checks passed. Both tasks moved in_progress -> done.
- 2026-08-31 00:24 +0800: All T-006 dependencies are done; T-006 moved pending -> in_progress for adversarial integration review, full validation, debug App smoke, documentation finalization, and isolated commit.
- 2026-08-31 00:50 +0800: The previously failing `terminal-attach-veil-css.test.ts` passed after avoiding the base-rule regex collision; the first resumed full suite passed 70 files / 438 tests. A mistaken root-level `npm test` invocation failed only because the frontend package lives under `src`; it was immediately rerun from `src`.
- 2026-08-31 01:09 +0800: Adversarial cascade and sizing review found that `:where(.term-overlay)` no longer out-specificed the later base rule and that divider clamping only protected immediate children. New regressions failed before the repair; the final `:is(.term-overlay)` selector, recursive ratio-aware subtree minimums, cross-axis split gate, restored-size check for maximized panes, and late mutation gate passed 42/42 focused tests. The final full suite passed 70 files / 443 tests; i18n, TypeScript/Vite build, diff check, and byte-identity checks for all three pre-existing dirty files passed.
- 2026-08-31 01:13 +0800: `scripts/rebuild-debug-app.sh` completed with the checkout-specific Bundle ID and valid signature. Exact-match process selection stopped only debug GUI PID 900 and preserved every Host; `open -n` started exact debug GUI PID 8627. Window-owner/path probes and two screenshots confirmed a nonblank App; the final screenshot visibly captured the restored two-pane UI and pane context actions.
- 2026-08-31 01:16 +0800: Explicit staging included 22 task-only paths and excluded all three pre-existing dirty files; staged whitespace and status checks passed. Feature commit `5376c5b` was created, T-006 moved in_progress -> done, and this final status record was prepared for a documentation-only amend into the same commit.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 through T-006 are done. The final frontend suite passed 70 files / 443 tests; i18n, TypeScript/Vite build, diff checks, signed debug bundle rebuild, exact-process restart, visible two-pane/context-menu inspection, task-document validation, and isolated feature commit all passed.
- Limitations: Vitest still prints the repository's existing jsdom Canvas and DocumentPanel `act(...)` warnings, but all 443 tests pass; no scoped blocker remains.
