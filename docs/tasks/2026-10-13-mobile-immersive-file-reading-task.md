# Task Plan: 移动文件沉浸阅读与跟手导航

- Created: 2026-10-13
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户确认沉浸式文件体验需求后授权实施并交付。

<!-- task-doc-section:background-goal -->
## Background and goal

以正文为主，文件树与预览保持相邻全屏页；单行文件栏、二级操作菜单、跟手切换与返回位置保持，改善截图中多层操作/说明占用正文的问题。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

预览栏仅返回图标/文件名/更多图标；文件树栏仅返回/目录名/更多。刷新、下载、复制、源码/渲染、完整路径/安全说明按需显示。普通正文右滑回树，树左滑回最后预览；跟手、距离速度完成/回弹、每次只一层。横滚代码、选字、链接/菜单排除。同Session往返保持树/正文位置及模式。文件页中下载任务收进更多菜单并有轻量图标提示；错误、缓存、截断仍明确。保留安全区、系统状态栏、减弱动态效果、可访问按钮入口。Markdown本地链接用行内视觉，不缩正文/热区。无终端/Session列表重做、无后端或下载机制变更、无文件历史/新格式/目录安全范围改变。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户已确认上述需求及默认行为并授权实施 | 上轮结构化确认和本轮请求 |
| F-002 | 现有preview数据与可见状态混用，返回会清除文件；顶部多层常驻说明 | mobile/src/features/files/SessionFiles.tsx |
| F-003 | App已有终端/树手势；preview目前标记no-page-swipe，代码标记horizontal-scroll | mobile/src/app/App.tsx、FileContent.tsx |
| F-004 | 下载任务App级provider独立于Session视图，已有详情Modal | FileDownloads.tsx |
| F-005 | 初始工作区干净，HEAD28fc16b；实体iPhone当前可连接 | git status/log、devicectl list devices |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Accepted assumptions: 正常阅读隐藏静态说明但保留异常；树标题目录名；树左滑返回最后文件；未选不进空页；不改变终端本身；同Session/当前文件往返保留，不新增跨App重启持久历史。
- Implementation decision: 分离preview文件与previewVisible；两页持续挂载、inert/aria隔离，原生非passive触摸处理与CSS变量跟手，无每move重新渲染Markdown。
- Implementation decision: FileDownloads新增沉浸surface注册与指示器/详情入口；仅文件页隐藏大卡片，其他页面现有行为保留。
- Open question: 无产品阻塞；真机交互/安装能力以当前工具实际输出为准。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 正常预览正文紧接单行栏，无常驻操作行/完整路径/安全段落；长文件名省略不撑高，图标44CSSpx热区。
- 所有现有操作菜单可发现/执行，安全读取/Markdown策略不变；链接不呈现大按钮。
- 手势跟手、短滑回弹、完成/取消正确；纵滚、代码横滚、长按选择、链接/菜单、多指不误切，App父手势不穿透。
- 树/预览往返不重新挂载正文、不重新请求当前文件、不丢位置/模式；返回终端不结束Session。
- 下载在文件页不遮正文，更多菜单有进度/待处理指示，可打开详情取消/保存；离开文件页现有卡片恢复，失败残留提示不被吞。
- 定向/全前端测试、生产构建、真实浏览器触摸/几何与可用真机检查通过；更新调试App并截图确认正确窗口；只提交本任务。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001、T-002、T-003按固定契约并行；T-004依赖前三项；T-006依赖T-004且需恢复手机连接；T-005依赖T-004/T-006且需独占真机操作条件。
- Parallel batches: 手势hook、下载沉浸呈现、协调者布局/菜单；随后串行集成与运行验收。
- Serialization constraints: swipe子任务只改新useFilePageSwipe.ts及测试；download子任务仅FileDownloads.tsx/test/css；协调者SessionFiles/FileContent/session-files.css/i18n/App必要集成/脚本/文档。本计划仅协调者写，平台构建串行避免dist写冲突。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 跟手文件页手势

- Status: done
- Owner: file-swipe
- Objective: 实现可复用但仅服务文件两页的跟手触摸hook与回归。
- Inputs and prerequisites: 固定useFilePageSwipe({containerRef,active,previewVisible,hasPreview,onShowTree,onShowPreview}) -> {dragging}；hook在container设置--file-swipe-offset（px）、data-file-swiping，容器base transform由previewVisible控制。
- Scope or files: mobile/src/features/files/useFilePageSwipe.ts及.test.tsx。
- Expected output: 原生capture触摸处理、方向/排除/取消/速度距离门禁、无父导航穿透。
- Dependencies: None.
- Execution steps:
  1. 实现跟手、完成/回弹与滚动/选字/多指/菜单/生命周期排除。
- Acceptance criteria:
  - 只处理preview右滑/tree左滑；tree右滑交给既有App；非passive preventDefault有效；无每move React更新正文。
- Verification method:
  - 定向Vitest及集成真实Chrome触摸。
- Validation evidence:39/39 swipe定向测试与TypeScript通过；真实Chrome位移在松手前变化、短滑回弹/双向完成/父层不穿透/菜单可点击通过。实测暴露450ms兼容click抑制吞掉250ms后新操作，两个新增测试修复前失败，修复后原浏览器流程通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 下载沉浸菜单入口

- Status: done
- Owner: compact-downloads
- Objective: 文件页仅指示器及二级详情，不出现大任务卡片。
- Inputs and prerequisites: useFileDownloads({immersive?:boolean})返回现有available/occupied/start加snapshot?/openDetails；导出FileDownloadIndicator展示进度/待处理，根SessionFiles调用immersive:active。
- Scope or files: FileDownloads.tsx、FileDownloads.test.tsx、file-downloads.css。
- Expected output: 稳定surface注册清理、文件页隐藏卡片、状态提示、详情保留及回归。
- Dependencies: None.
- Execution steps:
  1. 添加可选沉浸surface hook及菜单指示器，保留下载机制和异常信息。
- Acceptance criteria:
  - 只影响文件页，离开恢复；任务/取消/另存为及残留错误不丢；默认无provider安全。
- Verification method:
  - 定向Vitest，根菜单集成测试/截图。
- Validation evidence:32/32下载测试、TS通过；根集成测试菜单进入下载详情/状态保留/无大卡片通过；Chrome截图download-compact-progress与download-in-more-menu确认健康正文不被卡片遮挡；原生下载方法完全未改。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 精简栏、菜单与阅读状态

- Status: done
- Owner: coordinator
- Objective: 重构文件视图状态，接入两hook并精简正文上方Chrome。
- Inputs and prerequisites: T-001/T-002固定hook契约，当前安全/文档读取实现。
- Scope or files: SessionFiles.tsx/test、FileContent.tsx、session-files.css、i18n及App必要排除、脚本/使用说明。
- Expected output: 单行栏、操作/信息菜单、紧凑异常、持续挂载的滑动页、位置/模式保持与回归。
- Dependencies: None.
- Execution steps:
  1. 分离选中文件与可见页，接入精简栏和菜单；保持请求取消/竞态隔离。
  2. 接入手势/下载指示，检查App父手势不穿透，更新必要测试和脚本。
- Acceptance criteria:
  - 满足布局、菜单、阅读状态与安全不变；同文件往返无重复读取。
- Verification method:
  - 文件组件/App测试，TS/Vite构建与真实Chrome。
- Validation evidence:全mobile842/842串行测试、TS/Vite生产构建通过，真实Chrome49CSSpx单行栏（48px控件+1px边框）、正文零额外区、行内链接无边框/内边距、320px长标题/热区/浅深色/横屏、页面DOM/模式/阅读位置保持通过。独立审查指出渲染Markdown内联组件函数重建DOM，精确pre身份回归修复前失败，稳定回调/组件map/memo后测试与原生横滚Chrome检查通过。
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 跨层运行验证、更新App与提交

- Status: in_progress
- Owner: coordinator
- Objective: 审查实际手势/布局，更新可用设备并记录证据后提交。
- Inputs and prerequisites: T-001/T-002/T-003通过。
- Scope or files: 本任务diff、任务文档、iOS/Android及桌面调试产物。
- Expected output: 测试、截图/运行证据、签名调试包更新、相关Git commit。
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. 全前端测试/构建、真实Chrome触摸及窄屏浅深色/正文链接几何检查、独立对抗审查。
  2. 构建并保留数据更新可用iPhone/模拟器；原生截图/手势验证，不改用户授权或系统设置。
  3. scripts/restart-debug-app.py精确重启GUI并核对路径/非空白截图；版本/diff/任务文档校验后独立提交。
- Acceptance criteria:
  - 所有本任务自动化通过，实际渲染与触摸证据真实，未覆盖的设备/系统行为不夸大。
- Verification method:
  - Vitest/build、真实触摸脚本、devicectl/Cua截图与窗口身份、git diff/check-version/task validator。
- Validation evidence:最终842/842前端测试、TS/Vite、Chrome完整触摸/几何脚本通过；iPhoneOS真机签名归档/profile/IPA验证与保留数据安装启动成功，Android APK构建成功；统一脚本重启Debug GUI PID92206，ps精确路径及window1956截图确认非空白。版本/diff/任务文档检查通过。T-005原生阅读手势独占条件另行blocked；T-006最终包部署另外blocked，当前代码交付剩余动作仅本任务commit。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 独占真机时完成阅读手势验收

- Status: blocked
- Owner: coordinator
- Objective: 在不与用户或其他调试操作争抢手机输入的条件下，完成真实文件阅读往返验收。
- Inputs and prerequisites: T-004已安装的新版本、可独占的手机测试时间段及既有授权主机。
- Scope or files: 同一文件的真机预览/菜单/短滑回弹/返回/横滚/选择，不发送终端命令或更改设备授权。
- Expected output: 原生截图与实际手势状态记录，区别于Chrome fixture证据。
- Dependencies: T-004, T-006.
- Execution steps:
  1. 用户明确可独占手机后，从已有Session打开Markdown/代码，验证精简栏、菜单、返回位置、横滚和选字排除。
- Acceptance criteria:
  - 观察能够归因到本次动作，不把安装成功或其他交互导致的画面变化当作手势通过。
- Verification method:
  - 实机控制和devicectl截图，同一文件前后状态对照。
- Validation evidence:实体iPhone更新安装/启动成功，DeviceHub可展示屏幕；尝试一次镜像拖动期间，实际Session/输入画面出现其他交互变化，结果不可归因。本轮停止争抢手机输入，未宣称真实文件两页手势已通过。Chrome真实触摸/位移/回弹已通过，但不能替代该项。
- Blocker: 手机存在同时交互/调试，当前没有独占、稳定的原生手势验证条件。
- Unblock condition: 用户确认手机可暂时独占测试；随后继续本记录，不重写实现或通过反复输入猜测结果。

### [ ] T-006 — 恢复连接后覆盖最终真机包

- Status: blocked
- Owner: coordinator
- Objective: 将包含最后复制反馈自动收起的最终签名版本覆盖到手机。
- Inputs and prerequisites: T-004最终源码/签名归档、重新可用的实体iPhone连接；前一次主功能包已成功安装。
- Scope or files: 仅com.agentport.mobile保留数据覆盖安装，不改授权或其他App。
- Expected output: 最终包安装/启动结果与进程截图，不把早期主功能包当完整最终包。
- Dependencies: T-004.
- Execution steps:
  1. 手机重新接电/解锁且可连接后复核签名及设备状态，安装最终归档并确认启动。
- Acceptance criteria:
  - 不卸载清空数据；实际安装成功，版本包与最终源码一致。
- Verification method:
  - devicectl安装/启动/进程及截图。
- Validation evidence:最终iPhoneOS归档/IPA与Android APK顺序构建通过；最后devicectl安装报CoreDeviceError4016（设备无法满足连接/电源/服务usage assertions），随后list devices显示实体手机unavailable。此前主功能包安装成功，本次最后复制反馈完善未覆盖。
- Blocker: 实体手机连接不可用，无法覆盖最终包；不重复盲重试。
- Unblock condition: 用户重新接电、解锁并恢复可用连接，然后继续该步骤。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

覆盖两页往返/短滑回弹/快滑/方向锁/纵向优先/代码与文本选择/链接/多指取消/菜单/隐藏中断/减弱动态，目录/正文滚动与Markdown模式保持，不重复请求；菜单操作、异常/缓存/截断/下载状态正常保留。浏览器真实DOM/触摸测位移并截图320/390及横屏浅深色。原生安装和交互以可用设备当前能力为准；不把DOM断言当真机证据。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 父App已有手势，子页必须消费本层事件，不能一次跨到终端。
- React被动touchmove不能阻止原生滚动；使用局部非passive监听并保留代码原生横滚。
- 持续挂载页面需inert/aria隐藏非当前层，过渡不能导致隐藏内容聚焦。
- 菜单压缩不能吞异常/截断/下载目标残留警告；这些优先于沉浸。
- 构建过程保留已有签名和Session Hosts，不用强制查杀/发布实例。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-13: 核对确认契约、干净HEAD28fc16b、现有文件/下载/App结构与可连接iPhone；固定hook和文件所有权，T-001/T-002/T-003开始。
- 2026-10-13: 手势39项、下载沉浸32项及根组件集成通过；真实浏览器揭露新点击被ghost抑制吞掉，修复并回归原流程。独立审查的Markdown渲染节点重建问题由pre身份回归复现，修复后返回/菜单/进度更新与横滚位置不再丢。T-001/T-002/T-003 done。
- 2026-10-13: 初始全量并行有既有GlobalActiveDashboard计时用例失败，串行完整841/841通过；TS/Vite通过。Chrome脚本通过跟手/回弹/模式位置/代码原生横滚、49px健康栏、零额外Chrome、长标题及下载菜单检查；横滚动量先稳定后比较，避免把惯性剩余6px当状态丢失。
- 2026-10-13: 实体iPhone用既有签名Team重建并验证当前iPhoneOS归档/IPA，保留数据覆盖安装/启动通过。Android APK构建通过。真机镜像期间发现同时交互，停止追加输入并新增T-005 blocked；安装启动与完整手势验收分开记录。
- 2026-10-13: 发现外部独立键盘按钮改动已提交38f5cc9，不修改、不混入本任务；当前dirty仍均为本任务文件。桌面统一脚本构建签名重启成功，待最后核对GUI路径/截图和提交。LEARNS新增两条实际失败的可复用教训。
- 2026-10-13: Debug新GUI PID92206/window1956激活与截图、ps路径确认正常；仅统一脚本关闭旧GUI72608，不停止Host/Connector。最终任务文档/版本/diff校验通过，准备提交已验证改动。
- 2026-10-13: 外部只改LEARNS的dd28a21已提交，差异复核本任务仅包含两条新增教训，保留其键盘环境条目，不混入其工作。
- 2026-10-13: 补充复制反馈3秒自动收起及回归，避免成功提示成为常驻正文Chrome。最终完整842/842、生产构建与Chrome脚本通过；最终iPhoneOS签名归档/IPA及Android APK顺序重建通过，尝试刷新实体iPhone以包含全部最终改动；安装报CoreDeviceError4016，重新观察手机unavailable，新增T-006 blocked。早期沉浸主功能包已安装，但最后复制反馈完善尚未覆盖；原生独占阅读手势仍不冒称完成。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence:T-001至T-003完成；842项测试、生产构建、Chrome真实触摸/几何/截图通过，iPhone新版本安装启动与Android构建通过。T-004代码验证已完成，剩余提交；T-006最终安装受手机连接阻塞、T-005独占实机阅读手势条件受阻。截图 /tmp/agentport-immersive-evidence/，实机启动 /tmp/agentport-immersive-iphone-startup.png；不以启动替代阅读手势验收。
- Limitations:实际iPhone文件两页手势/选择/VoiceOver及Android原生文件页尚未完整验收；手机同时交互导致单次镜像操作不可归因。早期沉浸主功能包已安装，最后复制反馈完善的最终签名包因手机unavailable待覆盖。无后端和下载机制改动。
