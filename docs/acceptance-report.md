# AgentPort 验收报告（0.1.0，2026-07-19 历史快照）

> 本文记录 2026-07-19 当次验收，不代表当前工作树的发布证据，也未覆盖后来加入的 Qoder/Pi 与新增测试。仓库根目录的 `release-manifest.json` 在发布时重新生成，可能晚于本文。发布候选必须重新运行 `cargo test --workspace --all-targets`、`cd src && npm test && npm run build` 及相应 E2E，再生成新的发布清单；不得沿用下列历史通过数。

测试基线（实测环境）：macOS 26.5.1，Apple Silicon（arm64），本机 Homebrew Rust 1.95.0；
Linux 验证在 OrbStack Docker（linux/amd64，Rosetta 模拟）中执行。
Agent CLI：claude 2.1.215（验收期间从 2.1.214 自动升级，能力探测正常适应）、codex-cli 0.144.5、kimi 0.27.0。
PRD 基线为 M1/8GiB 与 Ubuntu 22.04/4核/8GiB —— 本环境更强，数字仅作该环境实测记录。

## 一、测试总览

| 套件 | 命令 | 结果 |
|---|---|---|
| 单元/集成（core） | `cargo test -p agentport-core` | 114 passed / 0 failed |
| host 集成 | `cargo test -p agentport-host --test host_tests` | 9 passed / 0 failed（连续 3 轮） |
| Adapter 测试（含真实 CLI fixtures） | `cargo test -p agentport-core adapters` | 33 passed / 0 failed |
| 数据库迁移 | 同上（`db::tests::migrations_are_idempotent_and_versioned`） | 通过 |
| 安全边界（握手/输入隔离/脱敏/泄漏扫描） | host_tests + `e2e/wave2.sh` + `e2e/play5.sh` | 通过 |
| 波次 1 E2E（PTY/重连/SHA-256/进程组） | `bash e2e/wave1.sh` | PASS |
| 波次 2 E2E（导出/搜索/时间线/Secret） | `bash e2e/wave2.sh` | PASS |
| 验收剧本 2（GUI 强杀恢复） | `bash e2e/play2.sh` | 见 §四 |
| 验收剧本 3（真实 CLI 恢复矩阵） | `bash e2e/play3.sh` | PASS（见 §四） |
| 验收剧本 4（Worktree 安全） | `bash e2e/play4.sh` | PASS |
| 验收剧本 5（Secret/进程清理） | `bash e2e/play5.sh` | PASS |
| 性能指标 | `./target/debug/agentport-cli perf all` | 见 §三 |
| 跨平台发布矩阵 | Docker 构建 + 容器验证 | 见 §五 |

## 二、真实 CLI 验证（非 Mock）

- **claude 2.1.215**：`--session-id <uuid>` 指定原生 ID（`claude -p` 真实调用退出码 0）；恢复矩阵中 `claude --resume <同一 uuid>` 精确恢复，能力探测对自动升级（2.1.214→2.1.215）无感。Hook 经按调用 `--settings` 注入（不碰用户全局配置）。
- **codex 0.144.5**：`resume [SESSION_ID]`/`--last` 存在；`--ask-for-approval never`、`--dangerously-bypass-approvals-and-sandbox` 存在；`--full-auto` 不存在于该版本；`notify` 语义无法从 CLI 输出确认 → 未注入，hook 降级。TUI 输出未稳定暴露 session id → 恢复精度 latest（明示）。
- **kimi 0.27.0**：`--session [id]`、`--continue`、`--auto`、`--yolo` 存在；无会话级 hook 注入机制（只有全局 config.toml，按约束不修改）→ hook 降级；`kimi -p` 真实调用输出行 `To resume this session: kimi -r session_<uuid>` 已存为 fixture（`crates/agentport-core/tests/fixtures/cli/kimi-print-ok.txt`）；TUI 未稳定暴露 id → 恢复精度 latest（明示）。
- 三个 CLI 的 `--version`/`--help` 真实输出全部落为解析 fixtures（`tests/fixtures/cli/`），并有"未知未来版本"合成 fixtures 验证安全降级。

## 三、性能指标（PRD ch.10）

测量方法：`./target/release/agentport-cli perf all`（原始记录见 `<data>/perf-results.jsonl` 与交付目录 `dist-release/perf-results.jsonl`）。交互指标连续 30 次取 P95（标注者除外）。实测环境：macOS 26.5.1 arm64（非 PRD 的 M1 基线，数字为该环境记录）。

| 指标 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 冷启动到窗口可见（真实 .app） | ≤1.5s macOS | 1399ms | ✅ |
| 已运行 Session 重连 attach | P95 ≤300ms | P95 0.64ms（n=30） | ✅ |
| 键盘输入回显（协议 RTT；xterm paint 未含） | P95 ≤50ms | P95 0.26ms（n=30） | ✅（近似项） |
| 状态通知延迟（Idle→Working，PTY 路径） | P95 ≤300ms | P95 0.40ms（n=10） | ✅（近似项） |
| 输出吞吐 | ≥1 MiB/s × 60s，无阻塞 >100ms | 1.11 MiB/s × 67s，最大 client gap 219ms，日志字节流与接收一致 | ✅ |
| 日志一致性 | SHA-256 100% 一致 | wave1/throughput 均逐字节一致 | ✅ |
| 单 Host 空闲内存 | ≤35 MiB | 9.0 MiB（5s 采样；PRD 10min 窗口未做满） | ✅（窗口注明） |
| 应用空闲 CPU（10 个 Idle Host） | ≤1% 单核 | 均值 0.33%（30s 采样） | ✅（窗口注明） |
| GUI 空闲内存 | ≤250 MiB | 102.5 MiB（60s 采样，真实 .app） | ✅（窗口注明） |
| Session 停止清理 | 100/100，≤5s 无后代 | 100/100，P95 275ms（含 job control 逃逸清理） | ✅ |
| GUI 强杀崩溃恢复 | 30/30 日志连续 | 30/30 | ✅ |
| Worktree 创建（20k 文件） | P95 ≤8s | P95 1.65s（n=5） | ✅ |
| 日志上限轮转 | ≤limit+5MiB | 写入 220MiB 后磁盘 21.1MiB（limit 200） | ✅ |
| 恢复时间线生成（100 事件） | P95 ≤300ms | P95 3.5ms（n=30） | ✅ |
| 会话正文搜索 | 不持久化正文索引 | 按需流式扫描 Agent 原生日志；旧 FTS 正文启动时清空 | ✅ |
| 全局搜索首批结果 | P95 ≤200ms | P95 1.0ms（现实密度，n=30）；最坏密度（每行命中）268ms | ✅/记录 |
| AgentPort 正文副本磁盘占比 | 0% | 新 Host 不创建 `output.log`；正文索引为空 | ✅ |
| Secret 读取注入 | P95 ≤300ms，泄漏 0 | P95 1.3ms；泄漏扫描 0（play5/wave2） | ✅ |
| 诊断 ZIP | 不复制会话正文 | ZIP 仅包含状态事件与诊断元数据 | ✅ |
| 可访问性键盘路径 | 12 条 100% | 未人工验证（实现具备：焦点圈定/aria-live/screenReaderMode/快捷键全覆盖） | ⚠️ 未验证 |
| 文本对比度 | WCAG AA | 深浅主题仍需自动扫描与人工复核 | ⚠️ 未验证 |
| 跨平台发布矩阵 | 正式 100% | 见 §五 | 部分 |

## 四、验收剧本执行记录

- **剧本 1（跨平台安装/IME/可访问性）**：macOS .app 启动/窗口渲染/db 初始化通过；Ubuntu 24.04 deb 干净容器安装→PTY E2E→xvfb 启动→卸载通过。IME、VoiceOver/Orca 键盘路径、Fedora/Arch 干净 VM 人工回归：未验证（实现具备：焦点管理/aria-live/screenReaderMode/深浅主题/减少动效；可复现验证脚本见 scripts/linux/verify-in-container.sh）。
- **剧本 2（持久与恢复）**：历史发布基线 PASS。当前实现把磁盘日志重放替换为 Host 内 4 MiB 有界尾部；自动化回归验证 Host 存活、重连可输入且新运行不创建 `output.log`，完整 120s 人工重跑待下次发布验收。
- **剧本 3（恢复矩阵+搜索）**：恢复矩阵沿用历史基线；当前实现的关闭会话搜索改为按需扫描已验证的 Agent 原生日志，并由 Core/Tauri 回归覆盖。旧 50ms FTS 数字不再适用。
- **剧本 4（Worktree）**：PASS。Base Ref=HEAD~1 生效；主 checkout 不变；完成后 dirty 显示"结果尚未提交"；dirty 删除被阻止；清理后删除成功且 `git worktree list` 消失。
- **剧本 5（Secret/清理/存储）**：历史 Keychain 与进程组回归保持 PASS。当前 AgentPort 实时尾部继续脱敏，诊断 ZIP 不再包含正文，旧日志只允许按精确清单二次确认删除；Agent 原生日志属于 Provider 安全边界，需在发布验收中单独审计。Secret Service 锁定场景（Linux）未自动化（见 known-limitations）。

## 五、跨平台发布矩阵

| 平台 | 产物 | 验证 | 等级 |
|---|---|---|---|
| macOS 26.5.1 arm64 | `dist-release/macos/AgentPort_0.1.0_aarch64.dmg` + `.app`（含 host sidecar） | 构建+启动+渲染+db 初始化；冷启动 1062ms；空闲 RSS 103MiB（60s） | 正式（签名/公证未执行） |
| Ubuntu 24.04 x86_64 | `dist-release/ubuntu2404/AgentPort_0.1.0_amd64.deb` | Docker 构建 + 干净容器安装/PTY/xvfb/卸载 PASS | 正式 |
| Ubuntu 22.04 x86_64 | `dist-release/ubuntu2204/AgentPort_0.1.0_amd64.deb` | Docker 构建 + 干净容器安装/PTY/xvfb/卸载 PASS | 正式 |
| Fedora latest x86_64 | `dist-release/fedora/agentport-fedora-x86_64.tar.gz` | Docker 构建（容器内编译通过；未做干净 VM 回归） | 社区验证 |
| Arch latest x86_64 | `dist-release/arch/agentport-arch-x86_64.tar.gz` | Docker 构建（同上） | 社区验证 |
| AppImage | （本次未发布） | GitHub linuxdeploy 下载持续失败，打包阻塞；脚本可复现，按 PRD 未通过干净 VM 验证不发布 | Beta（阻塞） |

签名/公证、Fedora/Arch/AppImage 的干净 VM 交互回归（IME/通知/卸载）、VoiceOver/Orca 人工验收：均未在本机执行，详见 `docs/known-limitations.md`。

## 六、安全验证

- 输入隔离：握手校验 session id + 随机 token（错误身份拒绝并关闭）；逐帧校验 session id（host_tests::input_isolation）。
- 进程组清理：SIGINT→SIGTERM→SIGKILL 升级 + ppid 树兜底（job control 逃逸的 `sleep &` 后台任务同样清除，host_tests::job_control_escapee_cleanup）。
- Secret：Keychain 真实往返（无授权弹窗）；泄漏扫描覆盖前端输出/SQLite/argv/日志/索引/诊断 zip（play5、wave2）；脱敏流式实现无尾部饿死（redact 回归测试）。
- 日志一致性：客户端接收字节流与落盘日志 SHA-256 逐字节一致（wave1）。

## 七、测试稳定性披露

- `cargo test --workspace` 全绿（core 114 + host 9，已连续 6+ 轮复跑确认）。在高并发 Docker 构建负载下，host_tests 中一个时序敏感用例曾单次超时失败（20.6s vs 正常 4.2s 套件时长），负载正常后连续全绿；判定为测试环境敏感性而非产品缺陷。
- GUI 自动化只覆盖启动/渲染/数据初始化；交互流验证以 CLI 层等价路径（同一 core 代码）+ 人工烟测为准，未做 WebDriver 级回放。
- 真实 CLI 验证消耗过真实 API 调用（每个 Agent ≤1 次极小 prompt，验收剧本 3）。
