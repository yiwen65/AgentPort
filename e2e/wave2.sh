#!/usr/bin/env bash
# Wave-2 E2E (PRD 第九章 P1): exports, diagnostics zip, search, timeline,
# secret lifecycle (Keychain + redaction), worktree base-ref + dirty-block.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/target/debug/agentport-cli"
export AGENTPORT_DATA_DIR="$(mktemp -d /tmp/agentport-e2e-w2.XXXXXX)"
export AGENTPORT_SOCKET_DIR="$AGENTPORT_DATA_DIR/sock"
FAIL=0
say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()  { printf '  \033[32mOK\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
session_log_path() {
  "$CLI" session status "$1" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"]["logPath"])'
}

GITREPO=$(mktemp -d /tmp/agentport-e2e-repo.XXXXXX)
cd "$GITREPO" && git init -q -b main && git config user.email t@t && git config user.name t
echo v1 > a.txt && git add . && git commit -qm c1
echo v2 > a.txt && git commit -qam c2
cd "$ROOT"

cleanup() {
  for id in "${SES1:-}" "${SES2:-}" "${SES3:-}"; do [ -n "${id:-}" ] && "$CLI" session stop "$id" >/dev/null 2>&1; done
  [ -n "${SECID:-}" ] && "$CLI" secret delete "$SECID" >/dev/null 2>&1
}
trap cleanup EXIT

"$CLI" probe shell --path /bin/sh >/dev/null
PROJ=$("$CLI" project add "$GITREPO" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

say "worktree：Base Ref 创建 + dirty 阻止删除"
WT=$("$CLI" worktree create --project "$PROJ" --task "fix-login timeout" --base-ref HEAD~1 --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
WTPATH=$("$CLI" worktree list --project "$PROJ" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["path"])')
WTHEAD=$(git -C "$WTPATH" rev-parse HEAD)
MAINHEAD=$(git -C "$GITREPO" rev-parse HEAD)
[ "$WTHEAD" = "$(git -C "$GITREPO" rev-parse HEAD~1)" ] && ok "worktree 落在 HEAD~1（Base Ref 生效）" || bad "base ref wrong: $WTHEAD"
[ "$WTHEAD" != "$MAINHEAD" ] && ok "主 checkout 未移动" || bad "main checkout moved"
echo dirty > "$WTPATH/dirty.txt"
"$CLI" worktree remove "$WT" >/dev/null 2>&1 && bad "dirty worktree 被删除（应阻止）" || ok "dirty 删除被阻止"
"$CLI" worktree health "$WT" --json | grep -q '"health": "dirty"' && ok "health=dirty" || bad "health wrong"
rm "$WTPATH/dirty.txt"
"$CLI" worktree remove "$WT" >/dev/null && ok "清理后删除成功" || bad "clean remove failed"
git -C "$GITREPO" worktree list --porcelain | grep -q "$WTPATH" && bad "worktree 仍注册" || ok "git worktree list 已消失"
[ "$(cat "$GITREPO/a.txt")" = "v2" ] && ok "主 checkout 内容不变" || bad "main checkout changed"

say "session + export（log/md 与源一致）"
SES1=$("$CLI" session new --project "$PROJ" --agent shell --title "w2-export" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
M="w2-export-$RANDOM"
"$CLI" session input "$SES1" --data "echo $M; echo done-$M\\n" >/dev/null
"$CLI" session read "$SES1" --until "done-$M" --timeout 10 --json >/dev/null
"$CLI" export log --session "$SES1" --out "$AGENTPORT_DATA_DIR/e.log" --json >/dev/null
grep -q "$M" "$AGENTPORT_DATA_DIR/e.log" && ok "export log 含输出" || bad "export log missing"
LOG1=$(session_log_path "$SES1")
python3 - "$LOG1" "$AGENTPORT_DATA_DIR/e.log" <<'PY' && ok "export log 与源 sha256 一致" || bad "export sha mismatch"
import sys, hashlib
a = open(sys.argv[1],'rb').read(); b = open(sys.argv[2],'rb').read()
assert hashlib.sha256(a).hexdigest() == hashlib.sha256(b).hexdigest(), "sha mismatch"
PY
"$CLI" export md --session "$SES1" --out "$AGENTPORT_DATA_DIR/e.md" --json >/dev/null
grep -q "w2-export" "$AGENTPORT_DATA_DIR/e.md" && grep -q '```' "$AGENTPORT_DATA_DIR/e.md" && ok "markdown 导出含头部与代码块" || bad "md export wrong"

say "诊断 ZIP：结构、manifest、脱敏"
"$CLI" export zip --session "$SES1" --out "$AGENTPORT_DATA_DIR/diag.zip" --json >/dev/null
python3 - "$AGENTPORT_DATA_DIR/diag.zip" "$SES1" <<'PY' && ok "zip 结构与 manifest 正确" || bad "zip invalid"
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1]); names = z.namelist(); ses = sys.argv[2]
m = json.loads(z.read("manifest.json"))
assert m["formatVersion"] == 1 and ses in m["sessions"], "manifest"
assert any(n.endswith("-terminal.log") for n in names), "terminal log"
assert any(n.endswith("-status-events.json") for n in names), "status events"
assert any("adapter-capabilities" in n for n in names), "capabilities"
assert "token" not in json.dumps(m).lower() or "hostToken" not in json.dumps(m)
PY

say "secret 生命周期（Keychain + 注入 + 脱敏审计）"
SECRET_VAL="ap-e2e-$RANDOM-secret"
SECID=$(printf '%s' "$SECRET_VAL" | "$CLI" secret add --preset pre_shell_safe --env AP_E2E_SECRET --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
[ -n "$SECID" ] && ok "secret 已存入 Keychain（ref=${SECID}）" || bad "secret add failed"
"$CLI" secret list --json | grep -q "$SECRET_VAL" && bad "secret list 泄漏原值" || ok "secret list 仅元数据"
security find-generic-password -s agentport -a "pre_shell_safe:AP_E2E_SECRET" >/dev/null 2>&1 && ok "Keychain 条目存在" || bad "keychain entry missing"
SES2=$("$CLI" session new --project "$PROJ" --agent shell --preset pre_shell_safe --title "w2-secret" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
"$CLI" session input "$SES2" --data 'X=sec; echo "val=$AP_E2E_SECRET"; echo ${X}-done\n' >/dev/null
OUT=$("$CLI" session read "$SES2" --until "sec-done" --timeout 10 --json)
echo "$OUT" | grep -q "$SECRET_VAL" && bad "前端输出含 secret 原值" || ok "输出已脱敏（客户端只见 [redacted]）"
LOG2=$(session_log_path "$SES2")
grep -q "$SECRET_VAL" "$LOG2" && bad "日志含 secret" || ok "日志无明文 secret"
grep -q "\[redacted\]" "$LOG2" && ok "日志含固定掩码" || bad "掩码缺失"
grep -a "$SECRET_VAL" "$AGENTPORT_DATA_DIR/agentport.db" >/dev/null 2>&1 && bad "SQLite 含 secret" || ok "SQLite 无 secret"
grep -a "$SECRET_VAL" "$AGENTPORT_DATA_DIR/sessions/$SES2/host.json" >/dev/null 2>&1 && bad "host.json 含 secret" || ok "host.json 仅含变量名"
"$CLI" export zip --session "$SES2" --out "$AGENTPORT_DATA_DIR/diag2.zip" --json >/dev/null
python3 - "$AGENTPORT_DATA_DIR/diag2.zip" "$SECRET_VAL" <<'PY' && ok "诊断 zip 无 secret 字节" || bad "zip leaks secret"
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
blob = b"".join(z.read(n) for n in z.namelist())
assert sys.argv[2].encode() not in blob, "secret leaked into zip"
PY
"$CLI" diag hosts --json >/dev/null && ok "diag hosts 可用"

say "search：已关闭 session 的关键词可检索"
KW="w2kw$RANDOM"
"$CLI" session input "$SES1" --data "echo $KW\\n" >/dev/null
"$CLI" session read "$SES1" --until "$KW" --timeout 8 --json >/dev/null
"$CLI" session stop "$SES1" >/dev/null
sleep 0.3
RES=$("$CLI" search "$KW" --json)
echo "$RES" | grep -q "$SES1" && ok "terminal 全文命中已停止 session" || { bad "search miss"; echo "$RES" | head -5; }
"$CLI" search "w2-secret" --json | grep -q "w2-secret" && ok "metadata 命中 session 标题" || bad "metadata search miss"

say "timeline：离开期间事件与已读"
"$CLI" session stop "$SES2" >/dev/null
sleep 0.5
"$CLI" reconcile >/dev/null   # 导入 host 侧 status-events.jsonl（GUI 关闭期间的事件）
TL=$("$CLI" timeline --json)
echo "$TL" | grep -q "$SES2" && ok "timeline 含关闭期间事件" || { bad "timeline empty"; echo "$TL" | head -5; }
"$CLI" timeline --ack >/dev/null
TL2=$("$CLI" timeline --json)
[ "$(echo "$TL2" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["entries"]))')" = "0" ] && ok "ack 后 timeline 清空" || bad "timeline ack failed"

say "系统通知（真实 osascript，macOS）"
"$CLI" diag notify-test >/dev/null 2>&1 && ok "通知发送成功" || bad "notify failed"

say "result"
[ "$FAIL" = 0 ] && { echo "WAVE2 E2E: PASS  (data dir kept at $AGENTPORT_DATA_DIR)"; exit 0; } || { echo "WAVE2 E2E: FAIL"; exit 1; }
