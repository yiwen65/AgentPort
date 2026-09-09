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
不停止现有 Host/Session，不开放 SSH，不复制私人凭据，不购买服务，不自动提交审核，不使用子代理。

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
- Open question: 审核联系人、反馈邮箱尚未提供。

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
- Validation evidence: 用户设备已配对并建立演示通道（devices=1, activeChannels=1），但蜂窝条件与终端显示/输入仍待用户明确确认。临时原生 Rust 身份完成实际配对、连接、仅撤销自己、原连接关闭、重连被拒；原用户设备数保持 1，不影响其授权。关闭任务独占的 Funnel 443 两条路由后 No serve config，公网探针不能访问；恢复存在约数十秒传播延迟，随后 HTTPS 匿名 401 正常。已有 Mac 主 GUI/connector 未重启；未终止任何 Host。测试账号已启用仅接通电源有效、截至网页有效期的 caffeinate 断言；不覆盖合盖或重启。
- Blocker: 等待用户确认演示终端可显示/输入及测试网络；审核联系人和提交资料尚未齐备。
- Unblock condition: 用户完成真机确认并补齐联系信息；再交付审核备注，不自动提交。

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

<!-- task-doc-section:validation-plan -->
## Test and validation plan
先验证入口及权限，再隔离负向测试，然后服务安全测试，最后真实外网完整闭环。不用仅在本机 curl 的结果代替外网验收。仅将本任务文件加入提交。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
标准账号不是完整沙箱；组权限、共享目录、其他用户服务必须检查。Funnel 可能要求管理员开启账户能力，未知可达性和审核地区网络条件。不保证 Apple 接受此审核方案。不能在审核备注放长期 Relay 注册令牌或私人凭据。

<!-- task-doc-section:execution-log -->
## Execution log
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

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: partial
- Evidence: T-001、T-002、T-003、T-005 通过；gateway 23 项测试、用户配对/连接、独立身份实际撤销和公网入口恢复均有证据。
- Limitations: T-004 等待用户确认终端显示/输入、网络和联系人；未提交 Apple。无重启后自动恢复配置，Mac 必须保持运行、接通电源并勿合盖；网页有效期为创建起 7 天，最多 3 个设备、30 次发码尝试。已配对设备不会因网页凭据过期自动撤销。
