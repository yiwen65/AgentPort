# Task Plan: Mobile 终端滚动真机诊断

- Created: 2026-10-14
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户报告Agent终端滚动卡顿、静止时仍卡；要求解决采样阻碍并继续。

<!-- task-doc-section:background-goal -->
## Background and goal
打通真机观测，区分触摸/手势调度、远端输入与重绘、网络/排队、收到输出后的解析与绘制；不凭静态代码或平均CPU推断主因。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
仅诊断与必要诊断工具；优先无源码改动的系统采样与WebKit检查。无源码通道不足以取得触摸/回包/解析时序后，增加默认关闭的VITE_SCROLL_DIAGNOSTICS=1诊断collector并以本机临时开发签名包覆盖安装；只记录数值/模式，不含终端内容。临时脚本/trace置于/tmp；不改滚动行为、不删除权限/安全设置、不重启用户Session或安装未知包。保持已有用户文件修改。若不能完成时序分段，明确证据缺口，不宣称已修复卡顿。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence
| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 普通buffer/no-mouse走本地scrollLines，alternate/SGR会产生远端输入 | MobileTerminal.tsx:625；隔离真实xterm实验0 vs 15 input events |
| F-002 | 按PID/名称单进程附加失败，但devicectl确认App存活 | 前次xctrace日志与device processes |
| F-003 | iPhone27.0、Xcode27.0；DDI compatible/isUsable | 本轮xcodebuild、devicectl ddiServices |
| F-004 | --all-processes Time Profiler能够录制并导出App/WebContent/GPU | /tmp/agentport-scroll-system-probe-20261014.trace与toc/profile |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- Assumption: 用户按提示在20秒窗口滚动；必须用观测事件检查，不能把无手势录制当作复现。
- Open question: 当前Agent实际buffer/mouse mode、gesture-to-output-to-render耗时与120Hz/实际帧率待采集。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- 录制/导出真机目标进程有效样本，排除“App未运行”的错误推断。
- 在可用通道上获取实际滚动模式/渲染状态与时序证据，或记录精确新阻碍。
- 将采样事实、支持推断和未知分开；给出下一个能区分网络/远端与本地绘制的动作。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
- Dependency graph: T-001 -> T-004 -> T-005 -> T-002 -> T-003; T-001 -> T-003.
- Parallel batches: 初始T-001系统trace与T-002 WebKit查询独立；T-004 helper归scroll-collector、调用点归coordinator，可按不同文件并行。
- Serialization constraints: 项目记录只由coordinator写；诊断worker只能写/tmp，不修改或操作App。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 打通系统采样
- Status: done
- Owner: coordinator
- Objective: 绕过单进程枚举附加阻碍，取得真机App与WebContent样本。
- Inputs and prerequisites: 连接且已信任的iPhone、当前App进程、Xcode27工具。
- Scope or files: xctrace/devicectl；/tmp trace与导出。
- Expected output: 可导出CPU样本与进程身份。
- Dependencies: None.
- Execution steps:
  1. 核验DDI兼容性与进程。
  2. all-processes短probe，再采20秒样本并导出。
- Acceptance criteria:
  - 目标App及WebContent样本存在。
- Verification method:
  - xctrace export toc/time-profile；解析目标进程样本。
- Validation evidence: probe录制/export成功；20秒样本录制/export成功。App4216、WebContent4217、GPU4218均有样本；仅统计目标进程。DDI usable、compatible。不是单进程附加的根因证明，而是验证过的替代路径。
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — 模式/帧/时序观测
- Status: blocked
- Owner: coordinator + webkit-diagnostics
- Objective: 获取真实WebView模式、帧调度、滚动输入与输出/绘制关联；解析CPU符号。
- Inputs and prerequisites: App存活、已取得trace、本机WebInspector库与设备符号。
- Scope or files: /tmp/agentport-scroll-*；系统device support symbols，仅诊断。
- Expected output: 有范围和开销边界的观测。
- Dependencies: T-004, T-005.
- Execution steps:
  1. 检查WebInspector服务，仅枚举AgentPort页面。
  2. 核对实际模式/renderer；必要时临时诊断hook，不改滚动逻辑。
  3. 将trace地址匹配本机相同UUID符号，统计目标进程成本。
- Acceptance criteria:
  - 实际读值有工具证据；未取得的指标明确标UNKNOWN。
- Verification method:
  - 诊断脚本返回、trace解析、模式与手势计数校验。
- Validation evidence: 已取得两轮真实滑动（2+4段）与CPU工具验证样本；完整时序日志、实际SGR/WebGL、同步保持时间及解析/调度成本已验证。最终matched ACK与实际paintBlocked需要最新包。
- Blocker: 手机变为unavailable，最终包安装报CoreDevice4016；用户选择暂时不方便连接。
- Unblock condition: 用户接线、解锁，完成T-005后在同一场景滑动。

### [ ] T-003 — 结论与限制
- Status: blocked
- Owner: coordinator
- Objective: 给出证据支持的分段诊断与可验证的下一步。
- Inputs and prerequisites: T-001、T-002结果。
- Scope or files: 本任务文档；不改产品滚动逻辑。
- Expected output: 事实/推断/未知、记录与用户结论。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 核对观测是否覆盖实际卡顿而非idle。
  2. 比较输入前后时间与解析绘制成本，检查观测者开销。
  3. 记录结论与未完成项，检查diff。
- Acceptance criteria:
  - 不将平均CPU、模拟/离线结果误当真机因果证明。
- Verification method:
  - 数据/脚本审查与文档validator。
- Validation evidence: 已给出有数据的初步分段结论；paint请求抑制与matched ACK占比未取得真机确认，不把相邻输出视作RTT。
- Blocker: T-002最后确认样本待用户恢复连接。
- Unblock condition: T-002获得最终确认或用户接受当前有界诊断。

### [x] T-004 — 默认关闭的时序采集与签名产物
- Status: done
- Owner: coordinator + scroll-collector
- Objective: 绕过未广告的WebInspector页面，以有界本机时序日志捕获真实手势、输入、输出、解析与render边界。
- Inputs and prerequisites: T-001采样成功；用户授权解决诊断阻碍；已有真机开发签名流程。
- Scope or files: mobile/src/terminal/scrollDiagnostics.ts与tests（worker）；MobileTerminal.tsx、SessionWorkspace.tsx、synchronizedOutput.ts与tests（coordinator）；必要文档/测试。
- Expected output: 默认关闭、一次15秒、内存/日志有界、无内容/身份数据的诊断collector与安装包。
- Dependencies: T-001.
- Execution steps:
  1. 实现注入clock/timer/sink的纯collector与边界回归。
  2. 在既有touch/input/output/parse/render seam添加opt-in调用，不改时序/行为。
  3. 门禁通过后，仅本机VITE_SCROLL_DIAGNOSTICS=1构建签名与覆盖安装。
- Acceptance criteria:
  - 默认关闭且无IPC/rAF采样；每帧不写日志，最终records<=550chars、4096条事件上限且丢弃量可见；无终端原文。
  - 测试、TypeScript/Vite和实际诊断构建/安装通过，默认构建恢复；代码验证后commit。最新包的安装/实机确认由T-005单独跟踪。
- Verification method:
  - Collector/integration Vitest、production build、真机日志与包签名；独立review。
- Validation evidence: 最终59 files / 911 tests通过、TypeScript/Vite生产构建及startup gate通过；opt-in针对性测试、真实App+xterm诊断链路测试通过（含terminalInput、inputAck与实际paintBlocked）。所有日志含分隔符<=550chars，无原文；多版签名/实际安装取得真机日志。最终完整版本签名/profile验证通过，安装待T-005。独立只读review及后续observer delta review无未解决回归；普通dist已恢复，debug GUI统一脚本重开、精确路径核对、窗口截图正常。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 最新包安装与确认样本
- Status: blocked
- Owner: coordinator
- Objective: 安装含terminalInput/paintBlocked/匹配ACK字段的最后签名包，确认窗口与分段归因。
- Inputs and prerequisites: T-004最终签名iPhoneOS archive；当前已信任设备。
- Scope or files: 私有开发包、device install/launch、仅数字diag日志。
- Expected output: 最新包安装/进程/实际滑动确认；不改滚动逻辑。
- Dependencies: T-004.
- Execution steps:
  1. 先确认物理设备connected且解锁。
  2. 覆盖安装最终archive，launch并检查进程，不卸载数据。
  3. 固定键盘/页面20秒复现，复制diag.log和必要轮转文件。
- Acceptance criteria:
  - 最后字段有真实样本，明确哪些等待属于门控/本地队列/远端ACK。
- Verification method:
  - devicectl install/launch与日志字段、序号匹配。
- Validation evidence: 构建签名通过；实际install报CoreDevice4016/assertions unavailable；随后devicectl显示物理iPhone unavailable。未盲重试；用户明确选择暂时不方便。此前门控版已有真实日志，不当作最后版确认。
- Blocker: 用户设备当前不可连接。
- Unblock condition: 用户重新接线、解锁并允许恢复真机操作。

<!-- task-doc-section:validation-plan -->
## Test and validation plan
所有实时观测只针对AgentPort与其WebContent/GPU；无关进程不报告。CPU按sample weight统计且检查missing stacks；frame、手势、output必须同时间基准。单次采样不可泛化p95或全场景性能；网络段包括远端处理/队列，不能仅凭RTT猜测。没有产品代码修改时不运行无关构建或重装。

### 已取得的真机证据（非优化收益）

- 初版有效样本：5.492s、15.001s；分别1024 retained /400、619 dropped，因此分段时序只覆盖前3.856s、10.340s。rAF p50=17ms、p95=18–19ms；input→本地release p95=5ms；queuedWrite→parsed p95=3–4ms。下一output不是与input匹配的回包，不把18–58ms观察间隔称作网络RTT。
- 门控版有效样本：alternate/any/SGR/WebGL，7.328s（2053 events）、15.001s（3750 events）、3.507s（1186 events）；均无event/frame丢失；正常buffer/no-mouse控制0.726s（51 events），无输入/输出，仅本地16次render。短控制不能代表长期GPU健康。
- 三段alternate的rAF p95=18/19/18ms、最大66/30/47ms（第一段有2次>50ms）。本地input release p95=6/4/4ms；解析p95=3ms（第二段queued=273、parsed=275并有2次resize，不强行FIFO配对）。output→下一write批次p95=15/16/15ms。
- 真实同步门控开始/结束235/436/135对，均由marker释放、没有watchdog或reset释放；保持p95=34/18/33ms、最大50/51/51ms。在hold期间parsed到下次render的观察间隔p95=194/175/126ms，hold外p95=32/24/44ms；这是many-to-one的下一render间隔，不是每次write已在屏幕呈现的精确延迟。必须核对真实被抑制的paint才能定位调度影响。
- wheelOutside均0；wheel flush197/415/140，5ms内观察到的input134/292/66。轻微运动常没有input，但旧版本记录的是输入守卫后，不能直接断言xterm丢失：最终terminalInput/匹配ACK字段用于排除此歧义。固定像素轮滚会经过xterm整数行量化，且SGR wheel不携带位移大小；源头事实见xterm Terminal.ts:641、Viewport.getLinesScrolled。
- 原始文件与可重现解析：/tmp/agentport-scroll-system-probe-20261014.trace、agentport-scroll-active-20261014.trace、agentport-scroll-active-profile.xml、agentport-scroll-active-symbols.json；/tmp/agentport-scroll-phone-traces.json（初版）、agentport-scroll-gate-phone-analysis.json（门控版，只有数字/模式/随机traceID）；/tmp/agentport-scroll-diag-browser.mjs（生产App+xterm、虚构remote adapter、不是真机网络）。完整device trace有无关系统进程，仅报告App关联部分；不提交任何trace/profile/签名/设备身份。
- 验证：collector/terminal/workspace/sync gate普通和opt-in测试；默认完整suite在一次构建并发下出现未改GlobalActiveDashboard的1s等待超时，单独复核17/17、随后4-worker全suite通过。新增observer不改变门控，错误隔离/marker/timeout/reset/blocked paint均有回归。浏览器真实App测试对接17个phase中的有效阶段，采集期间0条IPC/log，仅finish写入，所有记录含分隔符<=550chars且无原文；默认普通构建/startup gate通过。源码修改仅用于观测，尚未作滚动优化。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
xctrace单进程附加仍失败；all-processes已验证可用。symbolicate默认命令未找到相关dSYM，需核对本机DeviceSupport Mach-O符号或WebKit调试路径。用户是否在录制窗口实际滑动尚未证实；不将低平均CPU等同无渲染问题。WebInspector若未获系统授权，不绕过或自动打开安全设置。

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-10-14: 核验App、DDI、Xcode；all-processes短probe成功，单进程附加阻碍有可验证替代路径。
- 2026-10-14: 20秒Time Profiler录制/export成功；默认symbolicate无相关dSYM。通过DeviceSupport相同UUID的Mach-O与atos解析了WebCore/JSC/WebKit/AgentPort符号；CPU样本没有足够touch帧证明复现。
- 2026-10-14: WebInspector旧lib的-3混淆timeout；直接property-list binary framing验证收发成功，但精确App/代理身份不广告。LLDB未取得可求值的stopped进程；未改任何系统权限。
- 2026-10-14: 选择T-004默认关闭的有界数值埋点路径；worker实现collector，coordinator接入与验证，暂不改滚动逻辑。
- 2026-10-14: 首轮诊断包签名/覆盖安装、907 tests及浏览器真实链路回归通过，实际iPhone取得两段有效滑动数据；默认关闭/开启诊断均通过。
- 2026-10-14: 补入实际xterm编码、轮滚flush/越界、同步门控起止；再安装并获取4段无记录丢失的实际样本（含本地normal控制）。常规file browser与临时DOM terminal回归通过。
- 2026-10-14: 根据“输入前/绘制请求”缺口补入terminalInput、paintBlocked及数字序号匹配完成ACK；不增加网络请求、不改原输入/绘制行为。完整单测911项及诊断浏览器链路检查通过，等待最终真机确认样本。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: blocked
- Evidence: T-001与T-004完成；有效真机滑动和回归见正文。T-005设备不可用、用户暂停，T-002/T-003最终确认保留。
- Limitations: 不是卡顿修复；同步保持与后续render等待关联明显、解析/JS调度通常很快；纯网络/远端处理份额与真实GPU呈现未分离，不能宣称GPU健康或给出网络RTT。

### 暂停与恢复记录
- 2026-10-14: 最终签名包路径可从本机 `/tmp/agentport-scroll-complete-iphone-paths.json` 找到；仓库archive为 `mobile/src-tauri/gen/apple/build/agentport-mobile_iOS.xcarchive`。install返回4016，device list显示unavailable，用户选择暂时不方便；停止设备操作。
- 2026-10-14: 最终默认全suite911/911、build、startup graph验证通过；不混入用户immersive-file-reading任务文档改动。仅诊断代码与记录提交，保留已取得的无内容数据；恢复时先核对设备与artifact，不假定旧安装失败无外部效果。
- 初步SUPPORTED INFERENCE：优先调查触摸→整数行/VT wheel映射与同步完整帧绘制调度，暂无持续解析/JS线程饱和的证据；不是已经证明“网络慢”或“显卡慢”。
