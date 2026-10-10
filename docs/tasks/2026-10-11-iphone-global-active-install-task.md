# Task Plan: 安装全设备 Active Session 到 iPhone

- Created: 2026-10-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户明确要求“安装到 iphone”；沿用禁止 computer 的约束。

<!-- task-doc-section:background-goal -->
## Background and goal

将包含全设备 Active Session 的当前源码构建为物理 iPhone 开发签名 App，覆盖安装到唯一可用的实体 iPhone 并启动验证。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 使用既有 Apple Development 配置和官方 Tauri 真机 archive/包装脚本。
- 保持 bundle ID/team，移开旧 archive 防止误用；不卸载、不清除 App 数据。
- 仅安装实体 iPhone，不操作模拟器或 Apple Watch；不发布 TestFlight/App Store、不变更版本/源码、不使用 computer。
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
- Open question: 新包原生启动崩溃，原安装范围不含产品源修改；需用户决定修复原生生命周期兼容，或恢复旧包。设备信任/签名可用，不是锁屏或安装失败。
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

### [ ] T-002 — 覆盖安装并启动

- Status: blocked
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
- Validation evidence: devicectl 安装 6 秒成功，install/after-apps JSON outcome=success，bundle/version正确；launch outcome=success 仅证明派发启动。两次只读 process 查询均未找到启动 PID 或 AgentPort。目标新二进制 UUID 与 ips slice_uuid 完全匹配；报告显示 UIKit ___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke 在主线程触发 EXC_BREAKPOINT/SIGTRAP，约71ms退出。数据容器路径发生迁移，但旧 WebKit 存储条目仍在且含 2026-09-06 时间戳；没有执行卸载/数据清除，未逐条核验用户数据。
- Blocker: 新安装包不能持续运行；原生 Scene lifecycle 兼容修复超出本安装任务约定的“不改产品源”范围。
- Unblock condition: 用户授权原生兼容修复并重新构建/安装后持续运行验收通过，或明确要求恢复此前旧 archive；不得盲目重复安装/启动。

### [ ] T-003 — 交付记录与文档提交

- Status: pending
- Owner: coordinator
- Objective: 收敛实际证据、说明未验证的真机业务行为并提交安装记录。
- Inputs and prerequisites: T-001/T-002 结果。
- Scope or files: 本任务文档；Git 状态核对。
- Expected output: 完成的安装记录，必要时明确 blocker；仅文档 commit。
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

### [ ] T-004 — 新发现的原生启动故障处置（待后续授权）

- Status: blocked
- Owner: coordinator
- Objective: 收集并界定原生启动失败，等待明确处置授权后修复或恢复可运行的 App。
- Inputs and prerequisites: T-001 新 archive；实体 iPhone 崩溃报告；需扩大原安装任务范围的明确授权。
- Scope or files: 当前仅私有只读 crash/归档元数据；原生源/依赖或旧包恢复均尚未获本任务授权，不擅自执行。
- Expected output: 明确处置范围以及可持续运行的目标包；不是单纯 launch 派发成功。
- Dependencies: T-001
- Execution steps:
  1. 只读核对 crash UUID、堆栈、SDK 与 Scene manifest，界定新包原生失败。
  2. 等待修复兼容或恢复旧包的明确后续授权，记录允许的产品修改/设备操作。
  3. 按授权处置并完成构建、安装、持续运行验证。
- Acceptance criteria:
  - 安全边界明确，原生启动阻塞被可复现实验证明解决；未授权时不改源或回滚。
- Verification method:
  - ips/二进制 UUID/SDK 比较；处置后的真实进程与业务验收。
- Validation evidence: 只读报告显示匹配新包二进制 UUID 的 UIKit NoSceneLifecycleAdoption SIGTRAP；当前 Xcode/SDK27.0 与旧包 SDK26.5 均缺 Scene manifest。重复运行来自设备已有 crash，不重放 launch；仅明确阻塞，未验证修复。
- Blocker: 解决原生 Scene lifecycle 兼容或恢复旧包超出原约定安装范围；当前尚无明确后续处置授权。
- Unblock condition: 用户明确授权兼容修复，或明确要求恢复之前旧包；再据此更新执行范围。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

无需重复修改/重测已通过的产品代码；Tauri beforeBuildCommand 会重新执行 TypeScript/Vite build。包装工具检查 arm64/iPhoneOS、CMS/profile 有效性、目标设备、开发 entitlements、签名及 IPA 解包 round-trip。安装前后查询 bundle/version/数据容器；安装与启动各独立确认，再读取设备进程。没有 computer 或真机 UI 自动化，因此业务交互/非空白 UI 不冒充已验证。

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

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: blocked
- Evidence: T-001 真机 archive/签名/新前端嵌入验证通过；T-002 安装已成功，但启动后崩溃，经运行进程查询与匹配二进制 UUID 的 ips 确认；不得报告可正常使用。
- Limitations: 未验证真机 UI/多电脑业务操作；原生 Scene lifecycle 兼容尚未修复。旧包已私有备份，可按用户明确决定恢复；禁止 computer 的约束保持。
