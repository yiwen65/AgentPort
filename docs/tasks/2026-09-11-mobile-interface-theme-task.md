# Task Plan: 移动端独立黑绿界面主题

- Created: 2026-09-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户确认仅移动端、默认黑绿界面主题、与终端设置解耦。

<!-- task-doc-section:background-goal -->
## Background and goal

以参考图的近黑/深绿底、灰白文字及亮绿—黄绿主按钮设计界面，保留布局、业务行为和终端原配色。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

首页、列表、全局设置及主界面弹窗使用独立界面主题；主界面模式独立持久化，默认深色黑绿，支持独立明亮/深色/跟随系统。根据用户后续纠正，Session 外层、终端及外围控件继续随终端色板保持沉浸式体验。保留终端六色板和原模式选择。不改桌面，不重启用户 Host/Agent/Connector，不分发 TestFlight，不使用子代理。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 主界面订阅终端主题并投射 root CSS 变量 | mobile/src/app/appAppearance.ts |
| F-002 | Session 外层还覆盖通用语义色 | SessionWorkspace.tsx，terminalThemes.ts |
| F-003 | 设置只有一个 Theme 分组 | SettingsDialog.tsx |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 黑绿是独立界面的唯一色系，提供独立明暗模式，不增加未请求的多个品牌色系。
- Open question: 无阻塞产品决策；设备验收以实际可用性记录。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 改变终端色板/模式不会改变界面；改变界面模式不会改变终端，旧终端存储不迁移覆盖。
- 新默认黑绿深色；独立设置保存并恢复，存储不可用仍可切换。
- 语义文字对比度至少 4.5:1，按钮渐变最暗端也检查文字对比度；错误/警告不以绿色代替。
- 不改变既有布局和终端会话行为；测试和设备截图如实记录。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002。
- Parallel batches: 无，串行。
- Serialization constraints: 共享主题、设置及 CSS 同一人修改；构建保留生成文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 独立外观状态与黑绿色板

- Status: done
- Owner: coordinator
- Objective: 分离主界面和终端色彩作用域及存储。
- Inputs and prerequisites: 已确认需求和现有调用链。
- Scope or files: appAppearance、SettingsDialog、SessionWorkspace、CSS、i18n 和相关测试。
- Expected output: 独立设置、黑绿默认主题和回归覆盖。
- Dependencies: None.
- Execution steps:
  1. 新建独立界面模式存储，不改终端存储。
  2. 替换主界面语义色，保留 Session 外层的终端色板覆盖。
  3. 设置分组、翻译和隔离/对比度测试。
- Acceptance criteria:
  - 主题互不影响，原终端偏好保留，主界面主题清晰可读。
- Verification method:
  - Vitest、TypeScript、颜色对比度测试。
- Validation evidence: 完整 434 Mobile 测试通过，TypeScript/Vite 构建通过。测试覆盖主界面/终端双向独立、原终端存储保留、Session 语义色覆盖仍存在、存储失败、恢复、system 模式；深浅主题正文/次级文字 4.5:1 和两端渐变主按钮文字 4.5:1 对比度断言通过。
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — 构建与视觉验收

- Status: blocked
- Owner: coordinator
- Objective: 构建更新手机调试包并验证界面。
- Inputs and prerequisites: T-001。
- Scope or files: 调试包和本文档。
- Expected output: 验证记录、截图与任务 commit。
- Dependencies: T-001.
- Execution steps:
  1. 运行完整移动端测试和构建。
  2. 更新 iPhone 调试包，截图检查主界面与设置；按统一脚本重开桌面调试窗口。
  3. 核对并提交任务改动。
- Acceptance criteria:
  - 不混入无关改动，未验证项明确说明，不停止现有用户 Agent。
- Verification method:
  - 构建、真机截图、diff 检查。
- Validation evidence: iOS arm64 debug archive 构建通过，生成文件恢复原状。Chrome CDP 390/320 CSS px 设置页、浅色设置页及无 Native bridge 的空首页截图已检查；两宽度 document.scrollWidth 等于 innerWidth，弹窗在视口内、内容可纵向滚动。统一脚本 --skip-build 重开桌面调试 GUI；PID 50023 精确 executable 路径，窗口 2898 截图非白屏。git diff --check 通过。
- Blocker: iPhone 17 Pro Max 当前 unavailable，devicectl 安装失败；真机安装与真实数据/Session 视觉验收未完成。浏览器首页提示 Native bridge 不存在是预览环境限制，不代表手机业务验收通过。
- Unblock condition: 重新连接并解锁 iPhone，安装已构建调试包，截图验收首页、设置及沉浸式 Session。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

独立存储与恢复、旧终端偏好保留、两方向主题隔离、system mode、不可用存储、多消费者；语义色对比度；完整移动测试和 iOS 构建。截图验证真实设备，键盘/读屏未实测不宣称覆盖。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

共享工作区有无关文档和生成文件改动。终端外围样式目前仍使用 terminal 变量，需要区分实际渲染背景与界面按钮，不能全局替换。Android 原 APK 打包存在依赖网络缺口。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-11: 用户确认；完成耦合点定位，T-001 开始。
- 2026-09-11: 用户纠正 Session 外层必须保留终端配色以保持沉浸感；已恢复 SessionWorkspace 和终端外围原有颜色继承。
- 2026-09-11: T-001 完成。独立界面 key 为 agentport-mobile-v3:interface-mode，默认 dark，不迁移原终端存储。Session 的 --bg 与主按钮颜色显式随终端，避免继承主界面绿色渐变。
- 2026-09-11: 完整 434 测试和 iOS archive 通过；T-002 因手机离线 blocked。初次 Chrome CLI 截图受最小窗口限制裁切，改用 CDP device metrics 后测得真实 390/320 CSS px 并截图确认。修复设置面板原有 margin-top:0 对新增第二分组的覆盖，恢复两组间距。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 实现及 434 测试、TypeScript/Vite、iOS arm64 archive 均通过；浏览器深浅设置页和 320/390 宽度检查通过；桌面 GUI 重开与截图通过。日志 /tmp/interface-all-tests.log、/tmp/interface-build.log、/tmp/agentport-image-ios-build.log；截图 /tmp/agentport-interface-settings-390.png、/tmp/agentport-interface-settings-320.png、/tmp/agentport-interface-light.png、/tmp/agentport-interface-home.png、/tmp/agentport-interface-debug.png。
- Limitations: iPhone 离线，未安装此次包、未完成真机和读屏/200%文字测试；Android 未执行新打包。桌面主题未改，未重启用户 Host/Agent/Connector，未发布 TestFlight。代码提交不代表 T-002 真机验收已通过。
