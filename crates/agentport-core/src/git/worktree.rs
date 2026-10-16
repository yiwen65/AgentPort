//! Worktree creation/removal details — see mod.rs for the contract.
//! Worktree discovery uses the machine-safe NUL-delimited porcelain format.

use super::{command::GitRunner, GitWorktreeInfo};
use crate::error::{CoreError, Result};
use std::path::{Path, PathBuf};

pub(crate) fn read_worktrees(root: &Path, runner: &GitRunner) -> Result<Vec<GitWorktreeInfo>> {
    let output = runner.run_read_only(Some(root), ["worktree", "list", "--porcelain", "-z"])?;
    if output.exit_code() == Some(129) && output.stderr_lossy().contains("unknown switch `z'") {
        // Git 2.34 (Ubuntu 22.04) lacks -z and writes paths WITHOUT quoting.
        // Refuse ambiguous newline paths before using its line format.
        ensure_legacy_paths_are_unambiguous(root, runner)?;
        let output = runner
            .run_read_only(Some(root), ["worktree", "list", "--porcelain"])?
            .require_success()?;
        return parse_worktree_list_lines(&output.stdout);
    }
    parse_worktree_list_z(&output.require_success()?.stdout)
}

fn parse_worktree_list_lines(raw: &[u8]) -> Result<Vec<GitWorktreeInfo>> {
    let mut nul = Vec::new();
    for line in raw
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        if !(line.starts_with(b"worktree ")
            || line.starts_with(b"HEAD ")
            || line.starts_with(b"branch ")
            || line == b"detached"
            || line == b"bare"
            || line.starts_with(b"locked")
            || line.starts_with(b"prunable"))
        {
            return Err(legacy_path_error());
        }
        nul.extend_from_slice(line);
        nul.push(0);
    }
    parse_worktree_list_z(&nul)
}

fn legacy_path_error() -> CoreError {
    CoreError::Blocked(
        "this Git version cannot safely list worktree paths containing newlines; upgrade Git to a version supporting worktree list --porcelain -z".into(),
    )
}

fn ensure_no_newline(bytes: &[u8]) -> Result<()> {
    if bytes.contains(&b'\n') {
        return Err(legacy_path_error());
    }
    Ok(())
}

fn ensure_legacy_paths_are_unambiguous(root: &Path, runner: &GitRunner) -> Result<()> {
    ensure_no_newline(root.as_os_str().as_encoded_bytes())?;
    let common = runner
        .run_read_only(
            Some(root),
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?
        .require_success()?;
    let common = common.stdout.strip_suffix(b"\n").unwrap_or(&common.stdout);
    ensure_no_newline(common)?;
    let common = bytes_to_path(common);
    // core.worktree may place the main checkout outside the common directory.
    let configured =
        runner.run_read_only(Some(root), ["config", "--null", "--get", "core.worktree"])?;
    if configured.success() {
        ensure_no_newline(&configured.stdout)?;
    } else if configured.exit_code() != Some(1) {
        configured.require_success()?;
    }
    let entries = match std::fs::read_dir(common.join("worktrees")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        // gitdir stores the full linked checkout path followed by one LF.
        // Unlike line porcelain, this allows embedded LF to be detected.
        let path = std::fs::read(entry?.path().join("gitdir"))?;
        ensure_no_newline(path.strip_suffix(b"\n").unwrap_or(&path))?;
    }
    Ok(())
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_porcelain_preserves_raw_paths_and_occupancy() {
        let raw = "worktree /repo space/ü\t\"\\\nHEAD abc123\nbranch refs/heads/feature/test\nlocked reason\n\nworktree /plain repo\nHEAD def456\ndetached\nprunable reason\n\n".as_bytes();
        let list = parse_worktree_list_lines(raw).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, PathBuf::from("/repo space/ü\t\"\\"));
        assert_eq!(list[0].head.as_deref(), Some("abc123"));
        assert_eq!(list[0].branch.as_deref(), Some("feature/test"));
        assert!(list[0].locked);
        assert_eq!(list[1].path, PathBuf::from("/plain repo"));
        assert!(list[1].branch.is_none());
        assert!(list[1].prunable);
    }

    #[cfg(unix)]
    #[test]
    fn line_porcelain_preserves_non_utf8_paths() {
        use std::os::unix::ffi::OsStrExt;
        let list = parse_worktree_list_lines(b"worktree /repo\xff\n\n").unwrap();
        assert_eq!(list[0].path.as_os_str().as_bytes(), b"/repo\xff");
    }

    #[cfg(unix)]
    #[test]
    fn discovers_a_real_worktree_with_control_characters() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo ü\t\"\\");
        std::fs::create_dir(&root).unwrap();
        let runner = GitRunner::default();
        runner
            .run(Some(&root), ["init"])
            .unwrap()
            .require_success()
            .unwrap();
        let worktrees = read_worktrees(&root, &runner).unwrap();
        assert_eq!(worktrees.len(), 1);
        assert_eq!(worktrees[0].path, root.canonicalize().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn legacy_discovery_rejects_ambiguous_registered_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let runner = GitRunner::default();
        runner
            .run(Some(&root), ["init"])
            .unwrap()
            .require_success()
            .unwrap();
        assert!(ensure_legacy_paths_are_unambiguous(&root, &runner).is_ok());
        let metadata = root.join(".git/worktrees/linked");
        std::fs::create_dir_all(&metadata).unwrap();
        // This LF could otherwise forge porcelain fields and hide occupancy.
        std::fs::write(metadata.join("gitdir"), b"/linked\nHEAD spoofed/.git\n").unwrap();
        assert!(matches!(
            ensure_legacy_paths_are_unambiguous(&root, &runner),
            Err(CoreError::Blocked(_))
        ));
        assert!(ensure_no_newline(b"/main\npath").is_err());
        assert!(parse_worktree_list_lines(b"worktree /main\npath\nHEAD abc\n").is_err());
    }
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
