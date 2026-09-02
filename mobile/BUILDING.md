# AgentPort Mobile 构建与签名模板

## 状态边界

仓库包含 Tauri 生成的 iOS/Android 工程。当前验证过 Android API 29 和 iOS 26.5 模拟器的构建与非空白启动；Apple 当前 Xcode catalog 不再提供 iOS 16.0/16.4 runtime，因此最低 iOS 版本的运行验收仍需带 iOS 16 runtime 的固定 CI 或开发机。这里只证明 deployment target 为 16.0，不以最新 runtime 替代最低版本结论。

## 通用依赖

- Node.js 18+ 与 npm
- Rust 1.85+（当前移动依赖的最低版本；建议 rustup 固定 toolchain）
- Tauri CLI 2（由 `npm ci` 安装）

```bash
cd mobile
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## iOS

目标：iOS 16+。需要 Xcode、Command Line Tools、CocoaPods（若生成工程要求）及 Rust iOS targets。

```bash
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
npm run tauri -- ios init --ci --skip-targets-install
npm run build:ios-simulator
```

需要 XcodeGen、CocoaPods 和 libimobiledevice；Tauri CLI 会检查这些工具。`build:ios-simulator` 只清理生成的 simulator `.app` 目的目录，再执行 Xcode 的本地 simulator 签名构建；不能传 `--no-sign`，否则 Keychain backend 在 simulator 中不可用。这也避免 Tauri 2.11 重复构建时在有效 archive 之后报 `Directory not empty (os error 66)`。团队签名值通过生成工程的 build setting 或 `signing/ios.xcconfig.template` 注入；不得把真实 Team ID、证书或 profile 提交到仓库。

最低版本验收需要 iPhone / iOS 16 runtime；最新版本另行使用当前 Xcode runtime。可用官方命令检查 catalog：

```bash
xcodebuild -downloadPlatform iOS -buildVersion 16.0 -architectureVariant arm64 -exportPath /tmp/ios-runtime
```

若返回 `is not available for download`，只能记录 blocker 或使用固定 CI，不能用最新 runtime 代替最低版本结论。仓库提供 `.github/workflows/mobile-ios16.yml`，它只接受带官方 iOS 16 runtime 的 `self-hosted/macOS/agentport-ios16` runner，并上传 smoke 截图；在此 runner 实际执行通过前最低版本 gate 仍为 blocked。受限网络若阻止 SwiftPM 拉取依赖，应配置团队批准的 Git mirror/cache；不要把机器级 mirror 或凭据写入仓库。

## Android

目标：Android 10/API 29+。需要 JDK 17、Android command-line tools、platform-tools、emulator、API 29 platform/image 和 Rust Android target。

```bash
export PATH="$HOME/.cargo/bin:$PATH"
export JAVA_HOME=/path/to/jdk17/Contents/Home
export ANDROID_HOME=/path/to/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
rustup target add aarch64-linux-android x86_64-linux-android
npm run tauri -- android init --ci --skip-targets-install
npm run tauri -- android build --debug --apk --target aarch64 --ci
```

生成工程后核对 `applicationId = "com.agentport.mobile"`、`minSdk = 29`、`compileSdk = 36` 和 `targetSdk = 36`，创建 API 29 arm64 AVD，并运行 Gradle/unit/build 与 emulator smoke。若 Maven Central 在当前网络被阻断，只能通过团队批准的临时 Gradle mirror 配置构建；不得提交用户级 mirror。签名模板见 `signing/android-keystore.properties.template`；真实 keystore、密码和 alias 不得提交。

## 许可与可复现 Mosh

T-017 引入 Mosh 时必须：

1. 固定上游源码 revision 与所有 patch；
2. 从源码构建 iOS/Android binding；
3. 保留 GPLv3、上游 notice 和 Corresponding Source 获取方式；
4. 验证普通 Shell 与 AgentPort Session attach，不能只链接预构建不可追溯二进制。

## 当前验证记录

- Android：API 29 arm64 emulator 已验证 debug APK 安装、冷启动和非空白空状态；最低 Android gate 已通过。
- iOS：iOS 26.5 / arm64 simulator 已验证无签名 debug bundle 安装、启动和非空白空状态；`IPHONEOS_DEPLOYMENT_TARGET = 16.0`。
- iOS 最低版本：Xcode catalog 对 16.0 和 16.4 均返回 `is not available for download`，尚未运行 iOS 16 simulator gate。
- Web/Rust host 检查不能替代上述平台运行验收；真机网络、后台和安全存储也不由模拟器结果证明。
