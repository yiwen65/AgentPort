use super::command::GitRunner;
use super::repository::{repository_lock, RepositoryFileLock, RepositoryIdentity};
use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::models::{Lifecycle, Project, Worktree, WorktreeHealth};
use crate::paths::AppPaths;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GitContextLocator {
    Session {
        session_id: String,
    },
    ProjectMain {
        project_id: String,
    },
    Worktree {
        project_id: String,
        worktree_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCheckoutKind {
    Main,
    Worktree,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutTarget {
    pub project_id: String,
    pub kind: GitCheckoutKind,
    pub worktree_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutDescriptor {
    pub target: GitCheckoutTarget,
    pub checkout_id: String,
    pub repo_key: String,
    pub project_name: String,
    pub project_root: String,
    pub checkout_root: String,
    pub expected_branch: Option<String>,
    pub actual_branch: Option<String>,
    pub head_oid: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub ongoing_operation: Option<String>,
    pub has_remote: bool,
    pub remote: Option<String>,
    pub remote_url: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub worktree_health: Option<String>,
    pub live_session_ids: Vec<String>,
    pub writable: bool,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
pub struct ResolvedGitContext {
    pub descriptor: GitCheckoutDescriptor,
    pub identity: RepositoryIdentity,
    pub project: Project,
    pub worktree: Option<Worktree>,
}

pub struct GitWorkspaceManager<'a> {
    pub(crate) db: &'a Db,
    pub(crate) runner: GitRunner,
    pub(crate) commit_timeout: Duration,
    owned_worktrees_root: Option<PathBuf>,
}

impl<'a> GitWorkspaceManager<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self {
            db,
            runner: GitRunner::default(),
            commit_timeout: Duration::from_secs(120),
            owned_worktrees_root: None,
        }
    }

    /// Production command boundary: only Worktrees below AgentPort's managed
    /// data directory can be mutated. Persisted linked Worktrees elsewhere
    /// remain inspectable but are explicitly read-only.
    pub fn new_with_paths(db: &'a Db, paths: &AppPaths) -> Self {
        Self {
            db,
            runner: GitRunner::default(),
            commit_timeout: Duration::from_secs(120),
            owned_worktrees_root: Some(canonical_or_saved(&paths.worktrees_root())),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_commit_timeout(mut self, timeout: Duration) -> Self {
        self.commit_timeout = timeout;
        self
    }

    pub fn resolve(&self, locator: &GitContextLocator) -> Result<GitCheckoutDescriptor> {
        Ok(self.resolve_internal(locator)?.descriptor)
    }

    /// Accept an externally switched branch without touching the checkout.
    /// The caller must present the exact saved and registered branches it saw;
    /// any other blocker or intervening change keeps the Worktree read-only.
    pub fn adopt_current_worktree_branch(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_branch: &str,
        actual_branch: &str,
    ) -> Result<GitCheckoutDescriptor> {
        let initial = self.resolve_internal(locator)?;
        validate_branch_adoption(
            &initial,
            expected_checkout_id,
            expected_branch,
            actual_branch,
        )?;
        let lock = repository_lock(&initial.identity.repo_key);
        let _guard = lock.lock().unwrap();
        let _file_guard = RepositoryFileLock::acquire(&initial.identity.common_dir)?;

        let current = self.resolve_internal(locator)?;
        validate_branch_adoption(
            &current,
            expected_checkout_id,
            expected_branch,
            actual_branch,
        )?;
        let worktree = current.worktree.as_ref().ok_or_else(|| {
            CoreError::Validation("only a linked Worktree branch can be adopted".into())
        })?;
        self.db
            .update_worktree_branch_if(&worktree.id, expected_branch, actual_branch)?;

        let adopted = self.resolve_internal(locator)?.descriptor;
        if !adopted.writable
            || adopted.expected_branch.as_deref() != Some(actual_branch)
            || adopted.actual_branch.as_deref() != Some(actual_branch)
        {
            return Err(CoreError::Conflict(
                "Worktree branch changed again while accepting the current branch".into(),
            ));
        }
        Ok(adopted)
    }

    pub(crate) fn resolve_internal(
        &self,
        locator: &GitContextLocator,
    ) -> Result<ResolvedGitContext> {
        match locator {
            GitContextLocator::ProjectMain { project_id } => self.resolve_main(project_id),
            GitContextLocator::Worktree {
                project_id,
                worktree_id,
            } => self.resolve_worktree(project_id, worktree_id),
            GitContextLocator::Session { session_id } => {
                let session = self.db.get_session(session_id)?;
                let resolved = match session.worktree_id.as_deref() {
                    Some(worktree_id) => self.resolve_worktree(&session.project_id, worktree_id)?,
                    None => self.resolve_main(&session.project_id)?,
                };
                if Path::new(&session.cwd).is_dir() {
                    let cwd_identity =
                        RepositoryIdentity::discover(Path::new(&session.cwd), &self.runner)?;
                    if cwd_identity.repo_key != resolved.identity.repo_key
                        || cwd_identity.root != resolved.identity.root
                    {
                        return Err(CoreError::Conflict(format!(
                            "session {} cwd resolves to checkout {} but its saved Git context is {}",
                            session.id,
                            cwd_identity.root.display(),
                            resolved.identity.root.display()
                        )));
                    }
                }
                Ok(resolved)
            }
        }
    }

    fn resolve_main(&self, project_id: &str) -> Result<ResolvedGitContext> {
        let project = self.db.get_project(project_id)?;
        let identity = RepositoryIdentity::from_project(&project, &self.runner)?;
        let descriptor = self.descriptor(
            &project,
            None,
            &identity,
            identity.root.clone(),
            None,
            None,
            Vec::new(),
        )?;
        Ok(ResolvedGitContext {
            descriptor,
            identity,
            project,
            worktree: None,
        })
    }

    fn resolve_worktree(&self, project_id: &str, worktree_id: &str) -> Result<ResolvedGitContext> {
        let project = self.db.get_project(project_id)?;
        let worktree = self.db.get_worktree(worktree_id)?;
        if worktree.project_id != project.id {
            return Err(CoreError::Conflict(format!(
                "worktree {} belongs to project {}, not {}",
                worktree.id, worktree.project_id, project.id
            )));
        }
        let main_identity = RepositoryIdentity::from_project(&project, &self.runner)?;
        let saved_path = PathBuf::from(&worktree.path);
        let registered = main_identity
            .worktrees(&self.runner)?
            .into_iter()
            .find(|entry| same_worktree_path(&entry.path, &saved_path));
        if !saved_path.is_dir() {
            let mut blockers = vec!["worktree_missing".into()];
            let registered_branch = match registered {
                Some(entry) => {
                    if entry.prunable {
                        blockers.push("worktree_prunable".into());
                    }
                    entry.branch
                }
                None => {
                    blockers.push("worktree_not_registered".into());
                    None
                }
            };
            if registered_branch.as_deref() != Some(worktree.branch.as_str()) {
                blockers.push("worktree_branch_drift".into());
            }
            self.apply_ownership_blocker(&saved_path, &mut blockers);
            let descriptor = self.descriptor(
                &project,
                Some(&worktree),
                &main_identity,
                saved_path,
                Some(WorktreeHealth::Missing),
                registered_branch,
                std::mem::take(&mut blockers),
            )?;
            return Ok(ResolvedGitContext {
                descriptor,
                identity: main_identity,
                project,
                worktree: Some(worktree),
            });
        }

        let identity = RepositoryIdentity::discover(&saved_path, &self.runner)?;
        if identity.repo_key != main_identity.repo_key
            || identity.common_dir != main_identity.common_dir
        {
            return Err(CoreError::Conflict(format!(
                "worktree {} no longer belongs to project repository {}",
                worktree.id, project.id
            )));
        }
        let checkout_root = std::fs::canonicalize(&saved_path)?;
        if identity.root != checkout_root {
            return Err(CoreError::Conflict(format!(
                "worktree {} path resolves inside a different checkout: {}",
                worktree.id,
                identity.root.display()
            )));
        }
        let mut blockers = Vec::new();
        self.apply_ownership_blocker(&checkout_root, &mut blockers);
        let mut health = Some(worktree.health);
        let registered_branch = match registered {
            Some(entry) => {
                if entry.prunable {
                    blockers.push("worktree_prunable".into());
                }
                if entry.locked {
                    health = Some(WorktreeHealth::Locked);
                }
                entry.branch
            }
            None => {
                blockers.push("worktree_not_registered".into());
                None
            }
        };
        if registered_branch.as_deref() != Some(worktree.branch.as_str()) {
            blockers.push("worktree_branch_drift".into());
        }
        let descriptor = self.descriptor(
            &project,
            Some(&worktree),
            &identity,
            checkout_root,
            health,
            registered_branch,
            blockers,
        )?;
        Ok(ResolvedGitContext {
            descriptor,
            identity,
            project,
            worktree: Some(worktree),
        })
    }

    fn apply_ownership_blocker(&self, checkout: &Path, blockers: &mut Vec<String>) {
        let Some(owned_root) = self.owned_worktrees_root.as_deref() else {
            return;
        };
        let checkout = canonical_or_saved(checkout);
        if !checkout.starts_with(owned_root) {
            blockers.push("external_linked_worktree".into());
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn descriptor(
        &self,
        project: &Project,
        worktree: Option<&Worktree>,
        identity: &RepositoryIdentity,
        checkout_root: PathBuf,
        worktree_health: Option<WorktreeHealth>,
        registered_branch: Option<String>,
        blockers: Vec<String>,
    ) -> Result<GitCheckoutDescriptor> {
        let checkout_exists = checkout_root.is_dir();
        let actual_branch = if checkout_exists {
            self.symbolic_branch(&checkout_root)?
        } else {
            None
        };
        let head_oid = if checkout_exists {
            self.head_oid(&checkout_root)?
        } else {
            None
        };
        let unborn = head_oid.is_none();
        let detached = !unborn && actual_branch.is_none();
        let expected_branch = worktree.map(|value| value.branch.clone());
        let actual_branch = registered_branch.or(actual_branch);
        let remote = if checkout_exists {
            remote_state(&self.runner, &checkout_root, actual_branch.as_deref())
        } else {
            RemoteState::default()
        };
        let target = GitCheckoutTarget {
            project_id: project.id.clone(),
            kind: if worktree.is_some() {
                GitCheckoutKind::Worktree
            } else {
                GitCheckoutKind::Main
            },
            worktree_id: worktree.map(|value| value.id.clone()),
        };
        let checkout_id = checkout_id(&identity.repo_key, &checkout_root);
        let live_session_ids = self
            .db
            .list_sessions(Some(&project.id), false)?
            .into_iter()
            .filter(|session| matches!(session.lifecycle, Lifecycle::Creating | Lifecycle::Running))
            .filter(|session| match worktree {
                Some(worktree) => session.worktree_id.as_deref() == Some(worktree.id.as_str()),
                None => session.worktree_id.is_none(),
            })
            .map(|session| session.id)
            .collect::<Vec<_>>();
        let mut live_session_ids = live_session_ids;
        live_session_ids.sort();
        let mut warnings = Vec::new();
        if !live_session_ids.is_empty() {
            warnings.push("active_sessions".into());
        }
        if worktree_health == Some(WorktreeHealth::Locked) {
            warnings.push("worktree_locked".into());
        }
        Ok(GitCheckoutDescriptor {
            target,
            checkout_id,
            repo_key: identity.repo_key.clone(),
            project_name: project.name.clone(),
            project_root: project.root_path.clone(),
            checkout_root: checkout_root.to_string_lossy().into_owned(),
            expected_branch,
            actual_branch,
            head_oid,
            detached,
            unborn,
            ongoing_operation: checkout_exists
                .then(|| detect_operation(&identity.git_dir))
                .flatten(),
            has_remote: remote.has_remote,
            remote: remote.remote,
            remote_url: remote.remote_url,
            upstream: remote.upstream,
            ahead: remote.ahead,
            behind: remote.behind,
            worktree_health: worktree_health.map(|health| health.as_str().to_owned()),
            live_session_ids,
            writable: blockers.is_empty(),
            blockers,
            warnings,
        })
    }

    fn symbolic_branch(&self, checkout: &Path) -> Result<Option<String>> {
        let output = self.runner.run_read_only(
            Some(checkout),
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
        )?;
        if output.success() {
            return Ok(Some(output.stdout_lossy().trim().to_owned()));
        }
        Ok(None)
    }

    fn head_oid(&self, checkout: &Path) -> Result<Option<String>> {
        let output = self
            .runner
            .run_read_only(Some(checkout), ["rev-parse", "--verify", "HEAD"])?;
        if output.success() {
            return Ok(Some(output.stdout_lossy().trim().to_owned()));
        }
        Ok(None)
    }
}

#[derive(Default)]
struct RemoteState {
    has_remote: bool,
    remote: Option<String>,
    remote_url: Option<String>,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
}

fn validate_branch_adoption(
    resolved: &ResolvedGitContext,
    expected_checkout_id: &str,
    expected_branch: &str,
    actual_branch: &str,
) -> Result<()> {
    if resolved.worktree.is_none() {
        return Err(CoreError::Validation(
            "only a linked Worktree branch can be adopted".into(),
        ));
    }
    if resolved.descriptor.checkout_id != expected_checkout_id
        || resolved.descriptor.expected_branch.as_deref() != Some(expected_branch)
        || resolved.descriptor.actual_branch.as_deref() != Some(actual_branch)
    {
        return Err(CoreError::Conflict(
            "Worktree branch state changed; refresh before accepting it".into(),
        ));
    }
    if expected_branch == actual_branch
        || resolved.descriptor.blockers.as_slice() != ["worktree_branch_drift"]
    {
        return Err(CoreError::Blocked(
            "the Worktree is not blocked only by branch drift".into(),
        ));
    }
    Ok(())
}

fn remote_state(runner: &GitRunner, checkout: &Path, branch: Option<&str>) -> RemoteState {
    let remotes = runner
        .run_read_only(Some(checkout), ["remote"])
        .ok()
        .filter(|output| output.success())
        .map(|output| {
            output
                .stdout_lossy()
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let has_remote = !remotes.is_empty();
    let configured_remote = branch.and_then(|branch| {
        runner
            .run_read_only(
                Some(checkout),
                ["config", "--get", &format!("branch.{branch}.remote")],
            )
            .ok()
            .filter(|output| output.success())
            .map(|output| output.stdout_lossy().trim().to_owned())
            .filter(|value| !value.is_empty() && value != ".")
    });
    let remote = configured_remote
        .filter(|value| remotes.contains(value))
        .or_else(|| {
            remotes
                .iter()
                .find(|value| value.as_str() == "origin")
                .cloned()
        })
        .or_else(|| remotes.first().cloned());
    let remote_url = remote.as_deref().and_then(|name| {
        runner
            .run_read_only(Some(checkout), ["remote", "get-url", name])
            .ok()
            .filter(|output| output.success())
            .map(|output| output.stdout_lossy().trim().to_owned())
            .filter(|value| !value.is_empty())
    });
    let upstream = branch.and_then(|branch| {
        runner
            .run_read_only(
                Some(checkout),
                [
                    "for-each-ref",
                    "--format=%(upstream:short)",
                    &format!("refs/heads/{branch}"),
                ],
            )
            .ok()
            .filter(|output| output.success())
            .map(|output| output.stdout_lossy().trim().to_owned())
            .filter(|value| !value.is_empty())
    });
    let (ahead, behind) = upstream
        .as_deref()
        .and_then(|upstream| {
            runner
                .run_read_only(
                    Some(checkout),
                    [
                        "rev-list",
                        "--left-right",
                        "--count",
                        &format!("HEAD...{upstream}"),
                    ],
                )
                .ok()
                .filter(|output| output.success())
                .and_then(|output| {
                    let values = output
                        .stdout_lossy()
                        .split_whitespace()
                        .filter_map(|value| value.parse::<usize>().ok())
                        .collect::<Vec<_>>();
                    (values.len() == 2).then(|| (values[0], values[1]))
                })
        })
        .unwrap_or((0, 0));
    RemoteState {
        has_remote,
        remote,
        remote_url,
        upstream,
        ahead,
        behind,
    }
}

fn checkout_id(repo_key: &str, checkout_root: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(repo_key.as_bytes());
    hasher.update([0]);
    hasher.update(path_bytes(checkout_root));
    format!("{:x}", hasher.finalize())
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

fn canonical_or_saved(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn same_worktree_path(left: &Path, right: &Path) -> bool {
    canonical_or_saved(left) == canonical_or_saved(right)
}

fn detect_operation(git_dir: &Path) -> Option<String> {
    [
        ("rebase", "rebase-merge"),
        ("rebase", "rebase-apply"),
        ("merge", "MERGE_HEAD"),
        ("cherry_pick", "CHERRY_PICK_HEAD"),
        ("revert", "REVERT_HEAD"),
        ("bisect", "BISECT_LOG"),
        ("sequencer", "sequencer"),
    ]
    .into_iter()
    .find_map(|(name, marker)| git_dir.join(marker).exists().then(|| name.to_owned()))
}
