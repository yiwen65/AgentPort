#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=versions.env
source "$ROOT/versions.env"
DOWNLOADS="$ROOT/downloads"
SOURCES="$ROOT/sources"
OUTPUT="$ROOT/build/android/arm64-v8a"
MOSH_SRC="$SOURCES/mosh-android"
DEPS_ARCHIVE="$DOWNLOADS/mosh-android-libs-v1.0.0.tar.gz"
PROTOC_ARCHIVE="$DOWNLOADS/protoc-33.3-osx-aarch_64.zip"
DEPS_ROOT="$SOURCES/android-deps"
DEPS="$DEPS_ROOT/android-libs"
PROTOC_ROOT="$SOURCES/protoc-33.3"
PROTOC="$PROTOC_ROOT/bin/protoc"

for tool in git curl shasum tar unzip autoreconf automake make; do
  command -v "$tool" >/dev/null || { echo "missing build tool: $tool" >&2; exit 1; }
done
if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  for candidate in \
    /opt/homebrew/share/android-commandlinetools/ndk/* \
    "$HOME/Library/Android/sdk/ndk"/*; do
    [[ -d "$candidate/toolchains/llvm/prebuilt" ]] && ANDROID_NDK_HOME="$candidate"
  done
fi
if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" ]]; then
  echo "set ANDROID_NDK_HOME to an installed Android NDK" >&2
  exit 1
fi
PREBUILT=$(find "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" -mindepth 1 -maxdepth 1 -type d | head -1)
TOOLCHAIN="$PREBUILT/bin"
CC="$TOOLCHAIN/aarch64-linux-android${ANDROID_API}-clang"
CXX="$TOOLCHAIN/aarch64-linux-android${ANDROID_API}-clang++"
for tool in "$CC" "$CXX" "$TOOLCHAIN/llvm-ar" "$TOOLCHAIN/llvm-ranlib"; do
  [[ -x "$tool" ]] || { echo "missing NDK tool: $tool" >&2; exit 1; }
done

mkdir -p "$DOWNLOADS" "$SOURCES" "$OUTPUT"
download() {
  local url=$1 checksum=$2 destination=$3
  if [[ ! -f "$destination" ]] || ! echo "$checksum  $destination" | shasum -a 256 -c -; then
    rm -f "$destination"
    curl -fL --retry 3 -o "$destination" "$url"
  fi
  echo "$checksum  $destination" | shasum -a 256 -c -
}
download "$ANDROID_DEPS_URL" "$ANDROID_DEPS_SHA256" "$DEPS_ARCHIVE"
download "$ANDROID_PROTOC_URL" "$ANDROID_PROTOC_SHA256" "$PROTOC_ARCHIVE"

rm -rf "$DEPS_ROOT" "$PROTOC_ROOT"
mkdir -p "$DEPS_ROOT" "$PROTOC_ROOT"
tar -xzf "$DEPS_ARCHIVE" -C "$DEPS_ROOT"
unzip -q "$PROTOC_ARCHIVE" -d "$PROTOC_ROOT"
[[ "$($PROTOC --version)" == "libprotoc 33.3" ]] || { echo "unexpected protoc version" >&2; exit 1; }

if [[ ! -d "$MOSH_SRC/.git" ]]; then
  rm -rf "$MOSH_SRC"
  git clone --filter=blob:none "$MOSH_REPOSITORY" "$MOSH_SRC"
fi
git -C "$MOSH_SRC" fetch --depth 1 origin "$MOSH_COMMIT"
git -C "$MOSH_SRC" reset --hard "$MOSH_COMMIT"
git -C "$MOSH_SRC" clean -fdx
git -C "$MOSH_SRC" apply "$ROOT/patches/android-mobile.patch"

LIBDIR="$DEPS/static/arm64-v8a"
PROTOBUF_LIBS=(
  "$LIBDIR/libprotobuf.a" "$LIBDIR"/libabsl_*.a
  "$LIBDIR"/libutf8_*.a "$LIBDIR/libupb.a"
)
PROTOBUF_LINK="-Wl,--start-group ${PROTOBUF_LIBS[*]} -Wl,--end-group -llog -landroid -lm"
FLAGS="-fPIC -ftls-model=global-dynamic"
INCLUDES="-D__ANDROID__ -I$DEPS/include -I$DEPS/include/ncurses -I$MOSH_SRC"
cd "$MOSH_SRC"
./autogen.sh
CC="$CC -std=gnu23" CXX="$CXX -std=gnu++17" \
AR="$TOOLCHAIN/llvm-ar" RANLIB="$TOOLCHAIN/llvm-ranlib" \
CFLAGS="$FLAGS" CXXFLAGS="$FLAGS" CPPFLAGS="$INCLUDES" \
LDFLAGS="-L$LIBDIR" ac_cv_path_PROTOC="$PROTOC" \
protobuf_CFLAGS="-I$DEPS/include" protobuf_LIBS="$PROTOBUF_LINK" \
OpenSSL_CFLAGS="-I$DEPS/include" OpenSSL_LIBS="-L$LIBDIR -lcrypto" \
TINFO_CFLAGS="-I$DEPS/include/ncurses" TINFO_LIBS="-L$LIBDIR -lncursesw" \
./configure --host=aarch64-linux-android --prefix="$OUTPUT/prefix" \
  --with-crypto-library=openssl --disable-client --disable-server \
  --enable-ios-controller --with-ncurses
make clean
make -j "$(sysctl -n hw.ncpu)"

MOSH_LIBS=(
  src/crypto/libmoshcrypto.a src/network/libmoshnetwork.a
  src/protobufs/libmoshprotos.a src/statesync/libmoshstatesync.a
  src/terminal/libmoshterminal.a src/frontend/libmoshiosclient.a
  src/util/libmoshutil.a
)
DEPENDENCY_LIBS=(
  "$LIBDIR/libprotobuf.a" "$LIBDIR"/libabsl_*.a
  "$LIBDIR"/libutf8_*.a "$LIBDIR/libupb.a"
  "$LIBDIR/libssl.a" "$LIBDIR/libcrypto.a" "$LIBDIR/libncursesw.a"
)
"$CXX" -shared -Wl,-soname,libagentport_mosh.so \
  -o "$OUTPUT/libagentport_mosh.so" \
  -Wl,--whole-archive "${MOSH_LIBS[@]}" -Wl,--no-whole-archive \
  -Wl,--start-group "${DEPENDENCY_LIBS[@]}" -Wl,--end-group \
  -lz -llog -landroid -lm -ldl
cp "$PREBUILT/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" "$OUTPUT/libc++_shared.so"

JNI="$ROOT/../../src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
mkdir -p "$JNI"
rm -f "$JNI/libagentport_mosh.so" "$JNI/libc++_shared.so"
install -m 755 "$OUTPUT/libagentport_mosh.so" "$JNI/libagentport_mosh.so"
install -m 755 "$OUTPUT/libc++_shared.so" "$JNI/libc++_shared.so"
"$TOOLCHAIN/llvm-readelf" -Ws "$OUTPUT/libagentport_mosh.so" > "$OUTPUT/symbols.txt"
grep -q ' mosh_main$' "$OUTPUT/symbols.txt"
rm "$OUTPUT/symbols.txt"
"$TOOLCHAIN/llvm-readelf" -d "$OUTPUT/libagentport_mosh.so" > "$OUTPUT/dynamic.txt"
grep NEEDED "$OUTPUT/dynamic.txt"
rm "$OUTPUT/dynamic.txt"
echo "built and installed Android arm64 Mosh libraries"
