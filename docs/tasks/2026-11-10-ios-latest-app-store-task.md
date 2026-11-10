# Task Plan: AgentsPort iOS 最新源码构建与提审

- Created: 2026-11-10
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求发布最新 iOS 构建，结构化确认选择“最新源码构建并提审”。

<!-- task-doc-section:background-goal -->
## Background and goal
将当前源码冻结为独立候选，构建、验证、上传并提交 AgentsPort iOS 更新审核。现有正式版本已为 Ready for Distribution，更新使用 1.0.1；不将提审称为上线。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
Contract: projectRoot=/Users/w/Projects/AgentSessions; platform=iOS; app=AgentsPort; bundle=com.agentport.mobile; appStoreID=6810035671; teamID=GACM96NWQ2。授权当前源码构建、自动签名/发行上传、新版本资料及最终提审；保留当前价格、精确地区集合、未来地区开关、兼容平台与手动发布方式。不购买、不签法律协议、不改其他生产服务、不发布更新、不改动其他 App。用户另行明确批准恢复/续期原隔离审核环境。后台仅使用 public-browser；本次不修改业务代码，不覆盖既有 dirty plist。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 源码 HEAD=1a2dc584c4fb1dba32bfc92b91fe561f53aefd07；唯一既有 dirty 文件为生成 Info.plist 的版本 0.1.0→1.0.0 | git status/diff/log，2026-11-10 |
| F-002 | 当前 ASC App 6810035671 为 AgentsPort，正式 1.0.0 build6 Ready for Distribution，发布方式 MANUAL | 当前 public-browser Distribution 读回 |
| F-003 | TestFlight 仅有 1.0.0 builds6/5 与历史0.1.0；候选计划1.0.1 build7 | 当前 public-browser TestFlight 读回 |
| F-004 | 工程 bundle=com.agentport.mobile、team=GACM96NWQ2；Xcode27.2 | tauri.conf.json、project.yml、pbxproj、xcodebuild -version |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- Assumption: 保留已发布版本元数据/真实截图，更新说明仅覆盖已确认源码差异；提交前复核隐私与审核入口。
- Resolved: 旧审核入口HTTP410，用户明确批准恢复原隔离环境；仅续期专用gateway并重启同一任务容器，至2026-11-24 10:30 UTC。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- 独立冻结源码和构建配置，记录 hash；保留用户未提交改动。
- 有意义测试、最终导出IPA检查及Apple上传/处理证据。
- 新版绑定准确 build，设置不变，真实审核访问可用，提交后读回 Submission ID/状态。
- 阻碍如实记录，不重复未知外部写入，不宣称审核通过或上线。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
- Dependency graph: T-001（串行阶段：预检→冻结/测试→归档/导出→上传/处理→元数据/提审）。
- Parallel batches: 无共享写操作并行；独立只读检查可批量。
- Serialization constraints: 单一协调者独占后台、归档和发布记录。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 当前候选构建与正式提审

- Status: done
- Owner: coordinator
- Objective: 按本次contract完成1.0.1最新源码候选并提审。
- Inputs and prerequisites: 当前源码、现有Xcode登录、当前ASC登录；保留发行设置。
- Scope or files: 独立私有候选目录、本记录及该App新版本。
- Expected output: 验证产物及上传/提交证据，或准确阻碍。
- Dependencies: None.
- Execution steps:
  1. 读取现有正式状态、身份、设置、审核访问；冻结当前源码。
  2. 运行测试，构建1.0.1(7)归档，导出并检查IPA。
  3. 上传一次并核实处理；创建/完善更新，验证设置后提审。
- Acceptance criteria:
  - 版本/身份/产物可追溯；Apple提交状态及准确build独立读回。
- Verification method:
  - Mobile测试、签名及IPA检查、ASC刷新读回、任务文档验证。
- Validation evidence: Mobile967/967、Rust图片14/14、Python packaging10/10、图标检查、TypeScript/Vite、iOS归档/最终IPA检查及Xcode发行上传通过（独立检查器CMS来源保守unknown，见日志）；Apple处理完成、build7 Ready to Submit。最终Submission详情刷新读回唯一1.0.1(7) Waiting for Review；175价格均0，148地区选择/175地区状态前后逐项相同，手动发布与审核凭据/Notes/更新说明最终读回匹配。证据位于 `/Users/w/AgentPort-private/app-store-20261110/`，详见执行日志。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan
运行冻结候选的Mobile Vitest及TypeScript/Vite构建；iOS packaging、图标、Python packaging；最终IPA身份/签名/资源/权限；ASC处理和提审状态，地区/发布方式前后精确比对。保留未执行的真机测试边界。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
旧审核服务已获授权续期至2026-11-24 10:30 UTC；如审核仍未结束，须到期前复核。登录已恢复。构建覆盖营销版本为1.0.1，不修改Android/桌面或仓库canonical版本。大陆保持选中但缺ICP备案号不可销售；欧盟27地区保持未选。1.0.1尚未审核通过/上线。

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-11-10T10:15Z: 用户确认最新源码构建并提审；ASC当前1.0.0(6) Ready for Distribution，手动发布；TestFlight最高build6。外部写入均not_started。
- 2026-11-10T10:27Z: 源码冻结至私有 `/Users/w/AgentPort-private/app-store-20261110/source`；source-manifest.json记录1059文件hash与dirty plist。Mobile967/967、Python packaging10/10、图标检查通过。首轮归档因Homebrew rustc优先且缺iOS sysroot失败；仅本次命令将~/.cargo/bin置首，使用已装iOS target的rustup工具链后归档成功；未改全局环境。
- 2026-11-10T10:30Z: 发行导出成功。IPA=1.0.1(7)，SHA256=94977e398d603b2a6352b2f78aac2b5a35684de090d6a2dd74f51e83f72a92bf；检查器退出2仅因CMS profile来源未知，其余身份、Apple签名anchor、实际签名证书/profile授权一致。该缺口保留并使用后续Xcode/Apple分发校验补验。无CloudKit；未添加加密豁免。候选变更仅生成plist版本与ACL移除Android键；业务源码未漂移。
- 2026-11-10T10:30Z: 原审核站HTTP410，用户批准恢复。仅修改隔离容器gateway expires_at为2026-11-24T10:30:12Z，保留原配置备份，重启准确任务容器；四个其他容器ID/PID/StartedAt/restartCount不变。公网TLS、匿名401、认证200/no-store/HSTS、Origin/CSRF403、非公开路径404、WSS101全部通过；Connector connected，保留1个既有设备、不撤权。
- 2026-11-10T10:33Z: Xcode Upload succeeded / EXPORT SUCCEEDED，Apple已接收1.0.1(7)等待处理；由同一归档另行导出上传，不声称与本地IPA字节相同。Rust markdown_images14/14通过。
- 2026-11-10T10:34Z: 创建1.0.1新版本并独立读回，更新说明三项为文件树图片、相对路径复制、终端绘制可靠性；审核Notes仅续期日期。Save/reload逐字匹配，继承description/support/marketing不变，审核用户名/密码与当前有效专用凭据匹配，仅输出布尔。继承iPhone/iPad各3图、各3实际缩略图加载成功；未上传/替换截图。当前手动发布、立即更新、保留评分。现有地区175项完整读回：148选中，147 Available，大陆ICP Filing Number Missing，EU27未选；未来地区自动加入false。

- 2026-11-10T10:50Z: 新构建已处理至Missing Compliance，按实际额外标准加密/法国不发行完成问卷；Ready to Submit读回。Build ID=b0b87165-aefb-4779-9cd5-40f5f09329bf；绑定1.0.1并等模态实际消失后保存，刷新读回build7。
- 2026-11-10T10:52Z: Add Build模态尚在加载时的未限定页面快照暴露旧演示网站凭据，未继续使用该凭据。维护503下仅轮换专用网站密码，更新本机私有资料、当前gateway与内部/续期回滚配置；先前脚本遇内部备份origin不同在断言处停止，读回文件后复用同一pending秘密完成剩余更新，没有重复生成凭据或重做quiesce。旧认证401、新认证200，公网完整烟测再次通过；同步Apple字段Save/reload布尔匹配，未改管理密码或撤销既有设备。未记录秘密值。四个其他容器最终PID/启动时间/restartCount保持原样。
- 2026-11-10T10:53Z: Add for Review产生唯一Draft，核对iOS1.0.1(7)后Submit for Review一次；Apple显示1 Item Submitted。新详情刷新确认Waiting for Review、Items Submitted(1)、Date Submitted Nov10,2026 at6:53PM、Submission ID=af0b891b-36c1-4ddf-a0ca-087d52b8ae92。
- 2026-11-10T10:55Z: 175价格均0；175地区状态与148选择及future=false逐项前后相同。Mac/Vision发行checkbox保持启用，新1.0.1均显示compatible。提交后再次比较审核密码、Notes、更新说明、required=true、MANUAL=true、1.0.1(7)全部匹配。浏览器留在新Submission详情。审核演示3个Python测试再次通过。桌面版本同步检查通过，原dirty plist保留。已有LEARNS的mobile Rust toolchain条目已覆盖本次失败机制，不重复写入。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: passed
- Evidence: T-001完成；新版本已上传、处理并提交，详情刷新确认。`submission-readback.json`、`final-metadata-check.json`、`availability-before/after.json`、`selection-before.json`、`prices.json`和各测试/上传日志保存在私有证据目录；任务文档验证与版本同步通过。
- Limitations: passed仅对应本次构建/上传/提审目标，不代表Apple审核通过或更新上线。未覆盖安装用户真机，未重新跑公网原生配对/跨网UI全流程；审核演示仅当前HTTPS/WSS、Connector与测试文件验证，保留旧设备。独立IPA检查器仍不自行确证profile CMS来源，补充证据为Xcode发行导出、Apple分析/处理及可提审；不声称已做全依赖隐私Required Reason API审计。最终IPA无独立PrivacyInfo.xcprivacy或license资源文件；Tauri网页资产嵌入二进制，字体本身保留copyright/OFL授权URL元数据，仓库含OFL/GPL文本及公开源码；该观察不是完整法律/隐私合规认证。大陆现有版本因ICP缺失受限，新版尚未逐地区上线。
