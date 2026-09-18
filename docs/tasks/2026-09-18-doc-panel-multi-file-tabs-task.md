# Task Plan: 文档面板多文件查看（标签页+分栏）

- Created: 2026-09-18
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户截图反馈「当前只能同时查看一个文件」，经 clarify-requirements 结构化确认（形态/打开行为/分栏/作用域四项决策 + 摘要确认）

<!-- task-doc-section:background-goal -->
## Background and goal

右侧文档面板当前由 store 单值 `openDocument: {path, line} | null` 驱动，打开新文件即替换旧文件。目标：升级为 VSCode 式**多标签 + 最多左右两栏**的查看/编辑区：

- 标签页：单击文件树/终端链接 → 斜体预览标签（下一次单击替换它）；编辑或双击 → 固定标签；同路径去重直接激活
- 分栏：标签右键「在右侧分栏打开」+ 拖标签到面板右缘，上限 2 栏；每个分栏组各自维护一个预览标签
- 作用域全局共享：切换 Session 标签不变，文件树仍跟随活动 Session 的 cwd
- 每栏保留现有全部能力：Raw 编辑（行号、⌘S、脏标记、关闭确认）、Markdown/文本 Preview、选区引用、重载、在文件管理器中显示

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**范围内（桌面端 `src/` 前端）：**

- store 状态结构：`openDocument` 单值 → 标签组/分栏结构（含活动组、活动标签、pendingLine）
- `documents.ts` 打开/关闭/固定/移动/重排逻辑，脏检查器从单例 → 按标签
- `DocumentPanel.tsx`：每组分栏（标签条 + 内容区），共享工具条作用于活动组，拖拽重排/分栏，标签右键菜单
- `DocumentTree.tsx`：单击预览/双击固定/右键「在右侧分栏打开」；选中高亮跟随活动标签；重命名/删除联动标签
- 受影响消费者更新：`fontZoom.ts`、`TerminalArea.tsx`
- i18n（en-US + zh-CN）与对应测试

**明确排除（已与用户确认）：**

- 移动端（mobile/）
- 标签持久化到磁盘（重启清空，与现状一致）
- 文件外部变更自动监听（保持手动重载）
- 3 栏及以上；仅垂直（左右）分栏
- 后端（Rust）改动：现有 `readSessionDocument`/`writeSessionDocument` 等 API 已够用

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | `openDocument` 为全局单值 `{path, line} \| null`，非按 Session；初始 null 不持久化 | `src/src/store.ts:308,436` |
| F-002 | DocumentPanel 本地组件态持有 doc/draft/mode/selection，切文件即重置；脏检查经 `registerDocumentDirtyChecker` 单例上报 | `src/src/components/DocumentPanel.tsx`、`src/src/documents.ts` |
| F-003 | 文件树单击文件即 `openDocumentTarget`（替换当前）；重命名/删除已对 `openDocument` 做联动 | `src/src/components/DocumentTree.tsx` |
| F-004 | 其他消费者：`fontZoom.ts:52`（`openDocument !== null \|\| explorerOpen`）、`TerminalArea.tsx:1312`（`docPanelExpanded && openDocument !== null`）；打开入口另有 `terminals.ts:1008`、`gitCenter.ts:749` | rg `openDocument` 输出 |
| F-005 | 通用右键菜单 `openContextMenu(x, y, items)` 已存在，支持 separator/danger | `src/src/store.ts:600`、`DocumentTree.tsx` 用法 |
| F-006 | 测试栈 vitest + Testing Library；`npm test`（vitest run）、`npm run build`（tsc --noEmit && vite build）、`npm run i18n:check` | `src/package.json` |
| F-007 | 现有 doc 面板契约测试：`documents.test.ts`、`DocumentPanel.test.tsx`、`DocumentTree.test.tsx`、`doc-panel-*-css.test.ts`（body/expanded/header/tree-only/doc-preview-select/doc-tree-sidebar） | `ls src/src` |
| F-008 | i18n 为嵌套 JSON 片段：`locales/fragments/{en-US,zh-CN}/shell-ui.json` 内含 `ui.document.*` | rg 输出（zh-CN shell-ui.json:143-169） |
| F-009 | 调试交付流程：必须 `python3 scripts/restart-debug-app.py` 重启调试窗口并截图确认非白屏；完成后创建 git commit | `AGENTS.md` 仓库规则 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 预览标签一旦被编辑立即转为固定标签（因此预览标签永远干净，替换它无需确认）——VSCode 语义；影响：简化脏确认流。验证：行为测试。
- Assumption: 最后一个标签关闭后面板回到「仅文件树」状态（等价现 `closeDocument`）。验证：面板测试。
- Assumption: 支持同栏内拖拽重排与跨栏拖拽移动；`docPanelExpanded` 作用于整个面板。验证：面板测试。
- Assumption: 终端文件链接打开到「活动分栏组」，`:line` 跳转保持现状（pendingLine 一次性消费）。验证：documents 单测。
- Assumption: 每标签运行时状态（已加载内容/draft/mode/selection）不放全局 store，由面板侧按 tabId  keyed 管理，避免每次击键通知全部 store 订阅者。验证：编辑一个标签后切换再切回，draft 保留。
- Open question: 无（四项关键决策已经用户确认）。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 可同时打开多个文件标签：单击=预览标签（斜体，可被下一次单击替换），编辑/双击=固定；同路径去重激活
- 至多左右两栏：右键「在右侧分栏打开」或拖标签到右缘创建第二栏；每栏独立预览标签、独立活动标签；栏间可拖拽移动标签；空栏自动收合
- 每标签独立 Raw/Preview、draft、脏标记；切标签 draft 不丢；关闭脏标签弹确认；⌘S 保存当前活动标签
- 工具条（模式/保存/引用/展开/重载/定位/关闭）作用于活动组活动标签；文件树选中态跟随活动标签；树内重命名/删除正确联动标签
- `npm test`、`npm run build`、`npm run i18n:check` 全绿；CSS 契约测试同步更新
- 调试窗口经 `scripts/restart-debug-app.py` 重启并截图确认非白屏；git commit 仅含本任务改动

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → T-003 → T-004 → T-005 → T-006（全线串行）
- Parallel batches: 无；状态结构是后续一切的前置，且多个任务共享同一批文件
- Serialization constraints: `store.ts`/`documents.ts`/`DocumentPanel.tsx`/`DocumentTree.tsx`/样式与测试文件均被多个任务触及，必须串行；由 coordinator 顺序执行

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 状态层与打开逻辑改造（store + documents）

- Status: done
- Owner: coordinator
- Objective: 用「标签组 + 分栏」模型替换 `openDocument` 单值，实现预览标签语义与 dirty 按标签管理
- Inputs and prerequisites: 已确认的四项决策；F-001~F-005
- Scope or files: `src/src/store.ts`、`src/src/documents.ts`、`src/src/fontZoom.ts`、`src/src/components/TerminalArea.tsx`（仅可见性判断两处）
- Expected output: `DocumentTab{id,path,pinned,pendingLine}`、`docGroups: DocumentGroup[]`（1~2 组，含 tabs/activeTabId）、`activeDocGroupIndex`；`openDocumentTarget`/`closeDocumentTab`/`pinDocumentTab`/`splitTabToRight`/`moveTab`/`reorderTab`/`setActiveDocTab`/`setActiveDocGroup`/按标签 dirty registry；两个可见性消费者改用派生判断
- Dependencies: None.
- Execution steps:
  1. store：定义类型与初始值（`docGroups: []`、`activeDocGroupIndex: 0`），保留 explorer/docPanel* 字段
  2. documents.ts：实现打开（去重→激活并写 pendingLine；否则进活动组替换其预览标签）、关闭（空组收合、末标签关闭回到树态）、固定、右分栏（2 栏上限）、组间移动、组内重排
  3. dirty registry：`registerDocumentDirtyChecker(tabId, checker)` + `isDocumentTabDirty(tabId)`；关闭脏标签前确认
  4. fontZoom/TerminalArea 改用 `docGroups` 派生可见性
- Acceptance criteria:
  - 新 API 单测覆盖：预览替换/编辑固定/去重激活/二栏上限/空组收合/末标签关闭/dirty 确认
  - `tsc --noEmit` 通过（面板/树暂以兼容层编译或同步改完）
- Verification method: `cd src && npx vitest run src/documents.test.ts`（新/改测试），`npx tsc --noEmit`
- Validation evidence: `npx vitest run src/documents.test.ts` 25/25 通过（新增 15 个标签组逻辑用例：预览替换/固定/去重/分栏/上限/收合/重排/脏确认/删除级联/重命名 rekey/pendingLine）；`npx tsc --noEmit` 源码零错误（仅测试文件待 T-005）。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — DocumentPanel 多标签 + 分栏 UI

- Status: done
- Owner: coordinator
- Objective: 面板重构为每栏「标签条 + 内容区」，共享工具条作用于活动组；每标签独立运行时状态
- Inputs and prerequisites: T-001 完成
- Scope or files: `src/src/components/DocumentPanel.tsx`、`src/src/styles.css`
- Expected output: 标签条（预览斜体、脏点、关闭钮、双击固定、右键菜单：固定/关闭/在右侧分栏打开、拖拽重排/跨栏/右缘分栏）、双栏布局与活动组指示、工具条绑定活动组、⌘S/引用/重载/定位按活动标签；运行时状态按 tabId keyed（切标签保留 draft/mode/selection）
- Dependencies: T-001
- Execution steps:
  1. 抽 DocGroupView：标签条 + body（raw 编辑器/preview），状态按 tabId 存模块级 Map
  2. 共享工具条改为读取活动组活动标签；面板可见性改为 `docGroups 非空 || explorerOpen`
  3. 标签交互：单击激活、双击固定、中键/✕关闭（脏确认）、右键菜单、HTML5 拖拽（重排/跨栏/右缘新建栏）
  4. CSS：标签条、斜体预览、活动组高亮、双栏分隔
- Acceptance criteria:
  - 单栏时外观/交互与现状基本一致（文件名进标签）；双栏时两组独立操作
  - 脏标签关闭弹确认；预览标签斜体且被替换无确认
- Verification method: `npx vitest run src/components/DocumentPanel.test.tsx` + 相关 CSS 契约测试
- Validation evidence: `DocumentPanel.test.tsx` 19/19 通过（含 5 个新用例：标签渲染斜体/编辑固定+切标签 draft 保留/双击固定/脏标签关闭确认/分栏+收合）；doc-panel CSS 契约 6 文件 14/14 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — DocumentTree 联动

- Status: done
- Owner: coordinator
- Objective: 树与新标签模型联动：单击预览、双击固定、右键「在右侧分栏打开」、选中态/重命名/删除联动
- Inputs and prerequisites: T-001、T-002 完成
- Scope or files: `src/src/components/DocumentTree.tsx`
- Expected output: 文件行单击→`openDocumentTarget`（预览）；双击→固定打开；右键菜单新增「在右侧分栏打开」（文件）；选中高亮=活动标签路径；重命名后更新对应标签 path；删除文件/目录时关闭对应标签
- Dependencies: T-001, T-002
- Execution steps:
  1. openPath 改为读活动组活动标签路径
  2. 行交互：onClick 预览 / onDoubleClick 固定 / 右键菜单加分栏项
  3. 重命名联动改为「更新打开中的标签路径」；删除联动改为「关闭匹配标签（含目录前缀）」
- Acceptance criteria: DocumentTree 测试更新后通过；三种联动行为有测试
- Verification method: `npx vitest run src/components/DocumentTree.test.tsx`
- Validation evidence: `DocumentTree.test.tsx` 11/11 通过（右键菜单新增「在右侧分栏打开」断言、重命名/删除联动改为标签模型）。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — i18n 文案

- Status: done
- Owner: coordinator
- Objective: 新增标签/分栏相关文案（中英）
- Inputs and prerequisites: T-002、T-003 中实际使用的 key 已确定
- Scope or files: `src/src/locales/fragments/en-US/shell-ui.json`、`src/src/locales/fragments/zh-CN/shell-ui.json`
- Expected output: `ui.document.*` 新增 key（关闭标签/固定/在右侧分栏打开/标签列表 aria 等），双语齐全
- Dependencies: T-002, T-003
- Execution steps:
  1. 汇总代码中新增 t() key
  2. 双语补齐并跑 i18n:check
- Acceptance criteria: `npm run i18n:check` 通过
- Verification method: `cd src && npm run i18n:check`
- Validation evidence: `npm run i18n:check` 通过（2 locales, 6 namespaces）；新增 closeTab/closeActiveTab/pin/openToSide/moveToOtherGroup/tabs 六键双语，移除死键 close/closeTip。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 测试套件更新与新增

- Status: done
- Owner: coordinator
- Objective: 全部受影响的单测/契约测试更新 + 新行为测试，整套前端测试转绿
- Inputs and prerequisites: T-001~T-004 完成
- Scope or files: `src/src/documents.test.ts`、`src/src/components/DocumentPanel.test.tsx`、`src/src/components/DocumentTree.test.tsx`、`src/src/doc-panel-*-css.test.ts`、新增 `doc-tabs-*` 行为/CSS 测试、`src/src/fontZoom.test.ts`、`src/src/terminals-renderer.test.ts`、`src/src/components/TerminalArea.split.test.tsx`
- Expected output: 测试反映新模型；`npm test` 全绿
- Dependencies: T-001, T-002, T-003, T-004
- Execution steps:
  1. 逐文件更新失效断言
  2. 新增：预览替换/固定/去重/分栏上限/空组收合/dirty 确认/拖拽移动（逻辑层）/CSS 契约
  3. `npm test` + `npm run build`
- Acceptance criteria: `npm test`、`npm run build` 全绿
- Verification method: `cd src && npm test && npm run build`
- Validation evidence: `npm test` 730/731 通过；唯一失败 `terminal-drag-drop-config.test.mjs` 经 `git diff src-tauri/tauri.conf.json` 证实为用户未提交的图标改动（JSON 注释）所致，与本任务无关且不纳入提交。`npm run build`（tsc --noEmit && vite build）通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 调试窗口验证与提交

- Status: done
- Owner: coordinator
- Objective: 按仓库规则重启调试 App、截图确认、创建 git commit
- Inputs and prerequisites: T-005 全绿
- Scope or files: `scripts/restart-debug-app.py`；git commit（仅本任务改动）
- Expected output: 调试窗口运行新构建且截图非白屏；commit 含全部源码/测试/文案/任务文档改动
- Dependencies: T-005
- Execution steps:
  1. `python3 scripts/restart-debug-app.py`
  2. `ps` 确认 GUI 可执行路径为当前 checkout 的 debug bundle；激活窗口并截图确认渲染
  3. `git status` 审查改动集，提交
- Acceptance criteria: AGENTS.md 两条规则（重启验证、任务 commit）满足
- Verification method: 截图人工核验 + `git show --stat`
- Validation evidence: `scripts/restart-debug-app.py` 构建+签名+重启成功（旧 GUI 38672 精确停止，新 GUI PID 60670）；`ps` 确认可执行路径为本 checkout 的 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`；CGWindowList 确认 layer-0 窗口 2027×1226 alpha=1.0（owner "AgentPort Debug - AgentSessions"）在屏且进程稳定存活。**截图内容核验受阻**：本 shell 无录屏 TCC 授权（ScreenCaptureKit -3801、`screencapture` 报 could not create image from display），改为窗口元数据核验，渲染内容未经图像确认。提交 `2f1ba72`（17 文件，+1955/-465）；用户未提交的图标 WIP 经 stash→build→pop 完整恢复，未混入提交。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 单元/组件：vitest（documents 逻辑、DocumentPanel、DocumentTree、CSS 契约、受影响消费者）
- 静态：`npx tsc --noEmit`（随 `npm run build`）、`npm run i18n:check`
- 集成：`npm test` 整套 + `npm run build`
- 实机：`python3 scripts/restart-debug-app.py` 重启调试窗口，`ps` 核验进程路径，截图确认非白屏；手动冒烟：开多标签、预览替换、编辑固定、⌘S、右分栏、拖标签、关闭脏标签确认
- 交付：`git commit` 仅含本任务改动

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 风险：面板重构面大（选择拖拽自动滚动、gutter、引用选区等存量逻辑需按 tabId 重 key），回归风险高 → 缓解：存量行为测试先跑通作为基线，重构后逐条恢复
- 风险：拖拽分栏在 WKWebView 的 HTML5 DnD 手感问题 → 缓解：右键菜单始终可用作兜底；拖拽 drop 指示保持简单
- 风险：`openDocument` 引用点遗漏（如测试外模块）→ 缓解：改完后 `rg openDocument` 全仓复核
- Blockers: 无

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-18: 需求经 clarify-requirements 四项结构化决策与用户确认（标签+可分栏 / 预览标签 / 右键+拖拽上限 2 栏 / 全局共享）；创建任务文档；代码侦察完成（F-001~F-009）。
- 2026-09-18: T-001 开始（Owner: coordinator）。
- 2026-09-18: T-001~T-005 完成：store 改为 docGroups/activeDocGroupIndex；documents.ts 新增标签组动作与 runtime map（loadedPath/loadedToken 防重入加载守卫）；DocumentPanel 重写为 工具条+标签条+多组编辑器；DocumentTree 单击预览/双击固定/右键分栏；fontZoom、TerminalArea 消费者迁移；i18n 六键双语；全套测试 730/731（唯一失败为用户未提交图标改动所致，已证实无关）。实现期发现并修复：moveDocumentTab 先 splice 后判满员的丢标签缺陷、编辑未固定预览标签的行为缺口（onChange/Tab 键补 pin）。
- 2026-09-18: T-006 开始（Owner: coordinator）。
- 2026-09-18: 首次 debug 构建失败：用户未提交的 `tauri.conf.json` 含 `//` 注释，本仓 Tauri 构建与 strict-JSON 测试均无法解析。经 stash 暂存其两文件（tauri.conf.json、Info.plist）→ 构建重启验证 → 提交本任务 → `git stash pop` 无损恢复。T-006 完成：进程路径与在屏窗口核验通过；截图内容核验因本 shell 无录屏 TCC 授权受阻（已如实记录）。任务收尾，最终验证 partial。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001~T-006 全部 done；任务文档校验通过；`npm test` 730/731、`npm run build`、`npm run i18n:check` 通过；debug App 重启且进程路径/在屏窗口核验通过；commit `2f1ba72` 仅含本任务改动。
- Limitations: (1) 窗口渲染内容未经截图确认——本 shell 无 Screen Recording TCC 授权，ScreenCaptureKit/screencapture 均被拒；已在用户屏幕前置该窗口，需用户目检。(2) `terminal-drag-drop-config.test.mjs` 单测失败源于用户未提交的 `tauri.conf.json` JSON 注释（同样破坏其 `tauri build`），与本任务无关，未纳入提交。
