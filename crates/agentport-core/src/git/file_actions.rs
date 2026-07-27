use super::command::GitRunOptions;
use super::commit::{GitMutationResult, GitPathSelection};
use super::context::{GitContextLocator, GitWorkspaceManager};
use super::repository::{repository_lock, RepositoryFileLock};
use super::status::{bytes_to_path, decode_path_token, GitChangeEntry, GitChangesSnapshot};
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

const MAX_IGNORE_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitIgnoreTarget {
    Repository,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitResolvedFile {
    pub context: super::context::GitCheckoutDescriptor,
    pub display_path: String,
    pub absolute_path: String,
}

impl<'a> GitWorkspaceManager<'a> {
    pub fn discard_paths(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: &str,
        selections: &[GitPathSelection],
    ) -> Result<GitMutationResult> {
        if selections.is_empty() {
            return Err(CoreError::Validation(
                "select at least one unstaged Git Changes file".into(),
            ));
        }
        let initial = self.resolve_internal(locator)?;
        validate_checkout_id(&initial.descriptor.checkout_id, expected_checkout_id)?;
        let lock = repository_lock(&initial.identity.repo_key);
        let _guard = lock.lock().unwrap();
        let locked = self.resolve_internal(locator)?;
        validate_checkout_id(&locked.descriptor.checkout_id, expected_checkout_id)?;
        let _file_guard = RepositoryFileLock::acquire(&locked.identity.common_dir)?;
        let snapshot = self.changes(locator, true)?;
        validate_snapshot(&snapshot, expected_checkout_id, expected_status_token)?;
        let paths = selected_paths(&snapshot, selections, |entry| {
            entry.unstaged && !entry.untracked && !entry.ignored && !entry.conflicted
        })?;
        let checkout = Path::new(&snapshot.context.checkout_root);
        self.runner
            .run_with_options(
                Some(checkout),
                [
                    "restore",
                    "--worktree",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                GitRunOptions {
                    input: Some(nul_path_input(&paths)),
                    max_stdout: 256 * 1024,
                    max_stderr: 256 * 1024,
                    ..GitRunOptions::default()
                },
            )?
            .require_success()?;
        Ok(GitMutationResult {
            operation_id: operation_id(),
            changes: self.changes(locator, true)?,
        })
    }

    pub fn ignore_path(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: &str,
        selection: &GitPathSelection,
        target: GitIgnoreTarget,
    ) -> Result<GitMutationResult> {
        let initial = self.resolve_internal(locator)?;
        validate_checkout_id(&initial.descriptor.checkout_id, expected_checkout_id)?;
        let lock = repository_lock(&initial.identity.repo_key);
        let _guard = lock.lock().unwrap();
        let locked = self.resolve_internal(locator)?;
        validate_checkout_id(&locked.descriptor.checkout_id, expected_checkout_id)?;
        let _file_guard = RepositoryFileLock::acquire(&locked.identity.common_dir)?;
        let snapshot = self.changes(locator, true)?;
        validate_snapshot(&snapshot, expected_checkout_id, expected_status_token)?;
        let entry = selected_entry(&snapshot, selection)?;
        if !entry.untracked || entry.staged || entry.ignored {
            return Err(CoreError::Validation(
                "only an untracked file can be added to an ignore file".into(),
            ));
        }
        let raw = decode_path_token(&snapshot.context.checkout_id, &entry.path_token)?;
        let path = std::str::from_utf8(&raw).map_err(|_| {
            CoreError::Validation("non-UTF-8 paths cannot be ignored safely".into())
        })?;
        let rule = exact_ignore_rule(path)?;
        let ignore_file = match target {
            GitIgnoreTarget::Repository => {
                Path::new(&snapshot.context.checkout_root).join(".gitignore")
            }
            GitIgnoreTarget::Local => locked.identity.common_dir.join("info").join("exclude"),
        };
        append_ignore_rule(&ignore_file, &rule)?;
        Ok(GitMutationResult {
            operation_id: operation_id(),
            changes: self.changes(locator, true)?,
        })
    }

    pub fn resolve_file(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: &str,
        selection: &GitPathSelection,
    ) -> Result<GitResolvedFile> {
        let snapshot = self.changes(locator, true)?;
        validate_snapshot(&snapshot, expected_checkout_id, expected_status_token)?;
        let entry = selected_entry(&snapshot, selection)?;
        let raw = decode_path_token(&snapshot.context.checkout_id, &entry.path_token)?;
        let checkout = Path::new(&snapshot.context.checkout_root);
        let path = checkout.join(bytes_to_path(&raw));
        let canonical = std::fs::canonicalize(&path).map_err(|_| {
            CoreError::NotFound(format!("file no longer exists: {}", path.display()))
        })?;
        let canonical_checkout = std::fs::canonicalize(checkout)?;
        if !canonical.starts_with(&canonical_checkout) {
            return Err(CoreError::Blocked(
                "Git file resolves outside this Checkout".into(),
            ));
        }
        let display_path = entry.display_path.clone();
        Ok(GitResolvedFile {
            context: snapshot.context,
            display_path,
            absolute_path: canonical.to_string_lossy().into_owned(),
        })
    }

    pub fn trash_path<F>(
        &self,
        locator: &GitContextLocator,
        expected_checkout_id: &str,
        expected_status_token: &str,
        selection: &GitPathSelection,
        trash: F,
    ) -> Result<GitMutationResult>
    where
        F: FnOnce(&Path) -> Result<()>,
    {
        let initial = self.resolve_internal(locator)?;
        validate_checkout_id(&initial.descriptor.checkout_id, expected_checkout_id)?;
        let lock = repository_lock(&initial.identity.repo_key);
        let _guard = lock.lock().unwrap();
        let locked = self.resolve_internal(locator)?;
        validate_checkout_id(&locked.descriptor.checkout_id, expected_checkout_id)?;
        let _file_guard = RepositoryFileLock::acquire(&locked.identity.common_dir)?;
        let snapshot = self.changes(locator, true)?;
        validate_snapshot(&snapshot, expected_checkout_id, expected_status_token)?;
        let entry = selected_entry(&snapshot, selection)?;
        if !entry.untracked || entry.staged || entry.ignored {
            return Err(CoreError::Validation(
                "only an untracked file can be moved to Trash".into(),
            ));
        }
        let raw = decode_path_token(&snapshot.context.checkout_id, &entry.path_token)?;
        let checkout = std::fs::canonicalize(&snapshot.context.checkout_root)?;
        let path = checkout.join(bytes_to_path(&raw));
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
            CoreError::NotFound(format!("file no longer exists: {}", path.display()))
        })?;
        if metadata.is_dir() {
            return Err(CoreError::Blocked(
                "Git Center moves individual untracked files to Trash, not directories".into(),
            ));
        }
        let parent = path
            .parent()
            .ok_or_else(|| CoreError::Blocked("invalid untracked file path".into()))?;
        if !std::fs::canonicalize(parent)?.starts_with(&checkout) {
            return Err(CoreError::Blocked(
                "untracked file parent resolves outside this Checkout".into(),
            ));
        }
        trash(&path)?;
        Ok(GitMutationResult {
            operation_id: operation_id(),
            changes: self.changes(locator, true)?,
        })
    }
}

fn validate_checkout_id(actual: &str, expected: &str) -> Result<()> {
    if actual != expected {
        return Err(CoreError::Conflict(
            "Git Checkout changed; reopen Git Center".into(),
        ));
    }
    Ok(())
}

fn validate_snapshot(
    snapshot: &GitChangesSnapshot,
    expected_checkout_id: &str,
    expected_status_token: &str,
) -> Result<()> {
    validate_checkout_id(&snapshot.context.checkout_id, expected_checkout_id)?;
    if !snapshot.context.writable {
        return Err(CoreError::Blocked("this Git Checkout is read-only".into()));
    }
    if !snapshot.complete {
        return Err(CoreError::Blocked(
            "Git Changes is partial; file actions are disabled".into(),
        ));
    }
    if snapshot.status_token != expected_status_token {
        return Err(CoreError::Conflict(
            "Git status changed; refresh before modifying files".into(),
        ));
    }
    Ok(())
}

fn selected_entry<'a>(
    snapshot: &'a GitChangesSnapshot,
    selection: &GitPathSelection,
) -> Result<&'a GitChangeEntry> {
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.path_token == selection.path_token)
        .ok_or_else(|| CoreError::Conflict("selected file is no longer present".into()))?;
    if entry.entry_token != selection.entry_token {
        return Err(CoreError::Conflict(
            "selected file changed after it was displayed".into(),
        ));
    }
    Ok(entry)
}

fn selected_paths(
    snapshot: &GitChangesSnapshot,
    selections: &[GitPathSelection],
    allowed: impl Fn(&GitChangeEntry) -> bool,
) -> Result<BTreeSet<Vec<u8>>> {
    let mut paths = BTreeSet::new();
    for selection in selections {
        let entry = selected_entry(snapshot, selection)?;
        if !allowed(entry) {
            return Err(CoreError::Validation(format!(
                "{} cannot use this Git file action",
                entry.display_path
            )));
        }
        paths.insert(decode_path_token(
            &snapshot.context.checkout_id,
            &entry.path_token,
        )?);
    }
    Ok(paths)
}

fn nul_path_input(paths: &BTreeSet<Vec<u8>>) -> Vec<u8> {
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path);
        input.push(0);
    }
    input
}

fn exact_ignore_rule(path: &str) -> Result<String> {
    if path.contains('\n') || path.contains('\r') {
        return Err(CoreError::Validation(
            "paths containing line breaks cannot be added to ignore files".into(),
        ));
    }
    let mut rule = String::from("/");
    for value in path.chars() {
        if matches!(value, '\\' | '*' | '?' | '[' | ']' | ' ') {
            rule.push('\\');
        }
        rule.push(value);
    }
    Ok(rule)
}

fn append_ignore_rule(path: &Path, rule: &str) -> Result<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(CoreError::Blocked(format!(
                "ignore target is not a regular file: {}",
                path.display()
            )));
        }
        if metadata.len() > MAX_IGNORE_FILE_BYTES {
            return Err(CoreError::Blocked(format!(
                "ignore file exceeds {} bytes",
                MAX_IGNORE_FILE_BYTES
            )));
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    if existing.lines().any(|line| line == rule) {
        return Ok(());
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        file.write_all(b"\n")?;
    }
    writeln!(file, "{rule}")?;
    file.sync_all()?;
    Ok(())
}

fn operation_id() -> String {
    format!("gitop_{}", uuid::Uuid::new_v4().simple())
}
