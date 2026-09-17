# AgentPort 自动更新（Tauri Updater）

AgentPort 的升级是**整包升级**：一个 Release = 一个版本，Tauri 壳、Vite/React dist 与全部 Sidecar（`agentport-host`、`agentport-remote-bridge`、`agentport-mosh-attach`、`agentport-connector`）作为同一个 `bundle.externalBin` 集合一起安装，**没有独立的 Host updater**。

```
一个 Release = v0.2.0
AgentPort.app
├── Contents/MacOS/agentport                 ← Tauri 壳
├── Contents/MacOS/agentport-host            ← bundled sidecar
├── ...（其余 sidecar）
└── Contents/Resources/…（WebView 内嵌前端 dist）

Tauri bundle → 安装包 → Tauri Updater 整包更新
```

这样做避免了“UI 1.3 / Host 1.2 协议兼容、谁先升级、Host 更新失败回滚”这类双版本问题。

## 用户可见流程

> 平台范围：应用内更新当前只对 **macOS** 生效。Linux 的 `.deb`/tarball 由系统包管理器升级（bundler 只能用 AppImage 产出 Linux updater 载荷，而 AppImage 尚未发布），Windows 不在本项目分发范围内；其他平台 `update_status` 直接返回 `disabled`，不产生网络请求。

```
启动 → 后台 check()
   ├── 无更新：静默（Settings 不改动）
   └── 有更新：后台 download()，界面右下角卡片显示进度
              → 「AgentPort v0.2.0 已准备好」
              → 用户点「退出并更新」
                   ↓
        Rust: 持久化渲染恢复边界
                   ↓
        Rust: graceful stop 全部运行中的 Session Host
                   ↓
        Rust: 复核进程组已清理（失败则中止，保持旧版本运行）
                   ↓
        update.install() → app.restart()
                   ↓
        新版 AgentPort 启动（Sidecar 与前端同为新版）
```

要点：

- **下载可以自动，安装必须用户点击**。更新安装会停止正在运行的 Session，因此界面明确提示“安装会停止 N 个运行中的 Session，升级后可重新启动”，而不是静默安装。
- 安装前 Host 停止走与归档/删除相同的 `HostManager::stop` 路径（认证 socket → 进程组清理 → 持久化终止事实），任何 Session 无法证明清理完成都会**中止安装**并保留当前版本。
- Session 本身不依赖 Host 内存：升级前会像正常退出一样写入渲染器确认的恢复边界，升级后 Session 为 `interrupted`，由用户按既有流程 Restart。

## 前端与 Rust 的分工

| 位置 | 职责 |
|---|---|
| `src-tauri/src/updater.rs` | 检查、下载、进度事件、停止 Host、安装、重启 |
| `src/src/components/UpdateBanner.tsx` | 只渲染状态 + 用户确认，不控制进程生命周期 |
| `src/src/api.ts` | `update_status` / `update_check` / `update_download` / `update_install` + `update-state` 事件 |

Rust 命令：

| 命令 | 说明 |
|---|---|
| `update_status` | 返回当前 `UpdateSnapshot`（WebView 重载后的状态对齐） |
| `update_check` | 访问 `plugins.updater.endpoints`，结果写入 `update-state` |
| `update_download` | 后台下载并校验签名，进度通过同一事件推送 |
| `update_install` | 停止 Host → 复核 → `Update::install` → `app.restart()` |

配置（`src-tauri/tauri.conf.json`）：

```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "endpoints": ["https://github.com/yiwen65/AgentPort/releases/latest/download/latest.json"],
      "pubkey": "<TAURI_SIGNING_PRIVATE_KEY 对应的公钥>",
      "windows": { "installMode": "passive" }
    }
  }
}
```

WebView **没有** `updater:*` 权限（`src-tauri/capabilities/default.json` 未授予）。整个流程由 Rust 命令驱动，前端无法指定 endpoint、无法自行安装。

## Debug / 开发构建永远不升级

- `cfg!(debug_assertions)` 为真：`update_status` 固定返回 `disabled`，启动探针直接返回，不访问任何 feed。
- 设置 `AGENTPORT_UPDATER_DISABLED=1` 可在 release 构建中临时关闭（用于发布前的手工验证）。
- 因此 `tauri dev`、以及 checkout 内 `target/debug/bundle/macos/AgentPort.app` 调试包都不会被正式升级影响。

## 发布流程

1. 对齐版本（唯一版本源：`Cargo.toml [workspace.package]`、`src-tauri/tauri.conf.json`、`src/package.json`）：

   ```bash
   scripts/set-version.sh 0.2.0     # 同时校验三者一致
   scripts/check-version-sync.sh    # 单独校验
   ```

2. 提交并打 tag：

   ```bash
   git commit -am "release: v0.2.0"
   git tag v0.2.0 && git push origin main v0.2.0
   ```

3. GitHub Actions（`.github/workflows/release.yml`）在 tag 上构建 macOS（universal），由 `tauri-action` 上传 Release 资产，并生成 `latest.json`：

   ```
   AgentPort_0.2.0_universal.dmg
   AgentPort.app.tar.gz      + AgentPort.app.tar.gz.sig
   latest.json               （darwin-aarch64 / darwin-x86_64 指向同一个 universal 包）
   ```

   Linux 仍走既有手工/容器流程（`scripts/build-linux.sh`），由包管理器升级。

4. 客户端下一次启动时通过 `latest.json` 发现更新。

### 两种签名互不替代

| 签名 | 作用 | 来源 |
|---|---|---|
| OS 代码签名 / 公证 | 让 macOS、Windows 信任这个 App | `APPLE_*`、`APPLE_SIGNING_IDENTITY` 等，沿用 `AGENTS.md` 与 `docs/install.md` 的既有规则 |
| Tauri Updater 签名 | 让客户端确认更新包来自发布者 | `TAURI_SIGNING_PRIVATE_KEY`（+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`） |

Updater 密钥只用于签 `.sig`，**不会**让 macOS 信任 App；反之 OS 签名也不会让 Updater 接受更新包。

### Updater 密钥

- 私钥：本机 `~/.tauri/agentport-updater.key`（不要提交、不要放进 Release）。
- 公钥：已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。
- GitHub Secrets：`TAURI_SIGNING_PRIVATE_KEY`（私钥内容或路径）、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（无密码时留空）。
- **私钥丢失后无法再向已安装的客户端推送更新**（客户端只认对应公钥），请离线备份。密钥泄露则需要轮换公钥并让旧版本先升级到带新公钥的版本。

本地构建（`scripts/build-macos.sh`）在没有密钥时自动以 `--config '{"bundle":{"createUpdaterArtifacts":false}}'` 跳过 updater 产物，避免“配置了 pubkey 却没有私钥”导致构建失败；这种 DMG 可以手工安装，但不能作为更新源发布。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 客户端一直“检查中”后无提示 | `update-state` 事件里 `phase=error`，查看 `~/Library/Logs` 之外的 App 日志：`<AppPaths 根>/logs/app.log`（`tracing` 记录 check/download 失败） |
| 下载完成但提示签名/校验失败 | `TAURI_SIGNING_PRIVATE_KEY` 与 `pubkey` 不匹配；构建日志会出现 “does not match the public key” 警告 |
| 安装按钮点不动 / 报 “could not be stopped safely” | 某个 Session Host 的进程组清理无法确认，安装被主动中止；先手工停止该 Session 再重试 |
| 点了「退出并更新」后窗口消失但没升级 | macOS 安装需要 App 包可写：把 App 放在 `/Applications` 等可写位置，不要直接从只读 DMG 运行 |
| Debug App 从不提示更新 | 预期行为，见上文 “Debug / 开发构建永远不升级” |

## 相关文件

- `src-tauri/src/updater.rs` — 更新状态机与命令
- `src-tauri/tauri.conf.json` — endpoint / pubkey / `createUpdaterArtifacts`
- `src-tauri/src/main.rs` — `stop_live_sessions_for_update`（安装前的 Host 清理与复核）
- `src/src/components/UpdateBanner.tsx` — 用户确认界面
- `scripts/check-version-sync.sh`、`scripts/set-version.sh` — 单版本对齐
- `.github/workflows/release.yml` — tag 触发的发布流水线
