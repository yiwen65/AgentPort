# AgentPort Mobile v1.0 技术架构决策

> 状态：Accepted for implementation<br>
> 日期：2026-09-01<br>
> 产品输入：`docs/mobile-app-prd.md`<br>
> 执行权威：`docs/tasks/2026-09-01-agentport-mobile-v1-task.md`

## 1. 决策摘要

AgentPort Mobile 采用**独立 Tauri 2 Mobile + React 应用**，位于 `mobile/`。电脑端新增 Tauri-free 的 `agentport-service` 应用服务层、版本化 `agentport-remote-protocol` 协议 crate，以及只通过 SSH stdio 启动的 `agentport-remote-bridge` 二进制。

- 桌面、Core、Service、Bridge、共享协议：PolyForm Noncommercial 1.0.0（非商业免费，商业用途需作者书面授权，见仓库根 `LICENSE`/`LICENSING.md`）。
- 独立移动 App（`mobile/`）：GPL-3.0-only，不禁止商用，分发时按 GPLv3 提供对应源码；它链接的 Mosh 组件同样是 GPLv3 上游代码。
- 手机不编译 `agentport-core`，不拥有电脑端 SQLite、Git、Secret、PTY 或 Agent 进程；只持有主机配置、凭据引用、最小缓存和远程 view model。
- SSH/SFTP 由移动 Tauri Rust 层实现，候选为 `russh`/`russh-sftp`；固定版本只能在双端 target 编译与 fixture 通过后写入 lockfile。
- Mosh 由独立原生 Tauri plugin 封装 GPLv3 客户端代码；Mosh 只承载实时终端，控制和业务请求继续走 SSH Bridge。
- 终端继续使用 xterm.js，并以移动 touch/IME/selection/special-key/a11y spike 作为进入完整功能开发的门禁。

该许可划分是用户确认的工程策略，不是法律意见：桌面端禁止商用（商用需授权），移动端按 GPLv3 开放且允许商用。移动端链接 GPLv3 Mosh，因此移动产物对外分发时仍须履行 GPLv3 义务（随包提供对应源码与许可证文本）；任何对外分发前仍应完成许可证审查。

## 2. 证据与选项

### 2.1 当前事实

- 当前前端是 React 18、Tauri 2、xterm.js 5.5；`src/src/api.ts` 已定义完整 typed invoke facade。
- `agentport-core` 无条件依赖 SQLite、keyring、nix、Git/Worktree、Host 管理等电脑本地能力，不适合作为移动客户端整体链接。
- `src-tauri/src/main.rs` 同时承担 Tauri adapter 和大量 use-case orchestration；CLI 只覆盖子集，直接远程包装现有 Tauri commands 不能实现完整等价。
- Host 已实现 Session+Token 认证、run-aware replay/resync、bounded multi-client、进程组清理和 Secret 脱敏；但跨客户端输入严格 FIFO/batch acknowledgment 和 remote unknown-write contract 尚不存在。
- 官方 Mosh 是 GPLv3；`COPYING.iOS` 只处理 Apple App Store 条款冲突，仍要求其他 GPL 条款，包括源码和许可证文本。

### 2.2 比较

| 方案 | 复用 | SSH/SFTP | Mosh | 代价 | 结论 |
|---|---|---|---|---|---|
| 独立 Tauri 2 Mobile + React | 复用 React、TypeScript、xterm、Rust、Tauri 习惯 | Rust plugin | 原生 plugin | 移动 plugin 与 toolchain 风险 | 采用 |
| Flutter | 终端/SSH 移动包较成熟 | Dart package | 仍需原生/FFI | 重写全部 React UI/typed facade | 不采用 |
| Swift + Kotlin 双原生 | 原生系统能力最好 | 双实现 | 双实现 | 两套 UI、协议、测试和状态逻辑 | 不采用 |
| 把现有桌面 Tauri app 直接 mobile init | 表面复用最高 | 仍需 plugin | 仍需 plugin | desktop sidecar/macOS private API/窗口与 host-local Core 强耦合 | 不采用 |

## 3. 代码与许可边界

```text
Cargo workspace (PolyForm-Noncommercial-1.0.0)
├─ crates/agentport-core                 # 现有 domain/infrastructure
├─ crates/agentport-host                 # 现有 PTY/process owner
├─ crates/agentport-service              # 新：Tauri-free use-case facade
├─ crates/agentport-remote-protocol      # 新：DTO/envelope/capabilities/framing
├─ crates/agentport-remote-bridge        # 新：stdio adapter, no listener
├─ crates/agentport-mosh-attach          # 新：本机 Host↔Mosh PTY adapter，不含 GPL client
├─ crates/agentport-cli                  # 逐步改接 service
└─ src-tauri                             # desktop adapter, 逐步改接 service

mobile/ (GPL-3.0-only app boundary)
├─ COPYING
├─ THIRD_PARTY_LICENSES.md
├─ package.json / package-lock.json
├─ src/                                  # React mobile UI
└─ src-tauri/
   ├─ Rust SSH/SFTP/client state plugin
   ├─ iOS Keychain secure-storage plugin
   ├─ Android Keystore secure-storage plugin
   └─ GPL Mosh native plugin/bindings
```

规则：

1. 桌面 crates 不链接 GPL Mosh；GPL 代码只进入 `mobile/` 产物。
2. `agentport-remote-protocol` 只含 wire DTO、能力和 framing，不依赖 Core、Tauri、SSH 或 Mosh。
3. `agentport-service` 可以依赖 Core，但不能依赖 Tauri；桌面、CLI、Bridge 使用同一业务语义。
4. Bridge 不把 Host Token、私有 Socket path 或 Secret 原值发送给客户端。Secret 新增是唯一允许客户端向 Bridge 发送 Secret 原值的 write-only RPC，适用第 5.6 节的专用内存与日志规则。
5. 移动目录构建脚本必须能从源码重建所链接的 Mosh 组件，并保留上游 notice/许可证（对外分发时随包提供对应源码）。

## 4. 电脑端服务分层

### 4.1 `agentport-service`

`agentport-service` 是进程内应用服务，不是 daemon。它负责：

- boot/reconcile 与 capability snapshot；
- Project/Agent/Preset/Session/Worktree/Git use cases；
- Session create/restart 的 repo lock、adapter/permission、Secret 注入、token rotation 和 Host launch；
- history/search/timeline/export/backup/legacy storage；
- Secret metadata、write-only Secret 创建/删除、diagnostics、document operations；
- 对平台相关能力使用显式 trait：notification、trash/reveal、file picker、commit-AI credential storage。

迁移策略按垂直切片进行：先抽取只读 boot/list 与 Session attach/input/control，再抽取 PRD parity 方法。桌面 Tauri 在每个切片改为薄 adapter，并由“同一 fixture 经 Tauri adapter 与 Bridge 得到等价结果”的测试阻止语义漂移。

### 4.2 Bridge 进程

调用形态：

```bash
agentport-remote-bridge serve --stdio
```

约束：

- stdin/stdout 只承载 framed protocol；所有诊断写 stderr。
- 不 bind TCP/UDP/Unix listener；不启动 daemon。
- 继承 SSH 登录用户权限和 AgentPort data dir。
- 每个 SSH control connection 一个 Bridge 进程；多个进程通过 Core/Host 的数据库、Socket 和锁协调。
- SSH 结束或 EOF 后取消订阅、清理临时 transfer，不停止 Agent Session。

## 5. Wire protocol v1

### 5.1 Framing

- `u32` big-endian payload length + UTF-8 JSON payload。
- 单 JSON frame 上限 16 MiB；超限在读取分配前拒绝。
- terminal bytes 使用 base64；1 MiB/min 基线可接受其开销。
- 大文件不走 Bridge：通用和业务产物传输走同一 SSH 连接上的 SFTP。
- schema DTO 使用 `deny_unknown_fields` 仅限握手/安全边界；普通 response 读取者忽略未知可选字段以支持前向兼容。

### 5.2 状态机

```text
AwaitHello -> Ready -> Draining -> Closed
              |
              +-> event subscriptions
```

客户端先发 `hello`：

```json
{
  "type": "hello",
  "protocol": {"major": 1, "minor": 0},
  "client": {"name": "agentport-mobile", "version": "..."},
  "requestedCapabilities": ["session.read", "session.input"]
}
```

服务端返回 negotiated protocol、AgentPort/platform、capabilities、limits（frame、subscriptions、Host clients）和 disabled reasons。major 不兼容立即关闭；minor/capability 缺失显式降级。

### 5.3 Envelope

- request：`requestId`、`method`、`params`、可选 `precondition`。
- accepted：服务端已接受并分配 `operationId`/server sequence；不是成功。
- result：`succeeded`、`failed`、`not_executed`。
- disconnect after accepted but before result：客户端显示 `unknown`，不自动重放非幂等写入。
- event：`subscriptionId`、`eventType`、run-aware cursor、payload。
- resync：客户端提供最后确认 cursor；服务端返回连续事件、`gap` 或 authoritative snapshot。

### 5.4 方法重试分类

| 类别 | 示例 | 自动重试 |
|---|---|---|
| 只读 | list/status/history/search/diag | 可，使用 request ID 去重 |
| 幂等写 | mark seen、保存完整 setting snapshot（带 revision） | 仅同 request ID/precondition |
| 非幂等写 | input、create、stop、restart、Git commit/delete | 不自动重放；unknown 后 reconcile 或用户决定 |

### 5.5 Session 输出、历史与输入

- live output 沿用 `runId/runOrdinal/generation/offset` 与 status cursor；这些字段在单个 run/generation 内单调。
- native-history provider cursor 保持 opaque，但 Bridge 为每次 history snapshot 包装 `HistoryCursor { sourceFingerprint, snapshotRevision, pageSequence, providerCursor }`。`pageSequence` 对客户端每次成功翻页单调递增；source mutation/truncation 返回 `gap/conflict`，不得把旧 cursor 重映射到新来源。
- 每个 Session 输入进入 Host 侧 bounded FIFO：batch ID、client ID、server receive sequence、完整 bytes。
- FIFO 只记录非正文元数据，不新增持久远程审计。
- batch acknowledgment 必须在 PTY write 前后区分 accepted/completed。
- stop success 必须由 Host authoritative `group_cleaned`/进程组验证支持，不能只观察主 PID 消失。

### 5.6 Secret write-only RPC

- `secret.add` 的原值只允许客户端→Bridge 单向进入，依赖已验证 SSH 加密与主机指纹；服务端响应只返回 Secret metadata。
- 该方法使用专用 DTO，类型不实现 `Debug`/`Display`/`Clone`；frame logger 永不记录 payload。
- 接收 frame buffer、解析缓冲和 Secret value 使用可 zeroize 容器；写入 Keychain/Secret Service 成功或失败后立即清零。
- 原值不得进入 request cache、operation result、错误文本、tracing span、panic payload、SQLite、诊断或审计。
- 写入必须是原子业务操作；断线导致结果 unknown 时，客户端通过 metadata list/revision reconcile，不自动重发原值。

## 6. Mobile runtime

### 6.1 Rust/Tauri 层

- 管理 SSH control connections、SFTP sessions 和 Mosh sessions。
- 凭据安全存储由原生 plugin 完成；Rust/JS 只持 opaque credential handle，认证时才在可清零容器中短暂读取明文。
- 不实现生物识别或 process-memory credential lease；显式连接和有限自动重连均按 handle 即时访问系统安全存储。
- SSH host key 为 jump/target 分别建 trust record；变化在启动 Bridge 前阻断。
- 连接结果状态必须是 connected/failed/unknown/reconnecting/stale，不用缓存伪装在线。

### 6.2 React 层

```text
mobile/src/
├─ app/                 # router, shell, providers
├─ protocol/            # generated/manual TS DTO adapter
├─ platform/            # typed Tauri invoke/events
├─ features/
│  ├─ hosts-auth
│  ├─ dashboard-sessions
│  ├─ agents-projects-git
│  ├─ docs-search-backup
│  ├─ secrets-settings-diag
│  ├─ shell-sftp
│  ├─ mosh
│  └─ notifications-data
├─ terminal/
├─ i18n/
└─ test/
```

业务 feature 只依赖稳定 `RemoteClient` interface，不直接调用 raw Tauri commands。T-008 至 T-013 可在独立 feature 目录工作；T-014 需等 T-008 的 dashboard state contract 稳定后启动。

### 6.3 本地数据

- host profile、known-host、设置、最后状态摘要：平台 file-protection/encrypted-storage 支持的本地数据库。
- password/private key/passphrase：Keychain/Keystore；普通数据库只存 opaque credential ID。
- Session 正文/terminal output：不持久化。
- profile export：Argon2id 派生 key + AES-256-GCM；不包含凭据。
- 后台 task switcher 不遮蔽，App 不增加锁，保持 PRD 明确取舍。

## 7. SSH、SFTP 与 Mosh

### 7.1 SSH/SFTP spike gate

固定依赖前必须在 iOS simulator 与 Android emulator 完成：

1. password、imported Ed25519、generated Ed25519；
2. direct 和 single jump；jump/target 独立 TOFU 与 key change；
3. stdio Bridge framing、1 MiB/min terminal stream；
4. russh-sftp browse/upload/download/atomic temp rename；
5. disconnect around accepted/result，证明 non-replay；
6. build/license audit。

失败则重新评估 Flutter 或平台原生 SSH，而不是增加未经证明的兼容层。

### 7.2 Mosh

Mosh 既要支持普通 Shell，也要支持已有 AgentPort Session。Session 模式不能绕过 Host：

```text
Mobile GPL Mosh client
  ⇄ UDP ⇄ mosh-server (target host, owns only outer PTY)
             └─ agentport-mosh-attach --session <public-session-id>
                  └─ local agentport-service/HostManager
                       └─ authenticated Host socket (Session ID + Host Token kept local)
                            └─ existing Agent PTY
```

- SSH bootstrap 通过 Bridge/service 请求启动 `mosh-server`，remote command 为不含 GPL 代码的 `agentport-mosh-attach`；手机只接收 Mosh connection key/UDP 参数和 public Session ID，永不接收 Host Token/socket path。
- `agentport-mosh-attach` 以 SSH 同一 OS 用户运行，在电脑本机通过 Core/HostManager 解析当前 run 与 Host credential，附加 output，并把 stdin 按 bounded batch 写入 Host FIFO；所有 output 仍先经过 Host redactor。
- attach adapter 监听 outer PTY resize 并调用 Host resize；Host stale run、wrong binding、gap 或 disconnect 必须显式退出，不连接旧 PID。
- Mosh 可靠状态同步负责终端字节交付；同一 attach 进程为其 input batches 分配严格递增 local sequence。SSH 控制通道继续承载状态、生命周期和所有非终端写操作，并用于 reconcile；Mosh 网络恢复不得新建第二个 attach writer。
- 普通 Shell 模式由 `mosh-server` 启动用户 shell，不经过 AgentPort Host，并在 UI 中与 Agent Session 明确区分。
- Mosh UDP 必须手机直达 target；ProxyJump 只服务 SSH bootstrap/control。
- 缺 server/UDP 不可达时给安装/防火墙指引和“改用 SSH”，不静默降级。
- T-017 必须在 iOS/Android 上证明 GPL source build、Session attach、pre-redacted output、FIFO input、resize、UDP/roaming 和 SSH-control independent recovery。若任一平台失败，T-017 blocked；不得以 SSH mock 或普通 Mosh Shell 代替 Session Mosh。

## 8. 文件所有权与并行边界

基础批次序列化：

| 任务 | 独占路径 |
|---|---|
| T-005 Bridge | `crates/agentport-remote-protocol/**`、`crates/agentport-service/**`、`crates/agentport-remote-bridge/**`、Core/Host 必要改动 |
| T-006 Mobile scaffold | `mobile/package*.json`、`mobile/src-tauri/**`（仅 scaffold/shared shell）、`mobile/src/app/**`、`mobile/src/platform/**`、移动配置 |
| T-017 Transport spike | `crates/agentport-mosh-attach/**`、`mobile/src-tauri/src/{ssh,sftp,credentials,mosh}/**`、`mobile/src/terminal/**`、`mobile/src/features/transport-spike/**` |
| T-007 Host/Auth integration | `mobile/src/features/hosts-auth/**`；复用 T-017 plugin API，不重写 plugin |
| T-008 Session | `mobile/src/features/dashboard-sessions/**` |
| T-009 Agent/Git | `mobile/src/features/agents-projects-git/**` |
| T-010 Docs/Backup | `mobile/src/features/docs-search-backup/**` |
| T-011 Secret/Settings | `mobile/src/features/secrets-settings-diag/**` |
| T-012 Shell/SFTP | `mobile/src/features/shell-sftp/**`；仅通过 T-017 plugin API |
| T-013 Mosh product | `mobile/src/features/mosh/**`；`mobile/src-tauri/src/mosh/**` 只能在 T-017 owner 完成 handoff 后串行扩展 |
| T-014 Notification/Data | `mobile/src/features/notifications-data/**`、`mobile/src-tauri/src/{notifications,storage}/**` |
| Coordinator | root `Cargo.toml`/`Cargo.lock`、`mobile/package-lock.json`、`mobile/src-tauri/Cargo.lock`、protocol schema/TS generation、shared store/router、authority doc、跨任务生成文件 |

`agentport-remote-protocol` schema 只归 T-005；下游发现的 schema 缺口交协调者串行更新。T-007 完成后冻结 `RemoteClient`；feature writers 不直接调用 raw Tauri command。T-014 明确依赖 T-008，不能与 T-008 同批启动。

当前未提交的 `LEARNS.md`、`src/src/terminals.ts`、`src/src/terminals-renderer.test.ts` 不属于移动任务，禁止 writer 修改或提交。

## 9. Toolchain 与环境策略

当前本机：

- 可用：Xcode 26.6、iOS 26.5 runtime、Node/npm、Homebrew Rust host target。
- 缺失：iOS 16 runtime、Android SDK/JDK/Gradle/emulator、rustup/mobile targets、移动工程依赖。

实施允许安装本地开源开发依赖，但不得登录开发者账号、读取真实签名身份、购买服务或写生产环境。工具链应固定：

- rustup-managed stable toolchain（满足 workspace MSRV）与实际支持的 iOS/Android targets；
- JDK 17、Android command-line tools、API 29 arm64 image 与一个冻结的 current stable image；
- iOS 16 验收使用兼容的 side-by-side Xcode/runtime 或 CI；Xcode 26.6 继续覆盖最新 runtime。

无法在本机获得 iOS 16 runtime 时，可由可重复 CI 证据满足该 profile，但本地不得宣称已运行。

## 10. 实施门禁

### Gate A：协议/Bridge

- protocol crate golden/compat/fuzz bounds；
- Bridge GUI-off、no-listener、unknown write、cursor gap、多-client FIFO；
- Host Token/Secret/argv/global-config safety tests。

### Gate B：移动 scaffold

- iOS latest simulator 与 Android API 29 emulator 启动非空白 shell；
- no account/cloud/telemetry dependency scan；
- license boundary and reproducible build。

### Gate C：T-017 prerequisite transport spike

- 依赖 Gate A（T-005）与 Gate B（T-006）；在完整 feature batch 前单独执行。
- SSH/SFTP 双端、Keychain/Keystore simulated flows、xterm touch/IME basics。
- Mosh 双端 source build、普通 Shell 与 AgentPort Session attach、Host redaction/FIFO/resize、UDP/roaming/control recovery。

只有 T-005、T-006、T-017 全部 done，才释放 T-007；只有 T-007 done 才释放 T-008 至 T-013，T-014 另依赖 T-008。Gate 失败时将 T-017 标 blocked 并记录精确解锁条件；不得跳过而生成 parity UI mock。

## 11. PRD traceability

| PRD 范围 | 架构 owner |
|---|---|
| HOST/AUTH/NET/BRIDGE | protocol + service + mobile Rust transport |
| DASH/SES | RemoteClient + dashboard/session feature + terminal |
| PAR-01..23 | agentport-service facade + corresponding mobile features |
| PAR-24..27 | mobile settings/system adapters/i18n |
| TERM/SFTP | mobile Rust transport + shell-sftp feature |
| NOTIFY/DATA | native plugins + notifications-data feature |
| PERF/安全/无障碍 | dedicated benchmarks/scans/semantic tests；T-015 gate |

## 12. 已知未决技术验证（不是产品决策）

- `russh`/`russh-sftp` 的双端编译、ProxyJump 和性能尚未实证。
- xterm.js 的触屏、IME、选择、外接键盘、VoiceOver/TalkBack 与 Canvas addon 在移动 WebView 尚未实证。
- Android Mosh port 和 iOS Mosh source build 尚未实证。
- iOS 16 runtime 与 Android toolchain 当前不在本机。
- 仅模拟器不能证明硬件 Keychain/Keystore、蜂窝迁移、系统 kill/background 或真机 Mosh UDP；按 PRD 披露。

前三项可行性验证集中属于 T-017；完整产品化属于 T-007/T-013，非功能回归属于 T-015。任何失败都必须回写 authority document 的 blocker 与精确解锁条件。
