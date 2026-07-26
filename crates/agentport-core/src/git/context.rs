use super::command::GitRunner;
use super::repository::RepositoryIdentity;
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
