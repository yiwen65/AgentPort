# Mobile 科技感双主题与状态设计

- Created: 2026-09-05
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户提供的 Logo 截图及已确认的设计摘要

<!-- task-doc-section:background-goal -->
## Background and goal
用品牌中心圆环 Logo 替代启动文案；冷白/午夜蓝双主题，以真实状态图形、精炼文案和克制交互动效提升清晰度。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
仅 Mobile 前端、测试和任务记录。不改桌面端、SSH、Host、生命周期协议、终端六主题或其他未提交工作。不创建或停止生产 Session。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence
- 基线 `2422666` 已有项目启动按钮、居中选择器和独立 SettingsDialog。
- App.tsx 在返回列表后保留终端组件；terminalAppearance.ts 管理独立终端偏好。
- SessionSummary 没有退出码；core/models.rs 的 Lifecycle 和 AgentState 区分退出、中断、停止、运行、输入等待等，不能把 exited 推断为异常。
- mobile/package.json 支持 Vitest、TypeScript/Vite 和 iOS 模拟器构建。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- 用户明确确认：主界面 Light / Dark / System，默认 System；保持终端外观独立。
- 用户确认：浅色冷白银灰、深色午夜蓝，冷青和少量蓝紫用于品牌与交互重点，不做满屏霓虹。
- Open question: 无阻塞问题。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- Logo 启动按钮保留至少 44 CSS px 点击区域、可访问名称和原项目启动逻辑。
- 设置新增主界面三态偏好，持久化并动态跟随系统；不重建 xterm。
- 状态有图形和文字，不只靠颜色；缓存/离线不显示实时运行动画，未读独立表达。
- 按压、展开、弹窗和主题切换有有界反馈；减少动态效果时停用运动。
- 完成回归、构建、实际 WebKit 布局和截图检查，并记录未覆盖范围。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
T-001 → T-002 → T-003 串行集成，避免共享 CSS/设置冲突。状态组件委派未产出文件；最终所有改动由 coordinator 集成和验证。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Logo、双主题、状态和动效
- Status: done
- Owner: coordinator
- Objective: 实现已确认的视觉和行为合同。
- Inputs and prerequisites: 用户截图、确认摘要、当前 Mobile 组件和协议类型。
- Scope or files: AppAppearance、AgentPortMark、Dashboard、SessionStateBadge、Settings、Modal、CSS、i18n。
- Expected output: 双主题 Logo 和界面、三态偏好、语义状态和有界动效。
- Dependencies: None.
- Execution steps: 实现主题状态与配色，连接设置，重排状态行，加入按压/展开/弹窗动效。
- Acceptance criteria: 主界面与终端独立，状态不猜测，保持原启动与导航行为。
- Verification method: 组件与状态测试、TypeScript、模拟器计算样式。
- Validation evidence: 主题和状态测试、Modal 生命周期测试、App 保留终端断言通过；最终 WebKit 行宽 352、按钮宽 346、标题宽约 321 CSS px。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 集成与回归验证
- Status: done
- Owner: coordinator
- Objective: 验证持久化、系统跟随、状态优先级、模态焦点和配色约束。
- Inputs and prerequisites: T-001 实现。
- Scope or files: Mobile 测试文件和构建产物。
- Expected output: 全套回归和生产构建通过。
- Dependencies: T-001
- Execution steps: 增加主题存储/系统事件测试、状态矩阵、动效减少偏好与 CSS 回归，运行完整测试和构建。
- Acceptance criteria: 无重新附加或终端偏好变化；退出不误报失败；旧 CSS 不覆盖行布局。
- Verification method: npm test -- --maxWorkers=2；npm run build；npm run build:ios-simulator。
- Validation evidence: 最终 15 个测试文件 / 82 项测试通过；TypeScript/Vite 及最终 iOS 构建通过。已测不透明文字/状态配色组合 >=4.5:1，Logo 配色端点对 fill >=3:1（不是整应用无障碍认证）。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 模拟器验证与提交
- Status: done
- Owner: coordinator
- Objective: 在实际 WebKit 验证视觉与关键路径，并只提交本任务。
- Inputs and prerequisites: T-001、T-002 通过。
- Scope or files: 最终模拟器包、运行时检查、截图和任务相关 diff。
- Expected output: 已更新且正常显示的 Mobile App，以及有边界的验证证据。
- Dependencies: T-001, T-002
- Execution steps: 安装启动最终包，连接已有配置，检查双色和布局，验证系统跟随/终端保留/动效，检查提交范围。
- Acceptance criteria: 非空白窗口、可用启动入口、可访问关闭按钮；排除原有四个无关脏文件。
- Verification method: simctl、ps、LLDB 内产品 DOM/API 调用、截图及 git diff --check。
- Validation evidence: iPhone 17 Pro / iOS 26.5 最终包 PID 65873 可执行路径已核实；连接成功；实际 OS light→dark→light 下 System 跟随成功，保留相同 xterm 节点和终端偏好；范围检查通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan
自动回归覆盖未知/旧状态、生命周期优先级、缓存、持久化拒绝、系统事件、模态焦点及减少运动；模拟器验证浅深色、Logo、设置、窗口尺寸、实际动画和既有终端保留。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
保留原有 LEARNS.md、docs/mobile-app-prd.md、src/src/terminals.ts、src/src/terminals-renderer.test.ts 改动，不纳入提交。原有终端/Host 进程不停止。没有失败退出码证据时显示“已结束”，不推断失败。

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-09-05：用户确认设计合同，开始 T-001。状态组件委派失败且没有文件产出，没有采用未验证产物。
- 2026-09-05：主题、Logo、状态、动效集成完成；开始 T-002，新增断言并通过完整回归。
- 2026-09-05：T-003 首次截图发现行变窄；计算样式定位到后加载的全局旧 grid 规则，按钮只有 10 CSS px、标题为 0。仅覆盖 display:block 即恢复宽度，证明因果；随后把行布局集中到 styles.css 并移除旧列定义，增加防回归断言。
- 2026-09-05：修复后重新运行 82 项测试、前端和 iOS 构建；重装最终包，截图及计算样式确认布局正常。
- 2026-09-05：实际切换模拟器系统浅深色验证 System，随后恢复系统浅色及验证前主界面 Light 偏好；终端外观未修改。本轮只附加已有空闲 Shell，没有创建、输入命令或停止 Session。
- 2026-09-05：320×568 和 568×320 的临时 WKWebView frame 验证无水平溢出，设置可纵向滚动，滚动到底后关闭按钮仍可见（44×44 CSS px）。已恢复 402×874。
- 2026-09-05：WebKit 实际采样弹窗进入 220ms、退出 130ms，进入时 transform 为中间矩阵，关闭后对话框移除；背景 inert 为 true。减少运动路径由自动测试覆盖。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: passed
- Evidence: 15 files / 82 tests；最终前端/iOS 构建成功；最终浅深色、设置及选择器截图已检查：/tmp/mobile-future-light-final.png、/tmp/mobile-future-dark-final.png、/tmp/mobile-future-settings-final.png、/tmp/mobile-future-picker-final.png。构建日志：/tmp/mobile-future-ios-final.log。
- Limitations: 仅 iOS 26.5 模拟器；没有 Android、真机、iOS 16、VoiceOver、最大 Dynamic Type 或真实横屏旋转验证。小尺寸检查是调整真实 WKWebView frame，而不是独立设备。运行时操作主要经 LLDB 执行产品 DOM/API，不声称完成全物理触摸验收。截图覆盖现有实际状态，其他状态由组件测试覆盖。
