# AgentPort

面向 macOS 13+ 与 Ubuntu 22.04/24.04 的本地 AI CLI 工作台：用一个界面统一管理
Claude Code、Codex、Kimi Code、Qoder CLI、Pi（以及 Generic Shell 降级入口）的持久 Session、
PTY、状态、日志、Git Worktree 与恢复流程。本地优先、单用户、无账号、无云端、
无遥测。

```
GUI（Tauri 2 + React + xterm.js，可重连客户端，不拥有进程）
  └─ agentport-core（SQLite、Adapter 探测、Worktree、脱敏、Credential Broker）
       └─ agentport-host（每 Session 一个独立进程：PTY、进程组、Socket、心跳、日志）
            └─ claude / codex / kimi / qodercli / pi / sh
```

## 快速开始（开发）

```bash
# 依赖：Rust ≥1.80、Node ≥18、系统 git；macOS 或 Ubuntu（见 docs/install.md）
cargo test --workspace --all-targets   # 全部 Rust 单元/集成测试
(cd src && npm test && npm run build)  # 前端测试与生产构建
cargo build -p agentport-cli -p agentport-host
./target/debug/agentport-cli probe     # 探测本机全部受支持 Agent CLI
./target/debug/agentport-cli --help    # 无头客户端（功能与 GUI 等价）
cd src && npm install && npm run dev   # 前端开发服务器（:1420）
../src/node_modules/.bin/tauri dev --prefix src-tauri  # 或：cd src-tauri && ../src/node_modules/.bin/tauri dev
```

## 常用命令

| 任务 | 命令 |
|---|---|
| Rust 全部测试 | `cargo test --workspace --all-targets` |
| 前端测试与构建 | `cd src && npm test && npm run build` |
| 波次 1 E2E（PTY/重连/清理/日志 SHA-256） | `bash e2e/wave1.sh` |
| 波次 2 E2E（导出/搜索/时间线/Secret 泄漏扫描） | `bash e2e/wave2.sh` |
| 验收剧本 2（GUI 强杀恢复/输出连续） | `bash e2e/play2.sh` |
| 验收剧本 3（真实 CLI 恢复矩阵） | `bash e2e/play3.sh` |
| 验收剧本 4（Worktree 安全） | `bash e2e/play4.sh` |
| 性能指标（PRD ch.10） | `./target/debug/agentport-cli perf all`（结果存 `<data>/perf-results.jsonl`） |
| macOS 打包 | `bash scripts/build-macos.sh`（Universal 见脚本头部说明） |
| Ubuntu 22.04 / 24.04 `.deb`（发布基线） | `bash scripts/build-linux.sh ubuntu2204`（Docker） |
| Ubuntu 24.04 原生 `.deb`（兼容性诊断） | `bash scripts/build-linux.sh ubuntu2404`（Docker） |
| Fedora/Arch 社区构建 | `bash scripts/build-linux.sh fedora` / `arch` |
| AppImage（Beta） | `bash scripts/build-linux.sh appimage` |
| 发布清单 | `bash scripts/generate-release-manifest.sh` |

## agentport-cli（无头客户端）

GUI 的全部核心能力都能脚本化（E2E 与验收就靠它）：

```bash
agentport-cli probe [agent] [--path EXE]          # CLI 能力探测（多候选必须手选）
agentport-cli project add <path>                  # 添加项目（重复路径聚焦已有）
agentport-cli session new --project P --agent kimi --title 修复登录超时
agentport-cli session input <id> --data "ls\n"    # 输入（任何输入都校验 session id）
agentport-cli session read <id> --until done      # 读输出（回放+实时）
agentport-cli session stop <id>                   # 清理完整进程组（含后台逃逸任务）
agentport-cli session restart <id>                # 重启并恢复（精确/降级明示）
agentport-cli worktree create --project P --task "fix" --base-ref HEAD~1
agentport-cli secret add --preset pre_kimi_safe --env KIMI_API_KEY   # 值从 stdin 读
agentport-cli export zip --session <id> --out diag.zip               # 脱敏诊断包
agentport-cli search "login timeout"              # 元数据 + 终端全文
agentport-cli timeline                            # 离开期间恢复时间线
```

## 硬约束（实现即如此）

- GUI 关闭 ≠ Session 停止；每个 Session 独立 Host/PTY/Socket/日志/输入通道。
- 默认沿用各 CLI 原生权限审批；选择自动批准或绕过权限后直接启动，不再弹出二次风险确认。
- Secret 只存 macOS Keychain / Linux Secret Service；绝不落 SQLite/日志/索引/导出/进程参数；后端不可用则禁用、无明文回退。
- 停止 Session 清理完整进程组（含 job control 逃逸的后台任务）。
- 不静默修改用户 CLI 全局配置；状态必须带来源/置信度/时间/证据。
- Git 全部参数数组调用；Worktree dirty 默认阻止删除。

## 文档

- 用户指南 `docs/user-guide.md` · 安装 `docs/install.md` · 故障排查 `docs/troubleshooting.md` · 安全说明 `docs/security.md`
- 验收报告 `docs/acceptance-report.md` · 已知限制 `docs/known-limitations.md` · 发布清单 `release-manifest.json`（发布前须重新运行生成脚本）
