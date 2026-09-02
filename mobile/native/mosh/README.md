# AgentPort Mobile Mosh native build

AgentPort Mobile links the pinned Blink mobile-client fork of Mosh. Mosh and the
mobile application are distributed under GPLv3; generated native artifacts and
downloaded source trees are intentionally not committed.

## Pinned inputs

`versions.env` is the machine-readable manifest for all source revisions,
download URLs, checksums, Android API 29, and the iOS 16.0 deployment target.
The Mosh client itself is always compiled from commit
`3640d36678dc415ba24f03d7f6fb20a0dac1fa6b`.

- iOS builds Protocol Buffers 21.12 from source as a static arm64 simulator
  archive. A matching host `protoc` 3.21.12 is required.
- Android builds Mosh from source, but currently consumes the checksum-pinned
  `rjyo/mosh-android` v1.0.0 dependency archive for Android OpenSSL 3.2.1,
  Protocol Buffers 33.3/Abseil, and ncurses 6.4. The matching checksum-pinned
  host `protoc` binary is downloaded separately. This distinction must not be
  described as a source build of all Android dependencies.
- `patches/android-mobile.patch` only guards Darwin-only `SIGINFO` use and uses
  Android's UTF-8 locale contract. Mosh's thread-local selector state is built
  with the global-dynamic TLS model because Android loads APK libraries through
  `dlopen`; local-exec/initial-exec TLS either fails to link or fails to load.

## Build

From the repository root on macOS:

```bash
# Requires Xcode, cmake, ninja, autotools, ncurses headers, and protoc 3.21.12.
PROTOC=/opt/homebrew/opt/protobuf@21/bin/protoc \
  bash mobile/native/mosh/build-ios-simulator.sh

# Requires an installed Android NDK; defaults to the newest common SDK path.
bash mobile/native/mosh/build-android-arm64.sh
```

Outputs are written beneath ignored `mobile/native/mosh/build/`. The Android
script also installs ignored copies into the generated Gradle project's
`jniLibs/arm64-v8a` directory. `mobile/src-tauri/build.rs` refuses an iOS build
when the required local archives are missing.

## Corresponding source and licenses

The exact corresponding Mosh source is obtained by cloning the repository and
checking out `MOSH_COMMIT` from `versions.env`, then applying the tracked patch
for Android. `COPYING` and `COPYING.iOS` are preserved from that revision.
Dependency license files are contained in their pinned source/archive inputs;
a release source bundle must include those inputs, this build directory, and
the complete Mobile source needed to rebuild the linked application.

This document records the engineering boundary and is not legal advice.
