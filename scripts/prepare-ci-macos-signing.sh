#!/usr/bin/env bash
# Import explicitly: Tauri's APPLE_CERTIFICATE resolver only recognizes Apple
# certificate name prefixes, not our stable self-signed release certificate.
set -euo pipefail
: "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}" "${INPUT_CERTIFICATE:?}"
: "${INPUT_CERTIFICATE_PASSWORD:?}" "${INPUT_SIGNING_IDENTITY:?}"
keychain="$RUNNER_TEMP/agentport-release.keychain-db"
p12="$RUNNER_TEMP/agentport-release.p12"
probe="$RUNNER_TEMP/agentport-signing-probe"
trap 'rm -f "$p12" "$probe"' EXIT
password="$(openssl rand -hex 32)"
echo "::add-mask::$password"
printf '%s' "$INPUT_CERTIFICATE" | base64 --decode > "$p12"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$p12" -k "$keychain" -P "$INPUT_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security > /dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "$password" "$keychain" > /dev/null
# Preserve the runner's other keychains (including Apple trust certificates).
python3 - "$keychain" <<'PY'
import subprocess, sys, shlex
existing = shlex.split(subprocess.check_output(
    ['security', 'list-keychains', '-d', 'user'], text=True))
subprocess.run(['security', 'list-keychains', '-d', 'user', '-s',
                *existing, sys.argv[1]], check=True)
PY
# Fail before compilation if the certificate/private key cannot actually sign.
cp /usr/bin/true "$probe"
codesign --force --sign "$INPUT_SIGNING_IDENTITY" --keychain "$keychain" "$probe"
codesign --verify --strict "$probe"
printf 'APPLE_SIGNING_IDENTITY=%s\n' "$INPUT_SIGNING_IDENTITY" >> "$GITHUB_ENV"
# Do NOT export APPLE_CERTIFICATE: that would re-enter Tauri's Apple-only resolver.
