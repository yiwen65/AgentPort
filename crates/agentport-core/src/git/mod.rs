//! Git worktree management (PRD 3.5). Uses the SYSTEM git CLI — never libgit2 —
//! so user credentials/filters behave as usual. EVERY git invocation is an
//! argument array via std::process::Command; string concatenation into a shell
//! is forbidden anywhere in this module.

use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::ids::new_id;
use crate::models::*;
use crate::paths::{slugify, AppPaths};
use chrono::Utc;
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
pub mod branch;
pub mod command;
pub mod commit;
pub mod commit_ai;
pub mod context;
pub mod diff;
pub mod file_actions;
pub mod history;
pub mod operation;
pub mod repository;
pub mod status;
pub mod sync;
mod token;
pub mod worktree;

pub use branch::{
    BranchInfo, BranchManager, BranchSnapshot, CheckoutState, CreateBranchOutcome,
    DeleteBranchOutcome, RepoStatus, SwitchOutcome,
};
pub use command::{GitOutput, GitRunOptions, GitRunner};
pub use commit::{
    GitCommitOutcome, GitCommitRecovery, GitCommitResult, GitCommitReview, GitCommitScopeFile,
    GitMutationResult, GitPathSelection,
};
pub use commit_ai::GitCommitAiContext;
pub use context::{
    GitCheckoutDescriptor, GitCheckoutKind, GitCheckoutTarget, GitContextLocator,
    GitWorkspaceManager, ResolvedGitContext,
};
pub use diff::{GitDiffFormat, GitDiffSide, GitFileDiff};
pub use file_actions::{GitIgnoreTarget, GitResolvedFile};
pub use history::{
    GitCommitDetail, GitCommitFile, GitCommitPatch, GitCommitSummary, GitHistoryPage,
};
pub use operation::{
    AutoStash, BranchOperation, BranchOperationKind, BranchOperationPhase, BranchOperationStep,
    ReconcileReport, RestoreStrategy,
};
pub use repository::{RepositoryFileLock, RepositoryIdentity, RepositoryManager};
pub use status::{GitChangeCounts, GitChangeEntry, GitChangeKind, GitChangesSnapshot};
pub use sync::GitRemoteAction;

#[derive(Debug, Clone)]
pub struct GitWorktreeInfo {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DirtySummary {
    pub modified: usize,
    pub untracked: usize,
    pub staged: usize,
    /// Ignored files are still local user data. `git worktree remove` deletes
    /// them even though ordinary porcelain status hides them, so safe removal
    /// must count them explicitly.
    pub ignored: usize,
    pub ignored_sample: Vec<String>,
    /// Human-readable summary generated from the authoritative porcelain v2
    /// records for "copy git status".
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePreview {
    pub task_slug: String,
    pub branch: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDeletePreflight {
    pub worktree_id: String,
    pub branch: String,
    pub path: String,
    pub health: WorktreeHealth,
    pub modified: usize,
    pub staged: usize,
    pub untracked: usize,
    pub ignored: usize,
    pub ignored_sample: Vec<String>,
    pub session_count: usize,
    pub active_session_count: usize,
    pub can_remove: bool,
    pub blockers: Vec<String>,
}

pub struct GitRepo {
    pub root: PathBuf,
}

/// Run the system `git` with an argv array — never through a shell. When
/// `repo` is given, `-C <repo>` is prepended so no call depends on the
/// process cwd. Non-zero exit -> CoreError::Git carrying the full stderr and
/// the argv list (argv[1..], i.e. everything after the program name).
pub(crate) fn run_git(repo: Option<&Path>, args: &[&str]) -> Result<String> {
    run_git_timeout(repo, args, std::time::Duration::from_secs(15))
}

/// All git invocations get a hard timeout: a wedged git (network mount, odd
/// hook, credential prompt) must never freeze the caller (PRD 3.5 失败路径 B).
pub(crate) fn run_git_timeout(
    repo: Option<&Path>,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<String> {
    let output = command::GitRunner::new(timeout)
        .run(repo, args)?
        .require_success()?;
    Ok(output.stdout_lossy())
}

/// Shorthand for `run_git(Some(dir), args)`.
pub(crate) fn run_git_at(dir: &Path, args: &[&str]) -> Result<String> {
    run_git(Some(dir), args)
}

impl GitRepo {
    /// `git -C path rev-parse --show-toplevel`; NotFound/Validation when not a repo.
    pub fn discover(path: &Path) -> Result<GitRepo> {
        if !path.is_dir() {
            return Err(CoreError::Validation(format!(
                "not a directory: {}",
                path.display()
            )));
        }
        let top = run_git_at(path, &["rev-parse", "--show-toplevel"]).map_err(|e| match e {
            CoreError::Git(msg) => {
                CoreError::Validation(format!("not a git repo: {} ({msg})", path.display()))
            }
            other => other,
        })?;
        let root = std::fs::canonicalize(top.trim()).map_err(|e| {
            CoreError::Internal(format!("cannot canonicalize git root {}: {e}", top.trim()))
        })?;
        Ok(GitRepo { root })
    }

    pub fn head_commit(&self) -> Result<String> {
        Ok(run_git(Some(&self.root), &["rev-parse", "HEAD"])?
            .trim()
            .to_string())
    }

    pub fn current_branch(&self) -> Result<Option<String>> {
        match run_git(Some(&self.root), &["symbolic-ref", "--short", "HEAD"]) {
            Ok(s) => Ok(Some(s.trim().to_string())),
            // Detached HEAD: symbolic-ref exits non-zero -> no branch.
            Err(CoreError::Git(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn branch_exists(&self, branch: &str) -> Result<bool> {
        let refspec = format!("refs/heads/{branch}");
        // Judged by exit code (--quiet), never by stderr content.
        match run_git(
            Some(&self.root),
            &["show-ref", "--verify", "--quiet", &refspec],
        ) {
            Ok(_) => Ok(true),
            Err(CoreError::Git(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn resolve_ref(&self, refname: &str) -> Result<String> {
        let want = format!("{refname}^{{commit}}");
        Ok(
            run_git(Some(&self.root), &["rev-parse", "--verify", &want])?
                .trim()
                .to_string(),
        )
    }

    pub fn status(&self, path: &Path) -> Result<DirtySummary> {
        let runner = GitRunner::default();
        let identity = RepositoryIdentity::discover(path, &runner)?;
        status::read_dirty_summary(&identity, path, &runner)
    }

    pub fn worktree_list(&self) -> Result<Vec<GitWorktreeInfo>> {
        let runner = GitRunner::default();
        let output = runner
            .run_read_only(Some(&self.root), ["worktree", "list", "--porcelain", "-z"])?
            .require_success()?;
        worktree::parse_worktree_list_z(&output.stdout)
    }

    /// `git worktree add <path> -b <branch> <base>` (create_branch=true) or
    /// `git worktree add <path> <branch>` when adopting an existing branch (P1).
    pub fn worktree_add(
        &self,
        path: &Path,
        branch: &str,
        base: &str,
        create_branch: bool,
    ) -> Result<()> {
        let p = path.to_string_lossy().into_owned();
        let argv: Vec<&str> = if create_branch {
            vec!["worktree", "add", &p, "-b", branch, base]
        } else {
            vec!["worktree", "add", &p, branch]
        };
        run_git(Some(&self.root), &argv)?;
        Ok(())
    }

    /// `git worktree remove <path>` — refuses internally when dirty (git itself
    /// errors); we pre-check dirty and return CoreError::Blocked with the summary.
    pub fn worktree_remove(&self, path: &Path) -> Result<()> {
        let p = path.to_string_lossy().into_owned();
        run_git(Some(&self.root), &["worktree", "remove", &p])?;
        Ok(())
    }

    pub fn worktree_prune(&self) -> Result<()> {
        run_git(Some(&self.root), &["worktree", "prune"])?;
        Ok(())
    }

    pub fn is_locked(&self, path: &Path) -> Result<bool> {
        // git reports canonical paths in the porcelain output; canonicalize the
        // candidate too so symlinked (e.g. /var -> /private/var) paths compare.
        let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        Ok(self
            .worktree_list()?
            .iter()
            .any(|w| w.locked && w.path == canon))
    }
}

/// High-level manager bound to app paths + db records (PRD 3.5 flows).
pub struct WorktreeManager<'a> {
    pub paths: &'a AppPaths,
    pub db: &'a Db,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeBranchSelection {
    Auto,
    New { name: String },
    Existing { name: String, expected_oid: String },
}

enum InternalWorktreeBranchSelection {
    Auto,
    New(String),
    Existing {
        name: String,
        expected_oid: Option<String>,
    },
}

impl<'a> WorktreeManager<'a> {
    /// Return the exact backend-generated auto branch and directory before any
    /// mutation. The renderer must display this result instead of maintaining
    /// a second slug implementation that can drift.
    pub fn preview(&self, project_id: &str, task_name: &str) -> Result<WorktreePreview> {
        let project = self.db.get_project(project_id)?;
        let task_slug = worktree_task_slug(task_name);
        let worktrees_root = std::fs::canonicalize(self.paths.worktrees_root())
            .unwrap_or_else(|_| self.paths.worktrees_root());
        Ok(WorktreePreview {
            branch: format!("agent/{task_slug}"),
            path: worktrees_root
                .join(slugify(&project.name))
                .join(&task_slug)
                .to_string_lossy()
                .into_owned(),
            task_slug,
        })
    }

    /// Recover a Git Worktree that was fully created under AgentPort's own
    /// project directory but could not be persisted because the process
    /// stopped between the Git mutation and the database insert. Worktrees
    /// anywhere outside that exact owned directory are never adopted.
    pub fn reconcile_owned_worktrees(&self, project_id: &str) -> Result<usize> {
        let project = self.db.get_project(project_id)?;
        let runner = GitRunner::default();
        let identity = RepositoryIdentity::from_project(&project, &runner)?;
        let lock = repository::repository_lock(&identity.repo_key);
        let _guard = lock.lock().unwrap();
        let identity = RepositoryIdentity::from_project(&project, &runner)?;
        let _file_guard = RepositoryFileLock::acquire(&identity.common_dir)?;
        let identity = RepositoryIdentity::from_project(&project, &runner)?;
        self.reconcile_owned_worktrees_with_identity(&project, &identity, &runner)
    }

    fn reconcile_owned_worktrees_with_identity(
        &self,
        project: &Project,
        identity: &RepositoryIdentity,
        runner: &GitRunner,
    ) -> Result<usize> {
        let owned_root = self.paths.worktrees_root().join(slugify(&project.name));
        if !owned_root.is_dir() {
            return Ok(0);
        }
        let owned_root = std::fs::canonicalize(owned_root)?;
        let mut known = self.db.list_worktrees(&project.id)?;
        let mut recovered = 0;
        for git_worktree in identity.worktrees(runner)? {
            if git_worktree.prunable || !git_worktree.path.is_dir() {
                continue;
            }
            let path = std::fs::canonicalize(&git_worktree.path)?;
            if path.parent() != Some(owned_root.as_path())
                || known
                    .iter()
                    .any(|worktree| same_path(Path::new(&worktree.path), &path))
            {
                continue;
            }
            let (Some(branch), Some(head)) = (git_worktree.branch, git_worktree.head) else {
                continue;
            };
            let status = GitRepo::discover(&path)?.status(&path)?;
            let health = if git_worktree.locked {
                WorktreeHealth::Locked
            } else if status.raw.trim().is_empty() && status.ignored == 0 {
                WorktreeHealth::Clean
            } else {
                WorktreeHealth::Dirty
            };
            let worktree = Worktree {
                id: new_id("wt"),
                project_id: project.id.clone(),
                branch,
                base_commit: head,
                base_ref: None,
                path: path.to_string_lossy().into_owned(),
                health,
                created_at: Utc::now(),
            };
            match self.db.insert_worktree(&worktree) {
                Ok(()) => {
                    known.push(worktree);
                    recovered += 1;
                }
                Err(CoreError::Conflict(_))
                    if self.db.list_worktrees(&project.id)?.iter().any(|known| {
                        same_path(Path::new(&known.path), Path::new(&worktree.path))
                    }) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(recovered)
    }

    /// Create branch `agent/<slug>` (or adopt existing branch when
    /// `use_existing_branch` is set) + directory under
    /// `<data>/worktrees/<project-slug>/<task-slug>`, from HEAD or an explicit
    /// Base Ref (P1). On ANY git failure: roll back only directories created by
    /// this call, keep full git stderr in the error.
    /// Branch/dir conflicts -> CoreError::Conflict with the existing path/branch;
    /// never overwrite (PRD 3.5 failure A).
    pub fn create(
        &self,
        project_id: &str,
        task_name: &str,
        base_ref: Option<&str>,
        use_existing_branch: Option<&str>,
    ) -> Result<Worktree> {
        let selection = match use_existing_branch {
            Some(branch) => InternalWorktreeBranchSelection::Existing {
                name: branch.to_owned(),
                expected_oid: None,
            },
            None => InternalWorktreeBranchSelection::Auto,
        };
        self.create_internal(project_id, task_name, base_ref, selection)
    }

    pub fn create_selected(
        &self,
        project_id: &str,
        task_name: &str,
        base_ref: Option<&str>,
        selection: WorktreeBranchSelection,
    ) -> Result<Worktree> {
        let selection = match selection {
            WorktreeBranchSelection::Auto => InternalWorktreeBranchSelection::Auto,
            WorktreeBranchSelection::New { name } => InternalWorktreeBranchSelection::New(name),
            WorktreeBranchSelection::Existing { name, expected_oid } => {
                InternalWorktreeBranchSelection::Existing {
                    name,
                    expected_oid: Some(expected_oid),
                }
            }
        };
        self.create_internal(project_id, task_name, base_ref, selection)
    }

    fn create_internal(
        &self,
        project_id: &str,
        task_name: &str,
        base_ref: Option<&str>,
        selection: InternalWorktreeBranchSelection,
    ) -> Result<Worktree> {
        let runner = GitRunner::default();
        self.create_internal_with_runner(project_id, task_name, base_ref, selection, &runner)
    }

    fn create_internal_with_runner(
        &self,
        project_id: &str,
        task_name: &str,
        base_ref: Option<&str>,
        selection: InternalWorktreeBranchSelection,
        runner: &GitRunner,
    ) -> Result<Worktree> {
        let project = self.db.get_project(project_id)?;
        let identity = RepositoryIdentity::from_project(&project, runner)?;
        let lock = repository::repository_lock(&identity.repo_key);
        let _guard = lock.lock().unwrap();
        let identity = RepositoryIdentity::from_project(&project, runner)?;
        let _file_guard = RepositoryFileLock::acquire(&identity.common_dir)?;
        let identity = RepositoryIdentity::from_project(&project, runner)?;
        self.reconcile_owned_worktrees_with_identity(&project, &identity, runner)?;

        let WorktreePreview {
            task_slug: _,
            branch: auto_branch,
            path: preview_path,
        } = self.preview(project_id, task_name)?;
        let (branch, create_branch, expected_oid) = match selection {
            InternalWorktreeBranchSelection::Auto => (auto_branch, true, None),
            InternalWorktreeBranchSelection::New(name) => (name, true, None),
            InternalWorktreeBranchSelection::Existing { name, expected_oid } => {
                (name, false, expected_oid)
            }
        };
        let branch = branch.trim().to_owned();
        if branch.is_empty() {
            return Err(CoreError::Validation(
                "branch name must not be empty".into(),
            ));
        }
        if !create_branch
            && expected_oid
                .as_deref()
                .is_some_and(|oid| oid.trim().is_empty())
        {
            return Err(CoreError::Validation(
                "expected branch OID must not be empty".into(),
            ));
        }
        validate_worktree_branch_name(&identity, runner, &branch)?;

        let observed_oid = local_branch_oid(&identity, runner, &branch)?;
        if create_branch && observed_oid.is_some() {
            return Err(CoreError::Conflict(format!(
                "local branch already exists: {branch}; select it from the local branch list to use it"
            )));
        }
        if !create_branch && observed_oid.is_none() {
            return Err(CoreError::NotFound(format!(
                "local branch no longer exists: {branch}"
            )));
        }
        if let (Some(expected), Some(observed)) = (expected_oid.as_deref(), observed_oid.as_deref())
        {
            if expected != observed {
                return Err(CoreError::Conflict(format!(
                    "local branch {branch} moved after selection; expected {expected}, observed {observed}"
                )));
            }
        }
        ensure_worktree_branch_unoccupied(&identity, runner, &branch)?;

        // Base: explicit ref (validated) or current HEAD.
        let base_commit = if create_branch {
            resolve_worktree_base(&identity, runner, base_ref)?
        } else {
            observed_oid.expect("existing branch OID checked above")
        };

        // Re-read the exact local ref and occupancy immediately before the
        // mutation. The in-process and common-dir locks serialize AgentPort;
        // Git's own worktree protection remains authoritative for external
        // clients racing after this check.
        let final_oid = local_branch_oid(&identity, runner, &branch)?;
        if create_branch {
            if final_oid.is_some() {
                return Err(CoreError::Conflict(format!(
                    "local branch appeared before Worktree creation: {branch}"
                )));
            }
        } else {
            let final_oid = final_oid.ok_or_else(|| {
                CoreError::NotFound(format!("local branch no longer exists: {branch}"))
            })?;
            if final_oid != base_commit {
                return Err(CoreError::Conflict(format!(
                    "local branch {branch} moved before Worktree creation; expected {base_commit}, observed {final_oid}"
                )));
            }
        }
        ensure_worktree_branch_unoccupied(&identity, runner, &branch)?;

        let dir = PathBuf::from(preview_path);
        // `owned` tracks whether THIS call created the directory; rollback may
        // only ever delete directories we own (PRD 3.5 failure B).
        let mut owned = false;
        if dir.exists() {
            if !dir.is_dir() {
                return Err(CoreError::Conflict(format!(
                    "worktree path exists and is not a directory: {}",
                    dir.display()
                )));
            }
            if std::fs::read_dir(&dir)?.next().is_some() {
                return Err(CoreError::Conflict(format!(
                    "worktree dir exists and is not empty: {}",
                    dir.display()
                )));
            }
            // Empty dir: reusable, but never deleted by our rollback.
        } else {
            std::fs::create_dir_all(&dir)?;
            owned = true;
        }

        let mut args = vec![OsString::from("worktree"), OsString::from("add")];
        if create_branch {
            args.extend([
                OsString::from("--no-track"),
                OsString::from("-b"),
                OsString::from(&branch),
                dir.as_os_str().to_owned(),
                OsString::from(&base_commit),
            ]);
        } else {
            args.extend([dir.as_os_str().to_owned(), OsString::from(&branch)]);
        }
        let add_result = runner
            .run(Some(&identity.root), args)
            .and_then(|output| output.require_success().map(|_| ()));
        if let Err(error) = add_result {
            let registered = identity.worktrees(runner).ok().and_then(|worktrees| {
                worktrees.into_iter().find(|worktree| {
                    same_path(&worktree.path, &dir)
                        && worktree.branch.as_deref() == Some(branch.as_str())
                })
            });
            if registered.is_none() {
                if owned {
                    let _ = std::fs::remove_dir_all(&dir);
                }
                if let Some(classified) = classify_worktree_add_failure(
                    &identity,
                    runner,
                    &branch,
                    &base_commit,
                    create_branch,
                )? {
                    return Err(classified);
                }
                return Err(error);
            }
        }

        // `--no-track` does not clear stale branch.<name> configuration left
        // behind by an older deleted branch. A newly-created branch must not
        // silently inherit that historical upstream.
        if create_branch {
            if let Err(config_error) = clear_stale_branch_tracking(&identity, runner, &branch) {
                if let Err(rollback_error) = rollback_created_worktree(
                    &identity,
                    runner,
                    &dir,
                    owned,
                    Some((branch.as_str(), base_commit.as_str())),
                ) {
                    return Err(CoreError::Internal(format!(
                        "{config_error}; Worktree rollback failed: {rollback_error}"
                    )));
                }
                return Err(config_error);
            }
        }

        // A branch can be moved by an external Git process after our final
        // preflight. Verify both the local ref and the registered Worktree HEAD
        // before persisting anything. A mismatched fresh Worktree is removed
        // with normal Git protection; force removal is never used.
        if let Err(verification_error) =
            verify_created_worktree(&identity, runner, &dir, &branch, &base_commit)
        {
            if let Err(rollback_error) = rollback_created_worktree(
                &identity,
                runner,
                &dir,
                owned,
                create_branch.then_some((branch.as_str(), base_commit.as_str())),
            ) {
                return Err(CoreError::Internal(format!(
                    "{verification_error}; Worktree rollback failed: {rollback_error}"
                )));
            }
            return Err(verification_error);
        }

        // Store the canonical path: `git worktree list --porcelain` reports
        // canonical paths, and db uniqueness should match them.
        let canon = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        let wt = Worktree {
            id: new_id("wt"),
            project_id: project.id.clone(),
            branch: branch.clone(),
            base_commit,
            base_ref: if create_branch {
                base_ref.map(str::to_string)
            } else {
                None
            },
            path: canon.to_string_lossy().into_owned(),
            health: WorktreeHealth::Clean,
            created_at: Utc::now(),
        };
        if let Err(e) = self.db.insert_worktree(&wt) {
            if let Err(rollback_error) = rollback_created_worktree(
                &identity,
                runner,
                &canon,
                owned,
                create_branch.then_some((branch.as_str(), wt.base_commit.as_str())),
            ) {
                return Err(CoreError::Internal(format!(
                    "failed to persist Worktree: {e}; Git rollback failed: {rollback_error}"
                )));
            }
            return Err(match e {
                CoreError::Conflict(msg) => {
                    let existing = self
                        .db
                        .list_worktrees(&project.id)
                        .ok()
                        .and_then(|ws| ws.into_iter().find(|w| w.path == wt.path));
                    match existing {
                        Some(w) => CoreError::Conflict(format!(
                            "worktree already exists for task '{task_name}': {} (branch {})",
                            w.path, w.branch
                        )),
                        None => CoreError::Conflict(msg),
                    }
                }
                other => other,
            });
        }
        Ok(wt)
    }

    /// Recompute clean/dirty/missing/locked and persist it.
    pub fn refresh_health(&self, worktree_id: &str) -> Result<WorktreeHealth> {
        let w = self.db.get_worktree(worktree_id)?;
        let path = Path::new(&w.path);
        let health = if !path.is_dir() {
            WorktreeHealth::Missing
        } else {
            let repo = GitRepo::discover(path)?;
            if repo.is_locked(path)? {
                WorktreeHealth::Locked
            } else {
                let status = repo.status(path)?;
                if status.raw.trim().is_empty() && status.ignored == 0 {
                    WorktreeHealth::Clean
                } else {
                    WorktreeHealth::Dirty
                }
            }
        };
        self.db.set_worktree_health(worktree_id, health)?;
        Ok(health)
    }

    /// Re-read all deletion-sensitive facts immediately before confirmation.
    /// This is intentionally richer than the sidebar's cached health badge.
    pub fn deletion_preflight(&self, worktree_id: &str) -> Result<WorktreeDeletePreflight> {
        let health = self.refresh_health(worktree_id)?;
        let worktree = self.db.get_worktree(worktree_id)?;
        let summary = if Path::new(&worktree.path).is_dir() {
            self.dirty_summary(worktree_id)?
        } else {
            DirtySummary::default()
        };
        let (session_count, active_session_count) = self.db.worktree_session_counts(worktree_id)?;
        let mut blockers = Vec::new();
        if summary.modified + summary.staged + summary.untracked > 0 {
            blockers.push("uncommitted_changes".into());
        }
        if summary.ignored > 0 {
            blockers.push("ignored_local_files".into());
        }
        if session_count > 0 {
            blockers.push("session_references".into());
        }
        if health == WorktreeHealth::Locked {
            blockers.push("locked".into());
        }
        let can_remove = blockers.is_empty()
            && matches!(health, WorktreeHealth::Clean | WorktreeHealth::Missing);
        Ok(WorktreeDeletePreflight {
            worktree_id: worktree.id,
            branch: worktree.branch,
            path: worktree.path,
            health,
            modified: summary.modified,
            staged: summary.staged,
            untracked: summary.untracked,
            ignored: summary.ignored,
            ignored_sample: summary.ignored_sample,
            session_count,
            active_session_count,
            can_remove,
            blockers,
        })
    }

    /// Safe delete (PRD 3.5 failure C): dirty/missing handling — dirty BLOCKS by
    /// default (no force button in P0/P1/P2); on success run `worktree remove`
    /// + prune, delete the db record, and verify the main checkout is untouched.
    pub fn remove(&self, worktree_id: &str) -> Result<()> {
        let preflight = self.deletion_preflight(worktree_id)?;
        let health = preflight.health;
        let w = self.db.get_worktree(worktree_id)?;
        if preflight.session_count > 0 {
            return Err(CoreError::Blocked(format!(
                "worktree is used by {} session(s), including {} active session(s); archive does not remove the dependency",
                preflight.session_count, preflight.active_session_count
            )));
        }
        let project = self.db.get_project(&w.project_id)?;
        let git_root = project
            .git_root_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                CoreError::Validation(format!(
                    "not a git repo: project '{}' has no git root",
                    project.name
                ))
            })?;
        // Operate from the main repo root; the worktree path is only ever a
        // target argument, so the main checkout is never touched.
        let repo = GitRepo::discover(Path::new(git_root))?;
        match health {
            WorktreeHealth::Dirty => Err(CoreError::Blocked(format!(
                "worktree contains local data ({} modified, {} staged, {} untracked, {} ignored); \
                     commit, move, or clean it up before removing: {}",
                preflight.modified,
                preflight.staged,
                preflight.untracked,
                preflight.ignored,
                w.path
            ))),
            WorktreeHealth::Locked => Err(CoreError::Blocked(format!(
                "worktree is locked; unlock it outside AgentPort first: {}",
                w.path
            ))),
            WorktreeHealth::Missing => self
                .db
                .delete_worktree_after(worktree_id, || {
                    if Path::new(&w.path).is_dir() {
                        return Err(CoreError::Blocked(format!(
                            "worktree path reappeared after the safety check; retry removal: {}",
                            w.path
                        )));
                    }
                    repo.worktree_prune()
                }),
            WorktreeHealth::Clean => self.db.delete_worktree_after(worktree_id, || {
                let latest = repo.status(Path::new(&w.path))?;
                if !latest.raw.trim().is_empty() || latest.ignored > 0 {
                    return Err(CoreError::Blocked(format!(
                        "worktree changed after the safety check ({} modified, {} staged, {} untracked, {} ignored); retry after reviewing it",
                        latest.modified, latest.staged, latest.untracked, latest.ignored
                    )));
                }
                repo.worktree_remove(Path::new(&w.path))?;
                repo.worktree_prune()
            }),
        }
    }

    pub fn dirty_summary(&self, worktree_id: &str) -> Result<DirtySummary> {
        let w = self.db.get_worktree(worktree_id)?;
        let path = Path::new(&w.path);
        let repo = GitRepo::discover(path)?;
        repo.status(path)
    }
}

/// Worktree task names may be non-English. Keep letters and numbers from all
/// scripts while retaining a conservative set of separators for Git refs and
/// directory components.
fn worktree_task_slug(input: &str) -> String {
    let mut slug = String::with_capacity(input.len());
    let mut last_dash = false;
    for character in input.trim().chars() {
        if character.is_alphanumeric() {
            for lower in character.to_lowercase() {
                slug.push(lower);
            }
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    let mut slug: String = slug.chars().take(60).collect();
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "task".into()
    } else {
        slug
    }
}

fn clear_stale_branch_tracking(
    identity: &RepositoryIdentity,
    runner: &GitRunner,
    branch: &str,
) -> Result<()> {
    for field in ["remote", "merge", "rebase", "pushRemote"] {
        let key = format!("branch.{branch}.{field}");
        let output = runner.run(
            Some(&identity.root),
            [
                OsString::from("config"),
                OsString::from("--unset-all"),
                OsString::from(key),
            ],
        )?;
        if output.success() || output.exit_code() == Some(5) {
            continue;
        }
        return output.require_success().map(|_| ());
    }
    Ok(())
}

fn validate_worktree_branch_name(
    identity: &RepositoryIdentity,
    runner: &GitRunner,
    branch: &str,
) -> Result<()> {
    let output = runner.run(
        Some(&identity.root),
        [
            OsString::from("check-ref-format"),
            OsString::from("--branch"),
            OsString::from(branch),
        ],
    )?;
    if output.success() {
        return Ok(());
    }
    Err(CoreError::Validation(format!(
        "invalid local branch name {branch:?}"
    )))
}

fn local_branch_oid(
    identity: &RepositoryIdentity,
    runner: &GitRunner,
    branch: &str,
) -> Result<Option<String>> {
    let full_ref = format!("refs/heads/{branch}");
    let revision = format!("{full_ref}^{{commit}}");
    let output = runner.run(
        Some(&identity.root),
        [
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from("--quiet"),
            OsString::from("--end-of-options"),
            OsString::from(revision),
        ],
    )?;
    if output.success() {
        let oid = output.stdout_lossy().trim().to_owned();
        if oid.is_empty() {
            return Err(CoreError::Internal(format!(
                "local branch {branch} resolved to an empty OID"
            )));
        }
        return Ok(Some(oid));
    }
    if !output.timed_out && output.exit_code() == Some(1) {
        return Ok(None);
    }
    output.require_success().map(|_| None)
}

fn ensure_worktree_branch_unoccupied(
    identity: &RepositoryIdentity,
    runner: &GitRunner,
    branch: &str,
) -> Result<()> {
    if let Some(worktree) = identity
        .worktrees(runner)?
        .into_iter()
        .find(|worktree| worktree.branch.as_deref() == Some(branch))
    {
        return Err(CoreError::Blocked(format!(
            "local branch {branch} is already checked out at {}",
            worktree.path.display()
        )));
    }
    Ok(())
}

fn verify_created_worktree(
    identity: &RepositoryIdentity,
    runner: &GitRunner,
    dir: &Path,
    branch: &str,
    expected_oid: &str,
) -> Result<()> {
    let registered = identity
        .worktrees(runner)?
        .into_iter()
        .find(|worktree| same_path(&worktree.path, dir))
        .ok_or_else(|| {
            CoreError::Internal(format!(
                "Git did not register the new Worktree at {}",
                dir.display()
            ))
        })?;
    if registered.branch.as_deref() != Some(branch) {
        return Err(CoreError::Conflict(format!(
            "new Worktree branch changed during creation; expected {branch}, observed {}",
            registered.branch.as_deref().unwrap_or("detached HEAD")
        )));
    }

    let observed_ref = local_branch_oid(identity, runner, branch)?.ok_or_else(|| {
        CoreError::NotFound(format!(
            "local branch was deleted during Worktree creation: {branch}"
        ))
    })?;
    let observed_head = runner
        .run(
            Some(dir),
            [
                OsString::from("rev-parse"),
                OsString::from("--verify"),
                OsString::from("HEAD^{commit}"),
            ],
        )?
        .require_success()?
        .stdout_lossy()
        .trim()
        .to_owned();
    if observed_ref != expected_oid || observed_head != expected_oid {
        return Err(CoreError::Conflict(format!(
            "local branch {branch} moved during Worktree creation; expected {expected_oid}, observed ref {observed_ref}, Worktree HEAD {observed_head}"
        )));
    }
    Ok(())
}

fn rollback_created_worktree(
    identity: &RepositoryIdentity,
    runner: &GitRunner,
    dir: &Path,
    owned: bool,
    created_branch: Option<(&str, &str)>,
) -> Result<()> {
    let existed_before = !owned;
    runner
        .run(
            Some(&identity.root),
            [
                OsString::from("worktree"),
                OsString::from("remove"),
                dir.as_os_str().to_owned(),
            ],
        )?
        .require_success()?;
    if owned && dir.exists() {
        // Never recursively remove a path after Git has released it: an
        // external process could have populated the directory in that small
        // window. Removing an empty directory is sufficient cleanup.
        std::fs::remove_dir(dir)?;
    } else if existed_before && !dir.exists() {
        std::fs::create_dir_all(dir)?;
    }
    if let Some((branch, expected_oid)) = created_branch {
        runner
            .run(
                Some(&identity.root),
                [
                    OsString::from("update-ref"),
                    OsString::from("-d"),
                    OsString::from(format!("refs/heads/{branch}")),
                    OsString::from(expected_oid),
                ],
            )?
            .require_success()?;
        if local_branch_oid(identity, runner, branch)?.is_some() {
            return Err(CoreError::Conflict(format!(
                "new branch {branch} was retained because its ref changed during rollback"
            )));
        }
    }
    runner
        .run(
            Some(&identity.root),
            [OsString::from("worktree"), OsString::from("prune")],
        )?
        .require_success()?;
    Ok(())
}

fn resolve_worktree_base(
    identity: &RepositoryIdentity,
    runner: &GitRunner,
    base_ref: Option<&str>,
) -> Result<String> {
    let base = base_ref.unwrap_or("HEAD").trim();
    if base.is_empty() || base.starts_with('-') {
        return Err(CoreError::Validation(
            "Base Ref must not be empty or option-like".into(),
        ));
    }
    let revision = format!("{base}^{{commit}}");
    Ok(runner
        .run(
            Some(&identity.root),
            [
                OsString::from("rev-parse"),
                OsString::from("--verify"),
                OsString::from("--end-of-options"),
                OsString::from(revision),
            ],
        )?
        .require_success()?
        .stdout_lossy()
        .trim()
        .to_owned())
}

fn classify_worktree_add_failure(
    identity: &RepositoryIdentity,
    runner: &GitRunner,
    branch: &str,
    expected_oid: &str,
    create_branch: bool,
) -> Result<Option<CoreError>> {
    let observed_oid = local_branch_oid(identity, runner, branch)?;
    if create_branch {
        if observed_oid.is_some() {
            return Ok(Some(CoreError::Conflict(format!(
                "local branch appeared while creating the Worktree: {branch}"
            ))));
        }
        return Ok(None);
    }
    let Some(observed_oid) = observed_oid else {
        return Ok(Some(CoreError::NotFound(format!(
            "local branch was deleted before Worktree creation: {branch}"
        ))));
    };
    if observed_oid != expected_oid {
        return Ok(Some(CoreError::Conflict(format!(
            "local branch {branch} moved before Worktree creation; expected {expected_oid}, observed {observed_oid}"
        ))));
    }
    if let Some(worktree) = identity
        .worktrees(runner)?
        .into_iter()
        .find(|worktree| worktree.branch.as_deref() == Some(branch))
    {
        return Ok(Some(CoreError::Blocked(format!(
            "local branch {branch} became checked out at {}",
            worktree.path.display()
        ))));
    }
    Ok(None)
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left == right
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // -- helpers -------------------------------------------------------------

    struct Fixture {
        _tmp: TempDir,
        repo_dir: PathBuf, // canonical main checkout
        paths: AppPaths,
        db: Db,
        project_id: String,
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        run_git_at(dir, args).unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
    }

    fn commit_file(dir: &Path, name: &str, content: &str, msg: &str) {
        std::fs::write(dir.join(name), content).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["-c", "commit.gpgsign=false", "commit", "-m", msg]);
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-b", "main"]);
        git(dir, &["config", "user.email", "agentport@test.local"]);
        git(dir, &["config", "user.name", "AgentPort Test"]);
        commit_file(dir, "file.txt", "hello v1\n", "init");
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let repo_raw = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_raw).unwrap();
        init_repo(&repo_raw);
        let repo_dir = std::fs::canonicalize(&repo_raw).unwrap();
        let paths = AppPaths::new(tmp.path().join("data"));
        paths.ensure_layout().unwrap();
        let db = Db::open_memory().unwrap();
        let project_id = "prj_test".to_string();
        db.add_project(&Project {
            id: project_id.clone(),
            name: "Main API!".into(),
            root_path: repo_dir.to_string_lossy().into_owned(),
            git_root_path: Some(repo_dir.to_string_lossy().into_owned()),
            created_at: Utc::now(),
        })
        .unwrap();
        Fixture {
            _tmp: tmp,
            repo_dir,
            paths,
            db,
            project_id,
        }
    }

    fn mgr(fx: &Fixture) -> WorktreeManager<'_> {
        WorktreeManager {
            paths: &fx.paths,
            db: &fx.db,
        }
    }

    // -- tests ---------------------------------------------------------------

    #[test]
    fn create_success() {
        let fx = fixture();
        let mgr = mgr(&fx);
        let repo = GitRepo::discover(&fx.repo_dir).unwrap();
        let base = repo.head_commit().unwrap();

        let wt = mgr
            .create(&fx.project_id, "Fix login timeout!", None, None)
            .unwrap();
        let dir = PathBuf::from(&wt.path);
        assert!(dir.is_dir());
        assert!(dir.join(".git").exists()); // worktree gitfile
        assert!(wt.path.contains("worktrees/main-api/fix-login-timeout"));
        assert_eq!(wt.branch, "agent/fix-login-timeout");
        assert_eq!(wt.base_commit, base);
        assert_eq!(wt.base_ref, None);
        assert_eq!(wt.health, WorktreeHealth::Clean);

        // New worktree HEAD == base commit.
        let wt_repo = GitRepo::discover(&dir).unwrap();
        assert_eq!(wt_repo.head_commit().unwrap(), base);
        assert_eq!(
            wt_repo.current_branch().unwrap().as_deref(),
            Some("agent/fix-login-timeout")
        );

        // db record persisted.
        let rec = fx.db.get_worktree(&wt.id).unwrap();
        assert_eq!(rec.branch, "agent/fix-login-timeout");
        assert_eq!(rec.path, wt.path);

        // `git worktree list` contains the path.
        let list = repo.worktree_list().unwrap();
        assert!(list.iter().any(|i| i.path == dir));
    }

    #[test]
    fn preview_and_create_share_the_same_unicode_task_slug() {
        let fx = fixture();
        let manager = mgr(&fx);
        let preview = manager.preview(&fx.project_id, "修复 登录超时").unwrap();
        assert_eq!(preview.task_slug, "修复-登录超时");
        assert_eq!(preview.branch, "agent/修复-登录超时");
        assert!(preview.path.ends_with("/worktrees/main-api/修复-登录超时"));

        let created = manager
            .create(&fx.project_id, "修复 登录超时", None, None)
            .unwrap();
        assert_eq!(created.branch, preview.branch);
        assert_eq!(created.path, preview.path);
    }

    #[test]
    fn create_with_base_ref() {
        let fx = fixture();
        let mgr = mgr(&fx);
        let repo = GitRepo::discover(&fx.repo_dir).unwrap();
        let old = repo.head_commit().unwrap();
        commit_file(&fx.repo_dir, "file.txt", "hello v2\n", "v2");
        let head_now = repo.head_commit().unwrap();
        assert_ne!(old, head_now);

        let wt = mgr
            .create(&fx.project_id, "base ref task", Some("HEAD~1"), None)
            .unwrap();
        assert_eq!(wt.base_commit, old);
        assert_eq!(wt.base_ref.as_deref(), Some("HEAD~1"));
        let wt_repo = GitRepo::discover(Path::new(&wt.path)).unwrap();
        assert_eq!(wt_repo.head_commit().unwrap(), old);

        // Main checkout HEAD untouched.
        assert_eq!(repo.head_commit().unwrap(), head_now);
    }

    #[test]
    fn create_use_existing_branch_and_conflicts() {
        let fx = fixture();
        let mgr = mgr(&fx);
        git(&fx.repo_dir, &["branch", "feat-x"]);

        // Adopt an existing branch.
        let wt = mgr
            .create(&fx.project_id, "adopt it", None, Some("feat-x"))
            .unwrap();
        assert_eq!(wt.branch, "feat-x");
        let wt_repo = GitRepo::discover(Path::new(&wt.path)).unwrap();
        assert_eq!(wt_repo.current_branch().unwrap().as_deref(), Some("feat-x"));

        // Adopting a nonexistent branch -> NotFound.
        let err = mgr
            .create(&fx.project_id, "other task", None, Some("no-such-branch"))
            .unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)), "{err}");

        // Same task twice: the second create sees branch agent/<slug> already
        // exists -> Conflict, never overwrite.
        mgr.create(&fx.project_id, "dup task", None, None).unwrap();
        let err = mgr
            .create(&fx.project_id, "dup task", None, None)
            .unwrap_err();
        match err {
            CoreError::Conflict(msg) => assert!(msg.contains("agent/dup-task"), "{msg}"),
            other => panic!("expected Conflict, got {other}"),
        }
    }

    #[test]
    fn dirty_blocks_remove_until_clean() {
        let fx = fixture();
        let mgr = mgr(&fx);
        let repo = GitRepo::discover(&fx.repo_dir).unwrap();
        let main_file = fx.repo_dir.join("file.txt");
        let bytes_before = std::fs::read(&main_file).unwrap();
        let head_before = repo.head_commit().unwrap();

        let wt = mgr
            .create(&fx.project_id, "dirty task", None, None)
            .unwrap();
        let dir = PathBuf::from(&wt.path);
        let canon = std::fs::canonicalize(&dir).unwrap();

        // Unstaged modification counts as modified.
        std::fs::write(dir.join("file.txt"), "changed\n").unwrap();
        let s = mgr.dirty_summary(&wt.id).unwrap();
        assert_eq!((s.modified, s.staged, s.untracked), (1, 0, 0));

        // Staging moves it to staged; an untracked file counts as untracked.
        git(&dir, &["add", "."]);
        std::fs::write(dir.join("untracked.txt"), "oops\n").unwrap();
        assert_eq!(mgr.refresh_health(&wt.id).unwrap(), WorktreeHealth::Dirty);
        let s = mgr.dirty_summary(&wt.id).unwrap();
        assert_eq!((s.modified, s.staged, s.untracked), (0, 1, 1));
        assert!(s.raw.contains("untracked.txt"));

        // Dirty BLOCKS removal — there is no force path.
        let err = mgr.remove(&wt.id).unwrap_err();
        match err {
            CoreError::Blocked(msg) => {
                assert!(msg.contains("1 staged"), "{msg}");
                assert!(msg.contains("1 untracked"), "{msg}");
            }
            other => panic!("expected Blocked, got {other}"),
        }
        assert!(dir.is_dir());
        assert!(repo
            .worktree_list()
            .unwrap()
            .iter()
            .any(|i| i.path == canon));
        assert!(fx.db.get_worktree(&wt.id).is_ok());

        // Clean up inside the worktree; removal then succeeds.
        git(&dir, &["reset", "--hard", "HEAD"]);
        std::fs::remove_file(dir.join("untracked.txt")).unwrap();
        assert_eq!(mgr.refresh_health(&wt.id).unwrap(), WorktreeHealth::Clean);
        mgr.remove(&wt.id).unwrap();
        assert!(!dir.exists());
        assert!(!repo
            .worktree_list()
            .unwrap()
            .iter()
            .any(|i| i.path == canon));
        assert!(matches!(
            fx.db.get_worktree(&wt.id),
            Err(CoreError::NotFound(_))
        ));

        // Main checkout untouched: identical bytes and HEAD.
        assert_eq!(std::fs::read(&main_file).unwrap(), bytes_before);
        assert_eq!(repo.head_commit().unwrap(), head_before);
    }

    #[test]
    fn ignored_local_files_block_removal_and_are_reported_by_preflight() {
        let fx = fixture();
        let manager = mgr(&fx);
        std::fs::write(
            fx.repo_dir.join(".git/info/exclude"),
            ".agentport-local-secret\n",
        )
        .unwrap();
        let wt = manager
            .create(&fx.project_id, "ignored data", None, None)
            .unwrap();
        let local_file = Path::new(&wt.path).join(".agentport-local-secret");
        std::fs::write(&local_file, "mock-only-value\n").unwrap();

        let preflight = manager.deletion_preflight(&wt.id).unwrap();
        assert_eq!(preflight.health, WorktreeHealth::Dirty);
        assert_eq!(preflight.ignored, 1);
        assert_eq!(
            preflight.ignored_sample,
            vec![".agentport-local-secret".to_string()]
        );
        assert!(!preflight.can_remove);
        assert!(preflight
            .blockers
            .iter()
            .any(|blocker| blocker == "ignored_local_files"));

        let error = manager.remove(&wt.id).unwrap_err();
        assert!(matches!(error, CoreError::Blocked(_)), "{error}");
        assert!(error.to_string().contains("1 ignored"), "{error}");
        assert!(local_file.exists());
        assert!(fx.db.get_worktree(&wt.id).is_ok());

        std::fs::remove_file(local_file).unwrap();
        manager.remove(&wt.id).unwrap();
    }

    #[test]
    fn stale_tracking_config_is_cleared_for_a_recreated_auto_branch() {
        let fx = fixture();
        git(
            &fx.repo_dir,
            &["config", "branch.agent/stale-tracking.remote", "origin"],
        );
        git(
            &fx.repo_dir,
            &[
                "config",
                "branch.agent/stale-tracking.merge",
                "refs/heads/main",
            ],
        );

        let wt = mgr(&fx)
            .create(&fx.project_id, "stale tracking", None, None)
            .unwrap();
        assert_eq!(wt.branch, "agent/stale-tracking");
        assert!(run_git_at(
            &fx.repo_dir,
            &["config", "--get", "branch.agent/stale-tracking.remote"]
        )
        .is_err());
        assert!(run_git_at(
            &fx.repo_dir,
            &["config", "--get", "branch.agent/stale-tracking.merge"]
        )
        .is_err());
    }

    #[test]
    fn reconciles_only_unrecorded_worktrees_inside_agentport_owned_directory() {
        let fx = fixture();
        let owned_path = fx.paths.worktree_dir("main-api", "crash-recovery");
        std::fs::create_dir_all(owned_path.parent().unwrap()).unwrap();
        git(
            &fx.repo_dir,
            &[
                "worktree",
                "add",
                "--no-track",
                "-b",
                "agent/crash-recovery",
                owned_path.to_str().unwrap(),
                "HEAD",
            ],
        );
        let outside_path = fx._tmp.path().join("user-owned-worktree");
        git(
            &fx.repo_dir,
            &[
                "worktree",
                "add",
                "--no-track",
                "-b",
                "user/outside",
                outside_path.to_str().unwrap(),
                "HEAD",
            ],
        );

        let manager = mgr(&fx);
        assert_eq!(
            manager.reconcile_owned_worktrees(&fx.project_id).unwrap(),
            1
        );
        let worktrees = fx.db.list_worktrees(&fx.project_id).unwrap();
        assert_eq!(worktrees.len(), 1);
        assert_eq!(worktrees[0].branch, "agent/crash-recovery");
        assert!(same_path(Path::new(&worktrees[0].path), &owned_path));
        assert!(!worktrees
            .iter()
            .any(|worktree| same_path(Path::new(&worktree.path), &outside_path)));
        assert_eq!(
            manager.reconcile_owned_worktrees(&fx.project_id).unwrap(),
            0
        );
    }

    #[test]
    fn missing_worktree_pruned_on_remove() {
        let fx = fixture();
        let mgr = mgr(&fx);
        let repo = GitRepo::discover(&fx.repo_dir).unwrap();

        let wt = mgr.create(&fx.project_id, "gone task", None, None).unwrap();
        let dir = PathBuf::from(&wt.path);
        std::fs::remove_dir_all(&dir).unwrap(); // external deletion

        assert_eq!(mgr.refresh_health(&wt.id).unwrap(), WorktreeHealth::Missing);
        mgr.remove(&wt.id).unwrap(); // prune path: succeeds
        assert!(matches!(
            fx.db.get_worktree(&wt.id),
            Err(CoreError::NotFound(_))
        ));
        assert!(!repo
            .worktree_list()
            .unwrap()
            .iter()
            .any(|i| i.path == Path::new(&wt.path)));
    }

    #[test]
    fn locked_blocks_remove_until_unlock() {
        let fx = fixture();
        let mgr = mgr(&fx);

        let wt = mgr
            .create(&fx.project_id, "locked task", None, None)
            .unwrap();
        git(&fx.repo_dir, &["worktree", "lock", &wt.path]);
        assert_eq!(mgr.refresh_health(&wt.id).unwrap(), WorktreeHealth::Locked);

        let err = mgr.remove(&wt.id).unwrap_err();
        assert!(matches!(err, CoreError::Blocked(_)), "{err}");
        assert!(Path::new(&wt.path).is_dir());
        assert!(fx.db.get_worktree(&wt.id).is_ok());

        git(&fx.repo_dir, &["worktree", "unlock", &wt.path]);
        assert_eq!(mgr.refresh_health(&wt.id).unwrap(), WorktreeHealth::Clean);
        mgr.remove(&wt.id).unwrap();
        assert!(!Path::new(&wt.path).exists());
    }

    #[test]
    fn task_name_injection_is_argv_safe() {
        let fx = fixture();
        let mgr = mgr(&fx);
        let pwned = Path::new("/tmp/pwned");
        let _ = std::fs::remove_file(pwned);

        let wt = mgr
            .create(
                &fx.project_id,
                "evil; $(touch /tmp/pwned) && `id`",
                None,
                None,
            )
            .unwrap();
        // No shell was ever involved: nothing executed the injection string.
        assert!(!pwned.exists());
        assert!(wt.branch.starts_with("agent/"));
        assert!(wt
            .branch
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '/'));

        mgr.remove(&wt.id).unwrap(); // clean state for other runs
    }

    #[test]
    fn resolve_ref_rejects_unknown_ref() {
        let fx = fixture();
        let repo = GitRepo::discover(&fx.repo_dir).unwrap();
        let err = repo.resolve_ref("definitely-not-a-ref").unwrap_err();
        match err {
            CoreError::Git(msg) => assert!(msg.contains("rev-parse"), "{msg}"),
            other => panic!("expected Git error, got {other}"),
        }

        // Same through the manager: bad Base Ref fails before anything is made.
        let mgr = mgr(&fx);
        let err = mgr
            .create(
                &fx.project_id,
                "bad base",
                Some("definitely-not-a-ref"),
                None,
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::Git(_)), "{err}");
    }

    #[test]
    fn selected_branch_creation_trace_has_no_network_force_or_worktree_bypass() {
        let fx = fixture();
        git(&fx.repo_dir, &["branch", "trace-existing"]);
        let expected_oid = git(&fx.repo_dir, &["rev-parse", "refs/heads/trace-existing"])
            .trim()
            .to_owned();
        let (runner, recorded) = GitRunner::recording();

        mgr(&fx)
            .create_internal_with_runner(
                &fx.project_id,
                "trace existing",
                None,
                InternalWorktreeBranchSelection::Existing {
                    name: "trace-existing".into(),
                    expected_oid: Some(expected_oid),
                },
                &runner,
            )
            .unwrap();

        let recorded = recorded.lock().unwrap();
        assert!(recorded.iter().any(|argv| {
            argv.iter()
                .map(|arg| arg.to_string_lossy())
                .collect::<Vec<_>>()
                .windows(4)
                .any(|window| {
                    window[0] == "worktree" && window[1] == "add" && window[3] == "trace-existing"
                })
        }));
        for argv in recorded.iter() {
            let args = if argv.first().is_some_and(|arg| arg == "-C") {
                &argv[2..]
            } else {
                argv.as_slice()
            };
            let command = args.first().map(|arg| arg.to_string_lossy());
            assert!(
                !matches!(command.as_deref(), Some("fetch" | "pull" | "push")),
                "network command trace: {argv:?}"
            );
            assert!(
                args.iter().all(|arg| {
                    !matches!(
                        arg.to_string_lossy().as_ref(),
                        "--force" | "-f" | "--ignore-other-worktrees"
                    )
                }),
                "forbidden worktree bypass trace: {argv:?}"
            );
        }
    }

    #[test]
    fn selected_branch_move_during_worktree_add_is_verified_and_rolled_back() {
        let fx = fixture();
        let expected_oid = git(&fx.repo_dir, &["rev-parse", "HEAD"]).trim().to_owned();
        git(&fx.repo_dir, &["branch", "race-existing"]);
        git(&fx.repo_dir, &["switch", "-c", "race-move-source"]);
        commit_file(
            &fx.repo_dir,
            "race.txt",
            "external branch move\n",
            "race move",
        );
        let moved_oid = git(&fx.repo_dir, &["rev-parse", "HEAD"]).trim().to_owned();
        git(&fx.repo_dir, &["switch", "main"]);

        let runner =
            GitRunner::moving_ref_before_worktree_add("refs/heads/race-existing", &moved_oid);
        let error = mgr(&fx)
            .create_internal_with_runner(
                &fx.project_id,
                "race existing",
                None,
                InternalWorktreeBranchSelection::Existing {
                    name: "race-existing".into(),
                    expected_oid: Some(expected_oid.clone()),
                },
                &runner,
            )
            .unwrap_err();

        assert!(matches!(error, CoreError::Conflict(_)), "{error}");
        assert!(error.to_string().contains(&expected_oid));
        assert!(error.to_string().contains(&moved_oid));
        assert!(!fx.paths.worktree_dir("main-api", "race-existing").exists());
        assert!(mgr(&fx)
            .db
            .list_worktrees(&fx.project_id)
            .unwrap()
            .is_empty());
        assert!(!RepositoryIdentity::from_project(
            &fx.db.get_project(&fx.project_id).unwrap(),
            &GitRunner::default(),
        )
        .unwrap()
        .worktrees(&GitRunner::default())
        .unwrap()
        .into_iter()
        .any(|worktree| worktree.branch.as_deref() == Some("race-existing")));
    }

    #[test]
    fn database_failure_rolls_back_git_and_preserves_a_reused_empty_directory() {
        let fx = fixture();
        let task = "db conflict";
        let dir = fx.paths.worktree_dir("main-api", "db-conflict");
        std::fs::create_dir_all(&dir).unwrap();
        let canonical_dir = std::fs::canonicalize(&dir).unwrap();
        let base_commit = git(&fx.repo_dir, &["rev-parse", "HEAD"]).trim().to_owned();
        fx.db
            .insert_worktree(&Worktree {
                id: "wt_existing_record".into(),
                project_id: fx.project_id.clone(),
                branch: "recorded-only".into(),
                base_commit: base_commit.clone(),
                base_ref: None,
                path: canonical_dir.to_string_lossy().into_owned(),
                health: WorktreeHealth::Missing,
                created_at: Utc::now(),
            })
            .unwrap();

        let error = mgr(&fx)
            .create_selected(
                &fx.project_id,
                task,
                None,
                WorktreeBranchSelection::New {
                    name: "feature/db-conflict".into(),
                },
            )
            .unwrap_err();

        assert!(matches!(error, CoreError::Conflict(_)), "{error}");
        assert!(dir.is_dir());
        assert!(std::fs::read_dir(&dir).unwrap().next().is_none());
        assert!(!GitRepo::discover(&fx.repo_dir)
            .unwrap()
            .branch_exists("feature/db-conflict")
            .unwrap());
        assert!(!RepositoryIdentity::from_project(
            &fx.db.get_project(&fx.project_id).unwrap(),
            &GitRunner::default(),
        )
        .unwrap()
        .worktrees(&GitRunner::default())
        .unwrap()
        .into_iter()
        .any(|worktree| same_path(&worktree.path, &dir)));
    }

    #[test]
    fn parse_nul_worktree_list_blocks() {
        let raw = b"worktree /repo/main\0HEAD aaaa\0branch refs/heads/main\0\0\
                    worktree /repo/wt1\0HEAD bbbb\0detached\0locked reason\0\0\
                    worktree /repo/wt2\0HEAD cccc\0branch refs/heads/feat\0prunable gone\0";
        let list = worktree::parse_worktree_list_z(raw).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert!(!list[0].locked && !list[0].prunable);
        assert_eq!(list[1].branch, None); // detached
        assert!(list[1].locked);
        assert_eq!(list[2].branch.as_deref(), Some("feat"));
        assert!(list[2].prunable);
    }
}
