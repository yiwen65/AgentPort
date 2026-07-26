use super::command::{GitRunOptions, GitRunner};
use super::context::{GitCheckoutDescriptor, GitContextLocator, GitWorkspaceManager};
use super::diff::GitDiffFormat;
use super::status::{
    bytes_to_path, decode_path_token, encode_path_token, parse_numstat_z, GitNumstatMap,
};
use crate::error::{CoreError, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::Path;

const DEFAULT_HISTORY_LIMIT: usize = 50;
const MAX_HISTORY_LIMIT: usize = 100;
const MAX_HISTORY_BYTES: usize = 2 * 1024 * 1024;
const MAX_COMMIT_DIFF_BYTES: usize = 1024 * 1024;
const MAX_COMMIT_DIFF_LINES: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    pub oid: String,
    pub short_oid: String,
    pub parent_oids: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub committed_at: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryPage {
    pub context: GitCheckoutDescriptor,
    pub anchor_oid: Option<String>,
    pub commits: Vec<GitCommitSummary>,
    pub next_cursor: Option<String>,
    pub head_changed: bool,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub status: String,
    pub path_token: String,
    pub display_path: String,
    pub old_path_token: Option<String>,
    pub display_old_path: Option<String>,
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub context: GitCheckoutDescriptor,
    pub commit: GitCommitSummary,
    pub message: String,
    pub files: Vec<GitCommitFile>,
    pub selected_parent_oid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitPatch {
    pub context: GitCheckoutDescriptor,
    pub commit_oid: String,
    pub parent_oid: Option<String>,
    pub path_token: Option<String>,
    pub format: GitDiffFormat,
    pub patch: Option<String>,
    pub truncated: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryCursor {
    anchor_oid: String,
    offset: usize,
}

impl<'a> GitWorkspaceManager<'a> {
    pub fn history(
        &self,
        locator: &GitContextLocator,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<GitHistoryPage> {
        let resolved = self.resolve_internal(locator)?;
        let limit = if limit == 0 {
            DEFAULT_HISTORY_LIMIT
        } else if limit > MAX_HISTORY_LIMIT {
            return Err(CoreError::Validation(format!(
                "history limit must not exceed {MAX_HISTORY_LIMIT}"
            )));
        } else {
            limit
        };
        let (anchor_oid, offset) = match cursor {
            Some(cursor) => {
                let decoded = decode_cursor(
                    &resolved.descriptor.repo_key,
                    &resolved.descriptor.checkout_id,
                    cursor,
                )?;
                validate_oid(&decoded.anchor_oid)?;
                (Some(decoded.anchor_oid), decoded.offset)
            }
            None => (resolved.descriptor.head_oid.clone(), 0),
        };
        let Some(anchor_oid) = anchor_oid else {
            return Ok(GitHistoryPage {
                context: resolved.descriptor,
                anchor_oid: None,
                commits: Vec::new(),
                next_cursor: None,
                head_changed: false,
                observed_at: now_string(),
            });
        };
        ensure_commit(&self.runner, &resolved.identity.root, &anchor_oid)?;
        let mut args = vec![
            OsString::from("log"),
            OsString::from(&anchor_oid),
            OsString::from("--topo-order"),
            OsString::from("--date-order"),
            OsString::from(format!("--skip={offset}")),
            OsString::from(format!("--max-count={}", limit + 1)),
            OsString::from("--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%x00%x00"),
        ];
        let output = self
            .runner
            .run_with_options(
                Some(&resolved.identity.root),
                args.drain(..),
                GitRunOptions {
                    max_stdout: MAX_HISTORY_BYTES,
                    read_only: true,
                    ..GitRunOptions::default()
                },
            )?
            .require_success()?;
        if output.stdout_truncated {
            return Err(CoreError::Blocked(
                "history page exceeded the output limit".into(),
            ));
        }
        let mut commits = parse_commit_summaries(&output.stdout)?;
        let has_more = commits.len() > limit;
        if has_more {
            commits.truncate(limit);
        }
        let next_cursor = has_more.then(|| {
            encode_cursor(
                &resolved.descriptor.repo_key,
                &resolved.descriptor.checkout_id,
                &HistoryCursor {
                    anchor_oid: anchor_oid.clone(),
                    offset: offset + limit,
                },
            )
        });
        let head_changed = resolved.descriptor.head_oid.as_deref() != Some(anchor_oid.as_str());
        Ok(GitHistoryPage {
            context: resolved.descriptor,
            anchor_oid: Some(anchor_oid),
            commits,
            next_cursor,
            head_changed,
            observed_at: now_string(),
        })
    }

    pub fn commit_detail(
        &self,
        locator: &GitContextLocator,
        commit_oid: &str,
    ) -> Result<GitCommitDetail> {
        let resolved = self.resolve_internal(locator)?;
        validate_oid(commit_oid)?;
        ensure_commit(&self.runner, &resolved.identity.root, commit_oid)?;
        let commit = read_commit_summary(&self.runner, &resolved.identity.root, commit_oid)?;
        let message = self
            .runner
            .run_with_options(
                Some(&resolved.identity.root),
                [
                    "show",
                    "--no-patch",
                    "--format=%B",
                    "--no-notes",
                    commit_oid,
                ],
                GitRunOptions {
                    max_stdout: 64 * 1024,
                    read_only: true,
                    ..GitRunOptions::default()
                },
            )?
            .require_success()?;
        if message.stdout_truncated {
            return Err(CoreError::Blocked(
                "commit message exceeded the display limit".into(),
            ));
        }
        let selected_parent_oid = commit.parent_oids.first().cloned();
        let files = read_commit_files(
            &self.runner,
            &resolved.identity.root,
            &resolved.descriptor.checkout_id,
            commit_oid,
            selected_parent_oid.as_deref(),
        )?;
        Ok(GitCommitDetail {
            context: resolved.descriptor,
            commit,
            message: message.stdout_lossy(),
            files,
            selected_parent_oid,
        })
    }

    pub fn commit_diff(
        &self,
        locator: &GitContextLocator,
        commit_oid: &str,
        parent_oid: Option<&str>,
        path_token: Option<&str>,
    ) -> Result<GitCommitPatch> {
        let resolved = self.resolve_internal(locator)?;
        validate_oid(commit_oid)?;
        ensure_commit(&self.runner, &resolved.identity.root, commit_oid)?;
        let summary = read_commit_summary(&self.runner, &resolved.identity.root, commit_oid)?;
        let parent_oid = match parent_oid {
            Some(parent) => {
                validate_oid(parent)?;
                if !summary.parent_oids.iter().any(|value| value == parent) {
                    return Err(CoreError::Validation(
                        "selected parent does not belong to this commit".into(),
                    ));
                }
                Some(parent.to_owned())
            }
            None => summary.parent_oids.first().cloned(),
        };
        let selected_file = match path_token {
            Some(token) => {
                let files = read_commit_files(
                    &self.runner,
                    &resolved.identity.root,
                    &resolved.descriptor.checkout_id,
                    commit_oid,
                    parent_oid.as_deref(),
                )?;
                Some(
                    files
                        .into_iter()
                        .find(|file| file.path_token == token)
                        .ok_or_else(|| {
                            CoreError::Validation(
                                "selected path does not belong to this commit Diff".into(),
                            )
                        })?,
                )
            }
            None => None,
        };
        let raw_path = selected_file
            .as_ref()
            .map(|file| decode_path_token(&resolved.descriptor.checkout_id, &file.path_token))
            .transpose()?;
        let raw_old_path = selected_file
            .as_ref()
            .and_then(|file| file.old_path_token.as_deref())
            .map(|token| decode_path_token(&resolved.descriptor.checkout_id, token))
            .transpose()?;
        let mut args = if let Some(parent) = &parent_oid {
            vec![
                OsString::from("--literal-pathspecs"),
                OsString::from("diff"),
                OsString::from("--no-color"),
                OsString::from("--no-ext-diff"),
                OsString::from("--no-textconv"),
                OsString::from("--find-renames"),
                OsString::from("--submodule=short"),
                OsString::from(parent),
                OsString::from(commit_oid),
            ]
        } else {
            vec![
                OsString::from("--literal-pathspecs"),
                OsString::from("show"),
                OsString::from("--format="),
                OsString::from("--no-color"),
                OsString::from("--no-ext-diff"),
                OsString::from("--no-textconv"),
                OsString::from("--find-renames"),
                OsString::from("--submodule=short"),
                OsString::from("--root"),
                OsString::from("--patch"),
                OsString::from(commit_oid),
            ]
        };
        if let Some(path) = raw_path.as_deref() {
            args.push(OsString::from("--"));
            args.push(bytes_to_path(path).into_os_string());
            if let Some(old_path) = raw_old_path.as_deref() {
                args.push(bytes_to_path(old_path).into_os_string());
            }
        }
        let output = self
            .runner
            .run_with_options(
                Some(&resolved.identity.root),
                args,
                GitRunOptions {
                    max_stdout: MAX_COMMIT_DIFF_BYTES,
                    read_only: true,
                    ..GitRunOptions::default()
                },
            )?
            .require_success()?;
        let binary = output
            .stdout
            .windows(b"Binary files".len())
            .any(|window| window == b"Binary files")
            || output
                .stdout
                .windows(b"GIT binary patch".len())
                .any(|window| window == b"GIT binary patch");
        // A whole-commit patch may legitimately contain text diffs alongside
        // Git's binary summary lines. Degrade only a selected binary file;
        // otherwise preserve the useful text portion of the commit.
        if selected_file.as_ref().is_some_and(|file| file.binary)
            || (binary && path_token.is_some())
        {
            return Ok(GitCommitPatch {
                context: resolved.descriptor,
                commit_oid: commit_oid.into(),
                parent_oid,
                path_token: path_token.map(str::to_owned),
                format: GitDiffFormat::Binary,
                patch: None,
                truncated: false,
                reason: Some("binary".into()),
            });
        }
        let mut patch = String::from_utf8_lossy(&output.stdout).into_owned();
        let mut truncated = output.stdout_truncated;
        if patch.lines().count() > MAX_COMMIT_DIFF_LINES {
            patch = patch
                .lines()
                .take(MAX_COMMIT_DIFF_LINES)
                .collect::<Vec<_>>()
                .join("\n");
            patch.push('\n');
            truncated = true;
        }
        Ok(GitCommitPatch {
            context: resolved.descriptor,
            commit_oid: commit_oid.into(),
            parent_oid,
            path_token: path_token.map(str::to_owned),
            format: GitDiffFormat::Text,
            patch: Some(patch),
            truncated,
            reason: truncated.then(|| "diff_limit".into()),
        })
    }
}

fn read_commit_summary(runner: &GitRunner, checkout: &Path, oid: &str) -> Result<GitCommitSummary> {
    let format_arg = "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%x00%x00";
    let output = runner
        .run_with_options(
            Some(checkout),
            ["show", "--no-patch", "--no-notes", format_arg, oid],
            GitRunOptions {
                max_stdout: 128 * 1024,
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()?;
    parse_commit_summaries(&output.stdout)?
        .into_iter()
        .next()
        .ok_or_else(|| CoreError::Internal("Git returned no commit metadata".into()))
}

fn parse_commit_summaries(raw: &[u8]) -> Result<Vec<GitCommitSummary>> {
    let records = split_record_nul(raw);
    let mut commits = Vec::new();
    for record in records {
        let record = trim_newlines(record);
        if record.is_empty() {
            continue;
        }
        let fields = record.split(|byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() != 8 {
            return Err(CoreError::Internal(format!(
                "Git commit metadata had {} fields instead of 8",
                fields.len()
            )));
        }
        commits.push(GitCommitSummary {
            oid: text(fields[0]),
            short_oid: text(fields[1]),
            parent_oids: text(fields[2])
                .split_whitespace()
                .map(str::to_owned)
                .collect(),
            author_name: text(fields[3]),
            author_email: text(fields[4]),
            authored_at: text(fields[5]),
            committed_at: text(fields[6]),
            subject: text(fields[7]),
        });
    }
    Ok(commits)
}

fn read_commit_files(
    runner: &GitRunner,
    checkout: &Path,
    checkout_id: &str,
    commit_oid: &str,
    parent_oid: Option<&str>,
) -> Result<Vec<GitCommitFile>> {
    let mut name_args = diff_tree_args("--name-status", commit_oid, parent_oid);
    name_args.push(OsString::from("-z"));
    let names = runner
        .run_with_options(
            Some(checkout),
            name_args,
            GitRunOptions {
                max_stdout: MAX_HISTORY_BYTES,
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()?;
    if names.stdout_truncated {
        return Err(CoreError::Blocked(
            "commit file list exceeded the output limit".into(),
        ));
    }

    let mut stat_args = diff_tree_args("--numstat", commit_oid, parent_oid);
    stat_args.push(OsString::from("-z"));
    let stats = runner
        .run_with_options(
            Some(checkout),
            stat_args,
            GitRunOptions {
                max_stdout: MAX_HISTORY_BYTES,
                read_only: true,
                ..GitRunOptions::default()
            },
        )?
        .require_success()?;
    if stats.stdout_truncated {
        return Err(CoreError::Blocked(
            "commit statistics exceeded the output limit".into(),
        ));
    }
    let stats = parse_numstat_z(&stats.stdout);
    parse_name_status(checkout_id, &names.stdout, &stats)
}

fn diff_tree_args(mode: &str, commit_oid: &str, parent_oid: Option<&str>) -> Vec<OsString> {
    match parent_oid {
        Some(parent) => vec![
            OsString::from("--literal-pathspecs"),
            OsString::from("diff"),
            OsString::from(mode),
            OsString::from("--find-renames"),
            OsString::from(parent),
            OsString::from(commit_oid),
        ],
        None => vec![
            OsString::from("--literal-pathspecs"),
            OsString::from("diff-tree"),
            OsString::from("--root"),
            OsString::from("--no-commit-id"),
            OsString::from("-r"),
            OsString::from(mode),
            OsString::from("--find-renames"),
            OsString::from(commit_oid),
        ],
    }
}

fn parse_name_status(
    checkout_id: &str,
    raw: &[u8],
    stats: &GitNumstatMap,
) -> Result<Vec<GitCommitFile>> {
    let fields = raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let status = text(fields[index]);
        index += 1;
        let rename = status.starts_with('R') || status.starts_with('C');
        let old_path = if rename {
            let value = fields
                .get(index)
                .ok_or_else(|| CoreError::Internal("rename has no old path".into()))?
                .to_vec();
            index += 1;
            Some(value)
        } else {
            None
        };
        let path = fields
            .get(index)
            .ok_or_else(|| CoreError::Internal("commit status has no path".into()))?
            .to_vec();
        index += 1;
        let (additions, deletions, binary) =
            stats.get(&path).cloned().unwrap_or((None, None, false));
        files.push(GitCommitFile {
            status,
            path_token: encode_path_token(checkout_id, &path),
            display_path: text(&path),
            old_path_token: old_path
                .as_ref()
                .map(|old| encode_path_token(checkout_id, old)),
            display_old_path: old_path.as_ref().map(|old| text(old)),
            additions,
            deletions,
            binary,
        });
    }
    Ok(files)
}

fn encode_cursor(repo_key: &str, checkout_id: &str, cursor: &HistoryCursor) -> String {
    let payload = serde_json::to_vec(cursor).expect("history cursor is serializable");
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(&payload),
        super::token::sign(
            b"git-history-cursor-v1",
            &[repo_key.as_bytes(), checkout_id.as_bytes(), &payload],
        )
    )
}

fn decode_cursor(repo_key: &str, checkout_id: &str, cursor: &str) -> Result<HistoryCursor> {
    let (payload, signature) = cursor
        .split_once('.')
        .ok_or_else(|| CoreError::Validation("invalid history cursor".into()))?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| CoreError::Validation("invalid history cursor".into()))?;
    if !super::token::verify(
        signature,
        b"git-history-cursor-v1",
        &[repo_key.as_bytes(), checkout_id.as_bytes(), &payload],
    ) {
        return Err(CoreError::Validation(
            "history cursor belongs to a different Checkout".into(),
        ));
    }
    Ok(serde_json::from_slice(&payload)?)
}

fn validate_oid(oid: &str) -> Result<()> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CoreError::Validation(
            "commit OID must be a complete hexadecimal object ID".into(),
        ));
    }
    Ok(())
}

fn ensure_commit(runner: &GitRunner, checkout: &Path, oid: &str) -> Result<()> {
    let output = runner.run_read_only(Some(checkout), ["cat-file", "-t", oid])?;
    if !output.success() || output.stdout_lossy().trim() != "commit" {
        return Err(CoreError::NotFound(format!("commit {oid}")));
    }
    Ok(())
}

fn split_record_nul(raw: &[u8]) -> Vec<&[u8]> {
    let mut records = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index + 2 < raw.len() {
        if raw[index] == 0 && raw[index + 1] == 0 && raw[index + 2] == 0 {
            records.push(&raw[start..index]);
            index += 3;
            start = index;
        } else {
            index += 1;
        }
    }
    if start < raw.len() {
        records.push(&raw[start..]);
    }
    records
}

fn trim_newlines(mut value: &[u8]) -> &[u8] {
    while value
        .first()
        .is_some_and(|byte| *byte == b'\n' || *byte == b'\r')
    {
        value = &value[1..];
    }
    while value
        .last()
        .is_some_and(|byte| *byte == b'\n' || *byte == b'\r')
    {
        value = &value[..value.len() - 1];
    }
    value
}

fn text(value: &[u8]) -> String {
    String::from_utf8_lossy(value).into_owned()
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
