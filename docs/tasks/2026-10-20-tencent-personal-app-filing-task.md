# Task Plan: AgentsPort 腾讯云个人 APP 备案

- Created: 2026-10-20
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户说明腾讯云、个人主体，并要求操作其已打开的备案控制台。

<!-- task-doc-section:background-goal -->
## Background and goal

为 AgentsPort 的中国大陆分发准备 APP 备案草稿和可核实的 iOS 特征信息；已有域名的网站备案不能替代 APP 备案。帮助填写，但不冒用身份或未经确认提交法律承诺。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 操作用户已打开的腾讯云窗口，沿用已备案个人主体，只新增 APP 草稿，不修改/注销既有网站或主体。
- 提取对应 App Store 1.0.0(6) 的公开发行证书公钥和 SHA-1；不导出私钥、P12，不公开身份证/手机号/密码，不将个人材料写入 Git。
- 身份证、人脸、短信核验由用户本人完成。承诺书、协议和最终备案提交须额外明确确认。
- 不撤回 Apple 审核，不修改现有上架地区/名称/Bundle ID；费用、新资源购买或备案信息冲突时停止确认。
- public-browser 当前只见另一空窗口；Cua 的现有 Chrome DevTools 绑定缺少运行期授权，不重启服务/浏览器或绕过授权。使用正常允许的原生 AX/截图操作用户指定的腾讯云窗口。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户的备案平台为腾讯云，主体为个人 | 用户明确回答 |
| F-002 | 主体已在腾讯云备案时，官方流程为我的备案→APP→新增/接入服务 | https://cloud.tencent.com/document/product/243/97670 可见正文 |
| F-003 | iOS 特征要求 Bundle ID、公钥及证书 SHA-1；即使栏名为MD5，iOS仍填SHA-1 | https://cloud.tencent.com/document/product/243/97789 可见正文 |
| F-004 | 实际腾讯云窗口存在，页面有网站/APP及新增/接入服务 | 原生窗口与AX观察，敏感信息未输出；导航截图交叉核对 |
| F-005 | 当前 App 已提交 1.0.0(6)，Bundle ID com.agentport.mobile；大陆截图提示 ICP Filing Number Missing | 既有提审任务记录和用户截图 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 原个人主体、所属省级管局及平台已列出的可备案云资源已观察；初始APP名AgentsPort已填入。最终命名规则仍以接入商/管局审核为准。
- 用户已明确确认带入的个人资料准确并允许原样沿用；不在聊天索取其具体值。
- 服务域名/IP须与真实用途相符，审核演示不伪装成正式中央业务服务。
- 若签名归档与备案特征格式不能证实，暂停该字段，不用开发证书或猜测公钥格式。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 可核实的字段写入正确的 APP 草稿并能重新读取，无既有备案被更改。
- 公钥/指纹来自对应发行材料，私钥不被读取或导出，身份材料仅在平台处理。
- 明确交付草稿、待用户核验/确认事项与真实保存状态，不宣称已获备案号。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001/T-002 -> T-003。
- Parallel batches: T-001浏览器由协调者独占；T-002可由独立代理在指定私有目录提取公开信息。
- Serialization constraints: 仅协调者编辑本文档和操作浏览器；代理不能访问私钥或更改工程/归档。

<!-- task-doc-section:task-list -->
## Task list

### [ ] T-001 — 腾讯云草稿与主体/资源核实
- Status: in_progress
- Owner: coordinator
- Objective: 核实表单并填写可以证实的 APP 信息。
- Inputs and prerequisites: 用户授权操作现有腾讯云窗口与个人主体。
- Scope or files: 仅该窗口的新 APP 草稿，不变更原有备案。
- Expected output: 实际字段/要求、草稿及待确认项。
- Dependencies: None.
- Execution steps:
  1. 观察页面并选择APP，打开新增服务流程。
  2. 核实主体、资源和命名约束，填写真实信息。
- Acceptance criteria:
  - 无未经确认的身份/法律/费用或原备案变更。
- Verification method:
  - 原生AX与隐私裁剪截图交叉核实，写入后新快照读回。
- Validation evidence: 新增服务表单默认仍为网站，明确切换APP后填入AgentsPort，AX及裁剪截图一致。使用平台已列出的有备案余量的原云资源，未购买或变更资源。核实新增服务和原主体所属管局，无协议勾选；主体信息仅原样带入，未编辑。点击保存订单草稿后列表唯一逻辑行显示草稿（未提交）及本次时间；AX列视图重复不是另一个订单，未删除任何订单。已编辑该草稿回到主体/主体负责人信息页，存在拍照上传入口。期间窗口切到其他网页时目标校验拦截输入，恢复备案标签后才继续。
- Blocker: APP实际访问的腾讯云后台域名待用户确认；不能把审核演示域名当正式服务。服务分类、SDK列表、语言、备注、图标等仍待完成。
- Unblock condition: 用户说明真实后台/域名用途后继续，不新增购买或改造服务。

### [x] T-002 — iOS 发行公开特征信息
- Status: done
- Owner: coordinator
- Objective: 从确切发行材料提取 Bundle ID、公开证书和SHA-1，核实公钥格式。
- Inputs and prerequisites: 本机归档、对应Bundle ID的公开App Store发行profile及腾讯云要求；不把自动导出重签之前的开发证书当发行证书。
- Scope or files: 只读归档及明确授权的公开发行profile/证书；输出仅到私有 app-icp-filing-20261020/ios-public 目录，不读或导出私钥。
- Expected output: 带归档版本/签名来源证据的公开材料与校验结果。
- Dependencies: None.
- Execution steps:
  1. 定位并核实归档版本、build和签名类型，不改归档或重建App。
  2. 提取公开证书、SHA-1及公钥的明确编码形式，等待表单格式匹配。
- Acceptance criteria:
  - 无开发证书混用，无私钥导出，无个人身份值进入Git。
- Verification method:
  - plist/codesign/openssl只读交叉验证及输出文件权限检查。
- Validation evidence: 当前及历史候选归档实际development签名，未冒充发行材料。代理仅从唯一匹配com.agentport.mobile、get-task-allow=false、无设备列表、beta-reports-active=true且有效的App Store profile中提取唯一Apple Distribution公钥证书；公开DER/PEM/SHA-1和明确标记SPKI/PKCS1/modulus候选编码保存在私有目录，未读取/导出私钥。协调者独立复核profile类型、DER一致性、SHA-1一致性及security verify-cert -p codeSign通过。来源是对应App发行profile，不声称已核实build6包内签名。开发候选均标记NOT-build6，未使用。已选择苹果平台；实际包信息弹窗要求40位SHA-1。官方规范第5幅公钥示例为256字节RSA公钥数值（不是SPKI/PKCS1 DER），据此填写对应发行profile证书的512位十六进制modulus、证书SHA-1及Bundle ID。遮罩截图确认三字段绿色格式标记；点击“验证”后弹窗关闭，包信息表中三值精确匹配。该验证不代表已核实build6实际导出签名，也不代表完整服务已持久保存或备案通过。
- Blocker: None；若后续要求build6包内签名证明，仍须补真实上传IPA/导出证据。
- Unblock condition: None.

### [ ] T-003 — 保存核实与用户核验/提交边界
- Status: blocked
- Owner: coordinator
- Objective: 保存已确认草稿，列出身份核验、法律确认和最终提交边界。
- Inputs and prerequisites: T-001/T-002证据及用户进一步确认。
- Scope or files: 草稿保存/读回；最终提交仅明确授权后进行。
- Expected output: 正确的草稿结果或具体阻碍，不冒充备案通过。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 核对全部已填字段，保存并读取实际状态。
  2. 遇到人脸/短信、协议或提交节点交给用户确认。
- Acceptance criteria:
  - 不跳过核验，不隐式接受承诺书或提交。
- Verification method:
  - 草稿持久化状态、用户确认及平台反馈。
- Validation evidence: 初始订单已保存草稿并重新打开核实主体步骤；未勾选协议或提交承诺书/最终备案，Apple审核未操作。
- Blocker: 待本人核对/必要身份核验、后续服务及特征字段；最终法律提交尚未单独授权。
- Unblock condition: 用户核对/完成相应本人步骤后继续；最终预览、协议与提交另行明确确认。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 每次操作前刷新准确窗口AX；敏感值不打印，截图仅裁剪必要非敏感区域。
- 公钥/指纹核对确切发行归档，避免开发证书、私钥或不明格式。
- 写入后读取值或比较布尔结果，保存不等于提交/批准。
- 文档校验、差异检查，只提交本任务文件，不混入其他开发工作。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 个人主体及命名规则依省份/接入商实际审核，不承诺一定获准。
- 折叠页签和图片未被官方网页扫描完整覆盖，实际表单为准。
- 任何真实身份核验、协议、最终法律提交或费用都不能代理猜填/默认接受。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-20: 用户明确要求操作已打开的腾讯云个人备案页面。发现独立工具浏览器为空、真实Chrome另有窗口；DevTools绑定缺运行期授权，不升级/重启工具，改用已允许的原生AX。仅观察和点击APP页签，未提交任何订单。

- 2026-10-20: 新增APP流程已填AgentsPort并保存订单草稿，唯一逻辑订单显示草稿（未提交），重新编辑停在主体信息。未修改原身份数据、网站备案或Apple审核。T-001/T-003因本人资料确认/核验转blocked。
- 2026-10-20: 发行profile公开证书已由代理提取、协调者独立校验，拒绝误用开发归档；实际公钥字段编码仍待核对，T-002 blocked。无工程/归档变更或私钥操作，所有公开材料只在私有目录。

- 2026-10-20: 用户明确确认页面原个人资料准确并允许原样沿用，T-001恢复in_progress，继续后续APP服务信息；人脸/短信和最终法律提交边界不变。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 新APP初始信息已填写并保存草稿，重新编辑回主体步骤；对应App发行profile公开材料已提取并独立校验，未冒用开发证书。
- Limitations: 用户已确认沿用个人资料；T-001/T-003仍待真实后台域名和其余服务字段/本人核验。包信息已加入当前编辑器，但尚未保存完整服务并重新打开核实持久化；初始订单草稿已保存。发行profile证书来源明确，但build6包内最终签名仍未独立恢复。未最终提交、未获备案号，未变更原网站备案或Apple审核。

- 2026-10-20: 苹果平台及包信息已填写，页面验证后表格精确读回Bundle ID、公钥与SHA-1。官方正文best-effort扫描完成，但图片不在文本扫描范围；另单独读取官方第5幅图片确认公钥格式。停在APP服务编辑器，待用户确认真实后台域名；SDK默认选项尚未当作已核实声明，未获取短信或接受协议。
