# Task Plan: 低开销跨端通知与手机消息收件箱

- Created: 2026-09-08
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户要求制定计划并实施 Completed / Approval 跨端通知、手机 Recent 保留与左滑移除；高性能低开销；禁止 subagent。

<!-- task-doc-section:background-goal -->
## Background and goal

每个可信的 turn 完成或批准请求均进入可靠的通知处理链路。手机待处理消息不受桌面已读或 Session 当前状态覆盖影响，直到本机成功查看或明确移除。避免高频轮询、历史日志扫描及终端正文传输。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

包含消息元数据模型、设备级查看/移除游标、持久投递状态、多 Host 前台接收、Recent 左滑交互、本地通知点击定位和性能验证。复用桌面现有语义事件与通知 worker。消息移除不得停止、归档或删除 Session。

用户最新决定：只保留前台通知，不实施后台通知方案。排除 APNs provider、远程推送 token 注册、后台保活及 Apple 推送能力配置。手机回到前台且恢复连接后增量补收，不承诺锁屏、挂起或终止时实时通知。

不改变输入、终端渲染或 Session 生命周期，不混入现有未提交改动。所有工作由当前 agent 串行执行，不使用 subagent。不读取 APNs 私钥、不部署推送服务、不变更 Apple 推送配置；本方案不需要 Key ID 或 APNs 凭据。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 桌面已有语义通知、去重、原生通知 worker 和点击定位 | src-tauri/src/main.rs::notify_status_once; src-tauri/src/notifications.rs |
| F-002 | 整改前：手机仅选中 Host 由 WebView 每五秒 attention.poll 后发本地通知 | mobile/src/features/sessions/SessionDashboard.tsx:394-436 |
| F-003 | 整改前：Recent 依赖最新状态及跨端共享 unreadAttention；不是独立消息箱 | sessionRecent.ts; agentport-service::SessionSummary::from_projection |
| F-004 | 整改前：消息左滑移除未实现；现有 remove 是删除 Session | SessionDashboard::SessionRow; SessionRowActions.tsx |
| F-005 | 当前协议提供 attention.poll，未提供全局 attention 事件订阅 | crates/agentport-remote-protocol/src/lib.rs; agentport-remote-bridge/src/lib.rs |
| F-006 | 本次前置审查的相关测试通过 | /tmp/agentport-notification-review-mobile.log:36; desktop.log:6; core.log:14 |
| F-007 | Relay 为自部署密文转发服务，没有现成 APNs provider | crates/agentport-relay/README.md; src 中 APNs 检索 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: Recent 按 Session 合并显示最新待处理提示，保留消息游标；新事件仍可重新进入，不按句子或时间猜测去重。
- Assumption: 手机本机查看/移除不消费其他设备的未读消息；App 已展示的当前 Session 视为已查看，以实际可见和成功打开为边界。
- Confirmed decision: 用户撤回此前的 Mac→APNs 方案，明确只保留前台通知。以本条最新决定为准，不再询问或配置 APNs 凭据。
- Remaining work: 前台本地通知的真实系统呈现、原生完成回执与点击定位仍需验证/完善；这些与 APNs 无关，不能因取消后台推送而视为自动完成。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Completed / Approval 被准确识别，事件重放不产生重复提示，投递失败不静默跳过。
- 手机消息在后续 Working/Exited、桌面已读、App 重启和离线情况下仍保留；本机查看/手动移除只确认已见游标，不消费更新消息。
- 左滑只移除消息，支持回弹、取消、纵向滚动、辅助操作和 reduced-motion，不操作 Session 删除接口。
- 前台覆盖所有已连接 Host，不依赖当前浏览设备；后台停止 JS 轮询，回到前台恢复连接后补收。后台实时通知不属于验收要求。
- 队列有明确背压/容量行为，不能为了有界内存静默丢弃未读；持久化与 UI 更新按批次进行。
- 记录空闲请求量、并发上限、延迟/失败退避、队列增长和列表更新边界的测试结果；实机未测项明确列出。
- 相关回归、构建和实机界面检查通过后仅提交任务改动。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003; T-003 -> T-004,T-005; T-004,T-005 -> T-006 -> T-007; T-003 -> T-008. 仍按串行执行。
- Parallel batches: None. 用户明确禁止 subagent，所有任务串行。
- Serialization constraints: 协议、生成文件、共享存储、Dashboard 和打包均串行修改/验证。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 确认后台投递架构及权限边界

- Status: done
- Owner: coordinator
- Objective: 核对现有事件协议和 Relay 基础，确认 APNs provider 部署位置及授权。
- Inputs and prerequisites: 当前审查结果、用户目标
- Scope or files: 本计划、通知与 Relay 边界
- Expected output: 确认架构、最小权限和明确部署边界
- Dependencies: None.
- Execution steps:
  1. 检索现有实现；提出唯一影响方案的后台架构决策。
- Acceptance criteria:
  - 架构不依赖手机后台保活，密钥保管和部署范围明确。
- Verification method:
  - 仓库证据与用户确认。
- Validation evidence: 用户确认由常在线 Mac 直接投递 APNs；不新增服务器，尚未授权读取私钥或改变 Apple 配置。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 独立持久消息与设备游标

- Status: done
- Owner: coordinator
- Objective: 修复 Recent 提前消失及跨端已读干扰，建立与通知投递分离的消息状态。
- Inputs and prerequisites: T-001 方案
- Scope or files: mobile 消息模型；必要的 service/protocol 元数据
- Expected output: 持久 inbox、单调游标、离线读取与背压规则
- Dependencies: T-001
- Execution steps:
  1. 先构造状态覆盖、共享已读、重启、陈旧回复回归，再实现最小模型。
- Acceptance criteria:
  - 未查看不消失；移除旧消息不吞掉新事件；无终端正文。
- Verification method:
  - 纯状态测试、持久化失败和重放测试。
- Validation evidence: attentionInbox 的 12 项测试通过，覆盖独立保留、重启、旧本机回执迁移、陈旧确认、重放、持久化失败、容量背压、原生通知 ID 重试复用。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 低开销多设备接收与可靠投递

- Status: done
- Owner: coordinator
- Objective: 将接收从选中设备/UI 生命周期解耦，修复失败跳过，复用事件连接。
- Inputs and prerequisites: T-002 游标与投递状态
- Scope or files: mobile notification coordinator；必要的 bridge/service 订阅
- Expected output: 有界增量接收、失败退避、可等待的通知发送
- Dependencies: T-002
- Execution steps:
  1. 优先复用状态事件连接；必要时增量补拉；增加并发、取消、断线和失败测试。
- Acceptance criteria:
  - 所有连接 Host 可接收；无固定高频后台轮询；失败可恢复。
- Verification method:
  - 计时器与请求计数测试、突发消息测试、队列容量测试。
- Validation evidence: useAttentionInbox 三项测试及 native sink 拒绝回归通过；全部已连接 Host 前台补拉、后台停止、慢请求不重叠、空闲 60s 每 Host 共 4 次请求（含初始），无 Session 列表轮询，通知拒绝仍进入 Recent。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Recent 左滑移除与打开清除

- Status: done
- Owner: coordinator
- Objective: 实现轻量消息交互而非 Session 删除。
- Inputs and prerequisites: T-003 稳定 inbox 接口
- Scope or files: mobile Recent 组件、样式、i18n、Dashboard 集成
- Expected output: 跟手滑动、移除收起动画、可访问替代操作
- Dependencies: T-003
- Execution steps:
  1. 增加手势判定、只用 transform 跟手；确认后移除；可见且成功打开后确认游标。
- Acceptance criteria:
  - 纵向滚动不误删；无 Session 删除调用；reduced-motion 可用。
- Verification method:
  - 组件事件回归、列表渲染计数、实机手势检查。
- Validation evidence: Recent 六项组件测试通过：离线移除、打开不提前确认、横/纵手势、取消动画及 91 次拖动事件零 React commit；真机 Recent 页面正常渲染，真实左滑与系统动效验收留 T-006。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 前台本地通知原生回执与点击定位

- Status: pending
- Owner: coordinator
- Objective: 完善本地通知的 OS 完成回执及 host/session 点击定位；原任务中的 APNs 部分已由用户取消，未实现且不再实施。
- Inputs and prerequisites: 用户最新前台限定、T-003 投递状态
- Scope or files: mobile 本地通知原生桥及点击路由；不含 APNs/provider
- Expected output: 本地通知真实完成/失败反馈、点击定位；无需推送密钥
- Dependencies: T-003
- Execution steps:
  1. 针对 iOS 插件提前 resolve 的行为建立回归，补齐本地完成回执与点击定位；不添加远程推送注册或后台保活。
- Acceptance criteria:
  - 原生错误可观察；本地通知点击可定位正确 Session；不把 invoke 返回当成 OS 已接收或横幅已呈现。
- Verification method:
  - 本地原生桥回归、前台系统通知与点击实机验证。
- Validation evidence: 已核对 tauri-plugin-notification 2.3.3 的 NotificationPlugin.swift：本地 show 在 OS completion 前 resolve。当前仅等待原生命令返回；真实 OS 呈现和点击定位尚未验收。
- Blocker: None.
- Unblock condition: None.

### [ ] T-006 — 端到端与性能验收

- Status: pending
- Owner: coordinator
- Objective: 验证前台通知、恢复补收、后台停止轮询和手势路径以及空闲/突发开销；不验证后台实时推送。
- Inputs and prerequisites: T-002 至 T-005
- Scope or files: 相关测试、调试 App
- Expected output: 可复现的功能与性能证据
- Dependencies: T-004, T-005
- Execution steps:
  1. 运行定向及全量回归；采样请求/内存边界；构建安装；真机检查并清理临时诊断。
- Acceptance criteria:
  - 不以测试通过冒充系统通知到达；所有未测项明确。
- Verification method:
  - 桌面/手机/核心测试、构建、进程路径和遮蔽截图。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-007 — 提交与交付

- Status: pending
- Owner: coordinator
- Objective: 审查最小 diff 并只提交本任务改动。
- Inputs and prerequisites: T-006 验证结果
- Scope or files: 本任务文件及本计划
- Expected output: Git commit 与完成/受阻状态
- Dependencies: T-006
- Execution steps:
  1. 自审竞态、容量、权限和误删除边界；更新本计划；选择性提交。
- Acceptance criteria:
  - 无无关脏文件混入；无未清理探针；不停止 Host。
- Verification method:
  - git diff --check、staged diff、任务文档校验。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 通知补拉索引及本地阶段验证

- Status: done
- Owner: coordinator
- Objective: 避免增量拉取扫描/排序全部状态历史，验证并部署本地整改阶段。
- Inputs and prerequisites: T-003；已确认 attention.poll 查询计划。
- Scope or files: crates/agentport-core/src/db/mod.rs、models.rs；本地功能测试和调试包。
- Expected output: v14 语义事件部分索引、游标 seek 查询、本地候选验证证据。
- Dependencies: T-003.
- Execution steps:
  1. 增加迁移与真实 SQL 的 EXPLAIN QUERY PLAN 回归；运行核心与手机回归并构建调试包。
- Acceptance criteria:
  - 使用 idx_attention_cursor 做 SEARCH，不使用临时排序 B-tree；不改变事件语义及游标顺序。
- Verification method:
  - 查询计划测试、DB 回归、核心全量串行回归、Mobile 全量测试和构建、调试 App 路径及截图。
- Validation evidence: DB 58 项通过；core 最终 350 通过/6 ignored；Mobile 308 通过；Debug macOS 和 iOS archive 成功。桌面 GUI PID 39410 路径确认、截图非白屏；手机已安装/重新打开并捕获 Recent 页面。初次 core 全量有 CLI 探测失败，HEAD 对照通过，最终候选完整串行复跑通过；未修改探测模块。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

状态模型先测后改，通知用 fake sink 和可控时钟验证失败、重放、断线和多 Host。交互用组件事件及真机检查。对通知权限拒绝、前台呈现、本地通知点击、后台停止轮询和返回前台补收独立验收；取消锁屏实时推送验收。请求量、并发和有界状态以可重复测试验证；CPU/电量未测时不声称低耗电已达标。构建前后保留生成文件既有差异，只重启本任务相关 GUI，不终止 Host。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- APNs 已明确取消，不再构成阻塞或待办；前台本地通知仍受 iOS 通知权限及系统呈现策略影响。
- 当前事件协议只有增量拉取，全局订阅需核对服务生命周期，不能声称现有连接已经支持通知推送。
- 待处理数据必须可靠保留；队列达到上限时采用背压及持久游标恢复，不静默淘汰未读。
- 工作区已有 LEARNS、PRD、Xcode、ACL 和桌面输入修改，必须原样保留。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-08: 用户最新决定“保持能够前台通知就行，不用后台通知方案”。取消 APNs/provider/token 注册及相关凭据询问；T-005 从 APNs 资源 blocked 收敛为仅前台原生回执/点击定位 pending。现有前台代码无需回滚；本次只更新范围，不声称剩余实机验收已完成。

- 2026-09-08 18:55: 本地阶段已提交 5260dfc。T-005 核对原生边界后 blocked，准备询问 Apple 推送资源与配置授权；不把尚未编写的 APNs provider 描述为只差开关。用户工作区其他修改保持不动。

- 2026-09-08 18:50: T-002/T-003/T-004 本地实现和组件验证完成；新增 T-008 索引性能任务并验证完成。T-005 开始代码/原生边界设计，APNs 及点击定位尚未实现，未读取私钥或修改 Apple 能力。
- 2026-09-08 18:50: iPhone 最终候选安装/启动成功；准备只提交本地阶段，保留所有无关未提交工作。实机未采到真实左滑展开，留 T-006。

- 2026-09-08: 用户选择 Mac 直接 APNs 投递；T-001 done，T-002 in_progress。开始独立 inbox 模型，通知投递凭据仍未配置。

- 2026-09-08: 用户授权计划并实施、禁止 subagent；创建本任务唯一状态文档。
- 2026-09-08: T-001 开始；确认现有 attention.poll 和自部署 Relay 均无 APNs provider。准备确认影响安全与部署范围的架构决策。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 本地阶段 Mobile 308、核心 350 通过，核心 6 ignored；构建/安装/重开两端调试包并确认非白屏。
- Limitations: 后台 APNs 已由用户取消，不属于未完成项。前台原生完成回执、通知点击定位、物理左滑、系统横幅及 CPU/电量测量仍未完成验收；历史自动化结果不等于这些实机验收。
