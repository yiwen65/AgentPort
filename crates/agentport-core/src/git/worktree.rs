//! Worktree creation/removal details — see mod.rs for the contract.
//! Worktree discovery uses the machine-safe NUL-delimited porcelain format.

use super::GitWorktreeInfo;
use crate::error::{CoreError, Result};
use std::path::PathBuf;

/// Machine-safe parser for `git worktree list --porcelain -z`.
pub(crate) fn parse_worktree_list_z(raw: &[u8]) -> Result<Vec<GitWorktreeInfo>> {
    let mut out = Vec::new();
    let mut current: Option<GitWorktreeInfo> = None;
    for field in raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        if let Some(path) = field.strip_prefix(b"worktree ") {
            if let Some(info) = current.take() {
                out.push(info);
            }
            current = Some(GitWorktreeInfo {
                path: bytes_to_path(path),
                head: None,
                branch: None,
                locked: false,
                prunable: false,
            });
            continue;
        }
        let info = current.as_mut().ok_or_else(|| {
            CoreError::Internal("worktree porcelain record has no worktree path".into())
        })?;
        if let Some(head) = field.strip_prefix(b"HEAD ") {
            info.head = Some(String::from_utf8_lossy(head).into_owned());
        } else if let Some(branch) = field.strip_prefix(b"branch ") {
            let branch = branch.strip_prefix(b"refs/heads/").unwrap_or(branch);
            info.branch = Some(String::from_utf8_lossy(branch).into_owned());
        } else if field.starts_with(b"locked") {
            info.locked = true;
        } else if field.starts_with(b"prunable") {
            info.prunable = true;
        }
    }
    if let Some(info) = current {
        out.push(info);
    }
    Ok(out)
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
