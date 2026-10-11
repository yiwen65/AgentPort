# Task Plan: 移除 Project 后保留并恢复 Session

- Created: 2026-10-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求删除 project 仅移除条目，不删除 session，同一路径重新打开后自动恢复。

<!-- task-doc-section:background-goal -->
## Background and goal

将 Project 移除从级联销毁改为列表隐藏，再次添加同一路径恢复原 Project 和 Session。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

修改 Core 持久化、桌面/Service/CLI 入口和确认文案，添加回归测试。保留运行中的 Host、日志、原生历史、Worktree 和 Git 操作记录。不改变单独删除 Session/Worktree 的语义，不恢复已经被旧版本永久删除的数据。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 原 Core remove_project 级联删除依赖并排入文件清理 | crates/agentport-core/src/db/mod.rs:1465 |
| F-002 | 桌面和 Service 删除入口停止 Host 并清理原生历史、Worktree | src-tauri/src/main.rs:1164；crates/agentport-service/src/lib.rs:1401 |
| F-003 | 添加入口通过标准化路径查找已注册 Project | src-tauri/src/main.rs:1083；crates/agentport-service/src/lib.rs:1314 |
| F-004 | 仓库要求验证后提交，使用统一脚本重启调试 GUI 并截图 | AGENTS.md |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “同一 project”按现有标准化 root_path 匹配；保留 ID 可维持全部关联，通过回归测试验证。
- Open question: 无；用户已授权明确的行为修改。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 移除后列表不含 Project，但 active/archived Session、运行信息、历史及 Worktree 均保留，不新增清理作业。
- 同一路径重新打开复用原 ID 并恢复 Session 列表，跨数据库重开仍有效。
- 列表排序/置顶只验证可见 Project；其他 Project 和单独删除行为不变。
- 桌面确认文案明确数据保留与恢复；桌面/Service/CLI 不再因移除 Project 停止进程或删除文件。
- 回归检查、版本同步和调试构建通过，精确路径的调试 GUI 已打开且截图非白屏，提交仅包含本任务改动。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 / T-002 / T-003 / T-005 -> T-004。
- Parallel batches: Core+桌面由 coordinator；Service+CLI 由 project-entrypoints；前端由 project-ui。
- Serialization constraints: 各自文件独占；Core 提供 restore_project(id)->Result<bool> 和 remove_project_confirmed(snapshot)->Result<()>；T-004 集成后统一验证，文档仅 coordinator 写入。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 持久化保留与桌面入口

- Status: done
- Owner: coordinator
- Objective: 移除仅隐藏 Project，同路径恢复原数据，桌面不清理依赖。
- Inputs and prerequisites: F-001 至 F-003；新 removed 列迁移。
- Scope or files: crates/agentport-core/src/db/mod.rs、models.rs；src-tauri/src/main.rs。
- Expected output: 软移除/恢复 API、可见列表布局和持久化回归测试。
- Dependencies: None.
- Execution steps:
  1. 添加迁移，更新删除/恢复和列表逻辑。
  2. 接入桌面，替换级联删除测试并验证关联数据保留。
- Acceptance criteria:
  - 不清理 Session/Worktree，恢复复用 ID，迁移和布局可用。
- Verification method:
  - cargo test -p agentport-core db::tests；Core 全量（低并发、时间阈值用例单独运行）；调试构建。
- Validation evidence: task-5 db::tests 62/62；task-7 Core 414 单测与 78 项 integration 通过、7 忽略；时间阈值 signing_timeout 用例全量中受负载影响失败，但 task-5 单独运行通过（全量跳过该 1 项）。task-9 前端 tsc/vite、全部 sidecar、带 tauri/custom-protocol 的桌面构建和固定证书签名验证通过。已验证隐藏/跨 Db 重开恢复/ID、归档 generation、运行身份与状态历史、Worktree/操作记录保留、可见列表布局。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Service 与 CLI 入口

- Status: done
- Owner: project-entrypoints
- Objective: 所有 Project 移除入口一致保留数据，添加入口恢复隐藏条目。
- Inputs and prerequisites: Core API 合同已固定，集成检查等待 T-001。
- Scope or files: crates/agentport-service/src/lib.rs；crates/agentport-cli/src/main.rs。
- Expected output: 入口修改和 Service 回归测试。
- Dependencies: None.
- Execution steps:
  1. 删除 Project 移除入口的进程/文件清理。
  2. 添加同路径恢复逻辑并更新针对性测试。
- Acceptance criteria:
  - Service/CLI 移除保留所有数据，Service 恢复同 ID。
- Verification method:
  - cargo test -p agentport-service -- --test-threads=1；cargo test -p agentport-cli；cargo check -p agentport-cli。
- Validation evidence: coordinator 已审查 diff；task-8 复核 Service 48/48、CLI 2 单测+4 integration、cargo check 全部通过。覆盖 Session/Host 元数据、Worktree/原生历史文件保留、Host socket 无连接、同路径恢复原 ID 和 stale preflight 拒绝。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 确认文案与前端回归

- Status: done
- Owner: project-ui
- Objective: 确认弹窗明确仅移除条目并可恢复，前端流程正确刷新列表。
- Inputs and prerequisites: API 保持 preflight 入参及返回类型，后端不再产生清理警告。
- Scope or files: src/src/actions.ts；git-removal-flows.test.ts；locales/fragments/*/shell-extra.json。
- Expected output: 准确中英文文案和确认/取消/恢复回归。
- Dependencies: None.
- Execution steps:
  1. 更新非破坏性的确认文案及相关流程。
  2. 更新测试并验证。
- Acceptance criteria:
  - 不宣称不可逆销毁，确认/取消及重新添加刷新工作正常。
- Verification method:
  - npm --prefix src test -- src/git-removal-flows.test.ts；完整前端测试；i18n:check 审计。
- Validation evidence: coordinator 已审查 diff，npm --prefix src test 全部 119 个文件、981 项测试通过；子任务针对性 9/9、tsc 通过。i18n:check 仅报告两个未改动文件的既有问题（src/deviceSwitch.ts:94、crates/agentport-core/src/adapters/capability.rs:539），改动文案无问题，作为范围外限制记录。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成验证、调试重启与提交

- Status: done
- Owner: coordinator
- Objective: 检查所有改动、运行针对性验证，打开更新后的 GUI 并提交。
- Inputs and prerequisites: T-001 至 T-003 完成。
- Scope or files: 本任务 diff、docs/user-guide.md 行为说明、LEARNS.md 已验证 renderer 清理经验；统一调试脚本；本任务文档。
- Expected output: 检查结果、截图、Git commit。
- Dependencies: T-001, T-002, T-003, T-005.
- Execution steps:
  1. 检查协作 diff，运行 Rust/前端/版本验证。
  2. 统一脚本构建签名重启，ps 核对 GUI 路径并截图。
  3. 更新记录并仅提交本任务文件。
- Acceptance criteria:
  - 所有必要检查通过，调试 App 非白屏，任务改动已提交。
- Verification method:
  - 测试结果、git diff --check、check-version-sync.sh、ps 和截图、任务文档校验。
- Validation evidence: Core/Service/CLI 和前端结果见 T-001/2/3/5；task-9 调试构建及固定证书签名通过，ps 精确核对 GUI PID 26833 路径，task-11 定位 window 10815 并截图 /tmp/agentport-project-preserve-debug.png，coordinator read 图片确认侧栏和双 pane 正常渲染（非白屏）。版本同步、独立/连续审查完成；最终 git diff --check、任务文档校验、staged diff 检查通过，并成功创建仅含本任务 14 个文件的 Git commit。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 隐藏 Project 后释放 renderer attachment

- Status: done
- Owner: project-ui
- Objective: Session 不在可见树时仅释放 renderer 连接，避免隐藏后的后台全量输出流和资源残留；不停止 Host。
- Inputs and prerequisites: 独立审查发现 pruneHandles 使用 disposeHandle 丢失 attachmentId，watch_loop 仍会发送全量输出；coordinator 已复核调用链。
- Scope or files: src/src/terminals.ts；src/src/terminals-renderer.test.ts。
- Expected output: 利用现有 generation-fenced releaseTerminal 安全释放连接的最小补丁和实际 handle 回归。
- Dependencies: T-003.
- Execution steps:
  1. 创建真实 mock terminal handle，验证隐藏项目触发安全 detach 而非仅 dispose。
  2. 处理重复 snapshot/refresh prune 与快速重新选择的 generation 竞态，保留可见项目 handle。
- Acceptance criteria:
  - 隐藏运行中 Session 的 renderer attachment 释放一次且不停止 Host；恢复/重选的新连接不被旧 release 清理。
- Verification method:
  - npm --prefix src test -- src/terminals-renderer.test.ts src/git-removal-flows.test.ts；TypeScript 编译。
- Validation evidence: 三项新增真实 handle/mock transport 回归在补丁前失败（detach 为零），直接复用 releaseTerminal 后 127 renderer 测试通过；coordinator task-10 复核 renderer+删除流程共 136/136 通过，diff 审查和子任务 tsc 均通过；覆盖重复 prune、可见其他 Session、snapshot/detach pending 时重新 attach 的 generation 安全。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Core 检查隐藏和恢复、迁移、依赖保留、布局及跨数据库重开；Service 检查同路径恢复及不调用 Host 清理；前端检查文案和状态刷新。运行必要 Rust/前端检查、版本同步，使用 scripts/restart-debug-app.py 构建并重启，精确 GUI 路径核对后截图。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

隐藏不等于销毁：内部 get_project 仍可供运行中的 Host/Session 使用；公开列表必须过滤隐藏项目。旧版本已经删除的数据无法凭此恢复。尚无阻塞。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 确认 Core、桌面、Service、CLI 的原删除链路，固定软移除和恢复 API，开始三个独占文件任务。
- 2026-10-11: 已检查协作 diff；前端全量 981 项测试通过，T-003 完成；i18n 全局检查的两个既有范围外问题已复核未改动。
- 2026-10-11: 新增 Core 回归的返回形状和 legacy run 基数断言已按实际 API 修正；db::tests 62/62 通过。首次高并发全量 Core 的两个范围外测试失败，单独复跑均通过，正在以 test-threads=4 重跑全部 Core 并复核 Service/CLI。
- 2026-10-11: Service/CLI 子任务返回：Service 48/48、CLI 新回归 1/1、cargo check 通过；独立只读审查进行中。
- 2026-10-11: 独立审查指出隐藏 Session 后 pruneHandles 仅销毁前端而未 detach renderer；复核后追加必要 T-005，保留运行中的 Host 但释放显示连接。
- 2026-10-11: Core 414 单测与全部 integration 通过（只跳过已单独通过的时间阈值用例）；Service 全量复核遇到无改动的 EOF 时序用例失败，Project 两项回归均通过，后续低并发复核。
- 2026-10-11: task-8 低并发 Service 全部 48 项通过（含原 EOF 时序用例）；CLI 全部 6 项和 cargo check 通过，T-002 验收完成。
- 2026-10-11: T-005 三项新增回归先失败后通过；coordinator task-10 复核 136/136、版本同步和 diff 检查通过，T-005 完成。将已验证的 renderer dispose≠detach 陷阱记录到 LEARNS.md；独立审查继续复核补丁。
- 2026-10-11: task-9 统一脚本正在构建/签名/重启调试 GUI，未进行手动查杀。
- 2026-10-11: task-9 构建和固定证书签名成功，仅关闭精确旧 GUI PID 97983，打开精确调试 GUI PID 26833；T-001 完成、T-004 进入最终截图/提交阶段。只读连续审查确认 renderer 修复解决原问题，未发现其他 actionable 问题。
- 2026-10-11: task-11 ps 核对精确 GUI 路径，激活其 window 10815 并截图；read 确认侧栏和双 pane 非白屏。最终 diff 检查发现新增经验末尾多一空行，已修正，准备提交。
- 2026-10-11: 最终 diff、任务文档、版本同步和 staged diff 检查通过，Git commit 已成功创建；T-004 完成，所有任务验收完成，完成状态记录纳入该本地提交。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-005 全部完成；保留/恢复、Session/Host 权限数据、Worktree/原生历史和 renderer 连接的回归通过，任务文档和 diff 校验通过，精确调试 GUI 已构建签名重启并截图非白屏，任务改动已创建 Git commit。
- Limitations: i18n 全局 checker 的两个既有范围外问题未修改。Core 一个时间阈值用例全量负载下失败、单独通过；Service 一个 EOF 时序用例并发失败、串行全量通过。保留/恢复使用临时数据回归，不在用户真实项目上执行移除；截图验证真实 App 正常渲染，不等于完整手工删除/恢复端到端验证。
