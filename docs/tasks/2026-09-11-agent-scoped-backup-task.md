# Task Plan: 按 agent 类型备份与合并恢复

- Created: 2026-09-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户确认按类型备份 AgentPort 管理会话、合并恢复、兼容旧备份。

<!-- task-doc-section:background-goal -->
## Background and goal

设置页按 agent 类型备份和恢复，恢复缺失会话但不覆盖现有会话或影响其他类型。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

包含会话元数据及原生历史；不包含外部会话、凭据和全局配置。不变更用户已有未提交修改。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前备份为完整 SQLite 快照，恢复发布到另一个目录 | crates/agentport-core/src/backup.rs create/restore |
| F-002 | 设置页调用 Tauri backup_create/backup_restore | src/src/components/SettingsDialog.tsx; src-tauri/src/main.rs |
| F-003 | 原生恢复拒绝覆盖不同内容 | crates/agentport-core/src/native_backup.rs materialize |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 用户已确认旧整库备份可读取，但仅恢复选中类型。
- Open question: 无。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 每种受支持类型有独立备份恢复入口。
- 归档仅包含选中类型及必要依赖，不泄露其他类型或全局设置。
- 合并恢复保留现有会话，冲突可见，其他类型不受影响。
- 旧备份兼容，错误类型、安全校验与原生冲突有测试。
- 验证、提交本任务修改，重建重启调试 App 并确认渲染。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无；按核心契约、调用端、集成验证顺序执行。
- Serialization constraints: API/归档语义确定后接入界面，避免共享契约并发改写。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 核心按类型备份与合并恢复

- Status: done
- Owner: coordinator
- Objective: 安全筛选快照，合并缺失会话并验证冲突。
- Inputs and prerequisites: 已确认需求及现有 SQLite/native backup 契约。
- Scope or files: crates/agentport-core/src/backup.rs, db, 核心测试。
- Expected output: 按类型核心 API 和回归测试。
- Dependencies: None.
- Execution steps:
  1. 筛选快照及关联元数据。
  2. 验证归档后合并缺失会话，不覆盖现有数据。
  3. 添加隔离、冲突与兼容测试。
- Acceptance criteria:
  - 类型隔离、无静默覆盖，旧归档可筛选导入。
- Verification method:
  - cargo test -p agentport-core backup
- Validation evidence: cargo test -p agentport-core backup --lib：32 passed。覆盖隔离及 SQLite 空闲页敏感内容、v1/v2、项目映射、重复恢复、类型/项目/原生 ID/原生文件冲突、Worktree/status 导入、失败后重试；日志 /tmp/agent-backup-core-final.log。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 设置界面和命令接入

- Status: done
- Owner: coordinator
- Objective: 按类型显示动作、状态及合并结果。
- Inputs and prerequisites: T-001 核心 API。
- Scope or files: src-tauri/src/main.rs, src/src/api.ts, SettingsDialog, locales, 界面测试。
- Expected output: 中英文按类型备份恢复界面。
- Dependencies: T-001.
- Execution steps:
  1. 接入命令和类型。
  2. 替换全量动作，展示合并恢复确认与结果。
  3. 添加交互测试。
- Acceptance criteria:
  - 选择类型传递一致，忙碌禁用、错误和成功反馈明确。
- Verification method:
  - 前端针对测试、类型检查、i18n 和构建；Rust check。
- Validation evidence: SettingsDialog.backup + api-backup-contract：8 passed；npm run build、npm run i18n:check、cargo check -p agentport 通过。每个 Agent 一行，原生按钮/可访问名称/忙碌禁用/错误与跳过列表覆盖交互测试。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成验证与交付

- Status: done
- Owner: coordinator
- Objective: 验证端到端契约并提交。
- Inputs and prerequisites: T-001, T-002 完成。
- Scope or files: docs/user-guide.md, 本文档，调试 App。
- Expected output: 验证证据、任务 commit、更新调试窗口。
- Dependencies: T-002.
- Execution steps:
  1. 审查安全边界、运行相关测试并更新文档。
  2. 使用统一脚本重建和重启，确认进程路径及截图。
  3. 仅提交本任务文件。
- Acceptance criteria:
  - 测试通过，调试窗口更新，无其他工作混入提交。
- Verification method:
  - git diff --check; restart-debug-app.py; ps; 截图。
- Validation evidence: cargo test -p agentport-core -- --test-threads=1 全部通过（lib 411 passed/6 ignored，加 71 个集成测试）；32 个 backup 相关测试通过；前端相关 8 passed；build、i18n、Rust check 和 git diff --check 通过。全量前端 646 passed/2 failed，干净 HEAD 临时目录复现相同 SplitAgentPicker SVG 断言失败。统一 restart-debug-app.py 构建签名并仅重启 GUI；PID 41171 executable 为本 checkout target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport。用户解锁后截图 /tmp/agent-backup-window-ready.png（2624×1824，SHA-256 c10443868bd34d945afffed62820d1f581809a5664b4cff8cd6325d5f84c80c1）确认 Backup & Restore 的独立 Agent 行、备份/恢复按钮正常渲染。git commit 成功（feat: back up and merge restore sessions per agent），仅包含 13 个本任务文件；最终状态记录 amend 到同一提交。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

核心测试覆盖混合类型归档筛选、旧备份恢复、重复恢复、同 ID 冲突、元数据依赖和原生冲突；前端测试验证类型参数及反馈。构建后只重启精确调试 GUI，不终止 Host/connector。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

SQLite 与原生文件并非同一事务；必须预检、保持不覆盖并清晰报告失败。共享项目与 worktree 需保留关联且不改动现有行。不得复制快照删除后的 SQLite 空闲页中其他类型内容。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-11: 需求已确认，检查现有整库实现；T-001 开始。已有 LEARNS.md/mobile 修改不属于本任务。
- 2026-09-11: T-001 完成 32 个相关测试；T-002 顺序接入并完成 8 个测试、类型/构建/i18n/Rust check；T-003 开始。
- 2026-09-11: 全量 core 首轮 410 passed/1 failed/6 ignored（adapter 自动探测），失败项单跑通过；前端全量 646 passed/2 failed，失败为未修改的 SplitAgentPicker 图标 SVG 断言，单跑仍失败。不混入该问题修复。
- 2026-09-11: core 全量串行重跑全部通过；干净 HEAD archive 的 SplitAgentPicker 单跑复现同两项失败，确认基线问题。
- 2026-09-11: 统一脚本重启调试 GUI 成功；初次黑屏截图由 IOConsoleUsers 的 CGSSessionScreenIsLocked=Yes 证实为锁屏。用户选择解锁后继续，随后实际截图确认渲染正常。不修改 LEARNS.md（本次为临时环境状态，已有用户改动）。
- 2026-09-11: 首次 feature commit 已创建并核对 13 个路径；T-003 完成，最终状态记录并入同一 commit，其他 LEARNS/mobile 修改保持未暂存。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001/T-002/T-003 完成，核心、命令契约、前端针对测试与打包/截图均通过；文档验证与 git diff --check 通过，已创建仅含本任务文件的 feature commit。
- Limitations: 全量前端有两个经干净 HEAD 复现的既有图标断言失败；未进行全主题对比度、屏幕阅读器及 200%/320px 完整可访问性审计。SQLite 与外部 Provider 文件不是一个原子事务，极端 I/O/提交失败后外部目录可能留下可复用的同内容文件，不覆盖已有数据。
