# Task Plan: AgentPort 原生日志按需读取与资源治理

- Created: 2026-08-24
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户确认的 proposed plan（2026-08-24）

<!-- task-doc-section:background-goal -->
## Background and goal

AgentPort 当前把 PTY 原始字节追加到每次运行的 `output.log`，同时 agent 自身已经保存结构化原生日志；现场快照中 AgentPort 会话目录约 8.9 GiB。目标是让 agent 原生日志成为唯一持久化会话正文，AgentPort 仅保存来源元数据，实时终端仅使用有界内存，并保留安全、需确认的旧日志清理能力。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：Host 输出管线、原生日志解析/分页/搜索/导出、Tauri/前端历史视图、设置与旧日志迁移、备份诊断去正文、文档与验证。
- 支持：Claude、Codex、Pi、Kimi、Qoder；Shell 明确无持久化历史。
- 非目标：修改任何 agent 的原生日志；自动删除旧 `output.log`；中断当前运行的旧 Host；将结构化事件伪装为 ANSI 终端重放。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | `output.log` 同时被 Host 写入并用于重放、搜索、导出和恢复游标。 | `crates/agentport-host/src/main.rs`, `crates/agentport-core/src/{logs,search,export,timeline}.rs`, `src-tauri/src/main.rs` |
| F-002 | 当前数据目录中约有 8.9 GiB 会话日志，设置允许单会话最多 2048 MiB。 | 2026-08-24 只读盘点与 settings DB 查询 |
| F-003 | Claude、Codex、Pi、Kimi、Qoder 均存在结构化原生日志；Shell 没有原生日志。 | 本机各 agent 原生数据目录及适配器启动参数检查 |
| F-004 | 原生日志不是 PTY ANSI 字节，不能精确重建终端状态。 | 原生 JSONL 事件样本与 Host `LogWriter` 原始字节写入路径对比 |
| F-005 | 工作树已有大量用户修改，涉及本任务重叠文件。 | `git status --short` 2026-08-24 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 原生 ID、规范化路径、文件指纹、读取游标和生命周期属于允许持久化的元数据；消息正文、PTY 字节和全文索引不允许持久化。
- Assumption: 每个新 Host 使用 4 MiB 内存尾部；历史分页 200 条；搜索按来源顺序流式处理，避免并发放大内存与磁盘读取。
- Assumption: 旧 Host 自然结束前可继续写旧日志，这是不中断当前 agent 的兼容边界。
- Open question: None；历史呈现、Shell、搜索、导出和清理策略均已由用户确认。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 新启动的所有 agent 与 Shell 会话均不创建或追加 `output.log`。
- 五种 agent 历史可按需分页、搜索并导出 Markdown/JSON，正文不进入 AgentPort DB/索引/诊断/备份。
- 运行终端保持真实；存活 Host 重连只恢复最多 4 MiB 内存尾部；结束后展示结构化历史。
- 原生日志缺失、损坏、无权限或候选歧义时安全降级并给出明确状态。
- 旧日志清单精确报告空间与覆盖状态，只有用户确认并选择后才能删除。
- Core、Host、Tauri、前端测试和 Debug App 烟测通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006。
- Parallel batches: 无；核心模型、IPC、Tauri 和前端契约连续演进，采用串行集成避免污染现有重叠修改。
- Serialization constraints: `models.rs`、`src-tauri/src/main.rs`、前端 store/types/terminal 文件均已有用户修改，所有编辑由 coordinator 串行完成并逐次检查差异。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固化失败基线与契约

- Status: done
- Owner: coordinator
- Objective: 用确定性测试证明当前 Host 会创建磁盘日志，并锁定新接口与兼容边界。
- Inputs and prerequisites: 用户确认方案；当前源码与数据盘点。
- Scope or files: 任务文档、Host/Core 现有测试。
- Expected output: 可复现的 FAIL oracle、完整任务契约。
- Dependencies: None.
- Execution steps:
  1. 记录现有磁盘写入路径和原生来源。
  2. 增加最低稳定层的 no-output-log 回归测试。
- Acceptance criteria:
  - 测试在旧实现上因创建/追加 `output.log` 而失败。
- Verification method:
  - 定向运行新增 Host/Core 测试并保存失败原因。
- Validation evidence: `cargo test -p agentport-host new_host_keeps_terminal_output_in_memory_without_creating_output_log -- --nocapture` 在旧实现上按预期 FAIL：Host 创建了临时目录中的 `output.log`；实时输出断言已通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现原生历史提供层

- Status: done
- Owner: coordinator
- Objective: 为五种 agent 提供安全、流式、分页的统一历史事件读取，Shell 明确不可用。
- Inputs and prerequisites: T-001。
- Scope or files: `crates/agentport-core/src/history.rs`, adapters, models, tests。
- Expected output: `HistoryEvent/Page/SourceStatus/Cursor` 与 provider resolver/parser。
- Dependencies: T-001。
- Execution steps:
  1. 解析并验证各 provider 的规范路径和 native ID。
  2. 流式规范化 JSONL，支持多文件、损坏行和不透明游标。
  3. 增加分页、搜索与错误状态测试。
- Acceptance criteria:
  - 五种 agent fixture 均返回稳定事件；Shell、缺失与歧义安全降级。
- Verification method:
  - `cargo test -p agentport-core history`。
- Validation evidence: `cargo test -p agentport-core --lib -- --test-threads=1` 中 history 6/6 通过，覆盖 Claude ID rollover、Codex/Kimi/Qoder 精确来源、Pi 分页/坏行/导出、Shell unavailable、按需搜索和超长 JSONL 有界读取。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 移除新 Host 磁盘正文并使用有界内存

- Status: done
- Owner: coordinator
- Objective: 新 Host 不写 `output.log`，以 4 MiB 环形缓冲支持存活 Host 重连。
- Inputs and prerequisites: T-002；现有 IPC 与重放语义。
- Scope or files: Host main/server、protocol、host manager、相关测试。
- Expected output: 新 live-output 游标/重放路径及旧帧兼容。
- Dependencies: T-002。
- Execution steps:
  1. 把 `LogWriter` 替换为有界内存缓冲与单调序列。
  2. 新连接从内存尾部重放，旧 Host 帧继续可解析。
  3. 去除新会话 `logPath`/log limit 依赖。
- Acceptance criteria:
  - 新 Host 运行和重连均无日志文件，缓冲不超过 4 MiB。
- Verification method:
  - `cargo test -p agentport-host` 及协议定向测试。
- Validation evidence: `cargo test -p agentport-host --test host_tests -- --test-threads=1`：29/29 通过；覆盖新 Host 不创建日志、4 MiB 尾部上限、重连、慢客户端隔离、Secret 实时脱敏和进程组清理。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 接入历史、搜索、导出与安全清理

- Status: done
- Owner: coordinator
- Objective: 以原生日志替换 Tauri/CLI 的正文读取，并提供确认式旧日志清理。
- Inputs and prerequisites: T-003。
- Scope or files: Core search/export/backup/diag/db，Tauri/CLI commands。
- Expected output: 历史分页、按需搜索、Markdown/JSON 导出、legacy inventory/delete API。
- Dependencies: T-003。
- Execution steps:
  1. 接入原生读取命令并停用正文 FTS/旧 raw-tail 默认路径。
  2. 排除备份和诊断正文。
  3. 实现 canonical-path 白名单清单与显式删除。
- Acceptance criteria:
  - 无正文副本；导出仅写用户目标；清理不能越过精确旧日志集合。
- Verification method:
  - Core/Tauri/CLI 定向测试和临时目录集成测试。
- Validation evidence: Core 286/286 通过（另 6 个交互凭据环境测试忽略）；Tauri 43/43、CLI 4/4 通过。备份/诊断明确排除正文，旧 FTS 正文清空与 legacy 精确确认删除均有测试。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 实现历史 UI 与产品契约迁移

- Status: done
- Owner: coordinator
- Objective: 分离实时终端与历史对话，更新搜索、导出、设置、清理和文档。
- Inputs and prerequisites: T-004 API。
- Scope or files: 前端 types/api/store/components/locales/styles，PRD/用户文档。
- Expected output: 统一历史视图、来源状态、JSON/Markdown 导出、旧日志清理 UI。
- Dependencies: T-004。
- Execution steps:
  1. 接入分页历史与 provider 状态。
  2. 替换 raw log 搜索/导出和 log-limit 设置。
  3. 增加 UI/契约测试并更新文档。
- Acceptance criteria:
  - 运行中显示真实终端；结束后显示结构化历史；不可用/清理风险明确。
- Verification method:
  - 前端定向测试、typecheck、i18n 检查。
- Validation evidence: `npm test -- --run`：47 个测试文件、303/303 通过；`npm run build` 与 `npm run i18n:check` 通过。结束 Session 原生历史和不保留 xterm 的行为有定向测试。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 全量验证与 Debug App 烟测

- Status: done
- Owner: coordinator
- Objective: 完成跨层回归、资源边界验证并打开正确 Debug App。
- Inputs and prerequisites: T-005。
- Scope or files: 全部任务差异、构建产物和 Debug App。
- Expected output: 全部验收证据与非白屏 Debug 窗口。
- Dependencies: T-005。
- Execution steps:
  1. 运行格式、测试、构建和差异检查。
  2. 重建签名 Debug App，只重启目标 GUI。
  3. 用进程路径和截图验证窗口。
- Acceptance criteria:
  - 验收项全部通过，或明确记录唯一剩余阻塞。
- Verification method:
  - Cargo/npm 检查、`scripts/rebuild-debug-app.sh`、`ps`、截图。
- Validation evidence: `scripts/rebuild-debug-app.sh` 成功并完成 ad-hoc 签名；仅重启精确 Debug GUI，最终 PID 9978 的可执行路径为 `/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`。Computer Use 截图确认非白屏，结束会话显示原生历史、Markdown/JSON 导出和来源信息；“历史、存储与渲染”成功列出 193 个遗留日志（9,436,031,266 字节），未执行删除。最终 GUI RSS 快照约 147 MiB。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 单元：五 provider 解析、分页、损坏/截断/缺失、多来源排序、Shell unavailable。
- Host：no-output-log、4 MiB 上限、连接重放、旧协议兼容。
- 集成：历史/搜索/导出/清理命令与无正文持久化。
- 前端：运行/结束态切换、来源错误、导出格式、清理确认、移除日志上限。
- 系统：Core/Host/Tauri/CLI/前端测试、构建、Debug App 窗口验证。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 原生格式随 agent 版本变化：宽容解析未知事件并保留 provider/kind，fixture 覆盖当前版本。
- 原生 ID 可能变化：允许同会话多个来源，不用单一 stale ID 覆盖历史。
- Codex 旧会话缺 ID：只接受可证明唯一的候选，否则 unavailable。
- 旧 Host 无法热替换：不中断它们，并明确标记仍可能增长的旧日志。
- 清理不可逆：必须先 inventory、显式选择、canonical-path 验证和二次确认。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-24: 建立 execute 模式任务文档；确认大规模脏工作树并采用串行集成。
- 2026-08-24: T-001 开始；已记录 Host `LogWriter`、raw replay/search/export 与原生日志的职责冲突。
- 2026-08-24: T-001 完成；新增 no-output-log 回归在旧实现上确定性失败，失败原因仅为磁盘日志被创建。T-002 开始。
- 2026-08-24: T-002 完成；五 provider 原生历史流式分页/搜索测试 5/5 通过。T-003 开始；Host 已移除 LogWriter，no-output-log 与 reconnect replay 回归通过，正在完成邻接测试迁移。
- 2026-08-24: T-003/T-004 完成；Host 29/29、Core 286/286、Tauri 43/43、CLI 4/4 通过，正文备份/诊断/索引路径已停用并加入确认式 legacy 清理。
- 2026-08-24: T-005/T-006 完成；前端 303/303、构建、i18n、Debug App 签名与非白屏烟测通过。193 个旧日志共 9,436,031,266 字节仅盘点，未删除。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: Host/Core/Tauri/CLI/前端测试、生产前端构建、i18n、任务文档校验、Debug App 重建/进程路径/截图均通过；新 Host 不落盘和 4 MiB 内存上限有确定性回归。
- Limitations: 工作区在任务开始前已有大量未提交且未格式化修改；`cargo fmt --all -- --check` 会同时报告这些重叠文件，未对用户的无关改动执行全仓自动格式化。现存 9,436,031,266 字节旧日志需用户在设置中显式选择并二次确认后才会删除。
