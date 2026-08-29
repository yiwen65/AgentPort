# Task Plan: 终端多主题切换

- Created: 2026-08-29
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户在本会话确认的《共同需求理解摘要》

<!-- task-doc-section:background-goal -->
## Background and goal

当前终端仅随应用有效明暗模式使用 One Dark Pro / One Light 色板。目标是在“设置 → 外观与无障碍”中增加独立、全局、即时保存的终端主题选择器，首发 One、Cupertino、Graphite、Aurora、Ember、Sakura 六个原创主题家族；每个家族均有浅色和深色版本，并同步驱动 xterm 与完整终端工作区表面。保留现有应用“系统 / 浅色 / 深色”外观及 One 默认值。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**Scope**

- 为前后端 Settings 合同增加全局 `terminalTheme`，合法值为 `one | cupertino | graphite | aurora | ember | sakura`，旧数据库缺值时默认 `one`。
- 建立 12 组内置终端色板，覆盖背景、正文、光标、光标反色、选区、ANSI 16 色及终端工作区表面 token。
- 应用明暗模式决定所选主题家族的浅/深版本；切换主题或系统模式时，所有现有和新建 xterm 即时同步并刷新纹理。
- 在外观设置中加入可键盘及屏幕阅读器使用的主题卡片网格，点击后即时保存；补齐中英文文案、失败反馈及视觉样式。
- 终端工作区中的 xterm、边缘、滚动条、文档正文与代码表面跟随终端主题；侧栏、设置、弹窗继续跟随应用主题。
- 增加对持久化、迁移、运行时同步、设置交互、色板结构与对比度的自动化验证，并完成 Debug App 视觉验收。

**Non-goals**

- 不实现整套应用换肤、Project/Session 覆盖、自定义/导入/主题市场或首次启动引导。
- 不改变现有应用主题默认值、平台支持范围、Session 生命周期或终端滚动/重放行为。
- 不复制 Apple、Vercel 或第三方主题的专有资产与完整配色；仅采用克制层级、语义 token、适配明暗模式和清晰对比等设计原则。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | xterm 当前只有按有效应用明暗模式索引的 One Dark/Light 两套硬编码色板，切换会清理 texture atlas 并 refresh。 | `src/src/terminals.ts:646-725`, `src/src/terminals.ts:2652-2661` |
| F-002 | 应用主题应用入口已经统一计算系统明暗、设置 `data-theme` 并调用 `applyXtermTheme`。 | `src/src/actions.ts:187-226` |
| F-003 | Rust Settings 通过 SQLite key/value 显式读取和保存，缺失字段使用 `Settings::default()`，适合无 migration 文件地兼容新增偏好。 | `crates/agentport-core/src/models.rs:871-925`, `crates/agentport-core/src/db/mod.rs:3899-4022` |
| F-004 | 外观设置已有“立即写入、失败回滚、阻止并发偏好写”的应用主题交互模式。 | `src/src/components/SettingsDialog.tsx:1258-1281`, `src/src/components/SettingsDialog.language.test.tsx:88-138` |
| F-005 | 终端和文档工作区已通过 `--bg-term`、`--term-text`、`--workspace-*`、`--terminal-scroll-thumb` 等 CSS token 共享 One 表面。 | `src/src/styles.css:20-205`, `src/src/styles.css:2735-2750`, `src/src/styles.css:3130-3200`, `src/src/styles.css:3460-3545` |
| F-006 | 前端使用 Vitest、TypeScript 和 Vite；仓库提供 Debug App 重建脚本并要求精确重启、进程路径与非白屏截图确认。 | `src/package.json:7-13`, `AGENTS.md` |
| F-007 | 用户已明确确认 6 套原创主题、卡片网格、全局即时生效、One 默认、完整终端工作区边界和可访问性优先。 | 本会话《共同需求理解摘要》及“确认并继续”答复 |
| F-008 | Apple HIG 与 Vercel Geist 均强调明暗适配、语义颜色层级和可读对比；Apple 对普通文本给出 4.5:1 基线。 | `https://developer.apple.com/design/human-interface-guidelines/color`, `https://developer.apple.com/design/human-interface-guidelines/accessibility/`, `https://vercel.com/geist/colors` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 主题英文专名在中英文界面保持一致，说明、提示和无障碍标签本地化；用户已在需求确认中接受。
- Assumption: 终端主题继续由后端 Settings 作为事实源，前端不增加第二套独立持久化；允许复用现有启动期本地外观 hint，但不依赖它保证正确性。
- Assumption: WCAG 自动化门槛覆盖基础正文/背景（至少 4.5:1）及适合作为正文前景的 ANSI 槽位；传统低亮 `black` 等语义槽位单独记录并视觉审校，不伪称全部 ANSI 组合均满足正文 AA。
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `terminalTheme` 在 Rust/TypeScript 合同中类型收敛，旧数据库和未知持久化值安全回退到 `one`，保存/重载保持用户选择。
- 6 个家族各含浅/深完整色板；基础 foreground/background 对比度均不低于 4.5:1，色板定义有结构和回退测试。
- 应用明暗有效模式变化只切换所选家族的对应版本；主题选择不改变现有应用 `theme`。
- 卡片网格准确显示 6 个主题、当前选中态、终端文字/ANSI 预览，具备 radiogroup/radio 语义、键盘焦点、非纯颜色选中标记和中英文文案。
- 点击主题后所有已打开 xterm 和完整工作区即时更新并自动保存；失败时 store、草稿、DOM 和终端全部回滚并显示错误。
- 新建终端使用当前所选色板；切换不重建 Session、不清空内容、不改变滚动状态。
- 相关 Vitest、i18n 检查、前端 build、Rust 定向测试和必要集成测试通过。
- `scripts/rebuild-debug-app.sh` 成功；仅精确关闭旧 Debug GUI，`open -n` 后用 `ps` 验证目标可执行路径，并截图确认设置页和终端非白屏、关键主题视觉正常。
- Git 最终只提交本任务相关文件并创建一个任务 commit。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-003 -> T-004 -> T-005 -> T-006 -> T-007 -> T-008`; `T-002 -> T-003`; `T-002 -> T-004`。
- Parallel batches:
  - Batch A: T-001（前端主题核心）与 T-002（后端设置持久化）并行。
  - Batch B: T-003（设置卡片 UI）在 Batch A 合入后执行。
  - Batch C: T-004（跨仓库测试/fixture 整合）串行执行。
  - Batch D: T-005 至 T-008 依次进行验证、审查、Debug 视觉验收和提交。
- Serialization constraints: `types.ts/actions.ts/terminals.ts` 由 T-001 独占；Rust Settings 文件由 T-002 独占；T-003 才可改 `SettingsDialog.tsx/styles.css/locales`；authority document 始终仅由 coordinator 修改。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立终端主题目录与运行时同步

- Status: done
- Owner: coordinator
- Objective: 用单一前端主题目录定义 6×2 色板，并让应用主题入口和所有 xterm 按 `terminalTheme + effectiveTheme` 即时同步。
- Inputs and prerequisites: 已确认主题阵容；F-001、F-002、F-005。
- Scope or files: `src/src/terminalThemes.ts`（新增）、`src/src/terminalThemes.test.ts`（新增）、`src/src/types.ts`, `src/src/actions.ts`, `src/src/terminals.ts`。
- Expected output: 类型安全的主题目录、CSS token 应用函数、xterm 主题选择/刷新路径和色板/对比度测试。
- Dependencies: None.
- Execution steps:
  1. 定义主题 ID、元数据、浅深 palette 和安全回退。
  2. 设计 12 套完整 ITheme 与必要工作区语义 token，保持 One 当前值兼容。
  3. 将 xterm 创建/切换改为主题 ID 与明暗模式双键索引；应用 CSS token 和 dataset。
  4. 增加目录完整性、One 兼容、基础对比度和回退测试。
- Acceptance criteria:
  - 6×2 palette 字段完整、基础对比度达标，One 值不回归。
  - 现有句柄切换 refresh/clearTextureAtlas，新句柄直接使用当前 palette。
  - 应用 `theme` 与终端 `terminalTheme` 相互独立。
- Verification method:
  - `cd src && npx vitest run src/terminalThemes.test.ts`
  - `cd src && npx tsc --noEmit`
- Validation evidence: `cd src && npm test -- --run src/terminalThemes.test.ts` 通过（4 tests）；测试覆盖 6×2 完整性、One 精确兼容、未知值回退、基础/工作区文字 AA、新主题可读 ANSI 槽位与 CSS token 应用。`cd src && npx tsc --noEmit` 仅报告 5 个既有 Settings test fixture 缺少新必填字段，已明确归入 T-004，无 T-001 生产代码类型错误。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 扩展后端设置合同与兼容持久化

- Status: done
- Owner: coordinator
- Objective: 在 Rust Settings 中加入受限 `TerminalTheme` 枚举，并可靠默认、加载、保存 6 个合法值。
- Inputs and prerequisites: 已确认 One 为默认；F-003。
- Scope or files: `crates/agentport-core/src/models.rs`, `crates/agentport-core/src/db/mod.rs` 及同文件测试。
- Expected output: camelCase API 字段 `terminalTheme`、SQLite key `terminal_theme`、兼容默认/未知值回退和 round-trip 测试。
- Dependencies: None.
- Execution steps:
  1. 定义可序列化枚举及稳定字符串映射。
  2. 更新 Settings 默认、数据库 load/save。
  3. 增加缺失值、合法值 round-trip 和未知值回退测试。
- Acceptance criteria:
  - 旧 DB 无字段时加载 `One`；六个值均可保存再加载；未知值回退 `One`。
  - 不改变其他 Settings 字段和 telemetry 约束。
- Verification method:
  - `cargo test -p agentport-core settings --lib`
- Validation evidence: `cargo test -p agentport-core settings --lib` 通过（4 passed）；`cargo test -p agentport-core terminal_theme --lib` 通过（2 passed）；`cargo fmt -- crates/agentport-core/src/models.rs crates/agentport-core/src/db/mod.rs` 完成。缺失字段由 default One 覆盖，测试覆盖六值 round-trip 与未知值回退。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 实现设置页主题卡片与工作区视觉

- Status: done
- Owner: coordinator
- Objective: 在外观设置中增加高审美、可访问、即时保存的主题卡片网格，并让文档/代码等完整终端工作区消费主题 token。
- Inputs and prerequisites: T-001、T-002 已完成；现有即时偏好交互模式 F-004。
- Scope or files: `src/src/components/SettingsDialog.tsx`, `src/src/styles.css`, `src/src/components/MermaidBlock.tsx`, `src/src/components/FlowGraph.tsx`, `src/src/locales/fragments/{zh-CN,en-US}/settings-ui.json`, `src/scripts/i18n-shared-value-allowlist.json`, `src/src/components/SettingsDialog.terminal-theme.test.tsx`。
- Expected output: 6 张真实色板预览卡、明确选中/焦点状态、即时保存及失败回滚、终端工作区无接缝 token 样式。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 复用立即保存互斥锁，加入 terminal theme 切换与回滚。
  2. 构建语义 radiogroup/card preview 和无障碍状态提示。
  3. 增加响应式两列/窄屏单列样式，尊重 reduced motion。
  4. 将文档正文、代码块、边界和滚动条切到终端专属 token；补齐双语。
- Acceptance criteria:
  - 卡片在浅深应用模式均清晰，选中态有图标/边框/文本而非仅颜色。
  - 主题写入期间阻止冲突偏好与关闭；失败完整回滚。
  - 设置/侧栏应用色不被终端主题 token 污染。
- Verification method:
  - 定向 Vitest 设置 UI 测试。
  - `cd src && npm run i18n:check && npm run build`
- Validation evidence: `cd src && npm test -- --run src/components/SettingsDialog.terminal-theme.test.tsx src/terminalThemes.test.ts src/components/MermaidBlock.test.tsx` 通过（12 tests）；覆盖 6 卡/选中标记、即时保存、应用主题独立、完整失败回滚、busy fence 及 Mermaid 主题集成。`npm run i18n:check` 通过；`npx vite build` 成功（2572 modules transformed）。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 整合合同 fixture 与回归测试

- Status: done
- Owner: coordinator
- Objective: 更新所有严格 Settings fixture，并覆盖设置交互、运行时同步和明暗配对的跨模块行为。
- Inputs and prerequisites: T-001、T-002、T-003 已完成。
- Scope or files: 受新必填 Settings 字段影响的 `src/src/**/*.test.*`、必要的既有测试或新集成测试；不改生产行为，除非测试证明本任务实现缺口。
- Expected output: 无类型逃逸的 fixture 更新及关键行为回归测试。
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. 查找所有 Settings literal 并显式加入 `terminalTheme: "one"`。
  2. 测试成功即时保存、写入失败回滚、偏好写并发阻止、应用明暗配对和现有 xterm 更新。
  3. 运行前端完整测试并修复仅由本任务引入的失败。
- Acceptance criteria:
  - 不以 optional/`as any` 绕过新合同。
  - 前端完整测试通过且关键新行为有直接断言。
- Verification method:
  - `cd src && npm test`
- Validation evidence: 5 个严格 Settings fixture 均显式加入 `terminalTheme: "one"`；新增 runtime pairing 与 xterm in-place repaint 断言。`cd src && npx tsc --noEmit` 通过；定向 runtime/renderer/settings/catalog 测试 83/83 通过；首次完整测试发现新增重复 `.pi-rpc-composer textarea` selector 使既有 CSS contract test 取到错误 rule，合并 selector 后 `cd src && npm test` 复跑为 61 files、370 tests 全通过（仅保留既有 jsdom canvas stderr）。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 执行跨栈验证

- Status: done
- Owner: coordinator
- Objective: 运行与改动风险匹配的完整静态、测试、构建和 Rust 验证并记录实际结果。
- Inputs and prerequisites: T-001 至 T-004 已完成。
- Scope or files: 验证为主；仅修复验证揭示的本任务缺陷。
- Expected output: i18n、前端测试/build、Rust 定向测试通过，diff 与状态干净可审。
- Dependencies: T-004.
- Execution steps:
  1. 运行 i18n、完整 Vitest、TypeScript/Vite build。
  2. 运行 agentport-core Settings 定向测试，必要时扩展至相关 crate 测试。
  3. 检查 `git diff --check`、`git status` 和改动范围。
- Acceptance criteria:
  - 所有计划命令通过；失败不得仅靠代码阅读忽略。
- Verification method:
  - `cd src && npm run i18n:check && npm test && npm run build`
  - `cargo test -p agentport-core settings --lib`
  - `git diff --check`
- Validation evidence: `cd src && npm run i18n:check && npm run build` 通过（TypeScript + Vite 2572 modules）；当前完整 `npm test` 为 61 files、370 tests 全通过。`rustfmt --edition 2021 --check` 两个改动 Rust 文件通过；`cargo test -p agentport-core terminal_theme --lib` 为 3/3，camelCase contract 单测 1/1，settings round-trip 定向测试通过。补充运行完整 core lib 时 319 passed/1 unrelated capability probe failed，失败用例随后 exact 单独复跑 1/1 通过，判定为既有环境/并行探测 flake，不影响本任务定向门禁。`git diff --check` 通过；误触发 workspace rustfmt 的 6 个无关文件已按初始 clean 状态精确恢复，最终 status 仅含任务文件。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 对抗性审查与收敛

- Status: done
- Owner: theme-reviewer + coordinator
- Objective: 独立审查持久化兼容、主题同步、对比度、无障碍、视觉边界和无关回归，并修复证据充分的问题。
- Inputs and prerequisites: T-005 验证通过。
- Scope or files: 本任务 diff；必要修复限制在已确认范围。
- Expected output: 具体 findings 清零或明确记录限制，修复后重跑受影响验证。
- Dependencies: T-005.
- Execution steps:
  1. 由 reviewer 阅读 diff 和关键路径并提出可行动 finding。
  2. coordinator 核验 finding、做最小修复。
  3. 重跑受影响测试并记录结果。
- Acceptance criteria:
  - 无未处理的 correctness/accessibility 高中风险 finding。
- Verification method:
  - diff 审查；受影响定向测试；`git diff --check`。
- Validation evidence: reviewer run `6ca2d518-c29e-4cd4-833c-1db36506abab` 完成只读审查，提出 2 个 medium finding：Git Center 顶栏/差异代码意外继承终端 token；Cupertino Dark block cursor 字符对比仅约 3.65:1。coordinator 核验后将 Git surface/diff 改回 app tokens、将 cursorAccent 改为背景深色，并新增 scope CSS 与 cursor 可见/字符对比门禁。`cd src && npm test` 复跑 62 files、372 tests 全通过；`npm run build` 通过；`git diff --check` 通过。无未处理 correctness/accessibility 高中风险 finding。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 重建并视觉验收 Debug App

- Status: done
- Owner: coordinator
- Objective: 按仓库规则重建、精确重启 Debug App，并验证设置卡片与实际终端主题非白屏且视觉正常。
- Inputs and prerequisites: T-006 完成；macOS GUI/截图能力可用。
- Scope or files: `target/debug/bundle/macos/AgentPort.app` 构建产物；不关闭 release App 或 host。
- Expected output: 成功构建、目标 GUI 路径证据和至少设置页/终端的非白屏截图检查。
- Dependencies: T-006.
- Execution steps:
  1. 运行 `bash scripts/rebuild-debug-app.sh`。
  2. 精确定位并关闭旧 debug GUI PID，执行 `open -n`。
  3. 用 `ps` 验证可执行路径；激活准确进程并截图检查至少 Graphite、Cupertino/Aurora 及 One 的设置预览与终端表面。
- Acceptance criteria:
  - 构建/启动成功，目标进程路径准确，未触碰 release App/host，截图非白屏且无明显接缝、溢出或不可读文本。
- Verification method:
  - 重建脚本退出码；`ps`；`screencapture`/可用窗口截图与人工检查。
- Validation evidence: `bash scripts/rebuild-debug-app.sh` 成功完成 frontend、Host、custom-protocol GUI 与 ad-hoc signing（Bundle ID `com.agentport.desktop.debug.c9d007c8147e`）。初始 TCC blocker 经用户授予 Screen Recording 并手动完成设置导航后解除；当前 Debug GUI PID `69451` 的 executable 精确为 `/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`，window `3284` 可由 `screencapture -l` 可靠捕获。从重建前到四张截图及首次提交后的检查期间，7 个 `agentport-host` 始终为 PID `4264, 6452, 18395, 23863, 65840, 66233, 71647`，Debug GUI 重启未关闭其中任何一个。深色设置截图 `/tmp/agentport-theme-qa/settings-graphite-open.png`（SHA-256 `cb2b91a33fe6a0c3e808f67301daedb2ccc0fbd7384f92f62556b5523944ecc8`）和浅色设置截图 `settings-graphite-light.png`（`90cade7573f9f8b36dfd231448b7ea8bc63bc30763d3ae47db736fc4f8f16a86`）均完整显示 6 张 3×2 色板卡，Graphite 的边框与勾选标记清楚，无溢出或低对比；One、Cupertino、Aurora 等预览均可辨。Graphite 深色实际终端截图 `settings-graphite.png`（`126903afaad01c3a4a613ed40d5cc055df4ee6c3fd52dd46a0dd8ca1ccd07653`）和浅色实际终端截图 `terminal-graphite-light.png`（`323683f6671ce859fffcccaacf49143fbbde5afe63c420596bece6fdc3727d9d`，2624×1824、24,162 colors）均非白屏；xterm 背景/正文、工作区边缘、标题栏 underlap、光标与 ANSI 色同步，无明显接缝或不可读文本。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 最终状态与任务提交

- Status: done
- Owner: coordinator
- Objective: 完成 authority document、最终检查并创建仅含本任务改动的 Git commit。
- Inputs and prerequisites: T-007 完成或有诚实记录的环境 blocker；所有产品验收项已有证据。
- Scope or files: 本任务源文件、测试、locale、task document，以及本任务已验证格式化 detour 的 `LEARNS.md` 记录。
- Expected output: validator 通过、final validation 准确、单一任务 commit。
- Dependencies: T-007.
- Execution steps:
  1. 更新所有任务状态、证据、最终验证结果和限制。
  2. 验证 task document 与 Git diff/status。
  3. 暂存本任务文件并创建语义化 commit；确认提交后状态。
- Acceptance criteria:
  - task document validator 通过；commit 存在且不混入无关改动。
- Verification method:
  - `python3 .../task_document.py validate --path ...`
  - `git diff --cached --check`, `git show --stat --oneline HEAD`, `git status --short`
- Validation evidence: `python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path docs/tasks/2026-08-29-terminal-theme-switcher-task.md` 通过；`git diff --cached --check` 通过，首次暂存清单为 24 个本任务源码、测试、locale 与 task document 文件，无未暂存或未跟踪改动；`git commit -m "feat(terminal): add curated color themes"` 成功创建单一任务 commit。首次提交后 `git show --stat --oneline --summary HEAD` 确认主题为 `feat(terminal): add curated color themes`、24 files，`git status --short` 为空；最终状态与已验证的 scoped-rustfmt lesson 通过 amend 纳入同一 commit，最终为 25 files。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. **Palette unit**: 主题 ID 完整、每个模式字段齐全、One 兼容、未知值 fallback、基础 foreground/background WCAG AA；记录 ANSI 低亮语义例外。
2. **Backend contract**: `Settings::default()`、SQLite 缺失/未知值回退、六主题 round-trip、JSON camelCase 序列化。
3. **Settings UI**: 6 个 radio card、选中状态、即时成功保存、失败回滚、忙碌互斥、双语 key。
4. **Runtime integration**: CSS dataset/token、现有 xterm clear atlas + refresh、新 xterm 选中 palette、系统明暗变化仍留在同一主题家族。
5. **Regression**: 完整 Vitest、i18n checker、TypeScript/Vite build、Rust Settings 定向测试、diff whitespace。
6. **Visual**: Debug App 设置页在浅/深模式检查卡片层级、键盘焦点与窄宽布局；实际终端至少抽查中性、冷色、暖色主题及 One 回归，并确认非白屏/无接缝。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- **双事实源/色值漂移**：若 CSS 与 xterm 各自复制色板会产生边缘接缝；采用单一 TypeScript 目录，并由主题应用入口写入终端专属 CSS token。
- **设置写竞争**：语言、应用主题、终端主题分别即时保存，可能以旧 snapshot 覆盖彼此；复用同一 busy fence，测试并发阻止和失败回滚。
- **xterm 已绘制缓存**：仅改 option 可能保留旧 canvas；保留 clearTextureAtlas + refresh，不重建句柄。
- **ANSI 对比度语义**：`black`/低亮槽位既可作为背景也可作前景，无法诚实承诺所有组合 AA；自动化保证基础正文并审校可读前景，明确例外。
- **设置面板高度**：6 张卡可能导致溢出；使用响应式网格并依赖既有 content scrolling，不压缩其他无障碍控件。
- **GUI 权限**：Screen Recording/Accessibility 曾阻止截图与自动化交互；已记录原始错误，用户随后授予 Screen Recording 并手动完成设置导航，四张可信窗口截图已完成视觉验收。Accessibility 仍未传递给自动化进程，但不再阻止本任务已定义的像素检查。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-29: 用户通过结构化确认锁定需求范围并授权实施。
- 2026-08-29: 检查当前 Settings、xterm 主题、CSS token、测试脚本和仓库规则；创建 execute 模式 authority document。
- 2026-08-29: Batch A 启动：T-001 分配给 `frontend-theme-core`，T-002 分配给 `backend-settings`；两者文件边界不重叠。
- 2026-08-29: 两次独立 writer DAG（runs `026ef97d-9a20-4540-9212-53faa8d10592`、`628c0e37-2db9-4700-9e71-b33419c9275c`）均在无文件产出的情况下以 `task_inconclusive` 失败；coordinator 接管 T-001/T-002，保持原文件边界并顺序实施。
- 2026-08-29: T-002 完成；Rust Settings 新增 `TerminalTheme`，SQLite 缺失/未知回退 One，六主题 round-trip 定向测试通过。
- 2026-08-29: T-001 完成；单一 TypeScript 主题目录已接管 xterm 与工作区 token，6×2 色板/对比度/One 兼容测试通过；TypeScript 剩余 5 个 fixture 更新留给 T-004。
- 2026-08-29: Batch B 启动；T-003 由 coordinator 实现设置卡片、即时保存回滚、双语与终端工作区 token 样式。
- 2026-08-29: T-003 完成；6 卡画廊、即时成功/回滚/busy fence、双语、完整终端文档/图表 token 已通过 12 个定向测试、i18n checker 与 Vite 构建。
- 2026-08-29: Batch C 启动；T-004 更新严格 Settings fixtures 并补运行时/合同回归。
- 2026-08-29: T-004 完成；TypeScript 合同、runtime 明暗配对与 xterm 原地 repaint 均有直接测试；完整 Vitest 370/370 通过。
- 2026-08-29: T-005 启动跨栈最终验证。
- 2026-08-29: T-005 完成；前端完整测试/build/i18n、Rust 定向测试、格式与 diff 检查通过。完整 core 补充测试出现一个无关 capability probe flake，exact 复跑通过；误格式化的无关 Rust 文件已精确恢复。
- 2026-08-29: T-006 启动独立对抗性审查。
- 2026-08-29: T-006 完成；独立 reviewer 的 Git Center scope leak 与 Cupertino cursor 对比两项 medium finding 均已修复并回归，完整前端 372/372 与 build 通过。
- 2026-08-29: T-007 启动 Debug App 重建、精确重启与视觉验收。
- 2026-08-29: Debug bundle 构建/签名成功；最终 GUI PID 22704 路径准确，window 3140 onscreen 1080×721，7 个 Host 均保持。Screen Recording/Accessibility TCC 分别以黑色单帧/`could not create image from window` 和 `-25211` 阻止像素与交互验收；T-007 转 blocked，等待用户授权或明确豁免。
- 2026-08-29: 用户完成 Screen Recording 授权；系统重启 Debug GUI 为 PID 69451、window 3284，7 个 Host PID 均保持。用户手动打开外观设置并选择 Graphite，解除 T-007 blocker。
- 2026-08-29: 深/浅设置页与 Graphite 深/浅实际终端共四张窗口截图均通过人工像素检查；6 卡布局、选中状态、文字对比、终端表面同步和 underlap 均正常，T-007 完成。
- 2026-08-29: T-008 启动；准备最终 document validator、暂存范围检查和任务 commit。
- 2026-08-29: authority document validator 与 staged diff check 通过；24 个任务文件完成单一语义化 commit，首次提交后工作区 clean。
- 2026-08-29: 将本任务误用 `cargo fmt -- <paths>` 导致 workspace 格式化扩散、随后精确恢复的可复用 lesson 合并到 `LEARNS.md`；最终 commit 共 25 个任务相关文件。
- 2026-08-29: T-008 完成；最终状态与 lesson 经 validator 后 amend 到同一任务 commit，Debug GUI PID 69451 保持打开。重建、截图与首次提交后检查期间 7 个 Host 均未中断；更晚的最终进程复核发现两个已完成/idle shutdown armed 的 easy-pi Host（65840、4264）分别收到 AgentPort `client_stop` 后正常退出，当前剩余 5 个。任务执行未发送 kill/stop Host 命令，当前任务 Host 23863 保持不变。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-008 全部完成。前端完整 Vitest 62 files、372 tests 通过，i18n checker 与生产 build 通过；Rust 默认/未知值/六主题 round-trip 与 camelCase contract 定向测试通过；独立审查的两项 medium finding 已修复并回归；`git diff --check`、staged diff check 和 authority document validator 通过；四张 Debug App 设置/终端深浅截图均非白屏并完成视觉检查；单一任务 commit 已创建。
- Limitations: macOS Accessibility 权限仍未传递给自动化进程，因此设置导航由用户手动完成；Screen Recording 已生效并提供可信窗口像素证据。完整 `agentport-core` 补充测试曾有 1 个无关 capability probe 并行 flake，对应用例 exact 复跑 1/1 通过；本任务 Rust 定向门禁全部通过。最终复核时两个此前已完成并进入 idle-shutdown 状态的无关 easy-pi Host 被 AgentPort 以 `client_stop` 正常停止，故当前 Host 数为 5；Debug 重启与本任务命令均未终止 Host。
