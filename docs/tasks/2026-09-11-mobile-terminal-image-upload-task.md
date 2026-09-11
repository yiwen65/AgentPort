# Task Plan: 移动终端单图 SFTP 上传

- Created: 2026-09-11
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: blocked
- Source: 用户要求快捷键滚动区新增图片图标，系统单图选择、复用 SSH/SFTP 上传、粘贴远端路径且不 Enter。

<!-- task-doc-section:background-goal -->
## Background and goal

最小实现单张 PNG/JPEG 从 iOS PhotosPicker / Android Photo Picker 上传到当前 SSH 主机 ~/.cache/agentport，然后复用 xterm.paste 插入路径。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

一个按钮、两个原生 Picker、一个上传流程。复用现有认证 SSH，通过临时 SFTP channel 传输原始缓存文件，不经 JS/Base64。无多图、压缩、相机、剪贴板图片、Agent 专用逻辑、进度、后台任务、数据库/附件架构或 Session 目录。Relay 没有 SSH 会话，仅明确报不支持，不扩展 Relay 上传协议。现有 Host/Agent 不重启，不自动部署 TestFlight；保留其他会话改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | SFTP spike 新建 SSH 且接收 Base64，不符合直接复用要求 | mobile/src-tauri/src/sftp/mod.rs |
| F-002 | RemoteConnections 持有认证 SSH 或 Relay transport | mobile/src-tauri/src/remote.rs |
| F-003 | 已有剪贴板流程通过 terminal.paste 处理 bracketed paste | mobile/src/terminal/MobileTerminal.tsx |
| F-004 | Tauri 已有原生双平台插件构建接入方式 | 现有 barcode-scanner/clipboard-manager crates |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 仅当前认证 SSH 支持首版；Relay 直接显示明确错误。已向用户说明。
- Assumption: PhotosPicker 选择 HEIC 等不支持格式时明确报错，不转码或压缩。原始 JPEG/PNG 后缀与实际内容匹配。
- Open question: 两个平台真机验收取决于当前设备/模拟器可用性，未运行项不宣称通过。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 系统单图选择与取消正常；Android 使用 ContentResolver，不解析真实路径。
- SFTP 复用当前 SSH，没有重新认证，不中断 PTY。
- 上传成功才粘贴路径，绝无 Enter；切换 Session/run/连接后不误投。
- 重复点击有界，缓存成功/失败清理，上传失败不粘贴，长任务不锁住整个连接表。
- 单图 PNG/JPEG；不添加用户排除的功能。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002。
- Parallel batches: 无，用户要求直接串行执行，不使用子代理。
- Serialization constraints: 两端构建共用生成配置，保留备份后依次执行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 实现最小上传闭环

- Status: done
- Owner: coordinator
- Objective: 原生选择、缓存、复用 SSH 上传、现有粘贴入口。
- Inputs and prerequisites: 上述调用链与用户范围。
- Scope or files: mobile 本地 picker 插件、Rust remote/sftp、平台适配、MobileTerminal 与 Workspace。
- Expected output: 最小功能改动与回归测试。
- Dependencies: None.
- Execution steps:
  1. 增加原生系统 Picker 与缓存清理。
  2. 为临时 SFTP 借用当前认证连接，控制生命周期与目标一致性。
  3. 增加滚动区图标，复用粘贴并防止异步结果误投。
- Acceptance criteria:
  - 核心闭环符合用户限制及上方正确性边界。
- Verification method:
  - 针对性单元测试、隔离 SSH fixture 与两平台构建。
- Validation evidence: TypeScript 与完整 Mobile 434 测试通过；Rust 31 测试通过，扩展真实 OpenSSH fixture 验证 PNG/JPEG 原始内容、权限 0600、同一认证 SSH 上 SFTP 关闭后 PTY 仍可输入。iOS arm64 debug archive 成功；Android arm64 Rust 和 Kotlin 2.0.21 原生 Picker 针对现有 Android 36/Tauri/Activity 1.10.1 classpath 编译成功。完整 APK 与真机交互仍属于 T-002。
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — 验证与提交

- Status: blocked
- Owner: coordinator
- Objective: 验证上传/粘贴与平台构建，提交任务相关改动。
- Inputs and prerequisites: T-001 完成。
- Scope or files: 本任务代码和本文档。
- Expected output: 验证报告、独立 commit。
- Dependencies: T-001
- Execution steps:
  1. 运行相关测试、平台构建和可用的实际交互验收。
  2. 核对未提交工作与生成文件备份，按规则仅重开调试 GUI并截图。
  3. 记录实际结果、限制并提交。
- Acceptance criteria:
  - 不混入其他改动，不重启现有 Host/Agent，不用测试结果代替平台实测。
- Verification method:
  - TypeScript/Vitest、Rust tests、iOS/Android 编译、可用设备验收、diff 检查。
- Validation evidence: 核心验证见 T-001；全量 UI 日志 /tmp/agentport-image-all-ui-tests.log，Rust 日志 /tmp/agentport-image-native-tests.log，iOS 日志 /tmp/agentport-image-ios-build.log。debug GUI 通过统一脚本 --skip-build 重开，PID 99794 精确匹配当前 checkout 可执行路径；/tmp/agentport-image-desktop.png 已检查非白屏，桌面代码未改。
- Blocker: iPhone 已连接并安装修正版，但系统选图到 Agent 图片标签的完整交互尚未验收；Android Gradle 获取 kotlin-gradle-plugin-api:2.0.21 时 TLS 握手被远端中断，offline 模式缺少可用 metadata。Kotlin 源码使用已缓存的实际依赖单独编译成功，不等同 APK 或选图运行验收。
- Unblock condition: 连接解锁 iPhone 以安装并验收 Picker；恢复 Gradle 官方仓库可达性后完成 APK 构建，或用户明确接受当前验证边界后交付。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

测试成功一次粘贴、取消不输入、失败不输入、重复点击、切换/重连/卸载后的结果失效、PNG/JPEG识别及缓存清理。隔离任务 SSH fixture 验证同一 SSH 上 PTY 与 SFTP 并行、真实上传内容相同；不向用户运行中的 TUI 注入测试输入。两端编译分别验证，设备不可用明确记录。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

共享工作区已有文档和 iOS 生成文件改动。系统 Picker 会造成前后台/焦点变化，不能错误套用剪贴板失焦取消使选图永远失效。SFTP 不展开 ~，实际上传必须使用远端 home 的解析路径。禁止自动重连把上传/粘贴送往新连接。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-11: 读取 SSH/SFTP/粘贴边界及原生插件范例；T-001 开始。
- 2026-09-11: T-001 done；短期 SFTP 通过 Arc 借用原有 SSH，不持连接表锁等待 Picker/上传，不调用 disconnect。取消/失败/目标切换/切回/重置/卸载回归通过。
- 2026-09-11: T-002 blocked。iOS archive 成功，设备离线。Android 首次 JAVA_HOME 指向不存在的 JDK，改用实际 openjdk@17；随后官方 Gradle 仓库 TLS 失败，任务级代理及离线重试未解决缺失 metadata，不改产品仓库源/不关闭 TLS 校验。原生 Kotlin 用现有缓存依赖单独编译成功。所有构建后恢复原有生成文件，插件 .tauri/构建缓存未纳入版本控制。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 实现、434 UI 测试、31 Rust 测试、iOS archive、Android Rust/Kotlin 编译通过；桌面 GUI 非白屏确认。
- Limitations: APK 打包和实际系统选图到 Agent 标签的端到端验收未完成；修正版已安装并启动 iPhone，未上传 TestFlight。代码提交不代表 T-002 真机验收完成。

## 2026-09-11 — Agent 图片路径识别修复

- 用户授权修复上传后显示原始路径而非 Agent 原生 `[Image #1]` 的问题。
- 本地 Codex 源码 `tui/src/bottom_pane/chat_composer.rs::handle_paste_image_path` 通过图片解码识别路径并生成标签；`clipboard_paste.rs::normalize_pasted_path` 不展开 `~`。原实现上传至绝对路径却返回 `~/.cache/...`，导致直接文件读取不兼容。
- 最小修正：返回实际 SFTP 上传绝对路径，不改变存储位置、终端粘贴/bracketed-paste、目标隔离或不自动 Enter 的约束；不在前端伪造标签。
- Red：真实 OpenSSH fixture 新增绝对路径断言，旧实现 30 passed / 1 failed，失败文本 `Agent image path must be absolute: ~/.cache/...`。
- Green：修正后 31 Rust 测试通过；真实返回路径可直接读取且与上传字节一致。前端相关 53 测试通过，覆盖粘贴与异步隔离。之前完整 434 前端测试通过。
- iOS arm64 archive 重建成功，16:21 安装到 iPhone 17 Pro Max，16:22 启动成功。未向运行中的用户 Agent 注入输入，尚未宣称真机 `[Image #1]` 验收通过。
- 按统一脚本 `--skip-build` 重开桌面 GUI；PID 69521 可执行路径精确核验，窗口 2303 截图 `/tmp/agentport-image-path-fix-desktop.png` 确认非白屏。桌面代码未改。
- 先前真机验收隔离 fixture 的元数据仍在 `/tmp/agentport-image-fixture.json`；继续验收/清理时仅操作该任务 profile、credential、Shell 与 sshd，不触碰用户 Hosts/Agents。
