# Task Plan: iOS App Store 正式上架准备

- Created: 2026-10-17
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户要求通过 public-browser MCP 操作已登录 Chrome 填写 App Store Connect，随后确认 1.0 新构建、隐私审查和政策草稿、免费且排除欧盟。

<!-- task-doc-section:background-goal -->
## Background and goal

推进 iOS 正式上架准备；用户后续确认名称统一为 AgentsPort（商店与 iPhone/iPad 桌面），保存准确元数据并准备包含新图标的 1.0 App Store 构建。不能把 TestFlight 上传、开发包安装或表单保存称为审核通过或正式发布。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 所有 App Store Connect 页面操作仅用 public-browser MCP；本机可审查源码、构建、验证和使用现有 Xcode 发行身份上传用户明确授权的新构建。
- 可填写、保存可证实的元数据；可审查数据流并起草隐私政策。发布政策、正式隐私声明、法律/出口/年龄声明、最终提交审核和正式发布须再确认。
- 不签新合同、不付款、不添加或撤销测试人员，不泄露 Apple 凭据、签名材料或真实用户终端内容；不重启任何现有 Host/Connector。
- 用户指定免费、排除欧盟。用户表示不需要 ICP；保留实际平台提示，不虚构备案号，不把这一陈述当作已完成的 Apple 验证。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | App 为 AgentPorts，Bundle ID com.agentport.mobile，Apple ID 6810035671，主要语言 English (U.S.) | public-browser 的 Distribution / App Information 页面；mobile/TESTFLIGHT.md |
| F-002 | 初始检查时，正式商店版本 1.0 处于 Prepare for Submission，未选择构建 | Distribution 页面观察；未点 Add for Review |
| F-003 | 初始检查时，可用构建有 0.1.0 (1–4)，build 4 显示 Missing Compliance | Add Build 对话框只读检查后 Cancel |
| F-004 | 英文推广语、描述、关键词、Support URL、Marketing URL 已保存；副标题 SSH, Mosh & Agent Sessions、分类 Developer Tools 已保存 | Save 后 reload，view_page 读回全部值 |
| F-005 | 初始检查时隐私问卷、价格与地区、年龄及 Content Rights 尚未设置 | App Privacy / Pricing and Availability / App Information 的 view_page；问卷查看后 Cancel |
| F-006 | 用户批准准备并上传 1.0 新构建；隐私先审查起草；免费且排除欧盟 | 结构化回答与后续“除了欧盟”“不需要icp备案” |
| F-007 | Mobile 为 GPL-3.0-only，Mosh 同为 GPLv3；开发签名 IPA 不可作为 App Store 发行包 | AGENTS.md、mobile/RELEASE.md、mobile/TESTFLIGHT.md |
| F-008 | 用户确认 Relay 由用户自行配置、不收集用户信息 | 用户在隐私审查后的明确陈述；用于区分开发者收集与用户自选服务器处理 |
| F-009 | 用户要求名称为 AgentsPort，并明确同时修改商店与手机桌面；Bundle ID 不变 | 结构化名称范围确认；需要新 build 6 替代 build 5 作为最终候选 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 沿用本机现有付费开发团队、Xcode 登录与现有 App ID；构建前从既有 profile 核实，不能替换签名身份或提交真实团队值。
- Resolved: 审核联系人四项已复用同一 App 原有 TestFlight 信息并核实，版权署名已按用户确认保存；电话不公开、不写入本任务文档。
- Resolved: 用户确认 Relay 自配、开发者不收集信息，并批准以既有审核姓名/邮箱公开隐私政策。正式政策已推送 GitHub、匿名 HTTP 200 且原文一致；App Privacy URL 已保存，Data Not Collected 隐私标签已 Publish 并刷新见 Published 提示。
- Resolved: 用户批准 Content Rights No，并在 Apple 算出 4+ 后明确批准保留 4+ 保存；未选择 Made for Kids。两项已 Save/reload 读回。标准加密/不向法国分发已确认并保存；1.0.0(6) 已绑定正式草稿。
- Resolved: 本机隔离演示已通过真实 SSH/TOFU 连接；iPhone/iPad 各三张原生截图已生成并检查，未使用个人会话。
- Resolved: 六张截图已上传并刷新读回；用户随后独立批准 T-011/T-012 的安全审核部署。https://review.skyride.top/ 已通过公网及原生 App 验收；专用网站审核凭据/Notes 已在 App Store Connect 保存并刷新匹配，未提交审核。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 已填写字段能够刷新后读回，与源码功能一致。
- 新 1.0 构建签名、平台、图标、Scene 生命周期及无静态库资源门禁通过，Apple 接收后再核实处理状态。
- 隐私草稿按真实数据流描述本地数据、自选主机/Relay、推送和诊断等，不无证据宣称零收集。
- 价格与地区符合免费、排除欧盟；所有高风险声明有用户明确确认。
- 提审/发布前再次确认；未获得确认时记录准确缺项和当前状态，不声称上架完成。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 独立；T-002 -> T-003；T-004/T-005/T-006/T-008/T-009 独立；T-011 -> T-012 -> T-010；T-001/T-003/T-004/T-005/T-006/T-008/T-009/T-010 -> T-007。
- Parallel batches: 隐私数据流只读审查 T-002 可与协调者本机构建 T-004 并行。浏览器 T-003/T-005/T-006/T-009 串行，原生构建与不重叠的只读检查可并行。
- Serialization constraints: 仅协调者编辑本文件、操作 Chrome、修改生成 Xcode 工程和归档；审查子代理只读源码，不能访问凭据、修改文件或操控浏览器。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 基础商店元数据
- Status: done
- Owner: coordinator
- Objective: 填写准确英文功能与支持信息。
- Inputs and prerequisites: 用户确认的浏览器操作范围、mobile/README.md 和通用终端说明。
- Scope or files: App Store Connect Distribution 与 App Information。
- Expected output: 已保存的描述、推广语、关键词、URL、副标题及分类。
- Dependencies: None.
- Execution steps:
  1. public-browser fill_form、Save、reload、view_page 读回。
- Acceptance criteria:
  - 刷新后字段仍存在，未改法律声明或提审。
- Verification method:
  - 浏览器刷新独立读取持久化值。
- Validation evidence: 上述七项文字字段及 Developer Tools 分类在 reload 后读回；版本仍 1.0，未选择构建，未提交。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 隐私数据流审查
- Status: done
- Owner: appstore-privacy-audit
- Objective: 查明移动端网络数据、存储、SDK、推送、诊断及用户自主连接边界。
- Inputs and prerequisites: 现有源码、依赖与配置；用户授权审查。
- Scope or files: mobile/src-tauri/src、mobile/src、mobile/package.json、mobile/src-tauri/Cargo.toml。
- Expected output: 带路径和证据的数据清单、已证实行为与运营未知项。
- Dependencies: None.
- Execution steps:
  1. 只读追踪关键数据流，协调者检查报告证据。
- Acceptance criteria:
  - 不将缺少遥测 SDK 等同于无数据收集，不访问真实凭据。
- Verification method:
  - 完整相关函数与调用链静态审查。
- Validation evidence: 只读子代理完成报告；协调者直接复核 remote.rs 的 realtime 别名、Relay endpoint.rs 的 WSS 终止/Noise 分支、Connector 的 realtime 接受及推送 token 持久化、APNs 固定 payload、凭据/档案、Markdown HTTPS、图片上传、inbox、诊断函数。证实 realtime Relay 可读转发内容，推送注册另用 Noise 控制信道；没有运营留存和全依赖树运行证明，不据此填零收集。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 隐私政策发布与标签
- Status: done
- Owner: coordinator
- Objective: 基于已核实数据流起草政策，向用户确认后才决定公开发布和 Apple 声明。
- Inputs and prerequisites: T-002 报告及协调者复核。
- Scope or files: mobile/PRIVACY.md 草稿；App Privacy 仅在确认后填写。
- Expected output: 待确认政策、运营问题与候选声明。
- Dependencies: T-002.
- Execution steps:
  1. 起草事实说明，标记需要运营者确认的保留期限、联系和发布位置。
  2. 用户确认后再处理公开链接与 Apple 表单。
- Acceptance criteria:
  - 无虚构法律保证、无未确认的零收集宣称、无隐式公开发布。
- Verification method:
  - 对照 T-002 路径证据和用户确认。
- Validation evidence: 用户明确批准后，以既有审核姓名和邮箱完善 mobile/PRIVACY.md，移除草稿/内部备注，不含电话、专用网站密码或其他秘密。提交 554d363 经 SSH/看门狗推送 main；匿名 GitHub 页面 HTTP 200，raw 原文逐字节匹配。URL https://github.com/yiwen65/AgentPort/blob/main/mobile/PRIVACY.md 已在 App Privacy 保存。仅发布用户确认的 Data Not Collected 隐私响应，确认对话框及刷新后出现 Published a few seconds ago，URL和声明均读回；不是 App 审核或正式发布。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 1.0 App Store 构建与上传
- Status: done
- Owner: coordinator
- Objective: 使用新图标准备新 1.0 发行归档，验证后上传现有 App。
- Inputs and prerequisites: 用户明确批准；mobile/TESTFLIGHT.md 发行流程；本机现有 Xcode 登录与签名。
- Scope or files: 本机私有归档、临时 xcconfig/export options、mobile 发行配置（必要时）；生成工程临时变化备份并还原。
- Expected output: 通过本地验证的归档及 Apple 上传接收证据。
- Dependencies: None.
- Execution steps:
  1. 备份旧归档和生成配置，核实工具链、团队与空闲空间。
  2. 使用 Tauri 参数服务构建 1.0 iPhoneOS Release，验证签名、版本、Scene manifest 和无 .a 资源。
  3. 使用现有 Xcode App Store Connect 导出上传流程，不公开开发 IPA。
  4. public-browser 核实构建处理状态。
- Acceptance criteria:
  - 版本 1.0，新图标进入包，发行签名和上传成功可证；不把上传成功称为审核通过。
- Verification method:
  - codesign、plist/profile、归档资源、Xcode 日志与 App Store Connect 页面。
- Validation evidence: Mobile 三个版本源及锁文件同步为 1.0.0（桌面仍 0.1.4）；生成 Xcode 文件备份并原样还原。发行归档为 iPhoneOS/arm64、1.0.0(5)，codesign/Scene manifest/无 .a 资源门禁通过，编译图标与已在真机确认的新图标开发包逐字节相同。Xcode 22:49:08 CST 返回 Upload succeeded / EXPORT SUCCEEDED；public-browser 读到 Version 1.0.0、Build 5、上传时间 22:49、Missing Compliance，证明 Apple 已处理到加密声明门禁，不代表审核通过。商店 Version 也改为 1.0.0，reload 后读回。iOS packaging 5/5、Mobile 全量 948/948、Python packaging 10/10、图标 34 项检查通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 免费和非欧盟地区
- Status: done
- Owner: coordinator
- Objective: 配置免费价格与排除欧盟 27 国的可用性。
- Inputs and prerequisites: 用户确认免费、排除欧盟及关于 ICP 的说明。
- Scope or files: public-browser Pricing and Availability。
- Expected output: 已保存、读回的价格和国家地区名单。
- Dependencies: None.
- Execution steps:
  1. 检查价格向导与地区列表，按明确名单配置。
  2. 保留实际合规提示，遇到额外法律声明暂停确认。
- Acceptance criteria:
  - 不收费、不选择欧盟，不修改无关平台或付款协议。
- Verification method:
  - 保存后刷新，核对价格与排除名单。
- Validation evidence: 通过 public-browser 确认 175 个本币价格均为 0，保存后重新进入 Current Price 逐项读回仍为 0。地区设为 175 减欧盟 27 国共 148；reload 后读取全部 175 个国家/地区的实际状态，欧盟 27 国全部 Not Available，其余 148 个 Available on App Release。中国大陆与英国均为 Available on App Release，未来新增地区自动可用关闭；未改税务或签付款协议。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 审核联系与法律声明
- Status: done
- Owner: coordinator
- Objective: 补齐审核联系人、版权和用户确认的年龄/内容权利/出口声明。
- Inputs and prerequisites: 既有联系资料、用户合规回答；隔离审核访问和截图独立由 T-009 负责。
- Scope or files: App Review 联系字段、Copyright、Age Ratings、Content Rights、Export Compliance；不在本任务中处理 T-009 的网站凭据/说明和截图。
- Expected output: 用户确认后保存的联系与声明；否则清晰列出缺项。
- Dependencies: None.
- Execution steps:
  1. 收集页面实际问题和缺项，不猜填联系人或勾选合规声明。
  2. 逐项保存、刷新核实已批准的字段，不把版权署名授权当作第三方内容权利声明。
- Acceptance criteria:
  - 所属联系与法律字段得到明确确认并保存读回，不自批准 T-009 的网站或素材。
- Verification method:
  - 页面字段、问卷定义与状态读回；必要时以源码事实提出候选答案。
- Validation evidence: 正式审核四项联系人已从既有 TestFlight 资料复用并 Save/reload 匹配；没有公开电话。用户确认后，版权 2026 jin wen 与正式版本绑定 1.0.0 build 6 均 Save/reload 核实。build 6 选择额外标准加密、法国 No 后 Save，TestFlight 从 Missing Compliance 变为 Ready to Submit；未改 Info.plist 为不加密、未动 build 5。隐私政策/标签已公开。用户后续明确批准 Content Rights No，已选择 DOES_NOT_USE_THIRD_PARTY_CONTENT、Done/Save/reload 核实 No。年龄问卷按已批准的实际用途填写，Apple 计算 4+ 后再次取得用户“保留4+并保存”确认，选择 Not Applicable（不是 Made for Kids），保存并刷新核实 Global rating of 4+ with regional exceptions。审核登录/说明未填失效入口或专用密码。
- Blocker: None.
- Unblock condition: None.

### [ ] T-007 — 最终核对和提交边界
- Status: blocked
- Owner: coordinator
- Objective: 核对所有上架准备项并在用户再次确认后才提交审核或发布。
- Inputs and prerequisites: 前置任务输出及明确提审/发布确认。
- Scope or files: App Store Connect 正式审核流程。
- Expected output: 准确的提交结果或未提交的剩余清单。
- Dependencies: T-001, T-003, T-004, T-005, T-006, T-008, T-009, T-010.
- Execution steps:
  1. 汇总最终版本、构建、政策、截图、地区和审核资料供用户确认。
  2. 仅经确认执行明确的提交动作，随后核实实际状态。
- Acceptance criteria:
  - 无授权不点 Add for Review / Submit for Review / Publish；不承诺审核结果。
- Verification method:
  - 最终确认回执与浏览器审核状态。
- Validation evidence: 当前尚未提交，用户确认的边界要求提交前再次确认。
- Blocker: 准备项已完成，但最终 Add for Review / Submit for Review 及发布策略仍需明确确认；网站当前期限为 2026-10-24 17:57 UTC，提交前须复查覆盖审核时间。
- Unblock condition: 用户明确批准最终提审动作和手动/自动发布策略，且提交前重新核实审核入口有效。

### [x] T-008 — AgentsPort 商店与 iOS 桌面名称统一
- Status: done
- Owner: coordinator
- Objective: 将当前 iOS 商店名和手机/iPad 桌面名统一为 AgentsPort，并上传新 build 6。
- Inputs and prerequisites: 用户明确要求 AgentsPort，且确认商店和手机桌面均改；已有 1.0.0(5) 归档与签名流程。
- Scope or files: public-browser App Information/Distribution 文案；mobile/src-tauri/Info.ios.plist、生成 iOS plist/project.yml、iOS packaging 测试、隐私草稿和分发说明；不改桌面 AgentPort 或 Android 名称，不改 Bundle ID。
- Expected output: 已保存并刷新核实的商店名称/文案；CFBundleDisplayName=AgentsPort 的已验证新归档及 Apple build 6 接收证据。
- Dependencies: None.
- Execution steps:
  1. 添加可回归验证的 iOS 显示名配置，保持 Bundle ID、二进制名及安全存储身份稳定。
  2. 更新商店名称和相关手机 App 文案，保留桌面 AgentPort 名称。
  3. 备份 build 5，使用相同流程构建/验证并上传 1.0.0(6)，保留旧上传记录。
- Acceptance criteria:
  - 店面名称刷新后为 AgentsPort，新包显示名为 AgentsPort，Bundle ID 不变；不提交审核或发布。
- Verification method:
  - 新名称测试先在未改配置时失败，再在修复后通过；plist/签名/图标/平台门禁；public-browser 名称读回和新构建记录。
- Validation evidence: 用户确认后在 iOS canonical/generated plist 和 XcodeGen spec 设置 CFBundleDisplayName=AgentsPort，新增身份不变的测试；先观察缺配置失败，再观察 iOS packaging 6/6、全量 Mobile 949/949、Python packaging 10/10、图标 34 项通过。商店名称及描述两处手机品牌名 Save/reload 为 AgentsPort，桌面品牌 AgentPort 未改。新 1.0.0(6) 最终 plist/签名证明 AgentsPort、同 Bundle ID、iPhoneOS/arm64，新图标/Scene/无 .a 资源通过。Xcode 23:05:53 上传成功；页面初为 Processing，后到 Missing Compliance，标准加密/法国 No 经用户批准保存后为 Ready to Submit，并已绑定正式 1.0.0 草稿且刷新核实。旧 build 5 保留，生成临时变化还原；未覆盖安装当前手机 App。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 本机隔离演示与真实商店截图
- Status: done
- Owner: coordinator
- Objective: 使用本机独立演示数据与独立 iPhone/iPad 模拟器生成真实商店截图；不开公网审核入口。
- Inputs and prerequisites: 用户在旧入口失败后明确要求本机准备，并选择仅生成本机截图；既有 iOS 构建流程和 Apple 规格。
- Scope or files: 全新临时演示数据/配置与 loopback 测试连接、独立截图模拟器、私有临时文件/图片目录、Chrome 中素材上传；不使用个人会话或主账号凭据，不启动 Docker/公网服务，不启用系统 Remote Login。
- Expected output: 真实原生 App 使用演示数据的 iPhone/iPad 截图及上传读回；审核远程访问由 T-010 单独处理。
- Dependencies: None.
- Execution steps:
  1. 以最小环境白名单和显式 AGENTPORT_DATA_DIR/AGENTPORT_SOCKET_DIR/AGENTPORT_HOST_BIN 准备临时数据；先静态复核隔离，再验证没有默认 DB/IPC 路径误用。
  2. 临时 SSH fixture 只监听 127.0.0.1、使用合成测试认证，并仅执行显式环境下的 Bridge；只创建并清理本任务自己的 shell sessions。这是数据/配置隔离，不宣称 OS 沙箱，不向不可信审核员开放。
  3. 为截图使用独立模拟器和无 fixture 编译注入的新 App，拍摄真实演示状态，检查尺寸/隐私后上传并读回。
- Acceptance criteria:
  - 截图来自真实原生 App 和真实演示会话，符合尺寸，无个人数据或实际秘密；仅任务资源被清理，无公网端口或既有 Session 受扰。
- Verification method:
  - 环境/DB/socket 路径、所有权与服务监听验证，simulator 版本/签名/screenshot，public-browser 上传读回。
- Validation evidence: 已从同一 App 的 TestFlight Sign-In 字段取得用户授权复用的专用网站凭据，仅保存在本机私有目录/0600 文件中，未输出值。build 2 的 What to Test 明确该凭据只用于隔离审核网页、不是 SSH/macOS 密码，并提供旧 HTTPS 入口。该入口直接访问失败，系统 DNS 返回 nodename nor servname provided；经现有代理也出现 TLS EOF，未取得认证成功或发码证据。未向 App Review 填入已失效入口。后经用户批准仅本机截图，创建独立 DB/socket/最小环境和两个合成 shell Session，实际 PTY 环境检查通过；SSH fixture 只监听 loopback，仅允许固定 Bridge exec，无交互 shell/转发。TOFU 指纹与 fixture 相符，真实 SSH 连接、项目列表、终端及 Markdown 文件预览已通过。新建专用 iPhone/iPad 模拟器安装 1.0.0 原生 App，未编译注入 fixture，使用 XCTest/Device Hub 实际操作及原生截图。私有目录 /Users/w/AgentPort-private/app-store-review-20261017/screenshots/ 含 sessions/terminal/markdown 各两类共六张 PNG：iPhone 1206×2622，iPad 2064×2752；逐张查看无个人数据或凭据，manifest.json 记录 SHA256。已通过独立 CLI 停止仅任务所有的两个 Session，验证记录的四个 Host/PTY PID 消失且私有二进制无残留进程；停止任务 SSH 服务并确认端口关闭。用户重新登录后通过 public-browser 原生 file_upload 向两类槽各上传三张；首次读回各出现六个独立条目，逐项仅移除本次多出的三个重复条目并确认 Remove App Screenshot，未删除原始三张或 Asset Library 资产。页面自动持久化且 Save disabled；reload 后分别切换 iPhone/iPad，均读回 3 of 10 App Screenshots 以及 sessions、terminal、markdown 三个文件名，顺序一致，无重复。1.0.0 仍 Prepare for Submission，绑定 build 6 未变，未点 Add for Review。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 正式审核远程访问方式
- Status: done
- Owner: coordinator
- Objective: 确定审核员如何完整体验需要远程主机的功能，不暴露本机个人 Shell 或失效网站。
- Inputs and prerequisites: 用户提供有效专用访问方式，或明确确认其他审核说明方案。
- Scope or files: App Review 登录/Notes；公网部署须依 T-012 的独立明确授权，禁止开放主账号或填入管理凭据。
- Expected output: 经验证的专用审核访问，或用户确认并清楚说明的其他方式。
- Dependencies: T-011, T-012.
- Execution steps:
  1. 保留旧网址不可达的证据，不填写失效凭据。
  2. 在用户明确指定可用入口/授权后验证并保存，最终提审仍需单独确认。
- Acceptance criteria:
  - 不误导审核员，不开放个人账号，不把截图会话当公网可用审核服务。
- Verification method:
  - 入口/凭据/端到端检查或已确认审核说明的保存读回。
- Validation evidence: 用户后续明确批准新安全公网方案，T-012 实测 https://review.skyride.top/ 的专用网站认证、配对与真实终端可用。仅通过 public-browser 在正式 1.0.0 draft 填入网站专用随机用户名/密码、勾选 Sign-in required 并填写 Notes；说明该账户仅用于 HTTP Basic 审核网页、不是 SSH/OS/Apple 账户。Notes 包含120秒配对码步骤、键盘遮挡时重新点 Validate code 的真实操作方式、Review Demo/Review Terminal/README.md/3个真实测试、未配置付费AI提供商及当前访问期限。Save 后 reload，独立比较用户名、密码、Notes和checkbox全部匹配，仅输出布尔结果，未把任何凭据值写入日志或仓库；1.0.0仍 Prepare for Submission，绑定build6未变。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — 新审核机内网隔离环境
- Status: done
- Owner: coordinator
- Objective: 在用户指定的 Tailscale Linux 电脑准备独立审核演示实例，先验证内网访问，不开放公网。
- Inputs and prerequisites: 用户授权 SSH 检查和隔离部署，并明确选择先内网准备；提供的管理凭据仅用于操作，不转交审核员或记录值。
- Scope or files: 独立任务目录、Docker image/container/volume/internal network 和仅本机 loopback 的专用 SSH 隧道；保留已有审核容器及业务服务。
- Expected output: 当前版本的独立演示环境、合成数据、受保护的内网测试入口和验证结果；公网入口仍另行确认。
- Dependencies: None.
- Execution steps:
  1. 只读检查系统、现有服务和容器边界，不触碰旧实例。
  2. 在新目录构建当前代码，创建仅任务所有的隔离容器和私有认证材料。
  3. 验证容器隔离、连接与真实终端/文件数据流，说明尚未验证的公网/真机边界。
- Acceptance criteria:
  - 不开放公网、不泄露主账号凭据、不影响旧 Host/Connector 或业务；演示数据独立，实际连接及终端输出可证。
- Verification method:
  - 容器 inspect、监听/挂载/权限检查、认证和 Bridge/Relay 实测、部署前后旧实例身份对比。
- Validation evidence: 远端 Ubuntu 24.04 x86_64，Docker 29.4.1/Rust 1.94.1。由 b70f4aa 源码快照构建当前 CLI/Host/Bridge/Connector/Relay；初次构建因旧进程环境中的失效代理失败，仅本次命令清除代理后成功，未改系统代理。新实例 agentsport-appstore-review-20261018，独立 image/volume/internal network，UID1550/read-only/cap-drop ALL/no-new-privileges/1CPU/1GiB/pids256，只挂专用 HOME，无主账号 HOME/Docker socket/SSH agent/provider secrets。Docker internal network 未实际发布 HostConfig 的端口，改用任务 SSH 隧道从本机 loopback 直达容器私网 IP；外网出口探针失败，未建任何 Serve/Funnel。网页 wrong Host400/匿名401/认证200 no-store/wrong Origin与CSRF403/合法发码200；SSH 拒绝错误密码、交互 Shell、任意 exec、转发。真实 Hello/project.list/session.list/attach/input/poll/detach 全部返回完成 Result，PTY 输出 REVIEW_REMOTE_OK 且独立 HOME/无个人秘密变量断言通过。专用 iPhone 模拟器通过原生 UI 保存独立 SSH 测试认证，核对 TOFU 后连接新 Linux Review，打开 Review Terminal；XCTest 通过且原生截图确认输出。合成 README.md/app.py/test_app.py 与 3 个真实测试已准备；gateway 测试 macOS/Linux 各25/25通过。新容器保持运行且配置 unless-stopped；四个原有容器 ID/PID/启动时间/restart count 全部不变，旧 live Session 未中断。私有操作说明位于本机 linux-20261018/README.md 和远端 ~/agentport-appstore-20261018/README.md。此接受只证明内网 SSH/网页/Connector；占位 HTTPS/WSS 域名 review.invalid 不可用于 Apple，未测试公网配对、真机跨网或整机重启。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — 受限反向隧道与公网 HTTPS/WSS 入口
- Status: done
- Owner: coordinator
- Objective: 将独立 Linux 演示以可信 HTTPS/WSS 供审核访问，公网服务器只做入口。
- Inputs and prerequisites: 用户确认并授权使用 Server 运维仓库的既有管理资料，新增 review.skyride.top DNS/TLS/Nginx、受限隧道账号和服务及必要网络隔离；冲突/付费/现有业务变更须停止确认。
- Scope or files: Server 仓库仅新增专用部署脚本/配置/测试/说明；公网与 Linux 上仅任务自有账号/密钥/服务/路由/隔离规则。不复用生产 Relay token、不公开管理凭据、不自动提审。
- Expected output: HTTPS 网页与 WSS 转发、独立认证、限制转发的专用 SSH 密钥、可回滚部署及端到端验证。
- Dependencies: T-011.
- Execution steps:
  1. 核对 DNS、证书、Nginx/SSH 配置、监听和现有业务基线，无冲突后新增专用配置。
  2. Linux 主动连接公网专用隧道账号，只允许两条指定 loopback 反向转发；Nginx 仅代理审核网页与 /v1/relay。
  3. 限制容器主动访问宿主服务，验证公网认证/Origin/CSRF/TLS、真实配对/终端/撤销及原有服务不变。
- Acceptance criteria:
  - 不暴露 Linux SSH/主账号/生产 Relay；HTTPS/WSS 可信且真实 App 可用；严格权限、可回滚、无业务回归。
- Verification method:
  - DNSPod/权威 DNS、TLS 和外部请求、sshd effective config/转发拒绝、容器隔离与原生 App验收、前后业务基线。
- Validation evidence: 按 Server/AGENTS.md 仅内存使用管理资料，新增独立部署脚本/模板/测试/运维说明，不覆盖既有工作。DNSPod 创建 review A记录（RecordId2432295403），两台权威NS答案均核实；新可信TLS证书有效至2027-01-15。专用 Linux key不离机，上游专用账号只允许45067/45068两条loopback反向转发；实测拒绝Shell、本地转发和其他端口，主机监听只为127.0.0.1。独立审查发现的旧established流量放行、Docker启动早于隔离及准备/激活身份漂移均已修正：仅REPLY方向ESTABLISHED，停用仅任务容器Docker自动重启并由Requires/After隔离的systemd单元管理，身份manifest绑定容器ID/networkID/IP/server。IPv4/IPv6规则实测阻断已建立的容器主动宿主连接，宿主主动Bridge连接仍成功；容器主动宿主SSH失败。公网可信TLS/匿名及错误认证401/认证200-no-store/Referrer-Policy same-origin/Origin-CSRF403/额外路径404/WSS101均通过。原生iPhone模拟器实际完成公网配对，后续终端输入XCTest通过，独立Host读到NATIVE_PUBLIC_INPUT_OK；原生协议探针等待完整Result并验证重连/attach/input/poll/detach和解码PTY输出。只重启新任务容器/隧道后，配对身份仍保留且再次重连/I/O通过。先实测maintenance503封闭发码，再撤销仅两个命名测试身份；确认devices0/channels0，恢复公网401后旧身份明确返回Unauthorized。四个原有Linux容器PID/start/restart不变，公网原有配置hash及Nginx/sshd/生产Relay主PID/状态不变，原Relay HTTP状态未变。脚本bash-n/ShellCheck、6项部署离线测试、6项探针单测通过；原gateway macOS/Linux各25项通过。已关闭Mac临时隧道，公网服务不依赖本Mac。未整机重启或真机蜂窝跨网测试；容器不是VM、共享内核和底层磁盘且HOME无硬配额，风险在运维说明中明确。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 浏览器写入后 view_page，重要字段 Save 后 reload 再读回。
- 新包核对 1.0 版本、iPhoneOS/arm64、codesign、Scene manifest、无 .a 资源、实际新图标及上传结果。
- 隐私审查以完整相关函数和依赖为证，未知运营事实单列，不冒充运行验证。
- 地区以欧盟 27 国明确名单逐项核对，不把 EEA 或英国等同欧盟。
- 所有进展更新并执行 task_document.py validate；交付前 git diff 检查、仅提交本任务文件，不提交本机签名与生成个人标识。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 价格、欧盟以外监管、中国大陆可用性、加密和内容声明均以实际要求及用户提供的事实为准；不能规避或编造。
- 先前磁盘空间不足的风险已缓解；不擅自清除旧归档或用户文件。
- 分发 GPLv3 移动端时保留许可与对应源码义务，不擅自改为闭源许可。
- 政策、声明、截图与有效审核访问均已准备并保存；尚未获得最终提审/发布策略确认，不得声称已公开上架。网站当前期限为2026-10-24 17:57 UTC，正式提交前须复核或续期。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-17 22:20–22:38 CST: 用户确认浏览器操作范围；已保存并刷新核对基础元数据。只读检查构建列表、隐私向导和价格页面，未提交声明。
- 2026-10-17 22:38 CST: 用户确认 1.0 新构建、隐私审查草稿、免费、排除欧盟；用户表示不需要 ICP。T-002/T-004/T-005 开始；T-006 因缺资料受阻；T-007 因前置项及最终确认受阻。协调者独占浏览器与任务文档。
- 2026-10-17 22:44–22:49 CST: Mobile 版本统一为 1.0.0，使用现有团队与 Xcode 账户完成 1.0.0(5) 发行归档和上传。旧开发归档私有备份，生成 Xcode 文件恢复。Apple 接收后页面列出 Build 5 / Missing Compliance；未提交审核。
- 2026-10-17: T-002 静态报告经协调者关键源码复核后完成；T-003 草稿已写，因运营/联系人/公开政策确认转 blocked。免费价格保存、重新读取 175 项均为 0；排除欧盟的 148 地区保存并刷新核对，T-005 完成。T-004 经页面 Build 5 和上传日志交叉验证后完成。截图两类槽为空；仅查看出口向导后取消，T-006 继续受阻。
- 2026-10-17 22:55 CST: Mobile 1.0.0 全量 948/948、Python packaging 10/10、图标 34 项、桌面版本同步及任务文档校验全部通过。唯一额外生成变化为 iOS 构建从 ACL 清单移除了 Android screen-rotation 键；确认没有其他键变化后，仅还原该生成文件。当时等待运营事实、联系人/素材和声明确认，整体标为 blocked；不公开政策、不提交审核。
- 2026-10-17 23:00 CST: 用户确认名称 AgentsPort，并选择同时统一商店与手机桌面名称，新增 T-008 并开始执行；不扩大到桌面/Android 重命名。用户关于自配 Relay、不收集信息的陈述已用于保存 Data Not Collected 草稿，reload 后再次验证，但未 Publish。
- 2026-10-17 23:01–23:05 CST: iOS 显示名回归先失败，再因三份配置同步 AgentsPort 而通过；发行构建 1.0.0(6) 最终 plist、签名/平台/图标/Scene 门禁通过，Xcode 上传成功。商店名称和两处移动文案保存/刷新读回为 AgentsPort；public-browser 验证 Build Uploads 的 build 6/Processing/23:05，T-008 完成。
- 2026-10-17 23:06 CST: Mobile 全量 949/949、Python packaging 10/10、图标 34 项、桌面版本同步和 diff 检查通过。新构建的生成 Xcode/schema 文件已自动恢复到包含新显示名的构建前状态。
- 2026-10-17: 仅从同一 App 现有 TestFlight 表单复用四项审核联系人；先确认正式表单为空，Save/reload 后逐项匹配，不记录私有值、不复用审核账号密码。版权、截图、隔离审核访问及法律声明/政策公开当时仍须确认，整体回到 blocked。
- 2026-10-17: 用户随后明确批准：以现有审核姓名/邮箱公开隐私政策到 GitHub（不公开电话）；如实选择额外标准加密并排除法国；版权用 2026 加现有审核姓名；复用隔离演示环境和专用网站审核凭据。T-003/T-006 恢复 in_progress，新增 T-009；最终提审/正式发布仍不在授权内。
- 2026-10-17: 已根据批准的运营模型完善正式隐私政策，去除 DRAFT/内部审查笔记，公开资料只包含姓名和邮箱。T-009 从旧 build 2 的说明恢复隔离网页入口及网站专用凭据后，只读验证因 DNS/代理 TLS 失败受阻，标为 blocked；不猜测服务器、不改生产服务。T-003/T-006 的其他已授权工作继续。
- 2026-10-17: 政策提交 554d363 已推送 main，匿名页面 200/原文一致；public-browser 保存政策 URL 并 Publish 隐私响应，reload 见 Published 与 Data Not Collected，T-003 done。标准加密/法国 No 已保存，build 6 Ready to Submit；版权与绑定 build 6 保存后刷新核实。只读查看年龄 Step 1 及内容权利问题后取消，未猜填，T-006 当时转 blocked；未点 Add for Review 或正式发布。
- 2026-10-17: 用户明确批准按实际功能填写年龄问卷草稿（结果保存前核对），内容权利按其产品声明选择 No；旧演示不可达后要求本机准备并确认仅生成截图，不开放公网。T-006/T-009 恢复执行，正式审核访问独立为 T-010 blocked。Docker daemon/专用旧测试账号当前不可用，考虑仅 loopback、最小环境、独立数据的临时 SSH fixture；委派只读子代理核对隔离路径和环境传播，未把它当 OS 沙箱。

- 2026-10-17 至 18: 用户批准 Content Rights No；年龄草稿计算 4+ 后明确批准“保留4+并保存”。两项均通过 public-browser 保存和刷新读回，T-006 done；不是 Made for Kids，未提审。
- 2026-10-18 00:50–01:23 CST: 用户批准继续前台模拟器操作。专用 iPhone/iPad 已通过 loopback SSH 和 TOFU，生成并检查六张真实原生截图；iPhone 1206×2622、iPad 2064×2752。Device Hub 字符合成/剪贴板输入未可靠落地，改用临时独立 XCTest 原生 UI 操作后完成；未修改正式 App、未操作个人模拟器。仅停止任务自有两个 Session 与 SSH fixture，进程树/端口关闭复核通过。T-009 因 public-browser 登录失效转 blocked，待用户重新登录后上传；T-010/T-007 保持 blocked。

- 2026-10-18: 用户确认重新登录，T-009 从 blocked 恢复 in_progress。仅通过 public-browser 上传六张截图；每类首次出现重复条目，经确认逐项移除本次重复项，reload 后核实 iPhone/iPad 各 3 of 10，文件名及顺序均正确，自动持久化且 Save disabled，T-009 done。未提交审核；T-010/T-007 仍 blocked。

- 2026-10-18: 用户提供另一台 Tailscale 电脑的 SSH 管理入口，并明确确认先内网准备隔离环境、公网方案另行确认。新增 T-011 in_progress；发现旧审核容器有 live Session，明确保留，另建实例，不开放公网。

- 2026-10-18: T-011 独立 Linux 环境已完成；新容器/数据卷/internal network 保留运行，通过仅本机 SSH 隧道完成网页和真实 Bridge/PTY 验收，并用专用 iPhone 模拟器原生 UI 连接 Review Terminal。macOS/Linux gateway 各25/25、演示 Python3/3通过；四个旧容器身份/进程/启动时间未变，Serve/Funnel 仍无配置。未用用户 sudo 密码；未提供主账号凭据给演示环境。T-011 done，T-010 继续等待可信公网 HTTPS/WSS 方案与开放确认，T-007 未提交。

- 2026-10-18: 用户确认安全公网方案并明确授权部署 review.skyride.top 专用 DNS/TLS/Nginx、受限反向隧道账号/服务及容器网络隔离；公网服务器资料仅按 Server/AGENTS.md 使用。T-012 in_progress，T-010 恢复执行；现有业务、管理 SSH、生产 Relay 与最终提审权限边界不变。

- 2026-10-18: T-012 已完成DNS/TLS/受限反向隧道/隔离前置启动和公网实际验收。只短暂停启任务新建演示容器，原有业务基线未变；原生iPhone公网配对/终端输入、协议完整Result/重连、任务容器重启后身份恢复及撤销Unauthorized全部有运行证据。两项初版隔离设计问题及身份漂移风险在激活前修正并验证，部署回滚reload失败分支有回归测试。网页键盘覆盖造成的UI测试误判已以焦点移出/结果核实解决，无App源代码变更。
- 2026-10-18: 两个测试授权在公网503维护门禁下撤销，最终devices0/channels0；已恢复公网401。经public-browser保存专用审核网站凭据和详细Notes，reload四项逐一布尔匹配；T-010/T-012 done。Mac临时SSH隧道关闭、含邀请的UI临时构建/日志清理。审核信息保存后再次核实两类截图仍各3/10。Server仓库仅本任务7个新增文件提交为5a6367f，其余既有未提交工作保留；部署说明位于该仓库docs/agentport-review-entry.md。T-007仅待最终提审/发布策略确认及提交前期限复核，未点Add for Review。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 除T-007外准备项均已验证；既有Mobile949/949，当前部署/回滚测试6/6、协议探针6/6及公网/原生App/重连/撤销实测通过。隐私、build6、联系人/声明、六张截图及审核网站凭据/Notes均已保存读回。旧本机截图fixture与临时隧道已关闭；新Linux隔离演示和公网入口保留运行，测试设备/通道清理为0。
- Limitations: T-001至T-006及T-008至T-012已完成；T-007仅待最终提审和发布策略明确授权及提交前网站期限复核。整机重启/真机蜂窝跨网未验收，容器共享内核/磁盘边界已说明。Ready to Submit 不是审核通过或公开发布。未提交审核、未正式发布、未覆盖安装用户手机。
