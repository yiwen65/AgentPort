//! Adapter-owned semantic turn boundaries for agents without per-process hooks.
//!
//! Kimi persists its main-agent wire protocol under `KIMI_CODE_HOME`; Pi PTY
//! sessions persist versioned JSONL inside AgentPort's private Session root.
//! We consume only lifecycle metadata and never copy prompt or response text.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};
use std::time::{Duration, SystemTime};

use agentport_core::models::AgentTransport;
use agentport_core::protocol::HostConfig;
use serde_json::Value;
use tracing::warn;

use super::{HostMsg, Shared};

const POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_JSONL_RECORD_BYTES: usize = 4 * 1024 * 1024;
const MAX_SNAPSHOT_TAIL_BYTES: usize = MAX_JSONL_RECORD_BYTES + 64 * 1024;
const MAX_RECORDS_PER_POLL: usize = 256;
const MAX_BYTES_PER_POLL: usize = MAX_JSONL_RECORD_BYTES + 1;

#[derive(Clone, Default)]
struct JsonlCursor {
    offset: u64,
    draining_oversized: bool,
}

#[derive(Clone)]
struct FileCursor {
    path: PathBuf,
    cursor: JsonlCursor,
}

enum Source {
    Disabled,
    Pi {
        directory: PathBuf,
        offsets: HashMap<PathBuf, JsonlCursor>,
    },
    Kimi {
        home: PathBuf,
        cwd: String,
        initial_sessions: HashMap<String, FileCursor>,
    },
}

pub(crate) struct Snapshot {
    source: Source,
    inherited_turn_complete: bool,
}

impl Snapshot {
    /// Capture pre-spawn offsets so a resumed Session never replays old turns
    /// as fresh completion notifications. A completed turn belonging to the
    /// exact resumed Pi transcript is retained only as an idle-timer hint; it
    /// is not replayed as a new status event.
    pub(crate) fn capture(cfg: &HostConfig) -> Self {
        let mut inherited_turn_complete = false;
        let source = match (cfg.adapter_type.as_str(), cfg.transport) {
            ("pi" | "easy_pi" | "omp", transport) => {
                let directory = pi_session_dir(cfg)
                    .unwrap_or_else(|| PathBuf::from(&cfg.session_dir).join(&cfg.adapter_type));
                let offsets = jsonl_offsets(&directory);
                inherited_turn_complete = cfg
                    .agent_session_id_hint
                    .as_deref()
                    .is_some_and(|id| pi_transcript_has_completed_turn(&directory, id));
                if transport == AgentTransport::Pty {
                    Source::Pi { directory, offsets }
                } else {
                    Source::Disabled
                }
            }
            ("codex", AgentTransport::Pty) => {
                inherited_turn_complete = cfg.agent_session_id_hint.as_deref().is_some_and(|id| {
                    codex_home(cfg).is_some_and(|home| {
                        codex_transcript_has_completed_turn(&home.join("sessions"), id, &cfg.cwd)
                    })
                });
                Source::Disabled
            }
            ("kimi", AgentTransport::Pty) => match kimi_home(cfg) {
                Some(home) => {
                    let initial_sessions = kimi_sessions(&home, &cfg.cwd);
                    inherited_turn_complete = cfg
                        .agent_session_id_hint
                        .as_deref()
                        .and_then(|id| initial_sessions.get(id))
                        .is_some_and(|cursor| latest_kimi_wire_event_is_turn_end(&cursor.path));
                    Source::Kimi {
                        initial_sessions,
                        home,
                        cwd: cfg.cwd.clone(),
                    }
                }
                None => Source::Disabled,
            },
            _ => Source::Disabled,
        };
        Self {
            source,
            inherited_turn_complete,
        }
    }

    pub(crate) fn inherited_turn_complete(&self) -> bool {
        self.inherited_turn_complete
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

fn pi_session_dir(cfg: &HostConfig) -> Option<PathBuf> {
    cfg.command
        .windows(2)
        .find_map(|pair| (pair[0] == "--session-dir").then(|| PathBuf::from(&pair[1])))
}

fn follow_pi(
    directory: PathBuf,
    mut offsets: HashMap<PathBuf, JsonlCursor>,
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
            let cursor = offsets.entry(path.clone()).or_default();
            follow_jsonl(&path, cursor, |event, completion_input_boundary| {
                if is_pi_turn_end(event) {
                    let _ = tx.send(HostMsg::SemanticCompletion {
                        adapter: shared.cfg.adapter_type.clone(),
                        completion_input_boundary,
                    });
                } else if is_pi_turn_start(event) {
                    let _ = tx.send(HostMsg::SemanticActivity {
                        adapter: shared.cfg.adapter_type.clone(),
                    });
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
            follow_jsonl(
                &cursor.path,
                &mut cursor.cursor,
                |event, completion_input_boundary| {
                    if is_kimi_turn_end(event) {
                        let _ = tx.send(HostMsg::SemanticCompletion {
                            adapter: "kimi".into(),
                            completion_input_boundary,
                        });
                    } else if is_kimi_turn_start(event) {
                        let _ = tx.send(HostMsg::SemanticActivity {
                            adapter: "kimi".into(),
                        });
                    }
                },
            );
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn is_pi_turn_start(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("message")
        && event.pointer("/message/role").and_then(Value::as_str) == Some("user")
}

fn is_pi_turn_end(event: &Value) -> bool {
    // error/aborted are not terminal failures here: the Pi-family runtime may
    // retry an assistant error. Without an authoritative retry-exhausted event,
    // failure coverage remains process-only, never a premature failure notice.
    event.get("type").and_then(Value::as_str) == Some("message")
        && event.pointer("/message/role").and_then(Value::as_str) == Some("assistant")
        && event.pointer("/message/stopReason").and_then(Value::as_str) == Some("stop")
}

fn is_kimi_turn_start(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("context.append_loop_event")
        && event.pointer("/event/type").and_then(Value::as_str) == Some("step.begin")
}

fn is_kimi_turn_end(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("context.append_loop_event")
        && event.pointer("/event/type").and_then(Value::as_str) == Some("step.end")
        && event.pointer("/event/finishReason").and_then(Value::as_str) == Some("end_turn")
}

struct BoundedRecordRead {
    consumed: usize,
    complete: bool,
    oversized: bool,
}

fn read_bounded_jsonl_record<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    already_oversized: bool,
    byte_budget: usize,
) -> std::io::Result<Option<BoundedRecordRead>> {
    line.clear();
    let mut consumed = 0usize;
    let mut oversized = already_oversized;
    while consumed < byte_budget {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            break;
        }
        let remaining_budget = byte_budget - consumed;
        let available = &available[..available.len().min(remaining_budget)];
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if !oversized {
            let remaining = MAX_JSONL_RECORD_BYTES.saturating_sub(line.len());
            let retained = take.min(remaining);
            line.extend_from_slice(&available[..retained]);
            oversized = retained < take;
        }
        let complete = available[..take].last() == Some(&b'\n');
        reader.consume(take);
        consumed = consumed.saturating_add(take);
        if complete {
            return Ok(Some(BoundedRecordRead {
                consumed,
                complete: true,
                oversized,
            }));
        }
    }
    Ok((consumed > 0).then_some(BoundedRecordRead {
        consumed,
        complete: false,
        oversized,
    }))
}

fn follow_jsonl(
    path: &Path,
    cursor: &mut JsonlCursor,
    mut on_event: impl FnMut(&Value, Option<SystemTime>),
) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() < cursor.offset {
        *cursor = JsonlCursor::default();
    }
    if metadata.len() == cursor.offset {
        return;
    }
    let Ok(mut file) = File::open(path) else {
        return;
    };
    if file.seek(SeekFrom::Start(cursor.offset)).is_err() {
        return;
    }
    let observed_at = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    // Freeze this poll at the metadata boundary so a later append cannot make
    // an older completion look newer than intervening user input.
    let mut reader = BufReader::new(file).take(metadata.len() - cursor.offset);
    let mut line = Vec::new();
    let mut remaining_budget = MAX_BYTES_PER_POLL;
    for _ in 0..MAX_RECORDS_PER_POLL {
        if remaining_budget == 0 {
            return;
        }
        let Ok(record) = read_bounded_jsonl_record(
            &mut reader,
            &mut line,
            cursor.draining_oversized,
            remaining_budget,
        ) else {
            return;
        };
        let Some(record) = record else {
            return;
        };
        remaining_budget = remaining_budget.saturating_sub(record.consumed);
        if !record.complete {
            if record.oversized {
                cursor.offset = cursor.offset.saturating_add(record.consumed as u64);
                cursor.draining_oversized = true;
            }
            return;
        }

        cursor.offset = cursor.offset.saturating_add(record.consumed as u64);
        cursor.draining_oversized = false;
        if record.oversized {
            warn!(path = %path.display(), bytes = record.consumed, "semantic JSONL record exceeds parse limit");
            continue;
        }
        if let Ok(event) = serde_json::from_slice::<Value>(&line) {
            let completion_input_boundary =
                (cursor.offset == metadata.len()).then_some(observed_at);
            on_event(&event, completion_input_boundary);
        }
    }
}

/// Return true only when the exact resumed Pi transcript's latest message is
/// an authoritative completed assistant turn. Reads are bounded to the header
/// and a tail window so a large transcript cannot delay Host startup.
fn pi_transcript_has_completed_turn(directory: &Path, session_id: &str) -> bool {
    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };
    let mut matches = entries.flatten().filter_map(|entry| {
        let path = entry.path();
        (path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            && pi_transcript_session_id(&path).as_deref() == Some(session_id))
        .then_some(path)
    });
    let Some(path) = matches.next() else {
        return false;
    };
    matches.next().is_none() && latest_pi_message_is_turn_end(&path)
}

fn pi_transcript_session_id(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut bounded = reader.take((MAX_JSONL_RECORD_BYTES + 1) as u64);
    let mut line = Vec::new();
    let read = bounded.read_until(b'\n', &mut line).ok()?;
    if read == 0 || !line.ends_with(b"\n") || line.len() > MAX_JSONL_RECORD_BYTES {
        return None;
    }
    let event = serde_json::from_slice::<Value>(&line).ok()?;
    (event.get("type").and_then(Value::as_str) == Some("session"))
        .then(|| event.get("id").and_then(Value::as_str).map(str::to_owned))
        .flatten()
}

fn latest_pi_message_is_turn_end(path: &Path) -> bool {
    latest_bounded_event(path, |event| {
        event.get("type").and_then(Value::as_str) == Some("message")
    })
    .is_some_and(|event| is_pi_turn_end(&event))
}

fn latest_kimi_wire_event_is_turn_end(path: &Path) -> bool {
    latest_bounded_event(path, |event| {
        event.get("type").and_then(Value::as_str) == Some("context.append_loop_event")
    })
    .is_some_and(|event| is_kimi_turn_end(&event))
}

fn latest_bounded_event(path: &Path, mut relevant: impl FnMut(&Value) -> bool) -> Option<Value> {
    let Ok(mut file) = File::open(path) else {
        return None;
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return None;
    };
    let start = length.saturating_sub(MAX_SNAPSHOT_TAIL_BYTES as u64);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return None;
    }
    let mut tail = Vec::with_capacity((length - start) as usize);
    if file.read_to_end(&mut tail).is_err() {
        return None;
    }
    if start > 0 {
        let first_newline = tail.iter().position(|byte| *byte == b'\n')?;
        tail.drain(..=first_newline);
    }
    // Any partial or malformed newer record makes inherited state uncertain.
    if !tail.ends_with(b"\n") {
        return None;
    }
    for line in tail.split(|byte| *byte == b'\n').rev() {
        if line.is_empty() {
            continue;
        }
        if line.len() > MAX_JSONL_RECORD_BYTES {
            return None;
        }
        let event = serde_json::from_slice::<Value>(line).ok()?;
        if relevant(&event) {
            return Some(event);
        }
    }
    None
}

fn codex_home(cfg: &HostConfig) -> Option<PathBuf> {
    cfg.env
        .iter()
        .rev()
        .find_map(|(name, value)| (name == "CODEX_HOME").then_some(PathBuf::from(value)))
        .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
}

fn codex_transcript_has_completed_turn(root: &Path, id: &str, cwd: &str) -> bool {
    let mut candidates = Vec::new();
    let mut visited = 0;
    collect_codex_candidates(root, id, 6, &mut visited, &mut candidates);
    let matches = candidates
        .into_iter()
        .filter(|path| codex_transcript_matches(path, id, cwd))
        .collect::<Vec<_>>();
    matches.len() == 1 && latest_codex_event_is_turn_complete(&matches[0])
}

fn collect_codex_candidates(
    root: &Path,
    id: &str,
    depth: usize,
    visited: &mut usize,
    output: &mut Vec<PathBuf>,
) {
    const MAX_VISITED: usize = 20_000;
    if depth == 0 || *visited >= MAX_VISITED {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if *visited >= MAX_VISITED {
            return;
        }
        *visited += 1;
        let path = entry.path();
        if path.is_dir() {
            collect_codex_candidates(&path, id, depth - 1, visited, output);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.contains(id))
        {
            output.push(path);
        }
    }
}

fn codex_transcript_matches(path: &Path, id: &str, cwd: &str) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut reader = BufReader::new(file);
    for _ in 0..32 {
        let mut line = Vec::new();
        let Ok(read) = reader
            .by_ref()
            .take((MAX_JSONL_RECORD_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
        else {
            return false;
        };
        if read == 0 || !line.ends_with(b"\n") || line.len() > MAX_JSONL_RECORD_BYTES {
            return false;
        }
        let Ok(event) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) == Some("session_meta") {
            return event.pointer("/payload/id").and_then(Value::as_str) == Some(id)
                && event
                    .pointer("/payload/cwd")
                    .and_then(Value::as_str)
                    .is_none_or(|recorded| recorded == cwd);
        }
    }
    false
}

fn latest_codex_event_is_turn_complete(path: &Path) -> bool {
    latest_bounded_event(path, |event| {
        event.get("type").and_then(Value::as_str) == Some("event_msg")
            && matches!(
                event.pointer("/payload/type").and_then(Value::as_str),
                Some("task_started" | "task_complete" | "turn_aborted")
            )
    })
    .is_some_and(|event| {
        event.pointer("/payload/type").and_then(Value::as_str) == Some("task_complete")
    })
}

fn jsonl_offsets(directory: &Path) -> HashMap<PathBuf, JsonlCursor> {
    let mut offsets = HashMap::new();
    let Ok(entries) = fs::read_dir(directory) else {
        return offsets;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            if let Ok(metadata) = entry.metadata() {
                offsets.insert(
                    path,
                    JsonlCursor {
                        offset: metadata.len(),
                        draining_oversized: false,
                    },
                );
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
        sessions.insert(
            id.to_string(),
            FileCursor {
                path,
                cursor: JsonlCursor {
                    offset,
                    draining_oversized: false,
                },
            },
        );
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
        return Some(FileCursor {
            path,
            cursor: JsonlCursor {
                offset,
                draining_oversized: false,
            },
        });
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
    fn pi_semantic_source_uses_managed_cli_session_dir() {
        let dir = tempfile::tempdir().unwrap();
        let managed = dir.path().join("managed-pi");
        fs::create_dir_all(&managed).unwrap();
        fs::write(
            managed.join("pi-session.jsonl"),
            b"{\"type\":\"session\",\"id\":\"native-id\"}\n{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n",
        )
        .unwrap();
        let cfg = HostConfig {
            protocol: 2,
            session_id: "ses".into(),
            run_id: "run".into(),
            run_ordinal: 1,
            host_token: "tok".into(),
            command: vec![
                "pi".into(),
                "--session-dir".into(),
                managed.to_string_lossy().into_owned(),
            ],
            cwd: "/tmp".into(),
            env: vec![],
            adapter_type: "pi".into(),
            detect_pty_needs_input: false,
            transport: AgentTransport::Pty,
            socket_path: dir.path().join("sock").to_string_lossy().into_owned(),
            session_dir: dir.path().join("stable").to_string_lossy().into_owned(),
            log_path: dir.path().join("output.log").to_string_lossy().into_owned(),
            host_log_path: dir.path().join("host.log").to_string_lossy().into_owned(),
            hook_events_path: dir.path().join("events.jsonl").to_string_lossy().into_owned(),
            log_limit_bytes: 1024,
            agent_session_id_hint: Some("native-id".into()),
            secret_env_names: vec![],
            sigint_grace_ms: 1500,
            sigterm_grace_ms: 2500,
            cols: 120,
            rows: 32,
        };

        for adapter in ["pi", "easy_pi", "omp"] {
            let mut cfg = cfg.clone();
            cfg.adapter_type = adapter.into();
            let snapshot = Snapshot::capture(&cfg);
            assert!(snapshot.inherited_turn_complete(), "{adapter}");
            assert!(matches!(snapshot.source, Source::Pi { .. }), "{adapter}");
        }
    }

    #[test]
    fn resumed_pi_transcript_inherits_only_a_completed_latest_message() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi-session.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"session\",\"id\":\"native-id\"}\n{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n{\"type\":\"model_change\"}\n",
        )
        .unwrap();

        assert!(pi_transcript_has_completed_turn(dir.path(), "native-id"));
        assert!(!pi_transcript_has_completed_turn(dir.path(), "other-id"));

        let duplicate = dir.path().join("duplicate.jsonl");
        fs::copy(&path, &duplicate).unwrap();
        assert!(!pi_transcript_has_completed_turn(dir.path(), "native-id"));
        fs::remove_file(duplicate).unwrap();

        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n")
            .unwrap();
        file.flush().unwrap();
        assert!(!pi_transcript_has_completed_turn(dir.path(), "native-id"));
    }

    #[test]
    fn incomplete_pi_snapshot_record_makes_inherited_state_uncertain() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi-session.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"session\",\"id\":\"native-id\"}\n{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n{\"type\":\"message\"",
        )
        .unwrap();

        assert!(!pi_transcript_has_completed_turn(dir.path(), "native-id"));
    }

    #[test]
    fn resumed_codex_transcript_inherits_only_an_exact_completed_turn() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions/2026/08/29");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-native-id.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"native-id\",\"cwd\":\"/work\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n",
        )
        .unwrap();
        assert!(codex_transcript_has_completed_turn(
            &dir.path().join("sessions"),
            "native-id",
            "/work"
        ));
        assert!(!codex_transcript_has_completed_turn(
            &dir.path().join("sessions"),
            "other-id",
            "/work"
        ));

        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n")
            .unwrap();
        file.flush().unwrap();
        assert!(!codex_transcript_has_completed_turn(
            &dir.path().join("sessions"),
            "native-id",
            "/work"
        ));
    }

    #[test]
    fn resumed_kimi_wire_inherits_only_a_completed_latest_loop_event() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wire.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"finishReason\":\"end_turn\"}}\n{\"type\":\"metadata\"}\n",
        )
        .unwrap();
        assert!(latest_kimi_wire_event_is_turn_end(&path));

        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(
            b"{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\"}}\n",
        )
        .unwrap();
        file.flush().unwrap();
        assert!(!latest_kimi_wire_event_is_turn_end(&path));
    }

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
        assert!(is_pi_turn_start(&user));
        assert!(!is_pi_turn_start(&complete));
        for reason in ["error", "aborted", "length", "toolUse"] {
            let retryable_or_intermediate = serde_json::json!({
                "type": "message", "message": {"role": "assistant", "stopReason": reason}
            });
            assert!(!is_pi_turn_end(&retryable_or_intermediate), "{reason}");
            assert!(!is_pi_turn_start(&retryable_or_intermediate), "{reason}");
        }
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
        let start = serde_json::json!({
            "type": "context.append_loop_event",
            "event": {"type": "step.begin"}
        });
        assert!(is_kimi_turn_end(&complete));
        assert!(!is_kimi_turn_end(&tool_call));
        assert!(is_kimi_turn_start(&start));
        assert!(!is_kimi_turn_start(&complete));
    }

    #[test]
    fn follower_starts_at_snapshot_and_waits_for_complete_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        fs::write(&path, b"{\"type\":\"old\"}\n").unwrap();
        let mut cursor = JsonlCursor {
            offset: fs::metadata(&path).unwrap().len(),
            draining_oversized: false,
        };
        let mut seen = Vec::new();
        follow_jsonl(&path, &mut cursor, |event, _| seen.push(event.clone()));
        assert!(seen.is_empty());

        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"type\":\"partial\"}").unwrap();
        file.flush().unwrap();
        follow_jsonl(&path, &mut cursor, |event, _| seen.push(event.clone()));
        assert!(seen.is_empty());
        file.write_all(b"\n").unwrap();
        file.flush().unwrap();
        follow_jsonl(&path, &mut cursor, |event, _| seen.push(event.clone()));
        assert_eq!(seen[0]["type"], "partial");
    }

    #[test]
    fn oversized_record_is_drained_across_bounded_polls_before_the_next_event() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let mut input = Vec::with_capacity(MAX_JSONL_RECORD_BYTES + 128);
        input.extend(std::iter::repeat_n(b'x', MAX_JSONL_RECORD_BYTES + 64));
        input.extend_from_slice(b"\n{\"type\":\"next\"}\n");
        fs::write(&path, input).unwrap();

        let mut cursor = JsonlCursor::default();
        let mut seen = Vec::new();
        follow_jsonl(&path, &mut cursor, |event, _| seen.push(event.clone()));
        assert!(seen.is_empty());
        assert_eq!(cursor.offset, MAX_BYTES_PER_POLL as u64);
        assert!(cursor.draining_oversized);

        follow_jsonl(&path, &mut cursor, |event, _| seen.push(event.clone()));
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["type"], "next");
        assert_eq!(cursor.offset, fs::metadata(&path).unwrap().len());
        assert!(!cursor.draining_oversized);
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
