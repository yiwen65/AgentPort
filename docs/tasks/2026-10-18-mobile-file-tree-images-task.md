# Task Plan: 移动端文件树图片查看

- Created: 2026-10-18
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户已确认需求摘要，并授权“编写开发计划，开始实施完成交付”。

<!-- task-doc-section:background-goal -->
## Background and goal

移动端文件树当前只有文本/Markdown阅读，图片能力仅用于Markdown内嵌图片。新增独立图片全屏查看，复用已有安全接口和手势，不改变HTML讨论或桌面端范围。持久计划用于协调原生动图安全门禁、前端资源生命周期和设备交付三条依赖路径。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- iOS/Android；PNG/JPEG/WebP/GIF/静态安全SVG，GIF和动态WebP自动播放。点击直接查看单张。
- 等比适配、双指缩放、拖动、双击缩放、重置；沉浸浮层返回/标题/更多。滑动不返回。
- 保留树展开、滚动和终端；复用原下载入口。退出停止播放、清理句柄与Blob，晚到结果不可复活。
- Session cwd根内，实际格式校验，20MiB/20MP；新增动图帧数/累计画布预算，SVG禁脚本/外部资源。
- 不含相册、切图、缩略图、HEIC/AVIF、SVG动画/源码切换、暂停/进度条、编辑分享、系统相册、持久离线缓存、桌面或HTML。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 需求与执行均已获用户明确确认 | 本轮用户消息及上一轮需求确认 |
| F-002 | 本轮起始工作区干净，HEAD aa9ea22 | 2026-10-18 git status --short / git log |
| F-003 | 已有Session下载分块读取+native校验+安全Blob | mobile/src/platform/tauriMarkdownImageClient.ts、markdownImageAssets.ts |
| F-004 | 现有查看器是85dvh弹窗，具有缩放拖动逻辑 | MarkdownImageViewer.tsx、markdown-images.css |
| F-005 | GIF目前检查矩形/块结构但没有帧预算；WebP只检查头尺寸 | mobile/src-tauri/src/markdown_images.rs |
| F-006 | 现有文件页有持久树/预览与沉浸浮层 | mobile/src/features/files/SessionFiles.tsx、session-files.css |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 已确认透明图片提供可辨识背景并兼顾明暗内容，实现选择棋盘格/浅色/深色切换；每次打开重新适配、不记忆上次变换已在摘要确认。
- Assumption: 动图预算是保守的拒绝门禁，不是浏览器内存的严格保证；以边界测试和可用设备实测记录具体值。
- Open question: 无产品决策待确认。物理设备连接、签名和可操作时间需实际观察。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 已支持扩展名点击不走文本read；真实内容必须原生校验；各允许格式显示，安全SVG无脚本/资源请求。
- 动图在允许预算内播放，超帧/累计画布/格式和尺寸限制均在交给浏览器前拒绝。
- 适配全屏/安全区、明暗/透明背景；拖动/缩放不返回，返回树保持展开/滚动，既有Markdown阅读不回归。
- 加载中可退出；主动退出、后台、断连、换Session、异步晚到均不泄露句柄/Blob或复活页面。
- 原下载不被图片读取占用；失败/超限可重试或原样下载。
- 自动化、实际浏览器、原生测试和可用设备验证结果如实记录；不能以构建/安装代替真机交互证据。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 + T-002 -> T-003 + T-004 -> T-005；T-003 + T-004 -> T-006。
- Parallel batches: 第一批T-001（原生独占）与T-002（前端独占）；第二批集成验证与只读独立审查并行，随后串行设备构建与交付。
- Serialization constraints: 协调者独占本文；不同时写mobile/dist与原生嵌入；原生模块由子任务独占，其余前端由协调者负责。禁止广泛杀进程、卸载手机App或改动非任务文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 独立图片的动图安全门禁

- Status: done
- Owner: image-native
- Objective: 复用原生图片校验，给独立图片启用GIF/WebP帧数和累计画布预算，不改变已有Markdown默认策略。
- Inputs and prerequisites: F-003、F-005；前端将传animationLimits=true。
- Scope or files: mobile/src-tauri/src/markdown_images.rs（独占）。
- Expected output: 可选校验参数、无像素解码的结构门禁、边界测试、记录具体预算。
- Dependencies: None.
- Execution steps:
  1. 增加可选animation_limits参数与GIF/WebP预算验证；拒绝未纳入预算的动画容器。
  2. 增加正常与恶意/截断/边界回归，运行原生测试。
- Acceptance criteria:
  - 可接受正常动图，预算越界在浏览器前拒绝；原调用兼容。
- Verification method:
  - 原生模块测试、定向diff复核。
- Validation evidence: 已复核可选参数、GIF/WebP/APNG门禁与边界测试；子任务定向14/14通过，协调者复跑 PATH=$HOME/.cargo/bin:$PATH cargo test --manifest-path mobile/src-tauri/Cargo.toml --locked --lib 全82/82通过。300帧、8000万累计画布像素（含边界与tiny-delta测试）。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 前端图片页与可取消读取

- Status: done
- Owner: coordinator
- Objective: 文件树图片路由、沉浸全屏、共享手势和有界资源生命周期。
- Inputs and prerequisites: F-003、F-004、F-006及已确认需求。
- Scope or files: mobile/src/features/files/、mobile/src/platform/tauriMarkdownImageClient*、mobile/src/protocol/markdownImageClient.ts、mobile/src/i18n/resources.ts。
- Expected output: 图片页、共享手势、可取消读取、错误/重试/下载/背景交互及针对性测试。
- Dependencies: None.
- Execution steps:
  1. 提取现有查看器手势并为独立查看启用可取消、有预算的本地读取。
  2. 接入树点击和浮层，排除页面滑动与二进制文本read，清理退出/后台/晚到资源。
  3. 补充组件与适配器测试。
- Acceptance criteria:
  - 单张全屏交互与失败状态符合需求，退出回树且不破坏既有阅读。
- Verification method:
  - 定向Vitest与TypeScript检查。
- Validation evidence: 新SessionFileImages6与tauriSessionImageClient5全部通过，原SessionFiles44/MarkdownImages8/旧adapter4均通过（共67项）；npx tsc --noEmit、生产构建及新旧实际Chrome回归通过。退出期间open保留以确保最终close；其余传输与晚到结果可取消。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 整合与实际浏览器回归

- Status: done
- Owner: coordinator
- Objective: 验证前后端契约、生命周期和真实渲染/手势。
- Inputs and prerequisites: T-001、T-002输出。
- Scope or files: mobile/scripts/浏览器回归、mobile前端测试和生产构建。
- Expected output: 全量测试、生产构建与真实Chrome渲染证据。
- Dependencies: T-001, T-002
- Execution steps:
  1. 整合检查和全量测试。
  2. 增加图片页实际浏览器回归，覆盖动画/透明SVG/明暗/拖动缩放/返回树和失败。
- Acceptance criteria:
  - 任务相关测试与构建通过，既有Session文件和Markdown图片回归通过；若全量存在非任务失败，须有独立clean HEAD基线证据并披露，不混入修复。
- Verification method:
  - npm test、npm run build、实际Chrome回归脚本、原生测试。
- Validation evidence: 最终68相关Vitest、npm run build及node scripts/test-file-tree-images.mjs、node scripts/test-session-files.mjs均exit0。GIF/WebP用中心像素截图变化证明播放；截图复核浅/深色、320px窄屏和透明背景。原生全库82/82。全量前端964/965单项GlobalActive失败在独立HEAD归档同样复现，不将其归因于本任务或称全绿；新SMIL回归另已通过。图片adapter在浏览器中mock，不是手机传输证据。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 独立对抗审查与修正

- Status: done
- Owner: file-image-review
- Objective: 独立检查动图门禁、路径边界、晚到/退出资源和手势回归。
- Inputs and prerequisites: T-001/T-002实现与初步集成证据；可与最终回归并行。
- Scope or files: 本任务diff（只读审查），必要修正由协调者执行。
- Expected output: 有证据的审查结果、必要修正及复测。
- Dependencies: T-001, T-002
- Execution steps:
  1. 独立审查可触发的漏洞/回归。
  2. 逐项核实和修正后复测。
- Acceptance criteria:
  - 无未解决的任务内高风险发现。
- Verification method:
  - 定向复核与回归。
- Validation evidence: 独立仅read审查GIF/WebP预算/边界、SVG、取消/句柄、Blob和手势/Session根。发现animateColor遗漏；协调者新增测试先红（实际标签存留），将其加入blocklist后最终68测试与新旧浏览器回归通过。复核无其余具体发现；未声称独立运行测试或设备验收。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 原生构建与可用设备交付

- Status: blocked
- Owner: coordinator
- Objective: iOS/Android构建，尽可能完成设备真实图片交互；按仓库规则打开调试桌面窗口。
- Inputs and prerequisites: T-004通过，设备/签名/工具链可用。
- Scope or files: 忽略的原生产物、统一调试重启入口、设备交付记录。
- Expected output: 签名包、可用设备覆盖安装/启动与实际交互证据或明确阻塞。
- Dependencies: T-003, T-004
- Execution steps:
  1. 串行进行原生嵌入构建，保护旧archive和手机数据。
  2. 覆盖安装/启动并检查具体进程和可用图片页；无设备或控制权限则记录验证缺口。
  3. 统一脚本重启debug GUI，确认可执行路径和非空白窗口。
- Acceptance criteria:
  - 真实结果可追溯；未做真机手势不记为已验收。
- Verification method:
  - 构建/签名检查、设备进程/交互、精确GUI路径与截图。
- Validation evidence: iOS debug archive/签名profile/IPA由build-ios-personal-team.sh与package-ios-development.py验证通过，旧archive已保留。随后iPhone重新connected；devicectl保留数据覆盖安装与launch成功，PID1309可执行路径与本次安装目录匹配。Android arm64 debug APK构建并通过apksigner v2签名验证；两包放在 ~/Downloads/AgentPort-file-tree-images-20261018-143118/，SHA256SUMS双校验通过。Desktop统一脚本--skip-build重启精确GUI并截图确认非白屏。手机并行使用中，未继续抢占操作，未验证图片页/双指/后台；adb无设备，Android未安装。
- Blocker: 尚未获得手机独占验收时段及Android设备；安装/进程不是图片页交互证据。
- Unblock condition: 在可操作且已连接Session的iPhone/Android上验证真实文件读取、GIF/WebP播放、缩放拖动、返回树及后台清理；不卸载App或覆盖个人数据。

### [ ] T-006 — 文档与任务专属提交

- Status: in_progress
- Owner: coordinator
- Objective: 更新使用说明、收口证据并提交本任务改动。
- Inputs and prerequisites: 自动化与审查通过，设备状态已如实记录。
- Scope or files: mobile/SESSION_FILES.md、本文及本任务源码/测试。
- Expected output: 验证后的Git commit，不混入并行工作。
- Dependencies: T-003, T-004
- Execution steps:
  1. 更新支持格式、预算、使用方式和验证边界。
  2. 检查差异、计划校验、版本同步，暂存本任务文件并提交。
- Acceptance criteria:
  - 文档与实现一致、提交范围准确，交付报告不掩盖阻塞。
- Verification method:
  - task_document.py validate、git diff --check、版本同步与提交文件核对。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先运行SessionFiles/图片查看器/原生适配器单测，再运行mobile全量测试和生产构建。原生校验测试验证GIF/WebP完整结构、帧预算和累计画布预算；真实Chrome验证解码、动图变化、SVG安全、触控和树位置。iOS/Android按可用环境构建和安装；原生传输和手机手势独立记录，不把浏览器mock视为原生证据。所有mobile/dist写入与archive构建串行。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 动图由WebView解码播放，预算只限制输入工作量，并非绝对堆内存上限。
- 退出正在open的传输若只取消RPC可能丢失服务端句柄；需确保收到open后最终close，其他阶段可取消。
- 真实设备可能离线/锁屏/没有已连接Session，不能用安装代替验收。
- 当前Mobile为GPL-3.0-only；不导入桌面非商业许可实现。
- 全量前端964/965，GlobalActiveDashboard.test.tsx:47一项失败；独立clean HEAD归档补齐资源后同样复现（该组52/53），单独运行该文件可通过。保留基线问题，不混入修复。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-18 14:15 +0800: 创建唯一执行计划；起始git工作区干净，确认已有图片链路和85dvh查看器。T-001/T-002开始，文件所有权互斥。
- 2026-10-18 14:20 +0800: T-002的11项新测试与原有56相关测试、tsc通过。测试初次误选下载徽标role=img，已改按文件名定位并补完整下载mock。
- 2026-10-18 14:24 +0800: T-001定向14测试、协调者原生全库82测试通过；最初offline缺少tao Git pin，正常联网Cargo拉取后通过，不改依赖或锁文件。T-001/T-002 done，T-003集成与T-004只读独立审查并行开始。
- 2026-10-18 14:25 +0800: 新/旧实际Chrome回归通过。截图复核发现fixture浅色设置未生效，已使用真实主题变量纠正；Chrome退出清理曾ENOTEMPTY，已改为等所属进程退出再删临时目录。全量GlobalActive单项失败在clean HEAD归档独立复现。
- 2026-10-18 14:25 +0800: 实体iPhone均unavailable，adb无设备。统一脚本--skip-build重开debug GUI，ps精确路径PID96012与窗口2076非白屏已确认；无桌面源码改动无需重编译。
- 2026-10-18 14:28 +0800: 独立审查发现旧SVG sanitizer遗漏animateColor；新增定向回归实际失败（标签存留），最小blocklist补全后通过。SVG仍只静态，不扩大权限。
- 2026-10-18 14:31 +0800: 最终68相关测试、生产构建、新/旧Chrome全部exit0，清理竞态修正也完成；T-003/T-004 done。T-005开始原生串行构建，设备状态仍需交付时复核。
- 2026-10-18 14:32 +0800: iOS开发归档与签名IPA校验完成，输出在Downloads；随后串行Android构建，未并发写dist。
- 2026-10-18 14:34 +0800: Android arm64 debug APK构建完成；iPhone已重新连接，保留数据覆盖安装/启动成功且进程路径匹配。手机正在并行使用，停止交互/画面采集并恢复DeviceHub原选择，非任务画面自有临时截图已删除，不保留内容；不当作图片页验收。T-005 blocked，待独占设备时段与Android设备。
- 2026-10-18 14:36 +0800: 两包已汇总至Downloads并双SHA校验通过；恢复自动构建产生的跟踪Info.plist版本与ACL漂移，不提交生成噪音。更新SESSION_FILES与静态SVG可复用教训；T-006开始收口提交。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001至T-004已通过实现/相关测试/原生测试/实际浏览器/独立审查；iOS/Android构建、iPhone覆盖安装启动、desktop debug精确进程与非白屏通过；T-006提交中。
- Limitations: T-005手机图片页/手势/后台真实验收未完成，Android无连接设备；全量前端一项GlobalActive基线失败已独立复现，未掩盖或混入修复。浏览器原生adapter为mock，不替代真机传输验证。
