# Task Plan: Mobile 回放流控与终端响应根因优化

- Created: 2026-09-07
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 用户要求已连接 iPhone 实测排查，并要求根本性优化。

<!-- task-doc-section:background-goal -->
## Background and goal

修复完整历史回放在有界队列溢出后重复同步的问题，并在实际 iPhone 上验证加载和滚动响应。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：Service/Bridge 推送流控、移动端恢复游标与经测量证实的响应瓶颈、相关回归和开发构建。按用户最新指示，以小尾部和实时显示替代 4 MiB 回放；取消终端数据的端到端 Noise 加密，保留 WSS/TLS 与设备握手认证、输入顺序和现有会话。排除无关脏文件、输入丢弃、生产发布和 Git push。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 真机两次 4 MiB 冷挂载约 2.9–3.0 秒，出现 bridge_writer_queue_overflow；1 MiB 对照约 1.49 秒且无该重同步 | /tmp/agentport-iphone-perf-20260907/measurements.json |
| F-002 | Bridge 每订阅队列 32，Service 推送队列 64，满时丢弃事件 | crates/agentport-remote-bridge/src/lib.rs spawn_dispatcher；crates/agentport-service/src/lib.rs try_push_event |
| F-003 | 真机低频合成滚轮到下一输出中位 244 ms，write 回调 p95 10 ms；不等于真实手势验证 | 同目录 report.md |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 在两级队列实施可取消背压可消除正常回放的主动丢弃；通过慢消费者回归和真机复测验证。
- 已验证实际手势下解析 p95 4 ms、帧间隔 p95 17 ms；远端往返仍约 200 ms，未测量精确 touch-to-photon。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 有界内存下输出完整有序；消费者暂停后恢复不产生人为 resync。
- 队列满时 detach/关闭可结束，其他订阅与控制响应继续前进。
- 真机小尾部回放与实时显示不触发 Bridge 队列溢出；记录首屏和滚动响应证据。
- 已有会话和无关修改保留；目标回归、构建和任务文档校验通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-004 -> T-006 -> T-005 -> T-003.
- Parallel batches: 无；串行执行。
- Serialization constraints: 流控语义决定移动恢复逻辑，二者完成后才能构建同一产物并验证真机。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 完整回放的可取消背压

- Status: done
- Owner: coordinator
- Objective: 消除两级推送队列满时的主动丢弃
- Inputs and prerequisites: 真机基线、当前源码与前置任务结果。
- Scope or files: crates/agentport-service/src/lib.rs；crates/agentport-remote-bridge/src/lib.rs
- Expected output: 最小实现、针对性回归与验证证据。
- Dependencies: None.
- Execution steps:
  1. 复现并明确可证伪条件。
  2. 实现、检查差异并执行验证。
- Acceptance criteria:
  - 消除两级推送队列满时的主动丢弃，不牺牲数据完整性和取消能力。
- Verification method:
  - 慢消费者完整性、取消、订阅公平性及现有 Rust 测试。
- Validation evidence: cargo test -p agentport-service -p agentport-remote-bridge --lib：46 个测试通过；旧版完整回放回归在期望 offset 32 时得到 64，修改后通过；包含满队列 detach 与多订阅公平性。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 移动恢复与连续滚动响应

- Status: done
- Owner: coordinator
- Objective: 修复恢复期间旧事件污染游标，并依据测量定位高频输入成本
- Inputs and prerequisites: 真机基线、当前源码与前置任务结果。
- Scope or files: mobile/src 终端和会话代码及测试
- Expected output: 最小实现、针对性回归与验证证据。
- Dependencies: T-001
- Execution steps:
  1. 复现并明确可证伪条件。
  2. 实现、检查差异并执行验证。
- Acceptance criteria:
  - 修复恢复期间旧事件污染游标，并依据测量定位高频输入成本，不牺牲数据完整性和取消能力。
- Verification method:
  - 恢复回归、移动测试与类型检查；真机滚动指标。
- Validation evidence: 旧游标污染回归先失败后通过；npm test：189 个移动测试通过。真机 pi-40 的 60 Hz 合成滚动 120 次输入全部完成、无错误，帧 p95 17 ms、解析 p95 1 ms；未证实需要改动滚动算法，远端结果 p50 276 ms。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 开发构建与真机闭环

- Status: done
- Owner: coordinator
- Objective: 验证修改后的完整链路并提交本任务变更
- Inputs and prerequisites: 真机基线、当前源码与前置任务结果。
- Scope or files: 开发构建产物、任务文档和本任务源码
- Expected output: 最小实现、针对性回归与验证证据。
- Dependencies: T-005
- Execution steps:
  1. 复现并明确可证伪条件。
  2. 实现、检查差异并执行验证。
- Acceptance criteria:
  - 验证修改后的完整链路并提交本任务变更，不牺牲数据完整性和取消能力。
- Verification method:
  - 真机 64 KiB 冷挂载、实际手势和输入；目标构建；Git 范围检查。
- Validation evidence: 目标测试通过：Core 349（6 ignored）、Host 27 单元+35 集成、Service 31、Bridge 16、Relay 25（3 ignored）、移动 189；移动原生 relay 2。iOS Debug 已安装，UUID 1DC894DC-67C6-3202-BA27-2807F67A70F9。Mac Debug PID 79982 路径正确，截图非白屏。真机结果见 final-realtime-results.json；独立诊断会话已停止归档，测试钩子已恢复。仅提交任务文件，不 push。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 原生加密热点的兼容加速验证

- Status: done
- Owner: coordinator
- Objective: 验证已采样的 Noise 解密成本，选择保持协议和身份校验的加速实现。
- Inputs and prerequisites: T-002；真机 Debug 长回放 3.22 MB 耗时 4.17 秒、无重同步；既有原生 CPU 采样。
- Scope or files: crates/agentport-relay/Cargo.toml、crypto.rs、相应 lockfile 与移动优化构建。
- Expected output: 可重复微基准、跨实现互通测试、经测量支持的最小加速改动。
- Dependencies: T-002
- Execution steps:
  1. 对照现有纯 Rust 和已有 ring 库实现的相同 ChaChaPoly 密码算法。
  2. 验证双向互通、篡改与重放拒绝，并进行真机构建对照。
- Acceptance criteria:
  - 保留原 Noise 协议、密钥和加密强度，热点耗时有实测改善。
- Verification method:
  - 本地定长加解密基准、Relay 测试、真机回放对照。
- Validation evidence: Relay 24 个测试通过；旧实现双向互通及篡改/重放拒绝通过。约 4 MiB 本机 Debug 加解密从 656.64 ms 降至 4.14 ms；真机同会话 3,216,992 字节从 4171 ms 降至 3230/3523 ms，两次无 resync。用户随后要求取消终端数据的端到端加密。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 实时优先的小尾部与单层传输

- Status: done
- Owner: coordinator
- Objective: 按最新要求取消大历史等待，并让终端数据走 WSS/TLS 原始流而不重复 Noise 加密。
- Inputs and prerequisites: 用户 2026-09-07 最新指示；T-004 基线。
- Scope or files: Mobile 会话/终端测试；Relay endpoint、net、connector 和相关测试。
- Expected output: 小尾部即时可见与可输入；握手认证下协商的原始 WSS 数据流。
- Dependencies: T-006
- Execution steps:
  1. 冷挂载只保留最近 64 KiB 用于重建 TUI 模式，边收边显示，不以历史完成阻塞输入。
  2. 在已认证握手内协商原始数据模式，旧客户端兼容，Relay 服务无需更改。
  3. 回归、开发构建及真机首屏/滚动对照。
- Acceptance criteria:
  - 授权和吊销语义保留，原始数据模式明确协商，数据顺序及取消有效。
  - 真机首屏无 4 MiB 等待；输入不被回放阻塞。
- Verification method:
  - Mobile 交互测试、Relay 原始/兼容模式与授权回归、真机测量。
- Validation evidence: WSS 原始流授权、撤销、双向 256 KiB 与旧客户端兼容测试通过。真机旧会话首次 760 ms；新 Host 5.5 MB 诊断输出两次冷挂载首屏 319/355 ms，接收 65726/65575 字节，单次 attach，均无 resync。实际手指滑动 488 次输入全部完成、零错误；远端确认 p50 207/p95 254 ms，解析 p95 4 ms，帧间隔 p95 17 ms。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 小尾部终端模式种子

- Status: done
- Owner: coordinator
- Objective: 修复真机小尾部丢失 alternate/mouse 模式的已复现退化。
- Inputs and prerequisites: T-004；真机 64 KiB 后 mode=normal、mouse=none，原为 alternate/any。
- Scope or files: Service attach、Core terminal_seed.rs、Host 有界模式状态、VTE 依赖及回归。
- Expected output: 新 Host 持续保留模式状态，独立于 4 MiB 文本淘汰；旧 Host 从保留尾部提取可用模式，仅发送种子和请求尾部，不重启已有 Host。
- Dependencies: T-004
- Execution steps:
  1. 解析省略前缀中的终端模式，保留有界种子。
  2. 按种子、尾部、ReplayDone、实时输出的顺序发送，游标只计算实际尾部字节。
  3. 回归与真机 alternate/mouse 模式验证。
- Acceptance criteria:
  - 不向手机发送旧文本；小尾部保留模式，游标不因种子膨胀；读取有期限且缓存有界。
- Verification method:
  - 模式解析、分片、reset、尾部精确游标测试；真机复测。
- Validation evidence: Core 模式分片/reset 与 Host 超 4 MiB 淘汰回归通过；Service 精确尾部游标回归通过。真机诊断会话输出 5,521,207 字节后，小尾部仍恢复 alternate/any。旧 Host 已淘汰的模式无法追溯恢复；模式种子并非完整屏幕快照。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先运行慢消费者回归证明旧逻辑丢数据，再实现并运行 Service/Bridge 测试；移动恢复测试与类型检查；构建更新实际开发链路，复测完整回放、滚动和输入。实际设备未跑的检查明确标记未验证。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

背压必须可取消，不能在满队列下阻塞 detach；上游 Host 仍有有限保留和慢客户端断开边界。真机/检查器可能断连，需恢复后继续，不以静态测试替代。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-07: 真机当前完整 4 MiB 与小尾部均为 normal/none，证实启动模式已被旧 Host 的 4 MiB 环形尾部淘汰；扩展 T-006，让新 Host 独立保留模式状态。既有 Host 无法恢复已淘汰指令，保留会话并明确验证边界。
- 2026-09-07: T-005 真机发现小尾部省略了启动模式；新增 T-006 服务端模式种子，避免用猜测模式或恢复大网络回放掩盖问题。另用失败回归修复了 replay 完成与旧 resize rAF 回调交错导致 resize 丢失的问题。
- 2026-09-07: 用户明确改为速度优先、取消加密、不需要 4 MiB 历史；新增 T-005，并用 WSS/TLS 单层保护配合一次性设备认证，避免无认证接入。
- 2026-09-07: 长回放完整性已改善，但 Debug 3.22 MB 仍耗时 4.17 秒；新增 T-004 验证加密热点，T-003 最终验收等待该结果。
- 2026-09-07: T-002 验证完成，开始 T-003。桌面调试包已重建、正确进程路径及非白屏截图确认；iOS debug archive 已安装，UUID F86AE33A-B37E-37D5-B560-0C00E1B8F184；新 Relay Bridge PID 96130。pi-40 仅约 50 KiB 历史，改用 mobileUI 验证长回放。
- 2026-09-07: T-001 本地验证通过；T-002 已复现旧心跳污染重连游标，代次隔离后 28 个会话测试通过；继续滚动和开发产物验证。
- 2026-09-07: 已完成真机基线及源代码定位；开始 T-001，恢复点为队列背压回归。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 上述目标测试、构建、已连接 iPhone 的两次小尾部冷挂载与真实滑动均通过；原始指标保存在 /tmp/agentport-iphone-perf-20260907/final-realtime-results.json。
- Limitations: 旧 Host 已淘汰的模式不能恢复，已有用户会话未重启；小尾部不保证任意 TUI 的完整历史画面；公网 RTT 仍存在，手势到像素精确延迟未测。临时性能原始文件不进入 Git。
