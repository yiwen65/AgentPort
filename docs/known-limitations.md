# AgentPort 已知限制（0.1.0）

本文件与 `release-manifest.json` 互相印证：下列每一项都如实记录，未验证项不冒充已验证。

## 平台与构建

1. **macOS Universal（x86_64+arm64）未在本机产出**。本机是 Homebrew Rust（无 rustup target std），只构建了 `aarch64`。Universal 构建流程已脚本化（`scripts/build-macos.sh --universal`，需 rustup 双 target），未在本机验证。
2. **Developer ID 签名与公证未执行**（本机无开发者证书）。构建脚本会应用完整的 ad-hoc Bundle 签名，以保证 App、资源和 Sidecar 通过严格完整性校验；但它不提供开发者身份信任。产出的 `.app/.dmg` 仍可能需要在“系统设置 → 隐私与安全性”放行或执行 `xattr -cr`。CI 签名/公证步骤在 `docs/install.md` 说明，标记未验证。
3. **Fedora/Arch 为社区验证层级**：Docker 构建 + 容器内冒烟；未做干净 VM 人工回归（IME/通知/卸载）。**AppImage 本次未发布**：构建窗口内 GitHub 的 linuxdeploy 下载持续失败（SSL 截断），无法完成打包；构建脚本 `scripts/build-linux.sh appimage` 可复现，网络恢复后重跑即可。按 PRD，未通过干净 VM 启动验证前不发布该 Artifact。
4. **Linux 桌面差异**（WebKitGTK/Wayland 合成器、IME、剪贴板）按 PRD 11.d 属于已知未知项；正式承诺仍限定 Ubuntu LTS。

## 功能限制

5. **搜索索引磁盘占用未达 PRD 0.35 目标**：SQLite FTS5 trigram 索引实测 ≈ 原文本 2.6–2.7×（存文本 + trigram postings；release 模式吞吐 33 MiB/s、现实密度查询 P95 1.0ms、最坏密度 268ms 均达标或有记录）。若要 0.35，需改 contentless/external-content 索引（片段凭 offset 从源日志重建）——记录为后续优化，不作为发布阻塞。
6. **Kimi/Codex 的 Hook 状态为降级**：Kimi 0.27.0 无会话级 hook 注入机制（只有全局 `~/.kimi-code/config.toml`，AgentPort 按约束不修改）；Codex 0.144.5 的 `notify` 语义无法从 CLI 输出确认，未注入。两者状态显示为 PTY 启发式（中置信度）+ 进程事实，UI 标记"状态可能不精确"。Claude 2.1.214 经按调用 `--settings` 注入 hook（高置信度）。
7. **原生 Session ID 捕获**：Claude 启动时经 `--session-id` 指定（精确）。Kimi/Codex 交互式 TUI 输出中未稳定暴露 ID（`kimi -p`/`codex exec --json` 可捕获，TUI 未证实）——首次启动 `resumePrecision=latest`（明示）；若运行中经 hook/输出捕获到 ID 则升级为 exact。
8. **Generic Shell 无恢复**：重启 shell session 总是新进程并明示"不可恢复"，绝不伪装。
9. **job control 之外的更深逃逸**（子进程自己 `setsid` 守护化）不在进程组清理范围内；清理按 session leader + ppid 树快照实现（macOS `ps` 的 sess 列恒 0，无法按 session id 归组）。
10. **诊断 ZIP 内 terminal.log 截断到最后 2 MiB**（保持包体积）；完整原始日志始终可从数据目录直接导出 `.log`。

## 验证缺口（如实标记）

11. **可访问性人工验收未自动化**：VoiceOver/Orca 12 条键盘路径已有实现与单元级支撑（焦点管理、aria-live、screenReaderMode、深浅主题、减少动效），但 PRD 要求的人工脚本验收未在本机执行，标记未验证。
12. **GUI 交互自动化缺失**：GUI 烟测覆盖启动/窗口渲染/数据初始化；完整 GUI 操作流（点击、IME 输入、拖拽）无自动化回放，依赖 CLI 层等价验证 + 人工抽检。
13. **性能基线**：PRD 基线为 M1/8GiB 与 Ubuntu 22.04/4核/8GiB；本机为 Apple Silicon 更新机型、Docker 模拟 x86_64（Rosetta），数字仅作参考，报告注明实测环境。
14. **长稳指标**：10 分钟空闲内存/5 分钟 CPU 采样以较短窗口近似（报告中注明实际窗口）。
15. **secret 锁定场景**（Keychain 锁定/Secret Service 锁定）未自动化：macOS 无法脚本锁定登录钥匙串而不影响用户环境；对应代码路径（`backend_status` Locked 映射、启动阻止）已实现并有单元测试，端到端人工验证未做。
