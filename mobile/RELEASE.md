# iPhone 本地开发分发（免费 Personal Team / 付费长期证书）

此流程是 **Apple Development 签名**，不是付费 Apple Developer Program 的 Ad Hoc、TestFlight、App Store 或企业分发。免费 Apple ID 的 Personal Team 通常只有约 **7 天**的 profile/App 有效期，且有设备、App ID 和能力数量限制；以 Apple 实际签发的 profile 为准。IPA 不是任何 iPhone 都能安装的通用安装包，也不能通过企业/Ad Hoc OTA 链接绕过 Apple 限制。

## 付费长期证书（Apple Developer Program 会员）

开通付费会员后改用付费 Team 的 **Apple Development 签名**，profile 有效期约 **1 年**，替代免费 Personal Team 的 7 天证书。下文的准备、包装、安装流程不变，仅以下几点不同：

- **Team ID 会变**：同一 Apple ID 开通会员后，付费团队的 Team ID 与原个人团队不同；钥匙串会签发新证书（CN 可能仍带旧个人团队后缀，以证书 OU/自动签名实际匹配的 team 为准）。先用 `security find-identity -v -p codesigning` 确认可用证书，`APPLE_DEVELOPMENT_TEAM` 传付费 Team ID，不要再沿用已失效的旧个人团队 ID。真实 Team ID 仍只保存在本机。
- **Xcode 必须已登录会员账号**：未登录时 xcodebuild 报 `No Accounts: Add a new account in Accounts settings`；在 Xcode → Settings → Accounts 登录，必要时同意新的开发者计划协议。
- **先让本机拿到含目标设备的长期 profile**：官方脚本不带 `-allowProvisioningUpdates`，无法注册新设备或创建 profile。先用一次性 xcodebuild 触发（profile 会缓存到 `~/Library/Developer/Xcode/UserData/Provisioning Profiles/`）：

  ```bash
  cd mobile
  CONFIG="$(mktemp)"
  printf 'DEVELOPMENT_TEAM = <付费 Team ID>\nCODE_SIGN_STYLE = Automatic\nCODE_SIGN_IDENTITY = Apple Development\nCODE_SIGNING_ALLOWED = YES\nCODE_SIGNING_REQUIRED = YES\n' > "$CONFIG"
  XCODE_XCCONFIG_FILE="$CONFIG" xcodebuild archive \
    -project src-tauri/gen/apple/agentport-mobile.xcodeproj \
    -scheme agentport-mobile_iOS -configuration Debug \
    -destination 'platform=iOS,id=<iPhone hardware UDID>' \
    -archivePath src-tauri/gen/apple/build/agentport-mobile_iOS.xcarchive \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration
  ```

  这次 archive 在 provisioning 之后会因 Rust 阶段失败（见下一条），属预期；只要 profile 已签发即可。若生成了 `build/agentport-mobile_iOS.xcarchive` 残留，按前文移开后再跑官方脚本。
- **不能绕过 tauri CLI 直接完整构建**：生成工程的 `Build Rust Code` 阶段回调 `tauri ios xcode-script`，它依赖 `tauri ios build` 启动的本地参数服务；直接调 xcodebuild 会在该阶段 panic（WebSocket `Connection refused`）。完整构建仍走上面的官方脚本。
- **验证与续期**：打包输出的 `manifest.json` 中 `profile_expires_utc` 应约为一年后，且 `provisioned_device_count` 覆盖目标设备。到期前重跑本节流程即可；覆盖安装保留 App 数据。

## 本机准备

按 [BUILDING.md](BUILDING.md) 安装依赖、`npm ci`、Rust iOS target，并先构建真机 Mosh/protobuf 静态库。需要完整 Xcode、Python 3、已登录 Xcode 的 Apple ID（免费 Personal Team 或付费会员团队），以及本机钥匙串中的 Apple Development 证书和私钥。连接、信任 iPhone，在 Xcode 的 Devices and Simulators 完成配对；iOS 16+ 开启开发者模式。

在 Xcode 选择目标 Team（免费 Personal Team 或付费团队）和自动开发签名，允许 Xcode 为自己的设备注册/签发 profile；必要时先在 Xcode 完成签名配置。免费团队不支持的 entitlement 需要先解决，不能改用 distribution profile 掩盖失败。机器未准备好 profile 时 CLI 可能失败；回 Xcode 修复后重试，不假定 CLI 自动登录或注册成功。

现有生成 Xcode 工程中的 Team ID 只是本机状态，**不得提交真实 Team ID**、生成签名改动、profile、证书或钥匙串。脚本使用临时 xcconfig 覆盖生成工程签名设置，不编辑生成工程。以下变量仅在本机 shell 中设置，不写入版本控制：

```bash
cd mobile
export APPLE_DEVELOPMENT_TEAM='<Personal Team ID>'
export IOS_DEVICE_UDID='<iPhone hardware UDID>'
export IOS_OUTPUT_DIR="$HOME/AgentPort-private/iphone-$(date +%Y%m%d-%H%M%S)"
bash scripts/build-ios-personal-team.sh
```

设备 UDID 从 Xcode 设备详情获取；不要把 devicectl 的连接 UUID 当作 profile 中的硬件 UDID。脚本拒绝已有 archive 和输出目录，避免误用旧包；重复构建前自行把 `src-tauri/gen/apple/build/agentport-mobile_iOS.xcarchive` 移到私有备份目录。不要把模拟器库复制成真机库。脚本通过 Tauri `--debug --target aarch64 --archive-only` 创建物理设备 archive，强制 Automatic / Apple Development 签名，不执行 `xcodebuild -exportArchive`。

## 包装已有签名 archive

也可以只运行验证/打包（不会重签名或修改输入）：

```bash
python3 scripts/package-ios-development.py \
  --app src-tauri/gen/apple/build/agentport-mobile_iOS.xcarchive/Products/Applications/AgentPort.app \
  --team-id "$APPLE_DEVELOPMENT_TEAM" --device-udid "$IOS_DEVICE_UDID" \
  --output "$IOS_OUTPUT_DIR"
```

可重复 `--device-udid` 校验多个目标设备；bundle ID 默认 `com.agentport.mobile`，本机合法修改时显式传 `--bundle-id`。默认剩余有效期必须超过 1 小时，可用 `--min-valid-hours` 或构建脚本的 `IOS_MIN_VALID_HOURS` 提高阈值。

验证包括：profile 创建/过期时间、注册设备列表及目标 UDID、bundle/team/app identifier、开发 entitlement（拒绝 Ad Hoc/企业）、签名 entitlement 不超出 profile、签名证书属于 profile、iPhoneOS 元数据、主程序 arm64/Mach-O iOS 平台、`codesign --verify --deep --strict`。当前仅支持单 App，不支持需独立 profile 的 App Extensions/Watch。该策略验证“设备开发签名”，不能仅凭 profile 可靠判断 Apple 账户是否付费；必须由操作者在 Xcode 确认选择 Personal Team。

`ditto` 将原始签名 `.app` 放进 IPA 的 `Payload/`；解包后再次验签并比较 `embedded.mobileprovision` 字节。输出包含 IPA、`manifest.json` 和 `SHA256SUMS`（`shasum -a 256 -c SHA256SUMS` 可复核）。manifest 仅记录有效期、设备数量、校验状态、平台及摘要，不包含 Team ID、UDID、profile 内容或凭据。**IPA 本身必然含有 profile 的 Team ID/设备 UDID 和公钥证书，不可公开上传**；它不包含签名私钥。不要上传 archive、构建日志或本机签名配置。

这是可重复操作的构建/包装流程，不承诺逐字节相同的 archive/IPA：证书、profile、时间戳和 Xcode 版本都会影响产物。依赖来自锁文件；记录自己的源码 revision、Xcode/Rust/Node 版本以便复现。

## 安装、验收和续期

推荐 Apple 官方工具安装 archive 中已签名 `.app`：

```bash
xcrun devicectl list devices
xcrun devicectl device install app --device '<devicectl device identifier>' \
  src-tauri/gen/apple/build/agentport-mobile_iOS.xcarchive/Products/Applications/AgentPort.app
xcrun devicectl device process launch --device '<devicectl device identifier>' com.agentport.mobile
```

也可用 Xcode Devices and Simulators 的 Installed Apps 添加 App，或 Apple Configurator 的 Add Apps / Choose from my Mac 选择 IPA（取决于工具版本）。只有 profile 包含的设备、有效 profile/证书和正确开发者信任状态才可安装/运行；工具安装成功不代表业务验收。首次运行若提示信任，按 iPhone「设置 → 通用 → VPN 与设备管理」操作。

有效期到达后 App 通常无法启动。重新连接设备，在 Xcode 刷新 Personal Team profile，用新的开发签名重新 archive、验证和安装；单纯重新压缩旧 `.app` **不会续期**。保持 bundle ID/team 并覆盖安装通常保留数据，不保证系统永远保留；先备份重要数据，不要默认卸载。新增设备必须重新签发包含该 UDID 的 profile 并重建。

## 验证边界

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-package-ios-development.py
bash -n scripts/build-ios-personal-team.sh
```

单元测试使用虚构 profile，覆盖有效期、设备、team/bundle、开发 entitlement 和平台拒绝策略；不替代真实 Apple CMS、codesign、archive、IPA 安装或 iPhone 启动验收。本次流程实现没有执行 native archive 或真机安装。
