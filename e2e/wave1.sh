#!/usr/bin/env bash
# Wave-1 vertical-slice acceptance (PRD 11.a wave 1 + P0 criteria):
#   session start -> attach -> input/output -> client (GUI) death -> reconnect
#   -> no lost output (sha256) -> stop -> full process-group cleanup.
# Uses the shell adapter so it runs anywhere without agent CLIs.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/target/debug/agentport-cli"
export AGENTPORT_DATA_DIR="$(mktemp -d /tmp/agentport-e2e-w1.XXXXXX)"
export AGENTPORT_SOCKET_DIR="$AGENTPORT_DATA_DIR/sock"
FAIL=0

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

cleanup() {
  "$CLI" session list --json >/dev/null 2>&1
  for id in $("CLI" session list --all --json 2>/dev/null | python3 -c 'import sys,json;[print(s["id"]) for s in json.load(sys.stdin)]' 2>/dev/null); do
    "$CLI" session stop "$id" >/dev/null 2>&1
  done
}
trap cleanup EXIT

say "setup: project + shell session"
"$CLI" probe shell --path /bin/sh >/dev/null   # 多候选时由用户显式确认（PRD 3.1）
PROJ=$("$CLI" project add "$ROOT" --json | jget "['id']")
[ -n "$PROJ" ] && ok "project $PROJ" || bad "project add"
SES=$("$CLI" session new --project "$PROJ" --agent shell --title "wave1-slice" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
[ -n "$SES" ] && ok "session $SES" || { bad "session new"; exit 1; }

say "input -> output roundtrip"
M1="w1-marker-$RANDOM"
"$CLI" session input "$SES" --data "echo $M1\\n" >/dev/null
OUT=$("$CLI" session read "$SES" --until "$M1" --timeout 10 --json)
echo "$OUT" | grep -q "$M1" && ok "marker echoed" || { bad "no marker"; echo "$OUT" | head -5; }
echo "$OUT" | jget "['matched']" | grep -q True && ok "read matched" || bad "read not matched"

say "GUI(client) 死亡后 host 存活、输出连续"
# Produce distinctive output, then reconnect and verify nothing lost between
# the two reads: the log file is the source of truth.
M2="w1-after-death-$RANDOM"
"$CLI" session input "$SES" --data "echo $M2; sleep 0.2\\n" >/dev/null
sleep 0.5
OUT2=$("$CLI" session read "$SES" --until "$M2" --timeout 10 --tail-bytes 1048576 --json)
echo "$OUT2" | grep -q "$M2" && ok "output continues after client exit/reconnect" || bad "lost output"
echo "$OUT2" | grep -q "$M1" && ok "replay includes pre-death bytes" || bad "replay gap"

say "日志与客户端收到字节 SHA-256 一致"
# The authoritative log path lives in the Session record (run-scoped since v3):
# never reconstruct it from a hardcoded layout, which silently goes stale.
LOG=$("$CLI" session status "$SES" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"]["logPath"])')
[ -f "$LOG" ] && ok "log path resolves: $LOG" || { bad "log missing at $LOG"; exit 1; }
python3 - "$LOG" "$OUT2" <<'PY' && ok "sha256(log tail) == sha256(received tail)" || bad "sha mismatch"
import sys, json, hashlib
log = open(sys.argv[1], 'rb').read()
received = json.loads(sys.argv[2])['output'].encode()
# received is the last len(received) bytes of the log (tail replay of 1MiB)
assert log.endswith(received), "log tail != received bytes"
assert hashlib.sha256(log[-len(received):]).hexdigest() == hashlib.sha256(received).hexdigest()
PY

say "心跳/状态在线"
"$CLI" session status "$SES" --json | grep -q '"lifecycle": "running"' && ok "lifecycle=running" || bad "not running"

say "stop：完整进程组清理"
HOSTPID=$("$CLI" session status "$SES" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"]["hostPid"])')
"$CLI" session input "$SES" --data "sleep 240 & sleep 240 &\\n" >/dev/null
sleep 0.5
CHILDREN_BEFORE=$(pgrep -P "$HOSTPID" | wc -l | tr -d ' ')
"$CLI" session stop "$SES" >/dev/null
sleep 1
if kill -0 "$HOSTPID" 2>/dev/null; then bad "host still alive"; else ok "host $HOSTPID gone (had $CHILDREN_BEFORE direct children)"; fi
pgrep -f "sleep 240" >/dev/null && bad "grandchild sleep leaked" || ok "no descendant leaked"
"$CLI" session status "$SES" --json | grep -q '"lifecycle": "stopped"' && ok "lifecycle=stopped" || bad "lifecycle wrong"

say "中断与恢复标记"
SES2=$("$CLI" session new --project "$PROJ" --agent shell --title "wave1-crash" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
HOST2=$("$CLI" session status "$SES2" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"]["hostPid"])')
kill -9 "$HOST2"   # host crash / machine restart simulation
sleep 0.3
"$CLI" reconcile >/dev/null
"$CLI" session status "$SES2" --json | grep -q '"lifecycle": "interrupted"' && ok "crash -> interrupted" || bad "no interrupted state"
RE=$("$CLI" session restart "$SES2" --json)
echo "$RE" | grep -q '"resumePrecision": "unavailable"' && ok "shell resume precision=unavailable (明示降级)" || bad "precision wrong: $RE"
"$CLI" session input "$SES2" --data "echo alive\\n" >/dev/null
"$CLI" session read "$SES2" --until alive --timeout 8 --json | grep -q alive && ok "restarted session usable" || bad "restart unusable"
"$CLI" session stop "$SES2" >/dev/null 2>&1

say "result"
[ "$FAIL" = 0 ] && { echo "WAVE1 E2E: PASS  (data dir kept at $AGENTPORT_DATA_DIR)"; exit 0; } || { echo "WAVE1 E2E: FAIL"; exit 1; }
