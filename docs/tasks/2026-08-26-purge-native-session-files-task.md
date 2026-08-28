# Task Plan: 永久删除 Session 时同步删除 Agent 原生 Session 文件

- Created: 2026-08-26
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户确认的需求契约（clarify-requirements 阶段，2026-08-26 会话）

<!-- task-doc-section:background-goal -->
## Background and goal

当前 AgentPort 永久删除（purge）一个已归档 Session 时，只清理数据库行与 AgentPort 自有 session 目录（经 `cleanup_jobs` 耐久队列），agent 原生侧的记录文件（如 `~/.claude/projects/<slug>/<id>.jsonl`、Codex rollout 文件、Kimi sessionDir、Qoder segment 目录）全部残留，用户在 agent 原生 CLI（如 `claude --resume`）里仍能看到已删除的会话。

目标：在全部三个永久删除入口（`delete_archived_session` / `delete_project_archived_sessions` / `delete_all_archived_sessions`）purge 成功后，尽力删除该 session 的全部原生产物；失败仅告警（日志 + UI toast），不阻断 purge。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**Scope**
- agentport-core 新增原生文件清理模块：按 session id 精确匹配解析并删除各 adapter（claude / codex / kimi / qoder）的原生产物。
- 三个 purge 入口在 DB 提交后执行原生清理，失败时 emit 告警事件。
- 前端监听告警事件并 toast 提示（含 i18n）。
- 单元测试 + 构建验证 + Debug App 重启验证（按 AGENTS.md）。

**Non-goals（已确认关闭的分支）**
- 归档（archive）时不删除任何原生文件；unarchive 流程零改动。
- 不新增侧边栏「直接删除」入口。
- 原生文件删除失败不中止 purge，也不进入 `cleanup_jobs` 重试队列。
- 不修改永久删除确认弹窗文案。
- 不做整目录清理（如整个 `~/.claude/projects/<slug>/`），只删与 session id 精确匹配的文件/目录。
- shell adapter 无原生文件，为 no-op；pi 的原生 transcript 位于 AgentPort 自有 session 目录内（`session_dir/pi/*.jsonl`），已被现有 cleanup job 的 `remove_dir_all(session_dir)` 覆盖，无需新增逻辑。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 三个永久删除入口位于 src-tauri，purge 后调用 `cleanup_purged_sessions` 触发耐久清理队列 | `src-tauri/src/main.rs:2648` `delete_archived_session`、`:2667` `delete_project_archived_sessions`、`:2701` `delete_all_archived_sessions` |
| F-002 | purge 事务删除 session 全部 DB 行并入队 cleanup job；purge 后无法再查询 session 记录 | `crates/agentport-core/src/db/mod.rs:2462` `purge_archived_session`、`:2503` `purge_project_archived_sessions`、`:2559` `purge_all_archived_sessions` |
| F-003 | Session 模型含 `adapter_type: AgentType`、`agent_session_id: Option<String>`、`cwd: String` | `crates/agentport-core/src/models.rs:393-427` |
| F-004 | history.rs 已有完整的原生 transcript 解析逻辑：`collect_native_ids`（合并 hook events 与 agent_session_id）、`resolve_claude/codex/pi/kimi/qoder`、`cwd_slug`、`configured_home`、`source()`（含 canonicalize + root 前缀校验） | `crates/agentport-core/src/history.rs:423-780` |
| F-005 | 原生路径布局：claude=`<CLAUDE_CONFIG_DIR\|~/.claude>/projects/<cwd_slug>/<id>.jsonl`；codex=`<CODEX_HOME\|~/.codex>/sessions/**` 按 session_meta id+cwd 匹配；kimi=索引 `session_index.jsonl` 指向 sessionDir（transcript 为 `agents/main/wire.jsonl`）；qoder=`<QODER_HOME\|~/.qoder>/logs/sessions/<cwd_slug>/<id>/segments/*.jsonl`；pi=AgentPort session 目录内 | `crates/agentport-core/src/history.rs:595-780` |
| F-006 | session 可能拥有多个原生 id（/clear、fork、compact 轮转），`collect_native_ids` 从 hook events 文件按序收集；该文件在 AgentPort session 目录内，cleanup job 会删除它 | `crates/agentport-core/src/history.rs:507-552`、`src-tauri/src/main.rs:557-575` |
| F-007 | 后台清理调度线程周期性运行 `run_due_cleanup_jobs`，与 purge 命令并发存在 | `src-tauri/src/main.rs:625-656` `ensure_cleanup_scheduler` |
| F-008 | 前端有全局 `toast(text, kind)`（store.ts:409）与 tauri `listen` 事件封装（api.ts），后端用 `app.emit(...)` 推送 | `src/src/store.ts:409`、`src/src/api.ts:596-655`、`src-tauri/src/main.rs:1390+` |
| F-009 | i18n 资源位于 `src/src/locales/{en-US,zh-CN}` | `ls src/src/locales` |
| F-010 | AGENTS.md 要求 UI/App 行为改动后执行 `bash scripts/rebuild-debug-app.sh` 并 `open -n` 调试包、截图确认渲染 | `AGENTS.md` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption（用户已确认接受）: 失败告警形式 = tracing 日志 + UI toast；仅按 session id 精确匹配删除，不做整目录清理（安全约束）。
- Assumption: Kimi 的相关产物 = 索引中该 session 的整个 `sessionDir`（其下 `agents/main/wire.jsonl` 等均为该 session 独有）；Qoder 的相关产物 = `<id>/` 整个目录（含 segments）。依据：两者均以 session id 命名、由 agent 按 session 独占创建。影响：若某 agent 在共享目录中混入其他 session 文件会误删——通过「目录名必须精确等于原生 id 且位于 agent 配置根下」约束控制风险。
- Assumption: Claude 的相关产物为 `<id>.jsonl`（当前版本 Claude Code 将 sidechain 写入同一 transcript）。实现时对每个 id 附带检查同名 `<id>/` 目录是否存在，存在则一并删除（仅限该精确名）。
- Open question: 无（需求契约已确认，无遗留决策）。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 任一永久删除入口执行成功后，该 session 全部原生 id 对应的原生文件/目录不再存在于磁盘。
- 同项目其他 session 的原生文件不受影响（删除目标均经 session id 精确匹配 + agent 配置根前缀校验）。
- 原生文件删除失败（含文件不存在）时 purge 仍返回成功；失败写入 tracing 日志，且前端出现告警 toast。
- 归档、unarchive 流程完全不触碰原生文件。
- agentport-core 与 src-tauri 相关测试通过；前端构建与相关测试通过。
- Debug App 重建并以独立实例打开，截图确认窗口正常渲染（按 AGENTS.md）。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002；T-001 → T-003（事件名契约 `native-cleanup-warning` 在本文件固定）；T-002 + T-003 → T-004。
- Parallel batches: 批次 1 = [T-001]；批次 2 = [T-002, T-003]（文件不重叠：T-002 只改 Rust，T-003 只改前端 src/ 与 locales）；批次 3 = [T-004]。
- Serialization constraints: T-002 与 T-001 同改 Rust crate 但文件不同；T-004 必须等全部实现任务完成后串行执行。本任务图规模小，全部由 coordinator 串行执行，不启动 subagent。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — agentport-core 原生文件清理模块

- Status: done
- Owner: coordinator
- Objective: 在 agentport-core 实现「解析 → 计划 → 执行」两段式原生清理：purge 前从 session 记录 + hook events 解析出全部删除目标（NativeCleanupPlan），purge 提交后幂等执行，返回成功/失败统计；全部删除目标必须通过 canonicalize + agent 配置根前缀校验。
- Inputs and prerequisites: F-003、F-004、F-005、F-006；history.rs 中现有解析函数（当前为私有，需提升为 `pub(crate)` 复用）。
- Scope or files: `crates/agentport-core/src/native_cleanup.rs`（新增）、`crates/agentport-core/src/history.rs`（可见性调整 + 必要抽取）、`crates/agentport-core/src/lib.rs`（导出模块）。
- Expected output: `pub fn plan_native_cleanup(paths: &AppPaths, session: &Session) -> NativeCleanupPlan` 与 `pub fn execute_native_cleanup(plan: &NativeCleanupPlan) -> NativeCleanupOutcome`（含 deleted 数与固定标签的失败列表，不持久化 OS 错误串/绝对路径）；claude/codex/kimi/qoder 四 adapter 覆盖，pi/shell 为显式 no-op；单元测试覆盖各 adapter 的解析、根前缀防护、id 精确匹配、幂等（文件不存在视为成功）。
- Dependencies: None.
- Execution steps:
  1. 将 history.rs 中 `collect_native_ids`、`cwd_slug`、`configured_home`、`codex_files` 扫描、kimi 索引读取等调整为 `pub(crate)` 复用。
  2. 新建 native_cleanup.rs：plan 阶段按 adapter 解析目标（claude: `<id>.jsonl` + 同名 `<id>/` 目录探测；codex: session_meta 匹配文件；kimi: 精确 sessionDir 目录；qoder: `<id>/` 目录），每个目标 canonicalize 并校验位于对应 agent 配置根内。
  3. execute 阶段幂等删除（NotFound 视为成功），失败记录固定标签。
  4. 编写单元测试（tempdir 伪造各 agent home，含「不匹配其他 session 文件」的防护用例）。
- Acceptance criteria:
  - 新模块公开 API 如上；测试覆盖四种 adapter 与防护用例；`cargo test -p agentport-core native` 通过。
- Verification method:
  - `cargo test -p agentport-core native_cleanup`（及全量 `cargo test -p agentport-core`）。
- Validation evidence: `cargo test -p agentport-core --lib native_cleanup` → 5 passed / 0 failed；`cargo test -p agentport-core --lib` → 296 passed / 0 failed / 6 ignored（其中 `adapters::capability::tests::readonly_probe_reads_version_first_line_and_help` 首轮全量时失败一次，单独重跑与第二轮全量均通过，与本次改动无关——capability.rs 未触及，属既有并发 flaky）；`cargo build -p agentport-core` 无警告。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 三个 purge 入口接入原生清理

- Status: done
- Owner: coordinator
- Objective: 在 src-tauri 三个永久删除命令中：purge 前为每个目标 session 生成 NativeCleanupPlan（此时 hook events 文件仍在磁盘，不受 F-007 后台线程竞争影响），DB purge 提交后执行计划；存在失败时 `app.emit("native-cleanup-warning", { count })`，tracing::warn 记录。
- Inputs and prerequisites: T-001 完成；F-001、F-002、F-006、F-007。
- Scope or files: `src-tauri/src/main.rs`（`delete_archived_session`、`delete_project_archived_sessions`、`delete_all_archived_sessions`，以及批量入口在 purge 前补取 session 记录）；如需要可调整 `crates/agentport-core/src/db/mod.rs` 增加批量取 session 的只读方法。
- Expected output: 三个入口行为一致；purge 返回值不变；单入口已有 `get_session`，批量入口用现有只读查询取全量 session 后逐一 plan。
- Dependencies: T-001。
- Execution steps:
  1. 批量入口在 stop 之后、purge 之前取回 confirmed session 的完整记录并生成 plans。
  2. purge 提交成功后按序执行 plans（best-effort），统计失败。
  3. 失败数 > 0 时 emit `native-cleanup-warning` 并 tracing::warn。
  4. 补充/调整 Rust 测试（main.rs 现有 cleanup 测试附近）：验证 plans 在 purge 前生成、purge 失败不执行删除。
- Acceptance criteria:
  - 三入口代码路径均接入；`cargo build -p agentport` 与相关测试通过；事件契约与 T-003 一致。
- Verification method:
  - `cargo test -p agentport`（或 src-tauri 对应测试目标）中相关用例；`cargo build`。
- Validation evidence: `cargo test -p agentport` → 44 passed / 0 failed，含新增 `cleanup_tests::purged_session_native_artifacts_are_removed_after_commit`（plan→purge→execute 全流程，验证原生文件被删、其他 session 文件保留、DB 行已删）；`cargo build -p agentport` 0 警告。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 前端告警 toast 与 i18n

- Status: done
- Owner: coordinator
- Objective: 前端监听 `native-cleanup-warning` 事件（payload `{ count: number }`），弹出 warning toast（中英双语 i18n），告知部分原生文件删除失败、详情见日志。
- Inputs and prerequisites: 事件契约固定（本文件 dependencies 节）；F-008、F-009。
- Scope or files: `src/src/api.ts`（listen 封装）、`src/src/desktopEvents.ts` 或 App 挂载处（接线）、`src/src/locales/en-US/*` 与 `src/src/locales/zh-CN/*`（文案）、新增/调整对应测试文件。
- Expected output: 收到事件即 toast；i18n 双语言；契约测试断言事件名与 payload 形状。
- Dependencies: T-001（契约固定即可，可与 T-002 并行）。
- Execution steps:
  1. api.ts 增加 `onNativeCleanupWarning` listen 封装。
  2. 全局事件接线处注册回调 → `toast(i18n.t(...), "warning")`（核对 Toast kind 枚举是否有 warning，否则用 info/error 中最贴近者）。
  3. 添加 en-US / zh-CN 文案。
  4. 添加前端测试（模拟事件 → toast 被调用）。
- Acceptance criteria:
  - 测试通过；`npm run build`（或仓库既有前端构建命令）通过。
- Verification method:
  - 前端测试命令（vitest 等）+ 前端生产构建。
- Validation evidence: `npx vitest run App.native-cleanup App.notification App.git-center-mount` → 7 passed；全量 `npm run test` → 49 files / 322 passed；`npm run i18n:check` 通过；`npm run build`（tsc --noEmit + vite build）通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 整体验证与 Debug App 重启

- Status: done
- Owner: coordinator
- Objective: 全量回归验证并按 AGENTS.md 重启 Debug App、截图确认渲染。
- Inputs and prerequisites: T-001、T-002、T-003 全部 done。
- Scope or files: 不新增源码改动；仅验证与调试窗口操作。
- Expected output: 全量 Rust/前端测试与构建通过；Debug App 以独立实例运行且窗口非白屏的截图证据。
- Dependencies: T-002, T-003。
- Execution steps:
  1. `cargo test -p agentport-core` 与 src-tauri 测试、前端测试与构建。
  2. `bash scripts/rebuild-debug-app.sh`。
  3. 精确定位并仅终止 debug GUI 旧进程（comm 精确等于 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`，不得误杀 agentport-host——参见 LEARNS.md），`open -n` 打开。
  4. `ps` 确认新 GUI 进程路径为调试包；激活该进程窗口后截图确认非白屏。
- Acceptance criteria:
  - 所有测试/构建通过；截图显示窗口正常渲染。
- Verification method:
  - 上述命令实际输出 + 截图文件。
- Validation evidence: `cargo test -p agentport-core` 全部 target 通过（lib 296 passed + 全部集成测试 ok）；`cargo test -p agentport` 44 passed；前端 322 passed 与生产构建通过（T-003 证据）；`bash scripts/rebuild-debug-app.sh` 成功（debug_bundle_id=com.agentport.desktop.debug.c9d007c8147e，重签名完成）；旧 debug GUI PID 1486 按 comm 精确匹配终止（未触碰 agentport-host）；`open -n` 后以 `ps` 确认新 GUI 进程（PID 82066）可执行路径为 target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport；ScreenCaptureKit 截图 /tmp/agentport-debug-purge-native.png 显示侧栏与终端完整渲染（非白屏）。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 单元：agentport-core `native_cleanup` 模块测试（tempdir 伪造 CLAUDE_CONFIG_DIR/CODEX_HOME/KIMI_CODE_HOME/QODER_HOME；覆盖解析、幂等、根前缀防护、不误删其他 session）。
- 集成：src-tauri purge 命令测试（plan 在 purge 前生成、purge 失败不删除原生文件）。
- 前端：事件契约/toast 测试 + 生产构建。
- 全量：`cargo test -p agentport-core`、src-tauri 测试、前端测试套件。
- 实机：rebuild-debug-app.sh + 独立实例打开 + `ps` 路径核对 + 截图。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- R-001（主要风险）误删其他 session 的原生文件：缓解 = 全部目标经 id 精确匹配 + canonicalize 根前缀校验 + 防护测试；codex/kimi 复用现有「id+cwd 双匹配」逻辑。
- R-002 后台清理线程（F-007）在 purge 提交后立即删除 session 目录导致 hook events 丢失：缓解 = plan 在 purge 之前生成（此时文件必在，因 cleanup job 尚未入队）。
- R-003 历史 session 缺原生 id 或原生文件已被用户手删：按契约跳过/幂等成功，仅日志。
- R-004 Kimi/Qoder 删除整目录的行为若 agent 布局变化可能误删：缓解 = 目录名精确等于原生 id 且位于配置根内的校验。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-26: 需求契约经 clarify-requirements 流程确认（触发点=仅永久删除；范围=全部相关产物；失败=尽力删除仅告警；入口=全部三个；文案=不变）。
- 2026-08-26: 完成只读侦察（F-001~F-010），创建并填充任务文档。
- 2026-08-26: T-001 置为 in_progress（Owner: coordinator），开始实现 native_cleanup 模块。
- 2026-08-26: T-001 完成：history.rs 复用函数提升为 pub(crate) 并抽取 read_kimi_session_index；新增 crates/agentport-core/src/native_cleanup.rs（plan/execute 两段式、根前缀防护、幂等删除）；5 个新单测通过，core lib 全量 296 通过。
- 2026-08-26: T-002 完成：main.rs 新增 plan_native_cleanups/run_native_cleanups helper 并接入全部三个 purge 入口（plan 在 purge 前、execute 在提交后、失败 emit native-cleanup-warning）；cwd_slug 提升为 pub；新增集成测试通过，agentport 44 测试全绿。
- 2026-08-26: T-003 置为 in_progress（Owner: coordinator）。
- 2026-08-26: T-003 完成：api.ts 新增 onNativeCleanupWarning；App.tsx 注册监听器弹 toast（toast kind 无 warning 枚举，用 info）；zh-CN/en-US session.json 增加 cleanup.nativeWarning 文案；新增 App.native-cleanup.test.tsx，两个既有 App 测试 mock 补齐；前端 322 测试与生产构建通过。
- 2026-08-26: T-004 置为 in_progress（Owner: coordinator），开始整体验证与 Debug App 重启。
- 2026-08-26: T-004 完成：全量 Rust/前端测试与构建通过；Debug App 重建重签名、独立实例打开、进程路径核对与截图验证渲染全部通过。
- 2026-08-26: 已知限制（与本次改动无关）：`agentport-host` 的 `invalid_resume_requires_resync_then_bounded_tail` 测试失败，但 agentport-host/{main.rs,server.rs,tests/host_tests.rs} 的修改与 history.rs 未跟踪状态均属本任务开始前工作区既有的未提交改动，本次改动未触及 host 与协议层；另 `adapters::capability` 一个既有 flaky 测试在首轮 core 全量中间歇失败、重跑通过。两者均已在任务文档中如实记录。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001~T-004 全部 done；任务文档 validator 通过；`cargo test -p agentport-core`（296 lib + 全部集成 target）、`cargo test -p agentport`（44）、前端 `npm run test`（322）、`npm run build`、`npm run i18n:check` 全部通过；Debug App 重启后截图确认渲染正常（/tmp/agentport-debug-purge-native.png）。
- Limitations: agentport-host 的 `invalid_resume_requires_resync_then_bounded_tail` 失败属本任务开始前工作区既有未提交改动（host 源码与测试均被他人/先前工作修改），与本次改动无关，未修复；真实 GUI 手动端到端删除未逐一人工操作，行为由 Rust 集成测试（plan→purge→execute 全流程）与前端事件测试覆盖。
