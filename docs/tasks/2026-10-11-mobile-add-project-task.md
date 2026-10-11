# Task Plan: Mobile 添加已有项目

- Created: 2026-10-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户确认 New Project 需求后授权「开始实施，完成功能交付」。

<!-- task-doc-section:background-goal -->
## Background and goal

手机可将已连接电脑的已有目录加入 AgentPort，浏览或输入路径，成功后回到列表定位、展开项目，不自动启动 Agent。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅项目视图及项目空状态提供入口，绑定当前电脑；浏览从远程服务账户 Home 开始，允许该账户可访问的其他目录，不提权。显示名可选，支持普通非 Git 目录、符号链接去重、旧端手动路径降级、离线禁提交及未知结果核对。目录只读浏览、隐藏目录切换、上级导航。
不创建目录、不克隆 Git、不自动启动 Session、不改版本、不发布、不改变现有 Session/Host 生命周期。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户已确认上述功能范围并授权实现 | 当前会话需求确认和后续实施指令 |
| F-002 | 服务已有 project.add，并返回 project/focusedExisting；normalize_abs 要求目录存在并解析符号链接 | crates/agentport-service/src/lib.rs add_project；crates/agentport-core/src/paths.rs normalize_abs |
| F-003 | project.add 是不可自动重试写；移动能力清单尚不含添加和浏览 | crates/agentport-remote-protocol/src/lib.rs classify_method/MOBILE_V2_METHOD_ALLOWLIST |
| F-004 | 项目视图绑定 selectedDeviceId，活动视图为多设备；已有 Modal、远程请求及中文/英文 i18n | mobile/src/features/sessions/SessionDashboard.tsx；mobile/src/components/Modal.tsx；mobile/src/i18n/resources.ts |
| F-005 | projects.root_path 有 UNIQUE，服务共享电脑现有项目库 | crates/agentport-core/src/db/mod.rs schema；crates/agentport-service/src/lib.rs |
| F-006 | 工作区初始干净；本机有 booted iPhone 17 Pro / iOS 26.5 simulator | git status --short；xcrun simctl list devices booted |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 无需新增原生移动接口；沿用 RemoteClient.request 和现有 SSH/Relay 路由，需通过协议和 UI 集成检查验证。
- Assumption: 浏览支持超大目录的有界结果并明确提示截断，手动路径作为定位补充，不增加文件管理器功能。
- Open question: 无产品范围问题；真机和最低 OS 可用性由运行环境决定，不能以 Web 测试替代。
- 并行实现接口契约：project.directory.list({path?: string, showHidden?: boolean}) -> {path, homePath, parentPath: string|null, entries: [{name,path}], truncated: boolean}；省略 path 从服务账户 Home 开始，只返回可跟随的目录。project.directory.resolve({path: string}) -> {path: string}，返回真实绝对目录，供手动路径验证和未知结果核对，不列举文件。两者均 read。project.add({path,name?: string|null}) -> {project: ProjectSummary, focusedExisting: boolean} 保持现有形状。目录错误码 path_not_found / not_directory / permission_denied / invalid_path / directory_read_failed，添加相同前置校验失败为 not_executed。旧端 unknown_method/capability_disabled 触发降级，不把权限或网络故障当成不支持。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 浏览和手动绝对路径均可添加已有普通目录；显示名可选；取消提交前不写数据。
- 真实路径和符号链接去重，重复项目聚焦原项目且不改名；桌面共享 DB 可见。
- 项目视图及空状态提供入口，活动视图无入口；不自动启动 Agent；多设备切换及迟到响应不串目标。
- 离线禁提交，错误保留输入，提交防连点；未知结果持久保留并核对，不盲目重复写。
- 浏览旧端降级；添加不支持提示升级；成功后刷新失败与添加失败区分。
- 新增服务/协议、UI 状态回归测试通过；mobile 构建通过；小屏、键盘尺寸、明暗主题渲染可验证。
- 精确重启当前 checkout Debug App，ps 核对 GUI executable 并截屏确认非白屏；本任务相关改动创建 Git commit。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: 原功能T-001/T-002/T-003/T-006/T-007→T-004已完成。continuation解除原T-005阻塞：T-009生命周期修复→T-008构建入口最终验证；T-005模拟器完成后→用户授权T-010真机；T-008/T-009/T-010→T-011最终提交。所有实际sim/device构建串行，只有纯fixture/read-only工作并行。
- Parallel batches: 后端 agent mobile-project-backend 独占 crates 协议/服务/bridge；前端 agent mobile-project-dialog 独占 mobile/src/features/projects 与 mobile/src/i18n/resources.ts；coordinator 独占 Dashboard 集成及专属测试，不写上述独占文件，直至移交。完整 T-003 验证等待 T-001/T-002 产物可用。
- Serialization constraints: authority 文档仅 coordinator 写；review 阶段使用仅 read 工具隔离审查；构建与 App 重启串行，防资源竞争及 shared 输出冲突。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 远程目录与项目前置校验

- Status: done
- Owner: mobile-project-backend
- Objective: 支持安全只读远程目录浏览/解析，明确路径错误及能力，保留不可自动重试添加语义。
- Inputs and prerequisites: 已确认需求及文档中的接口契约。
- Scope or files: crates/agentport-remote-protocol/src/lib.rs；crates/agentport-service/src/lib.rs；crates/agentport-remote-bridge/src/lib.rs；必要的新服务目录 helper/test。
- Expected output: 新方法、read 注册、移动清单、目录/添加前置错误映射及回归测试。
- Dependencies: None.
- Execution steps:
  1. 检查服务、registry 和 Bridge 错误形状。
  2. 实现目录浏览/解析、Home/父级/隐藏目录/符号链接、有界列表及路径错误。
  3. 验证重复及并发添加不会产生不同目录记录；运行目标 Rust 测试。
- Acceptance criteria:
  - 非 Git 目录、symlink、空/隐藏目录、无效/不存在/文件路径、服务账户权限符合契约；纯浏览不写磁盘。
- Verification method:
  - cargo test -p agentport-remote-protocol -p agentport-service -p agentport-remote-bridge。
- Validation evidence: 子任务全量 Rust 81/81 通过；coordinator 检查目录 helper、add_project 和 Bridge diff，并独立重跑 cargo test -p agentport-remote-bridge --test project_directory（真实二进制 2/2）、cargo test -p agentport-service project_tests（6/6）、cargo test -p agentport-remote-protocol（13/13），均通过。真实 UID 501 的 mode-000 权限测试通过。目录条目保留词法 alias，避免 symlink 和真实目录 UI key 重复；git diff --check 通过。Windows 分支未运行。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 移动添加项目面板

- Status: done
- Owner: mobile-project-dialog
- Objective: 用现有 Modal 和 RemoteClient 实现完整添加流程，含旧端降级、未知结果安全恢复。
- Inputs and prerequisites: 已确认需求及文档中的接口契约。
- Scope or files: mobile/src/features/projects/；mobile/src/i18n/resources.ts。
- Expected output: AddProjectDialog、独立 CSS/测试及中英翻译；导出集成回调契约。
- Dependencies: None.
- Execution steps:
  1. 默认浏览 Home，支持目录/上级/隐藏开关、手动路径、可选名称。
  2. 实现离线、pending/result_unknown、old host、前置错误和保留输入。
  3. 未知写状态按 host 持久化，支持关闭重开后核对；运行目标 Vitest。
- Acceptance criteria:
  - 防重复，明确绑定电脑；取消前无写；超时不盲重试；实际提交成功和列表刷新由独立回调区分。
- Verification method:
  - cd mobile && npm test -- src/features/projects。
- Validation evidence: 子任务 2 文件 50 测试通过；coordinator 检查面板、host-specific journal、状态回归测试与 CSS，独立运行全部 mobile npm test（44 文件 562/562）和 npm run build（TS + Vite）通过。Chrome + 实际 Bridge 隔离 DB smoke 实测浏览/手动路径/隐藏/上级/普通目录/符号链接去重/缺失目录/离线和明暗小屏渲染通过。面板未知、关闭重开、StrictMode、迟到响应、刷新失败与存储失败由 Vitest 覆盖；真机行为未验证。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Dashboard 集成与完整验证

- Status: done
- Owner: coordinator
- Objective: 接入项目入口/空状态及定位展开，保留既有 dashboard/活动视图行为，检查跨设备异步边界。
- Inputs and prerequisites: 文档已锁定的 UI/远程接口契约；完整验证时检查 T-001/T-002 产物。
- Scope or files: mobile/src/features/sessions/SessionDashboard.tsx；mobile/src/features/sessions/SessionDashboard*.test.tsx；必要的协议契约测试。
- Expected output: 项目视图/空状态入口及添加成功列表集成，单元/集成/构建和独立审查证据。
- Dependencies: T-006.
- Execution steps:
  1. 增加绑定 host 的入口和 Modal；成功 merge 项目、展开并滚动定位，独立处理刷新失败。
  2. 检查子任务 diff，执行 UI/协议集成回归和全部 mobile tests/build。
  3. 独立 adversarial review，修复实证问题后复验。
- Acceptance criteria:
  - 首版完整流程及需求状态可观察；既有 Session/全局活动测试无回归。
- Verification method:
  - mobile npm test/npm run build；Rust 目标测试；git diff --check；scripts/check-version-sync.sh；只读独立审查。
- Validation evidence: 最终 npm test 44 文件 572/572，npm run build TS/Vite 通过；Dashboard 专属 8 个集成回归覆盖空状态元数据就绪、目标隔离、确认 merge/展开/定位、重复及刷新失败。Rust 目标 81 测试与 coordinator 独立 21 目标复验通过；mobile native remote::tests 9/9 通过。隔离 read-only 审查两问题由 T-006 先红后绿修复，连续 delta 审查确认已解决且无新 actionable finding。最终真实 Chrome + 新建隔离 Bridge DB smoke 通过，runtime exceptions 0。diff 和版本同步通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 渲染、调试交付与提交

- Status: done
- Owner: coordinator
- Objective: 更新调试 App 并观察实际渲染，记录平台/网络验证边界，仅提交本任务文件。
- Inputs and prerequisites: T-003 验证通过。
- Scope or files: docs/tasks/2026-10-11-mobile-add-project-task.md；调试构建产物；本任务 Git commit。
- Expected output: 小屏/主题截图和调试 GUI 进程/截图证据、明确未验证项、任务 commit。
- Dependencies: T-001, T-002, T-003, T-007.
- Execution steps:
  1. 运行真实浏览器 mobile 组件渲染和流程 smoke；尽可能验证本机 Bridge 的真实目录/项目调用。
  2. python3 scripts/restart-debug-app.py；ps 核对精确可执行路径并截图确认非白屏，不影响 Host/Connector/release。
  3. 审核 diff/status，校验 task 文档，创建任务相关 commit。
- Acceptance criteria:
  - 提供真实渲染证据和可打开的更新调试窗口；提交只包含本任务；未运行的平台检查诚实列出。
- Verification method:
  - 浏览器 smoke/截图；统一 debug restart；ps executable/codesign；git show --stat/status；task 文档 validator。
- Validation evidence: 最终实际 Chrome + 实际 Bridge 隔离 DB smoke passed（13检查，异常0）；读取明暗320 CSS px、390 CSS px 添加结果及430px短视口截图，滚动后提交控件可操作。python3 scripts/restart-debug-app.py 成功重建、固定证书签名并仅关闭旧 GUI12288、打开新 GUI9804；ps两次确认 exact executable=/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport；codesign --verify --deep --strict 通过。激活精确PID并读取CGWindow10745，screencapture PNG显示正常sidebar及workspace，非白屏。证据 /tmp/agentport-mobile-add-project-smoke/。临时Vite、Chrome、隔离Bridge已停止，harness已移至/tmp；host cargo test生成的非本任务ACL变更（移除mobile插件项）经差异检查恢复。版本/diff检查通过。最后重建的新GUI34687、窗口10754与debug-app-final.png再次确认；功能commit fdcdc2b已创建，git show确认仅18个本任务文件，提交后工作区干净。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 更新 iOS 模拟器调试窗口（附加平台验证）

- Status: done
- Owner: coordinator
- Objective: 将移动端新功能嵌入原生调试包并在本机已有 iOS 模拟器打开，确认非空白渲染。
- Inputs and prerequisites: T-001/T-002 经 coordinator 检查且 mobile tests/build 通过；本机 booted iPhone 17 Pro / iOS 26.5。
- Scope or files: mobile 构建产物；已有 simulator App（保留数据，不卸载）；截图放 /tmp。
- Expected output: 更新后的 simulator App 构建/安装/启动证据及非空白截图。
- Dependencies: T-001, T-002.
- Execution steps:
  1. npm run build:ios-simulator 构建现有本地签名调试包。
  2. xcrun simctl install/launch 更新并打开现有 booted simulator，不卸载数据。
  3. simctl 截图并读取确认渲染；检查构建是否修改 tracked 文件。
- Acceptance criteria:
  - iOS 模拟器运行更新后的 UI，入口或离线禁用状态可见；明确不代替真机/最低 iOS/Android 验收。
- Verification method:
  - iOS simulator build、simctl install/launch、simctl io screenshot、read 图片及 git status。
- Validation evidence: continuation中同一npm入口成功，以真实iphonesimulator27.0 SDK签名archive，Bundle ID不变、MinimumOSVersion16.0、完整Scene manifest。simctl install保留数据后launch PID32234持续存活且截图正常Active视图。为展示新入口，在无Simulator GUI可用情况下仅将当前workspace.layout偏好seed为projects（备份原值，不改主机/凭据/其他键），重启PID64135持续存活；mobile-simulator-projects.png显示新添加项目图标及明确offline状态。无dev server，当前新App实际渲染，未宣称触控/Keychain存取/SSH业务已跑。证据/tmp/agentport-ios-sdk-unblock/；未下载runtime或修改SDK/缓存。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 修复独立审查发现的取消与恢复竞态

- Status: done
- Owner: mobile-project-dialog
- Objective: 关闭动画开始即阻止尚未提交的写；刷新失败跨断线重连仍有可执行的只读恢复动作。
- Inputs and prerequisites: 隔离只读 review 的两个具体因果发现，T-002 产物。
- Scope or files: mobile/src/features/projects/AddProjectDialog.tsx 与 tests；mobile/src/components/Modal.tsx 与必要 tests；LEARNS.md 仅记录已复验的两项可复用教训。
- Expected output: 先失败后通过的两个回归，以及局部修复，现有 Modal 消费者行为不变。
- Dependencies: T-002.
- Execution steps:
  1. 复现 Header ×/Escape/backdrop 动画 130ms 内 validation 返回后意外 project.add。
  2. 复现 add 成功、onAdded 失败、断线重连后 delivered guard 丢失 refreshFailed 恢复按钮。
  3. 最小修复并运行面板/Modal 测试；coordinator 复验全套和真实 browser smoke。
- Acceptance criteria:
  - 提交前所有关闭路径立即阻止 write；已提交的写仍保留迟到 receipt。
  - 重连/核对可恢复已确认添加的列表刷新，project.add 总数始终一，回调单飞。
- Verification method:
  - 先运行新增回归观察失败，再修复并运行 npm test -- src/features/projects src/components/Modal.test.tsx；全 mobile tests/build。
- Validation evidence: coordinator 读取 baseline log 确认 focused 4 失败（动画三路径各出现1次本不该发送的 project.add，重连 onAdded 1而不是2）。修复后同样 4 测试通过，面板/Modal 64/64；coordinator 保留原非动画 Modal exiting 分支并复跑全 mobile 572/572 与 build 通过。原隔离 reviewer 连续只读 delta 检查两条因果修复均成立；真实 browser/Bridge 新 fixture 再通过。LEARNS.md 追加两项已验证教训，无环境失败猜测。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 核对并保护默认名的 Core 约束

- Status: done
- Owner: coordinator
- Objective: 核对桌面/Core默认名约束，保留一致前置拒绝，并保护长目录名使用短自定义名称的可恢复路径。
- Inputs and prerequisites: 初始误判服务限制偏离桌面；最小实验表明去掉服务限制仍被Db::add_project的1-80字符校验拒绝（crates/agentport-core/src/db/mod.rs:1179），排除放宽默认名分支。
- Scope or files: crates/agentport-service/src/lib.rs 和 project_tests.rs；LEARNS.md；本任务文档。
- Expected output: 保留正确前置校验的解释、长basename拒绝且无写后可用短名成功的契约测试；不修改Core约束。
- Dependencies: T-001.
- Execution steps:
  1. 诊断81字符basename：原服务InvalidRequest；去掉guard后仍Core Validation(1-80)，检查Db源码证明初始假设错误。
  2. 恢复正确前置guard，新增overlong_directory_basename_requires_a_short_explicit_name_before_writing保护既有约束与恢复路径。
  3. 复验全后端套件并再统一重建Debug App、核对进程截图。
- Acceptance criteria:
  - 默认名同Core限制，过长在写前not_executed拒绝，不进unknown锁死；可输入短名称添加；原上限/去重测试通过。
- Verification method:
  - 最小诊断两次失败和Db源码证据；新增Core约束测试及全后端套件；debug restart/截图。
- Validation evidence: 两个诊断依次返回InvalidRequest和Core Validation，Db源码证明既有1-80约束。恢复guard后新增overlong_directory_basename_requires_a_short_explicit_name_before_writing通过：默认过长无写，短显式名成功。完整后端cargo test ... -- --test-threads=1共82/82通过；初次parallel有未修改noisy_attachment测试的try_recv竞态单次失败，源码显示未等待noisy dispatcher就绪，孤立复验3/3和全串行18 Bridge/48 service/13 protocol/3 integration通过，没有修改这个既有测试。最终统一debug重建成功，新GUI34687精确路径和strict签名核验通过；窗口10754的debug-app-final.png已读取确认非白屏。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 修复 SDK/runtime 混淆导致的模拟器构建阻塞

- Status: done
- Owner: coordinator
- Objective: 保持真实 SDK、签名、production/custom-protocol 前端及最低 iOS16，不伪造元数据，通过有效的 Xcode generic simulator 构建路径绕开上游错误的 runtime-version gate。
- Inputs and prerequisites: 用户授权「解决阻塞并继续」；工作区570af5a干净；安装CLI2.11.4的二进制字符串确认cargo-mobile2=0.22.4；精确版本公共源码validate_sdk将available runtime.version与SDKSettings.Version比较，本机runtime26.5 < SDK27.0。
- Scope or files: mobile/scripts/build-ios-simulator.sh；必要Python/Node构建helper与tests；mobile/BUILDING.md；本任务文档；验证后LEARNS.md。不修改XcodeSDK/registry/node_modules缓存，不安装额外大型runtime、不跳过签名、不改Bundle ID/Team/最低版本。
- Expected output: 有回归门禁的可重用模拟器构建入口，原始构建命令通过；保留最后有效bundle，正确清理自建构建进程。
- Dependencies: T-009.
- Execution steps:
  1. 刷新原始失败baseline，精确版本source/实际runtime与SDK校验定界。
  2. 比较安全替代路径：Tauri build --open 保留真实production options server，Xcode用真实SDK generic simulator archive；验证原生Xcode script必须读取该server，不能裸cargo/猜默认features。
  3. 编码脚本/生命周期/签名/生产前端与失败保留bundle的回归，先红后绿。
  4. 原命令构建成功并校验签名与frontend资源，交T-005安装启动渲染。
- Acceptance criteria:
  - 无SDK/version伪造和签名绕过；使用实际SDK27编译仍能运行现有runtime26.5，App正常启动且嵌入新UI。
  - 清理仅自己的CLI/Xcodebuild进程，保持已有Host/Connector/release与手机数据；构建失败保留最后有效产物。
- Verification method:
  - 原始npm run build:ios-simulator；helper单元/脚本集成fixture；codesign/plist校验；mobile test/build；T-005模拟器检查。
- Validation evidence: 原始入口明确复现SDK27误报(exit1)，安装CLI二进制含cargo-mobile2-0.22.4，精确版本source将runtime版本同SDK版本比较；实际RPC显示dev=false/custom-protocol。相同真实SDK27在generic archive中成功，初始4workflowfixtures先4红后4绿；T-009进一步24fixtures经coordinator独立重跑24/24，原npm入口最终again ARCHIVE SUCCEEDED + strict签名/ID/版本/min16检查，无SDK/runtime/registry/node_modules伪造或下载。全mobile572/572（maxWorkers2）与TS/Vite通过；独立只读review三项问题修复后continuity确认无新actionable。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 构建工作流的取消/子进程/版本回归

- Status: done
- Owner: ios-build-lifecycle-fix
- Objective: 修复独立审查发现的发布取消窗口、已退出leader留下构建后代、build-number被忽略问题。
- Inputs and prerequisites: 新build helper已通过实际SDK27genericarchive及4workflowfixtures；read-only review给出三个具体因果发现。
- Scope or files: mobile/scripts/build-ios-simulator.py；mobile/scripts/test-build-ios-simulator.py。coordinator独占doc、BUILDING.md与后续安装。
- Expected output: 先失败后通过的取消/后代/版本fixtures与局部修复；不信号任何非本次创建的进程，不改SDK/缓存/全局工具链。
- Dependencies: None.
- Execution steps:
  1. 复现backup rename后取消导致旧产物丢失，保护完整事务及回滚。
  2. 复现helper/native leader早退和TERM-surviving child；保留明确ownership anchor到整个私有组清理完成，不能向已回收PID盲发信号。
  3. 明确处理/校验配置bundleVersion与build-number，遵循现有Tauri语义并保持本任务版本不变。
- Acceptance criteria:
  - 取消后至少一个已验证bundle存在；私有同组后代均清理，PGID不可误路由；版本参数不会静默忽略。
- Verification method:
  - 新增fixtures先红后绿；原4fixtures仍绿；Python语法与完整nativebuild、签名/元数据验证由coordinator复跑。
- Validation evidence: coordinator读取before.log确认16cases中11fail+1error（真实rename取消、早退/TERM-surviving后代、stale版本）；作者最终24/24，coordinator完整独立复验24/24(76.665s)，原4cases保持绿；read-only delta审查确认三条因果修复均解决。最终actual signed SDK27模拟器archive通过，process anchors先TERM/KILL后reap，无名称查杀。数字version/bundleVersion/build-number正向校验与不支持覆盖显式拒绝已记录BUILDING.md。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 更新已配对实体 iPhone 并验收启动

- Status: done
- Owner: coordinator
- Objective: 将添加项目功能安装到当前已配对实体iPhone，保留数据/配对，使用正确device平台库与现有开发签名。
- Inputs and prerequisites: 用户结构化确认「更新实体iPhone」；现有connected/paired iPhone且已安装同ID开发App；T-005实际sim构建已结束，设备构建与后续sim重建串行，避免共享Externals/arm64缓存覆盖。
- Scope or files: mobile设备构建/签名产物；当前已配对iPhone的com.agentport.mobile；本任务记录。不卸载、不改签名Team/Bundle ID、不发布/上传、不停止远程Host/Connector。
- Expected output: 新签名device archive、本机验证、devicectl安装/启动与PID存活证据；可取得时界面证据。
- Dependencies: T-005.
- Execution steps:
  1. 验证当前device App/签名配置，使用aarch64设备target正常Tauri签名archive；不能复用simulator库。
  2. 检查SDK27 Scene及签名/最低版本/平台，devicectl install更新，不先卸载。
  3. launch并延迟复查实际PID/新crash；保留更新后的App打开。
- Acceptance criteria:
  - 安装到用户确认的当前手机，数据保留，启动不是仅派发成功而是实际存活；明确像素/业务未跑项目。
- Verification method:
  - device archive、签名/plist/Scene检查、devicectl install/launch/process信息；可用界面截图/检查。
- Validation evidence: 用户已确认authority；普通Tauri aarch64 device archive成功（没有复用sim库），strict签名/SDKiphoneos27.0/min16/Scene真布尔检查通过；embedded profile未过期且包含用户确认的当前设备，Team/应用ID一致。devicectl install更新而非卸载，launch实际PID22448，后续process info仍指向新安装468C...App并存活；devicectl capture screenshot1320x2868实际显示原有实时终端Session（不是白屏），已有界面/会话保留。此轮没有在实体机提交新项目或做完整键盘/辅助技术测试。证据/tmp/agentport-ios-sdk-unblock/iphone-*.json/png。
- Blocker: None.
- Unblock condition: None.

### [ ] T-011 — 解除阻塞后的交付收尾

- Status: in_progress
- Owner: coordinator
- Objective: 更新最终SDK/平台交付记录及已验证教训，保持更新后的debug窗口打开并提交仅本次修复。
- Inputs and prerequisites: T-008/T-009构建修复与T-010真机安装通过。
- Scope or files: mobile/BUILDING.md；LEARNS.md；本任务文档；本次Git commit。桌面debug GUI仅统一restart脚本，不改Host/Connector/release。
- Expected output: 最终passed任务记录、debug窗口渲染截图及相关修复commit。
- Dependencies: T-008, T-009, T-010.
- Execution steps:
  1. 汇总SDK/runtimerootcause、fixture先红后绿、实际双平台build/install、PID与截图证据。
  2. 统一debug --skip-build重启已签名当前bundle，精确ps与截图；保持手机新App运行。
  3. diff/版本/计划validator，only task files commit，记录剩余minimum-OS/a11y验收边界。
- Acceptance criteria:
  - 本机SDK误报不再阻塞；模拟器与用户授权手机已更新且真实渲染；只提交本次相关文件。
- Verification method:
  - task validator、git diff --check、版本同步、debug进程/签名/截图、手机PID、git show/status。
- Validation evidence: root已检查两项已验证LEARN与source/fixture差异；原图SDK/compiler/runtimetarget明确分开。24fixture及实际sim构建最终通过，手机PID22448最后复查仍指向新安装App；实体截图实时终端正常。python3 scripts/restart-debug-app.py --skip-build仅重启签名有效当前GUI，newPID97983精确路径由ps确认，desktop-debug-final.png正常非白屏。diff/版本门禁通过，本次Git提交尚未创建。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

后端目标 Rust tests 验证 registry、目录和 Bridge 错误；前端面板 tests 验证 browse/manual/pending/old host/offline；Dashboard 集成 tests 验证视图入口、空状态、展开定位、跨设备迟到响应、成功后刷新失败。全 mobile Vitest/TS/Vite 构建、版本一致性及 diff 门禁。实际浏览器小屏/明暗主题 smoke，真实 Bridge 临时 DB 的目录/添加流程可行性测试。调试 GUI 统一重建签名重启并截图。真机/最低 OS 不可替代声明。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 添加写超时未知结果必须独立核对并持久保留；不能自动写重放。
- 旧端未提供真实目录解析时，对未知 symlink 路径不能仅凭未匹配列表断言未添加。
- 目录浏览与文件访问不扩展账户权限；Home 定位不能误用手机 Home。
- 大目录需有界，隐藏切换/导航失败不能留下可误选的旧目录。
- 原生设备和最低 OS 运行环境有限；测试与截图必须说明覆盖边界。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 读取已确认需求和相关源码，工作区干净，建立接口契约。
- 2026-10-11: T-001/T-002 标记 in_progress，通过两个隔离子任务并行实施；coordinator 独占任务文档。
- 2026-10-11: 接口已固定且文件不重叠，T-003 转 in_progress，与两个子任务并行开发 Dashboard 集成；完整集成验证仍等待两个产物。
- 2026-10-11: Dashboard 接入完成，初轮测试受未交付 i18n 影响；翻译可用后调整测试读取实际文案。npm test -- src/features/sessions/SessionDashboardProject.test.tsx：7/7 通过；既有 Dashboard/GlobalActive 两文件 60/60 通过（整合运行中的新测试文案断言随后修正）。
- 2026-10-11: 添加 projectsLoaded 防止 sessions 先返回时误报项目空状态，新增回归；首次 mobile build 和 43 文件 546 测试通过（不含尚在编写的面板新增测试，最终需再跑）。
- 2026-10-11: T-001 产物经 diff/源码检查及 coordinator 独立 Rust 21 测试复验，转 done。启动仅 read 工具的隔离 adversarial review。
- 2026-10-11: 真实 Chrome + 实际 Bridge 临时 DB smoke 通过 Home、浏览、隐藏/上级、手动路径、非 Git 添加、symlink 去重不改名、缺失目录清除旧选择、离线禁止提交；320/390 CSS px、430px 短视口和明暗主题截屏。主题 fixture 首次误用默认 dark 的系统媒体切换，修正显式 system 后通过，无产品代码变更。证据 /tmp/agentport-mobile-add-project-smoke/；运行异常 0。
- 2026-10-11: T-002 经 coordinator 源码/测试/真实渲染验证转 done；最终 mobile 44 文件 562/562 和 TS/Vite build 通过。增加 T-005，执行本机可用 iOS 模拟器构建安装与渲染，和只读 review 并行，编译产物不与 desktop debug 重建重叠。
- 2026-10-11: T-005 首轮失败：Tauri 报 Simulator SDK 27.0 未安装，而 xcrun -showsdks 和 SDKSettings 显示实际安装 SDK27，runtime 列表仅 iOS26.5；继续限定调查，不宣称根因或模拟器通过。validator 初轮相对路径受 mobile cwd 影响，随后绝对路径校验通过。
- 2026-10-11: 独立 read-only review 提出两个具体状态竞态：动画延迟 onClose 期间预检可继续写，以及 refreshFailed 跨重连被 delivered guard 吞掉恢复动作。新增 T-006，交原作者回归复现和局部修复，T-003 最终验收等待它。
- 2026-10-11: T-005 单变量重试仍同一 SDK 探测错误；Xcode 可识别 SDK 和旧 runtime 的 simulator destination。限定调查结束，转 blocked，保留未证明根因及原生交付限制；不改本机工具链，不把旧 App 截图作为新功能证据。附加平台 gate 不阻塞已确认的功能代码/真实 Bridge/browser/desktop debug 交付。
- 2026-10-11: T-006 原因由4项失败回归证明，修复后64 focused 与最终572全量/构建通过；coordinator 保留 Modal 旧非动画分支，continuity read-only 审查确认两问题已解决。追加两条已验证 LEARNS，不记录未解决 SDK 猜测；T-006/T-003 转 done。
- 2026-10-11: 最终实际浏览器/Bridge 在新隔离 DB 全流程再次通过，native Rust remote::tests 9/9。T-004 转 in_progress，下一步统一 debug 重建签名重启、精确进程核验及截图，再清理临时 harness 与提交。
- 2026-10-11: 统一 debug restart成功；新GUI9804精确路径已确认，strict签名通过，窗口10745截图正常非白屏。清理自建浏览器/服务器及移动临时harness，恢复host-test生成的ACL平台漂移；最终版本/diff门禁通过，准备仅stage任务相关18文件。
- 2026-10-11: staged diff复查时提出「80字符默认名限制可能偏离桌面」假设，新增T-007诊断81字符basename，未作为已证实缺陷交付。
- 2026-10-11: 最小实验原guard返回InvalidRequest，移除guard仍被Core Db::add_project拒绝(1-80chars)，证明初始假设错误。恢复guard，不放宽Core或修改桌面；新增正确契约测试（过长默认名写前拒绝、短自定义名可恢复），仅增加guard解释。记录可复用教训，复跑套件与debug构建。
- 2026-10-11: 后端parallel一次既有noisy_attachment try_recv失败，限定检查揭示未同步等待noisy dispatcher的测试竞态；不改非本任务代码，隔离3/3及完整串行82/82通过。T-007已完成Core约束核对和新增恢复契约测试，第三条LEARN记录已证实的误判。
- 2026-10-11: 最终再次统一debug重建/固定签名/精确重启成功，GUI34687、窗口10754及debug-app-final.png非白屏证据已检查。代码验证结束，T-004仅待相关改动Git提交。
- 2026-10-11: 功能commit fdcdc2b创建成功，仅18个任务相关文件；git show/status复核通过。T-004转done，执行计划最终partial仅因附加平台T-005 blocked。本次文件完整交付，无推送/发布或手机安装声明。
- 2026-10-11 continuation: 用户授权解除阻塞；刷新工作区仍干净，复用原任务文档。T-005 blocked→in_progress，新增T-008。源码精确匹配安装CLI：cargo-mobile2-0.22.4::Target.validate_sdk读SDK版本却要求runtime>=该版本，因此误报SDK未装。隔离仅read调查子任务ios-sdk-path-check验证安全路径；所有编辑由coordinator负责。
- 2026-10-11 continuation: 原npm命令复现SDK27误报(exit1)，Tauri production --open的实际RPC返回dev=false、tauri/custom-protocol；相同真实SDK27的generic signed archive成功。封装4workflowfixtures在旧脚本4失败，新helper4通过，原始npm入口实际构建成功且签名/ID/SDK27/最低16/Scene布尔检查通过；未安装runtime。
- 2026-10-11 continuation: 独立只读审查指出发布backup move取消、leader已退但后代仍跑、build-number静默忽略三个具体问题，新增T-009由独占脚本文件的子任务先复现后修复。全mobile测试在默认并发一次旧GlobalActive测试失败；限定2worker重跑处理中，不改应用源码掩盖环境问题。
- 2026-10-11 continuation: 当前实际SDK27产物已通过strict签名/ID/min16/Scene及构建检查，T-005输入可用，模拟器运行验收可与T-009纯fixture脚本修复并行；子任务不会构建或修改当前产物。T-008最终验证仍等待T-009。
- 2026-10-11 continuation: 模拟器新App已安装并launch，PID32234持续存活，截图显示正常Active视图（旧布局偏好保留），没有dev server。默认并发旧GlobalActive测试孤立17/17、限制2worker全572/572及build复验通过。用户结构化授权更新当前已配对实体iPhone，新增T-010；手机构建安装与sim构建串行。
- 2026-10-11 continuation: 原新sim App安装/实际进程/新入口截图验收通过，T-005转done（仅UI布局偏好seed，不声称触控业务）。确认当前实体手机已有同Bundle ID的开发App0.1.0，T-010转in_progress；它使用普通device archive，不依赖sim helper的纯fixture生命周期修复，实际构建保持串行。
- 2026-10-11 continuation: T-009先16cases11fail+1error后24/24通过，coordinator独立24/24及完整actual sim archive复验通过；3项独立review的continuity复查无actionable。T-009/T-008转done，原始npm入口不再SDK误报。
- 2026-10-11 continuation: 用户授权的手机device archive正常签名/授权profile/SDK27/min16/Scene校验通过；更新安装launch PID22448，延迟存活与实际1320x2868截图证明实时终端正常渲染且当前Session保留。T-010转done，T-011交付收尾开始。
- 2026-10-11 continuation: 最后手机PID22448仍运行；桌面统一--skip-build重启后GUI97983路径准确，正常渲染截图已读取。LEARN追加已验证SDK/runtime误判与私有进程组ownership两项，未写未证实假设；diff/版本检查通过，仅本次6文件待commit。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 原功能commit fdcdc2b/570af5a及此前Rust82/native9/browser集成证据保留。本轮SDK/runtime阻塞已解：源版本与真实SDK27/runtime26.5定界，原入口成功；24工作流fixtures先红后绿并coordinator独立复验，mobile572/572（maxWorkers2）+TS/Vite通过。独立review三项生命周期/版本问题修复后复查无actionable。实际signedsim App已安装并正常渲染新入口；用户明确授权实体iPhone新signedSDK27/min16/Scene正确App已更新，PID22448持续存活，实际终端截图正常；桌面debugGUI97983正常。T-001至T-010全部done，仅T-011待本次修复commit。
- Limitations: 本机原无Simulator GUI，sim项目布局由仅UI偏好seed并截图，不声称原生触控/键盘/辅助技术完整验收；本轮没有在实体机提交新项目。最低iOS16、Android/Windows/Linux运行未新增验收；iOS26.5sim与当前实体机存活/像素不是这些边界的替代。SIGKILL/断电无法运行cleanup；有意detach成新session的后代不属于同私有组；文件系统rollback失败保留可恢复产物但需手动恢复。版本helper不支持覆盖/path/prerelease版本已明确拒绝。未发布或推送。
