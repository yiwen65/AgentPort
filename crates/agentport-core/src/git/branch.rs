use super::command::{GitOutput, GitRunner};
use super::operation::{
    AutoStash, BranchOperation, BranchOperationKind, BranchOperationPhase, OperationJournal,
    ReconcileReport, RestoreStrategy,
};
use super::repository::{repository_lock, RepositoryFileLock, RepositoryIdentity};
use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::models::Lifecycle;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Stable marker inside the blocked error raised when the merged-only delete
/// gate rejects a branch. Command layers use it to recognize that an explicit
/// force-delete retry (`delete_forced`) would succeed where `delete` refused;
/// keep the `ensure_merged_for_delete` message and this marker in sync.
pub const UNMERGED_DELETE_BLOCK_MARKER: &str = "is not merged into";

/// True when `error` is exactly the merged-only delete gate rejection, i.e.
/// the failure an explicit force delete is designed to override.
pub fn is_unmerged_delete_block(error: &CoreError) -> bool {
    matches!(error, CoreError::Blocked(message) if message.contains(UNMERGED_DELETE_BLOCK_MARKER))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum CheckoutState {
    Branch(String),
    Detached(String),
    Unborn(Option<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPath {
    pub path: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub unmerged: bool,
    pub submodule_dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub checkout: CheckoutState,
    pub paths: Vec<StatusPath>,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub unmerged: bool,
    pub dirty_submodule: bool,
    pub operation_state: Option<String>,
}

impl RepoStatus {
    pub fn is_dirty(&self) -> bool {
        self.staged || self.unstaged || self.untracked || self.unmerged || self.dirty_submodule
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub oid: String,
    pub current: bool,
    pub occupied_worktree: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchOutcome {
    pub operation_id: String,
    pub branch: BranchInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchOutcome {
    pub operation_id: String,
    pub branch_name: String,
    pub deleted_oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSnapshot {
    pub repository_root: String,
    pub repo_key: String,
    pub status: RepoStatus,
    pub branches: Vec<BranchInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchOutcome {
    pub operation_id: String,
    pub source: CheckoutState,
    pub target_branch: String,
    pub stashed: bool,
    pub restored: bool,
    pub pending_restore: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotPath {
    path: String,
    staged: bool,
    unstaged: bool,
    untracked: bool,
    worktree_hash: Option<String>,
    #[serde(default)]
    worktree_mode: Option<u32>,
    index_oid: Option<String>,
    #[serde(default)]
    index_mode: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SnapshotWorktree {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    locked: bool,
    prunable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorktreeSnapshot {
    #[serde(default)]
    status: Option<RepoStatus>,
    #[serde(default)]
    worktrees: Vec<SnapshotWorktree>,
    #[serde(default)]
    live_session_ids: Vec<String>,
    #[serde(default)]
    paths: Vec<SnapshotPath>,
    #[serde(default)]
    ignored: Vec<SnapshotPath>,
}

#[derive(Debug, Clone)]
struct StashRecord {
    selector: String,
    oid: String,
    message: String,
}

#[derive(Debug, Clone)]
struct ParsedStashMarker {
    operation_id: String,
    repo_key: String,
    source: String,
    source_oid: Option<String>,
    target: String,
    target_oid: Option<String>,
    created_at: chrono::DateTime<Utc>,
}

#[derive(Debug)]
enum ExactRefObservation {
    Present(String),
    Absent,
    Unknown(String),
}

pub struct BranchManager<'a> {
    db: &'a Db,
    runner: GitRunner,
}

impl<'a> BranchManager<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self {
            db,
            runner: GitRunner::default(),
        }
    }

    pub fn list(&self, project_id: &str) -> Result<BranchSnapshot> {
        let identity = self.identity(project_id)?;
        let status = self.status(&identity)?;
        let branches = self.list_branches(&identity)?;
        Ok(BranchSnapshot {
            repository_root: identity.root.to_string_lossy().into_owned(),
            repo_key: identity.repo_key,
            status,
            branches,
        })
    }

    pub fn create(
        &self,
        project_id: &str,
        name: &str,
        start_point: Option<&str>,
    ) -> Result<CreateBranchOutcome> {
        let identity = self.identity(project_id)?;
        let lock = repository_lock(&identity.repo_key);
        let _guard = lock.lock().unwrap();
        let identity = self.identity(project_id)?;
        let _file_guard = RepositoryFileLock::acquire(&identity.common_dir)?;
        let identity = self.identity(project_id)?;
        self.create_locked(project_id, name, start_point, identity)
    }

    fn create_locked(
        &self,
        project_id: &str,
        name: &str,
        start_point: Option<&str>,
        identity: RepositoryIdentity,
    ) -> Result<CreateBranchOutcome> {
        self.validate_branch_name(&identity, name)?;
        let status = self.status(&identity)?;
        self.ensure_operation_conflicts(&status)?;
        self.ensure_checkout_state_allowed(&status)?;
        let before = self.list_branches(&identity)?;
        if before.iter().any(|branch| branch.name == name) {
            return Err(CoreError::Conflict(format!(
                "branch already exists: {name}"
            )));
        }
        let expected_oid = if let Some(start) = start_point {
            self.validate_branch_name(&identity, start)?;
            before
                .iter()
                .find(|branch| branch.name == start)
                .map(|branch| branch.oid.clone())
                .ok_or_else(|| {
                    CoreError::NotFound(format!(
                        "local start branch {start}; remote revisions are not accepted"
                    ))
                })?
        } else {
            self.run_success(&identity, ["rev-parse", "HEAD"])?
                .stdout_lossy()
                .trim()
                .to_owned()
        };
        let source_commit = self
            .run_success(&identity, ["rev-parse", "HEAD"])?
            .stdout_lossy()
            .trim()
            .to_owned();
        let operation_id = format!("op_{}", uuid::Uuid::new_v4().simple());
        let now = Utc::now();
        let journal = OperationJournal::new(self.db);
        journal.insert(&BranchOperation {
            id: operation_id.clone(),
            kind: BranchOperationKind::Create,
            project_id: project_id.to_owned(),
            repo_key: identity.repo_key.clone(),
            checkout_root: identity.root.to_string_lossy().into_owned(),
            source_branch: match &status.checkout {
                CheckoutState::Branch(branch) => Some(branch.clone()),
                CheckoutState::Detached(_) | CheckoutState::Unborn(_) => None,
            },
            source_commit: source_commit.clone(),
            target_branch: name.to_owned(),
            target_oid: expected_oid.clone(),
            phase: BranchOperationPhase::Prepared,
            stash_oid: None,
            stash_selector: None,
            stash_marker: None,
            snapshot_json: Some(serde_json::to_string(&status)?),
            error_json: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        })?;
        // Create the exact local ref only if it is still absent. A porcelain
        // `git branch` failure followed by observing the expected OID is
        // ambiguous: another Git client may have won the same-name/same-OID
        // race. The expected-absent CAS gives this operation unambiguous
        // ownership of the ref before create-and-switch may roll it back.
        let full_ref = format!("refs/heads/{name}");
        let result = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("update-ref"),
                OsString::from(&full_ref),
                OsString::from(&expected_oid),
                OsString::new(),
            ],
        );
        let created = self
            .list_branches(&identity)?
            .into_iter()
            .find(|branch| branch.name == name)
            .filter(|branch| branch.oid == expected_oid);
        match (result, created) {
            (Ok(output), Some(branch)) if output.success() => {
                let observed_status = self.status(&identity)?;
                let observed_head = self
                    .run_success(&identity, ["rev-parse", "HEAD"])?
                    .stdout_lossy()
                    .trim()
                    .to_owned();
                if observed_head != source_commit {
                    journal.update(
                        &operation_id,
                        BranchOperationPhase::RecoveryRequired,
                        None,
                        Some("creating a branch unexpectedly changed checkout HEAD"),
                        Some("create postcondition failed"),
                    )?;
                    return Err(CoreError::Conflict(
                        "local branch was created but checkout HEAD changed externally".into(),
                    ));
                }
                journal.update(
                    &operation_id,
                    BranchOperationPhase::Completed,
                    None,
                    None,
                    Some("local branch ref created without switching checkout"),
                )?;
                self.record_observation(
                    &journal,
                    &operation_id,
                    BranchOperationPhase::Completed,
                    &observed_status,
                    &observed_head,
                    "post-create HEAD/status verified",
                )?;
                Ok(CreateBranchOutcome {
                    operation_id,
                    branch,
                })
            }
            (Ok(output), observed) => {
                let error = if output.success() {
                    CoreError::Conflict(format!(
                        "created branch {name} changed before its result could be verified"
                    ))
                } else {
                    output.require_success().err().unwrap_or_else(|| {
                        CoreError::Internal(format!(
                            "branch {name} creation failed with an unknown result"
                        ))
                    })
                };
                let detail = if observed.is_some() {
                    "expected-absent branch create lost ownership; observed ref retained"
                } else {
                    "local branch ref was not created"
                };
                journal.update(
                    &operation_id,
                    BranchOperationPhase::Failed,
                    None,
                    Some(&error.to_string()),
                    Some(detail),
                )?;
                Err(error)
            }
            (Err(error), observed) => {
                let detail = if observed.is_some() {
                    "branch create command was ambiguous; observed ref retained as externally owned"
                } else {
                    "local branch create command could not be observed as successful"
                };
                journal.update(
                    &operation_id,
                    BranchOperationPhase::Failed,
                    None,
                    Some(&error.to_string()),
                    Some(detail),
                )?;
                Err(error)
            }
        }
    }

    /// Create a local branch and switch to it while holding one repository
    /// reservation. AgentPort Session launch uses the same common-dir lock, so
    /// a new Creating/Running Session cannot enter between the ref creation and
    /// the checkout mutation.
    pub fn create_and_switch(
        &self,
        project_id: &str,
        name: &str,
        start_point: Option<&str>,
    ) -> Result<SwitchOutcome> {
        let identity = self.identity(project_id)?;
        let lock = repository_lock(&identity.repo_key);
        let _guard = lock.lock().unwrap();
        let identity = self.identity(project_id)?;
        let _file_guard = RepositoryFileLock::acquire(&identity.common_dir)?;
        let identity = self.identity(project_id)?;
        let created = self.create_locked(project_id, name, start_point, identity.clone())?;
        match self.switch_locked(project_id, name, identity.clone()) {
            Ok(outcome) => Ok(outcome),
            Err(switch_error) => match self.rollback_created_branch(
                &identity,
                name,
                &created.branch.oid,
            ) {
                Ok(()) => Err(switch_error),
                Err(rollback_error) => Err(CoreError::Git(format!(
                    "create-and-switch failed: {switch_error}; the new branch could not be safely rolled back: {rollback_error}"
                ))),
            },
        }
    }

    fn rollback_created_branch(
        &self,
        identity: &RepositoryIdentity,
        name: &str,
        expected_oid: &str,
    ) -> Result<()> {
        // A non-terminal switch operation may retain an automatic stash whose
        // source/target recovery still depends on this ref. In that case the
        // safe outcome is to keep the new branch and expose recovery, not to
        // satisfy atomic appearance by breaking the recovery journal.
        self.ensure_branch_not_referenced(identity, name, None)?;
        let Some(branch) = self.local_branch(identity, name)? else {
            return Ok(());
        };
        if branch.current || branch.occupied_worktree.is_some() || branch.oid != expected_oid {
            return Err(CoreError::Conflict(format!(
                "new branch {name} changed or became checked out before rollback"
            )));
        }
        let full_ref = format!("refs/heads/{name}");
        let result = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("update-ref"),
                OsString::from("-d"),
                OsString::from(&full_ref),
                OsString::from(expected_oid),
            ],
        );
        match self.local_branch(identity, name)? {
            None => {
                let occupied = identity
                    .worktrees(&self.runner)?
                    .into_iter()
                    .find(|worktree| worktree.branch.as_deref() == Some(name));
                if let Some(worktree) = occupied {
                    // `update-ref -d` does not reserve external worktree
                    // creation. If another Git client checked out the branch
                    // during the deletion CAS, restore the exact ref only
                    // while it is still absent and report the race.
                    let restore = self.runner.run(
                        Some(&identity.root),
                        [
                            OsString::from("update-ref"),
                            OsString::from(&full_ref),
                            OsString::from(expected_oid),
                            OsString::new(),
                        ],
                    );
                    let restored = matches!(
                        self.observe_exact_ref(identity, name),
                        ExactRefObservation::Present(ref oid) if oid == expected_oid
                    );
                    if restored {
                        return Err(CoreError::Blocked(format!(
                            "new branch {name} became checked out in {} during rollback; its ref was restored",
                            worktree.path.display()
                        )));
                    }
                    let restore_error = match restore {
                        Ok(output) => output
                            .require_success()
                            .err()
                            .map(|error| error.to_string()),
                        Err(error) => Some(error.to_string()),
                    }
                    .unwrap_or_else(|| "restored ref could not be verified".into());
                    return Err(CoreError::Conflict(format!(
                        "new branch {name} became checked out during rollback and its ref could not be restored safely: {restore_error}"
                    )));
                }
                Ok(())
            }
            Some(remaining) if remaining.oid != expected_oid => Err(CoreError::Conflict(format!(
                "new branch {name} moved during rollback; the moved ref was retained"
            ))),
            Some(_) => match result {
                Ok(output) => output.require_success().map(|_| ()),
                Err(error) => Err(error),
            },
        }
    }

    /// Delete one exact, fully merged local branch ref.
    ///
    /// The ancestry check is performed against immutable OIDs and deletion is
    /// an expected-OID `update-ref` compare-and-swap. This gives `branch -d`
    /// semantics without the ref-read/ref-delete race in that porcelain
    /// command; this method never performs an unconditional/forced ref write.
    pub fn delete(&self, project_id: &str, name: &str) -> Result<DeleteBranchOutcome> {
        self.delete_with_mode(project_id, name, false)
    }

    /// Delete one exact local branch ref regardless of merge state.
    ///
    /// This is the `branch -D` counterpart of `delete`: it skips only the
    /// merged-ancestry gate so abandoned (e.g. backup) branches can be
    /// removed. Every other guard still applies — the branch must not be the
    /// current checkout, must not occupy a worktree, must not be referenced
    /// by an unfinished operation, and deletion remains a journaled
    /// expected-OID compare-and-swap.
    pub fn delete_forced(&self, project_id: &str, name: &str) -> Result<DeleteBranchOutcome> {
        self.delete_with_mode(project_id, name, true)
    }

    fn delete_with_mode(
        &self,
        project_id: &str,
        name: &str,
        force: bool,
    ) -> Result<DeleteBranchOutcome> {
        let identity = self.identity(project_id)?;
        let lock = repository_lock(&identity.repo_key);
        let _guard = lock.lock().unwrap();
        let identity = self.identity(project_id)?;
        let _file_guard = RepositoryFileLock::acquire(&identity.common_dir)?;
        let identity = self.identity(project_id)?;
        self.validate_branch_name(&identity, name)?;

        let status = self.status(&identity)?;
        self.ensure_delete_allowed(&status)?;
        if matches!(&status.checkout, CheckoutState::Branch(current) if current == name) {
            return Err(CoreError::Blocked(format!(
                "cannot delete the currently checked out branch {name}"
            )));
        }

        let branches = self.list_branches(&identity)?;
        let target = branches
            .iter()
            .find(|branch| branch.name == name)
            .cloned()
            .ok_or_else(|| CoreError::NotFound(format!("local branch {name}")))?;
        if target.current {
            return Err(CoreError::Blocked(format!(
                "cannot delete the currently checked out branch {name}"
            )));
        }
        if let Some(path) = &target.occupied_worktree {
            return Err(CoreError::Blocked(format!(
                "cannot delete branch {name}; it is checked out in worktree {path}"
            )));
        }
        self.ensure_branch_not_referenced(&identity, name, None)?;

        let source_commit = self
            .run_success(&identity, ["rev-parse", "HEAD"])?
            .stdout_lossy()
            .trim()
            .to_owned();
        let source_branch = match &status.checkout {
            CheckoutState::Branch(branch) => Some(branch.clone()),
            CheckoutState::Detached(_) => None,
            CheckoutState::Unborn(_) => unreachable!("blocked by ensure_delete_allowed"),
        };
        // Deleting a ref never writes the index or worktree. Preserve the
        // machine-readable status/worktree/session snapshot for drift checks,
        // but do not hash dirty and ignored trees (node_modules and build
        // outputs can be enormous and are outside this operation's write set).
        let snapshot = self.capture_snapshot(&identity, &status, false)?;
        let operation_id = format!("op_{}", uuid::Uuid::new_v4().simple());
        let now = Utc::now();
        let journal = OperationJournal::new(self.db);
        journal.insert(&BranchOperation {
            id: operation_id.clone(),
            kind: BranchOperationKind::Delete,
            project_id: project_id.to_owned(),
            repo_key: identity.repo_key.clone(),
            checkout_root: identity.root.to_string_lossy().into_owned(),
            source_branch,
            source_commit: source_commit.clone(),
            target_branch: name.to_owned(),
            target_oid: target.oid.clone(),
            phase: BranchOperationPhase::Prepared,
            stash_oid: None,
            stash_selector: None,
            stash_marker: None,
            snapshot_json: Some(serde_json::to_string(&snapshot)?),
            error_json: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        })?;

        // External Git clients do not honor AgentPort's advisory lock. Re-read
        // the exact ref and mutation blockers after the durable journal write.
        let refreshed_identity = match self.identity(project_id) {
            Ok(identity) => identity,
            Err(error) => {
                journal.update(
                    &operation_id,
                    BranchOperationPhase::Failed,
                    None,
                    Some(&error.to_string()),
                    Some("repository identity refresh failed before delete CAS"),
                )?;
                return Err(error);
            }
        };
        if refreshed_identity != identity {
            journal.update(
                &operation_id,
                BranchOperationPhase::Failed,
                None,
                Some("repository identity changed before local branch deletion"),
                Some("delete repository identity drift detected"),
            )?;
            return Err(CoreError::Conflict(
                "repository identity changed before local branch deletion".into(),
            ));
        }
        if let Err(error) =
            self.ensure_branch_not_referenced(&refreshed_identity, name, Some(&operation_id))
        {
            journal.update(
                &operation_id,
                BranchOperationPhase::Failed,
                None,
                Some(&error.to_string()),
                Some("delete blocked by another unfinished branch operation"),
            )?;
            return Err(error);
        }

        let refreshed_status = match self.status(&refreshed_identity) {
            Ok(status) => status,
            Err(error) => {
                journal.update(
                    &operation_id,
                    BranchOperationPhase::Failed,
                    None,
                    Some(&error.to_string()),
                    Some("repository status refresh failed before delete CAS"),
                )?;
                return Err(error);
            }
        };
        if let Err(error) = self.ensure_delete_allowed(&refreshed_status) {
            journal.update(
                &operation_id,
                BranchOperationPhase::Failed,
                None,
                Some(&error.to_string()),
                Some("repository state blocked delete before CAS"),
            )?;
            return Err(error);
        }
        if matches!(&refreshed_status.checkout, CheckoutState::Branch(current) if current == name) {
            journal.update(
                &operation_id,
                BranchOperationPhase::Failed,
                None,
                Some("target branch became the current checkout before deletion"),
                Some("delete blocked after current checkout changed"),
            )?;
            return Err(CoreError::Blocked(format!(
                "cannot delete the currently checked out branch {name}"
            )));
        }

        let refreshed_target = match self.local_branch(&refreshed_identity, name) {
            Ok(target) => target,
            Err(error) => {
                journal.update(
                    &operation_id,
                    BranchOperationPhase::Failed,
                    None,
                    Some(&error.to_string()),
                    Some("exact local branch refresh failed before delete CAS"),
                )?;
                return Err(error);
            }
        };
        if refreshed_target.is_none() {
            self.finish_missing_delete_ref(
                &refreshed_identity,
                &journal,
                &operation_id,
                name,
                &target.oid,
                &snapshot,
            )?;
            return Ok(DeleteBranchOutcome {
                operation_id,
                branch_name: name.to_owned(),
                deleted_oid: target.oid,
            });
        }
        let refreshed_target = refreshed_target.expect("checked above");
        if refreshed_target.oid != target.oid {
            let error = CoreError::Conflict(format!(
                "local branch {name} moved before deletion; expected {}, observed {}",
                target.oid, refreshed_target.oid
            ));
            journal.update(
                &operation_id,
                BranchOperationPhase::Failed,
                None,
                Some(&error.to_string()),
                Some("expected local branch OID changed before CAS deletion"),
            )?;
            return Err(error);
        }
        if refreshed_target.current || refreshed_target.occupied_worktree.is_some() {
            let error = CoreError::Blocked(format!(
                "cannot delete branch {name}; it became checked out in a worktree"
            ));
            journal.update(
                &operation_id,
                BranchOperationPhase::Failed,
                None,
                Some(&error.to_string()),
                Some("delete blocked after worktree occupancy changed"),
            )?;
            return Err(error);
        }

        if !force {
            let merge_target_oid = match self.delete_merge_target_oid(&refreshed_identity, name) {
                Ok(oid) => oid,
                Err(CoreError::NotFound(_))
                    if matches!(
                        self.observe_exact_ref(&refreshed_identity, name),
                        ExactRefObservation::Absent
                    ) =>
                {
                    self.finish_missing_delete_ref(
                        &refreshed_identity,
                        &journal,
                        &operation_id,
                        name,
                        &target.oid,
                        &snapshot,
                    )?;
                    return Ok(DeleteBranchOutcome {
                        operation_id,
                        branch_name: name.to_owned(),
                        deleted_oid: target.oid,
                    });
                }
                Err(error) => {
                    journal.update(
                        &operation_id,
                        BranchOperationPhase::Failed,
                        None,
                        Some(&error.to_string()),
                        Some("could not resolve immutable delete merge target"),
                    )?;
                    return Err(error);
                }
            };
            if let Err(error) = self.ensure_merged_for_delete(
                &refreshed_identity,
                name,
                &target.oid,
                &merge_target_oid,
            ) {
                journal.update(
                    &operation_id,
                    BranchOperationPhase::Failed,
                    None,
                    Some(&error.to_string()),
                    Some("merged-only ancestry check rejected local branch deletion"),
                )?;
                return Err(error);
            }
        }

        let full_ref = format!("refs/heads/{name}");
        let result = self.runner.run(
            Some(&refreshed_identity.root),
            [
                OsString::from("update-ref"),
                OsString::from("-d"),
                OsString::from(&full_ref),
                OsString::from(&target.oid),
            ],
        );

        // A timeout/error is not proof that update-ref made no change. The
        // exact ref is authoritative. Once absent, unrelated HEAD/status/live
        // Session drift is observation only and must not turn success into a
        // false failure.
        let remaining_oid = match self.local_branch(&refreshed_identity, name) {
            Ok(Some(branch)) => Some(branch.oid),
            Ok(None) => None,
            Err(primary_error) => match self.observe_exact_ref(&refreshed_identity, name) {
                ExactRefObservation::Present(oid) => Some(oid),
                ExactRefObservation::Absent => None,
                ExactRefObservation::Unknown(fallback_error) => {
                    let error = CoreError::Git(format!(
                        "delete CAS outcome could not be determined: primary observation failed: {primary_error}; exact fallback failed: {fallback_error}"
                    ));
                    journal.update(
                        &operation_id,
                        BranchOperationPhase::RecoveryRequired,
                        None,
                        Some(&error.to_string()),
                        Some("post-CAS exact local ref state is unknown"),
                    )?;
                    return Err(error);
                }
            },
        };
        if remaining_oid.is_none() {
            self.finish_missing_delete_ref(
                &refreshed_identity,
                &journal,
                &operation_id,
                name,
                &target.oid,
                &snapshot,
            )?;
            return Ok(DeleteBranchOutcome {
                operation_id,
                branch_name: name.to_owned(),
                deleted_oid: target.oid,
            });
        }

        let remaining_oid = remaining_oid.expect("checked above");
        let error = if remaining_oid != target.oid {
            CoreError::Conflict(format!(
                "local branch {name} moved during deletion; expected {}, observed {}; CAS retained the moved ref",
                target.oid, remaining_oid
            ))
        } else {
            match result {
                Ok(output) => output.require_success().err().unwrap_or_else(|| {
                    CoreError::Internal(format!(
                        "local branch {name} remained after the expected-OID CAS reported success"
                    ))
                }),
                Err(error) => error,
            }
        };
        journal.update(
            &operation_id,
            BranchOperationPhase::Failed,
            None,
            Some(&error.to_string()),
            Some("expected-OID CAS retained the local branch ref"),
        )?;
        Err(error)
    }

    pub fn switch(&self, project_id: &str, target: &str) -> Result<SwitchOutcome> {
        let identity = self.identity(project_id)?;
        let lock = repository_lock(&identity.repo_key);
        let _guard = lock.lock().unwrap();
        let identity = self.identity(project_id)?;
        let _file_guard = RepositoryFileLock::acquire(&identity.common_dir)?;
        let identity = self.identity(project_id)?;
        self.switch_locked(project_id, target, identity)
    }

    fn switch_locked(
        &self,
        project_id: &str,
        target: &str,
        identity: RepositoryIdentity,
    ) -> Result<SwitchOutcome> {
        self.validate_branch_name(&identity, target)?;
        let status = self.status(&identity)?;
        self.ensure_operation_conflicts(&status)?;
        let branches = self.list_branches(&identity)?;
        let target_info = match branches.iter().find(|branch| branch.name == target) {
            Some(branch) => branch,
            None if matches!(status.checkout, CheckoutState::Unborn(_)) => {
                self.ensure_checkout_state_allowed(&status)?;
                unreachable!("unborn checkout validation always blocks")
            }
            None => return Err(CoreError::NotFound(format!("local branch {target}"))),
        };
        if let Some(path) = &target_info.occupied_worktree {
            if canonical_or_original(Path::new(path)) != identity.root {
                return Err(CoreError::Blocked(format!(
                    "branch {target} is checked out in linked worktree {path}"
                )));
            }
        }
        self.ensure_checkout_state_allowed(&status)?;
        if matches!(&status.checkout, CheckoutState::Branch(branch) if branch == target) {
            return Err(CoreError::Conflict(format!(
                "branch {target} is already checked out"
            )));
        }
        self.ensure_no_ignored_collision(&identity, target)?;

        let source_commit = self
            .run_success(&identity, ["rev-parse", "HEAD"])?
            .stdout_lossy()
            .trim()
            .to_owned();
        let source_branch = match &status.checkout {
            CheckoutState::Branch(branch) => Some(branch.clone()),
            CheckoutState::Detached(_) => None,
            CheckoutState::Unborn(_) => unreachable!("blocked by ensure_mutation_allowed"),
        };
        let operation_id = format!("op_{}", uuid::Uuid::new_v4().simple());
        let dirty = status.is_dirty();
        let snapshot = self.capture_snapshot(&identity, &status, dirty)?;
        let now = Utc::now();
        let marker = format!(
            "agentport:v1:op={operation_id}:repo={}:source={}:sourceOid={source_commit}:target={target}:targetOid={}:at={}",
            identity.repo_key,
            source_branch
                .as_deref()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("DETACHED@{source_commit}")),
            target_info.oid,
            now.to_rfc3339_opts(SecondsFormat::Millis, true)
        );
        let journal = OperationJournal::new(self.db);
        journal.insert(&BranchOperation {
            id: operation_id.clone(),
            kind: BranchOperationKind::Switch,
            project_id: project_id.to_owned(),
            repo_key: identity.repo_key.clone(),
            checkout_root: identity.root.to_string_lossy().into_owned(),
            source_branch,
            source_commit: source_commit.clone(),
            target_branch: target.to_owned(),
            target_oid: target_info.oid.clone(),
            phase: BranchOperationPhase::Prepared,
            stash_oid: None,
            stash_selector: None,
            // Persist the marker before invoking stash so a process exit
            // between Git success and the next DB update is recoverable.
            stash_marker: dirty.then(|| marker.clone()),
            snapshot_json: Some(serde_json::to_string(&snapshot)?),
            error_json: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        })?;

        let mut stashed = false;
        if dirty {
            let stash_before = self.stash_tip(&identity)?;
            let stash_result = self.runner.run(
                Some(&identity.root),
                [
                    "stash",
                    "push",
                    "--include-untracked",
                    "-m",
                    marker.as_str(),
                ],
            );
            // Even an I/O error or timeout can arrive after Git changed the
            // repository. Resolve the marker and refs/stash before deciding.
            let stash_after = self.stash_tip(&identity)?;
            let stash = self.find_stash(&identity, &marker, stash_after.as_deref())?;
            let stash = match stash {
                Some(stash) if Some(stash.oid.as_str()) != stash_before.as_deref() => stash,
                _ => {
                    return match stash_result {
                        Ok(output) => {
                            output.require_success()?;
                            Err(CoreError::Internal(
                                "git stash did not create a uniquely identifiable stash".into(),
                            ))
                        }
                        Err(error) => Err(error),
                    };
                }
            };
            journal.update(
                &operation_id,
                BranchOperationPhase::Stashed,
                Some((&stash.oid, &stash.selector, &marker)),
                None,
                Some("dirty state stashed"),
            )?;
            stashed = true;

            if let Some(error) = git_result_error(stash_result) {
                journal.update(
                    &operation_id,
                    BranchOperationPhase::RecoveryRequired,
                    None,
                    Some(&error.to_string()),
                    Some("stash command reported failure after a stash was observed"),
                )?;
                let restore = self.restore_locked(
                    &identity,
                    &journal.get(&operation_id)?,
                    RestoreStrategy::Source,
                );
                return match restore {
                    Ok(()) => Err(error),
                    Err(restore_error) => Err(CoreError::Git(format!(
                        "automatic stash reported failure: {error}; source restore also failed: {restore_error}"
                    ))),
                };
            }

            // A stash can run hooks and takes time. Re-read all external facts
            // before the checkout mutation instead of trusting pre-stash state.
            let after_stash = match self.identity(project_id) {
                Ok(identity) => identity,
                Err(error) => {
                    return Err(self.rollback_stashed(
                        &identity,
                        &journal,
                        &operation_id,
                        error,
                        "repository identity could not be re-read after stash",
                    ));
                }
            };
            if after_stash != identity {
                return Err(self.rollback_stashed(
                    &identity,
                    &journal,
                    &operation_id,
                    CoreError::Conflict(
                        "repository identity drifted while creating the automatic stash".into(),
                    ),
                    "repository identity drifted after stash",
                ));
            }
            let post_stash_status = match self.status(&identity) {
                Ok(status) => status,
                Err(error) => {
                    return Err(self.rollback_stashed(
                        &identity,
                        &journal,
                        &operation_id,
                        error,
                        "status could not be re-read after stash",
                    ));
                }
            };
            let post_stash_head = match self.run_success(&identity, ["rev-parse", "HEAD"]) {
                Ok(output) => output.stdout_lossy().trim().to_owned(),
                Err(error) => {
                    return Err(self.rollback_stashed(
                        &identity,
                        &journal,
                        &operation_id,
                        error,
                        "HEAD could not be re-read after stash",
                    ));
                }
            };
            self.record_observation(
                &journal,
                &operation_id,
                BranchOperationPhase::Stashed,
                &post_stash_status,
                &post_stash_head,
                "post-stash HEAD/status verified",
            )?;
            if (post_stash_status.is_dirty()
                && !self.only_original_ignored_paths_are_visible(
                    &identity,
                    &post_stash_status,
                    &snapshot,
                )?)
                || post_stash_status.operation_state.is_some()
                || post_stash_head != source_commit
                || !self.ignored_snapshot_matches(&identity, &snapshot)?
            {
                journal.update(
                    &operation_id,
                    BranchOperationPhase::RecoveryRequired,
                    None,
                    Some("repository did not match the protected post-stash state"),
                    Some("stopped before branch switch"),
                )?;
                let restore = self.restore_locked(
                    &identity,
                    &journal.get(&operation_id)?,
                    RestoreStrategy::Source,
                );
                return match restore {
                    Ok(()) => Err(CoreError::Conflict(
                        "repository changed while creating the automatic stash; source state was restored"
                            .into(),
                    )),
                    Err(error) => Err(CoreError::Conflict(format!(
                        "repository changed while creating the automatic stash; stash retained and automatic source restore stopped: {error}"
                    ))),
                };
            }
            let refreshed_target = self
                .list_branches(&identity)
                .map_err(|error| {
                    self.rollback_stashed(
                        &identity,
                        &journal,
                        &operation_id,
                        error,
                        "local branches could not be re-read after stash",
                    )
                })?
                .into_iter()
                .find(|branch| branch.name == target)
                .ok_or_else(|| {
                    self.rollback_stashed(
                        &identity,
                        &journal,
                        &operation_id,
                        CoreError::Conflict(format!("target branch disappeared: {target}")),
                        "target branch disappeared after stash",
                    )
                })?;
            if refreshed_target.oid != target_info.oid {
                return Err(self.rollback_stashed(
                    &identity,
                    &journal,
                    &operation_id,
                    CoreError::Conflict(format!(
                        "target branch {target} moved while creating the automatic stash"
                    )),
                    "target branch moved after stash",
                ));
            }
            if let Some(path) = refreshed_target.occupied_worktree {
                if canonical_or_original(Path::new(&path)) != identity.root {
                    return Err(self.rollback_stashed(
                        &identity,
                        &journal,
                        &operation_id,
                        CoreError::Blocked(format!(
                            "branch {target} became occupied in linked worktree {path}"
                        )),
                        "target branch became occupied after stash",
                    ));
                }
            }
            if let Err(error) = self.ensure_no_ignored_collision(&identity, target) {
                return Err(self.rollback_stashed(
                    &identity,
                    &journal,
                    &operation_id,
                    error,
                    "ignored path collision appeared after stash",
                ));
            }
        }

        let final_precheck = (|| -> Result<()> {
            let live_identity = self.identity(project_id)?;
            if live_identity != identity {
                return Err(CoreError::Conflict(
                    "repository identity drifted immediately before branch switch".into(),
                ));
            }
            let live_status = self.status(&identity)?;
            self.ensure_operation_conflicts(&live_status)?;
            if self
                .run_success(&identity, ["rev-parse", "HEAD"])?
                .stdout_lossy()
                .trim()
                != source_commit
                || live_status.checkout != status.checkout
            {
                return Err(CoreError::Conflict(
                    "source HEAD drifted immediately before branch switch".into(),
                ));
            }
            if stashed {
                let protected = &snapshot;
                if (live_status.is_dirty()
                    && !self.only_original_ignored_paths_are_visible(
                        &identity,
                        &live_status,
                        protected,
                    )?)
                    || !self.ignored_snapshot_matches(&identity, protected)?
                {
                    return Err(CoreError::Conflict(
                        "worktree drifted after automatic stash and before switch".into(),
                    ));
                }
            } else if live_status.is_dirty() {
                return Err(CoreError::Conflict(
                    "worktree became dirty immediately before branch switch".into(),
                ));
            }
            let live_target = self
                .list_branches(&identity)?
                .into_iter()
                .find(|branch| branch.name == target)
                .ok_or_else(|| {
                    CoreError::Conflict(format!("target branch disappeared: {target}"))
                })?;
            if live_target.oid != target_info.oid {
                return Err(CoreError::Conflict(format!(
                    "target branch {target} moved immediately before switch"
                )));
            }
            if let Some(path) = live_target.occupied_worktree {
                if canonical_or_original(Path::new(&path)) != identity.root {
                    return Err(CoreError::Blocked(format!(
                        "branch {target} became occupied in linked worktree {path}"
                    )));
                }
            }
            self.ensure_checkout_state_allowed(&live_status)?;
            self.ensure_no_ignored_collision(&identity, target)
        })();
        if let Err(error) = final_precheck {
            if stashed {
                return Err(self.rollback_stashed(
                    &identity,
                    &journal,
                    &operation_id,
                    error,
                    "final pre-switch repository validation failed",
                ));
            }
            journal.update(
                &operation_id,
                BranchOperationPhase::Failed,
                None,
                Some(&error.to_string()),
                Some("final pre-switch repository validation failed without mutation"),
            )?;
            return Err(error);
        }

        let switch_result = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("switch"),
                OsString::from("--no-guess"),
                OsString::from("--no-recurse-submodules"),
                OsString::from("--no-overwrite-ignore"),
                OsString::from(target),
            ],
        );
        // A timeout/non-zero result is not repository state. Re-read HEAD and
        // status first; only an exact target observation counts as success.
        let observed_status = match self.status(&identity) {
            Ok(status) => status,
            Err(error) if stashed => {
                return Err(self.rollback_stashed(
                    &identity,
                    &journal,
                    &operation_id,
                    error,
                    "status could not be read after branch switch",
                ));
            }
            Err(error) => {
                journal.update(
                    &operation_id,
                    BranchOperationPhase::RecoveryRequired,
                    None,
                    Some(&error.to_string()),
                    Some("status could not be read after clean branch switch"),
                )?;
                return Err(error);
            }
        };
        let observed_head = match self.run_success(&identity, ["rev-parse", "HEAD"]) {
            Ok(output) => output.stdout_lossy().trim().to_owned(),
            Err(error) if stashed => {
                return Err(self.rollback_stashed(
                    &identity,
                    &journal,
                    &operation_id,
                    error,
                    "HEAD could not be read after branch switch",
                ));
            }
            Err(error) => {
                journal.update(
                    &operation_id,
                    BranchOperationPhase::RecoveryRequired,
                    None,
                    Some(&error.to_string()),
                    Some("HEAD could not be read after clean branch switch"),
                )?;
                return Err(error);
            }
        };
        let target_observed = matches!(
            &observed_status.checkout,
            CheckoutState::Branch(branch) if branch == target
        ) && observed_head == target_info.oid
            && observed_status.operation_state.is_none()
            && !observed_status.unmerged
            && !observed_status.dirty_submodule;
        if !target_observed {
            let switch_error = match switch_result {
                Ok(output) if output.success() => {
                    "git switch returned success but the target HEAD was not observed".to_owned()
                }
                Ok(output) => git_output_error(&output),
                Err(error) => error.to_string(),
            };
            journal.update(
                &operation_id,
                BranchOperationPhase::RecoveryRequired,
                None,
                Some(switch_error.trim()),
                Some("git switch failed"),
            )?;
            self.record_observation(
                &journal,
                &operation_id,
                BranchOperationPhase::RecoveryRequired,
                &observed_status,
                &observed_head,
                "post-switch failure observation",
            )?;
            if stashed {
                if let Err(restore_error) = self.restore_locked(
                    &identity,
                    &journal.get(&operation_id)?,
                    RestoreStrategy::Source,
                ) {
                    return Err(CoreError::Git(format!(
                        "switch failed: {}; source restore also failed: {restore_error}",
                        switch_error.trim()
                    )));
                }
            } else {
                journal.update(
                    &operation_id,
                    BranchOperationPhase::Failed,
                    None,
                    Some(switch_error.trim()),
                    Some("clean switch failed without repository mutation"),
                )?;
            }
            return Err(CoreError::Git(format!(
                "switch to {target} failed: {}",
                switch_error.trim()
            )));
        }
        journal.update(
            &operation_id,
            BranchOperationPhase::Switched,
            None,
            None,
            Some("target branch checked out"),
        )?;
        self.record_observation(
            &journal,
            &operation_id,
            BranchOperationPhase::Switched,
            &observed_status,
            &observed_head,
            "post-switch HEAD/status verified",
        )?;

        if !stashed {
            journal.update(
                &operation_id,
                BranchOperationPhase::Completed,
                None,
                None,
                Some("clean switch completed"),
            )?;
        }
        Ok(SwitchOutcome {
            operation_id,
            source: status.checkout,
            target_branch: target.to_owned(),
            stashed,
            restored: false,
            pending_restore: stashed,
        })
    }

    pub fn recover(
        &self,
        operation_id: &str,
        strategy: RestoreStrategy,
    ) -> Result<BranchOperation> {
        let journal = OperationJournal::new(self.db);
        let operation = journal.get(operation_id)?;
        let identity = self.identity(&operation.project_id)?;
        if identity.repo_key != operation.repo_key
            || canonical_or_original(Path::new(&operation.checkout_root)) != identity.root
        {
            return Err(CoreError::Conflict(format!(
                "repository identity changed since branch operation {operation_id}"
            )));
        }
        let lock = repository_lock(&identity.repo_key);
        let _guard = lock.lock().unwrap();
        let _file_guard = RepositoryFileLock::acquire(&identity.common_dir)?;
        let identity = self.identity(&operation.project_id)?;
        self.restore_locked(&identity, &journal.get(operation_id)?, strategy)?;
        journal.get(operation_id)
    }

    pub fn operation(&self, operation_id: &str) -> Result<BranchOperation> {
        OperationJournal::new(self.db).get(operation_id)
    }

    pub fn operation_steps(
        &self,
        operation_id: &str,
    ) -> Result<Vec<super::operation::BranchOperationStep>> {
        OperationJournal::new(self.db).steps(operation_id)
    }

    pub fn list_auto_stashes(&self, project_id: &str) -> Result<Vec<AutoStash>> {
        OperationJournal::new(self.db).auto_stashes(project_id)
    }

    /// Drop is deliberately separate from restore. Only a verified restore may
    /// clean up, and the selector is re-resolved from exact OID + marker.
    pub fn cleanup(&self, operation_id: &str) -> Result<BranchOperation> {
        let journal = OperationJournal::new(self.db);
        let operation = journal.get(operation_id)?;
        if operation.phase != BranchOperationPhase::RestoredVerified {
            return Err(CoreError::Blocked(format!(
                "operation {operation_id} is not restored_verified"
            )));
        }
        let identity = self.identity(&operation.project_id)?;
        let lock = repository_lock(&identity.repo_key);
        let _guard = lock.lock().unwrap();
        let _file_guard = RepositoryFileLock::acquire(&identity.common_dir)?;
        let identity = self.identity(&operation.project_id)?;
        self.drop_verified_stash(&identity, &operation)?;
        journal.get(operation_id)
    }

    /// Startup-safe reconciliation never applies or deletes data. It can close
    /// a prepared operation when no mutation happened, verify an already
    /// applied stash, or move ambiguous states to recovery_required so the UI
    /// can offer explicit source/target recovery choices.
    pub fn reconcile(&self, project_id: &str) -> Result<ReconcileReport> {
        let identity = self.identity(project_id)?;
        let lock = repository_lock(&identity.repo_key);
        let _guard = lock.lock().unwrap();
        let _file_guard = RepositoryFileLock::acquire(&identity.common_dir)?;
        let identity = self.identity(project_id)?;
        let journal = OperationJournal::new(self.db);
        let incomplete = journal.incomplete(Some(project_id))?;
        for operation in &incomplete {
            if operation.kind == BranchOperationKind::Delete
                && matches!(
                    operation.phase,
                    BranchOperationPhase::Prepared | BranchOperationPhase::RecoveryRequired
                )
            {
                self.validate_branch_name(&identity, &operation.target_branch)?;
                let target = self.local_branch(&identity, &operation.target_branch)?;
                if target.is_none() {
                    match self.restore_missing_ref_if_occupied(
                        &identity,
                        &operation.target_branch,
                        &operation.target_oid,
                    ) {
                        Ok(Some(path)) => {
                            journal.update(
                                &operation.id,
                                BranchOperationPhase::Failed,
                                None,
                                Some("a worktree checked out the branch during deletion"),
                                Some(&format!(
                                    "startup reconciliation restored the deleted ref because worktree {path} still checks it out"
                                )),
                            )?;
                        }
                        Ok(None) => {
                            journal.update(
                                &operation.id,
                                BranchOperationPhase::Completed,
                                None,
                                None,
                                Some(
                                    "startup reconciliation verified completed local branch deletion",
                                ),
                            )?;
                        }
                        Err(error) => {
                            journal.update(
                                &operation.id,
                                BranchOperationPhase::RecoveryRequired,
                                None,
                                Some(&error.to_string()),
                                Some("startup reconciliation could not restore a ref required by an occupied worktree"),
                            )?;
                        }
                    }
                } else {
                    journal.update(
                        &operation.id,
                        BranchOperationPhase::Failed,
                        None,
                        None,
                        Some("startup reconciliation verified the local branch ref was retained"),
                    )?;
                }
                continue;
            }
            if operation.kind == BranchOperationKind::Create
                && matches!(
                    operation.phase,
                    BranchOperationPhase::Prepared | BranchOperationPhase::RecoveryRequired
                )
            {
                let created = self.list_branches(&identity)?.into_iter().any(|branch| {
                    branch.name == operation.target_branch && branch.oid == operation.target_oid
                });
                journal.update(
                    &operation.id,
                    if created {
                        BranchOperationPhase::Completed
                    } else {
                        BranchOperationPhase::Failed
                    },
                    None,
                    None,
                    Some(if created {
                        "startup reconciliation verified completed branch creation"
                    } else {
                        "startup reconciliation verified no branch ref was created"
                    }),
                )?;
                continue;
            }
            if operation.kind == BranchOperationKind::Switch
                && operation.phase == BranchOperationPhase::RecoveryRequired
                && operation.stash_oid.is_none()
            {
                let status = self.status(&identity)?;
                let head = self
                    .run_success(&identity, ["rev-parse", "HEAD"])?
                    .stdout_lossy()
                    .trim()
                    .to_owned();
                let completed = !status.is_dirty()
                    && status.operation_state.is_none()
                    && self.restore_location_matches(
                        &status,
                        &head,
                        operation,
                        RestoreStrategy::Target,
                    );
                journal.update(
                    &operation.id,
                    if completed {
                        BranchOperationPhase::Completed
                    } else {
                        BranchOperationPhase::Failed
                    },
                    None,
                    None,
                    Some(if completed {
                        "startup reconciliation verified the clean switch completed"
                    } else {
                        "startup reconciliation closed a no-stash switch failure without modifying the observed checkout"
                    }),
                )?;
                continue;
            }
            match operation.phase {
                BranchOperationPhase::Prepared if operation.stash_oid.is_none() => {
                    let discovered = operation
                        .stash_marker
                        .as_deref()
                        .map(|marker| self.find_stash(&identity, marker, None))
                        .transpose()?
                        .flatten();
                    if let (Some(stash), Some(marker)) =
                        (discovered, operation.stash_marker.as_deref())
                    {
                        journal.update(
                            &operation.id,
                            BranchOperationPhase::Stashed,
                            Some((&stash.oid, &stash.selector, marker)),
                            None,
                            Some("startup reconciliation bound a completed automatic stash"),
                        )?;
                    } else {
                        let observed_status = self.status(&identity)?;
                        let observed_head = self
                            .run_success(&identity, ["rev-parse", "HEAD"])?
                            .stdout_lossy()
                            .trim()
                            .to_owned();
                        let clean_switch_completed = operation.stash_marker.is_none()
                            && !observed_status.is_dirty()
                            && observed_status.operation_state.is_none()
                            && self.restore_location_matches(
                                &observed_status,
                                &observed_head,
                                operation,
                                RestoreStrategy::Target,
                            );
                        if clean_switch_completed {
                            journal.update(
                                &operation.id,
                                BranchOperationPhase::Completed,
                                None,
                                None,
                                Some(
                                    "startup reconciliation verified a completed clean branch switch",
                                ),
                            )?;
                            continue;
                        }
                        let source_head_unchanged = observed_head == operation.source_commit;
                        let dirty_snapshot_unchanged = match operation.snapshot_json.as_deref() {
                            Some(json) => serde_json::from_str::<WorktreeSnapshot>(json)
                                .ok()
                                .is_some_and(|snapshot| {
                                    self.prepared_snapshot_matches(&identity, &snapshot)
                                        .unwrap_or(false)
                                }),
                            None => true,
                        };
                        if source_head_unchanged && dirty_snapshot_unchanged {
                            journal.update(
                                &operation.id,
                                BranchOperationPhase::Failed,
                                None,
                                None,
                                Some(
                                    "startup reconciliation verified HEAD and protected worktree snapshot were unchanged",
                                ),
                            )?;
                        } else {
                            journal.update(
                                &operation.id,
                                BranchOperationPhase::RecoveryRequired,
                                None,
                                Some(
                                    "prepared operation has no bound stash and its protected repository snapshot drifted",
                                ),
                                Some(
                                    "startup reconciliation stopped without modifying Git state",
                                ),
                            )?;
                        }
                    }
                }
                BranchOperationPhase::Stashed | BranchOperationPhase::Switched
                    if self.exact_stash(&identity, operation).is_err() =>
                {
                    journal.update(
                        &operation.id,
                        BranchOperationPhase::RecoveryRequired,
                        None,
                        Some("persisted automatic stash is missing or no longer unique"),
                        Some("startup reconciliation requires manual inspection"),
                    )?;
                }
                BranchOperationPhase::Applying => {
                    let snapshot = operation
                        .snapshot_json
                        .as_deref()
                        .map(serde_json::from_str::<WorktreeSnapshot>)
                        .transpose()?;
                    let observed_status = self.status(&identity)?;
                    let observed_head = self
                        .run_success(&identity, ["rev-parse", "HEAD"])?
                        .stdout_lossy()
                        .trim()
                        .to_owned();
                    let exact_location = self.restore_location_matches(
                        &observed_status,
                        &observed_head,
                        operation,
                        RestoreStrategy::Target,
                    ) || self.restore_location_matches(
                        &observed_status,
                        &observed_head,
                        operation,
                        RestoreStrategy::Source,
                    );
                    if snapshot.as_ref().is_some_and(|snapshot| {
                        self.snapshot_matches(&identity, snapshot).unwrap_or(false)
                    }) && exact_location
                        && self.exact_stash(&identity, operation).is_ok()
                    {
                        journal.update(
                            &operation.id,
                            BranchOperationPhase::RestoredVerified,
                            None,
                            None,
                            Some("startup reconciliation verified the interrupted stash apply"),
                        )?;
                    } else {
                        journal.update(
                            &operation.id,
                            BranchOperationPhase::RecoveryRequired,
                            None,
                            Some("interrupted stash apply could not be verified"),
                            Some("stash retained for explicit recovery"),
                        )?;
                    }
                }
                BranchOperationPhase::Cleaning => {
                    let marker = operation.stash_marker.as_deref().unwrap_or_default();
                    match self.find_stash(&identity, marker, operation.stash_oid.as_deref())? {
                        Some(_) => journal.update(
                            &operation.id,
                            BranchOperationPhase::RestoredVerified,
                            None,
                            Some("cleanup was interrupted before the OID-checked stash deletion completed"),
                            Some("exact stash still exists and cleanup can be retried"),
                        )?,
                        None => journal.update(
                            &operation.id,
                            BranchOperationPhase::Completed,
                            None,
                            None,
                            Some(
                                "startup reconciliation verified the cleaned stash is absent after an interrupted cleanup",
                            ),
                        )?,
                    }
                }
                BranchOperationPhase::RestoredVerified => {
                    let marker = operation.stash_marker.as_deref().unwrap_or_default();
                    if self
                        .find_stash(&identity, marker, operation.stash_oid.as_deref())?
                        .is_none()
                    {
                        journal.update(
                            &operation.id,
                            BranchOperationPhase::Completed,
                            None,
                            None,
                            Some(
                                "startup reconciliation observed that the verified stash was already removed externally",
                            ),
                        )?;
                    }
                }
                _ => {}
            }
        }
        let mut orphan_marker_stashes = Vec::new();
        for stash in self.list_stashes(&identity)? {
            if let Some(position) = stash.message.find("agentport:v1:op=") {
                let marker = &stash.message[position..];
                if journal.operation_for_marker(marker)?.is_none() {
                    orphan_marker_stashes.push(stash.selector.clone());
                    if let Err(error) = self
                        .import_orphan_marker_stash(project_id, &identity, &journal, &stash, marker)
                    {
                        tracing::warn!(
                            project_id,
                            selector = %stash.selector,
                            %error,
                            "AgentPort marker stash could not be imported into the recovery journal"
                        );
                    }
                }
            }
        }
        Ok(ReconcileReport {
            incomplete: journal.incomplete(Some(project_id))?,
            orphan_marker_stashes,
        })
    }

    fn import_orphan_marker_stash(
        &self,
        project_id: &str,
        identity: &RepositoryIdentity,
        journal: &OperationJournal<'_>,
        stash: &StashRecord,
        marker: &str,
    ) -> Result<()> {
        let parsed = parse_stash_marker(marker).ok_or_else(|| {
            CoreError::Validation("malformed AgentPort automatic stash marker".into())
        })?;
        if parsed.repo_key != identity.repo_key {
            return Err(CoreError::Conflict(
                "AgentPort stash marker repository key does not match this repository".into(),
            ));
        }
        if !parsed
            .operation_id
            .strip_prefix("op_")
            .is_some_and(|value| {
                value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err(CoreError::Validation(
                "AgentPort stash marker operation ID is invalid".into(),
            ));
        }
        self.validate_branch_name(identity, &parsed.target)?;
        let source_branch = if let Some(commit) = parsed
            .source
            .strip_prefix("DETACHED@")
            .or_else(|| parsed.source.strip_prefix("detached@"))
        {
            if !is_hex_oid(commit) {
                return Err(CoreError::Validation(
                    "AgentPort detached source marker has an invalid OID".into(),
                ));
            }
            None
        } else {
            self.validate_branch_name(identity, &parsed.source)?;
            Some(parsed.source.clone())
        };
        let source_commit = self
            .run_success_os(
                identity,
                vec![
                    OsString::from("rev-parse"),
                    OsString::from("--verify"),
                    format!("{}^1^{{commit}}", stash.oid).into(),
                ],
            )?
            .stdout_lossy()
            .trim()
            .to_owned();
        if parsed
            .source_oid
            .as_deref()
            .is_some_and(|expected| expected != source_commit)
            || (source_branch.is_none()
                && parsed
                    .source
                    .split_once('@')
                    .is_some_and(|(_, expected)| expected != source_commit))
        {
            return Err(CoreError::Conflict(
                "AgentPort stash marker source OID does not match the stash parent".into(),
            ));
        }
        let target_oid = if let Some(oid) = parsed.target_oid {
            if !is_hex_oid(&oid) {
                return Err(CoreError::Validation(
                    "AgentPort stash marker target OID is invalid".into(),
                ));
            }
            self.run_success_os(
                identity,
                vec![
                    OsString::from("rev-parse"),
                    OsString::from("--verify"),
                    format!("{oid}^{{commit}}").into(),
                ],
            )?
            .stdout_lossy()
            .trim()
            .to_owned()
        } else {
            self.runner
                .run(
                    Some(&identity.root),
                    [
                        OsString::from("rev-parse"),
                        OsString::from("--verify"),
                        format!("refs/heads/{}^{{commit}}", parsed.target).into(),
                    ],
                )
                .ok()
                .filter(GitOutput::success)
                .map(|output| output.stdout_lossy().trim().to_owned())
                .unwrap_or_else(|| source_commit.clone())
        };
        let operation_id = match journal.get(&parsed.operation_id) {
            Err(CoreError::NotFound(_)) => parsed.operation_id,
            Ok(_) => format!("op_{}", uuid::Uuid::new_v4().simple()),
            Err(error) => return Err(error),
        };
        journal.insert(&BranchOperation {
            id: operation_id,
            kind: BranchOperationKind::Switch,
            project_id: project_id.to_owned(),
            repo_key: identity.repo_key.clone(),
            checkout_root: identity.root.to_string_lossy().into_owned(),
            source_branch,
            source_commit,
            target_branch: parsed.target,
            target_oid,
            phase: BranchOperationPhase::RecoveryRequired,
            stash_oid: Some(stash.oid.clone()),
            stash_selector: Some(stash.selector.clone()),
            stash_marker: Some(marker.to_owned()),
            snapshot_json: None,
            error_json: Some(serde_json::json!({
                "message": "automatic stash was discovered without its durable file snapshot; it is retained for manual recovery"
            })),
            created_at: parsed.created_at,
            updated_at: Utc::now(),
            completed_at: None,
        })
    }

    fn identity(&self, project_id: &str) -> Result<RepositoryIdentity> {
        RepositoryIdentity::from_project(&self.db.get_project(project_id)?, &self.runner)
    }

    fn status(&self, identity: &RepositoryIdentity) -> Result<RepoStatus> {
        let mut status = super::status::read_repo_status(identity, &self.runner)?;
        status.operation_state = detect_operation_state(&identity.git_dir);
        Ok(status)
    }

    fn list_branches(&self, identity: &RepositoryIdentity) -> Result<Vec<BranchInfo>> {
        let output = self.run_success(
            identity,
            [
                "for-each-ref",
                "--sort=refname",
                "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(worktreepath)%00%(symref)%00",
                "refs/heads",
            ],
        )?;
        parse_branches(&output.stdout)
    }

    fn validate_branch_name(&self, identity: &RepositoryIdentity, name: &str) -> Result<()> {
        if name.trim().is_empty()
            || name != name.trim()
            || name.starts_with('-')
            || name.contains('\0')
        {
            return Err(CoreError::Validation(
                "branch name must be non-empty, option-safe, NUL-free, and have no surrounding whitespace"
                    .into(),
            ));
        }
        let output = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("check-ref-format"),
                OsString::from("--branch"),
                OsString::from(name),
            ],
        )?;
        if output.success() {
            let normalized = output.stdout_lossy();
            if normalized.trim_end() == name {
                Ok(())
            } else {
                Err(CoreError::Validation(format!(
                    "branch shorthand {name:?} resolves to {:?}; an exact local branch name is required",
                    normalized.trim_end()
                )))
            }
        } else {
            Err(CoreError::Validation(format!(
                "invalid local branch name {name:?}: {}",
                output.stderr_lossy().trim()
            )))
        }
    }

    fn ensure_mutation_allowed(
        &self,
        identity: &RepositoryIdentity,
        status: &RepoStatus,
    ) -> Result<()> {
        self.ensure_operation_conflicts_and_sessions(identity, status)?;
        self.ensure_checkout_state_allowed(status)
    }

    fn ensure_delete_allowed(&self, status: &RepoStatus) -> Result<()> {
        if let Some(state) = &status.operation_state {
            return Err(CoreError::Blocked(format!(
                "branch deletion is blocked while Git operation is active: {state}"
            )));
        }
        if status.unmerged {
            return Err(CoreError::Blocked(
                "branch deletion is blocked by unresolved index conflicts".into(),
            ));
        }
        if matches!(status.checkout, CheckoutState::Unborn(_)) {
            return Err(CoreError::Blocked(
                "branch deletion is blocked in an unborn repository".into(),
            ));
        }
        Ok(())
    }

    fn ensure_branch_not_referenced(
        &self,
        identity: &RepositoryIdentity,
        branch: &str,
        excluded_operation_id: Option<&str>,
    ) -> Result<()> {
        let referenced_by = OperationJournal::new(self.db)
            .incomplete(None)?
            .into_iter()
            .find(|operation| {
                operation.repo_key == identity.repo_key
                    && excluded_operation_id != Some(operation.id.as_str())
                    && (operation.source_branch.as_deref() == Some(branch)
                        || operation.target_branch == branch)
            });
        if let Some(operation) = referenced_by {
            return Err(CoreError::Blocked(format!(
                "cannot delete branch {branch}; unfinished {} operation {} still references it",
                operation.kind.as_str(),
                operation.id
            )));
        }
        Ok(())
    }

    fn local_branch(
        &self,
        identity: &RepositoryIdentity,
        name: &str,
    ) -> Result<Option<BranchInfo>> {
        Ok(self
            .list_branches(identity)?
            .into_iter()
            .find(|branch| branch.name == name))
    }

    /// Exact fallback used only when the normal local-branch enumeration
    /// failed around a mutating CAS. Exit status, not localized stderr,
    /// determines presence or absence.
    fn observe_exact_ref(
        &self,
        identity: &RepositoryIdentity,
        branch: &str,
    ) -> ExactRefObservation {
        let full_ref = format!("refs/heads/{branch}");
        let exists = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("show-ref"),
                OsString::from("--exists"),
                OsString::from(&full_ref),
            ],
        );
        if let Ok(output) = &exists {
            if !output.timed_out && output.exit_code() == Some(2) {
                return ExactRefObservation::Absent;
            }
        }
        let show_ref = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("show-ref"),
                OsString::from("--verify"),
                OsString::from("--hash"),
                OsString::from(&full_ref),
            ],
        );
        match &show_ref {
            Ok(output) if output.success() => {
                let oid = output.stdout_lossy().trim().to_owned();
                if !oid.is_empty() {
                    return ExactRefObservation::Present(oid);
                }
            }
            _ => {}
        }

        let revision = format!("{full_ref}^{{commit}}");
        let rev_parse = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("rev-parse"),
                OsString::from("--verify"),
                OsString::from(revision),
            ],
        );
        if let Ok(output) = &rev_parse {
            if output.success() {
                let oid = output.stdout_lossy().trim().to_owned();
                if !oid.is_empty() {
                    return ExactRefObservation::Present(oid);
                }
            }
        }
        ExactRefObservation::Unknown(format!(
            "show-ref-exists={}; show-ref-verify={}; rev-parse={}",
            command_observation(&exists),
            command_observation(&show_ref),
            command_observation(&rev_parse)
        ))
    }

    fn branch_upstream_ref(
        &self,
        identity: &RepositoryIdentity,
        name: &str,
    ) -> Result<Option<String>> {
        let output = self.run_success(
            identity,
            [
                "for-each-ref",
                "--format=%(refname)%00%(upstream)%00",
                "refs/heads",
            ],
        )?;
        let expected_ref = format!("refs/heads/{name}");
        for record in output.stdout.split(|byte| *byte == b'\n') {
            let mut fields = record.split(|byte| *byte == 0);
            let Some(refname) = fields.next() else {
                continue;
            };
            if refname != expected_ref.as_bytes() {
                continue;
            }
            let upstream = fields.next().unwrap_or_default();
            return if upstream.is_empty() {
                Ok(None)
            } else {
                bytes_to_string(upstream).map(Some)
            };
        }
        Err(CoreError::NotFound(format!("local branch {name}")))
    }

    fn delete_merge_target_oid(
        &self,
        identity: &RepositoryIdentity,
        branch: &str,
    ) -> Result<String> {
        let revision = match self.branch_upstream_ref(identity, branch)? {
            Some(upstream) => format!("{upstream}^{{commit}}"),
            None => "HEAD^{commit}".to_owned(),
        };
        Ok(self
            .run_success_os(
                identity,
                vec![
                    OsString::from("rev-parse"),
                    OsString::from("--verify"),
                    OsString::from(revision),
                ],
            )?
            .stdout_lossy()
            .trim()
            .to_owned())
    }

    fn ensure_merged_for_delete(
        &self,
        identity: &RepositoryIdentity,
        branch: &str,
        branch_oid: &str,
        merge_target_oid: &str,
    ) -> Result<()> {
        let output = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("merge-base"),
                OsString::from("--is-ancestor"),
                OsString::from(branch_oid),
                OsString::from(merge_target_oid),
            ],
        )?;
        if output.success() {
            return Ok(());
        }
        if !output.timed_out && output.exit_code() == Some(1) {
            return Err(CoreError::Blocked(format!(
                "cannot delete branch {branch}; commit {branch_oid} {UNMERGED_DELETE_BLOCK_MARKER} {merge_target_oid}"
            )));
        }
        output.require_success().map(|_| ())
    }

    /// If an external client checked out the branch between AgentPort's
    /// preflight and CAS deletion, recreate the exact ref only while it is
    /// still absent. The empty old value is update-ref's expected-absent CAS.
    fn restore_missing_ref_if_occupied(
        &self,
        identity: &RepositoryIdentity,
        branch: &str,
        target_oid: &str,
    ) -> Result<Option<String>> {
        let occupied_path = identity
            .worktrees(&self.runner)?
            .into_iter()
            .find(|worktree| worktree.branch.as_deref() == Some(branch))
            .map(|worktree| worktree.path.to_string_lossy().into_owned());
        let Some(path) = occupied_path else {
            return Ok(None);
        };

        let full_ref = format!("refs/heads/{branch}");
        let restore_result = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("update-ref"),
                OsString::from(&full_ref),
                OsString::from(target_oid),
                OsString::from(""),
            ],
        );
        let restored = self
            .local_branch(identity, branch)?
            .is_some_and(|candidate| candidate.oid == target_oid);
        if restored {
            return Ok(Some(path));
        }
        let detail = match restore_result {
            Ok(output) => output
                .require_success()
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "expected-absent ref restore did not create the ref".into()),
            Err(error) => error.to_string(),
        };
        Err(CoreError::Conflict(format!(
            "branch {branch} is checked out in worktree {path}, but its deleted ref could not be restored with expected-absent CAS: {detail}"
        )))
    }

    fn finish_missing_delete_ref(
        &self,
        identity: &RepositoryIdentity,
        journal: &OperationJournal<'_>,
        operation_id: &str,
        branch: &str,
        target_oid: &str,
        snapshot: &WorktreeSnapshot,
    ) -> Result<()> {
        match self.restore_missing_ref_if_occupied(identity, branch, target_oid) {
            Ok(Some(path)) => {
                let error = CoreError::Conflict(format!(
                    "branch {branch} became checked out in worktree {path} during deletion; its exact ref was restored"
                ));
                journal.update(
                    operation_id,
                    BranchOperationPhase::Failed,
                    None,
                    Some(&error.to_string()),
                    Some("post-delete worktree check restored the exact target ref"),
                )?;
                return Err(error);
            }
            Ok(None) => {}
            Err(error) => {
                journal.update(
                    operation_id,
                    BranchOperationPhase::RecoveryRequired,
                    None,
                    Some(&error.to_string()),
                    Some("post-delete worktree check requires manual ref recovery"),
                )?;
                return Err(error);
            }
        }

        let observed_status = self.status(identity);
        let observed_head = self
            .run_success(identity, ["rev-parse", "HEAD"])
            .map(|output| output.stdout_lossy().trim().to_owned());
        let snapshot_match = self.prepared_snapshot_matches(identity, snapshot);
        let drift_observed = !matches!(snapshot_match, Ok(true));
        journal.update(
            operation_id,
            BranchOperationPhase::Completed,
            None,
            None,
            Some(if drift_observed {
                "exact local ref is absent; unrelated HEAD/status/session drift was observed after deletion"
            } else {
                "exact local ref is absent; post-delete HEAD/status/worktrees were observed"
            }),
        )?;
        if let (Ok(status), Ok(head)) = (&observed_status, &observed_head) {
            let _ = self.record_observation(
                journal,
                operation_id,
                BranchOperationPhase::Completed,
                status,
                head,
                if drift_observed {
                    "post-delete observation recorded unrelated repository drift"
                } else {
                    "post-delete HEAD/status observation recorded"
                },
            );
        }
        Ok(())
    }

    // Create/switch may run alongside Sessions; Git safety guards still apply.
    fn ensure_operation_conflicts(&self, status: &RepoStatus) -> Result<()> {
        if let Some(state) = &status.operation_state {
            return Err(CoreError::Blocked(format!(
                "branch mutation is blocked while Git operation is active: {state}"
            )));
        }
        if status.unmerged {
            return Err(CoreError::Blocked(
                "branch mutation is blocked by unresolved index conflicts".into(),
            ));
        }
        Ok(())
    }

    // Restore/recovery retains its stricter checkout ownership requirement.
    fn ensure_operation_conflicts_and_sessions(
        &self,
        identity: &RepositoryIdentity,
        status: &RepoStatus,
    ) -> Result<()> {
        self.ensure_operation_conflicts(status)?;
        if let Some(session_id) = self.live_session_ids_for_checkout(identity)?.first() {
            let session = self.db.get_session(session_id)?;
            return Err(CoreError::Blocked(format!(
                "session {} is {} in this checkout",
                session.id,
                session.lifecycle.as_str()
            )));
        }
        Ok(())
    }

    fn ensure_checkout_state_allowed(&self, status: &RepoStatus) -> Result<()> {
        if matches!(status.checkout, CheckoutState::Unborn(_)) {
            return Err(CoreError::Blocked(
                "branch mutation is blocked in an unborn repository".into(),
            ));
        }
        if status.dirty_submodule {
            return Err(CoreError::Blocked(
                "branch mutation is blocked by a dirty submodule".into(),
            ));
        }
        Ok(())
    }

    fn live_session_ids_for_checkout(&self, identity: &RepositoryIdentity) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        for session in self.db.list_sessions(None, false)? {
            if !matches!(session.lifecycle, Lifecycle::Creating | Lifecycle::Running) {
                continue;
            }
            let cwd = Path::new(&session.cwd);
            let Ok(session_repo) = RepositoryIdentity::discover(cwd, &self.runner) else {
                continue;
            };
            if session_repo.root == identity.root {
                ids.push(session.id);
            }
        }
        ids.sort();
        Ok(ids)
    }

    fn ensure_no_ignored_collision(
        &self,
        identity: &RepositoryIdentity,
        target: &str,
    ) -> Result<()> {
        let target_treeish = format!("refs/heads/{target}^{{tree}}");
        let target_tree = self.run_success(
            identity,
            ["ls-tree", "-r", "-z", "--name-only", &target_treeish],
        )?;
        let current_index = self.run_success(identity, ["ls-files", "-z"])?;
        let current_paths = current_index
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(bytes_to_string)
            .collect::<Result<std::collections::BTreeSet<_>>>()?;
        let ignored_output = self.run_success(
            identity,
            [
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "-z",
            ],
        )?;
        let ignored_paths = ignored_output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(bytes_to_string)
            .collect::<Result<Vec<_>>>()?;
        let mut collisions = Vec::new();
        for raw_path in target_tree
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            let path = bytes_to_string(raw_path)?;
            if current_paths.contains(&path) {
                continue;
            }
            // Target tree entries are files/gitlinks, while the ignored side
            // may be either that exact path, a parent occupying the target's
            // location, or a descendant that would be recursively deleted if
            // Git replaces its directory with a file. Compare path components
            // in both directions; string-prefix checks would confuse `foo`
            // with `foobar`.
            let target_path = Path::new(&path);
            for ignored in &ignored_paths {
                let ignored_path = Path::new(ignored);
                if ignored_path == target_path
                    || ignored_path.starts_with(target_path)
                    || target_path.starts_with(ignored_path)
                {
                    collisions.push(ignored.clone());
                }
            }
        }
        collisions.sort();
        collisions.dedup();
        if collisions.is_empty() {
            Ok(())
        } else {
            Err(CoreError::Blocked(format!(
                "target branch tracks paths occupied by local ignored files: {}",
                collisions.join(", ")
            )))
        }
    }

    fn capture_snapshot(
        &self,
        identity: &RepositoryIdentity,
        status: &RepoStatus,
        include_protected_files: bool,
    ) -> Result<WorktreeSnapshot> {
        let mut paths = Vec::new();
        for item in status.paths.iter().filter(|_| include_protected_files) {
            let worktree_hash = if item.unstaged || item.untracked {
                hash_path(&identity.root.join(&item.path))?
            } else {
                None
            };
            let worktree_mode = if item.unstaged || item.untracked {
                path_mode(&identity.root.join(&item.path))?
            } else {
                None
            };
            let (index_oid, index_mode) = if item.staged {
                self.index_entry(identity, &item.path)?
            } else {
                (None, None)
            };
            paths.push(SnapshotPath {
                path: item.path.clone(),
                staged: item.staged,
                unstaged: item.unstaged,
                untracked: item.untracked,
                worktree_hash,
                worktree_mode,
                index_oid,
                index_mode,
            });
        }
        paths.sort_by(|a, b| a.path.cmp(&b.path));
        let mut ignored = Vec::new();
        if include_protected_files {
            let ignored_output = self.run_success(
                identity,
                [
                    "ls-files",
                    "--others",
                    "--ignored",
                    "--exclude-standard",
                    "-z",
                ],
            )?;
            for raw in ignored_output
                .stdout
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
            {
                let path = bytes_to_string(raw)?;
                ignored.push(SnapshotPath {
                    worktree_hash: hash_path(&identity.root.join(&path))?,
                    worktree_mode: path_mode(&identity.root.join(&path))?,
                    path,
                    staged: false,
                    unstaged: false,
                    untracked: false,
                    index_oid: None,
                    index_mode: None,
                });
            }
        }
        ignored.sort_by(|a, b| a.path.cmp(&b.path));
        let mut worktrees = identity
            .worktrees(&self.runner)?
            .into_iter()
            .map(|worktree| SnapshotWorktree {
                path: canonical_or_original(&worktree.path)
                    .to_string_lossy()
                    .into_owned(),
                head: worktree.head,
                branch: worktree.branch,
                locked: worktree.locked,
                prunable: worktree.prunable,
            })
            .collect::<Vec<_>>();
        worktrees.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(WorktreeSnapshot {
            status: Some(status.clone()),
            worktrees,
            live_session_ids: self.live_session_ids_for_checkout(identity)?,
            paths,
            ignored,
        })
    }

    fn ignored_snapshot_matches(
        &self,
        identity: &RepositoryIdentity,
        snapshot: &WorktreeSnapshot,
    ) -> Result<bool> {
        for ignored in &snapshot.ignored {
            let path = identity.root.join(&ignored.path);
            if hash_path(&path)? != ignored.worktree_hash
                || path_mode(&path)? != ignored.worktree_mode
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn index_entry(
        &self,
        identity: &RepositoryIdentity,
        path: &str,
    ) -> Result<(Option<String>, Option<u32>)> {
        let output = self.run_success_os(
            identity,
            vec![
                OsString::from("ls-files"),
                OsString::from("--stage"),
                OsString::from("-z"),
                OsString::from("--"),
                OsString::from(path),
            ],
        )?;
        let record = output
            .stdout
            .split(|byte| *byte == 0)
            .next()
            .unwrap_or_default();
        if record.is_empty() {
            return Ok((None, None));
        }
        let text = String::from_utf8_lossy(record);
        let mut fields = text.split_whitespace();
        let mode = fields
            .next()
            .and_then(|value| u32::from_str_radix(value, 8).ok());
        let oid = fields.next().map(str::to_owned);
        Ok((oid, mode))
    }

    fn snapshot_matches(
        &self,
        identity: &RepositoryIdentity,
        expected: &WorktreeSnapshot,
    ) -> Result<bool> {
        let current_status = self.status(identity)?;
        if current_status.unmerged {
            return Ok(false);
        }
        let current = self.capture_snapshot(identity, &current_status, true)?;
        let expected_map = expected
            .paths
            .iter()
            .map(|path| (&path.path, path))
            .collect::<BTreeMap<_, _>>();
        let current_map = current
            .paths
            .iter()
            .map(|path| (&path.path, path))
            .collect::<BTreeMap<_, _>>();
        if expected_map.keys().collect::<Vec<_>>() != current_map.keys().collect::<Vec<_>>() {
            return Ok(false);
        }
        if !expected_map.iter().all(|(path, expected)| {
            let current = current_map[path];
            expected.staged == current.staged
                && expected.unstaged == current.unstaged
                && expected.untracked == current.untracked
                && expected.worktree_hash == current.worktree_hash
                && expected.worktree_mode == current.worktree_mode
                && expected.index_oid == current.index_oid
                && expected.index_mode == current.index_mode
        }) {
            return Ok(false);
        }
        let expected_ignored = expected
            .ignored
            .iter()
            .map(|path| (&path.path, path))
            .collect::<BTreeMap<_, _>>();
        let current_ignored = current
            .ignored
            .iter()
            .map(|path| (&path.path, path))
            .collect::<BTreeMap<_, _>>();
        if expected_ignored.keys().collect::<Vec<_>>() != current_ignored.keys().collect::<Vec<_>>()
        {
            return Ok(false);
        }
        Ok(expected_ignored.iter().all(|(path, expected)| {
            let current = current_ignored[path];
            expected.worktree_hash == current.worktree_hash
                && expected.worktree_mode == current.worktree_mode
        }))
    }

    fn prepared_snapshot_matches(
        &self,
        identity: &RepositoryIdentity,
        expected: &WorktreeSnapshot,
    ) -> Result<bool> {
        let status = self.status(identity)?;
        if expected
            .status
            .as_ref()
            .is_some_and(|saved| saved != &status)
        {
            return Ok(false);
        }
        let mut worktrees = identity
            .worktrees(&self.runner)?
            .into_iter()
            .map(|worktree| SnapshotWorktree {
                path: canonical_or_original(&worktree.path)
                    .to_string_lossy()
                    .into_owned(),
                head: worktree.head,
                branch: worktree.branch,
                locked: worktree.locked,
                prunable: worktree.prunable,
            })
            .collect::<Vec<_>>();
        worktrees.sort_by(|a, b| a.path.cmp(&b.path));
        if !expected.worktrees.is_empty() && expected.worktrees != worktrees {
            return Ok(false);
        }
        let live_session_ids = self.live_session_ids_for_checkout(identity)?;
        if expected.live_session_ids != live_session_ids {
            return Ok(false);
        }
        if expected.paths.is_empty() && expected.ignored.is_empty() {
            Ok(true)
        } else {
            self.snapshot_matches(identity, expected)
        }
    }

    fn only_original_ignored_paths_are_visible(
        &self,
        identity: &RepositoryIdentity,
        status: &RepoStatus,
        snapshot: &WorktreeSnapshot,
    ) -> Result<bool> {
        let ignored = snapshot
            .ignored
            .iter()
            .map(|path| (&path.path, (&path.worktree_hash, &path.worktree_mode)))
            .collect::<BTreeMap<_, _>>();
        if status.paths.is_empty() {
            return Ok(true);
        }
        for path in &status.paths {
            let Some((expected_hash, expected_mode)) = ignored.get(&path.path) else {
                return Ok(false);
            };
            let absolute = identity.root.join(&path.path);
            if hash_path(&absolute)? != **expected_hash || path_mode(&absolute)? != **expected_mode
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn restore_locked(
        &self,
        identity: &RepositoryIdentity,
        operation: &BranchOperation,
        strategy: RestoreStrategy,
    ) -> Result<()> {
        let journal = OperationJournal::new(self.db);
        let snapshot: WorktreeSnapshot = serde_json::from_str(
            operation
                .snapshot_json
                .as_deref()
                .ok_or_else(|| CoreError::Conflict("operation has no dirty snapshot".into()))?,
        )?;
        // Resolve marker + immutable OID before any checkout mutation. Recheck
        // again immediately before apply because the shared stash reflog may
        // change outside AgentPort's advisory repository lock.
        let _ = self.exact_stash(identity, operation)?;
        if self.snapshot_matches(identity, &snapshot)? {
            let status = self.status(identity)?;
            let head = self
                .run_success(identity, ["rev-parse", "HEAD"])?
                .stdout_lossy()
                .trim()
                .to_owned();
            if self.restore_location_matches(&status, &head, operation, strategy) {
                journal.update(
                    &operation.id,
                    BranchOperationPhase::RestoredVerified,
                    None,
                    None,
                    Some("restored state and requested checkout verified before retry"),
                )?;
                return Ok(());
            }
            return Err(CoreError::Blocked(
                "the protected changes are already restored at a different checkout; refusing to move a dirty worktree automatically"
                    .into(),
            ));
        }

        let status = self.status(identity)?;
        self.ensure_mutation_allowed(identity, &status)?;
        if let Some(state) = &status.operation_state {
            return Err(CoreError::Blocked(format!(
                "cannot recover an automatic stash while Git operation is active: {state}"
            )));
        }
        if status.unmerged || status.dirty_submodule {
            return Err(CoreError::Blocked(
                "cannot recover an automatic stash with conflicts or a dirty submodule".into(),
            ));
        }
        if status.is_dirty()
            && !self.only_original_ignored_paths_are_visible(identity, &status, &snapshot)?
        {
            return Err(CoreError::Blocked(
                "checkout changed after the branch operation; refusing to apply a stash over it"
                    .into(),
            ));
        }
        let mut checkout_result: Option<Result<GitOutput>> = None;
        match strategy {
            RestoreStrategy::Target => {
                let target_ref = format!("refs/heads/{}^{{commit}}", operation.target_branch);
                let target_oid = self
                    .run_success_os(
                        identity,
                        vec![
                            OsString::from("rev-parse"),
                            OsString::from("--verify"),
                            target_ref.into(),
                        ],
                    )?
                    .stdout_lossy()
                    .trim()
                    .to_owned();
                if target_oid != operation.target_oid {
                    return Err(CoreError::Conflict(format!(
                        "target branch {} moved from {} to {}",
                        operation.target_branch, operation.target_oid, target_oid
                    )));
                }
                if !matches!(&status.checkout, CheckoutState::Branch(branch) if branch == &operation.target_branch)
                {
                    checkout_result = Some(self.runner.run(
                        Some(&identity.root),
                        [
                            OsString::from("switch"),
                            OsString::from("--no-guess"),
                            OsString::from("--no-recurse-submodules"),
                            OsString::from("--no-overwrite-ignore"),
                            operation.target_branch.clone().into(),
                        ],
                    ));
                }
            }
            RestoreStrategy::Source => match &operation.source_branch {
                Some(branch) => {
                    let source_ref = format!("refs/heads/{branch}^{{commit}}");
                    let source_oid = self
                        .run_success_os(
                            identity,
                            vec![
                                OsString::from("rev-parse"),
                                OsString::from("--verify"),
                                source_ref.into(),
                            ],
                        )?
                        .stdout_lossy()
                        .trim()
                        .to_owned();
                    if source_oid != operation.source_commit {
                        return Err(CoreError::Conflict(format!(
                            "source branch {branch} moved from {} to {source_oid}",
                            operation.source_commit
                        )));
                    }
                    if !matches!(&status.checkout, CheckoutState::Branch(current) if current == branch)
                    {
                        checkout_result = Some(self.runner.run(
                            Some(&identity.root),
                            [
                                OsString::from("switch"),
                                OsString::from("--no-guess"),
                                OsString::from("--no-recurse-submodules"),
                                OsString::from("--no-overwrite-ignore"),
                                branch.clone().into(),
                            ],
                        ));
                    }
                }
                None => {
                    if !matches!(&status.checkout, CheckoutState::Detached(oid) if oid == &operation.source_commit)
                    {
                        checkout_result = Some(self.runner.run(
                            Some(&identity.root),
                            [
                                OsString::from("switch"),
                                OsString::from("--no-recurse-submodules"),
                                OsString::from("--no-overwrite-ignore"),
                                OsString::from("--detach"),
                                operation.source_commit.clone().into(),
                            ],
                        ));
                    }
                }
            },
        }
        let live_identity = self.identity(&operation.project_id)?;
        if live_identity != *identity {
            journal.update(
                &operation.id,
                BranchOperationPhase::RecoveryRequired,
                None,
                Some("repository identity drifted while selecting restore checkout"),
                Some("stash retained before apply"),
            )?;
            return Err(CoreError::Conflict(
                "repository identity drifted while selecting restore checkout".into(),
            ));
        }
        let post_checkout_status = self.status(identity)?;
        let post_checkout_head = self
            .run_success(identity, ["rev-parse", "HEAD"])?
            .stdout_lossy()
            .trim()
            .to_owned();
        let checkout_error = checkout_result.as_ref().and_then(|result| match result {
            Ok(output) if output.success() => None,
            Ok(output) => Some(git_output_error(output)),
            Err(error) => Some(error.to_string()),
        });
        if let Err(error) = self.ensure_mutation_allowed(identity, &post_checkout_status) {
            journal.update(
                &operation.id,
                BranchOperationPhase::RecoveryRequired,
                None,
                Some(&error.to_string()),
                Some("restore checkout pre-apply validation failed"),
            )?;
            return Err(error);
        }
        if (post_checkout_status.is_dirty()
            && !self.only_original_ignored_paths_are_visible(
                identity,
                &post_checkout_status,
                &snapshot,
            )?)
            || !self.restore_location_matches(
                &post_checkout_status,
                &post_checkout_head,
                operation,
                strategy,
            )
        {
            let message = checkout_error.unwrap_or_else(|| {
                "requested restore checkout was not observed after git switch".into()
            });
            journal.update(
                &operation.id,
                BranchOperationPhase::RecoveryRequired,
                None,
                Some(&message),
                Some("stash retained because restore checkout postcondition failed"),
            )?;
            return Err(CoreError::Conflict(message));
        }
        if let Some(message) = checkout_error {
            tracing::warn!(
                operation_id = %operation.id,
                detail = %message,
                "restore checkout command reported failure but exact HEAD/status postcondition succeeded"
            );
        }
        let stash = self.exact_stash(identity, operation)?;
        journal.update(
            &operation.id,
            BranchOperationPhase::Applying,
            None,
            None,
            Some("applying exact stash with index"),
        )?;
        let apply = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("stash"),
                OsString::from("apply"),
                OsString::from("--index"),
                // Stash selectors are reflog positions and can move. A stash
                // commit OID is immutable and accepted by `stash apply`.
                OsString::from(&stash.oid),
            ],
        );
        let apply = match apply {
            Ok(output) => output,
            Err(error) => {
                journal.update(
                    &operation.id,
                    BranchOperationPhase::RecoveryRequired,
                    None,
                    Some(&error.to_string()),
                    Some("stash apply could not be executed; exact stash retained"),
                )?;
                return Err(error);
            }
        };
        if !apply.success() {
            let message = git_output_error(&apply);
            let observed = self.status(identity)?;
            let observed_head = self
                .run_success(identity, ["rev-parse", "HEAD"])?
                .stdout_lossy()
                .trim()
                .to_owned();
            if self.snapshot_matches(identity, &snapshot)?
                && self.restore_location_matches(&observed, &observed_head, operation, strategy)
            {
                journal.update(
                    &operation.id,
                    BranchOperationPhase::RestoredVerified,
                    None,
                    Some(message.trim()),
                    Some("stash apply reported failure but exact restore postcondition verified"),
                )?;
                self.record_observation(
                    &journal,
                    &operation.id,
                    BranchOperationPhase::RestoredVerified,
                    &observed,
                    &observed_head,
                    "post-apply timeout/failure state exactly verified",
                )?;
                return Ok(());
            }
            journal.update(
                &operation.id,
                BranchOperationPhase::RecoveryRequired,
                None,
                Some(message.trim()),
                Some("stash apply left recovery work"),
            )?;
            if let Ok(head) = self.run_success(identity, ["rev-parse", "HEAD"]) {
                let _ = self.record_observation(
                    &journal,
                    &operation.id,
                    BranchOperationPhase::RecoveryRequired,
                    &observed,
                    head.stdout_lossy().trim(),
                    "post-apply failure observation",
                );
            }
            return Err(CoreError::Conflict(format!(
                "stash apply requires manual conflict resolution: {}",
                message.trim()
            )));
        }
        if !self.snapshot_matches(identity, &snapshot)? {
            journal.update(
                &operation.id,
                BranchOperationPhase::RecoveryRequired,
                None,
                Some("restored content did not match the persisted snapshot"),
                Some("stash retained after verification failure"),
            )?;
            return Err(CoreError::Conflict(
                "stash applied but restored content could not be verified; stash retained".into(),
            ));
        }
        let restored_status = self.status(identity)?;
        let restored_head = self
            .run_success(identity, ["rev-parse", "HEAD"])?
            .stdout_lossy()
            .trim()
            .to_owned();
        if !self.restore_location_matches(&restored_status, &restored_head, operation, strategy) {
            journal.update(
                &operation.id,
                BranchOperationPhase::RecoveryRequired,
                None,
                Some("restored content matched but requested checkout HEAD drifted"),
                Some("stash retained after restore location verification failure"),
            )?;
            return Err(CoreError::Conflict(
                "stash applied, but the requested restore checkout could not be verified; stash retained"
                    .into(),
            ));
        }
        journal.update(
            &operation.id,
            BranchOperationPhase::RestoredVerified,
            None,
            None,
            Some("restored state exactly verified"),
        )?;
        self.record_observation(
            &journal,
            &operation.id,
            BranchOperationPhase::RestoredVerified,
            &restored_status,
            &restored_head,
            "post-restore HEAD/status verified",
        )?;
        Ok(())
    }

    fn restore_location_matches(
        &self,
        status: &RepoStatus,
        head: &str,
        operation: &BranchOperation,
        strategy: RestoreStrategy,
    ) -> bool {
        match strategy {
            RestoreStrategy::Target => {
                matches!(&status.checkout, CheckoutState::Branch(branch) if branch == &operation.target_branch)
                    && head == operation.target_oid
            }
            RestoreStrategy::Source => match &operation.source_branch {
                Some(source) => {
                    matches!(&status.checkout, CheckoutState::Branch(branch) if branch == source)
                        && head == operation.source_commit
                }
                None => {
                    matches!(&status.checkout, CheckoutState::Detached(oid) if oid == &operation.source_commit)
                        && head == operation.source_commit
                }
            },
        }
    }

    fn drop_verified_stash(
        &self,
        identity: &RepositoryIdentity,
        operation: &BranchOperation,
    ) -> Result<()> {
        let journal = OperationJournal::new(self.db);
        let snapshot: WorktreeSnapshot = serde_json::from_str(
            operation
                .snapshot_json
                .as_deref()
                .ok_or_else(|| CoreError::Conflict("operation has no dirty snapshot".into()))?,
        )?;
        let _ = self.verify_cleanup_state(identity, operation, &snapshot)?;

        let stash = self.exact_stash(identity, operation)?;
        let stashes = self.list_stashes(identity)?;
        // `git stash drop stash@{N}` cannot atomically assert that the mutable
        // selector still names an OID. We can safely clean the common case in
        // which this is the sole stash by deleting refs/stash with an OID CAS.
        // If any unrelated stash exists, retain all entries and require the
        // user to manage the shared reflog explicitly.
        if stashes.len() != 1
            || stashes[0].oid != stash.oid
            || stashes[0].selector != "stash@{0}"
            || self.stash_tip(identity)? != Some(stash.oid.clone())
        {
            journal.update(
                &operation.id,
                BranchOperationPhase::RestoredVerified,
                None,
                Some("shared stash reflog contains another entry; cleanup was not attempted"),
                Some("verified restore retained to avoid a mutable stash selector race"),
            )?;
            return Err(CoreError::Blocked(
                "the repository has another stash entry; AgentPort retained its verified backup because Git cannot drop a shared stash selector with an OID compare-and-swap"
                    .into(),
            ));
        }
        // Re-read the checkout and live Session state immediately before the
        // only destructive step. External Git/filesystem drift never gets an
        // optimistic front-end pass-through.
        let _ = self.verify_cleanup_state(identity, operation, &snapshot)?;
        journal.update(
            &operation.id,
            BranchOperationPhase::Cleaning,
            None,
            None,
            Some("restored state reverified; starting OID-checked stash cleanup"),
        )?;
        let drop_result = self.runner.run(
            Some(&identity.root),
            [
                OsString::from("update-ref"),
                OsString::from("-d"),
                OsString::from("refs/stash"),
                OsString::from(&stash.oid),
            ],
        );
        // Re-enumeration is authoritative even if Git timed out after the
        // compare-and-swap completed or the process API returned an I/O error.
        let still_exists = self
            .find_stash(
                identity,
                operation.stash_marker.as_deref().unwrap_or_default(),
                operation.stash_oid.as_deref(),
            )?
            .is_some();
        if still_exists {
            let message = match drop_result {
                Ok(ref output) => git_output_error(output),
                Err(ref error) => error.to_string(),
            };
            journal.update(
                &operation.id,
                BranchOperationPhase::RestoredVerified,
                None,
                Some(message.trim()),
                Some("verified restore retained because OID-checked stash cleanup failed"),
            )?;
            return Err(CoreError::Git(format!(
                "restored state is verified but OID-checked stash cleanup failed: {}",
                message.trim()
            )));
        }
        match &drop_result {
            // The exact entry is gone, so the desired postcondition is
            // verified despite the process-level error.
            Err(error) => {
                tracing::warn!(operation_id = %operation.id, error = %error, "OID-checked stash cleanup postcondition succeeded after process error")
            }
            Ok(output) if !output.success() => {
                tracing::warn!(operation_id = %operation.id, detail = %git_output_error(output), "OID-checked stash cleanup postcondition succeeded after reported command failure")
            }
            Ok(_) => {}
        }
        if self
            .find_stash(
                identity,
                operation.stash_marker.as_deref().unwrap_or_default(),
                operation.stash_oid.as_deref(),
            )?
            .is_some()
        {
            journal.update(
                &operation.id,
                BranchOperationPhase::RestoredVerified,
                None,
                Some("exact stash still exists after OID-checked ref deletion"),
                Some("cleanup postcondition failed"),
            )?;
            return Err(CoreError::Conflict(
                "OID-checked stash cleanup returned success but the exact stash still exists"
                    .into(),
            ));
        }
        journal.update(
            &operation.id,
            BranchOperationPhase::Completed,
            None,
            None,
            Some("sole exact verified stash removed with refs/stash OID compare-and-swap"),
        )?;
        let status = self.status(identity)?;
        let head = self
            .run_success(identity, ["rev-parse", "HEAD"])?
            .stdout_lossy()
            .trim()
            .to_owned();
        self.record_observation(
            &journal,
            &operation.id,
            BranchOperationPhase::Completed,
            &status,
            &head,
            "post-cleanup HEAD/status verified",
        )
    }

    fn verify_cleanup_state(
        &self,
        identity: &RepositoryIdentity,
        operation: &BranchOperation,
        snapshot: &WorktreeSnapshot,
    ) -> Result<(RepoStatus, String)> {
        let status = self.status(identity)?;
        self.ensure_mutation_allowed(identity, &status)?;
        if !self.snapshot_matches(identity, snapshot)? {
            return Err(CoreError::Blocked(
                "restored checkout changed after verification; automatic stash is retained".into(),
            ));
        }
        let observed = self.status(identity)?;
        if observed != status {
            return Err(CoreError::Conflict(
                "repository status drifted during automatic stash cleanup verification".into(),
            ));
        }
        let head = self
            .run_success(identity, ["rev-parse", "HEAD"])?
            .stdout_lossy()
            .trim()
            .to_owned();
        let verified_location = match &observed.checkout {
            CheckoutState::Branch(branch) if branch == &operation.target_branch => {
                head == operation.target_oid
            }
            CheckoutState::Branch(branch)
                if operation.source_branch.as_deref() == Some(branch.as_str()) =>
            {
                head == operation.source_commit
            }
            CheckoutState::Detached(oid) if operation.source_branch.is_none() => {
                head == operation.source_commit && oid == &operation.source_commit
            }
            _ => false,
        };
        if !verified_location {
            return Err(CoreError::Blocked(
                "restored checkout is no longer at the recorded source or target commit; automatic stash is retained"
                    .into(),
            ));
        }
        Ok((observed, head))
    }

    fn exact_stash(
        &self,
        identity: &RepositoryIdentity,
        operation: &BranchOperation,
    ) -> Result<StashRecord> {
        let marker = operation.stash_marker.as_deref().ok_or_else(|| {
            CoreError::Conflict(format!("operation {} has no stash marker", operation.id))
        })?;
        let oid = operation.stash_oid.as_deref().ok_or_else(|| {
            CoreError::Conflict(format!("operation {} has no stash oid", operation.id))
        })?;
        self.find_stash(identity, marker, Some(oid))?
            .ok_or_else(|| {
                CoreError::Conflict(format!(
                    "exact stash for operation {} is missing or moved externally",
                    operation.id
                ))
            })
    }

    fn find_stash(
        &self,
        identity: &RepositoryIdentity,
        marker: &str,
        oid: Option<&str>,
    ) -> Result<Option<StashRecord>> {
        let matches = self
            .list_stashes(identity)?
            .into_iter()
            .filter(|stash| {
                stash.message.ends_with(marker) && oid.is_none_or(|oid| stash.oid == oid)
            })
            .collect::<Vec<_>>();
        match matches.len() {
            0 => Ok(None),
            1 => Ok(matches.into_iter().next()),
            _ => Err(CoreError::Conflict(format!(
                "multiple stashes have the exact AgentPort marker {marker}"
            ))),
        }
    }

    fn list_stashes(&self, identity: &RepositoryIdentity) -> Result<Vec<StashRecord>> {
        let output =
            self.run_success(identity, ["stash", "list", "--format=%gd%x00%H%x00%gs%x00"])?;
        parse_stashes(&output.stdout)
    }

    fn stash_tip(&self, identity: &RepositoryIdentity) -> Result<Option<String>> {
        let output = self.runner.run(
            Some(&identity.root),
            ["rev-parse", "--verify", "refs/stash"],
        )?;
        if output.success() {
            Ok(Some(output.stdout_lossy().trim().to_owned()))
        } else {
            Ok(None)
        }
    }

    fn run_success<const N: usize>(
        &self,
        identity: &RepositoryIdentity,
        args: [&str; N],
    ) -> Result<GitOutput> {
        self.runner
            .run(Some(&identity.root), args)?
            .require_success()
    }

    fn run_success_os(
        &self,
        identity: &RepositoryIdentity,
        args: Vec<OsString>,
    ) -> Result<GitOutput> {
        self.runner
            .run(Some(&identity.root), args)?
            .require_success()
    }

    fn record_observation(
        &self,
        journal: &OperationJournal<'_>,
        operation_id: &str,
        phase: BranchOperationPhase,
        status: &RepoStatus,
        head_oid: &str,
        detail: &str,
    ) -> Result<()> {
        let status_bytes = serde_json::to_vec(status)?;
        let token = format!("sha256:{:x}", Sha256::digest(&status_bytes));
        let head_json = serde_json::json!({
            "checkout": status.checkout,
            "oid": head_oid,
        });
        journal.record_observation(operation_id, phase, &head_json, &token, detail)
    }

    fn rollback_stashed(
        &self,
        identity: &RepositoryIdentity,
        journal: &OperationJournal<'_>,
        operation_id: &str,
        cause: CoreError,
        detail: &str,
    ) -> CoreError {
        let cause_text = cause.to_string();
        if let Err(journal_error) = journal.update(
            operation_id,
            BranchOperationPhase::RecoveryRequired,
            None,
            Some(&cause_text),
            Some(detail),
        ) {
            return CoreError::Git(format!(
                "{cause}; operation journal update also failed: {journal_error}"
            ));
        }
        let restore = journal.get(operation_id).and_then(|operation| {
            self.restore_locked(identity, &operation, RestoreStrategy::Source)
        });
        match restore {
            Ok(()) => cause,
            Err(restore_error) => CoreError::Git(format!(
                "{cause}; automatic source restore stopped and the stash was retained: {restore_error}"
            )),
        }
    }
}

fn git_output_error(output: &GitOutput) -> String {
    if output.timed_out {
        format!(
            "git command timed out after it was terminated: {}",
            output.stderr_lossy().trim()
        )
    } else {
        format!(
            "git command exited {:?}: {}",
            output.exit_code(),
            output.stderr_lossy().trim()
        )
    }
}

fn command_observation(result: &Result<GitOutput>) -> String {
    match result {
        Ok(output) => format!(
            "exit={:?},timed_out={}",
            output.exit_code(),
            output.timed_out
        ),
        Err(error) => error.to_string(),
    }
}

fn parse_stash_marker(marker: &str) -> Option<ParsedStashMarker> {
    let rest = marker.strip_prefix("agentport:v1:op=")?;
    let (operation_id, rest) = rest.split_once(":repo=")?;
    let (repo_key, rest) = rest.split_once(":source=")?;
    let target_separator = rest.find(":target=")?;
    let source_oid_separator = rest.find(":sourceOid=");
    let (source, source_oid, target_rest) = match source_oid_separator {
        Some(position) if position < target_separator => {
            let source = &rest[..position];
            let after = &rest[position + ":sourceOid=".len()..];
            let (source_oid, target_rest) = after.split_once(":target=")?;
            (source, Some(source_oid), target_rest)
        }
        _ => {
            let source = &rest[..target_separator];
            let target_rest = &rest[target_separator + ":target=".len()..];
            (source, None, target_rest)
        }
    };
    let (target, target_oid, created_at) = if let Some(position) = target_rest.find(":targetOid=") {
        let target = &target_rest[..position];
        let after = &target_rest[position + ":targetOid=".len()..];
        let (target_oid, created_at) = after.split_once(":at=")?;
        (target, Some(target_oid), created_at)
    } else {
        let (target, created_at) = target_rest.split_once(":at=")?;
        (target, None, created_at)
    };
    let created_at = chrono::DateTime::parse_from_rfc3339(created_at)
        .ok()?
        .with_timezone(&Utc);
    Some(ParsedStashMarker {
        operation_id: operation_id.to_owned(),
        repo_key: repo_key.to_owned(),
        source: source.to_owned(),
        source_oid: source_oid.map(str::to_owned),
        target: target.to_owned(),
        target_oid: target_oid.map(str::to_owned),
        created_at,
    })
}

fn is_hex_oid(value: &str) -> bool {
    (40..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn git_result_error(result: Result<GitOutput>) -> Option<CoreError> {
    match result {
        Ok(output) if output.success() => None,
        Ok(output) if output.timed_out => Some(CoreError::Timeout(git_output_error(&output))),
        Ok(output) => Some(CoreError::Git(git_output_error(&output))),
        Err(error) => Some(error),
    }
}

#[cfg(test)]
fn parse_status_v2(raw: &[u8]) -> Result<RepoStatus> {
    super::status::parse_repo_status_v2(raw)
}

fn parse_branches(raw: &[u8]) -> Result<Vec<BranchInfo>> {
    let fields = nul_records(raw, 5)?;
    fields
        .into_iter()
        .map(|record| {
            let refname = bytes_to_string(record[0])?;
            let name = refname
                .strip_prefix("refs/heads/")
                .ok_or_else(|| CoreError::Internal(format!("unexpected local ref {refname}")))?
                .to_owned();
            let worktree = bytes_to_string(record[3])?;
            Ok(BranchInfo {
                name,
                oid: bytes_to_string(record[1])?,
                current: record[2] == b"*",
                occupied_worktree: (!worktree.is_empty()).then_some(worktree),
            })
        })
        .collect()
}

fn parse_stashes(raw: &[u8]) -> Result<Vec<StashRecord>> {
    nul_records(raw, 3)?
        .into_iter()
        .map(|record| {
            Ok(StashRecord {
                selector: bytes_to_string(record[0])?,
                oid: bytes_to_string(record[1])?,
                message: bytes_to_string(record[2])?,
            })
        })
        .collect()
}

fn nul_records(raw: &[u8], width: usize) -> Result<Vec<Vec<&[u8]>>> {
    let mut fields = raw.split(|byte| *byte == 0).collect::<Vec<_>>();
    if matches!(fields.last(), Some(field) if field.is_empty()) {
        fields.pop();
    }
    if matches!(fields.last(), Some(field) if *field == b"\n") {
        fields.pop();
    }
    for index in (0..fields.len()).step_by(width) {
        if let Some(field) = fields.get_mut(index) {
            *field = field.strip_prefix(b"\n").unwrap_or(field);
        }
    }
    if fields.len() % width != 0 {
        return Err(CoreError::Internal(format!(
            "malformed NUL-delimited Git record: {} fields for width {width}",
            fields.len()
        )));
    }
    Ok(fields.chunks(width).map(|chunk| chunk.to_vec()).collect())
}

fn detect_operation_state(git_dir: &Path) -> Option<String> {
    [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry_pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
        ("sequencer", "sequencer"),
    ]
    .into_iter()
    .find_map(|(path, state)| git_dir.join(path).exists().then(|| state.to_owned()))
}

fn hash_path(path: &Path) -> Result<Option<String>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CoreError::Io(error)),
    };
    let mut hash = Sha256::new();
    if metadata.file_type().is_symlink() {
        hash.update(b"symlink\0");
        hash.update(path_bytes(&std::fs::read_link(path)?));
    } else if metadata.is_file() {
        hash.update(b"file\0");
        let mut file = std::fs::File::open(path)?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
        }
    } else {
        hash.update(b"other\0");
    }
    Ok(Some(format!("{:x}", hash.finalize())))
}

fn path_mode(path: &Path) -> Result<Option<u32>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CoreError::Io(error)),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(Some(metadata.permissions().mode() & 0o7777))
    }
    #[cfg(not(unix))]
    {
        Ok(Some(u32::from(metadata.permissions().readonly())))
    }
}

fn canonical_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn bytes_to_string(bytes: &[u8]) -> Result<String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        CoreError::Validation(
            "AgentPort branch management currently requires UTF-8 repository path names".into(),
        )
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        AgentTransport, AgentType, PermissionMode, Project, ResumePrecision, Session,
    };
    use chrono::Utc;
    use tempfile::TempDir;

    struct Fixture {
        _temp: TempDir,
        root: PathBuf,
        db: Db,
        project_id: String,
    }

    fn git(root: &Path, args: &[&str]) -> String {
        GitRunner::default()
            .run(Some(root), args)
            .unwrap()
            .require_success()
            .unwrap()
            .stdout_lossy()
    }

    fn commit(root: &Path, path: &str, contents: &str, message: &str) {
        let file = root.join(path);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(file, contents).unwrap();
        git(root, &["add", "--", path]);
        git(
            root,
            &["-c", "commit.gpgsign=false", "commit", "-m", message],
        );
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let raw = temp.path().join("repo ü");
        std::fs::create_dir(&raw).unwrap();
        git(&raw, &["init", "-b", "main"]);
        git(&raw, &["config", "user.name", "AgentPort"]);
        git(&raw, &["config", "user.email", "agentport@test.invalid"]);
        commit(&raw, "tracked.txt", "base\n", "initial");
        let root = std::fs::canonicalize(raw).unwrap();
        let db = Db::open_memory().unwrap();
        let project_id = "prj_branch".to_owned();
        db.add_project(&Project {
            id: project_id.clone(),
            name: "Branch tests".into(),
            root_path: root.to_string_lossy().into_owned(),
            git_root_path: Some(root.to_string_lossy().into_owned()),
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
        Fixture {
            _temp: temp,
            root,
            db,
            project_id,
        }
    }

    fn manager(fixture: &Fixture) -> BranchManager<'_> {
        BranchManager::new(&fixture.db)
    }

    fn make_branch(root: &Path, name: &str) {
        git(root, &["branch", name]);
    }

    #[test]
    fn status_v2_parses_mixed_dirty_and_unicode() {
        let fixture = fixture();
        std::fs::write(fixture.root.join("tracked.txt"), "staged\n").unwrap();
        git(&fixture.root, &["add", "tracked.txt"]);
        std::fs::write(fixture.root.join("tracked.txt"), "unstaged\n").unwrap();
        std::fs::write(fixture.root.join("未跟踪.txt"), "hello\n").unwrap();
        let status = manager(&fixture).list(&fixture.project_id).unwrap().status;
        assert!(status.staged && status.unstaged && status.untracked);
        assert!(status.paths.iter().any(|path| path.path == "未跟踪.txt"));
    }

    #[test]
    fn list_create_and_clean_switch() {
        let fixture = fixture();
        let manager = manager(&fixture);
        let created = manager
            .create(&fixture.project_id, "feature/本地", None)
            .unwrap();
        assert_eq!(created.branch.name, "feature/本地");
        let outcome = manager.switch(&fixture.project_id, "feature/本地").unwrap();
        assert!(!outcome.stashed);
        assert!(matches!(
            manager.list(&fixture.project_id).unwrap().status.checkout,
            CheckoutState::Branch(ref branch) if branch == "feature/本地"
        ));
        assert_eq!(
            manager.operation(&outcome.operation_id).unwrap().phase,
            BranchOperationPhase::Completed
        );
    }

    #[test]
    fn create_and_switch_completes_under_one_branch_operation() {
        let fixture = fixture();
        let outcome = manager(&fixture)
            .create_and_switch(&fixture.project_id, "feature/atomic", None)
            .unwrap();

        assert_eq!(outcome.target_branch, "feature/atomic");
        assert!(!outcome.stashed);
        assert!(matches!(
            manager(&fixture).list(&fixture.project_id).unwrap().status.checkout,
            CheckoutState::Branch(ref branch) if branch == "feature/atomic"
        ));
    }

    #[test]
    fn create_and_switch_preserves_live_sessions() {
        for lifecycle in [Lifecycle::Creating, Lifecycle::Running] {
            let fixture = fixture();
            fixture
                .db
                .insert_session(&Session {
                    id: "ses_create_switch_live".into(),
                    project_id: fixture.project_id.clone(),
                    worktree_id: None,
                    preset_id: "preset".into(),
                    title: "live create and switch".into(),
                    cwd: fixture.root.to_string_lossy().into_owned(),
                    host_pid: None,
                    host_socket: None,
                    host_token: "token".into(),
                    lifecycle: lifecycle.clone(),
                    agent_session_id: None,
                    resume_precision: ResumePrecision::Unavailable,
                    log_path: fixture.root.join("log").to_string_lossy().into_owned(),
                    adapter_type: AgentType::Shell,
                    transport: AgentTransport::Pty,
                    command: vec![],
                    permission_mode: PermissionMode::Native,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                    pinned_at: None,
                    archived_at: None,
                })
                .unwrap();

            std::fs::write(fixture.root.join("tracked.txt"), "session edits\n").unwrap();
            let outcome = manager(&fixture)
                .create_and_switch(&fixture.project_id, "feature/live", None)
                .unwrap();
            assert!(outcome.stashed);

            assert!(matches!(
                manager(&fixture).list(&fixture.project_id).unwrap().status.checkout,
                CheckoutState::Branch(ref branch) if branch == "feature/live"
            ));
            assert_eq!(
                fixture.db.get_session("ses_create_switch_live").unwrap().lifecycle,
                lifecycle
            );
        }
    }

    #[test]
    fn create_and_switch_rolls_back_the_new_ref_when_checkout_is_blocked() {
        let fixture = fixture();
        git(
            &fixture.root,
            &["switch", "-c", "start-with-generated-file"],
        );
        commit(
            &fixture.root,
            "generated/cache.bin",
            "tracked target\n",
            "target file",
        );
        git(&fixture.root, &["switch", "main"]);
        std::fs::write(fixture.root.join(".gitignore"), "generated/\n").unwrap();
        std::fs::create_dir_all(fixture.root.join("generated")).unwrap();
        std::fs::write(fixture.root.join("generated/cache.bin"), "local secret\n").unwrap();
        let before = hash_path(&fixture.root.join("generated/cache.bin")).unwrap();

        let error = manager(&fixture)
            .create_and_switch(
                &fixture.project_id,
                "feature/rolled-back",
                Some("start-with-generated-file"),
            )
            .unwrap_err();

        assert!(matches!(error, CoreError::Blocked(_)), "{error}");
        assert!(!manager(&fixture)
            .list(&fixture.project_id)
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "feature/rolled-back"));
        assert!(matches!(
            manager(&fixture).list(&fixture.project_id).unwrap().status.checkout,
            CheckoutState::Branch(ref branch) if branch == "main"
        ));
        assert_eq!(
            hash_path(&fixture.root.join("generated/cache.bin")).unwrap(),
            before
        );
    }

    #[test]
    fn create_does_not_claim_an_externally_created_same_oid_ref() {
        let fixture = fixture();
        let main_oid = git(&fixture.root, &["rev-parse", "HEAD"]).trim().to_owned();
        let manager = BranchManager {
            db: &fixture.db,
            runner: GitRunner::creating_external_ref_before_update(
                "refs/heads/feature/external-winner",
                &main_oid,
            ),
        };

        let error = manager
            .create_and_switch(&fixture.project_id, "feature/external-winner", None)
            .unwrap_err();

        assert!(matches!(error, CoreError::Git(_)), "{error}");
        assert_eq!(
            git(
                &fixture.root,
                &["rev-parse", "refs/heads/feature/external-winner"]
            )
            .trim(),
            main_oid
        );
        assert!(matches!(
            manager.list(&fixture.project_id).unwrap().status.checkout,
            CheckoutState::Branch(ref branch) if branch == "main"
        ));
    }

    #[test]
    fn create_and_switch_retains_ref_required_by_stash_recovery() {
        let fixture = fixture();
        std::fs::write(fixture.root.join("tracked.txt"), "dirty\n").unwrap();
        let manager = BranchManager {
            db: &fixture.db,
            runner: GitRunner::failing_once("switch"),
        };

        let error = manager
            .create_and_switch(&fixture.project_id, "feature/recovery-target", None)
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("could not be safely rolled back"));
        assert!(manager
            .list(&fixture.project_id)
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "feature/recovery-target"));
        let pending = manager.list_auto_stashes(&fixture.project_id).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].target_branch, "feature/recovery-target");
        assert_eq!(pending[0].phase, BranchOperationPhase::RestoredVerified);
    }

    #[test]
    fn rollback_restores_ref_if_an_external_worktree_occupies_it_during_delete() {
        let fixture = fixture();
        git(
            &fixture.root,
            &["switch", "-c", "start-with-generated-file"],
        );
        commit(
            &fixture.root,
            "generated/cache.bin",
            "tracked target\n",
            "target file",
        );
        git(&fixture.root, &["switch", "main"]);
        std::fs::write(fixture.root.join(".gitignore"), "generated/\n").unwrap();
        std::fs::create_dir_all(fixture.root.join("generated")).unwrap();
        std::fs::write(fixture.root.join("generated/cache.bin"), "local secret\n").unwrap();
        let occupied_path = fixture.root.parent().unwrap().join("occupied rollback");
        let manager = BranchManager {
            db: &fixture.db,
            runner: GitRunner::occupying_branch_before_delete(
                "feature/occupied-during-rollback",
                &occupied_path,
            ),
        };

        let error = manager
            .create_and_switch(
                &fixture.project_id,
                "feature/occupied-during-rollback",
                Some("start-with-generated-file"),
            )
            .unwrap_err();

        assert!(
            error.to_string().contains("its ref was restored"),
            "{error}"
        );
        assert!(manager
            .list(&fixture.project_id)
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "feature/occupied-during-rollback"
                && branch.occupied_worktree.is_some()));
    }

    #[test]
    fn mixed_dirty_switch_requires_explicit_restore_and_cleanup() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("tracked.txt"), "staged value\n").unwrap();
        git(&fixture.root, &["add", "tracked.txt"]);
        std::fs::write(fixture.root.join("tracked.txt"), "working value\n").unwrap();
        std::fs::write(fixture.root.join("new file.txt"), "untracked\n").unwrap();
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        assert!(outcome.stashed && outcome.pending_restore && !outcome.restored);
        assert_eq!(
            manager(&fixture)
                .operation(&outcome.operation_id)
                .unwrap()
                .phase,
            BranchOperationPhase::Switched
        );
        assert!(!git(&fixture.root, &["stash", "list"]).trim().is_empty());
        let auto_stashes = manager(&fixture)
            .list_auto_stashes(&fixture.project_id)
            .unwrap();
        assert_eq!(auto_stashes.len(), 1);
        assert_eq!(auto_stashes[0].phase, BranchOperationPhase::Switched);
        let cleanup_error = manager(&fixture)
            .cleanup(&outcome.operation_id)
            .unwrap_err();
        assert!(matches!(cleanup_error, CoreError::Blocked(_)));
        let restored = manager(&fixture)
            .recover(&outcome.operation_id, RestoreStrategy::Target)
            .unwrap();
        assert_eq!(restored.phase, BranchOperationPhase::RestoredVerified);
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
            "working value\n"
        );
        assert_eq!(
            git(&fixture.root, &["show", ":tracked.txt"]),
            "staged value\n"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("new file.txt")).unwrap(),
            "untracked\n"
        );
        assert!(!git(&fixture.root, &["stash", "list"]).trim().is_empty());
        let completed = manager(&fixture).cleanup(&outcome.operation_id).unwrap();
        assert_eq!(completed.phase, BranchOperationPhase::Completed);
        assert!(git(&fixture.root, &["stash", "list"]).trim().is_empty());
        let steps = manager(&fixture)
            .operation_steps(&outcome.operation_id)
            .unwrap();
        assert!(steps
            .iter()
            .any(|step| step.phase == BranchOperationPhase::RestoredVerified));
    }

    #[test]
    fn ignored_collision_blocks_without_mutating_checkout() {
        let fixture = fixture();
        git(&fixture.root, &["switch", "-c", "target"]);
        commit(
            &fixture.root,
            "generated/cache.bin",
            "tracked target\n",
            "target file",
        );
        git(&fixture.root, &["switch", "main"]);
        std::fs::write(fixture.root.join(".gitignore"), "generated/\n").unwrap();
        std::fs::create_dir_all(fixture.root.join("generated")).unwrap();
        std::fs::write(fixture.root.join("generated/cache.bin"), "local secret\n").unwrap();
        let before = hash_path(&fixture.root.join("generated/cache.bin")).unwrap();
        let head = git(&fixture.root, &["rev-parse", "HEAD"]);
        let error = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap_err();
        assert!(matches!(error, CoreError::Blocked(_)), "{error}");
        assert_eq!(
            hash_path(&fixture.root.join("generated/cache.bin")).unwrap(),
            before
        );
        assert_eq!(git(&fixture.root, &["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn ignored_descendant_blocks_directory_to_file_replacement_without_data_loss() {
        let fixture = fixture();
        commit(
            &fixture.root,
            ".gitignore",
            "foo/\n",
            "ignore local foo directory",
        );
        git(&fixture.root, &["switch", "-c", "target-file"]);
        std::fs::write(fixture.root.join("foo"), "tracked target file\n").unwrap();
        git(&fixture.root, &["add", "--", "foo"]);
        git(
            &fixture.root,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "target replaces foo directory",
            ],
        );
        git(&fixture.root, &["switch", "main"]);
        std::fs::create_dir(fixture.root.join("foo")).unwrap();
        std::fs::write(
            fixture.root.join("foo/valuable.bin"),
            b"do not delete\0\xff",
        )
        .unwrap();
        let before = hash_path(&fixture.root.join("foo/valuable.bin")).unwrap();
        let head = git(&fixture.root, &["rev-parse", "HEAD"]);

        let error = manager(&fixture)
            .switch(&fixture.project_id, "target-file")
            .unwrap_err();
        assert!(matches!(error, CoreError::Blocked(_)), "{error}");
        assert_eq!(
            hash_path(&fixture.root.join("foo/valuable.bin")).unwrap(),
            before
        );
        assert_eq!(git(&fixture.root, &["rev-parse", "HEAD"]), head);
        assert!(git(&fixture.root, &["stash", "list"]).trim().is_empty());
    }

    #[test]
    fn ignored_path_without_collision_allows_switch() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join(".gitignore"), "scratch/\n").unwrap();
        std::fs::create_dir(fixture.root.join("scratch")).unwrap();
        std::fs::write(fixture.root.join("scratch/local"), "keep\n").unwrap();
        manager(&fixture)
            .switch(&fixture.project_id, "target")
            .and_then(|outcome| {
                manager(&fixture)
                    .recover(&outcome.operation_id, RestoreStrategy::Target)
                    .map(|_| outcome)
            })
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("scratch/local")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn detached_dirty_checkout_can_switch_and_restore() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        git(&fixture.root, &["switch", "--detach", "HEAD"]);
        std::fs::write(fixture.root.join("tracked.txt"), "detached dirty\n").unwrap();
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        manager(&fixture)
            .recover(&outcome.operation_id, RestoreStrategy::Target)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
            "detached dirty\n"
        );
    }

    #[test]
    fn unborn_and_ongoing_operation_are_blocked() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("unborn");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        let db = Db::open_memory().unwrap();
        db.add_project(&Project {
            id: "unborn".into(),
            name: "unborn".into(),
            root_path: root.to_string_lossy().into_owned(),
            git_root_path: Some(root.to_string_lossy().into_owned()),
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
        let error = BranchManager::new(&db)
            .create("unborn", "branch", None)
            .unwrap_err();
        assert!(matches!(error, CoreError::Blocked(_)));

        let fixture = fixture();
        make_branch(&fixture.root, "target");
        for (sentinel, directory) in [
            ("MERGE_HEAD", false),
            ("CHERRY_PICK_HEAD", false),
            ("REVERT_HEAD", false),
            ("BISECT_LOG", false),
            ("rebase-merge", true),
            ("rebase-apply", true),
            ("sequencer", true),
        ] {
            let path = fixture.root.join(".git").join(sentinel);
            if directory {
                std::fs::create_dir(&path).unwrap();
            } else {
                std::fs::write(&path, "fake\n").unwrap();
            }
            let error = manager(&fixture)
                .switch(&fixture.project_id, "target")
                .unwrap_err();
            assert!(
                matches!(error, CoreError::Blocked(_)),
                "{sentinel}: {error}"
            );
            if directory {
                std::fs::remove_dir(&path).unwrap();
            } else {
                std::fs::remove_file(&path).unwrap();
            }
        }
    }

    #[test]
    fn occupied_linked_worktree_is_blocked() {
        let fixture = fixture();
        make_branch(&fixture.root, "occupied");
        let linked = fixture._temp.path().join("linked");
        git(
            &fixture.root,
            &["worktree", "add", linked.to_str().unwrap(), "occupied"],
        );
        let error = manager(&fixture)
            .switch(&fixture.project_id, "occupied")
            .unwrap_err();
        assert!(matches!(error, CoreError::Blocked(_)), "{error}");
    }

    #[test]
    fn session_in_other_linked_worktree_does_not_block_main_checkout() {
        let fixture = fixture();
        make_branch(&fixture.root, "linked-session");
        make_branch(&fixture.root, "target");
        let linked = fixture._temp.path().join("linked-session");
        git(
            &fixture.root,
            &[
                "worktree",
                "add",
                linked.to_str().unwrap(),
                "linked-session",
            ],
        );
        fixture
            .db
            .insert_session(&Session {
                id: "ses_linked".into(),
                project_id: fixture.project_id.clone(),
                worktree_id: None,
                preset_id: "preset".into(),
                title: "linked".into(),
                cwd: linked.to_string_lossy().into_owned(),
                host_pid: None,
                host_socket: None,
                host_token: "token".into(),
                lifecycle: Lifecycle::Creating,
                agent_session_id: None,
                resume_precision: ResumePrecision::Unavailable,
                log_path: linked.join("log").to_string_lossy().into_owned(),
                adapter_type: AgentType::Shell,
                transport: AgentTransport::Pty,
                command: vec![],
                permission_mode: PermissionMode::Native,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                pinned_at: None,
                archived_at: None,
            })
            .unwrap();
        manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
    }

    #[test]
    fn apply_conflict_retains_exact_stash_and_recovery_journal() {
        let fixture = fixture();
        git(&fixture.root, &["switch", "-c", "target"]);
        commit(
            &fixture.root,
            "tracked.txt",
            "target version\n",
            "target change",
        );
        git(&fixture.root, &["switch", "main"]);
        std::fs::write(fixture.root.join("tracked.txt"), "local version\n").unwrap();
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        let error = manager(&fixture)
            .recover(&outcome.operation_id, RestoreStrategy::Target)
            .unwrap_err();
        assert!(matches!(error, CoreError::Conflict(_)), "{error}");
        assert_eq!(
            manager(&fixture)
                .operation(&outcome.operation_id)
                .unwrap()
                .phase,
            BranchOperationPhase::RecoveryRequired
        );
        assert_eq!(
            manager(&fixture)
                .list_auto_stashes(&fixture.project_id)
                .unwrap()
                .len(),
            1
        );
        assert!(!git(&fixture.root, &["stash", "list"]).trim().is_empty());
    }

    #[test]
    fn dirty_submodule_blocks_branch_switch() {
        let fixture = fixture();
        let child = fixture._temp.path().join("child");
        std::fs::create_dir(&child).unwrap();
        git(&child, &["init", "-b", "main"]);
        git(&child, &["config", "user.name", "AgentPort"]);
        git(&child, &["config", "user.email", "agentport@test.invalid"]);
        commit(&child, "child.txt", "base\n", "child initial");
        git(
            &fixture.root,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                child.to_str().unwrap(),
                "vendor/child",
            ],
        );
        git(&fixture.root, &["add", ".gitmodules", "vendor/child"]);
        git(
            &fixture.root,
            &["-c", "commit.gpgsign=false", "commit", "-m", "add child"],
        );
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("vendor/child/child.txt"), "dirty child\n").unwrap();
        let status = manager(&fixture).list(&fixture.project_id).unwrap().status;
        assert!(status.dirty_submodule);
        let error = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap_err();
        assert!(matches!(error, CoreError::Blocked(_)), "{error}");
    }

    #[test]
    fn create_and_switch_separately_preserve_live_sessions() {
        for lifecycle in [Lifecycle::Creating, Lifecycle::Running] {
            let fixture = fixture();
            make_branch(&fixture.root, "target");
            fixture
                .db
                .insert_session(&Session {
                    id: "ses_live".into(),
                    project_id: fixture.project_id.clone(),
                    worktree_id: None,
                    preset_id: "preset".into(),
                    title: "live".into(),
                    cwd: fixture.root.to_string_lossy().into_owned(),
                    host_pid: None,
                    host_socket: None,
                    host_token: "token".into(),
                    lifecycle: lifecycle.clone(),
                    agent_session_id: None,
                    resume_precision: ResumePrecision::Unavailable,
                    log_path: fixture.root.join("log").to_string_lossy().into_owned(),
                    adapter_type: AgentType::Shell,
                    transport: AgentTransport::Pty,
                    command: vec![],
                    permission_mode: PermissionMode::Native,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                    pinned_at: None,
                    archived_at: None,
                })
                .unwrap();
            manager(&fixture)
                .create(&fixture.project_id, "feature/live", None)
                .unwrap();
            manager(&fixture)
                .switch(&fixture.project_id, "target")
                .unwrap();
            assert_eq!(fixture.db.get_session("ses_live").unwrap().lifecycle, lifecycle);
            assert!(matches!(
                manager(&fixture).list(&fixture.project_id).unwrap().status.checkout,
                CheckoutState::Branch(ref branch) if branch == "target"
            ));
        }
    }

    #[test]
    fn live_session_in_current_checkout_does_not_block_deleting_an_unoccupied_branch() {
        let fixture = fixture();
        make_branch(&fixture.root, "merged-unused");
        fixture
            .db
            .insert_session(&Session {
                id: "ses_live_delete".into(),
                project_id: fixture.project_id.clone(),
                worktree_id: None,
                preset_id: "preset".into(),
                title: "live delete".into(),
                cwd: fixture.root.to_string_lossy().into_owned(),
                host_pid: None,
                host_socket: None,
                host_token: "token".into(),
                lifecycle: Lifecycle::Running,
                agent_session_id: None,
                resume_precision: ResumePrecision::Unavailable,
                log_path: fixture.root.join("log").to_string_lossy().into_owned(),
                adapter_type: AgentType::Shell,
                transport: AgentTransport::Pty,
                command: vec![],
                permission_mode: PermissionMode::Native,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                pinned_at: None,
                archived_at: None,
            })
            .unwrap();

        manager(&fixture)
            .delete(&fixture.project_id, "merged-unused")
            .unwrap();
    }

    #[test]
    fn external_project_root_drift_is_structured_conflict() {
        let fixture = fixture();
        let conn = fixture.db.conn().lock().unwrap();
        conn.execute(
            "UPDATE projects SET git_root_path=?2 WHERE id=?1",
            rusqlite::params![fixture.project_id, fixture._temp.path().to_string_lossy()],
        )
        .unwrap();
        drop(conn);
        let error = manager(&fixture).list(&fixture.project_id).unwrap_err();
        assert!(matches!(error, CoreError::Conflict(_)), "{error}");
    }

    #[test]
    fn injection_like_branch_name_is_rejected_without_execution() {
        let fixture = fixture();
        let marker = fixture._temp.path().join("pwned");
        let name = format!("evil;touch {}", marker.display());
        assert!(manager(&fixture)
            .create(&fixture.project_id, &name, None)
            .is_err());
        assert!(matches!(
            manager(&fixture).create(&fixture.project_id, "--help", None),
            Err(CoreError::Validation(_))
        ));
        assert!(!marker.exists());
    }

    #[test]
    fn status_parser_handles_conflict_record() {
        let raw = b"# branch.oid deadbeef\0# branch.head main\0u UU N... 100644 100644 100644 100644 a b c conflict.txt\0";
        let status = parse_status_v2(raw).unwrap();
        assert!(status.unmerged);
        assert_eq!(status.paths[0].path, "conflict.txt");
    }

    #[test]
    fn repository_initialized_after_project_add_is_rediscovered_without_boundary_expansion() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("late git");
        std::fs::create_dir(&root).unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&Project {
            id: "late_git".into(),
            name: "late git".into(),
            root_path: root.to_string_lossy().into_owned(),
            git_root_path: None,
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
        assert!(matches!(
            BranchManager::new(&db).list("late_git"),
            Err(CoreError::NotFound(_))
        ));
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "AgentPort"]);
        git(&root, &["config", "user.email", "agentport@test.invalid"]);
        commit(&root, "tracked.txt", "base\n", "initial");
        let snapshot = BranchManager::new(&db).list("late_git").unwrap();
        assert!(matches!(
            snapshot.status.checkout,
            CheckoutState::Branch(ref name) if name == "main"
        ));

        let parent = temp.path().join("parent repo");
        let child = parent.join("child");
        std::fs::create_dir_all(&child).unwrap();
        git(&parent, &["init", "-b", "main"]);
        db.add_project(&Project {
            id: "expanded".into(),
            name: "expanded".into(),
            root_path: child.to_string_lossy().into_owned(),
            git_root_path: None,
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
        assert!(matches!(
            BranchManager::new(&db).list("expanded"),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn create_accepts_only_local_start_and_never_sets_tracking() {
        let fixture = fixture();
        make_branch(&fixture.root, "local-base");
        // A same-named tag makes an unqualified start point ambiguous. The
        // implementation must use the already resolved local-branch OID.
        git(&fixture.root, &["tag", "local-base", "HEAD"]);
        git(
            &fixture.root,
            &["update-ref", "refs/remotes/origin/remote-only", "HEAD"],
        );
        let manager = manager(&fixture);
        let created = manager
            .create(&fixture.project_id, "feature/local", Some("local-base"))
            .unwrap();
        assert_eq!(
            created.branch.oid,
            git(&fixture.root, &["rev-parse", "refs/heads/local-base"]).trim()
        );
        let tracking = GitRunner::default()
            .run(
                Some(&fixture.root),
                ["config", "--get", "branch.feature/local.remote"],
            )
            .unwrap();
        assert!(!tracking.success());
        assert!(matches!(
            manager.create(
                &fixture.project_id,
                "feature/from-remote",
                Some("origin/remote-only")
            ),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn renamed_target_path_still_checks_ignored_collision() {
        let fixture = fixture();
        git(&fixture.root, &["switch", "-c", "renamed-target"]);
        std::fs::create_dir_all(fixture.root.join("generated")).unwrap();
        git(&fixture.root, &["mv", "tracked.txt", "generated/cache.bin"]);
        git(
            &fixture.root,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "rename target",
            ],
        );
        git(&fixture.root, &["switch", "main"]);
        std::fs::write(fixture.root.join(".gitignore"), "generated/\n").unwrap();
        std::fs::create_dir_all(fixture.root.join("generated")).unwrap();
        std::fs::write(fixture.root.join("generated/cache.bin"), "local ignored\n").unwrap();
        let before = hash_path(&fixture.root.join("generated/cache.bin")).unwrap();
        assert!(matches!(
            manager(&fixture).switch(&fixture.project_id, "renamed-target"),
            Err(CoreError::Blocked(_))
        ));
        assert_eq!(
            hash_path(&fixture.root.join("generated/cache.bin")).unwrap(),
            before
        );
    }

    #[test]
    fn injected_switch_failure_rolls_back_source_and_retains_verified_stash() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("tracked.txt"), "staged\n").unwrap();
        git(&fixture.root, &["add", "tracked.txt"]);
        std::fs::write(fixture.root.join("tracked.txt"), "working\n").unwrap();
        std::fs::write(fixture.root.join("untracked.txt"), "untracked\n").unwrap();
        let manager = BranchManager {
            db: &fixture.db,
            runner: GitRunner::failing_once("switch"),
        };
        assert!(manager.switch(&fixture.project_id, "target").is_err());
        let pending = manager.list_auto_stashes(&fixture.project_id).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].phase, BranchOperationPhase::RestoredVerified);
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
            "working\n"
        );
        assert_eq!(git(&fixture.root, &["show", ":tracked.txt"]), "staged\n");
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("untracked.txt")).unwrap(),
            "untracked\n"
        );
        assert!(matches!(
            manager.list(&fixture.project_id).unwrap().status.checkout,
            CheckoutState::Branch(ref branch) if branch == "main"
        ));
        assert!(!git(&fixture.root, &["stash", "list"]).trim().is_empty());
    }

    #[test]
    fn injected_oid_checked_cleanup_failure_keeps_verified_state_and_is_retryable() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("tracked.txt"), "dirty\n").unwrap();
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        manager(&fixture)
            .recover(&outcome.operation_id, RestoreStrategy::Target)
            .unwrap();
        let failing = BranchManager {
            db: &fixture.db,
            runner: GitRunner::failing_once("update-ref"),
        };
        assert!(failing.cleanup(&outcome.operation_id).is_err());
        assert_eq!(
            failing.operation(&outcome.operation_id).unwrap().phase,
            BranchOperationPhase::RestoredVerified
        );
        assert!(!git(&fixture.root, &["stash", "list"]).trim().is_empty());
        manager(&fixture).cleanup(&outcome.operation_id).unwrap();
        assert!(git(&fixture.root, &["stash", "list"]).trim().is_empty());
    }

    #[test]
    fn restart_reconcile_discovers_pending_operation_and_exact_stash() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("tracked.txt"), "dirty\n").unwrap();
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        drop(manager(&fixture));
        let restarted = BranchManager::new(&fixture.db);
        let report = restarted.reconcile(&fixture.project_id).unwrap();
        assert_eq!(report.incomplete.len(), 1);
        assert_eq!(report.incomplete[0].id, outcome.operation_id);
        let stashes = restarted.list_auto_stashes(&fixture.project_id).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(
            stashes[0].oid,
            report.incomplete[0].stash_oid.as_deref().unwrap()
        );
    }

    #[test]
    fn return_to_source_restores_exact_content_and_index() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("tracked.txt"), "source staged\n").unwrap();
        git(&fixture.root, &["add", "tracked.txt"]);
        std::fs::write(fixture.root.join("tracked.txt"), "source working\n").unwrap();
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        let restored = manager(&fixture)
            .recover(&outcome.operation_id, RestoreStrategy::Source)
            .unwrap();
        assert_eq!(restored.phase, BranchOperationPhase::RestoredVerified);
        assert!(matches!(
            manager(&fixture).list(&fixture.project_id).unwrap().status.checkout,
            CheckoutState::Branch(ref branch) if branch == "main"
        ));
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
            "source working\n"
        );
        assert_eq!(
            git(&fixture.root, &["show", ":tracked.txt"]),
            "source staged\n"
        );
        assert!(!git(&fixture.root, &["stash", "list"]).trim().is_empty());
    }

    #[test]
    fn real_unresolved_conflict_blocks_without_mutation() {
        let fixture = fixture();
        git(&fixture.root, &["switch", "-c", "conflicting"]);
        commit(
            &fixture.root,
            "tracked.txt",
            "target conflict\n",
            "target conflict",
        );
        git(&fixture.root, &["switch", "main"]);
        commit(
            &fixture.root,
            "tracked.txt",
            "source conflict\n",
            "source conflict",
        );
        let merge = GitRunner::default()
            .run(Some(&fixture.root), ["merge", "conflicting"])
            .unwrap();
        assert!(!merge.success());
        let before = git(&fixture.root, &["rev-parse", "HEAD"]);
        let error = manager(&fixture)
            .switch(&fixture.project_id, "conflicting")
            .unwrap_err();
        assert!(matches!(error, CoreError::Blocked(_)), "{error}");
        assert_eq!(git(&fixture.root, &["rev-parse", "HEAD"]), before);
        assert!(
            manager(&fixture)
                .list(&fixture.project_id)
                .unwrap()
                .status
                .unmerged
        );
    }

    #[test]
    fn same_common_dir_switches_are_serialized_across_threads() {
        let fixture = fixture();
        make_branch(&fixture.root, "target-a");
        make_branch(&fixture.root, "target-b");
        let (first, second) = std::thread::scope(|scope| {
            let first = scope
                .spawn(|| BranchManager::new(&fixture.db).switch(&fixture.project_id, "target-a"));
            let second = scope
                .spawn(|| BranchManager::new(&fixture.db).switch(&fixture.project_id, "target-b"));
            (first.join().unwrap(), second.join().unwrap())
        });
        assert!(first.is_ok(), "{first:?}");
        assert!(second.is_ok(), "{second:?}");
        let final_status = manager(&fixture).list(&fixture.project_id).unwrap().status;
        assert!(matches!(
            final_status.checkout,
            CheckoutState::Branch(ref branch) if branch == "target-a" || branch == "target-b"
        ));
    }

    #[test]
    fn live_session_started_after_switch_blocks_restore_and_preserves_stash() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("tracked.txt"), "dirty\n").unwrap();
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        fixture
            .db
            .insert_session(&Session {
                id: "ses_after_switch".into(),
                project_id: fixture.project_id.clone(),
                worktree_id: None,
                preset_id: "preset".into(),
                title: "after switch".into(),
                cwd: fixture.root.to_string_lossy().into_owned(),
                host_pid: None,
                host_socket: None,
                host_token: "token".into(),
                lifecycle: Lifecycle::Running,
                agent_session_id: None,
                resume_precision: ResumePrecision::Unavailable,
                log_path: fixture.root.join("log").to_string_lossy().into_owned(),
                adapter_type: AgentType::Shell,
                transport: AgentTransport::Pty,
                command: vec![],
                permission_mode: PermissionMode::Native,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                pinned_at: None,
                archived_at: None,
            })
            .unwrap();
        assert!(matches!(
            manager(&fixture).recover(&outcome.operation_id, RestoreStrategy::Source),
            Err(CoreError::Blocked(_))
        ));
        assert_eq!(
            manager(&fixture)
                .operation(&outcome.operation_id)
                .unwrap()
                .phase,
            BranchOperationPhase::Switched
        );
        assert!(!git(&fixture.root, &["stash", "list"]).trim().is_empty());
    }

    #[test]
    fn startup_reconcile_repairs_prepared_and_applying_crash_windows() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("tracked.txt"), "dirty\n").unwrap();
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();

        // Simulate exit after stash succeeded but before its OID/selector were
        // persisted. The marker was persisted in the prepared journal first.
        {
            let conn = fixture.db.conn().lock().unwrap();
            conn.execute(
                "UPDATE branch_operations SET phase='prepared',stash_oid=NULL,stash_selector=NULL WHERE id=?1",
                rusqlite::params![outcome.operation_id],
            )
            .unwrap();
        }
        let report = manager(&fixture).reconcile(&fixture.project_id).unwrap();
        assert_eq!(report.incomplete[0].phase, BranchOperationPhase::Stashed);
        assert!(report.incomplete[0].stash_oid.is_some());

        manager(&fixture)
            .recover(&outcome.operation_id, RestoreStrategy::Target)
            .unwrap();
        {
            let conn = fixture.db.conn().lock().unwrap();
            conn.execute(
                "UPDATE branch_operations SET phase='applying' WHERE id=?1",
                rusqlite::params![outcome.operation_id],
            )
            .unwrap();
        }
        let report = manager(&fixture).reconcile(&fixture.project_id).unwrap();
        assert_eq!(
            report.incomplete[0].phase,
            BranchOperationPhase::RestoredVerified
        );
        assert!(!git(&fixture.root, &["stash", "list"]).trim().is_empty());
    }

    #[test]
    fn startup_reconcile_closes_clean_switch_crash_after_checkout() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        {
            let conn = fixture.db.conn().lock().unwrap();
            conn.execute(
                "UPDATE branch_operations
                 SET phase='prepared',completed_at=NULL WHERE id=?1",
                rusqlite::params![outcome.operation_id],
            )
            .unwrap();
        }
        let report = manager(&fixture).reconcile(&fixture.project_id).unwrap();
        assert!(report.incomplete.is_empty());
        assert_eq!(
            manager(&fixture)
                .operation(&outcome.operation_id)
                .unwrap()
                .phase,
            BranchOperationPhase::Completed
        );
        assert!(matches!(
            manager(&fixture)
                .list(&fixture.project_id)
                .unwrap()
                .status
                .checkout,
            CheckoutState::Branch(ref branch) if branch == "target"
        ));
    }

    #[test]
    fn startup_reconcile_imports_marker_stash_missing_its_database_operation() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("tracked.txt"), "orphaned backup\n").unwrap();
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        let stash_oid = manager(&fixture)
            .operation(&outcome.operation_id)
            .unwrap()
            .stash_oid
            .unwrap();
        {
            let conn = fixture.db.conn().lock().unwrap();
            conn.execute(
                "DELETE FROM branch_operations WHERE id=?1",
                rusqlite::params![outcome.operation_id],
            )
            .unwrap();
        }

        let report = manager(&fixture).reconcile(&fixture.project_id).unwrap();
        assert_eq!(report.orphan_marker_stashes.len(), 1);
        let imported = manager(&fixture).operation(&outcome.operation_id).unwrap();
        assert_eq!(imported.phase, BranchOperationPhase::RecoveryRequired);
        assert_eq!(imported.stash_oid.as_deref(), Some(stash_oid.as_str()));
        assert!(imported.snapshot_json.is_none());
        assert_eq!(
            manager(&fixture)
                .list_auto_stashes(&fixture.project_id)
                .unwrap()
                .len(),
            1
        );
        assert!(manager(&fixture)
            .recover(&outcome.operation_id, RestoreStrategy::Target)
            .is_err());
        assert!(git(&fixture.root, &["stash", "list", "--format=%H"])
            .lines()
            .any(|oid| oid == stash_oid));
    }

    #[test]
    fn startup_reconcile_repairs_both_cleanup_crash_windows() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("tracked.txt"), "cleanup crash\n").unwrap();
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        manager(&fixture)
            .recover(&outcome.operation_id, RestoreStrategy::Target)
            .unwrap();
        let stash_oid = manager(&fixture)
            .operation(&outcome.operation_id)
            .unwrap()
            .stash_oid
            .unwrap();

        {
            let conn = fixture.db.conn().lock().unwrap();
            conn.execute(
                "UPDATE branch_operations SET phase='cleaning' WHERE id=?1",
                rusqlite::params![outcome.operation_id],
            )
            .unwrap();
        }
        manager(&fixture).reconcile(&fixture.project_id).unwrap();
        assert_eq!(
            manager(&fixture)
                .operation(&outcome.operation_id)
                .unwrap()
                .phase,
            BranchOperationPhase::RestoredVerified
        );

        {
            let conn = fixture.db.conn().lock().unwrap();
            conn.execute(
                "UPDATE branch_operations SET phase='cleaning' WHERE id=?1",
                rusqlite::params![outcome.operation_id],
            )
            .unwrap();
        }
        git(
            &fixture.root,
            &["update-ref", "-d", "refs/stash", &stash_oid],
        );
        let report = manager(&fixture).reconcile(&fixture.project_id).unwrap();
        assert!(report.incomplete.is_empty());
        assert_eq!(
            manager(&fixture)
                .operation(&outcome.operation_id)
                .unwrap()
                .phase,
            BranchOperationPhase::Completed
        );

        let created = manager(&fixture)
            .create(&fixture.project_id, "created-after-restart", Some("target"))
            .unwrap();
        {
            let conn = fixture.db.conn().lock().unwrap();
            conn.execute(
                "UPDATE branch_operations
                 SET phase='recovery_required',completed_at=NULL WHERE id=?1",
                rusqlite::params![created.operation_id],
            )
            .unwrap();
        }
        let report = manager(&fixture).reconcile(&fixture.project_id).unwrap();
        assert!(report.incomplete.is_empty());
        assert_eq!(
            manager(&fixture)
                .operation(&created.operation_id)
                .unwrap()
                .phase,
            BranchOperationPhase::Completed
        );
    }

    #[test]
    fn startup_reconcile_terminates_no_stash_recovery_records() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        let outcome = manager(&fixture)
            .switch(&fixture.project_id, "target")
            .unwrap();
        {
            let conn = fixture.db.conn().lock().unwrap();
            conn.execute(
                "UPDATE branch_operations
                 SET phase='recovery_required',completed_at=NULL WHERE id=?1",
                rusqlite::params![outcome.operation_id],
            )
            .unwrap();
        }
        let report = manager(&fixture).reconcile(&fixture.project_id).unwrap();
        assert!(report.incomplete.is_empty());
        assert_eq!(
            manager(&fixture)
                .operation(&outcome.operation_id)
                .unwrap()
                .phase,
            BranchOperationPhase::Completed
        );
    }

    #[test]
    fn branch_transaction_command_trace_contains_no_force_or_network_git() {
        let fixture = fixture();
        make_branch(&fixture.root, "target");
        std::fs::write(fixture.root.join("tracked.txt"), "dirty\n").unwrap();
        let (runner, recorded) = GitRunner::recording();
        let manager = BranchManager {
            db: &fixture.db,
            runner,
        };
        let outcome = manager.switch(&fixture.project_id, "target").unwrap();
        manager
            .recover(&outcome.operation_id, RestoreStrategy::Target)
            .unwrap();
        manager.cleanup(&outcome.operation_id).unwrap();
        manager
            .create(&fixture.project_id, "created-local", Some("main"))
            .unwrap();
        manager
            .delete(&fixture.project_id, "created-local")
            .unwrap();

        let recorded = recorded.lock().unwrap();
        assert!(recorded.iter().any(|argv| {
            argv.iter()
                .map(|arg| arg.to_string_lossy())
                .collect::<Vec<_>>()
                .windows(4)
                .any(|window| {
                    window[0] == "update-ref"
                        && window[1] == "-d"
                        && window[2] == "refs/heads/created-local"
                        && !window[3].is_empty()
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
                !matches!(
                    command.as_deref(),
                    Some("fetch" | "pull" | "push" | "reset" | "checkout" | "commit" | "submodule")
                ),
                "forbidden command trace: {argv:?}"
            );
            if command.as_deref() == Some("stash") {
                let subcommand = args.get(1).map(|arg| arg.to_string_lossy());
                assert!(
                    !matches!(subcommand.as_deref(), Some("pop" | "clear")),
                    "forbidden stash command trace: {argv:?}"
                );
            }
            assert!(
                args.iter().all(|arg| {
                    !matches!(
                        arg.to_string_lossy().as_ref(),
                        "--force" | "-f" | "-D" | "--ignore-other-worktrees"
                    )
                }),
                "forbidden force flag trace: {argv:?}"
            );
        }
    }

    #[test]
    fn expected_oid_cas_rejects_branch_moved_immediately_before_delete() {
        let fixture = fixture();
        make_branch(&fixture.root, "cas-target");
        git(&fixture.root, &["switch", "-c", "external-move"]);
        commit(
            &fixture.root,
            "external.txt",
            "external commit\n",
            "external ref move",
        );
        let moved_oid = git(&fixture.root, &["rev-parse", "HEAD"]).trim().to_owned();
        git(&fixture.root, &["switch", "main"]);

        let manager = BranchManager {
            db: &fixture.db,
            runner: GitRunner::moving_ref_before_update("refs/heads/cas-target", &moved_oid),
        };
        let error = manager
            .delete(&fixture.project_id, "cas-target")
            .unwrap_err();
        assert!(matches!(error, CoreError::Conflict(_)), "{error}");
        assert_eq!(
            git(&fixture.root, &["rev-parse", "refs/heads/cas-target"]).trim(),
            moved_oid
        );
    }

    fn latest_delete_operation(fixture: &Fixture) -> BranchOperation {
        let id = fixture
            .db
            .conn()
            .lock()
            .unwrap()
            .query_row(
                "SELECT id FROM branch_operations WHERE kind='delete' ORDER BY created_at DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        manager(fixture).operation(&id).unwrap()
    }

    #[test]
    fn pre_cas_merge_check_failure_terminalizes_delete_as_failed() {
        let fixture = fixture();
        make_branch(&fixture.root, "fail-before-cas");
        let manager = BranchManager {
            db: &fixture.db,
            runner: GitRunner::failing_once("merge-base"),
        };

        let error = manager
            .delete(&fixture.project_id, "fail-before-cas")
            .unwrap_err();

        assert!(matches!(error, CoreError::Git(_)), "{error}");
        assert_eq!(
            latest_delete_operation(&fixture).phase,
            BranchOperationPhase::Failed
        );
        assert!(manager
            .list(&fixture.project_id)
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "fail-before-cas"));
    }

    #[test]
    fn post_cas_branch_enumeration_failure_uses_exact_fallback_and_completes() {
        let fixture = fixture();
        make_branch(&fixture.root, "post-cas-fallback");
        let manager = BranchManager {
            db: &fixture.db,
            // list_branches before journal, refreshed local_branch, upstream
            // lookup, then the post-CAS local_branch observation.
            runner: GitRunner::failing_nth("for-each-ref", 4),
        };

        manager
            .delete(&fixture.project_id, "post-cas-fallback")
            .unwrap();

        assert_eq!(
            latest_delete_operation(&fixture).phase,
            BranchOperationPhase::Completed
        );
        assert!(matches!(
            manager.observe_exact_ref(
                &manager.identity(&fixture.project_id).unwrap(),
                "post-cas-fallback"
            ),
            ExactRefObservation::Absent
        ));
    }

    #[test]
    fn post_cas_worktree_observation_failure_never_leaves_prepared() {
        let fixture = fixture();
        make_branch(&fixture.root, "post-cas-worktree-failure");
        let manager = BranchManager {
            db: &fixture.db,
            // capture_snapshot observes worktrees once; the post-CAS
            // recoverability check is the second invocation.
            runner: GitRunner::failing_nth("worktree", 2),
        };

        let error = manager
            .delete(&fixture.project_id, "post-cas-worktree-failure")
            .unwrap_err();

        assert!(matches!(error, CoreError::Git(_)), "{error}");
        assert_eq!(
            latest_delete_operation(&fixture).phase,
            BranchOperationPhase::RecoveryRequired
        );
    }

    #[test]
    fn post_cas_status_observation_failure_is_nonfatal_after_ref_is_absent() {
        let fixture = fixture();
        make_branch(&fixture.root, "post-cas-status-failure");
        let manager = BranchManager {
            db: &fixture.db,
            // Initial pre-journal status, pre-CAS status, then the optional
            // post-CAS observation in finish_missing_delete_ref.
            runner: GitRunner::failing_nth("status", 3),
        };

        manager
            .delete(&fixture.project_id, "post-cas-status-failure")
            .unwrap();

        assert_eq!(
            latest_delete_operation(&fixture).phase,
            BranchOperationPhase::Completed
        );
    }
}
