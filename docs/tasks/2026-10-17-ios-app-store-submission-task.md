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
| F-002 | 正式商店版本 1.0 处于 Prepare for Submission，未选择构建 | Distribution 页面观察；未点 Add for Review |
| F-003 | 可用构建有 0.1.0 (1–4)，build 4 显示 Missing Compliance | Add Build 对话框只读检查后 Cancel |
| F-004 | 英文推广语、描述、关键词、Support URL、Marketing URL 已保存；副标题 SSH, Mosh & Agent Sessions、分类 Developer Tools 已保存 | Save 后 reload，view_page 读回全部值 |
| F-005 | 隐私问卷尚未开始，价格与地区尚未设置，年龄及 Content Rights 尚未设置 | App Privacy / Pricing and Availability / App Information 的 view_page；问卷查看后 Cancel |
| F-006 | 用户批准准备并上传 1.0 新构建；隐私先审查起草；免费且排除欧盟 | 结构化回答与后续“除了欧盟”“不需要icp备案” |
| F-007 | Mobile 为 GPL-3.0-only，Mosh 同为 GPLv3；开发签名 IPA 不可作为 App Store 发行包 | AGENTS.md、mobile/RELEASE.md、mobile/TESTFLIGHT.md |
| F-008 | 用户确认 Relay 由用户自行配置、不收集用户信息 | 用户在隐私审查后的明确陈述；用于区分开发者收集与用户自选服务器处理 |
| F-009 | 用户要求名称为 AgentsPort，并明确同时修改商店与手机桌面；Bundle ID 不变 | 结构化名称范围确认；需要新 build 6 替代 build 5 作为最终候选 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 沿用本机现有付费开发团队、Xcode 登录与现有 App ID；构建前从既有 profile 核实，不能替换签名身份或提交真实团队值。
- Open question: 审核联系人姓名、电话、邮箱、版权署名；尚无已确认信息，不猜填。
- Open question: 用户已确认 Relay 自行配置、开发者不收集信息；“Data Not Collected”问卷草稿已 Save，尚未 Publish。隐私政策最终文字、运营主体/联系邮箱、公开发布位置和 Publish 动作仍待确认。
- Open question: 年龄/内容权利/加密出口合规声明与审核用隔离服务凭据待用户确认；新 1.0 构建号与内容须以实际上传结果核实。
- Open question: 截图是否已有合格素材；不可把含个人会话的截图公开上传。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 已填写字段能够刷新后读回，与源码功能一致。
- 新 1.0 构建签名、平台、图标、Scene 生命周期及无静态库资源门禁通过，Apple 接收后再核实处理状态。
- 隐私草稿按真实数据流描述本地数据、自选主机/Relay、推送和诊断等，不无证据宣称零收集。
- 价格与地区符合免费、排除欧盟；所有高风险声明有用户明确确认。
- 提审/发布前再次确认；未获得确认时记录准确缺项和当前状态，不声称上架完成。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 独立完成；T-002 -> T-003；T-004 独立；T-005 独立；T-006 独立；T-008 为名称统一及新构建的增量任务；T-001/T-003/T-004/T-005/T-006/T-008 -> T-007。
- Parallel batches: 隐私数据流只读审查 T-002 可与协调者本机构建 T-004 并行。浏览器 T-005/T-006 串行。
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

### [ ] T-003 — 隐私政策草稿与确认
- Status: blocked
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
- Validation evidence: mobile/PRIVACY.md 草稿已随新名称改为 AgentsPort，标明未批准公开；覆盖本地数据、可读 realtime Relay、独立加密推送注册、APNs、图片、文件和日志。用户明确说明 Relay 自配、不收集用户信息后，已将该运营事实纳入草稿；public-browser 选择 No, we do not collect data、Save，再 reload 后仍见 Data Not Collected；未点 Publish。仍待主体/联系、最终文字与公开位置确认。
- Blocker: 用户已澄清自配 Relay、不收集信息；仍缺隐私联系人、最终政策内容和公开位置确认，不能点 Publish。
- Unblock condition: 用户确认联系资料、最终文字和公开发布位置/动作后，才公开政策及 Apple 隐私标签。

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

### [ ] T-006 — 审核资料、截图与法律声明
- Status: blocked
- Owner: coordinator
- Objective: 补齐联系人、版权、真实素材和用户确认的适用声明。
- Inputs and prerequisites: 联系资料、截图来源、隔离审核访问、合规回答。
- Scope or files: App Review Information、Screenshots、Age Ratings、Content Rights、Export Compliance。
- Expected output: 用户确认后保存的真实资料；否则清晰缺项。
- Dependencies: None.
- Execution steps:
  1. 收集页面实际问题和缺项，不猜填联系人或勾选合规声明。
  2. 使用经授权的隔离演示环境与素材，不暴露主账号真实数据。
- Acceptance criteria:
  - 全部声明和审核凭据得到明确确认，素材真实且适用。
- Verification method:
  - 页面读回、素材检查、审核通道实际可用性验证。
- Validation evidence: App Information 的 Content Rights / Age Ratings 未设置；版权和审核登录凭据未填。已在同一 App 的 TestFlight Test Information 找到四项既有联系人，确认正式表单原为空后复用并 Save/reload，四项逐字匹配；未复制账号密码，未在文档记录手机号或其他私有值。隐私 No Data Collected 草稿经用户运营说明后已保存但未 Publish。1.0.0(5) Missing Compliance，加密向导查看后 Cancel，未勾选；新 build 6 上传已接收。iPhone 6.1/6.3 与 iPad 12.9/13 截图槽均为 0/10，未上传个人数据截图。
- Blocker: 仍需版权署名、年龄/内容/出口声明确认；截图来源、隔离审核入口与凭据使用尚未授权/复核。联系人已补齐，供用户最终核对。
- Unblock condition: 用户确认对应声明、版权和素材/审核访问来源，并完成必要验证。

### [ ] T-007 — 最终核对和提交边界
- Status: blocked
- Owner: coordinator
- Objective: 核对所有上架准备项并在用户再次确认后才提交审核或发布。
- Inputs and prerequisites: 前置任务输出及明确提审/发布确认。
- Scope or files: App Store Connect 正式审核流程。
- Expected output: 准确的提交结果或未提交的剩余清单。
- Dependencies: T-001, T-003, T-004, T-005, T-006, T-008.
- Execution steps:
  1. 汇总最终版本、构建、政策、截图、地区和审核资料供用户确认。
  2. 仅经确认执行明确的提交动作，随后核实实际状态。
- Acceptance criteria:
  - 无授权不点 Add for Review / Submit for Review / Publish；不承诺审核结果。
- Verification method:
  - 最终确认回执与浏览器审核状态。
- Validation evidence: 当前尚未提交，用户确认的边界要求提交前再次确认。
- Blocker: 前置材料和最终提交确认尚不齐。
- Unblock condition: 全部前置门禁通过且用户明确批准最终动作。

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
- Validation evidence: 用户确认后在 iOS canonical/generated plist 和 XcodeGen spec 设置 CFBundleDisplayName=AgentsPort，新增身份不变的测试；先观察测试因缺配置失败，再观察 iOS packaging 6/6、全量 Mobile 949/949、Python packaging 10/10、图标 34 项通过。商店 Name=AgentsPort 与描述两处手机品牌名称均 Save/reload 读回，保留桌面品牌 AgentPort。新 1.0.0(6) 归档的最终 plist/签名证明显示名 AgentsPort、同 Bundle ID、iPhoneOS/arm64；新图标、Scene 与无 .a 资源门禁通过。Xcode 23:05:53 返回 Upload succeeded / EXPORT SUCCEEDED；public-browser Build Uploads 行显示 Version 1.0.0 Build(6)、Processing、23:05。旧 build 5 保留，生成 Xcode/schema 临时改动已还原。仅验证发行包桌面显示名配置，未覆盖安装用户当前手机 App。
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
- 当前磁盘约剩 6.2 GiB，归档和上传可能受空间限制；不擅自清除旧归档或用户文件。
- 分发 GPLv3 移动端时保留许可与对应源码义务，不擅自改为闭源许可。
- 政策、审核联系方式、截图、演示服务与最终确认未齐；本轮不得声称已公开上架。

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
- 2026-10-17: 仅从同一 App 现有 TestFlight 表单复用四项审核联系人；先确认正式表单为空，Save/reload 后逐项匹配，不记录私有值、不复用审核账号密码。版权、截图、隔离审核访问及法律声明/政策公开仍须确认，整体回到 blocked。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001/T-002/T-004/T-005/T-008 已验证；最新 build 6 的本地验证和 Apple 接收/Processing 均有证据，948 项基础套件在加名称回归后为 949/949。T-003/T-006/T-007 等待政策公开、素材、声明及最终授权。
- Limitations: 最新 1.0.0(6) 最后观察为 Processing，未声称处理/审核完成；build 5 的 Missing Compliance 已观察。No Data Collected 仅保存草稿，未 Publish，政策未公开；年龄/内容/出口、版权、截图及审核访问待完成。四项联系人已补齐；未覆盖安装用户手机、未提交审核、未正式发布。
