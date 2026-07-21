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
use std::path::{Path, PathBuf};
use std::process::Command;

pub mod worktree;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub xy: String,
    pub path: String,
    pub untracked: bool,
}

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
    /// `git status --porcelain=v1` raw text for "copy git status".
    pub raw: String,
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
    let dir;
    let mut argv: Vec<&str> = Vec::with_capacity(args.len() + 2);
    if let Some(d) = repo {
        dir = d.to_string_lossy().into_owned();
        argv.push("-C");
        argv.push(&dir);
    }
    argv.extend_from_slice(args);
    let mut child = Command::new("git")
        .args(&argv)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    // Drain both pipes concurrently so a chatty git can never deadlock us.
    let mut out_pipe = child.stdout.take().expect("piped");
    let mut err_pipe = child.stderr.take().expect("piped");
    let out_handle = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = std::io::Read::read_to_end(&mut out_pipe, &mut v);
        v
    });
    let err_handle = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = std::io::Read::read_to_end(&mut err_pipe, &mut v);
        v
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait()? {
            Some(s) => break s,
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CoreError::Timeout(format!(
                        "git {} timed out after {}s",
                        argv.join(" "),
                        timeout.as_secs()
                    )));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    };
    let stdout = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).into_owned();
    if !status.success() {
        let stderr = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).into_owned();
        return Err(CoreError::Git(format!(
            "git {} failed ({}): {}",
            argv.join(" "),
            status,
            stderr.trim()
        )));
    }
    Ok(stdout)
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
        let out = run_git_at(path, &["status", "--porcelain=v1"])?;
        Ok(worktree::parse_porcelain_status(&out))
    }

    pub fn worktree_list(&self) -> Result<Vec<GitWorktreeInfo>> {
        let out = run_git(Some(&self.root), &["worktree", "list", "--porcelain"])?;
        Ok(worktree::parse_worktree_list(&out))
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

impl<'a> WorktreeManager<'a> {
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
        let project = self.db.get_project(project_id)?;
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
        let repo = GitRepo::discover(Path::new(git_root))?;

        let task_slug = slugify(task_name);
        let (branch, create_branch) = match use_existing_branch {
            Some(b) if b.trim().is_empty() => {
                return Err(CoreError::Validation(
                    "use_existing_branch must not be empty".into(),
                ))
            }
            Some(b) => (b.to_string(), false),
            None => (format!("agent/{task_slug}"), true),
        };

        let exists = repo.branch_exists(&branch)?;
        if create_branch && exists {
            return Err(CoreError::Conflict(format!(
                "branch exists: {branch} — use existing?"
            )));
        }
        if !create_branch && !exists {
            return Err(CoreError::NotFound(format!("branch not found: {branch}")));
        }

        // Base: explicit ref (validated) or current HEAD.
        let base_commit = match base_ref {
            Some(r) => repo.resolve_ref(r)?,
            None => repo.head_commit()?,
        };

        let dir = self.paths.worktree_dir(&slugify(&project.name), &task_slug);
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

        if let Err(e) = repo.worktree_add(&dir, &branch, &base_commit, create_branch) {
            if owned {
                let _ = std::fs::remove_dir_all(&dir);
            }
            return Err(e);
        }

        // Store the canonical path: `git worktree list --porcelain` reports
        // canonical paths, and db uniqueness should match them.
        let canon = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        let wt = Worktree {
            id: new_id("wt"),
            project_id: project.id.clone(),
            branch: branch.clone(),
            base_commit,
            base_ref: base_ref.map(str::to_string),
            path: canon.to_string_lossy().into_owned(),
            health: WorktreeHealth::Clean,
            created_at: Utc::now(),
        };
        if let Err(e) = self.db.insert_worktree(&wt) {
            if owned {
                let _ = repo.worktree_remove(&canon);
                let _ = repo.worktree_prune();
                if canon.exists() {
                    let _ = std::fs::remove_dir_all(&canon);
                }
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
            } else if repo.status(path)?.raw.trim().is_empty() {
                WorktreeHealth::Clean
            } else {
                WorktreeHealth::Dirty
            }
        };
        self.db.set_worktree_health(worktree_id, health)?;
        Ok(health)
    }

    /// Safe delete (PRD 3.5 failure C): dirty/missing handling — dirty BLOCKS by
    /// default (no force button in P0/P1/P2); on success run `worktree remove`
    /// + prune, delete the db record, and verify the main checkout is untouched.
    pub fn remove(&self, worktree_id: &str) -> Result<()> {
        let health = self.refresh_health(worktree_id)?;
        let w = self.db.get_worktree(worktree_id)?;
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
            WorktreeHealth::Dirty => {
                let s = self.dirty_summary(worktree_id)?;
                Err(CoreError::Blocked(format!(
                    "worktree is dirty ({} modified, {} staged, {} untracked); \
                     commit or clean it up before removing: {}",
                    s.modified, s.staged, s.untracked, w.path
                )))
            }
            WorktreeHealth::Locked => Err(CoreError::Blocked(format!(
                "worktree is locked; unlock it outside AgentPort first: {}",
                w.path
            ))),
            WorktreeHealth::Missing => {
                repo.worktree_prune()?;
                self.db.delete_worktree(worktree_id)?;
                Ok(())
            }
            WorktreeHealth::Clean => {
                repo.worktree_remove(Path::new(&w.path))?;
                repo.worktree_prune()?;
                self.db.delete_worktree(worktree_id)?;
                Ok(())
            }
        }
    }

    pub fn dirty_summary(&self, worktree_id: &str) -> Result<DirtySummary> {
        let w = self.db.get_worktree(worktree_id)?;
        let path = Path::new(&w.path);
        let repo = GitRepo::discover(path)?;
        repo.status(path)
    }
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
            .any(|i| i.path == PathBuf::from(&wt.path)));
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
    fn parse_status_counts_xy_columns() {
        let s = worktree::parse_porcelain_status(" M a.txt\nM  b.txt\nMM c.txt\n?? new.txt\n");
        assert_eq!((s.modified, s.staged, s.untracked), (2, 2, 1));
        assert!(s.raw.contains("MM c.txt"));
        assert!(worktree::parse_porcelain_status("").raw.is_empty());
    }

    #[test]
    fn parse_worktree_list_blocks() {
        let raw = "worktree /repo/main\nHEAD aaaa\nbranch refs/heads/main\n\n\
                   worktree /repo/wt1\nHEAD bbbb\ndetached\nlocked reason\n\n\
                   worktree /repo/wt2\nHEAD cccc\nbranch refs/heads/feat\nprunable gone\n";
        let list = worktree::parse_worktree_list(raw);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert!(!list[0].locked && !list[0].prunable);
        assert_eq!(list[1].branch, None); // detached
        assert!(list[1].locked);
        assert_eq!(list[2].branch.as_deref(), Some("feat"));
        assert!(list[2].prunable);
    }
}
