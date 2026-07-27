//! Data model — mirrors PRD chapter 5.
//!
//! Invariants that must not change (PRD 11.c):
//! - IDs, lifecycle states, resume precision, status evidence, secret boundary.
//! - Host PID is never a session identity; identity = session id + random host token
//!   verified in the socket handshake.
//! - Secrets are never stored here — only system-store references.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Top-level data model version (PRD ch.5 `version`). Bump when the schema
/// changes in a way the migrator must handle; SQLite user_version tracks the same.
pub const DATA_MODEL_VERSION: i64 = 10;
pub const APP_ID: &str = "agentport.local";
pub const DELIVERY_SCOPE: &str = "p0_p2";

/// Run identity used when reading pre-run-scoped journals and database rows.
/// It is deliberately scoped by `session_id` in SQLite, so every legacy
/// session can retain this stable compatibility value.
pub const LEGACY_RUN_ID: &str = "legacy";
pub const LEGACY_RUN_ORDINAL: i64 = 0;

pub fn legacy_run_id() -> String {
    LEGACY_RUN_ID.to_owned()
}

/// New installations retain a bounded recent-output window per Session. An
/// existing saved setting is never overwritten during upgrade.
pub const DEFAULT_LOG_LIMIT_MIB: u64 = 200;
pub const MIN_LOG_LIMIT_MIB: u64 = 20;
pub const MAX_LOG_LIMIT_MIB: u64 = 2048;
/// A cleanup job stops being scheduled after this many failed attempts.
pub const MAX_CLEANUP_JOB_ATTEMPTS: i64 = 8;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentType {
    Claude,
    Codex,
    Kimi,
    Qoder,
    Pi,
    Shell,
}

impl AgentType {
    /// Registry of every adapter compiled into this build. Keep discovery,
    /// onboarding, and CLI probing on this single list so adding an adapter
    /// does not require updating several independent fixed-size arrays.
    pub const ALL: &'static [Self] = &[
        Self::Claude,
        Self::Codex,
        Self::Kimi,
        Self::Qoder,
        Self::Pi,
        Self::Shell,
    ];

    pub const fn all() -> &'static [Self] {
        Self::ALL
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            AgentType::Claude => "claude",
            AgentType::Codex => "codex",
            AgentType::Kimi => "kimi",
            AgentType::Qoder => "qoder",
            AgentType::Pi => "pi",
            AgentType::Shell => "shell",
        }
    }
    pub fn command_names(&self) -> &'static [&'static str] {
        match self {
            AgentType::Claude => &["claude"],
            AgentType::Codex => &["codex"],
            AgentType::Kimi => &["kimi"],
            AgentType::Qoder => &["qodercli"],
            AgentType::Pi => &["pi"],
            AgentType::Shell => &["sh", "bash", "zsh"],
        }
    }
    pub fn display_name(&self) -> &'static str {
        match self {
            AgentType::Claude => "Claude Code",
            AgentType::Codex => "Codex",
            AgentType::Kimi => "Kimi Code",
            AgentType::Qoder => "Qoder",
            AgentType::Pi => "Pi",
            AgentType::Shell => "Generic Shell",
        }
    }

    pub fn approval_model(&self) -> ApprovalModel {
        match self {
            AgentType::Pi | AgentType::Shell => ApprovalModel::NoBuiltinPrompts,
            AgentType::Claude | AgentType::Codex | AgentType::Kimi | AgentType::Qoder => {
                ApprovalModel::NativePrompts
            }
        }
    }

    pub fn default_transport(&self) -> AgentTransport {
        AgentTransport::Pty
    }

    pub fn default_permission_mode(&self) -> PermissionMode {
        match self {
            AgentType::Qoder => PermissionMode::Bypass,
            _ => PermissionMode::Native,
        }
    }

    /// Generic shells have no approval protocol. Keep `Native` as the stored
    /// sentinel for compatibility, but never expose or enforce a permission
    /// mode for them.
    pub fn effective_permission_mode(&self, requested: PermissionMode) -> PermissionMode {
        match self {
            // Qoder is an AgentPort-managed full-access integration. Its
            // required capability gate lives in `permission_argv`; callers
            // cannot silently turn it into a native-prompt Session.
            AgentType::Qoder => PermissionMode::Bypass,
            AgentType::Shell | AgentType::Pi => PermissionMode::Native,
            _ => requested,
        }
    }
}

impl std::str::FromStr for AgentType {
    type Err = crate::error::CoreError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "claude" => Ok(AgentType::Claude),
            "codex" => Ok(AgentType::Codex),
            "kimi" => Ok(AgentType::Kimi),
            "qoder" => Ok(AgentType::Qoder),
            "pi" => Ok(AgentType::Pi),
            "shell" => Ok(AgentType::Shell),
            other => Err(crate::error::CoreError::Validation(format!(
                "unknown agent type: {other}"
            ))),
        }
    }
}

/// Detection state for a CLI on this machine (PRD 3.1.c).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeState {
    Undetected,
    Probing,
    Available,
    Conflict,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookStatus {
    Supported,
    Degraded,
    Unavailable,
}

impl HookStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            HookStatus::Supported => "supported",
            HookStatus::Degraded => "degraded",
            HookStatus::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalModel {
    NativePrompts,
    NoBuiltinPrompts,
}

impl ApprovalModel {
    pub fn as_str(&self) -> &'static str {
        match self {
            ApprovalModel::NativePrompts => "native_prompts",
            ApprovalModel::NoBuiltinPrompts => "no_builtin_prompts",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTransport {
    Pty,
    JsonRpc,
}

impl AgentTransport {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentTransport::Pty => "pty",
            AgentTransport::JsonRpc => "json_rpc",
        }
    }
}

impl std::str::FromStr for AgentTransport {
    type Err = crate::error::CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pty" => Ok(AgentTransport::Pty),
            "json_rpc" => Ok(AgentTransport::JsonRpc),
            other => Err(crate::error::CoreError::Validation(format!(
                "unknown agent transport: {other}"
            ))),
        }
    }
}

/// Capability snapshot for one agent type (PRD ch.5 `adaptersByType`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInstall {
    pub agent_type: AgentType,
    /// Confirmed absolute path of the executable.
    pub executable_path: String,
    /// Raw version text from the CLI (1..200 chars kept).
    pub version_text: String,
    /// sha256 digest over version+help output ("sha256:…").
    pub capability_hash: String,
    /// Supports resuming by native session id exactly.
    pub exact_resume: bool,
    pub hook_status: HookStatus,
    pub approval_model: ApprovalModel,
    pub default_transport: AgentTransport,
    pub probed_at: DateTime<Utc>,
    /// All candidate paths found during probing (for conflict resolution).
    #[serde(default)]
    pub candidates: Vec<ProbeCandidate>,
    /// Capability flags parsed from --help (flag name -> present).
    #[serde(default)]
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeCandidate {
    pub path: String,
    pub version_text: Option<String>,
    pub source: String, // system_path | login_shell_path | version_manager | well_known_dir | manual
}

// ---------------------------------------------------------------------------
// Projects / presets / secrets
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String, // prj_…
    pub name: String,
    pub root_path: String, // normalized absolute path
    pub git_root_path: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Default: keep the CLI's own approval prompts. No bypass flags added.
    Native,
    /// Explicitly user-enabled auto-approve for this preset only.
    Auto,
    /// Bypass flags (e.g. --dangerously-skip-permissions). Only via explicit
    /// user opt-in with risk confirmation; always shown in the title bar.
    Bypass,
}

impl PermissionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            PermissionMode::Native => "native",
            PermissionMode::Auto => "auto",
            PermissionMode::Bypass => "bypass",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String, // pre_…
    pub agent_type: AgentType,
    pub name: String,
    pub executable_path: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub permission_mode: PermissionMode,
    /// Plain env var names allowed to be inherited from the launching env.
    #[serde(default)]
    pub env_names: Vec<String>,
    #[serde(default)]
    pub secret_ref_ids: Vec<String>,
    #[serde(default)]
    pub built_in: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretBackend {
    MacosKeychain,
    LinuxSecretService,
}

impl SecretBackend {
    pub fn as_str(&self) -> &'static str {
        match self {
            SecretBackend::MacosKeychain => "macos_keychain",
            SecretBackend::LinuxSecretService => "linux_secret_service",
        }
    }
}

/// Secret metadata only — never the value (PRD 3.7).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    pub id: String, // sec_…
    pub env_name: String,
    pub backend: SecretBackend,
    pub service: String, // e.g. "agentport"
    pub account: String, // e.g. "pre_kimi_safe:KIMI_API_KEY" — no value
    pub updated_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Creating,
    Running,
    Interrupted,
    Exited,
    Stopped,
}

impl Lifecycle {
    pub fn as_str(&self) -> &'static str {
        match self {
            Lifecycle::Creating => "creating",
            Lifecycle::Running => "running",
            Lifecycle::Interrupted => "interrupted",
            Lifecycle::Exited => "exited",
            Lifecycle::Stopped => "stopped",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumePrecision {
    Exact,
    Latest,
    Unavailable,
}

impl ResumePrecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            ResumePrecision::Exact => "exact",
            ResumePrecision::Latest => "latest",
            ResumePrecision::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String, // ses_…
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub preset_id: String,
    pub title: String,
    pub cwd: String,
    /// Diagnostic only — never an identity (PRD ch.5 note).
    pub host_pid: Option<i64>,
    pub host_socket: Option<String>,
    /// Random per-launch token; required in socket handshake.
    #[serde(skip_serializing)] // never leaves the core/db layer
    pub host_token: String,
    pub lifecycle: Lifecycle,
    pub agent_session_id: Option<String>,
    pub resume_precision: ResumePrecision,
    pub log_path: String,
    pub adapter_type: AgentType,
    #[serde(default = "default_agent_transport")]
    pub transport: AgentTransport,
    /// Final argv used to launch (diagnostic + preflight audit). Never contains secrets.
    #[serde(default)]
    pub command: Vec<String>,
    pub permission_mode: PermissionMode,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
}

pub fn default_agent_transport() -> AgentTransport {
    AgentTransport::Pty
}

/// Persistent work required after an archived Session's database rows are
/// purged. It intentionally contains no filesystem location: workers derive
/// any cleanup target from the Session ID outside SQLite.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupJob {
    pub session_id: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    /// `None` means the bounded retry budget has been exhausted.
    pub retry_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

/// One concrete Host/Agent launch for a stable Session ID.
///
/// `run_ordinal` is monotonic within one Session. Ordinal zero is reserved for
/// the `legacy` compatibility run so a newly-created v2 run always sorts after
/// imported pre-v2 state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRun {
    pub session_id: String,
    pub run_id: String,
    pub run_ordinal: i64,
    pub created_at: DateTime<Utc>,
}

/// Position of a state transition within a Session's ordered launches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCursor {
    #[serde(default = "legacy_run_id")]
    pub run_id: String,
    #[serde(default)]
    pub run_ordinal: i64,
    #[serde(default)]
    pub sequence: i64,
}

impl Default for StatusCursor {
    fn default() -> Self {
        Self {
            run_id: legacy_run_id(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            sequence: 0,
        }
    }
}

impl StatusCursor {
    /// Ordering is session-scoped: runs are ordered first, then their local
    /// sequence. Callers must not compare cursors from different Sessions.
    pub fn is_after(&self, other: &Self) -> bool {
        self.run_ordinal > other.run_ordinal
            || (self.run_ordinal == other.run_ordinal && self.sequence > other.sequence)
    }
}

/// Position of terminal output. Log generation prevents a rotated file offset
/// from being interpreted as bytes from a later generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCursor {
    #[serde(default = "legacy_run_id")]
    pub run_id: String,
    #[serde(default)]
    pub run_ordinal: i64,
    #[serde(default)]
    pub generation: i64,
    #[serde(default)]
    pub offset: i64,
}

impl Default for LogCursor {
    fn default() -> Self {
        Self {
            run_id: legacy_run_id(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            generation: 0,
            offset: 0,
        }
    }
}

impl LogCursor {
    /// Ordering is session-scoped. A newer run always wins; positions inside
    /// one run are ordered by log generation and then byte offset.
    pub fn is_not_older_than(&self, other: &Self) -> bool {
        self.run_ordinal > other.run_ordinal
            || (self.run_ordinal == other.run_ordinal
                && self.run_id == other.run_id
                && (self.generation > other.generation
                    || (self.generation == other.generation && self.offset >= other.offset)))
    }
}

// ---------------------------------------------------------------------------
// Status evidence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Working,
    NeedsInput,
    Idle,
    Exited,
    Unknown,
}

impl AgentState {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentState::Working => "working",
            AgentState::NeedsInput => "needs_input",
            AgentState::Idle => "idle",
            AgentState::Exited => "exited",
            AgentState::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateSource {
    /// Official CLI hook / event.
    Hook,
    /// PTY-output heuristic.
    Pty,
    /// Process-level fact (exit, spawn).
    Process,
    /// Adapter-reported (e.g. session-id capture).
    Adapter,
}

impl StateSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            StateSource::Hook => "hook",
            StateSource::Pty => "pty",
            StateSource::Process => "process",
            StateSource::Adapter => "adapter",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

impl Confidence {
    pub fn as_str(&self) -> &'static str {
        match self {
            Confidence::Low => "low",
            Confidence::Medium => "medium",
            Confidence::High => "high",
        }
    }
}

/// One status transition with evidence (PRD 3.4 / 4.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub session_id: String,
    /// Host launch identity. Older journals omit this and deserialize as the
    /// reserved legacy run.
    #[serde(default = "legacy_run_id")]
    pub run_id: String,
    /// Monotonic per-Session launch ordinal. Older journals deserialize as 0.
    #[serde(default)]
    pub run_ordinal: i64,
    /// Monotonic within one run, not across Session restarts.
    pub sequence: i64,
    pub state: AgentState,
    pub source: StateSource,
    pub confidence: Confidence,
    /// Short machine-readable evidence tag, e.g. "hook:Stop", "pty:silence",
    /// "process:exit:0". Never contains secret values or raw user output.
    #[serde(default)]
    pub evidence: Option<String>,
    /// Exact retained-log position captured with this transition when the Host
    /// could observe one.  Older journals legitimately omit it; consumers must
    /// then treat the event as metadata-only rather than inventing a jump.
    #[serde(default)]
    pub log_cursor: Option<LogCursor>,
    pub occurred_at: DateTime<Utc>,
}

impl StatusEvent {
    pub fn cursor(&self) -> StatusCursor {
        StatusCursor {
            run_id: self.run_id.clone(),
            run_ordinal: self.run_ordinal,
            sequence: self.sequence,
        }
    }

    /// Generic Claude notifications (idle/push) are observable hook facts,
    /// but they are not agent state transitions. This also protects a newer
    /// GUI from legacy Hosts that still project them as `needs_input`.
    pub fn changes_session_state(&self) -> bool {
        !(self.source == StateSource::Hook && self.evidence.as_deref() == Some("hook:Notification"))
    }

    /// User-actionable semantic events shared by system notifications, unread
    /// badges and recovery surfaces. Keep this exact: generic hook
    /// notifications and process lifecycle facts are not user messages.
    pub fn attention_kind(&self) -> Option<AttentionKind> {
        let evidence = self.evidence.as_deref().unwrap_or("");
        match self.state {
            AgentState::NeedsInput
                if (self.source == StateSource::Hook && evidence == "hook:PermissionRequest")
                    || (self.source == StateSource::Pty
                        && evidence.starts_with("pty:pattern:")) =>
            {
                Some(AttentionKind::ApprovalRequested)
            }
            AgentState::Idle
                if (self.source == StateSource::Hook
                    && matches!(evidence, "hook:Stop" | "hook:TurnEnd"))
                    || (self.source == StateSource::Adapter
                        && matches!(evidence, "adapter:kimi:TurnEnd" | "adapter:pi:TurnEnd")) =>
            {
                Some(AttentionKind::TurnCompleted)
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionKind {
    ApprovalRequested,
    TurnCompleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SummaryState {
    Completed,
    Waiting,
    Failed,
    Output,
    None,
}

impl SummaryState {
    pub fn as_str(&self) -> &'static str {
        match self {
            SummaryState::Completed => "completed",
            SummaryState::Waiting => "waiting",
            SummaryState::Failed => "failed",
            SummaryState::Output => "output",
            SummaryState::None => "none",
        }
    }
}

/// Recovery summary for "while you were away" (PRD ch.5 `recoverySummaryBySession`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySummary {
    pub session_id: String,
    pub last_seen_sequence: i64,
    pub latest_sequence: i64,
    pub unread_output_offset: i64,
    pub summary_state: SummaryState,
    pub acknowledged_at: Option<DateTime<Utc>>,
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeHealth {
    Clean,
    Dirty,
    Missing,
    Locked,
}

impl WorktreeHealth {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorktreeHealth::Clean => "clean",
            WorktreeHealth::Dirty => "dirty",
            WorktreeHealth::Missing => "missing",
            WorktreeHealth::Locked => "locked",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub id: String, // wt_…
    pub project_id: String,
    pub branch: String,
    pub base_commit: String,
    /// P1: explicit base ref when the user picked one (else created from HEAD).
    #[serde(default)]
    pub base_ref: Option<String>,
    pub path: String,
    pub health: WorktreeHealth,
    pub created_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    System,
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReducedMotion {
    System,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum UiLanguage {
    #[default]
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}

impl UiLanguage {
    pub fn as_str(self) -> &'static str {
        match self {
            UiLanguage::ZhCn => "zh-CN",
            UiLanguage::EnUs => "en-US",
        }
    }

    pub fn from_code(value: &str) -> Option<Self> {
        match value {
            "zh-CN" => Some(UiLanguage::ZhCn),
            "en-US" => Some(UiLanguage::EnUs),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum CommitAiProvider {
    #[default]
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "anthropic")]
    Anthropic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitAiSettings {
    pub provider: CommitAiProvider,
    pub base_url: String,
    pub model: String,
    pub api_key_secret_ref_id: Option<String>,
}

impl Default for CommitAiSettings {
    fn default() -> Self {
        Self {
            provider: CommitAiProvider::OpenAi,
            base_url: String::new(),
            model: String::new(),
            api_key_secret_ref_id: None,
        }
    }
}

impl CommitAiSettings {
    pub fn validate(&self) -> Result<(), crate::error::CoreError> {
        use crate::error::CoreError;
        if self.base_url.len() > 2048
            || self
                .base_url
                .chars()
                .any(|value| matches!(value, '\0' | '\r' | '\n'))
        {
            return Err(CoreError::Validation(
                "commit AI base URL must be one line up to 2048 bytes".into(),
            ));
        }
        if self.model.len() > 256
            || self
                .model
                .chars()
                .any(|value| matches!(value, '\0' | '\r' | '\n'))
        {
            return Err(CoreError::Validation(
                "commit AI model must be one line up to 256 bytes".into(),
            ));
        }
        if self
            .api_key_secret_ref_id
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 256)
        {
            return Err(CoreError::Validation(
                "commit AI API key reference is invalid".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub log_limit_mib: u64,
    pub notifications_enabled: bool,
    #[serde(default)]
    pub ui_language: UiLanguage,
    pub theme: Theme,
    pub terminal_font_family: String,
    pub terminal_font_size: u32,
    /// Optional terminal emulator executable for Linux. Arguments are
    /// deliberately not accepted so this setting never becomes a shell command.
    #[serde(default)]
    pub terminal_command: String,
    pub reduced_motion: ReducedMotion,
    pub screen_reader_mode: bool,
    pub search_index_enabled: bool,
    /// Preferred order for quick-launch Agent icons. Unknown future adapters
    /// are permitted and appended by the renderer when they are discovered.
    #[serde(default)]
    pub agent_order: Vec<String>,
    /// Hard constraint: always false (PRD ch.5).
    pub telemetry_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            log_limit_mib: DEFAULT_LOG_LIMIT_MIB,
            notifications_enabled: true,
            ui_language: UiLanguage::default(),
            theme: Theme::System,
            terminal_font_family: "system-monospace".into(),
            terminal_font_size: 13,
            terminal_command: String::new(),
            reduced_motion: ReducedMotion::System,
            screen_reader_mode: false,
            search_index_enabled: true,
            agent_order: vec![
                "shell".into(),
                "codex".into(),
                "claude".into(),
                "kimi".into(),
                "qoder".into(),
                "pi".into(),
            ],
            telemetry_enabled: false,
        }
    }
}

impl Settings {
    /// Clamp/validate per PRD ranges; returns error messages for invalid fields.
    pub fn validate(&self) -> Result<(), crate::error::CoreError> {
        use crate::error::CoreError;
        if !(MIN_LOG_LIMIT_MIB..=MAX_LOG_LIMIT_MIB).contains(&self.log_limit_mib) {
            return Err(CoreError::Validation(format!(
                "log_limit_mib {} out of range {MIN_LOG_LIMIT_MIB}-{MAX_LOG_LIMIT_MIB}",
                self.log_limit_mib
            )));
        }
        if !(10..=28).contains(&self.terminal_font_size) {
            return Err(CoreError::Validation(
                "terminal_font_size out of range 10-28".into(),
            ));
        }
        if self.terminal_command.len() > 1024
            || self
                .terminal_command
                .chars()
                .any(|c| matches!(c, '\0' | '\r' | '\n'))
        {
            return Err(CoreError::Validation(
                "terminal_command must be a single executable path up to 1024 bytes".into(),
            ));
        }
        if self.telemetry_enabled {
            return Err(CoreError::Validation(
                "telemetry_enabled must always be false".into(),
            ));
        }
        if self.agent_order.iter().any(|agent| agent.trim().is_empty()) {
            return Err(CoreError::Validation(
                "agent_order cannot contain empty adapter names".into(),
            ));
        }
        let unique: std::collections::HashSet<_> = self.agent_order.iter().collect();
        if unique.len() != self.agent_order.len() {
            return Err(CoreError::Validation(
                "agent_order cannot contain duplicate adapters".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_status_event_deserializes_to_reserved_run() {
        let event: StatusEvent = serde_json::from_str(
            r#"{
                "sessionId":"ses_legacy",
                "sequence":7,
                "state":"working",
                "source":"hook",
                "confidence":"high",
                "occurredAt":"2026-07-22T00:00:00.000Z"
            }"#,
        )
        .unwrap();

        assert_eq!(event.run_id, LEGACY_RUN_ID);
        assert_eq!(event.run_ordinal, LEGACY_RUN_ORDINAL);
        assert_eq!(
            event.cursor(),
            StatusCursor {
                run_id: LEGACY_RUN_ID.into(),
                run_ordinal: LEGACY_RUN_ORDINAL,
                sequence: 7,
            }
        );
    }

    #[test]
    fn pi_defaults_to_native_pty_transport() {
        assert_eq!(AgentType::Pi.default_transport(), AgentTransport::Pty);
    }
}
