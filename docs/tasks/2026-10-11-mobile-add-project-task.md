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

- Dependency graph: T-001、T-002、T-003 基于已锁定接口独立开发并行；T-001/T-002 完成后 -> T-005；审查发现补充 T-006（依赖 T-002），T-003 最终验收等待 T-006；T-001/T-002/T-003/T-007 完成后 -> T-004；附加 T-005 受本机 SDK 探测阻塞，单独披露而不伪装通过。
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

### [ ] T-004 — 渲染、调试交付与提交

- Status: in_progress
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
- Validation evidence: 最终实际 Chrome + 实际 Bridge 隔离 DB smoke passed（13检查，异常0）；读取明暗320 CSS px、390 CSS px 添加结果及430px短视口截图，滚动后提交控件可操作。python3 scripts/restart-debug-app.py 成功重建、固定证书签名并仅关闭旧 GUI12288、打开新 GUI9804；ps两次确认 exact executable=/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport；codesign --verify --deep --strict 通过。激活精确PID并读取CGWindow10745，screencapture PNG显示正常sidebar及workspace，非白屏。证据 /tmp/agentport-mobile-add-project-smoke/。临时Vite、Chrome、隔离Bridge已停止，harness已移至/tmp；host cargo test生成的非本任务ACL变更（移除mobile插件项）经差异检查恢复。版本/diff检查通过；Git提交尚未完成。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 更新 iOS 模拟器调试窗口（附加平台验证）

- Status: blocked
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
- Validation evidence: npm run build:ios-simulator 和单变量 IPHONEOS_DEPLOYMENT_TARGET=16.0 重试均在完成前端 build 后失败：Tauri 报 Xcode Simulator SDK 27.0 is not installed。xcodebuild -showsdks、xcrun --sdk iphonesimulator --show-sdk-path/version 与 SDKSettings.json 均显示真实 SDK27.0 已安装；xcodebuild -showdestinations 可识别 booted iPhone17 Pro/iOS26.5。未替换/安装现有模拟器 App，不能宣称更新后原生渲染通过。未下载 SDK/runtime、未修改本机 Xcode 或上游 CLI。
- Blocker: Tauri iOS simulator SDK 探测拒绝本机已安装 SDK27.0；具体根因未证明，现有 runtime 仅26.5。
- Unblock condition: 在支持的 Xcode/SDK/Tauri 组合中通过同一 build 命令，随后安装启动截屏；此附加验证不是已确认功能实现的前置条件，但交付必须披露限制。

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

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 功能代码完成：Rust后端82测试（最终串行；先前parallel81通过，后续已有noisy_attachment测试一次调度竞态，孤立3/3复验通过）、coordinator后端21复验、native mobile远程9测试、全部mobile572测试与TS/Vite构建通过；独立审查两问题先红后绿修复且复查通过；真实browser/Bridge隔离DB全流程与小屏明暗截图通过；更新后的签名debug GUI正常渲染。T-004待Git提交，T-005附加原生平台验证blocked。
- Limitations: iOS simulator打包被Tauri SDK27探测失败阻塞；没有更新或安装手机/模拟器App，不宣称iOS16/Android/真机或真实手机键盘/辅助技术已通过。430px视口模拟仅证明浏览器压缩高度时控件可通过滚动操作。Windows隐藏属性分支和Linux运行未实测。未发布或推送。
