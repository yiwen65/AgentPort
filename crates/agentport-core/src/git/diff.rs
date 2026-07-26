use super::command::{GitRunOptions, GitRunner};
use super::context::{GitCheckoutDescriptor, GitContextLocator, GitWorkspaceManager};
use super::status::{bytes_to_path, decode_path_token, GitChangeEntry};
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::path::Path;

const MAX_DIFF_BYTES: usize = 1024 * 1024;
const MAX_DIFF_LINES: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDiffSide {
    Staged,
    Unstaged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDiffFormat {
    Text,
    Binary,
    Summary,
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub context: GitCheckoutDescriptor,
    pub status_token: String,
    pub side: GitDiffSide,
    pub path_token: String,
    pub display_path: String,
    pub format: GitDiffFormat,
    pub patch: Option<String>,
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
    pub file_size: Option<u64>,
    pub truncated: bool,
    pub reason: Option<String>,
    pub conflict_code: Option<String>,
}

impl<'a> GitWorkspaceManager<'a> {
    pub fn diff(
        &self,
        locator: &GitContextLocator,
        expected_status_token: &str,
        side: GitDiffSide,
        path_token: &str,
    ) -> Result<GitFileDiff> {
        let snapshot = self.changes(locator, true)?;
        if !snapshot.complete {
            return Err(CoreError::Blocked(
                "Git Changes is partial; refresh before opening a Diff".into(),
            ));
        }
        if snapshot.status_token != expected_status_token {
            return Err(CoreError::Conflict(
                "Git status changed; refresh the selected file".into(),
            ));
        }
        let raw_path = decode_path_token(&snapshot.context.checkout_id, path_token)?;
        let entry = snapshot
            .entries
            .iter()
            .find(|entry| entry.path_token == path_token)
            .ok_or_else(|| {
                CoreError::Conflict("selected file is no longer present in Git Changes".into())
            })?;
        if entry.ignored {
            return Err(CoreError::Blocked(
                "ignored file contents are not previewed".into(),
            ));
        }
        match side {
            GitDiffSide::Staged if !entry.staged => {
                return Err(CoreError::Validation(
                    "selected file has no staged changes".into(),
                ))
            }
            GitDiffSide::Unstaged if !entry.unstaged && !entry.untracked && !entry.conflicted => {
                return Err(CoreError::Validation(
                    "selected file has no unstaged changes".into(),
                ))
            }
            _ => {}
        }

        if entry.untracked {
            return untracked_diff(snapshot.context, expected_status_token, entry, raw_path);
        }
        tracked_diff(
            &self.runner,
            snapshot.context,
            expected_status_token,
            side,
            entry,
            raw_path,
        )
    }
}

fn tracked_diff(
    runner: &GitRunner,
    context: GitCheckoutDescriptor,
    status_token: &str,
    side: GitDiffSide,
    entry: &GitChangeEntry,
    raw_path: Vec<u8>,
) -> Result<GitFileDiff> {
    let checkout = Path::new(&context.checkout_root);
    let old_path = entry
        .old_path_token
        .as_deref()
        .map(|token| decode_path_token(&context.checkout_id, token))
        .transpose()?;
    let numstat = run_git_diff(runner, checkout, side, &raw_path, old_path.as_deref(), true)?;
    let (additions, deletions, binary) = parse_numstat(&numstat.stdout);
    let file_size = std::fs::symlink_metadata(checkout.join(bytes_to_path(&raw_path)))
        .ok()
        .map(|metadata| metadata.len());
    if binary {
        return Ok(GitFileDiff {
            context,
            status_token: status_token.into(),
            side,
            path_token: entry.path_token.clone(),
            display_path: entry.display_path.clone(),
            format: GitDiffFormat::Binary,
            patch: None,
            additions: None,
            deletions: None,
            file_size,
            truncated: false,
            reason: Some("binary".into()),
            conflict_code: entry.conflict_code.clone(),
        });
    }

    let patch = run_git_diff(
        runner,
        checkout,
        side,
        &raw_path,
        old_path.as_deref(),
        false,
    )?;
    let mut truncated = patch.stdout_truncated;
    let mut text = String::from_utf8_lossy(&patch.stdout).into_owned();
    let lines = text.lines().count();
    if lines > MAX_DIFF_LINES {
        text = text
            .lines()
            .take(MAX_DIFF_LINES)
            .collect::<Vec<_>>()
            .join("\n");
        text.push('\n');
        truncated = true;
    }
    Ok(GitFileDiff {
        context,
        status_token: status_token.into(),
        side,
        path_token: entry.path_token.clone(),
        display_path: entry.display_path.clone(),
        format: if entry.conflicted {
            GitDiffFormat::Conflict
        } else {
            GitDiffFormat::Text
        },
        patch: Some(text),
        additions,
        deletions,
        file_size,
        truncated,
        reason: truncated.then(|| "diff_limit".into()),
        conflict_code: entry.conflict_code.clone(),
    })
}

fn run_git_diff(
    runner: &GitRunner,
    checkout: &Path,
    side: GitDiffSide,
    path: &[u8],
    old_path: Option<&[u8]>,
    numstat: bool,
) -> Result<super::command::GitOutput> {
    let mut args = vec![
        OsString::from("--literal-pathspecs"),
        OsString::from("diff"),
        OsString::from("--no-color"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--find-renames"),
        OsString::from("--submodule=short"),
    ];
    if side == GitDiffSide::Staged {
        args.push(OsString::from("--cached"));
    }
    if numstat {
        args.push(OsString::from("--numstat"));
        args.push(OsString::from("-z"));
    }
    args.push(OsString::from("--"));
    args.push(bytes_to_path(path).into_os_string());
    if let Some(old_path) = old_path {
        args.push(bytes_to_path(old_path).into_os_string());
    }
    runner
        .run_with_options(
            Some(checkout),
            args,
            GitRunOptions {
                max_stdout: if numstat { 64 * 1024 } else { MAX_DIFF_BYTES },
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()
}

fn parse_numstat(raw: &[u8]) -> (Option<usize>, Option<usize>, bool) {
    let first = raw.split(|byte| *byte == 0).next().unwrap_or_default();
    let fields = first.split(|byte| *byte == b'\t').collect::<Vec<_>>();
    if fields.len() < 2 || fields[0] == b"-" || fields[1] == b"-" {
        return (None, None, fields.len() >= 2);
    }
    (
        std::str::from_utf8(fields[0])
            .ok()
            .and_then(|value| value.parse().ok()),
        std::str::from_utf8(fields[1])
            .ok()
            .and_then(|value| value.parse().ok()),
        false,
    )
}

fn untracked_diff(
    context: GitCheckoutDescriptor,
    status_token: &str,
    entry: &GitChangeEntry,
    raw_path: Vec<u8>,
) -> Result<GitFileDiff> {
    let checkout = Path::new(&context.checkout_root);
    let (file, file_size) = match open_untracked_no_follow(checkout, &raw_path)? {
        UntrackedTarget::File { file, size } => (file, size),
        UntrackedTarget::Summary { size, reason } => {
            return Ok(summary_diff(context, status_token, entry, size, reason));
        }
    };
    if file_size > MAX_DIFF_BYTES as u64 {
        return Ok(summary_diff(
            context,
            status_token,
            entry,
            file_size,
            "file_size_limit",
        ));
    }
    let mut contents = Vec::with_capacity(file_size as usize);
    file.take((MAX_DIFF_BYTES + 1) as u64)
        .read_to_end(&mut contents)?;
    if contents.len() > MAX_DIFF_BYTES {
        return Ok(summary_diff(
            context,
            status_token,
            entry,
            file_size,
            "file_size_limit",
        ));
    }
    let Ok(text) = std::str::from_utf8(&contents) else {
        return Ok(GitFileDiff {
            context,
            status_token: status_token.into(),
            side: GitDiffSide::Unstaged,
            path_token: entry.path_token.clone(),
            display_path: entry.display_path.clone(),
            format: GitDiffFormat::Binary,
            patch: None,
            additions: None,
            deletions: None,
            file_size: Some(file_size),
            truncated: false,
            reason: Some("binary".into()),
            conflict_code: None,
        });
    };
    if contents.contains(&0) {
        return Ok(GitFileDiff {
            context,
            status_token: status_token.into(),
            side: GitDiffSide::Unstaged,
            path_token: entry.path_token.clone(),
            display_path: entry.display_path.clone(),
            format: GitDiffFormat::Binary,
            patch: None,
            additions: None,
            deletions: None,
            file_size: Some(file_size),
            truncated: false,
            reason: Some("binary".into()),
            conflict_code: None,
        });
    }
    let line_count = text.lines().count();
    if line_count > MAX_DIFF_LINES {
        return Ok(summary_diff(
            context,
            status_token,
            entry,
            file_size,
            "line_limit",
        ));
    }
    let mut patch = format!(
        "diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n",
        entry.display_path
    );
    for line in text.split_inclusive('\n') {
        patch.push('+');
        patch.push_str(line);
    }
    if !text.is_empty() && !text.ends_with('\n') {
        patch.push_str("\n\\ No newline at end of file\n");
    }
    Ok(GitFileDiff {
        context,
        status_token: status_token.into(),
        side: GitDiffSide::Unstaged,
        path_token: entry.path_token.clone(),
        display_path: entry.display_path.clone(),
        format: GitDiffFormat::Text,
        patch: Some(patch),
        additions: Some(line_count),
        deletions: Some(0),
        file_size: Some(file_size),
        truncated: false,
        reason: None,
        conflict_code: None,
    })
}

fn summary_diff(
    context: GitCheckoutDescriptor,
    status_token: &str,
    entry: &GitChangeEntry,
    file_size: u64,
    reason: &str,
) -> GitFileDiff {
    GitFileDiff {
        context,
        status_token: status_token.into(),
        side: GitDiffSide::Unstaged,
        path_token: entry.path_token.clone(),
        display_path: entry.display_path.clone(),
        format: GitDiffFormat::Summary,
        patch: None,
        additions: None,
        deletions: None,
        file_size: Some(file_size),
        truncated: true,
        reason: Some(reason.into()),
        conflict_code: entry.conflict_code.clone(),
    }
}

enum UntrackedTarget {
    File { file: File, size: u64 },
    Summary { size: u64, reason: &'static str },
}

#[cfg(unix)]
fn open_untracked_no_follow(checkout: &Path, raw_path: &[u8]) -> Result<UntrackedTarget> {
    use std::ffi::CString;
    use std::mem::MaybeUninit;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::OpenOptionsExt;

    let mut root_options = std::fs::OpenOptions::new();
    root_options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut directory = root_options.open(checkout)?;
    let components = raw_path.split(|byte| *byte == b'/').collect::<Vec<_>>();
    for component in &components[..components.len().saturating_sub(1)] {
        let component = CString::new(*component)
            .map_err(|_| CoreError::Validation("NUL in Git path component".into()))?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                component.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(CoreError::Io(std::io::Error::last_os_error()));
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    let name = CString::new(
        *components
            .last()
            .ok_or_else(|| CoreError::Validation("empty Git path cannot be previewed".into()))?,
    )
    .map_err(|_| CoreError::Validation("NUL in Git path component".into()))?;
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return Err(CoreError::Io(std::io::Error::last_os_error()));
    }
    let stat = unsafe { stat.assume_init() };
    let kind = stat.st_mode & libc::S_IFMT;
    let size = stat.st_size.max(0) as u64;
    if kind == libc::S_IFLNK {
        return Ok(UntrackedTarget::Summary {
            size,
            reason: "symlink_no_follow",
        });
    }
    if kind != libc::S_IFREG {
        return Ok(UntrackedTarget::Summary {
            size,
            reason: "not_regular_file",
        });
    }
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(CoreError::Io(std::io::Error::last_os_error()));
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok(UntrackedTarget::Summary {
            size: metadata.len(),
            reason: "not_regular_file",
        });
    }
    Ok(UntrackedTarget::File {
        size: metadata.len(),
        file,
    })
}

#[cfg(not(unix))]
fn open_untracked_no_follow(checkout: &Path, raw_path: &[u8]) -> Result<UntrackedTarget> {
    let path = checkout.join(bytes_to_path(raw_path));
    let metadata = std::fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() {
        return Ok(UntrackedTarget::Summary {
            size: metadata.len(),
            reason: "symlink_no_follow",
        });
    }
    if !metadata.is_file() {
        return Ok(UntrackedTarget::Summary {
            size: metadata.len(),
            reason: "not_regular_file",
        });
    }
    let canonical = std::fs::canonicalize(&path)?;
    if !canonical.starts_with(checkout) {
        return Err(CoreError::Blocked(
            "untracked path resolves outside the Checkout".into(),
        ));
    }
    Ok(UntrackedTarget::File {
        size: metadata.len(),
        file: File::open(canonical)?,
    })
}
