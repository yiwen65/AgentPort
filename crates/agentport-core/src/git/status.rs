use super::branch::{CheckoutState, RepoStatus, StatusPath};
use super::command::{GitRunOptions, GitRunner};
use super::context::{GitCheckoutDescriptor, GitContextLocator, GitWorkspaceManager};
use super::repository::RepositoryIdentity;
use super::DirtySummary;
use crate::error::{CoreError, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

const MAX_STATUS_BYTES: usize = 8 * 1024 * 1024;
const MAX_CHANGE_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Conflict,
    Untracked,
    Ignored,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeCounts {
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub ignored: usize,
    pub conflict: usize,
    pub renamed: usize,
    pub submodule: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeEntry {
    pub entry_token: String,
    pub path_token: String,
    pub display_path: String,
    pub old_path_token: Option<String>,
    pub display_old_path: Option<String>,
    pub index_status: Option<String>,
    pub worktree_status: Option<String>,
    pub conflict_code: Option<String>,
    pub kind: GitChangeKind,
    pub submodule_state: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub ignored: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangesSnapshot {
    pub context: GitCheckoutDescriptor,
    pub status_token: String,
    pub complete: bool,
    pub partial_reason: Option<String>,
    pub counts: GitChangeCounts,
    pub entries: Vec<GitChangeEntry>,
    pub observed_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RawStatusEntry {
    pub path: Vec<u8>,
    pub old_path: Option<Vec<u8>>,
    pub index_status: Option<u8>,
    pub worktree_status: Option<u8>,
    pub conflict_code: Option<String>,
    pub kind: GitChangeKind,
    pub submodule_state: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub ignored: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct StatusRead {
    pub entries: Vec<RawStatusEntry>,
    pub status_token: String,
    pub complete: bool,
    pub partial_reason: Option<String>,
    pub branch_head: Option<String>,
    pub branch_oid: Option<String>,
}

impl<'a> GitWorkspaceManager<'a> {
    pub fn changes(
        &self,
        locator: &GitContextLocator,
        include_ignored: bool,
    ) -> Result<GitChangesSnapshot> {
        let resolved = self.resolve_internal(locator)?;
        let checkout = Path::new(&resolved.descriptor.checkout_root);
        if !checkout.is_dir() {
            return Err(CoreError::NotFound(format!(
                "checkout is missing: {}",
                checkout.display()
            )));
        }
        let read = read_status(
            checkout,
            &resolved.descriptor.repo_key,
            &resolved.descriptor.checkout_id,
            &self.runner,
            include_ignored,
        )?;
        let mut context = resolved.descriptor;
        apply_status_head(&mut context, &read);
        if !read.complete {
            context.writable = false;
            if !context
                .blockers
                .iter()
                .any(|value| value == "status_partial")
            {
                context.blockers.push("status_partial".into());
            }
        }
        let counts = counts(&read.entries);
        let entries = read
            .entries
            .iter()
            .map(|entry| public_entry(&context.checkout_id, &read.status_token, entry))
            .collect();
        Ok(GitChangesSnapshot {
            context,
            status_token: read.status_token,
            complete: read.complete,
            partial_reason: read.partial_reason,
            counts,
            entries,
            observed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    }
}

fn apply_status_head(context: &mut GitCheckoutDescriptor, read: &StatusRead) {
    if let Some(branch_head) = read.branch_head.as_deref() {
        context.actual_branch = (branch_head != "(detached)").then(|| branch_head.to_owned());
    }
    if let Some(branch_oid) = read.branch_oid.as_deref() {
        if branch_oid == "(initial)" {
            context.head_oid = None;
            context.unborn = true;
            context.detached = false;
        } else {
            context.head_oid = Some(branch_oid.to_owned());
            context.unborn = false;
            context.detached = read.branch_head.as_deref() == Some("(detached)");
        }
    }
}

pub(crate) fn read_status(
    checkout: &Path,
    repo_key: &str,
    checkout_id: &str,
    runner: &GitRunner,
    include_ignored: bool,
) -> Result<StatusRead> {
    let mut args = vec![
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--ignore-submodules=none",
    ];
    if include_ignored {
        args.push("--ignored=matching");
    }
    let status = runner
        .run_with_options(
            Some(checkout),
            args,
            GitRunOptions {
                max_stdout: MAX_STATUS_BYTES,
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()?;
    let index = runner
        .run_with_options(
            Some(checkout),
            ["ls-files", "--stage", "-z"],
            GitRunOptions {
                max_stdout: MAX_STATUS_BYTES,
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()?;
    let parsed = parse_status_v2(&status.stdout, status.stdout_truncated)?;
    let mut entries = parsed.entries;
    let too_many = entries.len() > MAX_CHANGE_ENTRIES;
    if too_many {
        entries.truncate(MAX_CHANGE_ENTRIES);
    }
    let mut hasher = Sha256::new();
    hasher.update(checkout_id.as_bytes());
    hasher.update([0]);
    hasher.update(&status.stdout);
    hasher.update([0]);
    hasher.update(&index.stdout);
    for entry in &entries {
        hash_path_signature(&mut hasher, checkout, &entry.path);
        if let Some(old_path) = &entry.old_path {
            hash_path_signature(&mut hasher, checkout, old_path);
        }
    }
    let status_token = format!("{:x}", hasher.finalize());
    let complete = !status.stdout_truncated && !index.stdout_truncated && !too_many;
    let partial_reason = if status.stdout_truncated {
        Some("status_output_limit".into())
    } else if index.stdout_truncated {
        Some("index_output_limit".into())
    } else if too_many {
        Some("entry_limit".into())
    } else {
        None
    };
    let _ = repo_key;
    Ok(StatusRead {
        entries,
        status_token,
        complete,
        partial_reason,
        branch_head: parsed.branch_head,
        branch_oid: parsed.branch_oid,
    })
}

struct ParsedStatus {
    entries: Vec<RawStatusEntry>,
    branch_head: Option<String>,
    branch_oid: Option<String>,
}

fn parse_status_v2(raw: &[u8], tolerate_truncated_tail: bool) -> Result<ParsedStatus> {
    let fields = raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut branch_head = None;
    let mut branch_oid = None;
    let mut index = 0;
    while index < fields.len() {
        let field = fields[index];
        index += 1;
        if let Some(value) = field.strip_prefix(b"# branch.head ") {
            branch_head = Some(String::from_utf8_lossy(value).into_owned());
            continue;
        }
        if let Some(value) = field.strip_prefix(b"# branch.oid ") {
            branch_oid = Some(String::from_utf8_lossy(value).into_owned());
            continue;
        }
        let parsed = if field.starts_with(b"1 ") {
            parse_ordinary(field)
        } else if field.starts_with(b"2 ") {
            let old_path = fields.get(index).copied();
            if old_path.is_some() {
                index += 1;
            }
            parse_rename(field, old_path)
        } else if field.starts_with(b"u ") {
            parse_unmerged(field)
        } else if let Some(path) = field.strip_prefix(b"? ") {
            validate_relative_path(path)?;
            Ok(RawStatusEntry {
                path: path.to_vec(),
                old_path: None,
                index_status: None,
                worktree_status: None,
                conflict_code: None,
                kind: GitChangeKind::Untracked,
                submodule_state: None,
                staged: false,
                unstaged: false,
                untracked: true,
                ignored: false,
                conflicted: false,
            })
        } else if let Some(path) = field.strip_prefix(b"! ") {
            validate_relative_path(path)?;
            Ok(RawStatusEntry {
                path: path.to_vec(),
                old_path: None,
                index_status: None,
                worktree_status: None,
                conflict_code: None,
                kind: GitChangeKind::Ignored,
                submodule_state: None,
                staged: false,
                unstaged: false,
                untracked: false,
                ignored: true,
                conflicted: false,
            })
        } else if field.starts_with(b"# ") {
            continue;
        } else {
            Err(CoreError::Internal(format!(
                "unsupported porcelain v2 record: {}",
                String::from_utf8_lossy(field)
            )))
        };
        match parsed {
            Ok(entry) => entries.push(entry),
            Err(_) if tolerate_truncated_tail && index == fields.len() => break,
            Err(error) => return Err(error),
        }
    }
    Ok(ParsedStatus {
        entries,
        branch_head,
        branch_oid,
    })
}

fn parse_ordinary(field: &[u8]) -> Result<RawStatusEntry> {
    let parts = field.splitn(9, |byte| *byte == b' ').collect::<Vec<_>>();
    if parts.len() != 9 || parts[1].len() != 2 {
        return Err(CoreError::Internal(
            "incomplete ordinary porcelain v2 record".into(),
        ));
    }
    from_xy(parts[1], parts[2], parts[8].to_vec(), None, false)
}

fn parse_rename(field: &[u8], old_path: Option<&[u8]>) -> Result<RawStatusEntry> {
    let parts = field.splitn(10, |byte| *byte == b' ').collect::<Vec<_>>();
    let old_path = old_path.ok_or_else(|| {
        CoreError::Internal("rename porcelain v2 record has no original path".into())
    })?;
    if parts.len() != 10 || parts[1].len() != 2 {
        return Err(CoreError::Internal(
            "incomplete rename porcelain v2 record".into(),
        ));
    }
    from_xy(
        parts[1],
        parts[2],
        parts[9].to_vec(),
        Some(old_path.to_vec()),
        false,
    )
}

fn parse_unmerged(field: &[u8]) -> Result<RawStatusEntry> {
    let parts = field.splitn(11, |byte| *byte == b' ').collect::<Vec<_>>();
    if parts.len() != 11 || parts[1].len() != 2 {
        return Err(CoreError::Internal(
            "incomplete unmerged porcelain v2 record".into(),
        ));
    }
    from_xy(parts[1], parts[2], parts[10].to_vec(), None, true)
}

fn from_xy(
    xy: &[u8],
    submodule: &[u8],
    path: Vec<u8>,
    old_path: Option<Vec<u8>>,
    conflicted: bool,
) -> Result<RawStatusEntry> {
    validate_relative_path(&path)?;
    if let Some(old_path) = old_path.as_deref() {
        validate_relative_path(old_path)?;
    }
    let index = xy[0];
    let worktree = xy[1];
    let staged = !conflicted && index != b'.' && index != b' ';
    let unstaged = !conflicted && worktree != b'.' && worktree != b' ';
    Ok(RawStatusEntry {
        path,
        old_path,
        index_status: (index != b'.' && index != b' ').then_some(index),
        worktree_status: (worktree != b'.' && worktree != b' ').then_some(worktree),
        conflict_code: conflicted.then(|| String::from_utf8_lossy(xy).into_owned()),
        kind: kind_from_xy(index, worktree, conflicted),
        submodule_state: submodule
            .first()
            .is_some_and(|value| *value == b'S')
            .then(|| String::from_utf8_lossy(submodule).into_owned()),
        staged,
        unstaged,
        untracked: false,
        ignored: false,
        conflicted,
    })
}

fn kind_from_xy(index: u8, worktree: u8, conflicted: bool) -> GitChangeKind {
    if conflicted {
        return GitChangeKind::Conflict;
    }
    match [index, worktree] {
        [b'R', _] | [_, b'R'] => GitChangeKind::Renamed,
        [b'C', _] | [_, b'C'] => GitChangeKind::Copied,
        [b'A', _] | [_, b'A'] => GitChangeKind::Added,
        [b'D', _] | [_, b'D'] => GitChangeKind::Deleted,
        [b'T', _] | [_, b'T'] => GitChangeKind::TypeChanged,
        _ => GitChangeKind::Modified,
    }
}

pub(crate) type GitNumstatMap = HashMap<Vec<u8>, (Option<usize>, Option<usize>, bool)>;

pub(crate) fn parse_numstat_z(raw: &[u8]) -> GitNumstatMap {
    let fields = raw.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut result = HashMap::new();
    let mut index = 0;
    while index < fields.len() {
        let record = fields[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let columns = record.splitn(3, |byte| *byte == b'\t').collect::<Vec<_>>();
        if columns.len() != 3 {
            continue;
        }
        let binary = columns[0] == b"-" || columns[1] == b"-";
        let additions = (!binary)
            .then(|| std::str::from_utf8(columns[0]).ok()?.parse().ok())
            .flatten();
        let deletions = (!binary)
            .then(|| std::str::from_utf8(columns[1]).ok()?.parse().ok())
            .flatten();
        let path = if !columns[2].is_empty() {
            columns[2].to_vec()
        } else {
            // With `-z`, rename/copy numstat records encode an empty path in
            // the header followed by old-path NUL new-path NUL.
            if index + 1 >= fields.len() {
                break;
            }
            let new_path = fields[index + 1].to_vec();
            index += 2;
            new_path
        };
        if !path.is_empty() {
            result.insert(path, (additions, deletions, binary));
        }
    }
    result
}

fn counts(entries: &[RawStatusEntry]) -> GitChangeCounts {
    GitChangeCounts {
        staged: entries.iter().filter(|entry| entry.staged).count(),
        unstaged: entries.iter().filter(|entry| entry.unstaged).count(),
        untracked: entries.iter().filter(|entry| entry.untracked).count(),
        ignored: entries.iter().filter(|entry| entry.ignored).count(),
        conflict: entries.iter().filter(|entry| entry.conflicted).count(),
        renamed: entries
            .iter()
            .filter(|entry| entry.kind == GitChangeKind::Renamed)
            .count(),
        submodule: entries
            .iter()
            .filter(|entry| entry.submodule_state.is_some())
            .count(),
    }
}

fn public_entry(checkout_id: &str, status_token: &str, entry: &RawStatusEntry) -> GitChangeEntry {
    let path_token = encode_path_token(checkout_id, &entry.path);
    let old_path_token = entry
        .old_path
        .as_deref()
        .map(|path| encode_path_token(checkout_id, path));
    let mut token = Sha256::new();
    token.update(status_token.as_bytes());
    token.update([0]);
    token.update(&entry.path);
    if let Some(old_path) = &entry.old_path {
        token.update([0]);
        token.update(old_path);
    }
    token.update([
        entry.index_status.unwrap_or(b'.'),
        entry.worktree_status.unwrap_or(b'.'),
    ]);
    GitChangeEntry {
        entry_token: format!("{:x}", token.finalize()),
        path_token,
        display_path: String::from_utf8_lossy(&entry.path).into_owned(),
        old_path_token,
        display_old_path: entry
            .old_path
            .as_ref()
            .map(|path| String::from_utf8_lossy(path).into_owned()),
        index_status: entry
            .index_status
            .map(|value| char::from(value).to_string()),
        worktree_status: entry
            .worktree_status
            .map(|value| char::from(value).to_string()),
        conflict_code: entry.conflict_code.clone(),
        kind: entry.kind,
        submodule_state: entry.submodule_state.clone(),
        staged: entry.staged,
        unstaged: entry.unstaged,
        untracked: entry.untracked,
        ignored: entry.ignored,
        conflicted: entry.conflicted,
    }
}

pub(crate) fn decode_path_token(checkout_id: &str, token: &str) -> Result<Vec<u8>> {
    let (payload, signature) = token
        .split_once('.')
        .ok_or_else(|| CoreError::Validation("invalid Git path token".into()))?;
    let path = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| CoreError::Validation("invalid Git path token".into()))?;
    validate_relative_path(&path)?;
    if !super::token::verify(signature, b"git-path-v1", &[checkout_id.as_bytes(), &path]) {
        return Err(CoreError::Validation(
            "Git path token does not belong to this Checkout".into(),
        ));
    }
    Ok(path)
}

pub(crate) fn encode_path_token(checkout_id: &str, path: &[u8]) -> String {
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(path),
        path_signature(checkout_id, path)
    )
}

fn path_signature(checkout_id: &str, path: &[u8]) -> String {
    super::token::sign(b"git-path-v1", &[checkout_id.as_bytes(), path])
}

fn validate_relative_path(path: &[u8]) -> Result<()> {
    if path.is_empty() || path.contains(&0) {
        return Err(CoreError::Validation("empty or NUL Git path".into()));
    }
    let path = bytes_to_path(path);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(CoreError::Validation(
            "Git path escapes the checkout".into(),
        ));
    }
    Ok(())
}

fn hash_path_signature(hasher: &mut Sha256, checkout: &Path, raw_path: &[u8]) {
    hasher.update([0]);
    hasher.update(raw_path);
    let path = checkout.join(bytes_to_path(raw_path));
    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
        hasher.update(b"missing");
        return;
    };
    hasher.update(metadata.len().to_le_bytes());
    if let Ok(modified) = metadata.modified() {
        if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
            hasher.update(duration.as_nanos().to_le_bytes());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hasher.update(metadata.mode().to_le_bytes());
        hasher.update(metadata.ino().to_le_bytes());
    }
    if metadata.file_type().is_symlink() {
        if let Ok(target) = std::fs::read_link(path) {
            hasher.update(target.to_string_lossy().as_bytes());
        }
    }
}

pub(crate) fn read_repo_status(
    identity: &RepositoryIdentity,
    runner: &GitRunner,
) -> Result<RepoStatus> {
    let read = read_status(
        &identity.root,
        &identity.repo_key,
        &identity.repo_key,
        runner,
        false,
    )?;
    if !read.complete {
        return Err(CoreError::Blocked(format!(
            "repository status is partial: {}",
            read.partial_reason.as_deref().unwrap_or("unknown")
        )));
    }
    Ok(repo_status_from_parts(
        read.entries,
        read.branch_head,
        read.branch_oid,
    ))
}

#[cfg(test)]
pub(crate) fn parse_repo_status_v2(raw: &[u8]) -> Result<RepoStatus> {
    let parsed = parse_status_v2(raw, false)?;
    Ok(repo_status_from_parts(
        parsed.entries,
        parsed.branch_head,
        parsed.branch_oid,
    ))
}

fn repo_status_from_parts(
    entries: Vec<RawStatusEntry>,
    branch_head: Option<String>,
    branch_oid: Option<String>,
) -> RepoStatus {
    let checkout = match (branch_head.as_deref(), branch_oid.as_deref()) {
        (Some("(detached)"), Some(oid)) => CheckoutState::Detached(oid.to_owned()),
        (Some(branch), Some("(initial)")) => CheckoutState::Unborn(Some(branch.to_owned())),
        (Some(branch), _) => CheckoutState::Branch(branch.to_owned()),
        (_, Some(oid)) => CheckoutState::Detached(oid.to_owned()),
        _ => CheckoutState::Unborn(None),
    };
    let mut paths = entries
        .iter()
        .filter(|entry| !entry.ignored)
        .map(|entry| StatusPath {
            path: String::from_utf8_lossy(&entry.path).into_owned(),
            staged: entry.staged,
            unstaged: entry.unstaged,
            untracked: entry.untracked,
            unmerged: entry.conflicted,
            submodule_dirty: entry
                .submodule_state
                .as_ref()
                .is_some_and(|state| state.as_bytes().iter().skip(1).any(|value| *value != b'.')),
        })
        .collect::<Vec<_>>();
    paths.sort_by(|left, right| left.path.cmp(&right.path));
    RepoStatus {
        checkout,
        staged: paths.iter().any(|path| path.staged),
        unstaged: paths.iter().any(|path| path.unstaged),
        untracked: paths.iter().any(|path| path.untracked),
        unmerged: paths.iter().any(|path| path.unmerged),
        dirty_submodule: paths.iter().any(|path| path.submodule_dirty),
        paths,
        operation_state: None,
    }
}

pub(crate) fn read_dirty_summary(
    identity: &RepositoryIdentity,
    checkout: &Path,
    runner: &GitRunner,
) -> Result<DirtySummary> {
    let read = read_status(
        checkout,
        &identity.repo_key,
        &identity.repo_key,
        runner,
        true,
    )?;
    if !read.complete {
        return Err(CoreError::Blocked(format!(
            "worktree status is partial: {}",
            read.partial_reason.as_deref().unwrap_or("unknown")
        )));
    }
    let mut summary = DirtySummary::default();
    let mut raw = Vec::new();
    for entry in read.entries {
        if entry.ignored {
            summary.ignored += 1;
            if summary.ignored_sample.len() < 10 {
                summary
                    .ignored_sample
                    .push(String::from_utf8_lossy(&entry.path).into_owned());
            }
            continue;
        }
        summary.staged += usize::from(entry.staged);
        summary.modified += usize::from(entry.unstaged || entry.conflicted);
        summary.untracked += usize::from(entry.untracked);
        let xy = if entry.untracked {
            "??".into()
        } else if entry.conflicted {
            entry.conflict_code.unwrap_or_else(|| "UU".into())
        } else {
            format!(
                "{}{}",
                entry.index_status.map(char::from).unwrap_or(' '),
                entry.worktree_status.map(char::from).unwrap_or(' ')
            )
        };
        raw.push(format!("{xy} {}", String::from_utf8_lossy(&entry.path)));
    }
    summary.raw = raw.join("\n");
    if !summary.raw.is_empty() {
        summary.raw.push('\n');
    }
    Ok(summary)
}

#[cfg(unix)]
pub(crate) fn bytes_to_path(bytes: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
}

#[cfg(not(unix))]
pub(crate) fn bytes_to_path(bytes: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_parser_preserves_non_utf8_and_control_path_bytes() {
        let parsed = parse_status_v2(b"? non-utf8-\xff.txt\0? line\nbreak.txt\0", false).unwrap();
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[0].path, b"non-utf8-\xff.txt");
        assert_eq!(parsed.entries[1].path, b"line\nbreak.txt");
        assert!(parsed.entries.iter().all(|entry| entry.untracked));
    }

    #[test]
    fn numstat_parser_binds_rename_statistics_to_the_new_path() {
        let parsed = parse_numstat_z(b"12\t3\t\0old name.txt\0new name.txt\0");
        assert_eq!(
            parsed.get(b"new name.txt".as_slice()),
            Some(&(Some(12), Some(3), false))
        );
        assert!(!parsed.contains_key(b"old name.txt".as_slice()));
    }
}
