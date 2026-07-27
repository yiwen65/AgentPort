use super::command::GitRunOptions;
use super::context::{GitContextLocator, GitWorkspaceManager};
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

const MAX_STAGED_DIFF_BYTES: usize = 256 * 1024;
const MAX_RECENT_SUBJECTS_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitAiContext {
    pub status_token: String,
    pub branch: String,
    pub recent_subjects: Vec<String>,
    pub staged_diff: String,
    pub truncated: bool,
}

impl<'a> GitWorkspaceManager<'a> {
    pub fn commit_ai_context(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: &str,
    ) -> Result<GitCommitAiContext> {
        let resolved = self.resolve_internal(locator)?;
        if resolved.descriptor.checkout_id != expected_checkout_id {
            return Err(CoreError::Conflict(
                "Git Checkout changed; reopen Git Center".into(),
            ));
        }
        if !resolved.descriptor.writable {
            return Err(CoreError::Blocked("this Git Checkout is read-only".into()));
        }
        if resolved.descriptor.detached {
            return Err(CoreError::Blocked(
                "commit message generation is disabled on detached HEAD".into(),
            ));
        }
        if let Some(operation) = &resolved.descriptor.ongoing_operation {
            return Err(CoreError::Blocked(format!(
                "finish {operation} before generating a commit message"
            )));
        }

        let snapshot = self.changes(locator, true)?;
        if !snapshot.complete {
            return Err(CoreError::Blocked(
                "Git Changes is partial; commit message generation is disabled".into(),
            ));
        }
        if snapshot.status_token != expected_status_token {
            return Err(CoreError::Conflict(
                "Git status changed; refresh before generating a commit message".into(),
            ));
        }
        if snapshot.counts.conflict > 0 {
            return Err(CoreError::Blocked(
                "resolve all conflicts before generating a commit message".into(),
            ));
        }
        if snapshot.counts.staged == 0 {
            return Err(CoreError::Blocked(
                "there are no staged changes to describe".into(),
            ));
        }

        let checkout = Path::new(&snapshot.context.checkout_root);
        let diff = self
            .runner
            .run_with_options(
                Some(checkout),
                [
                    "diff",
                    "--cached",
                    "--no-ext-diff",
                    "--no-color",
                    "--unified=3",
                    "--",
                ],
                GitRunOptions {
                    max_stdout: MAX_STAGED_DIFF_BYTES,
                    max_stderr: 64 * 1024,
                    read_only: true,
                    timeout: Some(Duration::from_secs(30)),
                    ..GitRunOptions::default()
                },
            )?
            .require_success()?;
        let recent_subjects = self
            .runner
            .run_with_options(
                Some(checkout),
                ["log", "-8", "--format=%s"],
                GitRunOptions {
                    max_stdout: MAX_RECENT_SUBJECTS_BYTES,
                    max_stderr: 32 * 1024,
                    read_only: true,
                    timeout: Some(Duration::from_secs(10)),
                    ..GitRunOptions::default()
                },
            )
            .ok()
            .filter(|output| output.success())
            .map(|output| {
                output
                    .stdout_lossy()
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();

        let current = self.changes(locator, true)?;
        if current.status_token != expected_status_token {
            return Err(CoreError::Conflict(
                "Git status changed while collecting the staged diff".into(),
            ));
        }
        Ok(GitCommitAiContext {
            status_token: current.status_token,
            branch: current
                .context
                .actual_branch
                .unwrap_or_else(|| "HEAD".into()),
            recent_subjects,
            staged_diff: diff.stdout_lossy(),
            truncated: diff.stdout_truncated,
        })
    }
}
