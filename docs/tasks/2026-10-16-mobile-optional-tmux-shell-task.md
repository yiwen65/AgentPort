# Task Plan: Mobile 普通 Shell 默认与可选 tmux

- Created: 2026-10-16
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户明确取消 tmux 硬性要求，选择“默认普通 Shell，tmux 可选”，并确认实施摘要（包含更新本地 iPhone 真机构建）。

<!-- task-doc-section:background-goal -->
## Background and goal

降低通用终端使用门槛：远端只有 SSH 就可直接使用；Mosh 只额外要求 mosh-server 和直达 UDP。tmux 仅作为用户显式选择的持久会话模式，不再自动强制。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 新建默认普通 Shell，支持 SSH/Mosh；可显式选择 tmux。
- 旧 tmux 记录保持原来的 attach/结束语义，不删除、不自动重建。
- 普通 Shell 记录只是快捷入口，不代表远端进程存活。普通 SSH 再次打开明确为新 Shell，不重放历史命令；普通 Mosh 仅在原客户端/会话仍存活时恢复，不保证 App 重启恢复。
- UI 区分普通 Shell 和 tmux 的新建、状态、关闭/删除、重连及 Mosh→SSH 切换语义，不能声称普通 Shell 保持任务运行或恢复原会话。
- 复用原主机信任、凭据、单级跳板、UDP 配置、原生安全生命周期，保留 AgentPort 模式。
- 更新本地 iPhone 真机 archive；如配置可用，使用原有开发签名包装可安装 IPA，不能把旧 IPA 当成新包。不改签名配置，不上传/发布，不自动安装远端软件，不承诺结束普通 Shell 的全部后台子进程。
- 不改首页导航、通用文件管理或其他用户并行修改。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前新建/连接固定创建并检查 tmux | mobile/src-tauri/src/generic_terminal.rs mobile_terminal_create/connect |
| F-002 | 当前记录没有 mode，tmuxSession 为必填字符串 | generic_terminal.rs TerminalRecord；mobile/src/protocol/genericTerminalClient.ts |
| F-003 | 当前普通终端 UI 文案也承诺 tmux 持久性 | mobile/src/features/generic-terminal/GenericTerminal.tsx；i18n/resources.ts |
| F-004 | 存在独立 SSH actor、Mosh Shell bootstrap 原生底座 | generic_terminal.rs ssh_connection；mosh/bootstrap.rs Shell |
| F-005 | 当前 iPhoneOS archive 含通用终端，旧 standalone IPA 不含 | 前轮已直接检查 archive 二进制、前端 asset filename 及 IPA ZIP 内容 |
| F-006 | 开始时存在非任务改动 | git status: docs/tasks/2026-10-13-mobile-immersive-file-reading-task.md、src/src/components/DocumentPanel.test.tsx、src/src/markdown.tsx；均不得修改或提交 |
| F-007 | 用户已确认实现与本地 iPhone 构建授权 | 本轮结构化问题确认“确认并实施” |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 旧记录缺少 mode 时按 tmux 解读；新建请求缺少 mode 时按 shell 解读，使旧数据不丢失且新客户端默认符合新需求。
- Assumption: 继续保存普通终端的名称/主机作为快捷入口，不声称有远端持久会话；用户已接受。
- Assumption: 使用机器现有本地签名配置，不获取新证书或更改团队/profile；如不可用则记录构建阻塞，不绕过签名。
- Open question: 无产品决策待确认；设备/签名环境可用性由检查确定。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 无 tmux 的 SSH fixture 可创建/进入普通 Shell，使用标准 PTY + request_shell，不运行 Bridge/tmux 安装或检查命令；输入/输出/resize 与关闭正确。
- 普通 Mosh 启动默认 Shell，不含 tmux attach/check；已有 UDP 和跳板边界保持。
- 新建默认 shell、tmux 可选；旧记录自动识别 tmux；tmux 缺失错误只作用于选择 tmux 的终端。
- 普通终端再打开/SSH fallback 明确为新 Shell，无静默新建或命令重放；普通记录删除不误杀任何 tmux，不做不必要的远端结束命令。
- 原有信任/原服务器绑定、并发清理、tmux attach/结束回归通过。
- UI/Rust 测试、构建、真实浏览器渲染/交互检查通过；本地 iPhoneOS archive 与可安装 IPA 的内容/签名/有效性分别验证，不把模拟器构建或旧 IPA 当交付。
- 只提交本任务文件；按仓库默认流程精确重启 debug GUI，ps 核验与截图。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-006；T-001、T-002、T-006 → T-003/T-004；T-003、T-004 → T-005。
- Parallel batches: T-001 原生与 T-002 前端按固定 IPC/data 契约并行；稳定源码的 Rust/浏览器检查可与包构建并行，但所有会写 mobile/dist 的前端 build/startup 与 iPhone 构建必须串行。最终提交等待集成与产物验证共同完成。
- Serialization constraints: native-shell 独占 generic_terminal.rs；optional-shell-ui 独占 mobile/src 的本任务前端文件；协调者独占计划、文档、mobile/scripts。不得改锁文件、无关改动、共享签名配置或提交。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 原生普通 Shell 与旧记录兼容

- Status: done
- Owner: native-shell
- Objective: 支持默认 shell/可选 tmux，隔离创建与连接/删除的模式语义。
- Inputs and prerequisites: 既有 SSH/Mosh actor；固定 mode 契约。
- Scope or files: mobile/src-tauri/src/generic_terminal.rs。
- Expected output: mode enum、旧数据兼容、SSH shell request、Mosh 默认 shell bootstrap、plain 删除不远端 kill、回归。
- Dependencies: None.
- Execution steps:
  1. record 缺 mode 默认 tmux，create 缺 mode 默认 shell；plain tmuxSession 空字符串。
  2. 按 mode 路由 SSH Shell/Mosh Shell 与 tmux attach；保留信任、身份绑定和 cleanup。
  3. 验证无 tmux fixture 和 legacy tmux 回归。
- Acceptance criteria:
  - 普通路径无 tmux/Bridge 调用；旧 tmux 行为不回退；不重放命令。
- Verification method:
  - cargo test --manifest-path mobile/src-tauri/Cargo.toml --locked；真实 russh fixture。
- Validation evidence: 协调者 PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path mobile/src-tauri/Cargo.toml --locked 全通过71 tests。新增 no_tmux_shell_routes_preserve_bytes_resize_and_delete_locally 在服务端明确拒绝 tmux 的 fixture 中测试实际 production actor；旧 tmux isolated fixture 仍通过。检查 mode 双默认值、local-only delete 与 late-register fence。后续独立审查的拒绝响应/并发创建问题单列 T-006 修复。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 模式选择与诚实的普通 Shell 生命周期 UI

- Status: done
- Owner: optional-shell-ui
- Objective: 默认普通 Shell、tmux 显式可选，消除持久恢复误导。
- Inputs and prerequisites: 固定模式数据契约；既有 GenericTerminal UI 与 cleanup gate。
- Scope or files: mobile/src/features/generic-terminal/、protocol/genericTerminalClient.ts、platform/tauriGenericTerminalClient.ts/test、i18n/resources.ts、相关 App tests。
- Expected output: 模式选择、plain/tmux 区别文案、显式新 Shell/SSH切换确认、旧记录回归与组件测试。
- Dependencies: None.
- Execution steps:
  1. 默认 shell 新建，可选 tmux；record mode 缺失按 tmux 兼容。
  2. 普通关闭/删除/重新打开说明不保证持久性；切换 SSH 需明确新 Shell，不标为接回原终端。
  3. 测试 default/plain、legacy/tmux、无自动重放和迟到连接清理。
- Acceptance criteria:
  - 未选 tmux 不出现安装硬阻塞；所有持久化承诺均只出现在 tmux 模式。
- Verification method:
  - npm test -- --maxWorkers=2；npm run build。
- Validation evidence: 子任务59 files/939 tests、tsc/Vite通过；协调者 full UI/build/test:startup 重跑成功（终端仍deferred），Chrome/xterm默认Shell、legacy tmux、重新启动新Shell、关闭/删除/SSH切换确认与取消通过。普通Mosh文案仅声称客户端运行中，不声称 UDP已连接。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成、浏览器验收与说明更新

- Status: done
- Owner: coordinator
- Objective: 检查跨层 mode 默认/旧数据、真实渲染与回归，更新用户说明。
- Inputs and prerequisites: T-001/T-002 输出完成并审查。
- Scope or files: mobile/GENERIC_TERMINAL.md、README.md、scripts/test-generic-terminal.mjs 及必要集成修正。
- Expected output: 可复现 native/UI/browser 验证，普通 Shell 与 tmux 文档。
- Dependencies: T-001, T-002, T-006
- Execution steps:
  1. 审查 IPC、数据迁移与两模式语义；独立 read-only 检查安全生命周期。
  2. 更新 browser fixture，验证默认普通 Shell、显式新 Shell、tmux 恢复不创建。
  3. 更新使用与验收说明。
- Acceptance criteria:
  - 有证据覆盖无 tmux 普通路径，且旧 tmux 回归通过；文案无错误持久性承诺。
- Verification method:
  - full Mobile Rust/UI tests、Vite、Chrome/xterm fixture、diff review。
- Validation evidence: 协调者最终 Rust75/75、UI59 files/941 tests、tsc/Vite/test:startup 全通过；终端仍deferred。Chrome/xterm实测默认普通Shell、新Shell再打开/删除、关闭确认、Mosh→SSH新Shell确认/取消与detach顺序、旧tmux恢复、bytes/input/geometry/320px暗亮主题/host设置通过，截图在/tmp/agentport-optional-shell-evidence。独立审查的两问题经确定性fixture先失败后修复，连续复审无剩余actionable finding。README与使用说明已更新。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 本地 iPhone 真机构建与验证

- Status: done
- Owner: coordinator
- Objective: 真机 archive 包含新模式，现有签名可用则包装新 IPA，明确安装/运行证据边界。
- Inputs and prerequisites: T-003；现有 iOS Mosh v2 archives 与本机开发签名。
- Scope or files: 本地忽略的 iOS 构建产物；使用既有构建/包装脚本。
- Expected output: 新 iPhoneOS archive、可用时新 IPA、签名与嵌入资源检查。
- Dependencies: T-001, T-002, T-006
- Execution steps:
  1. 检查当前签名/profile与构建入口，只使用既有配置，不改团队或密钥。
  2. 生成真机 archive，验证平台、签名、原生 mode/前端资源均为新版本。
  3. 现有注册设备信息可用时包装本地 IPA，拒绝沿用旧包；可用模拟器/设备做启动渲染检查。
- Acceptance criteria:
  - 不把 Simulator/旧 IPA 当新 iPhone 构建；签名不可用则明确 blocked 不绕过。
- Verification method:
  - Tauri iOS build --archive-only；codesign；package-ios-development.py；资源 marker/hash；可用设备 screenshot。
- Validation evidence: 最终串行运行官方 build-ios-personal-team.sh 完成iPhoneOS archive与开发IPA；wrapper两次验证codesign/profile/证书/arm64 IOS平台/Scene manifest/ZIP往返，SHA256SUMS通过。验证最终archive与canonical IPA主程序SHA相同，含ssh_pty_rejected/ssh_shell_rejected修复marker及GenericTerminal-BB8KJDmc.js（普通Shell/tmux选择器）。IPA: mobile/src-tauri/gen/apple/build/arm64/AgentPort.ipa；SHA256 c47f43e8087c7691c36cb7eaf3ffad64e46b37ea625b71db055b06735d2d6a12。私有manifest在/Users/w/AgentPort-private/iphone-optional-tmux-20261016-184717/，profile有效至2027-09-23，验证1个既有注册设备。旧archive/IPA保留备份；未更换签名、未上传、未覆盖安装手机。启动渲染由Chrome真实生产组件与桌面debug截图覆盖，不冒充iPhone运行证据。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 最终验证、debug 窗口与提交

- Status: done
- Owner: coordinator
- Objective: 本地可验证门禁完成后只提交本任务，准确交付构建与剩余限制。
- Inputs and prerequisites: T-003；T-004 已有构建证据或明确 blocker。
- Scope or files: 当前计划、任务相关文件；统一 debug GUI 重启。
- Expected output: 任务限定 Git commit、ps/截图、最终报告。
- Dependencies: T-003, T-004
- Execution steps:
  1. 运行相关版本/快照/diff/计划门禁。
  2. 统一脚本重启精确 debug GUI，不关闭 Host/Connector，核验截图。
  3. 检查 staged scope，只提交任务改动。
- Acceptance criteria:
  - 不混入初始无关修改，不发布/推送，不虚构真机网络验收。
- Verification method:
  - check-version-sync.sh、build-terminal-snapshot.mjs --check、task_document.py validate、git diff --check、git show、ps/screenshot。
- Validation evidence: 版本/terminal snapshot/计划验证/diff门禁通过。统一debug构建签名精确重启、ps路径与激活截图非白屏通过。已创建 feat(mobile): make tmux optional for generic terminals 本地commit，核验11个文件均属本任务，未含既有其他任务文档；工作树仅剩该无关文档修改。提交后只修订当前计划完成状态并收录同一提交；无发布/推送/手机覆盖安装。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — SSH 请求拒绝与 tmux 创建/结束并发修复

- Status: done
- Owner: native-shell
- Objective: 独立审查发现的真实拒绝响应和 remote create/end 竞态不能随本功能交付。
- Inputs and prerequisites: T-001；审查观察 request_shell 仅入队、actor忽略Failure，以及创建意图先保存后远端执行。
- Scope or files: mobile/src-tauri/src/generic_terminal.rs。
- Expected output: 有界等待 PTY/Shell/exec 成功，保留早期输出；每记录 create/end 串行与有界生命周期gate；确定性回归。
- Dependencies: T-001
- Execution steps:
  1. fixture拒绝PTY/Shell但不关闭channel，证明旧逻辑误报ready，再修复响应等待。
  2. 暂停tmux create，发起End，再释放create，证明End不先删除记录/遗漏新会话。
  3. 跑focused/full native tests，稳定后协调者重新生成最终iPhone包。
- Acceptance criteria:
  - 拒绝时不注册空白可输入终端；并发End不先成功删除待创建会话记录。
- Verification method:
  - deterministic russh fixture、gate concurrency test、full Cargo suite、独立复审。
- Validation evidence: 先复现PTY拒绝仍ready和真实isolated tmux create/end孤儿会话两次预期失败；修复后11 focused native tests通过，覆盖3类拒绝/提前关闭、early PTY/Shell bytes、Weak gate清理与暂停创建/并发结束。协调者最终cargo test --locked 75/75通过；源码复审等待显式Success/Failure且保留有界early bytes，Weak-pruned lifecycle门覆盖意图发布到结果并与End共享，无锁序问题。UI增加2项服务器拒绝后input inert测试。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

原生与前端先按 mode 契约分头验证，再真实浏览器集成。原生 fake SSH server 应明确拒绝 tmux，标准 Shell 请求仍成功；不使用用户密码或远端安装。旧存储 JSON 无 mode 应读为 tmux，新请求无 mode 应选择 shell。plain end 只断开/删除本地入口，不用 SSH 登录执行远端 kill。Mosh 普通路径只启动 mosh-server 默认 Shell；没有真实 UDP/真机条件时明确运行未验收。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 旧记录默认值与新建默认值不同，必须分别编码/测试，不能用同一 serde default 错把旧 tmux 改为 shell。
- 普通 reconnect/Mosh→SSH 若仍显示“恢复同一终端”会误导并可能导致用户丢失任务，必须明确新 Shell。
- plain 删除不可根据旧 tmuxSession 误杀远端；不承诺杀掉 nohup/disown 等后台任务。
- 异步切换仍需 detach gate，不能向旧连接写入或创建重复连接；不扩展自动重连。
- 工作树已有三项无关修改，构建可读取它们但提交必须严格隔离。
- iPhone 签名/profile/设备可能不可用，不改签名配置或自动注册新设备绕过。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-16: 用户确认默认普通 Shell、tmux 可选与本地 iPhone 真机构建；仅保留普通记录作为快捷入口。
- 2026-10-16: 复核当前原生/前端仍强制 tmux；旧记录无 mode。记录三个既有无关修改，保留不动。T-001/T-002 开始，固定 mode/legacy 契约后并行实施。
- 2026-10-16: T-001/T-002 核心完成并经协调者重跑native71/UI939/build/startup及真实Chrome/xterm。进入T-003集成；文档已更新，普通Shell记录为快捷入口，旧tmux兼容。
- 2026-10-16: 当前物理iPhone可见、Android无设备；现有iPhoneOS开发profile有效至2027-09-23、2个注册设备，无需更改签名。官方build-ios-personal-team.sh创建第一轮archive与验证IPA成功；旧archive/IPA均改名保留，新IPA同步常规arm64/AgentPort.ipa，未覆盖安装手机、未上传。
- 2026-10-16: 第一轮打包时UI build与Tauri beforeBuild都写dist；因此最终包重建须在所有前端build/startup结束后串行进行，并核验嵌入资产名，不把第一轮包作为最终交付。
- 2026-10-16: 独立read-only审查指出PTY/Shell拒绝被忽略导致空白ready，以及tmux create/end可形成孤儿会话；新增T-006由native-shell以确定性fixture修复。第一轮archive已完成，源文件解除构建冻结，最终需重建。
- 2026-10-16: 统一restart-debug-app.py构建签名并精确重启成功；最终ps GUI PID21306精确匹配checkout路径，窗口2002激活后/tmp/agentport-optional-shell-debug.png非白屏，未查杀Host/Connector。保留无关工作树改动。
- 2026-10-16: T-006先复现两项预期失败后修复；协调者最终Rust75/75，UI941/941/build/startup和Chrome fixture通过。T-003/T-006完成。最终iPhone构建在所有dist写入检查结束后串行启动。
- 2026-10-16: 最终iPhoneOS archive/开发IPA成功，codesign/profile/ZIP往返/hash通过；核验新native拒绝错误marker与GenericTerminal-BB8KJDmc.js嵌入。常规arm64/AgentPort.ipa已更新且保留旧包；T-004完成。手机可见但未获覆盖安装授权，未安装/运行或发布。
- 2026-10-16: 进入T-005：diff/版本/terminal snapshot/计划验证已通过，准备只提交任务文件，排除既有用户文档改动与平台生成ACL漂移。
- 2026-10-16: 新增一条经过两项失败/修复回归验证的项目经验（LEARNS.md），记录SSH入队不等于接受、创建意图不等于远端完成。生成ACL仅因iOS target移除了Android screen-rotation条目，已恢复原HEAD，不入提交。
- 2026-10-16: 最终IPA SHA256 c47f43e8087c7691c36cb7eaf3ffad64e46b37ea625b71db055b06735d2d6a12，常规构建路径已更新；开发profile原有效期保留至2027-09-23，无签名配置改动。
- 2026-10-16: 本地feature commit已创建且只含本任务11文件，工作树保留其他任务文档修改；T-005完成。此完成记录随同一feature提交的文档修订收录。未上传/推送、未覆盖安装手机。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001～T-006 本轮授权的本地实现/验证/签名构建/提交交付均已完成。最终 native75、UI941、startup graph、Chrome fixture、签名/ZIP/hash/嵌入资产与 diff/版本/快照/计划门禁通过。已提交本任务11个文件，没有混入其他工作；passed指本轮代码与本地构建验收，不宣称真机网络业务已测。
- Limitations: 本轮交付为代码与本地签名 iPhoneOS archive/IPA，未覆盖安装手机、未发布/上传，实际 Mosh UDP、手机业务、蜂窝切网和系统冻结未在本轮重测；不把 host echo/handshake fixture、Chrome 或签名成功当作真机网络证据。Android 本轮无设备，未更新其安装包。
