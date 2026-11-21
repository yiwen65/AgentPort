//! Minimal Model Context Protocol (MCP) stdio transport.
//!
//! MCP over stdio is newline-delimited JSON-RPC 2.0: one JSON message per line,
//! no `Content-Length` framing. This module owns the message types and the
//! bounded line reader so the rest of the crate never touches raw bytes.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

/// Protocol revisions this server can speak. The negotiated version echoes the
/// client's request when supported, otherwise it answers with the latest one.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
pub const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";

/// A single JSON-RPC message can never exceed this; MCP payloads are small
/// tool calls. The bound keeps a hostile or buggy peer from exhausting memory.
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

/// One inbound JSON-RPC message: a request (has `id`) or a notification.
#[derive(Debug, Clone, Deserialize)]
pub struct IncomingMessage {
    #[serde(default)]
    pub jsonrpc: Option<String>,
    /// `None` = the member is absent (a notification). `Some(None)` = explicit
    /// `"id": null`, which JSON-RPC still expects an answer for.
    #[serde(default, deserialize_with = "optional_id")]
    pub id: Option<Option<Value>>,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

impl IncomingMessage {
    /// Notifications (no `id` member at all) must never be answered.
    pub fn response_id(&self) -> Option<Value> {
        match &self.id {
            None => None,
            Some(id) => Some(id.clone().unwrap_or(Value::Null)),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

/// Serialize a successful response for `id`.
pub fn success(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Serialize an error response for `id`.
pub fn failure(id: &Value, error: RpcError) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

fn optional_id<'de, D>(deserializer: D) -> Result<Option<Option<Value>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<Value>::deserialize(deserializer).map(Some)
}

/// Parse one line into a message.
pub fn parse_line(line: &str) -> Result<IncomingMessage, RpcError> {
    let message: IncomingMessage = serde_json::from_str(line)
        .map_err(|error| RpcError::new(PARSE_ERROR, format!("invalid JSON-RPC message: {error}")))?;
    if message.method.trim().is_empty() {
        return Err(RpcError::new(INVALID_REQUEST, "method must not be empty"));
    }
    if message
        .jsonrpc
        .as_deref()
        .is_some_and(|version| version != "2.0")
    {
        return Err(RpcError::new(
            INVALID_REQUEST,
            "jsonrpc must be \"2.0\"",
        ));
    }
    Ok(message)
}

/// Read one message line. Returns `Ok(None)` at end of input.
///
/// Oversized lines are consumed and rejected rather than buffered, so a peer
/// cannot force unbounded allocation.
pub fn read_message<R: BufRead>(reader: &mut R) -> Result<Option<String>, RpcError> {
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        // Read at most one byte past the cap, so an attacker-sized line is
        // rejected without ever being buffered in full.
        let read = {
            let mut limited =
                std::io::Read::take(&mut *reader, MAX_MESSAGE_BYTES as u64 + 1);
            limited
                .read_until(b'\n', &mut buffer)
                .map_err(|error| {
                    RpcError::new(INTERNAL_ERROR, format!("stdin read failed: {error}"))
                })?
        };
        if read == 0 {
            return Ok(None);
        }
        if buffer.len() > MAX_MESSAGE_BYTES {
            // Drop the rest of the oversized line so the next read stays
            // aligned to a message boundary.
            let mut sink = Vec::new();
            let _ = reader.read_until(b'\n', &mut sink);
            return Err(RpcError::new(
                INVALID_REQUEST,
                format!("message exceeds {MAX_MESSAGE_BYTES} bytes"),
            ));
        }
        while matches!(buffer.last(), Some(b'\n') | Some(b'\r')) {
            buffer.pop();
        }
        if buffer.iter().all(|byte| byte.is_ascii_whitespace()) {
            continue;
        }
        let text = String::from_utf8(buffer.clone()).map_err(|_| {
            RpcError::new(PARSE_ERROR, "message is not valid UTF-8")
        })?;
        return Ok(Some(text));
    }
}

/// Write one message followed by a newline and flush.
pub fn write_message<W: Write>(writer: &mut W, message: &Value) -> std::io::Result<()> {
    serde_json::to_writer(&mut *writer, message)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

/// `initialize` result: version negotiation plus the tool capability.
pub fn initialize_result(params: Option<&Value>, server_version: &str) -> Value {
    let requested = params
        .and_then(|value| value.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or(LATEST_PROTOCOL_VERSION);
    let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
        requested
    } else {
        LATEST_PROTOCOL_VERSION
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "agentport-mcp", "version": server_version },
        "instructions": CONNECTION_INSTRUCTIONS,
    })
}

pub const CONNECTION_INSTRUCTIONS: &str = "\
AgentPort Sessions MCP. Tools create and drive AgentPort Sessions on this machine.

Scope: only Sessions this server created exist here. The user's own Sessions are not
listed and cannot be addressed; list_agents only offers Agents that are installed and
switched on in AgentPort.

Delegation shape: create_session(agent, projectPath, prompt) opens a real AgentPort
pane-sized Session and sends the first prompt once the CLI is ready. For several
independent tasks prefer create_sessions once, then start_wait_group once and
poll get_wait_group; each item executes and completes independently. The older
wait_for_tasks tool remains available for bounded synchronous compatibility and
returns per-item state and the final reply. Single-task wait_for_task is the
completion primitive: it returns idle | needs_input | exited | timeout with the
current turn's reply when available. A timeout is a structured continuation point;
call wait_for_task again for the same Session and do not use read_output to decide
whether the turn finished. Each wait is capped below common client request deadlines.
read_output is only bounded progress evidence; session_status.completion can carry a
completed turn's final reply during recovery. cancel_wait_group cancels only the
background waiters, not the Agent Sessions.

Handoff routing: when the user asks to hand off, transfer, or delegate the current
context to a named Agent (for example, “handoff to codex”), call the `handoff` tool.
Do not invoke a handoff-writer skill and do not write a `docs/handoff/` document for
that request. `handoff` is a one-shot fire-and-forget transfer; it returns the new
Session and pane metadata without collecting a final answer.
cancel_turn is Ctrl-C and keeps
the Session alive; terminate_session kills the whole process group and cannot be
undone. To tidy up, archive_session hides a Session and keeps its history readable;
delete_session removes the Session *and* the Agent's transcript files, so it needs
the confirm string 'delete <sessionId>' and only when the user asked for it.

Do not enumerate before delegating: call create_session directly — the project resolves
itself, and a wrong or unavailable agent id comes back with the ids that would work, so
there is no list_agents / list_sessions / resolve_project round-trip to perform. Reach
for those only to answer the user's question or to find a Session you started earlier.

Sessions are not disposable: a delegated Session keeps running after it answers,
exactly like a terminal window the user is watching, and the user can read it,
reply to it or take it over. Do not terminate one because its task finished. Leave
it running; only terminate a Session when the user asks for it, or when it is stuck
and cannot be rescued.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifications_have_no_response_id() {
        let message = parse_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).unwrap();
        assert!(message.response_id().is_none());
        let request = parse_line(r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#).unwrap();
        assert_eq!(request.response_id(), Some(json!(7)));
        let null_id = parse_line(r#"{"jsonrpc":"2.0","id":null,"method":"tools/list"}"#).unwrap();
        // Explicit null is a request in JSON-RPC terms and still gets answered.
        assert_eq!(null_id.response_id(), Some(Value::Null));
    }

    #[test]
    fn oversized_line_is_rejected() {
        let mut input = vec![b'a'; MAX_MESSAGE_BYTES + 8];
        input.push(b'\n');
        let mut reader = std::io::BufReader::new(input.as_slice());
        let error = read_message(&mut reader).unwrap_err();
        assert_eq!(error.code, INVALID_REQUEST);
    }

    #[test]
    fn blank_lines_are_skipped() {
        let input = b"\n  \n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n";
        let mut reader = std::io::BufReader::new(input.as_slice());
        let message = read_message(&mut reader).unwrap().unwrap();
        assert!(message.contains("\"ping\""));
        assert!(read_message(&mut reader).unwrap().is_none());
    }

    #[test]
    fn initialize_echoes_a_supported_version() {
        let params = json!({ "protocolVersion": "2024-11-05" });
        let result = initialize_result(Some(&params), "0.0.0");
        assert_eq!(result["protocolVersion"], "2024-11-05");
        assert!(result["instructions"]
            .as_str()
            .unwrap()
            .contains("Handoff routing"));
        let unknown = json!({ "protocolVersion": "1999-01-01" });
        let result = initialize_result(Some(&unknown), "0.0.0");
        assert_eq!(result["protocolVersion"], LATEST_PROTOCOL_VERSION);
    }
}
