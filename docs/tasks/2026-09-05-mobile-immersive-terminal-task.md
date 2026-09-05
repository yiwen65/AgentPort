# Mobile 沉浸式 Session 终端

- Created: 2026-09-05
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户截图与沉浸式终端修改要求

<!-- task-doc-section:background-goal -->
## Background and goal
进入 Session 默认隐藏系统状态栏和应用标题栏。日志紧贴刘海下缘，触摸顶部才在原时间/无线图标区域显示标题与操作入口，不挤动终端。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
Mobile 终端布局、导航、iOS 原生状态栏桥接及回归测试。不改变连接、输入协议、主题、Session 生命周期或凭据。系统状态栏原生控制仅针对截图中的 iOS，Android 保留原系统栏行为。不重启桌面 GUI/Host。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence
- 原布局叠加 safe-area 顶部、62px 标题栏和14px终端内边距：`mobile/src/terminal/mobile-terminal.css` 与 `mobile/src/app/styles.css`。
- `App.tsx` 在返回列表后保留 SessionWorkspace；原生状态栏必须跟随可见路由，不能跟随终端挂载。
- 已安装的 Tao 0.35.3 iOS controller 提供 `setPrefersStatusBarHidden:`；其 setter 调用 UIKit `setNeedsStatusBarAppearanceUpdate`。Tauri `with_webview` 暴露该 controller，并在 UI 线程执行。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- 日志从刘海安全区下缘开始，不将完整字符画到硬件遮挡内；只把短标题和操作按钮放进左右两翼。
- 顶部触摸显示，触摸终端内容或再次进入 Session 隐藏；没有擅自增加超时设置。
- 删除常驻返回按钮后，在操作菜单中保留返回列表，并保留原有横向滑动返回。
- Open question: 无阻塞问题。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- iOS 终端中系统时间/网络/电池图标隐藏，退出后恢复。
- 默认无返回按钮、project/branch 副标题或可见 Session 标题。
- 顶部可呼出标题和操作菜单，无遮挡硬件区域，不重建终端或因触摸呼出而关闭键盘。
- 日志顶部仅保留 safe-area 和2 CSS px；控件显隐不改变终端尺寸。
- 测试、前端/iOS构建与模拟器截图验证通过后，仅提交任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
T-001 → T-002 串行实施及验证，共享终端与原生运行状态。额外委派一次只读检查，不授权其修改文件或操作模拟器。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 实现沉浸式终端与状态栏生命周期
- Status: done
- Owner: coordinator
- Objective: 用悬浮顶部控件替代常驻标题栏，并在 iOS 隐藏系统状态栏。
- Inputs and prerequisites: 用户要求、已确认的布局和 Tauri/Tao 原生能力。
- Scope or files: App、SessionWorkspace、MobileTerminal、CSS、i18n、appearance.rs 与相关测试。
- Expected output: 单行隐式顶部导航，不影响终端持续挂载和输入。
- Dependencies: None.
- Execution steps: 实施最小布局与桥接，检查路由/焦点/键盘，运行回归及构建。
- Acceptance criteria: 满足本文行为与生命周期要求。
- Verification method: Vitest、TypeScript/Vite、iOS 构建、差异检查。
- Validation evidence: 最终16个测试文件/86项测试通过；TypeScript/Vite 和最终 iOS 构建通过。触摸呼出的焦点问题已修正，回归与真实键盘验证通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 模拟器验证与 scoped commit
- Status: done
- Owner: coordinator
- Objective: 验证最终真实渲染、状态栏恢复及提交范围。
- Inputs and prerequisites: T-001 最终源代码与构建。
- Scope or files: iPhone 17 Pro / iOS 26.5 模拟器、此记录和 scoped commit。
- Expected output: 可见可用的更新 App，验证证据与任务提交。
- Dependencies: T-001
- Execution steps: 更新模拟器；验证隐藏/呼出/返回/键盘；检查截图；仅提交任务文件。
- Acceptance criteria: 状态栏和日志位置正确，终端节点与呼出前几何一致，原有无关工作保留。
- Verification method: LLDB 调用产品 DOM/API、UIKit 查询、simctl 截图、ps 与 Git。
- Validation evidence: 最终包 PID 34734 路径经 ps 核实。安全区62px、日志y=64 CSS px；触摸呼出前后同一xterm，真实键盘视口566px、终端高432px及输入焦点保持。菜单返回和滑动再进入保留同一 Session/xterm，默认重新隐藏；UIKit 状态栏偏好离开为NO、进入为YES，截图正常。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan
测试默认隐藏、显隐、Escape/Tab、菜单返回、路由再进入、终端保留、触摸呼出时保留输入焦点，以及原生调用顺序/失败恢复/浏览器无IPC。真实模拟器检查状态栏和顶部安全区、呼出前后终端几何、返回恢复。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
- 应用自有 Tao setter 非 UIKit 通用 setter；以 respondsToSelector 防止上游替换 controller 时崩溃。
- 刘海中央必须留空；小屏和横屏需要保持可操作，不能靠负边距把整行画在硬件背后。
- 保留原有 LEARNS.md、PRD、两份桌面终端未提交改动。

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-09-05：确认用户要求并检查现有布局、原生能力；开始实施。此记录在首轮实现之后补建，不追溯声称提前完成计划验证。
- 2026-09-05：首轮构建、安装成功，PID 69574 的模拟器可执行路径经 ps 核实；原生隐藏状态和顶部日志布局确认。
- 2026-09-05：模拟器页面在验证间发生外部切换，最初名为 default 的截图实际为列表，没有将它作为终端隐藏证据。后续以产品 DOM、UIKit 和实际截图一致的状态验收。
- 2026-09-05：只读检查发现触摸呼出将焦点移出终端，影响键盘/尺寸；改为触摸保留焦点，键盘/辅助激活才转移焦点，并使终端外部点击监听识别顶部呼出区域。重新运行最终测试及构建。
- 2026-09-05：T-001 最终测试及构建通过；开始 T-002，安装最终包并核实进程路径。
- 2026-09-05：T-002 模拟器验证通过；没有输入命令、创建或停止 Session。焦点问题作为本轮实现迭代记录于此，未修改已有无关 LEARNS.md。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: passed
- Evidence: `npm test -- --maxWorkers=2`：16 files / 86 tests；`npm run build`：TypeScript/Vite通过；`npm run build:ios-simulator`：BUILD SUCCEEDED；`git diff --check`通过。
- Runtime: iPhone 17 Pro / iOS 26.5，最终 App 打开且连接。单次有界返回/再进入实验结果为 sameNode=true / sameSession=true / chrome=false。跨调用检查期间曾发生 Session 改变，未用该轮作为保留证据。
- Screenshots: 已检查 `/tmp/mobile-immersive-revealed.png`（首轮呼出）、`/tmp/mobile-immersive-keyboard.png`（最终键盘保留）、`/tmp/mobile-immersive-return-list.png`（最终返回状态栏恢复）、`/tmp/mobile-immersive-final.png`（最终默认隐藏及非空白终端）。
- Logs: `/tmp/mobile-immersive-tests.log`、`/tmp/mobile-immersive-build.log`、`/tmp/mobile-immersive-ios.log`。
- Limitations: 没有验证 Android、真机、iOS16、横屏、小屏、VoiceOver 和最大 Dynamic Type。交互主要通过 LLDB 调用产品 DOM/API，不声称完整物理触摸验收。原生隐藏系统栏仅实现 iOS。
