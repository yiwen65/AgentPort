# Task Plan: 修复 Active Session 周期刷新加载提示闪现

- Created: 2026-10-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户报告“Loading active sessions from devices...”自动反复出现，授权排查修复。

<!-- task-doc-section:background-goal -->
## Background and goal

消除已有 Active 列表的定时刷新/返回前台/手动刷新导致的全局加载提示反复出现，同时保留第一次读取、失败重试和设备新连接的真实反馈。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅修改 Active 快照/首读状态、Dashboard 使用与回归测试；保留5秒刷新、每设备读取隔离、缓存禁操作、Projects/通知/场景兼容。不延长轮询间隔，不用CSS或延时掩盖状态错误。不使用computer、不重放旧暂停capture；不卸载/清除手机数据。验证后使用现有签名流程重新构建并覆盖安装到唯一可用实体iPhone，打开更新包。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 起始HEAD为9980f62，工作区干净，Scene/ownership修复已存在 | git log/status |
| F-002 | hook每5秒重新读取，所有请求开始都设snapshot.loading=true | mobile/src/features/sessions/useActiveSessionSnapshots.ts |
| F-003 | Dashboard将任何snapshot.loading映射到全局加载提示，同时用于空状态/scroll readiness | mobile/src/features/sessions/SessionDashboard.tsx:237,441,669,682 |
| F-004 | 有已有数据、空列表、初读失败、后台/重连等测试基础 | GlobalActiveDashboard.test.tsx、useActiveSessionSnapshots.test.tsx |
| F-005 | 唯一可用实体iPhone17ProMax，已信任配对；没有并行cargo/xcodebuild | devicectl list devices、ps只读检查 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 已验证根因：每5秒定时session.list开始都会设snapshot.loading=true，Dashboard把请求busy当作首次加载；延迟真实轮询的已有数据/空结果/错误结果3个回归均在该banner断言失败。首读结果状态需要独立维护，不能用长度或pending代替。
- Assumption: 沿用刚完成的同一手机安装流程，覆盖安装保留bundle/team和数据，不操作其他设备。
- Open question: 无阻塞产品决策。手机状态变化导致无法安装时明确报告，不盲目重试。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 初次读取提示存在且完成/失败后结束，首次慢设备仍有反馈。
- 已完成首读后，已有列表/已知空列表/已知失败均不因定时或手动后台读取再次出现全局加载提示；刷新确实继续且正常更新数据。
- 现有错误/重试与刷新按钮忙碌保持准确；离开/回到Active保留已知状态，断线重连/新设备仍作为新生命周期初读。
- 全mobile回归、build/原生签名与当前iOS Scene检查通过；手机更新包安装/启动并持续运行。
- 仅任务文件提交，禁止computer；真机UI不能自动验证则明确边界。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；reproducer/修复共享源码，native build/dist与安装串行。
- Serialization constraints: coordinator独占修改与设备，保留所有其他工作；不并行重建同一archive。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 因果复现与最小状态修复

- Status: done
- Owner: coordinator
- Objective: 证明并拆分首读状态与请求忙碌，修复周期提示。
- Inputs and prerequisites: 用户现象与当前hook/Dashboard/回归文件。
- Scope or files: useActiveSessionSnapshots.ts/.test.tsx、SessionDashboard.tsx、GlobalActiveDashboard.test.tsx。
- Expected output: 先失败后通过的轮询/手动/返回/重连回归及最小状态修复。
- Dependencies: None.
- Execution steps:
  1. 用fake clock+deferred reads复现已有数据/空数据/首次失败下周期banner。
  2. 将首次读取反馈与每设备loading/全局refreshing分离，保持异步失效守卫。
  3. 回归首次/重试/新设备/暂停等邻居状态。
- Acceptance criteria:
  - 首读真实提示不丢；后台刷新不再重现banner且更新正常。
- Verification method:
  - npm test -- src/features/sessions/GlobalActiveDashboard.test.tsx src/features/sessions/useActiveSessionSnapshots.test.tsx。
- Validation evidence: 坏基线3个UI用例在首个5秒tick发现Loading状态，3failed/14skipped；修复后2文件32测试通过，npx tsc --noEmit通过。已有数据/空/错误均覆盖3次延迟poll+手动+离开返回，确认仍读2台设备且busy准确；首次空/失败、取消迟到读、重新连接初读reset有hook保护，刷新结果updated确实发布。已有首次慢host和Projects/scroll相关用例保持通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 全套验证与新包构建安装

- Status: done
- Owner: coordinator
- Objective: 验证非回归并把新前端嵌入新签名真机包，覆盖更新目标手机。
- Inputs and prerequisites: T-001验证通过；现有签名/Scene兼容流程；实体设备可用。
- Scope or files: mobile自动测试与ignored/private原生产物；本计划。
- Expected output: 完整测试/build、归档新资源校验、安装/启动/持续运行证据。
- Dependencies: T-001
- Execution steps:
  1. 完整mobile测试与Python packaging guard，diff/版本门禁。
  2. 私有备份当前archive，官方脚本重建；校验SDK27Scene/签名/新资源。
  3. 同bundle/team覆盖安装，不卸载；启动及同PID延迟复核。
- Acceptance criteria:
  - 自动测试/签名构建通过，手机安装且持续运行；不夸大真机UI验证。
- Verification method:
  - npm test、build-ios-personal-team.sh、test-package-ios-development.py；manifest/二进制；devicectl。
- Validation evidence: npm test完整41文件/504测试通过；Python包装10测试通过；TypeScript/Vite与SDK27真机archive18秒通过，签名/profile/IPA SHA256/完整Scene配置复核成功。当前asset index-D9AZXXmm.js包含initialLoading，资源名嵌入归档binary（SHA256=17fe5589fc3c1b2740de45018c21777bef455c76b61854e2760064cb3c1677c7）。实体iPhone覆盖安装/launch明确成功，PID21375在3s/60s均实际存活；未卸载/清数据、未调用computer/截图。diff与版本同步门禁通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 提交与状态收敛

- Status: done
- Owner: coordinator
- Objective: 只提交已验证修复，记录准确验收与限制。
- Inputs and prerequisites: T-002结果。
- Scope or files: 任务源码/测试、本计划；仅必要的验证学习记录。
- Expected output: 修复commit与收敛计划，无敏感签名/设备产物入Git。
- Dependencies: T-002
- Execution steps:
  1. 审核diff与证据，更新唯一计划并validate。
  2. 仅stage任务文件commit，git show/status只读核验。
- Acceptance criteria:
  - 验证结果真实、已提交且无混入其他工作。
- Verification method:
  - task_document.py validate；git diff --check、commit/show/status。
- Validation evidence: 修复commit f126989已创建，git show只读复核仅6个任务文件；提交后工作区干净。计划validator/diff与版本门禁通过，无签名/设备/原生产物入Git。记录一条经失败前/后与部署验证的Active polling学习；最终计划闭环单独提交。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

定向UI测试用延迟返回确保pending期间观察到提示状态，而非只测试已resolve结果；覆盖3轮真实5秒timer、手动/返回前台、错误retry、首次慢host与断线重连。Hook测试核对first-read flag在成功空列表/失败/暂停/客户端替换间生命周期正确。随后全mobile/Python测试和官方原生build。安装新包时确认资源名/功能源码存在二进制内、Scene签名guard通过，启动后核对同一PID3s/60s。禁止computer；iOS截图服务已知不可用，不重复尝试。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 不能以sessions.length判断首次读取：空列表也是有效已知结果，失败已有专属状态。
- 不能停止poll来压掉提示；要证明读取仍执行和内容可更新。
- 原生流程必须保留SDK27Scene/compatible Tao pin与既有签名；手机可能锁屏/离线。
- 旧desktop capture暂停且未核实，与本任务无依赖，不重放或推断成功。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 阅读当前源码/回归、检查工作区干净和设备可用；建立唯一计划。T-001 in_progress，先建立延迟轮询坏基线。
- 2026-10-11 01:36: UI延迟轮询坏基线3failed，定位每次request.loading被误作首读；独立host.hasResult/initialLoading，不改每设备loading或刷新busy。成功/失败首读均结束initial阶段，取消读不算完成，重连新生命周期reset。定向32测试/TypeScript通过，T-001 done，T-002 in_progress。

- 2026-10-11: 全套504/504、Python10/10通过；新原生build/签名/SDK27Scene验证通过，新前端resource及initialLoading代码实际嵌入新binary。手机覆盖安装/启动成功，PID21375在3s/60s均存活。T-002 done，T-003 in_progress，开始最终diff/学习记录/任务提交。

- 2026-10-11: 创建修复commit f126989，git show/status核对6个任务文件与干净工作区。T-003 done；整体passed限定于回归/构建/安装和启动证据，真机UI边界不扩大。最终计划状态另行提交。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001/T-002/T-003全部done。三种状态轮询坏基线已复现并修复，32定向/504完整Mobile/10Python测试、TypeScript/Vite/真机SDK27签名构建通过，新资源已嵌入并覆盖安装，手机PID21375在3s/60s实际存活。修复commit f126989已创建并只读复核，工作区干净。
- Limitations: 手机UI/真实跨电脑网络行为未直接自动验收；提示行为由deferred-read UI回归验证，手机已部署对应新资源。禁止computer/已知截图服务不可用，不把进程存活当作像素或业务交互验收。
