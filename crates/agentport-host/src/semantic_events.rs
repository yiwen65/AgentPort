//! Adapter-owned semantic turn boundaries for agents without per-process hooks.
//!
//! Kimi persists its main-agent wire protocol under `KIMI_CODE_HOME`; Pi PTY
//! sessions persist versioned JSONL inside AgentPort's private Session root.
//! We consume only lifecycle metadata and never copy prompt or response text.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use agentport_core::models::AgentTransport;
use agentport_core::protocol::HostConfig;
use agentport_core::state::Observation;
use serde_json::Value;
use tracing::warn;

use super::{HostMsg, Shared};

const POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_JSONL_RECORD_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECORDS_PER_POLL: usize = 256;

#[derive(Clone)]
struct FileCursor {
    path: PathBuf,
    offset: u64,
}

enum Source {
    Disabled,
    Pi {
        directory: PathBuf,
        offsets: HashMap<PathBuf, u64>,
    },
    Kimi {
        home: PathBuf,
        cwd: String,
        initial_sessions: HashMap<String, FileCursor>,
    },
}

pub(crate) struct Snapshot {
    source: Source,
}

impl Snapshot {
    /// Capture pre-spawn offsets so a resumed Session never replays old turns
    /// as fresh completion notifications.
    pub(crate) fn capture(cfg: &HostConfig) -> Self {
        let source = match (cfg.adapter_type.as_str(), cfg.transport) {
            ("pi", AgentTransport::Pty) => {
                let directory = PathBuf::from(&cfg.session_dir).join("pi");
                let offsets = jsonl_offsets(&directory);
                Source::Pi { directory, offsets }
            }
            ("kimi", AgentTransport::Pty) => match kimi_home(cfg) {
                Some(home) => Source::Kimi {
                    initial_sessions: kimi_sessions(&home, &cfg.cwd),
                    home,
                    cwd: cfg.cwd.clone(),
                },
                None => Source::Disabled,
            },
            _ => Source::Disabled,
        };
        Self { source }
    }
}

pub(crate) fn spawn(snapshot: Snapshot, shared: Arc<Shared>, tx: mpsc::Sender<HostMsg>) {
    match snapshot.source {
        Source::Disabled => {}
        Source::Pi { directory, offsets } => {
            std::thread::spawn(move || follow_pi(directory, offsets, shared, tx));
        }
        Source::Kimi {
            home,
            cwd,
            initial_sessions,
        } => {
            std::thread::spawn(move || follow_kimi(home, cwd, initial_sessions, shared, tx));
        }
    }
}

fn follow_pi(
    directory: PathBuf,
    mut offsets: HashMap<PathBuf, u64>,
    shared: Arc<Shared>,
    tx: mpsc::Sender<HostMsg>,
) {
    while shared.child_alive.load(Ordering::Acquire) {
        let Ok(entries) = fs::read_dir(&directory) else {
            std::thread::sleep(POLL_INTERVAL);
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let offset = offsets.entry(path.clone()).or_insert(0);
            follow_jsonl(&path, offset, |event| {
                if is_pi_turn_end(event) {
                    let _ = tx.send(HostMsg::Obs(Observation::AdapterTurnEnd {
                        adapter: "pi".into(),
                    }));
                }
            });
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn follow_kimi(
    home: PathBuf,
    cwd: String,
    initial_sessions: HashMap<String, FileCursor>,
    shared: Arc<Shared>,
    tx: mpsc::Sender<HostMsg>,
) {
    let mut active_id = None::<String>;
    let mut cursor = None::<FileCursor>;
    while shared.child_alive.load(Ordering::Acquire) {
        let current_id = shared.agent_session_id.lock().unwrap().clone();
        if current_id != active_id {
            cursor = current_id.as_ref().and_then(|id| {
                initial_sessions
                    .get(id)
                    .cloned()
                    .or_else(|| kimi_session(&home, &cwd, id, 0))
            });
            active_id = current_id;
        } else if cursor.is_none() {
            cursor = active_id
                .as_ref()
                .and_then(|id| kimi_session(&home, &cwd, id, 0));
        }

        if let Some(cursor) = &mut cursor {
            follow_jsonl(&cursor.path, &mut cursor.offset, |event| {
                if is_kimi_turn_end(event) {
                    let _ = tx.send(HostMsg::Obs(Observation::AdapterTurnEnd {
                        adapter: "kimi".into(),
                    }));
                }
            });
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn is_pi_turn_end(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("message")
        && event.pointer("/message/role").and_then(Value::as_str) == Some("assistant")
        && event.pointer("/message/stopReason").and_then(Value::as_str) == Some("stop")
}

fn is_kimi_turn_end(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("context.append_loop_event")
        && event.pointer("/event/type").and_then(Value::as_str) == Some("step.end")
        && event.pointer("/event/finishReason").and_then(Value::as_str) == Some("end_turn")
}

fn follow_jsonl(path: &Path, offset: &mut u64, mut on_event: impl FnMut(&Value)) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() < *offset {
        *offset = 0;
    }
    if metadata.len() == *offset {
        return;
    }
    let Ok(mut file) = File::open(path) else {
        return;
    };
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return;
    }
    let mut reader = BufReader::new(file);
    for _ in 0..MAX_RECORDS_PER_POLL {
        let mut line = Vec::new();
        let Ok(read) = reader.read_until(b'\n', &mut line) else {
            return;
        };
        if read == 0 || !line.ends_with(b"\n") {
            return;
        }
        *offset = offset.saturating_add(read as u64);
        if line.len() > MAX_JSONL_RECORD_BYTES {
            warn!(path = %path.display(), bytes = line.len(), "semantic JSONL record exceeds parse limit");
            continue;
        }
        if let Ok(event) = serde_json::from_slice::<Value>(&line) {
            on_event(&event);
        }
    }
}

fn jsonl_offsets(directory: &Path) -> HashMap<PathBuf, u64> {
    let mut offsets = HashMap::new();
    let Ok(entries) = fs::read_dir(directory) else {
        return offsets;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            if let Ok(metadata) = entry.metadata() {
                offsets.insert(path, metadata.len());
            }
        }
    }
    offsets
}

fn kimi_home(cfg: &HostConfig) -> Option<PathBuf> {
    let configured = cfg
        .env
        .iter()
        .rev()
        .find_map(|(name, value)| (name == "KIMI_CODE_HOME").then_some(value.as_str()))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("KIMI_CODE_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".kimi-code")))?;
    Some(if configured.is_absolute() {
        configured
    } else {
        PathBuf::from(&cfg.cwd).join(configured)
    })
}

fn kimi_sessions(home: &Path, cwd: &str) -> HashMap<String, FileCursor> {
    let mut sessions = HashMap::new();
    let index = home.join("session_index.jsonl");
    let Ok(file) = File::open(index) else {
        return sessions;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if entry.get("workDir").and_then(Value::as_str) != Some(cwd) {
            continue;
        }
        let Some(id) = entry.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = validated_kimi_wire_path(home, &entry) else {
            continue;
        };
        let offset = fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        sessions.insert(id.to_string(), FileCursor { path, offset });
    }
    sessions
}

fn kimi_session(home: &Path, cwd: &str, id: &str, offset: u64) -> Option<FileCursor> {
    let index = home.join("session_index.jsonl");
    let file = File::open(index).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if entry.get("sessionId").and_then(Value::as_str) != Some(id)
            || entry.get("workDir").and_then(Value::as_str) != Some(cwd)
        {
            continue;
        }
        let path = validated_kimi_wire_path(home, &entry)?;
        return Some(FileCursor { path, offset });
    }
    None
}

fn validated_kimi_wire_path(home: &Path, entry: &Value) -> Option<PathBuf> {
    let declared = PathBuf::from(entry.get("sessionDir")?.as_str()?);
    let sessions_root = home.join("sessions").canonicalize().ok()?;
    let session_dir = declared.canonicalize().ok()?;
    if !session_dir.starts_with(&sessions_root) {
        return None;
    }
    let wire_path = session_dir
        .join("agents/main/wire.jsonl")
        .canonicalize()
        .ok()?;
    wire_path.starts_with(&sessions_root).then_some(wire_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_final_pi_assistant_messages() {
        let complete = serde_json::json!({
            "type": "message",
            "message": {"role": "assistant", "stopReason": "stop"}
        });
        let tool_use = serde_json::json!({
            "type": "message",
            "message": {"role": "assistant", "stopReason": "toolUse"}
        });
        let user = serde_json::json!({
            "type": "message",
            "message": {"role": "user"}
        });
        assert!(is_pi_turn_end(&complete));
        assert!(!is_pi_turn_end(&tool_use));
        assert!(!is_pi_turn_end(&user));
    }

    #[test]
    fn recognizes_only_kimi_end_turn_steps() {
        let complete = serde_json::json!({
            "type": "context.append_loop_event",
            "event": {"type": "step.end", "finishReason": "end_turn"}
        });
        let tool_call = serde_json::json!({
            "type": "context.append_loop_event",
            "event": {"type": "step.end", "finishReason": "tool_calls"}
        });
        assert!(is_kimi_turn_end(&complete));
        assert!(!is_kimi_turn_end(&tool_call));
    }

    #[test]
    fn follower_starts_at_snapshot_and_waits_for_complete_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        fs::write(&path, b"{\"type\":\"old\"}\n").unwrap();
        let mut offset = fs::metadata(&path).unwrap().len();
        let mut seen = Vec::new();
        follow_jsonl(&path, &mut offset, |event| seen.push(event.clone()));
        assert!(seen.is_empty());

        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"type\":\"partial\"}").unwrap();
        file.flush().unwrap();
        follow_jsonl(&path, &mut offset, |event| seen.push(event.clone()));
        assert!(seen.is_empty());
        file.write_all(b"\n").unwrap();
        file.flush().unwrap();
        follow_jsonl(&path, &mut offset, |event| seen.push(event.clone()));
        assert_eq!(seen[0]["type"], "partial");
    }

    #[test]
    fn kimi_index_cannot_redirect_wire_reads_outside_kimi_home() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("kimi-home");
        fs::create_dir_all(home.join("sessions")).unwrap();
        let outside = dir.path().join("outside-session");
        fs::create_dir_all(outside.join("agents/main")).unwrap();
        fs::write(outside.join("agents/main/wire.jsonl"), b"{}\n").unwrap();
        let entry = serde_json::json!({"sessionDir": outside});

        assert!(validated_kimi_wire_path(&home, &entry).is_none());
    }
}
