#!/usr/bin/env bash
# Orchestrates Linux builds via Docker (linux/amd64 under emulation on Apple
# Silicon, native on x86_64). Artifacts land in dist-release/<platform>/.
#
#   scripts/build-linux.sh ubuntu2404|ubuntu2204|fedora|arch|appimage|all
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export DOCKER_BUILDKIT=1
PLATFORM_FLAG="--platform linux/amd64"
[ "$(uname -m)" = "x86_64" ] && PLATFORM_FLAG=""

build_one() {
  local name="$1" dockerfile="$2"
  local tag="agentport-build-$name"
  local out="dist-release/$name"
  echo "== building $name (this takes a while: cargo release under $([ -n "$PLATFORM_FLAG" ] && echo emulation || echo native)) =="
  docker buildx build $PLATFORM_FLAG -f "$dockerfile" -t "$tag" --load .
  rm -rf "$out"; mkdir -p "$out"
  docker run --rm $PLATFORM_FLAG "$tag" true 2>/dev/null || true
  local cid
  cid=$(docker create $PLATFORM_FLAG "$tag")
  docker cp "$cid":/out/. "$out/"
  docker rm "$cid" >/dev/null
  ( cd "$out" && shasum -a 256 ./* 2>/dev/null | tee sha256.txt )
  echo "== $name artifacts =="
  ls -la "$out"
}

case "${1:-all}" in
  ubuntu2404) build_one ubuntu2404 scripts/linux/Dockerfile.ubuntu2404 ;;
  ubuntu2204) build_one ubuntu2204 scripts/linux/Dockerfile.ubuntu2204 ;;
  fedora)     build_one fedora     scripts/linux/Dockerfile.fedora ;;
  arch)       build_one arch       scripts/linux/Dockerfile.arch ;;
  appimage)   build_one appimage   scripts/linux/Dockerfile.appimage ;;
  all)
    build_one ubuntu2404 scripts/linux/Dockerfile.ubuntu2404
    build_one ubuntu2204 scripts/linux/Dockerfile.ubuntu2204
    build_one fedora     scripts/linux/Dockerfile.fedora
    build_one arch       scripts/linux/Dockerfile.arch
    build_one appimage   scripts/linux/Dockerfile.appimage
    ;;
  *) echo "unknown target $1" >&2; exit 2 ;;
esac
