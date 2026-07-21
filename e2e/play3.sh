#!/usr/bin/env bash
# 验收剧本 3: 三个官方 Agent 的真实启动、原生 Session ID 捕获、停止后"重启并恢复"、
# 恢复精度展示、已关闭 session 关键词搜索。
# 每个 Agent 只发一个极小 prompt（每个 ≤1 次真实 API 调用）。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/target/debug/agentport-cli"
export AGENTPORT_DATA_DIR="$(mktemp -d /tmp/agentport-e2e-p3.XXXXXX)"
export AGENTPORT_SOCKET_DIR="$AGENTPORT_DATA_DIR/sock"
FAIL=0
say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()  { printf '  \033[32mOK\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
jqv() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

PROJ=$("$CLI" project add "$ROOT" --json | jqv "['id']")
RESULTS=()

agent_flow() {
  local AGENT="$1"
  say "${AGENT}：探测 -> 启动 -> 真实 prompt -> session id -> 停止 -> 恢复"
  # 多候选时显式选择登录 shell 解析到的那个（PRD 3.1：用户确认唯一路径）。
  local EXE
  EXE=$(command -v "$AGENT" || true)
  if [ -n "$EXE" ]; then "$CLI" probe "$AGENT" --path "$EXE" --json >/dev/null; else "$CLI" probe "$AGENT" --json >/dev/null; fi
  local S
  S=$("$CLI" session new --project "$PROJ" --agent "$AGENT" --title "p3-$AGENT" --json | jqv "['id']")
  [ -n "$S" ] && ok "session created $S" || { bad "session new $AGENT"; return; }
  # Wait for the TUI to come up, then type a tiny prompt.
  sleep 6
  "$CLI" session input "$S" --data "Reply with exactly: PONG42\\n" >/dev/null
  "$CLI" session read "$S" --until "PONG42" --timeout 90 --json >/dev/null || true
  local ST
  ST=$("$CLI" session status "$S" --json)
  local ASID PREC
  ASID=$(echo "$ST" | jqv "['session']['agentSessionId']")
  PREC=$(echo "$ST" | jqv "['session']['resumePrecision']")
  echo "  agentSessionId=$ASID resumePrecision=$PREC"
  # Stop the host, then restart-and-resume.
  "$CLI" session stop "$S" >/dev/null
  sleep 0.5
  local RE
  RE=$("$CLI" session restart "$S" --json 2>&1)
  echo "$RE" | grep -q "error" && { bad "restart failed: $RE"; return; }
  local RE_PREC RE_CMD
  RE_PREC=$(echo "$RE" | jqv "['resumePrecision']")
  RE_CMD=$(echo "$RE" | jqv "['command']")
  echo "  resume cmd: $RE_CMD"
  case "$PREC" in
    exact)
      [ "$RE_PREC" = "exact" ] && ok "$AGENT 精确恢复（同一原生 ID）" || bad "$AGENT precision lost: $RE_PREC"
      echo "$RE_CMD" | grep -q "$ASID" && ok "$AGENT 恢复命令包含同一 session id" || bad "$AGENT resume id mismatch: $RE_CMD"
      ;;
    latest)
      [ "$RE_PREC" = "latest" ] && ok "$AGENT 降级恢复已明示（latest）" || bad "$AGENT precision wrong: $RE_PREC"
      echo "$RE" | grep -qi "最近" && ok "$AGENT 恢复说明含风险提示" || bad "$AGENT missing risk note"
      ;;
    unavailable)
      [ "$RE_PREC" = "unavailable" ] && ok "$AGENT 恢复不可用已明示" || bad "$AGENT precision wrong: $RE_PREC"
      ;;
  esac
  "$CLI" session stop "$S" >/dev/null 2>&1
  sleep 0.3
  RESULTS+=("$AGENT:$PREC:$ASID")
}

for A in claude codex kimi; do
  agent_flow "$A"
done

say "搜索：已关闭 session 的关键词"
KW="p3kw$RANDOM"
"$CLI" probe shell --path "$(command -v sh)" >/dev/null
S=$("$CLI" session new --project "$PROJ" --agent shell --title "p3-search" --json | jqv "['id']")
[ -n "$S" ] && ok "search session $S" || { bad "search session new"; S=""; }
if [ -n "$S" ]; then
"$CLI" session input "$S" --data "echo $KW\\n" >/dev/null
"$CLI" session read "$S" --until "$KW" --timeout 8 --json >/dev/null
"$CLI" session stop "$S" >/dev/null
sleep 0.3
T0=$(python3 -c 'import time;print(time.time())')
HIT=$("$CLI" search "$KW" --json)
T1=$(python3 -c 'import time;print(time.time())')
echo "$HIT" | grep -q "$S" && ok "搜索命中已关闭 session（$(python3 -c "print(f'{($T1-$T0)*1000:.0f}ms')")）" || bad "search miss"
fi

say "恢复矩阵汇总"
for r in "${RESULTS[@]}"; do echo "  $r"; done
[ "$FAIL" = 0 ] && { echo "PLAY3: PASS"; exit 0; } || { echo "PLAY3: FAIL"; exit 1; }
