# Task Plan: Ubuntu 旧 Bridge 添加项目目录兼容

- Created: 2026-10-12
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: 用户截图Computer5070降级提示，授权排查修复Ubuntu目录浏览/解析兼容。

<!-- task-doc-section:background-goal -->
## Background and goal

Ubuntu上旧Bridge缺少新project.directory方法时，移动端仍通过已有只读document.list浏览/验证已有目录，而不是直接退化为只能手动输入；保持写安全与现有会话。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅移动目录reader/面板/文案及document.list移动协议契约和回归。优先新方法，明确unsupported后才试legacy方法；权限/网络/非法响应不变成成功或不支持。兼容模式从已确认POSIX根目录/明确路径开始，不推断远端Home；明确旧接口不枚举目录symlink的限制，手动别名可解析。保持canonical去重/unknown journal/不重放写。
不升级/替换Ubuntu二进制，不重启远程GUI/Host/Connector，不写远端真实项目库，不创建/删除目录或Session，不改版本/发布。远端仅通过当前已配置5070主机进行只读探测。交付默认重启本checkout已签名debugGUI；手机更新延续既有用户授权且不卸载数据，必要时确认新权限边界。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前workspace d5fa7de且初始干净 | git status/log |
| F-002 | 截图对应5070，桌面注册表存在该名称的SSH/Relay配置；SSH目标与已信任laptop配置一致 | devices.json只打印所需非凭据metadata |
| F-003 | 实际主机Ubuntu22.04.5，Bridge为/usr/bin/agentport-remote-bridge，另有checkout GUI/Connector与usr/bin Connector | SSH readonly uname/os-release/proc executable；未信号任何PID |
| F-004 | 实际Bridge protocol1.1 linux-x86_64 hello；新list/resolve均unknown_method/not_executed，旧document.list('/')及('/home/w')成功且canonical path | /tmp/agentport-ubuntu-directory-compat/probe.py framed SSH readonly probe成功输出 |
| F-005 | legacy错误不存在路径为service_error/failed，不是unsupported；旧document.list返回isDir/truncated且不提供Home | 实际probe及service list_document_directory/PathParams源码 |
| F-006 | 现有UI只在unknown_method/capability_disabled进入manualFallback，未尝试旧document.list | AddProjectDialog.tsx browse/submit/checkResult |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: Relay到同机器的Bridge具有同一legacy读接口；可只读补验证，不把SSH探测等同Relay复现。
- Assumption: POSIX旧端初始根'/'可正常列举，实机已验证；若其他平台根路径不成立，应保留错误/允许明确绝对路径，而非猜盘符/Home。
- Open question: 无需改变产品范围；若远端真正不支持两套读接口，保留诚实manual降级。
- 并行接口契约：createProjectDirectoryReader(client,hostId)返回list(path?:string,showHidden?:boolean)和resolve(path:string)。list结果{path,homePath?:string,parentPath:string|null,entries:[{name,path}],truncated,compatibility:'native'|'legacy'}；resolve返回canonical绝对路径string。模块export isAbsoluteProjectPath和ProjectDirectoryListing。两套读方法明确unsupported才fallback，绝不发写。legacy Home未报告，homePath省略；返回compatibility供Root按钮/提示与symlink限制文案。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 实际旧UbuntuBridge新方法unsupported、旧document.list可用时显示目录浏览并能解析canonical path，UI不再宣称完全不支持。
- 新接口优先；unsupported双重缺失才manual；服务错误/权限/断线/坏响应不能盲目降级成功。
- legacy root、父级、隐藏开关、混合文件过滤与truncated诚实；Home不猜测，目录symlink列表限制明确，手动symlink解析安全。
- submit/preflight和unknown-write核对都复用canonical read，关闭/跨host/迟到响应防护、journal与单写保留。
- targeted先红后绿，完整mobile tests/build，真实Ubuntu只读reader和浏览器面板验证，独立review通过。
- debug窗口正常，相关commit创建；手机安装/触控未验证项明确。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 reader 与 T-002 UI基于接口独立开发，全部完成→T-003验证/交付。
- Parallel batches: ubuntu-directory-reader独占projectDirectory.ts及其tests；coordinator独占AddProjectDialog/i18n/现有integrationtests/协议allowlist/doc。
- Serialization constraints: source不重叠，完整验证等待产物；实际Rust/App/iOS构建串行；doc仅coordinator写。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 旧接口reader兼容与边界测试

- Status: done
- Owner: ubuntu-directory-reader
- Objective: 只读新→旧接口选择、canonical验证、返回适配与错误保持。
- Inputs and prerequisites: 真实旧Ubuntuprobe与确定reader契约。
- Scope or files: mobile/src/features/projects/projectDirectory.ts；projectDirectory.test.ts。
- Expected output: reader与边界回归，精确unsupported-only策略，Home/父级信息不伪造。
- Dependencies: None.
- Execution steps:
  1. 编码native优先/legacy fallback，统一只读解析。
  2. 测试canonical/symlink、混合/hidden/truncated、旧错误/双缺失、坏数据和独立host寿命。
- Acceptance criteria:
  - readonly且只unsupported允许fallback，legacy返回与native契约兼容，不猜Home，不以失败为验证成功。
- Verification method:
  - npm test -- src/features/projects/projectDirectory.test.ts；TS/build集成后验证。
- Validation evidence: Reader117/117由作者运行且coordinator完整mobile suite复核；最终731/731及TS/Vite通过。最终真实Ubuntu旧Bridge经只读SSH proxy由当前reader读root/home/hidden，手动/var/run解析/run，缺失path保持service_error/failed，写请求0；legacy不报告Home。证据task-25与本文Final validation。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 面板/解析/核对集成

- Status: done
- Owner: coordinator
- Objective: native/legacy浏览状态、Root/Home诚实文案与submit/check canonical一致接入。
- Inputs and prerequisites: 已锁定reader接口，AddProject现有状态机与i18n。
- Scope or files: AddProjectDialog.tsx及tests；mobile/src/i18n/resources.ts；crates/agentport-remote-protocol/src/lib.rs。
- Expected output: 可用legacy面板、独立解析降级、symlink限制提示，document.list加入移动read契约。
- Dependencies: None.
- Execution steps:
  1. 添加能复现旧端降级失败的UI回归并运行观察失败。
  2. 调整仅必要三个读调用及浏览状态，不变更写/生命周期协议。
  3. 跑面板/完整mobile与协议目标测试。
- Acceptance criteria:
  - 原安全回归仍绿；legacy浏览/解析/核对和诚实错误状态通过。
- Verification method:
  - targeted Vitest、全mobile tests/build、remote-protocol tests、diff。
- Validation evidence: Ubuntu UI回归before失败（没有home目录button且错误manual降级）；集成后完整mobile46files/731tests通过，TS/Vite通过；协议契约targeted1/1及完整13/13通过，版本同步/diff检查通过。已验证legacy canonical提交/unknown-write核对的自动回归；真实远端只读浏览不提交项目。
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — 实机旧Ubuntu验证与调试交付

- Status: in_progress
- Owner: coordinator
- Objective: 用已确认旧Bridge做只读真实验证和最小UI smoke，提交可见更新。
- Inputs and prerequisites: T-001/T-002产物经coordinator检查。
- Scope or files: 本文档；/tmp诊断/浏览器harness；签名debugGUI/必要mobile产物；本任务commit。
- Expected output: 旧Ubuntu准确readonly兼容证据、UI/独立review、调试渲染与commit。
- Dependencies: T-001, T-002, T-004.
- Execution steps:
  1. 真实SSH旧Bridge reader成功/错误验证，不修改远端账户/项目库。
  2. 浏览器旧端流程与独立review，必要原生mobile打包/用户授权更新；仅相关变更提交。
  3. 统一debug restart，精确PS/签名/截图确认。
- Acceptance criteria:
  - 不靠升级远端消除症状；记录SSH/Relay/native覆盖边界；commit只含本任务。
- Verification method:
  - framed readonly proxy/browser、read-only review、App构建/签名/进程/截图、task validator/git show/status。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 兼容路径的无损身份/合法特殊文件名防护

- Status: done
- Owner: ubuntu-directory-reader
- Objective: 修复隔离review发现的legacy lossy canonical重定向风险与无关控制字符文件名使整个目录失效问题。
- Inputs and prerequisites: Reader已交付107tests且UI168tests/build通过；review两条source-supported因果发现。
- Scope or files: projectDirectory.ts及tests，coordinator单独补面板no-write/跨connection预检回归与必要generation guard。
- Expected output: 新回归先红后绿；只拒绝/省略不可安全选择的路径，不将合法但无关的文件名当成整个payload非法。
- Dependencies: None.
- Execution steps:
  1. 复现legacy canonical/entry U+FFFD与UTF8真实同名目录碰撞，阻止错误canonical替换。
  2. 复现legacy普通file或hidden控制名子项使可读target的resolve失败，分离wire schema与UI可选择性。
  3. 保留结构类型/绝对路径必需字段failclosed；省略不可选择entry并标注不完整，native合法U+FFFD不拒绝。
  4. 复现submit预检在disconnect/reconnect后迟到仍发写，加入与browse/reconcile一致的generation fence；已发送的写继续保留receipt。
  5. 复现迟到unsupported预检污染新connection suppression导致下一次Add跳过resolver，在manual browse/submit catch修改共享标志前同样检查generation。
- Acceptance criteria:
  - 不能向与alias原目标不同的UTF8 sibling发写；无关合法特殊文件名不阻塞正常目录；未知写安全不变。
- Verification method:
  - Reader/面板新回归before/after、全部mobile tests/build及独立delta审查。
- Validation evidence: 路径身份10focused先9fail/1pass后10/10；损失canonical面板先误报Project added后no-write/no-journal通过。跨connection迟到成功预检与迟到unsupported回归均先发写失败后修复通过；最后stale unsupported targeted1/1和完整731/731/build绿。独立连续delta reviewer静态审查最新两处catch guard、reader重建与已发写receipt durability，未发现新问题；不冒充独立运行测试。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先UI旧端fixture复现manual错误，再reader+面板targeted、全部mobile(限定2worker)和TS/Vite、Rust协议契约。真实Ubuntu现有Bridge只读list/resolve失败与document.list成功形成对照；修复reader通过同一SSH帧路径读root/home/错误路径。浏览器实际React面板与oldBridge输出(不提交写)验证。独立只读adversarial review。debugGUI统一重建签名重启/精确路径/截图，必要phone更新保留数据且不影响Hosts。只提交相关文件。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 实际linux电脑多份App/Connector共存，不能仅看版本号或强制重启/替换错误二进制。
- Legacy Home不可得，不用profile username或项目路径猜；symlink列表仅isDir能力弱于新方法，要诚实提示。
- Legacy permission/path错误可能只有generic service_error，不能解析文案猜原因，更不能当unsupported。
- Canonical preflight/reconcile必须一致；旧读双缺失才可无解析manual，但unknown写必须仍fail-closed。
- 只读真实探测不等于真实项目写/手机Relay完整触控验证，交付边界需要说明。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-12: 用户截图与当前source定界manualFallback；初始工作区d5fa7de干净。
- 2026-10-12: 从已配置5070 SSH元数据定位并只读连接Ubuntu22.04.5；native新list/resolve unknown、旧document.list root/home成功、缺失path genericfailed。首diagnostic脚本BufferedReader+select假超时已修成bufsize0，成功wire证据保留，未改产品。
- 2026-10-12: 隔离read-only contract调查确认legacy方法/错误形状及Home不可推断；决定兼容read路径而非远端升级或Session重启。T-001/T-002基于明确接口并行开始。
- 2026-10-12: Ubuntu legacy UI回归先失败（manual-only，无home目录按钮），集成reader后168targeted与完整718tests/build通过；真实reader经SSH旧Bridge root/home/缺失错误验证通过，未发project.add。浏览器harness用只读proxy禁止写。
- 2026-10-12: 独立review发现legacy to_string_lossy的U+FFFD可能将alias误指UTF8同名sibling，以及合法控制名普通文件被全schema映射导致整个list/resolve失败；新增T-004由独占reader的作者先复现后修复，root补面板no-write回归。
- 2026-10-12: Reader path身份10focused先9fail/1pass后10pass；117reader green；root损失canonical面板回归先显示Project added后新防护禁止写。另一个预检跨disconnect/reconnect回归明确fail（旧结果仍project.add一次），加入仅写前generation guard，不中止已提交write。
- 2026-10-12: delta review指出迟到unsupported先修改共享resolveUnsupported再遇写前guard，仍可能使新连接下一次Add盲跳解析；新UI回归先误报Project added失败，最新catch guard先检查alive/generation/online后修改标志。targeted1/1、最后完整46files/731tests和build通过，review复核无新actionable问题。T-001/T-002/T-004经coordinator接受为done。
- 2026-10-12: T-003开始；最终当前reader再次连真实旧Ubuntu：root、/home/w、hidden、/var/run→/run和缺失path错误均通过，write0。实际React浏览器root→home→w、hidden19项、手动alias canonical、失败清空旧列表/禁用Add、320/390px截图及滚动后Add可见通过，write0。后台Chrome焦点门控用临时Emulation focus解锁，不前台激活；关闭该设置。只关闭本任务tab，harness移到/tmp，停止所拥有Vite/proxy。
- 2026-10-12: normal Tauri device archive第一次被Homebrew rustc sysroot选择错误阻塞（rustup target存在但core缺失）；仅把$HOME/.cargo/bin前置后同命令成功。最终.app签名/未过期profile/已配对设备授权、Bundle ID不变、SDK27/min16/Scene真布尔通过。当前实体iPhone两次检查均unavailable，本次未安装/启动实体机，也未改其数据；可安装产物已保留。
- 2026-10-12: 统一python3 scripts/restart-debug-app.py完整重建/固定证书签名，仅关闭旧GUI12929打开31000；PS确认新GUI exact路径，codesign strict/deep通过；Cua窗口1389 PNG已读取，sidebar与workspace正常非白屏。新增两条经验证learn：legacy路径lossy身份/文件名分层，以及iOS编译器PATH选择。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: not_run
- Evidence: 真实旧Ubuntureadonly baseline已复现；产品修复/回归尚未完成。
- Limitations: 尚未证实Relay使用相同Bridge或运行Native触控；绝不声称远端已升级/业务写验证通过。
