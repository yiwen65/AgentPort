# Task Plan: Relay 单图上传

- Created: 2026-09-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户明确要求添加 Relay 图片上传支持。

<!-- task-doc-section:background-goal -->
## Background and goal

Relay 连接复用原有系统单图选择和终端粘贴流程，上传后返回远端绝对路径，让支持图片的 Agent 生成原生标签，绝不自动 Enter。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅单张 PNG/JPEG，缓存到远端 ~/.cache/agentport。利用现有端到端加密 Relay 字节流和 Bridge，新增能力协商与有界二进制分块，不通过 JS/Base64 传图片。保留 SSH/SFTP 分支。不增加相机、压缩、多图、进度、后台任务、数据库或附件管理。无子代理。不重启现有 Host/Agent/Connector，不部署 TestFlight 或生产 Relay 服务。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Relay 已承载加密 Bridge 字节流 | crates/agentport-relay/src/net.rs，mobile/src-tauri/src/remote.rs |
| F-002 | Bridge 帧先读长度和原始字节，再解析 JSON | crates/agentport-remote-protocol/src/lib.rs::read_frame |
| F-003 | 当前选图命令拒绝 Relay | mobile/src-tauri/src/remote.rs::image_upload_connection |
| F-004 | 当前上传成功后的路径粘贴与目标隔离可复用 | mobile/src-tauri/src/sftp/image.rs，mobile/src/terminal/MobileTerminal.tsx |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 每个 Bridge 连接至多一个进行中上传、单文件最多 20 MiB；二进制块最多 64 KiB，逐块确认以限制排队并保留终端请求穿插能力。
- Assumption: 旧 Bridge 不声明新能力时明确提示升级，不发送未知二进制帧。
- Open question: 真机/远端部署验收可用性留待实现验证后确认，不以单元测试冒充真机端到端结果。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 原始 PNG/JPEG 字节完整上传，校验长度、连续偏移和摘要；只成功后返回绝对路径。
- 不接受客户端指定任意写入路径；独占创建、权限 0600；失败/取消/断线清理未完成文件。
- 沿用连接 generation 隔离，不向重连后的新连接重放上传。
- 图片上传不自动 Enter，不停止 Session；旧端可用性明确协商。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无，用户约束直接串行执行。
- Serialization constraints: 协议、Bridge、Mobile 串行；构建前备份生成文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Bridge 有界二进制图片接收

- Status: done
- Owner: coordinator
- Objective: 能力协商、固定缓存落盘与分块协议。
- Inputs and prerequisites: 现有 Bridge 帧和请求分发。
- Scope or files: crates/agentport-remote-protocol，crates/agentport-remote-bridge。
- Expected output: 可测试的接收状态机与回归测试。
- Dependencies: None.
- Execution steps:
  1. 新增能力、二进制块编码和上传请求。
  2. 落实限额、偏移/摘要验证、独占文件与清理。
- Acceptance criteria:
  - 二进制不经 Base64；失败不返回成功路径；旧协议不破坏。
- Verification method:
  - 协议和 Bridge 针对性测试。
- Validation evidence: 协议/Bridge 测试通过；真实 Relay+Connector+新 Bridge 隔离 fixture 上传 PNG/JPEG、逐块穿插 project.list、校验落盘字节一致，通过。边界扩展测试将在 T-003 汇总重跑。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Mobile Relay 选图上传接线

- Status: done
- Owner: coordinator
- Objective: 复用 Picker，使用捕获的当前 Relay 连接上传。
- Inputs and prerequisites: T-001。
- Scope or files: mobile/src-tauri/src/remote.rs，mobile/src-tauri/src/sftp/image.rs。
- Expected output: SSH/Relay 上传选择与相同返回契约。
- Dependencies: T-001.
- Execution steps:
  1. 捕获连接 generation 和能力；增加二进制请求发送。
  2. 上传、失败清理、超时退役仅匹配当前连接。
- Acceptance criteria:
  - 不持连接表锁等待 Picker/上传；路径仅投递原目标；SSH 不回归。
- Verification method:
  - 原生测试及本地加密 Relay fixture。
- Validation evidence: Mobile 原生 32 测试通过，包含实际发送器二进制分块/摘要/路径返回、旧端能力拒绝、旧连接不重放，以及原有真实 SSH/SFTP fixture；加密 Relay fixture 通过。
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — 集成构建与交付

- Status: blocked
- Owner: coordinator
- Objective: 验证支持范围并提交任务相关改动。
- Inputs and prerequisites: T-002。
- Scope or files: 任务代码与本文档。
- Expected output: 验证记录、调试构建及独立 commit。
- Dependencies: T-002.
- Execution steps:
  1. 验证真实传输字节及终端连接不受影响。
  2. 运行相关构建，保留无关生成文件，按统一脚本重开 GUI 并截图。
  3. 提交任务文件，披露未运行的真机验收。
- Acceptance criteria:
  - 不混入并发改动，不停止用户进程，不宣称未执行验证通过。
- Verification method:
  - 相关 Rust/前端测试、移动构建、截图和 diff 检查。
- Validation evidence: Mobile 原生 32 测试通过；相关前端 53 测试通过；协议 12、Bridge 17+1、Relay 25+1 测试通过（3 个 opt-in 忽略项中的真实 Bridge Relay 测试另行显式运行通过）。iOS arm64 archive 成功，17:12 安装 iPhone，17:14 启动成功；WebView 截图正常。Android arm64 原生编译成功，TypeScript/Vite 构建成功。统一脚本完成桌面 debug 构建、sidecar staging、签名和重开，PID 48374 精确路径及窗口 2550 非白屏截图确认。
- Blocker: Android APK 仍缺 Gradle kotlin-gradle-plugin-api:2.0.21 的离线缓存（此前在线 TLS 失败）；真机系统 Picker → Relay → Agent 的完整交互未执行。代码与隔离集成验证完成，提交不代表这些验收已通过。
- Unblock condition: 恢复 Gradle 依赖下载；使用非隐私 PNG/JPEG 在任务隔离 Session 中完成人工系统选图验收。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

成功 PNG/JPEG、无效头、超限、错偏移/长度/摘要、取消/断线清理、能力关闭、连接替换；已有 SSH fixture 和前端图片粘贴测试。集成优先任务隔离 Relay，不触碰用户会话。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

二进制与 JSON 共用帧需严格能力协商和长度验证；写帧中途超时必须关闭对应连接，不能留下半帧继续使用。新能力需要更新 Bridge，不以重启旧 Host/Connector 代替兼容策略。Android APK 上次受 Gradle TLS 阻塞。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-11: 确认现有加密字节流和独立 Bridge 分发；T-001 开始。
- 2026-09-11: T-001/T-002 完成核心测试；真实加密 Relay fixture 与 Mobile 32 原生测试通过。T-003 开始。
- 2026-09-11: 边界复验及 iOS/debug 构建安装通过；桌面/iPhone 均截图确认非白屏。Android 原生编译通过但 APK 依赖缺失；T-003 blocked，保留真机端到端验收缺口。未重启用户 Connector/Host/Agent，仅停止任务 fixture。
- 2026-09-11 17:18: 将连接变更提示统一为 host（不再误称 Relay 为 SSH）；32 原生测试重跑通过，iOS 重新构建、安装并启动成功。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 功能实现、真实加密 Relay 字节完整性与请求穿插、32 Mobile 原生/53 前端测试、协议/Bridge/Relay 测试、iOS arm64/Android arm64 原生构建、桌面签名构建及双端窗口截图均通过。日志：/tmp/agentport-relay-image-final-rust.log、/tmp/agentport-image-native-tests.log、/tmp/agentport-image-ios-build.log、/tmp/agentport-image-android-build.log、/tmp/agentport-relay-image-debug-build.log。截图：/tmp/agentport-relay-image-desktop.png、/tmp/agentport-relay-image-iphone.png。
- Limitations: T-003 的完整 APK 与人工真机选图验收未完成；不是生产 Relay 部署或 TestFlight 分发。其它远端需更新 Bridge；已有旧 Bridge 连接需要重新连接 Mobile，不能自动重放。旧 Agent 对路径的识别能力不由 Relay 上传代替。

## Wire contract and lifecycle

- 能力 `image.upload_v1` 仅显式请求时返回。旧端能力未启用，Mobile 在打开 Picker 前报需要更新 Bridge/重新连接。
- 外层仍为 u32 big-endian 长度帧。begin/finish/abort 使用现有 JSON request/result；chunk payload 为 `NUL | u32 JSON-header-length | JSON request header | raw bytes`，JSON header 最大 4096 字节，原始块最大 65536 字节；仅 image.chunk 接受二进制帧。
- begin 参数 size/extension，服务器生成 uploadId 与固定 home/.cache/agentport 路径，客户端无法指定输出目录/文件名。chunk 参数 uploadId/offset，结果确认新 offset；finish 必须长度和 SHA-256 匹配才返回绝对路径。
- 每连接一个活动上传，非幂等且不自动重放。每块释放写锁后等待结果，允许其它终端请求穿插。写入/超时失败退役仅原连接，避免半帧污染；generation/连接实例变化不继续发送到替换连接。
- abort、上传错误及 Bridge 连接退出通过 Drop 删除未完成文件。120 秒失效在下一次图片请求时清理；若客户端完全空闲不再发请求，文件保留至连接退出（每连接至多一个、总量受 20 MiB 上限约束），没有后台清理线程。已完成的缓存图按原需求保留。
