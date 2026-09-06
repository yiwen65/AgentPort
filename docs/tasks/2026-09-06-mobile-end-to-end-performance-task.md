# Task Plan: Mobile 端到端性能优化

- Created: 2026-09-06
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户确认“以当前 iOS 为主，全面实测并执行 Mobile 性能优化”。

<!-- task-doc-section:background-goal -->
## Background and goal

按端到端基线定位 Mobile 延迟、主线程工作、重复请求和后台开销，优化有测量证据的主要瓶颈。上一轮 a8cd12e 已优化 Host Stop 和启动 Shell 环境；本轮以此为基线，不重复宣称收益。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

覆盖启动、连接/重连、列表刷新/切换、终端首屏/流式输出/输入/键盘尺寸、多会话与后台恢复；有证据时沿共享后端优化。不重设计交互、不预设架构重写、不降低安全退出、凭据隔离、未知写入不重放、Recent 确认语义。仅操作独立测试会话；保留用户已有四处未提交改动。无 Android/真机条件的部分明确限定。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Dashboard 每 5 秒发起四种全量读取，另有 attention.poll；刷新之间没有 in-flight 去重 | mobile/src/features/sessions/SessionDashboard.tsx |
| F-002 | Dashboard 在终端显示时仍挂载；只保留一个选定的终端组件 | mobile/src/app/App.tsx |
| F-003 | 输出事件同步写 localStorage 中的 cursor；新 renderer 不读取该 cursor，而是请求 bounded tail | mobile/src/features/sessions/SessionWorkspace.tsx |
| F-004 | 原生请求经过 TauriRemoteClient 与 Rust remote.rs；输入采用单独提交/完成通道 | mobile/src/platform/tauriRemoteClient.ts, mobile/src-tauri/src/remote.rs |
| F-005 | 最新后端性能优化已提交；本任务为新的性能工作轮次 | a8cd12e |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 当前 iOS simulator + 同机浏览器受控工作负载用于定位；浏览器结果不等同真机。用原生构建/窗口验收补充交付，不声称真机帧率/耗电。
- Open question: 无阻塞的产品决策；跨公网网络切换、物理键盘/摄像头和 Android 运行时不在可验证环境内。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 建立可重复的启动、刷新、终端输出/切换基线，记录工作量、延迟与限制。
- 仅合入有测量/可计数工作量支持、回归通过的优化；不以缓存陈旧状态或丢字符换速度。
- 保留输入顺序、未知写入不重放、重连 cursor、设备切换 fencing、Recent/通知语义。
- 验证前端全套与类型构建、必要的原生测试/构建；更新 iOS 与签名 debug GUI，截图并验证精确路径。
- 分项提交本任务文件，不混入既有改动；没有收益的已检查链路明确记录，不强行修改。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004 -> T-005。
- Parallel batches: 无；用户已要求顺序协调执行，不使用并行 subagent。
- Serialization constraints: 共享 App/Dashboard/Workspace 和同一模拟器、测试夹具；由 coordinator 串行推进。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立基线与瓶颈排序

- Status: done
- Owner: coordinator
- Objective: 建立基线与瓶颈排序，保持已确认性能契约。
- Inputs and prerequisites: 独立生产打包浏览器夹具、确定性请求/存储/渲染计数、现有 native 生命周期证据
- Scope or files: mobile/src/app, mobile/src/features/sessions, mobile/src/platform, mobile/src-tauri/src/remote.rs
- Expected output: 按链路记录基线、收益候选与不修改项
- Dependencies: None.
- Execution steps:
  1. 检查现有实现与测量工作负载，定位第一处成本差异。
  2. 仅对有证据的候选做最小改动，复测并记录结果。
- Acceptance criteria:
  - 结果可追溯且符合总体验收，无法测量部分不宣称完成。
- Verification method:
  - 受控重复测量、针对性测试、按风险必要的构建与集成验证。
- Validation evidence: /tmp/ap-mobile-perf/baseline-{100,1000}.json：优化打包 React/xterm，Chrome headless 390x844、4x CPU throttle，100/1000 Sessions；8 次并发刷新产生32读取；1000输出事件产生1000同步存储写；隐藏Dashboard继续4种全量读取。连接/生命周期沿用上轮已测后端，未声称新增手机网络收益。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 优化列表请求调度与后台无效工作

- Status: done
- Owner: coordinator
- Objective: 优化列表请求调度与后台无效工作，保持已确认性能契约。
- Inputs and prerequisites: T-001 基线
- Scope or files: mobile/src/features/sessions/SessionDashboard.tsx 及测试，必要的 App 可见性传递
- Expected output: 防重叠读取、保持数据新鲜与通知语义，改善受控慢连接/隐藏页开销
- Dependencies: T-001
- Execution steps:
  1. 检查现有实现与测量工作负载，定位第一处成本差异。
  2. 仅对有证据的候选做最小改动，复测并记录结果。
- Acceptance criteria:
  - 结果可追溯且符合总体验收，无法测量部分不宣称完成。
- Verification method:
  - 受控重复测量、针对性测试、按风险必要的构建与集成验证。
- Validation evidence: Dashboard/App 24 tests passed；npm run build passed；/tmp/ap-mobile-perf/t002-100.json：8次显式刷新32→8请求，最大并发32→4；确定性60秒隐藏测试：全量读取0、attention.poll 12次，返回立即刷新。原有连接/设备切换与Recent测试通过。
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — 优化终端事件热路径

- Status: in_progress
- Owner: coordinator
- Objective: 优化终端事件热路径，保持已确认性能契约。
- Inputs and prerequisites: T-001/T-002 证据
- Scope or files: mobile/src/features/sessions/SessionWorkspace.tsx, mobile/src/terminal, 相应测试
- Expected output: 减少无用存储与事件开销，保持输出、重连与输入正确
- Dependencies: T-002
- Execution steps:
  1. 检查现有实现与测量工作负载，定位第一处成本差异。
  2. 仅对有证据的候选做最小改动，复测并记录结果。
- Acceptance criteria:
  - 结果可追溯且符合总体验收，无法测量部分不宣称完成。
- Verification method:
  - 受控重复测量、针对性测试、按风险必要的构建与集成验证。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 按测量优化启动与列表交互

- Status: pending
- Owner: coordinator
- Objective: 按测量优化启动与列表交互，保持已确认性能契约。
- Inputs and prerequisites: 前序测量及已优化结果
- Scope or files: mobile/src/app/App.tsx, Dashboard 与构建产物及测试
- Expected output: 必要的按需加载/索引或无收益项记录，避免过度抽象
- Dependencies: T-003
- Execution steps:
  1. 检查现有实现与测量工作负载，定位第一处成本差异。
  2. 仅对有证据的候选做最小改动，复测并记录结果。
- Acceptance criteria:
  - 结果可追溯且符合总体验收，无法测量部分不宣称完成。
- Verification method:
  - 受控重复测量、针对性测试、按风险必要的构建与集成验证。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 综合复测和调试交付

- Status: pending
- Owner: coordinator
- Objective: 综合复测和调试交付，保持已确认性能契约。
- Inputs and prerequisites: T-001 至 T-004 完成
- Scope or files: 本任务文档，测试/构建脚本，debug bundle
- Expected output: 同条件前后结果、测试通过、更新 simulator/debug GUI、task-only commits
- Dependencies: T-004
- Execution steps:
  1. 检查现有实现与测量工作负载，定位第一处成本差异。
  2. 仅对有证据的候选做最小改动，复测并记录结果。
- Acceptance criteria:
  - 结果可追溯且符合总体验收，无法测量部分不宣称完成。
- Verification method:
  - 受控重复测量、针对性测试、按风险必要的构建与集成验证。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

使用生产优化 bundle 的隔离浏览器夹具，固定数据规模、消息序列、延迟条件，记录多次中位数及调用/存储/渲染计数；组件 fake timer 测试用于调度边界而非真实手机延迟。`cd mobile && npm test -- --maxWorkers=2 && npm run build`。必要时运行 native Mobile 测试。iOS 构建使用现有 build:ios-simulator，desktop 使用 scripts/rebuild-debug-app.sh。外部临时测量放 /tmp，不污染仓库或用户凭据。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

设备切换/重连的晚到结果、刷新去重吞掉显式更新、暂停后台工作影响通知、终端重连错误地使用旧 renderer cursor、IME 重复发送均需保护。不能通过降低安全或隐藏错误达标。实体机与公网链路结果未覆盖。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-06: 用户确认完整范围；建立顺序执行契约，T-001 开始，已检查主要 JS/原生请求入口。

- 2026-09-06: T-001 完成，T-002 开始。原生协议请求入口已检查；未发现需降低安全语义的理由。夹具原始 esbuild safari13 转换不支持，改为一致 es2020 生产优化；该夹具用于受控浏览器比较，不替代 Vite/iOS 构建。

- 2026-09-06: T-002 完成；保留完整metadata刷新而非引入过期cache。T-003 开始，重点测量base64解码与同步cursor存储。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: not_run
- Evidence: T-001 正在建立基线。
- Limitations: 真机、Android 与公网网络测量暂不可用。
