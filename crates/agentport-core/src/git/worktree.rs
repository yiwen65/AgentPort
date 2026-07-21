//! Worktree creation/removal details — see mod.rs for the contract.
//! Parsers for `git status --porcelain=v1` and `git worktree list --porcelain`
//! live here so mod.rs stays focused on the command/rollback flows.

use super::{DirtySummary, GitWorktreeInfo, StatusEntry};
use std::path::PathBuf;

/// Parse `git status --porcelain=v1` output into a DirtySummary.
/// `??` lines count as untracked; for tracked entries the X column counts as
/// staged and the Y column as modified (a line can be both, e.g. `MM`).
pub(super) fn parse_porcelain_status(raw: &str) -> DirtySummary {
    let mut summary = DirtySummary {
        raw: raw.to_string(),
        ..Default::default()
    };
    for line in raw.lines() {
        // Porcelain lines are always `XY <path>`; the first 3 bytes are ASCII.
        if line.len() < 3 {
            continue;
        }
        let entry = StatusEntry {
            xy: line[..2].to_string(),
            path: line.get(3..).unwrap_or("").to_string(),
            untracked: line.starts_with("??"),
        };
        if entry.untracked {
            summary.untracked += 1;
            continue;
        }
        let mut cols = entry.xy.chars();
        if cols.next().unwrap_or(' ') != ' ' {
            summary.staged += 1;
        }
        if cols.next().unwrap_or(' ') != ' ' {
            summary.modified += 1;
        }
    }
    summary
}

/// Parse `git worktree list --porcelain` output. Blocks start with a
/// `worktree <path>` line, then carry `HEAD`, `branch`, `detached`, `locked`
/// and `prunable` records. A detached worktree simply has no `branch`.
pub(super) fn parse_worktree_list(raw: &str) -> Vec<GitWorktreeInfo> {
    let mut out = Vec::new();
    let mut cur: Option<GitWorktreeInfo> = None;
    for line in raw.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(info) = cur.take() {
                out.push(info);
            }
            cur = Some(GitWorktreeInfo {
                path: PathBuf::from(p),
                head: None,
                branch: None,
                locked: false,
                prunable: false,
            });
        } else if let Some(info) = cur.as_mut() {
            if let Some(h) = line.strip_prefix("HEAD ") {
                info.head = Some(h.to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                info.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            } else if line.starts_with("locked") {
                info.locked = true;
            } else if line.starts_with("prunable") {
                info.prunable = true;
            }
            // `detached` needs no handling: branch stays None.
        }
    }
    if let Some(info) = cur.take() {
        out.push(info);
    }
    out
}
