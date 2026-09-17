//! Versioned wire DTOs and bounded `u32` + JSON framing for AgentPort Remote.
//!
//! This crate deliberately has no dependency on Core, Tauri, SSH, or Mosh.

pub mod image;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};
use std::io::{Read, Write};
use thiserror::Error;
use zeroize::Zeroizing;

pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 1;
pub const EVENT_PUSH_MINOR: u16 = 1;
pub const CAPABILITY_SESSION_EVENT_PUSH: &str = "session.event_push";
pub const CAPABILITY_TERMINAL_GEOMETRY: &str = "terminal.geometry_v1";
pub const MAX_FRAME_BYTES: u32 = 16 * 1024 * 1024;

/// Exact Bridge dispatch registry. Retry classification is tested against this
/// list so an additive method cannot become callable without an explicit
/// replay policy. Classified-but-not-yet-dispatched future slices stay out.
pub const METHOD_REGISTRY: &[&str] = &[
    "image.begin", "image.chunk", "image.finish", "image.abort",
    "boot",
    "session.list",
    "session.poll",
    "session.attach",
    "session.detach",
    "session.control",
    "session.input",
    "session.create",
    "session.restart",
    "session.structured_input",
    "session.turn.abort",
    "session.stop",
    "session.rename",
    "session.pin",
    "session.archive",
    "session.unarchive",
    "session.archives.list",
    "session.archives.delete",
    "session.archives.delete_all",
    "session.status.history",
    "session.seen.mark",
    "session.output.unread.mark",
    "attention.poll",
    "session.auto_title",
    "agent.supported",
    "agent.probe",
    "agent.probe_all",
    "agent.preferences",
    "agent.preferences.replace",
    "preset.list",
    "project.list",
    "project.add",
    "project.rename",
    "project.layout.replace",
    "project.remove.preflight",
    "project.remove",
    "worktree.preview",
    "worktree.reconcile",
    "worktree.create",
    "worktree.list",
    "worktree.remove.preflight",
    "worktree.remove",
    "worktree.status",
    "git.context.resolve",
    "git.worktree.branch.adopt",
    "git.changes",
    "git.diff",
    "git.history",
    "git.commit.detail",
    "git.commit.diff",
    "git.stage",
    "git.unstage",
    "git.discard",
    "git.ignore",
    "git.trash",
    "git.file.resolve",
    "git.remote.sync",
    "git.commit.prepare",
    "git.commit.execute",
    "git.commit.reconcile",
    "branch.status",
    "branch.list",
    "branch.create",
    "branch.create_switch",
    "branch.switch",
    "branch.delete",
    "branch.autostash.list",
    "branch.autostash.restore",
    "branch.autostash.cleanup",
    "commit_ai.config.get",
    "commit_ai.config.save",
    "commit_ai.key.clear",
    "commit_ai.generate",
    "search.global",
    "search.session",
    "history.page",
    "storage.legacy.inventory",
    "storage.legacy.delete",
    "search.index.rebuild",
    "timeline.get",
    "timeline.ack",
    "settings.get",
    "settings.save",
    "diagnostics.hosts",
    "diagnostics.summary",
    "diagnostics.capabilities",
    "export.session",
    "backup.create",
    "backup.list",
    "backup.verify",
    "backup.restore",
    "document.read",
    "document.write",
    "document.list",
    "document.create",
    "secret.status",
    "secret.list",
    "secret.add",
    "secret.delete",
];

/// Product-level V2 Mobile surface. The Bridge keeps the larger registry for
/// desktop/service compatibility, while Mobile clients can pin this bounded
/// allowlist during review and capability negotiation.
pub const MOBILE_V2_METHOD_ALLOWLIST: &[&str] = &[
    "boot",
    "session.list",
    "session.attach",
    "session.detach",
    "session.control",
    "session.input",
    "session.create",
    "session.restart",
    "session.stop",
    "session.seen.mark",
    "attention.poll",
    "agent.supported",
    "agent.preferences",
    "project.list",
];

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("frame length {actual} exceeds maximum {maximum}")]
    FrameTooLarge { actual: u32, maximum: u32 },
    #[error("frame length cannot be represented on this platform")]
    LengthOverflow,
    #[error("unexpected end of framed input")]
    UnexpectedEof,
    #[error("framed input is not valid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("protocol major {client_major} is incompatible with server major {server_major}")]
    IncompatibleMajor {
        client_major: u16,
        server_major: u16,
    },
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// A received frame whose allocation is wiped when dropped. It intentionally
/// does not implement `Debug`, `Display`, or `Clone` so a frame cannot be
/// accidentally included in diagnostics.
pub struct FrameBuffer(Zeroizing<Vec<u8>>);

impl FrameBuffer {
    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_slice()
    }
}

/// Reads one frame. The advertised length is rejected before allocating its
/// payload buffer. A clean EOF before a header returns `Ok(None)`.
pub fn read_frame<R: Read>(
    reader: &mut R,
    maximum: u32,
) -> Result<Option<FrameBuffer>, ProtocolError> {
    let mut header = [0_u8; 4];
    let mut read = 0;
    while read < header.len() {
        match reader.read(&mut header[read..])? {
            0 if read == 0 => return Ok(None),
            0 => return Err(ProtocolError::UnexpectedEof),
            count => read += count,
        }
    }

    let length = u32::from_be_bytes(header);
    if length > maximum {
        return Err(ProtocolError::FrameTooLarge {
            actual: length,
            maximum,
        });
    }
    let length = usize::try_from(length).map_err(|_| ProtocolError::LengthOverflow)?;
    let mut payload = Zeroizing::new(vec![0_u8; length]);
    reader
        .read_exact(payload.as_mut_slice())
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::UnexpectedEof => ProtocolError::UnexpectedEof,
            _ => ProtocolError::Io(error),
        })?;
    Ok(Some(FrameBuffer(payload)))
}

pub fn write_frame<W: Write, T: Serialize>(
    writer: &mut W,
    value: &T,
    maximum: u32,
) -> Result<(), ProtocolError> {
    let payload = Zeroizing::new(serde_json::to_vec(value)?);
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::LengthOverflow)?;
    if length > maximum {
        return Err(ProtocolError::FrameTooLarge {
            actual: length,
            maximum,
        });
    }
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(payload.as_slice())?;
    writer.flush()?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

impl ProtocolVersion {
    pub const V1: Self = Self {
        major: PROTOCOL_MAJOR,
        minor: PROTOCOL_MINOR,
    };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientIdentity {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelloType {
    Hello,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    #[serde(rename = "type")]
    pub message_type: HelloType,
    pub protocol: ProtocolVersion,
    pub client: ClientIdentity,
    #[serde(default)]
    pub requested_capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerIdentity {
    pub agentport_version: String,
    pub platform: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub name: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_frame_bytes: u32,
    pub max_subscriptions: u32,
    pub max_host_clients: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub protocol: ProtocolVersion,
    pub server: ServerIdentity,
    pub capabilities: Vec<Capability>,
    pub limits: Limits,
}

pub fn negotiate_version(client: ProtocolVersion) -> Result<ProtocolVersion, ProtocolError> {
    if client.major != PROTOCOL_MAJOR {
        return Err(ProtocolError::IncompatibleMajor {
            client_major: client.major,
            server_major: PROTOCOL_MAJOR,
        });
    }
    Ok(ProtocolVersion {
        major: PROTOCOL_MAJOR,
        // Minor extensions are additive. A newer peer is safely capped to the
        // newest extension this server understands.
        minor: client.minor.min(PROTOCOL_MINOR),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryClass {
    Read,
    IdempotentWrite,
    NonIdempotentWrite,
    Unknown,
}

impl RetryClass {
    pub fn allows_automatic_retry(&self) -> bool {
        matches!(self, Self::Read)
    }
}

/// The registry is intentionally exact. Unknown methods are never inferred to
/// be reads, because doing so could make a future write automatically replay.
pub fn classify_method(method: &str) -> RetryClass {
    match method {
        "image.begin" | "image.chunk" | "image.finish" | "image.abort" => RetryClass::NonIdempotentWrite,
        "boot"
        | "session.list"
        | "session.status"
        | "session.history"
        | "session.poll"
        | "attention.poll"
        | "session.archives.list"
        | "session.status.history"
        | "search"
        | "diag"
        | "agent.supported"
        | "agent.preferences"
        | "preset.list"
        | "project.list"
        | "project.remove.preflight"
        | "worktree.preview"
        | "worktree.list"
        | "worktree.remove.preflight"
        | "worktree.status"
        | "git.context.resolve"
        | "git.changes"
        | "git.diff"
        | "git.history"
        | "git.commit.detail"
        | "git.commit.diff"
        | "git.file.resolve"
        | "git.commit.prepare"
        | "branch.status"
        | "branch.list"
        | "commit_ai.config.get"
        | "search.global"
        | "search.session"
        | "history.page"
        | "storage.legacy.inventory"
        | "settings.get"
        | "diagnostics.hosts"
        | "diagnostics.summary"
        | "diagnostics.capabilities"
        | "backup.list"
        | "backup.verify"
        | "document.read"
        | "document.list"
        | "secret.list" => RetryClass::Read,
        "session.mark_seen"
        | "settings.replace"
        | "session.attach"
        | "session.detach"
        | "session.control"
        | "session.rename"
        | "session.pin"
        | "session.seen.mark"
        | "session.output.unread.mark"
        | "session.auto_title"
        | "agent.probe"
        | "agent.probe_all"
        | "agent.preferences.replace"
        | "project.rename"
        | "project.layout.replace"
        | "worktree.reconcile"
        | "git.commit.reconcile"
        | "branch.autostash.list"
        | "search.index.rebuild"
        | "timeline.get"
        | "timeline.ack"
        | "settings.save"
        | "document.write"
        | "git.worktree.branch.adopt"
        | "git.stage"
        | "git.unstage" => RetryClass::IdempotentWrite,
        "session.input"
        | "session.structured_input"
        | "session.turn.abort"
        | "session.create"
        | "session.stop"
        | "session.restart"
        | "session.archive"
        | "session.unarchive"
        | "session.archives.delete"
        | "session.archives.delete_all"
        | "git.commit"
        | "git.delete"
        | "project.add"
        | "project.remove"
        | "worktree.create"
        | "worktree.remove"
        | "git.discard"
        | "git.ignore"
        | "git.trash"
        | "git.remote.sync"
        | "git.commit.execute"
        | "branch.create"
        | "branch.create_switch"
        | "branch.switch"
        | "branch.delete"
        | "branch.autostash.restore"
        | "branch.autostash.cleanup"
        | "commit_ai.config.save"
        | "commit_ai.key.clear"
        | "commit_ai.generate"
        | "storage.legacy.delete"
        | "export.session"
        | "backup.create"
        | "backup.restore"
        | "document.create"
        | "secret.status"
        | "secret.add"
        | "secret.delete" => RetryClass::NonIdempotentWrite,
        _ => RetryClass::Unknown,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Revision {
    Number(u64),
    Decimal(String),
}

impl Revision {
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Number(value) => Some(*value),
            Self::Decimal(value) => value.parse().ok(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Precondition {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<Revision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<RunCursor>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    #[serde(rename = "type")]
    pub message_type: RequestType,
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precondition: Option<Precondition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestType {
    Request,
}

/// Borrowed request view used by the Bridge. `params` points into the
/// zeroizing frame buffer, avoiding a second payload allocation before the
/// method is known.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BorrowedRequest<'a> {
    #[serde(rename = "type")]
    pub message_type: RequestType,
    pub request_id: &'a str,
    pub method: &'a str,
    #[serde(borrow)]
    pub params: &'a RawValue,
    #[serde(default)]
    pub precondition: Option<Precondition>,
}

pub fn borrow_request(frame: &[u8]) -> Result<BorrowedRequest<'_>, ProtocolError> {
    Ok(serde_json::from_slice(frame)?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteAgentType {
    Claude,
    Codex,
    Kimi,
    Qoder,
    Pi,
    Omp,
    Opencode,
    Amp,
    Gemini,
    Cline,
    KiroCli,
    CursorAgent,
    EasyPi,
    GrokBuild,
    Shell,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProbeParams {
    pub agent: RemoteAgentType,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProbeAllParams {
    #[serde(default)]
    pub preserve_selections: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPreferencesReplaceParams {
    /// Opaque adapter identifiers preserve forward-compatible values returned
    /// by a newer host. Probe methods remain typed to the six v1 adapters.
    pub agent_order: Vec<String>,
    pub agent_hidden: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetListParams {
    #[serde(default)]
    pub agent: Option<RemoteAgentType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAddParams {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectIdParams {
    pub project_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRenameParams {
    pub project_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectLayoutEntry {
    pub project_id: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectLayoutReplaceParams {
    pub entries: Vec<ProjectLayoutEntry>,
}

/// Exact versioned archive fact included in a Project deletion confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedProjectSession {
    pub session_id: String,
    pub archive_generation: u64,
    pub archived: bool,
}

/// Destructive Project removal must echo every dependency from the immediately
/// preceding preflight. The revision alone is not used as an authorization
/// token; Core compares the complete sorted snapshot before fencing writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreePreviewParams {
    pub project_id: String,
    pub task: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeProjectParams {
    pub project_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeIdParams {
    pub worktree_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeCreateParams {
    pub project_id: String,
    pub task: String,
    #[serde(default)]
    pub base_ref: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub branch_mode: Option<String>,
    #[serde(default)]
    pub expected_branch_oid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRemoveParams {
    pub project_id: String,
    /// Decimal text avoids IEEE-754 loss when a JS client echoes the digest.
    pub revision: String,
    pub sessions: Vec<ConfirmedProjectSession>,
    pub worktree_ids: Vec<String>,
    pub recoverable_operation_ids: Vec<String>,
    pub pending_commit_operation_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretDeleteParams {
    pub id: String,
}

/// Commit-AI configuration input. The optional API key remains in a
/// zeroizing allocation and this type intentionally implements neither
/// `Debug`, `Display`, nor `Clone`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitAiConfigSaveParams {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<Zeroizing<String>>,
    pub language: String,
}

impl CommitAiConfigSaveParams {
    pub fn new(
        provider: String,
        base_url: String,
        model: String,
        api_key: Option<String>,
        language: String,
    ) -> Self {
        Self {
            provider,
            base_url,
            model,
            api_key: api_key.map(Zeroizing::new),
            language,
        }
    }

    pub fn expose_api_key(&self) -> Option<&str> {
        self.api_key.as_ref().map(|value| value.as_str())
    }
}

/// Document bodies may contain credentials or prompts. Keep write content in
/// a zeroizing allocation and exclude this DTO from loggable traits.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentWriteParams {
    pub path: String,
    pub content: Zeroizing<String>,
}

impl DocumentWriteParams {
    pub fn new(path: String, content: String) -> Self {
        Self {
            path,
            content: Zeroizing::new(content),
        }
    }

    pub fn expose_content(&self) -> &str {
        self.content.as_str()
    }
}

/// Write-only `secret.add` input. Secret storage is zeroized on drop and the
/// type intentionally implements neither `Debug`, `Display`, nor `Clone`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretAddParams {
    pub env_name: String,
    pub preset_id: String,
    pub value: Zeroizing<String>,
}

impl SecretAddParams {
    pub fn expose_value(&self) -> &[u8] {
        self.value.as_bytes()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionIdParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCreateParams {
    pub project_id: String,
    pub agent: RemoteAgentType,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub preset_id: Option<String>,
    #[serde(default)]
    pub worktree_id: Option<String>,
    pub permission: String,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub risk_ack: bool,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[serde(default)]
    pub extra_args: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRestartParams {
    pub session_id: String,
    #[serde(default)]
    pub risk_ack: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRenameParams {
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionPinParams {
    pub session_id: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusCursor {
    pub run_id: String,
    pub run_ordinal: u64,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSeenParams {
    pub session_id: String,
    pub cursor: StatusCursor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionUnreadParams {
    pub session_id: String,
    pub cursor: RunCursor,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStructuredPromptParams {
    pub attachment_id: String,
    pub text: Zeroizing<String>,
}

impl SessionStructuredPromptParams {
    pub fn expose_text(&self) -> &str {
        self.text.as_str()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAutoTitleParams {
    pub session_id: String,
    pub input: Zeroizing<String>,
}

impl SessionAutoTitleParams {
    pub fn expose_input(&self) -> &str {
        self.input.as_str()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAttachParams {
    pub session_id: String,
    #[serde(default)]
    pub replay_tail_bytes: u64,
    #[serde(default)]
    pub resume_from: Option<RunCursor>,
    #[serde(default = "default_true")]
    pub subscribe_output: bool,
    #[serde(default)]
    pub screen_snapshot: bool,
}

/// Terminal input stays in a zeroizing base64 allocation until Service decodes
/// it into a second zeroizing byte buffer. This type intentionally implements
/// neither `Debug`, `Display`, nor `Clone`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionInputParams {
    pub attachment_id: String,
    pub batch_id: String,
    pub data_base64: Zeroizing<String>,
}

impl SessionInputParams {
    pub fn decode_data(&self) -> Result<Zeroizing<Vec<u8>>, base64::DecodeError> {
        base64::engine::general_purpose::STANDARD
            .decode(self.data_base64.as_bytes())
            .map(Zeroizing::new)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionControlKind {
    Resize,
    Interrupt,
    Continue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionControlParams {
    pub attachment_id: String,
    pub control: SessionControlKind,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    /// Revision/source metadata is additive. Legacy resize callers omit every
    /// field; V2 callers send the complete set after capability negotiation.
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub source_device_id: Option<String>,
    #[serde(default)]
    pub orientation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionCursor {
    pub occurred_at: String,
    pub session_id: String,
    pub run_ordinal: i64,
    pub sequence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionPollParams {
    #[serde(default)]
    pub cursor: Option<AttentionCursor>,
    #[serde(default = "default_attention_limit")]
    pub limit: u16,
}

fn default_attention_limit() -> u16 {
    64
}

#[cfg(test)]
mod terminal_geometry_contract_tests {
    use super::*;

    #[test]
    fn legacy_resize_remains_deserializable_without_geometry_metadata() {
        let params: SessionControlParams = serde_json::from_value(serde_json::json!({
            "attachmentId": "att-legacy",
            "control": "resize",
            "cols": 80,
            "rows": 24
        }))
        .unwrap();
        assert_eq!(params.expected_revision, None);
        assert_eq!(params.source_kind, None);
    }

    #[test]
    fn v2_resize_preserves_revision_device_and_orientation() {
        let params: SessionControlParams = serde_json::from_value(serde_json::json!({
            "attachmentId": "att-mobile",
            "control": "resize",
            "cols": 48,
            "rows": 40,
            "expectedRevision": 7,
            "sourceKind": "mobile",
            "sourceDeviceId": "phone-1",
            "orientation": "portrait"
        }))
        .unwrap();
        assert_eq!(params.expected_revision, Some(7));
        assert_eq!(params.source_kind.as_deref(), Some("mobile"));
        assert_eq!(params.source_device_id.as_deref(), Some("phone-1"));
        assert_eq!(params.orientation.as_deref(), Some("portrait"));
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionPollParams {
    pub attachment_id: String,
    #[serde(default = "default_poll_limit")]
    pub limit: u16,
    #[serde(default = "default_poll_wait_ms")]
    pub wait_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDetachParams {
    pub attachment_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStopParams {
    pub session_id: String,
    #[serde(default = "default_stop_grace_ms")]
    pub grace_ms: u64,
}

fn default_true() -> bool {
    true
}

fn default_poll_limit() -> u16 {
    64
}

fn default_poll_wait_ms() -> u64 {
    50
}

fn default_stop_grace_ms() -> u64 {
    1_500
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultStatus {
    Succeeded,
    Failed,
    NotExecuted,
    /// A non-idempotent operation entered execution but the terminal outcome
    /// could not be observed. Clients must not replay it automatically.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ServerEnvelope {
    Hello(HelloResult),
    Incompatible {
        supported: ProtocolVersion,
        message: String,
    },
    Accepted {
        request_id: String,
        operation_id: String,
        server_sequence: u64,
        retry_class: RetryClass,
    },
    Result {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        operation_id: Option<String>,
        status: ResultStatus,
        retry_class: RetryClass,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<RemoteError>,
    },
    Event(Event),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorRelation {
    Continuous,
    Gap,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCursor {
    pub run_id: String,
    pub run_ordinal: u64,
    pub generation: u64,
    pub offset: u64,
    pub status_sequence: u64,
}

impl RunCursor {
    pub fn relation_to(&self, previous: &Self) -> CursorRelation {
        if self.run_ordinal < previous.run_ordinal
            || (self.run_ordinal == previous.run_ordinal && self.run_id != previous.run_id)
        {
            return CursorRelation::Conflict;
        }
        if self.run_ordinal > previous.run_ordinal || self.generation > previous.generation {
            return CursorRelation::Gap;
        }
        if self.generation < previous.generation
            || self.offset < previous.offset
            || self.status_sequence < previous.status_sequence
        {
            return CursorRelation::Conflict;
        }
        CursorRelation::Continuous
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCursor {
    pub source_fingerprint: String,
    pub snapshot_revision: u64,
    pub page_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_cursor: Option<String>,
}

impl HistoryCursor {
    pub fn relation_to(&self, previous: &Self) -> CursorRelation {
        if self.source_fingerprint != previous.source_fingerprint
            || self.snapshot_revision != previous.snapshot_revision
            || self.page_sequence <= previous.page_sequence
        {
            return CursorRelation::Conflict;
        }
        if self.page_sequence > previous.page_sequence.saturating_add(1) {
            return CursorRelation::Gap;
        }
        CursorRelation::Continuous
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub subscription_id: String,
    pub event_type: String,
    pub cursor: RunCursor,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CursorOutcome<T> {
    Continuous {
        cursor: T,
        items: Vec<Value>,
    },
    Gap {
        reason: String,
        authoritative: Value,
    },
    Conflict {
        reason: String,
        authoritative: Value,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    #[test]
    fn frame_golden_is_big_endian_length_plus_json() {
        let mut bytes = Vec::new();
        write_frame(
            &mut bytes,
            &serde_json::json!({"ok": true}),
            MAX_FRAME_BYTES,
        )
        .unwrap();
        assert_eq!(&bytes[..4], &(11_u32.to_be_bytes()));
        assert_eq!(&bytes[4..], br#"{"ok":true}"#);
    }

    #[test]
    fn frame_rejects_oversize_before_reading_payload() {
        struct HeaderOnly {
            cursor: Cursor<Vec<u8>>,
            payload_read: bool,
        }
        impl Read for HeaderOnly {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                if self.cursor.position() >= 4 {
                    self.payload_read = true;
                    panic!("oversize reader attempted to read payload");
                }
                self.cursor.read(output)
            }
        }
        let mut input = HeaderOnly {
            cursor: Cursor::new((MAX_FRAME_BYTES + 1).to_be_bytes().to_vec()),
            payload_read: false,
        };
        assert!(matches!(
            read_frame(&mut input, MAX_FRAME_BYTES),
            Err(ProtocolError::FrameTooLarge { .. })
        ));
        assert!(!input.payload_read);
    }

    #[test]
    fn ordinary_request_ignores_unknown_fields_but_hello_rejects_them() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "type": "request", "requestId": "r1", "method": "boot", "params": {},
            "futureOptional": true
        }))
        .unwrap();
        assert_eq!(request.request_id, "r1");

        let hello = serde_json::from_value::<Hello>(serde_json::json!({
            "type": "hello", "protocol": {"major": 1, "minor": 0},
            "client": {"name": "mobile", "version": "1"},
            "requestedCapabilities": [], "futureOptional": true
        }));
        assert!(hello.is_err());
    }

    #[test]
    fn incompatible_major_fails_closed() {
        assert!(matches!(
            negotiate_version(ProtocolVersion { major: 2, minor: 0 }),
            Err(ProtocolError::IncompatibleMajor { .. })
        ));
    }

    #[test]
    fn minor_negotiation_preserves_v1_0_and_caps_newer_clients() {
        assert_eq!(
            negotiate_version(ProtocolVersion { major: 1, minor: 0 }).unwrap(),
            ProtocolVersion { major: 1, minor: 0 }
        );
        assert_eq!(
            negotiate_version(ProtocolVersion { major: 1, minor: 1 }).unwrap(),
            ProtocolVersion { major: 1, minor: 1 }
        );
        assert_eq!(
            negotiate_version(ProtocolVersion {
                major: 1,
                minor: 99
            })
            .unwrap(),
            ProtocolVersion { major: 1, minor: 1 }
        );
    }

    #[test]
    fn retry_registry_never_treats_unknown_as_read() {
        assert_eq!(classify_method("session.list"), RetryClass::Read);
        assert_eq!(
            classify_method("settings.replace"),
            RetryClass::IdempotentWrite
        );
        assert_eq!(
            classify_method("session.input"),
            RetryClass::NonIdempotentWrite
        );
        assert_eq!(classify_method("future.write"), RetryClass::Unknown);
        assert!(!classify_method("future.write").allows_automatic_retry());
        // Credential backend status performs a bounded set/get/delete probe;
        // it is observably active and must never be automatically replayed.
        assert_eq!(
            classify_method("secret.status"),
            RetryClass::NonIdempotentWrite
        );
        assert!(!classify_method("secret.status").allows_automatic_retry());
        assert!(METHOD_REGISTRY
            .iter()
            .all(|method| classify_method(method) != RetryClass::Unknown));
        let unique = METHOD_REGISTRY
            .iter()
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), METHOD_REGISTRY.len());
    }

    #[test]
    fn decimal_revisions_round_trip_without_javascript_precision_loss() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "type": "request",
            "requestId": "remove",
            "method": "project.remove",
            "params": {},
            "precondition": {"revision": "18446744073709551615"}
        }))
        .unwrap();
        assert_eq!(
            request.precondition.unwrap().revision.unwrap().as_u64(),
            Some(u64::MAX)
        );
    }

    #[test]
    fn cursors_distinguish_continuity_gap_and_conflict() {
        let run = RunCursor {
            run_id: "run-1".into(),
            run_ordinal: 1,
            generation: 0,
            offset: 10,
            status_sequence: 2,
        };
        let mut next = run.clone();
        next.offset = 11;
        assert_eq!(next.relation_to(&run), CursorRelation::Continuous);
        next.generation = 1;
        assert_eq!(next.relation_to(&run), CursorRelation::Gap);
        next = run.clone();
        next.offset = 9;
        assert_eq!(next.relation_to(&run), CursorRelation::Conflict);

        let history = HistoryCursor {
            source_fingerprint: "sha256:a".into(),
            snapshot_revision: 7,
            page_sequence: 1,
            provider_cursor: Some("opaque".into()),
        };
        let mut history_next = history.clone();
        history_next.page_sequence = 2;
        assert_eq!(
            history_next.relation_to(&history),
            CursorRelation::Continuous
        );
        history_next.page_sequence = 4;
        assert_eq!(history_next.relation_to(&history), CursorRelation::Gap);
        history_next.source_fingerprint = "sha256:b".into();
        assert_eq!(history_next.relation_to(&history), CursorRelation::Conflict);
    }

    #[test]
    fn secret_dto_has_no_loggable_traits_and_round_trips_without_exposure() {
        static_assertions::assert_not_impl_any!(SecretAddParams: std::fmt::Debug, std::fmt::Display, Clone);
        static_assertions::assert_not_impl_any!(SessionInputParams: std::fmt::Debug, std::fmt::Display, Clone);
        static_assertions::assert_not_impl_any!(SessionStructuredPromptParams: std::fmt::Debug, std::fmt::Display, Clone);
        static_assertions::assert_not_impl_any!(SessionAutoTitleParams: std::fmt::Debug, std::fmt::Display, Clone);
        let parsed: SecretAddParams =
            serde_json::from_str(r#"{"envName":"TOKEN","presetId":"pre_1","value":"very-secret"}"#)
                .unwrap();
        assert_eq!(parsed.expose_value(), b"very-secret");

        let input: SessionInputParams = serde_json::from_str(
            r#"{"attachmentId":"att-1","batchId":"batch-1","dataBase64":"aGVsbG8="}"#,
        )
        .unwrap();
        assert_eq!(input.decode_data().unwrap().as_slice(), b"hello");
    }
}
