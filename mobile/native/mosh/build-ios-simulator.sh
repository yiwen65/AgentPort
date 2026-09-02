#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=versions.env
source "$ROOT/versions.env"
DOWNLOADS="$ROOT/downloads"
SOURCES="$ROOT/sources"
OUTPUT="$ROOT/build/ios-simulator-arm64"
MOSH_SRC="$SOURCES/mosh"
PROTOBUF_ARCHIVE="$DOWNLOADS/protobuf-all-$PROTOBUF_IOS_VERSION.tar.gz"
PROTOBUF_SRC="$SOURCES/protobuf-$PROTOBUF_IOS_VERSION"
PROTOBUF_BUILD="$SOURCES/protobuf-ios-simulator-arm64-build"

for tool in git curl shasum tar cmake ninja autoreconf automake libtool xcrun make; do
  command -v "$tool" >/dev/null || { echo "missing build tool: $tool" >&2; exit 1; }
done
PROTOC=${PROTOC:-$(command -v protoc || true)}
if [[ -z "$PROTOC" || "$($PROTOC --version)" != "libprotoc 3.21.12" ]]; then
  echo "protobuf 21.12 protoc is required (set PROTOC=/path/to/protoc)" >&2
  exit 1
fi
NCURSES_PREFIX=${NCURSES_PREFIX:-$(brew --prefix ncurses 2>/dev/null || true)}
if [[ ! -f "$NCURSES_PREFIX/include/ncurses.h" ]]; then
  echo "ncurses headers are required (set NCURSES_PREFIX)" >&2
  exit 1
fi

mkdir -p "$DOWNLOADS" "$SOURCES" "$OUTPUT"
if [[ ! -f "$PROTOBUF_ARCHIVE" ]] || ! echo "$PROTOBUF_IOS_SHA256  $PROTOBUF_ARCHIVE" | shasum -a 256 -c -; then
  rm -f "$PROTOBUF_ARCHIVE"
  curl -fL --retry 3 -o "$PROTOBUF_ARCHIVE" "$PROTOBUF_IOS_URL"
fi
echo "$PROTOBUF_IOS_SHA256  $PROTOBUF_ARCHIVE" | shasum -a 256 -c -

if [[ ! -d "$PROTOBUF_SRC" ]]; then
  tar -xzf "$PROTOBUF_ARCHIVE" -C "$SOURCES"
fi
rm -rf "$PROTOBUF_BUILD"
cmake -S "$PROTOBUF_SRC/cmake" -B "$PROTOBUF_BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_SYSTEM_NAME=iOS \
  -DCMAKE_OSX_SYSROOT=iphonesimulator \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$IOS_DEPLOYMENT_TARGET" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -Dprotobuf_BUILD_TESTS=OFF \
  -Dprotobuf_BUILD_PROTOC_BINARIES=OFF \
  -Dprotobuf_BUILD_SHARED_LIBS=OFF \
  -Dprotobuf_WITH_ZLIB=OFF
cmake --build "$PROTOBUF_BUILD" --target libprotobuf -j "$(sysctl -n hw.ncpu)"

if [[ ! -d "$MOSH_SRC/.git" ]]; then
  rm -rf "$MOSH_SRC"
  git clone --filter=blob:none "$MOSH_REPOSITORY" "$MOSH_SRC"
fi
git -C "$MOSH_SRC" fetch --depth 1 origin "$MOSH_COMMIT"
git -C "$MOSH_SRC" reset --hard "$MOSH_COMMIT"
git -C "$MOSH_SRC" clean -fdx

SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
CC=$(xcrun --sdk iphonesimulator --find clang)
AR=$(xcrun --sdk iphonesimulator --find ar)
RANLIB=$(xcrun --sdk iphonesimulator --find ranlib)
FLAGS="-arch arm64 -isysroot $SDK -mios-simulator-version-min=$IOS_DEPLOYMENT_TARGET -I$NCURSES_PREFIX/include"
cd "$MOSH_SRC"
./autogen.sh
ac_cv_path_PROTOC="$PROTOC" \
protobuf_CFLAGS="-I$PROTOBUF_SRC/src" \
protobuf_LIBS="$PROTOBUF_BUILD/libprotobuf.a" \
CC="$CC" CXX="$CC" CPP="$CC -E" AR="$AR" RANLIB="$RANLIB" \
CFLAGS="$FLAGS" CXXFLAGS="$FLAGS -std=c++17" CPPFLAGS="$FLAGS" \
LDFLAGS="-arch arm64 -isysroot $SDK -mios-simulator-version-min=$IOS_DEPLOYMENT_TARGET" \
./configure --prefix="$OUTPUT" --disable-server --disable-client \
  --enable-ios-controller --host=arm64-apple-darwin
make clean
make -j "$(sysctl -n hw.ncpu)"

rm -f "$OUTPUT/libmosh.a" "$OUTPUT/libprotobuf.a"
libtool -static -o "$OUTPUT/libmosh.a" \
  src/crypto/libmoshcrypto.a src/network/libmoshnetwork.a \
  src/protobufs/libmoshprotos.a src/statesync/libmoshstatesync.a \
  src/terminal/libmoshterminal.a src/frontend/libmoshiosclient.a \
  src/util/libmoshutil.a
cp "$PROTOBUF_BUILD/libprotobuf.a" "$OUTPUT/libprotobuf.a"

file "$OUTPUT/libmosh.a" "$OUTPUT/libprotobuf.a"
nm -gU "$OUTPUT/libmosh.a" > "$OUTPUT/symbols.txt"
grep -q ' _mosh_main$' "$OUTPUT/symbols.txt"
rm "$OUTPUT/symbols.txt"
echo "built $OUTPUT/libmosh.a and static libprotobuf.a"
