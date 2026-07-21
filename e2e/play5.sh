#!/usr/bin/env bash
# 验收剧本 5（macOS 侧）：测试 Secret 写入 Keychain -> 预检启动 -> Agent 可读 ->
# 全目录字节扫描（前端/SQLite/进程参数/日志/索引/诊断 zip 无原值）->
# 停止含三个子进程的 session（5s 内全部消失）-> 日志轮转由 perf harness 复核。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/target/debug/agentport-cli"
export AGENTPORT_DATA_DIR="$(mktemp -d /tmp/agentport-e2e-p5.XXXXXX)"
export AGENTPORT_SOCKET_DIR="$AGENTPORT_DATA_DIR/sock"
FAIL=0
say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()  { printf '  \033[32mOK\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
jqv() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

VAL="p5-secret-$RANDOM-value"
SECID=""
SES=""
cleanup() {
  [ -n "$SES" ] && "$CLI" session stop "$SES" >/dev/null 2>&1
  [ -n "$SECID" ] && "$CLI" secret delete "$SECID" >/dev/null 2>&1
}
trap cleanup EXIT

"$CLI" probe shell --path "$(command -v sh)" >/dev/null
PROJ=$("$CLI" project add "$ROOT" --json | jqv "['id']")

say "secret 入库 + 预检启动"
SECID=$(printf '%s' "$VAL" | "$CLI" secret add --preset pre_shell_safe --env P5_TOKEN --json | jqv "['id']")
[ -n "$SECID" ] && ok "Keychain 写入成功" || { bad "secret add"; exit 1; }
SES=$("$CLI" session new --project "$PROJ" --agent shell --preset pre_shell_safe --title "p5-secret" --json | jqv "['id']")
"$CLI" session input "$SES" --data 'X=don; echo "child=$P5_TOKEN"; echo ${X}e5\n' >/dev/null
OUT=$("$CLI" session read "$SES" --until "done5" --timeout 10 --json)
echo "$OUT" | grep -q 'child=\[redacted\]' && ok "Agent 环境变量已注入且输出脱敏" || { bad "injection/redaction"; echo "$OUT" | head -3; }

say "全目录字节扫描（SQLite/日志/host.json/导出包）"
HITS=0
grep -ra "$VAL" "$AGENTPORT_DATA_DIR" >/dev/null 2>&1 && HITS=1
[ "$HITS" = 0 ] && ok "数据目录无原值（db/日志/host.json）" || bad "数据目录泄漏"
HOSTPID_NOW=$("$CLI" session status "$SES" --json | jqv "['session']['hostPid']")
ps -o command -p "$HOSTPID_NOW" | grep -q "$VAL" && bad "进程参数(argv)含原值" || ok "进程参数无原值（按 PRD 3.7 仅经环境变量注入）"
"$CLI" export zip --session "$SES" --out "$AGENTPORT_DATA_DIR/p5.zip" --json >/dev/null
python3 - "$AGENTPORT_DATA_DIR/p5.zip" "$VAL" <<'PY' && ok "诊断 zip 无原值" || bad "zip 泄漏"
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert sys.argv[2].encode() not in b"".join(z.read(n) for n in z.namelist())
PY
"$CLI" search "P5_TOKEN" --json >/dev/null && grep -ra "$VAL" "$AGENTPORT_DATA_DIR/agentport.db" >/dev/null 2>&1 && bad "索引含原值" || ok "搜索索引无原值"

say "停止含三个子进程的 session：agent 树 5s 内消失，host 10s 内退出"
"$CLI" session input "$SES" --data "sleep 300 & sleep 300 &\\n" >/dev/null
sleep 0.5
HOSTPID=$("$CLI" session status "$SES" --json | jqv "['session']['hostPid']")
AGENTPID=$(pgrep -P "$HOSTPID" | head -1)
SLEEPS_BEFORE=$(ps -axo pid=,ppid= | awk -v p="$AGENTPID" '$2==p {print $1}' | wc -l | tr -d ' ')
T0=$(python3 -c 'import time;print(time.time())')
"$CLI" session stop "$SES" >/dev/null
T1=$(python3 -c 'import time;print(time.time())')
# agent 树（shell+后台 sleep）必须 ≤5s 消失
TREE_GONE=1
for P in $AGENTPID $(ps -axo pid=,ppid= | awk -v p="$AGENTPID" '$2==p {print $1}'); do
  kill -0 "$P" 2>/dev/null && TREE_GONE=0
done
EL=$(python3 -c "print(f'{$T1-$T0:.1f}')")
[ "$TREE_GONE" = 1 ] && ok "agent 树（shell+${SLEEPS_BEFORE} 个后台子进程）${EL}s 内消失" || bad "agent 进程残留"
# host 进程自身 10s 内退出
HOST_GONE=0
for i in $(seq 1 20); do kill -0 "$HOSTPID" 2>/dev/null || { HOST_GONE=1; break; }; sleep 0.5; done
[ "$HOST_GONE" = 1 ] && ok "host 进程已退出" || bad "host 未退出"

say "result"
[ "$FAIL" = 0 ] && { echo "PLAY5: PASS"; exit 0; } || { echo "PLAY5: FAIL"; exit 1; }
