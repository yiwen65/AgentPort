//! Host <-> client IPC protocol over a per-session Unix domain socket.
//!
//! Newline-delimited JSON. Binary payloads are base64.
//! Identity invariant (PRD ch.5/6): the client must present the session id AND
//! the random per-launch host token; the host rejects and closes otherwise.
//! All input frames carry the session id and are re-validated per message.

use crate::models::{AgentState, Confidence, StateSource};
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

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
    },
    /// Keystrokes / pasted bytes for the PTY. Session id re-checked.
    Input {
        session_id: String,
        #[serde(with = "serde_bytes_b64")]
        data: Vec<u8>,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// Graceful interrupt of the foreground process group (Ctrl-C semantics).
    Interrupt {
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
    },
    Output {
        session_id: String,
        #[serde(with = "serde_bytes_b64")]
        data: Vec<u8>,
        /// Byte offset in the log where this chunk starts.
        offset: u64,
    },
    /// Marker after replaying buffered output; live stream follows.
    ReplayDone { session_id: String, offset: u64 },
    State {
        session_id: String,
        sequence: i64,
        state: AgentState,
        source: StateSource,
        confidence: Confidence,
        #[serde(default)]
        evidence: Option<String>,
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
    },
    Exit {
        session_id: String,
        /// None when killed by signal; `signal` then carries it.
        code: Option<i32>,
        #[serde(default)]
        signal: Option<i32>,
        /// True when the full process group was verified gone.
        group_cleaned: bool,
    },
    Pong {
        session_id: String,
        at: DateTime<Utc>,
    },
    Error {
        session_id: Option<String>,
        message: String,
    },
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
    pub host_token: String,
    /// Final argv — always an array, never a shell string.
    pub command: Vec<String>,
    pub cwd: String,
    /// Non-secret env vars only (name -> value). Secrets are inherited, not listed here.
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub adapter_type: String,
    pub socket_path: String,
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
        if self.session_id.is_empty() || self.host_token.len() < 16 {
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
            code: None,
            signal: Some(9),
            group_cleaned: true,
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
}
