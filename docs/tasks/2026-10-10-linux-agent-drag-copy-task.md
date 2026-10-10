# Task Plan: Linux Agent 终端普通拖选复制

- Created: 2026-10-10
- Workspace: /home/w/Project/AgentPort
- Mode: execute
- Overall status: done
- Source: 用户报告 Agent 高亮仍在但 Copy 灰色；确认 Shell 正常、Shift 拖选能复制，并选择普通拖动即可复制。

<!-- task-doc-section:background-goal -->
## Background and goal

修复 Linux Agent 鼠标协议开启时普通拖动无法生成 xterm 选区、Copy 灰色的问题。前次快捷键修复只覆盖已经存在的 xterm 选区。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅桌面前端鼠标选区兼容层及测试。普通左键拖动本地选字，单击与滚轮仍交给 Agent；Ctrl 拖动保留 Agent 行为，Shift 拖动继续使用 xterm 原生路径。不改变 macOS、移动端、Agent 代码或鼠标协议设置。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户确认 Shell 正常，Agent 普通拖选后高亮仍在但 Copy 灰色，Shift 拖选可复制 | 本轮用户交互回答 |
| F-002 | 鼠标协议会禁用 xterm 原生 selection；Linux Shift 强制选区 | xterm SelectionService.ts:429–483、Terminal.ts:724–782 |
| F-003 | 两个菜单只读取 term.getSelection()，不读取 Agent 自绘高亮 | terminals.ts installClipboardCompatibility、TerminalArea.tsx paneContextItems |
| F-004 | 用户要求普通拖动用于复制，同时保留单击、滚轮及修饰键 Agent 拖动 | drag_policy 回答：普通拖动即可复制 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 延迟鼠标按下至识别单击或拖动，可通过公开 xterm API 与 DOM 事件区分本地选区和 Agent 输入；用真实 xterm 与 WebKitGTK 验证。
- Open question: 无阻塞决定。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Linux 鼠标协议开启时普通左键拖动生成真实 xterm 选区，菜单 Copy 可用，Unicode 可复制。
- Agent 不收到本地拖选鼠标报告；单击、滚轮、Ctrl 拖动保持可用，Shift 原生拖选保持可用。
- Shell、macOS 不受兼容层影响；卸载/窗口失焦不遗留手势监听。
- 回归先失败后通过；相关前端测试、类型检查与构建通过；只提交本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 独立。
- Parallel batches: 无并行实现任务；完成后可独立只读审查。
- Serialization constraints: 协调者独占实现、测试和本文档。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 拖选兼容层与回归验证

- Status: done
- Owner: coordinator
- Objective: 在 Linux 区分 Agent 单击和本地拖选并验证菜单复制路径。
- Inputs and prerequisites: 用户行为确认、现有 xterm 5.5 与已运行的 Vite 调试端。
- Scope or files: src/src/terminalMouseSelection.ts、相关测试、src/src/terminals.ts、本文档。
- Expected output: 最小鼠标手势兼容层、回归测试、验证证据和 Git commit。
- Dependencies: None.
- Execution steps:
  1. 真实 xterm 编码鼠标模式下的失败拖选回归。
  2. 普通左键按下延迟判定，拖动转为 xterm Shift 原生选区，单击回放 Agent 事件，Ctrl 拖动直通。
  3. 运行相关测试、WebKitGTK 系统剪贴板验证、构建和差异审查后提交。
- Acceptance criteria:
  - 满足上述全部验收标准。
- Verification method:
  - Vitest 真实 xterm 鼠标协议/选区/输入断言及菜单集成断言；WebKitGTK GTK 事件复放和系统剪贴板读取；npm build。
- Validation evidence: 真实 xterm 回归修复前 4 failed / 6 passed（选区为空），修复后新增鼠标回归 16 项纳入完整 npm test，102 files / 798 tests passed；npm run build 与 tsc 通过；WebKitGTK 2.50.4 原生 GTK 按下/移动/松开/右键复放：selection="copy 中文"、mode="any"、sent=[]、menuDisabled=false、System clipboard="copy 中文"。git diff --check 与版本同步检查通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先观察普通拖动在 1000/1002/1003 鼠标协议下 getSelection 为空；再验证选区内容、Agent 输入缺失、单击/滚轮/Ctrl 拖动报告、菜单状态和剪贴板内容。补充 Shell/macOS、Shift、取消/卸载、反向及跨行拖动。运行邻近 clipboard/input/renderer 测试、tsc 与 production build。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

合成事件不得递归或复制 Agent 输入；必须保留 xterm 原生自动滚动、宽字符和选区绘制。macOS 调试重启脚本不适用于本机 Linux；当前已有 Vite 调试 GUI，应保留 Session，不查杀 Host/Connector。当前桌面截图 DBus 访问被拒，实际 GUI 截图若不可得须披露限制。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-10: 用户确认选择行为和目标；完成 xterm 鼠标协议/菜单读取边界定位，T-001 开始。
- 2026-10-10: 真实 xterm 初始 4 个拖选回归失败；完成手势分流后拖选通过。补充真实右键顺序后再次暴露 3 个失败，修正右键报告与 ANY hover 清空选区的问题。
- 2026-10-10: 只读独立审查未发现阻塞问题；补充取消、卸载、移出终端及拖选后链接点击回归。
- 2026-10-10: WebKitGTK 原生 GTK 复放发现 focus 会替换 DOM renderer 被命中的字形节点，合成按下因目标脱离 DOM 未到达 xterm；改为持久 xterm root 后选区/菜单/系统剪贴板全部通过，并补充字形节点替换回归。
- 2026-10-10: 完整 npm test 798/798、npm run build、tsc、diff 检查和版本同步通过，T-001 完成。现有 Linux Vite 调试 GUI PID 7716 保持运行；未重启或发送任何 Host/Connector 信号。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 全部验收通过；原生 WebKitGTK 拖选→右键→Copy 系统剪贴板验证、798 项完整测试、生产构建及差异审查通过。验证日志：/tmp/agentport-drag-before.log、/tmp/agentport-drag-full-tests.log、/tmp/agentport-drag-build.log；原生复放器与截图：/tmp/agentport-drag-probe.c、/tmp/agentport-drag-probe.png（临时文件不提交）。
- Limitations: 原生复放验证使用独立 WebKitGTK 窗口及真实前端模块，而非自动操作用户当前 Agent 会话。复放窗口截图已确认渲染非白屏；当前 GNOME 拒绝主桌面截图 DBus 请求，未取得实际调试 App 截图。macOS 专用重启脚本不适用于本 Linux/Vite 调试环境；现有调试 GUI 保持打开，发布/安装版尚未重新打包。
