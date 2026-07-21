#!/usr/bin/env bash
# 验收剧本 4：Base Ref Worktree + 完成时"结果尚未提交" + dirty 阻止删除 +
# 清理后删除成功 + 主 checkout 不变。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/target/debug/agentport-cli"
export AGENTPORT_DATA_DIR="$(mktemp -d /tmp/agentport-e2e-p4.XXXXXX)"
export AGENTPORT_SOCKET_DIR="$AGENTPORT_DATA_DIR/sock"
FAIL=0
say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()  { printf '  \033[32mOK\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
jqv() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

GITREPO=$(mktemp -d /tmp/agentport-p4-repo.XXXXXX)
cd "$GITREPO" && git init -q -b main && git config user.email t@t && git config user.name t
echo base > app.py && git add . && git commit -qm c1
echo v2 > app.py && git commit -qam c2
cd "$ROOT"
"$CLI" probe shell --path /bin/sh >/dev/null
PROJ=$("$CLI" project add "$GITREPO" --json | jqv "['id']")

say "从 Base Ref(HEAD~1) 创建 agent/fix-login-timeout 并启动 session"
WT=$("$CLI" worktree create --project "$PROJ" --task "fix login timeout" --base-ref HEAD~1 --json | jqv "['id']")
WTP=$("$CLI" worktree list --project "$PROJ" --json | jqv "[0]['path']")
BR=$("$CLI" worktree list --project "$PROJ" --json | jqv "[0]['branch']")
[ "$BR" = "agent/fix-login-timeout" ] && ok "分支 $BR" || bad "branch $BR"
S=$("$CLI" session new --project "$PROJ" --agent shell --worktree-id "$WT" --title "p4-fix" --json | jqv "['id']")
[ -n "$S" ] && ok "session 在 worktree 启动" || { bad "session new"; exit 1; }

say "修改不提交 -> session 完成 -> 结果尚未提交 + 删除被阻止"
"$CLI" session input "$S" --data "echo changed >> app.py\\n" >/dev/null
"$CLI" session read "$S" --until "changed" --timeout 5 --json >/dev/null || true
"$CLI" session stop "$S" >/dev/null
sleep 0.5
H=$("$CLI" worktree health "$WT" --json | jqv "['health']")
[ "$H" = "dirty" ] && ok "完成后 worktree=dirty（结果尚未提交）" || bad "health $H"
"$CLI" worktree remove "$WT" >/dev/null 2>&1 && bad "dirty 删除成功（应阻止）" || ok "dirty 删除被阻止"
MAIN_BEFORE=$(shasum -a 256 "$GITREPO/app.py" | awk '{print $1}')

say "恢复文件 -> 删除成功 -> 主 checkout 不变"
cd "$WTP" && git checkout -- app.py 2>/dev/null; cd "$ROOT"
"$CLI" worktree remove "$WT" >/dev/null && ok "清理后删除成功" || bad "remove failed"
git -C "$GITREPO" worktree list --porcelain | grep -q "$WTP" && bad "worktree 仍注册" || ok "worktree list 已移除"
MAIN_AFTER=$(shasum -a 256 "$GITREPO/app.py" | awk '{print $1}')
[ "$MAIN_BEFORE" = "$MAIN_AFTER" ] && ok "主 checkout 文件 hash 不变" || bad "main checkout changed"
[ "$(cat "$GITREPO/app.py")" = "v2" ] && ok "主 checkout 内容正确" || bad "main content wrong"

[ "$FAIL" = 0 ] && { echo "PLAY4: PASS"; exit 0; } || { echo "PLAY4: FAIL"; exit 1; }
