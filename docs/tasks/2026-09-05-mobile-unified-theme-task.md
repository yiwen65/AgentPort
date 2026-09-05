# Mobile 单行 Session 与统一 Theme

- Created: 2026-09-05
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户的三项修改要求和两张截图

<!-- task-doc-section:background-goal -->
## Background and goal
Session 单行显示，名称前只放状态图标；活跃条目之间及顶部留缝；统一 Theme 控制界面和终端。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
仅 Mobile 前端、测试与此记录。保留连接、启动和 Session 生命周期逻辑，不改桌面端、Host 或其他未提交文件。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence
- 基线 e650ed1 的 SessionRow 为名称加元数据双行。
- appAppearance.ts 和 terminalAppearance.ts 维护两个偏好；六套终端色板已包含完整浅深色及工作区语义色。
- App 保留隐藏的 SessionWorkspace，切换颜色不能重建终端。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- 遵照用户“采用终端主题”，保留旧终端主题/深浅选择为统一配置；旧主界面独立偏好不再参与计算。
- 新安装默认 One / System；时间仍在行尾，状态文案只供无障碍读取，未读保留小圆点。
- Open question: 无阻塞问题。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- 状态图标、名称和时间在同一行，不可见 Agent 类型和状态文字；仍有状态的可访问描述。
- 活跃列表顶部及条目之间存在可见空隙，触摸目标至少 44 CSS px。
- Settings 只有一个 Theme，包含 Light / Dark / System 和六套颜色；界面与终端同步响应，保存并恢复。
- 保留现有终端偏好和实例；System 跟随 OS；验证测试、构建、模拟器截图后仅提交任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
T-001 → T-002 串行完成，避免主题状态、全局 CSS 和消费者测试的共享修改。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 实现单行布局与统一主题
- Status: done
- Owner: coordinator
- Objective: 实现单行布局与统一主题。
- Inputs and prerequisites: 用户三项要求、现有 Mobile 实现。
- Scope or files: Dashboard、StateBadge、主题目录/状态、App、Settings、CSS、i18n 及测试。
- Expected output: 单一主题源、单行 Session 和有间距的活跃列表。
- Dependencies: None.
- Execution steps: 实现、检查关联消费者和运行相应验证。
- Acceptance criteria: 满足本文验收条件，无终端重建或无关改动。
- Verification method: Vitest、TypeScript/Vite、iOS 模拟器和计算样式。
- Validation evidence: 15 个测试文件 / 82 项测试通过；TypeScript/Vite 构建通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 完整验证及提交
- Status: done
- Owner: coordinator
- Objective: 完整验证及提交。
- Inputs and prerequisites: 用户三项要求、现有 Mobile 实现。
- Scope or files: 完整测试、构建、模拟器检查和 scoped commit。
- Expected output: 单一主题源、单行 Session 和有间距的活跃列表。
- Dependencies: T-001
- Execution steps: 实现、检查关联消费者和运行相应验证。
- Acceptance criteria: 满足本文验收条件，无终端重建或无关改动。
- Verification method: Vitest、TypeScript/Vite、iOS 模拟器和计算样式。
- Validation evidence: 最终 iOS 构建、安装和真实 WebKit 验证通过，PID 60835 路径经 ps 核实；浅深色截图正常，详情见下方。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan
覆盖存储兼容、System 事件、同步界面/终端、存储拒绝、模态语义及布局 CSS；生产构建和模拟器截图检查真实行布局、留缝、六主题及深浅切换。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
旧全局 CSS 的加载顺序不能覆盖新行布局。避免双主题源重新出现；不混入 LEARNS.md、PRD 和两份桌面终端文件的原有改动。

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-09-05：确认用户要求已明确覆盖上一轮独立主题设计；开始 T-001。
- 2026-09-05：T-001 完成。统一偏好复用旧终端存储键，扩展 System；共享快照保证新打开的消费者在存储失败时也保持同步。
- 2026-09-05：82 项回归和前端构建通过，开始 T-002 模拟器验证。
- 2026-09-05：最终 iOS 包重装、连接已有主机。实测项目行 48 CSS px、活跃卡片 50 CSS px；名称高 20、状态图标高 16；不再有 Agent 元数据行。
- 2026-09-05：活跃列表顶部间距 12 CSS px，条目间距 8 CSS px；320×568 WebView frame 下仍成立且页面宽度为 320，无水平溢出；已恢复 402×874。
- 2026-09-05：以已附加的稳定终端节点验证六主题×浅深色共 12 组，每组 App 背景变量与终端背景变量一致，xterm DOM 节点均保留。原始首次导航期间的节点引用没有用作此验证基准。
- 2026-09-05：真实模拟器系统 light→dark→light 下，System 同时切换主界面和终端，保存的模式仍为 system，节点保持不变。恢复系统浅色及验证前的 Cupertino/Dark 偏好。
- 2026-09-05：仅附加已有 Shell，没有输入命令、创建或停止 Session，也没有更换凭据或关闭桌面/Host。最终 App 保持打开和连接。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: passed
- Evidence: `npm test -- --maxWorkers=2`：15 files / 82 tests；`npm run build`：TypeScript/Vite 通过；`npm run build:ios-simulator`：BUILD SUCCEEDED（日志 /tmp/mobile-unified-ios.log）；`git diff --check` 通过。
- Screenshots: 已检查 /tmp/mobile-unified-projects-light.png、/tmp/mobile-unified-active-light.png、/tmp/mobile-unified-active-dark.png、/tmp/mobile-unified-theme-system-light.png、/tmp/mobile-unified-theme-system-dark.png。
- Limits: 仅 iPhone 17 Pro / iOS 26.5 模拟器；没有 Android、真机、VoiceOver、最大 Dynamic Type 或真实横屏旋转验证。小屏检查是临时调整真实 WKWebView frame，交互主要通过 LLDB 调用产品 DOM/API。状态文案保留为无障碍描述，不声称完成屏幕阅读器实测。
