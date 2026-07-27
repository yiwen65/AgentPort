use super::command::GitRunOptions;
use super::commit::GitMutationResult;
use super::context::{GitContextLocator, GitWorkspaceManager};
use super::repository::{repository_lock, RepositoryFileLock};
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitRemoteAction {
    Fetch,
    Pull,
    PullAutostash,
    PullRebase,
    PullRebaseAutostash,
    Push,
    ForcePush,
}

impl<'a> GitWorkspaceManager<'a> {
    pub fn sync_remote(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: &str,
        action: GitRemoteAction,
    ) -> Result<GitMutationResult> {
        let initial = self.resolve_internal(locator)?;
        validate_checkout(&initial.descriptor.checkout_id, expected_checkout_id)?;
        let lock = repository_lock(&initial.identity.repo_key);
        let _guard = lock.lock().unwrap();
        let locked = self.resolve_internal(locator)?;
        validate_checkout(&locked.descriptor.checkout_id, expected_checkout_id)?;
        let _file_guard = RepositoryFileLock::acquire(&locked.identity.common_dir)?;
        let snapshot = self.changes(locator, true)?;
        validate_checkout(&snapshot.context.checkout_id, expected_checkout_id)?;
        if !snapshot.context.writable {
            return Err(CoreError::Blocked("this Git Checkout is read-only".into()));
        }
        if !snapshot.complete {
            return Err(CoreError::Blocked(
                "Git Changes is partial; remote operations are disabled".into(),
            ));
        }
        if snapshot.status_token != expected_status_token {
            return Err(CoreError::Conflict(
                "Git status changed; refresh before syncing the remote".into(),
            ));
        }
        if snapshot.context.ongoing_operation.is_some() && action != GitRemoteAction::Fetch {
            return Err(CoreError::Blocked(
                "finish the current Git operation before syncing the remote".into(),
            ));
        }
        let checkout = Path::new(&snapshot.context.checkout_root);
        let branch = snapshot.context.actual_branch.as_deref();
        let configured_remote = branch.and_then(|branch| branch_remote(self, checkout, branch));
        let remote = configured_remote
            .as_deref()
            .filter(|value| *value != ".")
            .or(snapshot.context.remote.as_deref())
            .ok_or_else(|| CoreError::Blocked("no Git remote is configured".into()))?;
        let merge_ref = branch.and_then(|branch| branch_merge_ref(self, checkout, branch));
        let has_local_changes = snapshot.entries.iter().any(|entry| !entry.ignored);

        let is_pull = matches!(
            action,
            GitRemoteAction::Pull
                | GitRemoteAction::PullAutostash
                | GitRemoteAction::PullRebase
                | GitRemoteAction::PullRebaseAutostash
        );
        let is_explicit_autostash = matches!(
            action,
            GitRemoteAction::PullAutostash | GitRemoteAction::PullRebaseAutostash
        );
        if is_pull {
            if branch.is_none() || snapshot.context.unborn {
                return Err(CoreError::Blocked(
                    "Pull requires a checked-out branch with at least one commit".into(),
                ));
            }
            if merge_ref.is_none() {
                return Err(CoreError::Blocked(
                    "Pull requires an upstream branch".into(),
                ));
            }
            if configured_remote.as_deref() == Some(".") {
                return Err(CoreError::Blocked(
                    "Pull from a local-branch upstream is not supported in Git Center".into(),
                ));
            }
            if snapshot.entries.iter().any(|entry| entry.conflicted) {
                return Err(CoreError::Blocked(
                    "resolve Git conflicts before pulling".into(),
                ));
            }
            if has_local_changes && !is_explicit_autostash {
                return Err(CoreError::Blocked(
                    "Pull with local changes requires the explicit auto-stash action".into(),
                ));
            }
        }
        if matches!(action, GitRemoteAction::Push | GitRemoteAction::ForcePush)
            && (branch.is_none() || snapshot.context.unborn)
        {
            return Err(CoreError::Blocked(
                "Push requires a checked-out branch with at least one commit".into(),
            ));
        }
        if matches!(action, GitRemoteAction::Push | GitRemoteAction::ForcePush)
            && configured_remote.as_deref() == Some(".")
        {
            return Err(CoreError::Blocked(
                "Push to a local-branch upstream is not supported in Git Center".into(),
            ));
        }
        if action == GitRemoteAction::ForcePush {
            let branch = branch.unwrap_or_default();
            if matches!(branch, "main" | "master") {
                return Err(CoreError::Blocked(
                    "Force Push is disabled for main and master".into(),
                ));
            }
            if merge_ref.is_none() {
                return Err(CoreError::Blocked(
                    "Force Push requires an upstream branch".into(),
                ));
            }
        }

        let args = remote_args(action, remote, merge_ref.as_deref());
        self.runner
            .run_with_options(
                Some(checkout),
                args,
                GitRunOptions {
                    max_stdout: 1024 * 1024,
                    max_stderr: 1024 * 1024,
                    timeout: Some(Duration::from_secs(120)),
                    ..GitRunOptions::default()
                },
            )?
            .require_success()?;
        Ok(GitMutationResult {
            operation_id: format!("gitop_{}", uuid::Uuid::new_v4().simple()),
            changes: self.changes(locator, true)?,
        })
    }
}

fn branch_remote(
    manager: &GitWorkspaceManager<'_>,
    checkout: &Path,
    branch: &str,
) -> Option<String> {
    manager
        .runner
        .run_read_only(
            Some(checkout),
            ["config", "--get", &format!("branch.{branch}.remote")],
        )
        .ok()
        .filter(|output| output.success())
        .map(|output| output.stdout_lossy().trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn validate_checkout(actual: &str, expected: &str) -> Result<()> {
    if actual != expected {
        return Err(CoreError::Conflict(
            "Git Checkout changed; reopen Git Center".into(),
        ));
    }
    Ok(())
}

fn branch_merge_ref(
    manager: &GitWorkspaceManager<'_>,
    checkout: &Path,
    branch: &str,
) -> Option<String> {
    manager
        .runner
        .run_read_only(
            Some(checkout),
            ["config", "--get", &format!("branch.{branch}.merge")],
        )
        .ok()
        .filter(|output| output.success())
        .map(|output| output.stdout_lossy().trim().to_owned())
        .filter(|value| value.starts_with("refs/heads/"))
}

fn remote_args(action: GitRemoteAction, remote: &str, merge_ref: Option<&str>) -> Vec<OsString> {
    match action {
        GitRemoteAction::Fetch => vec!["fetch".into(), "--prune".into(), remote.into()],
        GitRemoteAction::Pull => vec![
            "-c".into(),
            "rebase.autoStash=false".into(),
            "pull".into(),
            "--ff-only".into(),
            remote.into(),
            merge_ref.unwrap_or_default().into(),
        ],
        GitRemoteAction::PullAutostash => vec![
            "pull".into(),
            "--ff-only".into(),
            "--autostash".into(),
            remote.into(),
            merge_ref.unwrap_or_default().into(),
        ],
        GitRemoteAction::PullRebase => vec![
            "-c".into(),
            "rebase.autoStash=false".into(),
            "pull".into(),
            "--rebase".into(),
            remote.into(),
            merge_ref.unwrap_or_default().into(),
        ],
        GitRemoteAction::PullRebaseAutostash => vec![
            "pull".into(),
            "--rebase".into(),
            "--autostash".into(),
            remote.into(),
            merge_ref.unwrap_or_default().into(),
        ],
        GitRemoteAction::Push if merge_ref.is_some() => vec![
            "push".into(),
            remote.into(),
            format!("HEAD:{}", merge_ref.unwrap_or_default()).into(),
        ],
        GitRemoteAction::Push => vec![
            "push".into(),
            "--set-upstream".into(),
            remote.into(),
            "HEAD".into(),
        ],
        GitRemoteAction::ForcePush => vec![
            "push".into(),
            "--force-with-lease".into(),
            remote.into(),
            format!("HEAD:{}", merge_ref.unwrap_or_default()).into(),
        ],
    }
}
