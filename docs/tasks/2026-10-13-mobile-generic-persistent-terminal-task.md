# Task Plan: Mobile 通用 SSH Mosh 持久终端

- Created: 2026-10-13
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户确认双模式需求后明确要求编写计划、实施并交付。

<!-- task-doc-section:background-goal -->
## Background and goal

保留 AgentPort 管理，新增不要求远端安装 AgentPort 的 SSH/Mosh 终端。手机可访问 macOS/常见 Linux，使用 App 创建的独立 tmux 会话保存远端工作。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

首期 SSH 与 Mosh 同时接入；复用密码/私钥、指纹与单级跳板配置。同一 SSH 主机两种明确入口，Relay 不用于通用终端。多终端、记录恢复、缺少 tmux 阻止进入并给指引、关闭仅断开、确认后结束会话、Mosh 失败由用户选择 SSH 接回。支持 iOS/Android。

排除新中继、通用文件管理、多级跳板、Windows 原生支持、远端自动安装、全部既有 tmux 会话管理、headless AgentPort 安装方案。不得自动重放命令或重建已经消失的会话。不保证系统冻结期间持续运行或服务器重启恢复。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前 SSH 登录后固定运行 Bridge 并握手 | mobile/src-tauri/src/remote.rs establish_with_secrets |
| F-002 | russh 认证和单级跳板可复用 | mobile/src-tauri/src/ssh/mod.rs |
| F-003 | 已有原生 Mosh 与 Shell bootstrap，但前端未接入 | mobile/src-tauri/src/mosh/{mod.rs,bootstrap.rs}；mobile/src 搜索 |
| F-004 | 当前移动终端渲染可直接供通用终端使用 | mobile/src/terminal/MobileTerminal.tsx onInput/onResize/write |
| F-005 | 主机档案含跳板和 UDP 参数 | mobile/src-tauri/src/hosts/mod.rs；HostProfile |
| F-006 | 开始时工作树无未提交改动 | git status --short，2026-10-13 |
| F-007 | 需求和实施授权已明确 | 本轮对话共同理解摘要及用户实施请求 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 沿用已有认证能力，不扩展新的认证方式；用户已接受。
- Assumption: 恢复只 attach 仍存在的 App tmux 会话，消失则提示用户新建；用户已接受。
- Assumption: 运行环境的模拟器/真机与测试 SSH 服务可用性需验证，不可用时记录限制，不虚构通过。
- Open question: 无产品决策待确认。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 未装 AgentPort 的远端支持普通 SSH/Mosh PTY 终端、全屏程序、输入与 resize。
- 多终端独立，关闭仅 detach，恢复存活 tmux 会话；连接/切网不重放命令或静默新建。
- tmux 缺失、mosh-server 缺失、UDP 故障、主机指纹变化都有明确处理。
- 同一 SSH 主机两入口；Relay 不可通用连接；原 AgentPort 主流程不回退。
- iOS/Android 构建与真机切网、前后台证据分别记录；不可用的设备不得标记验收通过。
- 完成代码验证后仅提交本任务改动；按仓库要求重启并截图检查调试 App。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-005；T-002 → T-006；T-001、T-002、T-005、T-006 → T-003 → T-004。
- Parallel batches: 原生端 T-001 与 Web 端 T-002 按预定 IPC 契约并行；T-003 集成串行；T-004 验收交付串行。
- Serialization constraints: T-001 独占 mobile/src-tauri/src，T-002 独占 mobile/src，协调者独占计划文档、文档/验证脚本。子任务不得提交、重启 App 或改锁文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 原生通用终端与持久会话

- Status: done
- Owner: native-terminal
- Objective: 不经过 Bridge 的 SSH PTY 与 Mosh/tmux 连接，持久记录和安全生命周期。
- Inputs and prerequisites: 已确认需求；协调者预定 IPC 契约；已有 SSH/Mosh 实现。
- Scope or files: mobile/src-tauri/src/generic_terminal.rs，lib.rs，mosh/，必要的 ssh/ 可见性调整。
- Expected output: list/create/connect/input/resize/poll/disconnect/end IPC、错误分类、单元与本地 SSH 集成测试。
- Dependencies: None.
- Execution steps:
  1. 实现受控 tmux 标识、记录、显式创建/只恢复语义与指纹安全。
  2. 接入 SSH PTY 和 Mosh 原生通道，保证关闭 detach、结束 kill 的边界。
  3. 验证命令注入、并发、输出字节完整性、退出与缺依赖错误。
- Acceptance criteria:
  - 普通连接不启动 Bridge；输入不重放；仅创建阶段允许新建 tmux。
  - 不关闭他人/AgentPort 会话；拒绝 Relay/未信任/停用主机。
- Verification method:
  - cargo test --manifest-path mobile/src-tauri/Cargo.toml；本地 fixture SSH。
- Validation evidence: 协调者 PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path mobile/src-tauri/Cargo.toml --locked 通过 42 tests；真实 russh+隔离 tmux fixture 验证 create/check/end、字节/PTy/resize/idle/detach，PTY 为 echo fixture 非真实 Shell。iOS simulator archive 与 Android APK 构建通过，尚无实际 Mosh UDP 运行证据。后续独立审查的 native 安全问题纳入 T-005。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 双模式入口与通用终端 UI

- Status: done
- Owner: terminal-ui
- Objective: 主机双入口、多终端列表、SSH/Mosh 选择、持久恢复与确认结束。
- Inputs and prerequisites: 已确认需求；协调者预定 IPC 契约；MobileTerminal。
- Scope or files: mobile/src/features/generic-terminal/，protocol/，platform/，App.tsx，HostManager.tsx，i18n/resources.ts 与相关测试/样式。
- Expected output: 独立通用终端 UI 及 IPC 适配、中文/英文状态、测试。
- Dependencies: None.
- Execution steps:
  1. 定义 typed client、事件/轮询及组件生命周期。
  2. 添加非 Relay 主机的通用终端入口，不经过 Bridge。
  3. 完善 missing/trust/disconnect/reconnect/end 等状态并测试。
- Acceptance criteria:
  - 终端创建/恢复/关闭/结束可区分，Mosh 失败显式改用 SSH。
  - 操作异步取消/切换不把旧输出或输入送入新终端，兼容既有 App 流程。
- Verification method:
  - npm --prefix mobile test；npm --prefix mobile run build；浏览器实际渲染检查。
- Validation evidence: 协调者 npm test -- --maxWorkers=2：48 files / 749 tests 全通过；npm run build 成功；真实 Chrome/xterm fixture 验证 bytes/input/resize、恢复不创建、关闭不结束、显式 fallback、结束确认、create、320px/暗亮主题。14 个新增生命周期测试覆盖 stale/late cleanup、ordered input/resize 和 detach-before-connect。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成回归与用户文档

- Status: done
- Owner: coordinator
- Objective: 检查契约与跨层路径，独立审查并修复可证实风险，补使用与验收文档。
- Inputs and prerequisites: T-001、T-002 已完成并审查。
- Scope or files: 本任务代码、mobile 使用文档和必要的验证脚本。
- Expected output: 集成修正、可复现验证记录、功能指引。
- Dependencies: T-001, T-002, T-005, T-006
- Execution steps:
  1. 审查 diff、IPC、字节/尺寸、信任、持久性和 tmux 生命周期。
  2. 跑全套 Mobile 测试构建、支持范围内的原生 target 检查与端到端 fixture。
  3. 记录安装前提、恢复语义与限制。
- Acceptance criteria:
  - 自动化门禁通过；需求到实现到验证路径可追溯。
- Verification method:
  - 前后端测试、build、diff review、原生 target 编译及可用的渲染检查。
- Validation evidence: 最终 full UI 48 files / 759 tests（npm test -- --maxWorkers=2）、tsc/Vite build、host Rust 44 tests 全通过；Chrome/xterm fixture 加入真实 interface/terminal appearance hooks，验证双入口窄屏和 jump 保存、暗亮 theme、bytes/input/resize、detach/fallback/end/create。既有 test-session-files.mjs 通过；check-version-sync.sh 与 build-terminal-snapshot.mjs --check 通过；独立 native 审查及源码 diff 检查通过。使用文档与原生对应源码/安全 patch 构建说明已更新。
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 真机边界、调试窗口与提交交付

- Status: blocked
- Owner: coordinator
- Objective: 尽可能完成平台验收，真实记录不能完成的项，提交已验证实现。
- Inputs and prerequisites: T-003 自动化通过；构建/设备环境可用。
- Scope or files: 计划文档、必要验证证据；统一 debug App 重启脚本。
- Expected output: 设备/渲染记录、任务限定 Git commit、最终交付说明。
- Dependencies: T-003
- Execution steps:
  1. 检查 iOS/Android 工具链与设备，执行可用构建/运行验收。
  2. 使用 scripts/restart-debug-app.py 重启精确 GUI，ps 核验路径，截图非白屏。
  3. 检查版本同步、任务计划 validator、git diff；只提交任务改动。
- Acceptance criteria:
  - 未验证真机项明确标注，禁止宣称整体通过；代码验证通过后提交。
  - 调试 App 可正常渲染，或记录具体不可用原因。
- Verification method:
  - 设备检查、ps、截图、scripts/check-version-sync.sh、task_document.py validate、git diff --check。
- Validation evidence: iOS 26.5 simulator signed archive / Android API29 APK 构建成功，安装并启动最终包，/tmp/agentport-generic-terminal-ios-final.png 与 android-final.png 非白屏。统一桌面 debug 重启签名成功，最终 ps PID84010/window1520 精确核验并激活截图非白屏。最后 devicectl 仍显示实体 iPhone unavailable；adb 仅 emulator-5554，无 Android 真机。本地源代码验证已完成；真实 Mosh UDP、真机切网/后台、移动完整 Shell/TUI 跨层端到端未完成。已创建本地 feat(mobile): add generic SSH and Mosh tmux terminals 提交；git show 核验仅24个本任务文件，工作树无剩余改动。未混入独立键盘入口提交。
- Blocker: 实体 iPhone unavailable，Android 无真机；本机无 mosh-server，不能凭 host echo PTY fixture/构建/模拟器启动宣称 native UDP 与两端真机业务通过。
- Unblock condition: 提供可用 iOS/Android 真机、已配置 SSH/tmux/mosh-server 的 macOS/Linux 目标与可达 UDP/VPN 网络；逐项运行并记录 Shell/full-screen、切网、前后台、恢复和停止验证。

### [x] T-005 — 激活 Mosh 前的 native 安全修复

- Status: done
- Owner: native-terminal
- Objective: 消除共享 winsize 数据竞争、异步退出释放悬空指针、首次启动过早 SIGTERM 信号风险。
- Inputs and prerequisites: T-001；独立 read-only 审查指出 Rust 与 pinned iosclient.cc 实际读写路径。
- Scope or files: mobile/src-tauri/src/mosh/mod.rs；mobile/native/mosh 的受控 patch、构建脚本及必要测试。
- Expected output: 双侧同步 resize/native 生命周期与信号启动协议、可复现回归和源码可追溯构建。
- Dependencies: T-001
- Execution steps:
  1. 核验原生读写/信号及指针生命周期，建立最小回归。
  2. 原生 event-loop 所有权或原子快照修复 resize，startup mask/readiness 与 reaper 保持分配存活。
  3. 验证所有 native 平台 patch 应用、重新构建 artifacts，再交由协调者复测。
- Acceptance criteria:
  - 原生不再无同步读取 Rust 可变 winsize；teardown 不释放活跃 native 指针；early detach 不发送未保护的终止信号。
- Verification method:
  - targeted Rust tests、native harness/source gate、重新生成 iOS/Android native libraries 和平台构建。
- Validation evidence: 协调者 cargo test --locked 最终 44/44 通过；MOSH_SAFETY_SANITIZER=thread 和 =address 各 3/3 harness 通过，无 sanitizer diagnostics。三平台 native 脚本成功（simulator/device/Android，v2 符号门禁通过）；重新构建 signed iOS simulator App 与 Android APK 成功。独立 read-only 复审确认三项 FFI 风险及 signal-vs-join 锁序修复。完整 native UDP 运行仍非此 harness 证明。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 跳板与 UDP 参数可配置入口

- Status: done
- Owner: coordinator
- Objective: 让已确认单级跳板与 Mosh UDP 范围不仅原生支持，还能由用户在共享 SSH 配置中设置。
- Inputs and prerequisites: T-002；HostProfileDraft 既有 jump/moshUdpPortStart/End 与既有翻译。
- Scope or files: mobile/src/features/hosts-auth/HostManager.tsx/test；i18n/resources.ts；使用说明。
- Expected output: 排除自身与 Relay 的跳板选择器、成对可选 UDP 参数和直达提示。
- Dependencies: T-002
- Execution steps:
  1. 新增配置回归，验证 V2 HostManager 缺少配置入口。
  2. 复用既有字段/校验，新增控件及 UDP 直达解释。
  3. 跑 focused/full UI tests/build 并重建平台前端嵌入包。
- Acceptance criteria:
  - UI 能保存单级 jump 与 UDP 范围；Relay 不提供；不改变既有认证保存逻辑。
- Verification method:
  - HostManager regression、full Vitest/build、平台包重建。
- Validation evidence: HostManager regression 先因缺失 label 失败，补控件后 focused 9/9 通过；full UI 759/759 与 build 通过。Chrome 320px 真实渲染验证跳板选项仅 Bastion、不含自身/Relay，保存正确 hostProfileId，网络配置截图确认可滚动访问。最终 iOS signed simulator / Android APK 内嵌前端已重建、安装启动。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先按预定 IPC 并行原生与前端单元验证，再由协调者集成复测。原生 fixture 不使用用户凭据与真实远端破坏性操作；仅允许测试账号的 App 命名 tmux。真实远端结束操作由 UI 逐次确认。Mosh 原生仅在 iOS/Android 有效；host 测试不冒充原生 UDP 验证。移动真机与可用工具链先观察再运行；远端装软件/提权/设备凭据授权不在默示权限内。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- SSH 控制命令超时可能结果未知：持久化创建意图、按已知名字检查，禁止静默重复创建。
- Mosh Shell 需要启动 tmux attach 而非另起普通 shell；UDP 参数应传给 mosh-server。
- SSH channel 输出含跨块 UTF-8/二进制 ANSI：保持 bytes，不逐块 lossy decode。
- 停用/删除/改主机身份后不得错误 attach 到另一账号；检查记录绑定。
- 长生命周期与多个异步 connect/unmount 容易泄漏 SSH/Mosh；唯一 connectionId 与明确 cleanup。
- iOS/Android 真机网络验收可能因设备不可用而阻塞，须保留未通过状态。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-13: 检查工作树干净，复核现有 Bridge、SSH、Mosh、MobileTerminal 与主机配置。
- 2026-10-13: 创建执行计划；T-001/T-002 开始，文件归属与 IPC 契约由协调者固定，已派发 native-terminal / terminal-ui。
- 2026-10-13: 环境观察：iOS 26.5 模拟器已启动；实体 iPhone 显示 unavailable，Android adb 无真机。iOS/Android Rust targets 与原生 Mosh archives 存在；本机有 tmux，无 mosh-server。Android SDK 在 /opt/homebrew/share/android-commandlinetools，JDK17 存在；启动 API29 模拟器准备构建运行检查。实体网络验收仍未满足。
- 2026-10-13: 增加 mobile/GENERIC_TERMINAL.md，说明远端安装前提、双用途、tmux 生命周期、UDP/跳板边界和安全限制。
- 2026-10-13: T-001 协调者 host cargo test 42/42 通过。Chrome/xterm fixture 先通过核心 create/restore/detach/fallback/confirmation/bytes/geometry；前端 Modal 改动后的脚本选择器需同步，不属产品失败。
- 2026-10-13: iOS signed simulator archive 与 Android debug APK 均成功，安装启动截图显示非白屏；实体设备 unavailable，真机业务仍未验收。
- 2026-10-13: 独立审查发现旧 Mosh FFI 在启用通用 Mosh 后必须修复的三项 native 安全问题，新增 T-005 派给 native-terminal。重新构建 artifacts/平台包后再作最终验证。
- 2026-10-13: Full Vitest under parallel platform/desktop builds 曾 748/749，GlobalActiveDashboard 1s wait 超时；该文件未修改。先收敛并发独立复测，不改不相关产品代码。
- 2026-10-13: 统一 restart-debug-app.py 构建签名并精确重启 GUI 成功；ps comm 核验新 GUI PID 77184 路径；window_id 1501 截图 /tmp/agentport-generic-terminal-debug-desktop.png 确认正常非白屏，未终止 Host/Connector。
- 2026-10-13: T-002 经协调者复测通过（749 tests / build / Chrome/xterm），进入 T-003。Existing GlobalActiveDashboard 超时仅重并发运行出现；--maxWorkers=2 全通过，未改该测试。
- 2026-10-13: 工作树出现非本任务的 MobileTerminal 键盘按钮改动；terminal-ui 确认非其所有。保留这些改动，提交排除 MobileTerminal.tsx/test/css、test-terminal-touch.mjs 与 i18n 的 session.showKeyboard 两处 hunks。共享文件按 hunk 暂存。
- 2026-10-13: T-005 三平台 native artifacts 已按脚本重新生成，全部成功且 v2 符号门禁通过。协调者再修 signal-vs-join pthread_t 复用竞态（共享 native_join mutex），增加已回收线程不发信号测试；独立审查确认原子几何/启动mask/retaining reaper/锁序无新的 actionable finding。
- 2026-10-13: 最终 host cargo 44/44，TSan/ASan 各 3/3；最终 iOS simulator archive 与 Android APK 重建成功并重新安装启动。T-005 完成，剩余跨层最终验证与真机边界交付。
- 2026-10-13: 收尾检查发现 HostManager V2 仅保留原生 jump/UDP 字段而没有用户设置入口。新增 T-006：回归先在 Single jump host label 缺失处失败（8 passed / 1 failed），然后补共享 SSH 配置中的选择器与成对 UDP 参数；focused 测试/build 运行中。
- 2026-10-13: 并行键盘入口工作已独立提交到 HEAD 4e8a929；本任务 diff 仍独立，仅新增 genericTerminal i18n。最终工作树 full UI 758 tests 和 browser fixture 通过，之后 T-006 新增一项测试待验。
- 2026-10-13: debug GUI 最新 ps PID 84010 精确匹配 checkout 路径；背景截图为黑色，激活精确窗口1520后 /tmp/agentport-generic-terminal-debug-desktop-final.png 正常渲染，未按黑截图判成白屏故障。
- 2026-10-13: T-006 focused/full UI/build、最终 Chrome host配置渲染全部通过；平台包再次重建并安装启动。T-006/T-003 完成。
- 2026-10-13: T-004 已执行设备和本地窗口/产物检查；最后物理 iPhone unavailable、adb仅模拟器。真机/Mosh UDP门禁 blocked，整体 partial；本地已验证实现按仓库规则提交，不发布、不混入另一键盘入口提交。
- 2026-10-13: 已创建 feat(mobile): add generic SSH and Mosh tmux terminals 本地 commit，检查 git show 的24个文件均为本任务，git status 空。该日志随同一提交的文档修订收录；工作流与最终验证仍 partial，不宣称 T-004 真机通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001/T-002/T-003/T-005/T-006 已完成本地实现与质量门禁；原生44/UI759、sanitizers、Chrome/xterm/回归、三平台 Mosh 库、iOS simulator/Android APK 构建启动、版本/快照漂移与 diff 检查通过。T-004 真机业务 gate blocked；已验证代码已本地提交，未发布/推送。
- Limitations: 不把字节 echo PTY 当作真实 Shell/TUI端到端，不把模拟器启动/平台链接当作 Mosh UDP运行证明；没有两端真机切网/后台与移动实际 Mosh 证据。iOS 16最低版本与实体 iOS签名IPA未在本次交付验证。未发布/推送；待设备和目标网络可用后继续 T-004。
