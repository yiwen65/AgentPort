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
pub const DATA_MODEL_VERSION: i64 = 1;
pub const APP_ID: &str = "agentport.local";
pub const DELIVERY_SCOPE: &str = "p0_p2";

/// New installations retain a bounded recent-output window per Session. An
/// existing saved setting is never overwritten during upgrade.
pub const DEFAULT_LOG_LIMIT_MIB: u64 = 100;
pub const MIN_LOG_LIMIT_MIB: u64 = 20;
pub const MAX_LOG_LIMIT_MIB: u64 = 2048;
pub const DEFAULT_RETENTION_DAYS: i64 = 30;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentType {
    Claude,
    Codex,
    Kimi,
    Shell,
}

impl AgentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentType::Claude => "claude",
            AgentType::Codex => "codex",
            AgentType::Kimi => "kimi",
            AgentType::Shell => "shell",
        }
    }
    pub fn command_names(&self) -> &'static [&'static str] {
        match self {
            AgentType::Claude => &["claude"],
            AgentType::Codex => &["codex"],
            AgentType::Kimi => &["kimi"],
            AgentType::Shell => &["sh", "bash", "zsh"],
        }
    }
    pub fn display_name(&self) -> &'static str {
        match self {
            AgentType::Claude => "Claude Code",
            AgentType::Codex => "Codex",
            AgentType::Kimi => "Kimi Code",
            AgentType::Shell => "Generic Shell",
        }
    }

    /// Generic shells have no approval protocol. Keep `Native` as the stored
    /// sentinel for compatibility, but never expose or enforce a permission
    /// mode for them.
    pub fn effective_permission_mode(&self, requested: PermissionMode) -> PermissionMode {
        if matches!(self, AgentType::Shell) {
            PermissionMode::Native
        } else {
            requested
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
    pub source: String, // "system_path" | "login_shell_path" | "well_known_dir" | "manual"
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
    /// Final argv used to launch (diagnostic + preflight audit). Never contains secrets.
    #[serde(default)]
    pub command: Vec<String>,
    pub permission_mode: PermissionMode,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
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
    /// Monotonic per-session sequence.
    pub sequence: i64,
    pub state: AgentState,
    pub source: StateSource,
    pub confidence: Confidence,
    /// Short machine-readable evidence tag, e.g. "hook:Stop", "pty:silence",
    /// "process:exit:0". Never contains secret values or raw user output.
    #[serde(default)]
    pub evidence: Option<String>,
    pub occurred_at: DateTime<Utc>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub log_limit_mib: u64,
    pub notifications_enabled: bool,
    pub retention_days: i64,
    pub theme: Theme,
    pub terminal_font_family: String,
    pub terminal_font_size: u32,
    pub reduced_motion: ReducedMotion,
    pub screen_reader_mode: bool,
    pub search_index_enabled: bool,
    /// Hard constraint: always false (PRD ch.5).
    pub telemetry_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            log_limit_mib: DEFAULT_LOG_LIMIT_MIB,
            notifications_enabled: true,
            retention_days: DEFAULT_RETENTION_DAYS,
            theme: Theme::System,
            terminal_font_family: "system-monospace".into(),
            terminal_font_size: 13,
            reduced_motion: ReducedMotion::System,
            screen_reader_mode: false,
            search_index_enabled: true,
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
        if !(1..=3650).contains(&self.retention_days) {
            return Err(CoreError::Validation(
                "retention_days out of range 1-3650".into(),
            ));
        }
        if !(10..=28).contains(&self.terminal_font_size) {
            return Err(CoreError::Validation(
                "terminal_font_size out of range 10-28".into(),
            ));
        }
        if self.telemetry_enabled {
            return Err(CoreError::Validation(
                "telemetry_enabled must always be false".into(),
            ));
        }
        Ok(())
    }
}
