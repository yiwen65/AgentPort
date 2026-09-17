# AgentPort 已知限制（0.1.1）

本文件与 `release-manifest.json` 互相印证：下列每一项都如实记录，未验证项不冒充已验证。

## 平台与构建

1. **macOS Universal 由 CI 产出，本机脚本仍未验证**。发布流水线（`.github/workflows/release.yml`）在 macOS runner 上构建 `universal-apple-darwin` 并通过 `lipo` 校验为 x86_64+arm64；本机是 Homebrew Rust（无 rustup target std），只能构建 `aarch64`，`scripts/build-macos.sh --universal` 未在本机跑通。
2. **Developer ID 签名与公证未执行**（本机无开发者证书）。构建脚本会应用完整的 ad-hoc Bundle 签名，以保证 App、资源和 Sidecar 通过严格完整性校验；但它不提供开发者身份信任。产出的 `.app/.dmg` 仍可能需要在“系统设置 → 隐私与安全性”放行或执行 `xattr -cr`。CI 签名/公证步骤在 `docs/install.md` 说明，标记未验证。
3. **Fedora/Arch 为社区验证层级**：Docker 构建 + 容器内冒烟；未做干净 VM 人工回归（IME/通知/卸载）。**AppImage 本次未发布**：构建窗口内 GitHub 的 linuxdeploy 下载持续失败（SSL 截断），无法完成打包；构建脚本 `scripts/build-linux.sh appimage` 可复现，网络恢复后重跑即可。按 PRD，未通过干净 VM 启动验证前不发布该 Artifact。
4. **Linux 桌面差异**（WebKitGTK/Wayland 合成器、IME、剪贴板）按 PRD 11.d 属于已知未知项；正式承诺仍限定 Ubuntu LTS。

## 功能限制

5. **原生日志兼容性按 Provider 版本变化**：历史读取器只接受经过 Session ID、CWD 与 Provider 根目录校验的 Claude、Codex、Pi、Kimi、Qoder JSONL。上游格式发生未知变化时会跳过无法解析的行或明示不可用，不会回退为保存 PTY 副本。
6. **Kimi/Codex 的 Hook 状态为降级**：Kimi 0.27.0 无会话级 hook 注入机制（只有全局 `~/.kimi-code/config.toml`，AgentPort 按约束不修改）；Codex 0.144.5 的 `notify` 语义无法从 CLI 输出确认，未注入。两者状态显示为 PTY 启发式（中置信度）+ 进程事实，UI 标记"状态可能不精确"。Claude 2.1.214 经按调用 `--settings` 注入 hook（高置信度）。
7. **原生 Session ID 捕获**：Claude 启动时经 `--session-id` 指定（精确）。Kimi/Codex 交互式 TUI 输出中未稳定暴露 ID（`kimi -p`/`codex exec --json` 可捕获，TUI 未证实）——首次启动 `resumePrecision=latest`（明示）；若运行中经 hook/输出捕获到 ID 则升级为 exact。
8. **Generic Shell 无恢复**：重启 shell session 总是新进程并明示"不可恢复"，绝不伪装。
9. **job control 之外的更深逃逸**（子进程自己 `setsid` 守护化）不在进程组清理范围内；清理按 session leader + ppid 树快照实现（macOS `ps` 的 sess 列恒 0，无法按 session id 归组）。
10. **Generic Shell 结束后无历史**：Shell 没有可验证的 Agent 原生日志；AgentPort 只提供运行期 4 MiB 内存尾部，不另行保存终端正文。
11. **旧 `output.log` 相关面已移除，但仍有死引用待清理**：Host 不再写 PTY 正文日志（本文件第 10 条），本次已删除读取它的 `Exporter::export_log/export_markdown`、远端 `session.recovery_context.read` 能力与其无生产者的错误码，并把 `diag hosts` 的 `logBytes` 改为本运行已输出的字节数（durable log cursor）。仍未清理：`sessions.log_path` 字段（含 CLI 建会话时写入的旧约定路径、`session status` 的 `logPath` 输出）、`SearchIndex` 的 FTS 正文索引与 `rebuild_all`/`query`（无生产调用方，仅保留 `purge_*` 清理路径）、`perf` 中已重基线的场景历史命名。删除这些面需要一次带迁移的单独改动。
12. **备份原生覆盖可能不完整**：v2 只归档能按原生 Session ID（及 Provider 可用的 CWD 绑定）唯一验证的文件；来源缺失或歧义时仍可生成通过完整性校验的备份，但 UI/Manifest 会将 `nativeCoverage` 标为不完整。Generic Shell 记为不支持，v1 旧版备份不含原生正文合同。备份 ZIP 不加密；恢复目标是当前配置的 Provider home，遇到同路径不同内容会中止而不覆盖。

## 验证缺口（如实标记）

13. **可访问性人工验收未自动化**：VoiceOver/Orca 12 条键盘路径已有实现与单元级支撑（焦点管理、aria-live、screenReaderMode、深浅主题、减少动效），但 PRD 要求的人工脚本验收未在本机执行，标记未验证。
14. **GUI 交互自动化缺失**：GUI 烟测覆盖启动/窗口渲染/数据初始化；完整 GUI 操作流（点击、IME 输入、拖拽）无自动化回放，依赖 CLI 层等价验证 + 人工抽检。
15. **性能基线**：PRD 基线为 M1/8GiB 与 Ubuntu 22.04/4核/8GiB；本机为 Apple Silicon 更新机型、Docker 模拟 x86_64（Rosetta），数字仅作参考，报告注明实测环境。
16. **长稳指标**：10 分钟空闲内存/5 分钟 CPU 采样以较短窗口近似（报告中注明实际窗口）。
17. **secret 锁定场景**（Keychain 锁定/Secret Service 锁定）未自动化：macOS 无法脚本锁定登录钥匙串而不影响用户环境；对应代码路径（`backend_status` Locked 映射、启动阻止）已实现并有单元测试，端到端人工验证未做。
