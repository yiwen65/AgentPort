#!/usr/bin/env bash
# 验收剧本 2（机制版，shell agent；真实 CLI 版本验证见 play3）：
# 两个项目、并行 session、持续输出 2 分钟、强杀"GUI"进程、Host 存活、
# 重开 800ms 内恢复可输入、输出无缺失、离开期间摘要。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/target/debug/agentport-cli"
export AGENTPORT_DATA_DIR="$(mktemp -d /tmp/agentport-e2e-p2.XXXXXX)"
export AGENTPORT_SOCKET_DIR="$AGENTPORT_DATA_DIR/sock"
FAIL=0
say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()  { printf '  \033[32mOK\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
jqv() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

DUR="${P2_DURATION:-120}"   # 默认 2 分钟（PRD），可用 P2_DURATION 缩短
"$CLI" probe shell --path /bin/sh >/dev/null
P1=$("$CLI" project add "$ROOT" --json | jqv "['id']")
P2=$("$CLI" project add /tmp --json | jqv "['id']")
say "两项目三 session，持续输出 ${DUR}s"
S1=$("$CLI" session new --project "$P1" --agent shell --title "p2-a" --json | jqv "['id']")
S2=$("$CLI" session new --project "$P1" --agent shell --title "p2-b" --json | jqv "['id']")
S3=$("$CLI" session new --project "$P2" --agent shell --title "p2-c" --json | jqv "['id']")
for S in $S1 $S2 $S3; do
  "$CLI" session input "$S" --data "i=0; while [ \$i -lt $DUR ]; do echo tick-$S-\$i; sleep 1; i=\$((i+1)); done\\n" >/dev/null
done

say "强杀全部 GUI（agentport-cli read 进程）"
PIDS=""
for S in $S1 $S2 $S3; do
  "$CLI" session read "$S" --timeout 300 --json >/dev/null 2>&1 &
  PIDS="$PIDS $!"
done
sleep 2
for P in $PIDS; do kill -9 $P 2>/dev/null; done
sleep 1
ALIVE=0
for S in $S1 $S2 $S3; do
  H=$("$CLI" session status "$S" --json | jqv "['session']['hostPid']")
  kill -0 "$H" 2>/dev/null && ALIVE=$((ALIVE+1))
done
[ "$ALIVE" = 3 ] && ok "3 个 Host 在 GUI 强杀后存活" || bad "only $ALIVE/3 hosts alive"

say "重开：attach P95 ≤ 800ms（每 session 3 次取最大）"
WORST=0
for S in $S1 $S2 $S3; do
  for i in 1 2 3; do
    T0=$(python3 -c 'import time;print(time.time())')
    "$CLI" session input "$S" --data "true\\n" >/dev/null || bad "input failed on $S"
    T1=$(python3 -c 'import time;print(time.time())')
    MS=$(python3 -c "print(int(($T1-$T0)*1000))")
    [ "$MS" -gt "$WORST" ] && WORST=$MS
  done
done
[ "$WORST" -lt 800 ] && ok "重连+可输入 worst=${WORST}ms < 800ms" || bad "reconnect ${WORST}ms >= 800ms"

say "输出连续性（tick 序号无缺口）"
for S in $S1 $S2 $S3; do
  sleep 1
  python3 - "$AGENTPORT_DATA_DIR/sessions/$S/output.log" <<'PY' && ok "$S tick 连续" || bad "$S tick 有缺口"
import sys, re
text = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace')
nums = [int(m.group(1)) for m in re.finditer(r'tick-[A-Za-z0-9_-]+-(\d+)', text)]
assert nums, "no ticks yet"
assert nums == list(range(nums[0], nums[0]+len(nums))), f"gap in {nums[:5]}...{nums[-3:]}"
PY
done

say "离开期间摘要（timeline 非空）"
"$CLI" reconcile >/dev/null
"$CLI" timeline --json | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["entries"]' && ok "timeline 有事件" || bad "timeline empty"

for S in $S1 $S2 $S3; do "$CLI" session stop "$S" >/dev/null 2>&1; done
[ "$FAIL" = 0 ] && { echo "PLAY2: PASS"; exit 0; } || { echo "PLAY2: FAIL"; exit 1; }
