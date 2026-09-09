#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
profile="${1:-debug}"
target_triple="$(rustc -vV | awk '/^host: / { print $2 }')"
source_directory="$repo_root/target/$profile"
case "$profile" in
  debug)
    # Isolate Cargo-owned artifacts from tauri-build's externalBin copies into
    # target/debug. A previously overwritten top-level binary can look Fresh
    # to Cargo; an explicit host target avoids reusing that contaminated output.
    cargo build -p agentport-host -p agentport-remote-bridge -p agentport-mosh-attach -p agentport-relay --features agentport-relay/connector --target "$target_triple"
    source_directory="$repo_root/target/$target_triple/debug"
    ;;
  release) cargo build -p agentport-host -p agentport-remote-bridge -p agentport-mosh-attach -p agentport-relay --features agentport-relay/connector --release ;;
  *)
    echo "usage: $0 [debug|release]" >&2
    exit 2
    ;;
esac

for binary in agentport-host agentport-remote-bridge agentport-mosh-attach agentport-connector; do
  source_path="$source_directory/$binary"
  target_path="$repo_root/src-tauri/binaries/$binary-$target_triple"
  cp "$source_path" "$target_path"
  chmod +x "$target_path"
done
