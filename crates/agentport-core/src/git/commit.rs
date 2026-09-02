use super::command::{GitOutput, GitRunOptions, GitRunner};
use super::context::{GitContextLocator, GitWorkspaceManager};
use super::repository::{repository_lock, RepositoryFileLock};
use super::status::{
    bytes_to_path, decode_path_token, encode_path_token, parse_numstat_z, GitChangesSnapshot,
};
use crate::db::ensure_project_not_removing_conn;
use crate::error::{CoreError, Result};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPathSelection {
    pub path_token: String,
    pub entry_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMutationResult {
    pub operation_id: String,
    pub changes: GitChangesSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitScopeFile {
    pub status: String,
    pub path_token: String,
    pub display_path: String,
    pub old_path_token: Option<String>,
    pub display_old_path: Option<String>,
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
    pub binary: bool,
    pub outside_project: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitReview {
    pub context: super::context::GitCheckoutDescriptor,
    pub commit_token: String,
    pub message: String,
    pub message_hash: String,
    pub before_head: Option<String>,
    pub index_hash: String,
    pub expected_tree_oid: String,
    pub files: Vec<GitCommitScopeFile>,
    pub outside_project_paths: Vec<String>,
    pub subject_over_72: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitOutcome {
    Succeeded,
    NotExecuted,
    ScopeDrift,
    Indeterminate,
}

impl GitCommitOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::NotExecuted => "not_executed",
            Self::ScopeDrift => "scope_drift",
            Self::Indeterminate => "indeterminate",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub operation_id: String,
    pub outcome: GitCommitOutcome,
    pub before_head: Option<String>,
    pub after_head: Option<String>,
    pub expected_tree_oid: String,
    pub actual_tree_oid: Option<String>,
    pub changes: GitChangesSnapshot,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRecovery {
    pub operation_id: String,
    pub repo_key: String,
    pub checkout_id: String,
    pub outcome: GitCommitOutcome,
    pub before_head: Option<String>,
    pub after_head: Option<String>,
    pub expected_tree_oid: String,
    pub actual_tree_oid: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum IndexMutation {
    Stage,
    Unstage,
}

impl<'a> GitWorkspaceManager<'a> {
    pub fn stage_paths(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: &str,
        selections: &[GitPathSelection],
    ) -> Result<GitMutationResult> {
        self.mutate_index(
            locator,
            expected_checkout_id,
            expected_status_token,
            selections,
            IndexMutation::Stage,
        )
    }

    pub fn unstage_paths(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: &str,
        selections: &[GitPathSelection],
    ) -> Result<GitMutationResult> {
        self.mutate_index(
            locator,
            expected_checkout_id,
            expected_status_token,
            selections,
            IndexMutation::Unstage,
        )
    }

    pub fn prepare_commit(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: &str,
        message: &str,
    ) -> Result<GitCommitReview> {
        self.build_commit_review(
            locator,
            expected_checkout_id,
            Some(expected_status_token),
            message,
        )
    }

    pub fn commit_changes(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_commit_token: &str,
        message: &str,
    ) -> Result<GitCommitResult> {
        validate_commit_message(message)?;
        let initial = self.resolve_internal(locator)?;
        validate_checkout(&initial.descriptor, expected_checkout_id)?;
        let lock = repository_lock(&initial.identity.repo_key);
        let _guard = lock.lock().unwrap();
        let locked = self.resolve_internal(locator)?;
        validate_checkout(&locked.descriptor, expected_checkout_id)?;
        let _file_guard = RepositoryFileLock::acquire(&locked.identity.common_dir)?;
        let resolved = self.resolve_internal(locator)?;
        validate_checkout(&resolved.descriptor, expected_checkout_id)?;
        let review = self.build_commit_review(locator, expected_checkout_id, None, message)?;
        if review.commit_token != expected_commit_token {
            return Err(CoreError::Conflict(
                "commit scope changed; review the staged files again".into(),
            ));
        }
        let checkout = Path::new(&review.context.checkout_root);
        ensure_commit_inputs_unchanged(
            &self.runner,
            checkout,
            review.before_head.as_deref(),
            &review.index_hash,
        )?;
        let expected_tree_oid = review.expected_tree_oid.clone();
        let operation_id = format!("gitcommit_{}", uuid::Uuid::new_v4().simple());
        self.insert_commit_journal(&operation_id, &review, &expected_tree_oid, "started")?;
        let execution = self.runner.run_with_options(
            Some(checkout),
            ["commit", "--file=-", "--cleanup=verbatim"],
            GitRunOptions {
                input: Some(message.as_bytes().to_vec()),
                max_stdout: 256 * 1024,
                max_stderr: 256 * 1024,
                timeout: Some(self.commit_timeout),
                ..GitRunOptions::default()
            },
        );
        let execution_error = execution_error(&execution);
        let observation = self.observe_commit(
            checkout,
            review.before_head.as_deref(),
            &expected_tree_oid,
            &review.message_hash,
        )?;
        self.finish_commit_journal(
            &operation_id,
            observation.outcome,
            observation.after_head.as_deref(),
            observation.actual_tree_oid.as_deref(),
            observation.journal_error,
        )?;
        let changes = self.changes(locator, true)?;
        Ok(GitCommitResult {
            operation_id,
            outcome: observation.outcome,
            before_head: review.before_head,
            after_head: observation.after_head,
            expected_tree_oid,
            actual_tree_oid: observation.actual_tree_oid,
            changes,
            error: execution_error.or(observation.error),
        })
    }

    pub fn reconcile_commit_operations(&self) -> Result<Vec<GitCommitRecovery>> {
        let pending = {
            let conn = self.db.conn().lock().unwrap();
            let mut statement = conn.prepare(
                "SELECT id,project_id,worktree_id,repo_key,checkout_id,before_head,
                        expected_tree_oid,message_hash
                 FROM git_commit_operations WHERE phase='started' ORDER BY created_at",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let mut recoveries = Vec::new();
        for (
            operation_id,
            project_id,
            worktree_id,
            repo_key,
            checkout_id,
            before_head,
            expected_tree,
            message_hash,
        ) in pending
        {
            let locator = match worktree_id {
                Some(worktree_id) => GitContextLocator::Worktree {
                    project_id,
                    worktree_id,
                },
                None => GitContextLocator::ProjectMain { project_id },
            };
            let resolved = match self.resolve_internal(&locator) {
                Ok(resolved) => resolved,
                Err(_) => {
                    self.finish_commit_journal(
                        &operation_id,
                        GitCommitOutcome::Indeterminate,
                        None,
                        None,
                        "context_unavailable",
                    )?;
                    recoveries.push(GitCommitRecovery {
                        operation_id,
                        repo_key,
                        checkout_id,
                        outcome: GitCommitOutcome::Indeterminate,
                        before_head,
                        after_head: None,
                        expected_tree_oid: expected_tree,
                        actual_tree_oid: None,
                    });
                    continue;
                }
            };
            if resolved.descriptor.repo_key != repo_key
                || resolved.descriptor.checkout_id != checkout_id
            {
                self.finish_commit_journal(
                    &operation_id,
                    GitCommitOutcome::Indeterminate,
                    None,
                    None,
                    "checkout_identity_drift",
                )?;
                recoveries.push(GitCommitRecovery {
                    operation_id,
                    repo_key,
                    checkout_id,
                    outcome: GitCommitOutcome::Indeterminate,
                    before_head,
                    after_head: None,
                    expected_tree_oid: expected_tree,
                    actual_tree_oid: None,
                });
                continue;
            }
            let process_lock = repository_lock(&repo_key);
            let _process_guard = process_lock.lock().unwrap();
            let _file_guard = match RepositoryFileLock::acquire(&resolved.identity.common_dir) {
                Ok(guard) => guard,
                Err(_) => {
                    self.finish_commit_journal(
                        &operation_id,
                        GitCommitOutcome::Indeterminate,
                        None,
                        None,
                        "recovery_lock_unavailable",
                    )?;
                    recoveries.push(GitCommitRecovery {
                        operation_id,
                        repo_key,
                        checkout_id,
                        outcome: GitCommitOutcome::Indeterminate,
                        before_head,
                        after_head: None,
                        expected_tree_oid: expected_tree,
                        actual_tree_oid: None,
                    });
                    continue;
                }
            };
            let resolved = match self.resolve_internal(&locator) {
                Ok(value)
                    if value.descriptor.repo_key == repo_key
                        && value.descriptor.checkout_id == checkout_id =>
                {
                    value
                }
                _ => {
                    self.finish_commit_journal(
                        &operation_id,
                        GitCommitOutcome::Indeterminate,
                        None,
                        None,
                        "checkout_identity_drift",
                    )?;
                    recoveries.push(GitCommitRecovery {
                        operation_id,
                        repo_key,
                        checkout_id,
                        outcome: GitCommitOutcome::Indeterminate,
                        before_head,
                        after_head: None,
                        expected_tree_oid: expected_tree,
                        actual_tree_oid: None,
                    });
                    continue;
                }
            };
            let observation = self.observe_commit(
                &resolved.identity.root,
                before_head.as_deref(),
                &expected_tree,
                &message_hash,
            )?;
            self.finish_commit_journal(
                &operation_id,
                observation.outcome,
                observation.after_head.as_deref(),
                observation.actual_tree_oid.as_deref(),
                observation.journal_error,
            )?;
            recoveries.push(GitCommitRecovery {
                operation_id,
                repo_key,
                checkout_id,
                outcome: observation.outcome,
                before_head,
                after_head: observation.after_head,
                expected_tree_oid: expected_tree,
                actual_tree_oid: observation.actual_tree_oid,
            });
        }
        Ok(recoveries)
    }

    fn mutate_index(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: &str,
        selections: &[GitPathSelection],
        mutation: IndexMutation,
    ) -> Result<GitMutationResult> {
        if selections.is_empty() {
            return Err(CoreError::Validation(
                "select at least one Git Changes file".into(),
            ));
        }
        let initial = self.resolve_internal(locator)?;
        validate_checkout(&initial.descriptor, expected_checkout_id)?;
        let lock = repository_lock(&initial.identity.repo_key);
        let _guard = lock.lock().unwrap();
        let locked = self.resolve_internal(locator)?;
        validate_checkout(&locked.descriptor, expected_checkout_id)?;
        let _file_guard = RepositoryFileLock::acquire(&locked.identity.common_dir)?;
        let resolved = self.resolve_internal(locator)?;
        validate_checkout(&resolved.descriptor, expected_checkout_id)?;
        let snapshot = self.changes(locator, true)?;
        if !snapshot.complete {
            return Err(CoreError::Blocked(
                "Git Changes is partial; index writes are disabled".into(),
            ));
        }
        if snapshot.status_token != expected_status_token {
            return Err(CoreError::Conflict(
                "Git status changed; refresh before modifying the index".into(),
            ));
        }
        let mut paths = BTreeSet::<Vec<u8>>::new();
        for selection in selections {
            let entry = snapshot
                .entries
                .iter()
                .find(|entry| entry.path_token == selection.path_token)
                .ok_or_else(|| {
                    CoreError::Conflict("selected file is no longer present in Git Changes".into())
                })?;
            if entry.entry_token != selection.entry_token {
                return Err(CoreError::Conflict(
                    "selected file changed after it was displayed".into(),
                ));
            }
            if entry.ignored {
                return Err(CoreError::Blocked(
                    "ignored files cannot be staged in Git Center".into(),
                ));
            }
            if matches!(mutation, IndexMutation::Stage)
                && entry
                    .submodule_state
                    .as_deref()
                    .is_some_and(|state| state.as_bytes().get(1) == Some(&b'.'))
            {
                return Err(CoreError::Blocked(format!(
                    "{} has only nested submodule changes; Git Center stages gitlinks only",
                    entry.display_path
                )));
            }
            match mutation {
                IndexMutation::Stage
                    if !entry.unstaged && !entry.untracked && !entry.conflicted =>
                {
                    return Err(CoreError::Validation(format!(
                        "{} has no unstaged change",
                        entry.display_path
                    )));
                }
                IndexMutation::Unstage if !entry.staged && !entry.conflicted => {
                    return Err(CoreError::Validation(format!(
                        "{} has no staged change",
                        entry.display_path
                    )));
                }
                _ => {}
            }
            paths.insert(decode_path_token(
                &snapshot.context.checkout_id,
                &entry.path_token,
            )?);
            if let Some(old_path_token) = entry.old_path_token.as_deref() {
                paths.insert(decode_path_token(
                    &snapshot.context.checkout_id,
                    old_path_token,
                )?);
            }
        }
        let input = nul_path_input(&paths);
        let checkout = Path::new(&snapshot.context.checkout_root);
        let args = match mutation {
            IndexMutation::Stage => vec![
                OsString::from("--literal-pathspecs"),
                OsString::from("add"),
                OsString::from("-A"),
                OsString::from("--pathspec-from-file=-"),
                OsString::from("--pathspec-file-nul"),
            ],
            IndexMutation::Unstage if snapshot.context.unborn => vec![
                OsString::from("update-index"),
                OsString::from("--force-remove"),
                OsString::from("-z"),
                OsString::from("--stdin"),
            ],
            IndexMutation::Unstage => vec![
                OsString::from("--literal-pathspecs"),
                OsString::from("restore"),
                OsString::from("--staged"),
                OsString::from("--pathspec-from-file=-"),
                OsString::from("--pathspec-file-nul"),
            ],
        };
        self.runner
            .run_with_options(
                Some(checkout),
                args,
                GitRunOptions {
                    input: Some(input),
                    max_stdout: 256 * 1024,
                    max_stderr: 256 * 1024,
                    ..GitRunOptions::default()
                },
            )?
            .require_success()?;
        let changes = self.changes(locator, true)?;
        Ok(GitMutationResult {
            operation_id: format!("gitop_{}", uuid::Uuid::new_v4().simple()),
            changes,
        })
    }

    fn build_commit_review(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: Option<&str>,
        message: &str,
    ) -> Result<GitCommitReview> {
        let subject_over_72 = validate_commit_message(message)?;
        let resolved = self.resolve_internal(locator)?;
        validate_checkout(&resolved.descriptor, expected_checkout_id)?;
        if resolved.descriptor.detached {
            return Err(CoreError::Blocked(
                "ordinary Commit is disabled on detached HEAD".into(),
            ));
        }
        if let Some(operation) = &resolved.descriptor.ongoing_operation {
            return Err(CoreError::Blocked(format!(
                "ordinary Commit is disabled while {operation} is in progress"
            )));
        }
        let snapshot = self.changes(locator, true)?;
        if !snapshot.complete {
            return Err(CoreError::Blocked(
                "Git Changes is partial; Commit is disabled".into(),
            ));
        }
        if let Some(expected) = expected_status_token {
            if snapshot.status_token != expected {
                return Err(CoreError::Conflict(
                    "Git status changed; refresh before reviewing Commit".into(),
                ));
            }
        }
        if snapshot.counts.conflict > 0 {
            return Err(CoreError::Blocked(
                "resolve all conflicts before Commit".into(),
            ));
        }
        let checkout = Path::new(&snapshot.context.checkout_root);
        let index_manifest = read_index_manifest(&self.runner, checkout)?;
        if index_manifest.truncated {
            return Err(CoreError::Blocked(
                "index manifest exceeded the safety limit".into(),
            ));
        }
        let index_hash = index_manifest.hash;
        let expected_tree_oid =
            compute_index_tree_oid(&self.runner, checkout, &index_manifest.bytes)?;
        let project_boundary = project_boundary(&resolved)?;
        let (files, outside_project_paths) = read_staged_scope(
            &self.runner,
            checkout,
            &snapshot.context.checkout_id,
            &project_boundary,
        )?;
        if files.is_empty() {
            return Err(CoreError::Blocked(
                "there are no staged changes to commit".into(),
            ));
        }
        let before_head = snapshot.context.head_oid.clone();
        ensure_commit_inputs_unchanged(
            &self.runner,
            checkout,
            before_head.as_deref(),
            &index_hash,
        )?;
        let message_hash = message_hash(message);
        let commit_token = commit_token(
            &snapshot.context.checkout_id,
            before_head.as_deref(),
            &index_hash,
            &message_hash,
        );
        let mut warnings = snapshot.context.warnings.clone();
        if !outside_project_paths.is_empty() {
            warnings.push("outside_project_scope".into());
        }
        if subject_over_72 {
            warnings.push("subject_over_72".into());
        }
        Ok(GitCommitReview {
            context: snapshot.context,
            commit_token,
            message: message.into(),
            message_hash,
            before_head,
            index_hash,
            expected_tree_oid,
            files,
            outside_project_paths,
            subject_over_72,
            warnings,
        })
    }

    fn observe_commit(
        &self,
        checkout: &Path,
        before_head: Option<&str>,
        expected_tree: &str,
        expected_message_hash: &str,
    ) -> Result<CommitObservation> {
        let after_head = read_head(&self.runner, checkout)?;
        if after_head.as_deref() == before_head {
            return Ok(CommitObservation {
                outcome: GitCommitOutcome::NotExecuted,
                after_head,
                actual_tree_oid: None,
                error: Some("Git did not create a commit".into()),
                journal_error: "git_not_executed",
            });
        }
        let Some(after) = after_head.as_deref() else {
            return Ok(CommitObservation {
                outcome: GitCommitOutcome::Indeterminate,
                after_head,
                actual_tree_oid: None,
                error: Some("HEAD became unavailable after Commit".into()),
                journal_error: "head_unavailable",
            });
        };
        let actual_tree_oid = read_tree(&self.runner, checkout, after).ok();
        let parents = read_parents(&self.runner, checkout, after).unwrap_or_default();
        let actual_message_hash =
            read_message(&self.runner, checkout, after).map(|message| message_hash(&message));
        let expected_parents = before_head
            .map(|head| vec![head.to_owned()])
            .unwrap_or_default();
        let message_matches = matches!(
            actual_message_hash.as_deref(),
            Ok(actual) if actual == expected_message_hash
        );
        if parents != expected_parents || !message_matches {
            return Ok(CommitObservation {
                outcome: GitCommitOutcome::Indeterminate,
                after_head,
                actual_tree_oid,
                error: Some(
                    "HEAD moved, but the resulting commit does not match this operation".into(),
                ),
                journal_error: "head_identity_mismatch",
            });
        }
        if actual_tree_oid.as_deref() == Some(expected_tree) {
            Ok(CommitObservation {
                outcome: GitCommitOutcome::Succeeded,
                after_head,
                actual_tree_oid,
                error: None,
                journal_error: "none",
            })
        } else {
            Ok(CommitObservation {
                outcome: GitCommitOutcome::ScopeDrift,
                after_head,
                actual_tree_oid,
                error: Some(
                    "a Git hook changed the index after confirmation; the actual commit scope differs"
                        .into(),
                ),
                journal_error: "scope_drift",
            })
        }
    }

    fn insert_commit_journal(
        &self,
        operation_id: &str,
        review: &GitCommitReview,
        expected_tree_oid: &str,
        phase: &str,
    ) -> Result<()> {
        let now = now_string();
        let mut conn = self.db.conn().lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_project_not_removing_conn(&tx, &review.context.target.project_id)?;
        tx.execute(
            "INSERT INTO git_commit_operations(
                id,project_id,worktree_id,repo_key,checkout_id,checkout_root,before_head,
                expected_tree_oid,index_hash,message_hash,phase,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)",
            params![
                operation_id,
                review.context.target.project_id,
                review.context.target.worktree_id,
                review.context.repo_key,
                review.context.checkout_id,
                review.context.checkout_root,
                review.before_head,
                expected_tree_oid,
                review.index_hash,
                review.message_hash,
                phase,
                now,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn finish_commit_journal(
        &self,
        operation_id: &str,
        outcome: GitCommitOutcome,
        result_head: Option<&str>,
        result_tree: Option<&str>,
        error_summary: &str,
    ) -> Result<()> {
        let now = now_string();
        let changed = self.db.conn().lock().unwrap().execute(
            "UPDATE git_commit_operations
             SET phase=?2,result_head=?3,result_tree=?4,error_summary=?5,
                 updated_at=?6,completed_at=?6
             WHERE id=?1",
            params![
                operation_id,
                outcome.as_str(),
                result_head,
                result_tree,
                (error_summary != "none").then_some(error_summary),
                now,
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!(
                "Git commit operation {operation_id}"
            )));
        }
        Ok(())
    }
}

struct CommitObservation {
    outcome: GitCommitOutcome,
    after_head: Option<String>,
    actual_tree_oid: Option<String>,
    error: Option<String>,
    journal_error: &'static str,
}

fn validate_checkout(
    descriptor: &super::context::GitCheckoutDescriptor,
    expected_checkout_id: &str,
) -> Result<()> {
    if descriptor.checkout_id != expected_checkout_id {
        return Err(CoreError::Conflict(
            "Git Checkout changed; reopen Git Center".into(),
        ));
    }
    if !descriptor.writable {
        return Err(CoreError::Blocked(format!(
            "Git Checkout is not writable: {}",
            descriptor.blockers.join(", ")
        )));
    }
    Ok(())
}

fn nul_path_input(paths: &BTreeSet<Vec<u8>>) -> Vec<u8> {
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path);
        input.push(0);
    }
    input
}

fn validate_commit_message(message: &str) -> Result<bool> {
    if message.as_bytes().contains(&0) {
        return Err(CoreError::Validation(
            "commit message must not contain NUL".into(),
        ));
    }
    if message.len() > 64 * 1024 {
        return Err(CoreError::Validation(
            "commit message exceeds 64 KiB".into(),
        ));
    }
    let subject = message.lines().next().unwrap_or_default().trim();
    if subject.is_empty() {
        return Err(CoreError::Validation(
            "commit message subject must not be empty".into(),
        ));
    }
    Ok(subject.chars().count() > 72)
}

struct IndexManifest {
    bytes: Vec<u8>,
    hash: String,
    truncated: bool,
}

fn read_index_manifest(
    runner: &super::command::GitRunner,
    checkout: &Path,
) -> Result<IndexManifest> {
    let output = runner
        .run_with_options(
            Some(checkout),
            ["ls-files", "--stage", "-z"],
            GitRunOptions {
                max_stdout: 8 * 1024 * 1024,
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()?;
    Ok(IndexManifest {
        hash: format!("{:x}", Sha256::digest(&output.stdout)),
        bytes: output.stdout,
        truncated: output.stdout_truncated,
    })
}

fn ensure_commit_inputs_unchanged(
    runner: &GitRunner,
    checkout: &Path,
    expected_head: Option<&str>,
    expected_index_hash: &str,
) -> Result<()> {
    let head_before = read_head(runner, checkout)?;
    let index = read_index_manifest(runner, checkout)?;
    let head_after = read_head(runner, checkout)?;
    if index.truncated {
        return Err(CoreError::Blocked(
            "index manifest exceeded the safety limit".into(),
        ));
    }
    if head_before.as_deref() != expected_head
        || head_after != head_before
        || index.hash != expected_index_hash
    {
        return Err(CoreError::Conflict(
            "HEAD or index changed while preparing Commit; review again".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum GitObjectFormat {
    Sha1,
    Sha256,
}

impl GitObjectFormat {
    fn hash_tree(self, body: &[u8]) -> Vec<u8> {
        let mut input = format!("tree {}\0", body.len()).into_bytes();
        input.extend_from_slice(body);
        match self {
            Self::Sha1 => Sha1::digest(&input).to_vec(),
            Self::Sha256 => Sha256::digest(&input).to_vec(),
        }
    }

    fn oid_bytes(self) -> usize {
        match self {
            Self::Sha1 => 20,
            Self::Sha256 => 32,
        }
    }
}

#[derive(Debug)]
enum IndexTreeNode {
    Directory(BTreeMap<Vec<u8>, IndexTreeNode>),
    Entry { mode: Vec<u8>, oid: Vec<u8> },
}

fn compute_index_tree_oid(
    runner: &super::command::GitRunner,
    checkout: &Path,
    manifest: &[u8],
) -> Result<String> {
    let object_format = read_object_format(runner, checkout)?;
    let mut root = IndexTreeNode::Directory(BTreeMap::new());
    for record in manifest
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| {
                CoreError::Internal("Git index manifest entry has no path separator".into())
            })?;
        let mut fields = record[..tab].split(|byte| *byte == b' ');
        let mode = fields
            .next()
            .ok_or_else(|| CoreError::Internal("Git index entry has no mode".into()))?;
        let oid = fields
            .next()
            .ok_or_else(|| CoreError::Internal("Git index entry has no object ID".into()))?;
        let stage = fields
            .next()
            .ok_or_else(|| CoreError::Internal("Git index entry has no stage".into()))?;
        if fields.next().is_some() || stage != b"0" {
            return Err(CoreError::Blocked(
                "the Git index contains unresolved conflict stages".into(),
            ));
        }
        let path = &record[tab + 1..];
        insert_index_entry(
            &mut root,
            path,
            normalize_tree_mode(mode)?,
            decode_hex_oid(oid, object_format.oid_bytes())?,
        )?;
    }
    let oid = hash_index_tree(&root, object_format)?;
    Ok(hex_oid(&oid))
}

fn read_object_format(
    runner: &super::command::GitRunner,
    checkout: &Path,
) -> Result<GitObjectFormat> {
    let output = runner
        .run_with_options(
            Some(checkout),
            ["rev-parse", "--show-object-format"],
            GitRunOptions {
                max_stdout: 32,
                max_stderr: 64 * 1024,
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()?;
    match output.stdout_lossy().trim() {
        "sha1" => Ok(GitObjectFormat::Sha1),
        "sha256" => Ok(GitObjectFormat::Sha256),
        value => Err(CoreError::Blocked(format!(
            "unsupported Git object format: {value}"
        ))),
    }
}

fn normalize_tree_mode(mode: &[u8]) -> Result<Vec<u8>> {
    match mode {
        b"100644" | b"100755" | b"120000" | b"160000" => Ok(mode.to_vec()),
        b"040000" | b"40000" => Ok(b"40000".to_vec()),
        _ => Err(CoreError::Blocked(format!(
            "unsupported Git index mode: {}",
            String::from_utf8_lossy(mode)
        ))),
    }
}

fn decode_hex_oid(value: &[u8], expected_bytes: usize) -> Result<Vec<u8>> {
    if value.len() != expected_bytes * 2 {
        return Err(CoreError::Blocked(
            "Git index object ID has an unexpected length".into(),
        ));
    }
    let mut result = Vec::with_capacity(expected_bytes);
    for pair in value.chunks_exact(2) {
        let high = hex_nibble(pair[0])?;
        let low = hex_nibble(pair[1])?;
        result.push((high << 4) | low);
    }
    if result.iter().all(|byte| *byte == 0) {
        return Err(CoreError::Blocked(
            "intent-to-add entries must be staged with content before Commit".into(),
        ));
    }
    Ok(result)
}

fn hex_nibble(value: u8) -> Result<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(CoreError::Internal(
            "Git index object ID is not hexadecimal".into(),
        )),
    }
}

fn insert_index_entry(
    root: &mut IndexTreeNode,
    path: &[u8],
    mode: Vec<u8>,
    oid: Vec<u8>,
) -> Result<()> {
    let parts = path.split(|byte| *byte == b'/').collect::<Vec<_>>();
    if parts.is_empty()
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == b"." || *part == b"..")
    {
        return Err(CoreError::Blocked(
            "Git index contains an invalid repository-relative path".into(),
        ));
    }
    insert_index_parts(root, &parts, mode, oid)
}

fn insert_index_parts(
    node: &mut IndexTreeNode,
    parts: &[&[u8]],
    mode: Vec<u8>,
    oid: Vec<u8>,
) -> Result<()> {
    let IndexTreeNode::Directory(entries) = node else {
        return Err(CoreError::Blocked(
            "Git index contains overlapping file and directory entries".into(),
        ));
    };
    let name = parts[0].to_vec();
    if parts.len() == 1 {
        if entries
            .insert(name, IndexTreeNode::Entry { mode, oid })
            .is_some()
        {
            return Err(CoreError::Blocked(
                "Git index contains duplicate paths".into(),
            ));
        }
        return Ok(());
    }
    let child = entries
        .entry(name)
        .or_insert_with(|| IndexTreeNode::Directory(BTreeMap::new()));
    insert_index_parts(child, &parts[1..], mode, oid)
}

fn hash_index_tree(node: &IndexTreeNode, object_format: GitObjectFormat) -> Result<Vec<u8>> {
    let IndexTreeNode::Directory(entries) = node else {
        return Err(CoreError::Internal(
            "cannot hash a non-directory as a Git tree".into(),
        ));
    };
    let mut ordered = entries.iter().collect::<Vec<_>>();
    ordered.sort_by(|(left_name, left), (right_name, right)| {
        git_tree_order(left_name, left, right_name, right)
    });
    let mut body = Vec::new();
    for (name, entry) in ordered {
        let (mode, oid) = match entry {
            IndexTreeNode::Directory(_) => {
                (b"40000".as_slice(), hash_index_tree(entry, object_format)?)
            }
            IndexTreeNode::Entry { mode, oid } => (mode.as_slice(), oid.clone()),
        };
        body.extend_from_slice(mode);
        body.push(b' ');
        body.extend_from_slice(name);
        body.push(0);
        body.extend_from_slice(&oid);
    }
    Ok(object_format.hash_tree(&body))
}

fn git_tree_order(
    left_name: &[u8],
    left: &IndexTreeNode,
    right_name: &[u8],
    right: &IndexTreeNode,
) -> Ordering {
    let mut left_key = left_name.to_vec();
    let mut right_key = right_name.to_vec();
    if matches!(left, IndexTreeNode::Directory(_)) {
        left_key.push(b'/');
    }
    if matches!(right, IndexTreeNode::Directory(_)) {
        right_key.push(b'/');
    }
    left_key.cmp(&right_key)
}

fn hex_oid(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(value.len() * 2);
    for byte in value {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

fn read_staged_scope(
    runner: &super::command::GitRunner,
    checkout: &Path,
    checkout_id: &str,
    project_boundary: &Path,
) -> Result<(Vec<GitCommitScopeFile>, Vec<String>)> {
    let names = runner
        .run_with_options(
            Some(checkout),
            [
                "--literal-pathspecs",
                "diff",
                "--cached",
                "--name-status",
                "-z",
                "--find-renames",
                "--no-ext-diff",
                "--no-textconv",
            ],
            GitRunOptions {
                max_stdout: 8 * 1024 * 1024,
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()?;
    let stats = runner
        .run_with_options(
            Some(checkout),
            [
                "--literal-pathspecs",
                "diff",
                "--cached",
                "--numstat",
                "-z",
                "--find-renames",
                "--no-ext-diff",
                "--no-textconv",
            ],
            GitRunOptions {
                max_stdout: 8 * 1024 * 1024,
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()?;
    if names.stdout_truncated || stats.stdout_truncated {
        return Err(CoreError::Blocked(
            "staged manifest exceeded the safety limit".into(),
        ));
    }
    let stat_map = parse_numstat_z(&stats.stdout);
    let fields = names
        .stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut outside_project_paths = BTreeSet::new();
    let mut index = 0;
    while index < fields.len() {
        let status = String::from_utf8_lossy(fields[index]).into_owned();
        index += 1;
        let renamed = status.starts_with('R') || status.starts_with('C');
        let old_path = if renamed {
            let value = fields
                .get(index)
                .ok_or_else(|| CoreError::Internal("staged rename has no old path".into()))?
                .to_vec();
            index += 1;
            Some(value)
        } else {
            None
        };
        let path = fields
            .get(index)
            .ok_or_else(|| CoreError::Internal("staged status has no path".into()))?
            .to_vec();
        index += 1;
        let (additions, deletions, binary) =
            stat_map.get(&path).cloned().unwrap_or((None, None, false));
        let new_outside = !checkout
            .join(bytes_to_path(&path))
            .starts_with(project_boundary);
        let old_outside = old_path.as_ref().is_some_and(|old| {
            !checkout
                .join(bytes_to_path(old))
                .starts_with(project_boundary)
        });
        if new_outside {
            outside_project_paths.insert(String::from_utf8_lossy(&path).into_owned());
        }
        if old_outside {
            if let Some(old_path) = old_path.as_ref() {
                outside_project_paths.insert(String::from_utf8_lossy(old_path).into_owned());
            }
        }
        files.push(GitCommitScopeFile {
            status,
            path_token: encode_path_token(checkout_id, &path),
            display_path: String::from_utf8_lossy(&path).into_owned(),
            old_path_token: old_path
                .as_deref()
                .map(|path| encode_path_token(checkout_id, path)),
            display_old_path: old_path
                .as_ref()
                .map(|path| String::from_utf8_lossy(path).into_owned()),
            additions,
            deletions,
            binary,
            outside_project: new_outside || old_outside,
        });
    }
    Ok((files, outside_project_paths.into_iter().collect()))
}

fn project_boundary(resolved: &super::context::ResolvedGitContext) -> Result<std::path::PathBuf> {
    let main_identity = super::repository::RepositoryIdentity::from_project(
        &resolved.project,
        &GitRunner::default(),
    )?;
    let project_root = std::fs::canonicalize(&resolved.project.root_path)?;
    let relative = project_root
        .strip_prefix(&main_identity.root)
        .map_err(|_| CoreError::Conflict("Project root is outside its approved Git root".into()))?;
    Ok(Path::new(&resolved.descriptor.checkout_root).join(relative))
}

fn message_hash(message: &str) -> String {
    let canonical = message.trim_end_matches(['\r', '\n']);
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

fn commit_token(
    checkout_id: &str,
    head: Option<&str>,
    index_hash: &str,
    message_hash: &str,
) -> String {
    super::token::sign(
        b"git-commit-v1",
        &[
            checkout_id.as_bytes(),
            head.unwrap_or("(unborn)").as_bytes(),
            index_hash.as_bytes(),
            message_hash.as_bytes(),
        ],
    )
}

fn execution_error(execution: &Result<GitOutput>) -> Option<String> {
    match execution {
        Ok(output) if output.success() => None,
        Ok(output) if output.timed_out => {
            Some("Git commit timed out; repository state was reconciled".into())
        }
        Ok(output) => {
            let stderr = output.stderr_lossy();
            let trimmed = stderr.trim();
            let mut message = if trimmed.is_empty() {
                format!("Git commit failed with exit {:?}", output.exit_code())
            } else {
                trimmed.to_owned()
            };
            if output.stderr_truncated {
                message.push_str(" [stderr truncated]");
            }
            Some(message)
        }
        Err(error) => Some(error.to_string()),
    }
}

fn read_head(runner: &super::command::GitRunner, checkout: &Path) -> Result<Option<String>> {
    let output = runner.run_read_only(Some(checkout), ["rev-parse", "--verify", "HEAD"])?;
    Ok(output
        .success()
        .then(|| output.stdout_lossy().trim().to_owned()))
}

fn read_tree(runner: &super::command::GitRunner, checkout: &Path, oid: &str) -> Result<String> {
    let spec = format!("{oid}^{{tree}}");
    Ok(runner
        .run_read_only(Some(checkout), ["rev-parse", "--verify", &spec])?
        .require_success()?
        .stdout_lossy()
        .trim()
        .to_owned())
}

fn read_parents(
    runner: &super::command::GitRunner,
    checkout: &Path,
    oid: &str,
) -> Result<Vec<String>> {
    Ok(runner
        .run_read_only(Some(checkout), ["show", "-s", "--format=%P", oid])?
        .require_success()?
        .stdout_lossy()
        .split_whitespace()
        .map(str::to_owned)
        .collect())
}

fn read_message(runner: &super::command::GitRunner, checkout: &Path, oid: &str) -> Result<String> {
    Ok(runner
        .run_with_options(
            Some(checkout),
            ["show", "-s", "--format=%B", oid],
            GitRunOptions {
                max_stdout: 64 * 1024,
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()?
        .stdout_lossy())
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::models::Project;
    use chrono::Utc;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn git(root: &Path, args: &[&str]) -> String {
        assert!(root.join(".agentport-git-feature-mock").is_file());
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn commit_journal_rejects_a_project_with_an_active_removal_fence() {
        let db = Db::open_memory().unwrap();
        db.add_project(&Project {
            id: "project-removing".into(),
            name: "project-removing".into(),
            root_path: "/tmp/project-removing".into(),
            git_root_path: Some("/tmp/project-removing".into()),
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
        db.begin_project_removal("project-removing").unwrap();
        let review = GitCommitReview {
            context: super::super::context::GitCheckoutDescriptor {
                target: super::super::context::GitCheckoutTarget {
                    project_id: "project-removing".into(),
                    kind: super::super::context::GitCheckoutKind::Main,
                    worktree_id: None,
                },
                checkout_id: "checkout".into(),
                repo_key: "repo".into(),
                project_name: "project-removing".into(),
                project_root: "/tmp/project-removing".into(),
                checkout_root: "/tmp/project-removing".into(),
                expected_branch: Some("main".into()),
                actual_branch: Some("main".into()),
                head_oid: None,
                detached: false,
                unborn: true,
                ongoing_operation: None,
                has_remote: false,
                remote: None,
                remote_url: None,
                upstream: None,
                ahead: 0,
                behind: 0,
                worktree_health: None,
                live_session_ids: Vec::new(),
                writable: true,
                blockers: Vec::new(),
                warnings: Vec::new(),
            },
            commit_token: "token".into(),
            message: "message".into(),
            message_hash: "message-hash".into(),
            before_head: None,
            index_hash: "index-hash".into(),
            expected_tree_oid: "tree".into(),
            files: Vec::new(),
            outside_project_paths: Vec::new(),
            subject_over_72: false,
            warnings: Vec::new(),
        };
        let manager = GitWorkspaceManager::new(&db);

        assert!(matches!(
            manager.insert_commit_journal("commit-op", &review, "tree", "started"),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn signing_timeout_kills_hook_process_group_and_reconciles_as_not_executed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("agentport-git-feature-mock");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join(".agentport-git-feature-mock"),
            "AgentPort Git Center test only\n",
        )
        .unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Signing Timeout Test"]);
        git(
            &root,
            &["config", "user.email", "signing-timeout@test.invalid"],
        );
        std::fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&root, &["add", "--", "tracked.txt"]);
        git(
            &root,
            &["-c", "commit.gpgsign=false", "commit", "-m", "initial"],
        );

        let signer = root.join("slow-signer.sh");
        std::fs::write(&signer, "#!/bin/sh\nsleep 5\nexit 1\n").unwrap();
        std::fs::set_permissions(&signer, std::fs::Permissions::from_mode(0o700)).unwrap();
        git(&root, &["config", "commit.gpgsign", "true"]);
        git(&root, &["config", "user.signingkey", "test-key"]);
        git(&root, &["config", "gpg.program", signer.to_str().unwrap()]);

        let db = Db::open_memory().unwrap();
        db.add_project(&Project {
            id: "project-timeout".into(),
            name: "project-timeout".into(),
            root_path: root.to_string_lossy().into_owned(),
            git_root_path: Some(root.to_string_lossy().into_owned()),
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
        std::fs::write(root.join("tracked.txt"), "signed content\n").unwrap();
        let locator = GitContextLocator::ProjectMain {
            project_id: "project-timeout".into(),
        };
        let manager = GitWorkspaceManager::new(&db).with_commit_timeout(Duration::from_millis(150));
        let changes = manager.changes(&locator, true).unwrap();
        let entry = changes
            .entries
            .iter()
            .find(|entry| entry.display_path == "tracked.txt")
            .unwrap();
        let staged = manager
            .stage_paths(
                &locator,
                &changes.context.checkout_id,
                &changes.status_token,
                &[GitPathSelection {
                    path_token: entry.path_token.clone(),
                    entry_token: entry.entry_token.clone(),
                }],
            )
            .unwrap()
            .changes;
        let review = manager
            .prepare_commit(
                &locator,
                &staged.context.checkout_id,
                &staged.status_token,
                "signing timeout",
            )
            .unwrap();
        let started = Instant::now();
        let result = manager
            .commit_changes(
                &locator,
                &review.context.checkout_id,
                &review.commit_token,
                &review.message,
            )
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(result.outcome, GitCommitOutcome::NotExecuted);
        assert!(result
            .error
            .as_deref()
            .is_some_and(|error| error.contains("timed out")));
        assert_eq!(
            git(&root, &["rev-parse", "HEAD"]).trim(),
            review.before_head.unwrap()
        );
        assert_eq!(
            git(&root, &["diff", "--cached", "--name-only"]).trim(),
            "tracked.txt"
        );
    }
}
