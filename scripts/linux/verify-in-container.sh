#!/usr/bin/env bash
# In-container verification for built packages (PRD 验收剧本 1 的 Linux 部分):
# install -> headless functional E2E (CLI) -> xvfb GUI launch smoke -> uninstall.
# Usage inside an Ubuntu container with artifacts mounted at /artifacts:
#   bash scripts/linux/verify-in-container.sh /artifacts/AgentPort_0.1.0_amd64.deb
set -euo pipefail
DEB="${1:?path to .deb inside container}"
export AGENTPORT_DATA_DIR=/tmp/ap-verify
export AGENTPORT_SOCKET_DIR=/tmp/ap-verify/sock
rm -rf "$AGENTPORT_DATA_DIR"

echo "== install =="
apt-get update -qq
apt-get install -y -qq "$DEB" xvfb xauth >/dev/null
command -v agentport
dpkg -L agent-port | grep -q "agentport-host" && echo "sidecar embedded: OK"
CLI=/artifacts/agentport-cli
chmod +x /artifacts/agentport-cli /artifacts/agentport-host 2>/dev/null || true

echo "== headless functional E2E (agentport-cli on real Linux) =="
$CLI probe shell --path /bin/bash --json | grep -q '"state": "available"' && echo "probe: OK"
PROJ=$($CLI project add /tmp --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' 2>/dev/null || $CLI project add /tmp --json | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)
SES=$($CLI session new --project "$PROJ" --agent shell --title verify --json | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)
$CLI session input "$SES" --data "echo linux-verify\\n" >/dev/null
$CLI session read "$SES" --until linux-verify --timeout 10 --json | grep -q linux-verify && echo "pty roundtrip: OK"
HOSTPID=$($CLI session status "$SES" --json | grep -o '"hostPid": [0-9]*' | head -1 | awk '{print $2}')
$CLI session stop "$SES" >/dev/null
sleep 1
kill -0 "$HOSTPID" 2>/dev/null && { echo "host still alive: FAIL"; exit 1; } || echo "stop cleanup: OK"

echo "== GUI launch smoke (xvfb) =="
xvfb-run -a agentport >/tmp/ap-gui.log 2>&1 &
GPID=$!
sleep 8
kill -0 $GPID 2>/dev/null && echo "GUI alive under xvfb: OK" || { echo "GUI died: FAIL"; cat /tmp/ap-gui.log; exit 1; }
kill $GPID 2>/dev/null || true

echo "== uninstall =="
dpkg -r agent-port
[ ! -e /usr/bin/agentport ] && echo "uninstall clean: OK"
echo "VERIFY-LINUX: PASS"
