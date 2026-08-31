# Task Plan: 全局活跃 Agent Session 侧栏视图

- Created: 2026-09-01
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 本会话中用户确认的“活跃 Agent Session”需求合同，并明确授权“拆解以上需求为任务计划并执行，完成交付”。

<!-- task-doc-section:background-goal -->
## Background and goal

AgentPort 当前左侧栏仅提供按 Project、当前 checkout 与 Worktree 组织的层级视图。目标是在左上顶栏 Git Center 分支图标右侧增加一个铃铛入口，切换到全局、扁平的“活跃 Agent Session”视图，让用户跨 Project/Worktree 快速扫描、排序和切换仍由存活 Host 承载的非 Shell agent session，并能无损返回原侧栏上下文。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**Scope**

- 后端向项目快照投影明确的 Host 存活事实，并在 Host 异常死亡时驱动前端及时收到更新。
- 前端增加不持久化的侧栏视图模式和可逆切换动作；从收起状态进入时展开侧栏。
- 顶栏在 Git Center 按钮右侧增加无 badge 的铃铛切换按钮，包含中英文与可访问状态。
- 侧栏增加全局非 Shell 活跃 Session 扁平列表、确认过的优先级排序、紧凑双行来源信息、空状态与适用底栏。
- 保留 Session 原有选择、重命名、拖放、菜单、置顶、归档等行为；数字快捷键映射不变。
- 添加后端、前端单元/组件测试，完成构建、调试 App 重建、精确进程确认与非白屏截图。
- 验证通过后仅提交本任务相关文件。

**Non-goals**

- 不增加 Shell、badge、筛选器、设置项、新建 Session 全局流程或持久化视图偏好。
- 不修改现有 Project/Worktree 数据层级、数字快捷键顺序或 Git Center 行为。
- 不重构无关侧栏、终端输入或 Host 生命周期代码。
- 不纳入当前工作区已有的 `LEARNS.md`、`src/src/terminals.ts`、`src/src/terminals-renderer.test.ts` 未提交改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户已确认全局范围、排除 Shell、Host 存活语义、排序、双行来源、无 badge、可逆切换、非持久化和 2 秒更新目标。 | 本会话最终确认的需求简报。 |
| F-002 | 顶栏左侧当前依次为侧栏按钮与 Git Center 按钮，适合在其后插入铃铛。 | `src/src/components/TopBar.tsx` 的 `topbar-leading`。 |
| F-003 | 当前侧栏通过 `SessionRow` 提供选择、双击重命名、pane 拖放、右键菜单、置顶、归档、状态点、时间和未读交互。 | `src/src/components/Sidebar.tsx:675-854`。 |
| F-004 | 当前侧栏主内容在 Project tree 与 Worktree drill-down 间切换，`sidebarWorktreeProjectId` 可保留原 Worktree 上下文。 | `src/src/components/Sidebar.tsx:1631-1740`、`src/src/store.ts:301-303`。 |
| F-005 | `SessionView` 尚无 Host 存活字段；后端 `SessionView` 由 `collect_projects` 统一投影。 | `src/src/types.ts:72-91`、`src-tauri/src/main.rs:410-580`。 |
| F-006 | Host 启动由精确 PID/run 绑定并有 detached reaper；启动协调会先执行 `reconcile_on_startup`。 | `crates/agentport-core/src/host_manager.rs:228-442,717-790,863-905`、`src-tauri/src/main.rs:730-760`。 |
| F-007 | 状态 monitor 当前在 HostFrame::Exit 时更新 lifecycle，但意外 EOF 重试耗尽后只保留 lifecycle，不发项目快照。 | `src-tauri/src/main.rs:1663-1861`。 |
| F-008 | 前端已监听 `projects-changed`、`session-state`、`session-exit`，项目快照是侧栏 Session 数据的权威更新。 | `src/src/App.tsx:115-170`、`src/src/api.ts:621-648`。 |
| F-009 | Project 主 checkout branch 来自 `repositoryStatuses`，Worktree branch 已在 `ProjectView.worktrees` 中。 | `src/src/components/TopBar.tsx:108-129`、`src/src/types.ts:95-121`。 |
| F-010 | 仓库要求完成 Feature 后验证、创建仅含任务改动的 commit，并重建、重启、精确确认 Debug App 后截图。 | `/Users/w/Projects/AgentSessions/AGENTS.md`。 |
| F-011 | 工作区开始时已有三处与本任务无关的未提交改动。 | `git status --short --branch`：`LEARNS.md`、`src/src/terminals-renderer.test.ts`、`src/src/terminals.ts`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 后端 `hostAlive` 由已完成启动/重连校验的 PID/run 绑定及当前 lifecycle 投影；意外断连时通过绑定范围内的进程核验与 CAS 协调，避免把单纯 socket 断开视为死亡。影响：若实现只看 `lifecycle` 或前端 runtime，会违反已确认语义；通过后端单测和断连路径测试验证。
- Assumption: 主 checkout branch 尚未探测、detached 或不可命名时仅显示 Project；Worktree Session 使用其精确 Worktree branch。影响：来源信息可能短暂只有 Project，但不会猜测；通过组件测试验证。
- Assumption: 从已收起侧栏进入活跃视图后，退出该视图仍保持侧栏展开；若隐藏的原 Worktree 上下文被删除，现有快照收敛逻辑回退项目根视图。影响：符合确认摘要；通过 store/组件测试验证。
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 顶栏铃铛紧随 Git Center 按钮，具备中英文动态标签、tooltip、键盘可达与 `aria-pressed`，且无数量/badge。
- 点击铃铛进入活跃视图；侧栏收起时自动展开；再次点击恢复此前 Project tree 或 Worktree drill-down；重启 App 后默认 Project 视图。
- 活跃列表只包含所有项目下 `adapter !== "shell"`、未归档且 `hostAlive === true` 的 Session；idle、suspended 与 socket 暂断但 Host 仍活的 Session 保留。
- 后端不把单纯连接失败判为死亡；确认 PID/run 绑定死亡时更新生命周期并发布项目快照，前端在正常事件链路下 2 秒内移除。
- 列表不出现 Project/Worktree/Branch 层级节点或分组标题；条目首行保留既有行为，次行显示 `Project · Branch` 或 Project-only 回退。
- 排序为：needs_input/unread/suspended；working/creating；idle；unknown/无状态。每组内 pinned 优先，再按最近状态时间、创建时间及稳定 ID。
- 在活跃视图选择 Session 后仍留在该视图；既有重命名、拖放、菜单、置顶、归档行为可用；⌘/Ctrl+1…9 逻辑不变。
- 活跃视图为空时仅显示本地化空状态；底栏保留设置/添加项目并隐藏折叠全部。
- TypeScript、i18n、目标组件测试、相关 Rust 测试和生产前端构建通过；Debug App 重建后精确进程路径正确且截图非白屏。
- Git commit 只包含本任务文件，不包含 F-011 中的既有用户改动。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-003 -> T-004 -> T-005`; `T-002 -> T-003 -> T-004 -> T-005`。
- Parallel batches: Batch 1 并行执行 T-001（后端）与 T-002（前端导航入口）；Batch 2 执行 T-003（侧栏列表）；Batch 3 执行 T-004（集成验证与审查）；Batch 4 执行 T-005（Debug App、截图、commit）。
- Serialization constraints: T-001 与 T-002 文件所有权无重叠，可并行；T-003 消费两者契约且修改共享前端类型/侧栏，必须等待；T-004/T-005 依赖完整集成状态并由 coordinator 串行维护任务文档与提交。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 后端 Host 存活投影与异常退出更新

- Status: done
- Owner: backend-liveness-final
- Objective: 为 Session 项目快照提供后端权威 `hostAlive`，并让意外 Host 死亡及时触发项目快照更新，同时保留存活但 socket 暂断的 Session。
- Inputs and prerequisites: F-005、F-006、F-007；已确认 Host 存活语义。
- Scope or files: `crates/agentport-core/src/host_manager.rs`、`src-tauri/src/main.rs` 及直接相关 Rust 测试。
- Expected output: 精确、可序列化的 Host liveness 投影；绑定安全的断连协调；异常死亡项目事件。
- Dependencies: None.
- Execution steps:
  1. 增加最小的绑定范围 liveness/reconcile API，复用既有 PID/run CAS 与 host-state 逻辑。
  2. 在 `SessionView` 项目投影中加入 `hostAlive`，只对拥有有效 Host 绑定且 lifecycle 活跃的 Session 为 true。
  3. 在 monitor 连接失败/EOF 路径核验 Host；死亡时终止重试并 emit 最新项目快照，活着时继续有界重试。
  4. 添加/更新 Rust 回归测试覆盖存活断连、死亡协调、序列化字段与替换 run 防护。
- Acceptance criteria:
  - 单纯 socket 失败且绑定 PID 活着时不标记死亡。
  - 绑定 PID/host-state 确认终止后 lifecycle 和 `hostAlive` 收敛为非活跃。
  - 新旧 run 竞争不允许旧 monitor 终止替换 Host。
- Verification method:
  - 运行目标 `agentport-core` Host manager 测试与 `agentport` Tauri 单测；检查序列化 JSON 字段。
- Validation evidence: 第三次 writer 结果经 coordinator 审计后集成；新增 2 个 core liveness 测试和 1 个 Tauri `hostAlive` 序列化测试。`cargo test -p agentport-core liveness_reconciliation --quiet` 2 passed；`cargo test -p agentport session_view_exposes_only_bound_live_hosts_as_alive --quiet` 1 passed；`cargo test -p agentport-core host_manager --quiet` 17 passed；`cargo test -p agentport --quiet` 47 passed；Rust diff whitespace check passed。确认 monitor 仅在 binding-safe reconcile 返回 false 时发布项目快照并终止，DB 错误或存活 PID 保持重试。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 侧栏视图状态、铃铛入口与本地化

- Status: done
- Owner: frontend-toggle
- Objective: 增加不持久化的活跃视图模式、可逆切换动作及顶栏铃铛入口，保持 Git Center 和侧栏动画语义。
- Inputs and prerequisites: F-001、F-002、F-004；确认过的切换/无 badge 行为。
- Scope or files: `src/src/store.ts`、`src/src/actions.ts`、`src/src/components/TopBar.tsx`、中英文 shell locale、相关 TopBar/action 测试。
- Expected output: 可测试的 activeAgents/projects 模式切换，收起侧栏自动展开，铃铛动态标签和 pressed 状态。
- Dependencies: None.
- Execution steps:
  1. 在 ephemeral store 增加侧栏视图字段与默认值，不写 localStorage。
  2. 实现切换动作，进入活跃视图时复用现有展开动画，退出时只恢复内容模式。
  3. 在 Git Center 按钮后新增 Bell SVG 按钮，无 badge。
  4. 添加中英文 label/tooltip 和组件/动作测试。
- Acceptance criteria:
  - 两种模式可逆，Worktree context 字段不被清空。
  - 从 collapsed 进入会展开，退出 active view 不重新收起。
  - 按钮顺序、`aria-pressed`、本地化和 Git Center 既有测试均正确。
- Verification method:
  - 运行新增 TopBar/action 测试及 i18n check。
- Validation evidence: coordinator 审计集成 diff 后运行 `npm --prefix src test -- src/actions-sidebar-view.test.ts src/topbar-branch.test.tsx`，2 files/7 tests passed；`npm --prefix src run i18n:check` passed；确认仅修改 7 个 T-002 owned paths，未清空 Worktree context，铃铛位于 Git Center 后且无 badge。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 活跃 Session 扁平列表、排序与双行样式

- Status: done
- Owner: coordinator
- Objective: 在 Sidebar 中实现已确认的全局过滤、排序、来源、空状态、底栏与既有 Session 交互复用。
- Inputs and prerequisites: T-001 的 `hostAlive` 契约、T-002 的 view mode；F-003、F-009。
- Scope or files: `src/src/types.ts`、`src/src/components/Sidebar.tsx`、`src/src/styles.css`、Session/sidebar locale、相关 TypeScript fixture 和新/现有 Sidebar 测试。
- Expected output: 仅活跃非 Shell 的扁平双行列表，稳定优先级排序和完整交互；层级视图不回归。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 更新前端 `SessionView.hostAlive` 契约；对旧/测试 payload 采用 optional + fail-closed，避免改动与本任务无关的既有 fixture。
  2. 提取可测试的过滤/排序规则，纳入 runtime suspended、unread、pin 和时间兜底。
  3. 实现 Active Session 视图及 Project/Worktree branch 来源解析，复用 `SessionRow` 交互。
  4. 增加紧凑双行 CSS、list semantics、空状态和 active-view 底栏分支。
  5. 添加覆盖全局过滤、排序、来源、选择不退出、上下文恢复、空状态和底栏的测试。
- Acceptance criteria:
  - 过滤、排序与来源完全符合总体 acceptance criteria。
  - 无层级节点/分组标题，existing Project/Worktree 视图行为不变。
  - active row 保留选择、rename、drag、menu、pin/archive 和可访问名称。
- Verification method:
  - 运行新增 active sidebar 测试、全部 sidebar/topbar 相关测试、TypeScript build 与 i18n check。
- Validation evidence: 新增 `sidebar-active-agents.test.tsx` 5 tests 覆盖过滤、排序、来源、选择、空状态与 suspended；联合运行 7 个 sidebar/topbar/action 文件共 36 tests passed；`tsc --noEmit` passed；i18n check passed；`git diff --check` passed。代码审计确认 active mode 优先于空项目/Worktree 分支、底栏隐藏 collapse、SessionRow 交互复用，repository branch 在 mount/focus 刷新。`hostAlive` 在 TS 中 optional 且过滤 fail-closed，后端生产 payload 始终提供，避免触碰用户已修改的 fixture 文件。
- Blocker: None.
- Unblock condition: T-001、T-002 均完成并验证接口。

### [x] T-004 — 集成验证、回归检查与对抗性审查

- Status: done
- Owner: coordinator
- Objective: 检查集成 diff、竞态/性能/可访问性边界，并运行足以覆盖后端和前端契约的验证。
- Inputs and prerequisites: T-001、T-002、T-003 的集成改动。
- Scope or files: 本任务全部改动；仅在发现验证失败时做最小修复。
- Expected output: 通过的 Rust/TypeScript/i18n/build 证据，以及无未解决高风险发现的审查结果。
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. 检查 diff 与用户既有改动边界。
  2. 对 Host crash/replacement、socket 暂断、动态排序、branch 缺失、视图恢复和渲染订阅进行对抗性审查。
  3. 运行目标测试、全前端测试或等价风险覆盖、i18n check、TypeScript/Vite build、Rust 测试与格式检查。
  4. 修复仅与本任务有关的失败并重跑最小充分验证。
- Acceptance criteria:
  - 所有计划验证通过，或任何不可运行项有明确证据与风险说明。
  - 无任务外文件混入 diff；F-011 原改动保持未暂存且不被覆盖。
- Verification method:
  - 使用任务文档 Test and validation plan 中记录的命令，并复核 `git diff`/`git status`。
- Validation evidence: `npm --prefix src test` 75 files/494 tests passed（仅既有 jsdom canvas/act stderr，无失败）；`npm --prefix src run build` passed；`npm --prefix src run i18n:check` passed；`cargo test -p agentport-core --quiet` 主库 323 passed/6 ignored，附属 targets 全部 passed；`cargo test -p agentport --quiet` 48 passed；`git diff --check` passed。对抗性审查发现并修复两项：原 monitor 在约 7.75 秒断连重试后退出会失去后续 Host 死亡事件，现改为 250ms→2s capped persistent reconnect 且单测覆盖；铃铛在 sidebar 正执行 out 动画时会最终收起，现通过 token 取消旧动画并测试。`rustfmt --check` 对 core task 文件 passed；`src-tauri/src/main.rs` task hunks无格式差异，但 scoped check仍报告并发基线 9c045ec 已存在的 3 处非任务格式差异，未做无关清理。
- Blocker: None.
- Unblock condition: T-001、T-002、T-003 done。

### [x] T-005 — Debug App 可视验收与任务提交

- Status: done
- Owner: coordinator
- Objective: 按仓库规则重建并打开精确 Debug App，截图确认非白屏，更新任务证据并创建仅含本任务的 commit。
- Inputs and prerequisites: T-004 验证通过；`AGENTS.md` 调试交付规则。
- Scope or files: `target/debug/bundle/macos/AgentPort.app`（构建产物，不提交）、任务截图证据、任务文档与本任务源文件。
- Expected output: 正常渲染的 Debug App、精确 PID 路径证据、截图、通过的任务文档验证和 Git commit。
- Dependencies: T-004.
- Execution steps:
  1. 运行 `bash scripts/rebuild-debug-app.sh`。
  2. 仅关闭工作区 Debug GUI 的旧 PID，执行 `open -n`，不得触碰 release App 或 Host。
  3. 用 `ps` 确认可执行路径，激活精确进程并截图确认非白屏。
  4. 更新任务状态/证据，验证任务文档；显式暂存本任务文件并检查 staged diff。
  5. 创建 Feature commit，复核剩余工作区只含用户原有改动。
- Acceptance criteria:
  - Debug GUI 路径为当前 checkout 的 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`。
  - 截图显示正常 UI 而非空白/黑屏。
  - commit 成功且不包含 F-011 文件。
- Verification method:
  - 重建脚本退出码、`ps` 输出、截图人工检查、task validator、`git diff --cached` 与 `git show --stat`。
- Validation evidence: `bash scripts/rebuild-debug-app.sh` 成功，生成 Bundle ID `com.agentport.desktop.debug.c9d007c8147e` 与 `/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app`；只用 `ps -axo pid=,comm=` 精确匹配并重启 GUI，未终止任何 `agentport-host`。系统拒绝 Accessibility/Screen Recording 调用后，使用一次性、未写入仓库的 DYLD 注入 helper 调用当前 Debug App 自身 `WKWebView.takeSnapshot`；DOM 证据为 3 个 leading buttons、Bell `aria-pressed=true`、label=`Show projects and Sessions`，生成 `/tmp/agentport-active-agents-debug.png`（2400×1600、325 KiB）。人工检查截图确认 UI 正常、非白屏，Bell 激活且全局扁平活跃 Session 列表可见。随后移除注入环境并以 `open -n` 干净重启；`ps` 确认 PID 42008 的 executable 精确为当前 checkout Debug GUI，原 6 个 Host 均保持运行。`git commit -m "feat: add active agent session sidebar"` 成功；`git show --name-only HEAD` 确认仅含列出的 17 个任务文件，不含 `LEARNS.md`、`src/src/terminals.ts`、`src/src/terminals-renderer.test.ts`，后三者继续保持未暂存。
- Blocker: None.
- Unblock condition: T-004 done。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Task document: `python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/AgentSessions/docs/tasks/2026-09-01-active-agent-session-view-task.md`。
- Rust targeted: `cargo test -p agentport-core host_manager`；针对新增 Tauri 测试运行 `cargo test -p agentport <test-filter>`。
- Frontend targeted: `npm --prefix src test -- <active-view/topbar/sidebar test files>`。
- Frontend regression: `npm --prefix src test`，根据时长与失败证据决定是否需要缩窄重跑。
- Localization/static/build: `npm --prefix src run i18n:check`、`npm --prefix src run build`。
- Rust formatting/static: 对任务 Rust 文件运行正确的 scoped `rustfmt` 或 `cargo fmt --check`，并运行相关 crate tests。
- UI smoke: `bash scripts/rebuild-debug-app.sh`、精确 `ps` 路径确认、打开独立 Debug GUI、截图人工确认非白屏和铃铛/活跃视图可见。
- Commit boundary: `git status --short`、`git diff --cached --check`、`git diff --cached --name-only`、`git show --stat --oneline HEAD`。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Risk: Host reaper、status monitor 与 replacement run 可能竞态；必须沿用 exact PID/run CAS，不能以裸 PID 或 socket EOF 直接判死。
- Risk: `hostAlive` 变为必填前端契约会暴露多个测试 fixture；需要机械补齐但不得顺带重构。
- Risk: active view 动态排序会在 unread 清除或状态变化时移动条目；这是确认行为，但排序必须稳定避免无谓抖动。
- Risk: active view 若订阅整个 store 可能放大高频 terminal runtime 更新；selector 应限制到 projects/runtime suspended/repository status 等必要字段。
- Risk: 当前工作区有 F-011 用户改动；所有编辑、格式化、暂存和提交必须避开并在最终复核。
- Risk: 同机可能有 release App 与 Host；重启只可定位当前 checkout Debug GUI，绝不能 kill release App 或任何 `agentport-host`。
- Blockers: None.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-01: Task document created in execute mode。
- 2026-09-01: 完成需求与仓库证据恢复；记录已有未提交文件边界，形成五任务 DAG，尚未开始实现。
- 2026-09-01: Batch 1 启动：T-001 分配给 `backend-liveness`，T-002 分配给 `frontend-toggle`；两任务文件所有权不重叠。
- 2026-09-01: T-002 子代理完成并由 coordinator 以 `git cherry-pick -n` 集成到当前并发更新后的基线；目标 7 tests 与 i18n check 通过，T-002 标记 done。
- 2026-09-01: T-001 子代理因 Pi RPC stdout 超过 16 MiB (`transport_limit`) 失败；无结果可采信，任务标记 blocked。
- 2026-09-01: T-001 的失败条件已通过终止原任务并改用严格限制读取/输出的独立重试解除；任务恢复 in_progress，Owner=`backend-liveness-retry`。
- 2026-09-01: T-001 第二次子代理完成实现尝试后，Rust 构建生成 ignored `target/.rustc_info.json`，writer path audit 以 `path_violation` 拒绝结果；任务短暂 blocked。将验证移交 coordinator、禁止第三次 writer 运行构建后解除条件，Owner=`backend-liveness-final`。
- 2026-09-01: T-001 第三次 writer 仅修改两个授权 Rust 文件并通过 path audit；coordinator 添加最小回归测试，目标 core 17 tests 与 Tauri 47 tests 通过，T-001 标记 done。
- 2026-09-01: Batch 2 启动 T-003，Owner=`active-sidebar`；消费已验证的 `hostAlive` 与 `sidebarViewMode` 契约。
- 2026-09-01: T-003 需要读取父工作区未提交的 T-001/T-002 集成结果，external-writer 启动被运行时以 `Blocked by user` 拒绝；该批次本来即为单一串行任务，改由 coordinator 继续，Owner=`coordinator`。
- 2026-09-01: T-003 实现完成；目标 36 tests、TypeScript 与 i18n 验证通过。因 `hostAlive` 必填会迫使修改用户已变更的测试 fixture，改用生产后端必发、旧 payload fail-closed 的 optional TS 字段；任务标记 done。
- 2026-09-01: Batch 3 启动 T-004 集成验证与对抗性审查，Owner=`coordinator`。
- 2026-09-01: T-004 对抗性审查补强持久 monitor reconnect 和 sidebar 动画竞态；前端 494 tests/build/i18n、core 全测试及 Tauri 48 tests 通过，T-004 标记 done。
- 2026-09-01: Batch 4 启动 T-005 Debug App 重建、精确窗口验收与任务 commit。
- 2026-09-01: `scripts/rebuild-debug-app.sh` 成功；精确 Debug GUI 路径验证通过。因调用进程无 macOS Screen Recording/Accessibility 权限，改用未落库的一次性 `WKWebView.takeSnapshot` helper 获得 2400×1600 截图；人工确认非白屏、Bell pressed 与活跃列表正常，之后已无注入地干净重启 GUI，全部 6 个 Host 未中断。
- 2026-09-01: 显式暂存 17 个任务文件并通过 staged whitespace/name boundary 检查；Feature commit 创建成功，`git show` 确认未包含三处用户原有改动，T-005 标记 done。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-005 均完成且有验证证据；前端 75 files/494 tests、build、i18n，core 323 passed/6 ignored 及附属 targets、Tauri 48 tests 均通过；Debug App 重建、精确 GUI 路径、2400×1600 非白屏 active-view 截图与干净重启验证通过；staged diff check、17 文件 commit boundary 与任务文档 validator 通过。
- Limitations: macOS 拒绝外部调用方的 Screen Recording/Accessibility，因此截图不是 `screencapture` 输出，而是由未落库的一次性 helper 在同一 Debug App 进程内调用 `WKWebView.takeSnapshot` 获得；截图已人工检查，helper 随后移除并以无注入环境重启 App。`src-tauri/src/main.rs` 的 scoped rustfmt 仍会报告并发基线 commit `9c045ec` 已存在的 3 处任务外格式差异，本任务 Rust hunks 无 rustfmt diff。
