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

say "worktree：Base Ref 创建 + dirty 健康度 + 删除"
WT=$("$CLI" worktree create --project "$PROJ" --task "fix-login timeout" --base-ref HEAD~1 --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
WTPATH=$("$CLI" worktree list --project "$PROJ" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["path"])')
WTHEAD=$(git -C "$WTPATH" rev-parse HEAD)
MAINHEAD=$(git -C "$GITREPO" rev-parse HEAD)
[ "$WTHEAD" = "$(git -C "$GITREPO" rev-parse HEAD~1)" ] && ok "worktree 落在 HEAD~1（Base Ref 生效）" || bad "base ref wrong: $WTHEAD"
[ "$WTHEAD" != "$MAINHEAD" ] && ok "主 checkout 未移动" || bad "main checkout moved"
echo dirty > "$WTPATH/dirty.txt"
# CLI 的 remove 是已确认的破坏性操作：脏工作区是清理输入而不是阻断条件
# （确认流程在 GUI 的 delete preflight 里）。这里验证 dirty 能被删掉、
# Git 注册被清掉、主 checkout 不受影响。
"$CLI" worktree health "$WT" --json | grep -q '"health": "dirty"' && ok "health=dirty" || bad "health wrong"
"$CLI" worktree remove "$WT" >/dev/null && ok "dirty worktree 删除成功（CLI 无需二次确认）" || bad "remove failed"
git -C "$GITREPO" worktree list --porcelain | grep -q "$WTPATH" && bad "worktree 仍注册" || ok "git worktree list 已消失"
[ "$(cat "$GITREPO/a.txt")" = "v2" ] && ok "主 checkout 内容不变" || bad "main checkout changed"

say "export：raw 日志导出已移除；正文导出走 Agent 原生日志"
SES1=$("$CLI" session new --project "$PROJ" --agent shell --title "w2-export" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
M="w2-export-$RANDOM"
"$CLI" session input "$SES1" --data "echo $M; echo done-$M\\n" >/dev/null
"$CLI" session read "$SES1" --until "done-$M" --timeout 10 --json >/dev/null
# 已移除的能力必须明确报错，不能静默成功。
ERR=$("$CLI" export log --session "$SES1" --out "$AGENTPORT_DATA_DIR/e.log" 2>&1)
echo "$ERR" | grep -q 'raw terminal log export was removed' && ok "export log 明确报错（能力已移除）" || bad "export log: $ERR"
# shell 适配器没有原生历史，md/json 导出必须说明原因而不是产出空文件。
ERR=$("$CLI" export md --session "$SES1" --out "$AGENTPORT_DATA_DIR/e.md" 2>&1)
echo "$ERR" | grep -q 'native history is unavailable' && ok "md 导出说明缺少原生历史" || bad "export md: $ERR"
# 正文导出/搜索的内容级覆盖在 core 的原生历史集成测试里（带 fixture），
# e2e 只负责进程级契约。

say "诊断 ZIP：结构、manifest、脱敏"
"$CLI" export zip --session "$SES1" --out "$AGENTPORT_DATA_DIR/diag.zip" --json >/dev/null
python3 - "$AGENTPORT_DATA_DIR/diag.zip" "$SES1" <<'PY' && ok "zip 结构与 manifest 正确" || bad "zip invalid"
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1]); names = z.namelist(); ses = sys.argv[2]
m = json.loads(z.read("manifest.json"))
assert m["formatVersion"] == 1 and ses in m["sessions"], "manifest"
# 诊断包不含终端正文（没有 PTY 副本可打包），但必须带状态日志与能力清单。
assert not any(n.endswith("-terminal.log") for n in names), "terminal log must not be packaged"
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
LOG2="$AGENTPORT_DATA_DIR/sessions/$SES2/status-events.jsonl"
grep -a "$SECRET_VAL" "$LOG2" >/dev/null 2>&1 && bad "状态日志含 secret" || ok "状态日志无明文 secret"
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

say "search：元数据命中；正文检索走原生日志"
KW="w2kw$RANDOM"
"$CLI" session input "$SES1" --data "echo $KW\\n" >/dev/null
"$CLI" session read "$SES1" --until "$KW" --timeout 8 --json >/dev/null
"$CLI" session stop "$SES1" >/dev/null
sleep 0.3
# CLI 的 search 只按需扫描 Agent 原生日志（docs/user-guide.md）；GUI 的
# 元数据+正文混合检索由 core 的 search 单测覆盖（query_hits_metadata_and_terminal）。
RES=$("$CLI" search "$KW" --json)
echo "$RES" | grep -q "$SES1" && bad "shell 会话不应有正文命中" || ok "无 PTY 正文索引（正文检索改走原生日志）"
echo "$RES" | grep -q '"partial": true' && bad "shell 会话查询不应是 partial" || ok "查询结果完整（无降级）"

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
