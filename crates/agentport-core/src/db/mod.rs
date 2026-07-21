//! SQLite persistence (PRD ch.5). Single user, local file, WAL mode.
//! Raw terminal bytes never enter the database — only metadata, status events
//! and derived summaries. Search index lives in the same file (FTS5) and is
//! fully rebuildable from logs + metadata.

use crate::error::{CoreError, Result};
use crate::models::*;
use crate::paths::AppPaths;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, Row, Transaction};
use std::sync::Mutex;

pub mod schema {
    /// Ordered migrations. Index N migrates version N -> N+1.
    /// NEVER edit an already-applied entry; append new ones.
    pub const MIGRATIONS: &[&str] = &[
        // v0 -> v1: initial schema (PRD ch.5)
        r#"
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
            root_path TEXT NOT NULL UNIQUE,
            git_root_path TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE adapters (
            agent_type TEXT PRIMARY KEY,
            executable_path TEXT NOT NULL,
            version_text TEXT NOT NULL,
            capability_hash TEXT NOT NULL,
            exact_resume INTEGER NOT NULL,
            hook_status TEXT NOT NULL,
            capabilities_json TEXT NOT NULL DEFAULT '{}',
            probed_at TEXT NOT NULL
        );
        CREATE TABLE presets (
            id TEXT PRIMARY KEY,
            agent_type TEXT NOT NULL,
            name TEXT NOT NULL,
            executable_path TEXT NOT NULL,
            args_json TEXT NOT NULL DEFAULT '[]',
            permission_mode TEXT NOT NULL DEFAULT 'native',
            env_names_json TEXT NOT NULL DEFAULT '[]',
            secret_ref_ids_json TEXT NOT NULL DEFAULT '[]',
            built_in INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE secret_refs (
            id TEXT PRIMARY KEY,
            env_name TEXT NOT NULL,
            backend TEXT NOT NULL,
            service TEXT NOT NULL,
            account TEXT NOT NULL UNIQUE,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE worktrees (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            branch TEXT NOT NULL,
            base_commit TEXT NOT NULL,
            base_ref TEXT,
            path TEXT NOT NULL UNIQUE,
            health TEXT NOT NULL DEFAULT 'clean',
            created_at TEXT NOT NULL
        );
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            worktree_id TEXT REFERENCES worktrees(id),
            preset_id TEXT NOT NULL,
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
            cwd TEXT NOT NULL,
            host_pid INTEGER,
            host_socket TEXT,
            host_token TEXT NOT NULL,
            lifecycle TEXT NOT NULL,
            agent_session_id TEXT,
            resume_precision TEXT NOT NULL DEFAULT 'unavailable',
            log_path TEXT NOT NULL,
            adapter_type TEXT NOT NULL,
            command_json TEXT NOT NULL DEFAULT '[]',
            permission_mode TEXT NOT NULL DEFAULT 'native',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT
        );
        CREATE TABLE status_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            sequence INTEGER NOT NULL,
            state TEXT NOT NULL,
            source TEXT NOT NULL,
            confidence TEXT NOT NULL,
            evidence TEXT,
            occurred_at TEXT NOT NULL,
            UNIQUE(session_id, sequence)
        );
        CREATE INDEX idx_status_events_session ON status_events(session_id, sequence);
        CREATE TABLE latest_status (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id),
            sequence INTEGER NOT NULL,
            state TEXT NOT NULL,
            source TEXT NOT NULL,
            confidence TEXT NOT NULL,
            occurred_at TEXT NOT NULL
        );
        CREATE TABLE recovery_summary (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id),
            last_seen_sequence INTEGER NOT NULL DEFAULT 0,
            latest_sequence INTEGER NOT NULL DEFAULT 0,
            unread_output_offset INTEGER NOT NULL DEFAULT 0,
            summary_state TEXT NOT NULL DEFAULT 'none',
            acknowledged_at TEXT
        );
        CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE redaction_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            hits INTEGER NOT NULL,
            occurred_at TEXT NOT NULL
        );
        "#,
        // v1 -> v2: `-1` means there is no unread terminal output. Older
        // rows with actual status history keep their prior recovery signal.
        r#"
        UPDATE recovery_summary
        SET unread_output_offset=-1
        WHERE latest_sequence=0 AND unread_output_offset=0;
        "#,
    ];
}

// ---------------------------------------------------------------------------
// (de)serialization helpers
// ---------------------------------------------------------------------------

fn dt_str(t: &DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_dt(s: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(s)
        .map_err(|e| CoreError::Internal(format!("bad timestamp {s}: {e}")))?
        .with_timezone(&Utc))
}

fn opt_dt(s: Option<String>) -> Result<Option<DateTime<Utc>>> {
    match s {
        Some(s) => Ok(Some(parse_dt(&s)?)),
        None => Ok(None),
    }
}

fn auto_title_pending_key(session_id: &str) -> String {
    format!("session_auto_title_pending:{session_id}")
}

fn title_from_first_input(input: &str) -> Option<String> {
    let normalized = input.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    let mut chars = normalized.chars();
    let prefix: String = chars.by_ref().take(15).collect();
    Some(if chars.next().is_some() {
        format!("{prefix}...")
    } else {
        prefix
    })
}

fn purge_session_rows(tx: &Transaction<'_>, id: &str) -> Result<()> {
    tx.execute("DELETE FROM status_events WHERE session_id=?1", params![id])?;
    tx.execute("DELETE FROM latest_status WHERE session_id=?1", params![id])?;
    tx.execute(
        "DELETE FROM recovery_summary WHERE session_id=?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM redaction_audit WHERE session_id=?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM app_meta WHERE key=?1",
        params![auto_title_pending_key(id)],
    )?;
    tx.execute("DELETE FROM sessions WHERE id=?1", params![id])?;
    Ok(())
}

fn agent_type(s: &str) -> Result<AgentType> {
    s.parse()
}

fn hook_status(s: &str) -> Result<HookStatus> {
    Ok(match s {
        "supported" => HookStatus::Supported,
        "degraded" => HookStatus::Degraded,
        "unavailable" => HookStatus::Unavailable,
        other => return Err(CoreError::Internal(format!("bad hook_status {other}"))),
    })
}
fn hook_status_str(h: &HookStatus) -> &'static str {
    match h {
        HookStatus::Supported => "supported",
        HookStatus::Degraded => "degraded",
        HookStatus::Unavailable => "unavailable",
    }
}

fn permission_mode(s: &str) -> Result<PermissionMode> {
    Ok(match s {
        "native" => PermissionMode::Native,
        "auto" => PermissionMode::Auto,
        "bypass" => PermissionMode::Bypass,
        other => return Err(CoreError::Internal(format!("bad permission_mode {other}"))),
    })
}

fn secret_backend(s: &str) -> Result<SecretBackend> {
    Ok(match s {
        "macos_keychain" => SecretBackend::MacosKeychain,
        "linux_secret_service" => SecretBackend::LinuxSecretService,
        other => return Err(CoreError::Internal(format!("bad secret backend {other}"))),
    })
}

fn lifecycle(s: &str) -> Result<Lifecycle> {
    Ok(match s {
        "creating" => Lifecycle::Creating,
        "running" => Lifecycle::Running,
        "interrupted" => Lifecycle::Interrupted,
        "exited" => Lifecycle::Exited,
        "stopped" => Lifecycle::Stopped,
        other => return Err(CoreError::Internal(format!("bad lifecycle {other}"))),
    })
}

fn resume_precision(s: &str) -> Result<ResumePrecision> {
    Ok(match s {
        "exact" => ResumePrecision::Exact,
        "latest" => ResumePrecision::Latest,
        "unavailable" => ResumePrecision::Unavailable,
        other => return Err(CoreError::Internal(format!("bad resume_precision {other}"))),
    })
}

fn agent_state(s: &str) -> Result<AgentState> {
    Ok(match s {
        "working" => AgentState::Working,
        "needs_input" => AgentState::NeedsInput,
        "idle" => AgentState::Idle,
        "exited" => AgentState::Exited,
        "unknown" => AgentState::Unknown,
        other => return Err(CoreError::Internal(format!("bad agent_state {other}"))),
    })
}

fn state_source(s: &str) -> Result<StateSource> {
    Ok(match s {
        "hook" => StateSource::Hook,
        "pty" => StateSource::Pty,
        "process" => StateSource::Process,
        "adapter" => StateSource::Adapter,
        other => return Err(CoreError::Internal(format!("bad state_source {other}"))),
    })
}

fn confidence(s: &str) -> Result<Confidence> {
    Ok(match s {
        "low" => Confidence::Low,
        "medium" => Confidence::Medium,
        "high" => Confidence::High,
        other => return Err(CoreError::Internal(format!("bad confidence {other}"))),
    })
}

fn summary_state(s: &str) -> Result<SummaryState> {
    Ok(match s {
        "completed" => SummaryState::Completed,
        "waiting" => SummaryState::Waiting,
        "failed" => SummaryState::Failed,
        "output" => SummaryState::Output,
        "none" => SummaryState::None,
        other => return Err(CoreError::Internal(format!("bad summary_state {other}"))),
    })
}

fn worktree_health(s: &str) -> Result<WorktreeHealth> {
    Ok(match s {
        "clean" => WorktreeHealth::Clean,
        "dirty" => WorktreeHealth::Dirty,
        "missing" => WorktreeHealth::Missing,
        "locked" => WorktreeHealth::Locked,
        other => return Err(CoreError::Internal(format!("bad worktree_health {other}"))),
    })
}

/// Deterministic mapping of a status event to the recovery summary state:
/// - needs_input -> waiting
/// - idle from a turn-end hook -> completed
/// - exited code 0 -> completed; exited nonzero/signal/unknown -> failed
/// - anything else -> output
fn summary_state_for(e: &StatusEvent) -> SummaryState {
    let ev = e.evidence.as_deref().unwrap_or("");
    match e.state {
        AgentState::NeedsInput => SummaryState::Waiting,
        AgentState::Idle if ev.contains("hook:Stop") || ev.contains("TurnEnd") => {
            SummaryState::Completed
        }
        AgentState::Exited => {
            if ev == "process:exit:0" {
                SummaryState::Completed
            } else {
                SummaryState::Failed
            }
        }
        _ => SummaryState::Output,
    }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

fn row_project(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get("id")?,
        name: r.get("name")?,
        root_path: r.get("root_path")?,
        git_root_path: r.get("git_root_path")?,
        created_at: DateTime::parse_from_rfc3339(&r.get::<_, String>("created_at")?)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

fn row_session(r: &Row) -> rusqlite::Result<Session> {
    let parse = |s: String| {
        DateTime::parse_from_rfc3339(&s)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now())
    };
    Ok(Session {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        worktree_id: r.get("worktree_id")?,
        preset_id: r.get("preset_id")?,
        title: r.get("title")?,
        cwd: r.get("cwd")?,
        host_pid: r.get("host_pid")?,
        host_socket: r.get("host_socket")?,
        host_token: r.get("host_token")?,
        lifecycle: lifecycle(&r.get::<_, String>("lifecycle")?).unwrap_or(Lifecycle::Interrupted),
        agent_session_id: r.get("agent_session_id")?,
        resume_precision: resume_precision(&r.get::<_, String>("resume_precision")?)
            .unwrap_or(ResumePrecision::Unavailable),
        log_path: r.get("log_path")?,
        adapter_type: agent_type(&r.get::<_, String>("adapter_type")?).unwrap_or(AgentType::Shell),
        command: serde_json::from_str(&r.get::<_, String>("command_json")?).unwrap_or_default(),
        permission_mode: permission_mode(&r.get::<_, String>("permission_mode")?)
            .unwrap_or(PermissionMode::Native),
        created_at: parse(r.get("created_at")?),
        updated_at: parse(r.get("updated_at")?),
        archived_at: r.get::<_, Option<String>>("archived_at")?.map(parse),
    })
}

fn row_status_event(r: &Row) -> rusqlite::Result<StatusEvent> {
    Ok(StatusEvent {
        session_id: r.get("session_id")?,
        sequence: r.get("sequence")?,
        state: agent_state(&r.get::<_, String>("state")?).unwrap_or(AgentState::Unknown),
        source: state_source(&r.get::<_, String>("source")?).unwrap_or(StateSource::Process),
        confidence: confidence(&r.get::<_, String>("confidence")?).unwrap_or(Confidence::Low),
        evidence: r.get("evidence")?,
        occurred_at: DateTime::parse_from_rfc3339(&r.get::<_, String>("occurred_at")?)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

fn row_worktree(r: &Row) -> rusqlite::Result<Worktree> {
    Ok(Worktree {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        branch: r.get("branch")?,
        base_commit: r.get("base_commit")?,
        base_ref: r.get("base_ref")?,
        path: r.get("path")?,
        health: worktree_health(&r.get::<_, String>("health")?).unwrap_or(WorktreeHealth::Missing),
        created_at: DateTime::parse_from_rfc3339(&r.get::<_, String>("created_at")?)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

fn row_preset(r: &Row) -> rusqlite::Result<Preset> {
    Ok(Preset {
        id: r.get("id")?,
        agent_type: agent_type(&r.get::<_, String>("agent_type")?).unwrap_or(AgentType::Shell),
        name: r.get("name")?,
        executable_path: r.get("executable_path")?,
        args: serde_json::from_str(&r.get::<_, String>("args_json")?).unwrap_or_default(),
        permission_mode: permission_mode(&r.get::<_, String>("permission_mode")?)
            .unwrap_or(PermissionMode::Native),
        env_names: serde_json::from_str(&r.get::<_, String>("env_names_json")?).unwrap_or_default(),
        secret_ref_ids: serde_json::from_str(&r.get::<_, String>("secret_ref_ids_json")?)
            .unwrap_or_default(),
        built_in: r.get("built_in")?,
    })
}

fn row_secret_ref(r: &Row) -> rusqlite::Result<SecretRef> {
    Ok(SecretRef {
        id: r.get("id")?,
        env_name: r.get("env_name")?,
        backend: secret_backend(&r.get::<_, String>("backend")?)
            .unwrap_or(SecretBackend::MacosKeychain),
        service: r.get("service")?,
        account: r.get("account")?,
        updated_at: DateTime::parse_from_rfc3339(&r.get::<_, String>("updated_at")?)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

fn row_adapter(r: &Row) -> rusqlite::Result<AdapterInstall> {
    let caps_json = r.get::<_, String>("capabilities_json")?;
    let caps: serde_json::Value = serde_json::from_str(&caps_json).unwrap_or(serde_json::json!({}));
    Ok(AdapterInstall {
        agent_type: agent_type(&r.get::<_, String>("agent_type")?).unwrap_or(AgentType::Shell),
        executable_path: r.get("executable_path")?,
        version_text: r.get("version_text")?,
        capability_hash: r.get("capability_hash")?,
        exact_resume: r.get("exact_resume")?,
        hook_status: hook_status(&r.get::<_, String>("hook_status")?)
            .unwrap_or(HookStatus::Unavailable),
        probed_at: DateTime::parse_from_rfc3339(&r.get::<_, String>("probed_at")?)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
        candidates: serde_json::from_value(caps["candidates"].clone()).unwrap_or_default(),
        flags: serde_json::from_value(caps["flags"].clone()).unwrap_or_default(),
    })
}

fn row_recovery(r: &Row) -> rusqlite::Result<RecoverySummary> {
    Ok(RecoverySummary {
        session_id: r.get("session_id")?,
        last_seen_sequence: r.get("last_seen_sequence")?,
        latest_sequence: r.get("latest_sequence")?,
        unread_output_offset: r.get("unread_output_offset")?,
        summary_state: summary_state(&r.get::<_, String>("summary_state")?)
            .unwrap_or(SummaryState::None),
        acknowledged_at: r
            .get::<_, Option<String>>("acknowledged_at")?
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|d| d.with_timezone(&Utc)),
    })
}

// ---------------------------------------------------------------------------
// Db
// ---------------------------------------------------------------------------

/// Thread-safe handle. All writes go through one connection guarded by a mutex;
/// WAL allows concurrent reads.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (creating + migrating) the database at the given app paths.
    pub fn open(paths: &AppPaths) -> Result<Self> {
        paths.ensure_layout()?;
        if let Some(parent) = paths.db_path().parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(paths.db_path())?;
        Self::init(conn)
    }

    /// Open an in-memory database (tests).
    pub fn open_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;",
        )?;
        Self::migrate(&conn)?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    fn migrate(conn: &Connection) -> Result<()> {
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in schema::MIGRATIONS.iter().enumerate() {
            let ver = (i + 1) as i64;
            if current < ver {
                let tx = conn.unchecked_transaction()?;
                tx.execute_batch(sql)?;
                tx.pragma_update(None, "user_version", ver)?;
                tx.commit()?;
            }
        }
        conn.execute(
            "INSERT INTO app_meta(key,value) VALUES('data_model_version',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![DATA_MODEL_VERSION.to_string()],
        )?;
        Ok(())
    }

    pub fn conn(&self) -> &Mutex<Connection> {
        &self.conn
    }

    // -- projects -----------------------------------------------------------
    pub fn add_project(&self, p: &Project) -> Result<()> {
        if p.name.is_empty() || p.name.chars().count() > 80 {
            return Err(CoreError::Validation(
                "project name must be 1-80 chars".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO projects(id,name,root_path,git_root_path,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![p.id, p.name, p.root_path, p.git_root_path, dt_str(&p.created_at)],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                CoreError::Conflict(format!("project path already registered: {}", p.root_path))
            }
            other => CoreError::Sqlite(other),
        })?;
        Ok(())
    }

    pub fn get_project(&self, id: &str) -> Result<Project> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM projects WHERE id=?1",
            params![id],
            row_project,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::NotFound(format!("project {id}")),
            other => CoreError::Sqlite(other),
        })
    }

    pub fn find_project_by_path(&self, root_path: &str) -> Result<Option<Project>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT * FROM projects WHERE root_path=?1",
            params![root_path],
            row_project,
        ) {
            Ok(p) => Ok(Some(p)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CoreError::Sqlite(e)),
        }
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT * FROM projects ORDER BY created_at, id")?;
        let rows = st.query_map([], row_project)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn rename_project(&self, id: &str, name: &str) -> Result<()> {
        if name.is_empty() || name.chars().count() > 80 {
            return Err(CoreError::Validation(
                "project name must be 1-80 chars".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("UPDATE projects SET name=?2 WHERE id=?1", params![id, name])?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("project {id}")));
        }
        Ok(())
    }

    pub fn remove_project(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // Block while any non-archived session references the project; callers
        // archive/stop sessions first. Worktree rows are deleted with the project.
        let live: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE project_id=?1 AND archived_at IS NULL",
            params![id],
            |r| r.get(0),
        )?;
        if live > 0 {
            return Err(CoreError::Blocked(format!(
                "project {id} still has {live} session(s); archive them first"
            )));
        }
        // Clean dependent rows first (FK constraints), then sessions/worktrees.
        conn.execute(
            "DELETE FROM status_events WHERE session_id IN (SELECT id FROM sessions WHERE project_id=?1)",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM latest_status WHERE session_id IN (SELECT id FROM sessions WHERE project_id=?1)",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM recovery_summary WHERE session_id IN (SELECT id FROM sessions WHERE project_id=?1)",
            params![id],
        )?;
        conn.execute("DELETE FROM sessions WHERE project_id=?1", params![id])?;
        conn.execute("DELETE FROM worktrees WHERE project_id=?1", params![id])?;
        let n = conn.execute("DELETE FROM projects WHERE id=?1", params![id])?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("project {id}")));
        }
        Ok(())
    }

    // -- adapters -----------------------------------------------------------
    pub fn upsert_adapter(&self, a: &AdapterInstall) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let caps = serde_json::json!({
            "candidates": a.candidates,
            "flags": a.flags,
        })
        .to_string();
        conn.execute(
            "INSERT INTO adapters(agent_type,executable_path,version_text,capability_hash,exact_resume,hook_status,capabilities_json,probed_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(agent_type) DO UPDATE SET executable_path=excluded.executable_path,
               version_text=excluded.version_text, capability_hash=excluded.capability_hash,
               exact_resume=excluded.exact_resume, hook_status=excluded.hook_status,
               capabilities_json=excluded.capabilities_json, probed_at=excluded.probed_at",
            params![
                a.agent_type.as_str(),
                a.executable_path,
                a.version_text,
                a.capability_hash,
                a.exact_resume,
                hook_status_str(&a.hook_status),
                caps,
                dt_str(&a.probed_at)
            ],
        )?;
        Ok(())
    }

    pub fn get_adapter(&self, t: AgentType) -> Result<Option<AdapterInstall>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT * FROM adapters WHERE agent_type=?1",
            params![t.as_str()],
            row_adapter,
        ) {
            Ok(a) => Ok(Some(a)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CoreError::Sqlite(e)),
        }
    }

    pub fn list_adapters(&self) -> Result<Vec<AdapterInstall>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT * FROM adapters ORDER BY agent_type")?;
        let rows = st.query_map([], row_adapter)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // -- presets ------------------------------------------------------------
    pub fn upsert_preset(&self, p: &Preset) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO presets(id,agent_type,name,executable_path,args_json,permission_mode,env_names_json,secret_ref_ids_json,built_in)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET agent_type=excluded.agent_type, name=excluded.name,
               executable_path=excluded.executable_path, args_json=excluded.args_json,
               permission_mode=excluded.permission_mode, env_names_json=excluded.env_names_json,
               secret_ref_ids_json=excluded.secret_ref_ids_json, built_in=excluded.built_in",
            params![
                p.id,
                p.agent_type.as_str(),
                p.name,
                p.executable_path,
                serde_json::to_string(&p.args)?,
                p.permission_mode.as_str(),
                serde_json::to_string(&p.env_names)?,
                serde_json::to_string(&p.secret_ref_ids)?,
                p.built_in
            ],
        )?;
        Ok(())
    }

    pub fn get_preset(&self, id: &str) -> Result<Preset> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT * FROM presets WHERE id=?1", params![id], row_preset)
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => CoreError::NotFound(format!("preset {id}")),
                other => CoreError::Sqlite(other),
            })
    }

    pub fn list_presets(&self, agent: Option<AgentType>) -> Result<Vec<Preset>> {
        let conn = self.conn.lock().unwrap();
        match agent {
            Some(a) => {
                let mut st = conn.prepare(
                    "SELECT * FROM presets WHERE agent_type=?1 ORDER BY built_in DESC, name",
                )?;
                let rows = st.query_map(params![a.as_str()], row_preset)?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            }
            None => {
                let mut st = conn.prepare("SELECT * FROM presets ORDER BY built_in DESC, name")?;
                let rows = st.query_map([], row_preset)?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            }
        }
    }

    pub fn delete_preset(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let built_in: bool = conn
            .query_row(
                "SELECT built_in FROM presets WHERE id=?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => CoreError::NotFound(format!("preset {id}")),
                other => CoreError::Sqlite(other),
            })?;
        if built_in {
            return Err(CoreError::Blocked(
                "built-in presets cannot be deleted".into(),
            ));
        }
        conn.execute("DELETE FROM presets WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn seed_builtin_presets(&self) -> Result<()> {
        for (id, t, name) in [
            ("pre_claude_safe", AgentType::Claude, "Claude 安全默认"),
            ("pre_codex_safe", AgentType::Codex, "Codex 安全默认"),
            ("pre_kimi_safe", AgentType::Kimi, "Kimi 安全默认"),
            ("pre_shell_safe", AgentType::Shell, "Shell 安全默认"),
        ] {
            let p = Preset {
                id: id.into(),
                agent_type: t,
                name: name.into(),
                executable_path: String::new(), // filled after CLI probing
                args: vec![],
                permission_mode: PermissionMode::Native,
                env_names: vec![],
                secret_ref_ids: vec![],
                built_in: true,
            };
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO presets(id,agent_type,name,executable_path,args_json,permission_mode,env_names_json,secret_ref_ids_json,built_in)
                 VALUES(?1,?2,?3,'','[]','native','[]','[]',1)",
                params![p.id, p.agent_type.as_str(), p.name],
            )?;
        }
        Ok(())
    }

    // -- secret refs (metadata only!) ---------------------------------------
    pub fn upsert_secret_ref(&self, s: &SecretRef) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO secret_refs(id,env_name,backend,service,account,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(id) DO UPDATE SET env_name=excluded.env_name, backend=excluded.backend,
               service=excluded.service, account=excluded.account, updated_at=excluded.updated_at",
            params![
                s.id,
                s.env_name,
                s.backend.as_str(),
                s.service,
                s.account,
                dt_str(&s.updated_at)
            ],
        )?;
        Ok(())
    }

    pub fn get_secret_ref(&self, id: &str) -> Result<SecretRef> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM secret_refs WHERE id=?1",
            params![id],
            row_secret_ref,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::NotFound(format!("secret ref {id}")),
            other => CoreError::Sqlite(other),
        })
    }

    pub fn list_secret_refs(&self) -> Result<Vec<SecretRef>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT * FROM secret_refs ORDER BY env_name")?;
        let rows = st.query_map([], row_secret_ref)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn delete_secret_ref(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM secret_refs WHERE id=?1", params![id])?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("secret ref {id}")));
        }
        Ok(())
    }

    // -- worktrees ----------------------------------------------------------
    pub fn insert_worktree(&self, w: &Worktree) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO worktrees(id,project_id,branch,base_commit,base_ref,path,health,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                w.id,
                w.project_id,
                w.branch,
                w.base_commit,
                w.base_ref,
                w.path,
                w.health.as_str(),
                dt_str(&w.created_at)
            ],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                CoreError::Conflict(format!("worktree path already registered: {}", w.path))
            }
            other => CoreError::Sqlite(other),
        })?;
        Ok(())
    }

    pub fn get_worktree(&self, id: &str) -> Result<Worktree> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM worktrees WHERE id=?1",
            params![id],
            row_worktree,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::NotFound(format!("worktree {id}")),
            other => CoreError::Sqlite(other),
        })
    }

    pub fn list_worktrees(&self, project_id: &str) -> Result<Vec<Worktree>> {
        let conn = self.conn.lock().unwrap();
        let mut st =
            conn.prepare("SELECT * FROM worktrees WHERE project_id=?1 ORDER BY created_at, id")?;
        let rows = st.query_map(params![project_id], row_worktree)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn set_worktree_health(&self, id: &str, h: WorktreeHealth) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE worktrees SET health=?2 WHERE id=?1",
            params![id, h.as_str()],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("worktree {id}")));
        }
        Ok(())
    }

    pub fn delete_worktree(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // Sessions keep their cwd/history but lose the worktree link.
        conn.execute(
            "UPDATE sessions SET worktree_id=NULL WHERE worktree_id=?1",
            params![id],
        )?;
        let n = conn.execute("DELETE FROM worktrees WHERE id=?1", params![id])?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("worktree {id}")));
        }
        Ok(())
    }

    // -- sessions -----------------------------------------------------------
    pub fn insert_session(&self, s: &Session) -> Result<()> {
        if s.title.is_empty() || s.title.chars().count() > 120 {
            return Err(CoreError::Validation(
                "session title must be 1-120 chars".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO sessions(id,project_id,worktree_id,preset_id,title,cwd,host_pid,host_socket,host_token,lifecycle,agent_session_id,resume_precision,log_path,adapter_type,command_json,permission_mode,created_at,updated_at,archived_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            params![
                s.id,
                s.project_id,
                s.worktree_id,
                s.preset_id,
                s.title,
                s.cwd,
                s.host_pid,
                s.host_socket,
                s.host_token,
                s.lifecycle.as_str(),
                s.agent_session_id,
                s.resume_precision.as_str(),
                s.log_path,
                s.adapter_type.as_str(),
                serde_json::to_string(&s.command)?,
                s.permission_mode.as_str(),
                dt_str(&s.created_at),
                dt_str(&s.updated_at),
                s.archived_at.map(|t| dt_str(&t)),
            ],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO recovery_summary(session_id,last_seen_sequence,latest_sequence,unread_output_offset,summary_state,acknowledged_at)
             VALUES(?1,0,0,-1,'none',NULL)",
            params![s.id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> Result<Session> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM sessions WHERE id=?1",
            params![id],
            row_session,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::NotFound(format!("session {id}")),
            other => CoreError::Sqlite(other),
        })
    }

    pub fn list_sessions(
        &self,
        project_id: Option<&str>,
        include_archived: bool,
    ) -> Result<Vec<Session>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from("SELECT * FROM sessions");
        let mut conds = vec![];
        if project_id.is_some() {
            conds.push("project_id=?1");
        }
        if !include_archived {
            conds.push("archived_at IS NULL");
        }
        if !conds.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conds.join(" AND "));
        }
        sql.push_str(" ORDER BY created_at, id");
        let mut st = conn.prepare(&sql)?;
        let rows = match project_id {
            Some(p) => st.query_map(params![p], row_session)?.collect::<Vec<_>>(),
            None => st.query_map([], row_session)?.collect::<Vec<_>>(),
        };
        Ok(rows.into_iter().filter_map(|r| r.ok()).collect())
    }

    fn touch(&self, conn: &Connection, id: &str) -> Result<()> {
        conn.execute(
            "UPDATE sessions SET updated_at=?2 WHERE id=?1",
            params![id, dt_str(&Utc::now())],
        )?;
        Ok(())
    }

    pub fn update_session_lifecycle(&self, id: &str, l: Lifecycle) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions SET lifecycle=?2, updated_at=?3 WHERE id=?1",
            params![id, l.as_str(), dt_str(&Utc::now())],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    pub fn update_session_host(
        &self,
        id: &str,
        pid: Option<i64>,
        socket: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions SET host_pid=?2, host_socket=?3, updated_at=?4 WHERE id=?1",
            params![id, pid, socket, dt_str(&Utc::now())],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    pub fn update_session_agent_id(
        &self,
        id: &str,
        agent_session_id: &str,
        precision: ResumePrecision,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions SET agent_session_id=?2, resume_precision=?3, updated_at=?4 WHERE id=?1",
            params![id, agent_session_id, precision.as_str(), dt_str(&Utc::now())],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    pub fn rename_session(&self, id: &str, title: &str) -> Result<()> {
        if title.is_empty() || title.chars().count() > 120 {
            return Err(CoreError::Validation(
                "session title must be 1-120 chars".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let n = tx.execute(
            "UPDATE sessions SET title=?2, updated_at=?3 WHERE id=?1",
            params![id, title, dt_str(&Utc::now())],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("session {id}")));
        }
        tx.execute(
            "DELETE FROM app_meta WHERE key=?1",
            params![auto_title_pending_key(id)],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Marks a system-generated title as eligible for one automatic rename.
    pub fn mark_session_title_auto_generated(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_meta(key,value) VALUES(?1,'1')
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![auto_title_pending_key(id)],
        )?;
        Ok(())
    }

    /// Replaces a pending generated title with the user's first submitted input.
    /// Returns false for manually titled, archived, empty, or already-renamed Sessions.
    pub fn auto_rename_session_from_first_input(&self, id: &str, input: &str) -> Result<bool> {
        let Some(title) = title_from_first_input(input) else {
            return Ok(false);
        };
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let pending: Option<String> = match tx.query_row(
            "SELECT value FROM app_meta WHERE key=?1",
            params![auto_title_pending_key(id)],
            |r| r.get(0),
        ) {
            Ok(value) => Some(value),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(error) => return Err(CoreError::Sqlite(error)),
        };
        if pending.as_deref() != Some("1") {
            return Ok(false);
        }
        let updated = tx.execute(
            "UPDATE sessions SET title=?2, updated_at=?3 WHERE id=?1 AND archived_at IS NULL",
            params![id, title, dt_str(&Utc::now())],
        )?;
        tx.execute(
            "DELETE FROM app_meta WHERE key=?1",
            params![auto_title_pending_key(id)],
        )?;
        tx.commit()?;
        Ok(updated == 1)
    }

    pub fn archive_session(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let n = tx.execute(
            "UPDATE sessions SET archived_at=?2, updated_at=?2 WHERE id=?1",
            params![id, dt_str(&Utc::now())],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("session {id}")));
        }
        tx.execute(
            "DELETE FROM app_meta WHERE key=?1",
            params![auto_title_pending_key(id)],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Restores an archived Session to the active project tree.
    pub fn unarchive_session(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions SET archived_at=NULL, updated_at=?2
             WHERE id=?1 AND archived_at IS NOT NULL",
            params![id, dt_str(&Utc::now())],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("archived session {id}")));
        }
        Ok(())
    }

    /// Permanently removes one archived Session and all database rows that
    /// depend on it. Session logs are removed by the GUI command after this
    /// transaction commits.
    pub fn purge_archived_session(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let archived: Option<String> = match tx.query_row(
            "SELECT archived_at FROM sessions WHERE id=?1",
            params![id],
            |r| r.get(0),
        ) {
            Ok(value) => value,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                return Err(CoreError::NotFound(format!("session {id}")));
            }
            Err(error) => return Err(CoreError::Sqlite(error)),
        };
        if archived.is_none() {
            return Err(CoreError::Blocked(format!("session {id} is not archived")));
        }
        purge_session_rows(&tx, id)?;
        tx.commit()?;
        Ok(())
    }

    /// Permanently removes all archived Sessions and returns their IDs so
    /// callers can clean derived files outside the SQLite transaction.
    pub fn purge_all_archived_sessions(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let ids = {
            let mut st = tx.prepare("SELECT id FROM sessions WHERE archived_at IS NOT NULL")?;
            let ids = st
                .query_map([], |r| r.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            ids
        };
        if ids.is_empty() {
            tx.commit()?;
            return Ok(ids);
        }
        tx.execute(
            "DELETE FROM status_events WHERE session_id IN
             (SELECT id FROM sessions WHERE archived_at IS NOT NULL)",
            [],
        )?;
        tx.execute(
            "DELETE FROM latest_status WHERE session_id IN
             (SELECT id FROM sessions WHERE archived_at IS NOT NULL)",
            [],
        )?;
        tx.execute(
            "DELETE FROM recovery_summary WHERE session_id IN
             (SELECT id FROM sessions WHERE archived_at IS NOT NULL)",
            [],
        )?;
        tx.execute(
            "DELETE FROM redaction_audit WHERE session_id IN
             (SELECT id FROM sessions WHERE archived_at IS NOT NULL)",
            [],
        )?;
        tx.execute(
            "DELETE FROM app_meta WHERE key IN
             (SELECT 'session_auto_title_pending:' || id FROM sessions WHERE archived_at IS NOT NULL)",
            [],
        )?;
        tx.execute("DELETE FROM sessions WHERE archived_at IS NOT NULL", [])?;
        tx.commit()?;
        Ok(ids)
    }

    pub fn get_session_token(&self, id: &str) -> Result<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT host_token FROM sessions WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::NotFound(format!("session {id}")),
            other => CoreError::Sqlite(other),
        })
    }

    /// Rotate the host token (used when a session is restarted: the new host
    /// gets a fresh identity token, the session id stays stable).
    pub fn set_session_token(&self, id: &str, token: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions SET host_token=?2, updated_at=?3 WHERE id=?1",
            params![id, token, dt_str(&Utc::now())],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    // -- status events --------------------------------------------------------
    pub fn record_status_event(&self, e: &StatusEvent) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let changed = tx.execute(
            "INSERT OR IGNORE INTO status_events(session_id,sequence,state,source,confidence,evidence,occurred_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                e.session_id,
                e.sequence,
                e.state.as_str(),
                e.source.as_str(),
                e.confidence.as_str(),
                e.evidence,
                dt_str(&e.occurred_at)
            ],
        )?;
        if changed > 0 {
            tx.execute(
                "INSERT INTO latest_status(session_id,sequence,state,source,confidence,occurred_at)
                 VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(session_id) DO UPDATE SET sequence=excluded.sequence,
                   state=excluded.state, source=excluded.source, confidence=excluded.confidence,
                   occurred_at=excluded.occurred_at
                 WHERE excluded.sequence >= latest_status.sequence",
                params![
                    e.session_id,
                    e.sequence,
                    e.state.as_str(),
                    e.source.as_str(),
                    e.confidence.as_str(),
                    dt_str(&e.occurred_at)
                ],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO recovery_summary(session_id,last_seen_sequence,latest_sequence,unread_output_offset,summary_state,acknowledged_at)
                 VALUES(?1,0,0,-1,'none',NULL)",
                params![e.session_id],
            )?;
            let summary = summary_state_for(e);
            tx.execute(
                "UPDATE recovery_summary
                 SET latest_sequence=MAX(latest_sequence,?2), summary_state=?3, acknowledged_at=NULL
                 WHERE session_id=?1",
                params![e.session_id, e.sequence, summary.as_str()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn latest_status(&self, session_id: &str) -> Result<Option<StatusEvent>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT session_id,sequence,state,source,confidence,NULL as evidence,occurred_at FROM latest_status WHERE session_id=?1",
            params![session_id],
            row_status_event,
        ) {
            Ok(e) => Ok(Some(e)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CoreError::Sqlite(e)),
        }
    }

    pub fn status_history(&self, session_id: &str, limit: u32) -> Result<Vec<StatusEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(
            "SELECT session_id,sequence,state,source,confidence,evidence,occurred_at
             FROM status_events WHERE session_id=?1 ORDER BY sequence DESC LIMIT ?2",
        )?;
        let rows = st.query_map(params![session_id, limit], row_status_event)?;
        let mut out: Vec<_> = rows.filter_map(|r| r.ok()).collect();
        out.reverse(); // chronological
        Ok(out)
    }

    pub fn events_since(&self, sequence_per_session: &[(String, i64)]) -> Result<Vec<StatusEvent>> {
        if sequence_per_session.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let cond = sequence_per_session
            .iter()
            .map(|_| "(session_id=? AND sequence>?)")
            .collect::<Vec<_>>()
            .join(" OR ");
        let sql = format!(
            "SELECT session_id,sequence,state,source,confidence,evidence,occurred_at
             FROM status_events WHERE {cond} ORDER BY occurred_at, session_id, sequence"
        );
        let mut st = conn.prepare(&sql)?;
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        for (sid, seq) in sequence_per_session {
            params_vec.push(Box::new(sid.clone()));
            params_vec.push(Box::new(*seq));
        }
        let refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
        let rows = st.query_map(refs.as_slice(), row_status_event)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // -- recovery summary -----------------------------------------------------
    pub fn get_recovery_summary(&self, session_id: &str) -> Result<RecoverySummary> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM recovery_summary WHERE session_id=?1",
            params![session_id],
            row_recovery,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                CoreError::NotFound(format!("recovery summary {session_id}"))
            }
            other => CoreError::Sqlite(other),
        })
    }

    pub fn set_last_seen_sequence(&self, session_id: &str, seq: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO recovery_summary(session_id,last_seen_sequence,latest_sequence,unread_output_offset,summary_state,acknowledged_at)
             VALUES(?1,0,0,-1,'none',NULL)",
            params![session_id],
        )?;
        conn.execute(
            "UPDATE recovery_summary SET last_seen_sequence=MAX(last_seen_sequence,?2) WHERE session_id=?1",
            params![session_id, seq],
        )?;
        Ok(())
    }

    pub fn set_unread_offset(&self, session_id: &str, offset: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO recovery_summary(session_id,last_seen_sequence,latest_sequence,unread_output_offset,summary_state,acknowledged_at)
             VALUES(?1,0,0,-1,'none',NULL)",
            params![session_id],
        )?;
        conn.execute(
            "UPDATE recovery_summary SET unread_output_offset=?2 WHERE session_id=?1",
            params![session_id, offset],
        )?;
        Ok(())
    }

    /// Mark the current status and terminal output as viewed by the user.
    pub fn mark_session_seen(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = dt_str(&Utc::now());
        conn.execute(
            "INSERT OR IGNORE INTO recovery_summary(session_id,last_seen_sequence,latest_sequence,unread_output_offset,summary_state,acknowledged_at)
             VALUES(?1,0,0,-1,'none',NULL)",
            params![session_id],
        )?;
        conn.execute(
            "UPDATE recovery_summary
             SET last_seen_sequence=latest_sequence, unread_output_offset=-1, acknowledged_at=?2
             WHERE session_id=?1",
            params![session_id, now],
        )?;
        Ok(())
    }

    /// Record the first terminal byte produced while the Session is not
    /// focused. Later chunks retain the first offset so recovery can jump to
    /// the start of the unread output.
    pub fn mark_output_unread(&self, session_id: &str, offset: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO recovery_summary(session_id,last_seen_sequence,latest_sequence,unread_output_offset,summary_state,acknowledged_at)
             VALUES(?1,0,0,-1,'none',NULL)",
            params![session_id],
        )?;
        conn.execute(
            "UPDATE recovery_summary
             SET unread_output_offset=CASE WHEN unread_output_offset < 0 THEN ?2 ELSE unread_output_offset END,
                 acknowledged_at=NULL
             WHERE session_id=?1",
            params![session_id, offset.max(0)],
        )?;
        Ok(())
    }

    /// PTY working/idle heuristics are too noisy for an unread badge. Only
    /// terminal-attention states count here; ordinary output is tracked by its
    /// byte offset separately.
    pub fn has_unread_attention(&self, session_id: &str, after_sequence: i64) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM status_events
                WHERE session_id=?1 AND sequence>?2 AND (
                    state='needs_input' OR state='exited' OR
                    (state='idle' AND (evidence LIKE '%hook:Stop%' OR evidence LIKE '%TurnEnd%'))
                )
             )",
            params![session_id, after_sequence],
            |row| row.get(0),
        )?;
        Ok(exists != 0)
    }

    pub fn acknowledge_recovery(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = dt_str(&Utc::now());
        conn.execute(
            "UPDATE recovery_summary
             SET acknowledged_at=?2, last_seen_sequence=latest_sequence, unread_output_offset=-1
             WHERE session_id=?1",
            params![session_id, now],
        )?;
        Ok(())
    }

    // -- settings / meta ------------------------------------------------------
    pub fn load_settings(&self) -> Result<Settings> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT key,value FROM settings")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let map: std::collections::HashMap<String, String> = rows.filter_map(|r| r.ok()).collect();
        drop(st);
        drop(conn);
        let d = Settings::default();
        let s = Settings {
            log_limit_mib: map
                .get("log_limit_mib")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.log_limit_mib),
            notifications_enabled: map
                .get("notifications_enabled")
                .map(|v| v == "true")
                .unwrap_or(d.notifications_enabled),
            retention_days: map
                .get("retention_days")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.retention_days),
            theme: match map.get("theme").map(String::as_str) {
                Some("dark") => Theme::Dark,
                Some("light") => Theme::Light,
                // Migrate the removed high-contrast option to the closest
                // supported appearance instead of failing old profiles.
                Some("high_contrast") => Theme::Dark,
                _ => Theme::System,
            },
            terminal_font_family: map
                .get("terminal_font_family")
                .cloned()
                .unwrap_or(d.terminal_font_family),
            terminal_font_size: map
                .get("terminal_font_size")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.terminal_font_size),
            reduced_motion: match map.get("reduced_motion").map(String::as_str) {
                Some("on") => ReducedMotion::On,
                Some("off") => ReducedMotion::Off,
                _ => ReducedMotion::System,
            },
            screen_reader_mode: map
                .get("screen_reader_mode")
                .map(|v| v == "true")
                .unwrap_or(d.screen_reader_mode),
            search_index_enabled: map
                .get("search_index_enabled")
                .map(|v| v == "true")
                .unwrap_or(d.search_index_enabled),
            telemetry_enabled: false, // hard constraint, never read from disk
        };
        s.validate()?;
        Ok(s)
    }

    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        s.validate()?;
        let conn = self.conn.lock().unwrap();
        let theme = match s.theme {
            Theme::System => "system",
            Theme::Dark => "dark",
            Theme::Light => "light",
        };
        let rm = match s.reduced_motion {
            ReducedMotion::System => "system",
            ReducedMotion::On => "on",
            ReducedMotion::Off => "off",
        };
        let pairs: [(String, String); 9] = [
            ("log_limit_mib".into(), s.log_limit_mib.to_string()),
            (
                "notifications_enabled".into(),
                s.notifications_enabled.to_string(),
            ),
            ("retention_days".into(), s.retention_days.to_string()),
            ("theme".into(), theme.into()),
            (
                "terminal_font_family".into(),
                s.terminal_font_family.clone(),
            ),
            (
                "terminal_font_size".into(),
                s.terminal_font_size.to_string(),
            ),
            ("reduced_motion".into(), rm.into()),
            (
                "screen_reader_mode".into(),
                s.screen_reader_mode.to_string(),
            ),
            (
                "search_index_enabled".into(),
                s.search_index_enabled.to_string(),
            ),
        ];
        let tx = conn.unchecked_transaction()?;
        for (k, v) in pairs {
            tx.execute(
                "INSERT INTO settings(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![k, v],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn meta_get(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT value FROM app_meta WHERE key=?1",
            params![key],
            |r| r.get(0),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CoreError::Sqlite(e)),
        }
    }

    pub fn meta_set(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_meta(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Builds a default title from the current non-archived Session count of one project.
    pub fn next_default_session_title(&self, project_id: &str, agent: AgentType) -> Result<String> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE project_id=?1 AND archived_at IS NULL",
            params![project_id],
            |r| r.get(0),
        )?;
        let next = count
            .checked_add(1)
            .ok_or_else(|| CoreError::Validation("project session count exhausted".into()))?;
        Ok(format!("{}-{next}", agent.as_str()))
    }

    // -- redaction audit (counts only, PRD 3.7) ------------------------------
    pub fn record_redaction_hits(&self, session_id: &str, hits: u64) -> Result<()> {
        if hits == 0 {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO redaction_audit(session_id,hits,occurred_at) VALUES(?1,?2,?3)",
            params![session_id, hits as i64, dt_str(&Utc::now())],
        )?;
        Ok(())
    }

    /// Total redaction hits per session (diagnostics display; counts only).
    pub fn redaction_hits_total(&self, session_id: &str) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COALESCE(SUM(hits),0) FROM redaction_audit WHERE session_id=?1",
            params![session_id],
            |r| r.get(0),
        )?;
        Ok(n as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids;

    fn db() -> Db {
        Db::open_memory().unwrap()
    }

    fn project(id: &str) -> Project {
        Project {
            id: id.into(),
            name: "demo".into(),
            root_path: format!("/tmp/{id}"),
            git_root_path: Some(format!("/tmp/{id}")),
            created_at: Utc::now(),
        }
    }

    fn session(id: &str, project_id: &str) -> Session {
        Session {
            id: id.into(),
            project_id: project_id.into(),
            worktree_id: None,
            preset_id: "pre_shell_safe".into(),
            title: "test session".into(),
            cwd: "/tmp".into(),
            host_pid: None,
            host_socket: None,
            host_token: ids::new_host_token(),
            lifecycle: Lifecycle::Creating,
            agent_session_id: None,
            resume_precision: ResumePrecision::Unavailable,
            log_path: format!("/tmp/{id}.log"),
            adapter_type: AgentType::Shell,
            command: vec!["/bin/sh".into()],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            archived_at: None,
        }
    }

    #[test]
    fn migrations_are_idempotent_and_versioned() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().to_path_buf());
        {
            let db = Db::open(&paths).unwrap();
            let conn = db.conn().lock().unwrap();
            let v: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(v, schema::MIGRATIONS.len() as i64);
            drop(conn);
            db.add_project(&project("prj_a")).unwrap();
        }
        // reopen: no-op migration, data survives
        let db = Db::open(&paths).unwrap();
        let p = db.get_project("prj_a").unwrap();
        assert_eq!(p.name, "demo");
        assert_eq!(
            db.meta_get("data_model_version").unwrap().as_deref(),
            Some("1")
        );
    }

    #[test]
    fn project_crud_and_duplicate_path_conflict() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        assert!(db.find_project_by_path("/tmp/prj_1").unwrap().is_some());
        let mut dup = project("prj_2");
        dup.root_path = "/tmp/prj_1".into();
        assert!(matches!(db.add_project(&dup), Err(CoreError::Conflict(_))));
        db.rename_project("prj_1", "renamed").unwrap();
        assert_eq!(db.get_project("prj_1").unwrap().name, "renamed");
        assert_eq!(db.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn remove_project_blocked_by_live_sessions() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_1", "prj_1")).unwrap();
        assert!(matches!(
            db.remove_project("prj_1"),
            Err(CoreError::Blocked(_))
        ));
        db.archive_session("ses_1").unwrap();
        db.remove_project("prj_1").unwrap();
        assert!(matches!(
            db.get_project("prj_1"),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn preset_seed_and_builtin_protection() {
        let db = db();
        db.seed_builtin_presets().unwrap();
        db.seed_builtin_presets().unwrap(); // idempotent
        let presets = db.list_presets(None).unwrap();
        assert_eq!(presets.len(), 4);
        assert!(presets
            .iter()
            .all(|p| p.permission_mode == PermissionMode::Native));
        assert!(matches!(
            db.delete_preset("pre_kimi_safe"),
            Err(CoreError::Blocked(_))
        ));
        let custom = Preset {
            id: "pre_custom".into(),
            agent_type: AgentType::Kimi,
            name: "custom".into(),
            executable_path: "/usr/local/bin/kimi".into(),
            args: vec!["--model".into(), "k2".into()],
            permission_mode: PermissionMode::Auto,
            env_names: vec!["FOO".into()],
            secret_ref_ids: vec![],
            built_in: false,
        };
        db.upsert_preset(&custom).unwrap();
        let back = db.get_preset("pre_custom").unwrap();
        assert_eq!(back.args, vec!["--model", "k2"]);
        assert_eq!(back.env_names, vec!["FOO"]);
        db.delete_preset("pre_custom").unwrap();
    }

    #[test]
    fn adapter_snapshot_roundtrip() {
        let db = db();
        let a = AdapterInstall {
            agent_type: AgentType::Kimi,
            executable_path: "/Users/x/.local/bin/kimi".into(),
            version_text: "0.27.0".into(),
            capability_hash: "sha256:abc".into(),
            exact_resume: true,
            hook_status: HookStatus::Supported,
            probed_at: Utc::now(),
            candidates: vec![ProbeCandidate {
                path: "/Users/x/.local/bin/kimi".into(),
                version_text: Some("0.27.0".into()),
                source: "env_path".into(),
            }],
            flags: vec!["session".into(), "continue".into()],
        };
        db.upsert_adapter(&a).unwrap();
        let back = db.get_adapter(AgentType::Kimi).unwrap().unwrap();
        assert!(back.exact_resume);
        assert_eq!(back.flags, vec!["session", "continue"]);
        assert_eq!(back.candidates.len(), 1);
    }

    #[test]
    fn session_lifecycle_updates() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_1", "prj_1")).unwrap();
        let s0 = db.get_session("ses_1").unwrap();
        assert_eq!(s0.lifecycle, Lifecycle::Creating);
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.update_session_lifecycle("ses_1", Lifecycle::Running)
            .unwrap();
        db.update_session_host("ses_1", Some(4242), Some("/tmp/ses_1.sock"))
            .unwrap();
        db.update_session_agent_id("ses_1", "01HZABC", ResumePrecision::Exact)
            .unwrap();
        let s = db.get_session("ses_1").unwrap();
        assert_eq!(s.lifecycle, Lifecycle::Running);
        assert_eq!(s.host_pid, Some(4242));
        assert_eq!(s.agent_session_id.as_deref(), Some("01HZABC"));
        assert_eq!(s.resume_precision, ResumePrecision::Exact);
        assert!(s.updated_at >= s0.updated_at);
        assert!(!db.get_session_token("ses_1").unwrap().is_empty());
        db.rename_session("ses_1", "new title").unwrap();
        assert_eq!(db.get_session("ses_1").unwrap().title, "new title");
        let rs = db.get_recovery_summary("ses_1").unwrap();
        assert_eq!(rs.last_seen_sequence, 0);
    }

    #[test]
    fn generated_title_uses_first_input_once_and_preserves_manual_rename() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_auto", "prj_1")).unwrap();
        db.mark_session_title_auto_generated("ses_auto").unwrap();

        assert!(db
            .auto_rename_session_from_first_input(
                "ses_auto",
                "  请检查这个很长的中文输入内容是否能够正确截断并显示  "
            )
            .unwrap());
        assert_eq!(
            db.get_session("ses_auto").unwrap().title,
            "请检查这个很长的中文输入内容是..."
        );
        assert!(!db
            .auto_rename_session_from_first_input("ses_auto", "第二段输入")
            .unwrap());

        db.insert_session(&session("ses_manual", "prj_1")).unwrap();
        db.mark_session_title_auto_generated("ses_manual").unwrap();
        db.rename_session("ses_manual", "手动命名").unwrap();
        assert!(!db
            .auto_rename_session_from_first_input("ses_manual", "不应覆盖手动标题")
            .unwrap());
        assert_eq!(db.get_session("ses_manual").unwrap().title, "手动命名");
    }

    #[test]
    fn archived_sessions_can_be_restored_or_permanently_purged() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_restore", "prj_1")).unwrap();
        db.archive_session("ses_restore").unwrap();
        db.unarchive_session("ses_restore").unwrap();
        assert!(db.get_session("ses_restore").unwrap().archived_at.is_none());

        db.archive_session("ses_restore").unwrap();
        db.purge_archived_session("ses_restore").unwrap();
        assert!(matches!(
            db.get_session("ses_restore"),
            Err(CoreError::NotFound(_))
        ));

        db.insert_session(&session("ses_purge", "prj_1")).unwrap();
        db.insert_session(&session("ses_live", "prj_1")).unwrap();
        db.archive_session("ses_purge").unwrap();
        assert_eq!(
            db.purge_all_archived_sessions().unwrap(),
            vec!["ses_purge".to_string()]
        );
        assert!(matches!(
            db.get_session("ses_purge"),
            Err(CoreError::NotFound(_))
        ));
        assert!(db.get_session("ses_live").is_ok());
    }

    #[test]
    fn generated_session_titles_use_each_projects_actual_count() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.add_project(&project("prj_2")).unwrap();
        db.insert_session(&session("ses_1", "prj_1")).unwrap();
        db.insert_session(&session("ses_2", "prj_1")).unwrap();
        db.insert_session(&session("ses_3", "prj_2")).unwrap();
        db.archive_session("ses_2").unwrap();

        assert_eq!(
            db.next_default_session_title("prj_1", AgentType::Codex)
                .unwrap(),
            "codex-2"
        );
        assert_eq!(
            db.next_default_session_title("prj_2", AgentType::Kimi)
                .unwrap(),
            "kimi-2"
        );
    }

    #[test]
    fn status_events_idempotent_and_latest_and_summary() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_1", "prj_1")).unwrap();
        let ev = |seq: i64, state: AgentState, evidence: &str| StatusEvent {
            session_id: "ses_1".into(),
            sequence: seq,
            state,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some(evidence.into()),
            occurred_at: Utc::now(),
        };
        db.record_status_event(&ev(1, AgentState::Working, "hook:PreToolUse"))
            .unwrap();
        db.record_status_event(&ev(1, AgentState::Working, "hook:PreToolUse"))
            .unwrap(); // duplicate ignored
        db.record_status_event(&ev(2, AgentState::NeedsInput, "hook:Notification"))
            .unwrap();
        let latest = db.latest_status("ses_1").unwrap().unwrap();
        assert_eq!(latest.sequence, 2);
        assert_eq!(latest.state, AgentState::NeedsInput);
        let rs = db.get_recovery_summary("ses_1").unwrap();
        assert_eq!(rs.latest_sequence, 2);
        assert_eq!(rs.summary_state, SummaryState::Waiting);
        db.record_status_event(&ev(3, AgentState::Exited, "process:exit:0"))
            .unwrap();
        assert_eq!(
            db.get_recovery_summary("ses_1").unwrap().summary_state,
            SummaryState::Completed
        );
        db.record_status_event(&ev(4, AgentState::Exited, "process:signal:9"))
            .unwrap();
        assert_eq!(
            db.get_recovery_summary("ses_1").unwrap().summary_state,
            SummaryState::Failed
        );
        let hist = db.status_history("ses_1", 10).unwrap();
        assert_eq!(hist.len(), 4);
        assert_eq!(hist[0].sequence, 1);
        // events_since
        let evs = db.events_since(&[("ses_1".to_string(), 2)]).unwrap();
        assert_eq!(evs.len(), 2);
        // last seen / acknowledge
        db.set_last_seen_sequence("ses_1", 2).unwrap();
        db.set_unread_offset("ses_1", 4096).unwrap();
        db.acknowledge_recovery("ses_1").unwrap();
        let rs = db.get_recovery_summary("ses_1").unwrap();
        assert_eq!(rs.last_seen_sequence, 4);
        assert!(rs.acknowledged_at.is_some());
    }

    #[test]
    fn unread_facts_ignore_pty_chatter_and_clear_when_seen() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_1", "prj_1")).unwrap();
        assert_eq!(
            db.get_recovery_summary("ses_1")
                .unwrap()
                .unread_output_offset,
            -1
        );

        let event = |seq: i64, state: AgentState, evidence: &str| StatusEvent {
            session_id: "ses_1".into(),
            sequence: seq,
            state,
            source: StateSource::Pty,
            confidence: Confidence::Medium,
            evidence: Some(evidence.into()),
            occurred_at: Utc::now(),
        };
        db.record_status_event(&event(1, AgentState::Working, "pty:activity"))
            .unwrap();
        db.record_status_event(&event(2, AgentState::Idle, "pty:silence:3000ms"))
            .unwrap();
        assert!(!db.has_unread_attention("ses_1", 0).unwrap());

        db.mark_output_unread("ses_1", 42).unwrap();
        db.mark_output_unread("ses_1", 99).unwrap();
        assert_eq!(
            db.get_recovery_summary("ses_1")
                .unwrap()
                .unread_output_offset,
            42
        );

        db.mark_session_seen("ses_1").unwrap();
        let seen = db.get_recovery_summary("ses_1").unwrap();
        assert_eq!(seen.last_seen_sequence, 2);
        assert_eq!(seen.unread_output_offset, -1);

        db.record_status_event(&event(3, AgentState::NeedsInput, "hook:Notification"))
            .unwrap();
        assert!(db
            .has_unread_attention("ses_1", seen.last_seen_sequence)
            .unwrap());
        db.mark_session_seen("ses_1").unwrap();
        assert!(!db.has_unread_attention("ses_1", 3).unwrap());
    }

    #[test]
    fn worktree_crud() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        let w = Worktree {
            id: "wt_1".into(),
            project_id: "prj_1".into(),
            branch: "agent/fix-x".into(),
            base_commit: "abc123".into(),
            base_ref: None,
            path: "/tmp/wt/fix-x".into(),
            health: WorktreeHealth::Clean,
            created_at: Utc::now(),
        };
        db.insert_worktree(&w).unwrap();
        db.set_worktree_health("wt_1", WorktreeHealth::Dirty)
            .unwrap();
        assert_eq!(
            db.get_worktree("wt_1").unwrap().health,
            WorktreeHealth::Dirty
        );
        assert_eq!(db.list_worktrees("prj_1").unwrap().len(), 1);
        db.delete_worktree("wt_1").unwrap();
        assert!(matches!(
            db.get_worktree("wt_1"),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn secret_ref_crud_no_values() {
        let db = db();
        let s = SecretRef {
            id: "sec_1".into(),
            env_name: "KIMI_API_KEY".into(),
            backend: SecretBackend::MacosKeychain,
            service: "agentport".into(),
            account: "pre_kimi_safe:KIMI_API_KEY".into(),
            updated_at: Utc::now(),
        };
        db.upsert_secret_ref(&s).unwrap();
        assert_eq!(db.list_secret_refs().unwrap().len(), 1);
        db.delete_secret_ref("sec_1").unwrap();
        assert!(db.list_secret_refs().unwrap().is_empty());
    }

    #[test]
    fn settings_defaults_validation_roundtrip() {
        let db = db();
        let d = db.load_settings().unwrap();
        assert_eq!(d.log_limit_mib, 100);
        assert_eq!(d.terminal_font_size, 13);
        assert!(!d.telemetry_enabled);
        let mut s = d.clone();
        s.theme = Theme::Dark;
        s.terminal_font_size = 18;
        db.save_settings(&s).unwrap();
        let back = db.load_settings().unwrap();
        assert_eq!(back.theme, Theme::Dark);
        assert_eq!(back.terminal_font_size, 18);
        let mut bad = d;
        bad.telemetry_enabled = true;
        assert!(matches!(
            db.save_settings(&bad),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn removed_high_contrast_setting_migrates_to_dark() {
        let db = db();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES('theme','high_contrast')",
                [],
            )
            .unwrap();
        assert_eq!(db.load_settings().unwrap().theme, Theme::Dark);
    }

    #[test]
    fn redaction_audit_counts_only() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_1", "prj_1")).unwrap();
        db.record_redaction_hits("ses_1", 0).unwrap();
        db.record_redaction_hits("ses_1", 3).unwrap();
        db.record_redaction_hits("ses_1", 2).unwrap();
        assert_eq!(db.redaction_hits_total("ses_1").unwrap(), 5);
    }
}
