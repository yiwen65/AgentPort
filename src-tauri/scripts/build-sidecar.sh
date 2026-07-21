#!/usr/bin/env bash
set -euo pipefail

profile="${1:-debug}"
case "$profile" in
  debug) cargo build -p agentport-host ;;
  release) cargo build -p agentport-host --release ;;
  *)
    echo "usage: $0 [debug|release]" >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

target_triple="$(rustc -vV | awk '/^host: / { print $2 }')"
source_path="$repo_root/target/$profile/agentport-host"
target_path="$repo_root/src-tauri/binaries/agentport-host-$target_triple"

cp "$source_path" "$target_path"
chmod +x "$target_path"
