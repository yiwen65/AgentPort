use super::command::GitRunner;
use super::worktree::parse_worktree_list_z;
use super::GitWorktreeInfo;
use crate::error::{CoreError, Result};
use crate::models::Project;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const REPOSITORY_FILE_LOCK_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryIdentity {
    pub root: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    pub repo_key: String,
}

impl RepositoryIdentity {
    pub fn discover(path: &Path, runner: &GitRunner) -> Result<Self> {
        if !path.is_dir() {
            return Err(CoreError::Validation(format!(
                "not a directory: {}",
                path.display()
            )));
        }
        let output = runner
            .run(
                Some(path),
                [
                    "rev-parse",
                    "--path-format=absolute",
                    "--show-toplevel",
                    "--absolute-git-dir",
                    "--git-common-dir",
                ],
            )?
            .require_success()
            .map_err(|e| match e {
                CoreError::Git(message) => CoreError::NotFound(format!(
                    "not a git repository: {} ({message})",
                    path.display()
                )),
                other => other,
            })?;
        let lines = output
            .stdout
            .split(|byte| *byte == b'\n')
            .collect::<Vec<_>>();
        if lines.len() < 3 {
            return Err(CoreError::Internal(
                "git rev-parse returned an incomplete repository identity".into(),
            ));
        }
        let root = canonicalize_git_path(&bytes_to_path(lines[0]))?;
        let git_dir = canonicalize_git_path(&bytes_to_path(lines[1]))?;
        let common_dir = canonicalize_git_path(&bytes_to_path(lines[2]))?;
        let repo_key = format!("{:x}", Sha256::digest(path_bytes(&common_dir)));
        Ok(Self {
            root,
            git_dir,
            common_dir,
            repo_key,
        })
    }

    pub fn from_project(project: &Project, runner: &GitRunner) -> Result<Self> {
        let live = Self::discover(Path::new(&project.root_path), runner)?;
        let saved = match project
            .git_root_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
        {
            Some(saved) => std::fs::canonicalize(saved).map_err(|error| {
                CoreError::Conflict(format!(
                    "saved git root for project {} cannot be resolved: {error}",
                    project.id
                ))
            })?,
            None => {
                let project_root = std::fs::canonicalize(&project.root_path).map_err(|error| {
                    CoreError::Conflict(format!(
                        "project root for {} cannot be resolved: {error}",
                        project.id
                    ))
                })?;
                if live.root != project_root {
                    return Err(CoreError::Conflict(format!(
                        "project {} became part of Git root {} outside its saved permission boundary {}; re-add the project to approve that repository root",
                        project.id,
                        live.root.display(),
                        project_root.display()
                    )));
                }
                // A repository initialized exactly at an already-approved
                // project root does not widen the filesystem boundary.
                project_root
            }
        };
        if saved != live.root {
            return Err(CoreError::Conflict(format!(
                "repository identity drift for project {}: saved root {} but live root is {}",
                project.id,
                saved.display(),
                live.root.display()
            )));
        }
        Ok(live)
    }

    pub fn worktrees(&self, runner: &GitRunner) -> Result<Vec<GitWorktreeInfo>> {
        let output = runner
            .run(Some(&self.root), ["worktree", "list", "--porcelain", "-z"])?
            .require_success()?;
        parse_worktree_list_z(&output.stdout)
    }
}

pub struct RepositoryManager<'a> {
    db: &'a crate::db::Db,
    runner: GitRunner,
}

impl<'a> RepositoryManager<'a> {
    pub fn new(db: &'a crate::db::Db) -> Self {
        Self {
            db,
            runner: GitRunner::default(),
        }
    }

    pub fn discover_project(&self, project_id: &str) -> Result<RepositoryIdentity> {
        RepositoryIdentity::from_project(&self.db.get_project(project_id)?, &self.runner)
    }
}

static REPOSITORY_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

pub(crate) fn repository_lock(repo_key: &str) -> Arc<Mutex<()>> {
    REPOSITORY_LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .entry(repo_key.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Advisory lock shared by every AgentPort process operating on the same Git
/// common directory. The in-memory mutex above keeps threads in one process
/// ordered; this file lock closes the second-App/host-process gap.
///
/// The lock intentionally lives in the Git common directory rather than a
/// checkout-specific `.git` file so every linked worktree shares it.
pub struct RepositoryFileLock {
    file: File,
}

impl RepositoryFileLock {
    pub fn acquire(common_dir: &Path) -> Result<Self> {
        Self::acquire_with_timeout(common_dir, REPOSITORY_FILE_LOCK_TIMEOUT)
    }

    pub fn acquire_with_timeout(common_dir: &Path, timeout: Duration) -> Result<Self> {
        let canonical_common_dir = canonicalize_git_path(common_dir)?;
        let lock_path = canonical_common_dir.join("agentport-operation.lock");
        if let Ok(metadata) = std::fs::symlink_metadata(&lock_path) {
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(CoreError::Conflict(format!(
                    "repository operation lock is not a regular file: {}",
                    lock_path.display()
                )));
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .agentport_no_follow()
            .open(&lock_path)?;
        if !file.metadata()?.file_type().is_file() {
            return Err(CoreError::Conflict(format!(
                "repository operation lock did not open as a regular file: {}",
                lock_path.display()
            )));
        }
        let deadline = Instant::now() + timeout;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Self { file }),
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(CoreError::Timeout(format!(
                        "timed out waiting for repository operation lock: {}",
                        lock_path.display()
                    )));
                }
                Err(TryLockError::Error(error)) => return Err(CoreError::Io(error)),
            }
        }
    }
}

trait NoFollowOpenOptions {
    fn agentport_no_follow(&mut self) -> &mut Self;
}

#[cfg(unix)]
impl NoFollowOpenOptions for OpenOptions {
    fn agentport_no_follow(&mut self) -> &mut Self {
        use std::os::unix::fs::OpenOptionsExt;
        self.custom_flags(libc::O_NOFOLLOW)
    }
}

#[cfg(not(unix))]
impl NoFollowOpenOptions for OpenOptions {
    fn agentport_no_follow(&mut self) -> &mut Self {
        self
    }
}

impl Drop for RepositoryFileLock {
    fn drop(&mut self) {
        if let Err(error) = self.file.unlock() {
            tracing::warn!(%error, "failed to release repository operation file lock");
        }
    }
}

fn canonicalize_git_path(path: &Path) -> Result<PathBuf> {
    std::fs::canonicalize(path).map_err(|error| {
        CoreError::Internal(format!(
            "cannot canonicalize git path {}: {error}",
            path.display()
        ))
    })
}

#[cfg(unix)]
fn bytes_to_path(bytes: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
}

#[cfg(not(unix))]
fn bytes_to_path(bytes: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
}

#[cfg(unix)]
fn path_bytes(path: &Path) -> &[u8] {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes()
}

#[cfg(not(unix))]
fn path_bytes(path: &Path) -> &[u8] {
    path.to_string_lossy().as_bytes()
}
