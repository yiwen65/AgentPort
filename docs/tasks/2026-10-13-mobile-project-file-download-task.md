# Task Plan: 移动端项目文件下载与系统另存为

- Created: 2026-10-13
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户确认下载需求后要求编写开发计划并实施交付。

<!-- task-doc-section:background-goal -->
## Background and goal

从 Session 文件树或预览选择文件，将完整原始字节下载并由 iOS/Android 系统另存为选择位置与文件名，不中断 Session。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

单个普通文件不限类型，上限1 GiB；每次系统另存为，可选本机或云提供方；同名由系统重命名/确认替换，App不自动覆盖。前台下载，App内切回终端不中断，提供进度取消，中断从头重试。根限定与现有SSH/Relay共用连接；分块原生落临时文件、完整性核验后保存；失败/取消清理自有临时文件。不含多选、文件夹、打包、后台保障、断点续传、下载历史、本地管理器或自动打开文件。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 上述功能范围与默认行为已确认，并已授权实施 | 对话结构化下载需求确认及最新用户请求 |
| F-002 | 现有根限定读取只支持1MiB文本，不能用于完整任意字节下载 | crates/agentport-service/src/session_files.rs |
| F-003 | mobile RemoteConnections通过同一request机制承载SSH与Relay | mobile/src-tauri/src/remote.rs |
| F-004 | 已有移动原生插件注册示例，尚无系统文件另存为插件 | mobile/plugins/tauri-plugin-image-picker、mobile/src-tauri/src/lib.rs |
| F-005 | iOS目录权限和Android SAF由系统控制，不应伪造任意路径访问 | 本轮需求分析中Apple/Android官方文档验证 |
| F-006 | 开始时工作区干净，HEAD d1e419c | git status --short / git log |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Accepted assumptions: 需求草案默认行为均已确认，包括单任务、文件行更多操作与预览下载、完整性验证、安全根边界、失败清理、系统保存确认及云同步不承诺。
- Implementation decision: 新RPC session.files.download.open/chunk/finish/close，固定服务端文件句柄和会话根，256KiB分块；手机原生管理临时文件与单任务，前端不接收文件正文。
- Implementation decision: iOS使用UIDocumentPickerViewController导出副本；Android ACTION_CREATE_DOCUMENT +后台IO写ContentResolver流，失败尽力删除新目标。禁止JS传入任意本地源路径。
- Open question: 无产品决策阻塞；实际设备与Android工具链能力需检查，无法执行的验收将明确记为blocked。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 文件树更多菜单及预览支持下载，包括二进制；现有点击预览/横滑导航不回归。
- 原生内存与单帧体积按块有界，1GiB完整传输不截断；超限、缺失、越界、特殊文件、权限、文件变更和空间不足明确失败。
- 使用当前已认证连接，替换连接不重放旧下载，Token不能跨服务连接混用。
- 全App同时一个任务，切页不停止下载；提供总量/已传输/进度、取消与失败重试。
- 正确区分下载完成待保存、系统选择、写入保存、保存成功、失败/取消；只有系统/IO完成确认才报成功。取消清理临时内容；非保证云同步/后台运行。
- iOS及Android保存流程都实现并构建检查，可用平台执行原生保存验收；设备不可用不得宣称真机通过。
- 全部本任务相关测试、前端构建、可用平台检查通过，更新调试App并核对进程路径/非空白截图，提交仅本任务改动。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001、T-002、T-003按已固定协议并行；T-004依赖前三项；T-005依赖T-004和可用设备。
- Parallel batches: 后端传输、移动原生/保存插件、协调者前端交互；随后串行跨层回归构建与设备验收。
- Serialization constraints: 后端拥有crates/service/bridge/protocol及根Cargo.lock；原生拥有mobile/src-tauri及新file-export插件（不改gen）；协调者拥有mobile前端、文档。新增mobile Cargo.lock由原生独占；本计划仅协调者修改。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 主机根限定二进制分块读取

- Status: done
- Owner: download-backend
- Objective: 新增固定文件句柄、有界二进制下载RPC，服务端完整性/变更检测。
- Inputs and prerequisites: F-002，固定open/chunk/finish/close契约；open参数sessionId/path，返回downloadId/name/sizeBytes/chunkBytes；chunk参数downloadId/offset，返回offset/contentBase64/eof；finish返回sizeBytes/sha256；close释放句柄。
- Scope or files: crates/agentport-service、crates/agentport-remote-bridge、crates/agentport-remote-protocol、Cargo.lock。
- Expected output: 每服务实例的有界句柄/TTL、安全读取、桥接路由及测试。
- Dependencies: None.
- Execution steps:
  1. 复用已有NOFOLLOW根限定安全打开，创建1GiB读取句柄；严格顺序chunk与SHA-256、元数据检查、资源关闭。
  2. 更新路由/允许列表并测试边界、二进制/0字节、超限、变更、取消与隔离。
- Acceptance criteria:
  - 路径与token不逃逸、不跨实例，内存/句柄数有界，不将下载结果放进文本预览API。
- Verification method:
  - Cargo定向服务/桥接/协议tests。
- Validation evidence: 协调者重跑 cargo test -p agentport-service -p agentport-remote-bridge -p agentport-remote-protocol -- --test-threads=1，通过64+20+13单元及3集成测试；包含实际完整1GiB sparse文件4096个有界块及哈希比对、变更/越界/句柄/TTL等。已逐读下载模块与测试确认无整文件分配。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 手机原生下载任务与两平台另存为

- Status: done
- Owner: native-download
- Objective: 原生分块接收/校验/临时文件清理及iOS/Android系统保存。
- Inputs and prerequisites: 固定RPC契约；mobile commands start/poll/cancel/save/discard，JS仅传profileId/sessionId/path/jobId不传本地文件路径；状态downloading/ready/saving/saved/failed/cancelled。
- Scope or files: mobile/src-tauri、mobile/plugins/tauri-plugin-file-export，新插件配套权限/manifest/构建及原生测试。
- Expected output: 单任务管理器、generation固定请求、磁盘写与SHA校验、原生保存插件与错误DTO。
- Dependencies: None.
- Execution steps:
  1. 复用RemoteConnections，原生有界分块落盘，poll返回无正文的进度；提供取消/保存/清理。
  2. iOS系统导出副本与Android系统创建文件/流复制，实现明确结果、失败/取消清理与同名行为。
- Acceptance criteria:
  - 前端不载荷正文、单任务可取消、无任意本地路径注入、插件只有内部调用，系统完成才成功。
- Verification method:
  - 原生Rust单元/集成tests及可用Swift/Kotlin/iOS/Android构建门禁。
- Validation evidence: native子任务最后16下载测试/全mobileRust60项通过，协调者重跑。iOS模拟器签名构建及Android APK构建通过，Swift/Kotlin插件编译链接成功；最终启动隔离修复后平台重建在T-004中记录。独立审查修复保存目标残留与本地清理双失败警告覆盖；协调者发现初始化下载缓存失败会阻断整个App，已改为仅禁用下载并补4个实际权限/链接/启动测试。实际系统保存未以构建替代，在T-005验收。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 文件树下载入口与跨页任务状态

- Status: done
- Owner: coordinator
- Objective: 接入下载动作、进度、取消、保存、重试并跨页保持。
- Inputs and prerequisites: 固定mobile start/poll/cancel/save/discard命令DTO；新独立FileDownloadClient适配器。
- Scope or files: mobile/src/features/files、mobile/src/platform、mobile/src/app、mobile/src/i18n及mobile/SESSION_FILES.md。
- Expected output: App级任务状态、文件行菜单/预览下载、完整状态/错误/限制UI与测试。
- Dependencies: None.
- Execution steps:
  1. 实现平台适配器与任务provider，使隐藏文件页或Session切换不会取消/误绑定下载。
  2. 新增入口与中英状态，定向前端测试取消竞态/跨页状态/重复点击/保存结果。
- Acceptance criteria:
  - 不抢文件行预览与横滑，任务来源明确，禁止第二任务，非原生浏览器明确不支持不伪造保存。
- Verification method:
  - Vitest定向tests、TypeScript与Vite构建。
- Validation evidence: 完整mobile Vitest782项（后续新增取消状态测试后重跑）通过；TypeScript/Vite构建通过。test-session-files.mjs真实App/xterm触摸回归扩展下载菜单/跨页进度/保存状态测试，通过并截图；其下载与保存客户端为明确fixture，不当作原生IO证明。前端补迟到start取消失败保留jobId、discard失败保留旧任务、系统保存/残留/保存后清理警告等测试。
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 跨层审查、回归构建与提交

- Status: in_progress
- Owner: coordinator
- Objective: 接收审查并验证集成，独立提交任务。
- Inputs and prerequisites: T-001/T-002/T-003完成。
- Scope or files: 本任务diff、自动生成的mobile/src-tauri/gen/schemas新增插件manifest/schema、LEARNS.md相关条目、任务记录、调试构建产物。
- Expected output: 安全及字节完整性/1GiB回归、两平台构建结果、功能commit。
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. 独立审查、运行跨层测试/完整mobile测试与构建，验证大文件有界和失败行为。
  2. 统一脚本重启签名桌面调试App，核对精确GUI路径并截图；独立提交。
- Acceptance criteria:
  - 自动化通过，无未审查安全/正确性阻塞，证据不夸大，提交不混无关工作。
- Verification method:
  - Cargo/NPM、两平台构建、git diff --check、check-version-sync、task document validator及截图。
- Validation evidence: 主机64+20+13单元/3集成含完整1GiB传输，手机Rust60项通过；mobile最终全量784项/生产构建、真实Chrome文件树下载交互fixture回归通过。最终iOS模拟器签名归档、Android APK构建、安装启动和非空白截图通过；Desktop统一脚本重启签名包成功，ps精确GUI路径与截图确认。版本同步/diff检查通过。外部目标残留警告优先级回归加入并通过；最终iOS/Android顺序重建、安装启动及ios-delivery.png/android-delivery.png截图确认正常渲染。Git commit待创建。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 原生真实保存验收

- Status: blocked
- Owner: coordinator
- Objective: 在可用设备执行下载到自选目录端到端并核对字节。
- Inputs and prerequisites: T-004输出、可用iOS/Android设备与已授权主机。
- Scope or files: 原生UI/保存目录与临时测试文件；不更改用户密钥或系统安全设置。
- Expected output: 设备保存成功/取消/失败与同名的实际证据；不可用时记录阻塞条件。
- Dependencies: T-004.
- Execution steps:
  1. 检查设备和连接能力，验证文件树下载→系统选择→磁盘文件一致与切回终端。
- Acceptance criteria:
  - 不用fixture或浏览器截图替代原生实际保存结果，不伪造不可用设备覆盖。
- Verification method:
  - 原生交互、目标文件哈希/大小、截图。
- Validation evidence: iOS26.5模拟器、Android API29 emulator-5554已安装启动最终构建且正常渲染；devicectl物理手机 unavailable。iOS现有localhost:51222主机配置离线，lsof无监听且launchctl未找到调试SSH服务；Android显示Add and connect a host first，没有已授权主机。未新增测试凭据、重配主机或伪造保存结果。原生RPC字节/取消/保存状态自动化通过，但系统选择目录后的实际目标文件写入未完成。
- Blocker: 缺少可用设备上的已授权主机连接，无法从真实Session下载并启动系统另存为。
- Unblock condition: 用户提供可连接的已授权主机与设备，或明确允许配置隔离的本地调试连接；随后按本任务继续实际目录保存/同名/取消/目标哈希验证。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

服务测试：二进制、0字节、1GiB/超限、根越界和链接替换、源变更、错误offset、完成哈希、句柄释放及服务隔离。手机Rust测试：分块读写/错误数据/哈希/断线取消/磁盘错误/单任务/保存状态。前端测试：所有状态及入口、取消/重复点击/隐藏页/切换Session、原生不可用。运行构建并尝试实际iOS/Android保存，记录精确覆盖和限制。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 单帧与内存不能按1GiB分配，传输与目标保存可能需要额外磁盘空间，空间失败不交付残缺内容。
- 移动系统暂停前台App和云提供方写入行为不可统一保证；不承诺后台/同步/绝对原子性。
- Agent可并发修改文件；检测元数据或大小变化则失败，不把已下载片段作成功。
- 新RPC旧主机明确提示升级，不回退SFTP或无根限定接口。
- 两平台工具链/真机可用性需实际验证；存在缺口时final result只能partial/blocked。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-13: 检查干净工作区HEAD d1e419c、现有Service/RemoteConnections/插件示例，建立协议与文件所有权边界；T-001/T-002/T-003开始。
- 2026-10-13: 后端四RPC与原生五命令按固定契约实现。协调者重跑主机64+20+13单元/3集成含完整1GiB传输，通过，T-001 done。
- 2026-10-13: 独立只读审查发现外部目标残留警告可被临时清理失败覆盖，原生修复组合状态并测试；前端同步最终错误码。协调者额外发现下载缓存初始化异常可阻止整个App启动，改为下载独立failclosed、终端继续可用，原生16项/全60项通过，T-002 done。
- 2026-10-13: 前端全局provider、进度/取消/系统保存、文件更多菜单/二进制预览入口完成；全mobile782项、生产构建及真实Chrome/xterm回归通过，T-003 done。补充取消等待状态与原生错误警告，最终重跑记录于T-004。
- 2026-10-13: 初次Android构建错误core缺失，定位PATH优先选择Homebrew rustc而非已安装目标的rustup；仅本次命令前置~/.cargo/bin后APK成功，无安装/升级或修改全局工具链。iOS模拟器签名构建成功。最终代码变更后平台重建与运行验证开始，T-004 in_progress。
- 2026-10-13: 协调者完整手机Rust60/60、前端783/783通过，真实Chrome扩展下载fixture回归通过并审看进度/菜单/返回终端截图；原生Swift/Kotlin最终构建及安装启动通过。桌面脚本重启GUI PID47048，ps路径与debug-app-final.png确认，不停止Host/Connector。
- 2026-10-13: T-005转blocked：物理手机不可用、iOS本地SSH缺失、Android无配置主机。只完成两平台启动，不宣称真实目录保存。新增错误警告优先级测试，避免重试清理错误再次掩盖外部残留文件提示；最终回归/产物刷新后独立提交。
- 2026-10-13: LEARNS.md合并已存在的iOS工具链教训为mobile工具链并新增Android已验证证据；新增可复用下载缓存初始化隔离教训。构建自动schema仅新增file-export空权限manifest，无其他权限变化。
- 2026-10-13: 最终前端784/784、TypeScript/Vite、扩展Chrome回归通过。最终iOS与Android顺序构建成功，保留数据安装并启动，审看两平台最终截图为正常离线/无主机界面。桌面调试GUI路径已核验、窗口非空白。尚未具备系统另存为真实连接条件，最终结果保持partial。准备只提交本任务已验证文件。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001至T-003完成；T-004最终自动化/两平台构建和启动验证已通过，等待提交。T-005因实际连接缺失blocked。证据日志见执行记录；截图 /tmp/agentport-download-evidence/，含下载操作/进度/返回终端（fixture）及原生启动（不冒充保存验收）。
- Limitations: 未验证真实iOS/Android系统目标写入、云提供方、设备1GiB保存/空间不足、无障碍或Linux实机主机。1GiB在macOS服务实际分块传输验证；Swift/Kotlin均编译，手机Rust字节与状态测试通过，不代表所有提供方行为已验收。
