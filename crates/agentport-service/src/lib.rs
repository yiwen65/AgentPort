//! Tauri-free application service boundary shared by desktop, CLI, and the
//! Remote Bridge. This foundation slice exposes boot/reconcile and session
//! listing without exposing Host credentials or private socket paths.

mod commit_ai;
use agentport_core::terminal_seed;

use agentport_core::adapters::{self, capability, LaunchContext, ResumeContext};
use agentport_core::db::Db;
use agentport_core::diag::Diagnostics;
use agentport_core::export::Exporter;
use agentport_core::git::{
    BranchManager, GitContextLocator, GitDiffSide, GitIgnoreTarget, GitPathSelection,
    GitRemoteAction, GitRepo, GitRunner, GitWorkspaceManager, RepositoryFileLock,
    RepositoryIdentity, RestoreStrategy, WorktreeBranchSelection, WorktreeManager,
};
use agentport_core::history::NativeHistory;
use agentport_core::host_manager::{
    write_private_file, AttachInfo, HostClient, HostManager, LaunchSpec,
};
use agentport_core::models::{
    AdapterInstall, AgentPreferencesSnapshot as CoreAgentPreferencesSnapshot, AgentTransport,
    AgentType, LogCursor, PermissionMode, Preset, Project, ProjectRemovalSession,
    ProjectRemovalSnapshot as CoreProjectRemovalSnapshot, ReducedMotion, ResumePrecision,
    SecretRef, Session, Settings, StatusEvent, TerminalTheme, Theme, UiLanguage, Worktree,
};
use agentport_core::native_cleanup::{execute_native_cleanup, plan_native_cleanup};
use agentport_core::paths::{normalize_abs, AppPaths};
use agentport_core::protocol::{normalize_host_frame, HostFrame, InputBatchAckPhase};
use agentport_core::search::SearchIndex;
use agentport_core::secrets::{load_preset_secrets, BackendStatus, CredentialBroker, SecretValue};
use agentport_core::timeline::{RecoveryAckSnapshot, Timeline};
use agentport_remote_protocol::{
    AgentPreferencesReplaceParams, AgentProbeAllParams, AgentProbeParams, AttentionPollParams,
    CommitAiConfigSaveParams, ConfirmedProjectSession, DocumentWriteParams, PresetListParams,
    ProjectAddParams, ProjectIdParams, ProjectLayoutReplaceParams, ProjectRemoveParams,
    ProjectRenameParams, RemoteAgentType, RunCursor, SecretAddParams, SecretDeleteParams,
    SessionAttachParams, SessionAutoTitleParams, SessionControlKind, SessionControlParams,
    SessionCreateParams, SessionDetachParams, SessionIdParams, SessionInputParams,
    SessionPinParams, SessionPollParams, SessionRecoveryContextParams, SessionRenameParams,
    SessionRestartParams, SessionSeenParams, SessionStopParams, SessionStructuredPromptParams,
    SessionUnreadParams, WorktreeCreateParams, WorktreeIdParams, WorktreePreviewParams,
    WorktreeProjectParams,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("AgentPort service operation was not executed")]
    NotExecutedCore(#[source] agentport_core::CoreError),
    #[error("AgentPort service operation failed")]
    Core(#[source] agentport_core::CoreError),
    #[error("remote attachment was not found")]
    AttachmentNotFound,
    #[error("remote request is invalid")]
    InvalidRequest,
    #[error("terminal input outcome is unknown")]
    InputOutcomeUnknown,
    #[error("remote attachment table is unavailable")]
    AttachmentState,
    #[error("remote response serialization failed")]
    Serialization,
    #[error("remote precondition did not match authoritative state")]
    PreconditionFailed,
    #[error("NEEDS_RISK_ACK")]
    RiskAcknowledgementRequired,
    #[error("Commit-AI operation failed: {0}")]
    CommitAi(String),
    #[error("Commit-AI request outcome is unknown")]
    CommitAiOutcomeUnknown,
}

impl From<agentport_core::CoreError> for ServiceError {
    fn from(value: agentport_core::CoreError) -> Self {
        Self::Core(value)
    }
}

pub type Result<T> = std::result::Result<T, ServiceError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCapability {
    pub name: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLimits {
    pub max_subscriptions: u32,
    pub max_host_clients: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSnapshot {
    pub capabilities: Vec<ServiceCapability>,
    pub limits: ServiceLimits,
}

impl Default for ServiceSnapshot {
    fn default() -> Self {
        Self {
            capabilities: vec![
                ServiceCapability {
                    name: "boot.read".into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: "session.read".into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: "session.attach".into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: "session.input".into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: "session.control".into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: agentport_remote_protocol::CAPABILITY_TERMINAL_GEOMETRY.into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: "session.poll".into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: agentport_remote_protocol::CAPABILITY_SESSION_EVENT_PUSH.into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: "agent.metadata".into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: "project.metadata".into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: "secret.metadata".into(),
                    enabled: true,
                    disabled_reason: None,
                },
                ServiceCapability {
                    name: "secret.write".into(),
                    enabled: true,
                    disabled_reason: None,
                },
            ],
            // Mirrors the current Host server's authenticated-client bound.
            // This remains an advertised ceiling, not a promise of FIFO input.
            limits: ServiceLimits {
                max_subscriptions: 32,
                max_host_clients: 16,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub git_root_path: Option<String>,
    pub created_at: String,
    pub pinned: bool,
    pub sort_order: i64,
}

impl From<Project> for ProjectSummary {
    fn from(project: Project) -> Self {
        Self {
            id: project.id,
            name: project.name,
            root_path: project.root_path,
            git_root_path: project.git_root_path,
            created_at: project.created_at.to_rfc3339(),
            pinned: project.pinned,
            sort_order: project.sort_order,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSummary {
    pub run_id: String,
    pub run_ordinal: i64,
    pub sequence: i64,
    pub state: String,
    pub source: String,
    pub confidence: String,
    pub occurred_at: String,
}

impl From<StatusEvent> for StatusSummary {
    fn from(status: StatusEvent) -> Self {
        Self {
            run_id: status.run_id,
            run_ordinal: status.run_ordinal,
            sequence: status.sequence,
            state: status.state.as_str().into(),
            source: status.source.as_str().into(),
            confidence: status.confidence.as_str().into(),
            occurred_at: status.occurred_at.to_rfc3339(),
        }
    }
}

/// Remote-safe Session view. It deliberately has no Host token, socket path,
/// PID, launch argv, or log path fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub preset_id: String,
    pub title: String,
    pub cwd: String,
    pub lifecycle: String,
    pub agent_session_id: Option<String>,
    pub resume_precision: String,
    pub adapter_type: String,
    pub transport: String,
    pub permission_mode: String,
    pub pinned_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub latest_status: Option<StatusSummary>,
    /// Authoritative Host handshake result, not inferred from lifecycle or
    /// status text. Active-Agent views must filter on this field.
    pub host_alive: bool,
    /// Shared semantic classifier: only approval requests and completed turns.
    pub latest_attention_kind: Option<String>,
    pub unread_attention: bool,
}

impl SessionSummary {
    fn from_projection(
        session: Session,
        latest_status: Option<StatusEvent>,
        unread_attention: bool,
        host_alive: bool,
    ) -> Self {
        let latest_attention_kind = latest_status
            .as_ref()
            .and_then(StatusEvent::attention_kind)
            .map(|kind| match kind {
                agentport_core::models::AttentionKind::ApprovalRequested => "approval_requested",
                agentport_core::models::AttentionKind::TurnCompleted => "turn_completed",
            })
            .map(str::to_owned);
        Self {
            id: session.id,
            project_id: session.project_id,
            worktree_id: session.worktree_id,
            preset_id: session.preset_id,
            title: session.title,
            cwd: session.cwd,
            lifecycle: session.lifecycle.as_str().into(),
            agent_session_id: session.agent_session_id,
            resume_precision: session.resume_precision.as_str().into(),
            adapter_type: session.adapter_type.as_str().into(),
            transport: session.transport.as_str().into(),
            permission_mode: session.permission_mode.as_str().into(),
            pinned_at: session.pinned_at.map(|value| value.to_rfc3339()),
            created_at: session.created_at.to_rfc3339(),
            updated_at: session.updated_at.to_rfc3339(),
            archived_at: session.archived_at.map(|value| value.to_rfc3339()),
            latest_status: latest_status.map(StatusSummary::from),
            host_alive,
            latest_attention_kind,
            unread_attention,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootSnapshot {
    pub reconciled_sessions: usize,
    pub service: ServiceSnapshot,
    pub projects: Vec<ProjectSummary>,
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttachResult {
    pub attachment_id: String,
    pub session_id: String,
    pub child_alive: bool,
    pub agent_session_id: Option<String>,
    /// Initial consumed position. Tail replay without an explicit resume has no
    /// cursor until its first event; the Hello high-water is not a replay start.
    pub cursor: Option<RunCursor>,
    pub features: Vec<String>,
    pub run_id: String,
    pub run_ordinal: i64,
    pub terminal_geometry: Option<agentport_core::protocol::TerminalGeometry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretAddResult {
    pub id: String,
    pub env_name: String,
    pub backend: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedAgentSummary {
    pub agent: String,
    pub display_name: String,
    pub command_names: Vec<String>,
    pub install: Option<AdapterInstall>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreferencesSnapshot {
    pub revision: u64,
    pub agent_order: Vec<String>,
    pub agent_hidden: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbeResult {
    pub agent: String,
    pub display_name: String,
    pub state: String,
    pub reason: Option<String>,
    pub reason_code: Option<String>,
    pub reason_detail: Option<String>,
    pub install: Option<AdapterInstall>,
    pub candidates: Vec<agentport_core::models::ProbeCandidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetSummary {
    pub id: String,
    pub agent: String,
    pub name: String,
    pub executable_path: String,
    pub permission_mode: String,
    pub env_names: Vec<String>,
    pub secret_ref_ids: Vec<String>,
    pub built_in: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAddResult {
    pub project: ProjectSummary,
    pub focused_existing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemovalPreflight {
    pub project_id: String,
    /// Decimal text is lossless through the mobile JavaScript boundary.
    pub revision: String,
    pub sessions: Vec<ConfirmedProjectSession>,
    pub worktree_ids: Vec<String>,
    pub recoverable_operation_ids: Vec<String>,
    pub pending_commit_operation_ids: Vec<String>,
    pub session_count: usize,
    pub active_session_count: usize,
    pub archived_session_count: usize,
    pub can_remove: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemoveResult {
    pub stop_warnings: usize,
    pub cleanup_warnings: usize,
    pub native_cleanup_warnings: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSummary {
    pub id: String,
    pub project_id: String,
    pub branch: String,
    pub base_commit: String,
    pub path: String,
    pub health: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatusSummary {
    pub health: String,
    pub modified: usize,
    pub staged: usize,
    pub untracked: usize,
    pub ignored: usize,
    pub ignored_sample: Vec<String>,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveResult {
    pub stop_warnings: usize,
    pub cleanup_warnings: usize,
    pub native_cleanup_warnings: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretBackendStatus {
    pub state: String,
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretSummary {
    pub id: String,
    pub env_name: String,
    pub backend: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStopResult {
    pub session_id: String,
    pub group_cleaned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchNoticeSummary {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLaunchResult {
    pub session_id: String,
    pub resume_precision: String,
    pub agent_session_id: Option<String>,
    pub notices: Vec<LaunchNoticeSummary>,
    /// Desktop-only launch facts. They are never serialized onto the Remote wire.
    #[serde(skip_serializing)]
    pub host_pid: u32,
    #[serde(skip_serializing)]
    pub child_alive: bool,
    #[serde(skip_serializing)]
    pub command: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryContextResult {
    pub data_base64: String,
    pub offset: u64,
    pub total: u64,
    pub cursor: RunCursor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInputResult {
    pub batch_id: String,
    pub server_sequence: u64,
    pub phase: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub event_type: String,
    pub cursor: RunCursor,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPollResult {
    pub attachment_id: String,
    pub closed: bool,
    pub events: Vec<SessionEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionControlResult {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_geometry: Option<agentport_core::protocol::TerminalGeometry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionEventSummary {
    pub session_id: String,
    pub run_id: String,
    pub kind: String,
    pub cursor: agentport_remote_protocol::AttentionCursor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionPollResult {
    pub events: Vec<AttentionEventSummary>,
    pub next_cursor: Option<agentport_remote_protocol::AttentionCursor>,
}

pub trait RemoteService {
    fn service_snapshot(&self) -> ServiceSnapshot;
    fn supported_agents(&self) -> Result<Vec<SupportedAgentSummary>> {
        Err(ServiceError::InvalidRequest)
    }
    fn probe_agent(&self, _params: AgentProbeParams) -> Result<AgentProbeResult> {
        Err(ServiceError::InvalidRequest)
    }
    fn probe_all_agents(&self, _params: AgentProbeAllParams) -> Result<Vec<AgentProbeResult>> {
        Err(ServiceError::InvalidRequest)
    }
    fn agent_preferences(&self) -> Result<AgentPreferencesSnapshot> {
        Err(ServiceError::InvalidRequest)
    }
    fn replace_agent_preferences(
        &self,
        _params: AgentPreferencesReplaceParams,
        _expected_revision: u64,
    ) -> Result<AgentPreferencesSnapshot> {
        Err(ServiceError::InvalidRequest)
    }
    fn list_presets(&self, _params: PresetListParams) -> Result<Vec<PresetSummary>> {
        Err(ServiceError::InvalidRequest)
    }
    fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        Err(ServiceError::InvalidRequest)
    }
    fn add_project(&self, _params: ProjectAddParams) -> Result<ProjectAddResult> {
        Err(ServiceError::InvalidRequest)
    }
    fn rename_project(&self, _params: ProjectRenameParams) -> Result<ProjectSummary> {
        Err(ServiceError::InvalidRequest)
    }
    fn replace_project_layout(
        &self,
        _params: ProjectLayoutReplaceParams,
    ) -> Result<Vec<ProjectSummary>> {
        Err(ServiceError::InvalidRequest)
    }
    fn project_remove_preflight(
        &self,
        _params: ProjectIdParams,
    ) -> Result<ProjectRemovalPreflight> {
        Err(ServiceError::InvalidRequest)
    }
    fn remove_project(&self, _params: ProjectRemoveParams) -> Result<ProjectRemoveResult> {
        Err(ServiceError::InvalidRequest)
    }
    fn preview_worktree(
        &self,
        _params: WorktreePreviewParams,
    ) -> Result<agentport_core::git::WorktreePreview> {
        Err(ServiceError::InvalidRequest)
    }
    fn reconcile_worktrees(&self, _params: WorktreeProjectParams) -> Result<usize> {
        Err(ServiceError::InvalidRequest)
    }
    fn create_worktree(&self, _params: WorktreeCreateParams) -> Result<WorktreeSummary> {
        Err(ServiceError::InvalidRequest)
    }
    fn list_worktrees(&self, _params: WorktreeProjectParams) -> Result<Vec<WorktreeSummary>> {
        Err(ServiceError::InvalidRequest)
    }
    fn worktree_remove_preflight(
        &self,
        _params: WorktreeIdParams,
    ) -> Result<agentport_core::git::WorktreeDeletePreflight> {
        Err(ServiceError::InvalidRequest)
    }
    fn remove_worktree(&self, _params: WorktreeIdParams) -> Result<WorktreeRemoveResult> {
        Err(ServiceError::InvalidRequest)
    }
    fn worktree_status(&self, _params: WorktreeIdParams) -> Result<WorktreeStatusSummary> {
        Err(ServiceError::InvalidRequest)
    }
    fn extended_facade(
        &self,
        _method: &str,
        _params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        Err(ServiceError::InvalidRequest)
    }
    fn save_commit_ai_config(
        &self,
        _params: CommitAiConfigSaveParams,
    ) -> Result<serde_json::Value> {
        Err(ServiceError::InvalidRequest)
    }
    fn write_document(&self, _params: DocumentWriteParams) -> Result<serde_json::Value> {
        Err(ServiceError::InvalidRequest)
    }
    fn secret_backend_status(&self) -> Result<SecretBackendStatus> {
        Err(ServiceError::InvalidRequest)
    }
    fn list_secrets(&self) -> Result<Vec<SecretSummary>> {
        Err(ServiceError::InvalidRequest)
    }
    fn delete_secret(&self, _params: SecretDeleteParams) -> Result<()> {
        Err(ServiceError::InvalidRequest)
    }
    fn boot(&self) -> Result<BootSnapshot>;
    fn list_sessions(&self, include_archived: bool) -> Result<Vec<SessionSummary>>;
    fn create_session(&self, _params: SessionCreateParams) -> Result<SessionLaunchResult> {
        Err(ServiceError::InvalidRequest)
    }
    fn restart_session(&self, _params: SessionRestartParams) -> Result<SessionLaunchResult> {
        Err(ServiceError::InvalidRequest)
    }
    fn rename_session(&self, _params: SessionRenameParams) -> Result<SessionSummary> {
        Err(ServiceError::InvalidRequest)
    }
    fn pin_session(&self, _params: SessionPinParams) -> Result<SessionSummary> {
        Err(ServiceError::InvalidRequest)
    }
    fn archive_session(&self, _params: SessionIdParams) -> Result<()> {
        Err(ServiceError::InvalidRequest)
    }
    fn unarchive_session(&self, _params: SessionIdParams) -> Result<()> {
        Err(ServiceError::InvalidRequest)
    }
    fn list_archived_sessions(&self) -> Result<Vec<SessionSummary>> {
        Err(ServiceError::InvalidRequest)
    }
    fn delete_archived_session(&self, _params: SessionIdParams) -> Result<()> {
        Err(ServiceError::InvalidRequest)
    }
    fn delete_all_archived_sessions(&self) -> Result<()> {
        Err(ServiceError::InvalidRequest)
    }
    fn session_status_history(&self, _params: SessionIdParams) -> Result<Vec<StatusSummary>> {
        Err(ServiceError::InvalidRequest)
    }
    fn mark_session_seen(&self, _params: SessionSeenParams) -> Result<()> {
        Err(ServiceError::InvalidRequest)
    }
    fn mark_session_output_unread(&self, _params: SessionUnreadParams) -> Result<()> {
        Err(ServiceError::InvalidRequest)
    }
    fn poll_attention(&self, _params: AttentionPollParams) -> Result<AttentionPollResult> {
        Err(ServiceError::InvalidRequest)
    }
    fn auto_title_session(&self, _params: SessionAutoTitleParams) -> Result<bool> {
        Err(ServiceError::InvalidRequest)
    }
    fn read_recovery_context(
        &self,
        _params: SessionRecoveryContextParams,
    ) -> Result<RecoveryContextResult> {
        Err(ServiceError::InvalidRequest)
    }
    fn attach_session(&self, params: SessionAttachParams) -> Result<SessionAttachResult>;
    /// Switches this attachment from request-driven polling to one sole Host
    /// reader. The returned bounded stream is the only event consumer.
    fn subscribe_session(&self, attachment_id: &str) -> Result<SessionSubscription>;
    fn input_session(&self, params: SessionInputParams) -> Result<SessionInputResult>;
    fn structured_prompt(&self, params: SessionStructuredPromptParams) -> Result<()>;
    fn abort_structured_turn(&self, params: SessionDetachParams) -> Result<()>;
    fn control_session(&self, params: SessionControlParams) -> Result<SessionControlResult>;
    fn poll_session(&self, params: SessionPollParams) -> Result<SessionPollResult>;
    fn detach_session(&self, params: SessionDetachParams) -> Result<()>;
    fn stop_session(&self, params: SessionStopParams) -> Result<SessionStopResult>;
    fn add_secret(&self, params: SecretAddParams) -> Result<SecretAddResult>;
}

pub struct SessionSubscription {
    pub attachment_id: String,
    receiver: mpsc::Receiver<SessionEvent>,
}

impl SessionSubscription {
    pub fn new(attachment_id: String, receiver: mpsc::Receiver<SessionEvent>) -> Self {
        Self {
            attachment_id,
            receiver,
        }
    }

    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> std::result::Result<SessionEvent, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }
}

struct Attachment {
    client: HostClient,
    cursor: RunCursor,
    replay_pending: bool,
    pending: VecDeque<SessionEvent>,
    next_input_batch_sequence: u64,
    host_exit_seen: bool,
    closed: bool,
}

struct PushAttachment {
    commands: mpsc::SyncSender<PushCommand>,
    closed: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

enum AttachmentState {
    Direct(Attachment),
    Push(PushAttachment),
    Transition,
}

type AttachmentSlot = Arc<Mutex<AttachmentState>>;

enum PushCommand {
    Input {
        params: SessionInputParams,
        reply: mpsc::SyncSender<Result<SessionInputResult>>,
    },
    StructuredPrompt {
        params: SessionStructuredPromptParams,
        reply: mpsc::SyncSender<Result<()>>,
    },
    AbortStructuredTurn {
        reply: mpsc::SyncSender<Result<()>>,
    },
    Control {
        params: SessionControlParams,
        reply: mpsc::SyncSender<Result<SessionControlResult>>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyExtendedParams {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitLocatorParams {
    locator: GitContextLocator,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitAdoptParams {
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_branch: String,
    actual_branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitChangesParams {
    locator: GitContextLocator,
    #[serde(default = "default_true")]
    include_ignored: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitDiffParams {
    locator: GitContextLocator,
    expected_status_token: String,
    side: GitDiffSide,
    path_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitHistoryParams {
    locator: GitContextLocator,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default = "default_git_history_limit")]
    limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitCommitDetailParams {
    locator: GitContextLocator,
    commit_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitCommitDiffParams {
    locator: GitContextLocator,
    commit_oid: String,
    #[serde(default)]
    parent_oid: Option<String>,
    #[serde(default)]
    path_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitPathsParams {
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    selections: Vec<GitPathSelection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitIgnoreParams {
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    selection: GitPathSelection,
    target: GitIgnoreTarget,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitFileParams {
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    selection: GitPathSelection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitRemoteParams {
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    action: GitRemoteAction,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitPrepareCommitParams {
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitCommitParams {
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_commit_token: String,
    message: String,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchProjectParams {
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchCreateParams {
    project_id: String,
    name: String,
    #[serde(default)]
    start_point: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchTargetParams {
    project_id: String,
    branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchDeleteParams {
    project_id: String,
    branch: String,
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchOperationParams {
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchRestoreParams {
    operation_id: String,
    strategy: RestoreStrategy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchAutoStashListParams {
    #[serde(default)]
    project_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchParams {
    query: String,
    #[serde(default = "default_search_limit")]
    limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSearchParams {
    session_id: String,
    query: String,
    #[serde(default = "default_session_search_limit")]
    limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryPageParams {
    session_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default = "default_history_page_limit")]
    limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyDeleteParams {
    entry_ids: Vec<String>,
    confirmed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportSessionParams {
    session_id: String,
    kind: String,
    destination: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupCreateParams {
    #[serde(default)]
    destination: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathParams {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentCreateParams {
    path: String,
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupRestoreParams {
    path: String,
    target: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimelineAckParams {
    snapshots: Vec<RecoveryAckSnapshot>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsSaveParams {
    log_limit_mib: u64,
    notifications_enabled: bool,
    #[serde(default)]
    ui_language: UiLanguage,
    theme: Theme,
    #[serde(default)]
    terminal_theme: TerminalTheme,
    terminal_font_family: String,
    terminal_font_size: u32,
    #[serde(default)]
    terminal_command: String,
    reduced_motion: ReducedMotion,
    screen_reader_mode: bool,
    search_index_enabled: bool,
    #[serde(default)]
    agent_order: Vec<String>,
    #[serde(default)]
    agent_hidden: Vec<String>,
    telemetry_enabled: bool,
}

impl From<SettingsSaveParams> for Settings {
    fn from(value: SettingsSaveParams) -> Self {
        Self {
            log_limit_mib: value.log_limit_mib,
            notifications_enabled: value.notifications_enabled,
            ui_language: value.ui_language,
            theme: value.theme,
            terminal_theme: value.terminal_theme,
            terminal_font_family: value.terminal_font_family,
            terminal_font_size: value.terminal_font_size,
            terminal_command: value.terminal_command,
            reduced_motion: value.reduced_motion,
            screen_reader_mode: value.screen_reader_mode,
            search_index_enabled: value.search_index_enabled,
            agent_order: value.agent_order,
            agent_hidden: value.agent_hidden,
            telemetry_enabled: value.telemetry_enabled,
        }
    }
}

fn default_search_limit() -> usize {
    20
}

fn default_session_search_limit() -> usize {
    1_000
}

fn default_history_page_limit() -> usize {
    agentport_core::history::DEFAULT_HISTORY_PAGE_SIZE
}

fn default_git_history_limit() -> usize {
    50
}

const PUSH_EVENT_QUEUE_CAPACITY: usize = 64;
const PUSH_COMMAND_QUEUE_CAPACITY: usize = 16;
const PUSH_READ_SLICE: Duration = Duration::from_millis(20);

pub struct CoreService {
    paths: AppPaths,
    db: Db,
    attachments: Mutex<HashMap<String, AttachmentSlot>>,
}

impl CoreService {
    pub fn open_default() -> Result<Self> {
        Self::open(AppPaths::discover()?)
    }

    pub fn open(paths: AppPaths) -> Result<Self> {
        paths.ensure_layout()?;
        let db = Db::open(&paths)?;
        db.seed_builtin_presets()?;
        Ok(Self {
            paths,
            db,
            attachments: Mutex::new(HashMap::new()),
        })
    }

    #[cfg(test)]
    fn memory() -> Result<Self> {
        Ok(Self {
            paths: AppPaths::new(
                std::env::temp_dir().join(agentport_core::ids::new_id("agentport-service-test")),
            ),
            db: Db::open_memory()?,
            attachments: Mutex::new(HashMap::new()),
        })
    }

    fn attachment_slot(&self, attachment_id: &str) -> Result<AttachmentSlot> {
        self.attachments
            .lock()
            .map_err(|_| ServiceError::AttachmentState)?
            .get(attachment_id)
            .cloned()
            .ok_or(ServiceError::AttachmentNotFound)
    }
}

impl RemoteService for CoreService {
    fn service_snapshot(&self) -> ServiceSnapshot {
        ServiceSnapshot::default()
    }

    fn supported_agents(&self) -> Result<Vec<SupportedAgentSummary>> {
        AgentType::all()
            .iter()
            .copied()
            .map(|agent| {
                Ok(SupportedAgentSummary {
                    agent: agent.as_str().into(),
                    display_name: agent.display_name().into(),
                    command_names: agent
                        .command_names()
                        .iter()
                        .map(|name| (*name).into())
                        .collect(),
                    install: self.db.get_adapter(agent)?,
                })
            })
            .collect()
    }

    fn probe_agent(&self, params: AgentProbeParams) -> Result<AgentProbeResult> {
        let agent = remote_agent_to_core(params.agent);
        let outcome =
            capability::probe_agent(agent, params.path.as_deref().map(std::path::Path::new));
        if let Some(install) = &outcome.install {
            self.db.upsert_adapter(install)?;
        }
        Ok(probe_result(agent, outcome))
    }

    fn probe_all_agents(&self, params: AgentProbeAllParams) -> Result<Vec<AgentProbeResult>> {
        let confirmed = if params.preserve_selections {
            self.db
                .list_adapters()?
                .into_iter()
                .filter_map(|install| {
                    let path = std::path::PathBuf::from(&install.executable_path);
                    path.is_file().then_some((install.agent_type, path))
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        capability::probe_all_with_confirmed_paths(&confirmed)
            .into_iter()
            .map(|outcome| {
                let agent = outcome.agent_type;
                if let Some(install) = &outcome.install {
                    self.db.upsert_adapter(install)?;
                }
                Ok(probe_result(agent, outcome))
            })
            .collect()
    }

    fn agent_preferences(&self) -> Result<AgentPreferencesSnapshot> {
        Ok(agent_preferences(self.db.load_agent_preferences()?))
    }

    fn replace_agent_preferences(
        &self,
        params: AgentPreferencesReplaceParams,
        expected_revision: u64,
    ) -> Result<AgentPreferencesSnapshot> {
        validate_agent_preference_ids(&params.agent_order)?;
        validate_agent_preference_ids(&params.agent_hidden)?;
        self.db
            .replace_agent_preferences(expected_revision, &params.agent_order, &params.agent_hidden)
            .map(agent_preferences)
            .map_err(|error| match error {
                agentport_core::CoreError::Conflict(_) => ServiceError::PreconditionFailed,
                other => ServiceError::Core(other),
            })
    }

    fn list_presets(&self, params: PresetListParams) -> Result<Vec<PresetSummary>> {
        self.db
            .list_presets(params.agent.map(remote_agent_to_core))?
            .into_iter()
            .map(preset_summary)
            .collect()
    }

    fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        Ok(self
            .db
            .list_projects()?
            .into_iter()
            .map(ProjectSummary::from)
            .collect())
    }

    fn add_project(&self, params: ProjectAddParams) -> Result<ProjectAddResult> {
        let root_path = normalize_abs(&params.path)?;
        if let Some(existing) = self.db.find_project_by_path(&root_path)? {
            return Ok(ProjectAddResult {
                project: existing.into(),
                focused_existing: true,
            });
        }
        let name = params.name.unwrap_or_else(|| {
            std::path::Path::new(&root_path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "project".into())
        });
        let project = Project {
            id: agentport_core::ids::new_id("prj"),
            name,
            root_path: root_path.clone(),
            git_root_path: GitRepo::discover(std::path::Path::new(&root_path))
                .ok()
                .map(|repo| repo.root.to_string_lossy().into_owned()),
            created_at: chrono::Utc::now(),
            pinned: false,
            sort_order: 0,
        };
        self.db.add_project(&project)?;
        Ok(ProjectAddResult {
            project: self.db.get_project(&project.id)?.into(),
            focused_existing: false,
        })
    }

    fn rename_project(&self, params: ProjectRenameParams) -> Result<ProjectSummary> {
        self.db.rename_project(&params.project_id, &params.name)?;
        self.db
            .get_project(&params.project_id)
            .map(Into::into)
            .map_err(Into::into)
    }

    fn replace_project_layout(
        &self,
        params: ProjectLayoutReplaceParams,
    ) -> Result<Vec<ProjectSummary>> {
        let entries = params
            .entries
            .into_iter()
            .map(|entry| agentport_core::models::ProjectLayoutEntry {
                id: entry.project_id,
                pinned: entry.pinned,
            })
            .collect::<Vec<_>>();
        self.db.set_project_layout(&entries)?;
        self.list_projects()
    }

    fn project_remove_preflight(&self, params: ProjectIdParams) -> Result<ProjectRemovalPreflight> {
        project_preflight(self.db.project_removal_snapshot(&params.project_id)?)
    }

    fn remove_project(&self, params: ProjectRemoveParams) -> Result<ProjectRemoveResult> {
        let expected = core_project_snapshot(params)?;
        self.db
            .begin_project_removal_confirmed(&expected)
            .map_err(|_| ServiceError::PreconditionFailed)?;
        let sessions = expected
            .sessions
            .iter()
            .map(|session| self.db.get_session(&session.id))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let native_plans = sessions
            .iter()
            .map(|session| plan_native_cleanup(&self.paths, session))
            .collect::<Vec<_>>();
        for session in &sessions {
            if let Err(stop_error) = (HostManager {
                paths: &self.paths,
                db: &self.db,
            })
            .stop(&session.id, 3_000)
            {
                // `HostManager::stop` failing means process-group cleanup was
                // not authoritatively proven. Preserve Session/Project
                // authority and every file/DB row; only release the temporary
                // cross-process fence so the user can reconcile and retry.
                self.db.cancel_project_removal(&expected.project_id)?;
                return Err(ServiceError::Core(stop_error));
            }
        }
        let manager = WorktreeManager {
            paths: &self.paths,
            db: &self.db,
        };
        let mut cleanup_warnings = 0;
        for worktree_id in &expected.worktree_ids {
            match manager.remove(worktree_id) {
                Ok(outcome) => cleanup_warnings += outcome.cleanup_warnings,
                Err(_) => cleanup_warnings += 1,
            }
        }
        self.db.remove_project(&expected.project_id)?;
        let native_cleanup_warnings = native_plans
            .iter()
            .filter(|plan| execute_native_cleanup(plan).has_failures())
            .count();
        cleanup_confirmed_sessions(&self.paths, &self.db, &expected.sessions);
        Ok(ProjectRemoveResult {
            stop_warnings: 0,
            cleanup_warnings,
            native_cleanup_warnings,
        })
    }

    fn preview_worktree(
        &self,
        params: WorktreePreviewParams,
    ) -> Result<agentport_core::git::WorktreePreview> {
        WorktreeManager {
            paths: &self.paths,
            db: &self.db,
        }
        .preview(&params.project_id, &params.task)
        .map_err(Into::into)
    }

    fn reconcile_worktrees(&self, params: WorktreeProjectParams) -> Result<usize> {
        WorktreeManager {
            paths: &self.paths,
            db: &self.db,
        }
        .reconcile_owned_worktrees(&params.project_id)
        .map_err(Into::into)
    }

    fn create_worktree(&self, params: WorktreeCreateParams) -> Result<WorktreeSummary> {
        let manager = WorktreeManager {
            paths: &self.paths,
            db: &self.db,
        };
        let worktree = match params.branch_mode.as_deref() {
            Some(mode) => manager.create_selected(
                &params.project_id,
                &params.task,
                params.base_ref.as_deref(),
                parse_worktree_branch_selection(
                    mode,
                    params.branch.as_deref(),
                    params.expected_branch_oid.as_deref(),
                )?,
            ),
            None => manager.create(
                &params.project_id,
                &params.task,
                params.base_ref.as_deref(),
                params.branch.as_deref(),
            ),
        }?;
        Ok(worktree_summary(worktree))
    }

    fn list_worktrees(&self, params: WorktreeProjectParams) -> Result<Vec<WorktreeSummary>> {
        let manager = WorktreeManager {
            paths: &self.paths,
            db: &self.db,
        };
        let mut result = Vec::new();
        for worktree in self.db.list_worktrees(&params.project_id)? {
            let _ = manager.refresh_health(&worktree.id);
            result.push(worktree_summary(self.db.get_worktree(&worktree.id)?));
        }
        Ok(result)
    }

    fn worktree_remove_preflight(
        &self,
        params: WorktreeIdParams,
    ) -> Result<agentport_core::git::WorktreeDeletePreflight> {
        WorktreeManager {
            paths: &self.paths,
            db: &self.db,
        }
        .deletion_preflight(&params.worktree_id)
        .map_err(Into::into)
    }

    fn remove_worktree(&self, params: WorktreeIdParams) -> Result<WorktreeRemoveResult> {
        self.db.begin_worktree_removal(&params.worktree_id)?;
        let sessions = self
            .db
            .list_sessions(None, true)?
            .into_iter()
            .filter(|session| session.worktree_id.as_deref() == Some(&params.worktree_id))
            .collect::<Vec<_>>();
        let native_plans = sessions
            .iter()
            .map(|session| plan_native_cleanup(&self.paths, session))
            .collect::<Vec<_>>();
        for session in &sessions {
            if let Err(error) = (HostManager {
                paths: &self.paths,
                db: &self.db,
            })
            .stop(&session.id, 3_000)
            {
                self.db.cancel_worktree_removal(&params.worktree_id)?;
                return Err(error.into());
            }
        }
        let outcome = (WorktreeManager {
            paths: &self.paths,
            db: &self.db,
        })
        .remove_after_fence(&params.worktree_id)?;
        let native_cleanup_warnings = native_plans
            .iter()
            .filter(|plan| execute_native_cleanup(plan).has_failures())
            .count();
        let session_ids = sessions
            .into_iter()
            .map(|session| session.id)
            .collect::<Vec<_>>();
        cleanup_session_ids(&self.paths, &self.db, &session_ids);
        Ok(WorktreeRemoveResult {
            stop_warnings: 0,
            cleanup_warnings: outcome.cleanup_warnings,
            native_cleanup_warnings,
        })
    }

    fn worktree_status(&self, params: WorktreeIdParams) -> Result<WorktreeStatusSummary> {
        let manager = WorktreeManager {
            paths: &self.paths,
            db: &self.db,
        };
        let health = manager.refresh_health(&params.worktree_id)?;
        let summary = manager.dirty_summary(&params.worktree_id)?;
        Ok(WorktreeStatusSummary {
            health: health.as_str().into(),
            modified: summary.modified,
            staged: summary.staged,
            untracked: summary.untracked,
            ignored: summary.ignored,
            ignored_sample: summary.ignored_sample,
            raw: summary.raw,
        })
    }

    fn extended_facade(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let manager = GitWorkspaceManager::new_with_paths(&self.db, &self.paths);
        let value = match method {
            "git.context.resolve" => {
                let params: GitLocatorParams = parse_extended(params)?;
                serialize_extended(manager.resolve(&params.locator)?)?
            }
            "git.worktree.branch.adopt" => {
                let params: GitAdoptParams = parse_extended(params)?;
                manager.adopt_current_worktree_branch(
                    &params.locator,
                    &params.expected_checkout_id,
                    &params.expected_branch,
                    &params.actual_branch,
                )?;
                serialize_extended(manager.changes(&params.locator, true)?)?
            }
            "git.changes" => {
                let params: GitChangesParams = parse_extended(params)?;
                serialize_extended(manager.changes(&params.locator, params.include_ignored)?)?
            }
            "git.diff" => {
                let params: GitDiffParams = parse_extended(params)?;
                serialize_extended(manager.diff(
                    &params.locator,
                    &params.expected_status_token,
                    params.side,
                    &params.path_token,
                )?)?
            }
            "git.history" => {
                let params: GitHistoryParams = parse_extended(params)?;
                serialize_extended(manager.history(
                    &params.locator,
                    params.cursor.as_deref(),
                    params.limit.min(200),
                )?)?
            }
            "git.commit.detail" => {
                let params: GitCommitDetailParams = parse_extended(params)?;
                serialize_extended(manager.commit_detail(&params.locator, &params.commit_oid)?)?
            }
            "git.commit.diff" => {
                let params: GitCommitDiffParams = parse_extended(params)?;
                serialize_extended(manager.commit_diff(
                    &params.locator,
                    &params.commit_oid,
                    params.parent_oid.as_deref(),
                    params.path_token.as_deref(),
                )?)?
            }
            "git.stage" => {
                let params: GitPathsParams = parse_extended(params)?;
                serialize_extended(manager.stage_paths(
                    &params.locator,
                    &params.expected_checkout_id,
                    &params.expected_status_token,
                    &params.selections,
                )?)?
            }
            "git.unstage" => {
                let params: GitPathsParams = parse_extended(params)?;
                serialize_extended(manager.unstage_paths(
                    &params.locator,
                    &params.expected_checkout_id,
                    &params.expected_status_token,
                    &params.selections,
                )?)?
            }
            "git.discard" => {
                let params: GitPathsParams = parse_extended(params)?;
                serialize_extended(manager.discard_paths(
                    &params.locator,
                    &params.expected_checkout_id,
                    &params.expected_status_token,
                    &params.selections,
                )?)?
            }
            "git.ignore" => {
                let params: GitIgnoreParams = parse_extended(params)?;
                serialize_extended(manager.ignore_path(
                    &params.locator,
                    &params.expected_checkout_id,
                    &params.expected_status_token,
                    &params.selection,
                    params.target,
                )?)?
            }
            "git.trash" => {
                let params: GitFileParams = parse_extended(params)?;
                serialize_extended(manager.trash_path(
                    &params.locator,
                    &params.expected_checkout_id,
                    &params.expected_status_token,
                    &params.selection,
                    move_to_system_trash,
                )?)?
            }
            "git.file.resolve" => {
                let params: GitFileParams = parse_extended(params)?;
                serialize_extended(manager.resolve_file(
                    &params.locator,
                    &params.expected_checkout_id,
                    &params.expected_status_token,
                    &params.selection,
                )?)?
            }
            "git.remote.sync" => {
                let params: GitRemoteParams = parse_extended(params)?;
                serialize_extended(manager.sync_remote(
                    &params.locator,
                    &params.expected_checkout_id,
                    &params.expected_status_token,
                    params.action,
                )?)?
            }
            "git.commit.prepare" => {
                let params: GitPrepareCommitParams = parse_extended(params)?;
                serialize_extended(manager.prepare_commit(
                    &params.locator,
                    &params.expected_checkout_id,
                    &params.expected_status_token,
                    &params.message,
                )?)?
            }
            "git.commit.execute" => {
                let params: GitCommitParams = parse_extended(params)?;
                serialize_extended(manager.commit_changes(
                    &params.locator,
                    &params.expected_checkout_id,
                    &params.expected_commit_token,
                    &params.message,
                )?)?
            }
            "git.commit.reconcile" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                serialize_extended(manager.reconcile_commit_operations()?)?
            }
            "branch.status" | "branch.list" => {
                let params: BranchProjectParams = parse_extended(params)?;
                let manager = BranchManager::new(&self.db);
                serialize_extended(manager.list(&params.project_id)?)?
            }
            "branch.create" => {
                let params: BranchCreateParams = parse_extended(params)?;
                let manager = BranchManager::new(&self.db);
                serialize_extended(manager.create(
                    &params.project_id,
                    &params.name,
                    params.start_point.as_deref(),
                )?)?
            }
            "branch.create_switch" => {
                let params: BranchCreateParams = parse_extended(params)?;
                let manager = BranchManager::new(&self.db);
                serialize_extended(manager.create_and_switch(
                    &params.project_id,
                    &params.name,
                    params.start_point.as_deref(),
                )?)?
            }
            "branch.switch" => {
                let params: BranchTargetParams = parse_extended(params)?;
                let manager = BranchManager::new(&self.db);
                serialize_extended(manager.switch(&params.project_id, &params.branch)?)?
            }
            "branch.delete" => {
                let params: BranchDeleteParams = parse_extended(params)?;
                let manager = BranchManager::new(&self.db);
                let outcome = if params.force {
                    manager.delete_forced(&params.project_id, &params.branch)?
                } else {
                    manager.delete(&params.project_id, &params.branch)?
                };
                serialize_extended(outcome)?
            }
            "branch.autostash.list" => {
                let params: BranchAutoStashListParams = parse_extended(params)?;
                let project_ids = match params.project_id {
                    Some(project_id) => vec![project_id],
                    None => self
                        .db
                        .list_projects()?
                        .into_iter()
                        .map(|project| project.id)
                        .collect(),
                };
                let manager = BranchManager::new(&self.db);
                let mut stashes = Vec::new();
                for project_id in project_ids {
                    match manager.reconcile(&project_id) {
                        Ok(_) => {}
                        Err(agentport_core::CoreError::NotFound(_)) => continue,
                        Err(error) => return Err(error.into()),
                    }
                    stashes.extend(manager.list_auto_stashes(&project_id)?);
                }
                serialize_extended(stashes)?
            }
            "branch.autostash.restore" => {
                let params: BranchRestoreParams = parse_extended(params)?;
                let manager = BranchManager::new(&self.db);
                serialize_extended(manager.recover(&params.operation_id, params.strategy)?)?
            }
            "branch.autostash.cleanup" => {
                let params: BranchOperationParams = parse_extended(params)?;
                let manager = BranchManager::new(&self.db);
                serialize_extended(manager.cleanup(&params.operation_id)?)?
            }
            "commit_ai.config.get" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                serialize_extended(commit_ai::config(&self.db)?)?
            }
            "commit_ai.key.clear" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                serialize_extended(commit_ai::clear_key(&self.db)?)?
            }
            "commit_ai.generate" => {
                let params: commit_ai::GenerateParams = parse_extended(params)?;
                serialize_extended(commit_ai::generate(&self.paths, &self.db, params)?)?
            }
            "search.global" => {
                let params: SearchParams = parse_extended(params)?;
                search_all(&self.paths, &self.db, params.query, params.limit.min(1_000))?
            }
            "search.session" => {
                let params: SessionSearchParams = parse_extended(params)?;
                let session = self.db.get_session(&params.session_id)?;
                let result = NativeHistory::new(&self.paths).search_session(
                    &session,
                    &params.query,
                    params.limit.min(1_000),
                )?;
                serde_json::json!({
                    "partial": false,
                    "totalHits": result.total_hits,
                    "sourceStatus": result.source_status,
                    "hits": result.hits.iter().map(|hit| serde_json::json!({
                        "kind": "terminal",
                        "sessionId": hit.session_id,
                        "projectId": session.project_id,
                        "title": session.title,
                        "snippet": hit.snippet,
                        "eventId": hit.event.id,
                        "provider": hit.event.provider,
                        "logOffset": serde_json::Value::Null,
                        "rotatedAway": false,
                    })).collect::<Vec<_>>(),
                })
            }
            "history.page" => {
                let params: HistoryPageParams = parse_extended(params)?;
                let session = self.db.get_session(&params.session_id)?;
                serialize_extended(NativeHistory::new(&self.paths).page(
                    &session,
                    params.cursor.as_deref(),
                    params.limit.min(1_000),
                )?)?
            }
            "storage.legacy.inventory" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                let sessions = self.db.list_sessions(None, true)?;
                serialize_extended(agentport_core::legacy_logs::inventory(
                    &self.paths,
                    &sessions,
                )?)?
            }
            "storage.legacy.delete" => {
                let params: LegacyDeleteParams = parse_extended(params)?;
                let sessions = self.db.list_sessions(None, true)?;
                serialize_extended(agentport_core::legacy_logs::delete_selected(
                    &self.paths,
                    &sessions,
                    &params.entry_ids,
                    params.confirmed,
                )?)?
            }
            "search.index.rebuild" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                SearchIndex {
                    db: &self.db,
                    paths: &self.paths,
                }
                .purge_transcript_bodies()?;
                serde_json::json!({})
            }
            "timeline.get" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                let timeline = Timeline { db: &self.db }.build_and_acknowledge_hidden_only()?;
                serde_json::json!({
                    "completed": timeline.completed,
                    "waiting": timeline.waiting,
                    "failed": timeline.failed,
                    "entries": timeline.entries,
                    "ackSnapshots": timeline.ack_snapshots,
                })
            }
            "timeline.ack" => {
                let params: TimelineAckParams = parse_extended(params)?;
                Timeline { db: &self.db }.acknowledge_snapshot(&params.snapshots)?;
                serde_json::json!({})
            }
            "settings.get" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                serialize_extended(self.db.load_settings()?)?
            }
            "settings.save" => {
                let params: SettingsSaveParams = parse_extended(params)?;
                self.db.save_settings(&params.into())?;
                serde_json::json!({})
            }
            "diagnostics.hosts" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                serialize_extended(
                    Diagnostics {
                        paths: &self.paths,
                        db: &self.db,
                    }
                    .host_list()?,
                )?
            }
            "diagnostics.summary" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                serialize_extended(
                    Diagnostics {
                        paths: &self.paths,
                        db: &self.db,
                    }
                    .copyable_summary()?,
                )?
            }
            "diagnostics.capabilities" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                let encoded = Diagnostics {
                    paths: &self.paths,
                    db: &self.db,
                }
                .adapter_capabilities_json()?;
                serde_json::from_str(&encoded).map_err(|_| ServiceError::Serialization)?
            }
            "export.session" => {
                let params: ExportSessionParams = parse_extended(params)?;
                let destination = absolute_path(&params.destination)?;
                let path = match params.kind.as_str() {
                    "md" | "json" => {
                        let session = self.db.get_session(&params.session_id)?;
                        NativeHistory::new(&self.paths).export(
                            &session,
                            destination,
                            &params.kind,
                        )?
                    }
                    "zip" => Exporter {
                        paths: &self.paths,
                        db: &self.db,
                    }
                    .export_diagnostics_zip(
                        &[params.session_id],
                        destination,
                        &load_all_secret_values(&self.db),
                    )?,
                    _ => return Err(ServiceError::InvalidRequest),
                };
                serialize_extended(path.to_string_lossy().into_owned())?
            }
            "backup.create" => {
                let params: BackupCreateParams = parse_extended(params)?;
                let destination = match params.destination {
                    Some(path) if !path.trim().is_empty() => absolute_path(&path)?.to_path_buf(),
                    _ => self.paths.backups_dir().join(format!(
                        "agentport-backup-{}.zip",
                        chrono::Utc::now().format("%Y%m%d-%H%M%S")
                    )),
                };
                let report = agentport_core::backup::create(&self.paths, &self.db, &destination)?;
                agentport_core::backup::verify(&destination)?;
                serde_json::json!({
                    "path": destination,
                    "files": report.files,
                    "bytes": report.bytes,
                    "verified": true,
                    "nativeCoverage": report.native_coverage,
                })
            }
            "backup.list" => {
                let _: EmptyExtendedParams = parse_extended(params)?;
                backup_list(&self.paths)
            }
            "backup.verify" => {
                let params: PathParams = parse_extended(params)?;
                let manifest = agentport_core::backup::verify(absolute_path(&params.path)?)?;
                serde_json::json!({
                    "ok": true,
                    "formatVersion": manifest.format_version,
                    "createdAt": manifest.created_at,
                    "dataModelVersion": manifest.data_model_version,
                    "files": manifest.files.len(),
                    "nativeCoverage": manifest.native_coverage,
                })
            }
            "backup.restore" => {
                let params: BackupRestoreParams = parse_extended(params)?;
                if params.target.trim().is_empty() {
                    return Err(ServiceError::InvalidRequest);
                }
                let live = self.paths.root();
                let target = absolute_path(&params.target)?.to_path_buf();
                if target == live || target.starts_with(live) || live.starts_with(&target) {
                    return Err(ServiceError::InvalidRequest);
                }
                let previous =
                    agentport_core::backup::restore(absolute_path(&params.path)?, &target)?;
                serde_json::json!({"restored": target, "previousKeptAt": previous})
            }
            "document.read" => {
                let params: PathParams = parse_extended(params)?;
                read_document(&params.path)?
            }
            "document.list" => {
                let params: PathParams = parse_extended(params)?;
                list_document_directory(&params.path)?
            }
            "document.create" => {
                let params: DocumentCreateParams = parse_extended(params)?;
                create_document_entry(&params.path, &params.kind)?
            }
            _ => return Err(ServiceError::InvalidRequest),
        };
        Ok(value)
    }

    fn save_commit_ai_config(&self, params: CommitAiConfigSaveParams) -> Result<serde_json::Value> {
        serialize_extended(commit_ai::save(&self.db, params)?)
    }

    fn write_document(&self, params: DocumentWriteParams) -> Result<serde_json::Value> {
        write_document(&params.path, params.expose_content())
    }

    fn secret_backend_status(&self) -> Result<SecretBackendStatus> {
        let (state, backend, reason) = match CredentialBroker::backend_status() {
            BackendStatus::Available(backend) => ("available", Some(backend.as_str().into()), None),
            BackendStatus::Locked(backend) => ("locked", Some(backend.as_str().into()), None),
            BackendStatus::Unavailable(reason) => ("unavailable", None, Some(reason)),
        };
        Ok(SecretBackendStatus {
            state: state.into(),
            backend,
            reason,
        })
    }

    fn list_secrets(&self) -> Result<Vec<SecretSummary>> {
        Ok(self
            .db
            .list_secret_refs()?
            .into_iter()
            .map(|secret| SecretSummary {
                id: secret.id,
                env_name: secret.env_name,
                backend: secret.backend.as_str().into(),
                updated_at: secret.updated_at.to_rfc3339(),
            })
            .collect())
    }

    fn delete_secret(&self, params: SecretDeleteParams) -> Result<()> {
        let secret = self.db.get_secret_ref(&params.id)?;
        let broker = CredentialBroker::detect()?;
        broker.delete(&secret)?;
        self.db.delete_secret_ref_everywhere(&params.id)?;
        Ok(())
    }

    fn boot(&self) -> Result<BootSnapshot> {
        let manager = HostManager {
            paths: &self.paths,
            db: &self.db,
        };
        let reconciled_sessions = manager.reconcile_on_startup()?.len();
        let projects = self
            .db
            .list_projects()?
            .into_iter()
            .map(ProjectSummary::from)
            .collect();
        let sessions = self.list_sessions(false)?;
        Ok(BootSnapshot {
            reconciled_sessions,
            service: self.service_snapshot(),
            projects,
            sessions,
        })
    }

    fn list_sessions(&self, include_archived: bool) -> Result<Vec<SessionSummary>> {
        let manager = HostManager {
            paths: &self.paths,
            db: &self.db,
        };
        self.db
            .list_session_projections(include_archived)?
            .into_iter()
            .map(|projection| {
                let host_alive = manager.is_alive(&projection.session.id);
                Ok(SessionSummary::from_projection(
                    projection.session,
                    projection.latest_status,
                    projection.unread_attention,
                    host_alive,
                ))
            })
            .collect()
    }

    fn create_session(&self, params: SessionCreateParams) -> Result<SessionLaunchResult> {
        let agent = remote_agent_to_core(params.agent);
        let permission = parse_permission(&params.permission)?;
        let mode = agent.effective_permission_mode(permission);
        if permission_requires_risk_ack(mode) && !params.risk_ack {
            return Err(ServiceError::RiskAcknowledgementRequired);
        }
        let transport = params
            .transport
            .as_deref()
            .map(str::parse)
            .transpose()
            .map_err(ServiceError::NotExecutedCore)?
            .unwrap_or_else(|| agent.default_transport());
        let project = self
            .db
            .get_project(&params.project_id)
            .map_err(ServiceError::NotExecutedCore)?;
        let (plan, preset, cwd, session_id) = build_launch_plan(
            self,
            &params.project_id,
            agent,
            params.preset_id,
            params.worktree_id.clone(),
            mode,
            transport,
            params.extra_args,
        )
        .map_err(ServiceError::NotExecutedCore)?;
        let repository_lock = match acquire_session_repository_lock(&cwd) {
            Ok(lock) => lock,
            Err(error) => {
                let _ = std::fs::remove_dir_all(self.paths.session_dir(&session_id));
                return Err(ServiceError::NotExecutedCore(error));
            }
        };
        let (env, secrets) = match materialize_launch_environment(self, &preset, &plan.env) {
            Ok(values) => values,
            Err(error) => {
                let _ = std::fs::remove_dir_all(self.paths.session_dir(&session_id));
                return Err(ServiceError::NotExecutedCore(error));
            }
        };
        let settings = match self.db.load_settings() {
            Ok(settings) => settings,
            Err(error) => {
                let _ = std::fs::remove_dir_all(self.paths.session_dir(&session_id));
                return Err(ServiceError::NotExecutedCore(error));
            }
        };
        let (title, auto_title_pending) = match params.title.map(|value| value.trim().to_string()) {
            Some(value) if !value.is_empty() => (value, false),
            _ => match self.db.next_default_session_title(&project.id, agent) {
                Ok(title) => (title, true),
                Err(error) => {
                    let _ = std::fs::remove_dir_all(self.paths.session_dir(&session_id));
                    return Err(ServiceError::NotExecutedCore(error));
                }
            },
        };
        if let Err(error) = write_launch_helpers(&plan.helper_files) {
            let _ = std::fs::remove_dir_all(self.paths.session_dir(&session_id));
            return Err(ServiceError::NotExecutedCore(error));
        }
        let now = chrono::Utc::now();
        let session = Session {
            id: session_id.clone(),
            project_id: project.id,
            worktree_id: params.worktree_id,
            preset_id: preset.id,
            title,
            cwd,
            host_pid: None,
            host_socket: Some(
                self.paths
                    .socket_path(&session_id)
                    .to_string_lossy()
                    .into_owned(),
            ),
            host_token: agentport_core::ids::new_host_token(),
            lifecycle: agentport_core::models::Lifecycle::Creating,
            agent_session_id: plan.assigned_agent_session_id.clone(),
            resume_precision: if plan.assigned_agent_session_id.is_some() {
                ResumePrecision::Exact
            } else {
                plan.resume_precision
            },
            log_path: self
                .paths
                .log_path(&session_id)
                .to_string_lossy()
                .into_owned(),
            adapter_type: agent,
            transport: plan.transport,
            pinned_at: None,
            command: plan.argv.clone(),
            permission_mode: mode,
            created_at: now,
            updated_at: now,
            archived_at: None,
        };
        if let Err(error) = self.db.insert_session(&session) {
            remove_launch_helpers(&plan.helper_files);
            let _ = std::fs::remove_dir_all(self.paths.session_dir(&session_id));
            return Err(ServiceError::NotExecutedCore(error));
        }
        drop(repository_lock);
        if auto_title_pending {
            if let Err(error) = self.db.mark_session_title_auto_generated(&session_id) {
                let _ = self.db.update_session_lifecycle(
                    &session_id,
                    agentport_core::models::Lifecycle::Exited,
                );
                remove_launch_helpers(&plan.helper_files);
                return Err(error.into());
            }
        }
        let info = match (HostManager {
            paths: &self.paths,
            db: &self.db,
        })
        .launch(LaunchSpec {
            session: session.clone(),
            command: plan.argv.clone(),
            env,
            secrets,
            log_limit_bytes: settings.log_limit_mib * 1024 * 1024,
            agent_session_id_hint: plan.assigned_agent_session_id.clone(),
            cols: params.cols.unwrap_or(120),
            rows: params.rows.unwrap_or(32),
        }) {
            Ok(info) => info,
            Err(error) => {
                remove_launch_helpers(&plan.helper_files);
                return Err(error.into());
            }
        };
        Ok(session_launch_result(
            session_id,
            session.resume_precision,
            session.agent_session_id,
            &plan,
            info.host_pid,
            info.child_alive,
        ))
    }

    fn restart_session(&self, params: SessionRestartParams) -> Result<SessionLaunchResult> {
        let initial = self
            .db
            .get_session(&params.session_id)
            .map_err(ServiceError::NotExecutedCore)?;
        if initial.archived_at.is_some() {
            return Err(ServiceError::InvalidRequest);
        }
        let repository_lock =
            acquire_session_repository_lock(&initial.cwd).map_err(ServiceError::NotExecutedCore)?;
        // Mobile receives Host Exit directly, before a desktop reaper may
        // update the DB. Reconcile matching durable exit/PID evidence before
        // testing lifecycle; a socket failure alone must not permit Restart.
        (HostManager { paths: &self.paths, db: &self.db })
            .reconcile_session_liveness(&params.session_id)
            .map_err(ServiceError::NotExecutedCore)?;
        let session = self
            .db
            .get_session(&params.session_id)
            .map_err(ServiceError::NotExecutedCore)?;
        if session.archived_at.is_some()
            || matches!(
                session.lifecycle,
                agentport_core::models::Lifecycle::Running
                    | agentport_core::models::Lifecycle::Creating
            )
        {
            return Err(ServiceError::PreconditionFailed);
        }
        let permission = session
            .adapter_type
            .effective_permission_mode(session.permission_mode);
        if permission_requires_risk_ack(permission) && !params.risk_ack {
            return Err(ServiceError::RiskAcknowledgementRequired);
        }
        let install =
            install_for(self, session.adapter_type).map_err(ServiceError::NotExecutedCore)?;
        let preset = preset_for(
            self,
            session.adapter_type,
            Some(session.preset_id.clone()),
            &install,
        )
        .map_err(ServiceError::NotExecutedCore)?;
        adapters::validate_user_args(session.adapter_type, &preset.args)
            .map_err(ServiceError::NotExecutedCore)?;
        let mut plan = adapters::adapter_for(session.adapter_type)
            .build_resume_checked(&ResumeContext {
                install,
                preset: preset.clone(),
                permission_mode: session.permission_mode,
                cwd: session.cwd.clone(),
                agent_session_id: session.agent_session_id.clone(),
                session_id: session.id.clone(),
                hook_events_path: self
                    .paths
                    .hook_events_path(&session.id)
                    .to_string_lossy()
                    .into_owned(),
                session_dir: self
                    .paths
                    .session_dir(&session.id)
                    .to_string_lossy()
                    .into_owned(),
                transport: session.transport,
            })
            .map_err(ServiceError::NotExecutedCore)?;
        if session.adapter_type == AgentType::Pi {
            agentport_core::pi_storage::prepare_launch(&self.paths, &session.id, &mut plan)
                .map_err(ServiceError::NotExecutedCore)?;
        }
        let (env, secrets) = materialize_launch_environment(self, &preset, &plan.env)
            .map_err(ServiceError::NotExecutedCore)?;
        let settings = self
            .db
            .load_settings()
            .map_err(ServiceError::NotExecutedCore)?;
        write_launch_helpers(&plan.helper_files).map_err(ServiceError::NotExecutedCore)?;
        let new_token = agentport_core::ids::new_host_token();
        if let Err(error) = self.db.set_session_token(&params.session_id, &new_token) {
            remove_launch_helpers(&plan.helper_files);
            return Err(ServiceError::NotExecutedCore(error));
        }
        let mut renewed = self.db.get_session(&params.session_id)?;
        renewed.host_socket = Some(
            self.paths
                .socket_path(&params.session_id)
                .to_string_lossy()
                .into_owned(),
        );
        renewed.lifecycle = agentport_core::models::Lifecycle::Creating;
        let info = match (HostManager {
            paths: &self.paths,
            db: &self.db,
        })
        .launch(LaunchSpec {
            session: renewed,
            command: plan.argv.clone(),
            env,
            secrets,
            log_limit_bytes: settings.log_limit_mib * 1024 * 1024,
            agent_session_id_hint: plan.assigned_agent_session_id.clone(),
            cols: 120,
            rows: 32,
        }) {
            Ok(info) => info,
            Err(error) => {
                remove_launch_helpers(&plan.helper_files);
                return Err(error.into());
            }
        };
        drop(repository_lock);
        if let Some(native) = &plan.assigned_agent_session_id {
            if session.agent_session_id.as_deref() != Some(native.as_str()) {
                self.db.update_session_agent_id(
                    &params.session_id,
                    native,
                    plan.resume_precision,
                )?;
            }
        }
        Ok(session_launch_result(
            params.session_id,
            plan.resume_precision,
            plan.assigned_agent_session_id
                .clone()
                .or(session.agent_session_id),
            &plan,
            info.host_pid,
            info.child_alive,
        ))
    }

    fn rename_session(&self, params: SessionRenameParams) -> Result<SessionSummary> {
        self.db.rename_session(&params.session_id, &params.title)?;
        session_summary(&self.paths, &self.db, &params.session_id)
    }

    fn pin_session(&self, params: SessionPinParams) -> Result<SessionSummary> {
        self.db
            .set_session_pinned(&params.session_id, params.pinned)?;
        session_summary(&self.paths, &self.db, &params.session_id)
    }

    fn archive_session(&self, params: SessionIdParams) -> Result<()> {
        let generation = self.db.archive_session(&params.session_id)?;
        if let Err(error) = (HostManager {
            paths: &self.paths,
            db: &self.db,
        })
        .stop(&params.session_id, 3_000)
        {
            return match self
                .db
                .unarchive_session_if_generation(&params.session_id, generation)
            {
                Ok(true) => Err(error.into()),
                Ok(false) => Err(ServiceError::PreconditionFailed),
                Err(rollback_error) => Err(rollback_error.into()),
            };
        }
        Ok(())
    }

    fn unarchive_session(&self, params: SessionIdParams) -> Result<()> {
        self.db.unarchive_session(&params.session_id)?;
        Ok(())
    }

    fn list_archived_sessions(&self) -> Result<Vec<SessionSummary>> {
        let mut sessions = self
            .list_sessions(true)?
            .into_iter()
            .filter(|session| session.archived_at.is_some())
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| right.archived_at.cmp(&left.archived_at));
        Ok(sessions)
    }

    fn delete_archived_session(&self, params: SessionIdParams) -> Result<()> {
        let session = self.db.get_session(&params.session_id)?;
        if session.archived_at.is_none() {
            return Err(ServiceError::InvalidRequest);
        }
        (HostManager {
            paths: &self.paths,
            db: &self.db,
        })
        .stop(&params.session_id, 3_000)?;
        let native_plan = plan_native_cleanup(&self.paths, &session);
        self.db.purge_archived_session(&params.session_id)?;
        let _ = execute_native_cleanup(&native_plan);
        cleanup_session_ids(
            &self.paths,
            &self.db,
            std::slice::from_ref(&params.session_id),
        );
        Ok(())
    }

    fn delete_all_archived_sessions(&self) -> Result<()> {
        let sessions = self
            .db
            .list_sessions(None, true)?
            .into_iter()
            .filter(|session| session.archived_at.is_some())
            .collect::<Vec<_>>();
        let manager = HostManager {
            paths: &self.paths,
            db: &self.db,
        };
        for session in &sessions {
            manager.stop(&session.id, 3_000)?;
        }
        let native_plans = sessions
            .iter()
            .map(|session| plan_native_cleanup(&self.paths, session))
            .collect::<Vec<_>>();
        let purged = self.db.purge_all_archived_sessions()?;
        for plan in &native_plans {
            let _ = execute_native_cleanup(plan);
        }
        cleanup_session_ids(&self.paths, &self.db, &purged);
        Ok(())
    }

    fn session_status_history(&self, params: SessionIdParams) -> Result<Vec<StatusSummary>> {
        Ok(self
            .db
            .status_history(&params.session_id, 200)?
            .into_iter()
            .map(StatusSummary::from)
            .collect())
    }

    fn mark_session_seen(&self, params: SessionSeenParams) -> Result<()> {
        let cursor = agentport_core::models::StatusCursor {
            run_id: params.cursor.run_id,
            run_ordinal: i64::try_from(params.cursor.run_ordinal)
                .map_err(|_| ServiceError::InvalidRequest)?,
            sequence: i64::try_from(params.cursor.sequence)
                .map_err(|_| ServiceError::InvalidRequest)?,
        };
        self.db
            .acknowledge_recovery_snapshot(&params.session_id, Some(&cursor), None)?;
        Ok(())
    }

    fn mark_session_output_unread(&self, params: SessionUnreadParams) -> Result<()> {
        let cursor = remote_cursor_to_core(&params.cursor)?;
        self.db.mark_output_unread_at(&params.session_id, &cursor)?;
        Ok(())
    }

    fn poll_attention(&self, params: AttentionPollParams) -> Result<AttentionPollResult> {
        let after = params
            .cursor
            .as_ref()
            .map(|cursor| {
                let occurred_at = chrono::DateTime::parse_from_rfc3339(&cursor.occurred_at)
                    .map_err(|_| ServiceError::InvalidRequest)?
                    .with_timezone(&chrono::Utc);
                Ok::<_, ServiceError>(agentport_core::models::AttentionCursor {
                    occurred_at,
                    session_id: cursor.session_id.clone(),
                    run_ordinal: cursor.run_ordinal,
                    sequence: cursor.sequence,
                })
            })
            .transpose()?;
        let events = self
            .db
            .poll_attention_events(after.as_ref(), params.limit)?
            .into_iter()
            .map(|event| {
                let kind = match event.attention_kind() {
                    Some(agentport_core::models::AttentionKind::ApprovalRequested) => {
                        "approval_requested"
                    }
                    Some(agentport_core::models::AttentionKind::TurnCompleted) => "turn_completed",
                    None => unreachable!("DB attention predicate must match shared classifier"),
                };
                AttentionEventSummary {
                    session_id: event.session_id.clone(),
                    run_id: event.run_id,
                    kind: kind.into(),
                    cursor: agentport_remote_protocol::AttentionCursor {
                        occurred_at: event.occurred_at.to_rfc3339(),
                        session_id: event.session_id,
                        run_ordinal: event.run_ordinal,
                        sequence: event.sequence,
                    },
                }
            })
            .collect::<Vec<_>>();
        let next_cursor = events.last().map(|event| event.cursor.clone());
        Ok(AttentionPollResult {
            events,
            next_cursor,
        })
    }

    fn auto_title_session(&self, params: SessionAutoTitleParams) -> Result<bool> {
        self.db
            .auto_rename_session_from_first_input(&params.session_id, params.expose_input())
            .map_err(Into::into)
    }

    fn read_recovery_context(
        &self,
        params: SessionRecoveryContextParams,
    ) -> Result<RecoveryContextResult> {
        const BEFORE: u64 = 128 * 1024;
        const AFTER: u64 = 256 * 1024;
        let session = self.db.get_session(&params.session_id)?;
        let cursor = remote_cursor_to_core(&params.cursor)?;
        let latest = self
            .db
            .get_latest_log_cursor(&params.session_id)?
            .ok_or(ServiceError::PreconditionFailed)?;
        if cursor.run_id != latest.run_id
            || cursor.run_ordinal != latest.run_ordinal
            || cursor.generation != latest.generation
            || cursor.offset > latest.offset
        {
            return Err(ServiceError::PreconditionFailed);
        }
        let path = std::path::PathBuf::from(&session.log_path);
        let length = std::fs::metadata(&path)
            .map_err(agentport_core::CoreError::Io)?
            .len();
        let latest_offset =
            u64::try_from(latest.offset).map_err(|_| ServiceError::InvalidRequest)?;
        if length < latest_offset {
            return Err(ServiceError::PreconditionFailed);
        }
        let target = u64::try_from(cursor.offset).map_err(|_| ServiceError::InvalidRequest)?;
        let start = target.saturating_sub(BEFORE);
        let end = target.saturating_add(AFTER).min(latest_offset);
        let data = agentport_core::logs::read_range(&path, start, end - start)?;
        if data.len() as u64 != end - start {
            return Err(ServiceError::PreconditionFailed);
        }
        Ok(RecoveryContextResult {
            data_base64: base64::engine::general_purpose::STANDARD.encode(data),
            offset: start,
            total: latest_offset,
            cursor: params.cursor,
        })
    }

    fn attach_session(&self, params: SessionAttachParams) -> Result<SessionAttachResult> {
        let resume = params
            .resume_from
            .as_ref()
            .map(remote_cursor_to_core)
            .transpose()?;
        let manager = HostManager {
            paths: &self.paths,
            db: &self.db,
        };
        let small_seed = params.subscribe_output
            && params.resume_from.is_none()
            && (1..=65_536).contains(&params.replay_tail_bytes);
        let (mut client, mut info) = manager.attach_with_resume(
            &params.session_id,
            params.replay_tail_bytes.min(4 * 1024 * 1024),
            resume,
            params.subscribe_output,
        )?;
        if small_seed
            && !info
                .features
                .iter()
                .any(|f| f == agentport_core::protocol::HOST_FEATURE_TERMINAL_SEED_V1)
        {
            // Upgrade-free fallback for already running Hosts. New Hosts send
            // their persistent mode seed with only the requested small tail.
            let _ = client.detach();
            (client, info) =
                manager.attach_with_resume(&params.session_id, 4 * 1024 * 1024, None, true)?;
        }
        if !client.supports_input_batches() {
            let _ = client.detach();
            return Err(ServiceError::InvalidRequest);
        }
        let attachment_id = agentport_core::ids::new_id("att");
        let cursor = attach_cursor(&info);
        let replay_pending = replay_expected(&params);
        let cutoff = cursor.offset.saturating_sub(params.replay_tail_bytes);
        let mut attachment = Attachment {
            client,
            cursor,
            replay_pending,
            pending: VecDeque::new(),
            next_input_batch_sequence: 0,
            host_exit_seen: false,
            closed: false,
        };
        if small_seed {
            prepare_terminal_seed(&mut attachment, cutoff)?;
        }
        let result = SessionAttachResult {
            attachment_id: attachment_id.clone(),
            session_id: info.session_id,
            child_alive: info.child_alive,
            agent_session_id: info.agent_session_id,
            cursor: params.resume_from.clone(),
            features: info.features,
            run_id: info.run_id,
            run_ordinal: info.run_ordinal,
            terminal_geometry: info.terminal_geometry,
        };
        let mut attachments = self
            .attachments
            .lock()
            .map_err(|_| ServiceError::AttachmentState)?;
        prune_closed_attachments(&mut attachments);
        if attachments.len() >= self.service_snapshot().limits.max_subscriptions as usize {
            let _ = attachment.client.detach();
            return Err(ServiceError::InvalidRequest);
        }
        attachments.insert(
            attachment_id,
            Arc::new(Mutex::new(AttachmentState::Direct(attachment))),
        );
        Ok(result)
    }

    fn subscribe_session(&self, attachment_id: &str) -> Result<SessionSubscription> {
        let slot = self.attachment_slot(attachment_id)?;
        let mut state = slot.lock().map_err(|_| ServiceError::AttachmentState)?;
        let direct = match std::mem::replace(&mut *state, AttachmentState::Transition) {
            AttachmentState::Direct(attachment) if !attachment.closed => attachment,
            other => {
                *state = other;
                return Err(ServiceError::InvalidRequest);
            }
        };
        let (events_tx, events_rx) = mpsc::sync_channel(PUSH_EVENT_QUEUE_CAPACITY);
        let (commands_tx, commands_rx) = mpsc::sync_channel(PUSH_COMMAND_QUEUE_CAPACITY);
        let closed = Arc::new(AtomicBool::new(false));
        let worker_closed = Arc::clone(&closed);
        let worker =
            std::thread::spawn(move || push_worker(direct, commands_rx, events_tx, worker_closed));
        *state = AttachmentState::Push(PushAttachment {
            commands: commands_tx,
            closed,
            worker: Some(worker),
        });
        Ok(SessionSubscription {
            attachment_id: attachment_id.to_string(),
            receiver: events_rx,
        })
    }

    fn input_session(&self, params: SessionInputParams) -> Result<SessionInputResult> {
        validate_input(&params)?;
        let slot = self.attachment_slot(&params.attachment_id)?;
        let mut state = slot.lock().map_err(|_| ServiceError::AttachmentState)?;
        match &mut *state {
            AttachmentState::Direct(attachment) => direct_input(attachment, params),
            AttachmentState::Push(push) if !push.closed.load(Ordering::Acquire) => {
                let commands = push.commands.clone();
                drop(state);
                let (reply_tx, reply_rx) = mpsc::sync_channel(1);
                commands
                    .send(PushCommand::Input {
                        params,
                        reply: reply_tx,
                    })
                    .map_err(|_| ServiceError::InputOutcomeUnknown)?;
                reply_rx
                    .recv()
                    .unwrap_or(Err(ServiceError::InputOutcomeUnknown))
            }
            AttachmentState::Push(_) | AttachmentState::Transition => {
                Err(ServiceError::InputOutcomeUnknown)
            }
        }
    }

    fn structured_prompt(&self, params: SessionStructuredPromptParams) -> Result<()> {
        if params.expose_text().trim().is_empty() || params.expose_text().len() > 256 * 1024 {
            return Err(ServiceError::InvalidRequest);
        }
        let slot = self.attachment_slot(&params.attachment_id)?;
        let mut state = slot.lock().map_err(|_| ServiceError::AttachmentState)?;
        match &mut *state {
            AttachmentState::Direct(attachment) if !attachment.closed => attachment
                .client
                .send_structured_prompt(params.expose_text())
                .map_err(Into::into),
            AttachmentState::Push(push) if !push.closed.load(Ordering::Acquire) => {
                let commands = push.commands.clone();
                drop(state);
                let (reply_tx, reply_rx) = mpsc::sync_channel(1);
                commands
                    .send(PushCommand::StructuredPrompt {
                        params,
                        reply: reply_tx,
                    })
                    .map_err(|_| ServiceError::InputOutcomeUnknown)?;
                reply_rx
                    .recv()
                    .unwrap_or(Err(ServiceError::InputOutcomeUnknown))
            }
            AttachmentState::Direct(_) | AttachmentState::Push(_) | AttachmentState::Transition => {
                Err(ServiceError::InputOutcomeUnknown)
            }
        }
    }

    fn abort_structured_turn(&self, params: SessionDetachParams) -> Result<()> {
        let slot = self.attachment_slot(&params.attachment_id)?;
        let mut state = slot.lock().map_err(|_| ServiceError::AttachmentState)?;
        match &mut *state {
            AttachmentState::Direct(attachment) if !attachment.closed => attachment
                .client
                .abort_structured_turn()
                .map_err(Into::into),
            AttachmentState::Push(push) if !push.closed.load(Ordering::Acquire) => {
                let commands = push.commands.clone();
                drop(state);
                let (reply_tx, reply_rx) = mpsc::sync_channel(1);
                commands
                    .send(PushCommand::AbortStructuredTurn { reply: reply_tx })
                    .map_err(|_| ServiceError::InputOutcomeUnknown)?;
                reply_rx
                    .recv()
                    .unwrap_or(Err(ServiceError::InputOutcomeUnknown))
            }
            AttachmentState::Direct(_) | AttachmentState::Push(_) | AttachmentState::Transition => {
                Err(ServiceError::InputOutcomeUnknown)
            }
        }
    }

    fn control_session(&self, params: SessionControlParams) -> Result<SessionControlResult> {
        let slot = self.attachment_slot(&params.attachment_id)?;
        let mut state = slot.lock().map_err(|_| ServiceError::AttachmentState)?;
        match &mut *state {
            AttachmentState::Direct(attachment) => direct_control(attachment, params),
            AttachmentState::Push(push) if !push.closed.load(Ordering::Acquire) => {
                let commands = push.commands.clone();
                drop(state);
                let (reply_tx, reply_rx) = mpsc::sync_channel(1);
                commands
                    .send(PushCommand::Control {
                        params,
                        reply: reply_tx,
                    })
                    .map_err(|_| ServiceError::AttachmentNotFound)?;
                reply_rx
                    .recv()
                    .unwrap_or(Err(ServiceError::AttachmentNotFound))
            }
            AttachmentState::Push(_) | AttachmentState::Transition => {
                Err(ServiceError::AttachmentNotFound)
            }
        }
    }

    fn poll_session(&self, params: SessionPollParams) -> Result<SessionPollResult> {
        let slot = self.attachment_slot(&params.attachment_id)?;
        let mut state = slot.lock().map_err(|_| ServiceError::AttachmentState)?;
        match &mut *state {
            AttachmentState::Direct(attachment) => direct_poll(attachment, params),
            // Push mode has exactly one event consumer. Permitting poll here
            // would race it and make delivery non-deterministic.
            AttachmentState::Push(_) | AttachmentState::Transition => {
                Err(ServiceError::InvalidRequest)
            }
        }
    }

    fn detach_session(&self, params: SessionDetachParams) -> Result<()> {
        let slot = self
            .attachments
            .lock()
            .map_err(|_| ServiceError::AttachmentState)?
            .remove(&params.attachment_id)
            .ok_or(ServiceError::AttachmentNotFound)?;
        let mut state = slot.lock().map_err(|_| ServiceError::AttachmentState)?;
        match &mut *state {
            AttachmentState::Direct(attachment) => {
                if !attachment.closed {
                    attachment.client.detach()?;
                    attachment.closed = true;
                }
                Ok(())
            }
            AttachmentState::Push(push) => {
                // Wake a reader held by output backpressure before waiting for
                // its command queue or join. Detach must not require a consumer.
                push.closed.store(true, Ordering::Release);
                if let Some(worker) = push.worker.take() {
                    let _ = worker.join();
                }
                // The worker drops its Host connection before join returns,
                // including when sending the optional Detach frame fails.
                Ok(())
            }
            AttachmentState::Transition => Err(ServiceError::AttachmentState),
        }
    }

    fn stop_session(&self, params: SessionStopParams) -> Result<SessionStopResult> {
        if params.session_id.is_empty() || params.grace_ms > 30_000 {
            return Err(ServiceError::InvalidRequest);
        }
        HostManager {
            paths: &self.paths,
            db: &self.db,
        }
        .stop(&params.session_id, params.grace_ms)?;
        // The attachment reader, not this separate stop connection, owns the
        // terminal Exit/EOF transition. Marking it closed here would suppress
        // the final event and make it pruneable before the Host stream drains.
        Ok(SessionStopResult {
            session_id: params.session_id,
            group_cleaned: true,
        })
    }

    fn add_secret(&self, params: SecretAddParams) -> Result<SecretAddResult> {
        let broker = CredentialBroker::detect()?;
        let secret =
            broker.store_staged(&params.env_name, &params.preset_id, params.expose_value())?;
        if let Err(error) = self.db.add_secret_ref_to_preset(&params.preset_id, &secret) {
            // The unique staged account cannot overwrite an active secret;
            // compensate any database failure before returning.
            let _ = broker.delete(&secret);
            return Err(error.into());
        }
        Ok(SecretAddResult {
            id: secret.id,
            env_name: secret.env_name,
            backend: secret.backend.as_str().into(),
        })
    }
}

type MaterializedLaunchEnvironment = (Vec<(String, String)>, Vec<(String, SecretValue)>);

fn install_for(service: &CoreService, agent: AgentType) -> agentport_core::Result<AdapterInstall> {
    if let Some(install) = service.db.get_adapter(agent)? {
        if std::path::Path::new(&install.executable_path).exists() {
            return Ok(install);
        }
    }
    let outcome = capability::probe_agent(agent, None);
    match outcome.install {
        Some(install) => {
            service.db.upsert_adapter(&install)?;
            Ok(install)
        }
        None => Err(agentport_core::CoreError::Adapter(format!(
            "{} is not available: {}",
            agent.display_name(),
            outcome.reason.unwrap_or_else(|| "not found".into())
        ))),
    }
}

fn preset_for(
    service: &CoreService,
    agent: AgentType,
    preset_id: Option<String>,
    install: &AdapterInstall,
) -> agentport_core::Result<Preset> {
    let mut preset = match preset_id {
        Some(id) => service.db.get_preset(&id)?,
        None => service
            .db
            .get_preset(&format!("pre_{}_safe", agent.as_str()))
            .unwrap_or(Preset {
                id: format!("pre_{}_safe", agent.as_str()),
                agent_type: agent,
                name: format!("{} safe default", agent.display_name()),
                executable_path: String::new(),
                args: Vec::new(),
                permission_mode: agent.default_permission_mode(),
                env_names: Vec::new(),
                secret_ref_ids: Vec::new(),
                built_in: true,
            }),
    };
    if preset.agent_type != agent {
        return Err(agentport_core::CoreError::Validation(format!(
            "preset {} belongs to {}",
            preset.id,
            preset.agent_type.as_str()
        )));
    }
    if preset.executable_path.is_empty() {
        preset.executable_path = install.executable_path.clone();
    }
    Ok(preset)
}

fn materialize_launch_environment(
    service: &CoreService,
    preset: &Preset,
    plan_env: &[(String, String)],
) -> agentport_core::Result<MaterializedLaunchEnvironment> {
    let mut env = capability::login_shell_launch_environment();
    env.extend_from_slice(plan_env);
    for name in &preset.env_names {
        if let Ok(value) = std::env::var(name) {
            env.push((name.clone(), value));
        }
    }
    capability::merge_launch_path_env(&mut env)?;
    let refs = preset
        .secret_ref_ids
        .iter()
        .map(|id| service.db.get_secret_ref(id))
        .collect::<agentport_core::Result<Vec<SecretRef>>>()?;
    let secrets = if refs.is_empty() {
        Vec::new()
    } else {
        load_preset_secrets(&CredentialBroker::detect()?, &refs)?
    };
    Ok((env, secrets))
}

fn write_launch_helpers(helper_files: &[(String, String)]) -> agentport_core::Result<()> {
    let mut written = Vec::with_capacity(helper_files.len());
    for (path, contents) in helper_files {
        if let Err(error) = write_private_file(path, contents) {
            for written_path in written {
                let _ = std::fs::remove_file(written_path);
            }
            return Err(error);
        }
        written.push(path.as_str());
    }
    Ok(())
}

fn remove_launch_helpers(helper_files: &[(String, String)]) {
    for (path, _) in helper_files {
        let _ = std::fs::remove_file(path);
    }
}

#[allow(clippy::too_many_arguments)]
fn build_launch_plan(
    service: &CoreService,
    project_id: &str,
    agent: AgentType,
    preset_id: Option<String>,
    worktree_id: Option<String>,
    permission: PermissionMode,
    transport: AgentTransport,
    extra_args: Option<Vec<String>>,
) -> agentport_core::Result<(adapters::LaunchPlan, Preset, String, String)> {
    if transport != AgentTransport::Pty {
        return Err(agentport_core::CoreError::Validation(format!(
            "{} Session creation supports only native PTY transport",
            agent.display_name()
        )));
    }
    let project = service.db.get_project(project_id)?;
    let install = install_for(service, agent)?;
    let mut preset = preset_for(service, agent, preset_id, &install)?;
    preset.permission_mode = permission;
    adapters::validate_user_args(agent, &preset.args)?;
    let cwd = match &worktree_id {
        Some(id) => {
            let worktree = service.db.get_worktree(id)?;
            if worktree.project_id != project.id {
                return Err(agentport_core::CoreError::Conflict(format!(
                    "worktree {} does not belong to project {}",
                    worktree.id, project.id
                )));
            }
            worktree.path
        }
        None => project.root_path,
    };
    let session_id = agentport_core::ids::new_id("ses");
    let session_dir = service.paths.session_dir(&session_id);
    std::fs::create_dir_all(&session_dir)?;
    let context = LaunchContext {
        install,
        preset: preset.clone(),
        cwd: cwd.clone(),
        session_id: session_id.clone(),
        hook_events_path: service
            .paths
            .hook_events_path(&session_id)
            .to_string_lossy()
            .into_owned(),
        session_dir: session_dir.to_string_lossy().into_owned(),
        transport,
    };
    let mut plan = adapters::adapter_for(agent).build_launch(&context)?;
    if let Some(extra_args) = extra_args {
        if extra_args.iter().any(String::is_empty) {
            return Err(agentport_core::CoreError::Validation(
                "empty extra argument".into(),
            ));
        }
        adapters::validate_user_args(agent, &extra_args)?;
        plan.argv.extend(extra_args);
    }
    if agent == AgentType::Pi {
        agentport_core::pi_storage::prepare_launch(&service.paths, &session_id, &mut plan)?;
    }
    Ok((plan, preset, cwd, session_id))
}

fn parse_permission(value: &str) -> Result<PermissionMode> {
    match value {
        "native" => Ok(PermissionMode::Native),
        "auto" => Ok(PermissionMode::Auto),
        "bypass" => Ok(PermissionMode::Bypass),
        _ => Err(ServiceError::InvalidRequest),
    }
}

fn permission_requires_risk_ack(mode: PermissionMode) -> bool {
    mode != PermissionMode::Native
}

fn acquire_session_repository_lock(
    cwd: &str,
) -> agentport_core::Result<Option<RepositoryFileLock>> {
    match RepositoryIdentity::discover(std::path::Path::new(cwd), &GitRunner::default()) {
        Ok(identity) => RepositoryFileLock::acquire(&identity.common_dir).map(Some),
        Err(agentport_core::CoreError::NotFound(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

fn session_launch_result(
    session_id: String,
    resume_precision: ResumePrecision,
    agent_session_id: Option<String>,
    plan: &adapters::LaunchPlan,
    host_pid: u32,
    child_alive: bool,
) -> SessionLaunchResult {
    SessionLaunchResult {
        session_id,
        resume_precision: resume_precision.as_str().into(),
        agent_session_id,
        notices: plan
            .notices
            .iter()
            .map(|notice| LaunchNoticeSummary {
                code: notice.code.into(),
                message: notice.legacy_message.clone(),
            })
            .collect(),
        host_pid,
        child_alive,
        command: plan.argv.clone(),
    }
}

fn validate_agent_preference_ids(values: &[String]) -> Result<()> {
    const MAX_ADAPTERS: usize = 64;
    const MAX_ID_BYTES: usize = 64;
    if values.len() > MAX_ADAPTERS
        || values.iter().any(|value| {
            value.is_empty()
                || value.len() > MAX_ID_BYTES
                || value.trim() != value
                || value.chars().any(|character| character.is_control())
        })
    {
        return Err(ServiceError::InvalidRequest);
    }
    let unique = values.iter().collect::<std::collections::HashSet<_>>();
    if unique.len() != values.len() {
        return Err(ServiceError::InvalidRequest);
    }
    Ok(())
}

fn remote_agent_to_core(agent: RemoteAgentType) -> AgentType {
    match agent {
        RemoteAgentType::Claude => AgentType::Claude,
        RemoteAgentType::Codex => AgentType::Codex,
        RemoteAgentType::Kimi => AgentType::Kimi,
        RemoteAgentType::Qoder => AgentType::Qoder,
        RemoteAgentType::Pi => AgentType::Pi,
        RemoteAgentType::Shell => AgentType::Shell,
    }
}

fn probe_result(agent: AgentType, outcome: capability::ProbeOutcome) -> AgentProbeResult {
    AgentProbeResult {
        agent: agent.as_str().into(),
        display_name: agent.display_name().into(),
        state: format!("{:?}", outcome.state).to_lowercase(),
        reason: outcome.reason,
        reason_code: outcome.reason_code.map(str::to_string),
        reason_detail: outcome.reason_detail,
        install: outcome.install,
        candidates: outcome.candidates,
    }
}

fn agent_preferences(value: CoreAgentPreferencesSnapshot) -> AgentPreferencesSnapshot {
    AgentPreferencesSnapshot {
        revision: value.revision,
        agent_order: value.agent_order,
        agent_hidden: value.agent_hidden,
    }
}

fn preset_summary(preset: Preset) -> Result<PresetSummary> {
    Ok(PresetSummary {
        id: preset.id,
        agent: preset.agent_type.as_str().into(),
        name: preset.name,
        executable_path: preset.executable_path,
        permission_mode: preset.permission_mode.as_str().into(),
        env_names: preset.env_names,
        secret_ref_ids: preset.secret_ref_ids,
        built_in: preset.built_in,
    })
}

fn project_preflight(snapshot: CoreProjectRemovalSnapshot) -> Result<ProjectRemovalPreflight> {
    let sessions = snapshot
        .sessions
        .into_iter()
        .map(|session| {
            Ok(ConfirmedProjectSession {
                session_id: session.id,
                archive_generation: u64::try_from(session.archive_generation)
                    .map_err(|_| ServiceError::Serialization)?,
                archived: session.archived,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let archived_session_count = sessions.iter().filter(|session| session.archived).count();
    let active_session_count = sessions.len().saturating_sub(archived_session_count);
    Ok(ProjectRemovalPreflight {
        project_id: snapshot.project_id,
        revision: snapshot.revision.to_string(),
        session_count: sessions.len(),
        active_session_count,
        archived_session_count,
        sessions,
        worktree_ids: snapshot.worktree_ids,
        recoverable_operation_ids: snapshot.recoverable_operation_ids,
        pending_commit_operation_ids: snapshot.pending_commit_operation_ids,
        can_remove: true,
    })
}

fn io_error(error: std::io::Error) -> ServiceError {
    agentport_core::CoreError::from(error).into()
}

fn absolute_path(path: &str) -> Result<&std::path::Path> {
    let path = std::path::Path::new(path);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ServiceError::InvalidRequest);
    }
    Ok(path)
}

fn read_document(path: &str) -> Result<serde_json::Value> {
    const MAX_BYTES: u64 = 1024 * 1024;
    const SNIFF_BYTES: usize = 8 * 1024;
    let canonical = std::fs::canonicalize(absolute_path(path)?).map_err(io_error)?;
    let metadata = std::fs::metadata(&canonical).map_err(io_error)?;
    if !metadata.is_file() {
        return Err(ServiceError::InvalidRequest);
    }
    let mut bytes = vec![0_u8; metadata.len().min(MAX_BYTES) as usize];
    use std::io::Read as _;
    std::fs::File::open(&canonical)
        .map_err(io_error)?
        .read_exact(&mut bytes)
        .map_err(io_error)?;
    if bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0) {
        return Err(ServiceError::InvalidRequest);
    }
    Ok(serde_json::json!({
        "path": canonical.to_string_lossy(),
        "content": String::from_utf8_lossy(&bytes),
        "truncated": metadata.len() > MAX_BYTES,
        "sizeBytes": metadata.len(),
    }))
}

fn write_document(path: &str, content: &str) -> Result<serde_json::Value> {
    const MAX_BYTES: usize = 8 * 1024 * 1024;
    if content.len() > MAX_BYTES {
        return Err(ServiceError::InvalidRequest);
    }
    let canonical = std::fs::canonicalize(absolute_path(path)?).map_err(io_error)?;
    if !canonical.is_file() {
        return Err(ServiceError::InvalidRequest);
    }
    let parent = canonical.parent().ok_or(ServiceError::InvalidRequest)?;
    let temporary = parent.join(format!(
        ".agentport-doc-save-{}.tmp",
        agentport_core::ids::new_id("doc")
    ));
    let result = (|| -> std::io::Result<()> {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, &canonical)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(io_error(error));
    }
    Ok(serde_json::json!({
        "path": canonical.to_string_lossy(),
        "sizeBytes": content.len(),
    }))
}

fn list_document_directory(path: &str) -> Result<serde_json::Value> {
    const MAX_ENTRIES: usize = 2_000;
    let canonical = std::fs::canonicalize(absolute_path(path)?).map_err(io_error)?;
    if !canonical.is_dir() {
        return Err(ServiceError::InvalidRequest);
    }
    let mut directories = Vec::new();
    let mut files = Vec::new();
    let mut truncated = false;
    for entry in std::fs::read_dir(&canonical).map_err(io_error)? {
        let Ok(entry) = entry else { continue };
        if directories.len() + files.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let is_directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let item = serde_json::json!({
            "name": name,
            "path": entry.path().to_string_lossy(),
            "isDir": is_directory,
        });
        if is_directory {
            directories.push(item);
        } else {
            files.push(item);
        }
    }
    let key = |value: &serde_json::Value| value["name"].as_str().unwrap_or("").to_lowercase();
    directories.sort_by_key(&key);
    files.sort_by_key(key);
    directories.extend(files);
    Ok(serde_json::json!({
        "path": canonical.to_string_lossy(),
        "entries": directories,
        "truncated": truncated,
    }))
}

fn create_document_entry(path: &str, kind: &str) -> Result<serde_json::Value> {
    let path = absolute_path(path)?;
    if path.exists() {
        return Err(ServiceError::InvalidRequest);
    }
    match kind {
        "dir" => std::fs::create_dir_all(path).map_err(io_error)?,
        "file" => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(io_error)?;
            }
            std::fs::File::create_new(path).map_err(io_error)?;
        }
        _ => return Err(ServiceError::InvalidRequest),
    }
    let canonical = std::fs::canonicalize(path).map_err(io_error)?;
    Ok(serde_json::json!({"path": canonical.to_string_lossy()}))
}

fn load_all_secret_values(db: &Db) -> Vec<Vec<u8>> {
    let Ok(broker) = CredentialBroker::detect() else {
        return Vec::new();
    };
    db.list_secret_refs()
        .unwrap_or_default()
        .iter()
        .filter_map(|secret| broker.load(secret).ok())
        .map(|value| value.expose().to_vec())
        .collect()
}

fn backup_list(paths: &AppPaths) -> serde_json::Value {
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(paths.backups_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("zip") {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let modified = metadata
                .modified()
                .map(chrono::DateTime::<chrono::Utc>::from)
                .map(|value| value.to_rfc3339())
                .unwrap_or_default();
            items.push(serde_json::json!({
                "path": path,
                "name": entry.file_name().to_string_lossy(),
                "size": metadata.len(),
                "modifiedAt": modified,
            }));
        }
    }
    items.sort_by(|left, right| {
        right["modifiedAt"]
            .as_str()
            .unwrap_or("")
            .cmp(left["modifiedAt"].as_str().unwrap_or(""))
    });
    serde_json::Value::Array(items)
}

fn search_all(paths: &AppPaths, db: &Db, query: String, limit: usize) -> Result<serde_json::Value> {
    let needle = query.trim().to_lowercase();
    if needle.chars().count() < 2 {
        return Err(ServiceError::InvalidRequest);
    }
    let history = NativeHistory::new(paths);
    let mut hits = Vec::new();
    let mut total_hits = 0usize;
    for project in db.list_projects()? {
        if project.name.to_lowercase().contains(&needle)
            || project.root_path.to_lowercase().contains(&needle)
        {
            total_hits = total_hits.saturating_add(1);
            if hits.len() < limit {
                hits.push(serde_json::json!({
                    "kind": "project",
                    "sessionId": serde_json::Value::Null,
                    "projectId": project.id,
                    "title": project.name,
                    "snippet": project.root_path,
                    "logOffset": serde_json::Value::Null,
                    "rotatedAway": false,
                }));
            }
        }
        for worktree in db.list_worktrees(&project.id)? {
            if worktree.branch.to_lowercase().contains(&needle)
                || worktree.path.to_lowercase().contains(&needle)
            {
                total_hits = total_hits.saturating_add(1);
                if hits.len() < limit {
                    hits.push(serde_json::json!({
                        "kind": "branch",
                        "sessionId": serde_json::Value::Null,
                        "projectId": project.id,
                        "title": worktree.branch,
                        "snippet": worktree.path,
                        "logOffset": serde_json::Value::Null,
                        "rotatedAway": false,
                    }));
                }
            }
        }
    }
    let mut partial = limit == 0 || hits.len() == limit;
    if !partial {
        for session in db.list_sessions(None, false)? {
            if session.title.to_lowercase().contains(&needle)
                || session.cwd.to_lowercase().contains(&needle)
                || session.adapter_type.as_str().contains(&needle)
            {
                total_hits = total_hits.saturating_add(1);
                if hits.len() < limit {
                    hits.push(serde_json::json!({
                        "kind": "session",
                        "sessionId": session.id,
                        "projectId": session.project_id,
                        "title": session.title,
                        "snippet": session.cwd,
                        "logOffset": serde_json::Value::Null,
                        "rotatedAway": false,
                    }));
                }
                if hits.len() == limit {
                    partial = true;
                    break;
                }
            }
            let result = history.search_session_bounded(
                &session,
                &query,
                limit.saturating_sub(hits.len()),
            )?;
            total_hits = total_hits.saturating_add(result.total_hits);
            for hit in result.hits {
                hits.push(serde_json::json!({
                    "kind": "terminal",
                    "sessionId": session.id,
                    "projectId": session.project_id,
                    "title": session.title,
                    "snippet": hit.snippet,
                    "eventId": hit.event.id,
                    "provider": hit.event.provider,
                    "logOffset": serde_json::Value::Null,
                    "rotatedAway": false,
                }));
            }
            if result.partial || hits.len() == limit {
                partial = true;
                break;
            }
        }
    }
    Ok(serde_json::json!({
        "partial": partial,
        "totalHits": total_hits,
        "hits": hits,
    }))
}

fn parse_extended<T: for<'de> Deserialize<'de>>(value: serde_json::Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| ServiceError::InvalidRequest)
}

fn serialize_extended<T: Serialize>(value: T) -> Result<serde_json::Value> {
    serde_json::to_value(value).map_err(|_| ServiceError::Serialization)
}

#[cfg(target_os = "macos")]
fn move_to_system_trash(path: &std::path::Path) -> agentport_core::Result<()> {
    let script = "on run argv\nset targetPath to item 1 of argv\ntell application \"Finder\" to delete POSIX file targetPath\nend run";
    let status = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .arg("--")
        .arg(path)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(agentport_core::CoreError::Blocked(
            "system Trash rejected the file".into(),
        ))
    }
}

#[cfg(target_os = "linux")]
fn move_to_system_trash(path: &std::path::Path) -> agentport_core::Result<()> {
    let status = std::process::Command::new("gio")
        .arg("trash")
        .arg("--")
        .arg(path)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(agentport_core::CoreError::Blocked(
            "system Trash rejected the file".into(),
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn move_to_system_trash(_path: &std::path::Path) -> agentport_core::Result<()> {
    Err(agentport_core::CoreError::Blocked(
        "system Trash is unavailable on this platform".into(),
    ))
}

fn worktree_summary(worktree: Worktree) -> WorktreeSummary {
    WorktreeSummary {
        id: worktree.id,
        project_id: worktree.project_id,
        branch: worktree.branch,
        base_commit: worktree.base_commit,
        path: worktree.path,
        health: worktree.health.as_str().into(),
        created_at: worktree.created_at.to_rfc3339(),
    }
}

fn parse_worktree_branch_selection(
    mode: &str,
    branch: Option<&str>,
    expected_branch_oid: Option<&str>,
) -> Result<WorktreeBranchSelection> {
    let branch = || {
        branch
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or(ServiceError::InvalidRequest)
    };
    match mode {
        "auto" if branch().is_err() => Ok(WorktreeBranchSelection::Auto),
        "new" => Ok(WorktreeBranchSelection::New { name: branch()? }),
        "existing" => Ok(WorktreeBranchSelection::Existing {
            name: branch()?,
            expected_oid: expected_branch_oid
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or(ServiceError::InvalidRequest)?,
        }),
        _ => Err(ServiceError::InvalidRequest),
    }
}

fn session_summary(paths: &AppPaths, db: &Db, session_id: &str) -> Result<SessionSummary> {
    let projection = db
        .list_session_projections(true)?
        .into_iter()
        .find(|projection| projection.session.id == session_id)
        .ok_or_else(|| agentport_core::CoreError::NotFound(format!("session {session_id}")))?;
    let host_alive = (HostManager { paths, db }).is_alive(session_id);
    Ok(SessionSummary::from_projection(
        projection.session,
        projection.latest_status,
        projection.unread_attention,
        host_alive,
    ))
}

fn core_project_snapshot(params: ProjectRemoveParams) -> Result<CoreProjectRemovalSnapshot> {
    let sessions = params
        .sessions
        .into_iter()
        .map(|session| {
            Ok(ProjectRemovalSession {
                id: session.session_id,
                archive_generation: i64::try_from(session.archive_generation)
                    .map_err(|_| ServiceError::InvalidRequest)?,
                archived: session.archived,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let revision = params
        .revision
        .parse::<u64>()
        .map_err(|_| ServiceError::InvalidRequest)?;
    Ok(CoreProjectRemovalSnapshot {
        project_id: params.project_id,
        revision,
        sessions,
        worktree_ids: params.worktree_ids,
        recoverable_operation_ids: params.recoverable_operation_ids,
        pending_commit_operation_ids: params.pending_commit_operation_ids,
    })
}

/// Best-effort first pass for the durable cleanup jobs created by Core's
/// cascade. Fixed error labels keep paths and local diagnostics out of SQLite.
fn cleanup_session_ids(paths: &AppPaths, db: &Db, session_ids: &[String]) {
    let sessions = session_ids
        .iter()
        .map(|id| ProjectRemovalSession {
            id: id.clone(),
            archive_generation: 0,
            archived: true,
        })
        .collect::<Vec<_>>();
    cleanup_confirmed_sessions(paths, db, &sessions);
}

fn cleanup_confirmed_sessions(paths: &AppPaths, db: &Db, sessions: &[ProjectRemovalSession]) {
    for session in sessions {
        let mut components = std::path::Path::new(&session.id).components();
        let valid_id = !session.id.is_empty()
            && matches!(components.next(), Some(std::path::Component::Normal(_)))
            && components.next().is_none();
        let outcome = if !valid_id {
            Err("invalid_session_id")
        } else {
            let socket = paths.socket_path(&session.id);
            let directory = paths.session_dir(&session.id);
            let socket_result = std::fs::remove_file(socket);
            let directory_result = std::fs::remove_dir_all(directory);
            if socket_result
                .as_ref()
                .is_err_and(|error| error.kind() != std::io::ErrorKind::NotFound)
            {
                Err("remove_socket_failed")
            } else if directory_result
                .as_ref()
                .is_err_and(|error| error.kind() != std::io::ErrorKind::NotFound)
            {
                Err("remove_session_directory_failed")
            } else {
                Ok(())
            }
        };
        match outcome {
            Ok(()) => {
                let _ = db.mark_cleanup_job_success(&session.id);
            }
            Err(reason) => {
                let _ = db.record_cleanup_job_retry(&session.id, reason, chrono::Utc::now());
            }
        }
    }
}

fn prune_closed_attachments(attachments: &mut HashMap<String, AttachmentSlot>) {
    attachments.retain(|_, slot| match slot.try_lock() {
        Ok(state) => !attachment_state_closed(&state),
        Err(_) => true,
    });
}

fn replay_expected(params: &SessionAttachParams) -> bool {
    params.subscribe_output && (params.resume_from.is_some() || params.replay_tail_bytes > 0)
}

fn attachment_state_closed(state: &AttachmentState) -> bool {
    match state {
        AttachmentState::Direct(attachment) => attachment.closed,
        AttachmentState::Push(push) => push.closed.load(Ordering::Acquire),
        AttachmentState::Transition => false,
    }
}

fn validate_input(params: &SessionInputParams) -> Result<()> {
    let data = params
        .decode_data()
        .map_err(|_| ServiceError::InvalidRequest)?;
    if params.batch_id.is_empty() || params.batch_id.len() > 128 || data.is_empty() {
        return Err(ServiceError::InvalidRequest);
    }
    Ok(())
}

fn direct_input(
    attachment: &mut Attachment,
    params: SessionInputParams,
) -> Result<SessionInputResult> {
    if attachment.closed {
        return Err(ServiceError::InputOutcomeUnknown);
    }
    let client_batch_id = params.batch_id.clone();
    let wire_batch_id = next_wire_batch_id(attachment)?;
    let data = params
        .decode_data()
        .map_err(|_| ServiceError::InvalidRequest)?;
    attachment
        .client
        .reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| ServiceError::InputOutcomeUnknown)?;
    if attachment
        .client
        .send_input_batch(&wire_batch_id, data.as_slice())
        .is_err()
    {
        let _ = attachment.client.reader.get_ref().set_read_timeout(None);
        return Err(ServiceError::InputOutcomeUnknown);
    }
    let mut accepted_sequence = None;
    let outcome = loop {
        let frame = match read_host_frame(&mut attachment.client) {
            Ok(Some(frame)) => frame,
            Ok(None) | Err(_) => {
                attachment.closed = true;
                break Err(ServiceError::InputOutcomeUnknown);
            }
        };
        match frame {
            HostFrame::InputBatchAck {
                batch_id,
                server_sequence,
                phase,
                ..
            } if batch_id == wire_batch_id => match phase {
                InputBatchAckPhase::Accepted => {
                    if accepted_sequence.is_none() {
                        accepted_sequence = Some(server_sequence);
                    }
                }
                InputBatchAckPhase::Completed if accepted_sequence == Some(server_sequence) => {
                    break Ok(SessionInputResult {
                        batch_id: client_batch_id.clone(),
                        server_sequence,
                        phase: input_phase_name(phase).into(),
                    })
                }
                InputBatchAckPhase::NotExecuted
                    if accepted_sequence.is_none()
                        || accepted_sequence == Some(server_sequence) =>
                {
                    break Ok(SessionInputResult {
                        batch_id: client_batch_id.clone(),
                        server_sequence,
                        phase: input_phase_name(phase).into(),
                    })
                }
                InputBatchAckPhase::Unknown if accepted_sequence == Some(server_sequence) => {
                    break Err(ServiceError::InputOutcomeUnknown)
                }
                _ => {}
            },
            // Acknowledgements belong exclusively to the input control path;
            // stale or unrelated acknowledgements are never exposed as events.
            HostFrame::InputBatchAck { .. } => {}
            other => {
                if let Some(event) = host_event(
                    &mut attachment.cursor,
                    &mut attachment.replay_pending,
                    other,
                ) {
                    enqueue_poll_event(&mut attachment.pending, event);
                }
            }
        }
    };
    let _ = attachment.client.reader.get_ref().set_read_timeout(None);
    outcome
}

fn direct_control(
    attachment: &mut Attachment,
    params: SessionControlParams,
) -> Result<SessionControlResult> {
    if attachment.closed {
        return Err(ServiceError::AttachmentNotFound);
    }
    match params.control {
        SessionControlKind::Resize => {
            let (cols, rows) = params
                .cols
                .zip(params.rows)
                .filter(|(cols, rows)| *cols > 0 && *rows > 0)
                .ok_or(ServiceError::InvalidRequest)?;
            match (params.expected_revision, params.source_kind.as_deref()) {
                (Some(expected_revision), Some(source_kind)) => {
                    attachment.client.resize_with_geometry(
                        cols,
                        rows,
                        expected_revision,
                        source_kind,
                        params.source_device_id.as_deref(),
                        &params.attachment_id,
                        params.orientation.as_deref(),
                    )?;
                    loop {
                        let Some(frame) = attachment.client.read_frame()? else {
                            attachment.closed = true;
                            return Err(ServiceError::InputOutcomeUnknown);
                        };
                        match frame {
                            HostFrame::ResizeAck {
                                accepted, geometry, ..
                            } => {
                                if !accepted {
                                    return Err(ServiceError::PreconditionFailed);
                                }
                                return Ok(SessionControlResult {
                                    accepted: true,
                                    terminal_geometry: Some(geometry),
                                });
                            }
                            other => {
                                if let Some(event) = host_event(
                                    &mut attachment.cursor,
                                    &mut attachment.replay_pending,
                                    other,
                                ) {
                                    enqueue_poll_event(&mut attachment.pending, event);
                                }
                            }
                        }
                    }
                }
                (None, None) => attachment.client.resize(cols, rows)?,
                _ => return Err(ServiceError::InvalidRequest),
            }
        }
        SessionControlKind::Interrupt => attachment.client.interrupt()?,
        SessionControlKind::Continue => attachment.client.resume()?,
    }
    Ok(SessionControlResult {
        accepted: true,
        terminal_geometry: None,
    })
}

fn direct_poll(
    attachment: &mut Attachment,
    params: SessionPollParams,
) -> Result<SessionPollResult> {
    let limit = usize::from(params.limit.clamp(1, 256));
    let mut events = Vec::with_capacity(limit.min(attachment.pending.len() + 1));
    while events.len() < limit {
        let Some(event) = attachment.pending.pop_front() else {
            break;
        };
        events.push(event);
    }
    if events.is_empty() && !attachment.closed {
        let wait = Duration::from_millis(params.wait_ms.min(1_000));
        if attachment
            .client
            .reader
            .get_ref()
            .set_read_timeout(Some(wait.max(Duration::from_millis(1))))
            .is_err()
        {
            attachment.closed = true;
            return Ok(SessionPollResult {
                attachment_id: params.attachment_id,
                closed: true,
                events,
            });
        }
        while events.len() < limit {
            match read_host_frame(&mut attachment.client) {
                Ok(Some(HostFrame::InputBatchAck { .. })) => {}
                Ok(Some(frame)) => {
                    if let Some(event) = host_event(
                        &mut attachment.cursor,
                        &mut attachment.replay_pending,
                        frame,
                    ) {
                        events.push(event);
                    }
                    let _ = attachment
                        .client
                        .reader
                        .get_ref()
                        .set_read_timeout(Some(Duration::from_millis(1)));
                }
                Ok(None) => {
                    attachment.closed = true;
                    break;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    break
                }
                Err(error) => {
                    attachment.closed = true;
                    let _ = attachment.client.reader.get_ref().set_read_timeout(None);
                    return Err(agentport_core::CoreError::Io(error).into());
                }
            }
        }
        let _ = attachment.client.reader.get_ref().set_read_timeout(None);
    }
    Ok(SessionPollResult {
        attachment_id: params.attachment_id,
        closed: attachment.closed,
        events,
    })
}

fn enqueue_poll_event(pending: &mut VecDeque<SessionEvent>, event: SessionEvent) {
    const MAX_PENDING: usize = 256;
    if pending.len() >= MAX_PENDING {
        pending.clear();
        pending.push_back(gap_event(event.cursor));
    } else {
        pending.push_back(event);
    }
}

fn gap_event(cursor: RunCursor) -> SessionEvent {
    resync_event(cursor, "remote_event_queue_overflow")
}

fn resync_event(cursor: RunCursor, reason: &str) -> SessionEvent {
    SessionEvent {
        event_type: "resync_required".into(),
        payload: serde_json::json!({
            "reason": reason,
            "authoritativeCursor": cursor,
        }),
        cursor,
    }
}

// Old Hosts already retain the recent PTY stream in memory. Scan its omitted
// prefix locally so small Mobile replays keep mouse/alternate/paste modes,
// without sending megabytes of obsolete redraws over the network.
fn prepare_terminal_seed(attachment: &mut Attachment, cutoff: u64) -> Result<()> {
    attachment
        .client
        .reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(agentport_core::CoreError::Io)?;
    let mut seed = terminal_seed::TerminalSeed::default();
    let mut seeded = false;
    let deadline = Instant::now() + Duration::from_secs(5);
    while attachment.replay_pending {
        if Instant::now() >= deadline {
            return Err(ServiceError::InvalidRequest);
        }
        let Some(mut frame) =
            read_host_frame(&mut attachment.client).map_err(agentport_core::CoreError::Io)?
        else {
            return Err(ServiceError::InvalidRequest);
        };
        if let HostFrame::TransientOutput { data, .. } = &frame {
            // New Hosts retain modes independently from their text ring. Old
            // Hosts simply omit this optional prefix.
            seed.advance(data);
            continue;
        }
        if let HostFrame::Output {
            session_id,
            data,
            offset,
            cursor,
        } = &mut frame
        {
            let skipped = cutoff.saturating_sub(*offset).min(data.len() as u64) as usize;
            seed.advance(&data[..skipped]);
            if skipped == data.len() {
                continue;
            }
            if !seeded {
                let modes = seed.bytes();
                if !modes.is_empty() {
                    let mut cursor = attachment.cursor.clone();
                    cursor.offset = (*offset).saturating_add(skipped as u64);
                    attachment.pending.push_back(SessionEvent {
                        event_type: "transient_output".into(), cursor,
                        payload: serde_json::json!({"sessionId":session_id, "dataBase64":base64::engine::general_purpose::STANDARD.encode(modes)}),
                    });
                }
                seeded = true;
            }
            data.drain(..skipped);
            *offset = offset.saturating_add(skipped as u64);
            cursor.offset = *offset as i64;
        }
        if let Some(event) = host_event(
            &mut attachment.cursor,
            &mut attachment.replay_pending,
            frame,
        ) {
            attachment.pending.push_back(event);
            if attachment.pending.len() >= PUSH_EVENT_QUEUE_CAPACITY {
                return Err(ServiceError::InvalidRequest);
            }
        }
    }
    attachment
        .client
        .reader
        .get_ref()
        .set_read_timeout(None)
        .map_err(agentport_core::CoreError::Io)?;
    Ok(())
}

fn push_worker(
    mut attachment: Attachment,
    commands: mpsc::Receiver<PushCommand>,
    events: mpsc::SyncSender<SessionEvent>,
    closed: Arc<AtomicBool>,
) {
    let _ = attachment
        .client
        .reader
        .get_ref()
        .set_read_timeout(Some(PUSH_READ_SLICE));
    let mut unexpected_close = false;
    'worker: loop {
        if closed.load(Ordering::Acquire) {
            break;
        }
        if let Some(event) = attachment.pending.pop_front() {
            if !push_event(&events, event, &closed, None) {
                break;
            }
            continue;
        }
        match commands.try_recv() {
            Ok(PushCommand::Input { params, reply }) => {
                let result = worker_input(&mut attachment, params, &events, &closed);
                let terminal = matches!(result, Err(ServiceError::InputOutcomeUnknown));
                let _ = reply.send(result);
                if terminal && attachment.closed {
                    unexpected_close = !attachment.host_exit_seen;
                    break;
                }
                continue;
            }
            Ok(PushCommand::StructuredPrompt { params, reply }) => {
                let result = attachment
                    .client
                    .send_structured_prompt(params.expose_text())
                    .map_err(ServiceError::from);
                let _ = reply.send(result);
                continue;
            }
            Ok(PushCommand::AbortStructuredTurn { reply }) => {
                let result = attachment
                    .client
                    .abort_structured_turn()
                    .map_err(ServiceError::from);
                let _ = reply.send(result);
                continue;
            }
            Ok(PushCommand::Control { params, reply }) => {
                let result = direct_control(&mut attachment, params);
                let terminal = result.is_err() && attachment.closed;
                let _ = reply.send(result);
                if terminal {
                    break;
                }
                continue;
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                let _ = attachment.client.detach();
                break;
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }

        match read_host_frame(&mut attachment.client) {
            Ok(Some(HostFrame::InputBatchAck { .. })) => {}
            Ok(Some(frame)) => {
                if matches!(frame, HostFrame::Exit { .. }) {
                    attachment.host_exit_seen = true;
                }
                if let Some(event) = host_event(
                    &mut attachment.cursor,
                    &mut attachment.replay_pending,
                    frame,
                ) {
                    if !push_event(&events, event, &closed, None) {
                        break 'worker;
                    }
                }
            }
            Ok(None) => {
                attachment.closed = true;
                unexpected_close = !attachment.host_exit_seen;
                break;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => {
                attachment.closed = true;
                unexpected_close = !attachment.host_exit_seen;
                break;
            }
        }
    }
    if closed.load(Ordering::Acquire) {
        let _ = attachment.client.detach();
    } else if unexpected_close {
        // Preserve real stream discontinuities after queued output, while
        // allowing detach to cancel even this final notification.
        let _ = push_event(
            &events,
            resync_event(attachment.cursor.clone(), "host_stream_closed"),
            &closed,
            None,
        );
    }
    closed.store(true, Ordering::Release);
}

fn worker_input(
    attachment: &mut Attachment,
    params: SessionInputParams,
    events: &mpsc::SyncSender<SessionEvent>,
    cancel: &AtomicBool,
) -> Result<SessionInputResult> {
    worker_input_with_timeout(attachment, params, events, cancel, Duration::from_secs(5))
}

fn worker_input_with_timeout(
    attachment: &mut Attachment,
    params: SessionInputParams,
    events: &mpsc::SyncSender<SessionEvent>,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<SessionInputResult> {
    let client_batch_id = params.batch_id.clone();
    let wire_batch_id = next_wire_batch_id(attachment)?;
    let data = params
        .decode_data()
        .map_err(|_| ServiceError::InvalidRequest)?;
    if attachment
        .client
        .send_input_batch(&wire_batch_id, data.as_slice())
        .is_err()
    {
        return Err(ServiceError::InputOutcomeUnknown);
    }
    let deadline = Instant::now() + timeout;
    let mut accepted_sequence = None;
    loop {
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err(ServiceError::InputOutcomeUnknown);
        }
        match read_host_frame(&mut attachment.client) {
            Ok(Some(HostFrame::InputBatchAck {
                batch_id,
                server_sequence,
                phase,
                ..
            })) if batch_id == wire_batch_id => match phase {
                InputBatchAckPhase::Accepted => {
                    if accepted_sequence.is_none() {
                        accepted_sequence = Some(server_sequence);
                    }
                }
                InputBatchAckPhase::Completed if accepted_sequence == Some(server_sequence) => {
                    return Ok(SessionInputResult {
                        batch_id: client_batch_id.clone(),
                        server_sequence,
                        phase: input_phase_name(phase).into(),
                    });
                }
                InputBatchAckPhase::NotExecuted
                    if accepted_sequence.is_none()
                        || accepted_sequence == Some(server_sequence) =>
                {
                    return Ok(SessionInputResult {
                        batch_id: client_batch_id.clone(),
                        server_sequence,
                        phase: input_phase_name(phase).into(),
                    });
                }
                InputBatchAckPhase::Unknown if accepted_sequence == Some(server_sequence) => {
                    return Err(ServiceError::InputOutcomeUnknown);
                }
                _ => {}
            },
            Ok(Some(HostFrame::InputBatchAck { .. })) => {}
            Ok(Some(frame)) => {
                if matches!(frame, HostFrame::Exit { .. }) {
                    attachment.host_exit_seen = true;
                }
                if let Some(event) = host_event(
                    &mut attachment.cursor,
                    &mut attachment.replay_pending,
                    frame,
                ) {
                    if !push_event(events, event, cancel, Some(deadline)) {
                        attachment.closed = true;
                        return Err(ServiceError::InputOutcomeUnknown);
                    }
                }
            }
            Ok(None) => {
                attachment.closed = true;
                return Err(ServiceError::InputOutcomeUnknown);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => {
                attachment.closed = true;
                return Err(ServiceError::InputOutcomeUnknown);
            }
        }
    }
}

fn next_wire_batch_id(attachment: &mut Attachment) -> Result<String> {
    attachment.next_input_batch_sequence = attachment
        .next_input_batch_sequence
        .checked_add(1)
        .ok_or(ServiceError::InvalidRequest)?;
    // The Host connection is attachment-scoped, so this monotonic identifier
    // is unique for every write without retaining caller-controlled IDs. A
    // late acknowledgement can never match a later request, even when the
    // mobile client reuses its display-level batch ID.
    Ok(format!("remote-{}", attachment.next_input_batch_sequence))
}

fn push_event(
    events: &mpsc::SyncSender<SessionEvent>,
    mut event: SessionEvent,
    cancel: &AtomicBool,
    deadline: Option<Instant>,
) -> bool {
    loop {
        if cancel.load(Ordering::Acquire) || deadline.is_some_and(|end| Instant::now() >= end) {
            return false;
        }
        match events.try_send(event) {
            Ok(()) => return true,
            Err(mpsc::TrySendError::Full(pending)) => {
                // Keep memory bounded and propagate pressure to the Host socket.
                // Unlike SyncSender::send, this wait is cancellable on detach.
                event = pending;
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(mpsc::TrySendError::Disconnected(_)) => return false,
        }
    }
}

fn remote_cursor_to_core(cursor: &RunCursor) -> Result<LogCursor> {
    Ok(LogCursor {
        run_id: cursor.run_id.clone(),
        run_ordinal: i64::try_from(cursor.run_ordinal).map_err(|_| ServiceError::InvalidRequest)?,
        generation: i64::try_from(cursor.generation).map_err(|_| ServiceError::InvalidRequest)?,
        offset: i64::try_from(cursor.offset).map_err(|_| ServiceError::InvalidRequest)?,
    })
}

fn core_cursor_to_remote(cursor: &LogCursor, status_sequence: u64) -> RunCursor {
    RunCursor {
        run_id: cursor.run_id.clone(),
        run_ordinal: u64::try_from(cursor.run_ordinal).unwrap_or_default(),
        generation: u64::try_from(cursor.generation).unwrap_or_default(),
        offset: u64::try_from(cursor.offset).unwrap_or_default(),
        status_sequence,
    }
}

fn attach_cursor(info: &AttachInfo) -> RunCursor {
    let status_sequence = info
        .current_status
        .as_ref()
        .and_then(|status| u64::try_from(status.sequence).ok())
        .unwrap_or_default();
    core_cursor_to_remote(&info.log_cursor, status_sequence)
}

fn read_host_frame(client: &mut HostClient) -> std::io::Result<Option<HostFrame>> {
    agentport_core::protocol::read_frame(&mut client.reader)
        .map(|frame| frame.map(|frame| normalize_host_frame(client.protocol, frame)))
}

fn input_phase_name(phase: InputBatchAckPhase) -> &'static str {
    match phase {
        InputBatchAckPhase::Accepted => "accepted",
        InputBatchAckPhase::Completed => "completed",
        InputBatchAckPhase::NotExecuted => "not_executed",
        InputBatchAckPhase::Unknown => "unknown",
    }
}

fn host_event(
    cursor: &mut RunCursor,
    replay_pending: &mut bool,
    frame: HostFrame,
) -> Option<SessionEvent> {
    // Hello carries the live high-water before retained replay frames. Do not
    // publish metadata at that future cursor ahead of the older Output stream;
    // ReplayDone will publish the authoritative high-water after replay.
    if *replay_pending
        && !matches!(
            &frame,
            HostFrame::Output { .. }
                | HostFrame::ReplayDone { .. }
                | HostFrame::ResyncRequired { .. }
        )
    {
        if let HostFrame::State { sequence, .. } = &frame {
            if let Ok(sequence) = u64::try_from(*sequence) {
                cursor.status_sequence = cursor.status_sequence.max(sequence);
            }
        }
        return None;
    }
    let event_type = match &frame {
        HostFrame::Output {
            data, cursor: next, ..
        } => {
            // Host Output cursor names the chunk start; the remote cursor names
            // bytes consumed after this event, making consecutive replay/live
            // events monotonic.
            let mut consumed = core_cursor_to_remote(next, cursor.status_sequence);
            consumed.offset = consumed.offset.saturating_add(data.len() as u64);
            *cursor = consumed;
            "output"
        }
        HostFrame::ReplayDone { cursor: next, .. } => {
            *cursor = core_cursor_to_remote(next, cursor.status_sequence);
            *replay_pending = false;
            "replay_done"
        }
        HostFrame::Heartbeat { .. } => {
            // Host metadata publication is not serialized with Output. Its
            // log cursor may be ahead of an Output frame not yet delivered, so
            // it must never advance the client's safe consumed-byte cursor.
            "heartbeat"
        }
        HostFrame::State { sequence, .. } => {
            if let Ok(sequence) = u64::try_from(*sequence) {
                cursor.status_sequence = cursor.status_sequence.max(sequence);
            }
            "state"
        }
        HostFrame::ResyncRequired { earliest, .. } => {
            *cursor = core_cursor_to_remote(earliest, cursor.status_sequence);
            *replay_pending = true;
            "resync_required"
        }
        HostFrame::TransientOutput { .. } => "transient_output",
        HostFrame::ProcessStatus { .. } => "process_status",
        HostFrame::Structured { .. } => "structured",
        HostFrame::AgentSession { .. } => "agent_session",
        HostFrame::Exit { .. } => "exit",
        HostFrame::Pong { .. } => "pong",
        HostFrame::Error { .. } => "error",
        HostFrame::InputBatchAck { .. } => "input_batch_ack",
        HostFrame::ResizeAck { .. } => "resize_ack",
        HostFrame::TerminalGeometryChanged { .. } => "terminal_geometry_changed",
        HostFrame::HelloOk { .. } => return None,
    };
    // HostFrame's binary serializer encodes terminal bytes as base64 and
    // contains no token, socket path, PID binding, argv, or log path.
    let payload = serde_json::to_value(&frame).ok()?;
    Some(SessionEvent {
        event_type: event_type.into(),
        cursor: cursor.clone(),
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentport_core::host_manager::HostClient;
    use agentport_core::models::LEGACY_RUN_ID;
    use agentport_core::models::{
        AgentTransport, AgentType, Lifecycle, PermissionMode, ResumePrecision,
    };
    use agentport_core::protocol::{
        read_frame, write_frame, ClientFrame, HostFrame, HOST_FEATURE_INPUT_BATCH_V1,
        PROTOCOL_VERSION,
    };
    use chrono::Utc;
    use std::io::BufReader;
    use std::os::unix::net::{UnixListener, UnixStream};

    fn accept_test_host(listener: UnixListener) -> (BufReader<UnixStream>, UnixStream, String) {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut writer = stream;
        let hello = read_frame::<ClientFrame>(&mut reader).unwrap().unwrap();
        let (session_id, protocol) = match hello {
            ClientFrame::Hello {
                session_id,
                protocol,
                ..
            } => (session_id, protocol),
            _ => panic!("unexpected Host handshake frame"),
        };
        write_frame(
            &mut writer,
            &HostFrame::HelloOk {
                protocol,
                session_id: session_id.clone(),
                host_pid: std::process::id(),
                child_alive: true,
                log_bytes: 0,
                agent_session_id: None,
                run_id: LEGACY_RUN_ID.into(),
                run_ordinal: 0,
                current_status: None,
                log_cursor: LogCursor::default(),
                features: vec![HOST_FEATURE_INPUT_BATCH_V1.into()],
                terminal_geometry: None,
            },
        )
        .unwrap();
        (reader, writer, session_id)
    }

    fn connect_test_attachment(socket: &std::path::Path, session_id: &str) -> Attachment {
        let (client, info) = HostClient::connect(
            &socket.to_string_lossy(),
            session_id,
            "0123456789abcdef0123456789abcdef",
            0,
        )
        .unwrap();
        Attachment {
            client,
            cursor: attach_cursor(&info),
            replay_pending: false,
            pending: VecDeque::new(),
            next_input_batch_sequence: 0,
            host_exit_seen: false,
            closed: false,
        }
    }

    fn test_input_params(batch_id: &str) -> SessionInputParams {
        serde_json::from_value(serde_json::json!({
            "attachmentId": "att-test",
            "batchId": batch_id,
            "dataBase64": "eA=="
        }))
        .unwrap()
    }

    #[test]
    fn service_is_usable_without_tauri_and_starts_empty() {
        let service = CoreService::memory().unwrap();
        assert!(service.list_sessions(false).unwrap().is_empty());
        let snapshot = service.service_snapshot();
        assert!(snapshot
            .capabilities
            .iter()
            .any(|capability| capability.name == "session.read" && capability.enabled));
    }

    #[test]
    fn pi_launch_plan_finalizes_epi_storage_without_starting_a_host() {
        let root = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(root.path().join("app"))
            .with_pi_sessions_root(root.path().join(".epi/agent/sessions"));
        let service = CoreService::open(paths).unwrap();
        let exe = root.path().join("pi-not-executed");
        std::fs::write(&exe, "fixture only").unwrap();
        let install = adapters::adapter_for(AgentType::Pi)
            .parse_capabilities(&exe, "fixture", "--session-id --session-dir --tui-mode")
            .unwrap();
        service.db.upsert_adapter(&install).unwrap();
        let project = service
            .add_project(ProjectAddParams {
                path: root.path().to_string_lossy().into_owned(),
                name: Some("Pi fixture".into()),
            })
            .unwrap();
        let (plan, _, _, id) = build_launch_plan(
            &service,
            &project.project.id,
            AgentType::Pi,
            None,
            None,
            PermissionMode::Native,
            AgentTransport::Pty,
            None,
        )
        .unwrap();
        let location = agentport_core::pi_storage::read_directory(&service.paths, &id).unwrap();
        assert!(location.starts_with(service.paths.pi_sessions_root().unwrap()));
        assert!(plan
            .argv
            .windows(2)
            .any(|pair| pair[0] == "--session-dir" && std::path::Path::new(&pair[1]) == location));
        assert!(plan.assigned_agent_session_id.is_some());
        assert!(!service.paths.host_config_path(&id).exists());
    }

    #[test]
    fn launch_facade_requires_risk_ack_before_side_effects_and_hides_desktop_facts() {
        let service = CoreService::memory().unwrap();
        assert!(matches!(
            service.create_session(SessionCreateParams {
                project_id: "missing".into(),
                agent: RemoteAgentType::Claude,
                title: None,
                preset_id: None,
                worktree_id: None,
                permission: "bypass".into(),
                transport: None,
                risk_ack: false,
                cols: None,
                rows: None,
                extra_args: None,
            }),
            Err(ServiceError::RiskAcknowledgementRequired)
        ));
        assert!(service.list_sessions(true).unwrap().is_empty());
        assert!(matches!(
            service.create_session(SessionCreateParams {
                project_id: "missing".into(),
                agent: RemoteAgentType::Shell,
                title: None,
                preset_id: None,
                worktree_id: None,
                permission: "native".into(),
                transport: None,
                risk_ack: false,
                cols: None,
                rows: None,
                extra_args: None,
            }),
            Err(ServiceError::NotExecutedCore(_))
        ));

        let result = SessionLaunchResult {
            session_id: "ses_safe".into(),
            resume_precision: "exact".into(),
            agent_session_id: Some("native-safe".into()),
            notices: Vec::new(),
            host_pid: 4242,
            child_alive: true,
            command: vec!["COMMAND_MUST_STAY_DESKTOP_LOCAL".into()],
        };
        let encoded = serde_json::to_string(&result).unwrap();
        assert!(!encoded.contains("4242"));
        assert!(!encoded.contains("COMMAND_MUST_STAY_DESKTOP_LOCAL"));
        assert!(encoded.contains("ses_safe"));
    }

    #[test]
    fn facade_uses_all_six_core_adapters_and_revisioned_preferences() {
        let service = CoreService::memory().unwrap();
        let supported = service.supported_agents().unwrap();
        assert_eq!(supported.len(), AgentType::all().len());
        assert_eq!(
            supported
                .iter()
                .map(|agent| agent.agent.as_str())
                .collect::<Vec<_>>(),
            AgentType::all()
                .iter()
                .map(AgentType::as_str)
                .collect::<Vec<_>>()
        );
        let initial = service.agent_preferences().unwrap();
        let replaced = service
            .replace_agent_preferences(
                AgentPreferencesReplaceParams {
                    agent_order: vec!["claude".into(), "future-agent".into(), "shell".into()],
                    agent_hidden: vec!["pi".into()],
                },
                initial.revision,
            )
            .unwrap();
        assert_eq!(replaced.revision, initial.revision + 1);
        let core_preferences = service.db.load_agent_preferences().unwrap();
        assert_eq!(core_preferences.revision, replaced.revision);
        assert_eq!(core_preferences.agent_order, replaced.agent_order);
        assert_eq!(core_preferences.agent_hidden, replaced.agent_hidden);
        assert!(replaced
            .agent_order
            .iter()
            .any(|agent| agent == "future-agent"));
        assert!(matches!(
            service.replace_agent_preferences(
                AgentPreferencesReplaceParams {
                    agent_order: vec!["shell".into(), "shell".into()],
                    agent_hidden: vec![],
                },
                replaced.revision,
            ),
            Err(ServiceError::InvalidRequest)
        ));
        assert!(matches!(
            service.replace_agent_preferences(
                AgentPreferencesReplaceParams {
                    agent_order: vec!["shell".into()],
                    agent_hidden: vec![],
                },
                initial.revision,
            ),
            Err(ServiceError::PreconditionFailed)
        ));
    }

    #[test]
    fn restart_reconciles_ended_host_before_rejecting_stale_running_state() {
        // The phone receives Exit directly, while DB lifecycle can remain
        // Running until the desktop reaper observes it. No Host is launched:
        // reaching RiskAcknowledgementRequired proves the stale guard cleared.
        for (case, alive, exit_run, lifecycle, expected) in [
            ("matching-exit", false, Some("current-run"), Lifecycle::Running, Lifecycle::Exited),
            ("dead-no-exit", false, None, Lifecycle::Running, Lifecycle::Interrupted),
            ("live-no-exit", true, None, Lifecycle::Running, Lifecycle::Running),
            ("live-old-exit", true, Some("old-run"), Lifecycle::Running, Lifecycle::Running),
            ("creating-no-pid", false, None, Lifecycle::Creating, Lifecycle::Creating),
        ] {
            let root = tempfile::tempdir().unwrap();
            let service = CoreService::open(AppPaths::new(root.path().join("app"))).unwrap();
            let project = service.add_project(ProjectAddParams {
                path: root.path().to_string_lossy().into_owned(), name: Some(case.into()),
            }).unwrap();
            let id = "ses_restart_fixture";
            let dir = service.paths.session_dir(id);
            std::fs::create_dir_all(&dir).unwrap();
            let log = dir.join("output.log").to_string_lossy().into_owned();
            service.db.insert_session(&Session {
                id: id.into(), project_id: project.project.id, worktree_id: None,
                preset_id: "pre_codex_bypass".into(), title: case.into(),
                cwd: root.path().to_string_lossy().into_owned(), host_pid: None,
                host_socket: None, host_token: "fixture-only-token".into(), lifecycle,
                agent_session_id: None, resume_precision: ResumePrecision::Unavailable,
                log_path: log.clone(), adapter_type: AgentType::Codex,
                transport: AgentTransport::Pty, command: Vec::new(),
                permission_mode: PermissionMode::Bypass, pinned_at: None,
                created_at: Utc::now(), updated_at: Utc::now(), archived_at: None,
            }).unwrap();
            let run = service.db.create_session_run(id, "current-run").unwrap();
            service.db.claim_session_run(id, &run.run_id, run.run_ordinal, &log).unwrap();
            let pid = if alive { i64::from(std::process::id()) } else { i64::from(i32::MAX) };
            if lifecycle == Lifecycle::Running {
                assert!(service.db.bind_session_host_for_run(id, &run.run_id, run.run_ordinal, pid, "/tmp/not-a-real-host.sock").unwrap());
                service.db.update_session_lifecycle(id, lifecycle).unwrap();
            }
            if let Some(exit_run) = exit_run {
                std::fs::write(dir.join("host-state.json"), serde_json::to_vec(&serde_json::json!({
                    "session_id": id, "host_pid": pid, "run_id": exit_run,
                    "run_ordinal": run.run_ordinal, "exit_reason": "process_exit",
                    "exited_at": Utc::now(), "exit_code": 0, "group_cleaned": true,
                })).unwrap()).unwrap();
            }
            let result = service.restart_session(SessionRestartParams { session_id: id.into(), risk_ack: false });
            if matches!(expected, Lifecycle::Exited | Lifecycle::Interrupted) {
                assert!(matches!(result, Err(ServiceError::RiskAcknowledgementRequired)), "{case}: {result:?}");
            } else {
                assert!(matches!(result, Err(ServiceError::PreconditionFailed)), "{case}: {result:?}");
            }
            assert_eq!(service.db.get_session(id).unwrap().lifecycle, expected, "{case}");
        }
    }

    #[test]
    fn project_facade_requires_echoed_preflight_and_cascades_metadata() {
        let service = CoreService::memory().unwrap();
        let root = tempfile::tempdir().unwrap();
        let added = service
            .add_project(ProjectAddParams {
                path: root.path().to_string_lossy().into_owned(),
                name: Some("Remote Project".into()),
            })
            .unwrap();
        let core_project = service.db.get_project(&added.project.id).unwrap();
        assert_eq!(added.project, ProjectSummary::from(core_project));
        let archived_id = "ses_remote_archived";
        let archived_dir = service.paths.session_dir(archived_id);
        std::fs::create_dir_all(&archived_dir).unwrap();
        std::fs::write(archived_dir.join("marker"), b"cleanup").unwrap();
        service
            .db
            .insert_session(&Session {
                id: archived_id.into(),
                project_id: added.project.id.clone(),
                worktree_id: None,
                preset_id: "pre_shell_safe".into(),
                title: "archived".into(),
                cwd: root.path().to_string_lossy().into_owned(),
                host_pid: None,
                host_socket: None,
                host_token: "fixture-only-token".into(),
                lifecycle: Lifecycle::Exited,
                agent_session_id: None,
                resume_precision: ResumePrecision::Unavailable,
                log_path: archived_dir
                    .join("output.log")
                    .to_string_lossy()
                    .into_owned(),
                adapter_type: AgentType::Shell,
                transport: AgentTransport::Pty,
                command: Vec::new(),
                permission_mode: PermissionMode::Native,
                pinned_at: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                archived_at: Some(Utc::now()),
            })
            .unwrap();
        let preflight = service
            .project_remove_preflight(ProjectIdParams {
                project_id: added.project.id.clone(),
            })
            .unwrap();
        assert_eq!(preflight.archived_session_count, 1);
        assert_eq!(preflight.sessions[0].session_id, archived_id);
        assert_eq!(
            preflight.revision,
            service
                .db
                .project_removal_snapshot(&added.project.id)
                .unwrap()
                .revision
                .to_string()
        );
        let mut stale = preflight_to_params(&preflight);
        stale.revision = stale
            .revision
            .parse::<u64>()
            .unwrap()
            .wrapping_add(1)
            .to_string();
        assert!(matches!(
            service.remove_project(stale),
            Err(ServiceError::PreconditionFailed)
        ));
        service
            .remove_project(preflight_to_params(&preflight))
            .unwrap();
        assert!(service.list_projects().unwrap().is_empty());
        assert!(!archived_dir.exists());
    }

    #[test]
    fn project_removal_preserves_authority_when_host_cleanup_is_unproven() {
        let service = CoreService::memory().unwrap();
        let root = tempfile::tempdir().unwrap();
        let added = service
            .add_project(ProjectAddParams {
                path: root.path().to_string_lossy().into_owned(),
                name: Some("Fail Closed".into()),
            })
            .unwrap();
        let running_id = "ses_unverified_stop";
        service
            .db
            .insert_session(&Session {
                id: running_id.into(),
                project_id: added.project.id.clone(),
                worktree_id: None,
                preset_id: "pre_shell_safe".into(),
                title: "running".into(),
                cwd: root.path().to_string_lossy().into_owned(),
                host_pid: Some(std::process::id() as i64),
                host_socket: Some(
                    root.path()
                        .join("missing.sock")
                        .to_string_lossy()
                        .into_owned(),
                ),
                host_token: "0123456789abcdef0123456789abcdef".into(),
                lifecycle: Lifecycle::Running,
                agent_session_id: None,
                resume_precision: ResumePrecision::Unavailable,
                log_path: root
                    .path()
                    .join("output.log")
                    .to_string_lossy()
                    .into_owned(),
                adapter_type: AgentType::Shell,
                transport: AgentTransport::Pty,
                command: Vec::new(),
                permission_mode: PermissionMode::Native,
                pinned_at: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                archived_at: None,
            })
            .unwrap();
        let preflight = service
            .project_remove_preflight(ProjectIdParams {
                project_id: added.project.id.clone(),
            })
            .unwrap();

        assert!(matches!(
            service.remove_project(preflight_to_params(&preflight)),
            Err(ServiceError::Core(agentport_core::CoreError::Host(_)))
        ));
        assert!(service.db.get_project(&added.project.id).is_ok());
        assert!(service.db.get_session(running_id).is_ok());
        // The failed attempt releases only its temporary fence, so authority
        // remains usable and a later reconcile/retry is possible.
        let mut another = service.db.get_session(running_id).unwrap();
        another.id = "ses_after_abort".into();
        another.lifecycle = Lifecycle::Stopped;
        another.host_pid = None;
        another.host_socket = None;
        service.db.insert_session(&another).unwrap();
    }

    #[test]
    fn session_metadata_archive_and_recovery_facade_preserves_core_semantics() {
        let service = CoreService::memory().unwrap();
        service.paths.ensure_layout().unwrap();
        let root = tempfile::tempdir().unwrap();
        let project = service
            .add_project(ProjectAddParams {
                path: root.path().to_string_lossy().into_owned(),
                name: Some("Sessions".into()),
            })
            .unwrap();
        let session_id = "ses_facade";
        let session_dir = service.paths.session_dir(session_id);
        std::fs::create_dir_all(&session_dir).unwrap();
        let log_path = session_dir.join("output.log");
        std::fs::write(&log_path, b"0123456789").unwrap();
        service
            .db
            .insert_session(&Session {
                id: session_id.into(),
                project_id: project.project.id,
                worktree_id: None,
                preset_id: "pre_shell_safe".into(),
                title: "initial".into(),
                cwd: root.path().to_string_lossy().into_owned(),
                host_pid: None,
                host_socket: None,
                host_token: "fixture-only-token".into(),
                lifecycle: Lifecycle::Exited,
                agent_session_id: None,
                resume_precision: ResumePrecision::Unavailable,
                log_path: log_path.to_string_lossy().into_owned(),
                adapter_type: AgentType::Shell,
                transport: AgentTransport::Pty,
                command: Vec::new(),
                permission_mode: PermissionMode::Native,
                pinned_at: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                archived_at: None,
            })
            .unwrap();

        let renamed = service
            .rename_session(SessionRenameParams {
                session_id: session_id.into(),
                title: "renamed".into(),
            })
            .unwrap();
        assert_eq!(renamed.title, "renamed");
        let pinned = service
            .pin_session(SessionPinParams {
                session_id: session_id.into(),
                pinned: true,
            })
            .unwrap();
        assert!(pinned.pinned_at.is_some());

        let cursor = LogCursor {
            run_id: "run-facade".into(),
            run_ordinal: 1,
            generation: 2,
            offset: 10,
        };
        service
            .db
            .set_latest_log_cursor(session_id, &cursor)
            .unwrap();
        let context = service
            .read_recovery_context(SessionRecoveryContextParams {
                session_id: session_id.into(),
                cursor: RunCursor {
                    run_id: cursor.run_id.clone(),
                    run_ordinal: 1,
                    generation: 2,
                    offset: 5,
                    status_sequence: 0,
                },
            })
            .unwrap();
        assert_eq!(context.offset, 0);
        assert_eq!(context.total, 10);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(context.data_base64)
                .unwrap(),
            b"0123456789"
        );
        assert!(matches!(
            service.read_recovery_context(SessionRecoveryContextParams {
                session_id: session_id.into(),
                cursor: RunCursor {
                    generation: 3,
                    ..context.cursor
                },
            }),
            Err(ServiceError::PreconditionFailed)
        ));

        service
            .archive_session(SessionIdParams {
                session_id: session_id.into(),
            })
            .unwrap();
        assert_eq!(service.list_archived_sessions().unwrap().len(), 1);
        service
            .unarchive_session(SessionIdParams {
                session_id: session_id.into(),
            })
            .unwrap();
        assert!(service.list_archived_sessions().unwrap().is_empty());
        service
            .archive_session(SessionIdParams {
                session_id: session_id.into(),
            })
            .unwrap();
        service
            .delete_archived_session(SessionIdParams {
                session_id: session_id.into(),
            })
            .unwrap();
        assert!(service.db.get_session(session_id).is_err());
        assert!(!session_dir.exists());
    }

    #[test]
    fn worktree_facade_uses_backend_preview_and_strict_branch_selection() {
        let service = CoreService::memory().unwrap();
        service.paths.ensure_layout().unwrap();
        let root = tempfile::tempdir().unwrap();
        let project = service
            .add_project(ProjectAddParams {
                path: root.path().to_string_lossy().into_owned(),
                name: Some("Worktree Facade".into()),
            })
            .unwrap();
        let preview = service
            .preview_worktree(WorktreePreviewParams {
                project_id: project.project.id,
                task: "Fix Login".into(),
            })
            .unwrap();
        assert_eq!(preview.branch, "agent/fix-login");
        assert!(matches!(
            parse_worktree_branch_selection("existing", Some("main"), None),
            Err(ServiceError::InvalidRequest)
        ));
        assert!(matches!(
            parse_worktree_branch_selection("auto", Some("named"), None),
            Err(ServiceError::InvalidRequest)
        ));
    }

    #[test]
    fn git_extended_facade_resolves_status_and_mutates_only_with_backend_tokens() {
        let service = CoreService::memory().unwrap();
        service.paths.ensure_layout().unwrap();
        let root = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(root.path())
                .status()
                .unwrap();
            assert!(status.success(), "git {:?}", args);
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "service@example.invalid"]);
        git(&["config", "user.name", "Service Test"]);
        std::fs::write(root.path().join("tracked.txt"), b"base\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "base"]);
        let project = service
            .add_project(ProjectAddParams {
                path: root.path().to_string_lossy().into_owned(),
                name: Some("Git Facade".into()),
            })
            .unwrap();
        std::fs::write(root.path().join("new.txt"), b"new\n").unwrap();
        let locator = serde_json::json!({
            "kind": "projectMain",
            "projectId": project.project.id,
        });
        let changes = service
            .extended_facade(
                "git.changes",
                serde_json::json!({"locator": locator, "includeIgnored": true}),
            )
            .unwrap();
        let checkout_id = changes["context"]["checkoutId"].as_str().unwrap();
        let status_token = changes["statusToken"].as_str().unwrap();
        let entry = changes["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["displayPath"] == "new.txt")
            .unwrap();
        let staged = service
            .extended_facade(
                "git.stage",
                serde_json::json!({
                    "locator": locator,
                    "expectedCheckoutId": checkout_id,
                    "expectedStatusToken": status_token,
                    "selections": [{
                        "pathToken": entry["pathToken"],
                        "entryToken": entry["entryToken"],
                    }],
                }),
            )
            .unwrap();
        assert_eq!(staged["changes"]["counts"]["staged"], 1);
        assert!(matches!(
            service.extended_facade(
                "git.changes",
                serde_json::json!({"locator": locator, "unexpected": true}),
            ),
            Err(ServiceError::InvalidRequest)
        ));
    }

    #[test]
    fn branch_extended_facade_creates_and_lists_with_strict_params() {
        let service = CoreService::memory().unwrap();
        service.paths.ensure_layout().unwrap();
        let root = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(root.path())
                .status()
                .unwrap();
            assert!(status.success(), "git {:?}", args);
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "service@example.invalid"]);
        git(&["config", "user.name", "Service Test"]);
        std::fs::write(root.path().join("tracked.txt"), b"base\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "base"]);
        let project = service
            .add_project(ProjectAddParams {
                path: root.path().to_string_lossy().into_owned(),
                name: Some("Branch Facade".into()),
            })
            .unwrap();
        let project_id = project.project.id;

        let created = service
            .extended_facade(
                "branch.create",
                serde_json::json!({"projectId": project_id, "name": "feature/mobile"}),
            )
            .unwrap();
        assert_eq!(created["branch"]["name"], "feature/mobile");

        let listed = service
            .extended_facade("branch.list", serde_json::json!({"projectId": project_id}))
            .unwrap();
        assert!(listed["branches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|branch| branch["name"] == "feature/mobile"));
        assert!(matches!(
            service.extended_facade(
                "branch.create",
                serde_json::json!({
                    "projectId": project_id,
                    "name": "feature/rejected",
                    "unexpected": true,
                }),
            ),
            Err(ServiceError::InvalidRequest)
        ));
        assert!(matches!(
            service.extended_facade(
                "branch.autostash.restore",
                serde_json::json!({"operationId": "op_missing", "strategy": "invalid"}),
            ),
            Err(ServiceError::InvalidRequest)
        ));
    }

    #[test]
    fn commit_ai_facade_round_trips_non_secret_config_and_rejects_unknown_fields() {
        let service = CoreService::memory().unwrap();
        let saved = service
            .save_commit_ai_config(CommitAiConfigSaveParams {
                provider: "anthropic".into(),
                base_url: "https://example.invalid/v1".into(),
                model: "test-model".into(),
                api_key: None,
                language: "en".into(),
            })
            .unwrap();
        assert_eq!(saved["provider"], "anthropic");
        assert_eq!(saved["language"], "en");
        assert_eq!(saved["hasApiKey"], false);
        assert!(matches!(
            service.extended_facade(
                "commit_ai.config.get",
                serde_json::json!({"unexpected": true}),
            ),
            Err(ServiceError::InvalidRequest)
        ));
        assert!(matches!(
            service.extended_facade(
                "commit_ai.generate",
                serde_json::json!({"unexpected": true}),
            ),
            Err(ServiceError::InvalidRequest)
        ));
    }

    #[test]
    fn content_history_settings_and_diagnostics_facade_is_strict_and_bounded() {
        let service = CoreService::memory().unwrap();
        service.paths.ensure_layout().unwrap();
        let settings = service
            .extended_facade("settings.get", serde_json::json!({}))
            .unwrap();
        assert_eq!(settings["telemetryEnabled"], false);
        let mut replacement = settings.clone();
        replacement["terminalFontSize"] = serde_json::json!(18);
        service
            .extended_facade("settings.save", replacement)
            .unwrap();
        assert_eq!(
            service
                .extended_facade("settings.get", serde_json::json!({}))
                .unwrap()["terminalFontSize"],
            18
        );
        assert!(matches!(
            service.extended_facade("settings.save", serde_json::json!({"unexpected": true}),),
            Err(ServiceError::InvalidRequest)
        ));
        assert!(matches!(
            service.extended_facade(
                "search.global",
                serde_json::json!({"query": "x", "limit": 20}),
            ),
            Err(ServiceError::InvalidRequest)
        ));
        assert!(service
            .extended_facade("diagnostics.hosts", serde_json::json!({}))
            .unwrap()
            .is_array());
        assert!(service
            .extended_facade("backup.list", serde_json::json!({}))
            .unwrap()
            .is_array());
        assert!(matches!(
            service.extended_facade(
                "backup.restore",
                serde_json::json!({
                    "path": "/tmp/missing.zip",
                    "target": service.paths.root(),
                }),
            ),
            Err(ServiceError::InvalidRequest)
        ));
        assert!(matches!(
            service.extended_facade(
                "export.session",
                serde_json::json!({
                    "sessionId": "missing",
                    "kind": "log",
                    "destination": "/tmp/output.log",
                }),
            ),
            Err(ServiceError::InvalidRequest)
        ));

        let documents = tempfile::tempdir().unwrap();
        let document = documents.path().join("note.md");
        std::fs::write(&document, "before").unwrap();
        let read = service
            .extended_facade("document.read", serde_json::json!({"path": document}))
            .unwrap();
        assert_eq!(read["content"], "before");
        service
            .write_document(DocumentWriteParams::new(
                document.to_string_lossy().into_owned(),
                "after".into(),
            ))
            .unwrap();
        assert_eq!(std::fs::read_to_string(&document).unwrap(), "after");
        let created = documents.path().join("nested").join("new.md");
        service
            .extended_facade(
                "document.create",
                serde_json::json!({"path": created, "kind": "file"}),
            )
            .unwrap();
        let listing = service
            .extended_facade(
                "document.list",
                serde_json::json!({"path": documents.path()}),
            )
            .unwrap();
        assert_eq!(listing["entries"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn preset_list_does_not_expose_stored_argv() {
        let service = CoreService::memory().unwrap();
        service
            .db
            .upsert_preset(&Preset {
                id: "pre_remote_safe".into(),
                agent_type: AgentType::Shell,
                name: "safe".into(),
                executable_path: "/bin/sh".into(),
                args: vec!["ARGV_MARKER_MUST_NOT_LEAVE_HOST".into()],
                permission_mode: PermissionMode::Native,
                env_names: vec!["SAFE_NAME".into()],
                secret_ref_ids: Vec::new(),
                built_in: false,
            })
            .unwrap();
        let encoded = serde_json::to_string(
            &service
                .list_presets(PresetListParams { agent: None })
                .unwrap(),
        )
        .unwrap();
        assert!(!encoded.contains("ARGV_MARKER_MUST_NOT_LEAVE_HOST"));
        assert!(encoded.contains("pre_remote_safe"));
    }

    #[test]
    fn secret_list_serializes_metadata_without_account_service_or_value() {
        let service = CoreService::memory().unwrap();
        service
            .db
            .upsert_secret_ref(&agentport_core::models::SecretRef {
                id: "sec_safe".into(),
                env_name: "TOKEN".into(),
                backend: agentport_core::models::SecretBackend::MacosKeychain,
                service: "must-not-serialize-service".into(),
                account: "must-not-serialize-account".into(),
                updated_at: Utc::now(),
            })
            .unwrap();
        let encoded = serde_json::to_string(&service.list_secrets().unwrap()).unwrap();
        assert!(!encoded.contains("must-not-serialize"));
        assert!(!encoded.to_ascii_lowercase().contains("value"));
        assert!(encoded.contains("sec_safe"));
    }

    fn preflight_to_params(preflight: &ProjectRemovalPreflight) -> ProjectRemoveParams {
        ProjectRemoveParams {
            project_id: preflight.project_id.clone(),
            revision: preflight.revision.clone(),
            sessions: preflight.sessions.clone(),
            worktree_ids: preflight.worktree_ids.clone(),
            recoverable_operation_ids: preflight.recoverable_operation_ids.clone(),
            pending_commit_operation_ids: preflight.pending_commit_operation_ids.clone(),
        }
    }

    #[test]
    fn input_waits_for_host_completion_and_preserves_interleaved_output_for_poll() {
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut writer = stream;
            let hello = read_frame::<ClientFrame>(&mut reader).unwrap().unwrap();
            let (session_id, protocol) = match hello {
                ClientFrame::Hello {
                    session_id,
                    protocol,
                    ..
                } => (session_id, protocol),
                _ => panic!("unexpected Host handshake frame"),
            };
            write_frame(
                &mut writer,
                &HostFrame::HelloOk {
                    protocol,
                    session_id: session_id.clone(),
                    host_pid: std::process::id(),
                    child_alive: true,
                    log_bytes: 0,
                    agent_session_id: None,
                    run_id: LEGACY_RUN_ID.into(),
                    run_ordinal: 0,
                    current_status: None,
                    log_cursor: LogCursor::default(),
                    features: vec![HOST_FEATURE_INPUT_BATCH_V1.into()],
                    terminal_geometry: None,
                },
            )
            .unwrap();
            let batch = read_frame::<ClientFrame>(&mut reader).unwrap().unwrap();
            let batch_id = match batch {
                ClientFrame::InputBatch { batch_id, data, .. } => {
                    assert_eq!(data, b"hello");
                    batch_id
                }
                _ => panic!("unexpected Host input frame"),
            };
            write_frame(
                &mut writer,
                &HostFrame::InputBatchAck {
                    session_id: session_id.clone(),
                    batch_id: batch_id.clone(),
                    server_sequence: 9,
                    phase: InputBatchAckPhase::Accepted,
                    message: None,
                },
            )
            .unwrap();
            write_frame(
                &mut writer,
                &HostFrame::Output {
                    session_id: session_id.clone(),
                    data: b"safe-output".to_vec(),
                    offset: 0,
                    cursor: LogCursor::default(),
                },
            )
            .unwrap();
            write_frame(
                &mut writer,
                &HostFrame::InputBatchAck {
                    session_id,
                    batch_id,
                    server_sequence: 9,
                    phase: InputBatchAckPhase::Completed,
                    message: None,
                },
            )
            .unwrap();
        });

        let socket = socket.to_string_lossy().into_owned();
        let (client, info) = HostClient::connect(
            &socket,
            "ses-runtime",
            "0123456789abcdef0123456789abcdef",
            0,
        )
        .unwrap();
        assert_eq!(info.protocol, PROTOCOL_VERSION);
        let service = CoreService::memory().unwrap();
        service.attachments.lock().unwrap().insert(
            "att-runtime".into(),
            Arc::new(Mutex::new(AttachmentState::Direct(Attachment {
                client,
                cursor: attach_cursor(&info),
                replay_pending: false,
                pending: VecDeque::new(),
                next_input_batch_sequence: 0,
                host_exit_seen: false,
                closed: false,
            }))),
        );
        let input: SessionInputParams = serde_json::from_value(serde_json::json!({
            "attachmentId": "att-runtime",
            "batchId": "batch-runtime",
            "dataBase64": "aGVsbG8="
        }))
        .unwrap();
        let receipt = service.input_session(input).unwrap();
        assert_eq!(receipt.server_sequence, 9);
        assert_eq!(receipt.phase, "completed");

        let polled = service
            .poll_session(SessionPollParams {
                attachment_id: "att-runtime".into(),
                limit: 8,
                wait_ms: 1,
            })
            .unwrap();
        assert_eq!(polled.events.len(), 1);
        assert_eq!(polled.events[0].event_type, "output");
        assert_eq!(polled.events[0].cursor.offset, b"safe-output".len() as u64);
        let json = serde_json::to_string(&polled).unwrap();
        assert!(json.contains("c2FmZS1vdXRwdXQ="));
        assert!(!json.contains("0123456789abcdef"));
        server.join().unwrap();

        let closed = service
            .poll_session(SessionPollParams {
                attachment_id: "att-runtime".into(),
                limit: 8,
                wait_ms: 1,
            })
            .unwrap();
        assert!(
            closed.closed,
            "closed peer must become observable, not EINVAL-loop"
        );
    }

    #[test]
    fn push_worker_owns_ack_reads_and_delivers_interleaved_output() {
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("push-host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut writer = stream;
            let hello = read_frame::<ClientFrame>(&mut reader).unwrap().unwrap();
            let (session_id, protocol) = match hello {
                ClientFrame::Hello {
                    session_id,
                    protocol,
                    ..
                } => (session_id, protocol),
                _ => panic!("unexpected Host handshake frame"),
            };
            write_frame(
                &mut writer,
                &HostFrame::HelloOk {
                    protocol,
                    session_id: session_id.clone(),
                    host_pid: std::process::id(),
                    child_alive: true,
                    log_bytes: 0,
                    agent_session_id: None,
                    run_id: LEGACY_RUN_ID.into(),
                    run_ordinal: 0,
                    current_status: None,
                    log_cursor: LogCursor::default(),
                    features: vec![HOST_FEATURE_INPUT_BATCH_V1.into()],
                    terminal_geometry: None,
                },
            )
            .unwrap();
            let prompt = read_frame::<ClientFrame>(&mut reader).unwrap().unwrap();
            assert!(matches!(
                prompt,
                ClientFrame::StructuredPrompt { ref text, .. } if text == "structured secret"
            ));
            assert!(matches!(
                read_frame::<ClientFrame>(&mut reader).unwrap().unwrap(),
                ClientFrame::AbortStructuredTurn { .. }
            ));
            let batch = read_frame::<ClientFrame>(&mut reader).unwrap().unwrap();
            let batch_id = match batch {
                ClientFrame::InputBatch { batch_id, .. } => batch_id,
                _ => panic!("unexpected Host input frame"),
            };
            write_frame(
                &mut writer,
                &HostFrame::InputBatchAck {
                    session_id: session_id.clone(),
                    batch_id: batch_id.clone(),
                    server_sequence: 11,
                    phase: InputBatchAckPhase::Accepted,
                    message: None,
                },
            )
            .unwrap();
            write_frame(
                &mut writer,
                &HostFrame::Output {
                    session_id: session_id.clone(),
                    data: b"pushed".to_vec(),
                    offset: 0,
                    cursor: LogCursor::default(),
                },
            )
            .unwrap();
            write_frame(
                &mut writer,
                &HostFrame::InputBatchAck {
                    session_id,
                    batch_id,
                    server_sequence: 11,
                    phase: InputBatchAckPhase::Completed,
                    message: None,
                },
            )
            .unwrap();
            assert!(matches!(
                read_frame::<ClientFrame>(&mut reader).unwrap().unwrap(),
                ClientFrame::Detach { .. }
            ));
        });

        let (client, info) = HostClient::connect(
            &socket.to_string_lossy(),
            "ses-push",
            "0123456789abcdef0123456789abcdef",
            0,
        )
        .unwrap();
        let service = CoreService::memory().unwrap();
        service.attachments.lock().unwrap().insert(
            "att-push".into(),
            Arc::new(Mutex::new(AttachmentState::Direct(Attachment {
                client,
                cursor: attach_cursor(&info),
                replay_pending: false,
                pending: VecDeque::new(),
                next_input_batch_sequence: 0,
                host_exit_seen: false,
                closed: false,
            }))),
        );
        let subscription = service.subscribe_session("att-push").unwrap();
        let prompt: SessionStructuredPromptParams = serde_json::from_value(serde_json::json!({
            "attachmentId": "att-push",
            "text": "structured secret"
        }))
        .unwrap();
        service.structured_prompt(prompt).unwrap();
        service
            .abort_structured_turn(SessionDetachParams {
                attachment_id: "att-push".into(),
            })
            .unwrap();
        let input: SessionInputParams = serde_json::from_value(serde_json::json!({
            "attachmentId": "att-push",
            "batchId": "batch-push",
            "dataBase64": "aGVsbG8="
        }))
        .unwrap();
        let receipt = service.input_session(input).unwrap();
        assert_eq!(receipt.phase, "completed");
        assert_eq!(receipt.server_sequence, 11);
        let event = subscription.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event.event_type, "output");
        assert_eq!(event.cursor.offset, 6);
        assert!(matches!(
            subscription.recv_timeout(Duration::from_millis(30)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        service
            .detach_session(SessionDetachParams {
                attachment_id: "att-push".into(),
            })
            .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn small_replay_keeps_modes_tail_and_exact_output_cursor() {
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("seed-host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let prefix = b"old text\x1b[?1049h\x1b[?1003;1006h".to_vec();
        let cutoff = prefix.len() as u64;
        let (proceed_tx, proceed_rx) = mpsc::sync_channel(1);
        let server = std::thread::spawn(move || {
            let (_reader, mut writer, session_id) = accept_test_host(listener);
            proceed_rx.recv().unwrap();
            let mut data = prefix;
            data.extend_from_slice(b"current screen");
            let end = data.len() as u64;
            write_frame(
                &mut writer,
                &HostFrame::Output {
                    session_id: session_id.clone(),
                    data,
                    offset: 0,
                    cursor: LogCursor::default(),
                },
            )
            .unwrap();
            write_frame(
                &mut writer,
                &HostFrame::ReplayDone {
                    session_id,
                    offset: end,
                    cursor: LogCursor {
                        offset: end as i64,
                        ..LogCursor::default()
                    },
                    partial_context: false,
                },
            )
            .unwrap();
            proceed_rx.recv().unwrap();
        });
        let mut attachment = connect_test_attachment(&socket, "ses-seed");
        proceed_tx.send(()).unwrap();
        attachment.replay_pending = true;
        prepare_terminal_seed(&mut attachment, cutoff).unwrap();
        assert!(!attachment.replay_pending);
        assert_eq!(attachment.pending.len(), 3);
        let seed = attachment.pending.pop_front().unwrap();
        assert_eq!(seed.event_type, "transient_output");
        assert_eq!(seed.cursor.offset, cutoff);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(seed.payload["dataBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes, b"\x1b[?1003h\x1b[?1006h\x1b[?1049h");
        let tail = attachment.pending.pop_front().unwrap();
        assert_eq!(tail.event_type, "output");
        assert_eq!(tail.cursor.offset, cutoff + 14);
        let host: HostFrame = serde_json::from_value(tail.payload).unwrap();
        assert!(
            matches!(host, HostFrame::Output { data, offset, .. } if data == b"current screen" && offset == cutoff)
        );
        assert_eq!(
            attachment.pending.pop_front().unwrap().event_type,
            "replay_done"
        );
        proceed_tx.send(()).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn detach_cancels_a_saturated_push_subscription() {
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("backpressure-host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let (sent_tx, sent_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut reader, mut writer, session_id) = accept_test_host(listener);
            for offset in 0..(PUSH_EVENT_QUEUE_CAPACITY + 8) {
                write_frame(
                    &mut writer,
                    &HostFrame::Output {
                        session_id: session_id.clone(),
                        data: vec![b'x'],
                        offset: offset as u64,
                        cursor: LogCursor::default(),
                    },
                )
                .unwrap();
            }
            sent_tx.send(()).unwrap();
            assert!(matches!(
                read_frame::<ClientFrame>(&mut reader).unwrap().unwrap(),
                ClientFrame::Detach { .. }
            ));
        });
        let attachment = connect_test_attachment(&socket, "ses-backpressure");
        let service = CoreService::memory().unwrap();
        service.attachments.lock().unwrap().insert(
            "att-full".into(),
            Arc::new(Mutex::new(AttachmentState::Direct(attachment))),
        );
        let _subscription = service.subscribe_session("att-full").unwrap();
        sent_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = service.detach_session(SessionDetachParams {
                attachment_id: "att-full".into(),
            });
            done_tx.send(result).unwrap();
        });
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("detach must not need output drain")
            .unwrap();
        worker.join().unwrap();
        server.join().unwrap();
    }

    #[test]
    fn clean_host_exit_then_eof_does_not_require_stream_resync() {
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("clean-exit-host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let (proceed_tx, proceed_rx) = mpsc::sync_channel(1);
        let server = std::thread::spawn(move || {
            let (_reader, mut writer, session_id) = accept_test_host(listener);
            proceed_rx.recv().unwrap();
            write_frame(
                &mut writer,
                &HostFrame::Exit {
                    session_id,
                    run_id: LEGACY_RUN_ID.into(),
                    run_ordinal: 0,
                    code: Some(0),
                    signal: None,
                    group_cleaned: true,
                    reason: "natural".into(),
                },
            )
            .unwrap();
        });
        let attachment = connect_test_attachment(&socket, "ses-clean-exit");
        proceed_tx.send(()).unwrap();
        let (commands_tx, commands_rx) = mpsc::sync_channel(1);
        let (events_tx, events_rx) = mpsc::sync_channel(PUSH_EVENT_QUEUE_CAPACITY);
        let closed = Arc::new(AtomicBool::new(false));
        let worker_closed = Arc::clone(&closed);
        let worker = std::thread::spawn(move || {
            push_worker(attachment, commands_rx, events_tx, worker_closed)
        });

        let exit = events_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(exit.event_type, "exit");
        worker.join().unwrap();
        assert!(closed.load(Ordering::Acquire));
        assert!(matches!(
            events_rx.recv_timeout(Duration::from_millis(20)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
        drop(commands_tx);
        server.join().unwrap();
    }

    #[test]
    fn abrupt_host_eof_requires_stream_resync() {
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("abrupt-eof-host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let (proceed_tx, proceed_rx) = mpsc::sync_channel(1);
        let server = std::thread::spawn(move || {
            let _connection = accept_test_host(listener);
            proceed_rx.recv().unwrap();
        });
        let attachment = connect_test_attachment(&socket, "ses-abrupt-eof");
        proceed_tx.send(()).unwrap();
        let (commands_tx, commands_rx) = mpsc::sync_channel(1);
        let (events_tx, events_rx) = mpsc::sync_channel(PUSH_EVENT_QUEUE_CAPACITY);
        let closed = Arc::new(AtomicBool::new(false));
        let worker_closed = Arc::clone(&closed);
        let worker = std::thread::spawn(move || {
            push_worker(attachment, commands_rx, events_tx, worker_closed)
        });

        let event = events_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event.event_type, "resync_required");
        assert_eq!(event.payload["reason"], "host_stream_closed");
        worker.join().unwrap();
        assert!(closed.load(Ordering::Acquire));
        drop(commands_tx);
        server.join().unwrap();
    }

    #[test]
    fn reused_client_batch_id_uses_new_wire_id_and_ignores_stale_ack() {
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("stale-ack-host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let (mut reader, mut writer, session_id) = accept_test_host(listener);
            let first = read_frame::<ClientFrame>(&mut reader).unwrap().unwrap();
            assert!(matches!(
                first,
                ClientFrame::InputBatch { ref batch_id, .. } if batch_id == "remote-1"
            ));
            std::thread::sleep(Duration::from_millis(50));
            write_frame(
                &mut writer,
                &HostFrame::InputBatchAck {
                    session_id: session_id.clone(),
                    batch_id: "remote-1".into(),
                    server_sequence: 1,
                    phase: InputBatchAckPhase::Completed,
                    message: None,
                },
            )
            .unwrap();

            let second = read_frame::<ClientFrame>(&mut reader).unwrap().unwrap();
            assert!(matches!(
                second,
                ClientFrame::InputBatch { ref batch_id, .. } if batch_id == "remote-2"
            ));
            for (batch_id, server_sequence, phase) in [
                ("remote-2", 2, InputBatchAckPhase::Accepted),
                ("remote-1", 1, InputBatchAckPhase::Completed),
                ("remote-2", 1, InputBatchAckPhase::Completed),
                ("remote-2", 2, InputBatchAckPhase::Completed),
            ] {
                write_frame(
                    &mut writer,
                    &HostFrame::InputBatchAck {
                        session_id: session_id.clone(),
                        batch_id: batch_id.into(),
                        server_sequence,
                        phase,
                        message: None,
                    },
                )
                .unwrap();
            }
        });
        let mut attachment = connect_test_attachment(&socket, "ses-stale-ack");
        attachment
            .client
            .reader
            .get_ref()
            .set_read_timeout(Some(Duration::from_millis(5)))
            .unwrap();
        let (events_tx, _events_rx) = mpsc::sync_channel(PUSH_EVENT_QUEUE_CAPACITY);
        let cancel = AtomicBool::new(false);

        assert!(matches!(
            worker_input_with_timeout(
                &mut attachment,
                test_input_params("batch-reused"),
                &events_tx,
                &cancel,
                Duration::from_millis(20),
            ),
            Err(ServiceError::InputOutcomeUnknown)
        ));
        let receipt = worker_input_with_timeout(
            &mut attachment,
            test_input_params("batch-reused"),
            &events_tx,
            &cancel,
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(receipt.batch_id, "batch-reused");
        assert_eq!(receipt.server_sequence, 2);
        assert_eq!(receipt.phase, "completed");
        assert_eq!(attachment.next_input_batch_sequence, 2);
        server.join().unwrap();
    }

    #[test]
    fn closed_push_attachments_are_pruned_from_subscription_limit() {
        let mut attachments = HashMap::new();
        for index in 0..ServiceSnapshot::default().limits.max_subscriptions {
            let (commands, receiver) = mpsc::sync_channel(1);
            drop(receiver);
            attachments.insert(
                format!("att-{index}"),
                Arc::new(Mutex::new(AttachmentState::Push(PushAttachment {
                    commands,
                    closed: Arc::new(AtomicBool::new(true)),
                    worker: None,
                }))),
            );
        }
        prune_closed_attachments(&mut attachments);
        assert!(attachments.is_empty());
    }

    #[test]
    fn bounded_push_preserves_replay_under_backpressure() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let cancel = AtomicBool::new(false);
            for offset in 0..65 {
                assert!(push_event(
                    &sender,
                    SessionEvent {
                        event_type: if offset == 64 {
                            "replay_done"
                        } else {
                            "output"
                        }
                        .into(),
                        cursor: test_run_cursor(offset),
                        payload: serde_json::json!({}),
                    },
                    &cancel,
                    None
                ));
            }
        });
        std::thread::sleep(Duration::from_millis(30));
        for offset in 0..65 {
            let event = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
            assert_eq!(event.cursor.offset, offset);
            assert_eq!(
                event.event_type,
                if offset == 64 {
                    "replay_done"
                } else {
                    "output"
                }
            );
        }
        worker.join().unwrap();
    }

    #[test]
    fn bounded_push_wait_can_be_cancelled_or_expire() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let event = || SessionEvent {
            event_type: "output".into(),
            cursor: test_run_cursor(1),
            payload: serde_json::json!({}),
        };
        sender.send(event()).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let worker_sender = sender.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = push_event(&worker_sender, event(), &worker_cancel, None);
            done_tx.send(result).unwrap();
        });
        cancel.store(true, Ordering::Release);
        assert!(!done_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
        assert!(!push_event(
            &sender,
            event(),
            &AtomicBool::new(false),
            Some(Instant::now() + Duration::from_millis(10))
        ));
    }

    fn test_run_cursor(offset: u64) -> RunCursor {
        RunCursor {
            run_id: "run-test".into(),
            run_ordinal: 1,
            generation: 0,
            offset,
            status_sequence: 0,
        }
    }

    #[test]
    fn status_only_attach_never_waits_for_an_output_replay_marker() {
        let params: SessionAttachParams = serde_json::from_value(serde_json::json!({
            "sessionId": "ses-1",
            "subscribeOutput": false,
            "replayTailBytes": 1024,
            "resumeFrom": test_run_cursor(50),
        }))
        .unwrap();
        assert!(!replay_expected(&params));
    }

    #[test]
    fn replay_metadata_is_suppressed_and_live_metadata_cannot_advance_output_cursor() {
        let mut cursor = test_run_cursor(100);
        let mut replay_pending = true;
        assert!(host_event(
            &mut cursor,
            &mut replay_pending,
            HostFrame::ProcessStatus {
                session_id: "ses-1".into(),
                suspended: true,
                signal: Some(19),
            },
        )
        .is_none());
        let replay = host_event(
            &mut cursor,
            &mut replay_pending,
            HostFrame::Output {
                session_id: "ses-1".into(),
                data: vec![0; 10],
                offset: 50,
                cursor: LogCursor {
                    run_id: "run-test".into(),
                    run_ordinal: 1,
                    generation: 0,
                    offset: 50,
                },
            },
        )
        .unwrap();
        assert_eq!(replay.cursor.offset, 60);

        replay_pending = false;
        let heartbeat = host_event(
            &mut cursor,
            &mut replay_pending,
            HostFrame::Heartbeat {
                session_id: "ses-1".into(),
                at: Utc::now(),
                log_bytes: 200,
                log_cursor: LogCursor {
                    run_id: "run-test".into(),
                    run_ordinal: 1,
                    generation: 0,
                    offset: 200,
                },
            },
        )
        .unwrap();
        assert_eq!(heartbeat.cursor.offset, 60);
    }

    #[test]
    fn replay_output_cursor_tracks_consumed_end_not_hello_high_water() {
        let mut cursor = RunCursor {
            run_id: "run-1".into(),
            run_ordinal: 1,
            generation: 0,
            offset: 100,
            status_sequence: 3,
        };
        let mut replay_pending = true;
        let event = host_event(
            &mut cursor,
            &mut replay_pending,
            HostFrame::Output {
                session_id: "ses-1".into(),
                data: vec![1; 10],
                offset: 50,
                cursor: LogCursor {
                    run_id: "run-1".into(),
                    run_ordinal: 1,
                    generation: 0,
                    offset: 50,
                },
            },
        )
        .unwrap();
        assert_eq!(event.cursor.offset, 60);
        assert_eq!(event.cursor.status_sequence, 3);
        assert!(replay_pending);
    }

    #[test]
    fn remote_session_view_cannot_serialize_host_credentials() {
        let now = Utc::now();
        let summary = SessionSummary::from_projection(
            Session {
                id: "ses_public".into(),
                project_id: "prj_1".into(),
                worktree_id: None,
                preset_id: "pre_1".into(),
                title: "safe".into(),
                cwd: "/tmp".into(),
                host_pid: Some(42),
                host_socket: Some("/private/agentport.sock".into()),
                host_token: "HOST_TOKEN_MUST_NOT_LEAK".into(),
                lifecycle: Lifecycle::Running,
                agent_session_id: None,
                resume_precision: ResumePrecision::Unavailable,
                log_path: "/private/output.log".into(),
                adapter_type: AgentType::Shell,
                transport: AgentTransport::Pty,
                command: vec!["secret-command".into()],
                permission_mode: PermissionMode::Native,
                pinned_at: None,
                created_at: now,
                updated_at: now,
                archived_at: None,
            },
            Some(StatusEvent {
                session_id: "ses_public".into(),
                run_id: "run-1".into(),
                run_ordinal: 1,
                sequence: 3,
                state: agentport_core::models::AgentState::NeedsInput,
                source: agentport_core::models::StateSource::Hook,
                confidence: agentport_core::models::Confidence::High,
                evidence: Some("hook:PermissionRequest".into()),
                log_cursor: None,
                occurred_at: now,
            }),
            true,
            true,
        );
        let json = serde_json::to_string(&summary).unwrap();
        assert!(!json.contains("HOST_TOKEN_MUST_NOT_LEAK"));
        assert!(!json.contains("agentport.sock"));
        assert!(!json.contains("output.log"));
        assert!(!json.contains("secret-command"));
        assert!(json.contains("\"hostAlive\":true"));
        assert!(json.contains("\"unreadAttention\":true"));
        assert!(json.contains("\"latestAttentionKind\":\"approval_requested\""));
    }
}
