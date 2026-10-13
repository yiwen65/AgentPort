# Task Plan: 桌面与移动端 Markdown 图片渲染

- Created: 2026-10-13
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户已逐项确认图片需求，并明确要求「开始实施，完成交付」。

<!-- task-doc-section:background-goal -->
## Background and goal

桌面和 mobile 的 Markdown 预览支持项目内图片与按文档授权的外链图片，正文适应宽度，点击进入可缩放/拖动的大图，保持原阅读位置与安全边界。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

支持标准 Markdown 行内/引用式图片、PNG/JPEG/WebP/GIF/静态安全 SVG。相对文档目录解析；根内 ../ 合法，真实路径越界拒绝。mobile 根由服务端 Session cwd 确定；桌面绑定文档浏览根，无根独立文档以父目录为界。外链每篇文档点击一次后由阅读设备匿名访问公开 HTTPS，重定向也校验，不用 Cookie/凭据，不访问内网/localhost/file/data。20 MiB 与2000万像素双上限；按需加载，失败明确且可重试。缓存/授权仅当前阅读生命周期，树/预览/终端往返保持，不跨文件或 App 重启保证离线。图片包裹超链点击优先大图。不增加保存/分享、独立图片预览、HTML img、任意 HTML、登录/内网图片、持久缓存或 Mermaid 资产能力。保留现有未提交 Host/终端/旧任务文档改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 两端图片需求与边界已确认 | 本轮 structured input 与确认草案 |
| F-002 | mobile 当前 img 显示阻止说明，桌面 minimal renderer 不解析图片 | mobile/src/features/files/FileContent.tsx；src/src/markdown.tsx |
| F-003 | mobile 文件访问有固定根/NOFOLLOW，下载有分块/身份检查 | crates/agentport-service/src/session_files.rs、session_file_downloads.rs |
| F-004 | 两端 CSP 图片仅 self/data，需受控 Blob 而非开放 https | 两端 src-tauri/tauri.conf.json |
| F-005 | 阅读设备直接取外链需原生匿名 HTTP、DNS/重定向约束以免 CORS/凭据泄露 | 已确认需求；native reqwest 能实现受控获取 |
| F-006 | 工作区存在外部未提交 Host、MobileTerminal 与旧任务文档工作 | 初始 git status；本任务不暂存这些路径 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 现有 Session 下载 RPC 可用于受限本地图片流，但不启动或占用前端下载任务；桌面新增等价根内只读流。整文件传输通过分块避免16 MiB帧上限。
- Assumption: 原生先校验位图头尺寸/SVG XML与视口尺寸，前端再将 SVG 作为经过清洗的 Blob 图片显示，不插入为任意 HTML；验证后才能进入 img 解码。
- Open question: None. 新发现必要限制需先记录，不能扩大授权范围。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- AC-001: 两端标准行内/引用式本地图片可读，中文/空格/根内上级路径正常，越界及符号链接替换不能逃逸。
- AC-002: 外链未授权零请求；授权后仅阅读设备匿名 HTTPS，私有/保留地址、混合 DNS、非法重定向与凭据被拒绝。
- AC-003: 文件/解码尺寸双上限、实际类型验证、静态 SVG 无脚本/链接/外部子资源。
- AC-004: 正文不撑宽页面；大图缩放拖动可关闭，保留阅读状态；移动端触摸不触发切页。
- AC-005: 加载/失败/超限/重试/连接中断状态明确，阅读期复用，销毁时释放临时图像资源。
- AC-006: 相关测试、两端生产构建与平台包验证；按仓库入口打开更新后的桌面调试 GUI，iPhone 保留数据覆盖安装并确认启动。真机/平台未验证项必须如实列出。
- AC-007: 仅本任务文件提交，任务文档验证、diff check 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001/T-002/T-003/T-004 → T-005 → T-006.
- Parallel batches: 首批 native、service、desktop frontend 与 coordinator mobile frontend 按已定义接口独立实现；之后串行集成。
- Serialization constraints: native agent独占两端Cargo manifests/locks和注册入口；service agent独占service/protocol路由；desktop agent独占src/前端；coordinator独占mobile/src前端、CSP和本任务文档。所有 cargo/build/生成 dist/native archives 由coordinator串行执行；只读前端测试可另行进行。不得将 mobile GPL 代码导入桌面，不重新声明整仓许可。
- Interface: 两端 native `markdown_image_fetch {url}`、`markdown_image_validate {contentBase64}` 返回 `{mime,width,height,contentBase64}`，错误 `{code,message}`；20MiB/20MP。桌面RPC `document.images.open {rootPath,path}` → 既有下载 open shape；`document.images.chunk/finish/close` → 既有下载 shapes；open即检查20MiB。mobile现有session.files.download接口用于只读流。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 原生外链获取与图像校验
- Status: done
- Owner: native-images
- Objective: 两端匿名公开HTTPS/DNS固定/重定向防护与格式/尺寸校验。
- Inputs and prerequisites: 已确认需求和上列接口。
- Scope or files: 两端native新image模块、Cargo依赖/锁、命令注册。
- Expected output: 可测试的有界获取/验证命令。
- Dependencies: None.
- Execution steps:
  1. 实现安全DNS/地址、手动重定向、无代理/凭据/引用来源、20MiB流限制。
  2. 位图/SVG真实类型与尺寸校验，绑定确定返回结构；加入测试。
- Acceptance criteria:
  - AC-002/003；原生不接收任意认证头或不受限源路径。
- Verification method:
  - Rust定向单测与编译，由coordinator串行执行。
- Validation evidence: coordinator：cargo test -p agentport markdown_images --bin agentport 与 mobile manifest markdown_images --lib 各7/7通过；新增XML内建/数字实体回归与移动端WebPKI根配置已重新验证。PNG/JPEG/WebP/GIF手工头门限+分配限制、SVG节点/深度/声明保护；压缩体最终解码错误由有界img处理。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 桌面根内图片只读流
- Status: done
- Owner: image-service
- Objective: 桌面根内二进制图片流，复用固定普通文件句柄及安全路径校验。
- Inputs and prerequisites: 下载管理器、既有安全根目录原语及新RPC合同。
- Scope or files: service新images路由/module/tests；protocol注册与bridge allowlist。
- Expected output: desktop image open/chunk/finish/close接口与安全回归。
- Dependencies: None.
- Execution steps:
  1. 新open限制20MiB，固定根/文件，复用分块/finish/close。
  2. 根外、symlink替换、普通文件与生命周期回归。
- Acceptance criteria:
  - AC-001/003；不改变现有document.*或下载任务行为。
- Verification method:
  - service/protocol/bridge定向测试，由coordinator执行。
- Validation evidence: coordinator：service document_image 4/4、session_file 16/16、protocol全14/14、bridge全20/20通过；复核Images独立registry与open_bounded复用，默认Session1GiB未改变。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 桌面 Markdown 图片与查看器
- Status: done
- Owner: desktop-images
- Objective: 桌面图片语法、稳定文档根/设备上下文、每篇授权、缓存和大图查看。
- Inputs and prerequisites: 已定义RPC/native合同；现有Markdown/DocumentPanel/API/store。
- Scope or files: src/前端图片模块、markdown、DocumentPanel/API/store与测试/依赖。
- Expected output: 可交互的桌面完整路径。
- Dependencies: None.
- Execution steps:
  1. 接入行内/引用图片、受限loader/SVG清洗、状态与文档级授权。
  2. 独立缩放查看器与位置保持，增加回归。
- Acceptance criteria:
  - AC-001/004/005；不移动或导入mobile GPL组件。
- Verification method:
  - 桌面组件测试、tsc/build、真实浏览器检查。
- Validation evidence: coordinator复核差异并重跑desktop image/grammar/context/SVG4套29/29及tsc通过；子任务全desktop1020通过，CSS放大审查后加入声明/选择器/预计算写入预算及线性扫描，相关目标测试已通过；真实浏览器fixture通过，原生路径待T-005/006。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — mobile Markdown 图片与查看器
- Status: done
- Owner: coordinator
- Objective: mobile图片组件、安全分块读取/外链获取、每篇授权与触摸大图。
- Inputs and prerequisites: 同一返回接口和既有RemoteClient。
- Scope or files: mobile/src/features/files及协议/平台adapter、App接入、CSP与测试。
- Expected output: mobile完整路径且不影响文件下载或图表。
- Dependencies: None.
- Execution steps:
  1. 本地下载RPC只读流＋nativevalidate；外链nativefetch，SVG清洗后Blob。
  2. 稳定文档生命周期授权/缓存与modal手势保护；错误/重试及测试。
- Acceptance criteria:
  - AC-001至005；原文件阅读/下载与Mermaid限制不回退。
- Verification method:
  - mobile组件/adapter/浏览器测试和build。
- Validation evidence: coordinator：mobile全888通过，最后资源/适配器定向11/11及tsc通过；真实Chrome验证PNG/SVG、每篇授权、引用/包裹图、双指缩放、位置/焦点/Blob销毁；mobile SVG额外深度memo/静态样式线性处理保护已加入，T-005再做最终全量回归。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 集成、安全复核与包构建
- Status: done
- Owner: coordinator
- Objective: 审阅子任务产物、交叉回归、安全验证与两端构建。
- Inputs and prerequisites: 四项实现完成且可集成。
- Scope or files: 相关集成/test/CSP、任务文档。
- Expected output: 可交付签名包与验证记录。
- Dependencies: T-001, T-002, T-003, T-004.
- Execution steps:
  1. 检查differences并运行有意义的定向与系统验证。
  2. 独立安全复核，修复必要缺陷，串行前端/native构建。
- Acceptance criteria:
  - AC-001至005及包构建。
- Verification method:
  - 真实引擎/HTTP边界/路径测试、两端构建、差异检查。
- Validation evidence: coordinator串行service4+16、protocol14、bridge20、desktop/mobile native各7通过；全desktop126套1027、mobile57套888通过，最后目标26+12及两端浏览器回归通过（native transport为mock明确标注）。两端生产构建、签名iPhoneOS归档/IPA和Android arm64 APK构建通过。安全复核CSS工作放大已修复，SVG实体误拒/元数据分配保护与mode缓存回归已补齐。
- Blocker: None.
- Unblock condition: None.

### [ ] T-006 — 安装验收与提交交付
- Status: blocked
- Owner: coordinator
- Objective: 更新调试窗口与iPhone，验证可见行为，提交本任务产物。
- Inputs and prerequisites: T-005通过；现有合法签名/可用设备。
- Scope or files: 调试重启脚本、设备安装、证据及本任务提交。
- Expected output: 正确窗口/安装证明、真实验收边界、git提交。
- Dependencies: T-005.
- Execution steps:
  1. 统一重启脚本，ps核对路径与非空白截图。
  2. 保留数据覆盖安装iPhone并确认；可行时读取图片，不操作无关App。
  3. 验证任务文档/差异，只暂存本任务文件并提交。
- Acceptance criteria:
  - AC-006/007；不夸大未执行的平台/真机交互验收。
- Verification method:
  - 签名/package检查、devicectl安装/进程、准确窗口截图与交互、git。
- Validation evidence:统一脚本重建签名并打开精确debug GUI；ps路径完全匹配；原生WKWebView中demo本地PNG/SVG/引用图可见，大图100%→125%及关闭回到正文通过。真实Native外链返回blocked_address与198.18.* DNS观测一致。iPhone保留数据覆盖安装/启动成功，进程目录匹配本次安装，Device Hub正常非空白，但当前无已连接主机且控制状态受并发操作影响。Android APK构建通过，未实际安装验收。实现已提交ba46e8e，交付记录在最终执行日志。
- Blocker: macOS公共域名使用198.18.* fake-IP，不能证明正常公有DNS网络的原生外链成功；iPhone缺少已连接Session/独占操作窗口，完整图片页真机交互未验收。不改系统DNS、不放宽私有地址策略、不抢占并发控制。
- Unblock condition: 提供正常公有DNS的读取设备网络与已连接Session/独占手机操作时段，继续T-006原生外链/手机图片页验收。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先native/server/组件定向测试，再两端全前端/构建；按风险补真实浏览器素材、静态SVG、未授权零请求、越界/混合DNS/重定向/超限/大图手势用例。Rust构建与mobile前端dist/native嵌入严格串行。签名环境仅进程传入，不把设备标识/Team ID写Git。真实平台不可验证时保留partial状态及精确下一步。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

外链DNS重绑定、重定向与代理可能绕过私有地址禁令；固定公开解析地址并禁代理。SVG/位图须先验证后进入WebView，防解码尺寸炸弹与子资源请求。两端阅读上下文/缓存不能混文档/设备；blob及事件须释放。现有共享工作区有外部编辑，不覆盖或暂存。物理设备连接/锁屏与并发操作可能阻塞验收。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-13: 确认执行授权、检查既有renderer/安全文件/分块协议与工作区，记录并行文件所有权和稳定接口。T-001至004开始；计划不混入Host/MobileTerminal/旧任务文档改动。
- 2026-10-13: 接受四个实现与browser子任务产物前审阅差异/定向重跑；T-001至004 done，T-005开始。Native依赖已串行解析锁；快照状态保留外部Host、MobileTerminal、SessionWorkspace、diag/lib与旧文档工作，不混入。
- 2026-10-13: 独立安全审查发现desktop CSS声明×节点放大，加入预计算/去重/预算及线性扫描；mobile静态样式也收紧，use图memo深度回归补齐。修复quick-xml类型推断、合法内建/数字XML实体被误拒绝；Native7×2通过。
- 2026-10-13: 当前macOS DNS把公共图片域名映射为198.18.*保留地址，真实外链请求不能在此环境证明成功；拒绝策略不放宽、不改系统DNS。移动端rustls-native-certs走Unix PEM探测且不能保证iOS/Android根存在，改用公开WebPKI根，仍进行TLS验证。浏览器native adapters均为fixture，不能替代此项原生验证。
- 2026-10-13: 两端生产构建完成。最终全量desktop1027、mobile888及两端Chrome脚本通过；随后模式缓存回归和最后状态显示改进定向26+12通过。Task-005 done；T-006进入安装验收阶段。
- 2026-10-13: 统一debug脚本完成构建/签名/精确GUI重启；签名iPhoneOS归档/IPA验证，保留数据覆盖安装/启动及新安装目录进程均成功；Android arm64 APK构建通过。桌面原生demo的PNG/SVG/引用图显示，大图100%→125%→关闭复原经截图确认；外链真实请求按198.18 fake-IP阻止，最后错误说明改为可读message。
- 2026-10-13: iPhone当前无已连接主机且共享控制状态变化，图片页原生交互与正常公有DNS外链成功路径无法完成；T-006 in_progress→blocked，整体partial，不改变DNS/放宽策略/抢占操作。保留外部Host/终端/diag/生成schema；仅本任务相关文件提交，mobile lib.rs只暂存新模块/两个handler。
- 2026-10-13: 记录实际发生并修复的XML实体误拒绝教训；其他主体历史条目原样保留。
- 2026-10-13: 实现提交ba46e8e完成。暂存59个相关文件，mobile lib.rs只包含3行image模块/handler；LEARNS仅新SVG条目。索引禁止路径检查和task validator/diff check/version sync均通过；未暂存Host/终端/diag/旧文档/生成schema，工作区剩余差异为外部工作。T-006保留真实验收blocker，整体partial不改写为完全通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001至005完成并经coordinator复核/重跑；两端实现与安全回归、浏览器、原生单测及三类平台构建通过；desktop原生本地图像/大图操作和iPhone覆盖安装/启动已证明。
- Limitations: T-006剩余正常公有DNS原生外链、iPhone连接Session后图片页手势验收；Android未安装验证。源格式与头尺寸先门限，压缩体损坏可能由有界浏览器解码报错；不承诺所有SVG/CSS或总进程内存固定上限。现有外部Host/终端/diag/旧任务文档和无关生成schema不提交。
