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
    pub focus: bool,
    pub created_at: String,
    pub source: &'a str,
}

pub fn queue_path(root: &Path) -> PathBuf {
    root.join(MCP_DIR).join(QUEUE_FILE)
}

/// Append one command. Returns the command id so a caller can correlate it.
pub fn enqueue(
    root: &Path,
    kind: &str,
    session_id: &str,
    focus: bool,
    now: &str,
) -> io::Result<String> {
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
        kind,
        session_id,
        focus,
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
        enqueue(dir.path(), "open_pane", "ses_1", true, "2026-11-20T00:00:00Z").unwrap();
        enqueue(dir.path(), "open_pane", "ses_2", false, "2026-11-20T00:00:01Z").unwrap();
        let body = fs::read_to_string(queue_path(dir.path())).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["kind"], "open_pane");
        assert_eq!(first["sessionId"], "ses_1");
        assert_eq!(first["focus"], true);
        assert_eq!(first["source"], "mcp");
    }
}
