//! Inventory and explicitly confirmed deletion of pre-native-history
//! `output.log` files. Paths are derived from `AppPaths` and Session IDs;
//! caller-provided filesystem paths are never accepted.

use crate::error::{CoreError, Result};
use crate::history::{HistorySourceStatus, NativeHistory};
use crate::models::{Lifecycle, Session};
use crate::paths::AppPaths;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLogEntry {
    pub id: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub path: String,
    pub bytes: u64,
    pub active: bool,
    pub native_status: HistorySourceStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLogInventory {
    pub entries: Vec<LegacyLogEntry>,
    pub total_bytes: u64,
    pub deletable_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDeleteReport {
    pub deleted: Vec<String>,
    pub bytes_reclaimed: u64,
}

pub fn inventory(paths: &AppPaths, sessions: &[Session]) -> Result<LegacyLogInventory> {
    let root = paths.sessions_dir();
    let canonical_root = match root.canonicalize() {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LegacyLogInventory {
                entries: Vec::new(),
                total_bytes: 0,
                deletable_bytes: 0,
            })
        }
        Err(error) => return Err(error.into()),
    };
    let history = NativeHistory::new(paths);
    let mut entries = Vec::new();
    for session in sessions {
        let active = matches!(session.lifecycle, Lifecycle::Creating | Lifecycle::Running);
        let session_dir = paths.session_dir(&session.id);
        let mut candidates = Vec::new();
        let session_log = session_dir.join("output.log");
        if regular_file_without_symlink(&session_log) {
            candidates.push((None, session_log));
        }
        let runs = session_dir.join("runs");
        if let Ok(run_entries) = fs::read_dir(runs) {
            let mut run_entries = run_entries.flatten().collect::<Vec<_>>();
            run_entries.sort_by_key(|entry| entry.file_name());
            for run in run_entries {
                let Ok(file_type) = run.file_type() else {
                    continue;
                };
                if !file_type.is_dir() || file_type.is_symlink() {
                    continue;
                }
                let run_id = run.file_name().to_string_lossy().into_owned();
                let path = run.path().join("output.log");
                if regular_file_without_symlink(&path) {
                    candidates.push((Some(run_id), path));
                }
            }
        }
        if candidates.is_empty() {
            continue;
        }
        let native_status = history.source_status(session);
        for (run_id, path) in candidates {
            push_entry(
                &mut entries,
                &canonical_root,
                session,
                run_id,
                path,
                active,
                &native_status,
            );
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let total_bytes = entries.iter().map(|entry| entry.bytes).sum();
    let deletable_bytes = entries
        .iter()
        .filter(|entry| !entry.active)
        .map(|entry| entry.bytes)
        .sum();
    Ok(LegacyLogInventory {
        entries,
        total_bytes,
        deletable_bytes,
    })
}

fn regular_file_without_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn push_entry(
    entries: &mut Vec<LegacyLogEntry>,
    canonical_root: &Path,
    session: &Session,
    run_id: Option<String>,
    path: PathBuf,
    active: bool,
    native_status: &HistorySourceStatus,
) {
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return;
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return;
    }
    let Ok(canonical) = path.canonicalize() else {
        return;
    };
    if !canonical.starts_with(canonical_root) {
        return;
    }
    let Ok(relative) = canonical.strip_prefix(canonical_root) else {
        return;
    };
    let mut hasher = Sha256::new();
    hasher.update(relative.to_string_lossy().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    entries.push(LegacyLogEntry {
        id: digest[..24].to_string(),
        session_id: session.id.clone(),
        run_id,
        path: canonical.to_string_lossy().into_owned(),
        bytes: metadata.len(),
        active,
        native_status: native_status.clone(),
    });
}

pub fn delete_selected(
    paths: &AppPaths,
    sessions: &[Session],
    entry_ids: &[String],
    confirmed: bool,
) -> Result<LegacyDeleteReport> {
    if !confirmed {
        return Err(CoreError::Validation(
            "legacy log deletion requires explicit confirmation".into(),
        ));
    }
    let requested = entry_ids.iter().cloned().collect::<HashSet<_>>();
    if requested.len() != entry_ids.len() {
        return Err(CoreError::Validation(
            "legacy log selection contains duplicate ids".into(),
        ));
    }
    let inventory = inventory(paths, sessions)?;
    let selected = inventory
        .entries
        .iter()
        .filter(|entry| requested.contains(&entry.id))
        .collect::<Vec<_>>();
    if selected.len() != requested.len() {
        return Err(CoreError::Conflict(
            "legacy log inventory changed; refresh before deleting".into(),
        ));
    }
    if selected.iter().any(|entry| entry.active) {
        return Err(CoreError::Blocked(
            "an active legacy Host may still append to the selected log".into(),
        ));
    }
    let mut deleted = Vec::with_capacity(selected.len());
    let mut bytes_reclaimed = 0u64;
    for entry in selected {
        fs::remove_file(&entry.path)?;
        deleted.push(entry.id.clone());
        bytes_reclaimed = bytes_reclaimed.saturating_add(entry.bytes);
    }
    Ok(LegacyDeleteReport {
        deleted,
        bytes_reclaimed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentTransport, AgentType, PermissionMode, ResumePrecision};
    use chrono::Utc;
    use tempfile::TempDir;

    fn session(_paths: &AppPaths, lifecycle: Lifecycle) -> Session {
        Session {
            id: "ses_legacy".into(),
            project_id: "prj".into(),
            worktree_id: None,
            preset_id: "pre".into(),
            title: "legacy".into(),
            cwd: "/tmp/work".into(),
            host_pid: None,
            host_socket: None,
            host_token: "token".into(),
            lifecycle,
            agent_session_id: None,
            resume_precision: ResumePrecision::Unavailable,
            adapter_type: AgentType::Shell,
            transport: AgentTransport::Pty,
            command: vec![],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            pinned_at: None,
            archived_at: None,
        }
    }

    #[test]
    fn inventory_and_delete_require_exact_confirmed_non_active_ids() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let run = paths.session_dir("ses_legacy").join("runs/run-1");
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("output.log"), b"legacy bytes").unwrap();
        let ended = session(&paths, Lifecycle::Exited);
        let inventory = inventory(&paths, std::slice::from_ref(&ended)).unwrap();
        assert_eq!(inventory.entries.len(), 1);
        assert_eq!(inventory.total_bytes, 12);
        assert!(delete_selected(
            &paths,
            std::slice::from_ref(&ended),
            &[inventory.entries[0].id.clone()],
            false,
        )
        .is_err());
        let report = delete_selected(
            &paths,
            std::slice::from_ref(&ended),
            &[inventory.entries[0].id.clone()],
            true,
        )
        .unwrap();
        assert_eq!(report.bytes_reclaimed, 12);
        assert!(!run.join("output.log").exists());
    }

    #[test]
    fn active_and_symlink_logs_are_never_deleted() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let run = paths.session_dir("ses_legacy").join("runs/run-1");
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("output.log"), b"active").unwrap();
        let active = session(&paths, Lifecycle::Running);
        let active_inventory = inventory(&paths, std::slice::from_ref(&active)).unwrap();
        assert!(active_inventory.entries[0].active);
        assert!(delete_selected(
            &paths,
            std::slice::from_ref(&active),
            &[active_inventory.entries[0].id.clone()],
            true,
        )
        .is_err());

        fs::remove_file(run.join("output.log")).unwrap();
        let outside = temp.path().join("outside.log");
        fs::write(&outside, b"outside").unwrap();
        std::os::unix::fs::symlink(&outside, run.join("output.log")).unwrap();
        assert!(inventory(&paths, &[session(&paths, Lifecycle::Exited)])
            .unwrap()
            .entries
            .is_empty());
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
    }
}
