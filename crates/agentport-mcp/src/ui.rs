//! GUI command queue for view-level operations.
//!
//! Split/pane layout is owned by the renderer (localStorage), not by the
//! backend. The MCP therefore never tries to write a layout: it appends an
//! intent that the desktop app consumes and applies through its own actions.
//! Losing a command is harmless (the user still has the Session in the
//! sidebar), so this is a plain append-only log rather than a transaction.

use serde::Serialize;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use crate::registry::MCP_DIR;

const QUEUE_FILE: &str = "ui-commands.jsonl";
/// Once the queue grows past this the desktop app is clearly not consuming it
/// (closed, or an older build); stop growing instead of filling the disk.
const MAX_QUEUE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCommand<'a> {
    pub id: String,
    pub kind: &'a str,
    pub session_id: &'a str,
    /// `right` or `down`; only for `split_pane`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<&'a str>,
    /// Split beside this Session instead of the focused pane.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_session_id: Option<&'a str>,
    pub focus: bool,
    pub created_at: String,
    pub source: &'a str,
}

/// One pane intent. The renderer decides what it can honour (it owns the
/// layout); the backend only states what was asked.
#[derive(Debug, Clone)]
pub struct PaneIntent<'a> {
    pub kind: &'a str,
    pub session_id: &'a str,
    pub direction: Option<&'a str>,
    pub target_session_id: Option<&'a str>,
    pub focus: bool,
}

impl<'a> PaneIntent<'a> {
    pub fn open(session_id: &'a str, focus: bool) -> PaneIntent<'a> {
        PaneIntent {
            kind: "open_pane",
            session_id,
            direction: None,
            target_session_id: None,
            focus,
        }
    }
}

pub fn queue_path(root: &Path) -> PathBuf {
    root.join(MCP_DIR).join(QUEUE_FILE)
}

/// Append one command. Returns the command id so a caller can correlate it.
pub fn enqueue(root: &Path, intent: PaneIntent<'_>, now: &str) -> io::Result<String> {
    let path = queue_path(root);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_QUEUE_BYTES {
        // Rotate rather than fail forever: the desktop app resets its byte
        // cursor when the file shrinks, so this drops only stale intents.
        let _ = fs::rename(&path, path.with_extension("jsonl.old"));
    }
    let id = format!(
        "mcpcmd-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros())
            .unwrap_or_default()
    );
    let command = UiCommand {
        id: id.clone(),
        kind: intent.kind,
        session_id: intent.session_id,
        direction: intent.direction,
        target_session_id: intent.target_session_id,
        focus: intent.focus,
        created_at: now.to_string(),
        source: "mcp",
    };
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    serde_json::to_writer(&mut file, &command)?;
    file.write_all(b"\n")?;
    file.flush()?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_append_as_json_lines() {
        let dir = tempfile::tempdir().unwrap();
        enqueue(dir.path(), PaneIntent::open("ses_1", true), "2026-11-20T00:00:00Z").unwrap();
        enqueue(dir.path(), PaneIntent::open("ses_2", false), "2026-11-20T00:00:01Z").unwrap();
        let body = fs::read_to_string(queue_path(dir.path())).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["kind"], "open_pane");
        assert_eq!(first["sessionId"], "ses_1");
        assert_eq!(first["focus"], true);
        assert_eq!(first["source"], "mcp");
        // Pane-specific fields stay out of an open_pane line.
        assert!(first.get("direction").is_none());
        assert!(first.get("targetSessionId").is_none());
    }

    #[test]
    fn split_intents_carry_direction_and_target() {
        let dir = tempfile::tempdir().unwrap();
        enqueue(
            dir.path(),
            PaneIntent {
                kind: "split_pane",
                session_id: "ses_new",
                direction: Some("down"),
                target_session_id: Some("ses_anchor"),
                focus: false,
            },
            "2026-11-20T00:00:02Z",
        )
        .unwrap();
        let body = fs::read_to_string(queue_path(dir.path())).unwrap();
        let command: serde_json::Value = serde_json::from_str(body.lines().next().unwrap()).unwrap();
        assert_eq!(command["kind"], "split_pane");
        assert_eq!(command["direction"], "down");
        assert_eq!(command["targetSessionId"], "ses_anchor");
        assert_eq!(command["focus"], false);
    }
}
