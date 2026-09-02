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
apt-get install -y -qq "$DEB" xvfb xauth python3 >/dev/null
GUI=$(command -v agentport)
HOST=$(dpkg -L agent-port | awk '/\/agentport-host$/ { print; exit }')
if [ -z "$HOST" ] || [ ! -f "$HOST" ] || [ ! -x "$HOST" ]; then
  echo "Host sidecar embedded and executable: FAIL" >&2
  exit 1
fi
echo "Host sidecar embedded and executable: OK"
BRIDGE=$(dpkg -L agent-port | awk '/\/agentport-remote-bridge$/ { print; exit }')
if [ -z "$BRIDGE" ] || [ ! -x "$BRIDGE" ]; then
  echo "Remote Bridge sidecar embedded: FAIL" >&2
  exit 1
fi
echo "Remote Bridge sidecar embedded: OK"
MOSH_ATTACH=$(dpkg -L agent-port | awk '/\/agentport-mosh-attach$/ { print; exit }')
if [ -z "$MOSH_ATTACH" ] || [ ! -x "$MOSH_ATTACH" ]; then
  echo "Mosh attach sidecar embedded: FAIL" >&2
  exit 1
fi
echo "Mosh attach sidecar embedded: OK"
CLI=/artifacts/agentport-cli
chmod +x /artifacts/agentport-cli /artifacts/agentport-host /artifacts/agentport-remote-bridge /artifacts/agentport-mosh-attach 2>/dev/null || true

echo "== installed Remote Bridge harness self-tests =="
python3 "$(dirname "$0")/../verify-installed-remote-bridge.py" --self-test

echo "== installed Remote Bridge GUI-off smoke =="
python3 "$(dirname "$0")/../verify-installed-remote-bridge.py" \
  --bridge "$BRIDGE" \
  --gui "$GUI" \
  --host "$HOST"

echo "== headless functional E2E (agentport-cli on real Linux) =="
PROBE_JSON=$($CLI probe shell --path /bin/bash --json)
grep -q '"state": "available"' <<<"$PROBE_JSON"
echo "probe: OK"
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
