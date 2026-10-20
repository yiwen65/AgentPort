# Task Plan: Git Center 代码审查问题修复

- Created: 2026-10-20
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Base commit: 09aabbb (fix: adapt remote branch mutation results before rendering)
- Overall status: done
- Source: 2026-10-20 Git Center 全量代码审查（core / Tauri / React），19 项证据成立的问题

<!-- task-doc-section:background-goal -->
## Background and goal

Git Center 覆盖 Rust core（`crates/agentport-core/src/git/*`）、Tauri 命令层与 React 前端。审查确认了 19 项可复现或有明确代码路径的问题，覆盖数据安全（错误的目标 ref、glob 误删、删除预检误报）、正确性（rename/i-t-a/pull autostash/冲突批量 stage）、恢复死锁、超时与性能（ignored 树全量哈希、O(N×M) 碰撞检测）。目标是逐项修复并补齐回归测试，现有测试全绿。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**范围内（按严重度）：**

| ID | 问题 | 主要文件 | 严重度 |
| --- | --- | --- | --- |
| T-001 | Push/ForcePush 目标 ref 取自 `branch.<name>.merge`，功能分支会写入远端 main | `git/sync.rs`、`src/src/gitCenter.ts`、locales | High |
| T-002 | `discard_paths` 缺少 `--literal-pathspecs`，glob 误删未选中文件 | `git/file_actions.rs` | High |
| T-003 | Worktree 删除预检在 status 失败时按"干净"处理 | `git/mod.rs`、`src/src/{types,actions}.ts`、worktree-extra locales | High |
| T-004 | 脏切换对 ignored 树做多次全文哈希（本仓库 138 GiB / 406k 文件） | `git/branch.rs` | High |
| T-005 | `pull --autostash` 冲突退出码 0，界面报成功 | `git/sync.rs` | Medium |
| T-006 | "Stage all" 把冲突文件标记为已解决 | `src/src/gitCenter.ts`、`GitChangesPanel.tsx` | Medium |
| T-007 | rename + 工作区修改的文件无法 stage（旧路径进入 pathspec） | `git/commit.rs` | Medium |
| T-008 | intent-to-add 条目使 expected tree 失真，正确提交被判 `ScopeDrift` | `git/commit.rs` | Medium |
| T-009 | 自动 stash 恢复因新增 ignored 文件 / stash 被手动 pop 永久卡死 | `git/branch.rs` | Medium |
| T-010 | `changesPhase:"refreshing"` 在请求被丢弃后永久锁死 | `src/src/gitCenter.ts` | Medium |
| T-011 | Worktree 删除在 fallback 目录删除前 `prune`，留下幽灵注册 | `git/mod.rs` | Medium |
| T-012 | `GitRunner` 正常退出后无上限等待读取线程 | `git/command.rs` | Medium |
| T-013 | `ensure_no_ignored_collision` O(树×ignored)，每次切分支执行 | `git/branch.rs` | Medium |
| T-014 | AI 提交信息包含 project 目录之外 staged 内容 | `git/commit_ai.rs` | Medium |
| T-015 | 设备切换后 Git Center 未重置 | `src/src/deviceSwitch.ts`、`gitCenter.ts` | Medium |
| T-016 | AI 提交 diff 未加 `--no-textconv` | `git/commit_ai.rs` | Low |
| T-017 | 提交成功却因收尾快照读取失败返回错误 | `git/commit.rs` | Low |
| T-018 | `branch.rs` 不检查 8 MiB stdout 截断 | `git/branch.rs` | Low |
| T-019 | 远端模式 Pull/Push 后 History 不刷新 | `src/src/gitCenter.ts` | Low |

**排除：** 不改产品交互模型（除 T-006 的安全过滤与 T-001 的目的地文案）；不引入新依赖；不做无关重构/格式化。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | 事实 | 证据 |
| --- | --- | --- |
| F-001 | `git checkout -b feature origin/main` 写入 `branch.feature.merge=refs/heads/main`；`git push origin HEAD:refs/heads/main` 会快进 main | 2026-10-20 `/tmp/rev-track` 实测（`986a39a..5d03101 HEAD -> main`） |
| F-002 | `git restore --worktree --pathspec-from-file=-` 仍按 glob 解释；`a*b.txt` 会重置 `axb.txt` | `/tmp/rev-glob` 实测，加 `--literal-pathspecs` 后只重置目标 |
| F-003 | `read_dirty_summary` 在 `!complete` 时返回 `Blocked`；`deletion_preflight` 用 `unwrap_or_default()` 吞掉 | `git/mod.rs:736-737`、`git/status.rs:690-695` |
| F-004 | `capture_snapshot(.., true)` 对每个 ignored 文件全文读；本仓库 406,677 文件 / 138 GiB allocated | `git/branch.rs:2487-2550,3589-3612` + `ls-files`+stat 实测 |
| F-005 | `pull --autostash` 重新应用冲突时 git 退出 0 且保留 autostash、留下 `UU` | `/tmp/rev-autostash` 实测 |
| F-006 | `git ls-files --stage` 对 `add -N` 输出空 blob OID（非全零）；`write-tree`/commit 跳过该条目 | `/tmp/rev-ita2` 实测 |
| F-007 | `2 RM` 条目携带 old path；`git add -A a.txt b.txt` 报 `pathspec 'a.txt' did not match any files` | `/tmp/rev-rename` 实测 |
| F-008 | porcelain v2 将 i-t-a 呈现为 `1 .A`（index 未改、worktree A、非 untracked） | `/tmp/rev-ita2` 实测 |
| F-009 | `worktree prune` 在目录仍存在时为 no-op；删除目录后注册残留会阻断 `git switch` / `worktree add` | `/tmp/wtx` 实测（审查子任务） |

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 每个 T-xxx 都有对应回归测试（无法构造的用最小单元测试覆盖判定函数），或说明为何不可测。
- `cargo test -p agentport-core` 全绿；`cargo test --workspace`（或至少 core + 相关 crate）无回归。
- `cd src && npx vitest run` 全绿；`npm run build`（`tsc --noEmit`）通过；`npm run i18n:check` 通过。
- T-001/T-002/T-007 的修复用临时真实仓库复验（Push 目标、discard 范围、rename stage）。
- 按 AGENTS.md 提交一个只含本任务改动的 commit；过程中不混入其他工作。
- UI 改动交付前按 AGENTS.md 重启调试窗口并截图确认非白屏（若本轮包含前端可见改动）。

<!-- task-doc-section:dependencies-batches -->
## 依赖与批次

- 文件所有权（避免并行冲突）：
  - A（coordinator）：`git/sync.rs`、`git/file_actions.rs`、`git/commit.rs`、`git/commit_ai.rs`、`git/branch.rs`
  - B：`git/command.rs` + `tests/git_runner_contract.rs`
  - C：`git/mod.rs`（T-003/T-011）+ `src-tauri/src/main.rs`（仅 preflight 透传）+ `src/src/types.ts` + `src/src/actions.ts` + `worktree-extra` locales + 对应测试
  - D：`src/src/gitCenter.ts`、`src/src/deviceSwitch.ts`、`src/src/components/GitCommitHoverCard.tsx`、`git.json` locales + 对应测试
- 依赖：T-001 的 core 修复先于 D 的文案调整；T-003 的 core 字段先于 C 的 TS/UI。
- 串行约束：`git/branch.rs` 由 A 独占；`src/src/types.ts` 由 C 独占；`git.json` 由 D 独占。

<!-- task-doc-section:key-design -->
## 关键设计决定

1. **T-001**：Push/ForcePush 目标固定为 `refs/heads/<当前分支>`；若现有 upstream 不指向该 ref，则加 `--set-upstream` 修复陈旧配置。ForcePush 同时校验本地分支与目标 ref 均非 main/master。
2. **T-004**：ignored 条目的 `worktree_hash` 改为元数据签名（len + mtime nanos + mode + inode + symlink target），不再读全文；tracked 条目保留内容哈希。ignored 校验改为"记录的路径必须存在且签名一致，新增 ignored 条目允许"。
3. **T-008**：不替换树哈希算法；在 `build_commit_review` 中识别 porcelain `1 .A`（i-t-a）并返回既有的 `Blocked("intent-to-add entries must be staged with content before Commit")`。
4. **T-009**：`restore_locked` 先验证快照/位置再要求 stash；`cleanup` 在 stash 已消失但快照已验证时允许收尾；`only_original_ignored_paths_are_visible` 简化为"无非 ignored 状态路径"。
5. **T-012**：读取线程通过 channel 返回，按剩余 deadline `recv_timeout`；超时则 kill 进程组、做短暂 grace、返回 `timed_out=true` 与已读字节。
6. **T-013**：ignored 路径放入 `BTreeSet<PathBuf>`，按 `range` 查后代 + 祖先集合查父目录，消除 O(N×M)。

<!-- task-doc-section:results -->
## 执行结果

- T-001..T-019 全部落地；每个修复都带回归测试（`git_workspace_remote/stage/commit/commit_ai/file_actions`、`git/branch.rs`/`git/mod.rs` 单测、前端 `git-center-regressions.test.tsx`、`git-worktree-delete-preflight.test.ts`、`deviceSwitch.test.ts`）。
- 关键设计修正：
  - Push/Force Push 目标改为 `refs/heads/<当前分支>`，upstream 名不同时 `--set-upstream` 修复陈旧配置。
  - ignored 条目改用元数据指纹（len+mtime+mode+inode），校验允许新增 ignored 文件；恢复流程先验证快照再要求 stash，cleanup 支持用户已手动 pop 的情况。
  - i-t-a 通过 porcelain `1 .A` 识别并复用既有 `Blocked` 文案；rename stage 不再把旧路径放进 pathspec。
  - `run_success/run_listing` 在 `stdout_truncated` 时 fail closed，列表调用上限 64 MiB。
  - 审查报告里"`only_original_ignored_paths_are_visible` 不可达"的结论被证伪：stash 修改过的 `.gitignore` 会让原 ignored 文件进入 `RepoStatus.paths`，helper 保留并改用指纹。
- 验证：
  - `cargo test --workspace`：全部 `test result: ok`（core lib 433 passed / 7 ignored；其余 crate 全绿）。
  - `cd src && npx vitest run`：135 files / 1128 tests passed；`npx tsc --noEmit` 通过。
  - `npm run i18n:check` 仍报 2 条 **HEAD 已存在** 的问题（`deviceSwitch.ts` 中文 defaultValue、`capability.rs` Gatekeeper 文案），与本次改动无关，未扩大范围修改。
  - rustfmt 已作用于所有改动的 Rust 文件（HEAD 版本均为 clean，未产生无关格式化）。
