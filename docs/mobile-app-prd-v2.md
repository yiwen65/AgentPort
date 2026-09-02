# AgentPort Mobile V2 产品需求文档

> 状态：已确认并进入实施<br>
> 日期：2026-09-02<br>
> 拟取代范围：`docs/mobile-app-prd.md` 中的移动端产品范围与验收定义<br>
> 保留原则：既有电脑端 AgentPort、Agent CLI、Host、PTY 与安全语义继续作为权威实现

## 1. 文档目的

本文将 AgentPort Mobile 收敛为面向 Session 的移动客户端，定义 V2 的产品目标、职责边界、功能范围、状态模型、验收标准和明确非目标。

V2 不追求桌面功能等价。电脑端继续负责 Agent、Project、Worktree、Git、文档、Secret、备份和其他工程管理；Mobile 专注于快速发现并打开 Session、接收请求批准/任务完成通知、忠实呈现 Agent CLI，以及向正在电脑端运行的 Agent 下达指令。

## 2. 产品定义

AgentPort Mobile 是 AgentPort Session 的移动查看与控制端，而不是桌面 AgentPort 的缩小版，也不是独立 Agent Runtime。

- Agent、Agent CLI、AgentPort Host 和实际任务进程运行在电脑端。
- Mobile 是 AgentPort 的遥控器和终端显示器，通过用户自管的安全连接发送交互信号并接收渲染数据。
- Mobile 不运行 Agent，不复制 Agent 业务逻辑，不重新实现 Agent CLI 的交互。
- 远端 AgentPort 接收 Mobile 的选择、按键、文本和控制意图，并调用现有接口完成实际操作。
- Mobile 的 Session 主界面是终端；消息、问题、选项、审批、进度和 TUI 均由 Agent CLI 自己渲染。
- AgentPort 只结构化自己拥有的状态，例如连接、Session 生命周期、未读、可信 Hook 事件、停止和恢复结果。

### 2.1 遥控器模型

Mobile 的作用可以概括为：**采集用户交互 → 发送控制信号 → 展示 AgentPort 返回的权威结果**。

- 浏览信号：选择设备、布局、Project、Session、筛选和 Recent。
- 输入信号：文本、粘贴、IME 提交和终端特殊键。
- 控制信号：快捷启动、Attach、Detach、Interrupt、Stop、Resume/Restart、Rename、Pin 和 Archive。
- 尺寸信号：Mobile 打开 Session 或横竖屏切换后产生的终端 `cols × rows`。
- 展示数据：Project/Session 摘要、状态图标、通知、PTY 字节流、回放游标和控制结果。

Mobile 不直接创建进程、拼装 Agent CLI 命令、访问 Host socket、写入 PTY、发送操作系统信号、清理进程组或修改电脑端数据库。Remote Bridge 只负责鉴权、能力协商、请求封装和安全转发；具体行为必须复用远端 AgentPort 已有的 Session、Host、PTY 和状态接口。

### 2.2 核心价值

1. 通过与桌面端一致的 Session 状态图标，快速看到 Session 正在连接、工作、等待批准、空闲、中断、退出、停止或状态未知。
2. 从最近列表、未读标记或“请求批准/任务完成”系统通知一步打开准确的 Session。
3. 在手机上忠实查看 Agent CLI，并通过文本、粘贴和终端按键向 Agent 下达指令。
4. 在移动网络变化或 App 重启后继续同一个电脑端 Session，不重复输入，不伪造在线状态。
5. 执行少量高价值 Session 管理操作，例如创建、重命名、置顶、归档、Interrupt、Stop 和 Resume。
6. 以单台远程设备为独立工作空间，在设备内使用与桌面端一致的“项目与 Session”或“活跃 Agent Session”布局。
7. 直接点击 Project 行的 Agent 图标，以桌面端相同的快捷启动语义创建并打开 Session；支持权限模式的 Agent 默认完全权限。

### 2.3 成功标准

V2 成功不是“桌面功能覆盖率达到 100%”，而是以下核心任务可靠完成：

- 用户能在启动 App 后迅速定位并打开目标 Session。
- 用户能区分实时状态、缓存状态、重连状态和结束状态。
- 用户能看到 Agent CLI 的真实界面并完成其原生交互。
- 用户发送的每个输入批次都有明确的投递结果，结果未知时不会自动重放。
- 用户离开 Mobile 或 Mobile 被终止时，电脑端 Session 不受影响。
- 请求批准或任务完成时，用户能通过系统通知返回准确 Session；其他状态不会产生系统通知。
- 用户始终清楚当前查看的是哪台远程设备；不同设备的 Project、Session、通知和界面状态不会混排。
- 用户能从 Project 行单击 Agent 图标启动 Session，成功后直接进入终端，失败或重复点击不会产生额外 Session。
- 抓取任一 Mobile 操作链路时，可以证明实际执行发生在远端 AgentPort 现有接口中，而不是 Mobile 或 Remote Bridge 的平行业务实现。

## 3. 系统职责边界

### 3.1 Agent CLI 拥有的交互

以下内容只能由 Agent CLI 通过终端字节流呈现和处理：

- Agent 消息正文与排版。
- 提问、选择、确认和审批。
- 命令菜单、进度、状态栏和快捷键提示。
- 全屏 TUI、alternate screen、鼠标模式和光标。
- Agent 自己定义的输入、取消、返回和提交语义。

Mobile 不得解析终端文本来猜测问题或选项，不得将 Agent CLI 交互转换成 AgentPort 自己的卡片，也不得通过 AgentPort 专用结构化输入绕过 Agent CLI。

### 3.2 AgentPort 拥有的状态与控制

以下内容可以由 AgentPort 结构化并由 Mobile 原生展示：

- 电脑连接状态与最后更新时间。
- Session 标识、标题、所属电脑、Project、Agent 类型和权限模式。
- Session 生命周期、Host 存活、运行结束和恢复结果。
- 与桌面端一致的状态图标、请求批准/任务完成未读标记和通知路由。
- Attach、Detach、Interrupt、Stop、Resume、Restart、Rename、Pin 和 Archive。
- PTY 输入批次的 accepted、completed、not executed、unknown 和 failed 状态。
- 输出游标、回放缺口、重连和缓存过期状态。
- 当前 Session run 的终端尺寸、尺寸来源、所有者和单调 revision。

### 3.3 Mobile 拥有的表现与意图采集

Mobile 负责：

- Session 列表、Recent、状态图标、语义未读标记和通知深链。
- 终端渲染、窗口尺寸、触摸滚动、选择、复制、搜索和字号。
- 文本输入、粘贴、IME、外接键盘和终端特殊键。
- 移动端安全区域、键盘避让、前后台切换和无障碍语义。
- 连接、输入和 Session 控制的诚实反馈与恢复入口。

### 3.4 现有接口复用边界

Mobile 所需能力按远端 AgentPort 现有接口投影，不建立 Mobile 专用业务实现：

| Mobile 交互 | 远端 AgentPort 权威接口类别 |
|---|---|
| 浏览 Project、Session、状态和未读 | 现有 Project/Session 查询与状态 DTO |
| 打开或切换 Session | 现有 Attach、回放、实时输出与 seen 接口 |
| 输入文本、粘贴和特殊键 | 现有 PTY input-batch/控制输入接口 |
| 适配手机横竖屏、恢复桌面尺寸 | 现有 `session.control: Resize` / Host PTY resize 接口 |
| Project 行 Agent 图标启动 | 现有桌面 quick-start/create-session 接口 |
| Interrupt、Stop、Resume/Restart | 现有 Session/Host 生命周期控制接口 |
| Rename、Pin、Archive | 现有 Session 元数据接口 |
| 批准/完成通知 | 现有 `AttentionKind` 与通知去重语义 |

允许为远程传输增加协议封装、设备身份、幂等键和能力版本，但不得在 Remote Bridge 或 Mobile 中复制 AgentPort 的权限判断、进程控制、Session 状态机或通知分类。

## 4. 目标用户与平台

### 4.1 用户

- 单个用户连接自己有权使用的电脑。
- 用户已在电脑端安装并配置 AgentPort、Project、Agent 和 Preset。
- 用户主要在离开电脑时检查 Agent 进展、处理需要输入的 Session 或追加指令。

### 4.2 正式支持平台

| 类别 | V2 范围 |
|---|---|
| 手机 | iOS 16+、Android 10+ |
| 平板 | 可运行自适应布局，不承诺专项多栏体验 |
| 电脑端 | macOS 13+、Ubuntu 22.04/24.04 |
| 传输 | SSH 必需；Mosh 可保留实验能力，但不属于 V2 完成门禁 |
| 分发 | 开源源码、构建说明和团队签名模板 |

### 4.3 规模基线

- 支持保存多台电脑。
- 最多 5 台电脑可由用户主动保持连接。
- 前台一次只显示一台远程设备的独立工作空间。
- 单个设备工作空间按 100 个 Session 验收；不提供跨设备聚合列表。
- App 不在启动时静默连接所有电脑。

## 5. 产品原则与硬边界

1. **Terminal is the Agent UI**：Mobile 忠实呈现 Agent CLI，不建立第二套 Agent 对话协议。
2. **电脑端是执行权威**：Agent、Host、PTY、Project 与任务状态均由电脑端拥有。
3. **Session 身份连续**：打开、切换、重连和恢复必须指向同一个 AgentPort/native Session，不以新 Session 冒充恢复。
4. **不猜测 Agent 语义**：不得从终端文本推断问题、审批、完成或失败。
5. **只结构化 AgentPort 自有状态**：生命周期、连接、未读、可信 Hook 事件和控制结果可以结构化。
6. **不静默重放输入**：结果未知的输入由用户决定如何处理。
7. **缓存不是实时**：断线后的最后已知状态必须显示时间和 stale 标识。
8. **App 不拥有 Session**：退出、崩溃、切换页面或断网不得停止电脑端 Session。
9. **最小本地留存**：Mobile 默认不持久化 Session 正文和终端输出。
10. **安全边界不降级**：Host Token、Secret 原值和未脱敏 PTY 数据不得暴露给 Mobile。
11. **无官方云依赖**：V2 不引入 AgentPort 账号、官方中继、遥测或可靠离线推送服务。
12. **移动端只做高频任务**：低频工程管理和高风险数据操作留在电脑端。
13. **设备工作空间隔离**：Project、Session、通知和列表状态均以远程设备为边界，不跨设备合并。
14. **通知语义与桌面一致**：系统通知只用于请求批准和任务完成；其余状态只由 Session 状态图标表达。
15. **快捷启动与桌面一致**：Project 行图标单击即启动；支持权限模式的 Agent 默认完全权限，不增加每次启动确认表单。
16. **Mobile 只发意图**：所有业务操作由远端 AgentPort 现有接口执行；Mobile 和 Remote Bridge 不实现第二套控制逻辑。
17. **终端尺寸有明确所有者**：Mobile 打开/旋转可以取得尺寸所有权；桌面不得静默抢回，必须提示并由用户明确恢复桌面尺寸。

## 6. 信息架构

### 6.1 设备工作空间

一个设备工作空间对应一台远程设备及其电脑端 AgentPort 数据。Mobile 可以保存并保持多台设备连接，但前台任一时刻只能进入一个设备工作空间。

- 顶部设备入口显示当前设备名称与连接状态，点击后打开设备切换 Sheet。
- 切换设备会整体替换 Project、Session、搜索结果和 Recent 上下文，不把多台设备的数据拼成一个列表。
- 每台设备独立保存布局模式、Project 展开状态、搜索/筛选、滚动位置、最近 Session 和当前选中 Session。
- 切回设备时恢复其工作空间状态；缓存数据必须标记最后更新时间和 stale 状态。
- 其他已连接设备可以在后台继续接收权威状态和通知，但不能把 Session 行插入当前设备工作空间。
- 系统通知必须携带设备身份；点击后先切换到对应设备工作空间，再打开准确 Session。

“设备工作空间”仅表示 Mobile 的设备级浏览上下文，不等同于 Git Worktree，也不新增电脑端 Workspace 实体。

### 6.2 Session 的两种布局

当前设备工作空间内提供与桌面端语义一致的两种布局。顶部工具栏只保留一个铃铛按钮作为布局切换器：Project 视图点击铃铛进入活跃 Session，活跃视图再次点击返回 Project；不再同时占用页面高度显示分段控件。

1. **项目与 Session（Projects and Sessions）**
   - 按 `Project → Session` 层级显示当前设备的数据。
   - Project 行左侧为展开/收起与 Project 名称，右侧为与桌面端一致的横向 Agent 快捷启动图标带；Session 行保留桌面端可用的标题、状态、分支/Worktree 摘要和更新时间。
   - 图标带只显示当前设备已安装且未被桌面设置隐藏的 Agent，并继承该设备的 `agentOrder`；内容溢出时可横向滑动，滑动手势不得误触启动。
   - 点击支持权限模式的 Agent 图标立即以完全权限启动；Project Terminal 和不提供权限模式的 Agent 按各自原生权限语义启动，不显示虚假的完全权限标签。
   - 快捷启动只作用于当前设备和该 Project 的当前 checkout，不弹出跨设备、Project、Preset、Worktree 或高级参数选择表单。
   - Project 行末尾若显示 `+`，其语义保持为“更多操作”，不得作为另一种新建 Session 入口；V2 只展示范围内可用操作。
   - 该布局用于浏览完整 Session 历史与 Project 上下文。
2. **活跃 Agent Session（Active Agent Sessions）**
   - 使用扁平列表，仅显示当前设备上 `hostAlive = true`、非 Shell、未处于归档中的 Agent Session。
   - “活跃”只表示对应 Agent Host 进程仍存活，不等同于 `working`、未读、最近有输出或需要输入。
   - 排序与桌面端一致：需关注优先，其次工作中、空闲、未知；同级再按置顶与最近状态时间排序。
   - Agent Host 退出或 Session 开始归档后，应从此布局移除；不得根据终端文本推断存活。
   - 没有符合条件的 Session 时显示“当前设备没有活跃 Agent Session”，并提供切回“项目与 Session”的入口；不得回退显示其他设备数据。

布局模式按设备独立保存。切换布局不改变 Session 身份、不停止 Agent，也不清除另一布局的展开和滚动状态。

### 6.3 一级入口

每个设备工作空间只有一个高频一级入口：

1. **Sessions**：在“项目与 Session”和“活跃 Agent Session”之间切换，通过状态图标识别状态并快速打开 Session。

设备连接、切换与设置通过 Sessions 页的设备 Sheet 进入，不占用独立高频导航项。

### 6.4 Session 沉浸模式

进入 Session 后隐藏一级导航，使用沉浸式终端界面：

- 顶部：紧凑显示返回当前设备 Session 列表、标题、设备与 Project、连接状态和更多操作。
- 主体：唯一终端渲染区域。
- 底部：移动文本输入和可横向滚动的特殊键栏；低频生命周期操作收纳进更多操作 Sheet，不持续挤压终端。
- 临时层：Recent Sheet、Session 信息 Sheet、Session 操作 Sheet。
- 列表与已选择终端同时保持挂载：点击 Session 或在列表向左滑进入全屏终端，在终端向右滑回列表；返回按钮和 Session 行点击始终作为等价路径。滑回列表不得 Detach、清空终端或丢失 xterm 视口。

## 7. 关键用户流程

### 7.1 添加并连接电脑

1. 用户输入电脑名称、地址、端口和用户名。
2. 用户选择密码或导入私钥。
3. Mobile 使用系统安全存储保存凭据引用。
4. 首次连接展示主机指纹并要求用户确认。
5. Mobile 通过 SSH 启动/连接 Remote Bridge；Bridge 完成鉴权与能力协商后，将请求转发给远端 AgentPort 现有接口。
6. 连接成功后进入该电脑的 Session 列表。

V2 不要求 App 内生成密钥、跳板机、主机配置导入导出或 Mosh 参数配置；已有实现可以保留，但不进入主流程和完成门禁。

### 7.2 快速打开 Session

1. App 恢复上次设备工作空间；用户也可以先从设备 Sheet 切换设备。
2. Sessions 页恢复该设备上次使用的“项目与 Session”或“活跃 Agent Session”布局。
3. 每条 Session 显示标题、Project、Agent、状态和更新时间；设备身份由当前工作空间表达，不在每行重复。
4. 用户点击 Session 后立即进入该 Session 的终端。
5. 终端在完成安全 Attach、首次 Mobile resize 和必要回放/重绘后才标记为可输入。
6. 用户可通过返回按钮或向右滑回列表，再点击 Session 或向左滑回同一个全屏终端；切换只改变可见页面，不 Detach Agent。
7. 返回列表时恢复该设备、布局、Project 展开状态、筛选和滚动位置。

### 7.3 Mobile 尺寸适配与桌面恢复

1. 用户在 Mobile 点击 Session 后，Mobile 先完成 Attach，并根据终端实际可用区域计算 `cols × rows`；尺寸不得使用固定机型常量。
2. Mobile 通过现有 `session.control: Resize` 向远端 AgentPort 发送尺寸信号，由 AgentPort 调用现有 Host PTY resize 接口。
3. 首次 Mobile resize 成功后，AgentPort 为当前 Session run 记录尺寸、来源设备、`portrait/landscape`、附件和单调修订号；Mobile 才显示“已适配手机尺寸”。
4. 手机横竖屏切换时，等待安全区域和终端容器布局稳定后重新计算并发送最终尺寸；同一轮布局抖动只提交最后一个有效尺寸。
5. 软键盘、顶部栏、底部输入栏和安全区域的出现不得造成 Mobile 与桌面持续争抢尺寸；V2 只在进入 Session、横竖屏变化或用户明确“重新适配手机”时取得尺寸所有权。
6. 桌面端打开一个当前由 Mobile 持有尺寸所有权的 Session 时，不立即用桌面 ResizeObserver 覆盖 PTY 尺寸，而是在不改变终端布局的提示层显示“已为手机调整，当前终端为 C×R”。
7. 提示提供“恢复桌面尺寸”按钮。用户点击后，桌面根据当前终端实际可用区域计算尺寸，并通过同一 AgentPort resize 接口提交。
8. AgentPort 确认桌面 resize 后将尺寸来源更新为 desktop，桌面隐藏提示并恢复正常自动 resize；失败或结果未知时保留提示并提供重试，不伪造成功。
9. 关闭提示只对当前尺寸修订号静默，不执行 resize；新的 Mobile resize 修订必须再次显示提示。
10. Mobile 与桌面同时附加时采用“最后一次明确取得所有权的 resize 成功结果”为权威；非所有者同步该网格但不得靠持续 ResizeObserver 自动反复覆盖。
11. 桌面取回所有权后，仍在线的 Mobile 显示“当前为桌面尺寸”和“重新适配手机”；只有用户点击该按钮或发生新的横竖屏切换时才能再次取得所有权。
12. Session run 结束或 Restart 产生新 run 后清除旧尺寸所有权；不得把上一 run 的手机提示带入新 Host。

### 7.4 从 Project 行快捷启动 Session

1. 用户进入当前设备的“项目与 Session”布局；“活跃 Agent Session”扁平布局不提供脱离 Project 上下文的启动按钮。
2. 每个 Project 行展示当前设备桌面端可见且可用的 Agent 图标，顺序与该设备桌面设置一致。
3. 图标的可访问名称必须包含 Project、Agent 和权限语义，例如“在 easy-pi 启动 Codex（完全权限）”。
4. 用户点击图标后，Mobile 立即发送快捷启动意图，不打开 New Session 表单，也不重复弹出权限确认。
5. 远端 AgentPort 调用现有桌面 quick-start/create-session 接口；支持权限模式的 Agent 保持 `permission=bypass`、`riskAck=true`、`presetId=null` 和 `transport=pty` 语义，默认标题、命令与环境仍由电脑端解析。
6. Project Terminal 使用电脑端用户权限；Pi 等不提供权限模式的 Agent 使用其原生语义。API 可以保留兼容字段，但 UI 不得声称不存在的 bypass 模式。
7. 创建期间只锁定被点击的图标并显示进度；重复点击不得创建第二个 Session，其他 Project 与 Agent 仍可操作。
8. 创建成功后刷新当前 Project，选中新 Session 并直接进入终端；创建失败时停留在列表、恢复图标并显示可重试错误，不插入幽灵 Session。
9. 当前设备离线、Agent 不可用或能力信息过期时禁用对应图标并提供原因，不降级为本地 Mobile Runtime。

### 7.5 从通知打开 Session

1. Mobile 复用电脑端已经归一化的 `AttentionKind`，只接受 `ApprovalRequested` 和 `TurnCompleted` 两类可通知事件。
2. `ApprovalRequested` 对应 Agent 明确请求批准；`TurnCompleted` 对应一次 Agent turn 完成，不等同于 Session 退出或 Agent Host 退出。
3. App 在线或系统允许的短时后台期间，可以为这两类事件触发本地系统通知。
4. 点击系统通知后，先进入事件所属设备工作空间，再打开绑定的准确 Session 终端。
5. 通知只显示设备、Session 标题和“等待批准/已完成”语义，不包含 AgentPort 自定义审批按钮、选项或正文解析结果。
6. working、creating、idle 波动、interrupted、exited、stopped、failed、unknown、普通新输出和 generic hook 均不触发系统通知，只更新 Session 状态图标。
7. Mobile 不自行解析终端文本识别批准或完成；PTY fallback 如需参与分类，必须由电脑端沿用桌面端同一实现和去重规则。

### 7.6 在 Session 中下达指令

1. 用户点击终端输入区或移动文本输入器。
2. Mobile 将文本封装为 UTF-8 原子输入批次并发送给远端 AgentPort；由 AgentPort 现有 PTY 输入接口写入目标 PTY。
3. 特殊键栏发送确定的控制意图，由 AgentPort 映射为现有终端键序列，例如 Esc、Tab、Shift+Tab、方向键和 Ctrl+C。
4. Agent CLI 接收输入并自行更新其消息、问题、选择或审批界面。
5. 输入结果显示为 sending、accepted/completed、unknown 或 failed。
6. unknown 输入不自动重发；用户可以复制原输入并自行决定是否再次发送。

### 7.7 网络切换与恢复

1. 连接中断后，Mobile 将当前内容标记为 stale/reconnecting，但不清空终端。
2. Remote Bridge 恢复后，从已确认游标继续输出，识别重复和缺口。
3. 恢复期间不允许把尚未获得输入能力的终端显示为可输入。
4. Session 切换和恢复必须同步终端 buffer、DOM viewport、alternate screen 和光标状态。
5. 无法安全续接时明确执行重新 Attach/回放，不伪装无缝恢复。

### 7.8 Session 生命周期控制

- Interrupt：Mobile 发送中断意图，由远端 AgentPort 现有控制接口执行。
- Stop：Mobile 完成用户确认后发送 Stop 意图，以远端 AgentPort 返回的完整进程组清理结果为准。
- Resume/Restart：Mobile 发送恢复意图，由远端 AgentPort 恢复同一 Session 身份；无法精确恢复时必须返回明确降级结果。
- Rename、Pin、Archive：Mobile 发送元数据操作意图，由远端 AgentPort 现有接口执行。
- Permanent Delete：V2 不提供，留在电脑端。

## 8. 功能需求

### 8.1 电脑与连接

| ID | 要求 |
|---|---|
| HOST-01 | 支持保存、编辑、连接、断开和删除多台电脑配置。 |
| HOST-02 | 必填配置为显示名、地址、端口、用户名和凭据引用。 |
| HOST-03 | 支持密码和导入的 OpenSSH 私钥认证。 |
| HOST-04 | 凭据只存于 iOS Keychain/Android Keystore 支持的安全存储。 |
| HOST-05 | 首次连接执行 TOFU；主机密钥变化必须阻断连接。 |
| HOST-06 | 用户主动连接后，最多 5 台电脑可同时在线。 |
| HOST-07 | 离线电脑显示最后连接时间、最后错误和 stale 标识。 |
| HOST-08 | Bridge 能力不兼容时阻断不安全操作并给出升级说明。 |

### 8.2 遥控信号与现有接口复用

| ID | 要求 |
|---|---|
| CTRL-01 | 所有读取和写入请求都发送到当前设备的远端 AgentPort；Mobile 不直接访问 Agent、Host、PTY、进程或电脑端数据库。 |
| CTRL-02 | Remote Bridge 只承担鉴权、能力协商、协议封装和安全转发，不拥有 Session 状态机、权限判断、通知分类或进程控制。 |
| CTRL-03 | 快捷启动、Attach/Detach、PTY 输入、Resize、Interrupt、Stop、Resume/Restart、Rename、Pin 和 Archive 必须复用远端 AgentPort 现有接口。 |
| CTRL-04 | 每个控制信号包含稳定设备 ID、目标资源 ID、操作类型、客户端请求 ID 和所需能力版本；Session 控制还绑定当前 run/attachment，resize 绑定预期 revision；不得依赖当前屏幕文本定位目标。 |
| CTRL-05 | Mobile 只展示远端 AgentPort 返回的 accepted/completed/not executed/unknown/failed，不根据本地超时或界面变化伪造成功。 |
| CTRL-06 | 结果未知的写操作不得自动重放；重试必须使用现有接口支持的幂等语义或由用户明确再次发起。 |
| CTRL-07 | 设备切换、App 前后台切换和重连不得把控制信号路由到旧设备、旧 Session 或旧 Host run。 |
| CTRL-08 | Mobile UI 的可见、启用和禁用状态来自远端 AgentPort 能力协商；能力缺失时禁用并解释，不在 Mobile 侧降级实现。 |
| CTRL-09 | Remote Bridge 可以适配传输 DTO，但不得改变远端 AgentPort 接口的业务结果、权限模式、状态顺序或错误语义。 |
| CTRL-10 | 为尺寸协调新增的 `terminalGeometry` 来源/revision 元数据是现有 resize 接口的 additive control metadata，不得演变为另一套 PTY resize 实现。 |

### 8.3 Session 列表与快速导航

| ID | 要求 |
|---|---|
| LIST-01 | 前台 Session 列表只显示当前设备工作空间的数据，不跨设备聚合。 |
| LIST-02 | 提供与桌面端语义一致的“项目与 Session”和“活跃 Agent Session”两种布局。 |
| LIST-03 | “项目与 Session”按 Project → Session 层级显示，并保留 Project 展开状态。 |
| LIST-04 | “活跃 Agent Session”仅包含当前设备 `hostAlive = true`、非 Shell、未归档中的 Agent Session。 |
| LIST-05 | 点击 Session 或系统通知可一步打开准确 Session。 |
| LIST-06 | 活跃列表排序为需关注、工作中、空闲、未知；同级再按置顶与最近状态时间排序。 |
| LIST-07 | Session 行显示标题、Project/分支摘要、Agent、与桌面端一致的状态图标、语义未读标记和更新时间。 |
| LIST-08 | 提供 Pinned、Needs attention、Unread、Running 和 Failed 快捷筛选，以及标题、Project 和 Agent 搜索。 |
| LIST-09 | 返回列表后恢复当前设备的布局、筛选、Project 展开状态、滚动位置和选择上下文。 |
| LIST-10 | Recent Sheet 只显示当前设备的最近 Session，并支持从终端中快速切换。 |
| LIST-11 | 顶部铃铛是 Project/活跃 Session 的单一布局切换器，并通过 `aria-pressed` 和可读名称同步表达当前状态。 |
| LIST-12 | Session 点击进入全屏终端；列表向左滑、终端向右滑可在两者间切换，且点击/返回键提供等价路径。切换不得 Detach 或重建已选择终端。 |

### 8.4 设备工作空间隔离

| ID | 要求 |
|---|---|
| WS-01 | Mobile 可保存并保持多台设备连接，但前台一次只呈现一个设备工作空间。 |
| WS-02 | Project、Session、Recent、搜索、筛选和通知路由均以当前设备为查询边界。 |
| WS-03 | 设备切换整体替换工作空间；不得将其他设备的行、分组或计数混入当前列表。 |
| WS-04 | 布局模式、Project 展开状态、筛选、滚动位置和最近选择按稳定设备 ID 独立保存。 |
| WS-05 | 切回设备时恢复其独立界面状态；离线缓存必须显示最后更新时间和 stale 标识。 |
| WS-06 | 其他在线设备可以在后台接收请求批准/任务完成事件，但系统通知必须标明设备，点击后显式切换设备再深链 Session。 |
| WS-07 | 快速创建 Session 固定使用当前设备；选择其他设备必须先切换工作空间。 |
| WS-08 | 设备被删除时只清理该设备的 Mobile 工作空间状态，不影响其他设备或电脑端 Session。 |

### 8.5 终端渲染

| ID | 要求 |
|---|---|
| TERM-01 | Session 默认且唯一的 Agent 内容界面是终端。 |
| TERM-02 | 忠实支持 ANSI、颜色、光标、alternate screen、清屏和常见 Agent TUI。 |
| TERM-03 | 支持有限尾部回放、原生历史、Session 内搜索、复制和跳到最新。 |
| TERM-04 | 支持触摸滚动、文本选择、字号调整、横竖屏和安全区域。 |
| TERM-05 | 支持 IME、粘贴、外接键盘和移动特殊键栏。 |
| TERM-06 | Session 切换后恢复正确 viewport，不覆盖用户已经开始的滚动。 |
| TERM-07 | replay transport 完成、parser 完成、renderer 完成、geometry-ready 和 input-ready 必须分别处理。 |
| TERM-08 | Mobile 不解析终端内容来生成消息、问题、选择、审批或完成状态。 |
| TERM-09 | Mobile 点击 Session 并完成 Attach 后，根据终端真实可用区域计算有效 `cols × rows`，通过现有 `session.control: Resize` 请求 AgentPort 调整 PTY。 |
| TERM-10 | Mobile 尺寸计算使用实际字体度量、终端容器、安全区域和持久 UI chrome，不使用固定设备型号或固定 `48×40` 等常量。 |
| TERM-11 | 竖屏与横屏分别计算尺寸；方向变化待布局稳定后防抖，只提交最后一个不同且有效的尺寸。 |
| TERM-12 | V2 的自动尺寸所有权切换只发生在进入 Session 和横竖屏变化；软键盘或瞬时布局抖动不得触发跨客户端 resize 拉锯。 |
| TERM-13 | AgentPort 为当前 Session run 保存最近成功 resize 的 `cols`、`rows`、source kind、source device、attachment、orientation、revision 和时间。 |
| TERM-14 | 尺寸来源和 revision 由 AgentPort 返回；Mobile/桌面不得从当前窗口形状或终端文本推断所有权。 |
| TERM-15 | Mobile resize 成功后才显示已适配；failed/unknown 时保留现有终端并显示“尺寸同步失败/结果未知”及明确重试入口。 |
| TERM-16 | 桌面打开 Mobile-owned 尺寸的 Session 时暂停该 Session 的桌面自动 PTY resize，按权威 Mobile 网格呈现终端，并在顶部提示层显示“已为手机调整”、当前 `C×R` 与来源设备。 |
| TERM-17 | 桌面提示提供可见文字按钮“恢复桌面尺寸”，按桌面当前实际终端区域计算并通过同一 resize 接口提交；成功后恢复 desktop ownership 和自动 resize。 |
| TERM-18 | 关闭桌面提示不执行 resize，只记住当前 revision；新的 Mobile resize revision 必须重新提示。 |
| TERM-19 | 桌面尺寸提示使用不改变终端测量区域的 overlay/chrome，出现和消失不得触发额外 fit/resize 循环。 |
| TERM-20 | Mobile 与桌面同时附加时，最后一次明确取得所有权且被 AgentPort 接受的 resize 生效；非所有者不得持续自动覆盖。 |
| TERM-21 | Session run 结束、Stop 或 Restart 后清除旧 run 的尺寸所有权；旧附件和旧 revision 的 resize 必须被拒绝或忽略。 |
| TERM-22 | resize 后保持同一 Session、buffer、alternate screen、光标和输入通道；不得通过重建 Session 或清空终端实现尺寸适配。 |
| TERM-23 | Mobile 首次打开 Session 时，input-ready 必须等待首次 resize 被 AgentPort 接受并完成必要重绘；失败/unknown 时保持只读并提供重试或返回，不得谎报已适配。 |
| TERM-24 | ownership 被另一客户端明确取得时，非所有者同步权威 grid/renderer 但不发送自动 resize；Mobile 显示当前来源和“重新适配手机”，桌面显示对应手机提示。 |

### 8.6 Session 输入与控制

| ID | 要求 |
|---|---|
| SES-01 | Mobile 通过远端 AgentPort 现有接口请求 Attach、Detach 和实时 PTY 输入输出。 |
| SES-02 | 文本和粘贴作为 UTF-8 原子批次发送，由远端 AgentPort 写入 PTY，不发生批次内字符交错。 |
| SES-03 | 每个输入批次具有 accepted/completed/not executed/unknown/failed 结果。 |
| SES-04 | unknown 输入不得自动重放。 |
| SES-05 | Mobile 发送 Esc、Tab、Shift+Tab、方向键、Ctrl 等控制意图，由远端 AgentPort 现有输入接口映射执行。 |
| SES-06 | Interrupt、Stop、Resume/Restart、Rename、Pin 和 Archive 均通过远端 AgentPort 现有接口执行。 |
| SES-07 | Stop 必须确认，并以电脑端完整进程组清理证据为成功标准。 |
| SES-08 | Resume 保留原 Session 身份；降级为新 Session 时必须明确说明。 |
| SES-09 | 多客户端同时输入时，批次按电脑端接收顺序串行，Mobile 显示瞬时提示。 |
| SES-10 | App 页面切换、断网、退出或崩溃不得停止电脑端 Session。 |

### 8.7 快速创建 Session

| ID | 要求 |
|---|---|
| CREATE-01 | “项目与 Session”布局中的每个 Project 行显示与桌面端同源的 Agent 快捷启动图标带。 |
| CREATE-02 | 图标集合、顺序和隐藏状态读取当前设备的已安装 Adapter、`agentOrder` 和 `agentHidden`，Mobile 不维护第二套排序。 |
| CREATE-03 | Agent 图标带支持横向滑动；必须区分滑动与点击，滑动结束不得触发 Session 创建。 |
| CREATE-04 | 点击图标立即向当前设备 AgentPort 发送当前 Project/current checkout 的 quick-start 意图，不打开创建表单。 |
| CREATE-05 | 远端 AgentPort 复用桌面 quick-start/create-session 接口；支持权限模式的 Agent 保持完全权限语义：`permission=bypass`、`riskAck=true`、`presetId=null`、`transport=pty`。 |
| CREATE-06 | Project Terminal 使用电脑端用户权限；Pi 等没有权限模式的 Agent 使用原生语义，不显示“完全权限/绕过权限”标签。 |
| CREATE-07 | 每个图标的可见标签或辅助说明明确 Agent 与权限语义；无障碍名称同时包含 Project、Agent 和权限语义。 |
| CREATE-08 | 单次创建 pending 期间禁用该图标并阻止重复创建；成功后刷新、选中并直接打开新 Session。 |
| CREATE-09 | 创建失败不产生 Session 行，图标恢复可用并显示可重试错误；设备离线、Agent 不可用或能力过期时禁用并解释原因。 |
| CREATE-10 | Mobile 不提供 Project、Agent、Preset 或 Worktree 的创建维护，也不暴露终端行列、Transport、任意 CLI 参数或权限选择表单。 |
| CREATE-11 | 当前 Project 没有可用 Agent 时不显示空图标带，提供“请在电脑端配置 Agent”的只读说明；Project 展开与已有 Session 浏览保持可用。 |

### 8.8 Session 状态、未读与系统通知

| ID | 要求 |
|---|---|
| ACT-01 | Session 行状态图标复用桌面端状态模型：creating、working、needs_input/等待批准、idle、interrupted、exited、stopped 和 unknown。 |
| ACT-02 | 状态图标必须提供可访问名称，不能只依赖颜色或动画表达；存在状态事件时显示发生时间，异常退出在已知时显示退出码。 |
| ACT-03 | 系统通知仅允许电脑端 `AttentionKind::ApprovalRequested` 和 `AttentionKind::TurnCompleted` 两类权威语义。 |
| ACT-04 | `TurnCompleted` 表示一次 Agent turn 完成；SessionEnd、正常/异常进程退出和 Host 退出均不得冒充任务完成通知。 |
| ACT-05 | working、creating、idle 波动、interrupted、exited、stopped、failed、unknown、普通新输出、generic Notification 和普通提问均不得触发系统通知。 |
| ACT-06 | 请求批准通知显示“等待批准”，任务完成通知显示“已完成”；通知携带稳定设备 ID、Session ID、Session 标题和事件时间。 |
| ACT-07 | 点击系统通知先切换到对应设备工作空间，再打开准确 Session；批准操作仍在 Agent CLI 终端中完成。 |
| ACT-08 | Mobile 不解析终端正文生成通知；电脑端 PTY fallback 必须与桌面端使用相同分类与重复抑制规则。 |
| ACT-09 | 同一批准提示的终端重绘、同一来源事件重放和跨 Hook/PTY 重复证据不得产生重复系统通知。 |
| ACT-10 | Session 未读标记只跟踪尚未查看的请求批准和任务完成语义；普通终端输出不能点亮未读标记。 |
| ACT-11 | 进入准确 Session 后清除对应语义未读标记，不影响其他 Session 或其他设备。 |
| ACT-12 | 前台和系统允许的短时后台期间可发送本地系统通知；App 被系统终止后不承诺实时通知，也不得暗示存在离线推送。 |

### 8.9 本地数据与隐私

| ID | 要求 |
|---|---|
| DATA-01 | 仅持久化电脑配置、凭据引用、主机指纹、设置和少量 Session/通知路由摘要。 |
| DATA-02 | Session 正文和终端输出默认不持久化。 |
| DATA-03 | 日志、错误和诊断不得包含密码、私钥、Secret 原值或完整输入正文。 |
| DATA-04 | Mobile 只接收电脑端完成实时脱敏后的终端输出。 |
| DATA-05 | 不包含账号、云同步、遥测、广告或行为分析 SDK。 |
| DATA-06 | App 不新增独立操作审计或输入正文审计。 |
| DATA-07 | `terminalGeometry` 只包含尺寸与来源元数据，保留范围不超过对应 Session run；不得包含终端正文，run 结束后清除。 |

### 8.10 设置与诊断

| ID | 要求 |
|---|---|
| SET-01 | 支持中文、英文、system/light/dark 和终端字号/主题。 |
| SET-02 | 支持通知总开关和按电脑开关。 |
| SET-03 | 支持减少动效和可访问名称。 |
| SET-04 | 提供连接状态、Bridge 版本/能力和最近错误的只读摘要。 |
| SET-05 | V2 不提供 Secret、Commit AI、Agent、Project、Git、备份和完整电脑端设置。 |

## 9. 明确不在 V2 范围

- 规范化对话视图、Agent 消息重排和 AgentPort 自定义聊天 UI。
- 结构化问题解析、选择卡片、审批卡片和 `structured_input` 产品流程。
- 从终端文本猜测 Agent 状态、完成、失败或需要输入。
- 独立 Activity/Event Feed，以及针对 Session 退出、失败、普通新输出或状态变化的系统通知。
- Mobile 或 Remote Bridge 自己实现 Session 状态机、Agent 启动器、PTY 写入器、进程控制器、权限判断或通知分类。
- 为 Mobile 复制一套与桌面现有接口平行的创建、控制或恢复业务 API。
- 在 Mobile 中执行 Agent 探测、排序、隐藏、恢复和全局配置；Mobile 只读取当前设备的桌面配置结果。
- Project、Preset 和 Worktree 的创建、编辑、删除或协调。
- Branch、auto-stash、Git Changes、Diff、History、Remote 和 Commit。
- 文档树、文件编辑、Markdown/Mermaid 预览和通用代码编辑。
- Secret、Commit AI 凭据、备份、恢复、旧日志清理和索引重建。
- Session 永久删除。
- 脱离 Project/AgentPort Host 的独立 SSH/Mosh Shell；Project 行的 Terminal 图标仍可创建电脑端 Project Terminal Session。
- 完整 SFTP 文件管理、权限修改、远程目录维护和批量文件操作。
- Mosh 作为正式传输门禁；已有实验实现可以保留但不得阻塞 V2。
- 跳板机、硬件密钥、完整 OpenSSH 配置语义和 SSH 端口转发。
- AgentPort 官方账号、云、中继、可靠离线推送和遥测。
- 团队协作、权限角色和远程操作审计。
- 平板专项体验、应用商店发布和预签名安装包。

## 10. 非功能需求

### 10.1 性能

| ID | 指标 |
|---|---|
| PERF-01 | 清进程冷启动至 Session 列表可操作的 p95 不超过 3 秒。 |
| PERF-02 | 点击 Session 后 1 秒内进入可读的 attaching/replaying 状态；网络认证时间单独记录。 |
| PERF-03 | 排除网络 RTT 后，输入提交至本地传输层写入的额外延迟 p95 不超过 100 ms。 |
| PERF-04 | 5 台设备保持在线、当前设备含 100 个 Session 时，布局切换、筛选和导航响应 p95 不超过 200 ms。 |
| PERF-05 | 连续 10 分钟以 1 MiB/min 接收终端输出并执行输入、滚动和切换，不出现超过 500 ms 的主线程停顿。 |

### 10.2 可靠性

- 输出回放、实时输出和历史分页使用单调游标，能够去重并识别缺口。
- transport、parser、renderer 和 input-ready 使用独立状态，不以单一“connected”替代。
- 写操作必须区分 completed、failed 和 unknown。
- App 崩溃、退出和断网不停止电脑端 Session。
- Session 切换不得造成 viewport 跳到错误历史位置、重复输入或终端状态串线。
- 同一 Session 的多客户端输入由电脑端单一顺序权威串行处理。
- Mobile/桌面 resize 必须携带当前 run/attachment/revision 上下文，旧 run 或旧附件的迟到请求不得覆盖新尺寸。
- 桌面尺寸提示本身不得改变终端测量区域或触发 resize feedback loop。

### 10.3 无障碍

- Sessions、状态图标、语义未读、系统通知深链、设备切换、布局切换、电脑配置、尺寸来源提示、“恢复桌面尺寸”、确认框和 Session 控制支持 VoiceOver/TalkBack。
- 支持系统动态字号、足够对比度、减少动效和非颜色状态表达。
- 终端的屏幕阅读器限制必须记录；同时提供搜索、复制、字号和可访问的 Session 元数据。
- 图标按钮必须具有可访问名称；可见图形尺寸与实际命中区域分别验证。

### 10.4 国际化与视觉

- V2 支持 `zh-CN` 和 `en-US`。
- 支持 system/light/dark；终端主题与 Agent CLI 输出保持兼容。
- Session 内容区域减少装饰和卡片嵌套，优先保证终端面积、文本可读性和状态清晰度。

## 11. 安全验收

1. 未通过 SSH 认证的客户端不能发现 AgentPort 数据或 Bridge 能力。
2. 首次主机指纹必须由用户确认；指纹变化必须在启动 Bridge 前阻断。
3. Bridge 不产生公网监听端口。
4. Host Token、Host socket、进程参数和未脱敏 PTY 数据不进入 Mobile DTO。
5. Mobile 存储、日志和诊断不包含密码、私钥、Secret 原值或完整输入正文。
6. unknown 输入不自动重放。
7. Stop 只有在电脑端证明目标 Session 进程组完成清理后才显示成功。
8. Mobile 不解析终端内容或生成 Agent 审批操作。
9. 完全权限快捷启动只能由用户点击明确标注 Agent 和权限语义的 Project 行图标触发，不得后台自动启动或由通知深链触发。
10. 快捷启动的 `riskAck` 只绑定本次明确点击；设备、Project、Agent 或参数发生变化时不得复用为另一次启动授权。
11. 每个遥控请求都必须由远端 AgentPort 现有接口重新执行身份、目标、能力和权限校验；Mobile UI 的可见状态不是授权依据。
12. Remote Bridge 不持久化 Host Token，不允许 Mobile 获得 Host socket 或绕过 AgentPort 接口直接控制进程。
13. resize 请求必须绑定已认证 attachment、当前 Session run 和预期 revision；旧 attachment、旧 run 或越权设备不能改变 PTY 尺寸。

## 12. V2 验收场景

| ID | 场景与通过条件 |
|---|---|
| AC-01 | 使用密码和导入私钥分别连接电脑，完成 TOFU、Bridge 协商并列出 Session。 |
| AC-02 | 电脑端 GUI 关闭时，Mobile 仍可列出、打开、输入、Interrupt 和 Stop Session。 |
| AC-03 | 从 Recent、Needs attention、Unread 以及请求批准/任务完成系统通知一步打开准确 Session。 |
| AC-04 | 打开 line-mode CLI 和 fullscreen TUI Session，Mobile 忠实呈现终端且不生成 AgentPort 卡片。 |
| AC-05 | 在 Agent CLI 自己呈现的提问、选择和审批中，通过文本或特殊键完成交互。 |
| AC-06 | 桌面与 Mobile 同时附加同一 Session，双方实时看到输出，输入批次不交错。 |
| AC-07 | 在输入边界断网，恢复后无重复输出；unknown 输入不自动重发。 |
| AC-08 | Session 切换和重连后 viewport、alternate screen、光标和 input-ready 状态正确。 |
| AC-09 | Mobile 被终止后电脑端 Session 继续运行；重启 App 后恢复同一 Session 和未读状态。 |
| AC-10 | 请求批准和 Agent turn 完成各生成一次系统通知；working/idle 波动、普通提问、新输出、失败、SessionEnd 和 process exit 均不通知。 |
| AC-11 | Stop、Resume/Restart、Rename、Pin 和 Archive 使用电脑端权威结果并正确处理失败。 |
| AC-12 | 同时连接设备 A 与 B 时，A 的 Sessions、Project、Recent、搜索结果和计数中不出现 B 的数据；B 的通知深链会先明确切换到 B。 |
| AC-13 | 在设备 A 设置“项目与 Session”并展开 Project、在设备 B 设置“活跃 Agent Session”后往返切换，两台设备分别恢复自己的布局、展开、筛选和滚动状态。 |
| AC-14 | “活跃 Agent Session”与桌面端使用相同 `hostAlive` 语义和排序；Host 退出、Shell Session 或归档中 Session 不出现在列表，状态文案不能影响筛选结果。 |
| AC-15 | 5 台设备保持连接、单台设备 100 个 Session 及持续终端输出时，设备切换和当前工作空间满足性能目标且不跨设备混排。 |
| AC-16 | VoiceOver/TalkBack 完成连接设备、切换工作空间、切换布局、读取状态图标、选择 Session、打开终端和确认 Stop。 |
| AC-17 | 安全扫描证明无账号、云、遥测、公网监听、凭据泄漏和未脱敏输出。 |
| AC-18 | 中英文、浅色/深色、动态字号、横竖屏、软键盘和外接键盘核心流程可用。 |
| AC-19 | Project 行图标顺序/隐藏项与桌面设置一致；Codex 等支持权限模式的 Agent 单击以 bypass 启动并直接打开，Pi/Terminal 不显示虚假权限模式；横向滑动、重复点击、离线和创建失败均不产生额外或幽灵 Session。 |
| AC-20 | 对 quick-start、Attach、输入、Resize、Interrupt、Stop、Resume、Rename、Pin 和 Archive 逐项追踪，证明 Mobile 信号经 Bridge 转发到远端 AgentPort 现有接口；Mobile/Bridge 中不存在平行状态机、PTY/进程控制或结果推断，能力缺失时操作被禁用。 |
| AC-21 | Mobile 分别以竖屏和横屏打开同一 line-mode/fullscreen TUI Session，只通过现有 resize 接口提交各自最终实测 `cols×rows`；Agent TUI 正确重绘，Session/buffer/光标/输入连续，瞬时布局与软键盘不产生 resize 风暴。 |
| AC-22 | Mobile resize 后桌面打开该 Session，PTY 保持手机尺寸并显示含设备和 `C×R` 的提示；关闭提示不 resize，新 revision 会重现；“恢复桌面尺寸”成功后切换 ownership 并恢复桌面自动 resize，在线 Mobile 同步网格且只在用户点“重新适配手机”后取回；失败/unknown、双端同时附加、旧 run 延迟请求均不会伪造成功或形成尺寸拉锯。 |

## 13. 分阶段交付

### 阶段 1：范围回收与终端单一权威

- 删除 Mobile 对 Agent 内容的结构化解析和卡片呈现。
- 移除 Conversation、Content 和跨设备聚合等非 V2 主导航或列表。
- 建立 Mobile → Remote Bridge → AgentPort 现有接口的遥控映射、能力协商、请求身份和结果回执契约。
- 建立单设备工作空间、Sessions、状态图标、语义未读、设备 Sheet 和沉浸式 Session Shell。

**门禁**：AC-03、AC-04、AC-05、AC-12、AC-20 通过。

### 阶段 2：快速导航、状态图标与通知

- “项目与 Session”、“活跃 Agent Session”、Recent、Pinned、Needs attention、Unread 和桌面一致的状态图标。
- Project 行 Agent 图标带、桌面同源排序、完全权限快捷启动、pending/失败状态和直接打开新 Session。
- 仅请求批准/任务完成系统通知、设备身份、跨设备深链、重复抑制和后台限制说明。

**门禁**：AC-03、AC-09、AC-10、AC-12 至 AC-14、AC-19 通过。

### 阶段 3：终端输入与恢复硬化

- 输入结果状态、unknown 恢复、特殊键、viewport、replay、input-ready 和 run-scoped resize ownership。
- Mobile 横竖屏适配、桌面尺寸提示/恢复、line-mode、fullscreen TUI、多客户端和断网测试。

**门禁**：AC-04 至 AC-09、AC-21、AC-22 通过。

### 阶段 4：安全、性能、无障碍与交付

- 安全扫描、100 Session 性能、双端适配、VoiceOver/TalkBack、中英文和构建说明。

**门禁**：AC-01 至 AC-22 全部通过。

## 14. 主要风险与取舍

| 风险 | V2 取舍 |
|---|---|
| 无云服务导致系统终止后无法可靠通知 | 以 Session 状态图标和语义未读为可靠状态源；批准/完成系统通知仅为在线和短时后台增强 |
| Agent CLI 在窄屏上的 TUI 适配不一致 | Mobile 忠实渲染并提供旋转、字号、特殊键和外接键盘；不通过重做 UI 掩盖问题 |
| 终端文本无法可靠判断 needs input | 只使用电脑端与桌面一致的权威分类；没有语义证据时不通知、不点亮语义未读，只保留当前状态图标 |
| 移动网络可能在输入边界断开 | 使用原子批次和 unknown 状态，不自动重放 |
| 完全权限快捷启动可能因误触创建高权限 Session | 图标明确权限语义、滑动与点击互斥、pending 防重复；保持桌面端单击即启动，不增加每次确认弹窗 |
| Mobile 与桌面接口演进不一致 | Bridge 协商能力版本并通过接口映射测试；能力缺失时禁用，不在 Mobile/Bridge 中复制或猜测业务逻辑 |
| PTY 尺寸全局共享导致 Mobile 与桌面互相覆盖 | AgentPort 记录 run-scoped ownership/revision；自动 resize 仅在明确入口触发，桌面通过提示按钮显式取回所有权 |
| 去掉桌面等价后已有功能成为沉没成本 | 后端能力可以保留；非 V2 UI 不进入主导航、验收和发布承诺 |
| 只用模拟器无法证明真实后台和蜂窝切换 | 在发布说明披露，并将真机验证作为后续发布门禁候选 |

## 15. Definition of Done

AgentPort Mobile V2 只有在以下条件同时满足时才可标记完成：

1. Sessions、状态图标、语义未读、批准/完成通知、电脑连接和沉浸式 Session Shell 完成。
2. Agent 内容只由终端渲染；不存在结构化问题解析、审批卡片或 AgentPort 对话视图。
3. AC-01 至 AC-22 全部有可重复验证证据。
4. 输入、重连、回放、Session 切换和多客户端行为满足可靠性边界。
5. 安全扫描证明凭据、Host Token、Secret 和未脱敏输出未进入 Mobile。
6. iOS/Android 构建、核心无障碍、中英文、主题和性能目标通过。
7. App 退出、崩溃和断网不停止电脑端 Session。
8. 每台设备的列表、Recent、通知路由和界面状态独立，且两种 Session 布局与桌面端语义一致。
9. Project 行 Agent 图标、排序、权限语义、立即启动和失败处理与桌面端快捷启动契约一致。
10. 所有 Mobile 交互信号均路由到远端 AgentPort 现有接口，Mobile/Bridge 没有平行业务控制实现。
11. Mobile 横竖屏 resize、AgentPort 尺寸 ownership/revision、桌面提示与显式恢复通过双端并发验收。
12. 已知通知、真机、后台和 Agent TUI 限制在发布说明中明确披露。

## 16. 相对 V1 的范围变更

### 保留

- SSH/Bridge、安全存储、TOFU、能力协商。
- 多设备连接、设备级工作空间、未读、状态和重连。
- 真实终端、历史、搜索、复制、特殊键和生命周期控制。
- 仅请求批准/任务完成的本地通知、状态图标、语义未读、最小数据、无云和安全边界。

### 重写

- “规范化对话 + 完整终端 fallback”改为“终端是唯一 Agent 内容界面”。
- “结构化问题/审批卡片”改为“Agent CLI 原生终端交互”。
- “桌面功能等价”改为“Session 核心任务闭环”。
- “完整设置与诊断”改为“移动必要设置与连接摘要”。
- “跨设备 Session 聚合”改为“一次一个设备工作空间，设备内提供桌面一致的两种 Session 布局”。
- “Activity 状态流与多类通知”改为“状态图标表达常态，仅请求批准/任务完成触发系统通知”。
- “创建 Session 表单”改为“Project 行 Agent 图标立即以默认完全权限快捷启动”。
- “Mobile 实现远程控制能力”改为“Mobile 只发送交互信号，由远端 AgentPort 复用现有接口执行”。
- “各客户端自动按窗口 resize”改为“Mobile 显式取得尺寸所有权，桌面提示并由用户一键恢复桌面尺寸”。

### 移出 V2

- Agent/Project/Worktree/Git 管理。
- 文档、导出、备份、Secret 和存储维护。
- 脱离 Project 的独立 Shell、完整 SFTP 和正式 Mosh 产品化。
- Session 永久删除、桌面系统能力替代和完整桌面等价矩阵。
