# Task Plan: 最近三天提交性能优化

- Created: 2026-09-10
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户授权对最近三天 commit 执行性能优化。

<!-- task-doc-section:background-goal -->
## Background and goal

检查最近 72 小时提交涉及的执行路径，测量新增开销，对有实证的候选进行最小优化。不把静态候选当运行时瓶颈，不为每个 commit 强行产生 diff。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

窗口固定为 2026-09-07 20:16 至 2026-09-10 20:16 +0800，基线 HEAD 5720974，共 67 个提交、247 个变化文件。完成提交历史级筛查与高频路径定向阅读，并非所有提交逐行审计或各平台全面测量。

直接串行执行，无子代理。不重启现有 Host/Agent、不修改用户数据、不改写历史 commit、不混入其他会话改动。只交付测量支持的数组复用优化；不调整协议、重连策略、并发上限或编译选项。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 窗口涉及原生 Rust、QuickJS 与浏览器 TypeScript | 固定时间窗口的 git log --numstat，留存 /tmp/agentport-perf/commits.txt |
| F-002 | 新增屏幕引擎同步处理每个 PTY 输出块，位于输出串行锁内 | 5893766；main.rs append_live_output -> OutputTail::append -> TerminalScreen::feed -> SnapshotEngine.feed |
| F-003 | 每个完整非 ASCII 字符/VT 序列原来重新创建前缀数组 | terminalCheckpoint.ts TerminalParserTail.advance；生成至 Host engine.js |
| F-004 | QuickJS 清零数组 length 不释放 backing capacity | rquickjs-sys 0.8.1 的 quickjs.c set_array_length fast_array 分支 |
| F-005 | 初始存在无关文档/iOS 生成文件修改 | 初始及最终 git status；未暂存这些路径 |

### 筛选结果

| 路径 / 相关提交 | 静态事实与处理决定 |
| --- | --- |
| Host 快照、warm checkpoint：5893766 / 7777735 | 新增每字节同步前缀解析；选作测量目标，交付有界短数组复用 |
| 活跃列表/前台恢复：e6fc505 / 68f61fa / 6a1e6b8 / 1f4ed8f / 81a7644 | 当前已有四组并发 Host 探测、预算和健康连接复用；没有实测证据支持继续调并发/超时，不动正确性防线 |
| 通知/语义事件：d117139 / c83a7a4 / a300419 / 5260dfc | follow_jsonl 在文件长度未变时返回，单次读取有上限；更换轮询/解析器缺少本轮归因证据，不实施 |
| 状态、移除、恢复与拖放：edfdc86 / b7f55e5 / 94732f1 等 | 主要涉及状态边界和生命周期；没有本轮可验证性能回归，不为“优化”削弱验证 |
| iOS 输入、滚动、恢复遮罩与模态：9183ad4 / 7730fd3 / 8381986 / 5720974 等 | 与输入顺序及屏幕恢复正确性紧耦合；未获得手机渲染性能测量，不宣称提速 |
| 图标、通知设置、发布/构建和文档提交 | 无证据指向当前主瓶颈，不做猜测性的资源压缩或配置改写 |
| Service 单 Session summary 先读取全列表 | 发现于定向阅读，但该全列表读取来自 2026-09-02，早于窗口；不扩展本轮范围 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 固定合成持续输出可验证 Host 吞吐和 CPU 成本，不代表普通稀疏交互、手机网络或视觉延迟。
- Open question: 用户未指定性能预算。采用重复独立进程、同构建级别、输出/状态相同及收益超过观测噪声作为交付依据。
- UNKNOWN: iPhone/JSC 性能、真实网络 P95/P99、长期功耗和其他 CPU 架构。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 候选有调用链和可复现实测；无证据候选不改。
- A/B 的完整字节、偏移和快照一致，parser 安全边界及资源上限不退化。
- 明确报告测量条件、机器成本、范围和未验证项。
- 验证通过后仅提交相关改动；现有 Host/Agent 不受影响。
- 调试 GUI 构建、签名、精确重开；截图验收单独记录，失败不得声称非白屏。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004。
- Parallel batches: 无；按上一阶段证据逐项推进。
- Serialization constraints: 共享工作区与构建产物，仅协调者执行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 筛选并测量候选

- Status: done
- Owner: coordinator
- Objective: 对窗口提交分类并找到可验证的新增高频成本。
- Inputs and prerequisites: git 历史、源代码、原生及 JS 性能适配指南。
- Scope or files: 上述窗口；临时测量在 /tmp/agentport-perf。
- Expected output: 候选排序、基线、固定工作负载。
- Dependencies: None.
- Execution steps:
  1. 筛查历史并沿 Host 输出调用链定位成本。
  2. 在实际 QuickJS 中运行 ASCII、ANSI、中文 4 MiB 流。
- Acceptance criteria:
  - 不把静态事实当作运行时结论。
- Verification method:
  - release 等价优化级别、相同输入、独立进程交错测量。
- Validation evidence: attribution.jsonl、ab.jsonl；中文前缀处理有可测成本。禁用前缀只作归因上限实验，未进入产品。索引循环实验变慢，拒绝；转义白名单改写结果不稳定，拒绝。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实施有界数组复用与真实 Host A/B

- Status: done
- Owner: coordinator
- Objective: 减少已证明的短命数组创建，不改变状态机。
- Inputs and prerequisites: T-001 的基线与正确性约束。
- Scope or files: mobile/src/terminal/terminalCheckpoint.ts、对应测试、生成的 Host engine.js。
- Expected output: 最小 diff、回归保护、可比测量。
- Dependencies: T-001
- Execution steps:
  1. 序列完成时复用长度不超过 256 的数组；长控制串及显式 reset 仍丢弃数组以释放容量。
  2. snapshot 继续复制；parser 状态、溢出/不安全前缀判定均不变。
  3. 对实际 Host 执行 7 对交错独立进程测量。
- Acceptance criteria:
  - 屏幕/字节正确、资源有界、收益大于噪声。
- Verification method:
  - 实际 PTY -> Host -> Unix socket 接收；完整输出、偏移与 snapshot SHA256 比对。
- Validation evidence: 最终 host-ab.jsonl 共 42 次；中文耗时中位数下降 7.80%、ANSI 3.73%，对应 CPU 下降 6.94% / 3.56%；每种输入所有快照哈希一致。纯 ASCII 不宣称收益。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 验证代码、构建并准备任务提交

- Status: done
- Owner: coordinator
- Objective: 审查范围与代码证据，构建可交付产物。
- Inputs and prerequisites: T-002 的最终候选。
- Scope or files: 三个优化/测试文件与本任务文档。
- Expected output: 通过验证的最小改动，独立任务提交。
- Dependencies: T-002
- Execution steps:
  1. 运行 Host/Mobile 回归、差分输入、生成资产一致性及 diff 检查。
  2. 统一脚本构建签名 debug App，仅关闭旧 GUI 并重开。
- Acceptance criteria:
  - 无其他会话改动；没有打断现有 Session。
- Verification method:
  - 下方测试命令与精确进程路径核验。
- Validation evidence: Host 34 单元 + 40 集成通过；Mobile 424 测试及 TypeScript 通过；100000 随机块、6363565 字节前后状态相同。最终 GUI PID 23707 的可执行路径精确匹配当前 checkout 调试包。截图另列 T-004。
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 调试窗口截图验收

- Status: blocked
- Owner: coordinator
- Objective: 确认新 GUI 非白屏。
- Inputs and prerequisites: 已构建签名并启动的调试 GUI。
- Scope or files: 当前 checkout 的 GUI；不触碰其他进程。
- Expected output: 实际窗口截图并目视确认。
- Dependencies: T-003
- Execution steps:
  1. 按 PID 激活窗口并截图。
- Acceptance criteria:
  - 取得实际非白屏截图。
- Verification method:
  - AppKit 激活 PID 23707，CGWindow 窗口 3005，screencapture -x -l 3005。
- Validation evidence: 激活/枚举成功，但两次最终候选构建后的截图均报 could not create image from window；未生成可检查图像。
- Blocker: 当前系统截图接口无法生成图像，原因未确认。
- Unblock condition: 截图环境恢复后，重新核验当前 GUI PID 并捕获该窗口；无需重启 Host/Agent。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

### 性能合约与复现

- macOS 26.5.1 (25F80)，Apple M5；rustc 1.98.0 (88d9e12ae 2026-08-18)。后台用户 Agent 保持运行；未固定频率/CPU 亲和性，噪声保留、不剔除样本。
- 实际 Host：`cargo build -p agentport-host --release`；仓库 profile opt-level=2、thin LTO、codegen-units=1、strip=true；基线/候选同构建类别。使用固定 rquickjs 0.8.1，无运行时/编译标志变更。
- 每种流约 4 MiB，80×40 几何，子进程 raw PTY 输出；客户端已完成 Hello 后创建 go 文件开始计时，到全部字节接收完成结束。随后另连 snapshot，验证 HWM 与数据长度，比较完整屏幕哈希。子进程读取 quit 文件后自行退出，仅失败时终止任务创建的 Host。
- 三种重复单元：ASCII 构建文本；ANSI `ESC[12;1H ESC[32m Working... ESC[0m ESC[K CRLF`；中文 `你好世界 session 更新状态与终端内容 ⚡\r\n`。发送单元为 16 KiB；OS 实际 PTY 分块由系统决定。
- 每种输入七对独立进程，奇数轮 A/B、偶数轮 B/A；顺序固定可复现，全部 42 样本保留。
- 机器成本为 Python `RUSAGE_CHILDREN` 的完整 fixture 子进程生命周期 user+system CPU 秒，包含初始化/结束，**不是**仅输出阶段 Host CPU。RSS 为该独立 fixture 的 maxrss。
- 临时基准：`python3 /tmp/agentport-perf/host_bench.py /tmp/agentport-perf/host-{baseline,candidate} {unicode,ansi,ascii}`（花括号表示逐项调用）。原始数据 `host-ab.jsonl`，初版未限制容量的探索数据另存 `host-ab-unbounded.jsonl`，不可混为最终结果。
- 最终 Host SHA256：baseline `445aef16c2e4195649eb1db408006b59645c9382156ed0721c2b03ede85f9618`；candidate `0ddf7f9402e9d2f94f198e3299985be42f3954e00207ebfd159b1b0ffdb759ee`。两者文件大小均 3592848 bytes。

### 最终实测（MEASURED）

| 4 MiB 流 | 基线耗时中位数 [min,max] 秒 | 候选耗时中位数 [min,max] 秒 | 中位耗时变化 | 生命周期 CPU 秒：基线 -> 候选 |
| --- | --- | --- | --- | --- |
| 中文/emoji 混合 | 2.1741 [2.1346,2.2373] | 2.0046 [1.9857,2.0784] | -7.80% | 2.4942 -> 2.3210 (-6.94%) |
| ANSI 高频刷新 | 3.5388 [3.5153,3.6039] | 3.4068 [3.3760,3.5344] | -3.73% | 3.6624 -> 3.5320 (-3.56%) |
| ASCII | 2.3576 [2.2743,2.4497] | 2.3126 [2.2506,2.4234] | 范围重叠，未确认收益 | 2.7281 -> 2.6707 |

中文机器成本约 0.624 -> 0.580 CPU 秒/MiB；ANSI 约 0.916 -> 0.883 CPU 秒/MiB。RSS 样本整体约 25–30 MB，范围重叠；不宣称降低内存。长串容量释放由专项数组身份回归测试验证；不保留此前无限制复用方案。没有改变 Host 64 MiB JS 内存上限、前缀 65536 字节上限和时间中断机制。

SUPPORTED INFERENCE：数组短命对象开销处于同步输出路径；单变量复用同时改善耗时和 CPU，完整链路验证支持其因果贡献。这不是证明所有慢操作都由前缀解析主导；xterm 实际解析仍占主要成本。

### 正确性与交付验证

- `cargo test -p agentport-host`：34 单元 + 40 实际 Host 集成通过。
- `cd mobile && npx tsc --noEmit && npx vitest run`：TypeScript 与 37 suites / 424 测试通过。
- `node /tmp/agentport-perf/differential.cjs`：固定种子 782347，100000 块随机字节 / 6363565 bytes，含定期 reset，前后 snapshot 判定逐块一致。
- `node scripts/build-terminal-snapshot.mjs --check` 与任务相关 `git diff --check`：通过。
- `python3 scripts/restart-debug-app.py`：最终版本构建、签名、仅重开精确 GUI 成功；日志 `/tmp/agentport-perf/restart-debug.log`。
- iPhone 本轮未重装；浏览器共享源码已更新，但没有声称 iOS 性能收益。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- T-004 截图未通过，其余代码/性能验证通过。
- 吞吐实验是本机饱和合成输出，不是手机端到端交互延迟，也未测网络/负载尾延迟和长期电量。
- 当前运行的 Host 二进制没有被替换/重启；原生收益适用于之后使用新二进制启动的 Host。
- /tmp 保留原始测量和实验脚本；不是持久产品文件。报告保留环境、输入定义、命令、哈希和汇总数据。
- 无新增 LEARNS：数组容量问题已在交付前修正并写入源注释/回归测试，不改其他会话正在修改的学习文档。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-10 20:16 +0800: 固定窗口、基线与用户改动，T-001 开始。
- 2026-09-10: T-001 完成，T-002 开始。移除前缀仅作归因实验；拒绝索引循环与无稳定证据的白名单改写。
- 2026-09-10: 初版真实 Host 中文约 8.7% 改善；审查发现 QuickJS 清零 length 会保留长数组容量，收紧到短前缀复用、长串释放，重新构建和全量 A/B。最终数据为上表 7.80%，不沿用初版数字。
- 2026-09-10: T-002 完成；T-003 完成测试、资产一致性、差分验证和最终 debug 构建。其他未提交改动保留。
- 2026-09-10: 新增 T-004；按 PID 激活成功，截图命令失败，标记 blocked，等待截图环境恢复。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 优化、性能对比、正确性测试和构建通过；T-001/T-002/T-003 done。T-004 因系统截图失败 blocked，不宣称窗口非白屏。
- Limitations: 本机 Host 持续输出的实测收益；无 iPhone/真实网络收益结论，不重启现有 Host/Agent。
