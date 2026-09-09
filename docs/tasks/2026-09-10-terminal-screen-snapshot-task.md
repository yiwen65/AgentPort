# Task Plan: 完整终端快照恢复

- Created: 2026-09-10
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户确认“实施修复”：完整终端快照与对应游标。

<!-- task-doc-section:background-goal -->
## Background and goal

解决手机冷打开、重同步后 TUI 历史/输入框缺失。完整状态必须先于匹配游标之后的增量输出恢复，不能用扩大原始尾部或强制重绘冒充完整快照。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：Host 内存终端状态、原子快照/游标协议、服务转发、手机恢复、回归与调试包验证。不重启或停止现有用户 Host/Agent，不上传 TestFlight，不清理无关改动。旧 Host 缺失完整历史不能逆向重建；其降级策略须明确。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 异常发生在 xterm buffer，不只是绘制 | /tmp/agentport-render-gap-live.log：live、待写0、内部输入框行空白 |
| F-002 | 原始尾部不构成完整屏幕 | 手机相同47×53 xterm，144074字节完整流保留上下边框，仅65536字节丢失两者；/tmp/agentport-render-gap-proof.js |
| F-003 | Host 已有原子输出尾部和模式种子 | crates/agentport-host/src/main.rs OutputTail；server.rs 初始帧 |
| F-004 | 新协议不能热升级旧 Host 内存状态 | 现有进程未维护完整屏幕，tail仅4MiB；不得重启用户Session |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 已否定直接使用 vt100 0.16.2 的 state_formatted：保存光标、滚动区域、备用屏幕和CSI中间状态续接均不等价。
- 已否定直接使用 avt 0.18.0：组合字符 e + U+0301 导致光标偏移；其余本次基本用例通过。
- 选定方向：与手机相同的 xterm 5.5.0 headless 状态机，补充 SerializeAddon 未包含的保存光标、滚动区、tabs、字符集和解析器前缀。使用嵌入式 QuickJS，不依赖系统 Node。
- 产品边界：引擎64MiB内存、512KiB栈、初始化2s/每次操作1s中断上限；保留2000行scrollback，快照JSON上限512KiB（为1MiB Host帧留空间）。失败或不安全解析器前缀返回无快照并明确降级，不影响原始输出。OSC8链接身份不恢复；未覆盖全部VT扩展及长期内存压力。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 首次完整快照恢复历史、输入框、光标和必要模式，后续增量等同持续解析。
- 快照绑定 Session/run/generation/offset/geometry；并发输出无丢失/重复，分片ANSI与UTF-8不损坏。
- 明确旧Host能力降级，不把不完整尾部宣称为完整快照。
- 验证通过后提交任务改动；有未解决语义缺口则不宣称完成。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；按用户此前要求不使用子代理。
- Serialization constraints: 协议与消费者顺序修改，保持无关生成文件改动。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 验证快照状态机与续接语义

- Status: done
- Owner: coordinator
- Objective: 证明状态库快照足以恢复现有终端语义。
- Inputs and prerequisites: F-001、F-002；候选vt1000.16.2、avt0.18.0及同源xterm5.5.0。
- Scope or files: 临时原型；必要核心快照模块与测试。
- Expected output: 有通过/失败证据的选型和快照契约。
- Dependencies: None.
- Execution steps:
  1. 检查状态序列化与解析器分片边界。
  2. 对比连续解析、快照后增量续接的屏幕与模式。
- Acceptance criteria:
  - 宽字符、备用屏、保存光标、滚动区、ANSI/UTF-8分片得到验证或明确阻塞。
- Verification method:
  - 隔离原型和目标测试；不操作用户Session。
- Validation evidence: /tmp/agentport-screen-prototype/results.jsonl 记录两种Rust库不等价；same-engine-results.jsonl记录8项同源引擎PASS；split-results.jsonl记录206个逐字节切分全部PASS（包括UTF-8、CSI、OSC）；quickjs-result.log证明无Node运行，同源引擎与SerializeAddon初始化后QuickJS malloc约2.06MB，设置64MiB内存上限。尚非完整压力测试。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 原子快照协议与手机恢复

- Status: done
- Owner: coordinator
- Objective: 从Host生成绑定游标/尺寸的快照，手机先恢复后接增量。
- Inputs and prerequisites: T-001通过。
- Scope or files: crates/agentport-host、agentport-core/protocol、agentport-service、mobile/src/features/sessions 与 terminal。
- Expected output: 有能力协商和旧Host降级的完整链路。
- Dependencies: T-001.
- Execution steps:
  1. 状态与输出提交保持同一时序；尺寸变更纳入状态。
  2. 添加快照协议、转发和手机恢复屏障。
- Acceptance criteria:
  - 首次打开与游标失效不再用原始尾部冒充完整屏幕。
- Verification method:
  - 原子性、尺寸、分片、重连和旧Host回归。
- Validation evidence: 同源产品代码10项测试（含每字节切分）；Workspace快照/早到事件顺序、旧Bridge仅明确not_executed重试；Host真实PTY快照测试保留超过64KiB的输入框并断言ReplayDone和第一帧增量游标等于Hello HWM，warm resume同样优先快照，覆盖没有输出字节的跨客户端resize；未请求能力的旧客户端仍走连续回放。手机全部369测试通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 构建、隔离端到端验证与交付

- Status: done
- Owner: coordinator
- Objective: 验证真实Host/Bridge/手机完整恢复，保留用户Session。
- Inputs and prerequisites: T-002通过。
- Scope or files: 相关测试、调试包、本任务文档和任务提交。
- Expected output: 已验证调试包、诚实验收记录和Git提交。
- Dependencies: T-002.
- Execution steps:
  1. 跑目标测试与相关构建，保存生成文件原始改动。
  2. 仅用统一脚本重启GUI；仅对任务创建Session测试快照。
  3. 截图确认并提交任务文件。
- Acceptance criteria:
  - 实际冷开屏幕完整，已有用户Session不受影响。
- Verification method:
  - 目标测试、隔离Host流、真机截图、Git diff审查。
- Validation evidence: Core351通过/6忽略、Host29单元+36集成、Service33、Bridge16+1无监听器、mosh2、Mobile369及TypeScript检查；调试GUI/手机均构建安装，真机冷打开、进程冷启动后重新打开、约55s后台恢复均保留header/history/input上下边框、继续LIVE FRAME，buffer/DOM行差异0。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先语义原型门禁，再协议/并发/手机集成测试，最后构建与隔离端到端验收；不因类型检查通过就宣称终端语义正确。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

不同VT实现可能丢失xterm状态；完整实现若涉及不支持的协议/字体语义需要停止扩大变更并汇报。旧Host无完整状态，不可静默补全。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-10: 最终审查补足无输出字节的resize边界：有效日志游标不等于完整屏幕状态，显式请求快照时warm resume也优先原子快照；增加真实PTY resize/旧客户端对照断言。
- 2026-09-10: 继续T-002：使用嵌入QuickJS+同源xterm，明确Hello能力协商，快照在output_serial下绑定HWM；旧Host保留可见降级提示。

- 2026-09-10: 用户确认实施；开始T-001，下载vt100 0.16.2检查能力；尚未修改产品代码。
- 2026-09-10 02:09: T-001完成。原型位于/tmp/agentport-screen-prototype：Cargo生成候选快照，compare.cjs对照手机xterm；same-engine.cjs补充内部状态，splits.cjs验证206切分；src/bin/quickjs.rs验证嵌入执行。T-002待开始，下一步先将共享capture/restore与QuickJS封装形成可测试产品模块，再加Host输出/尺寸同序快照协议。不将原型当成已交付修复。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed within the documented compatibility/resource boundary.
- Evidence: 2026-09-10 02:48安装手机；最终GUI PID61569路径精确核验并截图非空白（`/tmp/agentport-snapshot-debug-final.png`）。隔离真实Shell Session `ses_01M23R5GC649VCH9`只绘制一次边框，随后输出超过128KiB差分刷新；手机首次打开、完全退出手机App后冷打开、约55s后台返回均保留画面。冷启动游标140824→后台返回148183，pending写入0，DOM/buffer差异0，无降级提示。
- Artifacts: `/tmp/agentport-snapshot-phone-cold.{log,png}`、`/tmp/agentport-snapshot-phone-relaunch.{log,png}`、`/tmp/agentport-snapshot-phone-foreground.{log,png}`、`/tmp/agentport-snapshot-debug.png`；`/tmp/agentport-snapshot-{native,host,bridge}-tests.log`、`/tmp/agentport-snapshot-mobile-all.log`。
- Final-build recheck: 补充warm resize边界后，Host集成再次36/36，Core/Host/Service再次通过；统一脚本重建并只重启GUI。新隔离Session `ses_01M23RP1R5XZ0QH9`在手机进程冷启动后再次保留全部标记、边框及实时帧，见`/tmp/agentport-snapshot-phone-final.{log,png}`。两个任务Session均已archive后delete；既有用户Host56930仍存活，未操作其Agent。生成iOS文件按构建前副本恢复。
- Compatibility: 旧Bridge拒绝新增参数时，仅明确not_executed才不带参数重试；旧Host无完整状态时保留原有有界回放并显示提示。现有Host/Agent没有重启，因此旧Session无法追溯获得已丢弃的完整画面。新建Session使用更新Host。
- Limits: 快照不是无限历史；OSC8链接身份不恢复；超资源上限/不安全中间前缀明确降级。没有宣称覆盖所有VT扩展或所有间歇渲染异常。未重新跑无关桌面前端全套或手机Rust全套（手机原生代码未变）；相关Bridge/Rust、前端以及实际iOS构建通过。
