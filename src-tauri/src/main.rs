//! AgentPort GUI shell (Tauri 2). The GUI is a reconnectable client only —
//! it never owns agent processes (PRD ch.6). Commands delegate to
//! agentport-core; PTY output streams to the frontend via tauri Channels.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use agentport_core::adapters::{self, capability, LaunchContext, ResumeContext};
use agentport_core::db::Db;
use agentport_core::diag::Diagnostics;
use agentport_core::error::{CoreError, Result};
use agentport_core::export::{AnsiMode, Exporter, LogRange, MdBlocks};
use agentport_core::git::{
    GitRunner, RepositoryFileLock, RepositoryIdentity, WorktreeBranchSelection, WorktreeManager,
};
use agentport_core::host_manager::{
    write_private_file, AttachInfo, HostClient, HostManager, LaunchSpec,
};
use agentport_core::ids;
use agentport_core::models::*;
use agentport_core::notify::{
    notification_for_state_change, test_notification, Notification, Notifier,
};
use agentport_core::paths::{normalize_abs, AppPaths};
use agentport_core::protocol::{normalize_host_frame, HostFrame};
use agentport_core::search::SearchIndex;
use agentport_core::secrets::{load_preset_secrets, CredentialBroker, SecretValue};
use agentport_core::timeline::{RecoveryAckSnapshot, Timeline};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

mod git_commands;
mod notifications;

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
    notification_tx: SyncSender<Notification>,
    /// Status notifications may arrive through both the durable monitor and
    /// an attached renderer. Deduplicate by the immutable run/sequence key.
    notified_statuses: Mutex<HashSet<String>>,
}

type HostWriter = Arc<Mutex<std::os::unix::net::UnixStream>>;
type AttachmentMap = Arc<Mutex<HashMap<String, RendererAttachment>>>;

const NOTIFICATION_QUEUE_CAPACITY: usize = 64;

fn start_notification_worker() -> SyncSender<Notification> {
    let (tx, rx) = mpsc::sync_channel::<Notification>(NOTIFICATION_QUEUE_CAPACITY);
    let spawned = std::thread::Builder::new()
        .name("agentport-notifications".into())
        .spawn(move || {
            while let Ok(notification) = rx.recv() {
                if let Err(error) = notifications::send(&notification) {
                    tracing::warn!(error = %error, "system notification failed");
                }
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(error = %error, "could not start system notification worker");
    }
    tx
}

fn notify_status_once(app: &AppHandle, db: &Db, event: &StatusEvent) {
    if !matches!(event.state, AgentState::NeedsInput | AgentState::Exited) {
        return;
    }
    let state = app.state::<AppState>();
    let key = format!(
        "{}:{}:{}:{}",
        event.session_id, event.run_id, event.run_ordinal, event.sequence
    );
    {
        let mut notified = state.notified_statuses.lock().unwrap();
        if notified.len() >= 4096 {
            notified.clear();
        }
        if !notified.insert(key) {
            return;
        }
    }
    let title = db
        .get_session(&event.session_id)
        .map(|session| session.title)
        .unwrap_or_else(|_| event.session_id.clone());
    let (enabled, language) = {
        let notifier = state.notifier.lock().unwrap();
        (notifier.enabled(), notifier.language())
    };
    if !enabled {
        return;
    }
    if let Some(notification) = notification_for_state_change(language, &title, event) {
        match state.notification_tx.try_send(notification) {
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
    agent_session_id: Option<String>,
    resume_precision: String,
    permission_mode: String,
    transport: String,
    log_path: String,
    unread: bool,
    status: Option<Value>,
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

fn session_view(db: &Db, s: &Session, active_session: Option<&str>) -> SessionView {
    let latest = db.latest_status(&s.id).ok().flatten();
    let unread = if Some(s.id.as_str()) == active_session {
        false
    } else {
        db.get_recovery_summary(&s.id)
            .map(|r| {
                has_unread_output(db, &s.id)
                    || db
                        .has_unread_attention(&s.id, r.last_seen_sequence)
                        .unwrap_or(false)
            })
            .unwrap_or(false)
    };
    SessionView {
        id: s.id.clone(),
        project_id: s.project_id.clone(),
        worktree_id: s.worktree_id.clone(),
        title: s.title.clone(),
        adapter: s.adapter_type.as_str().into(),
        cwd: s.cwd.clone(),
        lifecycle: s.lifecycle.as_str().into(),
        agent_session_id: s.agent_session_id.clone(),
        resume_precision: s.resume_precision.as_str().into(),
        permission_mode: s.permission_mode.as_str().into(),
        transport: s.transport.as_str().into(),
        log_path: s.log_path.clone(),
        unread,
        status: latest.as_ref().map(status_value),
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

fn collect_projects(db: &Db, active: Option<&str>) -> Vec<ProjectView> {
    let mut out = vec![];
    if let Ok(projects) = db.list_projects() {
        for p in projects {
            let sessions = db
                .list_sessions(Some(&p.id), false)
                .unwrap_or_default()
                .iter()
                .map(|s| session_view(db, s, active))
                .collect();
            let worktrees = db
                .list_worktrees(&p.id)
                .unwrap_or_default()
                .iter()
                .map(worktree_view)
                .collect();
            out.push(ProjectView {
                id: p.id,
                name: p.name,
                root_path: p.root_path,
                git_root_path: p.git_root_path,
                sessions,
                worktrees,
            });
        }
    }
    out
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
            Ok((session_dir, socket_path)) => {
                let index = SearchIndex { db, paths };
                let session_ids = vec![session_id.clone()];
                if index.remove_sessions(&session_ids).is_err() {
                    Err("remove_search_index_failed")
                } else {
                    remove_cleanup_paths(&session_dir, &socket_path)
                }
            }
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
    let mgr = HostManager {
        paths: &state.paths,
        db: &state.db,
    };
    let _ = mgr.reconcile_on_startup();
    let _ = run_due_cleanup_jobs(&state.paths, &state.db);
    ensure_cleanup_scheduler(&state);
    ensure_live_session_monitors(&app, &state);
    if !state.branch_reconcile_started.swap(true, Ordering::AcqRel) {
        git_commands::spawn_startup_reconcile(app.clone(), state.paths.clone());
    }
    let idx = SearchIndex {
        db: &state.db,
        paths: &state.paths,
    };
    let _ = idx.open();
    let index_state = idx
        .index_state()
        .map(|s| format!("{s:?}").to_lowercase())
        .unwrap_or_else(|_| "unknown".into());
    let tl = Timeline { db: &state.db };
    let timeline = tl.build().map(|t| {
        json!({
            "completed": t.completed, "waiting": t.waiting, "failed": t.failed,
            "entries": t.entries, "ackSnapshots": t.ack_snapshots,
        })
    });
    let diag = Diagnostics {
        paths: &state.paths,
        db: &state.db,
    };
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
    Ok(BootInfo {
        platform: json!(diag.platform_info()),
        settings: map_err!(state.db.load_settings())?,
        adapters: map_err!(state.db.list_adapters())?,
        projects: collect_projects(&state.db, None),
        timeline,
        timeline_error,
        timeline_message,
        secret_backend: format!("{:?}", CredentialBroker::backend_status()),
        index_state,
        webview: "system".into(),
        exports_dir: state.paths.exports_dir().to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn list_projects(
    state: State<'_, AppState>,
    active_session: Option<String>,
) -> std::result::Result<Vec<ProjectView>, String> {
    Ok(collect_projects(&state.db, active_session.as_deref()))
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

#[tauri::command]
async fn probe_agents(state: State<'_, AppState>) -> std::result::Result<Vec<Value>, String> {
    let mut out = vec![];
    for o in capability::probe_all() {
        let t = o.agent_type;
        if let Some(i) = &o.install {
            let _ = state.db.upsert_adapter(i);
        }
        out.push(probe_outcome_json(t, &o));
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
    Ok(probe_outcome_json(t, &o))
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

fn launch_notice_values(agent: AgentType, notices: &[adapters::LaunchNotice]) -> Vec<Value> {
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

// ---------------------------------------------------------------------------
// Projects / presets
// ---------------------------------------------------------------------------

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
async fn remove_project(state: State<'_, AppState>, id: String) -> std::result::Result<(), String> {
    map_err!(state.db.remove_project(&id))
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

fn install_for(state: &AppState, t: AgentType) -> Result<AdapterInstall> {
    if let Some(i) = state.db.get_adapter(t)? {
        // Cached path may be stale (e.g. Homebrew removed the versioned
        // Caskroom dir after an upgrade). Re-probe instead of spawning a
        // missing binary.
        if !std::path::Path::new(&i.executable_path).exists() {
            let o = capability::probe_agent(t, None);
            return match o.install {
                Some(fresh) => {
                    state.db.upsert_adapter(&fresh)?;
                    Ok(fresh)
                }
                None => Err(CoreError::Adapter(format!(
                    "{} executable is no longer valid ({}), and re-probing found no replacement: {}",
                    t.display_name(),
                    i.executable_path,
                    o.reason.unwrap_or_else(|| "not found".into())
                ))),
            };
        }
        return Ok(i);
    }
    let o = capability::probe_agent(t, None);
    match o.install {
        Some(i) => {
            state.db.upsert_adapter(&i)?;
            Ok(i)
        }
        None => Err(CoreError::Adapter(format!(
            "{} not available: {}",
            t.display_name(),
            o.reason.unwrap_or_else(|| "not found".into())
        ))),
    }
}

fn preset_for(
    state: &AppState,
    t: AgentType,
    preset_id: Option<String>,
    install: &AdapterInstall,
) -> Result<Preset> {
    let mut p = match preset_id {
        Some(id) => state.db.get_preset(&id)?,
        None => state
            .db
            .get_preset(&format!("pre_{}_safe", t.as_str()))
            .unwrap_or(Preset {
                id: format!("pre_{}_safe", t.as_str()),
                agent_type: t,
                name: match t {
                    AgentType::Qoder => "Qoder 全权限默认".into(),
                    AgentType::Pi => "Pi 本地权限默认".into(),
                    _ => format!("{} 安全默认", t.display_name()),
                },
                executable_path: String::new(),
                args: vec![],
                permission_mode: t.default_permission_mode(),
                env_names: vec![],
                secret_ref_ids: vec![],
                built_in: true,
            }),
    };
    if p.agent_type != t {
        return Err(CoreError::Validation(format!(
            "preset {} is for {}",
            p.id,
            p.agent_type.as_str()
        )));
    }
    if p.executable_path.is_empty() {
        p.executable_path = install.executable_path.clone();
    }
    Ok(p)
}

/// Materialize the launch environment before creating any persistent Session
/// state.  A credential-store failure must not leave a `Creating` row or
/// helper file behind; create and restart intentionally share this exact
/// path so their environment semantics cannot drift.
type MaterializedLaunchEnvironment = (Vec<(String, String)>, Vec<(String, SecretValue)>);

fn materialize_launch_environment(
    state: &AppState,
    preset: &Preset,
    plan_env: &[(String, String)],
) -> Result<MaterializedLaunchEnvironment> {
    let mut env = plan_env.to_vec();
    for name in &preset.env_names {
        if let Ok(value) = std::env::var(name) {
            env.push((name.clone(), value));
        }
    }

    let refs: Vec<SecretRef> = preset
        .secret_ref_ids
        .iter()
        .map(|id| state.db.get_secret_ref(id))
        .collect::<Result<Vec<_>>>()?;
    let secrets = if refs.is_empty() {
        Vec::new()
    } else {
        let broker = CredentialBroker::detect()?;
        load_preset_secrets(&broker, &refs)?
    };
    Ok((env, secrets))
}

/// Write session-private adapter helpers as an all-or-nothing pre-launch
/// operation.  The paths originate from the adapter plan and are scoped to
/// the new Session directory; on a partial failure, remove only helpers we
/// wrote during this attempt.
fn write_launch_helpers(helper_files: &[(String, String)]) -> Result<()> {
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

/// Build the LaunchPlan for a (not yet created) session — used both by the
/// preflight panel and by actual creation.
#[allow(clippy::too_many_arguments)]
fn build_launch_plan(
    state: &AppState,
    project_id: &str,
    agent: AgentType,
    preset_id: Option<String>,
    worktree_id: Option<String>,
    permission: PermissionMode,
    transport: AgentTransport,
    extra_args: Option<Vec<String>>,
) -> Result<(adapters::LaunchPlan, Preset, String, Option<String>)> {
    if transport != AgentTransport::Pty {
        return Err(CoreError::Validation(format!(
            "{} Session creation supports only the native PTY transport",
            agent.display_name()
        )));
    }
    let project = state.db.get_project(project_id)?;
    let install = install_for(state, agent)?;
    let preset = preset_for(state, agent, preset_id, &install)?;
    adapters::validate_user_args(agent, &preset.args)?;
    let cwd = match &worktree_id {
        Some(w) => state.db.get_worktree(w)?.path,
        None => project.root_path,
    };
    let session_id = ids::new_id("ses");
    let session_dir = state.paths.session_dir(&session_id);
    std::fs::create_dir_all(&session_dir)?;
    let ctx = LaunchContext {
        install,
        preset: preset.clone(),
        cwd: cwd.clone(),
        session_id: session_id.clone(),
        hook_events_path: state
            .paths
            .hook_events_path(&session_id)
            .to_string_lossy()
            .into_owned(),
        session_dir: session_dir.to_string_lossy().into_owned(),
        transport,
    };
    let plan = adapters::adapter_for(agent).build_launch(&ctx)?;
    let mut plan = if permission != PermissionMode::Native {
        // Re-derive the permission argv through the capability gate (adapters
        // embed native defaults; auto/bypass flags come from the preset's mode).
        let mut p2 = preset.clone();
        p2.permission_mode = permission;
        let ctx2 = LaunchContext { preset: p2, ..ctx };
        adapters::adapter_for(agent).build_launch(&ctx2)?
    } else {
        plan
    };
    // Ad-hoc CLI args from the UI (PRD 3.2 参数框): appended as argv array
    // items only — never shell-concatenated.
    if let Some(extra) = extra_args {
        for a in &extra {
            if a.is_empty() {
                return Err(CoreError::Validation("empty extra arg".into()));
            }
        }
        adapters::validate_user_args(agent, &extra)?;
        plan.argv.extend(extra);
    }
    Ok((plan, preset, cwd, Some(session_id)))
}

fn parse_permission(s: &str) -> Result<PermissionMode> {
    match s {
        "native" => Ok(PermissionMode::Native),
        "auto" => Ok(PermissionMode::Auto),
        "bypass" => Ok(PermissionMode::Bypass),
        other => Err(CoreError::Validation(format!("bad permission {other}"))),
    }
}

fn parse_transport(s: &str) -> Result<AgentTransport> {
    s.parse()
}

/// Qoder's only supported AgentPort mode is its documented full-access flag.
/// It is a fixed product decision rather than an opt-in per-session risk gate;
/// existing Agents keep the historical acknowledgement rule.
fn permission_requires_risk_ack(agent: AgentType, mode: PermissionMode) -> bool {
    mode != PermissionMode::Native && agent != AgentType::Qoder
}

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
    let t: AgentType = map_err!(agent.parse::<AgentType>())?;
    let mode = t.effective_permission_mode(map_err!(parse_permission(&permission))?);
    if permission_requires_risk_ack(t, mode) && !risk_ack {
        return Err("NEEDS_RISK_ACK".into());
    }
    let transport = match transport {
        Some(value) => map_err!(parse_transport(&value))?,
        None => t.default_transport(),
    };
    let project = map_err!(state.db.get_project(&project_id))?;
    let (plan, preset, cwd, session_id) = map_err!(build_launch_plan(
        &state,
        &project_id,
        t,
        preset_id,
        worktree_id.clone(),
        mode,
        transport,
        extra_args
    ))?;
    let session_id = session_id.unwrap();
    // Reserve the checkout as soon as launch planning has resolved its cwd.
    // Branch mutation takes the same common-dir lock and rechecks Creating /
    // Running rows immediately before switch, so the user's create request
    // cannot silently cross a concurrent branch transition while secrets or
    // helper files are being prepared.
    let lock_cwd = cwd.clone();
    let repository_lock = match tauri::async_runtime::spawn_blocking(move || {
        acquire_session_repository_lock(&lock_cwd)
    })
    .await
    {
        Ok(Ok(lock)) => lock,
        Ok(Err(error)) => {
            let _ = std::fs::remove_dir_all(state.paths.session_dir(&session_id));
            return Err(error.to_string());
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(state.paths.session_dir(&session_id));
            return Err(format!("repository lock worker failed: {error}"));
        }
    };
    // Materialize every dependency that can fail before inserting a Session
    // row or writing adapter helpers.  The launch plan creates a private
    // directory for its paths, so clean that empty directory on a pre-launch
    // failure as well.
    let (env, secrets) = match materialize_launch_environment(&state, &preset, &plan.env) {
        Ok(materialized) => materialized,
        Err(error) => {
            let _ = std::fs::remove_dir_all(state.paths.session_dir(&session_id));
            return Err(error.to_string());
        }
    };
    let settings = match state.db.load_settings() {
        Ok(settings) => settings,
        Err(error) => {
            let _ = std::fs::remove_dir_all(state.paths.session_dir(&session_id));
            return Err(error.to_string());
        }
    };
    let (title, auto_title_pending) = match title.map(|value| value.trim().to_string()) {
        Some(value) if !value.is_empty() => (value, false),
        _ => match state.db.next_default_session_title(&project.id, t) {
            Ok(title) => (title, true),
            Err(error) => {
                let _ = std::fs::remove_dir_all(state.paths.session_dir(&session_id));
                return Err(error.to_string());
            }
        },
    };
    if let Err(error) = write_launch_helpers(&plan.helper_files) {
        let _ = std::fs::remove_dir_all(state.paths.session_dir(&session_id));
        return Err(error.to_string());
    }
    let now = Utc::now();
    let session = Session {
        id: session_id.clone(),
        project_id: project.id.clone(),
        worktree_id: worktree_id.clone(),
        preset_id: preset.id.clone(),
        title,
        cwd: cwd.clone(),
        host_pid: None,
        host_socket: Some(
            state
                .paths
                .socket_path(&session_id)
                .to_string_lossy()
                .into_owned(),
        ),
        host_token: ids::new_host_token(),
        lifecycle: Lifecycle::Creating,
        agent_session_id: plan.assigned_agent_session_id.clone(),
        resume_precision: if plan.assigned_agent_session_id.is_some() {
            ResumePrecision::Exact
        } else {
            plan.resume_precision
        },
        log_path: state
            .paths
            .log_path(&session_id)
            .to_string_lossy()
            .into_owned(),
        adapter_type: t,
        transport: plan.transport,
        command: plan.argv.clone(),
        permission_mode: mode,
        created_at: now,
        updated_at: now,
        archived_at: None,
    };
    // Inserting Creating while still holding the checkout reservation makes
    // the Session row and branch manager's final live-session check atomic.
    if let Err(error) = state.db.insert_session(&session) {
        remove_launch_helpers(&plan.helper_files);
        let _ = std::fs::remove_dir_all(state.paths.session_dir(&session_id));
        return Err(error.to_string());
    }
    drop(repository_lock);
    // Keep the marker separate from the Session schema. It is consumed only
    // after the first successfully submitted terminal input, so a custom
    // title supplied at creation is never overwritten.  It is created only
    // after the Session row exists, avoiding an orphan app_meta key.
    if auto_title_pending {
        if let Err(error) = state.db.mark_session_title_auto_generated(&session_id) {
            let _ = state
                .db
                .update_session_lifecycle(&session_id, Lifecycle::Exited);
            remove_launch_helpers(&plan.helper_files);
            return Err(error.to_string());
        }
    }
    let mgr = HostManager {
        paths: &state.paths,
        db: &state.db,
    };
    let info = match mgr.launch(LaunchSpec {
        session: session.clone(),
        command: plan.argv.clone(),
        env,
        secrets,
        log_limit_bytes: settings.log_limit_mib * 1024 * 1024,
        agent_session_id_hint: plan.assigned_agent_session_id.clone(),
        cols: cols.unwrap_or(120),
        rows: rows.unwrap_or(32),
    }) {
        Ok(info) => info,
        Err(error) => {
            remove_launch_helpers(&plan.helper_files);
            return Err(error.to_string());
        }
    };
    ensure_session_monitor(&app, &state, &session);
    emit_sessions_changed(&app, &state, Some(&session_id));
    let notices = launch_notice_values(t, &plan.notices);
    let notes = plan
        .notices
        .iter()
        .map(|notice| notice.legacy_message.as_str())
        .collect::<Vec<_>>();
    Ok(json!({
        "id": session_id,
        "attach": {
            "hostPid": info.host_pid,
            "childAlive": info.child_alive,
        },
        "resumePrecision": session.resume_precision.as_str(),
        "agentSessionId": session.agent_session_id,
        "notes": notes,
        "notices": notices,
        "command": plan.argv,
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

fn project_monitor_status(app: &AppHandle, db: &Db, event: &StatusEvent) {
    if let Err(error) = db.record_status_event(event) {
        tracing::error!(session = %event.session_id, error = %error, "session monitor projection write failed");
    }
    let _ = app.emit("session-state", status_value(event));
    notify_status_once(app, db, event);
}

/// Keep status truth alive independently of the renderer LRU. Each monitor
/// requests no output bytes, owns one verified socket, and retries boundedly
/// after an unexpected EOF. The Host journal remains the source of truth when
/// the GUI itself is closed.
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
        const RETRIES: usize = 5;
        let mut terminal = false;
        for attempt in 0..=RETRIES {
            if !monitor_is_current(&monitors, &session_id, monitor_id) {
                return;
            }
            let session = match db.get_session(&session_id) {
                Ok(session) if live_session(session.lifecycle) => session,
                _ => {
                    terminal = true;
                    break;
                }
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
                if attempt < RETRIES {
                    std::thread::sleep(Duration::from_millis(250 * (1_u64 << attempt)));
                    continue;
                }
                break;
            };
            let host = HostIdentity::from_attach(&info);
            if !host_identity_is_current(&db, &session_id, &host) {
                // A restart may have reserved/published a new run while this
                // monitor was connecting. Do not project the old connection;
                // retry against the durable Session row instead.
                tracing::debug!(session = %session_id, host_pid = host.host_pid, "monitor handshake belongs to a superseded Host");
                if attempt < RETRIES {
                    std::thread::sleep(Duration::from_millis(250 * (1_u64 << attempt)));
                    continue;
                }
                break;
            }
            if let Err(error) = db.set_latest_log_cursor(&session_id, &info.log_cursor) {
                tracing::warn!(session = %session_id, error = %error, "monitor could not persist Host log cursor");
            }
            if let Some(event) = info.current_status.as_ref() {
                if host.matches_run(&event.run_id, event.run_ordinal) {
                    project_monitor_status(&app, &db, event);
                } else {
                    tracing::warn!(session = %session_id, host_pid = host.host_pid, "monitor hello snapshot has the wrong run identity");
                    if attempt < RETRIES {
                        std::thread::sleep(Duration::from_millis(250 * (1_u64 << attempt)));
                        continue;
                    }
                    break;
                }
            } else if info.protocol == agentport_core::protocol::LEGACY_PROTOCOL_VERSION {
                let _ = client.request_status();
            }
            loop {
                let frame = match client.read_frame() {
                    Ok(Some(frame)) => frame,
                    Ok(None) | Err(_) => break,
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
                            json!({"sessionId": session_id, "reason": reason}),
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
            if attempt < RETRIES {
                std::thread::sleep(Duration::from_millis(250 * (1_u64 << attempt)));
            }
        }
        if !terminal && monitor_is_current(&monitors, &session_id, monitor_id) {
            // A lost status-only socket is transport evidence only. The Host
            // reaper/reconciliation owns `Interrupted`; guessing here would
            // turn a transient GUI-side outage into a false terminal state.
            tracing::warn!(session = %session_id, retries = RETRIES, "session monitor retry budget exhausted; lifecycle left unchanged");
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
    recovery_target: Option<LogCursor>,
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
    let (mut client, info) = HostClient::connect_with_recovery_target(
        &socket,
        &session_id,
        &token,
        replay_tail_bytes.min(MAX_REPLAY_BYTES),
        resume_from,
        recovery_target,
        true,
    )
    .map_err(|error| runtime_command_error_from_core(error, "host_connection_failed"))?;
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
        if let Err(error) = state.db.record_status_event(status) {
            tracing::error!(session = %session_id, error = %error, "attach status snapshot was not persisted");
        }
        let _ = app.emit("session-state", status_value(status));
    }
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
        );
    });
    Ok(json!({
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
    }))
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
                    HostFrame::Structured { event, .. } => {
                        if !host_identity_is_current(&db, &session_id, &host) {
                            tracing::warn!(session = %session_id, attachment_id, "dropping structured event from a stale Host attachment");
                            break;
                        }
                        let _ = channel.send(json!({"t": "structured", "event": event}));
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
                        notify_status_once(&app, &db, &ev);
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
                                "reason": reason,
                            }),
                        );
                        break;
                    }
                    HostFrame::Pong { .. } => {}
                    HostFrame::HelloOk { .. } => {}
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
) -> std::result::Result<(), String> {
    use agentport_core::protocol::{write_frame, ClientFrame};
    let writer = {
        let writers = state.writers.lock().unwrap();
        writers
            .get(&session_id)
            .map(|attachment| attachment.writer.clone())
    };
    let Some(w) = writer else {
        return Ok(()); // not attached (e.g. interrupted) — resize is best effort
    };
    let mut w = w.lock().unwrap();
    map_err!(write_frame(
        &mut *w,
        &ClientFrame::Resize {
            session_id: session_id.clone(),
            cols,
            rows,
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
async fn restart_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    risk_ack: bool,
) -> std::result::Result<Value, String> {
    let initial_session = map_err!(state.db.get_session(&session_id))?;
    let lock_cwd = initial_session.cwd.clone();
    let repository_lock = match tauri::async_runtime::spawn_blocking(move || {
        acquire_session_repository_lock(&lock_cwd)
    })
    .await
    {
        Ok(Ok(lock)) => lock,
        Ok(Err(error)) => return Err(error.to_string()),
        Err(error) => return Err(format!("repository lock worker failed: {error}")),
    };
    // The Session may have changed while this restart waited behind a branch
    // operation or another AgentPort process. Re-read under the common-dir
    // reservation before deciding that it is safe to relaunch.
    let session = map_err!(state.db.get_session(&session_id))?;
    if matches!(session.lifecycle, Lifecycle::Running | Lifecycle::Creating) {
        return Err("session is running; stop it first".into());
    }
    let permission_mode = session
        .adapter_type
        .effective_permission_mode(session.permission_mode);
    if permission_requires_risk_ack(session.adapter_type, permission_mode) && !risk_ack {
        return Err("NEEDS_RISK_ACK".into());
    }
    let install = map_err!(install_for(&state, session.adapter_type))?;
    let preset = map_err!(preset_for(
        &state,
        session.adapter_type,
        Some(session.preset_id.clone()),
        &install
    ))?;
    map_err!(adapters::validate_user_args(
        session.adapter_type,
        &preset.args
    ))?;
    let plan = map_err!(
        adapters::adapter_for(session.adapter_type).build_resume_checked(&ResumeContext {
            install,
            preset: preset.clone(),
            cwd: session.cwd.clone(),
            agent_session_id: session.agent_session_id.clone(),
            session_id: session.id.clone(),
            hook_events_path: state
                .paths
                .hook_events_path(&session.id)
                .to_string_lossy()
                .into_owned(),
            session_dir: state
                .paths
                .session_dir(&session.id)
                .to_string_lossy()
                .into_owned(),
            transport: session.transport,
        })
    )?;
    // Restart must use exactly the same preset environment and secret
    // materialization as create.  Do it before rotating the Host token or
    // moving the persisted lifecycle back to Creating.
    let (env, secrets) = map_err!(materialize_launch_environment(&state, &preset, &plan.env))?;
    let settings = map_err!(state.db.load_settings())?;
    if let Err(error) = write_launch_helpers(&plan.helper_files) {
        return Err(error.to_string());
    }
    let new_token = ids::new_host_token();
    if let Err(error) = state.db.set_session_token(&session_id, &new_token) {
        remove_launch_helpers(&plan.helper_files);
        return Err(error.to_string());
    }
    let mut renewed = map_err!(state.db.get_session(&session_id))?;
    renewed.host_socket = Some(
        state
            .paths
            .socket_path(&session_id)
            .to_string_lossy()
            .into_owned(),
    );
    renewed.lifecycle = Lifecycle::Creating;
    // HostManager claims the new run atomically before it publishes Creating.
    // Writing the lifecycle without that run fence would let a delayed terminal
    // observation from the previous Host race this restart.
    let mgr = HostManager {
        paths: &state.paths,
        db: &state.db,
    };
    let info = match mgr.launch(LaunchSpec {
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
            return Err(error.to_string());
        }
    };
    drop(repository_lock);
    let launched = map_err!(state.db.get_session(&session_id))?;
    // A resume whose recorded conversation is gone falls back to a fresh
    // conversation with a newly assigned native id (claude adapter). Persist
    // it so the next restart resumes the conversation that actually exists.
    if let Some(native) = &plan.assigned_agent_session_id {
        if session.agent_session_id.as_deref() != Some(native.as_str()) {
            map_err!(state
                .db
                .update_session_agent_id(&session_id, native, plan.resume_precision,))?;
        }
    }
    ensure_session_monitor(&app, &state, &launched);
    // `HostManager::launch` has already moved this exact host/run to Running
    // through its lifecycle CAS. A second unguarded write here could revive a
    // terminal state if the Host exited in the small window above.
    emit_sessions_changed(&app, &state, Some(&session_id));
    let notices = launch_notice_values(session.adapter_type, &plan.notices);
    let notes = plan
        .notices
        .iter()
        .map(|notice| notice.legacy_message.as_str())
        .collect::<Vec<_>>();
    Ok(json!({
        "resumePrecision": plan.resume_precision.as_str(),
        "agentSessionId": plan
            .assigned_agent_session_id
            .as_deref()
            .or(session.agent_session_id.as_deref()),
        "notes": notes,
        "notices": notices,
        "hostPid": info.host_pid,
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
async fn archive_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
) -> std::result::Result<(), String> {
    map_err!(stop_session_before_archive(&state, &session_id))?;
    map_err!(state.db.archive_session(&session_id))?;
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
    map_err!(state.db.purge_archived_session(&session_id))?;
    cleanup_purged_sessions(&state, std::slice::from_ref(&session_id));
    emit_sessions_changed(&app, &state, None);
    Ok(())
}

#[tauri::command]
async fn delete_all_archived_sessions(
    state: State<'_, AppState>,
    app: AppHandle,
) -> std::result::Result<(), String> {
    let archived_ids: Vec<String> = map_err!(state.db.list_sessions(None, true))?
        .into_iter()
        .filter(|session| session.archived_at.is_some())
        .map(|session| session.id)
        .collect();
    // Stop first, then purge as a batch. A stop error leaves every archive
    // intact instead of only partially deleting the user's archive history.
    // Legacy archives are stopped in bounded parallel batches.
    map_err!(stop_archived_sessions_for_purge(&state, &archived_ids))?;
    let purged = map_err!(state.db.purge_all_archived_sessions())?;
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
    let w = join?;
    emit_sessions_changed(&app, &state, None);
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
) -> std::result::Result<(), String> {
    let mgr = WorktreeManager {
        paths: &state.paths,
        db: &state.db,
    };
    map_err!(mgr.remove(&worktree_id))?;
    emit_sessions_changed(&app, &state, None);
    Ok(())
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
    last: Option<u32>,
    strip_ansi: bool,
) -> std::result::Result<String, String> {
    let exporter = Exporter {
        paths: &state.paths,
        db: &state.db,
    };
    let secrets = load_all_secret_values(&state);
    let destp = std::path::Path::new(&dest);
    let p = match kind.as_str() {
        "log" => {
            let range = last.map(LogRange::LastLines).unwrap_or(LogRange::All);
            let ansi = if strip_ansi {
                AnsiMode::Strip
            } else {
                AnsiMode::Keep
            };
            exporter.export_log(&session_id, destp, range, ansi, &secrets)
        }
        "md" => {
            let blocks = last.map(MdBlocks::Last).unwrap_or(MdBlocks::All);
            exporter.export_markdown(&session_id, destp, blocks, &secrets)
        }
        "zip" => exporter.export_diagnostics_zip(&[session_id], destp, &secrets),
        _ => return Err("unknown export kind".into()),
    };
    map_err!(p).map(|p| p.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Full-data backup / restore (settings page)
// ---------------------------------------------------------------------------

/// Create a full-data backup. Default destination is the private backups dir
/// with a UTC timestamp name; every backup is verified before reporting
/// success so the user never sees a green check on a broken archive.
#[tauri::command]
async fn backup_create(
    state: State<'_, AppState>,
    dest: Option<String>,
) -> std::result::Result<Value, String> {
    let dest = match dest {
        Some(d) if !d.trim().is_empty() => std::path::PathBuf::from(d),
        _ => state.paths.backups_dir().join(format!(
            "agentport-backup-{}.zip",
            Utc::now().format("%Y%m%d-%H%M%S")
        )),
    };
    let report = map_err!(agentport_core::backup::create(
        &state.paths,
        &state.db,
        &dest
    ))?;
    map_err!(agentport_core::backup::verify(&dest))?;
    Ok(json!({
        "path": dest,
        "files": report.files,
        "bytes": report.bytes,
        "verified": true,
    }))
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
        "createdAt": manifest.created_at,
        "dataModelVersion": manifest.data_model_version,
        "files": manifest.files.len(),
    }))
}

/// Restore into a NEW directory chosen by the user. The running app's data is
/// never touched: swapping the live data root requires the app to be quit
/// first, which is a deliberate manual step.
#[tauri::command]
async fn backup_restore(
    state: State<'_, AppState>,
    path: String,
    target: String,
) -> std::result::Result<Value, String> {
    if target.trim().is_empty() {
        return Err("restore target directory required".into());
    }
    let live = state.paths.root().to_path_buf();
    let target_path = std::path::PathBuf::from(&target);
    if target_path == live || target_path.starts_with(&live) || live.starts_with(&target_path) {
        return Err(
            "restore target must be outside the live data directory; quit the app before swapping data roots"
                .into(),
        );
    }
    let previous = map_err!(agentport_core::backup::restore(
        std::path::Path::new(&path),
        &target_path
    ))?;
    Ok(json!({
        "restored": target_path,
        "previousKeptAt": previous,
    }))
}

#[tauri::command]
async fn search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> std::result::Result<Value, String> {
    let idx = SearchIndex {
        db: &state.db,
        paths: &state.paths,
    };
    idx.open().map_err(|e| e.to_string())?;
    for s in map_err!(state.db.list_sessions(None, true))? {
        let _ = idx.index_session_log(&s.id, std::path::Path::new(&s.log_path), &[]);
    }
    let r = map_err!(idx.query(&query, limit.unwrap_or(20)))?;
    Ok(json!({
        "partial": r.partial,
        "totalHits": r.total_hits.unwrap_or(r.hits.len()),
        "hits": r.hits.iter().map(|h| json!({
            "kind": format!("{:?}", h.kind).to_lowercase(),
            "sessionId": h.session_id,
            "projectId": h.project_id,
            "title": h.title,
            "snippet": h.snippet,
            "logOffset": h.log_offset,
            "rotatedAway": h.rotated_away,
        })).collect::<Vec<_>>(),
    }))
}

/// Search the complete persisted log of one Session. Unlike xterm's in-memory
/// scrollback this includes output that predates the attach replay tail.
#[tauri::command]
async fn search_session_log(
    state: State<'_, AppState>,
    session_id: String,
    query: String,
    limit: Option<usize>,
) -> std::result::Result<Value, String> {
    let idx = SearchIndex {
        db: &state.db,
        paths: &state.paths,
    };
    // This is deliberately a direct, read-only scan rather than an FTS query:
    // the focused terminal must remain searchable even while the derived
    // global index is rebuilding or disabled.
    // Keep enough concrete hits for keyboard navigation in a long terminal,
    // while returning the exact total separately for histories with more.
    let r =
        map_err!(idx.query_session_text(&session_id, &query, limit.unwrap_or(1_000).min(1_000)))?;
    Ok(json!({
        "partial": r.partial,
        "totalHits": r.total_hits.unwrap_or(r.hits.len()),
        "hits": r.hits.iter().map(|h| json!({
            "kind": format!("{:?}", h.kind).to_lowercase(),
            "sessionId": h.session_id,
            "projectId": h.project_id,
            "title": h.title,
            "snippet": h.snippet,
            "logOffset": h.log_offset,
            "rotatedAway": h.rotated_away,
        })).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
async fn rebuild_search_index(state: State<'_, AppState>) -> std::result::Result<(), String> {
    let idx = SearchIndex {
        db: &state.db,
        paths: &state.paths,
    };
    idx.open().map_err(|e| e.to_string())?;
    map_err!(idx.rebuild_all(&mut |_, _| true))
}

#[tauri::command]
async fn get_timeline(state: State<'_, AppState>) -> std::result::Result<Value, String> {
    let tl = Timeline { db: &state.db };
    let t = map_err!(tl.build())?;
    Ok(json!({
        "completed": t.completed, "waiting": t.waiting, "failed": t.failed,
        "entries": t.entries, "ackSnapshots": t.ack_snapshots,
    }))
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

/// Read the last N bytes of a session's output log — used to render the
/// grey "history terminal" for exited/interrupted sessions (no live host).
#[tauri::command]
async fn read_log_tail(
    state: State<'_, AppState>,
    session_id: String,
    bytes: u64,
) -> std::result::Result<Value, String> {
    use base64::Engine as _;
    let session = map_err!(state.db.get_session(&session_id))?;
    let path = std::path::PathBuf::from(&session.log_path);
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let data =
        agentport_core::logs::tail_bytes(&path, bytes.min(4 * 1024 * 1024)).unwrap_or_default();
    Ok(json!({
        "data": base64::engine::general_purpose::STANDARD.encode(&data),
        "offset": len.saturating_sub(data.len() as u64),
        "total": len,
    }))
}

/// Read bounded context around an event-level recovery cursor for a terminal
/// that no longer has a live Host. The database's latest verified cursor is
/// the generation fence; `Session::log_path` alone is intentionally not one.
#[tauri::command]
async fn read_recovery_log_context(
    state: State<'_, AppState>,
    session_id: String,
    cursor: LogCursor,
) -> std::result::Result<Value, Value> {
    use base64::Engine as _;
    const BEFORE: u64 = 128 * 1024;
    const AFTER: u64 = 256 * 1024;
    let session = state.db.get_session(&session_id).map_err(|error| {
        runtime_command_error(
            "recovery_context_failed",
            json!({}),
            error.to_string(),
            error.to_string(),
        )
    })?;
    let latest = state
        .db
        .get_latest_log_cursor(&session_id)
        .map_err(|error| {
            runtime_command_error(
                "recovery_context_failed",
                json!({}),
                error.to_string(),
                error.to_string(),
            )
        })?
        .ok_or_else(|| {
            let message = "无法确认当前保留的输出代际；输出可能已轮转";
            runtime_command_error(
                "recovery_generation_unavailable",
                json!({}),
                message,
                message,
            )
        })?;
    if cursor.run_id != latest.run_id
        || cursor.run_ordinal != latest.run_ordinal
        || cursor.generation != latest.generation
        || cursor.offset < 0
        || cursor.offset > latest.offset
    {
        let message = "输出已轮转或不属于当前保留日志，无法安全定位";
        return Err(runtime_command_error(
            "recovery_output_rotated",
            json!({}),
            message,
            message,
        ));
    }
    let path = std::path::PathBuf::from(&session.log_path);
    let len = std::fs::metadata(&path)
        .map_err(|error| {
            runtime_command_error(
                "recovery_log_missing",
                json!({}),
                error.to_string(),
                "输出日志已不存在或已轮转",
            )
        })?
        .len();
    if latest.offset < 0 || len < latest.offset as u64 {
        let message = "输出已轮转或不再完整保留，无法安全定位";
        return Err(runtime_command_error(
            "recovery_log_incomplete",
            json!({}),
            message,
            message,
        ));
    }
    let target = cursor.offset as u64;
    let start = target.saturating_sub(BEFORE);
    let end = (target.saturating_add(AFTER)).min(latest.offset as u64);
    let data = agentport_core::logs::read_range(&path, start, end - start).map_err(|error| {
        runtime_command_error(
            "recovery_context_failed",
            json!({}),
            error.to_string(),
            error.to_string(),
        )
    })?;
    if data.len() as u64 != end - start {
        let message = "读取期间输出日志发生变化，无法安全定位；请重试";
        return Err(runtime_command_error(
            "recovery_log_changed",
            json!({}),
            message,
            message,
        ));
    }
    Ok(json!({
        "data": base64::engine::general_purpose::STANDARD.encode(&data),
        "offset": start,
        "total": latest.offset,
        "cursor": cursor,
    }))
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
        notification_tx: start_notification_worker(),
        notified_statuses: Mutex::new(HashSet::new()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            notifications::install(app.handle());
            Ok(())
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            boot,
            list_projects,
            list_archived_sessions,
            probe_agents,
            probe_agent,
            list_supported_agents,
            add_project,
            rename_project,
            remove_project,
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
            restart_session,
            rename_session,
            archive_session,
            unarchive_session,
            delete_archived_session,
            delete_all_archived_sessions,
            session_history,
            create_worktree,
            list_worktrees,
            remove_worktree,
            worktree_status_text,
            git_commands::get_repository_status,
            git_commands::list_local_branches,
            git_commands::create_local_branch,
            git_commands::delete_local_branch,
            git_commands::switch_local_branch,
            git_commands::list_auto_stashes,
            git_commands::restore_auto_stash,
            git_commands::cleanup_auto_stash,
            export_session,
            backup_create,
            backup_list,
            backup_verify,
            backup_restore,
            search,
            search_session_log,
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
            read_log_tail,
            read_recovery_log_context,
            reveal_in_file_manager,
            open_in_system_terminal,
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
    use std::sync::mpsc;

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

    fn insert_attachment_test_session(paths: &AppPaths, db: &Db) -> String {
        let project_id = ids::new_id("prj_attachment");
        db.add_project(&Project {
            id: project_id.clone(),
            name: "attachment test".into(),
            root_path: paths.root().to_string_lossy().into_owned(),
            git_root_path: None,
            created_at: Utc::now(),
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
