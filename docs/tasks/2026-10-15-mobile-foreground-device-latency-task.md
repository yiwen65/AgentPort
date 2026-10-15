# Task Plan: 移动端真机前台恢复延迟复验与定位

- Created: 2026-10-15
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户报告偶发前台 reconnect/attach 超过1秒；在 a055301 后告知 iPhone 已连接并要求 continue。

<!-- task-doc-section:background-goal -->
## Background and goal

覆盖安装已修复的调试包并真机复验。首轮真机仍测到7.296秒恢复，因此继续定位已确认的连接重建瓶颈，不以本地 Relay fixture 的8–37ms冒充真机结果。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：手机端恢复路径、必要的内容为空的连接阶段计时、相关回归、现有签名/保留数据覆盖安装与真机检查。
- 不改用户网络/权限/配对，不发送终端输入，不重启或停止任何 Host/Agent/Connector，不发布 Release。
- 不混入既有文件阅读任务文档改动或独立的1c3e3d3 Host idle cleanup工作。串行构建 mobile/dist 与设备归档。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | a055301 的移动修复已包含于当前源码；实体 iPhone27.0可连接 | git log/status；devicectl list devices |
| F-002 | 按既有开发证书完成新 iPhoneOS arm64 归档、签名/profile/IPA验证及保留数据覆盖安装启动；新App PID6519 | /tmp/agentport-foreground-iphone-paths.json、install.json、launch.json、processes.json；task-27/28输出 |
| F-003 | 新包显示现有 Session，WebGL2个画布，当前renderer live/无遮挡/输入入口可用；resumeConnection方法存在 | DeviceHub12628物理手机截图；targetRuntime查询 task-32/34 |
| F-004 | 实际后台21.219秒后，探测1501ms失败、disconnect16ms、connect5511ms、两个保留Session attach172/203ms；当前Session恢复可用状态在visible后7296ms | /tmp/agentport-foreground-iphone-cycle1.jsonl；仅计时/状态/已知方法名的临时observer，无终端正文 |
| F-005 | 当前连接为Relay，非SSH；页面维持同一PID/同一WebView | task-38允许字段查询；PID6519、target page-8 |
| F-006 | 同时出现的xcodebuild属于DiaryPhotoDeletion项目，不是mobile/dist写入者 | task-38 ps完整命令 |
| F-007 | 首个原生分段样本：credential5ms、relay-stream4095ms、bridge-hello167ms；首次主要成本在Relay stream建立 | /tmp/agentport-foreground-phase-cold.log；内容为空的原生Instant计时，task-46 |
| F-008 | 继续分段：WSS4088ms、Join500ms、认证157ms；临时显式DNS/TCP分段后WSS样本378/226ms，但一轮Join超时10s、另一轮757ms | phase2-cold.log、phase3-settled.log；未将跨样本变化认定为修复收益 |
| F-009 | 两轮交错WSS-only A/B共12个成功样本：原路径267–7349ms，分段路径241–5908ms；反转首测顺序后两者均慢，不能将分段改写认定为修复 | /tmp/agentport-foreground-ab.log、ab-final.log；均有wss-ab-done，无Join或Session请求 |
| F-010 | 慢的分段样本中配置0ms、DNS5–9ms、TCP1341–2219ms、TLS/WebSocket2397–3896ms | ab-final.log中原生Instant分段；elapsed可能包含调度/挂起，未证明具体网络/OS/服务端根因 |
| F-011 | 最终已重新构建/安装无临时诊断的已提交版本，签名、profile、IPA哈希验证成功，resume修复存在、临时API字符串不存在；PID6622存活 | task-59；/tmp/agentport-foreground-final-iphone-*.json、final-processes.json；二进制strings及codesign检查 |
| F-012 | 最终检查期间手机前台出现非AgentPort界面且有输入；立即停止所有手机输入，非目标App截图已删除 | DeviceHub12628实际观察；不记录非目标App内容，不据此推断App崩溃或代码回归 |
| F-013 | 用户随后选择“可以继续”，排他窗口确认最终App显示本轮真实Session正文；DOM live、recovering=false、inputEnabled=true、两个画布 | /tmp/agentport-exclusive-final.png；task-68/71精确target读回 |
| F-014 | 排他窗口观察到连接重建5101ms，两个保留Session attach238/281ms，disconnect到当前Session恢复5454ms；探测包装最终全部清理 | /tmp/agentport-exclusive-retry2.jsonl；task-71 cleaned=true、absent=true |
| F-015 | 短后台尝试未记录到hidden/visible事件，不能作为有效后台恢复性能样本 | /tmp/agentport-exclusive-cycle.jsonl仅installed/state/ready；未据AX动作回执声称后台复验成功 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 原生样本已指向Relay stream建立，尚需拆分手机WSS、Join等待和Noise响应；不能仅凭总耗时推断DNS/IPv6/TLS或Connector原因。
- Assumption: USB镜像/临时观测可能改变挂起条件；Inspector在首个后台区间已断开。后续A/B未同步记录visibility，且最终观察到其它手机操作，不能把所有波动归因于网络。
- Open question: 无需用户决策；若瓶颈在授权范围外的网络/服务端，停止修改并报告精确证据与解阻条件。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 明确真机连接重建首个成本分歧，不能把connect整体耗时归因于attach/parser。
- 仅在因果证据成立时实施最小修复；健康连接、输入不重放、世代/签名/用户数据边界不回退。
- 在相同真机条件下复验必要阶段与前台到恢复可用状态的耗时；仍超过1秒时说明剩余瓶颈，不能宣称全部解决。
- 新包正常启动/显示Session，移除临时页面观测，保留原手机数据；提交仅本任务修改。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004；T-001 -> T-006；T-001 + T-006 -> T-005（安全清理与已提交包交付）。
- Parallel batches: 无并行写任务；必要的独立只读审查可在单个任务边界内使用。
- Serialization constraints: 同一手机仅协调者控制；mobile/dist、iPhoneOS归档和签名/安装顺序执行。权威文档仅协调者写。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 覆盖安装与真机基线

- Status: done
- Owner: coordinator
- Objective: 安装a055301并恢复真实后台场景的基线。
- Inputs and prerequisites: 用户确认实体iPhone已连接；现有开发签名配置。
- Scope or files: 设备App、私有构建产物、/tmp/agentport-foreground-*。
- Expected output: 已签名新包、安装/启动证据及内容为空的真实计时。
- Dependencies: None.
- Execution steps:
  1. 校验证书Team并保留旧归档，执行build-ios-personal-team.sh。
  2. devicectl覆盖安装并只重开手机GUI，DeviceHub显示真实Session。
  3. 绑定精确AgentPort target，临时观测现有client方法和DOM恢复门槛，后台后正常激活，不发送输入。
- Acceptance criteria:
  - 安装、启动、Session显示均有工具证据；基线区分probe/connect/attach。
- Verification method:
  - 开发包脚本验证、devicectl、DeviceHub截图及读取临时计时。
- Validation evidence: F-002至F-005；实测7296ms，主要成本5511ms connect，而非172/203ms attach。
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — 连接阶段成本定位

- Status: blocked
- Owner: coordinator
- Objective: 定位5511ms连接成本的首个分歧，设计可证伪的控制实验。
- Inputs and prerequisites: T-001原始计时及Relay传输确认。
- Scope or files: mobile/src-tauri/src/remote.rs、lib.rs及relay_transport_tests.rs诊断接缝；crates/agentport-relay/src/net.rs、endpoint.rs的必要分段observer及原路径/等价分段路径A/B；其余凭据/Connector源码只读；手机临时观测。临时WSS探测命令只连接已批准的现有Relay配置、不发送Join或任何Session请求，定位结束移除。
- Expected output: 凭据/传输/hello阶段分布和根因证据，或明确外部阻塞边界。
- Dependencies: T-001.
- Execution steps:
  1. 读取现有连接路径并选择最低侵入阶段计时。
  2. 只在同一手机/传输条件下采集可比较样本。
  3. 用单变量干预或等价实验确认因果链；未证实前不进行正式性能修复。
- Acceptance criteria:
  - 有实测阶段归属和能区分主要候选原因的证据。
- Verification method:
  - 原生阶段计时与客户端observer交叉核对。
- Validation evidence: 原生remote14项及Relay检查通过；F-007至F-010已定位主要等待到TCP/TLS建连，原路径/分段路径交错结果否定稳定的改写收益；尚无可证明的本地修复点。
- Blocker: 排他窗口已确认最终界面，但连接重建仍5101ms；现有样本未证明具体本地修复点。短后台AX操作没有产生visibility事件，不作为性能回归通过。
- Unblock condition: 用户自行换一个网络（或如有VPN，临时断开后告知）作同包对照；继续时先验证实际hidden/visible，再采集同口径样本，不由agent改网络设置。

### [ ] T-003 — 最小修复与回归

- Status: pending
- Owner: coordinator
- Objective: 修复已证明的本地瓶颈，不掩盖真实网络延迟。
- Inputs and prerequisites: T-002确认因果及安全修复点。
- Scope or files: 以T-002证据限定的移动连接路径与必要测试。
- Expected output: 最小diff、红绿回归和邻近行为验证。
- Dependencies: T-002.
- Execution steps:
  1. 在稳定接缝编写能失败的回归。
  2. 修复原因，复核连接所有权、健康连接保留和不重放输入。
  3. 运行最小相关检查后扩大到必要完整suite/build。
- Acceptance criteria:
  - 回归修复前失败、修复后通过；收益来自预测阶段而非计时口径变化。
- Verification method:
  - 相关TS/Rust测试及实测比较。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 最终真机部署与交付

- Status: pending
- Owner: coordinator
- Objective: 将最终版本覆盖到手机并验证恢复路径，清理临时页面观测。
- Inputs and prerequisites: T-003验证通过；手机仍可连接。
- Scope or files: 开发归档、手机App、任务文档及相关提交。
- Expected output: 最终签名包、真机样本/截图、精确验收结果与本任务commit。
- Dependencies: T-003.
- Execution steps:
  1. 串行签名归档/profile验证、保留数据安装和启动。
  2. 复验后台返回、Session可用与有界样本，不触碰Host生命周期。
  3. 清理页面observer/方法包装，校验diff/版本/任务文档并提交。
- Acceptance criteria:
  - 降低已证明的额外延迟，报告实际剩余耗时与测量局限，不冒称所有网络条件下均低于1秒。
- Verification method:
  - devicectl、DeviceHub、内容为空的阶段观测、Git diff及文档validator。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 清理临时探测并保留已提交修复包

- Status: done
- Owner: coordinator
- Objective: 阻塞前移除所有临时诊断API/连接改写及页面包装，安全交付a055301已有修复，不假冒进一步性能改善。
- Inputs and prerequisites: T-001已完成；F-009/F-010表明当前不能接受新的连接改写。
- Scope or files: 本轮5个临时Rust改动文件、私有设备归档、手机页面、权威任务文档；不改外部文件阅读任务文档。
- Expected output: 临时源码清除、重新签名覆盖安装、现有Session可显示、证据和状态提交。
- Dependencies: T-001, T-006.
- Execution steps:
  1. 核对5个文件diff仅含本轮诊断后恢复已提交源码；保留私有原始样本。
  2. 构建并安装无临时API的开发包，保留数据与批准的Relay配置。
  3. 只连接现有mac配置并打开已有Session；不发送输入、不改网络、不动Host/Connector。
  4. 验证正常显示和文档/差异，提交本任务记录并请求所需网络对照决策。
- Acceptance criteria:
  - 无临时探测或未验证性能改写留在源码/最终包；真实剩余问题清楚披露。
- Verification method:
  - git diff、native remote检查、签名打包/安装/进程、物理手机页面截图与任务validator。
- Validation evidence: 5个临时Rust修改全部清除，源码无产品diff；native remote14项通过。最终iPhoneOS开发包签名/profile/IPA校验通过并覆盖安装/启动；IPA SHA256 ebd51cb72beec570c99b1ef4eee4a26d10a5e99e69fe892cf7d4f956e504be75，临时API/计时字符串不在二进制。T-006确认真实Session正常显示，task-71确认页面包装已清理。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 独占条件下确认最终Session画面

- Status: done
- Owner: coordinator
- Objective: 对最终无临时探测包完成可归因的Session显示确认，不把其它控制者导致的画面变化当作产品结论。
- Inputs and prerequisites: F-011最终包、当前Session身份；用户确认无其它手机/agent操作。
- Scope or files: 仅物理iPhone上的AgentPort页面；必要的只读DOM/截图，不发送输入、不操作其它App。
- Expected output: 最终Session渲染/连接门槛证据或清晰的可复现失败与边界。
- Dependencies: T-001.
- Execution steps:
  1. 用户确认可独占后，重新观察当前App与目标身份。
  2. 打开已知现有Session，验证非空、live状态及恢复门槛；有新失败则先复现，不用强制刷新掩盖。
  3. 与T-002的可见性/计时记录相互核对。
- Acceptance criteria:
  - 检查期间只控制目标App；结果可归因且不以启动PID替代渲染验收。
- Verification method:
  - DeviceHub物理手机画面、可用的精确AgentPort target只读观察；Inspector未广告目标时不反复盲试。
- Validation evidence: 用户确认可以继续后，明确AgentPort target重新可读。最终live/无恢复遮罩/输入入口可用，两画布及真实本轮Session正文截图一致；一度Attach failed随后已恢复。task-71清理成功。原生screenshotr仍Invalid service，使用已验证DeviceHub等价画面，未改DDI/权限。此任务只确认最终画面，不代表T-002性能已通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 手机基线/候选均使用现有Relay配置与开发签名，保留数据且不重启远端Host。
- 按证据选择原生remote/Relay回归、foreground TS集成；性能只比较相同测量边界。
- 真机以visible事件到probe/connect/attach结束及最后恢复无遮挡/输入门槛的状态记录计时，不把初始旧画面当作恢复已完成。
- /tmp中的临时JS/Python/日志不提交；观测关闭后核验Session仍正常。Task document validate、diff --check和版本同步作为交付门禁。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 手机再次断开、锁屏或同时交互时暂停相应真机结论，不把启动替代完整恢复验收。排他窗口已完成最终画面检查；A/B波动仍不可作为网络/VPN根因证明。
- 网络/Relay/Connector调度可能是真实外部成本；未证明本地原因时不缩短健康探测超时或更改网络设置。
- 两个保留Session会对同一主机各attach一次；不据此推断同一Session重复attach。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-15: 用户确认连接并要求继续；核对a055301与独立Host后续提交，保留外部文档改动。
- 2026-10-15: T-001开始：现有证书开发归档、签名/profile验证、保留数据安装启动完成，PID6519。
- 2026-10-15: T-001完成：原生物理手机显示当前Session；Inspector Target路由确认可用。临时页面观测不含终端文本，Inspector后台区间已断开。
- 2026-10-15: 真机基线仍失败：后台21.219秒后probe1501ms、connect5511ms、attach172/203ms，总恢复7296ms；未宣称验收通过。
- 2026-10-15: T-002开始：确认Relay而非SSH，继续定位凭据/Relay/Bridge hello子阶段；尚未改正式行为。
- 2026-10-15: 临时native阶段诊断通过remote14项检查并重新签名覆盖安装；冷连接测到credential5ms、Relay4095ms、Bridge167ms。独立只读调查未发现成功路径固定5秒sleep；按证据继续拆分WSS/Join/Noise，不缩短现有超时。
- 2026-10-15: WSS4088ms已确认；显式DNS/TCP/TLS分段样本DNS3–5ms、TCP64–86ms、TLS152–283ms，但有一次Join10秒超时。为排除环境波动或诊断路径变化，增加临时原路径/分段路径交错WSS-only A/B；不据此改正式重试策略。
- 2026-10-15: 完成12个交错样本，两条路径都会慢；慢样本TCP1.341–2.219s、TLS/WebSocket2.397–3.896s，DNS5–9ms。T-002 in_progress→blocked，需用户提供网络对照条件，未实施T-003。
- 2026-10-15: 新增并开始T-005，移除本轮临时诊断并重装已提交修复包；不把实验分段路径包装成性能修复。
- 2026-10-15: T-005完成源码清理、remote14项、最终签名/profile/IPA哈希验证、覆盖安装/启动；随后检查出现非目标App输入，停止全部手机操作，删除该非目标截图。
- 2026-10-15: 新增T-006，最终Session显示检查尝试后blocked；T-005因该验收前提in_progress→blocked。需要用户确认短暂独占手机，再进行可归因的复验，不修改网络或争抢焦点。
- 2026-10-15: 用户选择“可以继续”；T-006/T-005 blocked→in_progress。排他检查记录到连接重建5101ms、attach238/281ms，最终恢复live/无遮挡/输入入口可用并有真实Session正文截图；T-006/T-005→done。
- 2026-10-15: 临时组合JS首次重试因语句连接错误未确认执行，后一次检查时Retry按钮已消失；仅报告实际链路事件，不将其冒称可归因的主动点击收益。短后台AX动作未产生visibility事件，未计作后台性能通过。task-71已清理全部页面包装，无终端输入、网络改动或Host重启。T-002仍blocked，建议由用户手动换网络再对照。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001/T-005/T-006完成；最终签名包已保留数据覆盖安装，真实Session画面与DOM可用状态一致，临时源码/API/页面包装全部清理。基线7296ms；后续实测连接重建5101ms、attach238/281ms；12个WSS A/B原始数据保留。
- Limitations: T-002 blocked，T-003/T-004未执行；短后台尝试没有有效visibility事件，不计为恢复验收通过。需要用户手动换网络后继续同口径对照，当前不声称新性能修复或具体网络/VPN根因。
