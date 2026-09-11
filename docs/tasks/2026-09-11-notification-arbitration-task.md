# Task Plan: 通知证据仲裁与可靠提醒整改

- Created: 2026-09-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户要求按 Herdr 对比评估建议执行整改。

<!-- task-doc-section:background-goal -->
## Background and goal

在已有通知链路上减少弱证据覆盖、重复及过时提醒，保留准确完成/失败语义、运行隔离和持久历史。采用 Herdr 多源仲裁思想，不复制 Idle 即完成的规则。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：Host 状态仲裁、桌面通知发送前复核与焦点策略、基于实时屏幕的有界启发式、集成资源安全升级与状态说明、回归验证。
非目标：新增十四套集成、LLM 文本分析、远程规则下载、全局 exactly-once、改动手机推送基础设施、安装 Agent 主程序、修改用户配置冲突内容或重启现有 Session。手机继续消费兼容的 Host 语义事件。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Host 已统一接收观察，但状态机只保存最近状态，PTY 有防抖无独立来源权威 | crates/agentport-core/src/state.rs; crates/agentport-host/src/main.rs |
| F-002 | 通知已有准确完成白名单、跨来源去重、持久 run 游标 | models.rs; notify.rs; db/mod.rs |
| F-003 | 桌面去重后立即入队，不做延迟快照复核 | src-tauri/src/main.rs:notify_status_once |
| F-004 | Host 已有进程内终端屏幕用于恢复 | crates/agentport-host/src/terminal_screen.rs |
| F-005 | 集成资源变化会拒绝升级，现有 manifest 保存完整 before/after | notification_setup/mod.rs |
| F-006 | Herdr 区分 fallback 与 hook authority，客户端延迟复核 | /Users/w/Projects/easy-pi/herdr/src/terminal/state.rs; src/client/shell/notification_policy.rs |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 默认短延迟用于合并瞬态提醒，不修改已持久化历史和未读语义；通过确定性时钟测试验证。
- Assumption: 保持协议兼容，优先复用已有状态与证据字段；不凭静默判断完整 Hook 失效。
- Open question: 新 Agent 专属规则只有取得真实屏幕证据后才能启用，缺证据不宣称全覆盖。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 准确 Working / NeedsInput / 完成不被普通 PTY 输出或静默直接覆盖；退出后观察不复活 run。
- 弱屏幕证据不生成完成/失败，失败与完成在同为 Idle 时仍可区分。
- 延迟期间已解决请求、新一轮工作和旧 run 的过时提醒不发送；历史不被删除。
- 当前聚焦会话不弹系统通知；未聚焦会话正常提醒。
- 升级必须验证所有权、备份与冲突，失败恢复到升级前状态，不更改非本任务文件。
- 通过针对性测试、前端检查与调试构建；安全打开调试 GUI，记录视觉验证限制。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004 -> T-005.
- Parallel batches: 无；串行执行，避免共享状态/协议及回归基线交叉变化。
- Serialization constraints: 仲裁语义影响通知、屏幕和安装能力；协调者逐项验证。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Host 证据仲裁

- Status: done
- Owner: coordinator
- Objective: 在现有状态机内建立明确来源约束与退出终态，保留语义事件。
- Inputs and prerequisites: F-001, F-002, F-006.
- Scope or files: crates/agentport-core/src/state.rs; 必要 Host 接线与测试。
- Expected output: 可测试的来源仲裁及回归。
- Dependencies: None.
- Execution steps:
  1. 检查观测路径，添加冲突/迟到/重复/静默回归，实现最小仲裁。
- Acceptance criteria:
  - 满足前两项总体验收；现有原生事件不回归。
- Verification method:
  - cargo test -p agentport-core state::tests; Host 针对性测试。
- Validation evidence: 状态针对性 18 项通过；最终核心库 429 项、Host 35 单测/41 集成通过。包含真实 PTY 持续重绘不能清除准确审批请求的 Host 集成回归。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 通知发送策略

- Status: done
- Owner: coordinator
- Objective: 延迟复核、焦点抑制、保持事件历史独立。
- Inputs and prerequisites: T-001 的语义约束。
- Scope or files: notify.rs; src-tauri/src/main.rs; 前端焦点报告与测试。
- Expected output: 有界待发送策略、最新 run/state 复核。
- Dependencies: T-001.
- Execution steps:
  1. 复用事件身份与现有队列，加入确定性策略和必要焦点输入。
- Acceptance criteria:
  - 已解决/过时提醒被抑制；失败历史不丢失；聚焦正确。
- Verification method:
  - Rust 通知单测、桌面前端对应回归与类型检查。
- Validation evidence: notification_policy 4 项确定性测试（含焦点、快照水位、跨来源强化、旧 run、队列上限）、桌面 Rust 48 项、前端通知/设置 29 项通过；完整桌面前端 666 项通过，TypeScript/Vite 和 i18n 检查通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 实时屏幕启发式

- Status: done
- Owner: coordinator
- Objective: 避免滚动原始尾部被清屏/回写/历史残留误导。
- Inputs and prerequisites: T-002；现有 terminal_screen 实现。
- Scope or files: Host terminal_screen 与检测接线，规则和测试。
- Expected output: 有界当前屏幕取样、可解释证据；不新增无真实依据的品牌规则。
- Dependencies: T-002.
- Execution steps:
  1. 评估复用成本，限定扫描区域与频率，覆盖清屏/回写/无匹配行为。
- Acceptance criteria:
  - 不读取用户滚动 viewport，不因无匹配报完成，保留脱敏边界。
- Verification method:
  - 终端屏幕与 Host 检测回归；性能频率/内存边界检查。
- Validation evidence: Host 单测 35 项、集成 40 项通过；包括清屏、光标回写、未完成转义前缀；核心 screen_detection 回归通过。300ms 取样且输出未变时跳过，末 64 行取最后 8 行/8192 字符；仅两个保守 v1 通用控件规则，无新增品牌专属规则。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 安全集成升级

- Status: done
- Owner: coordinator
- Objective: 解除未被修改的受管旧资源必须手动回滚的维护障碍。
- Inputs and prerequisites: T-003 后稳定的证据/能力契约。
- Scope or files: notification_setup; NotificationSetupPanel; 本地化与测试。
- Expected output: 事务性升级与冲突保护，准确 UI 说明。
- Dependencies: T-003.
- Execution steps:
  1. 保留原始备份，升级前验证所有文件，失败回退，补幂等与冲突测试。
- Acceptance criteria:
  - 用户修改不覆盖；缺依赖不破坏旧版；升级/回滚保持正确所有权。
- Verification method:
  - 安装器临时 HOME 单测及面板回归。
- Validation evidence: 安装器 20 项通过，包括升级/重复升级、退役文件、原始 JSON 字节恢复、缺运行时、用户冲突、升级自检失败、中断恢复、只读更新提示；通知面板 11 项通过。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 集成验证与交付

- Status: blocked
- Owner: coordinator
- Objective: 验证整条链路，安全打开调试 App，提交任务相关改动。
- Inputs and prerequisites: T-001 至 T-004 验证通过。
- Scope or files: 回归测试、docs/agent-notifications.md、本任务文档。
- Expected output: 证据、限制和 scoped commit。
- Dependencies: T-004.
- Execution steps:
  1. 对抗性审查，运行核心/Host/桌面相关检查，统一脚本构建签名重启 GUI 并截图。
- Acceptance criteria:
  - 所有已授权范围有实现证据或明确 blocker，不混入用户工作。
- Verification method:
  - Rust 与前端回归、i18n、构建、脚本、ps、截图、git diff --check。
- Validation evidence: 最终 `cargo test -p agentport-core -p agentport-host -p agentport-service -p agentport -- --test-threads=4`：22 个目标共 658 passed、8 ignored；桌面 Vitest 666 passed；mobile terminalSnapshot 10 passed；桌面/mobile TS+Vite 构建通过；i18n 检查通过。统一脚本构建签名并重启成功，最终 ps 核验 GUI PID 89434 的可执行路径完全匹配当前 checkout 调试 App。`git diff --check` 通过。截图工具失败，未完成视觉验收。
- Blocker: `screencapture` 返回 could not create image from window；ScreenCaptureKit 初始化后返回 SCStreamErrorDomain -3811（audio/video capture failure）。CGPreflightScreenCaptureAccess 为 true，不能归因为未授权，也不能声称窗口非白屏。
- Unblock condition: 可用的系统截图环境或用户提供当前调试窗口截图后，核验非白屏及通知集成页展示；重新更新最终验收状态。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

优先确定性回归：来源冲突、退出迟到、同源连续事件、新 turn 分界、待发送失效、焦点、升级冲突与失败恢复。自动化安装测试使用隔离目录，不额外对真实 HOME 执行测试探测。调试 App 正常启动仍沿用已授权的现有自动探测策略，可能升级未修改的受管集成。最后运行依赖路径测试和嵌入资源调试构建。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

共享 checkout 有其他未提交工作；不得混入。协议已有旧 Host/手机消费者，避免不兼容 enum/必要字段变更。屏幕检测不可保证所有版本；真实模型请求不属于本次自动验证。系统通知显示受 OS 权限控制，发送成功不等于用户看见。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-11: 用户授权执行；复核当前代码和并发变更；开始 T-001。
- 2026-09-11: T-001 初验通过后接入 T-002；通知策略与前端构建通过后接入 T-003；屏幕/Host 验证通过后实现 T-004。串行任务已完成初验，进入 T-005 集成审查。
- 2026-09-11: 完整 Rust 依赖路径回归通过；对抗审查补充 Hook SessionEnd 不吞掉进程失败、AfterTool/SubagentStop 不代表根 turn 完成，以及跨来源强化不能让去重后的提醒一起失效。最终复跑中。
- 2026-09-11: 屏幕范围主动限缩为有测试的通用控件：未收集真实 Agent 新版 UI 样本，不新增专属规则/远程规则/完整 TOML DSL。手机保持既有持久事件消费，不改 APNs 或跨设备互斥策略。
- 2026-09-11: 新增 DB 水位测试最初比较整个 SessionRun，因持久时间戳仅存毫秒而失败；改为比较任务需要的 run_id/run_ordinal，未改变生产时间精度。最终全量依赖回归 658/658 通过。
- 2026-09-11: 手动取样成本测试通过：1 Session ×100 tick 27.284ms；15 Session ×100 tick 280.993ms（约每批 0.273ms /2.810ms，不含现有解析成本；仅本机合成样本，无硬 CI 时限）。该 ignored 测试已显式执行。
- 2026-09-11: 调试构建重启两次以确保最终代码嵌入；只使用统一脚本精确关闭 GUI，没有主动停止任何 Host/Connector。最终 GUI PID 89434。系统截图及 ScreenCaptureKit 捕获均失败，T-005 保留 blocked，交付代码与自动验证，不虚报视觉成功。
- 2026-09-11: 本轮保留旧报告协议与去重兼容窗口，没有为全部 provider 新增 turnId/requestId 或心跳租约；同一 run 内跨异步来源的迟到语义报告仍有辨认边界。后续需逐 SDK 验证并扩展，不能宣称已获得完整生命周期权威覆盖。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001 至 T-004 实现与自动化验证通过；T-005 的测试、构建、精确 GUI 重启通过，但截图门禁被系统捕获错误阻塞。状态文档通过 validator。
- Limitations: 未验证十四种 Agent 的真实已登录模型事件、Linux、手机推送呈现或全局去重。屏幕仅保守通用规则，不具备主动上报的身份精度；本轮不添加所有 SDK 的 turn/request 身份。不声称系统通知实际显示或调试窗口已通过视觉验收。
