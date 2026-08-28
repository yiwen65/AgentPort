# Task Plan: Project 拖拽排序与置顶

- Created: 2026-08-17
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户确认的 Project 拖拽排序与置顶实施计划

<!-- task-doc-section:background-goal -->
## Background and goal

在侧栏 Project 列表加入桌面端按住拖拽排序与持久化置顶。SQLite 是布局权威来源；置顶项形成顶部区域，区内可排序，跨区拖拽同步改变置顶状态，重启后保持。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围包含 projects 表迁移、核心模型与数据库 API、Tauri/前端契约、侧栏 Pointer Events 交互、菜单/图标/i18n、自动化测试和 debug App 验证。不移动项目目录，不调整 Session/Worktree 顺序，不执行 Git 操作，不新增第三方依赖、专用键盘排序或移动端长按手势，不修改 Session 置顶逻辑。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前 Project 由 SQLite `projects` 表持久化并按 `created_at, id` 读取。 | `crates/agentport-core/src/db/mod.rs` 的迁移与 `Db::list_projects`。 |
| F-002 | 侧栏 Project 渲染、共源右键/“＋”菜单均在 Sidebar。 | `src/src/components/Sidebar.tsx`。 |
| F-003 | 前端无拖拽依赖，已有 Pointer Events 拖动模式可复用。 | `src/package.json` 与 `QuickAgentStrip`。 |
| F-004 | 用户已确认持久化、可跨分区、菜单入口加常驻图标、菜单切换进入目标区最前。 | 本会话确认的共享理解与实施计划。 |
| F-005 | 工作区已有不属于本任务的 terminals 修改，必须保留。 | `HOME=/tmp git status --short` 显示 `src/src/terminals.ts` 与其测试已修改。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 交互面向桌面鼠标/触控板；Pointer Events 阈值、取消和自动滚动满足本次可访问范围。影响是本次不提供独立键盘重排。
- Assumption: 项目布局写入期间禁用第二次布局变更即可避免客户端异步倒序覆盖。
- Open question: 无。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 旧数据库迁移后顺序不变且均未置顶；新项目追加普通区末尾。
- 原子布局写入严格校验完整、唯一、规范的 Project ID 列表，失败无部分更新。
- ProjectView、Tauri API 与前端 store 统一携带置顶状态和规范顺序。
- 普通点击、拖拽、跨区、取消、自动滚动、子控件隔离、菜单置顶、保存失败恢复均符合确认行为。
- 中英文文案、Rust/前端测试、生产构建及 debug App 启动验证通过；不覆盖用户已有 terminals 修改。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004 -> T-005。
- Parallel batches: 无；数据契约、共享 Sidebar 和测试夹具存在重叠，按依赖串行执行。
- Serialization constraints: `Project` 模型、数据库迁移、Tauri command、前端 ProjectView 和 Sidebar 必须按契约顺序更新；任务文档仅由协调者维护。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 实现 Project 布局持久化

- Status: done
- Owner: coordinator
- Objective: 添加迁移、模型字段、确定性排序和原子布局更新。
- Inputs and prerequisites: 已确认的排序语义与当前 projects schema。
- Scope or files: `crates/agentport-core/src/models.rs`, `crates/agentport-core/src/db/mod.rs` 及必要 Project 构造器。
- Expected output: 可迁移、可校验、可重启保持的 Project 布局数据库能力。
- Dependencies: None.
- Execution steps:
  1. 追加迁移和模型字段。
  2. 更新行映射、添加和列表排序。
  3. 实现 immediate transaction 的完整布局校验与写入。
- Acceptance criteria:
  - 数据迁移和原子写入满足总体验收标准。
- Verification method:
  - Rust 定向数据库测试与编译。
- Validation evidence: `cargo test -p agentport-core project_layout --lib` 2 passed；`cargo test -p agentport-core v10_projects_migrate --lib` 1 passed；Rust LSP 未返回诊断但因 server 启动超时未确认。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 暴露布局契约与数据流

- Status: done
- Owner: coordinator
- Objective: 添加 Tauri command、ProjectView 字段、前端 API 与权威快照动作。
- Inputs and prerequisites: T-001 完成的数据库接口。
- Scope or files: `src-tauri/src/main.rs`, `src/src/types.ts`, `src/src/api.ts`, `src/src/actions.ts`, `src/src/store.ts`。
- Expected output: 前端可原子提交布局并接收最新规范快照。
- Dependencies: T-001.
- Execution steps:
  1. 扩展后端 view 和 command。
  2. 注册 command 并更新 TypeScript 契约。
  3. 实现保存中防重、乐观更新、成功对账和失败恢复。
- Acceptance criteria:
  - API 参数、返回值和 snapshot authority 路径一致。
- Verification method:
  - Rust command 编译与前端 API 契约测试。
- Validation evidence: `cargo check -p agentport` 通过；`cd src && npm run build` 通过，确认 Tauri/TypeScript 契约可编译。API 调用断言留待 T-004。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 构建拖拽和置顶界面

- Status: done
- Owner: coordinator
- Objective: 实现 Pointer Events 排序预览、菜单切换、图标、样式和本地化。
- Inputs and prerequisites: T-002 的前端契约和保存动作。
- Scope or files: `src/src/components/Sidebar.tsx`, 新布局 helper、`src/src/styles.css`, `src/src/locales/resources.ts`。
- Expected output: 符合确认交互的完整侧栏体验。
- Dependencies: T-002.
- Execution steps:
  1. 抽出纯布局运算。
  2. 实现指针拖拽、边缘滚动、取消和 click 抑制。
  3. 接入菜单、常驻图标、ARIA/announcement 和 reduced motion 样式。
- Acceptance criteria:
  - 行为与交互章节全部可观察成立。
- Verification method:
  - Vitest 交互测试和手工 debug App 检查。
- Validation evidence: `npm run build` 通过；TypeScript LSP 4 个相关文件无诊断；现有 Sidebar 菜单/分支测试 10 项通过。完整交互断言与 debug 手工检查分别由 T-004/T-005 完成。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 添加回归覆盖

- Status: done
- Owner: coordinator
- Objective: 覆盖迁移、数据库校验、API、纯排序和 Sidebar 交互。
- Inputs and prerequisites: T-003 完成的行为。
- Scope or files: Rust DB tests 与 `src/src/*test*`。
- Expected output: 对关键成功与失败路径的自动化回归保护。
- Dependencies: T-003.
- Execution steps:
  1. 添加 Rust 数据库与迁移测试。
  2. 添加纯排序和 API 契约测试。
  3. 更新并扩展 Sidebar 测试。
- Acceptance criteria:
  - 计划中的关键边界均有自动化断言或明确手工验证。
- Verification method:
  - 定向及完整相关测试命令。
- Validation evidence: 前端 Project 布局/API/Sidebar/action 及既有 Sidebar 回归共 34 项通过；Rust 迁移/布局 3 项通过；11 个相关 TS 文件 LSP 无诊断；`npm run i18n:check` 与 `tsc --noEmit` 通过。另修复了阻塞 i18n 检查的既有 Settings 提交语言字面量（改为资源键）。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 验证并启动 debug App

- Status: done
- Owner: coordinator
- Objective: 完成诊断、测试、构建、debug App 重建与非白屏验证。
- Inputs and prerequisites: T-004 测试完成。
- Scope or files: 全部本任务改动与 `scripts/rebuild-debug-app.sh` 产物。
- Expected output: 可运行且已验证的 debug App。
- Dependencies: T-004.
- Execution steps:
  1. 运行 LSP/lens、Rust、Vitest、i18n 和前端构建。
  2. 重建并只重启当前工作区 debug GUI。
  3. 用 ps 与截图确认正确进程和非白屏窗口。
- Acceptance criteria:
  - 所有要求检查通过，或清楚记录不可执行的限制。
- Verification method:
  - 保存命令结果、进程路径和截图证据。
- Validation evidence: 前端完整 Vitest 45 files / 267 tests 通过；production build、tsc、i18n、diff check、Rust 定向 rustfmt 通过；agentport GUI 43 tests、CLI probe 4 tests（串行复跑）、agentport-core 268 tests + 1 超时项隔离复跑通过、6 ignored。两轮独立 reviewer 的 6 个具体并发/拖拽发现已修复，复审无剩余 finding。`lens_diagnostics mode=all` 无 error。`scripts/rebuild-debug-app.sh` 成功，debug GUI PID 29328 的可执行路径正确；ScreenCaptureKit 窗口截图 `target/debug/agentport-debug-project-layout-window.png` 显示完整非空白 UI 与 Project 置顶图标。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先运行 agentport-core 的 Project/迁移定向测试，再运行 Tauri 编译；前端运行布局 helper、API 与 Sidebar 定向 Vitest、i18n 检查和 production build。最终运行受影响 workspace 测试或完整编译、lens diagnostics，并依仓库规则重建、打开、检查 debug App。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 全列表布局写入可能遇到并发新增/删除；后端必须拒绝集合不一致，前端失败后刷新权威快照。
- Pointer capture 会生成 click；必须以阈值和一次性 click 抑制避免误折叠。
- 展开 Project 高度不适合作为命中中点；目标计算应基于标题行和明确分区边界。
- 现有 terminals 文件有用户修改，任何批量格式化或回滚都不得覆盖。
- Python 脚本从 skill 目录执行被当前 OS sandbox 拒绝；任务文档已按模板手工创建，最终需尝试可用的等价验证或记录限制。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-17: 创建执行任务文档；T-001 进入 in_progress，由 coordinator 执行。
- 2026-08-17: 记录工作区已有 terminals 修改并设为保留边界。
- 2026-08-17: skill 自带 task_document.py 的 bash 读取被 OS sandbox 拒绝，改为按已读取模板手工创建文档。
- 2026-08-17: T-001 完成；v10 迁移、布局持久化与失败回滚定向测试共 3 项通过。T-002 进入 in_progress。
- 2026-08-17: T-002 完成；agentport Rust check 与前端 production build 通过。为保持 ProjectView 必填契约，最小更新了现有测试 fixture（包括用户已修改的 terminals renderer 测试，仅新增 `pinned: false`）。T-003 进入 in_progress。
- 2026-08-17: T-003 完成；Pointer Events 拖拽、自动滚动、跨区预览、菜单切换、图标、样式与 i18n 已实现，production build/LSP 及 10 项现有 Sidebar 测试通过。`i18n:check` 发现 SettingsDialog 既有“中文”字面量，留待最终验证评估。T-004 进入 in_progress。
- 2026-08-17: T-004 完成；新增纯布局、Tauri API、Pointer 拖拽/取消/自动滚动/菜单与权威恢复测试。定向前端 34 项、Rust 3 项通过；i18n 与 tsc 通过。T-005 进入 in_progress。
- 2026-08-17: 独立 review 发现并修复两类快照竞争与四类 Pointer/排序边界问题；新增权威 revision、早期 capture、取消 click 抑制、单项分区目标及滚动边界保护，复审确认无剩余 finding。
- 2026-08-17: T-005 完成；完整前端测试 267 项通过，Rust 相关套件通过（并发压力下的 CLI/Qoder 探测超时均已串行隔离复跑通过），debug App 已重建、重启并通过进程路径及非空白窗口截图验证。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 所有 T-001 至 T-005 均有实际测试、构建、review、诊断或运行截图证据；最终 debug App 正在从工作区 bundle 运行。
- Limitations: `cargo test --workspace` 与 agentport-core 全量测试在并行高负载时各出现过 CLI/Qoder 探测 2 秒超时；对应测试在串行或隔离复跑时全部通过。Vitest 的既有 jsdom Canvas “Not implemented” stderr 不影响 267 项通过结果。
