//! AgentPort GUI shell (Tauri 2). The GUI is a reconnectable client only —
//! it never owns agent processes (PRD ch.6). Commands delegate to
//! agentport-core; PTY output streams to the frontend via tauri Channels.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use agentport_core::adapters::{self, capability, LaunchContext, ResumeContext};
use agentport_core::db::Db;
use agentport_core::diag::Diagnostics;
use agentport_core::error::{CoreError, Result};
use agentport_core::export::{AnsiMode, Exporter, LogRange, MdBlocks};
use agentport_core::git::WorktreeManager;
use agentport_core::host_manager::{write_private_file, HostClient, HostManager, LaunchSpec};
use agentport_core::ids;
use agentport_core::models::*;
use agentport_core::notify::{Notification, Notifier};
use agentport_core::paths::{normalize_abs, AppPaths};
use agentport_core::protocol::HostFrame;
use agentport_core::search::SearchIndex;
use agentport_core::secrets::{load_preset_secrets, CredentialBroker};
use agentport_core::timeline::Timeline;
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

struct AppState {
    paths: AppPaths,
    db: Db,
    /// Live host input writers, per attached session.
    writers: Mutex<HashMap<String, Arc<Mutex<std::os::unix::net::UnixStream>>>>,
    notifier: Mutex<Notifier>,
}

macro_rules! map_err {
    ($e:expr) => {
        $e.map_err(|e| e.to_string())
    };
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
    secret_backend: String,
    index_state: String,
    webview: String,
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
        "sequence": e.sequence,
        "state": e.state.as_str(),
        "source": e.source.as_str(),
        "confidence": e.confidence.as_str(),
        "evidence": e.evidence,
        "occurredAt": e.occurred_at,
    })
}

fn session_view(db: &Db, s: &Session, active_session: Option<&str>) -> SessionView {
    let latest = db.latest_status(&s.id).ok().flatten();
    let unread = if Some(s.id.as_str()) == active_session {
        false
    } else {
        db.get_recovery_summary(&s.id)
            .map(|r| {
                r.unread_output_offset >= 0
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

#[tauri::command]
async fn boot(state: State<'_, AppState>) -> std::result::Result<BootInfo, String> {
    let mgr = HostManager {
        paths: &state.paths,
        db: &state.db,
    };
    let _ = mgr.reconcile_on_startup();
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
            "entries": t.entries,
        })
    });
    let diag = Diagnostics {
        paths: &state.paths,
        db: &state.db,
    };
    Ok(BootInfo {
        platform: json!(diag.platform_info()),
        settings: map_err!(state.db.load_settings())?,
        adapters: map_err!(state.db.list_adapters())?,
        projects: collect_projects(&state.db, None),
        timeline: timeline.unwrap_or_else(|_| json!({"entries": []})),
        secret_backend: format!("{:?}", CredentialBroker::backend_status()),
        index_state,
        webview: "system".into(),
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
    for t in [
        AgentType::Claude,
        AgentType::Codex,
        AgentType::Kimi,
        AgentType::Shell,
    ] {
        let o = capability::probe_agent(t, None);
        if let Some(i) = &o.install {
            let _ = state.db.upsert_adapter(i);
        }
        out.push(probe_outcome_json(t, &o));
    }
    Ok(out)
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
    json!({
        "agent": t.as_str(),
        "displayName": t.display_name(),
        "state": format!("{:?}", o.state).to_lowercase(),
        "reason": o.reason,
        "install": o.install,
        "candidates": o.candidates,
    })
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
                name: format!("{} 安全默认", t.display_name()),
                executable_path: String::new(),
                args: vec![],
                permission_mode: PermissionMode::Native,
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

/// Build the LaunchPlan for a (not yet created) session — used both by the
/// preflight panel and by actual creation.
fn build_launch_plan(
    state: &AppState,
    project_id: &str,
    agent: AgentType,
    preset_id: Option<String>,
    worktree_id: Option<String>,
    permission: PermissionMode,
    extra_args: Option<Vec<String>>,
) -> Result<(adapters::LaunchPlan, Preset, String, Option<String>)> {
    let project = state.db.get_project(project_id)?;
    let install = install_for(state, agent)?;
    let preset = preset_for(state, agent, preset_id, &install)?;
    let cwd = match &worktree_id {
        Some(w) => state.db.get_worktree(w)?.path,
        None => project.root_path.clone(),
    };
    let session_id = ids::new_id("ses");
    let session_dir = state.paths.session_dir(&session_id);
    std::fs::create_dir_all(&session_dir)?;
    let ctx = LaunchContext {
        install: install.clone(),
        preset: preset.clone(),
        cwd: cwd.clone(),
        session_id: session_id.clone(),
        hook_events_path: state
            .paths
            .hook_events_path(&session_id)
            .to_string_lossy()
            .into_owned(),
        session_dir: session_dir.to_string_lossy().into_owned(),
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

#[tauri::command]
async fn create_session(
    state: State<'_, AppState>,
    app: AppHandle,
    project_id: String,
    agent: String,
    title: Option<String>,
    preset_id: Option<String>,
    worktree_id: Option<String>,
    permission: String,
    risk_ack: bool,
    cols: Option<u16>,
    rows: Option<u16>,
    extra_args: Option<Vec<String>>,
) -> std::result::Result<Value, String> {
    let t: AgentType = map_err!(agent.parse::<AgentType>())?;
    let mode = t.effective_permission_mode(map_err!(parse_permission(&permission))?);
    if mode != PermissionMode::Native && !risk_ack {
        return Err("NEEDS_RISK_ACK".into());
    }
    let project = map_err!(state.db.get_project(&project_id))?;
    let (plan, preset, cwd, session_id) = map_err!(build_launch_plan(
        &state,
        &project_id,
        t,
        preset_id,
        worktree_id.clone(),
        mode,
        extra_args
    ))?;
    let session_id = session_id.unwrap();
    for (path, contents) in &plan.helper_files {
        map_err!(write_private_file(path, contents))?;
    }
    let (title, auto_title_pending) = match title.map(|value| value.trim().to_string()) {
        Some(value) if !value.is_empty() => (value, false),
        _ => (
            map_err!(state.db.next_default_session_title(&project.id, t))?,
            true,
        ),
    };
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
        command: plan.argv.clone(),
        permission_mode: mode,
        created_at: now,
        updated_at: now,
        archived_at: None,
    };
    // Keep the marker separate from the Session schema. It is consumed only
    // after the first successfully submitted terminal input, so a custom
    // title supplied at creation is never overwritten.
    if auto_title_pending {
        map_err!(state.db.mark_session_title_auto_generated(&session_id))?;
    }
    map_err!(state.db.insert_session(&session))?;
    let mut env = plan.env.clone();
    for name in &preset.env_names {
        if let Ok(v) = std::env::var(name) {
            env.push((name.clone(), v));
        }
    }
    let mut secrets = vec![];
    if !preset.secret_ref_ids.is_empty() {
        let broker = map_err!(CredentialBroker::detect())?;
        let refs: Vec<SecretRef> = preset
            .secret_ref_ids
            .iter()
            .map(|id| state.db.get_secret_ref(id))
            .collect::<Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        secrets = map_err!(load_preset_secrets(&broker, &refs))?;
    }
    let settings = map_err!(state.db.load_settings())?;
    let mgr = HostManager {
        paths: &state.paths,
        db: &state.db,
    };
    let info = map_err!(mgr.launch(LaunchSpec {
        session: session.clone(),
        command: plan.argv.clone(),
        env,
        secrets,
        log_limit_bytes: settings.log_limit_mib * 1024 * 1024,
        agent_session_id_hint: plan.assigned_agent_session_id.clone(),
        cols: cols.unwrap_or(120),
        rows: rows.unwrap_or(32),
    }))?;
    emit_sessions_changed(&app, &state, Some(&session_id));
    Ok(json!({
        "id": session_id,
        "attach": {
            "hostPid": info.host_pid,
            "childAlive": info.child_alive,
        },
        "resumePrecision": session.resume_precision.as_str(),
        "agentSessionId": session.agent_session_id,
        "notes": plan.notes,
        "command": plan.argv,
    }))
}

fn emit_sessions_changed(app: &AppHandle, state: &AppState, active: Option<&str>) {
    let projects = collect_projects(&state.db, active);
    let _ = app.emit("projects-changed", projects);
}

#[tauri::command]
async fn attach_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    replay_tail_bytes: u64,
    channel: tauri::ipc::Channel<Value>,
) -> std::result::Result<Value, String> {
    // Detach any existing attachment for this session first.
    detach_session(state.clone(), session_id.clone()).await.ok();
    let session = map_err!(state.db.get_session(&session_id))?;
    let socket = session
        .host_socket
        .clone()
        .ok_or_else(|| "no socket recorded".to_string())?;
    let token = map_err!(state.db.get_session_token(&session_id))?;
    let (client, info) = map_err!(HostClient::connect(
        &socket,
        &session_id,
        &token,
        replay_tail_bytes
    ))?;
    let HostClient { reader, writer, .. } = client;
    state
        .writers
        .lock()
        .unwrap()
        .insert(session_id.clone(), Arc::new(Mutex::new(writer)));
    let paths = state.paths.clone();
    let sid = session_id.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        // Each watch thread owns its own db handle (SQLite WAL allows it).
        let db = match Db::open(&paths) {
            Ok(d) => d,
            Err(e) => {
                let _ = channel.send(json!({"t": "error", "message": e.to_string()}));
                return;
            }
        };
        watch_loop(app2, channel, reader, db, paths, sid);
    });
    Ok(json!({
        "hostPid": info.host_pid,
        "childAlive": info.child_alive,
        "logBytes": info.log_bytes,
        "agentSessionId": info.agent_session_id,
    }))
}

fn watch_loop(
    app: AppHandle,
    channel: tauri::ipc::Channel<Value>,
    mut reader: std::io::BufReader<std::os::unix::net::UnixStream>,
    db: Db,
    _paths: AppPaths,
    session_id: String,
) {
    loop {
        match agentport_core::protocol::read_frame::<HostFrame>(&mut reader) {
            Ok(Some(frame)) => match frame {
                HostFrame::Output { data, offset, .. } => {
                    let _ = channel.send(json!({
                            "t": "output",
                            "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data),
                            "offset": offset,
                        }));
                }
                HostFrame::ReplayDone { offset, .. } => {
                    let _ = channel.send(json!({"t": "replay_done", "offset": offset}));
                }
                HostFrame::State {
                    session_id: sid,
                    sequence,
                    state,
                    source,
                    confidence,
                    evidence,
                    occurred_at,
                } => {
                    let ev = StatusEvent {
                        session_id: sid.clone(),
                        sequence,
                        state,
                        source,
                        confidence,
                        evidence,
                        occurred_at,
                    };
                    let _ = db.record_status_event(&ev);
                    let title = db
                        .get_session(&sid)
                        .map(|s| s.title)
                        .unwrap_or_else(|_| sid.clone());
                    let _ = app.emit("session-state", status_value(&ev));
                    let notifier = Notifier::new(true);
                    agentport_core::notify::notify_state_change(&notifier, &title, &ev);
                    let _ = channel.send(json!({"t": "state", "event": status_value(&ev)}));
                }
                HostFrame::AgentSession {
                    agent_session_id, ..
                } => {
                    let _ = db.update_session_agent_id(
                        &session_id,
                        &agent_session_id,
                        ResumePrecision::Exact,
                    );
                    let _ = channel.send(json!({"t": "agent_session", "id": agent_session_id}));
                    let _ = app.emit(
                        "session-agent-id",
                        json!({"sessionId": session_id, "agentSessionId": agent_session_id}),
                    );
                }
                HostFrame::Heartbeat { log_bytes, .. } => {
                    let _ = channel.send(json!({"t": "heartbeat", "logBytes": log_bytes}));
                }
                HostFrame::Exit {
                    code,
                    signal,
                    group_cleaned,
                    ..
                } => {
                    let _ = db.update_session_lifecycle(&session_id, Lifecycle::Exited);
                    let _ = channel.send(json!({
                        "t": "exit", "code": code, "signal": signal,
                        "groupCleaned": group_cleaned,
                    }));
                    let _ = app.emit(
                        "session-exit",
                        json!({
                            "sessionId": session_id, "code": code, "signal": signal,
                        }),
                    );
                    break;
                }
                HostFrame::Pong { .. } => {}
                HostFrame::HelloOk { .. } => {}
                HostFrame::Error { message, .. } => {
                    let _ = channel.send(json!({"t": "error", "message": message}));
                }
            },
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
}

#[tauri::command]
async fn detach_session(
    state: State<'_, AppState>,
    session_id: String,
) -> std::result::Result<(), String> {
    // Mark last-seen so the recovery timeline knows what the GUI has seen.
    if let Ok(Some(latest)) = state.db.latest_status(&session_id) {
        let _ = state
            .db
            .set_last_seen_sequence(&session_id, latest.sequence);
    }
    if let Some(w) = state.writers.lock().unwrap().remove(&session_id) {
        use std::net::Shutdown;
        if let Ok(w) = w.lock() {
            let _ = w.shutdown(Shutdown::Both);
        }
    }
    Ok(())
}

/// Confirm that the user has viewed the Session's current terminal content and
/// status. The frontend calls this when the Session receives focus.
#[tauri::command]
async fn mark_session_seen(
    state: State<'_, AppState>,
    session_id: String,
) -> std::result::Result<(), String> {
    map_err!(state.db.mark_session_seen(&session_id))?;
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
) -> std::result::Result<(), String> {
    map_err!(state.db.mark_output_unread(&session_id, offset))?;
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
    let writers = state.writers.lock().unwrap();
    let Some(w) = writers.get(&session_id) else {
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
    let writers = state.writers.lock().unwrap();
    let Some(w) = writers.get(&session_id) else {
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
    let session = map_err!(state.db.get_session(&session_id))?;
    if matches!(session.lifecycle, Lifecycle::Running | Lifecycle::Creating) {
        return Err("session is running; stop it first".into());
    }
    let permission_mode = session
        .adapter_type
        .effective_permission_mode(session.permission_mode);
    if permission_mode != PermissionMode::Native && !risk_ack {
        return Err("NEEDS_RISK_ACK".into());
    }
    let install = map_err!(install_for(&state, session.adapter_type))?;
    let preset = map_err!(preset_for(
        &state,
        session.adapter_type,
        Some(session.preset_id.clone()),
        &install
    ))?;
    let plan = map_err!(adapters::adapter_for(session.adapter_type).build_resume(
        &ResumeContext {
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
        }
    ))?;
    for (path, contents) in &plan.helper_files {
        map_err!(write_private_file(path, contents))?;
    }
    let new_token = ids::new_host_token();
    map_err!(state.db.set_session_token(&session_id, &new_token))?;
    let mut renewed = map_err!(state.db.get_session(&session_id))?;
    renewed.host_socket = Some(
        state
            .paths
            .socket_path(&session_id)
            .to_string_lossy()
            .into_owned(),
    );
    renewed.lifecycle = Lifecycle::Creating;
    map_err!(state
        .db
        .update_session_lifecycle(&session_id, Lifecycle::Creating))?;
    let settings = map_err!(state.db.load_settings())?;
    let mgr = HostManager {
        paths: &state.paths,
        db: &state.db,
    };
    let info = map_err!(mgr.launch(LaunchSpec {
        session: renewed,
        command: plan.argv.clone(),
        env: plan.env.clone(),
        secrets: vec![],
        log_limit_bytes: settings.log_limit_mib * 1024 * 1024,
        agent_session_id_hint: plan.assigned_agent_session_id.clone(),
        cols: 120,
        rows: 32,
    }))?;
    map_err!(state
        .db
        .update_session_lifecycle(&session_id, Lifecycle::Running))?;
    emit_sessions_changed(&app, &state, Some(&session_id));
    Ok(json!({
        "resumePrecision": plan.resume_precision.as_str(),
        "agentSessionId": session.agent_session_id,
        "notes": plan.notes,
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
    if let Some(writer) = state.writers.lock().unwrap().remove(session_id) {
        use std::net::Shutdown;
        if let Ok(writer) = writer.lock() {
            let _ = writer.shutdown(Shutdown::Both);
        }
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

/// Delete derived search data plus session-local logs after the authoritative
/// database transaction has completed. These are best-effort cleanups: a
/// successfully purged archive must not be reported as failed just because a
/// stale socket or already-removed log directory no longer exists.
fn cleanup_purged_sessions(state: &AppState, session_ids: &[String]) {
    let index = SearchIndex {
        db: &state.db,
        paths: &state.paths,
    };
    let _ = index.remove_sessions(session_ids);
    for session_id in session_ids {
        let _ = std::fs::remove_file(state.paths.socket_path(session_id));
        let _ = std::fs::remove_dir_all(state.paths.session_dir(session_id));
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
    let archived: Vec<Session> = map_err!(state.db.list_sessions(None, true))?
        .into_iter()
        .filter(|session| session.archived_at.is_some())
        .collect();
    // Stop first, then purge as a batch. A stop error leaves every archive
    // intact instead of only partially deleting the user's archive history.
    // Legacy archives are stopped in bounded parallel batches.
    let archived_ids: Vec<String> = archived.into_iter().map(|session| session.id).collect();
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

#[tauri::command]
async fn create_worktree(
    state: State<'_, AppState>,
    app: AppHandle,
    project_id: String,
    task: String,
    base_ref: Option<String>,
    branch: Option<String>,
) -> std::result::Result<Value, String> {
    let mgr = WorktreeManager {
        paths: &state.paths,
        db: &state.db,
    };
    let w = map_err!(mgr.create(&project_id, &task, base_ref.as_deref(), branch.as_deref()))?;
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
        "entries": t.entries,
    }))
}

#[tauri::command]
async fn ack_timeline(state: State<'_, AppState>) -> std::result::Result<(), String> {
    let tl = Timeline { db: &state.db };
    map_err!(tl.acknowledge_all())
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
    map_err!(state.db.save_settings(&settings))
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
    let notifier = state.notifier.lock().unwrap();
    map_err!(notifier.send(Notification {
        session_id: "diag".into(),
        title: "AgentPort 测试通知".into(),
        body: "通知通道工作正常。".into(),
    }))
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

#[tauri::command]
async fn reveal_in_file_manager(path: String) -> std::result::Result<(), String> {
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
        Ok(s) => Err(format!("file manager exited with {s}")),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn open_in_system_terminal(path: String) -> std::result::Result<(), String> {
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
    for (term, args) in [
        ("x-terminal-emulator", vec!["--working-directory"]),
        ("gnome-terminal", vec!["--working-directory"]),
        ("konsole", vec!["--workdir"]),
    ] {
        let mut argv = args.clone();
        argv.push(&path);
        if std::process::Command::new(term)
            .args(&argv)
            .status()
            .is_ok()
        {
            return Ok(());
        }
    }
    Err("no terminal emulator found".into())
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

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() {
    let paths = AppPaths::default().expect("app paths");
    paths.ensure_layout().expect("layout");
    // App diagnostics log — hangs/failures must leave evidence.
    {
        let log_dir = paths.root().join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("app.log"))
        {
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
    let state = AppState {
        paths,
        db,
        writers: Mutex::new(HashMap::new()),
        notifier: Mutex::new(Notifier::new(true)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            boot,
            list_projects,
            list_archived_sessions,
            probe_agents,
            probe_agent,
            add_project,
            rename_project,
            remove_project,
            list_presets,
            create_session,
            attach_session,
            detach_session,
            mark_session_seen,
            mark_session_output_unread,
            send_input,
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
            export_session,
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
            reveal_in_file_manager,
            open_in_system_terminal,
            pick_directory,
            pick_save_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building AgentPort")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // Mark all latest sequences as seen so the next launch's
                // recovery timeline only shows genuinely new events.
                let state = app.state::<AppState>();
                if let Ok(sessions) = state.db.list_sessions(None, false) {
                    for s in sessions {
                        if let Ok(Some(latest)) = state.db.latest_status(&s.id) {
                            let _ = state.db.set_last_seen_sequence(&s.id, latest.sequence);
                        }
                    }
                }
                // Detach all clients; hosts keep running (PRD core invariant).
                let writers: Vec<_> = state
                    .writers
                    .lock()
                    .unwrap()
                    .drain()
                    .map(|(_, w)| w)
                    .collect();
                drop(writers);
            }
        });
}
