# Task Plan: 目录树 VSCode 化：文件图标 + Git 装饰

- Created: 2026-09-19
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户提供的 VSCode 资源管理器截图，经 clarify-requirements 确认（范围=图标+Git 装饰；图标=自绘精选 SVG；摘要已确认）

<!-- task-doc-section:background-goal -->
## Background and goal

文档面板目录树当前只有通用文件/文件夹图标、无 git 信息。升级为截图式 VSCode 观感：彩色文件类型图标（按扩展名/特殊文件名映射 ~25 种，冷门回退通用图标）+ Git 状态装饰（绿=新增/U、金=M、红=D/冲突+`!`、右侧字母徽标、含变更目录聚合圆点、忽略文件淡化），另加头部「折叠全部」按钮。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**范围内：** 图标映射组件集；git 装饰数据层（locator 解析 → get_git_changes(includeIgnored=true) → checkoutRoot 相对路径索引 → 行装饰）；行渲染升级；折叠全部按钮；CSS 与 i18n；测试。
**排除：** 现有树交互不变（懒加载/右键菜单/新建/重命名/删除/拖拽/分栏）；不做「…」菜单；不动 Git Center/移动端；无后端新增 API；不做文件系统监听与轮询。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 后端 `get_git_changes(locator, includeIgnored)` 返回全量快照：entries 含 kind(added/modified/deleted/renamed/copied/type_changed/conflict/untracked/ignored) 与 staged/unstaged/untracked/ignored/conflicted 标志 | `crates/agentport-core/src/git/status.rs:19-80`、`src/src/api.ts:416` |
| F-002 | `displayPath` 为 checkout 相对路径（git status 原生输出）；快照 `context.checkoutRoot` 给绝对根 | status.rs:506、`src/src/types.ts:622-696` |
| F-003 | locator 仅支持 session/projectMain/worktree 三种；store `projects` 含 rootPath/gitRootPath 与 worktrees[].path，可按 explorerRoot 路径包含关系构建 locator | `src/src/types.ts:615-618,113-130` |
| F-004 | 无 git watcher/轮询；Git Center 缓存按 checkoutId 存于 `gitCenter.caches`，变更时 statusToken/observedAt 更新 | gitCenter.ts、desktopEvents.ts 检索 |
| F-005 | DocumentTree 行渲染：chevron + IconFolder/IconFile + name + selected class；懒加载目录；header 已有新建/刷新按钮 | `src/src/components/DocumentTree.tsx` |
| F-006 | 既有 CSS 契约测试 `doc-tree-sidebar-css.test.ts`、`doc-panel-tree-only-css.test.ts` | ls src/src |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 装饰仅在树根位于 git 仓库内时显示；非仓库静默无装饰（resolve 失败 → not-repo 态，不报错）。
- Assumption: 刷新触发=树打开/根目录加载、手动 ⟳、窗口聚焦；Git Center 同 checkoutRoot 快照更新时优先采用其 entries（订阅 store，无需自监听）。
- Assumption: 目录自身不着色、只显示聚合圆点；冲突红色 + `!`；删除文件不在磁盘列出故无行装饰。
- Assumption: 快照 entries 建 Map 索引，行装饰 O(depth)；大仓库几千条一次快照可接受。
- Open question: 无。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 行渲染：彩色类型图标（特殊文件名优先于扩展名）；git 状态色 + 徽标（M/A/U/D/R/!）；忽略淡化（含祖先继承）；目录聚合圆点
- 非仓库树根无任何装饰且不出错；locator 按 explorerRoot 路径包含关系从 store projects 推导（优先 worktree）
- 折叠全部按钮收起所有已展开目录
- 单测：图标映射、装饰计算（各 kind/祖先忽略/祖先未跟踪/目录聚合/越界路径）、组件渲染（class/徽标/淡化/圆点/折叠全部/非仓库）；`npm test`、`npm run build`、`i18n:check` 全绿
- 调试窗口按 AGENTS.md 重启并验证；git commit 仅含本任务改动

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001（图标集）→ T-002（git 数据层）→ T-003（树集成+CSS+i18n）→ T-004（测试补齐）→ T-005（验证交付）；串行，coordinator 执行
- Parallel batches: 无（共享文件）
- Serialization constraints: DocumentTree.tsx/styles.css/测试文件被多任务触及

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 文件图标集 docTreeIcons

- Status: done
- Owner: coordinator
- Objective: 自绘 ~25 种 SVG 图标 + 映射函数（特殊文件名 > 扩展名 > 通用回退）
- Inputs and prerequisites: 已确认图标方案
- Scope or files: `src/src/components/docTreeIcons.tsx`（新）
- Expected output: `fileIconSpec(name): {color, glyph}` 纯函数 + `DocFileIcon` 组件；映射覆盖 md/json/tsconfig/ts/tsx/js/css/html/rs/py/toml/yaml/lock/图片/字体/压缩包/pdf/sh/ps1/bat/env/git 系/npm 系/LICENSE/Makefile/Dockerfile/AGENTS.md 等
- Dependencies: None.
- Execution steps:
  1. 设计简洁 glyph（1–2 path/文字）+ 固定色板
  2. 映射表 + 单测友好导出
- Acceptance criteria: 映射单测通过；特殊文件名优先命中
- Verification method: `npx vitest run src/components/docTreeIcons.test.tsx`
- Validation evidence: docTreeIcons.test.tsx 通过（特殊名/扩展名/回退三组映射 + 渲染回退）。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — git 装饰数据层 docTreeGit

- Status: done
- Owner: coordinator
- Objective: locator 推导 + 快照拉取/订阅 + 纯装饰计算
- Inputs and prerequisites: F-001~F-004
- Scope or files: `src/src/docTreeGit.ts`（新）
- Expected output: `locatorForExplorerRoot(state, root)`、`buildDocGitIndex(snapshot)`、`decorateDocPath(index, absPath, isDir)`（纯）、`subscribeTreeGit/getTreeGit/refreshTreeGit(root)`（useSyncExternalStore 模式）；Git Center 快照优先逻辑
- Dependencies: T-001
- Execution steps:
  1. 纯函数：索引（files Map + ignored/untracked 祖先集 + 变更目录集）与装饰
  2. 模块状态：按 root 的 phase/checkoutRoot/index + 监听
  3. 刷新：locator → getGitChanges；失败 → not-repo/error；合并 gitCenter 缓存
- Acceptance criteria: 装饰计算单测全覆盖；非仓库静默
- Verification method: `npx vitest run src/docTreeGit.test.ts`
- Validation evidence: docTreeGit.test.ts 通过（kind 映射/目录聚合最坏态/未跟踪折叠目录继承/忽略祖先继承/越界路径/locator 最深 worktree 优先）。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — DocumentTree 集成 + CSS + i18n

- Status: done
- Owner: coordinator
- Objective: 行渲染接入图标与装饰；折叠全部按钮；样式与文案
- Inputs and prerequisites: T-001、T-002
- Scope or files: `src/src/components/DocumentTree.tsx`、`src/src/styles.css`、`src/src/locales/fragments/{en-US,zh-CN}/shell-ui.json`
- Expected output: 行：图标组件、git class、徽标、淡化、目录圆点；header 折叠全部；刷新按钮同时刷新 git；树打开/窗口聚焦触发拉取
- Dependencies: T-001, T-002
- Execution steps:
  1. 行渲染改造（保持既有交互/测试选择子）
  2. CSS：git 色板（dark/light 可读）、淡化、徽标、圆点
  3. i18n：collapseAll 等
- Acceptance criteria: 组件测试通过；i18n:check 通过
- Verification method: `npx vitest run src/components/DocumentTree.test.tsx`、`npm run i18n:check`
- Validation evidence: DocumentTree.test.tsx 14/14（新增装饰渲染/非仓库静默/折叠全部）；i18n:check 通过（collapseAll/collapseAllTip/gitStatus 七键双语）。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 测试补齐与全套验证

- Status: done
- Owner: coordinator
- Objective: 三层测试 + 全套转绿 + 构建
- Inputs and prerequisites: T-001~T-003
- Scope or files: `src/src/components/docTreeIcons.test.tsx`、`src/src/docTreeGit.test.ts`、`src/src/components/DocumentTree.test.tsx`、CSS 契约测试（如需）
- Expected output: `npm test` 全绿；`npm run build` 通过
- Dependencies: T-001, T-002, T-003
- Execution steps:
  1. 补测试并跑全套
  2. 修复暴露的问题
- Acceptance criteria: 全套绿
- Verification method: `cd src && npm test && npm run build`
- Validation evidence: `npm test` 754/754（98 文件全绿）；`npm run build`（tsc + vite）通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 调试窗口验证与提交

- Status: done
- Owner: coordinator
- Objective: 按仓库规则重启调试 App、验证、commit
- Inputs and prerequisites: T-004 全绿
- Scope or files: `scripts/restart-debug-app.py`；git commit（仅本任务改动）
- Expected output: 窗口在屏运行新构建；commit 完成
- Dependencies: T-004
- Execution steps:
  1. restart 脚本 → ps 核验路径 → 窗口元数据核验（截图能力受 TCC 限制则如实记录）
  2. 提交
- Acceptance criteria: AGENTS.md 规则满足
- Verification method: ps/CGWindowList + `git show --stat`
- Validation evidence: `restart-debug-app.py` 成功（新 GUI PID 5412）；ps 确认进程为本 checkout debug 包；CGWindowList 确认 layer-0 窗口 1200×800 alpha=1.0 在屏。渲染内容未截图（本 shell 无 Screen Recording TCC 授权），需用户目检图标与 git 装饰。commit `96cbf2e`（10 文件，+1501/-25，仅本任务改动）。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 纯逻辑单测（图标映射、装饰计算）→ 组件测试（DocumentTree）→ 全套 `npm test` → `npm run build`（tsc）→ `npm run i18n:check`
- 实机：restart-debug-app.py + ps + CGWindowList；渲染内容若因 TCC 无法截图则明确标注由用户目检
- 交付：git commit 仅含本任务改动

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 风险：大仓库快照 entries 多导致装饰开销 → 路径索引 Map + 祖先集，行 O(depth)
- 风险：Git Center 缓存与树自拉快照一致性 → 以 observedAt 较新者为准
- 风险：displayPath 编码（非 UTF-8 文件名）→ from_utf8_lossy，装饰按字符串匹配，边缘情形不致命
- Blockers: 无

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-19: 需求经 clarify-requirements 确认（图标+Git 装饰 / 自绘 SVG）；侦察完成（F-001~F-006）；创建任务文档。
- 2026-09-19: T-001~T-004 完成：docTreeIcons（~30 种映射）、docTreeGit（索引/装饰/locator/刷新）、DocumentTree 集成（徽标/圆点/淡化/折叠全部/Git Center 快照优先）、三层测试与全套 754/754。
- 2026-09-19: T-005 开始（Owner: coordinator）。
- 2026-09-19: T-005 完成：调试窗口重启核验通过；commit 96cbf2e。最终验证 partial（渲染内容因 TCC 未经图像确认）。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001~T-005 全部 done；任务文档校验通过；`npm test` 754/754、`npm run build`、`npm run i18n:check` 通过；debug App 重启且进程路径/在屏窗口核验通过；commit `96cbf2e` 仅含本任务改动。
- Limitations: 图标与 git 装饰的实际渲染未经截图确认（本 shell 无录屏 TCC 授权），已前置调试窗口待用户目检。
