#!/usr/bin/env bash
set -euo pipefail

profile="${1:-debug}"
case "$profile" in
  debug) cargo build -p agentport-host -p agentport-remote-bridge -p agentport-mosh-attach ;;
  release) cargo build -p agentport-host -p agentport-remote-bridge -p agentport-mosh-attach --release ;;
  *)
    echo "usage: $0 [debug|release]" >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

target_triple="$(rustc -vV | awk '/^host: / { print $2 }')"
for binary in agentport-host agentport-remote-bridge agentport-mosh-attach; do
  source_path="$repo_root/target/$profile/$binary"
  target_path="$repo_root/src-tauri/binaries/$binary-$target_triple"
  cp "$source_path" "$target_path"
  chmod +x "$target_path"
done
