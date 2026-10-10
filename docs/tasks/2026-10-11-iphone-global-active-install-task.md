# Task Plan: 安装全设备 Active Session 到 iPhone

- Created: 2026-10-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户要求“安装到 iphone”，并于原生启动失败后明确授权“执行修复”；沿用禁止 computer 的约束。

<!-- task-doc-section:background-goal -->
## Background and goal

将包含全设备 Active Session 的当前源码构建为物理 iPhone 开发签名 App，覆盖安装到唯一可用的实体 iPhone 并启动验证。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 使用既有 Apple Development 配置和官方 Tauri 真机 archive/包装脚本。
- 保持 bundle ID/team，移开旧 archive 防止误用；不卸载、不清除 App 数据。
- 仅交付目标实体 iPhone，不操作 Apple Watch；不发布 TestFlight/App Store、不变更版本、不使用 computer。
- 新授权允许修复 iOS Scene lifecycle 配置及直接受影响的原生生命周期适配、添加回归测试；不改 Active Session 业务，不绕过 UIKit 检查、不伪造 SDK、不升级无关依赖。
- 构建日志、profile、Team ID、UDID、签名产物留在私有本机目录，不提交。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前源码 2e4404d 包含功能提交 76cdeac，安装前工作区干净 | git log/status；前任务 496 测试与 build 通过 |
| F-002 | 唯一 available/paired 的物理 iPhone 为 iPhone 17 Pro Max，其余 iPhone 是模拟器 | xcrun devicectl list devices |
| F-003 | 已安装 com.agentport.mobile 0.1.0 | devicectl device info apps；私有 before-apps.json |
| F-004 | 旧 archive 是 0.1.0 真机开发包，profile 包含目标设备且有效到 2027-09-23；本机两份有效签名身份、真机 Mosh 库及 Rust target 就绪 | 只读 plist/CMS 与 rustup 检查；未记录身份值 |
| F-005 | 官方脚本拒绝旧 archive，使用临时 xcconfig，不可直接绕过 Tauri 参数服务构建 | mobile/BUILDING.md、RELEASE.md、scripts/build-ios-personal-team.sh |
| F-006 | 当前 Xcode/SDK 为 27.0，旧包 SDK 为 26.5；新旧 Info.plist 都没有 UIApplicationSceneManifest | xcodebuild/xcrun 与归档 Info.plist 只读比较 |
| F-007 | 新包安装成功但启动后没有持续运行；匹配新二进制 UUID 的真机 crash 在 UIKit NoSceneLifecycleAdoption 检查处 SIGTRAP | install/launch JSON、两次 process 查询、只读复制的 ips、dwarfdump UUID |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 唯一可用实体 iPhone 即用户目标，未发现需选择的第二台实体手机。
- Open question: 无阻塞授权问题。用户已选择修复新包，而非恢复旧包。设备信任/签名可用，不是锁屏或安装失败。
- Hypothesis: SDK 从 26.5 升到 27.0 触发未采用 Scene lifecycle 的原生兼容限制；堆栈/元数据支持，但未做修复或控制变量运行，不宣称已完成因果修复。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 新 archive 含本次 mobile 前端资源，主程序为物理 iOS arm64，签名/profile/目标注册设备验证通过。
- devicectl 明确报告 App 安装成功；只读查询确认已安装 bundle/version，检查原数据容器是否保留。
- devicectl 启动 com.agentport.mobile 成功，并只读复核运行进程；不把安装/启动当作业务 UI 验收。
- 不提交本机签名与设备资料，源码无非预期修改；安装记录文档校验通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-004 -> T-002 -> T-003；T-002 已完成安装子步骤，因新发现的原生启动阻塞追加 T-004。
- Parallel batches: 无，构建/安装/启动共用 archive 和设备，串行执行。
- Serialization constraints: 同一 iOS target/archive 不并行构建；只由 coordinator 操作实体设备和文档。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 新真机 archive 与签名验证

- Status: done
- Owner: coordinator
- Objective: 从当前源码构建新物理 iOS 开发包，证明不是旧 archive 或模拟器包。
- Inputs and prerequisites: 既有有效开发 profile、唯一实体设备、已提交源码及真机库。
- Scope or files: ignored iOS archive、私有输出、本文档；不改产品源。
- Expected output: 新 archive、验证过的开发 IPA/manifest/SHA256SUMS。
- Dependencies: None.
- Execution steps:
  1. 私有读取旧 profile 的本机 team，保留旧 archive 作为私有备份。
  2. 运行 bash mobile/scripts/build-ios-personal-team.sh；后台等待。
  3. 检查 manifest、代码签名、平台与新前端资源的嵌入证明。
- Acceptance criteria:
  - 官方构建与包装验证成功；新资源被嵌入，profile 包含目标设备且有效。
- Verification method:
  - 构建日志、manifest、SHA256SUMS、codesign 与归档文件检查。
- Validation evidence: 官方脚本 37 秒完成 Tauri 真机 archive 与开发 IPA 验证；TypeScript/Vite build 通过。manifest signature_verified/profile_preserved=true、platform=iPhoneOS、目标验证数=1，profile 有效到 2027-09-23；IPA SHA256 复核一致。归档 executable 中包含新前端资源名 index-BV5bB8RL.js，源资源含 allConnectedDevices；二进制 SHA256=7756f626d8f3a1927a02827a7dfe6144e50ff80fd3ac94403fca97545b501fb3。git status 仅本安装文档未跟踪，无产品源/签名配置漂移。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 覆盖安装并启动

- Status: done
- Owner: coordinator
- Objective: 在目标实体 iPhone 覆盖安装新包并启动。
- Inputs and prerequisites: T-001 新签名 archive 验证通过，设备仍可用。
- Scope or files: 实体 iPhone 的 com.agentport.mobile；私有工具 JSON 输出。
- Expected output: 安装成功、应用查询及启动/进程证据。
- Dependencies: T-001, T-004
- Execution steps:
  1. 复核目标为实体设备；运行 devicectl device install app，仅安装一次，不卸载。
  2. 查询安装后 App/数据容器，对照安装前元数据。
  3. 用 devicectl 启动并只读查询运行进程。
- Acceptance criteria:
  - 安装与启动明确成功；不清除数据；保留验证边界。
- Verification method:
  - devicectl install/launch JSON、info apps/processes；容器对比。
- Validation evidence: 原SDK27坏基线安装成功、launch派发成功但PID消失，匹配UUID的ips在UIKit NoSceneLifecycleAdoption处约71ms SIGTRAP。修复包仅新的一次覆盖安装/启动，scene-fix-install/launch JSON success；只读进程查询确认同一PID21312在3s与60s均存活，bundle/version仍com.agentport.mobile/0.1.0。crash文件最新时间00:54早于修复启动01:11，无修复后新记录。签名/SDK/实际配置已经T-004核验。未卸载/清数据，迁移后的旧WebKit存储仍在；未逐条核验数据。CLI截图尝试因iOS27 screenshotr服务Invalid service失败，不重试，不当作非空白UI证据。
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — 修复提交与交付收敛

- Status: in_progress
- Owner: coordinator
- Objective: 收敛实际证据、说明未验证的真机业务行为并提交安装记录。
- Inputs and prerequisites: T-001/T-002 结果。
- Scope or files: 本任务修复/测试/构建文档及LEARN记录；Git状态核对，不含本机签名/设备/产物。
- Expected output: 修复 commit、完成的安装执行记录及清楚的未验证边界。
- Dependencies: T-002
- Execution steps:
  1. 核对构建没有意外修改产品源/生成签名配置。
  2. 更新状态与验证限制，validate 文档并提交。
- Acceptance criteria:
  - 记录与工具结果一致，无敏感值/产物入 Git。
- Verification method:
  - git status/diff --check；task_document.py validate；git commit/show。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — iOS Scene lifecycle 最小兼容修复

- Status: done
- Owner: coordinator
- Objective: 以已捕获的 SIGTRAP 坏基线定位 Scene opt-in，修复后交付可持续运行的新包。
- Inputs and prerequisites: T-001 新 archive；匹配 UUID 的实体崩溃报告；用户“执行修复”授权；Tao 0.35.3 已具备 scenes 实现。
- Scope or files: mobile/src-tauri/Info.ios.plist、现有生成 Info.plist/project.yml、mobile 独立 Cargo.toml/Cargo.lock 的兼容 Tao 上游 pin；mobile/src/app/ios-packaging.test.ts、语义 plist 验证/包装脚本测试、mobile/BUILDING.md；本计划。APNs bridge 不需要修改；只改本故障及直接回归相关文件。
- Expected output: 完整非空 Scene manifest、TaoSceneDelegate 正确注册、相关原生回归保护，以及新版签名 archive；不是单纯 launch 派发成功。
- Dependencies: T-001
- Execution steps:
  1. 只读核对 crash UUID、堆栈、SDK 与 Scene manifest，界定新包原生失败。
  2. 为完整 Scene manifest 写失败回归；复用当前 Tao 的场景实现，不替换 UIApplicationDelegate 或打私有 UIKit 补丁。
  3. 做最小配置/直接生命周期适配，检查 native startup、通知权限及窗口附着；定向/full mobile 测试和新 archive 验证。
  4. 只读子代理研究公开上游，coordinator 独占编辑、构建/签名和真机操作；完成后交给 T-002 安装与持续运行验证。
- Acceptance criteria:
  - 保持权限/APNs/方向与业务行为，Scene manifest 配置与依赖 runtime 名称一致；自动回归、新包验签和实际归档配置通过；目标设备启动/持续运行最终证明由 T-002 完成。
- Verification method:
  - ips/二进制 UUID/SDK 比较；处置后的真实进程与业务验收。
- Validation evidence: 已有真机坏基线 UUID/堆栈明确；新增配置语义测试在修复前两个 plist 因 manifest=None 失败，修复后10个Python测试通过，完整Mobile41文件/498测试通过；旧SDK27坏archive被包装guard明确拒绝。新SDK27原生archive24秒完成，实际Info包含完整TaoScene/TaoSceneDelegate配置并经签名/profile/arm64验证；新UUID=CAFDCA9C-2404-3D8D-BF03-D9AC70B336C2，SDK未降级。公开上游git源核对compatible0.35.3 pin中iOS仅改为autorelease_ptr；APNs/方向配置不动。真机持续运行由T-002验证，不把archive成功当成运行成功。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

为 Scene manifest/直接生命周期适配添加失败前基线与回归保护，跑定向及全 mobile 测试；Tauri beforeBuildCommand 重新执行 TypeScript/Vite build。包装工具检查 arm64/iPhoneOS、CMS/profile 有效性、目标设备、开发 entitlements、签名及 IPA 解包 round-trip。安装前后查询 bundle/version/数据容器；安装与启动各独立确认，再读取设备进程。没有 computer 或真机 UI 自动化，因此业务交互/非空白 UI 不冒充已验证。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 设备可能锁定或无线离线，遇到明确限制需用户解锁/接线，不能盲目重试安装。
- 覆盖安装通常保留数据；本任务禁止卸载，核对同 bundle/team 与数据容器，不能宣称所有业务数据逐条核验。
- 旧任务的 desktop capture 仍 paused 且结果未核实；当前 iPhone 安装不依赖它，不重放或推断成功。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11 00:36: 建立安装执行文档。发现唯一实体 iPhone；安装前 App 查询成功；既有真机 profile/依赖就绪，旧 archive 必须备份。T-001 in_progress。
- 2026-10-11: 旧 archive 移到私有备份，新 archive/IPA 构建和包装验证成功；只读检查新前端资源嵌入、摘要与签名通过。T-001 done，实体 iPhone 再次确认为 available/paired，T-002 in_progress，开始一次覆盖安装。
- 2026-10-11 00:41: 覆盖安装明确成功。启动命令报告 success，但两次只读进程复核不见 App；读取 crash 后确认匹配本次新二进制，UIKit 原生 Scene lifecycle 检查处 SIGTRAP。当前 SDK27 vs旧SDK26.5；未重放启动/安装，未改源码或回滚。T-002 blocked，等待修复/回滚决定。新增 T-004 记录已做的只读故障界定与授权阻塞，不将必要工作隐藏在日志中。

- 2026-10-11: 用户明确授权执行修复；T-004 blocked -> in_progress，取消源码修改授权 blocker，保持 T-002 等待新包。只读查看锁定的 Tao0.35.3 已有 TaoSceneDelegate/窗口绑定，正在确认 manifest 激活条件；委派只读上游研究，编辑和真机由 coordinator 串行负责。

- 2026-10-11: 新 plist 语义回归先在 canonical/generated 两处因 manifest=None 失败；完整配置修复后 10 个 Python 测试通过，旧 SDK27 崩溃 archive 被新包装 guard 拒绝，plutil通过。497 Mobile 测试通过。只读研究确认 Tao0.35 的布尔门槛与配置返回悬空指针，保持既有 APNs delegate。
- 2026-10-11: 正式0.35.4不存在，最新0.37.1不满足runtime约束，拒绝升级不兼容minor或修改registry。通过公开上游 Git 核对 PR1245不可变commit c84a010...仍为0.35.3，iOS源码只改变 as_ptr->autorelease_ptr；仅 mobile pin 该兼容修复。Cargo仅替换 tao及其git宏来源，其他93依赖未升级。iPad多场景行为保留为未验证边界，不声称新业务窗口功能已验收。

- 2026-10-11 01:10: 新SDK27 archive/包装验证成功，10个Python/498个Mobile测试通过，Info实际Scene配置与新UUID核对通过。T-004 done（源码与新包验证）；T-002 blocked -> in_progress，仅对已验证的修复新包重新覆盖安装与启动，不重放此前未确定操作。

- 2026-10-11 01:12: 修复包安装/启动成功，PID21312在3s/60s实际查询均存活；最新crash00:54早于修复启动01:11。T-002 done，T-003 in_progress。CLI截图服务Invalid service，保留未验证pixels边界，不使用computer，不再重试截图。补记录一条已验证的SDK27/Scene部署经验，开始任务专属commit。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 原生修复、新SDK27 archive签名/完整Scene配置、10Python与498Mobile测试通过；实体iPhone覆盖安装/启动成功，同一PID存活60秒，无修复后新crash。T-001/T-004/T-002 done，T-003提交/文档闭环进行中。
- Limitations: 未验证真机pixels、VoiceOver、最低iOS16、iPad多窗口、Release优化下运行、APNs/深链与终端后台业务。screenshotr不可用，禁止computer；旧desktop capture仍未核实且与本任务无依赖。签名包/报告都仅保留私有目录，不发布。
