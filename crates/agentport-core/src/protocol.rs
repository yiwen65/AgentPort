//! Host <-> client IPC protocol over a per-session Unix domain socket.
//!
//! Newline-delimited JSON. Binary payloads are base64.
//! Identity invariant (PRD ch.5/6): the client must present the session id AND
//! the random per-launch host token; the host rejects and closes otherwise.
//! All input frames carry the session id and are re-validated per message.

use crate::models::{
    default_agent_transport, legacy_run_id, AgentState, AgentTransport, Confidence, LogCursor,
    StateSource, StatusEvent, LEGACY_RUN_ORDINAL,
};
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Current Host protocol.  v2 adds run-scoped state/output cursors while
/// retaining serde defaults so a new client can still consume v1 frames after
/// its bounded legacy handshake fallback.
pub const PROTOCOL_VERSION: u32 = 2;
pub const LEGACY_PROTOCOL_VERSION: u32 = 1;

fn b64e(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}
fn b64d(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    base64::engine::general_purpose::STANDARD.decode(s)
}

// ---------------------------------------------------------------------------
// Client -> Host
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    /// First frame on every connection. Host verifies session id + token.
    Hello {
        protocol: u32,
        session_id: String,
        token: String,
        /// If true, host replays recent log tail after hello_ok.
        replay_tail_bytes: u64,
        /// Resume a v2 output stream at this exact position.  When the cursor
        /// has rotated away, Host replies with `resync_required` instead of
        /// silently mapping the offset into unrelated bytes.
        #[serde(default)]
        resume_from: Option<LogCursor>,
        /// A recovery timeline click requests a bounded context centered on
        /// this exact cursor. Unlike `resume_from`, it may be far behind the
        /// normal tail replay window; Host validates run + generation before
        /// returning any bytes.
        #[serde(default)]
        replay_target: Option<LogCursor>,
        /// Status monitors subscribe without receiving terminal bytes.  The
        /// default preserves v1 behavior for ordinary terminal clients.
        #[serde(default = "default_subscribe_output")]
        subscribe_output: bool,
    },
    /// Keystrokes / pasted bytes for the PTY. Session id re-checked.
    Input {
        session_id: String,
        #[serde(with = "serde_bytes_b64")]
        data: Vec<u8>,
    },
    /// Submit one prompt through the agent's structured JSON-RPC transport.
    /// This is intentionally distinct from terminal input: it cannot be sent
    /// to a PTY Session by accident.
    StructuredPrompt {
        session_id: String,
        text: String,
    },
    /// Abort the current structured turn without sending a terminal signal.
    AbortStructuredTurn {
        session_id: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        pixel_width: u16,
        #[serde(default)]
        pixel_height: u16,
    },
    /// Graceful interrupt of the foreground process group (Ctrl-C semantics).
    Interrupt {
        session_id: String,
    },
    /// Resume a process group suspended by terminal job-control (Ctrl-Z).
    Continue {
        session_id: String,
    },
    /// Stop the whole session: SIGINT -> SIGTERM -> SIGKILL on the process group,
    /// verify no descendants remain, report `exit` then close.
    Stop {
        session_id: String,
        grace_ms: u64,
    },
    StatusRequest {
        session_id: String,
    },
    Ping {
        session_id: String,
    },
    Detach {
        session_id: String,
    },
}

// ---------------------------------------------------------------------------
// Host -> Client
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostFrame {
    HelloOk {
        protocol: u32,
        session_id: String,
        host_pid: u32,
        /// True when the agent child is still alive.
        child_alive: bool,
        /// Total bytes written to the output log so far.
        log_bytes: u64,
        #[serde(default)]
        agent_session_id: Option<String>,
        #[serde(default = "legacy_run_id")]
        run_id: String,
        #[serde(default)]
        run_ordinal: i64,
        /// A reconnect must not wait for a future state transition to learn
        /// the Host's present state.
        #[serde(default)]
        current_status: Option<StatusEvent>,
        #[serde(default)]
        log_cursor: LogCursor,
    },
    Output {
        session_id: String,
        #[serde(with = "serde_bytes_b64")]
        data: Vec<u8>,
        /// Byte offset in the log where this chunk starts.
        offset: u64,
        /// v2 identity for `offset`; v1 frames deserialize as the legacy
        /// run/generation-zero cursor.
        #[serde(default)]
        cursor: LogCursor,
    },
    /// Live PTY bytes whose durable log append failed. These bytes are
    /// intentionally cursorless and are never replayed; clients must render
    /// them without advancing their durable replay cursor.
    TransientOutput {
        session_id: String,
        #[serde(with = "serde_bytes_b64")]
        data: Vec<u8>,
    },
    /// Ephemeral job-control state for the direct Agent process group.
    ProcessStatus {
        session_id: String,
        suspended: bool,
        signal: Option<i32>,
    },
    /// A validated agent JSON-RPC event. The value is retained verbatim so
    /// the UI can render newly introduced Pi event kinds without a Host
    /// protocol upgrade.
    Structured {
        session_id: String,
        event: serde_json::Value,
    },
    /// Marker after replaying buffered output; live stream follows.
    ReplayDone {
        session_id: String,
        offset: u64,
        #[serde(default)]
        cursor: LogCursor,
        /// True when a recovery click deliberately loaded only a bounded
        /// context window around an old target instead of a contiguous resume.
        #[serde(default)]
        partial_context: bool,
    },
    /// The requested output cursor is no longer retained (or does not belong
    /// to this run). The client must reset its renderer and accept a bounded
    /// tail snapshot instead of silently stitching a gap.
    ResyncRequired {
        session_id: String,
        earliest: LogCursor,
        reason: String,
    },
    State {
        session_id: String,
        #[serde(default = "legacy_run_id")]
        run_id: String,
        #[serde(default)]
        run_ordinal: i64,
        sequence: i64,
        state: AgentState,
        source: StateSource,
        confidence: Confidence,
        #[serde(default)]
        evidence: Option<String>,
        /// Captured with the status transition so a recovery entry can target
        /// this event, not a generic per-Session unread marker.
        #[serde(default)]
        log_cursor: Option<LogCursor>,
        occurred_at: DateTime<Utc>,
    },
    AgentSession {
        session_id: String,
        agent_session_id: String,
        /// "exact" | "latest"
        resume_precision: String,
    },
    Heartbeat {
        session_id: String,
        at: DateTime<Utc>,
        log_bytes: u64,
        #[serde(default)]
        log_cursor: LogCursor,
    },
    Exit {
        session_id: String,
        #[serde(default = "legacy_run_id")]
        run_id: String,
        #[serde(default)]
        run_ordinal: i64,
        /// None when killed by signal; `signal` then carries it.
        code: Option<i32>,
        #[serde(default)]
        signal: Option<i32>,
        /// True when the full process group was verified gone.
        group_cleaned: bool,
        /// `natural` | `user_stop` | `host_signal` | `fault`.
        #[serde(default = "default_exit_reason")]
        reason: String,
    },
    Pong {
        session_id: String,
        at: DateTime<Utc>,
    },
    Error {
        session_id: Option<String>,
        message: String,
        /// Stable application-owned error identifier. Absent on legacy Hosts.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        /// Named localization parameters. Absent on legacy Hosts.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<serde_json::Value>,
        /// Original detail retained for diagnostics, never used as a key.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        technical_detail: Option<String>,
    },
}

/// Translate the offset-only output state used by protocol v1 into the
/// run-aware cursor shape consumed by current clients. Negotiated v1 frames
/// are authoritative only for their legacy byte offsets, so any cursor fields
/// supplied by serde defaults (or a transitional sender) are replaced.
pub fn normalize_host_frame(protocol: u32, mut frame: HostFrame) -> HostFrame {
    if protocol != LEGACY_PROTOCOL_VERSION {
        return frame;
    }

    fn legacy_cursor(offset: u64) -> LogCursor {
        LogCursor {
            offset: i64::try_from(offset).unwrap_or(i64::MAX),
            ..LogCursor::default()
        }
    }

    match &mut frame {
        HostFrame::HelloOk {
            log_bytes,
            log_cursor,
            ..
        }
        | HostFrame::Heartbeat {
            log_bytes,
            log_cursor,
            ..
        } => *log_cursor = legacy_cursor(*log_bytes),
        HostFrame::Output { offset, cursor, .. } | HostFrame::ReplayDone { offset, cursor, .. } => {
            *cursor = legacy_cursor(*offset);
        }
        _ => {}
    }
    frame
}

fn default_subscribe_output() -> bool {
    true
}

fn default_exit_reason() -> String {
    "natural".into()
}

mod serde_bytes_b64 {
    use super::*;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&b64e(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        b64d(&s).map_err(serde::de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// Framing helpers (shared by host and core client)
// ---------------------------------------------------------------------------

pub fn write_frame<T: Serialize>(w: &mut impl std::io::Write, frame: &T) -> std::io::Result<()> {
    let line = serde_json::to_string(frame).map_err(std::io::Error::other)?;
    w.write_all(line.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

/// Read one NDJSON frame. Returns Ok(None) on clean EOF.
pub fn read_frame<T: for<'de> Deserialize<'de>>(
    r: &mut impl std::io::BufRead,
) -> std::io::Result<Option<T>> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = r.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v = serde_json::from_str(trimmed)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        return Ok(Some(v));
    }
}

/// Host launch configuration. Written to `<session>/host.json` (mode 0600) by
/// the core, consumed by `agentport-host`. MUST NOT contain secret values —
/// secrets travel only through the inherited process environment (PRD 3.7).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub protocol: u32,
    pub session_id: String,
    #[serde(default = "legacy_run_id")]
    pub run_id: String,
    #[serde(default)]
    pub run_ordinal: i64,
    pub host_token: String,
    /// Final argv — always an array, never a shell string.
    pub command: Vec<String>,
    pub cwd: String,
    /// Non-secret env vars only (name -> value). Secrets are inherited, not listed here.
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub adapter_type: String,
    /// PTY is the compatibility default for configs written by older builds.
    #[serde(default = "default_agent_transport")]
    pub transport: AgentTransport,
    pub socket_path: String,
    /// Stable Session root for host-state and append-only status journal.
    /// Older configs derive it from `log_path` for compatibility.
    #[serde(default)]
    pub session_dir: String,
    pub log_path: String,
    pub host_log_path: String,
    pub hook_events_path: String,
    /// Rotation limit in bytes from the saved application settings.
    pub log_limit_bytes: u64,
    /// Adapter-specific launch context (e.g. assigned claude session uuid).
    #[serde(default)]
    pub agent_session_id_hint: Option<String>,
    /// Names of env vars that carry secrets in the host's own environment.
    /// The host reads these values from its env at startup to build the log
    /// redactor and passes them through to the agent child. Values NEVER
    /// appear in this file (PRD 3.7).
    #[serde(default)]
    pub secret_env_names: Vec<String>,
    /// Stop grace periods.
    #[serde(default = "default_sigint_grace_ms")]
    pub sigint_grace_ms: u64,
    #[serde(default = "default_sigterm_grace_ms")]
    pub sigterm_grace_ms: u64,
    /// Initial PTY size.
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_sigint_grace_ms() -> u64 {
    1_500
}
fn default_sigterm_grace_ms() -> u64 {
    2_500
}
fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    32
}

impl HostConfig {
    pub fn validate(&self) -> Result<(), crate::error::CoreError> {
        use crate::error::CoreError;
        if self.session_id.is_empty()
            || self.run_id.is_empty()
            || self.run_ordinal < LEGACY_RUN_ORDINAL
            || self.host_token.len() < 16
        {
            return Err(CoreError::Validation("bad session id/token".into()));
        }
        if self.command.is_empty() || self.command[0].is_empty() {
            return Err(CoreError::Validation("empty command".into()));
        }
        if self.log_limit_bytes < 1024 * 1024 {
            return Err(CoreError::Validation("log limit too small".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::LEGACY_RUN_ID;

    #[test]
    fn frame_roundtrip() {
        let f = ClientFrame::Input {
            session_id: "ses_1".into(),
            data: b"ls -la\r".to_vec(),
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &f).unwrap();
        let mut r = std::io::BufReader::new(&buf[..]);
        let back: ClientFrame = read_frame(&mut r).unwrap().unwrap();
        match back {
            ClientFrame::Input { session_id, data } => {
                assert_eq!(session_id, "ses_1");
                assert_eq!(data, b"ls -la\r");
            }
            _ => panic!("wrong frame"),
        }
    }

    #[test]
    fn host_frame_roundtrip() {
        let f = HostFrame::Exit {
            session_id: "ses_1".into(),
            run_id: LEGACY_RUN_ID.into(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            code: None,
            signal: Some(9),
            group_cleaned: true,
            reason: "natural".into(),
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &f).unwrap();
        let mut r = std::io::BufReader::new(&buf[..]);
        let back: HostFrame = read_frame(&mut r).unwrap().unwrap();
        assert!(matches!(
            back,
            HostFrame::Exit {
                signal: Some(9),
                ..
            }
        ));
    }

    #[test]
    fn host_error_envelope_remains_compatible_with_legacy_messages() {
        let legacy: HostFrame = serde_json::from_str(
            r#"{"type":"error","session_id":"ses_1","message":"legacy Host message"}"#,
        )
        .unwrap();
        assert!(matches!(
            legacy,
            HostFrame::Error {
                code: None,
                params: None,
                technical_detail: None,
                ..
            }
        ));

        let current = HostFrame::Error {
            session_id: Some("ses_1".into()),
            message: "legacy-compatible message".into(),
            code: Some("host_error".into()),
            params: Some(serde_json::json!({"attempt": 2})),
            technical_detail: Some("socket closed".into()),
        };
        let encoded = serde_json::to_value(current).unwrap();
        assert_eq!(encoded["code"], "host_error");
        assert_eq!(encoded["technical_detail"], "socket closed");
        assert_eq!(encoded["message"], "legacy-compatible message");
    }

    #[test]
    fn v1_offset_fields_normalize_to_legacy_cursors() {
        let frames = [
            (
                r#"{"type":"hello_ok","protocol":1,"session_id":"ses_1","host_pid":7,"child_alive":true,"log_bytes":12}"#,
                12,
            ),
            (
                r#"{"type":"output","session_id":"ses_1","data":"YWJjZA==","offset":4}"#,
                4,
            ),
            (
                r#"{"type":"replay_done","session_id":"ses_1","offset":8}"#,
                8,
            ),
            (
                r#"{"type":"heartbeat","session_id":"ses_1","at":"2026-07-23T00:00:00Z","log_bytes":16}"#,
                16,
            ),
        ];

        for (json, expected_offset) in frames {
            let frame: HostFrame = serde_json::from_str(json).unwrap();
            let cursor = match normalize_host_frame(LEGACY_PROTOCOL_VERSION, frame) {
                HostFrame::HelloOk { log_cursor, .. } | HostFrame::Heartbeat { log_cursor, .. } => {
                    log_cursor
                }
                HostFrame::Output { cursor, .. } | HostFrame::ReplayDone { cursor, .. } => cursor,
                other => panic!("unexpected frame: {other:?}"),
            };
            assert_eq!(cursor.run_id, LEGACY_RUN_ID);
            assert_eq!(cursor.run_ordinal, LEGACY_RUN_ORDINAL);
            assert_eq!(cursor.generation, 0);
            assert_eq!(cursor.offset, expected_offset);
        }
    }
}
