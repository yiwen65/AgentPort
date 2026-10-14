# Task Plan: Mobile 性能审查与优化

- Created: 2026-10-14
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求全方位审查并优化 mobile/ 性能。

<!-- task-doc-section:background-goal -->
## Background and goal
覆盖启动资源、终端热路径、React/文件阅读、网络与原生资源生命周期；实施证据支持的最小优化，不将静态风险冒充真机瓶颈。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
范围为 mobile/ 与必要验证/任务记录。保持输出、协议、连接恢复和输入行为；不改发布配置、凭据或服务端，不混入已有 immersive-file-reading 文档改动。未测量的原生真机性能仅报告风险。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence
| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 前端 React 18、xterm 5.5、Vite 7，原生 Tauri Mobile/Rust | mobile/package.json、mobile/README.md |
| F-002 | 存在 Vitest 与原生测试入口 | mobile/package.json、mobile/README.md |
| F-003 | 用户有无关未提交任务文档 | 初始 git status --short |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- Assumption: 本机组件实验与生产资源构建可用于筛选，不能替代 iPhone/Android 真机延迟、电量验证。
- Open question: 无用户指定真机 workload/预算；采用现有测试场景和有界压力输入，明确证据层级。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- 各主要层级均有审查记录；仅实施有复现证据与行为保护的优化。
- 记录基线、对照、环境、验证限制；测试与前端构建通过。
- 必要原生/界面验证按改动范围执行；提交仅包含本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
- Dependency graph: T-001 -> T-004; T-002 -> T-004; T-003 -> T-004.
- Parallel batches: T-001、T-002、T-003 只读审查并行；T-004 串行测量、实施和集成。
- Serialization constraints: 所有项目写操作与文档归 coordinator，审查代理只读。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 终端热路径审查
- Status: done
- Owner: terminal-review
- Objective: 查明输出、解析、快照、输入与渲染的具体成本候选。
- Inputs and prerequisites: mobile/src/terminal 源码与测试。
- Scope or files: mobile/src/terminal、相关客户端。
- Expected output: 有行号、因果链与可执行测量建议的审查报告。
- Dependencies: None.
- Execution steps:
  1. 只读追踪输出、快照、生命周期。
- Acceptance criteria:
  - 区分静态事实与未测量风险。
- Verification method:
  - coordinator 核对相关源码与测试。
- Validation evidence: 三个只读报告已收回；coordinator 核对 MobileTerminal parser fence、SessionFiles refresh/sort、MarkdownImages queue、GenericTerminal 导入、原生 PTY actor/订阅 clone/下载循环/Mosh drain 源码。静态审查完成，不代表运行瓶颈已证明。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — React、文件与资源审查
- Status: done
- Owner: react-review
- Objective: 评估订阅重渲染、文件阅读和启动资源。
- Inputs and prerequisites: mobile/package.json 与前端源码。
- Scope or files: mobile/src/app、features、vite.config.ts。
- Expected output: 按证据排序的成本候选与复现建议。
- Dependencies: None.
- Execution steps:
  1. 只读追踪数据刷新、组件更新和依赖加载。
- Acceptance criteria:
  - 覆盖主要 React 与文件阅读路径。
- Verification method:
  - coordinator 核对源码。
- Validation evidence: 三个只读报告已收回；coordinator 核对 MobileTerminal parser fence、SessionFiles refresh/sort、MarkdownImages queue、GenericTerminal 导入、原生 PTY actor/订阅 clone/下载循环/Mosh drain 源码。静态审查完成，不代表运行瓶颈已证明。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 原生与传输审查
- Status: done
- Owner: native-review
- Objective: 检查传输、锁、缓存、I/O 和生命周期风险。
- Inputs and prerequisites: Rust 原生源码与构建配置。
- Scope or files: mobile/src-tauri、mobile/native。
- Expected output: 静态事实、风险边界与下一步测量。
- Dependencies: None.
- Execution steps:
  1. 只读审查，不执行原生目标。
- Acceptance criteria:
  - 不把代码气味当成测量瓶颈。
- Verification method:
  - coordinator 核对发现。
- Validation evidence: 三个只读报告已收回；coordinator 核对 MobileTerminal parser fence、SessionFiles refresh/sort、MarkdownImages queue、GenericTerminal 导入、原生 PTY actor/订阅 clone/下载循环/Mosh drain 源码。静态审查完成，不代表运行瓶颈已证明。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 测量、优化与验证交付
- Status: done
- Owner: coordinator
- Objective: 选择证据最强的可验证改动，完成对照与提交。
- Inputs and prerequisites: 三份审查报告与本机实验。
- Scope or files: 经审查确定的 mobile/ 文件与本任务文档。
- Expected output: 最小优化、回归保护、测量记录与 commit。
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. 构建/测试基线，设计有界实验。
  2. 测量候选并最小实施。
  3. 回归、资源/行为验证、diff 审查与提交。
- Acceptance criteria:
  - 有可重现收益证据，正确性测试通过，限制明确。
- Verification method:
  - Vitest、TypeScript/Vite 构建、针对性对照与可用界面检查。
- Validation evidence: 两项独立对照完成；58 files / 898 tests、生产构建、startup静态图gate通过（旧App注入反例被正确拒绝）；浏览器文件回归与临时DOM终端回归通过；iOS26.5模拟器构建/非空白启动、精确debug GUI重启/截图通过；独立只读审查无actionable findings，git diff --check通过。原始WebGL环境DOM脚本失败与真机/Android性能限制见下方。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan
先记录 revision、环境和测试/构建基线；临时测量产物置于 /tmp。按候选选择组件实验或资源依赖对照。前端全套测试与生产构建为基本门禁；原生未改动时不将无关长构建作为性能证明。界面检查区分 Web 预览与原生真机。

### 测量契约与结果（MEASURED）
- 基线 revision：`110480cf30495dc4344cbf3b47257c8249589c0f`；开始时只有用户已有 immersive-file-reading 任务文档修改。Mac17,3 / arm64 / 10 logical CPUs，Darwin 27.0.0，Node v24.15.0，Chrome 155.0.8059.40，Vite 7.3.6。未固定频率/热状态；不代表真实手机。
- 构建：两侧均 `npm run build`，相同 Safari13 target、esbuild minify，非 TAURI_ENV_DEBUG。基线 dist 复制至 `/tmp/agentport-mobile-perf-baseline`；本地 HTTP 18421/18422，禁用浏览器资源缓存，390×844，CDP CPU throttle=4。缓存禁用不保证 V8 编译缓存冷启动。
- 首页：排除预热的 3 次观察后，6 次/侧交错新文档导航。初始 JS **862669 -> 390463 bytes（-54.74%）**，gzip 构建报告 **251.59 -> 128.55 kB**；CSS **59925 -> 45206 bytes**。新 Rollup 静态闭包为 1 chunk / 106 modules，不含 xterm 和终端视图。移除通用终端 eager import 是依赖图变化的直接原因；没有调大 chunk warning 阈值或改变编译参数。
- 首页 h1 DOM 插入（不是首帧呈现/可交互时间）中位数 **43.10 -> 34.45 ms**。基线原始值 `[97.10,50.10,44.30,40.00,41.90,40.90]`；候选 `[177.60,31.80,32.00,31.50,38.50,36.90]`，所有异常值保留。噪声/首次运行影响明显，**不以该小样本宣称启动延迟确定降低**。资源字节与模块闭包收益确定。
- 首次通用终端打开：同样 CPU throttle、无网络限速、固定虚构断连主机/空列表的 Tauri 命令替身，3 次/侧交错导航。从真实 CDP 鼠标点击至空终端列表 DOM 出现：基线 `[19.5,13.5,18.1] ms`，候选 `[79.9,45.6,43.4] ms`。候选首次加载增加一个 462822-byte 共用 MobileTerminal chunk 和 8932-byte GenericTerminal chunk；返回主机页全部通过。代价是将成本移到首次使用，不是总 App 体积下降；不将 mock 本地结果泛化为 SSH attach 延迟。
- 图片组件：实际 `createImageAsset` 导出，用 esbuild 同配置分别打包前后版本；输入为 1/8 MiB 的 byte=137 合成 PNG MIME payload、1024×1024 元数据、base64 提前创建。仅测 **atob -> Uint8Array -> Blob -> object URL**，不包含网络、图片解码、SVG 清洗或整页呈现。每条路径预热、4 次独立页面导航，AB/BA 交错、每个 size/variant 12 个样本；计时前 collectGarbage，计时后验证 Blob byte roundtrip 并 revoke URL。

| 图片 payload | Chrome 4× CPU：基线中位数/范围 | 候选中位数/范围 | 归一化耗时 |
| --- | --- | --- | --- |
| 1 MiB | 116.70 ms / 115.5–120.2 | 25.40 ms / 23.7–30.4 | 116.70 -> 25.40 ms/MiB |
| 8 MiB | 1030.35 ms / 1014.2–1048.3 | 187.95 ms / 186.0–190.1 | 128.79 -> 23.49 ms/MiB |

- 8 MiB 组件耗时约 -81.8%，两侧范围不重叠。前后只改字节转换；Blob 输出逐字节一致。Chrome 的调用后 JSHeapUsedSize 增量中位数约 **67.37 -> 0.0053 MiB**（1 MiB 输入 **16.81 -> 0.0094 MiB**）；这是时点堆计数，不是峰值/RSS，不含原生 Blob/typed-array backing store。直接填充最终字节 buffer 减少字符串迭代中间列表，与耗时/堆变化一致（SUPPORTED INFERENCE）。
- Node 独立进程对照（2 次/variant/size、2 warmups + 6 samples/process、`--expose-gc`）：1 MiB 中位数 **31.30 -> 1.82 ms**；8 MiB **255.70 -> 9.51 ms**。8 MiB 调用后 heapUsed 中位数 **256.58 -> 14.41 MiB**，arrayBuffers 两侧均约 **32.03 MiB**。仅为跨环境机制佐证，不当作 WKWebView 成果。
- 原始产物：`/tmp/agentport-mobile-startup-{bench.py,samples.jsonl,interleaved.log}`、`/tmp/agentport-mobile-generic-open-{bench.py,samples.json}`、`/tmp/agentport-mobile-image-browser-{bench.py,samples.json}`、`/tmp/agentport-mobile-image-node-samples.jsonl`、`/tmp/agentport-image-bench.mjs`、`/tmp/agentport-image-assets-{baseline,candidate}.mjs`。这些是本机临时证据，不纳入仓库。
- 运行命令：`browser-use < /tmp/agentport-mobile-startup-bench.py`（PERF_VERSIONS 指定交错顺序）；`browser-use < /tmp/agentport-mobile-generic-open-bench.py`；`browser-use < /tmp/agentport-mobile-image-browser-bench.py`；`PERF_VARIANT=baseline|candidate node --expose-gc /tmp/agentport-image-bench.mjs 1048576|8388608`。性能 gate 使用确定的模块图/字节输出，不使用易波动的毫秒阈值。

### 全方向静态审查与保留项
下面均为 **STATIC FACT / CONDITIONAL RISK**，不是已测瓶颈；每项含触发条件、反证与下一步测量。原生仅静态审查，未改 Rust/C++/锁/FFI。

| 方向与位置 | 源码事实、触发与潜在代价 | 为什么不盲改 / 下一步区分测量 |
| --- | --- | --- |
| 终端解析与布局 `terminal/MobileTerminal.tsx:396` | 每次 onWriteParsed 同步 syncScrollArea；正常 buffer 持续增长时可能增加 layout。DEC2026 gate 只限制绘制。 | 同步是防 native scroll 将重建 buffer 拉回 row0 的正确性 fence；几何未变时成本可能很小。真机比较 grow-log/alternate-screen 的 parser、layout、paint 份额。 |
| 隐藏会话与输出 `app/App.tsx:28`、`sessions/SessionWorkspace.tsx:205` | 保留两个 live stage，隐藏 stage 仍 decode/parse；待写队列 512 KiB、一次在途 parser write、rAF 合并，snapshot cache 8 entries/8 MiB。 | 隐藏暂停会影响瞬时切换/游标一致性；idle stream 可能无明显成本。测一个 busy stream vs 第二个 hidden busy stream；不删除回放恢复保障。 |
| 输出 timer/诊断 `terminal/synchronizedOutput.ts:17`、`SessionWorkspace.tsx:236` | 每逻辑 DEC2026 redraw 有 watchdog/full refresh；seen debounce 500 ms；backlog shed 清零后传 bytes，诊断值为0。 | xterm 会合并实际绘制；诊断为0不能用于测量丢弃量。保持超时/atomicity，按固定 bytes 改变帧/逻辑 redraw 数计时；未来测 shed 前应修正计数。 |
| React/轮询 `sessions/SessionDashboard.tsx:253,470,501`、`useActiveSessionSnapshots.ts:60` | project 视图5s刷新同时读取 session/project/agents/preferences；global 每 host 开始/完成复制 Map，活动列表与 unread some 可重复工作。 | 元数据新鲜度是已有语义；请求已有 single-flight、abort/lifecycle guards。按 host/session/inbox 数扫描 RPC bytes、React commits，而不是 blanket memo/cache。 |
| 文件树 `files/SessionFiles.tsx:89,163` | 重新进入刷新所有已访问目录；每次可见 tree render 都复制/filter/sort entries。 | 小/有界树未必重要；只刷新 expanded 可能留下无声旧缓存。测目录数、在途请求与无关菜单更新成本，再决定 listing-identity memo 或 bounded refresh。 |
| Markdown/Mermaid `files/FileContent.tsx:37,68`、`mermaidRenderer.ts:39` | 100k highlighter cap 不限制 Markdown parse/DOM；Mermaid lazy、20k source/200 edges、全局串行 queue、disposed fences。 | queue 保证主题/安全全局配置一致；不删除清洗/并发约束。用真实服务最大 payload、大表格/多图测 preview long tasks；考虑 source fallback 需行为确认。 |
| 图片 I/O/cache `files/MarkdownImages.tsx:16,35`、`platform/tauriMarkdownImageClient.ts:13` | 单 document queue、visibility/consent gates、64 MiB Blob cache；local chunks 顺序读取再编码/校验，release 不取消已开始下载；缓存不代表 decoded raster 上界。 | 串行保护峰值与同源安全，当前不并行放大内存。以高 RTT 大图+导航离开+后续小图记录浪费/首图 latency、native RSS，再定义 cancellation。字节转换已单独优化。 |
| 适配器资源 `platform/tauriRemoteClient.ts:26,156` | inputResults 等最终事件；subscribe 成功后 listen 失败没有 rollback。 | native deadlines/断线事件是否完整释放未知；不可随意取消已提交 input/mutation。mock listen failure、native active subscriptions与挂起 batch 数是下一步资源实验；本次不扩大修复面。 |
| 原生 SSH 背压 `src-tauri/src/generic_terminal.rs:578` | 单 actor 在 output tx.send await 阻塞时不能继续处理输入；input64/output16 bounded。 | 队列界限保护内存，正常 poll可能很轻。保持顺序/字节不丢；慢/暂停 poll 时测 queue occupancy 与 input ack p95。 |
| 传输 fanout `src-tauri/src/remote.rs:753` | 每 event clone 全 subscriptions/topics，再筛 profile/topic；共享 writer 仅锁完整 frame write/flush。 | 少量订阅可能无意义；逐 event 克隆不等于网络 bottleneck。按 E events×N subscriptions 测 allocations/dispatch duration，候选仅匹配ID的快照。 |
| 下载 `src-tauri/src/file_download.rs:419` | 256 KiB stop-and-wait chunk RPC，decode/hash/write 后才下一个。RTT高时 sequential cycles 可限制带宽利用。 | integrity、offset、close/cancel 是协议约束；不管线化现有服务。测 RPC wait vs hash/write、并行 terminal latency；此数据不经过 JS。 |
| Mosh `src-tauri/src/generic_terminal.rs:687,768`、`mosh/mod.rs:411` | Rust generic wrappers 内部 base64 encode/decode roundtrip；byte-wise VecDeque drain；pipe/thread/queue有上界、退休 join 保留 native pointer。 | 交互小流量可能不重要；FFI 生命周期不可为速度破坏。实际大输出测 CPU/MiB、allocations/poll，再考虑共享 byte-oriented internal helper。 |
| 电量/后台/原生 I/O `ssh/mod.rs:163`、`mosh/mod.rs:487`、`lib.rs:42` | SSH keepalive5s、Mosh退休reaper10ms、diag同步磁盘；通用终端 idle JS poll40ms。 | 存活/恢复/日志是行为约束，未获得真机 energy trace。测 idle/active/background wakeups、电量与退休时长；不凭 timer 数改 keepalive。 |
| 构建/兼容/安全 | Safari13 target、Tauri debug与release minification不同；字体声明不证明六种字体在首页下载；PNG/JPEG/WebP/GIF/SVG已有 bytes/pixels/CSS/use-expansion bounds。 | 本次不改 ISA/LTO/平台最低版本，不削弱 sanitization、hash、public-IP/DNS约束。Android/iOS16设备、签名生产包和真实网络性能仍 UNKNOWN。 |

### 正确性与界面验证
- 基线 `npm test`：57 files / 892 tests；候选：58 files / **898 tests**。新增 Blob 全字节实际验证含长度1/2/3/256/65537，empty/malformed不得创建URL；现有SVG/MIME/尺寸、consent/cache/unmount tests保持通过。
- `npm run build`、`npm run test:startup` 通过；后者实际 Rollup 静态 import closure gate，非字符串搜索源码猜测。`scripts/check-version-sync.sh` 通过。
- `node mobile/scripts/test-session-files.mjs` 通过：生产App/xterm、Markdown/SVG/真实Blob解码、页面状态保留、download mock、touch/focus；原生传输/保存替身，非真机证明。
- `node mobile/scripts/test-terminal-touch.mjs` 原样运行失败：WebGL启用后 `.xterm-rows` 为null，脚本自己声明DOM regression却未禁用GPU。临时副本 `/tmp/agentport-mobile-perf-dom-touch.mjs` 只在fixture挂载前设 `WebGL2RenderingContext=undefined`，全部 redraw/scroll/selection/clipboard/keyboard/shortcuts assertions通过。未改该脚本或终端产品代码；与本次App/图片改动无依赖。此 renderer 选择教训已合并 LEARNS.md。
- 独立只读 adversarial review 未发现 actionable 回归；指出 Suspense loading/真实first-open需运行核对，随后生产资源mock首次打开与返回3次/侧通过。
- `npm run build:ios-simulator` 通过；安装、launch `com.agentport.mobile` PID69497，iOS26.5模拟器截图 `/tmp/agentport-mobile-perf-ios.png` 确認非空白首页。不是iOS16或真机性能证明。构建产生的 schema-only screen-rotation漂移已还原。
- 按仓库规则 `python3 scripts/restart-debug-app.py` 构建/固定签名/精确GUI重启通过；`ps` 核对 PID70312 为当前 checkout debug `.app/Contents/MacOS/agentport`。窗口11050截图 `/tmp/agentport-mobile-perf-debug.png` 正常渲染；未关闭release/Host/Connector。桌面窗口是交付规则，不作为mobile性能证据。


<!-- task-doc-section:risks-blockers -->
## Risks and blockers
没有指定真机负载、延迟预算或电量预算；不能宣称端到端真机加速。终端输入、回放与恢复时序高风险，不因静态猜测改协议。已有 dist 不作为当前源码构建证明。

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-10-14: 创建执行契约；确认用户授权优化，保留无关修改；开始三方向只读审查。
- 2026-10-14: 三份报告核对完成；基线 57 files / 892 tests 通过，生产构建通过。首次首页资源请求 862669 bytes JS；大图片实际 createImageAsset 组件 8 MiB 基线约 260 ms，选择启动依赖边界与字节转换两项实验，不改协议/隐藏会话策略。
- 2026-10-14: 实施lazy终端与直接字节buffer填充；首次测试30/30通过，新增test URL继承签名被tsc拒绝，改用所需方法的对象替身后构建通过（生产代码不受影响）。
- 2026-10-14: browser-use临时脚本局部变量round遮蔽宿主内置函数，改run_id后测量完成；首次通用终端背景鼠标事件未生效，focus emulation开启/恢复后全部打开返回对照通过。未前置用户Chrome或访问登录数据。
- 2026-10-14: 两侧资源/组件测量与tradeoff已记录；独立审查通过；原终端脚本renderer不匹配已通过临时DOM fixture区分，教训合并既有LEARNS条目。
- 2026-10-14: iOS模拟器构建/安装通过；无在运行实例使terminate返回found nothing，随后显式launch与截图通过。debug统一脚本构建签名与精确重启通过；恢复本次构建生成schema漂移，未碰用户任务文档。
- 2026-10-14: 最终startup gate、生产构建与898 tests通过；旧版本App的counterfactual构建触发预期startup gate拒绝。临时本地服务已停止、唯一任务浏览器tab关闭；模拟器与debug窗口保留打开。完成T-004，准备仅提交本任务文件。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: passed
- Evidence: T-001–T-004 均完成；范围、测量、测试与界面证据见正文。完成前文档validator与diff检查通过；只提交本任务文件。
- Limitations: 收益仅为确定的初始资源削减和本机图片转换组件收益。首页h1时间噪声较大、首次终端加载略增；真机WKWebView/Android、实际SSH/Mosh、背景电量/内存峰值、iOS16与生产签名包性能未测量。原样DOM专用触控脚本在WebGL启用环境不通过；临时DOM fixture通过，不宣称该原脚本通过。
