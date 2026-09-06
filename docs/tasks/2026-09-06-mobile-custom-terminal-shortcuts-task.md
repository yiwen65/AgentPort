# Task Plan: Mobile 可配置终端快捷键

- Created: 2026-09-06
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求重排快捷键、增加方向键与 Ctrl、通过齿轮自定义；已确认只保留一个 Ctrl，支持自定义文本和组合键，优先使用图标。

<!-- task-doc-section:background-goal -->
## Background and goal

提供图标化、可配置并持久化的 Mobile 终端快捷键，保持已有输入、粘贴、选择和几何同步语义。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

默认顺序 /、Ctrl、Tab、@、Esc、↑、↓、←、→、Paste、Shift、Cmd，齿轮固定可达；一行横向滚动，不缩小触摸目标。设置支持内置按键显隐、排序、自定义文本和 Ctrl/Alt/Shift 组合键、修改/删除自定义项、恢复默认、保存/取消。只修改 Mobile 快捷键相关代码与本文件，不处理前一轮未定位的 SSH 问题，不改凭据、Host 或现有 Session。保留原有四处 dirty 文件。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 原快捷栏为七个固定按钮，Shift/Cmd 为单次修饰键 | mobile/src/terminal/MobileTerminal.tsx |
| F-002 | Paste 必须走完整 click，不能沿 touchstart 即时发送通道 | d787787 与原生 WebKit 复测 |
| F-003 | 已有带焦点隔离的 Modal 和 localStorage 设置惯例 | mobile/src/components/Modal.tsx, mobile/src/terminal/terminalAppearance.ts |
| F-004 | 用户明确保留现有 Shift/Cmd/Tab/Paste 图标；只保留一个 Ctrl | 当前用户确认 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 自定义布局在当前 Mobile 安装内全局保存，不与主机或 Session 绑定；Cmd 保持现有本地复制/粘贴/全选语义，Ctrl/Shift 为下一次输入生效。方向键遵循终端 application-cursor 模式。
- Open question: 无阻塞决策；真机与 Android 原生触摸不作为模拟器验证结论。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 默认顺序、图标和仅一个 Ctrl 符合用户确认；齿轮不随按键横向滚出视野。
- Ctrl+C、Ctrl+方向键、Shift+Tab、application-cursor 方向键等编码正确且每次只发送一次。
- 自定义可增改删、显隐、排序、恢复默认和持久化；保存/取消/重排不向终端发送任何数据。
- 设置对话框焦点隔离，普通 IME 输入保持 xterm 唯一发送者；Paste 的完整点击路径不退化。
- 回归、类型/前端构建、iOS 模拟器构建通过；更新签名 debug GUI，检查精确进程与非白屏截图；仅提交本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无。
- Serialization constraints: coordinator 顺序完成；不使用 subagent；只用隔离终端测试数据。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 快捷键模型与终端键编码

- Status: done
- Owner: coordinator
- Objective: 可验证的布局模型、存储验证与键序列编码。
- Inputs and prerequisites: 用户确认和当前 xterm API。
- Scope or files: mobile/src/terminal/shortcuts.ts 及测试。
- Expected output: 默认布局、损坏存储恢复、严格输入验证、Ctrl/Shift/Alt 与方向键编码。
- Dependencies: None.
- Execution steps:
  1. 实现模型、边界校验、存储与纯编码函数。
  2. 验证控制字符和 application-cursor 模式。
- Acceptance criteria:
  - 无自动执行；损坏/未知数据不能成为不可控的发送行为。
- Verification method:
  - 单元测试与类型构建。
- Validation evidence: shortcuts.test.ts 7 tests passed；前端 tsc/Vite 构建通过。包含默认顺序、存储损坏/失败、组合键与 application-cursor、IME 不变性。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 图标快捷栏与自定义设置

- Status: done
- Owner: coordinator
- Objective: 接入横向快捷栏和可保存/取消的设置 UI。
- Inputs and prerequisites: T-001 模型。
- Scope or files: MobileTerminal.tsx、ShortcutSettings.tsx、相关 CSS/测试。
- Expected output: 固定齿轮、可配置顺序、可访问按钮、单次 Ctrl 与自定义键派发。
- Dependencies: T-001
- Execution steps:
  1. 接入图标栏与设置，保留原 Paste 路径。
  2. 验证不重复输入、不误触键盘、不泄漏设置输入到终端。
- Acceptance criteria:
  - 满足整体交互与持久化验收。
- Verification method:
  - 组件测试、真实浏览器触摸与原生模拟器隔离操作。
- Validation evidence: 174 Mobile tests、Chrome 真实触摸回归通过；独立 WKWebView 原生 XCTest 2/2 通过（native-final.log），设置保存/重启持久化另一次单测通过（native-fixed2.log）。隔离夹具无 RemoteClient，不操作用户 Session。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 综合回归与调试交付

- Status: done
- Owner: coordinator
- Objective: 确认相邻行为、构建与可见交付。
- Inputs and prerequisites: T-001/T-002。
- Scope or files: 测试脚本、debug bundle、本任务文件。
- Expected output: 测试证据、更新后的模拟器与 desktop debug GUI、task-only commit。
- Dependencies: T-002
- Execution steps:
  1. 执行完整 Mobile 回归及构建。
  2. 仅重启目标 GUI，检查截图、精确路径与 diff 后提交。
- Acceptance criteria:
  - 验证实际通过；无法覆盖的环境明确列出。
- Verification method:
  - npm test -- --maxWorkers=2、npm run build:ios-simulator、scripts/rebuild-debug-app.sh、git diff --check。
- Validation evidence: npm test -- --run（174 passed）、npm run build、npm run build:ios-simulator、signed desktop rebuild 均通过。更新并启动 com.agentport.mobile，截图正常渲染但仍显示 Disconnected — Cached，不宣称 SSH 已修复。desktop GUI PID 33541 精确路径为当前 checkout target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport，截图非白屏。证据 /tmp/ap-shortcuts/。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

纯函数验证存储/编码，组件验证设置与输入边界，隔离实际 xterm 验证模式和触摸；不向用户 Session 输入。全套测试与 iOS/desktop 构建后更新调试 App。临时原生夹具及截图放 /tmp。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

重点保护 Paste 用户激活、修饰键组合、application-cursor 模式、快捷栏横向滚动与原 App 切换手势、Modal 焦点恢复及存储失败。不得更改 SSH 凭据来完成此任务。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-06: 用户确认范围；T-001 开始，检查原固定七键、Modal 和设置存储模式。
- 2026-09-07: T-001 done，T-002 in_progress。模型/设置/终端共 34 个针对性测试通过；实际 Chrome 触摸脚本通过横向滑动不输入、齿轮位置固定、方向键/修饰键、Paste 和设置焦点回归。为支持横向滚动，所有快捷键改为完成 click 后发送，保留 mousedown 的焦点保护。下一步原生 iOS 隔离验收。

- 2026-09-07: 原生编辑流程定位到滚动内容内 Add 按钮裁切、XCTest 点击落到 section；编辑时隐藏列表并将编辑操作固定到底部。撤回未经证明的通用 Modal visualViewport 改动；最终设置流程连续两次通过，无编辑输入发送，重启后持久化。快捷键真实软件键盘 Ctrl+C、application Up、横滑无输入和 Paste 单次发送通过。隔离服务已停止、两个夹具 App 已卸载。T-002/T-003 done。

- 2026-09-07 后续调整（覆盖原固定齿轮验收）：按用户新要求将 ⚙️ 放入滚动区末尾；图标 22→18px，间距 8→2px，保留 44px 触摸目标。22 个终端组件测试、真实浏览器触摸回归（齿轮随滚动移动、末尾可达并可打开设置）通过；iOS/签名 desktop 构建通过，更新并重启两端。精确 debug GUI PID 43980 与非白屏截图已确认，Mobile 仍显示 Disconnected — Cached。证据 /tmp/ap-shortcuts-compact/；未重新执行原生 XCTest，不宣称 SSH 已修复。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 174 单测、真实 Chrome 触摸、独立原生 WKWebView 模拟器两项 XCTest、前端/iOS/签名 debug 构建与重启截图检查通过。
- Limitations: 原生真机/Android 未覆盖；之前 SSH 报告不纳入本轮已完成声明。
