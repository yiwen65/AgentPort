# 本 Mac TestFlight 审核环境与自助配对入口

- Created: 2026-09-09
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户确认独立标准测试账号、文件隔离、受保护配对网页和仅供网页的 HTTPS 公网入口；系统授权、费用另行确认。

<!-- task-doc-section:background-goal -->
## Background and goal
让 Apple 外部测试审核员无人值守连接本 Mac 上的演示 Host，不依赖提交后即过期的二维码，不暴露私人工作环境。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
复用桌面程序、Relay 和手机粘贴配对码功能。隔离演示账号；受保护入口按需生成短期码；验收外网连接、限流和撤销。
不停止现有 Host/Session，不开放 SSH，不复制私人凭据，不购买服务，不使用子代理。用户后续明确授权提交 TestFlight 外部测试审核；不包含 App Store 公开发布。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 邀请有效期 120 秒，一次性自动授权 | crates/agentport-relay/src/protocol.rs、connector/ipc.rs 的 InviteAutomatic |
| F-002 | 手机支持粘贴配对码；已上传包包含 Relay | mobile/src/features/hosts-auth/PairDevice.tsx；此前 archive 二进制检查 |
| F-003 | 数据目录按 HOME，socket 按 UID 隔离 | crates/agentport-core/src/paths.rs |
| F-004 | 当前 Mac 未发现 Relay 服务端，仅 connector 连接配置的外部 WSS 域名 | ps/lsof、只读取 state.json 的公共端点字段；不修改原 Relay |
| F-005 | Tailscale 在线，当前无 serve/funnel 配置 | tailscale status --json、serve status、funnel status |
| F-006 | 无无交互 sudo 授权 | sudo -n true 返回 a password is required |
| F-007 | 主目录的组权限允许遍历，独立账号不等于文件隔离 | stat；当前账号属于 staff；测试账号需负向访问验证 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- Assumption: Tailscale Funnel 可用于审核 HTTPS；待账户能力及真实外网测试验证。
- Open question: 系统管理员授权如何完成；不可在聊天获取密码。
- Open question: 专用演示 agent 是否需服务凭据；不得复用个人凭据，先保留 Shell 演示。
- Resolved: 用户已在 App Store Connect 填写审核联系人和反馈邮箱；不在仓库记录个人联系方式。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- 私人目录、数据库和凭据不可由测试账号读取；原 Host/Session 持续运行。
- 审核员用专用凭据登录 HTTPS 页面，获取短期码并用现有 App 配对。
- 未认证、过期、重放与超限访问被拒；离线明确报错；凭据不进入 URL/日志。
- 可关闭入口并撤销设备；蜂窝或独立外网验证成功才交付。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
- Dependency graph: T-001 -> T-002 -> T-005；T-001 -> T-003；T-002、T-003、T-005 -> T-004。本机服务代码测试不依赖已部署账号，部署和真机验收需完整依赖。
- Parallel batches: 无；用户禁止子代理，串行执行。
- Serialization constraints: 系统账号、网络入口与服务配置依次变更；保留现有未提交文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 验证入口和系统权限
- Status: done
- Owner: coordinator
- Objective: 在开发部署前确认 HTTPS 可行性与管理员授权。
- Inputs and prerequisites: 用户明确允许独立 HTTPS 公网入口。
- Scope or files: Tailscale 状态、仅返回无敏感测试值的临时探针、系统权限检查。
- Expected output: 可行性证据和必要授权步骤。
- Dependencies: None.
- Execution steps:
  1. 检查已有配置，验证 Funnel 能力；探针结束清理。
  2. 确认账号创建权限，不索取聊天密码。
- Acceptance criteria:
  - HTTPS 路径可用且不影响现有入口，系统授权可执行。
- Verification method:
  - 状态检查、外网 HTTPS 请求、sudo 权限检查。
- Validation evidence: 用户已启用 Funnel；临时仅 /healthz 探针在 HTTPS 443 经现有代理和默认网络均返回预期内容；退出后 No serve config。8443 曾超时，不使用该结果宣称外网不可达。sudo -n true 被拒；用户允许系统弹窗，但 osascript 等待 180 秒超时，账号/组/密码文件均未创建。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 隔离演示账号与桌面 Host
- Status: done
- Owner: coordinator
- Objective: 提供与个人工作环境分离的演示桌面。
- Inputs and prerequisites: 系统管理员授权和 T-001 通过。
- Scope or files: 新标准账号、共享只读程序副本、演示数据、针对该账号的文件访问限制。
- Expected output: 独立可运行 Host，权限负向测试通过。
- Dependencies: T-001.
- Execution steps:
  1. 创建标准账号，不授予管理员、SSH 或共享访问权限。
  2. 安装程序副本、创建无私人信息演示项目并验证 HOME/UID/socket 隔离。
  3. 检查文件访问边界；不安全则暂停，不宣称为沙箱。
- Acceptance criteria:
  - 测试账号无法访问个人数据，演示 Host 可运行。
- Verification method:
  - 以测试 UID 验证允许/禁止路径，检查进程和 socket。
- Validation evidence: 用户执行补齐脚本后 UID/GID 均为 550、主目录 0700；主目录 /Users/w 存在针对测试账号的 deny ACL。实际 su 登录成功，test ! -r 私人 .ssh 和 agentport.db、test -x 程序通过。独立程序副本 root:wheel、不允许 group/other 写、codesign 验签通过。建立独立演示 Keychain、Review Demo 项目和 Review Terminal；CLI session status 确认 demo Host 11271、running，cwd 和数据路径均在测试 HOME。共享系统不构成完整沙箱，公共系统资源仍可见。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 受保护的按需配对服务
- Status: done
- Owner: coordinator
- Objective: 提供无需人工刷新审核备注的短期配对入口。
- Inputs and prerequisites: T-002 的独立 connector。
- Scope or files: 独立网页服务与测试、局部运维说明；不修改配对协议有效期。
- Expected output: 有认证、限流、截止日期和安全响应头的网页服务。
- Dependencies: T-001.
- Execution steps:
  1. 复用 InviteAutomatic，仅允许操作演示 connector，不暴露通用 IPC。
  2. 实现认证后显式生成、并发控制、离线处理、no-store 和不记录敏感正文。
  3. 测试拒绝路径和短期码单次消费；配置仅回环监听及 HTTPS 转发。
- Acceptance criteria:
  - 手机原版可粘贴配对；匿名和超限用户无法发码，凭据不泄露。
- Verification method:
  - 单元/集成安全测试、实际配对验证。
- Validation evidence: mobile/scripts/test-review-gateway.py 当前 23 项测试通过，覆盖真实同 UID Unix IPC、认证/CSRF/Origin/Host/正文大小/限流/离线/配对预算持久化/不确定写不重放/路径权限/错误 Relay 地址/撤销竞态。公网代理链实测匿名 401、认证 GET 200、CSRF POST 200、no-store、120 秒新码。loopback 到公开 WSS 地址映射不改变 host/key/id/PSK/TTL。用户浏览器首次请求 Origin:null 被拒，临时仅元数据诊断证实；改 Referrer-Policy 为 same-origin 后新码生成、用户设备 approved 且 activeChannels=1，Origin/CSRF 校验未放宽。临时诊断已移除。
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 外网验收和交付
- Status: blocked
- Owner: coordinator
- Objective: 验证无人值守审核流程并安全交付。
- Inputs and prerequisites: T-003 通过、可用独立外网设备。
- Scope or files: HTTPS 入口、演示 Host、审核使用说明和关停流程。
- Expected output: 配对/重连/撤销证据、用户可填写的审核备注。
- Dependencies: T-002, T-003, T-005.
- Execution steps:
  1. 从蜂窝或独立外网测试认证、取码、终端操作和重连。
  2. 验证凭据截止不等于设备自动失效，实际撤销已配对设备。
  3. 验证持续联网方案并交付；提交审核仍由用户决定。
- Acceptance criteria:
  - 真实外网闭环通过；关停和设备撤销有效；个人 Session 未受影响。
- Verification method:
  - 真机测试、权限复核、关闭入口/撤销测试。
- Validation evidence: 用户设备已配对并建立演示通道（devices=1, activeChannels=1）；用户随后确认正常并授权提交，但未明确蜂窝或独立外网条件。临时原生 Rust 身份完成实际配对、连接、仅撤销自己、原连接关闭、重连被拒；原用户设备数保持 1，不影响其授权。关闭任务独占的 Funnel 443 两条路由后 No serve config，公网探针不能访问；恢复存在约数十秒传播延迟，随后 HTTPS 匿名 401 正常。已有 Mac 主 GUI/connector 未重启；未终止任何 Host。测试账号已启用仅接通电源有效、截至网页有效期的 caffeinate 断言；不覆盖合盖或重启。
- Blocker: 蜂窝或独立外网测试条件尚未明确；不再阻塞用户已授权的审核提交。
- Unblock condition: 补充独立网络条件证据。终端正常确认、联系信息补齐与审核提交均已完成。

### [x] T-005 — 独立演示 Relay 与公网 WSS 路由
- Status: done
- Owner: coordinator
- Objective: 不向审核账号暴露现有 Relay 的服务级注册令牌。
- Inputs and prerequisites: 用户明确允许新建独立 Relay 与演示 WSS 路由；T-002 的账号。
- Scope or files: 新 token、测试账号 relay 进程、仅演示域名的 /v1/relay Funnel 路由。
- Expected output: 独立 Relay、connector connected、TLS WebSocket 路由可达。
- Dependencies: T-002.
- Execution steps:
  1. 在测试 HOME 生成全新 0600 注册令牌，启动回环 Relay。
  2. Connector 使用回环端点；网页公布同一 Relay 的 WSS 入口，不依赖 Mac 自己绕回公网。
  3. 验证连接状态和 WSS Upgrade，不修改原 Relay。
- Acceptance criteria:
  - 无原令牌复制，独立 connector connected，WSS 返回 101。
- Verification method:
  - 审查 bootstrap 脚本、native IPC status、经 TLS 代理的 WebSocket Upgrade。
- Validation evidence: 临时 bootstrap 使用 secrets.token_hex(32) 创建专用 token；原 Keychain/注册令牌未读取。demo connector configure 后 connected；HTTPS /v1/relay 的 Upgrade 返回 101 Switching Protocols。原 Relay 配置未改。手机实际握手属于 T-004。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Linux 独立部署与恢复验证
- Status: done
- Owner: coordinator
- Objective: 将审核演示服务迁移至全天在线 Linux，不再依赖工作 Mac。
- Inputs and prerequisites: 用户提供 FRP SSH 入口并明确授权迁移及 sudo；只读检查确认 Ubuntu 24.04 x86_64、Docker/Rust/DBus/Secret Service 依赖、Tailscale Funnel 能力。
- Scope or files: review_gateway.py 的 Linux peer 校验、回归测试、专用隔离容器与演示数据、启动与恢复脚本；不修改既有 FRP 和业务服务。
- Expected output: 原生 Linux CLI/Host/connector/Relay、受保护 HTTPS 配对入口与自动恢复。
- Dependencies: T-003, T-005.
- Execution steps:
  1. 适配并测试 Linux 同 UID peer 校验，构建原生组件。
  2. 使用无私人挂载、无 Docker socket、非 root 的专用容器运行演示与独立 Secret Service；仅回环发布服务端口。
  3. 验证公网认证/配对/终端及容器重建恢复，确认原服务不受影响。
- Acceptance criteria:
  - Linux 真实握手和终端可用，独立身份持久化，自动恢复配置生效；私人数据不挂入演示环境。
- Verification method:
  - 双平台 gateway 测试、native build、容器配置检查、公网与原生连接探针、任务容器恢复测试。
- Validation evidence: macOS/Linux gateway 各 25 项测试通过；Linux CLI/Host/connector/Relay/remote-bridge 构建成功。独立容器 UID/GID 1550、只读 rootfs、cap-drop ALL、no-new-privileges、1GB/1CPU/pids256，仅挂专用 HOME 卷且宿主仅回环发布端口。私有 DBus/Secret Service 持久化正常：创建任何 Host 前，用 acceptance-no-shell 标记启动、配对临时身份，然后移除标记并仅重启该新容器；原身份可经公网 WSS 重连，自动创建 running Review Terminal。最终原生探针等待真实 Result（不是 Accepted），验证 project.list/session.list/attach/input/poll/detach，输出 LINUX_REVIEW_OK。仅撤销探针自己的身份后公网重连返回 Unauthorized，剩余设备 0。docker/tailscaled enabled，restart unless-stopped；未重启整台 Linux。原有三个业务容器仍 Up 3 weeks。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 审核入口切换与 Mac 退役
- Status: done
- Owner: coordinator
- Objective: 让审核员使用 Linux，并解除工作 Mac 在线要求。
- Inputs and prerequisites: T-006 通过。
- Scope or files: 已提交 build 0.1.0 (1) 的审核说明、任务专属公网路由和配对授权。
- Expected output: ASC 新入口保存验证，Mac 演示入口停止；原 Host/Session 均不终止。
- Dependencies: T-006.
- Execution steps:
  1. 验证 ASC 等待审核时是否可编辑说明；不可编辑则暂停切换，不擅自撤回审核。
  2. 更新新 HTTPS 地址，保留专用网站登录并验证保存。
  3. 关闭仅任务所有的 Mac 公网路由并撤销旧演示设备，不杀任何 Host。
- Acceptance criteria:
  - 审核资料指向已验收的新入口；Mac 不再承担审核流量。
- Verification method:
  - ASC 保存后重新读取、HTTPS/WSS 探针与旧入口关闭确认。
- Validation evidence: ASC build 0.1.0 (1) 仍 Waiting for Review；What to Test 更新为 https://<review-host>.ts.net，专用网站账号不变。Save 显示 Saved，刷新页面后通过 Chrome AXTextArea 重新读取并与预期 1230 字符说明精确比较通过；未撤回审核。确认 Mac Funnel 443 仅有任务两条路由后关闭，No serve config、旧 HTTPS 探针 000；撤销旧演示设备 1→0。仅停止 Mac 的任务 gateway 和 caffeinate，未停止任何 Host/原有 Session。Linux HTTPS 匿名 401、connector connected，旧 Mac 不再承担审核流量。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan
先验证入口及权限，再隔离负向测试，然后服务安全测试，最后真实外网完整闭环。不用仅在本机 curl 的结果代替外网验收。仅将本任务文件加入提交。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
标准账号不是完整沙箱；组权限、共享目录、其他用户服务必须检查。Funnel 可能要求管理员开启账户能力，未知可达性和审核地区网络条件。不保证 Apple 接受此审核方案。不能在审核备注放长期 Relay 注册令牌或私人凭据。

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-09-09 17:41 CST: 用户明确要求撤回并重新提交，以避免旧审核资料快照仍指向 Mac。执行 Remove from Review 后，external 组确认 0.1.0 (1) 为 Ready to Submit；从 external 组移除再重新添加同一构建（未 Expire Build，未重传 IPA）。提交前核对 Linux URL、120 秒配对步骤，并通过 AX 在内存中比较审核登录字段与专用网站凭据（只输出匹配布尔值，不输出密码）。重新 Submit for Review 后确认 external 组 1 Build、0 Testers，0.1.0 (1) 再次 Waiting for Review。Linux HTTPS 匿名 401 正常，Mac 无需恢复入口。
- 2026-09-09: T-006/T-007 done。Linux 独立运行及公网终端闭环通过，容器恢复与配对持久化通过；已将 ASC 审核说明切换到 Linux 并刷新重读验证，未撤回 Waiting for Review。旧 Mac 公网入口关闭、旧设备撤销，仅停止任务网页与防睡眠进程。T-004 保留手机网络条件的历史验收缺口，不阻塞用户已授权的迁移；不宣称本次完成 iPhone 蜂窝实测。
- 2026-09-09: 用户确认演示正常并补齐联系信息，已授权提交且 ASC 显示 Waiting for Review。随后提供 Linux FRP SSH 入口；只读检查通过，用户明确授权执行迁移。T-006 in_progress，T-007 pending；不更改现有业务服务，不重启 Linux 整机，不撤回 Apple 审核。
- 2026-09-09: 用户确认实施；串行执行。T-001 开始：Tailscale 在线但无入口；非交互 sudo 不可用。
- 2026-09-09: T-001 blocked。原生 Funnel CLI 确认 tailnet 未启用功能，已提供官方启用页面；探测退出，No serve config，无对外服务。等待用户完成账户和系统授权。
- 2026-09-09: 用户启用 Funnel，443 探针经两条本机出口返回预期内容；已撤销临时配置。用户允许管理员弹窗，但调用 180 秒超时；未创建任何账号/组/密码。提供 /tmp/agentport-create-review-account.py 供用户在终端 sudo 执行；仅通过 py_compile，实际创建尚未验证，不算完成 T-002。
- 2026-09-09: 用户表示创建完成；检查实际状态发现部分创建（UID 550/GID 20、主目录缺失）。T-001 done（已验证 HTTPS、用户可本机 sudo）；T-002 blocked。提供幂等补齐脚本 /tmp/agentport-complete-review-account.py，等待用户系统授权，不重复运行创建账号脚本。
- 2026-09-09: 补齐后实际 su 权限负向测试通过，建立隔离演示数据和 running Shell Host，T-002 done。
- 2026-09-09: 发现原 Relay 使用服务级 token，用户新增明确授权：独立演示 Relay 与 WSS 路由。新增 T-005；不读取原 token。
- 2026-09-09: T-003 开始实现测试。调整依赖：本机纯代码测试可在隔离部署之外执行，最终部署/手机验收依赖所有前置。
- 2026-09-09: 20 项 gateway 测试通过；独立回环 Relay、connector、gateway 运行。Mac 自己连接公开 WSS 不稳定，采用标准内部回环/外部 TLS 分离地址，仅映射二维码的公开地址，身份和短期密钥不变。T-005 done。
- 2026-09-09: 公网 HTTPS 认证和发码验证通过；用户已获本机私有 website-access.txt 用于验收（未提交 Apple）。旧 iPhone Web Inspector 虚拟环境不存在，已请用户用蜂窝网络测试。
- 2026-09-09: 用户报告 Invalid request origin。捕获 Origin:null、无同源 Referer；根因是 no-referrer 与严格表单 Origin 校验冲突。新增响应策略回归先失败，改 same-origin 后通过。用户重试使发码计数 1→2，随后 devices=1/activeChannels=1。禁止 null Origin 和 CSRF 校验均保留；T-003 done。
- 2026-09-09: 当前 23 项测试通过。独立原生撤销探针验证成功，不撤销用户手机；探针私钥确认撤销后删除，临时示例源码已移出仓库。新增本地 review_access_control.py，不对 HTTP 开放管理操作。
- 2026-09-09: 公网入口关停/恢复已测试；恢复有传播延迟，之后 HTTPS 401 恢复。用户手机授权仍保留，可刷新重连。T-004 blocked，等待用户确认终端显示/输入及网络条件。
- 2026-09-18: 为 build 0.1.0 (3) 的外部审核续期审阅入口。网站访问已于 2026-09-16 16:40:22 CST 到期（网关按 `now >= expires_at` 返回 410，Tailscale Funnel 路由本身未动）。在容器卷内将 `expires_at` 由 2026-09-16T08:40:22Z 延长至 2026-09-25T03:27:35Z（+7 天），`max_devices=3`、`max_invitations=30` 与已用发码预算不变，旧配置备份为卷内 `gateway.json.bak-20260918032735`；重启容器加载新配置（此前 devices=0、activeChannels=0，无在途配对，未打断任何 Host/Session）。验证：匿名 HTTPS 401、错误凭据 401、Basic 认证 GET 200（含 CSRF）、`POST /invite` 200 且 connector 进入 `pairingPhase=waiting`、公网 `/v1/relay` 真实 WebSocket 握手 101。发码预算 1→2，设备仍为 0（邀请 120 秒后自然过期，未产生新配对）。若 2026-09-25 仍未完成审核，按同一方式再次延长；结束审核时按 `mobile/REVIEW_ACCESS.md` 先 `revoke-all` 再只移除任务自有的 Funnel 路由。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: partial
- Evidence: T-001、T-002、T-003、T-005 通过；gateway 23 项测试、用户配对/连接、独立身份实际撤销和公网入口恢复均有证据。用户确认正常后明确授权审核提交，并自行补齐联系信息。2026-09-09 16:03 CST，App Store Connect external 组显示 1 Build，0.1.0 (1) 为 Waiting for Review；尚非审核通过。
- Submission details: 补齐英文 Beta App Description、What to Test（含 HTTPS 入口和 120 秒粘贴配对流程），专用网站账号只填入 Sign-In Information。电话按 Apple 错误提示补中国 +86 国际格式后提交成功。未提供 macOS 密码、私人 Host 或 Relay token；未开启公开邀请链接，组内仍为 0 Testers。提交前 demo connector connected、HTTPS 匿名 401。
- Resubmission result: 用户随后明确授权撤回并重新提交；2026-09-09 17:41 CST，已使用 Linux 审核说明和核对过的专用网站凭据重新提交同一 build 0.1.0 (1)，状态 Waiting for Review。不是审核通过，可能重新排队。
- Migration result: T-006、T-007 已完成。Linux 入口 https://<review-host>.ts.net 已保存到 Apple 审核说明；原公网 WSS 端到端探针验证真实终端输出，容器重启后配对身份保留。Mac 可正常休眠/关机，不再承担审核环境服务。部署目录为 Linux 的 ~/agentport-review-deploy，容器 agentport-review-linux，持久化卷 agentport-review-home；操作说明见 mobile/scripts/review-linux/README.md。
- Limitations: T-004 仍未明确原 iPhone 蜂窝网络条件，本次 Linux 由 Mac 经公网 HTTPS/WSS 进行原生端到端验收，不宣称新的真机蜂窝测试。已提交的是 Apple 外部测试审核而非公开发布。Linux Docker/tailscaled 已启用开机启动，容器恢复已测，未整机重启（避免打断现有服务）。新网页有效期至 2026-09-16 16:40:22 CST，最多 3 个设备、30 次发码尝试；需在审核延迟时人工续期。已配对设备不会因网页过期自动撤销。旧手机 Mac 配对已撤销，测试新环境须重新取码配对。
