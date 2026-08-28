# Task Plan: Agent 原生 Session 备份恢复整改

- Created: 2026-08-26
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求按最佳实践制定并执行整改：备份/恢复对象由已移除的 AgentPort 独立正文日志改为通过 AgentPort 打开的 Agent 原生 Session。

<!-- task-doc-section:background-goal -->
## Background and goal

当前 AgentPort 已改为按需读取 Agent 原生历史，且不再持久化 `output.log` 正文；现有备份仍只保存 SQLite 与 AgentPort Session 辅助文件，并明确排除 Pi 原生目录，无法在原生 Provider 数据丢失后恢复历史或按同一原生 ID Resume。目标是交付版本化、可校验、Provider-aware 的备份恢复：仅捕获 SQLite 中由 AgentPort 管理且能以原生 ID/CWD 安全绑定的 Claude、Codex、Pi、Kimi、Qoder Session artifact；Shell 明确不适用；恢复时不覆盖冲突的 Provider 数据，并保持旧 v1 备份可读。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Scope:
  - 备份格式升级为 v2，并兼容验证/恢复 v1。
  - 建立按 Provider、原生 ID、CWD 和 canonical containment 选择 artifact 的统一备份/恢复模块。
  - 在归档中保存原生 Session artifact、覆盖率及逐文件 SHA-256；恢复到新 AgentPort 数据根时安全 materialize 到当前配置的 Provider home。
  - 冲突时拒绝覆盖；相同文件幂等复用；恢复失败不发布目标 AgentPort 数据根。
  - Tauri、CLI、前端设置页与中英文文案展示原生 Session 覆盖率、旧格式能力和敏感正文提示。
  - 更新 PRD/安全与用户文档中的数据边界。
- Non-goals:
  - 不备份完整 Provider home、账号配置、系统凭据库、Worktree、项目代码、导出物或诊断包。
  - 不实现把备份合并导入当前 SQLite 数据库，也不重映射原生 Session ID。
  - 不保证跨机器项目绝对路径自动重写；项目/CWD 不存在时明确限制 Resume。
  - 不改变 Agent 原生格式或把正文写入 SQLite/FTS。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前 v1 manifest 只描述 `agentport.db` 与 `sessions/**` payload。 | `crates/agentport-core/src/backup.rs:1-54` |
| F-002 | 当前备份明确跳过 `output.log` 和每个 Session 的 `pi/` 原生目录，且不遍历 Provider home。 | `crates/agentport-core/src/backup.rs:187-229` |
| F-003 | 原生 ID 由 hook events、DB scalar 和 Session-local `agent_session_id` 共同提供；历史解析按 Provider、ID、CWD 和 Provider root containment 绑定。 | `crates/agentport-core/src/history.rs:487-806` |
| F-004 | Claude/Codex/Kimi/Qoder 原生 artifact 位于各自 Provider home；Pi 位于 AgentPort Session 目录；Shell 无原生会话。 | `crates/agentport-core/src/history.rs:644-836`, `crates/agentport-core/src/adapters/pi.rs:1-196` |
| F-005 | 原生永久删除已经实现 exact ID/CWD、canonical root containment 和有界目标选择，可作为安全规则依据。 | `crates/agentport-core/src/native_cleanup.rs:1-260` |
| F-006 | 当前恢复先 verify、解压到 sibling staging、检查 SQLite integrity/schema，再保留旧 target 并 rename 发布。 | `crates/agentport-core/src/backup.rs:440-548` |
| F-007 | 当前设置页只显示文件数与结构完整性，并明确声称不复制 Agent 原生日志。 | `src/src/components/SettingsDialog.tsx:711-900`, `src/src/locales/fragments/zh-CN/settings-ui.json:229-278` |
| F-008 | 工作区存在大量用户未提交改动，本任务必须进行小范围增量修改，禁止 reset、覆盖或格式化无关文件。 | 2026-08-26 `git status --short` 输出；相关文件包括 backup/core/Tauri/UI/docs。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “通过 AgentPort 打开的”以备份时 SQLite 中存在的 Session 行及其可信原生 ID 证据为边界；影响是 Provider 中其他 Session 不会进入归档；通过 provider fixtures 和负例验证。
- Assumption: 首版恢复到当前配置的 Provider home，支持同机/同用户及自定义 Provider home；项目绝对路径变化不自动重写；影响是跨机 Resume 可能需先重新定位项目，UI/文档必须明示。
- Assumption: 缺失或歧义的原生 Session 不阻止生成结构完整的归档，但结果必须标记 coverage incomplete，不能显示为完整备份。
- Assumption: Provider 目标已存在且逐文件相同视为幂等复用；任何内容冲突均阻止恢复，绝不覆盖。
- Open question: 无阻塞问题；用户已授权按上一轮推荐方案制定并执行，以上保守策略作为本轮执行合同。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 新备份 writer 生成 format v2；verify/restore 继续接受 format v1。
- v2 只包含 DB 中 AgentPort Session 对应的原生 artifact，不包含同 Provider 下未关联 Session、系统凭据或完整配置目录。
- Claude、Codex、Pi、Kimi、Qoder 至少有 fixture 证明 capture/restore；Shell 计为 unsupported。
- manifest 和 API 报告 total/captured/missing/ambiguous/unsupported，UI 对 incomplete 使用警告而非完整成功。
- 恢复前完成完整 archive 校验、SQLite integrity 与 foreign-key 检查、Provider 目标冲突预检；冲突时不覆盖 Provider 文件且不发布目标数据根。
- 恢复成功后原生 artifact 位于各 Provider 可恢复位置；Pi 位于恢复后的 AgentPort Session 目录；Kimi index 可定位恢复目录。
- v1 roundtrip、zip-slip/篡改/资源限制与 `output.log` 排除回归继续通过。
- CLI/Tauri/前端类型和中英文文案与新响应契约一致。
- 相关 Rust/前端测试、格式/静态检查通过；按仓库规则重建并打开 Debug App，确认精确 debug GUI 进程及非白屏窗口；若 macOS TCC 阻止截图，仅可由用户明确豁免并接受精确 PID/path 与 onscreen layer-0 主窗口证据。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004.
- Parallel batches: 当前核心合同和共享文件高度耦合，执行图为串行；每项完成并验证后释放下一项。
- Serialization constraints: `backup.rs` 依赖 T-001 artifact API；Tauri/CLI/UI 依赖 T-002 report/manifest 合同；最终构建依赖全部代码与文案完成。Authority document 仅由 coordinator 修改。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 原生 Session artifact 规划与安全恢复模块

- Status: done
- Owner: coordinator（subagent 结果 inconclusive 后接管）
- Objective: 为五类 Agent 建立只选择 AgentPort 关联 Session 的 provider-aware capture plan、coverage 和 conflict-safe materialization API。
- Inputs and prerequisites: F-003 至 F-005；现有 history/native_cleanup 规则；保留用户未提交改动。
- Scope or files: `crates/agentport-core/src/native_backup.rs`（新增）、`crates/agentport-core/src/lib.rs`，必要时对 `history.rs` 作最小可见性调整。
- Expected output: 可由 backup v2 调用的序列化 native session/artifact 描述、staged capture 与 restore preflight/materialize API，以及 Provider fixtures。
- Dependencies: None.
- Execution steps:
  1. 设计逻辑 archive path、Provider-relative target 与 coverage 类型。
  2. 按 exact ID/CWD/containment 枚举 Claude、Codex、Pi、Kimi、Qoder artifact；Shell 标记 unsupported。
  3. 实现固定长度 staging copy/hash、目标冲突预检与幂等安装；Kimi index 原子更新。
  4. 添加仅关联 Session、路径逃逸、相同/冲突目标和 Provider roundtrip 测试。
- Acceptance criteria:
  - 不扫描/复制完整 Provider 配置根或无关 Session。
  - symlink/parent traversal/多匹配被拒绝或标记 ambiguous。
  - materialize 不覆盖不同内容，失败可清理本轮新建文件。
- Verification method:
  - `cargo test -p agentport-core native_backup -- --test-threads=1`
- Validation evidence: `cargo test -p agentport-core native_backup -- --test-threads=1`：7 passed、0 failed；覆盖 Claude 关联选择/幂等恢复、Codex 歧义、Pi 目标根、Kimi 目录与 index、Qoder 精确目录、Shell/missing coverage、冲突不覆盖。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 备份 v2、兼容验证与恢复事务集成

- Status: done
- Owner: subagent-T-002 + coordinator review/fix
- Objective: 将 T-001 集成到现有 create/verify/restore，并保持 v1 兼容和现有安全边界。
- Inputs and prerequisites: T-001 API 和测试通过；现有 backup v1 测试。
- Scope or files: `crates/agentport-core/src/backup.rs`。
- Expected output: v2 manifest/report、native payload 打包、coverage、v1/v2 verify、恢复 preflight/materialize、FK 校验和 rollback。
- Dependencies: T-001.
- Execution steps:
  1. 扩展 manifest/report，writer 切换 v2，reader 分支接受 v1/v2。
  2. 从 DB Session 清单生成 plan 并只从 staging 打包 native payload。
  3. 恢复时校验 DB/原生目标，materialize 成功后再发布 target。
  4. 扩展 roundtrip、v1 compatibility、partial、冲突与完整性测试。
- Acceptance criteria:
  - acceptance criteria 中核心备份/恢复条目全部由单元测试覆盖。
  - 冲突不发布 target；v1 无 native payload 仍可恢复。
- Verification method:
  - `cargo test -p agentport-core backup -- --test-threads=1`
  - `cargo fmt --all -- --check`
- Validation evidence: `cargo test -p agentport-core backup -- --test-threads=1` 最终 21 passed、0 failed；首次运行 20 passed/1 failed 暴露 FK fixture 未关闭约束，修正 fixture 后通过。`rustfmt --edition 2021 crates/agentport-core/src/{backup,native_backup}.rs` 通过。额外 review 将 Kimi 单 binding 改为 rollover-safe 多 binding，并阻止 incomplete manifest 伪造 index binding。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — CLI/Tauri/UI/文案与产品边界同步

- Status: done
- Owner: subagent-T-003 + coordinator review
- Objective: 暴露 coverage/restore 结果并让用户清楚看到原生正文范围、partial 和冲突风险。
- Inputs and prerequisites: T-002 稳定的 Rust report/manifest 合同。
- Scope or files: `crates/agentport-cli/src/main.rs`, `src-tauri/src/main.rs`, `src/src/api.ts`, `src/src/components/SettingsDialog.tsx`, `src/src/locales/fragments/{zh-CN,en-US}/settings-ui.json`, 相关前端测试，`AgentPort_PRD.md`, `docs/security.md`, `docs/user-guide.md`, `docs/known-limitations.md`。
- Expected output: CLI/Tauri JSON、TS 类型、Settings coverage UI、双语隐私/恢复说明和更新后的文档。
- Dependencies: T-002.
- Execution steps:
  1. 更新 CLI/Tauri 返回和错误合同。
  2. 更新 API 类型、设置页状态与 partial warning 测试。
  3. 同步中英文文案及 PRD/安全/用户文档。
- Acceptance criteria:
  - 完整和 partial 备份显示不同；verify 显示格式和 native coverage。
  - 文案不再承诺“不复制 Agent 原生日志”，明确归档可能包含敏感对话且不含系统凭据。
- Verification method:
  - `cargo test -p agentport-cli`
  - `cargo test --manifest-path src-tauri/Cargo.toml`
  - `cd src && npm test -- --run <targeted-tests>`
  - `cd src && npm run build`
- Validation evidence: `cd src && npm test -- --run src/components/SettingsDialog.backup.test.tsx`：3/3 passed；`npm run build` passed；`npm run i18n:check` passed；`cargo test -p agentport-cli`：4/4 integration tests passed；`cargo test --manifest-path src-tauri/Cargo.toml`：44/44 passed。Coordinator review 修正文案中“Secret 绝不入包”的错误承诺，明确已输出到原生正文的 Secret 可能被复制。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成回归与 Debug App 验收

- Status: done
- Owner: coordinator
- Objective: 验证跨层合同、无关回归和真实 Debug App 渲染。
- Inputs and prerequisites: T-001 至 T-003 done。
- Scope or files: 测试/构建产物与本 authority document；不新增功能代码，除非修复本任务回归。
- Expected output: 当前 checkout 的目标测试、构建、i18n/diff 检查及 Debug App 运行证据。
- Dependencies: T-003.
- Execution steps:
  1. 运行相关 Core/Tauri/CLI/前端测试和 build。
  2. 检查 diff、格式、i18n 与未覆盖失败。
  3. 运行 `scripts/rebuild-debug-app.sh`，仅关闭旧 debug GUI，`open -n` 启动并核验进程路径。
  4. 截图确认设置页/窗口非白屏。
- Acceptance criteria:
  - 所有必需检查通过，或明确记录与本任务无关且已隔离的既有失败。
  - debug GUI 可执行路径精确匹配 workspace target，截图非白屏。
- Verification method:
  - 以执行日志记录的实际命令为准。
- Validation evidence: `cargo test -p agentport-core -- --test-threads=1`：lib 314 passed/6 ignored，随后 integration 30 passed/1 unrelated failed；失败为既有 `git_workspace_commit::startup_recovery_classifies_committed_and_unexecuted_journals_from_git_truth`，单独复跑仍失败，路径不涉及本任务。`cd src && npm test -- --run`：50 files、324 tests 全通过。`cargo test -p agentport-cli`：4/4；Tauri 44/44；frontend build/i18n 通过；`git diff --check` 通过；task-owned Core files rustfmt check 通过。最终一次 `scripts/rebuild-debug-app.sh` 成功；旧 debug GUI PID 94850 单独关闭，当前 debug GUI PID 98108 的 executable path 精确匹配 workspace。最终复核 CGWindow 主窗口 windowID 2918、1200x800、alpha=1、onscreen=1；用户明确豁免被 TCC 阻止的截图验收。
- Blocker: None. 用户于 2026-08-26 明确豁免截图验收，接受精确 PID/path 与 onscreen layer-0 window 证据；此前 TCC `-3801` 限制保留为验证限制。
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Core unit: Provider artifact selection、固定长度捕获、v1/v2 manifest、hash/zip-slip/limits、相同/冲突目标、Kimi index、Pi 目标数据根。
- Core integration: create -> verify -> restore 使用隔离 Provider home，确认非关联 Session 不进入 ZIP、目标冲突不发布 data root。
- Contract: CLI/Tauri JSON 字段和前端 API 类型一致。
- UI: complete/partial/legacy 状态、隐私提示、错误状态。
- Regression: 现有 backup tests、Core 相关套件、Tauri/CLI tests、前端定向与 build。
- Runtime: 标准 debug rebuild、精确 PID path、非白屏截图；不关闭 release App 或无关 `agentport-host`。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 工作区已有大量未提交改动且与本任务共享文件；必须检查局部 diff，不得 reset/checkout/全文件重写无关区域。
- 原生日志可含源码、工具输出和正文中的 Secret；备份 ZIP 不是加密容器，UI/文档必须明确。
- Provider 原生格式可能变化；选择规则必须 fail closed，并以 coverage missing/ambiguous 暴露。
- Kimi 依赖共享 index；更新失败必须回滚，不能留下目录已安装但 index 不可达的假成功。
- 多 Provider root 不具备单一 rename 原子性；实现先做完整冲突预检，再只创建缺失文件并保留 rollback 清单。
- 活跃 Agent 可能追加原生 JSONL；capture 使用固定初始长度，不能无限追写，也不宣称多文件全局同时点。
- 当前 socket 仅按用户和 Session ID 命名；恢复后的旧 Host 冲突风险由不自动启动 Session、生命周期消毒/现有启动校验和文档限制控制，本任务不自动 Resume。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-26 19:42 +0800: Task document created in execute mode。
- 2026-08-26 19:50 +0800: 完成仓库证据、dirty baseline 与方案合同记录；T-001 进入 in_progress，authority document 由 coordinator 独占。
- 2026-08-26 19:55 +0800: T-001 writer subagent 返回 `task_inconclusive`，candidate 未集成；coordinator 接管，不采用未验证候选。
- 2026-08-26 20:20 +0800: T-001 完成；新增 `native_backup.rs` 和模块导出，定向 Core 7/7 通过。T-002 进入 in_progress。
- 2026-08-26 20:32 +0800: 集成 T-002 candidate；首次 backup 定向测试 20/21，通过失败定位为测试 fixture 自身 FK 写入被 SQLite 拒绝，关闭 fixture FK 后重跑 21/21。
- 2026-08-26 20:38 +0800: coordinator 对 v2 manifest 做对抗审阅，修正 Kimi 多 rollover binding 与 incomplete binding 注入风险；backup 定向仍为 21/21。T-002 done，T-003 in_progress。
- 2026-08-26 20:47 +0800: 集成并复核 T-003；前端定向 3/3、build、i18n、CLI 4/4、Tauri 44/44 通过。修正文案和安全合同，说明 transcript 中已出现的 Secret 仍可能入包。
- 2026-08-26 20:52 +0800: 对抗审阅发现 untrusted v2 manifest 可将 artifact 指向 Provider 配置文件；新增 provider/session target-prefix 验证和恶意 `settings.json` 回归，backup 定向增至 22/22。T-003 done，T-004 in_progress。
- 2026-08-26 21:03 +0800: 全前端 50 files/324 tests、CLI、Tauri、build、i18n、diff check 通过。Core lib 314 passed/6 ignored；integration 仅既有 Git commit recovery 测试失败，单测复跑确认稳定且与本任务路径无关。
- 2026-08-26 21:10 +0800: 标准 debug rebuild 成功；仅关闭旧 debug GUI PID 30871，重新打开后当前 PID 94850 executable path 精确匹配，CGWindow 为 onscreen layer-0 1200x800。ScreenCaptureKit 与 screencapture 均被 TCC 拒绝，T-004 因无法完成非白屏截图转 blocked。
- 2026-08-26 21:14 +0800: 将已验证的 untrusted native manifest 语义路径教训追加到 `LEARNS.md`；未改写其他历史条目。
- 2026-08-26 21:20 +0800: Kimi binding 增加 index entry 原生 ID/CWD 一致性验证，backup 22/22 复验通过；重新执行最终 debug rebuild，仅关闭旧 PID 94850，新 PID 98108 路径精确且 onscreen window 存在。截图仍被同一 TCC blocker 阻止。
- 2026-08-26 21:28 +0800: 用户要求继续；完整读取 authority document、刷新 dirty baseline、确认 debug PID 98108 仍运行。再次尝试 ScreenCaptureKit 与系统 `screencapture`，分别稳定失败为 TCC `-3801 user declined` 与 `could not create image from display`；T-004 保持 blocked，等待屏幕录制授权或用户豁免截图验收。
- 2026-08-26 21:31 +0800: 用户明确选择“豁免截图验收”，接受精确 debug PID/path 与 onscreen layer-0 window 证据；T-004 由 blocked 转回 in_progress，准备最终状态复核。
- 2026-08-26 21:33 +0800: 最终复核 PID 98108 路径精确，CGWindow 主窗口 windowID 2918、1200x800、alpha=1、onscreen=1，`git diff --check` 通过；按用户豁免完成 T-004，全部任务 done。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-004 全部 done；Core backup 22/22、前端 324/324、CLI 4/4、Tauri 44/44、build、i18n、diff check 通过；task document validator 最终通过。Debug App PID/path 和 onscreen 主窗口完成当前复核，用户明确豁免 TCC 阻止的截图。
- Limitations: macOS TCC 未授予当前进程屏幕录制权限，因此没有 PNG 截图。全 Core 回归另有一个与本任务无关、在当前 dirty baseline 中稳定复现的 Git commit recovery 测试失败；本任务路径与定向测试均通过。
