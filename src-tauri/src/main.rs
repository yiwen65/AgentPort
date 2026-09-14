//! AgentPort GUI shell (Tauri 2). The GUI is a reconnectable client only —
//! it never owns agent processes (PRD ch.6). Commands delegate to
//! agentport-core; PTY output streams to the frontend via tauri Channels.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(test)]
use agentport_core::adapters;
use agentport_core::adapters::capability;
use agentport_core::db::{Db, SessionProjection};
use agentport_core::diag::Diagnostics;
use agentport_core::error::{CoreError, Result};
use agentport_core::export::Exporter;
#[cfg(test)]
use agentport_core::git::{GitRunner, RepositoryFileLock, RepositoryIdentity};
use agentport_core::git::{WorktreeBranchSelection, WorktreeManager};
use agentport_core::history::NativeHistory;
use agentport_core::host_manager::{AttachInfo, HostClient, HostManager};
use agentport_core::ids;
use agentport_core::models::*;
use agentport_core::native_cleanup::{
    execute_native_cleanup, plan_native_cleanup, NativeCleanupPlan,
};
use agentport_core::notify::{
    notification_for_state_change, test_notification, NotificationDeduper, Notifier,
};
use agentport_core::paths::{normalize_abs, AppPaths};
use agentport_core::notification_policy::NotificationWatermark;
use agentport_core::protocol::{normalize_host_frame, HostFrame};
use agentport_core::search::SearchIndex;
use agentport_core::secrets::CredentialBroker;
use agentport_core::timeline::{RecoveryAckSnapshot, Timeline};
use agentport_remote_protocol::{RemoteAgentType, SessionCreateParams, SessionRestartParams};
use agentport_service::{CoreService, RemoteService, ServiceError};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

mod commit_ai;
mod git_commands;
mod git_workspace_commands;
mod notifications;
mod relay;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

struct AppState {
    paths: AppPaths,
    db: Db,
    /// Live renderer attachments, keyed by Session. An attachment ID is a
    /// capability: only its owner may detach or remove its Host writer.
    writers: AttachmentMap,
    next_attachment_id: AtomicU64,
    /// One status-only Host connection per live Session. Terminal renderers may
    /// be LRU-evicted without stopping this durable status projection.
    monitors: Arc<Mutex<HashMap<String, u64>>>,
    next_monitor_id: AtomicU64,
    /// A process-local guard for the durable cleanup worker. The worker owns
    /// only an `AppPaths` clone, never a borrowed or stale `AppState`.
    cleanup_scheduler_started: AtomicBool,
    branch_reconcile_started: AtomicBool,
    notifier: Mutex<Notifier>,
    /// Bounded, non-blocking handoff to one delivery worker. Native
    /// authorization can wait for the OS and must never stall Host readers.
    notification_tx: SyncSender<StatusEvent>,
    notification_session: Mutex<Option<String>>,
    /// Status notifications may arrive through both the durable monitor and
    /// an attached renderer, or as near-simultaneous Hook/PTY observations.
    notification_deduper: Mutex<NotificationDeduper>,
}

type HostWriter = Arc<Mutex<std::os::unix::net::UnixStream>>;
type AttachmentMap = Arc<Mutex<HashMap<String, RendererAttachment>>>;

const NOTIFICATION_QUEUE_CAPACITY: usize = 64;
const MAX_BACKEND_BLOCKING_JOBS: usize = 4;
static ACTIVE_BACKEND_BLOCKING_JOBS: AtomicUsize = AtomicUsize::new(0);

struct BackendBlockingPermit;

impl BackendBlockingPermit {
    fn try_acquire() -> Option<Self> {
        ACTIVE_BACKEND_BLOCKING_JOBS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_BACKEND_BLOCKING_JOBS).then_some(active + 1)
            })
            .ok()
            .map(|_| Self)
    }
}

impl Drop for BackendBlockingPermit {
    fn drop(&mut self) {
        ACTIVE_BACKEND_BLOCKING_JOBS.fetch_sub(1, Ordering::AcqRel);
    }
}

async fn run_backend_blocking<T, F>(operation: F) -> std::result::Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> std::result::Result<T, String> + Send + 'static,
{
    let permit = BackendBlockingPermit::try_acquire()
        .ok_or_else(|| "backend is busy; retry the operation".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|error| format!("backend worker failed: {error}"))?
}

/// Startup reconciliation is ordering-critical and may wait for the bounded
/// worker admission rather than being skipped when interactive jobs are busy.
async fn run_required_backend_blocking<T, F>(operation: F) -> std::result::Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> std::result::Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let permit = loop {
            if let Some(permit) = BackendBlockingPermit::try_acquire() {
                break permit;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|error| format!("backend worker failed: {error}"))?
}

fn start_notification_worker(app: AppHandle, rx: mpsc::Receiver<StatusEvent>) {
    let spawned = std::thread::Builder::new()
        .name("agentport-notifications".into())
        .spawn(move || {
            use agentport_core::notification_policy::{is_current, is_focused_target, PendingNotifications};
            let mut pending = PendingNotifications::default();
            loop {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(event) => pending.push(event, std::time::Instant::now()),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                for event in pending.take_due(std::time::Instant::now()) {
                    let state = app.state::<AppState>();
                    let db = &state.db;
                    let Ok(latest) = db.latest_status(&event.session_id) else { continue };
                    let Ok(run) = db.latest_session_run(&event.session_id) else { continue };
                    if run.is_some_and(|run| run.run_id != event.run_id || run.run_ordinal != event.run_ordinal)
                        || !is_current(&event, latest.as_ref()) {
                        continue;
                    }
                    let selected = state.notification_session.lock().unwrap().clone();
                    let focused = is_focused_target(&event, selected.as_deref(),
                        app.get_webview_window("main").is_some_and(|window| window.is_focused().unwrap_or(false)));
                    if focused { continue; }
                    let Ok(session) = db.get_session(&event.session_id) else { continue };
                    if session.archived_at.is_some() { continue; }
                    let (enabled, language) = {
                        let notifier = state.notifier.lock().unwrap();
                        (notifier.enabled(), notifier.language())
                    };
                    if !enabled { continue; }
                    if let Some(notification) = notification_for_state_change(language, &session.title, &event) {
                        if let Err(error) = notifications::send(&notification) {
                            tracing::warn!(error = %error, "system notification failed");
                        }
                    }
                }
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(error = %error, "could not start system notification worker");
    }
}

#[tauri::command]
fn set_notification_session(state: State<'_, AppState>, session_id: Option<String>) {
    *state.notification_session.lock().unwrap() = session_id;
}

fn changes_session_state_for_session(db: &Db, event: &StatusEvent) -> bool {
    if !event.changes_session_state() {
        return false;
    }
    if event.state != AgentState::NeedsInput || event.source != StateSource::Pty {
        return true;
    }
    db.get_session(&event.session_id)
        .map(|session| {
            event.changes_session_state_for(session.adapter_type, session.permission_mode)
        })
        // A missing Session is a separate consistency fault; preserve legacy
        // behavior instead of silently discarding potentially useful evidence.
        .unwrap_or(true)
}

fn notify_status_once(app: &AppHandle, db: &Db, event: &StatusEvent) {
    if !changes_session_state_for_session(db, event) {
        return;
    }
    let state = app.state::<AppState>();
    if !state
        .notification_deduper
        .lock()
        .unwrap()
        .should_notify(event)
    {
        return;
    }
    // Replayed history remains durable/unread but is not a fresh OS alert.
    if !state.notifier.lock().unwrap().enabled()
        || Utc::now().signed_duration_since(event.occurred_at) > chrono::Duration::seconds(30)
    {
        return;
    }
    if event.attention_kind().is_some() {
        match state.notification_tx.try_send(event.clone()) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                tracing::warn!("system notification queue is full; dropping duplicate UI signal")
            }
            Err(TrySendError::Disconnected(_)) => {
                tracing::warn!("system notification worker is unavailable")
            }
        }
    }
}

/// Immutable identity learned from the authenticated Host handshake. A socket
/// is not enough: a Session can be restarted while an old renderer or monitor
/// is still draining its previous Host connection.
#[derive(Clone, Debug, PartialEq, Eq)]
struct HostIdentity {
    host_pid: i64,
    protocol: u32,
    run_id: String,
    run_ordinal: i64,
}

impl HostIdentity {
    fn from_attach(info: &AttachInfo) -> Self {
        Self {
            host_pid: i64::from(info.host_pid),
            protocol: info.protocol,
            run_id: info.run_id.clone(),
            run_ordinal: info.run_ordinal,
        }
    }

    fn matches_run(&self, run_id: &str, run_ordinal: i64) -> bool {
        self.run_id == run_id && self.run_ordinal == run_ordinal
    }

    fn allows_legacy_binding(&self) -> bool {
        // A Host built before run identities existed may advertise protocol
        // v1, or a transitional v2 while serde supplies `legacy/0` defaults.
        // In either case PID is the strongest identity fact it can provide.
        self.protocol == agentport_core::protocol::LEGACY_PROTOCOL_VERSION
            || (self.run_id == LEGACY_RUN_ID && self.run_ordinal == LEGACY_RUN_ORDINAL)
    }
}

struct RendererAttachment {
    id: u64,
    host: HostIdentity,
    writer: HostWriter,
    /// Highest log cursor that this exact renderer attachment confirmed after
    /// its xterm write queue consumed the corresponding frame. Host cursors
    /// are producer high-waters and must never substitute for this boundary.
    rendered_log_cursor: Option<LogCursor>,
}

fn cursor_matches_attachment(host: &HostIdentity, cursor: &LogCursor) -> bool {
    host.matches_run(&cursor.run_id, cursor.run_ordinal)
        || (host.protocol == agentport_core::protocol::LEGACY_PROTOCOL_VERSION
            && cursor.run_id == LEGACY_RUN_ID
            && cursor.run_ordinal == LEGACY_RUN_ORDINAL)
}

fn record_renderer_log_cursor(
    attachments: &AttachmentMap,
    session_id: &str,
    attachment_id: u64,
    cursor: &LogCursor,
) -> std::result::Result<(), String> {
    if cursor.generation < 0 || cursor.offset < 0 || cursor.run_ordinal < 0 {
        return Err("renderer log cursor must not contain negative values".into());
    }
    let mut live = attachments.lock().unwrap();
    let attachment = live
        .get_mut(session_id)
        .filter(|attachment| attachment.id == attachment_id)
        .ok_or_else(|| "renderer attachment is no longer current".to_string())?;
    if !cursor_matches_attachment(&attachment.host, cursor) {
        return Err("renderer log cursor belongs to a different Host run".into());
    }
    if attachment
        .rendered_log_cursor
        .as_ref()
        .is_none_or(|current| cursor.is_not_older_than(current))
    {
        attachment.rendered_log_cursor = Some(cursor.clone());
    }
    Ok(())
}

/// The latest DB Host PID and latest reserved run are the durable authority
/// for a live Session. A stale connection may still emit historical facts, but
/// it must never cause a terminal lifecycle transition for a newer launch.
fn host_identity_is_current(db: &Db, session_id: &str, host: &HostIdentity) -> bool {
    let Ok(binding) = db.session_host_binding(session_id) else {
        return false;
    };
    if binding.host_pid != Some(host.host_pid) {
        return false;
    }
    match binding.run_identity() {
        Some((run_id, run_ordinal)) => {
            host.matches_run(run_id, run_ordinal) || host.allows_legacy_binding()
        }
        None => host.allows_legacy_binding(),
    }
}

fn replace_attachment(
    attachments: &AttachmentMap,
    session_id: String,
    attachment: RendererAttachment,
) -> Option<RendererAttachment> {
    attachments.lock().unwrap().insert(session_id, attachment)
}

fn take_attachment_if_current(
    attachments: &AttachmentMap,
    session_id: &str,
    attachment_id: u64,
) -> Option<RendererAttachment> {
    let mut live = attachments.lock().unwrap();
    let is_current = live
        .get(session_id)
        .is_some_and(|attachment| attachment.id == attachment_id);
    if is_current {
        live.remove(session_id)
    } else {
        None
    }
}

fn take_any_attachment(
    attachments: &AttachmentMap,
    session_id: &str,
) -> Option<RendererAttachment> {
    attachments.lock().unwrap().remove(session_id)
}

fn shutdown_attachment(attachment: &RendererAttachment) {
    use std::net::Shutdown;
    if let Ok(writer) = attachment.writer.lock() {
        let _ = writer.shutdown(Shutdown::Both);
    }
}

fn transition_terminal_lifecycle_for_host(
    db: &Db,
    session_id: &str,
    host: &HostIdentity,
    next: Lifecycle,
) -> bool {
    let Ok(binding) = db.session_host_binding(session_id) else {
        return false;
    };
    if binding.host_pid != Some(host.host_pid) {
        return false;
    }
    let expected_run = match binding.run_identity() {
        Some((run_id, run_ordinal)) if host.matches_run(run_id, run_ordinal) => {
            Some((run_id, run_ordinal))
        }
        Some(_) if host.allows_legacy_binding() => None,
        None if host.allows_legacy_binding() => None,
        _ => return false,
    };
    match db.update_session_lifecycle_if_host(session_id, host.host_pid, expected_run, next) {
        Ok(updated) => updated,
        Err(error) => {
            tracing::warn!(session = %session_id, host_pid = host.host_pid, error = %error, "could not persist verified terminal lifecycle");
            false
        }
    }
}

macro_rules! map_err {
    ($e:expr) => {
        $e.map_err(|e| e.to_string())
    };
}

fn runtime_command_error(
    code: &str,
    params: Value,
    technical_detail: impl Into<String>,
    legacy_message: impl Into<String>,
) -> Value {
    json!({
        "code": code,
        "params": params,
        "technicalDetail": technical_detail.into(),
        "message": legacy_message.into(),
    })
}

fn runtime_command_error_from_core(error: CoreError, fallback_code: &str) -> Value {
    match error {
        CoreError::RuntimeMessage {
            code,
            params,
            technical_detail,
            message,
        } => runtime_command_error(&code, params, technical_detail, message),
        error => {
            let detail = error.to_string();
            runtime_command_error(fallback_code, json!({}), detail.clone(), detail)
        }
    }
}

// ---------------------------------------------------------------------------
// Boot / state queries
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootInfo {
    platform: Value,
    settings: Settings,
    adapters: Vec<AdapterInstall>,
    projects: Vec<ProjectView>,
    timeline: Value,
    timeline_error: Option<String>,
    timeline_message: Option<Value>,
    secret_backend: String,
    index_state: String,
    webview: String,
    /// Private per-user export directory; the frontend uses it as the default
    /// destination so exports never land world-readable in /tmp.
    exports_dir: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionView {
    id: String,
    project_id: String,
    worktree_id: Option<String>,
    title: String,
    adapter: String,
    cwd: String,
    lifecycle: String,
    host_alive: bool,
    agent_session_id: Option<String>,
    resume_precision: String,
    permission_mode: String,
    transport: String,
    log_path: String,
    unread: bool,
    status: Option<Value>,
    /// RFC3339 pin timestamp; `None` means unpinned. Latest pin sorts first.
    pinned_at: Option<String>,
    created_at: String,
}

/// Archive-only view: archived Sessions are intentionally excluded from the
/// normal project tree, so the Settings archive page receives the project
/// label and archive timestamp in one compact payload.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ArchivedSessionView {
    id: String,
    project_id: String,
    project_name: String,
    title: String,
    adapter: String,
    created_at: String,
    archived_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectView {
    id: String,
    name: String,
    root_path: String,
    git_root_path: Option<String>,
    pinned: bool,
    sessions: Vec<SessionView>,
    worktrees: Vec<WorktreeView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorktreeView {
    id: String,
    branch: String,
    base_commit: String,
    base_ref: Option<String>,
    path: String,
    health: String,
}

fn status_value(e: &StatusEvent) -> Value {
    json!({
        "sessionId": e.session_id,
        "runId": e.run_id,
        "runOrdinal": e.run_ordinal,
        "sequence": e.sequence,
        "state": e.state.as_str(),
        "source": e.source.as_str(),
        "confidence": e.confidence.as_str(),
        "evidence": e.evidence,
        "logCursor": e.log_cursor,
        "occurredAt": e.occurred_at,
    })
}

fn replay_done_value(offset: u64, cursor: &LogCursor, partial_context: bool) -> Value {
    json!({
        "t": "replay_done", "offset": offset, "cursor": cursor,
        "partialContext": partial_context,
    })
}

#[cfg(test)]
fn has_unread_output(db: &Db, session_id: &str) -> bool {
    let Ok(Some(boundary)) = db.get_unread_log_cursor(session_id) else {
        return false;
    };
    let Ok(Some((latest, _))) = db.get_latest_log_cursor_observed(session_id) else {
        return false;
    };
    latest.run_ordinal > boundary.run_ordinal
        || (latest.run_ordinal == boundary.run_ordinal
            && (latest.run_id != boundary.run_id
                || latest.generation > boundary.generation
                || (latest.generation == boundary.generation && latest.offset > boundary.offset)))
}

#[cfg(test)]
fn session_view(db: &Db, s: &Session, _active_session: Option<&str>) -> SessionView {
    let latest = db.latest_status(&s.id).ok().flatten();
    let unread = db
        .get_recovery_summary(&s.id)
        .map(|r| {
            // The sidebar badge is for actionable unread messages only.
            // Renderer output is still tracked for recovery, but ordinary
            // PTY bytes (including redraws and progress chatter) are not
            // a user message and must not light up the badge. Being the active
            // Session is not an acknowledgement; an explicit selection is.
            db.has_unread_attention(&s.id, r.last_seen_sequence)
                .unwrap_or(false)
        })
        .unwrap_or(false);
    session_view_from_parts(s, latest.as_ref(), unread)
}

fn session_view_from_parts(s: &Session, latest: Option<&StatusEvent>, unread: bool) -> SessionView {
    SessionView {
        id: s.id.clone(),
        project_id: s.project_id.clone(),
        worktree_id: s.worktree_id.clone(),
        title: s.title.clone(),
        adapter: s.adapter_type.as_str().into(),
        cwd: s.cwd.clone(),
        lifecycle: s.lifecycle.as_str().into(),
        host_alive: matches!(s.lifecycle, Lifecycle::Creating | Lifecycle::Running)
            && s.host_pid
                .is_some_and(|pid| pid > 0 && pid <= i64::from(i32::MAX)),
        agent_session_id: s.agent_session_id.clone(),
        resume_precision: s.resume_precision.as_str().into(),
        permission_mode: s.permission_mode.as_str().into(),
        transport: s.transport.as_str().into(),
        log_path: s.log_path.clone(),
        unread,
        status: latest.map(status_value),
        pinned_at: s.pinned_at.map(|t| t.to_rfc3339()),
        created_at: s.created_at.to_rfc3339(),
    }
}

fn worktree_view(w: &Worktree) -> WorktreeView {
    WorktreeView {
        id: w.id.clone(),
        branch: w.branch.clone(),
        base_commit: w.base_commit.clone(),
        base_ref: w.base_ref.clone(),
        path: w.path.clone(),
        health: w.health.as_str().into(),
    }
}

fn collect_projects(db: &Db, _active: Option<&str>) -> Vec<ProjectView> {
    let projections = db.list_session_projections(false).unwrap_or_default();
    let mut sessions_by_project: HashMap<String, Vec<SessionView>> = HashMap::new();
    for SessionProjection {
        session,
        latest_status,
        unread_attention,
    } in projections
    {
        sessions_by_project
            .entry(session.project_id.clone())
            .or_default()
            .push(session_view_from_parts(
                &session,
                latest_status.as_ref(),
                unread_attention,
            ));
    }

    let mut worktrees_by_project: HashMap<String, Vec<WorktreeView>> = HashMap::new();
    for worktree in db.list_all_worktrees().unwrap_or_default() {
        worktrees_by_project
            .entry(worktree.project_id.clone())
            .or_default()
            .push(worktree_view(&worktree));
    }

    db.list_projects()
        .unwrap_or_default()
        .into_iter()
        .map(|p| ProjectView {
            sessions: sessions_by_project.remove(&p.id).unwrap_or_default(),
            worktrees: worktrees_by_project.remove(&p.id).unwrap_or_default(),
            id: p.id,
            name: p.name,
            root_path: p.root_path,
            git_root_path: p.git_root_path,
            pinned: p.pinned,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Durable post-purge cleanup / retention
// ---------------------------------------------------------------------------

/// Bound one foreground or background pass so a large historical archive never
/// monopolizes the GUI process or SQLite connection.
const MAX_CLEANUP_JOBS_PER_PASS: usize = 32;
const CLEANUP_POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Cleanup jobs are durable database records. Their only filesystem input is a
/// Session ID, which must be a single conservative path component before it is
/// resolved below `AppPaths::sessions_dir`. This prevents a corrupted database
/// row from turning a retry worker into an arbitrary-directory remover.
fn valid_cleanup_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 128
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn cleanup_session_paths(
    paths: &AppPaths,
    session_id: &str,
) -> std::result::Result<(std::path::PathBuf, std::path::PathBuf), &'static str> {
    if !valid_cleanup_session_id(session_id) {
        return Err("invalid_session_id");
    }
    let sessions_dir = paths.sessions_dir();
    let session_dir = paths.session_dir(session_id);
    // The component validation above is the primary guard. Keep this structural
    // check too so future `AppPaths` changes cannot silently broaden deletion.
    if session_dir.parent() != Some(sessions_dir.as_path()) {
        return Err("session_dir_outside_root");
    }
    Ok((session_dir, paths.socket_path(session_id)))
}

fn remove_cleanup_paths(
    session_dir: &std::path::Path,
    socket_path: &std::path::Path,
) -> std::result::Result<(), &'static str> {
    match std::fs::remove_file(socket_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("remove_socket_failed"),
    }
    match std::fs::remove_dir_all(session_dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("remove_session_directory_failed"),
    }
}

/// Perform a bounded durable cleanup pass. Error values written to SQLite are
/// fixed labels rather than OS error strings, so a job never persists an
/// absolute filesystem path or other environment-specific detail.
fn run_due_cleanup_jobs(paths: &AppPaths, db: &Db) -> usize {
    let jobs = match db.list_due_cleanup_jobs(Utc::now()) {
        Ok(jobs) => jobs,
        Err(error) => {
            tracing::error!(error = %error, "could not list due session cleanup jobs");
            return 0;
        }
    };

    let mut completed = 0;
    for job in jobs.into_iter().take(MAX_CLEANUP_JOBS_PER_PASS) {
        let session_id = job.session_id;
        let outcome = match cleanup_session_paths(paths, &session_id) {
            Err(reason) => Err(reason),
            Ok((session_dir, socket_path)) => remove_cleanup_paths(&session_dir, &socket_path),
        };

        match outcome {
            Ok(()) => match db.mark_cleanup_job_success(&session_id) {
                Ok(()) => completed += 1,
                Err(error) => {
                    // The filesystem delete is intentionally idempotent. Leave
                    // the job due so the next pass can acknowledge it safely.
                    tracing::error!(session = %session_id, error = %error, "could not acknowledge session cleanup job");
                }
            },
            Err(reason) => match db.record_cleanup_job_retry(&session_id, reason, Utc::now()) {
                Ok(job) => tracing::warn!(
                    session = %session_id,
                    attempts = job.attempts,
                    retry_scheduled = job.retry_at.is_some(),
                    reason,
                    "session cleanup deferred"
                ),
                Err(error) => tracing::error!(
                    session = %session_id,
                    error = %error,
                    "could not record session cleanup retry"
                ),
            },
        }
    }
    completed
}

/// Start exactly one process-local retry loop. It owns an `AppPaths` clone and
/// opens its own database handle instead of retaining `AppState` after boot.
fn ensure_cleanup_scheduler(state: &AppState) {
    if state
        .cleanup_scheduler_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let paths = state.paths.clone();
    let spawned = std::thread::Builder::new()
        .name("agentport-session-cleanup".into())
        .spawn(move || loop {
            std::thread::sleep(CLEANUP_POLL_INTERVAL);
            match Db::open(&paths) {
                Ok(db) => {
                    let _ = run_due_cleanup_jobs(&paths, &db);
                }
                Err(error) => {
                    tracing::error!(error = %error, "session cleanup worker could not open db")
                }
            }
        });
    if let Err(error) = spawned {
        state
            .cleanup_scheduler_started
            .store(false, Ordering::Release);
        tracing::error!(error = %error, "could not start session cleanup worker");
    }
}

#[tauri::command]
async fn boot(state: State<'_, AppState>, app: AppHandle) -> std::result::Result<BootInfo, String> {
    let startup_paths = state.paths.clone();
    let purge_succeeded = run_required_backend_blocking(move || {
        let db = Db::open(&startup_paths).map_err(|error| error.to_string())?;
        let manager = HostManager {
            paths: &startup_paths,
            db: &db,
        };
        let _ = manager.reconcile_on_startup();
        let _ = run_due_cleanup_jobs(&startup_paths, &db);
        Ok(SearchIndex {
            db: &db,
            paths: &startup_paths,
        }
        .purge_legacy_transcript_bodies_once()
        .is_ok())
    })
    .await?;

    ensure_cleanup_scheduler(&state);
    ensure_live_session_monitors(&app, &state);
    if !state.branch_reconcile_started.swap(true, Ordering::AcqRel) {
        git_commands::spawn_startup_reconcile(app.clone(), state.paths.clone());
        git_workspace_commands::spawn_startup_reconcile(app.clone(), state.paths.clone());
    }

    let snapshot_paths = state.paths.clone();
    let (platform, settings, adapters, projects, timeline, timeline_error, timeline_message) =
        run_backend_blocking(move || {
            let db = Db::open(&snapshot_paths).map_err(|error| error.to_string())?;
            let timeline = Timeline { db: &db }
                .build_and_acknowledge_hidden_only()
                .map(|timeline| {
                    json!({
                        "completed": timeline.completed,
                        "waiting": timeline.waiting,
                        "failed": timeline.failed,
                        "entries": timeline.entries,
                        "ackSnapshots": timeline.ack_snapshots,
                    })
                });
            let (timeline, timeline_error, timeline_message) = match timeline {
                Ok(timeline) => (timeline, None, None),
                Err(error) => (
                    json!({"completed": 0, "waiting": 0, "failed": 0, "entries": [], "ackSnapshots": []}),
                    Some(format!("恢复时间线读取失败：{error}")),
                    Some(json!({
                        "code": "timeline_load_failed",
                        "params": {},
                        "technicalDetail": error.to_string(),
                        "message": format!("恢复时间线读取失败：{error}"),
                    })),
                ),
            };
            let platform = json!(Diagnostics {
                paths: &snapshot_paths,
                db: &db,
            }
            .platform_info());
            Ok((
                platform,
                map_err!(db.load_settings())?,
                map_err!(db.list_adapters())?,
                collect_projects(&db, None),
                timeline,
                timeline_error,
                timeline_message,
            ))
        })
        .await?;

    Ok(BootInfo {
        platform,
        settings,
        adapters,
        projects,
        timeline,
        timeline_error,
        timeline_message,
        secret_backend: format!("{:?}", CredentialBroker::backend_status()),
        index_state: if purge_succeeded {
            "native_on_demand".into()
        } else {
            "native_on_demand_purge_failed".into()
        },
        webview: "system".into(),
        exports_dir: state.paths.exports_dir().to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn list_projects(
    state: State<'_, AppState>,
    app: AppHandle,
    active_session: Option<String>,
) -> std::result::Result<Vec<ProjectView>, String> {
    // Remote create/restart does not pass through the desktop launch commands.
    // Discover its monitor on refresh too, not only during GUI boot.
    ensure_live_session_monitors(&app, &state);
    let paths = state.paths.clone();
    run_backend_blocking(move || {
        let db = Db::open(&paths).map_err(|error| error.to_string())?;
        Ok(collect_projects(&db, active_session.as_deref()))
    })
    .await
}

#[tauri::command]
async fn list_archived_sessions(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<ArchivedSessionView>, String> {
    let mut archived = Vec::new();
    for project in map_err!(state.db.list_projects())? {
        for session in map_err!(state.db.list_sessions(Some(&project.id), true))? {
            let Some(archived_at) = session.archived_at else {
                continue;
            };
            archived.push(ArchivedSessionView {
                id: session.id,
                project_id: project.id.clone(),
                project_name: project.name.clone(),
                title: session.title,
                adapter: session.adapter_type.as_str().into(),
                created_at: session.created_at.to_rfc3339(),
                archived_at: archived_at.to_rfc3339(),
            });
        }
    }
    archived.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    Ok(archived)
}

// ---------------------------------------------------------------------------
// Agent probing
// ---------------------------------------------------------------------------
// Desktop keeps these AppState-bound commands rather than constructing the
// shared service per invoke: renderer compatibility requires its legacy
// reason-message shape and startup selection behavior. agentport-service uses
// the same Core registry/probe/Db APIs; same-fixture parity is covered there.

fn existing_executable(path: Option<&str>) -> Option<&std::path::Path> {
    path.map(std::path::Path::new).filter(|path| path.is_file())
}

#[tauri::command]
async fn probe_agents(
    state: State<'_, AppState>,
    preserve_selections: Option<bool>,
) -> std::result::Result<Vec<Value>, String> {
    let preserve_selections = preserve_selections.unwrap_or(false);
    // Startup probes refresh capability metadata, but must not turn a user's
    // explicit executable choice back into the automatic winner. A missing
    // selected executable is allowed to fall back to discovery.
    let confirmed_paths = if preserve_selections {
        state
            .db
            .list_adapters()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|install| {
                existing_executable(Some(&install.executable_path))
                    .map(|path| (install.agent_type, path.to_path_buf()))
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut out = vec![];
    for o in capability::probe_all_with_confirmed_paths(&confirmed_paths) {
        let t = o.agent_type;
        if let Some(i) = &o.install {
            let _ = state.db.upsert_adapter(i);
        }
        let setup =
            agentport_core::notification_setup::for_probe(&state.paths, t, o.install.as_ref());
        let mut result = probe_outcome_json(t, &o);
        result["notificationSetup"] = json!(setup);
        out.push(result);
    }
    Ok(out)
}

/// Adapter registry for renderer surfaces. New compiled adapters appear in
/// onboarding without a second hard-coded frontend list.
#[tauri::command]
fn list_supported_agents() -> Vec<Value> {
    AgentType::all()
        .iter()
        .copied()
        .map(|agent| {
            json!({
                "agent": agent.as_str(),
                "displayName": agent.display_name(),
                "commandNames": agent.command_names(),
            })
        })
        .collect()
}

#[tauri::command]
async fn probe_agent(
    state: State<'_, AppState>,
    agent: String,
    path: Option<String>,
) -> std::result::Result<Value, String> {
    let t: AgentType = match agent.parse() {
        Ok(t) => t,
        Err(e) => return Ok(json!({"state": "unavailable", "reason": e.to_string()})),
    };
    let o = capability::probe_agent(t, path.as_deref().map(std::path::Path::new));
    if let Some(i) = &o.install {
        let _ = state.db.upsert_adapter(i);
    }
    let setup = agentport_core::notification_setup::for_probe(&state.paths, t, o.install.as_ref());
    let mut result = probe_outcome_json(t, &o);
    result["notificationSetup"] = json!(setup);
    Ok(result)
}

#[tauri::command]
async fn notification_setups(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<agentport_core::notification_setup::NotificationSetup>, String> {
    let paths = state.paths.clone();
    run_backend_blocking(move || {
        let db = Db::open(&paths).map_err(|error| error.to_string())?;
        let installs = db.list_adapters().map_err(|error| error.to_string())?;
        agentport_core::notification_setup::list_status_with_installs(&paths, &installs)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn rollback_notification_setup(
    state: State<'_, AppState>,
    agent: String,
) -> std::result::Result<agentport_core::notification_setup::NotificationSetup, String> {
    let agent: AgentType = agent
        .parse()
        .map_err(|error: agentport_core::CoreError| error.to_string())?;
    let paths = state.paths.clone();
    run_backend_blocking(move || {
        agentport_core::notification_setup::rollback(&paths, agent)
            .map_err(|error| error.to_string())
    })
    .await
}

fn probe_outcome_json(t: AgentType, o: &capability::ProbeOutcome) -> Value {
    let reason_message = o.reason_code.map(|code| {
        let params = match code {
            "probe_auto_selected" | "probe_candidates_failed" => {
                json!({"count": o.candidates.len()})
            }
            _ => json!({}),
        };
        json!({
            "code": code,
            "params": params,
            "technicalDetail": o.reason_detail,
            "message": o.reason,
        })
    });
    json!({
        "agent": t.as_str(),
        "displayName": t.display_name(),
        "state": format!("{:?}", o.state).to_lowercase(),
        "reason": o.reason,
        "reasonMessage": reason_message,
        "install": o.install,
        "candidates": o.candidates,
    })
}

// ---------------------------------------------------------------------------
// Projects / presets
// ---------------------------------------------------------------------------
// These desktop commands retain AppHandle emissions, writer detachment, and
// native-cleanup warning UX that a Tauri-free service cannot own. The remote
// facade delegates to the same Core preflight/fence/cascade APIs and tests the
// confirmed dependency snapshot against the same in-memory Db fixtures.

#[tauri::command]
async fn add_project(
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
) -> std::result::Result<Value, String> {
    let norm = map_err!(normalize_abs(&path))?;
    if let Some(existing) = map_err!(state.db.find_project_by_path(&norm))? {
        return Ok(json!({"id": existing.id, "focusedExisting": true}));
    }
    let name = name.unwrap_or_else(|| {
        std::path::Path::new(&norm)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".into())
    });
    let git_root = agentport_core::git::GitRepo::discover(std::path::Path::new(&norm))
        .ok()
        .map(|r| r.root.to_string_lossy().into_owned());
    let p = Project {
        id: ids::new_id("prj"),
        name,
        root_path: norm,
        git_root_path: git_root,
        created_at: Utc::now(),
        pinned: false,
        sort_order: 0,
    };
    map_err!(state.db.add_project(&p))?;
    Ok(json!({"id": p.id, "name": p.name, "rootPath": p.root_path, "gitRootPath": p.git_root_path}))
}

#[tauri::command]
async fn rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> std::result::Result<(), String> {
    map_err!(state.db.rename_project(&id, &name))
}

#[tauri::command]
async fn set_project_layout(
    state: State<'_, AppState>,
    entries: Vec<ProjectLayoutEntry>,
    active_session: Option<String>,
) -> std::result::Result<Vec<ProjectView>, String> {
    map_err!(state.db.set_project_layout(&entries))?;
    Ok(collect_projects(&state.db, active_session.as_deref()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmedProjectRemovalPreflight {
    project_id: String,
    revision: String,
    sessions: Vec<ProjectRemovalSession>,
    worktree_ids: Vec<String>,
    recoverable_operation_ids: Vec<String>,
    pending_commit_operation_ids: Vec<String>,
}

impl TryFrom<ConfirmedProjectRemovalPreflight> for ProjectRemovalSnapshot {
    type Error = String;

    fn try_from(value: ConfirmedProjectRemovalPreflight) -> std::result::Result<Self, Self::Error> {
        let revision = value
            .revision
            .parse::<u64>()
            .map_err(|_| "Project removal revision is invalid".to_string())?;
        Ok(Self {
            project_id: value.project_id,
            revision,
            sessions: value.sessions,
            worktree_ids: value.worktree_ids,
            recoverable_operation_ids: value.recoverable_operation_ids,
            pending_commit_operation_ids: value.pending_commit_operation_ids,
        })
    }
}

#[tauri::command]
async fn remove_project(
    state: State<'_, AppState>,
    app: AppHandle,
    preflight: ConfirmedProjectRemovalPreflight,
) -> std::result::Result<Value, String> {
    let preflight = ProjectRemovalSnapshot::try_from(preflight)?;
    let id = preflight.project_id.clone();
    map_err!(state.db.begin_project_removal_confirmed(&preflight))?;
    let sessions = match preflight
        .sessions
        .iter()
        .map(|session| state.db.get_session(&session.id))
        .collect::<agentport_core::Result<Vec<_>>>()
    {
        Ok(sessions) => sessions,
        Err(error) => {
            let _ = state.db.cancel_project_removal(&id);
            return Err(error.to_string());
        }
    };
    let session_ids = preflight
        .sessions
        .iter()
        .map(|session| session.id.clone())
        .collect::<Vec<_>>();
    let native_plans = sessions
        .iter()
        .map(|session| {
            (
                session.id.clone(),
                plan_native_cleanup(&state.paths, session),
            )
        })
        .collect::<Vec<_>>();
    if let Err(error) = stop_sessions_for_project_removal(&state, &session_ids) {
        let _ = state.db.cancel_project_removal(&id);
        return Err(error);
    }

    // Remove every managed Worktree directory before dropping the Project
    // row. Individual cleanup failures are logged by the manager and never
    // turn stale files or Git metadata into a deletion blocker.
    let worktree_ids = preflight.worktree_ids;
    let manager = WorktreeManager {
        paths: &state.paths,
        db: &state.db,
    };
    let mut cleanup_warnings = 0usize;
    for worktree_id in worktree_ids {
        match manager.remove(&worktree_id) {
            Ok(outcome) => cleanup_warnings += outcome.cleanup_warnings,
            Err(error) => {
                cleanup_warnings += 1;
                tracing::warn!(
                    project = %id,
                    worktree = %worktree_id,
                    error = %error,
                    "Worktree cleanup failed during Project removal; continuing cascade"
                );
            }
        }
    }

    map_err!(state.db.remove_project(&id))?;
    run_native_cleanups(&app, &native_plans);
    cleanup_purged_sessions(&state, &session_ids);
    emit_sessions_changed(&app, &state, None);
    Ok(json!({
        "stopWarnings": 0,
        "cleanupWarnings": cleanup_warnings,
    }))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmedArchivedSession {
    id: String,
    archive_generation: i64,
}

#[tauri::command]
async fn project_remove_preflight(
    state: State<'_, AppState>,
    id: String,
) -> std::result::Result<Value, String> {
    let snapshot = map_err!(state.db.project_removal_snapshot(&id))?;
    let archived_sessions = snapshot
        .sessions
        .iter()
        .filter(|session| session.archived)
        .map(|session| {
            json!({
                "id": session.id,
                "archiveGeneration": session.archive_generation,
            })
        })
        .collect::<Vec<_>>();
    let session_count = snapshot.sessions.len();
    let archived_session_count = archived_sessions.len();
    let active_session_count = session_count.saturating_sub(archived_session_count);
    let worktree_count = snapshot.worktree_ids.len();
    let recoverable_operation_count = snapshot.recoverable_operation_ids.len();
    let pending_commit_operation_count = snapshot.pending_commit_operation_ids.len();
    Ok(json!({
        "projectId": snapshot.project_id,
        "revision": snapshot.revision.to_string(),
        "sessions": snapshot.sessions,
        "worktreeIds": snapshot.worktree_ids,
        "recoverableOperationIds": snapshot.recoverable_operation_ids,
        "pendingCommitOperationIds": snapshot.pending_commit_operation_ids,
        "sessionCount": session_count,
        "activeSessionCount": active_session_count,
        "archivedSessionCount": archived_session_count,
        "archivedSessions": archived_sessions,
        "worktreeCount": worktree_count,
        "recoverableOperationCount": recoverable_operation_count,
        "pendingCommitOperationCount": pending_commit_operation_count,
        // The complete snapshot is echoed back to execution and compared
        // atomically before the removal fence is published.
        "canRemove": true,
    }))
}

#[tauri::command]
async fn list_presets(
    state: State<'_, AppState>,
    agent: Option<String>,
) -> std::result::Result<Vec<Preset>, String> {
    let t = agent
        .map(|a| a.parse::<AgentType>())
        .transpose()
        .map_err(|e: CoreError| e.to_string())?;
    map_err!(state.db.list_presets(t))
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

fn desktop_service_error(error: ServiceError) -> String {
    match error {
        ServiceError::Core(error) | ServiceError::NotExecutedCore(error) => error.to_string(),
        ServiceError::RiskAcknowledgementRequired => "NEEDS_RISK_ACK".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
fn launch_notice_values(
    agent: AgentType,
    notices: &[agentport_core::adapters::LaunchNotice],
) -> Vec<Value> {
    notices
        .iter()
        .map(|notice| {
            json!({
                "code": notice.code,
                "params": {"agent": agent.display_name()},
                "technicalDetail": notice.legacy_message,
                "message": notice.legacy_message,
            })
        })
        .collect()
}

#[cfg(test)]
fn validate_worktree_project(project: &Project, worktree: &Worktree) -> Result<()> {
    if worktree.project_id != project.id {
        return Err(CoreError::Conflict(format!(
            "worktree {} belongs to project {}, not {}",
            worktree.id, worktree.project_id, project.id
        )));
    }
    Ok(())
}

#[cfg(test)]
fn acquire_session_repository_lock(cwd: &str) -> Result<Option<RepositoryFileLock>> {
    match RepositoryIdentity::discover(std::path::Path::new(cwd), &GitRunner::default()) {
        Ok(identity) => RepositoryFileLock::acquire(&identity.common_dir).map(Some),
        Err(CoreError::NotFound(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn create_session(
    state: State<'_, AppState>,
    app: AppHandle,
    project_id: String,
    agent: String,
    title: Option<String>,
    preset_id: Option<String>,
    worktree_id: Option<String>,
    permission: String,
    transport: Option<String>,
    risk_ack: bool,
    cols: Option<u16>,
    rows: Option<u16>,
    extra_args: Option<Vec<String>>,
) -> std::result::Result<Value, String> {
    let remote_agent: RemoteAgentType =
        serde_json::from_value(Value::String(agent.clone())).map_err(|error| error.to_string())?;
    let display_agent = agent
        .parse::<AgentType>()
        .map_err(|error| error.to_string())?;
    let paths = state.paths.clone();
    let outcome = run_backend_blocking(move || {
        let service = CoreService::open(paths).map_err(|error| error.to_string())?;
        service
            .create_session(SessionCreateParams {
                project_id,
                agent: remote_agent,
                title,
                preset_id,
                worktree_id,
                permission,
                transport,
                risk_ack,
                cols,
                rows,
                extra_args,
            })
            .map_err(desktop_service_error)
    })
    .await?;
    let session = map_err!(state.db.get_session(&outcome.session_id))?;
    ensure_session_monitor(&app, &state, &session);
    emit_sessions_changed(&app, &state, Some(&outcome.session_id));
    let notes = outcome
        .notices
        .iter()
        .map(|notice| notice.message.as_str())
        .collect::<Vec<_>>();
    let notices = outcome
        .notices
        .iter()
        .map(|notice| {
            json!({
                "code": notice.code,
                "params": {"agent": display_agent.display_name()},
                "technicalDetail": notice.message,
                "message": notice.message,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "id": outcome.session_id,
        "attach": {
            "hostPid": outcome.host_pid,
            "childAlive": outcome.child_alive,
        },
        "resumePrecision": outcome.resume_precision,
        "agentSessionId": outcome.agent_session_id,
        "notes": notes,
        "notices": notices,
        "command": outcome.command,
    }))
}

fn emit_sessions_changed(app: &AppHandle, state: &AppState, active: Option<&str>) {
    let projects = collect_projects(&state.db, active);
    let _ = app.emit("projects-changed", projects);
}

fn live_session(lifecycle: Lifecycle) -> bool {
    matches!(lifecycle, Lifecycle::Creating | Lifecycle::Running)
}

fn monitor_is_current(
    monitors: &Arc<Mutex<HashMap<String, u64>>>,
    session_id: &str,
    id: u64,
) -> bool {
    monitors
        .lock()
        .unwrap()
        .get(session_id)
        .is_some_and(|current| *current == id)
}

fn finish_session_monitor(monitors: &Arc<Mutex<HashMap<String, u64>>>, session_id: &str, id: u64) {
    let mut live = monitors.lock().unwrap();
    if live.get(session_id).is_some_and(|current| *current == id) {
        live.remove(session_id);
    }
}

/// Persist one renderer-confirmed boundary without replacing an earlier
/// first-unread cursor. Producer high-waters from the Host or status journal
/// are deliberately excluded: they can be ahead of WebView delivery during
/// shutdown. A lagging renderer acknowledgement may replay a few extra bytes,
/// but it can never omit output the user did not see.
fn persist_renderer_recovery_boundary(
    db: &Db,
    session_id: &str,
    host: &HostIdentity,
    cursor: &LogCursor,
) {
    let Ok(session) = db.get_session(session_id) else {
        return;
    };
    if !live_session(session.lifecycle) || !host_identity_is_current(db, session_id, host) {
        return;
    }
    let _ = db.mark_output_unread_at(session_id, cursor);
}

/// Capture only log positions acknowledged by the current renderer. Status
/// acknowledgements are already persisted when the focused WebView receives
/// each concrete status cursor; promoting to DB `latest_status` here would
/// consume monitor events that were never delivered to the renderer.
fn capture_gui_exit_recovery_boundaries(state: &AppState) {
    let boundaries: Vec<_> = state
        .writers
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(session_id, attachment)| {
            attachment
                .rendered_log_cursor
                .as_ref()
                .map(|cursor| (session_id.clone(), attachment.host.clone(), cursor.clone()))
        })
        .collect();
    for (session_id, host, cursor) in boundaries {
        persist_renderer_recovery_boundary(&state.db, &session_id, &host, &cursor);
    }
}

fn project_monitor_status(app: &AppHandle, db: &Db, event: &StatusEvent, notify: bool) {
    if !changes_session_state_for_session(db, event) {
        return;
    }
    if let Err(error) = db.record_status_event(event) {
        tracing::error!(session = %event.session_id, error = %error, "session monitor projection write failed");
    }
    let _ = app.emit("session-state", status_value(event));
    if notify {
        notify_status_once(app, db, event);
    }
}

/// Reconcile transport loss against durable Host evidence. Database errors are
/// not proof of death, so they preserve the monitor's existing retry behavior.
fn reconcile_monitor_liveness(
    app: &AppHandle,
    paths: &AppPaths,
    db: &Db,
    session_id: &str,
) -> bool {
    let manager = HostManager { paths, db };
    match manager.reconcile_session_liveness(session_id) {
        Ok(true) => true,
        Ok(false) => {
            let _ = app.emit("projects-changed", collect_projects(db, None));
            false
        }
        Err(error) => {
            tracing::warn!(session = %session_id, error = %error, "session monitor liveness reconciliation failed; retaining retry behavior");
            true
        }
    }
}

fn session_monitor_retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(250 * (1_u64 << attempt.min(3)))
}

/// Keep status truth alive independently of the renderer LRU. Each monitor
/// requests no output bytes, owns one verified socket, and reconnects with a
/// capped backoff after transport loss. It remains present until the exact
/// Session binding terminates, so a disconnected Host cannot later die without
/// publishing a fresh Project snapshot. The Host journal remains the source of
/// truth when the GUI itself is closed.
fn ensure_session_monitor(app: &AppHandle, state: &AppState, session: &Session) {
    if !live_session(session.lifecycle) {
        return;
    }
    let monitor_id = state.next_monitor_id.fetch_add(1, Ordering::Relaxed);
    let monitors = state.monitors.clone();
    {
        let mut live = monitors.lock().unwrap();
        if live.contains_key(&session.id) {
            return;
        }
        live.insert(session.id.clone(), monitor_id);
    }
    let paths = state.paths.clone();
    let app = app.clone();
    let session_id = session.id.clone();
    std::thread::spawn(move || {
        let db = match Db::open(&paths) {
            Ok(db) => db,
            Err(error) => {
                tracing::error!(session = %session_id, error = %error, "session monitor could not open db");
                finish_session_monitor(&monitors, &session_id, monitor_id);
                return;
            }
        };
        let mut terminal = false;
        let mut retry_attempt = 0_u32;
        loop {
            if !monitor_is_current(&monitors, &session_id, monitor_id) {
                return;
            }
            let session = match db.get_session(&session_id) {
                Ok(session) if live_session(session.lifecycle) => session,
                _ => break,
            };
            let connection = match (&session.host_socket, session.host_token.is_empty()) {
                (Some(socket), false) if !socket.is_empty() => HostClient::connect_with_resume(
                    socket,
                    &session_id,
                    &session.host_token,
                    0,
                    None,
                    false,
                ),
                _ => Err(CoreError::Host("no host socket/token recorded".into())),
            };
            let Ok((mut client, info)) = connection else {
                if !reconcile_monitor_liveness(&app, &paths, &db, &session_id) {
                    break;
                }
                std::thread::sleep(session_monitor_retry_delay(retry_attempt));
                retry_attempt = retry_attempt.saturating_add(1);
                continue;
            };
            let host = HostIdentity::from_attach(&info);
            if !host_identity_is_current(&db, &session_id, &host) {
                // A restart may have reserved/published a new run while this
                // monitor was connecting. Do not project the old connection;
                // retry against the durable Session row instead.
                tracing::debug!(session = %session_id, host_pid = host.host_pid, "monitor handshake belongs to a superseded Host");
                std::thread::sleep(session_monitor_retry_delay(retry_attempt));
                retry_attempt = retry_attempt.saturating_add(1);
                continue;
            }
            if let Err(error) = db.set_latest_log_cursor(&session_id, &info.log_cursor) {
                tracing::warn!(session = %session_id, error = %error, "monitor could not persist Host log cursor");
            }
            if let Some(event) = info.current_status.as_ref() {
                if host.matches_run(&event.run_id, event.run_ordinal) {
                    // A Hello snapshot restores current UI state after a GUI
                    // restart or monitor reconnect; it is not a new transition.
                    project_monitor_status(&app, &db, event, false);
                } else {
                    tracing::warn!(session = %session_id, host_pid = host.host_pid, "monitor hello snapshot has the wrong run identity");
                    std::thread::sleep(session_monitor_retry_delay(retry_attempt));
                    retry_attempt = retry_attempt.saturating_add(1);
                    continue;
                }
            } else if info.protocol == agentport_core::protocol::LEGACY_PROTOCOL_VERSION {
                let _ = client.request_status();
            }
            let mut notification_watermark = NotificationWatermark::new(info.current_status.as_ref(),
                info.protocol == agentport_core::protocol::LEGACY_PROTOCOL_VERSION);
            let mut stream_ended = false;
            loop {
                let frame = match client.read_frame() {
                    Ok(Some(frame)) => frame,
                    Ok(None) | Err(_) => {
                        stream_ended = true;
                        break;
                    }
                };
                match frame {
                    HostFrame::State {
                        session_id: frame_session_id,
                        run_id,
                        run_ordinal,
                        sequence,
                        state,
                        source,
                        confidence,
                        evidence,
                        log_cursor,
                        occurred_at,
                    } => {
                        if frame_session_id != session_id
                            || !host.matches_run(&run_id, run_ordinal)
                            || !host_identity_is_current(&db, &session_id, &host)
                        {
                            tracing::warn!(session = %session_id, host_pid = host.host_pid, "monitor received state from a superseded Host");
                            break;
                        }
                        project_monitor_status(
                            &app,
                            &db,
                            &StatusEvent {
                                session_id: frame_session_id,
                                run_id,
                                run_ordinal,
                                sequence,
                                state,
                                source,
                                confidence,
                                evidence,
                                log_cursor,
                                occurred_at,
                            },
                            notification_watermark.accept(sequence),
                        );
                    }
                    HostFrame::Heartbeat { log_cursor, .. } => {
                        if !host.matches_run(&log_cursor.run_id, log_cursor.run_ordinal)
                            || !host_identity_is_current(&db, &session_id, &host)
                        {
                            tracing::warn!(session = %session_id, host_pid = host.host_pid, "monitor received heartbeat from a superseded Host");
                            break;
                        }
                        if let Err(error) = db.set_latest_log_cursor(&session_id, &log_cursor) {
                            tracing::warn!(session = %session_id, error = %error, "monitor could not persist heartbeat cursor");
                        }
                    }
                    HostFrame::Exit {
                        session_id: frame_session_id,
                        run_id,
                        run_ordinal,
                        reason,
                        ..
                    } => {
                        if frame_session_id != session_id || !host.matches_run(&run_id, run_ordinal)
                        {
                            tracing::warn!(session = %session_id, host_pid = host.host_pid, "monitor received Exit from a different run");
                            break;
                        }
                        let lifecycle = if reason == "user_stop" {
                            Lifecycle::Stopped
                        } else {
                            Lifecycle::Exited
                        };
                        if !transition_terminal_lifecycle_for_host(
                            &db,
                            &session_id,
                            &host,
                            lifecycle,
                        ) {
                            tracing::warn!(session = %session_id, host_pid = host.host_pid, "monitor Exit no longer matches current Host");
                            break;
                        }
                        let _ = app.emit(
                            "session-exit",
                            json!({"sessionId": session_id, "reason": reason,
                                "runId": run_id, "runOrdinal": run_ordinal}),
                        );
                        terminal = true;
                        break;
                    }
                    HostFrame::Error { message, .. } => {
                        tracing::warn!(session = %session_id, %message, "session monitor host error");
                    }
                    _ => {}
                }
            }
            if terminal {
                break;
            }
            if stream_ended && !reconcile_monitor_liveness(&app, &paths, &db, &session_id) {
                break;
            }
            std::thread::sleep(session_monitor_retry_delay(retry_attempt));
            retry_attempt = retry_attempt.saturating_add(1);
        }
        finish_session_monitor(&monitors, &session_id, monitor_id);
    });
}

fn ensure_live_session_monitors(app: &AppHandle, state: &AppState) {
    if let Ok(sessions) = state.db.list_sessions(None, false) {
        for session in sessions {
            ensure_session_monitor(app, state, &session);
        }
    }
}

#[tauri::command]
async fn attach_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    replay_tail_bytes: u64,
    resume_from: Option<LogCursor>,
    channel: tauri::ipc::Channel<Value>,
) -> std::result::Result<Value, Value> {
    let socket = state
        .db
        .get_session(&session_id)
        .map_err(|error| runtime_command_error_from_core(error, "host_connection_failed"))?
        .host_socket
        .ok_or_else(|| {
            runtime_command_error(
                "host_connection_failed",
                json!({}),
                "no socket recorded",
                "no socket recorded",
            )
        })?;
    let token = state
        .db
        .get_session_token(&session_id)
        .map_err(|error| runtime_command_error_from_core(error, "host_connection_failed"))?;
    // Cap replay independently of frontend input so a malformed IPC request
    // cannot make a Host read an unbounded log tail into memory.
    const MAX_REPLAY_BYTES: u64 = 4 * 1024 * 1024;
    let (mut client, info) = HostClient::connect_with_resume(
        &socket,
        &session_id,
        &token,
        replay_tail_bytes.min(MAX_REPLAY_BYTES),
        resume_from,
        true,
    )
    .map_err(|error| {
        // A failed renderer attach must reconcile durable exit/PID facts before
        // its follow-up project refresh. Socket failure alone is not death.
        reconcile_monitor_liveness(&app, &state.paths, &state.db, &session_id);
        runtime_command_error_from_core(error, "host_connection_failed")
    })?;
    if let Ok(session) = state.db.get_session(&session_id) {
        ensure_session_monitor(&app, &state, &session);
    }
    let host = HostIdentity::from_attach(&info);
    if !host_identity_is_current(&state.db, &session_id, &host) {
        return Err(runtime_command_error(
            "host_changed_during_attach",
            json!({}),
            "Host changed while establishing terminal attachment; please reconnect",
            "Host changed while establishing terminal attachment; please reconnect",
        ));
    }
    if let Err(error) = state
        .db
        .set_latest_log_cursor(&session_id, &info.log_cursor)
    {
        tracing::warn!(session = %session_id, error = %error, "attach could not persist Host log cursor");
    }
    if info.protocol == agentport_core::protocol::LEGACY_PROTOCOL_VERSION {
        // v1 did not include a Hello snapshot; queue a status request before
        // the reader is handed to the watch thread.
        client
            .request_status()
            .map_err(|error| runtime_command_error_from_core(error, "host_connection_failed"))?;
    }
    if let Some(status) = info.current_status.as_ref() {
        project_monitor_status(&app, &state.db, status, false);
    }
    let notification_watermark = NotificationWatermark::new(info.current_status.as_ref(),
        info.protocol == agentport_core::protocol::LEGACY_PROTOCOL_VERSION);
    let HostClient { reader, writer, .. } = client;
    let writer = Arc::new(Mutex::new(writer));
    let attachment_id = state.next_attachment_id.fetch_add(1, Ordering::Relaxed);
    let previous = replace_attachment(
        &state.writers,
        session_id.clone(),
        RendererAttachment {
            id: attachment_id,
            host: host.clone(),
            writer: writer.clone(),
            rendered_log_cursor: None,
        },
    );
    // Replacement happens before shutdown. This makes the new attachment
    // authoritative immediately, while the old reader can only remove its
    // own ID when it observes the resulting EOF.
    if let Some(previous) = previous {
        if let Some(cursor) = previous.rendered_log_cursor.as_ref() {
            persist_renderer_recovery_boundary(&state.db, &session_id, &previous.host, cursor);
        }
        shutdown_attachment(&previous);
    }
    let attach_info = json!({
        "attachmentId": attachment_id,
        "hostPid": info.host_pid,
        "protocol": info.protocol,
        "childAlive": info.child_alive,
        "logBytes": info.log_bytes,
        "agentSessionId": info.agent_session_id,
        "runId": info.run_id,
        "runOrdinal": info.run_ordinal,
        "status": info.current_status.as_ref().map(status_value),
        "logCursor": info.log_cursor,
        "terminalGeometry": info.terminal_geometry,
    });
    // Publish the writable capability before the watch thread can flood the
    // WebView with retained replay frames. Warm previews can receive focus
    // immediately, and their first input must not wait behind replay delivery
    // or the invoke response queued after it.
    if info.child_alive {
        let _ = channel.send(json!({"t": "attached", "info": attach_info.clone()}));
    }
    let paths = state.paths.clone();
    let writers = state.writers.clone();
    let sid = session_id.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        // Each watch thread owns its own db handle (SQLite WAL allows it).
        let db = match Db::open(&paths) {
            Ok(d) => d,
            Err(e) => {
                let detail = e.to_string();
                let _ = channel.send(json!({
                    "t": "error",
                    "code": "watch_database_open_failed",
                    "params": {},
                    "technicalDetail": detail,
                    "message": format!("无法打开 Session 数据库：{detail}"),
                }));
                if let Some(attachment) = take_attachment_if_current(&writers, &sid, attachment_id)
                {
                    shutdown_attachment(&attachment);
                }
                return;
            }
        };
        watch_loop(
            app2,
            channel,
            reader,
            db,
            sid,
            writers,
            attachment_id,
            host,
            writer,
            notification_watermark,
        );
    });
    Ok(attach_info)
}

#[allow(clippy::too_many_arguments)]
fn watch_loop(
    app: AppHandle,
    channel: tauri::ipc::Channel<Value>,
    mut reader: std::io::BufReader<std::os::unix::net::UnixStream>,
    db: Db,
    session_id: String,
    writers: AttachmentMap,
    attachment_id: u64,
    host: HostIdentity,
    writer: HostWriter,
    mut notification_watermark: NotificationWatermark,
) {
    loop {
        match agentport_core::protocol::read_frame::<HostFrame>(&mut reader) {
            Ok(Some(frame)) => {
                let frame = normalize_host_frame(host.protocol, frame);
                match frame {
                    HostFrame::Output {
                        data,
                        offset,
                        cursor,
                        ..
                    } => {
                        if !host.matches_run(&cursor.run_id, cursor.run_ordinal) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping output from a stale Host run");
                            break;
                        }
                        let _ = channel.send(json!({
                            "t": "output",
                            "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data),
                            "offset": offset,
                            "cursor": cursor,
                        }));
                    }
                    HostFrame::TransientOutput { data, .. } => {
                        if !host_identity_is_current(&db, &session_id, &host) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping transient output from a stale Host attachment");
                            break;
                        }
                        let _ = channel.send(json!({
                            "t": "transient_output",
                            "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data),
                        }));
                    }
                    HostFrame::ProcessStatus {
                        suspended, signal, ..
                    } => {
                        if !host_identity_is_current(&db, &session_id, &host) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping process status from a stale Host attachment");
                            break;
                        }
                        let _ = channel.send(json!({
                            "t": "process_status",
                            "suspended": suspended,
                            "signal": signal,
                        }));
                    }
                    HostFrame::Structured { event, .. } => {
                        if !host_identity_is_current(&db, &session_id, &host) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping structured event from a stale Host attachment");
                            break;
                        }
                        let _ = channel.send(json!({"t": "structured", "event": event}));
                    }
                    HostFrame::ResizeAck {
                        accepted,
                        geometry,
                        reason,
                        ..
                    } => {
                        if !host.matches_run(&geometry.run_id, geometry.run_ordinal) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping geometry ACK from a stale Host run");
                            break;
                        }
                        let payload = json!({
                            "sessionId": session_id,
                            "attachmentId": attachment_id,
                            "accepted": accepted,
                            "geometry": geometry,
                            "reason": reason,
                        });
                        let _ =
                            channel.send(json!({"t": "resize_ack", "payload": payload.clone()}));
                        let _ = app.emit("terminal-geometry-resize-ack", payload);
                    }
                    HostFrame::TerminalGeometryChanged { geometry, .. } => {
                        if !host.matches_run(&geometry.run_id, geometry.run_ordinal) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping geometry update from a stale Host run");
                            break;
                        }
                        let payload = json!({
                            "sessionId": session_id,
                            "attachmentId": attachment_id,
                            "geometry": geometry,
                        });
                        let _ = channel.send(
                            json!({"t": "terminal_geometry_changed", "payload": payload.clone()}),
                        );
                        let _ = app.emit("terminal-geometry-changed", payload);
                    }
                    HostFrame::ReplayDone {
                        offset,
                        cursor,
                        partial_context,
                        ..
                    } => {
                        if !host.matches_run(&cursor.run_id, cursor.run_ordinal) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping replay marker from a stale Host run");
                            break;
                        }
                        let _ = channel.send(replay_done_value(offset, &cursor, partial_context));
                    }
                    HostFrame::ResyncRequired {
                        earliest, reason, ..
                    } => {
                        if !host.matches_run(&earliest.run_id, earliest.run_ordinal) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping resync marker from a stale Host run");
                            break;
                        }
                        let _ = channel.send(json!({
                            "t": "resync_required",
                            "earliest": earliest,
                            "reason": reason,
                        }));
                    }
                    HostFrame::State {
                        session_id: sid,
                        run_id,
                        run_ordinal,
                        sequence,
                        state,
                        source,
                        confidence,
                        evidence,
                        log_cursor,
                        occurred_at,
                    } => {
                        if !host.matches_run(&run_id, run_ordinal) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping state from a stale Host run");
                            break;
                        }
                        let ev = StatusEvent {
                            session_id: sid.clone(),
                            run_id,
                            run_ordinal,
                            sequence,
                            state,
                            source,
                            confidence,
                            evidence,
                            log_cursor,
                            occurred_at,
                        };
                        if !changes_session_state_for_session(&db, &ev) {
                            continue;
                        }
                        if let Err(error) = db.record_status_event(&ev) {
                            tracing::error!(session = %sid, error = %error, "state projection write failed");
                            let _ = channel.send(json!({
                                "t": "error",
                                "code": "status_persistence_failed",
                                "params": {},
                                "technicalDetail": error.to_string(),
                                "message": format!("状态未持久化：{error}"),
                                "persistenceDegraded": true,
                            }));
                        }
                        let _ = app.emit("session-state", status_value(&ev));
                        if notification_watermark.accept(ev.sequence) {
                            notify_status_once(&app, &db, &ev);
                        }
                        let _ = channel.send(json!({"t": "state", "event": status_value(&ev)}));
                    }
                    HostFrame::AgentSession {
                        agent_session_id, ..
                    } => {
                        if !host_identity_is_current(&db, &session_id, &host) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping agent session id from a stale Host attachment");
                            break;
                        }
                        match db.update_session_agent_id(
                            &session_id,
                            &agent_session_id,
                            ResumePrecision::Exact,
                        ) {
                            Ok(()) => {
                                let _ = channel
                                    .send(json!({"t": "agent_session", "id": agent_session_id}));
                                let _ = app.emit(
                                    "session-agent-id",
                                    json!({"sessionId": session_id, "agentSessionId": agent_session_id}),
                                );
                            }
                            Err(error) => {
                                tracing::error!(session = %session_id, error = %error, "agent session id persistence failed");
                                let _ = channel.send(json!({
                                    "t": "error",
                                    "code": "agent_session_persistence_failed",
                                    "params": {},
                                    "technicalDetail": error.to_string(),
                                    "message": format!("原生 Session ID 未持久化：{error}"),
                                    "persistenceDegraded": true,
                                }));
                            }
                        }
                    }
                    HostFrame::Heartbeat {
                        log_bytes,
                        log_cursor,
                        ..
                    } => {
                        if !host.matches_run(&log_cursor.run_id, log_cursor.run_ordinal) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping heartbeat from a stale Host run");
                            break;
                        }
                        if let Err(error) = db.set_latest_log_cursor(&session_id, &log_cursor) {
                            tracing::warn!(session = %session_id, attachment_id, error = %error, "could not persist heartbeat cursor");
                        }
                        let _ = channel.send(json!({"t": "heartbeat", "logBytes": log_bytes, "logCursor": log_cursor}));
                    }
                    HostFrame::Exit {
                        run_id,
                        run_ordinal,
                        code,
                        signal,
                        group_cleaned,
                        reason,
                        ..
                    } => {
                        if !host.matches_run(&run_id, run_ordinal) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping Exit from a stale Host run");
                            let _ = channel.send(json!({
                                "t": "detached",
                                "code": "host_replaced",
                                "params": {},
                                "message": "Host 已被新的运行替换",
                            }));
                            break;
                        }
                        // A user stop may have won the terminal transition while
                        // this watch thread was still draining the Exit frame.
                        // Never overwrite that stronger, user-requested fact.
                        let terminal_lifecycle = if reason == "user_stop" {
                            Lifecycle::Stopped
                        } else {
                            Lifecycle::Exited
                        };
                        if !transition_terminal_lifecycle_for_host(
                            &db,
                            &session_id,
                            &host,
                            terminal_lifecycle,
                        ) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping Exit from a superseded Host attachment");
                            let _ = channel.send(json!({
                                "t": "detached",
                                "code": "host_replaced",
                                "params": {},
                                "message": "Host 已被新的运行替换",
                            }));
                            break;
                        }
                        let _ = channel.send(json!({
                            "t": "exit", "code": code, "signal": signal,
                            "groupCleaned": group_cleaned,
                            "reason": reason, "runId": run_id, "runOrdinal": run_ordinal,
                        }));
                        let _ = app.emit(
                            "session-exit",
                            json!({
                                "sessionId": session_id, "code": code, "signal": signal,
                                "reason": reason, "runId": run_id, "runOrdinal": run_ordinal,
                            }),
                        );
                        break;
                    }
                    HostFrame::Pong { .. } => {}
                    HostFrame::HelloOk { .. } => {}
                    // The GUI never sends InputBatch frames, so no ack can
                    // arrive; ignore it like Pong/HelloOk.
                    HostFrame::InputBatchAck { .. } => {}
                    HostFrame::Error {
                        message,
                        code,
                        params,
                        technical_detail,
                        ..
                    } => {
                        let mut payload = json!({"t": "error", "message": message});
                        if let Some(object) = payload.as_object_mut() {
                            if let Some(code) = code {
                                object.insert("code".into(), json!(code));
                            }
                            if let Some(params) = params {
                                object.insert("params".into(), params);
                            }
                            if let Some(detail) = technical_detail {
                                object.insert("technicalDetail".into(), json!(detail));
                            }
                        }
                        let _ = channel.send(payload);
                    }
                }
            }
            Ok(None) => {
                let _ = channel.send(json!({"t": "detached"}));
                break;
            }
            Err(e) => {
                let _ = channel.send(json!({"t": "detached", "message": e.to_string()}));
                break;
            }
        }
    }
    // EOF/error is a renderer transport fact, never evidence that the Host or
    // Agent exited. Remove and close only this generation's writer; a newer
    // attachment for the same Session remains untouched.
    if let Some(attachment) = take_attachment_if_current(&writers, &session_id, attachment_id) {
        // Keep `writer` owned until after the ID check so an ABA replacement
        // cannot be closed by an old watcher.
        debug_assert!(Arc::ptr_eq(&attachment.writer, &writer));
        debug_assert_eq!(attachment.host, host);
        shutdown_attachment(&attachment);
    }
}

#[tauri::command]
async fn detach_session(
    state: State<'_, AppState>,
    session_id: String,
    attachment_id: Option<u64>,
) -> std::result::Result<(), String> {
    // A detached renderer is not a lifecycle event and cannot safely infer
    // that it owns a newer attachment. Older WebView code sends no ID; keep
    // that request harmless instead of allowing an ABA removal.
    let Some(attachment_id) = attachment_id else {
        return Ok(());
    };
    if let Some(attachment) = take_attachment_if_current(&state.writers, &session_id, attachment_id)
    {
        if let Some(cursor) = attachment.rendered_log_cursor.as_ref() {
            persist_renderer_recovery_boundary(&state.db, &session_id, &attachment.host, cursor);
        }
        shutdown_attachment(&attachment);
    }
    Ok(())
}

/// Confirm that the user has viewed the Session's current terminal content and
/// status. The frontend calls this when the Session receives focus.
#[tauri::command]
async fn mark_session_seen(
    state: State<'_, AppState>,
    session_id: String,
    cursor: Option<StatusCursor>,
) -> std::result::Result<(), String> {
    if let Some(cursor) = cursor {
        // Status delivery and xterm rendering are independent queues. Advance
        // only the concrete status cursor here; the renderer command below is
        // solely responsible for acknowledging terminal output.
        map_err!(state
            .db
            .acknowledge_recovery_snapshot(&session_id, Some(&cursor), None))?;
    }
    // A missing renderer cursor proves nothing. Older builds promoted it to
    // the DB latest status, which could consume a monitor event still queued
    // for WebView delivery during selection or shutdown.
    Ok(())
}

/// Record a log position only after the exact renderer attachment confirms
/// its xterm write queue consumed the frame. The process-local observation is
/// used as the GUI-exit boundary; the DB acknowledgement atomically clears an
/// older unread marker without consuming a producer cursor that arrived later.
#[tauri::command]
async fn mark_session_log_rendered(
    state: State<'_, AppState>,
    session_id: String,
    attachment_id: u64,
    cursor: LogCursor,
) -> std::result::Result<(), String> {
    record_renderer_log_cursor(&state.writers, &session_id, attachment_id, &cursor)?;
    map_err!(state
        .db
        .acknowledge_recovery_snapshot(&session_id, None, Some(&cursor)))?;
    Ok(())
}

/// Store the first output offset that arrives while a Session is not focused.
/// This is deliberately separate from PTY state transitions: activity/idle
/// heuristics must not create an unread badge by themselves.
#[tauri::command]
async fn mark_session_output_unread(
    state: State<'_, AppState>,
    session_id: String,
    offset: i64,
    cursor: Option<LogCursor>,
) -> std::result::Result<(), String> {
    match cursor {
        Some(cursor) => map_err!(state.db.mark_output_unread_at(&session_id, &cursor))?,
        None => map_err!(state.db.mark_output_unread(&session_id, offset))?,
    }
    Ok(())
}

#[tauri::command]
async fn send_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> std::result::Result<(), String> {
    use agentport_core::protocol::{write_frame, ClientFrame};
    use base64::Engine as _;
    let bytes = map_err!(base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| CoreError::Validation(format!("bad base64: {e}"))))?;
    const MAX_INPUT_FRAME_BYTES: usize = 256 * 1024;
    if bytes.len() > MAX_INPUT_FRAME_BYTES {
        return Err(format!(
            "input frame exceeds {MAX_INPUT_FRAME_BYTES} byte limit; split large paste before sending"
        ));
    }
    // Clone the per-session writer before locking it.  Holding the global map
    // lock across a blocking Unix-socket flush head-of-line blocks resize,
    // detach and input for every other Session.
    let writer = {
        let writers = state.writers.lock().unwrap();
        writers
            .get(&session_id)
            .map(|attachment| attachment.writer.clone())
    };
    let Some(w) = writer else {
        return Err("session not attached".into());
    };
    let mut w = w.lock().unwrap();
    map_err!(write_frame(
        &mut *w,
        &ClientFrame::Input {
            session_id: session_id.clone(),
            data: bytes,
        }
    ))
}

/// Pi RPC prompt entry point. Structured sessions deliberately do not route
/// prompt text through xterm/base64 terminal input.
#[tauri::command]
async fn send_structured_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> std::result::Result<(), String> {
    use agentport_core::protocol::{write_frame, ClientFrame};
    const MAX_PROMPT_BYTES: usize = 256 * 1024;
    if text.trim().is_empty() {
        return Err("structured prompt must not be empty".into());
    }
    if text.len() > MAX_PROMPT_BYTES {
        return Err(format!(
            "structured prompt exceeds {MAX_PROMPT_BYTES} byte limit"
        ));
    }
    let writer = {
        let writers = state.writers.lock().unwrap();
        writers
            .get(&session_id)
            .map(|attachment| attachment.writer.clone())
    };
    let Some(writer) = writer else {
        return Err("session not attached".into());
    };
    let mut writer = writer.lock().unwrap();
    map_err!(write_frame(
        &mut *writer,
        &ClientFrame::StructuredPrompt { session_id, text }
    ))
}

#[tauri::command]
async fn abort_structured_turn(
    state: State<'_, AppState>,
    session_id: String,
) -> std::result::Result<(), String> {
    use agentport_core::protocol::{write_frame, ClientFrame};
    let writer = {
        let writers = state.writers.lock().unwrap();
        writers
            .get(&session_id)
            .map(|attachment| attachment.writer.clone())
    };
    let Some(writer) = writer else {
        return Err("session not attached".into());
    };
    let mut writer = writer.lock().unwrap();
    map_err!(write_frame(
        &mut *writer,
        &ClientFrame::AbortStructuredTurn { session_id }
    ))
}

#[tauri::command]
async fn auto_rename_session_from_first_input(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    input: String,
) -> std::result::Result<bool, String> {
    let renamed = map_err!(state
        .db
        .auto_rename_session_from_first_input(&session_id, &input))?;
    if renamed {
        emit_sessions_changed(&app, &state, Some(&session_id));
    }
    Ok(renamed)
}

#[tauri::command]
async fn resize_pty(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    pixel_width: u16,
    pixel_height: u16,
    expected_revision: Option<u64>,
    source_kind: Option<String>,
    source_device_id: Option<String>,
    orientation: Option<String>,
) -> std::result::Result<(), String> {
    use agentport_core::protocol::{write_frame, ClientFrame};
    let attachment = {
        let writers = state.writers.lock().unwrap();
        writers.get(&session_id).map(|attachment| {
            (
                attachment.writer.clone(),
                format!("desktop:{}", attachment.id),
            )
        })
    };
    let Some((w, geometry_attachment_id)) = attachment else {
        return Ok(()); // not attached (e.g. interrupted) — resize is best effort
    };
    let mut w = w.lock().unwrap();
    map_err!(write_frame(
        &mut *w,
        &ClientFrame::Resize {
            session_id: session_id.clone(),
            cols,
            rows,
            pixel_width,
            pixel_height,
            expected_revision,
            source_kind,
            source_device_id,
            attachment_id: Some(geometry_attachment_id),
            orientation,
        }
    ))
}

#[tauri::command]
async fn stop_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
) -> std::result::Result<(), String> {
    let mgr = HostManager {
        paths: &state.paths,
        db: &state.db,
    };
    map_err!(mgr.stop(&session_id, 3000))?;
    emit_sessions_changed(&app, &state, None);
    Ok(())
}

#[tauri::command]
async fn interrupt_session(
    state: State<'_, AppState>,
    session_id: String,
) -> std::result::Result<(), String> {
    let mgr = HostManager {
        paths: &state.paths,
        db: &state.db,
    };
    map_err!(mgr.interrupt(&session_id))
}

#[tauri::command]
async fn resume_session(
    state: State<'_, AppState>,
    session_id: String,
) -> std::result::Result<(), String> {
    if map_err!(state.db.get_session(&session_id))?
        .archived_at
        .is_some()
    {
        return Err("archived Sessions cannot be resumed; restore the Session first".into());
    }
    let mgr = HostManager {
        paths: &state.paths,
        db: &state.db,
    };
    map_err!(mgr.resume(&session_id))
}

#[tauri::command]
async fn restart_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    risk_ack: bool,
) -> std::result::Result<Value, String> {
    let adapter = map_err!(state.db.get_session(&session_id))?.adapter_type;
    let paths = state.paths.clone();
    let requested_session_id = session_id.clone();
    let outcome = run_backend_blocking(move || {
        let service = CoreService::open(paths).map_err(|error| error.to_string())?;
        service
            .restart_session(SessionRestartParams {
                session_id: requested_session_id,
                risk_ack,
            })
            .map_err(desktop_service_error)
    })
    .await?;
    let session = map_err!(state.db.get_session(&session_id))?;
    ensure_session_monitor(&app, &state, &session);
    emit_sessions_changed(&app, &state, Some(&session_id));
    let notes = outcome
        .notices
        .iter()
        .map(|notice| notice.message.as_str())
        .collect::<Vec<_>>();
    let notices = outcome
        .notices
        .iter()
        .map(|notice| {
            json!({
                "code": notice.code,
                "params": {"agent": adapter.display_name()},
                "technicalDetail": notice.message,
                "message": notice.message,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "resumePrecision": outcome.resume_precision,
        "agentSessionId": outcome.agent_session_id,
        "notes": notes,
        "notices": notices,
        "hostPid": outcome.host_pid,
    }))
}

#[tauri::command]
async fn rename_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    title: String,
) -> std::result::Result<(), String> {
    map_err!(state.db.rename_session(&session_id, &title))?;
    emit_sessions_changed(&app, &state, None);
    Ok(())
}

#[tauri::command]
async fn set_session_pinned(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    pinned: bool,
) -> std::result::Result<(), String> {
    map_err!(state.db.set_session_pinned(&session_id, pinned))?;
    emit_sessions_changed(&app, &state, None);
    Ok(())
}

#[tauri::command]
async fn archive_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
) -> std::result::Result<(), String> {
    // Persist the archive fence before stopping so no concurrent restart can
    // claim or bind a new Host in the stop/archive gap. Roll it back if the
    // stop fails, preserving the previous user-visible contract.
    let archive_generation = map_err!(state.db.archive_session(&session_id))?;
    if let Err(error) = stop_session_before_archive(&state, &session_id) {
        match state
            .db
            .unarchive_session_if_generation(&session_id, archive_generation)
        {
            Ok(true) => return Err(error.to_string()),
            Ok(false) => {
                return Err(format!(
                    "{error}; the archive changed concurrently and was not rolled back"
                ));
            }
            Err(rollback_error) => {
                return Err(format!(
                    "{error}; additionally failed to restore the Session after archive rollback: {rollback_error}"
                ));
            }
        }
    }
    emit_sessions_changed(&app, &state, None);
    Ok(())
}

fn detach_session_writer(state: &AppState, session_id: &str) {
    if let Some(attachment) = take_any_attachment(&state.writers, session_id) {
        shutdown_attachment(&attachment);
    }
}

/// An archived Session must not retain a live Agent process. Stopping it at
/// archive time keeps the archive as history and avoids a later bulk purge
/// waiting on every old Host.
fn stop_session_before_archive(state: &AppState, session_id: &str) -> Result<()> {
    let manager = HostManager {
        paths: &state.paths,
        db: &state.db,
    };
    manager.stop(session_id, 3000)?;
    detach_session_writer(state, session_id);
    Ok(())
}

/// Legacy archives may predate stop-on-archive. Stop those Hosts in bounded
/// parallel batches so bulk deletion cannot wait session-by-session.
fn stop_archived_sessions_for_purge(state: &AppState, session_ids: &[String]) -> Result<()> {
    const STOP_CONCURRENCY: usize = 4;
    for batch in session_ids.chunks(STOP_CONCURRENCY) {
        let failures = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            let failures = &failures;
            for session_id in batch {
                scope.spawn(move || {
                    if let Err(error) = stop_session_before_archive(state, session_id) {
                        failures
                            .lock()
                            .unwrap()
                            .push(format!("{session_id}: {error}"));
                    }
                });
            }
        });
        let failures = failures.into_inner().unwrap();
        if !failures.is_empty() {
            return Err(CoreError::Host(format!(
                "unable to stop archived session(s): {}",
                failures.join("; ")
            )));
        }
    }
    Ok(())
}

/// A confirmed Project/Worktree deletion must not be rejected because an old
/// Host cannot complete its graceful-stop handshake. Try every stop in bounded
/// parallel batches, detach local writers, log failures, and continue cleanup.
fn stop_sessions_for_project_removal(
    state: &AppState,
    session_ids: &[String],
) -> std::result::Result<(), String> {
    const STOP_CONCURRENCY: usize = 4;
    for batch in session_ids.chunks(STOP_CONCURRENCY) {
        let failures = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            let failures = &failures;
            for session_id in batch {
                scope.spawn(move || {
                    if let Err(error) = stop_session_before_archive(state, session_id) {
                        failures
                            .lock()
                            .unwrap()
                            .push((session_id.clone(), error.to_string()));
                    }
                });
            }
        });
        let failures = failures.into_inner().unwrap();
        if !failures.is_empty() {
            let sessions = failures
                .iter()
                .map(|(session_id, _)| session_id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            for (session_id, error) in &failures {
                tracing::warn!(
                    session = %session_id,
                    error = %error,
                    "Session stop could not be authoritatively verified; Project removal aborted"
                );
            }
            return Err(format!(
                "Project removal aborted because process-group cleanup was not proven for: {sessions}"
            ));
        }
    }
    Ok(())
}

/// Trigger the durable cleanup queue after the authoritative database
/// transaction has committed. Filesystem work is acknowledged only after it
/// succeeds, so a crash or a temporary permission failure is retried instead
/// of silently leaking a session directory.
fn cleanup_purged_sessions(state: &AppState, session_ids: &[String]) {
    if session_ids.is_empty() {
        return;
    }
    let _ = run_due_cleanup_jobs(&state.paths, &state.db);
}

/// Build native-artifact cleanup plans for Sessions that are about to be
/// purged. Plans must be built before the purge commits: the hook-events
/// evidence lives in AgentPort's session directory and the Session rows are
/// deleted by the purge transaction.
fn plan_native_cleanups(
    state: &AppState,
    session_ids: &[String],
) -> Vec<(String, NativeCleanupPlan)> {
    session_ids
        .iter()
        .filter_map(|session_id| match state.db.get_session(session_id) {
            Ok(session) => Some((
                session_id.clone(),
                plan_native_cleanup(&state.paths, &session),
            )),
            Err(error) => {
                tracing::warn!(session = %session_id, error = %error, "could not plan native session cleanup");
                None
            }
        })
        .collect()
}

/// Execute native cleanup plans after the purge commits, on a best-effort
/// basis. Failures never block the purge; they are logged and surfaced to
/// the UI as a warning toast.
fn run_native_cleanups(app: &AppHandle, plans: &[(String, NativeCleanupPlan)]) {
    let mut failed_sessions = 0usize;
    for (session_id, plan) in plans {
        let outcome = execute_native_cleanup(plan);
        if outcome.has_failures() {
            failed_sessions += 1;
            tracing::warn!(
                session = %session_id,
                deleted = outcome.deleted,
                failures = outcome.failures.len(),
                reasons = ?outcome.failures,
                "native session artifact cleanup incomplete"
            );
        }
    }
    if failed_sessions > 0 {
        let _ = app.emit(
            "native-cleanup-warning",
            json!({ "count": failed_sessions }),
        );
    }
}

#[tauri::command]
async fn unarchive_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
) -> std::result::Result<(), String> {
    map_err!(state.db.unarchive_session(&session_id))?;
    emit_sessions_changed(&app, &state, None);
    Ok(())
}

#[tauri::command]
async fn delete_archived_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
) -> std::result::Result<(), String> {
    let session = map_err!(state.db.get_session(&session_id))?;
    if session.archived_at.is_none() {
        return Err("only archived sessions can be permanently deleted".into());
    }
    map_err!(stop_session_before_archive(&state, &session_id))?;
    let native_plan = plan_native_cleanup(&state.paths, &session);
    map_err!(state.db.purge_archived_session(&session_id))?;
    run_native_cleanups(&app, &[(session_id.clone(), native_plan)]);
    cleanup_purged_sessions(&state, std::slice::from_ref(&session_id));
    emit_sessions_changed(&app, &state, None);
    Ok(())
}

#[tauri::command]
async fn delete_project_archived_sessions(
    state: State<'_, AppState>,
    app: AppHandle,
    project_id: String,
    sessions: Vec<ConfirmedArchivedSession>,
) -> std::result::Result<(), String> {
    let current_archives = map_err!(state.db.project_archived_session_generations(&project_id))?;
    let mut confirmed_archives = sessions
        .into_iter()
        .map(|session| (session.id, session.archive_generation))
        .collect::<Vec<_>>();
    confirmed_archives.sort_by(|left, right| left.0.cmp(&right.0));
    if confirmed_archives
        .windows(2)
        .any(|pair| pair[0].0 == pair[1].0)
        || current_archives != confirmed_archives
    {
        return Err("archived Sessions changed after confirmation; review and try again".into());
    }
    // Preserve the same stop-before-purge guarantee as the archive Settings
    // flow, while limiting the destructive action to the exact confirmed set.
    // The database revalidates that set after stopping to close the race.
    let confirmed_ids = confirmed_archives
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    map_err!(stop_archived_sessions_for_purge(&state, &confirmed_ids))?;
    let native_plans = plan_native_cleanups(&state, &confirmed_ids);
    let purged = map_err!(state
        .db
        .purge_project_archived_sessions(&project_id, &confirmed_archives))?;
    run_native_cleanups(&app, &native_plans);
    cleanup_purged_sessions(&state, &purged);
    emit_sessions_changed(&app, &state, None);
    Ok(())
}

#[tauri::command]
async fn delete_all_archived_sessions(
    state: State<'_, AppState>,
    app: AppHandle,
) -> std::result::Result<(), String> {
    let archived_sessions: Vec<Session> = map_err!(state.db.list_sessions(None, true))?
        .into_iter()
        .filter(|session| session.archived_at.is_some())
        .collect();
    let archived_ids: Vec<String> = archived_sessions
        .iter()
        .map(|session| session.id.clone())
        .collect();
    // Stop first, then purge as a batch. A stop error leaves every archive
    // intact instead of only partially deleting the user's archive history.
    // Legacy archives are stopped in bounded parallel batches.
    map_err!(stop_archived_sessions_for_purge(&state, &archived_ids))?;
    let native_plans: Vec<(String, NativeCleanupPlan)> = archived_sessions
        .iter()
        .map(|session| {
            (
                session.id.clone(),
                plan_native_cleanup(&state.paths, session),
            )
        })
        .collect();
    let purged = map_err!(state.db.purge_all_archived_sessions())?;
    run_native_cleanups(&app, &native_plans);
    cleanup_purged_sessions(&state, &purged);
    emit_sessions_changed(&app, &state, None);
    Ok(())
}

#[tauri::command]
async fn session_history(
    state: State<'_, AppState>,
    session_id: String,
) -> std::result::Result<Vec<Value>, String> {
    let events = map_err!(state.db.status_history(&session_id, 200))?;
    Ok(events.iter().map(status_value).collect())
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

#[tauri::command]
async fn preview_worktree(
    state: State<'_, AppState>,
    project_id: String,
    task: String,
) -> std::result::Result<agentport_core::git::WorktreePreview, String> {
    let manager = WorktreeManager {
        paths: &state.paths,
        db: &state.db,
    };
    map_err!(manager.preview(&project_id, &task))
}

#[tauri::command]
async fn reconcile_worktrees(
    state: State<'_, AppState>,
    app: AppHandle,
    project_id: String,
) -> std::result::Result<usize, String> {
    let paths = state.paths.clone();
    let recovered = tauri::async_runtime::spawn_blocking(move || {
        let db = Db::open(&paths)?;
        WorktreeManager {
            paths: &paths,
            db: &db,
        }
        .reconcile_owned_worktrees(&project_id)
    })
    .await
    .map_err(|error| format!("Worktree reconciliation task failed: {error}"))?
    .map_err(|error| error.to_string())?;
    if recovered > 0 {
        emit_sessions_changed(&app, &state, None);
    }
    Ok(recovered)
}

fn parse_worktree_branch_selection(
    mode: Option<&str>,
    branch: Option<&str>,
    expected_branch_oid: Option<&str>,
) -> Result<WorktreeBranchSelection> {
    let required_branch = || {
        branch
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| CoreError::Validation("branch name is required for this mode".into()))
    };
    match mode {
        Some("auto") => {
            if branch.is_some_and(|branch| !branch.trim().is_empty()) {
                return Err(CoreError::Validation(
                    "auto Worktree branch mode must not include a branch name".into(),
                ));
            }
            Ok(WorktreeBranchSelection::Auto)
        }
        Some("new") => Ok(WorktreeBranchSelection::New {
            name: required_branch()?,
        }),
        Some("existing") => Ok(WorktreeBranchSelection::Existing {
            name: required_branch()?,
            expected_oid: expected_branch_oid
                .map(str::trim)
                .filter(|oid| !oid.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    CoreError::Validation(
                        "expected branch OID is required when using an existing branch".into(),
                    )
                })?,
        }),
        Some(other) => Err(CoreError::Validation(format!(
            "unsupported Worktree branch mode: {other}"
        ))),
        None => Err(CoreError::Validation(
            "explicit Worktree branch mode is required".into(),
        )),
    }
}

#[tauri::command]
// Tauri exposes command arguments as individual invoke keys, so keeping this
// boundary flat preserves the existing frontend contract. CommandError also
// intentionally carries the complete recovery snapshot across that boundary.
#[allow(clippy::too_many_arguments, clippy::result_large_err)]
async fn create_worktree(
    state: State<'_, AppState>,
    app: AppHandle,
    project_id: String,
    task: String,
    base_ref: Option<String>,
    branch: Option<String>,
    branch_mode: Option<String>,
    expected_branch_oid: Option<String>,
) -> std::result::Result<Value, git_commands::CommandError> {
    let explicit_selection = match branch_mode.as_deref() {
        Some(mode) => Some(
            parse_worktree_branch_selection(
                Some(mode),
                branch.as_deref(),
                expected_branch_oid.as_deref(),
            )
            .map_err(|error| {
                git_commands::CommandError::for_project_command(
                    error,
                    Some(&state.db),
                    Some(&project_id),
                    "create_worktree",
                    "validate",
                )
            })?,
        ),
        None => None,
    };
    let paths = state.paths.clone();
    let command_project_id = project_id.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        let db = Db::open(&paths).map_err(|error| {
            git_commands::CommandError::for_project_command(
                error,
                None,
                Some(&command_project_id),
                "create_worktree",
                "open_database",
            )
        })?;
        let manager = WorktreeManager {
            paths: &paths,
            db: &db,
        };
        let created = match explicit_selection {
            Some(selection) => {
                manager.create_selected(&command_project_id, &task, base_ref.as_deref(), selection)
            }
            None => manager.create(
                &command_project_id,
                &task,
                base_ref.as_deref(),
                branch.as_deref(),
            ),
        }
        .map_err(|error| {
            git_commands::CommandError::for_project_command(
                error,
                Some(&db),
                Some(&command_project_id),
                "create_worktree",
                "create",
            )
        })?;
        Ok::<Worktree, git_commands::CommandError>(created)
    })
    .await
    .map_err(|error| {
        git_commands::CommandError::for_join("create_worktree", "create", error.to_string())
    })?;
    let result = join;
    // Reconciliation at the start of creation may have recovered an orphan
    // even when the requested branch then conflicts. Always publish the
    // authoritative project tree after the operation finishes.
    emit_sessions_changed(&app, &state, None);
    let w = result?;
    Ok(json!({"id": w.id, "branch": w.branch, "path": w.path, "baseCommit": w.base_commit}))
}

#[tauri::command]
async fn list_worktrees(
    state: State<'_, AppState>,
    project_id: String,
) -> std::result::Result<Vec<WorktreeView>, String> {
    let mgr = WorktreeManager {
        paths: &state.paths,
        db: &state.db,
    };
    let mut out = vec![];
    for w in map_err!(state.db.list_worktrees(&project_id))? {
        let _ = mgr.refresh_health(&w.id);
        let w = state.db.get_worktree(&w.id).map_err(|e| e.to_string())?;
        out.push(worktree_view(&w));
    }
    Ok(out)
}

#[tauri::command]
async fn remove_worktree(
    state: State<'_, AppState>,
    app: AppHandle,
    worktree_id: String,
) -> std::result::Result<Value, String> {
    map_err!(state.db.begin_worktree_removal(&worktree_id))?;
    let sessions = map_err!(state.db.list_sessions(None, true))?
        .into_iter()
        .filter(|session| session.worktree_id.as_deref() == Some(worktree_id.as_str()))
        .collect::<Vec<_>>();
    let session_ids = sessions
        .iter()
        .map(|session| session.id.clone())
        .collect::<Vec<_>>();
    let native_plans = sessions
        .iter()
        .map(|session| {
            (
                session.id.clone(),
                plan_native_cleanup(&state.paths, session),
            )
        })
        .collect::<Vec<_>>();
    if let Err(error) = stop_sessions_for_project_removal(&state, &session_ids) {
        map_err!(state.db.cancel_worktree_removal(&worktree_id))?;
        return Err(error);
    }

    let mgr = WorktreeManager {
        paths: &state.paths,
        db: &state.db,
    };
    let outcome = map_err!(mgr.remove_after_fence(&worktree_id))?;
    run_native_cleanups(&app, &native_plans);
    cleanup_purged_sessions(&state, &session_ids);
    emit_sessions_changed(&app, &state, None);
    Ok(json!({
        "stopWarnings": 0,
        "cleanupWarnings": outcome.cleanup_warnings,
    }))
}

#[tauri::command]
async fn worktree_delete_preflight(
    state: State<'_, AppState>,
    worktree_id: String,
) -> std::result::Result<agentport_core::git::WorktreeDeletePreflight, String> {
    let manager = WorktreeManager {
        paths: &state.paths,
        db: &state.db,
    };
    map_err!(manager.deletion_preflight(&worktree_id))
}

#[tauri::command]
async fn worktree_status_text(
    state: State<'_, AppState>,
    worktree_id: String,
) -> std::result::Result<Value, String> {
    let mgr = WorktreeManager {
        paths: &state.paths,
        db: &state.db,
    };
    let h = map_err!(mgr.refresh_health(&worktree_id))?;
    let s = map_err!(mgr.dirty_summary(&worktree_id))?;
    Ok(json!({
        "health": h.as_str(),
        "modified": s.modified, "staged": s.staged, "untracked": s.untracked,
        "ignored": s.ignored, "ignoredSample": s.ignored_sample,
        "raw": s.raw,
    }))
}

// ---------------------------------------------------------------------------
// Export / search / timeline / diag / settings / secrets
// ---------------------------------------------------------------------------

fn load_all_secret_values(state: &AppState) -> Vec<Vec<u8>> {
    let Ok(broker) = CredentialBroker::detect() else {
        return vec![];
    };
    let mut out = vec![];
    if let Ok(refs) = state.db.list_secret_refs() {
        for r in &refs {
            if let Ok(v) = broker.load(r) {
                out.push(v.expose().to_vec());
            }
        }
    }
    out
}

#[tauri::command]
async fn export_session(
    state: State<'_, AppState>,
    session_id: String,
    kind: String,
    dest: String,
    _last: Option<u32>,
    _strip_ansi: bool,
) -> std::result::Result<String, String> {
    let exporter = Exporter {
        paths: &state.paths,
        db: &state.db,
    };
    let secrets = load_all_secret_values(&state);
    let destp = std::path::Path::new(&dest);
    let p = match kind.as_str() {
        "md" | "json" => {
            let session = map_err!(state.db.get_session(&session_id))?;
            NativeHistory::new(&state.paths).export(&session, destp, &kind)
        }
        "zip" => exporter.export_diagnostics_zip(&[session_id], destp, &secrets),
        "log" => return Err("raw terminal log export was removed; choose md or json".into()),
        _ => return Err("unknown export kind".into()),
    };
    map_err!(p).map(|p| p.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Agent-scoped backup / merge restore (settings page)
// ---------------------------------------------------------------------------

/// Each archive contains only the chosen agent and its Session dependencies.
#[tauri::command]
async fn backup_create(
    app: AppHandle,
    agent: AgentType,
    request_id: String,
    dest: Option<String>,
) -> std::result::Result<Value, String> {
    run_backend_blocking(move || {
        let state = app.state::<AppState>();
        let dest = match dest {
            Some(d) if !d.trim().is_empty() => std::path::PathBuf::from(d),
            _ => state.paths.backups_dir().join(format!(
                "agentport-{}-{}.zip",
                agent.as_str(),
                Utc::now().format("%Y%m%d-%H%M%S-%3f")
            )),
        };
        let mut last_phase = None;
        let mut last_emit = std::time::Instant::now();
        let mut progress = |progress: agentport_core::backup::BackupProgress| {
            if last_phase != Some(progress.phase)
                || (progress.total > 0 && progress.completed == progress.total)
                || last_emit.elapsed() >= Duration::from_millis(100)
            {
                let _ = app.emit("backup-progress", json!({
                    "requestId": request_id, "agent": agent,
                    "phase": progress.phase, "completed": progress.completed, "total": progress.total,
                }));
                last_phase = Some(progress.phase);
                last_emit = std::time::Instant::now();
            }
        };
        let report = map_err!(agentport_core::backup::create_agent_with_progress(
            &state.paths, &state.db, &dest, agent, &mut progress
        ))?;
        progress(agentport_core::backup::BackupProgress {
            phase: agentport_core::backup::BackupPhase::Verify, completed: 0, total: 0,
        });
        map_err!(agentport_core::backup::verify(&dest))?;
        Ok(json!({
            "path": dest, "agentType": agent,
            "files": report.files, "bytes": report.bytes, "verified": true,
            "nativeCoverage": report.native_coverage,
        }))
    })
    .await
}

/// Lightweight listing of the private backups dir. Integrity is verified on
/// demand (hashing every file on each list would be needlessly slow).
#[tauri::command]
async fn backup_list(state: State<'_, AppState>) -> std::result::Result<Value, String> {
    let dir = state.paths.backups_dir();
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("zip") {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified: std::result::Result<chrono::DateTime<Utc>, _> =
                meta.modified().map(|t| t.into());
            items.push(json!({
                "path": path,
                "name": entry.file_name().to_string_lossy(),
                "size": meta.len(),
                "modifiedAt": modified.map(|t| t.to_rfc3339()).unwrap_or_default(),
            }));
        }
    }
    items.sort_by(|a, b| {
        b["modifiedAt"]
            .as_str()
            .unwrap_or("")
            .cmp(a["modifiedAt"].as_str().unwrap_or(""))
    });
    Ok(Value::Array(items))
}

#[tauri::command]
async fn backup_verify(path: String) -> std::result::Result<Value, String> {
    let manifest = map_err!(agentport_core::backup::verify(std::path::Path::new(&path)))?;
    Ok(json!({
        "ok": true,
        "formatVersion": manifest.format_version,
        "agentType": manifest.agent_type,
        "createdAt": manifest.created_at,
        "dataModelVersion": manifest.data_model_version,
        "files": manifest.files.len(),
        "nativeCoverage": manifest.native_coverage,
    }))
}

/// Merge missing Sessions of one agent. Existing Sessions are never replaced.
#[tauri::command]
async fn backup_restore(
    app: AppHandle,
    path: String,
    agent: AgentType,
) -> std::result::Result<Value, String> {
    run_backend_blocking(move || {
        let state = app.state::<AppState>();
        let report = map_err!(agentport_core::backup::restore_agent(
            std::path::Path::new(&path),
            &state.paths,
            &state.db,
            agent
        ))?;
        let _ = app.emit("projects-changed", collect_projects(&state.db, None));
        Ok(json!(report))
    })
    .await
}

fn search_sync(
    paths: &AppPaths,
    db: &Db,
    query: String,
    limit: Option<usize>,
) -> std::result::Result<Value, String> {
    let limit = limit.unwrap_or(20).min(1_000);
    let needle = query.trim().to_lowercase();
    if needle.chars().count() < 2 {
        return Err("search query needs at least 2 characters".into());
    }
    let history = NativeHistory::new(paths);
    let mut hits = Vec::new();
    let mut total_hits = 0usize;
    let projects = map_err!(db.list_projects())?;
    for project in &projects {
        if project.name.to_lowercase().contains(&needle)
            || project.root_path.to_lowercase().contains(&needle)
        {
            total_hits = total_hits.saturating_add(1);
            if hits.len() < limit {
                hits.push(json!({
                    "kind": "project",
                    "sessionId": Value::Null,
                    "projectId": project.id,
                    "title": project.name,
                    "snippet": project.root_path,
                    "logOffset": Value::Null,
                    "rotatedAway": false,
                }));
            }
        }
        for worktree in map_err!(db.list_worktrees(&project.id))? {
            if worktree.branch.to_lowercase().contains(&needle)
                || worktree.path.to_lowercase().contains(&needle)
            {
                total_hits = total_hits.saturating_add(1);
                if hits.len() < limit {
                    hits.push(json!({
                        "kind": "branch",
                        "sessionId": Value::Null,
                        "projectId": project.id,
                        "title": worktree.branch,
                        "snippet": worktree.path,
                        "logOffset": Value::Null,
                        "rotatedAway": false,
                    }));
                }
            }
        }
    }
    let mut partial = limit == 0;
    if hits.len() == limit {
        partial = true;
    } else {
        for session in map_err!(db.list_sessions(None, false))? {
            if session.title.to_lowercase().contains(&needle)
                || session.cwd.to_lowercase().contains(&needle)
                || session.adapter_type.as_str().contains(&needle)
            {
                total_hits = total_hits.saturating_add(1);
                if hits.len() < limit {
                    hits.push(json!({
                        "kind": "session",
                        "sessionId": session.id,
                        "projectId": session.project_id,
                        "title": session.title,
                        "snippet": session.cwd,
                        "logOffset": Value::Null,
                        "rotatedAway": false,
                    }));
                }
                if hits.len() == limit {
                    partial = true;
                    break;
                }
            }
            let remaining = limit.saturating_sub(hits.len());
            let result = map_err!(history.search_session_bounded(&session, &query, remaining,))?;
            total_hits = total_hits.saturating_add(result.total_hits);
            for hit in result.hits {
                hits.push(json!({
                    "kind": "terminal",
                    "sessionId": session.id,
                    "projectId": session.project_id,
                    "title": session.title,
                    "snippet": hit.snippet,
                    "eventId": hit.event.id,
                    "provider": hit.event.provider,
                    "logOffset": Value::Null,
                    "rotatedAway": false,
                }));
            }
            if result.partial || hits.len() == limit {
                partial = true;
                break;
            }
        }
    }
    Ok(json!({
        "partial": partial,
        "totalHits": total_hits,
        "hits": hits,
    }))
}

#[tauri::command]
async fn search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> std::result::Result<Value, String> {
    let paths = state.paths.clone();
    run_backend_blocking(move || {
        let db = Db::open(&paths).map_err(|error| error.to_string())?;
        search_sync(&paths, &db, query, limit)
    })
    .await
}

#[tauri::command]
async fn get_native_history(
    state: State<'_, AppState>,
    session_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
) -> std::result::Result<Value, String> {
    let paths = state.paths.clone();
    run_backend_blocking(move || {
        let db = Db::open(&paths).map_err(|error| error.to_string())?;
        let session = map_err!(db.get_session(&session_id))?;
        let page = map_err!(NativeHistory::new(&paths).page(
            &session,
            cursor.as_deref(),
            limit.unwrap_or(agentport_core::history::DEFAULT_HISTORY_PAGE_SIZE),
        ))?;
        map_err!(serde_json::to_value(page))
    })
    .await
}

#[tauri::command]
async fn get_legacy_log_inventory(
    state: State<'_, AppState>,
) -> std::result::Result<Value, String> {
    let sessions = map_err!(state.db.list_sessions(None, true))?;
    let inventory = map_err!(agentport_core::legacy_logs::inventory(
        &state.paths,
        &sessions
    ))?;
    map_err!(serde_json::to_value(inventory))
}

#[tauri::command]
async fn delete_legacy_logs(
    state: State<'_, AppState>,
    entry_ids: Vec<String>,
    confirmed: bool,
) -> std::result::Result<Value, String> {
    let sessions = map_err!(state.db.list_sessions(None, true))?;
    let report = map_err!(agentport_core::legacy_logs::delete_selected(
        &state.paths,
        &sessions,
        &entry_ids,
        confirmed,
    ))?;
    map_err!(serde_json::to_value(report))
}

#[tauri::command]
async fn rebuild_search_index(state: State<'_, AppState>) -> std::result::Result<(), String> {
    let paths = state.paths.clone();
    run_backend_blocking(move || {
        let db = Db::open(&paths).map_err(|error| error.to_string())?;
        SearchIndex {
            db: &db,
            paths: &paths,
        }
        .purge_transcript_bodies()
        .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn get_timeline(state: State<'_, AppState>) -> std::result::Result<Value, String> {
    let paths = state.paths.clone();
    run_backend_blocking(move || {
        let db = Db::open(&paths).map_err(|error| error.to_string())?;
        let t = map_err!(Timeline { db: &db }.build_and_acknowledge_hidden_only())?;
        Ok(json!({
            "completed": t.completed, "waiting": t.waiting, "failed": t.failed,
            "entries": t.entries, "ackSnapshots": t.ack_snapshots,
        }))
    })
    .await
}

#[tauri::command]
async fn ack_timeline(
    state: State<'_, AppState>,
    snapshots: Vec<RecoveryAckSnapshot>,
) -> std::result::Result<(), String> {
    let tl = Timeline { db: &state.db };
    map_err!(tl.acknowledge_snapshot(&snapshots))
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> std::result::Result<Settings, String> {
    map_err!(state.db.load_settings())
}

#[tauri::command]
async fn save_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> std::result::Result<(), String> {
    map_err!(state.db.save_settings(&settings))?;
    state
        .notifier
        .lock()
        .unwrap()
        .configure(settings.notifications_enabled, settings.ui_language);
    Ok(())
}

#[tauri::command]
async fn diag_hosts(state: State<'_, AppState>) -> std::result::Result<Vec<Value>, String> {
    let diag = Diagnostics {
        paths: &state.paths,
        db: &state.db,
    };
    let hosts = map_err!(diag.host_list())?;
    Ok(hosts
        .iter()
        .map(|h| serde_json::to_value(h).unwrap())
        .collect())
}

#[tauri::command]
async fn diag_summary(state: State<'_, AppState>) -> std::result::Result<String, String> {
    let diag = Diagnostics {
        paths: &state.paths,
        db: &state.db,
    };
    map_err!(diag.copyable_summary())
}

#[tauri::command]
async fn diag_capabilities(state: State<'_, AppState>) -> std::result::Result<String, String> {
    let diag = Diagnostics {
        paths: &state.paths,
        db: &state.db,
    };
    map_err!(diag.adapter_capabilities_json())
}

// Desktop preserves the legacy scalar/status and invoke signatures. The
// shared service owns the typed metadata-only facade and the staged,
// compensating secret publication path; both delegate storage to Core.
#[tauri::command]
async fn secret_status() -> String {
    format!("{:?}", CredentialBroker::backend_status())
}

#[tauri::command]
async fn secret_add(
    state: State<'_, AppState>,
    preset_id: String,
    env_name: String,
    value: String,
) -> std::result::Result<Value, String> {
    let broker = map_err!(CredentialBroker::detect())?;
    let r = map_err!(broker.store(&env_name, &preset_id, value.as_bytes()))?;
    map_err!(state.db.upsert_secret_ref(&r))?;
    let mut preset = map_err!(state.db.get_preset(&preset_id))?;
    if !preset.secret_ref_ids.contains(&r.id) {
        preset.secret_ref_ids.push(r.id.clone());
        map_err!(state.db.upsert_preset(&preset))?;
    }
    Ok(json!({"id": r.id, "envName": r.env_name, "backend": r.backend.as_str()}))
}

#[tauri::command]
async fn secret_list(state: State<'_, AppState>) -> std::result::Result<Vec<Value>, String> {
    let refs = map_err!(state.db.list_secret_refs())?;
    Ok(refs
        .iter()
        .map(|r| {
            json!({"id": r.id, "envName": r.env_name, "backend": r.backend.as_str(),
                "account": r.account, "updatedAt": r.updated_at})
        })
        .collect())
}

#[tauri::command]
async fn secret_delete(state: State<'_, AppState>, id: String) -> std::result::Result<(), String> {
    let r = map_err!(state.db.get_secret_ref(&id))?;
    if let Ok(broker) = CredentialBroker::detect() {
        let _ = broker.delete(&r);
    }
    let mut commit_ai = map_err!(state.db.load_commit_ai_settings())?;
    if commit_ai.api_key_secret_ref_id.as_deref() == Some(&id) {
        commit_ai.api_key_secret_ref_id = None;
        map_err!(state.db.save_commit_ai_settings(&commit_ai))?;
    }
    map_err!(state.db.delete_secret_ref(&id))?;
    for mut p in map_err!(state.db.list_presets(None))? {
        if p.secret_ref_ids.contains(&id) {
            p.secret_ref_ids.retain(|x| x != &id);
            let _ = state.db.upsert_preset(&p);
        }
    }
    Ok(())
}

#[tauri::command]
async fn notify_test(state: State<'_, AppState>) -> std::result::Result<(), String> {
    let (enabled, language) = {
        let notifier = state.notifier.lock().unwrap();
        (notifier.enabled(), notifier.language())
    };
    if !enabled {
        return Err("notifications_disabled".into());
    }
    map_err!(notifications::send(&test_notification(language)))
}

#[tauri::command]
fn take_pending_notification_session() -> Option<String> {
    notifications::take_pending_session()
}

fn require_existing_path(path: &str) -> std::result::Result<(), String> {
    if std::path::Path::new(path).exists() {
        Ok(())
    } else {
        Err(format!(
            "项目目录已不存在，无法在文件管理器中显示：{path}。可从 AgentPort 移除该项目记录。"
        ))
    }
}

#[tauri::command]
async fn reveal_in_file_manager(path: String) -> std::result::Result<(), Value> {
    if let Err(message) = require_existing_path(&path) {
        return Err(runtime_command_error(
            "project_path_missing",
            json!({"path": path}),
            message.clone(),
            message,
        ));
    }
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .args(["-R", &path])
            .status()
    } else {
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(&path));
        std::process::Command::new("xdg-open").arg(dir).status()
    };
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(runtime_command_error(
            "file_manager_failed",
            json!({}),
            s.to_string(),
            format!("file manager exited with {s}"),
        )),
        Err(e) => Err(runtime_command_error(
            "file_manager_failed",
            json!({}),
            e.to_string(),
            e.to_string(),
        )),
    }
}

fn validate_external_url(url: &str) -> std::result::Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|error| format!("invalid URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("only absolute http:// and https:// URLs can be opened".into());
    }
    Ok(())
}

#[tauri::command]
async fn open_external_url(url: String) -> std::result::Result<(), Value> {
    validate_external_url(&url).map_err(|message| {
        runtime_command_error("external_url_rejected", json!({}), message.clone(), message)
    })?;
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&url).status()
    } else if cfg!(target_os = "linux") {
        std::process::Command::new("xdg-open").arg(&url).status()
    } else {
        return Err(runtime_command_error(
            "external_url_unsupported",
            json!({}),
            "external URL opening is unsupported on this platform",
            "external URL opening is unsupported on this platform",
        ));
    };
    match status {
        Ok(result) if result.success() => Ok(()),
        Ok(result) => Err(runtime_command_error(
            "external_url_open_failed",
            json!({}),
            result.to_string(),
            format!("URL opener exited with {result}"),
        )),
        Err(error) => Err(runtime_command_error(
            "external_url_open_failed",
            json!({}),
            error.to_string(),
            error.to_string(),
        )),
    }
}

#[tauri::command]
async fn open_in_system_terminal(
    state: State<'_, AppState>,
    path: String,
) -> std::result::Result<(), String> {
    require_existing_path(&path)?;
    if cfg!(target_os = "macos") {
        return match std::process::Command::new("open")
            .args(["-a", "Terminal", &path])
            .status()
        {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("open exited with {s}")),
            Err(e) => Err(e.to_string()),
        };
    }

    let configured = map_err!(state.db.load_settings())?.terminal_command;
    if let Some(command) = (!configured.trim().is_empty()).then_some(configured.trim()) {
        return launch_terminal(command, &[], &path);
    }

    let mut failures = Vec::new();
    for term in ["x-terminal-emulator", "gnome-terminal", "konsole"] {
        let args = fallback_terminal_args(term, &path);
        match launch_terminal(term, &args, &path) {
            Ok(()) => return Ok(()),
            Err(error) => failures.push(error),
        }
    }
    Err(format!(
        "no terminal emulator launched successfully: {}",
        failures.join("; ")
    ))
}

fn fallback_terminal_args<'a>(command: &str, cwd: &'a str) -> Vec<&'a str> {
    match command {
        "x-terminal-emulator" => Vec::new(),
        "gnome-terminal" => vec!["--working-directory", cwd],
        "konsole" => vec!["--workdir", cwd],
        _ => Vec::new(),
    }
}

fn launch_terminal(command: &str, args: &[&str], cwd: &str) -> std::result::Result<(), String> {
    let status = std::process::Command::new(command)
        .args(args)
        .current_dir(cwd)
        .status()
        .map_err(|error| format!("{command}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{command} exited with {status}"))
    }
}

/// Native directory picker. MUST NOT use blocking_pick_folder: a blocking
/// dialog freezes the main-thread event loop (the window dies right after
/// the dialog appears — exactly the reported bug). Instead: schedule the
/// dialog, yield, and await the callback result on the async runtime.
#[tauri::command]
async fn pick_directory(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.try_send(path.map(|p| p.to_string()));
    });
    rx.recv().await.flatten()
}

#[tauri::command]
async fn pick_save_path(app: AppHandle, default_name: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .save_file(move |path| {
            let _ = tx.try_send(path.map(|p| p.to_string()));
        });
    rx.recv().await.flatten()
}

fn read_session_document_impl(path: &str) -> std::result::Result<Value, Value> {
    const MAX_DOCUMENT_BYTES: u64 = 1024 * 1024;
    const BINARY_SNIFF_BYTES: usize = 8 * 1024;

    let reject = |code: &str, message: String| {
        runtime_command_error(code, json!({ "path": path }), message.clone(), message)
    };

    let raw = std::path::Path::new(&path);
    if !raw.is_absolute() {
        return Err(reject(
            "document_path_relative",
            format!("只能打开绝对路径的文档：{path}"),
        ));
    }
    let canonical = std::fs::canonicalize(raw).map_err(|e| {
        reject(
            "document_not_found",
            format!("文档不存在或无法访问：{path}（{e}）"),
        )
    })?;
    let metadata = std::fs::metadata(&canonical).map_err(|e| {
        reject(
            "document_not_found",
            format!("无法读取文档信息：{path}（{e}）"),
        )
    })?;
    if !metadata.is_file() {
        return Err(reject(
            "document_not_file",
            format!("该路径不是文件，无法在文档查看器中打开：{path}"),
        ));
    }

    let truncated = metadata.len() > MAX_DOCUMENT_BYTES;
    let mut bytes = vec![0u8; metadata.len().min(MAX_DOCUMENT_BYTES) as usize];
    {
        use std::io::Read;
        let mut file = std::fs::File::open(&canonical).map_err(|e| {
            reject(
                "document_read_failed",
                format!("无法读取文档：{path}（{e}）"),
            )
        })?;
        file.read_exact(&mut bytes).map_err(|e| {
            reject(
                "document_read_failed",
                format!("无法读取文档：{path}（{e}）"),
            )
        })?;
    }
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return Err(reject(
            "document_binary",
            format!("二进制文件不支持在文档查看器中预览：{path}"),
        ));
    }

    let content = String::from_utf8_lossy(&bytes).into_owned();
    Ok(json!({
        "path": canonical.to_string_lossy(),
        "content": content,
        "truncated": truncated,
        "sizeBytes": metadata.len(),
    }))
}

#[tauri::command]
async fn read_session_document(path: String) -> std::result::Result<Value, Value> {
    read_session_document_impl(&path)
}

fn write_session_document_impl(path: &str, content: &str) -> std::result::Result<Value, Value> {
    const MAX_WRITE_BYTES: usize = 8 * 1024 * 1024;

    let reject = |code: &str, message: String| {
        runtime_command_error(code, json!({ "path": path }), message.clone(), message)
    };

    let raw = std::path::Path::new(path);
    if !raw.is_absolute() {
        return Err(reject(
            "document_path_relative",
            format!("只能写入绝对路径的文档：{path}"),
        ));
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err(reject(
            "document_too_large",
            format!("文档内容超过大小限制，无法保存：{path}"),
        ));
    }
    let canonical = std::fs::canonicalize(raw).map_err(|e| {
        reject(
            "document_not_found",
            format!("文档不存在或无法访问：{path}（{e}）"),
        )
    })?;
    if !canonical.is_file() {
        return Err(reject(
            "document_not_file",
            format!("该路径不是文件，无法保存：{path}"),
        ));
    }

    // Write to a sibling temp file and rename, so a crash mid-save never
    // leaves a half-written document behind.
    let parent = canonical.parent().ok_or_else(|| {
        reject(
            "document_write_failed",
            format!("无法确定文档所在目录：{path}"),
        )
    })?;
    let tmp = parent.join(format!(
        ".agentport-doc-save-{}-{}.tmp",
        std::process::id(),
        canonical
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "document".into())
    ));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| {
        reject(
            "document_write_failed",
            format!("无法写入文档：{path}（{e}）"),
        )
    })?;
    std::fs::rename(&tmp, &canonical).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        reject(
            "document_write_failed",
            format!("无法保存文档：{path}（{e}）"),
        )
    })?;
    Ok(json!({
        "path": canonical.to_string_lossy(),
        "sizeBytes": content.len(),
    }))
}

#[tauri::command]
async fn write_session_document(
    path: String,
    content: String,
) -> std::result::Result<Value, Value> {
    write_session_document_impl(&path, &content)
}

fn list_document_directory_impl(path: &str) -> std::result::Result<Value, Value> {
    const MAX_ENTRIES: usize = 2000;

    let reject = |code: &str, message: String| {
        runtime_command_error(code, json!({ "path": path }), message.clone(), message)
    };

    let raw = std::path::Path::new(path);
    if !raw.is_absolute() {
        return Err(reject(
            "document_path_relative",
            format!("只能浏览绝对路径的目录：{path}"),
        ));
    }
    let canonical = std::fs::canonicalize(raw).map_err(|e| {
        reject(
            "document_not_found",
            format!("目录不存在或无法访问：{path}（{e}）"),
        )
    })?;
    if !canonical.is_dir() {
        return Err(reject(
            "document_not_directory",
            format!("该路径不是目录，无法在目录树中展开：{path}"),
        ));
    }

    let mut dirs: Vec<Value> = Vec::new();
    let mut files: Vec<Value> = Vec::new();
    let mut truncated = false;
    let entries = std::fs::read_dir(&canonical).map_err(|e| {
        reject(
            "document_read_failed",
            format!("无法读取目录：{path}（{e}）"),
        )
    })?;
    for entry in entries.flatten() {
        if dirs.len() + files.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // The git object store is never useful in the file tree and can hold
        // tens of thousands of loose objects.
        if name == ".git" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let item = json!({
            "name": name,
            "path": entry.path().to_string_lossy(),
            "isDir": is_dir,
        });
        if is_dir {
            dirs.push(item);
        } else {
            files.push(item);
        }
    }
    let key = |v: &Value| v["name"].as_str().unwrap_or("").to_lowercase();
    dirs.sort_by_key(key);
    files.sort_by_key(key);
    dirs.extend(files);
    Ok(json!({
        "path": canonical.to_string_lossy(),
        "entries": dirs,
        "truncated": truncated,
    }))
}

#[tauri::command]
async fn list_document_directory(path: String) -> std::result::Result<Value, Value> {
    list_document_directory_impl(&path)
}

fn create_document_entry_impl(path: &str, kind: &str) -> std::result::Result<Value, Value> {
    let reject = |code: &str, message: String| {
        runtime_command_error(code, json!({ "path": path }), message.clone(), message)
    };

    let raw = std::path::Path::new(path);
    if !raw.is_absolute() {
        return Err(reject(
            "document_path_relative",
            format!("只能创建绝对路径的文件或目录：{path}"),
        ));
    }
    // The tree joins the name onto a listed directory; never let it escape.
    if raw
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(reject(
            "document_create_failed",
            format!("路径不允许包含 .. 片段：{path}"),
        ));
    }
    if raw.exists() {
        return Err(reject(
            "document_entry_exists",
            format!("同名文件或目录已存在：{path}"),
        ));
    }

    match kind {
        "dir" => std::fs::create_dir_all(raw).map_err(|e| {
            reject(
                "document_create_failed",
                format!("无法创建目录：{path}（{e}）"),
            )
        })?,
        "file" => {
            if let Some(parent) = raw.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    reject(
                        "document_create_failed",
                        format!("无法创建目录：{path}（{e}）"),
                    )
                })?;
            }
            // create_new fails atomically if the file appeared meanwhile.
            std::fs::File::create_new(raw).map_err(|e| {
                reject(
                    "document_create_failed",
                    format!("无法创建文件：{path}（{e}）"),
                )
            })?;
        }
        _ => {
            return Err(reject(
                "document_create_failed",
                format!("不支持的创建类型：{kind}"),
            ))
        }
    }

    let canonical = std::fs::canonicalize(raw)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string());
    Ok(json!({ "path": canonical }))
}

#[tauri::command]
async fn create_document_entry(path: String, kind: String) -> std::result::Result<Value, Value> {
    create_document_entry_impl(&path, &kind)
}

fn rename_document_entry_impl(old_path: &str, new_path: &str) -> std::result::Result<Value, Value> {
    let reject = |code: &str, message: String| {
        runtime_command_error(
            code,
            json!({ "path": old_path }),
            message.clone(),
            message,
        )
    };

    let raw_old = std::path::Path::new(old_path);
    let raw_new = std::path::Path::new(new_path);
    if !raw_old.is_absolute() || !raw_new.is_absolute() {
        return Err(reject(
            "document_path_relative",
            format!("只能重命名绝对路径的文件或目录：{old_path} -> {new_path}"),
        ));
    }
    // The tree joins names onto a listed directory; never let it escape.
    let escapes = |p: &std::path::Path| p
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir));
    if escapes(raw_old) || escapes(raw_new) {
        return Err(reject(
            "document_rename_failed",
            format!("路径不允许包含 .. 片段：{old_path} -> {new_path}"),
        ));
    }
    if !raw_old.exists() {
        return Err(reject(
            "document_not_found",
            format!("文件或目录不存在：{old_path}"),
        ));
    }
    if raw_new.exists() {
        return Err(reject(
            "document_entry_exists",
            format!("同名文件或目录已存在：{new_path}"),
        ));
    }
    // Rename only: the tree cannot represent cross-directory moves.
    if raw_old.parent() != raw_new.parent() {
        return Err(reject(
            "document_rename_failed",
            format!("只能在原目录中重命名：{old_path} -> {new_path}"),
        ));
    }
    std::fs::rename(raw_old, raw_new).map_err(|e| {
        reject(
            "document_rename_failed",
            format!("无法重命名：{old_path} -> {new_path}（{e}）"),
        )
    })?;

    let canonical = std::fs::canonicalize(raw_new)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| new_path.to_string());
    Ok(json!({ "path": canonical }))
}

#[tauri::command]
async fn rename_document_entry(
    old_path: String,
    new_path: String,
) -> std::result::Result<Value, Value> {
    rename_document_entry_impl(&old_path, &new_path)
}

/// VSCode-style duplicate naming: `foo.md` -> `foo copy.md`, then
/// `foo copy 2.md`, … Directories and extensionless names append the suffix
/// to the whole name (`foo` -> `foo copy 2`).
fn duplicate_target_path(path: &std::path::Path) -> std::path::PathBuf {
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("/"));
    let (stem, extension) = if path.is_dir() {
        (
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            None,
        )
    } else {
        (
            path.file_stem()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path.extension().map(|e| e.to_string_lossy().into_owned()),
        )
    };
    let candidate = |suffix: &str| {
        let name = match &extension {
            Some(ext) => format!("{stem}{suffix}.{ext}"),
            None => format!("{stem}{suffix}"),
        };
        parent.join(name)
    };
    let first = candidate(" copy");
    if !first.exists() {
        return first;
    }
    for index in 2u32.. {
        let next = candidate(&format!(" copy {index}"));
        if !next.exists() {
            return next;
        }
    }
    unreachable!()
}

fn copy_directory_recursive(
    src: &std::path::Path,
    dst: &std::path::Path,
) -> std::io::Result<()> {
    // create_dir (not create_dir_all): dst's parent is the source's listed
    // parent, which already exists, and dst itself must not.
    std::fs::create_dir(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn duplicate_document_entry_impl(path: &str) -> std::result::Result<Value, Value> {
    let reject = |code: &str, message: String| {
        runtime_command_error(code, json!({ "path": path }), message.clone(), message)
    };

    let raw = std::path::Path::new(path);
    if !raw.is_absolute() {
        return Err(reject(
            "document_path_relative",
            format!("只能复制绝对路径的文件或目录：{path}"),
        ));
    }
    if raw
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(reject(
            "document_duplicate_failed",
            format!("路径不允许包含 .. 片段：{path}"),
        ));
    }
    if !raw.exists() {
        return Err(reject(
            "document_not_found",
            format!("文件或目录不存在：{path}"),
        ));
    }

    let target = duplicate_target_path(raw);
    let result = if raw.is_dir() {
        copy_directory_recursive(raw, &target).map(|_| ())
    } else {
        std::fs::copy(raw, &target).map(|_| ())
    };
    if let Err(e) = result {
        // The target did not exist before we started, so a leftover is a
        // partial copy we made; best-effort remove it.
        if target.is_dir() {
            let _ = std::fs::remove_dir_all(&target);
        } else {
            let _ = std::fs::remove_file(&target);
        }
        return Err(reject(
            "document_duplicate_failed",
            format!("无法复制：{path}（{e}）"),
        ));
    }

    let canonical = std::fs::canonicalize(&target)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| target.to_string_lossy().into_owned());
    Ok(json!({ "path": canonical }))
}

#[tauri::command]
async fn duplicate_document_entry(path: String) -> std::result::Result<Value, Value> {
    duplicate_document_entry_impl(&path)
}

fn delete_document_entry_impl(path: &str) -> std::result::Result<Value, Value> {
    let reject = |code: &str, message: String| {
        runtime_command_error(code, json!({ "path": path }), message.clone(), message)
    };

    let raw = std::path::Path::new(path);
    if !raw.is_absolute() {
        return Err(reject(
            "document_path_relative",
            format!("只能删除绝对路径的文件或目录：{path}"),
        ));
    }
    if raw
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(reject(
            "document_delete_failed",
            format!("路径不允许包含 .. 片段：{path}"),
        ));
    }
    // The filesystem root has no parent; refuse to delete it outright.
    if raw.parent().is_none() {
        return Err(reject(
            "document_delete_failed",
            format!("不允许删除根目录：{path}"),
        ));
    }
    // symlink_metadata: a symlink (even to a directory) is unlinked, never
    // traversed into.
    let metadata = std::fs::symlink_metadata(raw).map_err(|_| {
        reject(
            "document_not_found",
            format!("文件或目录不存在：{path}"),
        )
    })?;
    let result = if metadata.is_dir() {
        std::fs::remove_dir_all(raw)
    } else {
        std::fs::remove_file(raw)
    };
    result.map_err(|e| {
        reject(
            "document_delete_failed",
            format!("无法删除：{path}（{e}）"),
        )
    })?;
    Ok(json!({}))
}

#[tauri::command]
async fn delete_document_entry(path: String) -> std::result::Result<Value, Value> {
    delete_document_entry_impl(&path)
}

/// Opens a local file with the system's default application (Preview for a
/// PDF, an image viewer for a PNG, …). This is the escape hatch the document
/// viewer offers for files it cannot display itself.
#[tauri::command]
async fn open_with_default_app(path: String) -> std::result::Result<(), Value> {
    let reject = |code: &str, message: String| {
        runtime_command_error(code, json!({ "path": path }), message.clone(), message)
    };
    let raw = std::path::Path::new(&path);
    if !raw.is_absolute() {
        return Err(reject(
            "document_path_relative",
            format!("只能打开绝对路径的文件：{path}"),
        ));
    }
    if !raw.exists() {
        return Err(reject(
            "document_not_found",
            format!("文件不存在或无法访问：{path}"),
        ));
    }
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&path).status()
    } else if cfg!(target_os = "linux") {
        std::process::Command::new("xdg-open").arg(&path).status()
    } else {
        return Err(runtime_command_error(
            "external_url_unsupported",
            json!({}),
            "opening files with the default app is unsupported on this platform",
            "opening files with the default app is unsupported on this platform",
        ));
    };
    match status {
        Ok(result) if result.success() => Ok(()),
        Ok(result) => Err(runtime_command_error(
            "file_manager_failed",
            json!({}),
            result.to_string(),
            format!("default app open exited with {result}"),
        )),
        Err(e) => Err(runtime_command_error(
            "file_manager_failed",
            json!({}),
            e.to_string(),
            e.to_string(),
        )),
    }
}

/// Opens a file or directory in Visual Studio Code so the user can keep
/// editing documents the viewer only previews.
#[tauri::command]
async fn open_in_vs_code(path: String) -> std::result::Result<Value, Value> {
    let reject = |code: &str, message: String| {
        runtime_command_error(code, json!({ "path": path }), message.clone(), message)
    };
    let raw = std::path::Path::new(&path);
    if !raw.is_absolute() {
        return Err(reject(
            "document_path_relative",
            format!("只能打开绝对路径的文件或目录：{path}"),
        ));
    }
    if !raw.exists() {
        return Err(reject(
            "document_not_found",
            format!("文件或目录不存在：{path}"),
        ));
    }
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .args(["-a", "Visual Studio Code"])
            .arg(&path)
            .status()
    } else if cfg!(target_os = "linux") {
        std::process::Command::new("code").arg(&path).status()
    } else {
        return Err(reject(
            "editor_not_available",
            format!("未检测到 Visual Studio Code，无法打开：{path}"),
        ));
    };
    match status {
        Ok(result) if result.success() => Ok(json!({})),
        Ok(result) => Err(reject(
            "editor_not_available",
            format!("未检测到 Visual Studio Code，无法打开：{path}（{result}）"),
        )),
        Err(e) => Err(reject(
            "editor_not_available",
            format!("未检测到 Visual Studio Code，无法打开：{path}（{e}）"),
        )),
    }
}

#[tauri::command]
async fn pick_file(app: AppHandle, filter_name: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let mut dialog = app.dialog().file();
    if let Some(name) = filter_name {
        dialog = dialog.add_filter(name, &["zip"]);
    }
    dialog.pick_file(move |path| {
        let _ = tx.try_send(path.map(|p| p.to_string()));
    });
    rx.recv().await.flatten()
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/// WKWebView honors macOS press-and-hold: holding a character key triggers the
/// accent-menu behavior and the system suppresses repeated keydown events, so
/// terminal input cannot auto-repeat. Disable it for this app's defaults
/// domain before any WebKit process spawns. Tradeoff matches terminal-focused
/// apps (VS Code, iTerm): the accent popup no longer appears in app text
/// fields. Identifier must stay in sync with tauri.conf.json.
#[cfg(target_os = "macos")]
fn disable_press_and_hold() {
    match std::process::Command::new("defaults")
        .args([
            "write",
            "com.agentport.desktop",
            "ApplePressAndHoldEnabled",
            "-bool",
            "false",
        ])
        .status()
    {
        Ok(status) if status.success() => {}
        // Runs before the tracing subscriber is initialized — log to stderr.
        other => eprintln!("failed to disable ApplePressAndHoldEnabled: {other:?}"),
    }
}

#[cfg(not(target_os = "macos"))]
fn disable_press_and_hold() {}

fn main() {
    // macOS may deliver a notification response before Tauri's setup callback.
    // Install the delegate first so the clicked Session survives cold launch.
    notifications::install_early();
    disable_press_and_hold();
    let paths = AppPaths::discover().expect("app paths");
    paths.ensure_layout().expect("layout");
    // App diagnostics log — hangs/failures must leave evidence.
    {
        let log_dir = paths.root().join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&log_dir, std::fs::Permissions::from_mode(0o700));
        }
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("app.log"))
        {
            let _ = agentport_core::paths::AppPaths::restrict_file(&log_dir.join("app.log"));
            let _ = tracing_subscriber::fmt()
                .with_ansi(false)
                .with_writer(std::sync::Mutex::new(file))
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_env("RUST_LOG")
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                )
                .try_init();
        }
    }
    tracing::info!("AgentPort {} starting", env!("CARGO_PKG_VERSION"));
    let db = Db::open(&paths).expect("open db");
    db.seed_builtin_presets().expect("seed presets");
    let initial_settings = db.load_settings().unwrap_or_default();
    let mut notifier = Notifier::new(initial_settings.notifications_enabled);
    notifier.configure(
        initial_settings.notifications_enabled,
        initial_settings.ui_language,
    );
    let (notification_tx, notification_rx) = mpsc::sync_channel(NOTIFICATION_QUEUE_CAPACITY);
    let state = AppState {
        paths,
        db,
        writers: Arc::new(Mutex::new(HashMap::new())),
        next_attachment_id: AtomicU64::new(1),
        monitors: Arc::new(Mutex::new(HashMap::new())),
        next_monitor_id: AtomicU64::new(1),
        cleanup_scheduler_started: AtomicBool::new(false),
        branch_reconcile_started: AtomicBool::new(false),
        notifier: Mutex::new(notifier),
        notification_tx,
        notification_session: Mutex::new(None),
        notification_deduper: Mutex::new(NotificationDeduper::default()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            notifications::install(app.handle());
            start_notification_worker(app.handle().clone(), notification_rx);
            relay::start_on_app_launch(app.handle());
            // The sidebar glass is pure CSS now: the window stays
            // transparent (tauri.conf.json) and `.sidebar` owns blur,
            // saturation, and tint via backdrop-filter. A native
            // NSVisualEffectView underlay was tried (Sidebar material:
            // milky; UnderWindowBackground: desaturating) and removed —
            // two stacked glass layers only ever read as fog.
            Ok(())
        })
        .manage(state)
        .manage(relay::DesktopRelay::default())
        .invoke_handler(tauri::generate_handler![
            relay::desktop_relay_status,
            relay::desktop_relay_start,
            relay::desktop_relay_control,
            boot,
            list_projects,
            list_archived_sessions,
            probe_agents,
            probe_agent,
            notification_setups,
            set_notification_session,
            rollback_notification_setup,
            list_supported_agents,
            add_project,
            rename_project,
            set_project_layout,
            remove_project,
            project_remove_preflight,
            list_presets,
            create_session,
            attach_session,
            detach_session,
            mark_session_seen,
            mark_session_log_rendered,
            mark_session_output_unread,
            send_input,
            send_structured_prompt,
            abort_structured_turn,
            auto_rename_session_from_first_input,
            resize_pty,
            stop_session,
            interrupt_session,
            resume_session,
            restart_session,
            rename_session,
            set_session_pinned,
            archive_session,
            unarchive_session,
            delete_archived_session,
            delete_project_archived_sessions,
            delete_all_archived_sessions,
            session_history,
            preview_worktree,
            reconcile_worktrees,
            create_worktree,
            list_worktrees,
            remove_worktree,
            worktree_delete_preflight,
            worktree_status_text,
            git_commands::get_repository_status,
            git_commands::list_local_branches,
            git_commands::create_local_branch,
            git_commands::create_and_switch_local_branch,
            git_commands::delete_local_branch,
            git_commands::switch_local_branch,
            git_commands::list_auto_stashes,
            git_commands::restore_auto_stash,
            git_commands::cleanup_auto_stash,
            git_workspace_commands::resolve_git_context,
            git_workspace_commands::adopt_git_worktree_branch,
            git_workspace_commands::get_git_changes,
            git_workspace_commands::get_git_diff,
            git_workspace_commands::get_git_history,
            git_workspace_commands::get_git_commit_detail,
            git_workspace_commands::get_git_commit_diff,
            git_workspace_commands::stage_git_paths,
            git_workspace_commands::unstage_git_paths,
            git_workspace_commands::discard_git_paths,
            git_workspace_commands::add_git_ignore,
            git_workspace_commands::trash_git_path,
            git_workspace_commands::resolve_git_file,
            git_workspace_commands::sync_git_remote,
            git_workspace_commands::prepare_git_commit,
            git_workspace_commands::commit_git_changes,
            commit_ai::get_commit_ai_config,
            commit_ai::save_commit_ai_config,
            commit_ai::clear_commit_ai_api_key,
            commit_ai::generate_git_commit_message,
            export_session,
            backup_create,
            backup_list,
            backup_verify,
            backup_restore,
            search,
            get_native_history,
            get_legacy_log_inventory,
            delete_legacy_logs,
            rebuild_search_index,
            get_timeline,
            ack_timeline,
            get_settings,
            save_settings,
            diag_hosts,
            diag_summary,
            diag_capabilities,
            secret_status,
            secret_add,
            secret_list,
            secret_delete,
            notify_test,
            take_pending_notification_session,
            reveal_in_file_manager,
            open_in_system_terminal,
            open_external_url,
            read_session_document,
            write_session_document,
            list_document_directory,
            create_document_entry,
            rename_document_entry,
            duplicate_document_entry,
            delete_document_entry,
            open_with_default_app,
            open_in_vs_code,
            pick_directory,
            pick_save_path,
            pick_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building AgentPort")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                let state = app.state::<AppState>();
                capture_gui_exit_recovery_boundaries(&state);
                // Detach all clients; hosts keep running (PRD core invariant).
                let writers: Vec<_> = state
                    .writers
                    .lock()
                    .unwrap()
                    .drain()
                    .map(|(_, attachment)| attachment)
                    .collect();
                for attachment in writers {
                    shutdown_attachment(&attachment);
                }
            }
        });
}

#[cfg(test)]
mod cleanup_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::mpsc;

    #[test]
    fn backend_blocking_gate_caps_concurrent_heavy_jobs() {
        let permits = (0..MAX_BACKEND_BLOCKING_JOBS)
            .map(|_| BackendBlockingPermit::try_acquire().unwrap())
            .collect::<Vec<_>>();
        assert!(BackendBlockingPermit::try_acquire().is_none());
        drop(permits);
        assert!(BackendBlockingPermit::try_acquire().is_some());
    }

    #[test]
    fn session_monitor_retry_delay_caps_at_two_seconds() {
        assert_eq!(session_monitor_retry_delay(0), Duration::from_millis(250));
        assert_eq!(session_monitor_retry_delay(1), Duration::from_millis(500));
        assert_eq!(session_monitor_retry_delay(2), Duration::from_secs(1));
        assert_eq!(session_monitor_retry_delay(3), Duration::from_secs(2));
        assert_eq!(session_monitor_retry_delay(30), Duration::from_secs(2));
    }

    #[test]
    fn adapter_notices_use_stable_codes_and_keep_legacy_detail() {
        let launch_notices = vec![adapters::LaunchNotice::new(
            "pi_local_permissions",
            "Pi 不提供逐项权限确认，将以本地用户权限执行",
        )];
        let notices = launch_notice_values(AgentType::Pi, &launch_notices);

        assert_eq!(notices[0]["code"], "pi_local_permissions");
        assert_eq!(notices[0]["params"]["agent"], "Pi");
        assert_eq!(
            notices[0]["technicalDetail"],
            launch_notices[0].legacy_message
        );
        assert_eq!(notices[0]["message"], launch_notices[0].legacy_message);
    }

    #[test]
    fn startup_probe_reuses_a_selected_executable_until_it_disappears() {
        let temp = tempfile::tempdir().unwrap();
        let selected = temp.path().join("selected-shell");
        std::fs::write(&selected, "#!/bin/sh\n").unwrap();

        assert_eq!(
            existing_executable(selected.to_str()),
            Some(selected.as_path())
        );

        std::fs::remove_file(&selected).unwrap();
        assert_eq!(existing_executable(selected.to_str()), None);
    }

    #[test]
    fn probe_outcome_exposes_a_stable_message_alongside_legacy_reason() {
        let outcome = capability::ProbeOutcome {
            agent_type: AgentType::Codex,
            state: ProbeState::Unavailable,
            install: None,
            candidates: Vec::new(),
            reason: Some("未找到可执行文件".into()),
            reason_code: Some("probe_executable_not_found"),
            reason_detail: None,
        };

        let value = probe_outcome_json(AgentType::Codex, &outcome);
        assert_eq!(value["reasonMessage"]["code"], "probe_executable_not_found");
        assert_eq!(value["reasonMessage"]["message"], "未找到可执行文件");
        assert_eq!(value["reason"], "未找到可执行文件");
    }

    #[test]
    fn legacy_notification_status_is_informational_but_permission_request_is_visible() {
        let event = |evidence: &str| StatusEvent {
            session_id: "ses_claude".into(),
            run_id: "run_claude".into(),
            run_ordinal: 1,
            sequence: 1,
            state: AgentState::NeedsInput,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some(evidence.into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        };

        assert!(!event("hook:Notification").changes_session_state());
        assert!(event("hook:PermissionRequest").changes_session_state());
    }

    #[test]
    fn legacy_host_pty_approval_is_filtered_by_the_session_contract() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().to_path_buf());
        let db = Db::open(&paths).unwrap();
        let session_id = insert_attachment_test_session(&paths, &db);
        let event = StatusEvent {
            session_id,
            run_id: "run_legacy_host".into(),
            run_ordinal: 1,
            sequence: 1,
            state: AgentState::NeedsInput,
            source: StateSource::Pty,
            confidence: Confidence::Medium,
            evidence: Some("pty:pattern:Allow once".into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        };

        assert!(!changes_session_state_for_session(&db, &event));
    }

    #[test]
    fn launch_path_keeps_adapter_priority_and_adds_effective_entries() {
        let mut env = vec![
            ("PATH".into(), "/adapter/bin:/usr/bin:/adapter/bin".into()),
            ("AGENTPORT_TEST".into(), "kept".into()),
        ];

        capability::merge_path_env(
            &mut env,
            &[PathBuf::from("/login/bin"), PathBuf::from("/usr/bin")],
        )
        .unwrap();

        assert_eq!(env.iter().filter(|(name, _)| name == "PATH").count(), 1);
        assert_eq!(
            env.iter().find(|(name, _)| name == "PATH").unwrap().1,
            "/adapter/bin:/usr/bin:/login/bin"
        );
        assert!(env
            .iter()
            .any(|(name, value)| name == "AGENTPORT_TEST" && value == "kept"));
    }

    #[test]
    fn worktree_branch_mode_distinguishes_auto_new_and_selected_existing() {
        assert!(matches!(
            parse_worktree_branch_selection(Some("auto"), None, None).unwrap(),
            WorktreeBranchSelection::Auto
        ));
        assert!(matches!(
            parse_worktree_branch_selection(Some("new"), Some("feature/new"), None).unwrap(),
            WorktreeBranchSelection::New { name } if name == "feature/new"
        ));
        assert!(matches!(
            parse_worktree_branch_selection(
                Some("existing"),
                Some("feature/existing"),
                Some("aabbcc")
            )
            .unwrap(),
            WorktreeBranchSelection::Existing { name, expected_oid }
                if name == "feature/existing" && expected_oid == "aabbcc"
        ));
        assert!(
            parse_worktree_branch_selection(Some("existing"), Some("feature/existing"), None)
                .is_err()
        );
    }

    #[test]
    fn session_launch_rejects_a_worktree_owned_by_another_project() {
        let project = Project {
            id: "project-a".into(),
            name: "A".into(),
            root_path: "/mock/a".into(),
            git_root_path: Some("/mock/a".into()),
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        };
        let worktree = Worktree {
            id: "worktree-b".into(),
            project_id: "project-b".into(),
            branch: "feature/b".into(),
            base_commit: "a".repeat(40),
            base_ref: None,
            path: "/mock/b".into(),
            health: WorktreeHealth::Clean,
            created_at: Utc::now(),
        };

        let error = validate_worktree_project(&project, &worktree).unwrap_err();
        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(error.to_string().contains("belongs to project project-b"));
    }

    fn test_attachment(id: u64) -> RendererAttachment {
        let (writer, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        RendererAttachment {
            id,
            host: HostIdentity {
                host_pid: 42,
                protocol: agentport_core::protocol::PROTOCOL_VERSION,
                run_id: "run_test".into(),
                run_ordinal: 1,
            },
            writer: Arc::new(Mutex::new(writer)),
            rendered_log_cursor: None,
        }
    }

    #[test]
    fn session_creation_uses_the_common_repository_lock() {
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().join("repository with spaces");
        std::fs::create_dir_all(&repository).unwrap();
        let initialized = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&repository)
            .status()
            .unwrap();
        assert!(initialized.success());

        let identity = RepositoryIdentity::discover(&repository, &GitRunner::default()).unwrap();
        let held = RepositoryFileLock::acquire(&identity.common_dir).unwrap();
        let cwd = repository.to_string_lossy().into_owned();
        let (tx, rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            tx.send(acquire_session_repository_lock(&cwd).is_ok())
                .unwrap();
        });

        assert!(matches!(
            rx.recv_timeout(Duration::from_millis(75)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        drop(held);
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap());
        waiter.join().unwrap();
    }

    #[test]
    fn session_creation_does_not_create_a_lock_for_non_git_directories() {
        let temp = tempfile::tempdir().unwrap();
        assert!(
            acquire_session_repository_lock(temp.path().to_str().unwrap())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn reveal_in_file_manager_rejects_a_missing_path_before_spawning_open() {
        let missing = tempfile::tempdir().unwrap().path().join("missing-project");
        let error = require_existing_path(missing.to_str().unwrap()).unwrap_err();
        assert!(error.contains("项目目录已不存在"));
    }

    #[test]
    fn external_url_validation_allows_only_absolute_http_urls() {
        assert!(validate_external_url("https://example.com/docs?q=agentport").is_ok());
        assert!(validate_external_url("http://127.0.0.1:3000/path").is_ok());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("/missing-host").is_err());
    }

    #[test]
    fn read_session_document_reads_text_files() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("报告.md");
        std::fs::write(&file, "# 标题\n\n正文\n").unwrap();
        let value = read_session_document_impl(file.to_str().unwrap()).unwrap();
        assert_eq!(value["content"], "# 标题\n\n正文\n");
        assert_eq!(value["truncated"], false);
        assert_eq!(
            value["sizeBytes"],
            value["content"].as_str().unwrap().len() as u64
        );
        assert!(value["path"].as_str().unwrap().ends_with("报告.md"));
    }

    #[test]
    fn read_session_document_rejects_relative_missing_binary_and_directory() {
        let temp = tempfile::tempdir().unwrap();

        let relative = read_session_document_impl("docs/readme.md").unwrap_err();
        assert_eq!(relative["code"], "document_path_relative");

        let missing = read_session_document_impl(temp.path().join("missing.md").to_str().unwrap())
            .unwrap_err();
        assert_eq!(missing["code"], "document_not_found");

        let binary = temp.path().join("image.png");
        std::fs::write(&binary, [0x89, b'P', b'N', b'G', 0x00, 0x0d]).unwrap();
        let error = read_session_document_impl(binary.to_str().unwrap()).unwrap_err();
        assert_eq!(error["code"], "document_binary");

        let directory = read_session_document_impl(temp.path().to_str().unwrap()).unwrap_err();
        assert_eq!(directory["code"], "document_not_file");
    }

    #[test]
    fn write_session_document_saves_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("notes.md");
        std::fs::write(&file, "旧内容\n").unwrap();

        let value =
            write_session_document_impl(file.to_str().unwrap(), "新内容\n第二行\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "新内容\n第二行\n");
        assert_eq!(value["sizeBytes"], "新内容\n第二行\n".len() as u64);
        // No temp file is left behind in the document's directory.
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn write_session_document_rejects_relative_missing_and_directory() {
        let temp = tempfile::tempdir().unwrap();

        let relative = write_session_document_impl("docs/readme.md", "x").unwrap_err();
        assert_eq!(relative["code"], "document_path_relative");

        let missing =
            write_session_document_impl(temp.path().join("missing.md").to_str().unwrap(), "x")
                .unwrap_err();
        assert_eq!(missing["code"], "document_not_found");

        let directory =
            write_session_document_impl(temp.path().to_str().unwrap(), "x").unwrap_err();
        assert_eq!(directory["code"], "document_not_file");
    }

    #[test]
    fn list_document_directory_sorts_dirs_first_and_skips_dot_git() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("zeta")).unwrap();
        std::fs::create_dir(temp.path().join("Alpha")).unwrap();
        std::fs::create_dir(temp.path().join(".git")).unwrap();
        std::fs::write(temp.path().join("readme.md"), "x").unwrap();
        std::fs::write(temp.path().join("build.log"), "x").unwrap();

        let value = list_document_directory_impl(temp.path().to_str().unwrap()).unwrap();
        let names: Vec<&str> = value["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Alpha", "zeta", "build.log", "readme.md"]);
        assert_eq!(value["truncated"], false);
    }

    #[test]
    fn list_document_directory_rejects_files_and_relative_paths() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.md");
        std::fs::write(&file, "x").unwrap();

        let not_dir = list_document_directory_impl(file.to_str().unwrap()).unwrap_err();
        assert_eq!(not_dir["code"], "document_not_directory");

        let relative = list_document_directory_impl("some/dir").unwrap_err();
        assert_eq!(relative["code"], "document_path_relative");
    }

    #[test]
    fn create_document_entry_creates_nested_files_and_dirs() {
        let temp = tempfile::tempdir().unwrap();

        let dir = temp.path().join("a/b");
        let value = create_document_entry_impl(dir.to_str().unwrap(), "dir").unwrap();
        assert!(dir.is_dir());
        let canonical_dir = std::fs::canonicalize(&dir).unwrap();
        assert_eq!(value["path"], canonical_dir.to_string_lossy().as_ref());

        let file = temp.path().join("a/b/新文档.md");
        create_document_entry_impl(file.to_str().unwrap(), "file").unwrap();
        assert!(file.is_file());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "");

        let exists = create_document_entry_impl(file.to_str().unwrap(), "file").unwrap_err();
        assert_eq!(exists["code"], "document_entry_exists");

        let traversal = create_document_entry_impl(
            temp.path().join("..").join("escape.md").to_str().unwrap(),
            "file",
        )
        .unwrap_err();
        assert_eq!(traversal["code"], "document_create_failed");

        let relative = create_document_entry_impl("tmp/x.md", "file").unwrap_err();
        assert_eq!(relative["code"], "document_path_relative");
    }

    #[test]
    fn document_error_codes_cover_friendly_viewer_fallbacks() {
        // The panel maps these codes to a friendly empty state with actions,
        // so keep them stable: binary files and unreadable paths.
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("doc.pdf");
        std::fs::write(&binary, [b'%', b'P', b'D', b'F', 0x00, 0x01]).unwrap();
        let error = read_session_document_impl(binary.to_str().unwrap()).unwrap_err();
        assert_eq!(error["code"], "document_binary");

        let missing = read_session_document_impl(temp.path().join("missing.pdf").to_str().unwrap())
            .unwrap_err();
        assert_eq!(missing["code"], "document_not_found");
    }

    #[test]
    fn rename_document_entry_renames_within_same_directory() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("old.md");
        std::fs::write(&file, "x").unwrap();
        let renamed = temp.path().join("new.md");

        let value = rename_document_entry_impl(
            file.to_str().unwrap(),
            renamed.to_str().unwrap(),
        )
        .unwrap();
        assert!(!file.exists());
        assert_eq!(std::fs::read_to_string(&renamed).unwrap(), "x");
        let canonical = std::fs::canonicalize(&renamed).unwrap();
        assert_eq!(value["path"], canonical.to_string_lossy().as_ref());

        // Directories rename the same way.
        let dir = temp.path().join("dir-a");
        std::fs::create_dir(&dir).unwrap();
        let dir_renamed = temp.path().join("dir-b");
        rename_document_entry_impl(dir.to_str().unwrap(), dir_renamed.to_str().unwrap()).unwrap();
        assert!(!dir.exists());
        assert!(dir_renamed.is_dir());
    }

    #[test]
    fn rename_document_entry_rejects_invalid_and_conflicting_paths() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.md");
        std::fs::write(&file, "x").unwrap();
        let target = temp.path().join("b.md");
        std::fs::write(&target, "y").unwrap();

        let relative_old = rename_document_entry_impl("tmp/a.md", target.to_str().unwrap()).unwrap_err();
        assert_eq!(relative_old["code"], "document_path_relative");
        let relative_new = rename_document_entry_impl(file.to_str().unwrap(), "tmp/b.md").unwrap_err();
        assert_eq!(relative_new["code"], "document_path_relative");

        let traversal = rename_document_entry_impl(
            file.to_str().unwrap(),
            temp.path().join("..").join("escape.md").to_str().unwrap(),
        )
        .unwrap_err();
        assert_eq!(traversal["code"], "document_rename_failed");

        let missing = rename_document_entry_impl(
            temp.path().join("missing.md").to_str().unwrap(),
            temp.path().join("c.md").to_str().unwrap(),
        )
        .unwrap_err();
        assert_eq!(missing["code"], "document_not_found");

        let exists = rename_document_entry_impl(file.to_str().unwrap(), target.to_str().unwrap())
            .unwrap_err();
        assert_eq!(exists["code"], "document_entry_exists");

        // Renames must stay inside the listed directory; moves are rejected.
        let other_dir = temp.path().join("sub");
        std::fs::create_dir(&other_dir).unwrap();
        let moved = rename_document_entry_impl(
            file.to_str().unwrap(),
            other_dir.join("a.md").to_str().unwrap(),
        )
        .unwrap_err();
        assert_eq!(moved["code"], "document_rename_failed");
    }

    #[test]
    fn duplicate_document_entry_names_copy_with_incrementing_suffix() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("foo.md");
        std::fs::write(&file, "x").unwrap();

        let first = duplicate_document_entry_impl(file.to_str().unwrap()).unwrap();
        let first_path = temp.path().join("foo copy.md");
        assert_eq!(std::fs::read_to_string(&first_path).unwrap(), "x");
        let canonical = std::fs::canonicalize(&first_path).unwrap();
        assert_eq!(first["path"], canonical.to_string_lossy().as_ref());

        let second = duplicate_document_entry_impl(file.to_str().unwrap()).unwrap();
        let second_path = temp.path().join("foo copy 2.md");
        assert!(second_path.is_file());
        let canonical = std::fs::canonicalize(&second_path).unwrap();
        assert_eq!(second["path"], canonical.to_string_lossy().as_ref());
        assert!(file.is_file());

        // Extensionless files append the suffix to the whole name.
        let plain = temp.path().join("LICENSE");
        std::fs::write(&plain, "x").unwrap();
        duplicate_document_entry_impl(plain.to_str().unwrap()).unwrap();
        assert!(temp.path().join("LICENSE copy").is_file());
    }

    #[test]
    fn duplicate_document_entry_copies_directories_recursively() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("site");
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.md"), "home").unwrap();
        std::fs::write(dir.join("assets/logo.txt"), "logo").unwrap();

        let value = duplicate_document_entry_impl(dir.to_str().unwrap()).unwrap();
        let copy = temp.path().join("site copy");
        assert_eq!(std::fs::read_to_string(copy.join("index.md")).unwrap(), "home");
        assert_eq!(
            std::fs::read_to_string(copy.join("assets/logo.txt")).unwrap(),
            "logo"
        );
        let canonical = std::fs::canonicalize(&copy).unwrap();
        assert_eq!(value["path"], canonical.to_string_lossy().as_ref());

        // Duplicating a directory name containing a dot keeps the full name.
        let dotted = temp.path().join("v1.2");
        std::fs::create_dir(&dotted).unwrap();
        duplicate_document_entry_impl(dotted.to_str().unwrap()).unwrap();
        assert!(temp.path().join("v1.2 copy").is_dir());
    }

    #[test]
    fn duplicate_document_entry_rejects_relative_and_missing_paths() {
        let relative = duplicate_document_entry_impl("tmp/a.md").unwrap_err();
        assert_eq!(relative["code"], "document_path_relative");

        let temp = tempfile::tempdir().unwrap();
        let missing = duplicate_document_entry_impl(
            temp.path().join("missing.md").to_str().unwrap(),
        )
        .unwrap_err();
        assert_eq!(missing["code"], "document_not_found");

        let traversal = duplicate_document_entry_impl(
            temp.path().join("..").join("a.md").to_str().unwrap(),
        )
        .unwrap_err();
        assert_eq!(traversal["code"], "document_duplicate_failed");
    }

    #[test]
    fn delete_document_entry_removes_files_and_directories() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.md");
        std::fs::write(&file, "x").unwrap();
        let value = delete_document_entry_impl(file.to_str().unwrap()).unwrap();
        assert_eq!(value, json!({}));
        assert!(!file.exists());

        let dir = temp.path().join("tree");
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("nested/b.md"), "y").unwrap();
        delete_document_entry_impl(dir.to_str().unwrap()).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn delete_document_entry_rejects_relative_root_and_missing_paths() {
        let relative = delete_document_entry_impl("tmp/a.md").unwrap_err();
        assert_eq!(relative["code"], "document_path_relative");

        let root = delete_document_entry_impl("/").unwrap_err();
        assert_eq!(root["code"], "document_delete_failed");

        let temp = tempfile::tempdir().unwrap();
        let missing = delete_document_entry_impl(
            temp.path().join("missing.md").to_str().unwrap(),
        )
        .unwrap_err();
        assert_eq!(missing["code"], "document_not_found");

        let traversal = delete_document_entry_impl(
            temp.path().join("..").join("a.md").to_str().unwrap(),
        )
        .unwrap_err();
        assert_eq!(traversal["code"], "document_delete_failed");
    }

    fn insert_attachment_test_session(paths: &AppPaths, db: &Db) -> String {
        let project_id = ids::new_id("prj_attachment");
        db.add_project(&Project {
            id: project_id.clone(),
            name: "attachment test".into(),
            root_path: paths.root().to_string_lossy().into_owned(),
            git_root_path: None,
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
        let session_id = ids::new_id("ses_attachment");
        let now = Utc::now();
        db.insert_session(&Session {
            id: session_id.clone(),
            project_id,
            worktree_id: None,
            preset_id: "pre_shell_safe".into(),
            title: "attachment test".into(),
            cwd: paths.root().to_string_lossy().into_owned(),
            host_pid: None,
            host_socket: None,
            host_token: ids::new_host_token(),
            lifecycle: Lifecycle::Running,
            agent_session_id: None,
            resume_precision: ResumePrecision::Unavailable,
            log_path: paths.log_path(&session_id).to_string_lossy().into_owned(),
            adapter_type: AgentType::Shell,
            transport: AgentTransport::Pty,
            command: vec!["/bin/sh".into()],
            permission_mode: PermissionMode::Native,
            created_at: now,
            updated_at: now,
            pinned_at: None,
            archived_at: None,
        })
        .unwrap();
        session_id
    }

    fn bind_attachment_test_host(paths: &AppPaths, db: &Db, session_id: &str) -> HostIdentity {
        let run = db.create_session_run(session_id, &ids::new_uuid()).unwrap();
        let log_path = paths.run_log_path(session_id, &run.run_id);
        db.claim_session_run(
            session_id,
            &run.run_id,
            run.run_ordinal,
            &log_path.to_string_lossy(),
        )
        .unwrap();
        assert!(db
            .bind_session_host_for_run(
                session_id,
                &run.run_id,
                run.run_ordinal,
                42,
                "/tmp/renderer-boundary.sock",
            )
            .unwrap());
        HostIdentity {
            host_pid: 42,
            protocol: agentport_core::protocol::PROTOCOL_VERSION,
            run_id: run.run_id,
            run_ordinal: run.run_ordinal,
        }
    }

    #[test]
    fn session_view_exposes_only_bound_live_hosts_as_alive() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let session_id = insert_attachment_test_session(&paths, &db);

        let unbound = db.get_session(&session_id).unwrap();
        let unbound_value = serde_json::to_value(session_view(&db, &unbound, None)).unwrap();
        assert_eq!(unbound_value["hostAlive"], false);

        db.update_session_host(
            &session_id,
            Some(std::process::id() as i64),
            Some("/tmp/session-view-live.sock"),
        )
        .unwrap();
        let bound = db.get_session(&session_id).unwrap();
        let bound_value = serde_json::to_value(session_view(&db, &bound, None)).unwrap();
        assert_eq!(bound_value["hostAlive"], true);

        db.update_session_lifecycle(&session_id, Lifecycle::Stopped)
            .unwrap();
        let stopped = db.get_session(&session_id).unwrap();
        let stopped_value = serde_json::to_value(session_view(&db, &stopped, None)).unwrap();
        assert_eq!(stopped_value["hostAlive"], false);
    }

    #[test]
    fn migrated_session_accepts_v2_host_with_legacy_run_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let session_id = insert_attachment_test_session(&paths, &db);
        db.update_session_host(&session_id, Some(4242), Some("/tmp/attachment.sock"))
            .unwrap();

        let host = HostIdentity {
            host_pid: 4242,
            protocol: agentport_core::protocol::PROTOCOL_VERSION,
            run_id: agentport_core::models::LEGACY_RUN_ID.into(),
            run_ordinal: agentport_core::models::LEGACY_RUN_ORDINAL,
        };

        assert!(host_identity_is_current(&db, &session_id, &host));
    }

    #[test]
    fn legacy_host_can_attach_to_a_current_run_when_pid_matches() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let session_id = insert_attachment_test_session(&paths, &db);
        let run = db
            .create_session_run(&session_id, &ids::new_uuid())
            .unwrap();
        let log_path = paths.run_log_path(&session_id, &run.run_id);
        db.claim_session_run(
            &session_id,
            &run.run_id,
            run.run_ordinal,
            &log_path.to_string_lossy(),
        )
        .unwrap();
        assert!(db
            .bind_session_host_for_run(
                &session_id,
                &run.run_id,
                run.run_ordinal,
                4242,
                "/tmp/attachment.sock",
            )
            .unwrap());

        let host = HostIdentity {
            host_pid: 4242,
            protocol: agentport_core::protocol::LEGACY_PROTOCOL_VERSION,
            run_id: agentport_core::models::LEGACY_RUN_ID.into(),
            run_ordinal: agentport_core::models::LEGACY_RUN_ORDINAL,
        };

        assert!(host_identity_is_current(&db, &session_id, &host));
    }

    #[test]
    fn cleanup_targets_only_a_single_session_component() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        paths.ensure_layout().unwrap();
        let (session_dir, socket_path) = cleanup_session_paths(&paths, "ses_safe-1").unwrap();
        assert_eq!(session_dir, paths.sessions_dir().join("ses_safe-1"));
        let outside = temp.path().join("outside-kept");
        std::fs::write(&outside, "keep").unwrap();
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("output.log"), "remove").unwrap();
        remove_cleanup_paths(&session_dir, &socket_path).unwrap();
        assert!(!session_dir.exists());
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "keep");
        for invalid in ["", "../outside", "/tmp/outside", "ses/child", "ses.safe"] {
            assert!(cleanup_session_paths(&paths, invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn due_cleanup_job_removes_session_files_and_is_acknowledged() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let project_id = ids::new_id("prj_cleanup");
        db.add_project(&Project {
            id: project_id.clone(),
            name: "cleanup test".into(),
            root_path: temp.path().to_string_lossy().into_owned(),
            git_root_path: None,
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
        let session_id = ids::new_id("ses_cleanup");
        let now = Utc::now();
        db.insert_session(&Session {
            id: session_id.clone(),
            project_id,
            worktree_id: None,
            preset_id: "pre_shell_safe".into(),
            title: "cleanup test".into(),
            cwd: temp.path().to_string_lossy().into_owned(),
            host_pid: None,
            host_socket: None,
            host_token: ids::new_host_token(),
            lifecycle: Lifecycle::Stopped,
            agent_session_id: None,
            resume_precision: ResumePrecision::Unavailable,
            log_path: paths.log_path(&session_id).to_string_lossy().into_owned(),
            adapter_type: AgentType::Shell,
            transport: AgentTransport::Pty,
            command: vec!["/bin/sh".into()],
            permission_mode: PermissionMode::Native,
            created_at: now,
            updated_at: now,
            pinned_at: None,
            archived_at: None,
        })
        .unwrap();
        let session_dir = paths.session_dir(&session_id);
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("output.log"), "remove").unwrap();
        db.archive_session(&session_id).unwrap();
        db.purge_archived_session(&session_id).unwrap();

        assert_eq!(run_due_cleanup_jobs(&paths, &db), 1);
        assert!(!session_dir.exists());
        assert!(db.list_due_cleanup_jobs(Utc::now()).unwrap().is_empty());
    }

    #[test]
    fn purged_session_native_artifacts_are_removed_after_commit() {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let db = Db::open(&paths).unwrap();
        let project_id = ids::new_id("prj_native_cleanup");
        db.add_project(&Project {
            id: project_id.clone(),
            name: "native cleanup test".into(),
            root_path: temp.path().to_string_lossy().into_owned(),
            git_root_path: None,
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
        let session_id = ids::new_id("ses_native_cleanup");
        let now = Utc::now();
        let cwd = temp.path().join("workspace").to_string_lossy().into_owned();
        db.insert_session(&Session {
            id: session_id.clone(),
            project_id,
            worktree_id: None,
            preset_id: "pre_claude_safe".into(),
            title: "native cleanup test".into(),
            cwd: cwd.clone(),
            host_pid: None,
            host_socket: None,
            host_token: ids::new_host_token(),
            lifecycle: Lifecycle::Stopped,
            agent_session_id: Some("native-id-1".into()),
            resume_precision: ResumePrecision::Exact,
            log_path: paths.log_path(&session_id).to_string_lossy().into_owned(),
            adapter_type: AgentType::Claude,
            transport: AgentTransport::Pty,
            command: vec!["claude".into()],
            permission_mode: PermissionMode::Native,
            created_at: now,
            updated_at: now,
            pinned_at: None,
            archived_at: None,
        })
        .unwrap();
        let claude_home = temp.path().join("claude");
        let project_dir = claude_home
            .join("projects")
            .join(agentport_core::history::cwd_slug(&cwd));
        std::fs::create_dir_all(&project_dir).unwrap();
        let native_file = project_dir.join("native-id-1.jsonl");
        let other_file = project_dir.join("another-session.jsonl");
        std::fs::write(&native_file, "{}\n").unwrap();
        std::fs::write(&other_file, "{}\n").unwrap();

        db.archive_session(&session_id).unwrap();
        // Mirror the command flow: plan before purge (evidence intact),
        // purge, then execute the native cleanup after commit.
        let session = db.get_session(&session_id).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", &claude_home);
        let plan = plan_native_cleanup(&paths, &session);
        db.purge_archived_session(&session_id).unwrap();
        let outcome = execute_native_cleanup(&plan);
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        assert_eq!(outcome.deleted, 1);
        assert!(!outcome.has_failures());
        assert!(!native_file.exists());
        assert!(other_file.exists(), "another session's file must survive");
        assert!(db.get_session(&session_id).is_err());
    }

    #[test]
    fn stale_attachment_id_cannot_remove_a_newer_writer() {
        let attachments: AttachmentMap = Arc::new(Mutex::new(HashMap::new()));
        replace_attachment(&attachments, "ses_1".into(), test_attachment(1));
        let displaced = replace_attachment(&attachments, "ses_1".into(), test_attachment(2));
        assert_eq!(displaced.unwrap().id, 1);

        // The delayed detach from generation 1 is a no-op. Only the current
        // server-issued capability can remove generation 2.
        assert!(take_attachment_if_current(&attachments, "ses_1", 1).is_none());
        assert_eq!(
            take_attachment_if_current(&attachments, "ses_1", 2)
                .expect("current attachment")
                .id,
            2
        );
    }

    #[test]
    fn renderer_cursor_is_attachment_scoped_and_monotonic() {
        let attachments: AttachmentMap = Arc::new(Mutex::new(HashMap::new()));
        replace_attachment(&attachments, "ses_1".into(), test_attachment(7));
        let cursor = LogCursor {
            run_id: "run_test".into(),
            run_ordinal: 1,
            generation: 0,
            offset: 100,
        };
        record_renderer_log_cursor(&attachments, "ses_1", 7, &cursor).unwrap();
        record_renderer_log_cursor(
            &attachments,
            "ses_1",
            7,
            &LogCursor {
                offset: 50,
                ..cursor.clone()
            },
        )
        .unwrap();
        assert_eq!(
            attachments
                .lock()
                .unwrap()
                .get("ses_1")
                .unwrap()
                .rendered_log_cursor
                .as_ref()
                .unwrap()
                .offset,
            100
        );
        assert!(record_renderer_log_cursor(&attachments, "ses_1", 6, &cursor).is_err());
    }

    #[test]
    fn exit_boundary_uses_renderer_cursor_and_preserves_first_unread() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let session_id = insert_attachment_test_session(&paths, &db);
        let host = bind_attachment_test_host(&paths, &db, &session_id);
        let latest = LogCursor {
            run_id: host.run_id.clone(),
            run_ordinal: host.run_ordinal,
            generation: 0,
            offset: 200,
        };
        db.set_latest_log_cursor(&session_id, &latest).unwrap();
        let first_unread = LogCursor {
            offset: 50,
            ..latest.clone()
        };
        db.mark_output_unread_at(&session_id, &first_unread)
            .unwrap();

        let renderer = LogCursor {
            offset: 100,
            ..latest
        };
        persist_renderer_recovery_boundary(&db, &session_id, &host, &renderer);

        assert_eq!(
            db.get_unread_log_cursor(&session_id).unwrap(),
            Some(first_unread)
        );
        assert!(has_unread_output(&db, &session_id));
    }

    #[test]
    fn equal_renderer_boundary_is_not_reported_as_unread() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let session_id = insert_attachment_test_session(&paths, &db);
        let host = bind_attachment_test_host(&paths, &db, &session_id);
        let renderer = LogCursor {
            run_id: host.run_id.clone(),
            run_ordinal: host.run_ordinal,
            generation: 0,
            offset: 100,
        };
        db.set_latest_log_cursor(&session_id, &renderer).unwrap();

        persist_renderer_recovery_boundary(&db, &session_id, &host, &renderer);

        assert_eq!(
            db.get_unread_log_cursor(&session_id).unwrap(),
            Some(renderer)
        );
        assert!(!has_unread_output(&db, &session_id));
    }

    #[test]
    fn sidebar_unread_badge_ignores_terminal_output_without_attention() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let session_id = insert_attachment_test_session(&paths, &db);
        let session = db.get_session(&session_id).unwrap();

        // Output is retained as a recovery cursor, but it is not itself an
        // unread user message and must not light up the sidebar badge.
        db.mark_output_unread(&session_id, 42).unwrap();
        let view = session_view(&db, &session, None);
        assert!(!view.unread);
    }

    #[test]
    fn sidebar_unread_badge_tracks_semantic_completion_and_approval() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let session_id = insert_attachment_test_session(&paths, &db);
        let session = db.get_session(&session_id).unwrap();
        let event = |sequence, state, source, evidence: &str| StatusEvent {
            session_id: session_id.clone(),
            run_id: agentport_core::models::LEGACY_RUN_ID.into(),
            run_ordinal: agentport_core::models::LEGACY_RUN_ORDINAL,
            sequence,
            state,
            source,
            confidence: Confidence::High,
            evidence: Some(evidence.into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        };

        db.record_status_event(&event(
            1,
            AgentState::Idle,
            StateSource::Adapter,
            "adapter:kimi:TurnEnd",
        ))
        .unwrap();
        assert!(session_view(&db, &session, None).unread);
        assert!(session_view(&db, &session, Some(&session_id)).unread);

        db.mark_session_seen(&session_id).unwrap();
        db.record_status_event(&event(
            2,
            AgentState::Idle,
            StateSource::Adapter,
            "adapter:pi:TurnEnd",
        ))
        .unwrap();
        assert!(session_view(&db, &session, None).unread);

        db.mark_session_seen(&session_id).unwrap();
        db.record_status_event(&event(
            3,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:PermissionRequest",
        ))
        .unwrap();
        assert!(session_view(&db, &session, None).unread);

        db.mark_session_seen(&session_id).unwrap();
        db.record_status_event(&event(
            4,
            AgentState::NeedsInput,
            StateSource::Pty,
            "pty:pattern:permission",
        ))
        .unwrap();
        assert!(session_view(&db, &session, None).unread);
    }

    #[test]
    fn replay_done_channel_preserves_partial_recovery_context_flag() {
        let cursor = LogCursor {
            run_id: "run_1".into(),
            run_ordinal: 1,
            generation: 2,
            offset: 123,
        };
        let value = replay_done_value(123, &cursor, true);
        assert_eq!(value["t"], "replay_done");
        assert_eq!(value["partialContext"], true);
        assert_eq!(value["cursor"]["generation"], 2);
    }

    #[test]
    #[cfg(unix)]
    fn terminal_launcher_rejects_nonzero_exit_status() {
        let temp = tempfile::tempdir().unwrap();
        let error = launch_terminal("/usr/bin/false", &[], &temp.path().to_string_lossy())
            .expect_err("a terminal command that exits nonzero must not report success");
        assert!(error.contains("exited with"), "{error}");
    }

    #[test]
    fn generic_x_terminal_emulator_relies_on_inherited_current_dir() {
        assert!(fallback_terminal_args("x-terminal-emulator", "/tmp/project").is_empty());
        assert_eq!(
            fallback_terminal_args("gnome-terminal", "/tmp/project"),
            ["--working-directory", "/tmp/project"]
        );
        assert_eq!(
            fallback_terminal_args("konsole", "/tmp/project"),
            ["--workdir", "/tmp/project"]
        );
    }
}
