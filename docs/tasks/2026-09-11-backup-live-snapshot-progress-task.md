# Task Plan: 修复活跃会话下备份卡住并显示进度

- Created: 2026-09-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户报告 Codex 备份长时间禁用所有按钮，确认修复并增加状态。

<!-- task-doc-section:background-goal -->
## Background and goal

修复活跃 Host 持续写数据库时快照进度重启、长时间占用 GUI 数据库锁；显示阶段、进度、耗时并在超时后释放界面。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

只修改快照复制及备份状态反馈和回归测试；保持按 Agent 范围与不覆盖恢复契约。不停止 Host/connector，不修改其他用户工作。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 实际 GUI worker 卡在 backup_snapshot/run_to_completion，每步 32 页后睡眠 50ms，其他 GUI worker 等待 Db Mutex | /tmp/agent-backup-hang.sample；db/mod.rs backup_snapshot |
| F-002 | 实际数据库 11699×4096 字节，持续写入 | 只读 PRAGMA data_version 每秒变化 |
| F-003 | 未固定读事务的对照 3 秒重启 3 次；固定只读事务对照 19.93 秒完成 366 步且 0 重启 | 当前数据库只读连接、内存目标、相同 32 页/50ms 参数的对照实验 |
| F-004 | 当前没有发布备份 ZIP，只有快照临时文件 | backups/exports 文件元数据，不读取会话内容 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 保留单个备份/恢复任务串行执行；其他按钮禁用原因通过状态明确说明。
- Open question: 无；用户已选择修复并增加状态。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 持续写入时备份仍有限时间完成，并且使用一致性快照。
- 磁盘数据库快照不长时间持有 GUI Db Mutex；锁冲突/等待有界。
- 界面明确显示 Agent、执行阶段、进度和耗时，成功/失败后解禁。
- 故障回归先失败后通过；验证实际数据库路径并重启正确调试 GUI、截图确认。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无，顺序推进回归/核心契约/界面/实机。
- Serialization constraints: 同一 backup API 及其调用端共享进度协议。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 稳定、有界、独立连接快照

- Status: done
- Owner: coordinator
- Objective: 消除快照重启和 GUI DB 锁长时间占用。
- Inputs and prerequisites: 现场采样和只读对照证据。
- Scope or files: crates/agentport-core/src/db/backup.rs, db/mod.rs, backup.rs。
- Expected output: 回归测试、固定只读事务快照、超时和进度回调。
- Dependencies: None.
- Execution steps:
  1. 编写持续写入回归并记录失败。
  2. 独立连接固定读取视图，有界分步复制。
  3. 接入核心备份阶段回调并验证。
- Acceptance criteria:
  - 持续写入下完成；无需等待主 Db Mutex；错误不会无限重试。
- Verification method:
  - cargo test -p agentport-core backup --lib。
- Validation evidence: 持续写入回归旧实现失败（超过2秒预算，停写后3.798秒退出，/tmp/agent-backup-hang-red.log）；修复后3个快照测试通过（持续写入、固定视图/不持主锁、锁超时），35个备份相关测试通过。真实数据库显式只读诊断 backup_snapshot_live_source_read_only：268.999ms/46 steps/11699页、无回退且 integrity=ok，/tmp/agent-backup-live-fixed.log。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 阶段进度与耗时反馈

- Status: done
- Owner: coordinator
- Objective: 后台状态和前端任务准确关联。
- Inputs and prerequisites: T-001 回调协议。
- Scope or files: src-tauri/src/main.rs, src/src/api.ts, SettingsDialog, locales, 测试。
- Expected output: 快照、原生历史、文件打包、校验等状态；忙碌原因明确。
- Dependencies: T-001.
- Execution steps:
  1. 命令发送带 requestId 的进度事件。
  2. 前端订阅、显示阶段/计数/耗时，完成清理订阅。
  3. 添加进度、错误释放和事件关联测试。
- Acceptance criteria:
  - 无订阅竞态/其他任务串扰；失败和取消选择后可重试。
- Verification method:
  - 前端针对测试、build、i18n check、cargo check。
- Validation evidence: 前端相关11 tests passed（/tmp/agent-backup-progress-ui.log）；build、i18n:check、cargo check -p agentport 通过。覆盖订阅先于命令、requestId 过滤、阶段计数/耗时、超时解禁、订阅失败与组件卸载清理。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 实际快照验证与交付

- Status: done
- Owner: coordinator
- Objective: 验证原故障环境并提交最小修复。
- Inputs and prerequisites: T-001, T-002。
- Scope or files: 任务记录、调试 App、相关文档。
- Expected output: 真实数据只读快照验证、更新调试 GUI 和任务 commit。
- Dependencies: T-002.
- Execution steps:
  1. 使用当前数据源只读连接验证新路径。
  2. 统一脚本重建重启 GUI，不终止 Host。
  3. 截图验收、审查并仅提交本任务文件。
- Acceptance criteria:
  - 回归/相关测试通过，实际快照有界，GUI 正确渲染，任务独立提交。
- Verification method:
  - 实机诊断、restart-debug-app.py、ps、截图、git diff --check。
- Validation evidence: core 全 lib 串行 414 passed/7 ignored（其中新增显式真实源诊断已单独运行通过）；备份相关35 passed/1 ignored，前端11 passed；build/i18n/Rust check/diff check 通过。restart-debug-app.py 构建签名并仅重启 GUI，最终 PID 65866 路径精确为 target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport。实际点击 Codex：截图 /tmp/agent-backup-progress-running.png 显示 native 3/56、2秒及禁用说明；/tmp/agent-backup-progress-later.png 显示已完成、恢复按钮、归档及覆盖计数。归档 agentport-codex-20260910-180615-437.zip 为10445748字节，独立 Python 逐文件校验216个哈希/大小全部通过。覆盖 captured=5,total=56,missing=51（已明确告知用户不是完整原生历史备份）。截图 SHA-256 分别 b48aa79febf9718c6ff4d21778573fa37da4705a6a01b14a784c7fa64cd205de / d9fa297c089736b76867b4eea5e6c290510f083bc1f925f889670330469eec38。任务 commit（fix: pin live backup snapshots and report progress）已创建，仅含本任务14个路径；本最终状态记录 amend 到同一提交。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

最低稳定边界复现持续外部写入，先验证旧逻辑失败，再验证修复后完成及一致性；另测锁定目标超时和进度。前端验证订阅先于命令、requestId 隔离、阶段耗时、错误解禁。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

固定读事务会短暂延缓 WAL 回收，但不阻止 WAL 写入。SQLite 分步超时不能中止 OS 层无限 I/O。旧卡住任务需通过统一脚本关闭 GUI 解除；不得误杀承载 Session 的 Host。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-11: 已捕获现场及只读对照，用户确认修复；T-001 开始。
- 2026-09-11: T-001 回归先失败后通过，真实数据源只读快照0.269秒完成；T-001 done。T-002 顺序接入阶段事件/前端状态并完成11项测试和构建检查，T-002 done。T-003 开始实机验证。
- 2026-09-11: 统一脚本关闭旧 GUI PID 41171，启动新 GUI 65866；通过 AX 点击真实 Codex 备份，阶段/耗时可见且任务正常完成，216文件独立哈希校验通过。未向任何 Host/connector 发信号。
- 2026-09-11: 全 core lib 串行414通过；真实备份有51个原生历史缺失，已告知用户并保留原覆盖警告，不混入历史恢复范围。新增 SQLite 活跃备份教训到 LEARNS.md，仅暂存本任务新增小节，不纳入用户既有 remote-input 改动。
- 2026-09-11: 首次任务 commit 成功，已检查仅包含本任务14个路径；T-003 完成，最终记录并入同一提交。用户的 LEARNS remote-input 与 mobile 修改保持未暂存。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001/T-002/T-003 完成；回归先失败后通过，真实数据库快照与打包 GUI 路径已验证，相关测试/构建/截图/文档检查通过，已创建任务 commit。
- Limitations: 120秒上限针对数据库快照，不中止 OS 层无限 I/O，也不是整个原生历史备份的总时限。真实 Codex 包原生历史仅5/56可捕获，其余51缺失，覆盖警告保持可见。未执行全主题/屏幕阅读器完整审计；既有全量前端2个 SplitAgentPicker 图标断言失败不属于本次修复。
