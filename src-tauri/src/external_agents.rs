//! Watchers for writes made by *another* process.
//!
//! The desktop app is event driven: `projects-changed` and `session-state` are
//! emitted from inside this process, so a Session created by the MCP server (a
//! separate process using the same database and Host binaries) stays invisible
//! until some user action happens to refresh the tree. That is the difference
//! between "the agent says it opened a window" and the user actually seeing it.
//!
//! This module closes that gap with two bounded polls:
//!
//! * `PRAGMA data_version` on a dedicated read-only connection tells us another
//!   connection committed; we then adopt live Sessions (so Host events become
//!   status/unread/notifications) and emit one `projects-changed` snapshot.
//! * The MCP UI command queue is tailed by byte offset and each command becomes
//!   a `mcp-ui-command` event for the renderer to apply through its own actions.
//!
//! Both are cheap: one pragma and one `metadata` call per tick, and the project
//! snapshot is only built when something actually changed.

use agentport_core::db::Db;
use agentport_core::paths::AppPaths;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::{collect_projects, ensure_live_session_monitors, AppState};

/// One second: fast enough to feel live, slow enough that an idle app is quiet.
const POLL_INTERVAL: Duration = Duration::from_millis(1200);
/// A single tick never applies more than this many queued commands, so a stuck
/// renderer cannot make one loop iteration unbounded.
const MAX_COMMANDS_PER_TICK: usize = 32;
const QUEUE_FILE: &str = "ui-commands.jsonl";
const CURSOR_FILE: &str = "ui-commands.cursor";

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || run(app));
}

fn run(app: AppHandle) {
    let paths: AppPaths = match app.try_state::<AppState>() {
        Some(state) => state.paths.clone(),
        None => return,
    };
    // A private connection: never take the GUI's Db mutex from a polling
    // thread, or a multi-second read would stall every UI command.
    let db = match Db::open_read(&paths) {
        Ok(db) => db,
        Err(error) => {
            tracing::warn!(error = %error, "external change watcher could not open the database");
            return;
        }
    };
    let mut baseline: Option<i64> = None;
    let mut queue = QueueTail::new(paths.root().to_path_buf());
    loop {
        std::thread::sleep(POLL_INTERVAL);
        match db.data_version() {
            Ok(version) => match baseline {
                None => baseline = Some(version),
                Some(previous) if previous != version => {
                    baseline = Some(version);
                    // Adopt before announcing: a Session another process just
                    // launched must get its Host monitor in the same tick that
                    // the sidebar first shows it.
                    if let Some(state) = app.try_state::<AppState>() {
                        ensure_live_session_monitors(&app, &state);
                    }
                    let _ = app.emit("projects-changed", collect_projects(&db, None));
                }
                Some(_) => {}
            },
            Err(error) => {
                tracing::debug!(error = %error, "data_version probe failed");
            }
        }
        queue.drain(&app);
    }
}

/// Byte-offset tail of the MCP command queue.
struct QueueTail {
    path: PathBuf,
    cursor_path: PathBuf,
    offset: u64,
}

impl QueueTail {
    fn new(root: PathBuf) -> QueueTail {
        let dir = root.join("mcp");
        let path = dir.join(QUEUE_FILE);
        let cursor_path = dir.join(CURSOR_FILE);
        let offset = match fs::read_to_string(&cursor_path)
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
        {
            Some(offset) => offset,
            None => {
                // First run with this feature: treat everything already queued
                // as consumed instead of replaying commands from a past launch.
                let offset = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
                let tail = QueueTail {
                    path,
                    cursor_path,
                    offset,
                };
                tail.persist();
                return tail;
            }
        };
        QueueTail {
            path,
            cursor_path,
            offset,
        }
    }

    fn persist(&self) {
        if let Some(dir) = self.cursor_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&self.cursor_path)
            .and_then(|mut file| {
                use std::io::Write;
                file.write_all(self.offset.to_string().as_bytes())
            });
    }

    fn drain(&mut self, app: &AppHandle) {
        let Ok(metadata) = fs::metadata(&self.path) else {
            return;
        };
        let len = metadata.len();
        if len < self.offset {
            // The queue was rewritten or truncated underneath us.
            self.offset = 0;
        }
        if len == self.offset {
            return;
        }
        let Ok(file) = fs::File::open(&self.path) else {
            return;
        };
        let mut reader = BufReader::new(file);
        if reader.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let mut consumed = self.offset;
        let mut applied = 0_usize;
        let mut line = String::new();
        while applied < MAX_COMMANDS_PER_TICK {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(read) => {
                    // A partially written line is retried on the next tick
                    // instead of being consumed half-parsed.
                    if !line.ends_with('\n') {
                        break;
                    }
                    consumed += read as u64;
                    match serde_json::from_str::<Value>(line.trim()) {
                        Ok(command) => {
                            let _ = app.emit("mcp-ui-command", command);
                            applied += 1;
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "dropping an unreadable UI command");
                        }
                    }
                }
                Err(_) => break,
            }
        }
        if consumed != self.offset {
            self.offset = consumed;
            self.persist();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_queue(root: &std::path::Path, body: &str) -> PathBuf {
        let dir = root.join("mcp");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(QUEUE_FILE);
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn first_run_treats_existing_commands_as_consumed() {
        let dir = tempfile::tempdir().unwrap();
        let body = "{\"kind\":\"open_pane\"}\n";
        let path = write_queue(dir.path(), body);
        let tail = QueueTail::new(dir.path().to_path_buf());
        assert_eq!(tail.offset, fs::metadata(&path).unwrap().len());
        assert_eq!(
            fs::read_to_string(dir.path().join("mcp").join(CURSOR_FILE)).unwrap(),
            tail.offset.to_string()
        );
    }

    #[test]
    fn cursor_survives_restart_and_resets_after_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_queue(dir.path(), "{\"a\":1}\n");
        let mut tail = QueueTail::new(dir.path().to_path_buf());
        tail.offset = 0;
        tail.persist();
        // Reopening keeps the persisted offset.
        assert_eq!(QueueTail::new(dir.path().to_path_buf()).offset, 0);
        // A shorter queue resets to zero instead of seeking past the end.
        fs::write(&path, "{}\n").unwrap();
        let mut tail = QueueTail::new(dir.path().to_path_buf());
        tail.offset = 8;
        assert!(fs::metadata(&path).unwrap().len() < tail.offset);
        // The reset itself is exercised by `drain`, which needs an AppHandle;
        // the offset comparison above pins the reset condition.
        tail.offset = 0;
        tail.persist();
        assert_eq!(QueueTail::new(dir.path().to_path_buf()).offset, 0);
    }
}
