//! SQLite persistence (PRD ch.5). Single user, local file, WAL mode.
//! Raw terminal bytes never enter the database — only metadata, status events
//! and derived summaries. Search index lives in the same file (FTS5) and is
//! fully rebuildable from logs + metadata.

use crate::error::{CoreError, Result};
use crate::models::*;
use crate::paths::AppPaths;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection, Row, Transaction, TransactionBehavior};
use std::sync::Mutex;
use std::time::Duration as StdDuration;

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
        // v2 -> v3: a Session ID can be restarted, so state and recovery
        // ordering must include a monotonic per-Session run ordinal. Existing
        // rows remain readable as the reserved `legacy` run (ordinal zero).
        r#"
        CREATE TABLE session_runs (
            session_id TEXT NOT NULL REFERENCES sessions(id),
            run_id TEXT NOT NULL,
            run_ordinal INTEGER NOT NULL CHECK(run_ordinal >= 0),
            created_at TEXT NOT NULL,
            PRIMARY KEY(session_id, run_id),
            UNIQUE(session_id, run_ordinal),
            UNIQUE(session_id, run_id, run_ordinal)
        );
        CREATE INDEX idx_session_runs_session_ordinal
            ON session_runs(session_id, run_ordinal);
        INSERT INTO session_runs(session_id,run_id,run_ordinal,created_at)
            SELECT id,'legacy',0,created_at FROM sessions;

        ALTER TABLE status_events RENAME TO status_events_v2;
        CREATE TABLE status_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            run_ordinal INTEGER NOT NULL CHECK(run_ordinal >= 0),
            sequence INTEGER NOT NULL,
            state TEXT NOT NULL,
            source TEXT NOT NULL,
            confidence TEXT NOT NULL,
            evidence TEXT,
            occurred_at TEXT NOT NULL,
            FOREIGN KEY(session_id,run_id,run_ordinal)
                REFERENCES session_runs(session_id,run_id,run_ordinal),
            UNIQUE(session_id,run_id,sequence)
        );
        INSERT INTO status_events(
            id,session_id,run_id,run_ordinal,sequence,state,source,confidence,evidence,occurred_at
        )
            SELECT id,session_id,'legacy',0,sequence,state,source,confidence,evidence,occurred_at
            FROM status_events_v2;
        DROP TABLE status_events_v2;
        CREATE INDEX idx_status_events_session_run_sequence
            ON status_events(session_id,run_ordinal,sequence);

        ALTER TABLE latest_status ADD COLUMN run_id TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE latest_status ADD COLUMN run_ordinal INTEGER NOT NULL DEFAULT 0;

        ALTER TABLE recovery_summary ADD COLUMN latest_run_id TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE recovery_summary ADD COLUMN latest_run_ordinal INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recovery_summary ADD COLUMN last_seen_run_id TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE recovery_summary ADD COLUMN last_seen_run_ordinal INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recovery_summary ADD COLUMN unread_run_id TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE recovery_summary ADD COLUMN unread_run_ordinal INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recovery_summary ADD COLUMN unread_log_generation INTEGER NOT NULL DEFAULT 0;
        "#,
        // v3 -> v4: filesystem cleanup is durable work after Session rows are
        // removed. Deliberately no Session foreign key: the job outlives it.
        r#"
        CREATE TABLE cleanup_jobs (
            session_id TEXT PRIMARY KEY,
            attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
            last_error TEXT,
            retry_at TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX idx_cleanup_jobs_due
            ON cleanup_jobs(retry_at)
            WHERE retry_at IS NOT NULL;
        "#,
        // v4 -> v5: a stable Session can outlive several Host processes.
        // Keep the active run identity beside the recorded Host PID so a
        // reaper/monitor for an old process cannot terminally transition the
        // Session after a replacement run has been claimed.  Columns remain
        // nullable for pre-v5 hosts, where PID-only matching is the strongest
        // compatibility proof available.
        r#"
        ALTER TABLE sessions ADD COLUMN host_run_id TEXT;
        ALTER TABLE sessions ADD COLUMN host_run_ordinal INTEGER;
        "#,
        // v5 -> v6: durable, stepwise local-branch mutation journal. Stash
        // selectors and markers are operational metadata, never source data.
        // Keep this originally shipped shape immutable; v7 appends the fields
        // required by the transaction-safe implementation.
        r#"
        CREATE TABLE branch_operations (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            repo_key TEXT NOT NULL,
            checkout_root TEXT NOT NULL,
            source_branch TEXT,
            source_commit TEXT NOT NULL,
            target_branch TEXT NOT NULL,
            phase TEXT NOT NULL,
            stash_oid TEXT,
            stash_selector TEXT,
            stash_marker TEXT UNIQUE,
            snapshot_json TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_branch_operations_recovery
            ON branch_operations(repo_key,phase,created_at);
        CREATE TABLE branch_operation_steps (
            operation_id TEXT NOT NULL REFERENCES branch_operations(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL CHECK(sequence > 0),
            phase TEXT NOT NULL,
            detail TEXT,
            occurred_at TEXT NOT NULL,
            PRIMARY KEY(operation_id,sequence)
        );
        "#,
        // v6 -> v7: repair the shape used by an early AgentPort branch-journal
        // development build. That build created the final table names with a
        // smaller column set, so CREATE TABLE IF NOT EXISTS cannot make an
        // existing developer database compatible. The actual idempotent ALTER
        // statements run from `upgrade_legacy_branch_journal_schema` inside
        // this migration transaction.
        r#"SELECT 1;"#,
        // v7 -> v8: record the Host transport selected when a Session was
        // created. Existing terminal Sessions retain the historical PTY
        // behaviour; only Pi may opt into the structured RPC transport.
        r#"
        ALTER TABLE sessions ADD COLUMN transport TEXT NOT NULL DEFAULT 'pty';
        "#,
        // v8 -> v9: retain an event's exact output cursor and the most recent
        // Host-observed log cursor.  A byte offset without a run and generation
        // is not safe recovery-location data after a restart or rotation.
        r#"
        ALTER TABLE status_events ADD COLUMN log_generation INTEGER;
        ALTER TABLE status_events ADD COLUMN log_offset INTEGER;
        ALTER TABLE recovery_summary ADD COLUMN latest_log_run_id TEXT;
        ALTER TABLE recovery_summary ADD COLUMN latest_log_run_ordinal INTEGER;
        ALTER TABLE recovery_summary ADD COLUMN latest_log_generation INTEGER;
        ALTER TABLE recovery_summary ADD COLUMN latest_log_offset INTEGER;
        ALTER TABLE recovery_summary ADD COLUMN latest_log_observed_at TEXT;
        "#,
        // v9 -> v10: durable Git commit recovery evidence. Commit messages and
        // Diff contents are intentionally excluded; hashes are sufficient to
        // reconcile a timeout or crash against the authoritative Git objects.
        r#"
        CREATE TABLE git_commit_operations (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            worktree_id TEXT,
            repo_key TEXT NOT NULL,
            checkout_id TEXT NOT NULL,
            checkout_root TEXT NOT NULL,
            before_head TEXT,
            expected_tree_oid TEXT NOT NULL,
            index_hash TEXT NOT NULL,
            message_hash TEXT NOT NULL,
            phase TEXT NOT NULL,
            result_head TEXT,
            result_tree TEXT,
            error_summary TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
        );
        CREATE INDEX idx_git_commit_operations_recovery
            ON git_commit_operations(repo_key,phase,created_at);
        "#,
    ];
}

// ---------------------------------------------------------------------------
// (de)serialization helpers
// ---------------------------------------------------------------------------

fn dt_str(t: &DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
fn parse_dt(s: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(s)
        .map_err(|e| CoreError::Internal(format!("bad timestamp {s}: {e}")))?
        .with_timezone(&Utc))
}

fn auto_title_pending_key(session_id: &str) -> String {
    format!("session_auto_title_pending:{session_id}")
}

const CLEANUP_RETRY_BASE_SECONDS: i64 = 5;
const CLEANUP_RETRY_MAX_SECONDS: i64 = 60 * 60;
const MAX_CLEANUP_ERROR_CHARS: usize = 240;
/// Multiple GUI projections and the cleanup worker use independent SQLite
/// connections. Give a contending writer time to finish rather than turning a
/// short WAL write-lock collision into a lost session-status projection.
const SQLITE_BUSY_TIMEOUT: StdDuration = StdDuration::from_secs(5);

fn cleanup_retry_delay(attempts: i64) -> Duration {
    let exponent = attempts.saturating_sub(1).min(20) as u32;
    let seconds = CLEANUP_RETRY_BASE_SECONDS
        .saturating_mul(1_i64 << exponent)
        .min(CLEANUP_RETRY_MAX_SECONDS);
    Duration::seconds(seconds)
}

/// Cleanup errors are compact, non-sensitive operational summaries. Paths are
/// rejected because jobs must remain portable after the Session row is gone.
fn cleanup_error_summary(error: &str) -> Result<String> {
    let summary = error.split_whitespace().collect::<Vec<_>>().join(" ");
    if summary.is_empty() {
        return Err(CoreError::Validation(
            "cleanup error must not be empty".into(),
        ));
    }
    if summary.contains('/') || summary.contains('\\') {
        return Err(CoreError::Validation(
            "cleanup error must not contain a filesystem path".into(),
        ));
    }
    if summary.chars().count() > MAX_CLEANUP_ERROR_CHARS {
        return Err(CoreError::Validation(format!(
            "cleanup error exceeds {MAX_CLEANUP_ERROR_CHARS} characters"
        )));
    }
    Ok(summary)
}

fn enqueue_cleanup_job_tx(tx: &Transaction<'_>, id: &str, now: &DateTime<Utc>) -> Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO cleanup_jobs(session_id,attempts,last_error,retry_at,created_at)
         VALUES(?1,0,NULL,?2,?2)",
        params![id, dt_str(now)],
    )?;
    Ok(())
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
    tx.execute("DELETE FROM session_runs WHERE session_id=?1", params![id])?;
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
fn permission_mode(s: &str) -> Result<PermissionMode> {
    Ok(match s {
        "native" => PermissionMode::Native,
        "auto" => PermissionMode::Auto,
        "bypass" => PermissionMode::Bypass,
        other => return Err(CoreError::Internal(format!("bad permission_mode {other}"))),
    })
}

fn agent_transport(s: &str) -> Result<AgentTransport> {
    s.parse()
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
/// - precise approval semantics -> waiting
/// - precise hook/adapter turn-end semantics -> completed
/// - exited code 0 -> completed; exited nonzero/signal/unknown -> failed
/// - anything else -> output
fn summary_state_for(e: &StatusEvent) -> SummaryState {
    let ev = e.evidence.as_deref().unwrap_or("");
    match (e.attention_kind(), e.state) {
        (Some(AttentionKind::ApprovalRequested), _) => SummaryState::Waiting,
        (Some(AttentionKind::TurnCompleted), _) => SummaryState::Completed,
        (None, AgentState::Exited) => {
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
        // v8 added this with a PTY default. Keep fail-safe compatibility with
        // manually repaired or partially migrated local databases.
        transport: r
            .get::<_, String>("transport")
            .ok()
            .and_then(|value| agent_transport(&value).ok())
            .unwrap_or(AgentTransport::Pty),
        created_at: parse(r.get("created_at")?),
        updated_at: parse(r.get("updated_at")?),
        archived_at: r.get::<_, Option<String>>("archived_at")?.map(parse),
    })
}

fn row_status_event(r: &Row) -> rusqlite::Result<StatusEvent> {
    let generation = r.get::<_, Option<i64>>("log_generation").ok().flatten();
    let offset = r.get::<_, Option<i64>>("log_offset").ok().flatten();
    Ok(StatusEvent {
        session_id: r.get("session_id")?,
        run_id: r.get("run_id")?,
        run_ordinal: r.get("run_ordinal")?,
        sequence: r.get("sequence")?,
        state: agent_state(&r.get::<_, String>("state")?).unwrap_or(AgentState::Unknown),
        source: state_source(&r.get::<_, String>("source")?).unwrap_or(StateSource::Process),
        confidence: confidence(&r.get::<_, String>("confidence")?).unwrap_or(Confidence::Low),
        evidence: r.get("evidence")?,
        log_cursor: match (generation, offset) {
            (Some(generation), Some(offset)) => Some(LogCursor {
                run_id: r.get("run_id")?,
                run_ordinal: r.get("run_ordinal")?,
                generation,
                offset,
            }),
            _ => None,
        },
        occurred_at: DateTime::parse_from_rfc3339(&r.get::<_, String>("occurred_at")?)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

fn row_session_run(r: &Row) -> rusqlite::Result<SessionRun> {
    Ok(SessionRun {
        session_id: r.get("session_id")?,
        run_id: r.get("run_id")?,
        run_ordinal: r.get("run_ordinal")?,
        created_at: DateTime::parse_from_rfc3339(&r.get::<_, String>("created_at")?)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

fn row_cleanup_job(r: &Row) -> rusqlite::Result<CleanupJob> {
    let parse = |s: String| {
        DateTime::parse_from_rfc3339(&s)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now())
    };
    Ok(CleanupJob {
        session_id: r.get("session_id")?,
        attempts: r.get("attempts")?,
        last_error: r.get("last_error")?,
        retry_at: r.get::<_, Option<String>>("retry_at")?.map(parse),
        created_at: parse(r.get("created_at")?),
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
    let agent_type = agent_type(&r.get::<_, String>("agent_type")?).unwrap_or(AgentType::Shell);
    Ok(AdapterInstall {
        agent_type,
        executable_path: r.get("executable_path")?,
        version_text: r.get("version_text")?,
        capability_hash: r.get("capability_hash")?,
        exact_resume: r.get("exact_resume")?,
        hook_status: hook_status(&r.get::<_, String>("hook_status")?)
            .unwrap_or(HookStatus::Unavailable),
        approval_model: caps
            .get("approval_model")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| match value {
                "native_prompts" => Some(ApprovalModel::NativePrompts),
                "no_builtin_prompts" => Some(ApprovalModel::NoBuiltinPrompts),
                _ => None,
            })
            .unwrap_or_else(|| agent_type.approval_model()),
        default_transport: caps
            .get("default_transport")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| agent_transport(value).ok())
            .unwrap_or_else(|| agent_type.default_transport()),
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

fn validate_run_identity(run_id: &str, run_ordinal: i64) -> Result<()> {
    if run_id.trim().is_empty() {
        return Err(CoreError::Validation("run_id must not be empty".into()));
    }
    if run_ordinal < 0 {
        return Err(CoreError::Validation(
            "run_ordinal must not be negative".into(),
        ));
    }
    Ok(())
}

fn ensure_recovery_summary_row(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO recovery_summary(
            session_id,last_seen_sequence,latest_sequence,unread_output_offset,summary_state,acknowledged_at
         ) VALUES(?1,0,0,-1,'none',NULL)",
        params![session_id],
    )?;
    Ok(())
}

fn update_latest_log_cursor_tx(
    tx: &Transaction<'_>,
    session_id: &str,
    cursor: &LogCursor,
    observed_at: &DateTime<Utc>,
) -> Result<()> {
    validate_run_identity(&cursor.run_id, cursor.run_ordinal)?;
    if cursor.generation < 0 || cursor.offset < 0 {
        return Err(CoreError::Validation(
            "log generation and offset must not be negative".into(),
        ));
    }
    ensure_recovery_summary_row(tx, session_id)?;
    tx.execute(
        "UPDATE recovery_summary
         SET latest_log_run_id=?2, latest_log_run_ordinal=?3,
             latest_log_generation=?4, latest_log_offset=?5, latest_log_observed_at=?6
         WHERE session_id=?1 AND (
            latest_log_offset IS NULL OR
            ?3 > latest_log_run_ordinal OR
            (?3 = latest_log_run_ordinal AND latest_log_run_id=?2 AND (
                ?4 > latest_log_generation OR
                (?4 = latest_log_generation AND ?5 >= latest_log_offset)
            ))
         )",
        params![
            session_id,
            &cursor.run_id,
            cursor.run_ordinal,
            cursor.generation,
            cursor.offset,
            dt_str(observed_at),
        ],
    )?;
    Ok(())
}

/// Ensure an event references one immutable run identity. This permits a
/// journal import to create its run row on first sight, while rejecting a
/// conflicting run ID/ordinal pair instead of silently merging two launches.
fn ensure_session_run_tx(
    tx: &Transaction<'_>,
    session_id: &str,
    run_id: &str,
    run_ordinal: i64,
    created_at: &DateTime<Utc>,
) -> Result<()> {
    validate_run_identity(run_id, run_ordinal)?;
    match tx.query_row(
        "SELECT run_ordinal FROM session_runs WHERE session_id=?1 AND run_id=?2",
        params![session_id, run_id],
        |r| r.get::<_, i64>(0),
    ) {
        Ok(existing) => {
            if existing != run_ordinal {
                return Err(CoreError::Conflict(format!(
                    "session {session_id} run {run_id} changed ordinal from {existing} to {run_ordinal}"
                )));
            }
            return Ok(());
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(e) => return Err(CoreError::Sqlite(e)),
    }

    match tx.query_row(
        "SELECT run_id FROM session_runs WHERE session_id=?1 AND run_ordinal=?2",
        params![session_id, run_ordinal],
        |r| r.get::<_, String>(0),
    ) {
        Ok(existing) => {
            return Err(CoreError::Conflict(format!(
                "session {session_id} ordinal {run_ordinal} already belongs to run {existing}"
            )));
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(e) => return Err(CoreError::Sqlite(e)),
    }

    tx.execute(
        "INSERT INTO session_runs(session_id,run_id,run_ordinal,created_at)
         VALUES(?1,?2,?3,?4)",
        params![session_id, run_id, run_ordinal, dt_str(created_at)],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Db
// ---------------------------------------------------------------------------

/// Thread-safe handle. All writes go through one connection guarded by a mutex;
/// WAL allows concurrent reads.
pub struct Db {
    conn: Mutex<Connection>,
}

/// The persisted authority lease for the currently claimed Session run.
///
/// `run_id`/`run_ordinal` are absent only for sessions created by versions
/// before the v5 migration.  Callers must treat that shape as PID-only
/// compatibility mode; it must never be upgraded to a guessed run identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionHostBinding {
    pub host_pid: Option<i64>,
    pub run_id: Option<String>,
    pub run_ordinal: Option<i64>,
}

impl SessionHostBinding {
    pub fn run_identity(&self) -> Option<(&str, i64)> {
        self.run_id.as_deref().zip(self.run_ordinal)
    }
}

impl Db {
    /// Open (creating + migrating) the database at the given app paths.
    pub fn open(paths: &AppPaths) -> Result<Self> {
        paths.ensure_layout()?;
        if let Some(parent) = paths.db_path().parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(paths.db_path())?;
        // The DB (and its WAL sidecars) holds session metadata plus live Host
        // tokens. Existing installs may predate restrictive permissions, so
        // repair them on every open, not just at creation.
        crate::paths::AppPaths::restrict_file(&paths.db_path())?;
        crate::paths::AppPaths::restrict_file(&paths.db_path().with_extension("db-wal"))?;
        crate::paths::AppPaths::restrict_file(&paths.db_path().with_extension("db-shm"))?;
        Self::init(conn)
    }

    /// Open an in-memory database (tests).
    pub fn open_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
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
        let latest = schema::MIGRATIONS.len() as i64;
        if current > latest {
            // The database was written by a NEWER AgentPort. Continuing would
            // silently mis-read columns or drop unknown semantics; fail closed
            // and tell the operator exactly what to do instead.
            return Err(CoreError::Conflict(format!(
                "database schema v{current} is newer than this build supports (v{latest}); \
                 upgrade AgentPort or restore a backup instead of downgrading the data"
            )));
        }
        for (i, sql) in schema::MIGRATIONS.iter().enumerate() {
            let ver = (i + 1) as i64;
            if current < ver {
                let tx = conn.unchecked_transaction()?;
                tx.execute_batch(sql)?;
                if ver == 7 {
                    Self::upgrade_legacy_branch_journal_schema(&tx)?;
                }
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

    /// Upgrade the pre-v6-development branch journal without dropping any
    /// operation, stash identity, or step evidence. New installs already have
    /// these columns, so every ALTER is guarded by `pragma_table_info`.
    fn upgrade_legacy_branch_journal_schema(tx: &Transaction<'_>) -> Result<()> {
        fn has_column(tx: &Transaction<'_>, table: &str, column: &str) -> Result<bool> {
            Ok(tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                params![table, column],
                |row| row.get(0),
            )?)
        }

        let legacy_missing_target_oid = !has_column(tx, "branch_operations", "target_oid")?;
        let legacy_error_column = has_column(tx, "branch_operations", "error")?;

        if !has_column(tx, "branch_operations", "kind")? {
            tx.execute_batch(
                "ALTER TABLE branch_operations
                 ADD COLUMN kind TEXT NOT NULL DEFAULT 'switch';",
            )?;
        }
        if !has_column(tx, "branch_operations", "target_oid")? {
            // An empty OID deliberately fails later exact-location checks. It
            // keeps an old recoverable stash visible without guessing a target.
            tx.execute_batch(
                "ALTER TABLE branch_operations
                 ADD COLUMN target_oid TEXT NOT NULL DEFAULT '';",
            )?;
        }
        if !has_column(tx, "branch_operations", "error_json")? {
            tx.execute_batch("ALTER TABLE branch_operations ADD COLUMN error_json TEXT;")?;
        }
        if !has_column(tx, "branch_operations", "completed_at")? {
            tx.execute_batch("ALTER TABLE branch_operations ADD COLUMN completed_at TEXT;")?;
        }
        if !has_column(tx, "branch_operation_steps", "head_json")? {
            tx.execute_batch("ALTER TABLE branch_operation_steps ADD COLUMN head_json TEXT;")?;
        }
        if !has_column(tx, "branch_operation_steps", "status_token")? {
            tx.execute_batch("ALTER TABLE branch_operation_steps ADD COLUMN status_token TEXT;")?;
        }

        if legacy_missing_target_oid {
            // The early journal did not pin the target ref, so no automatic
            // target restore can be proven safe after upgrade. Preserve every
            // row and stash marker, but terminalize it only through explicit
            // recovery. Keep the legacy free-text error as structured JSON.
            let rows = if legacy_error_column {
                let mut statement = tx.prepare(
                    "SELECT id,phase,error,updated_at FROM branch_operations ORDER BY created_at",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            } else {
                let mut statement = tx.prepare(
                    "SELECT id,phase,NULL,updated_at FROM branch_operations ORDER BY created_at",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };

            for (id, phase, legacy_error, updated_at) in rows {
                if matches!(phase.as_str(), "completed" | "failed") {
                    let error_json = legacy_error
                        .map(|message| serde_json::json!({"message": message}).to_string());
                    tx.execute(
                        "UPDATE branch_operations
                         SET error_json=COALESCE(error_json,?2),
                             completed_at=COALESCE(completed_at,?3)
                         WHERE id=?1",
                        params![id, error_json, updated_at],
                    )?;
                } else {
                    let mut diagnostic = serde_json::json!({
                        "message": "legacy branch journal lacks a pinned target OID; automatic restore is disabled",
                        "migration": "v6_to_v7"
                    });
                    if let Some(message) = legacy_error {
                        diagnostic["legacyError"] = serde_json::Value::String(message);
                    }
                    tx.execute(
                        "UPDATE branch_operations
                         SET phase='recovery_required',error_json=?2
                         WHERE id=?1",
                        params![id, diagnostic.to_string()],
                    )?;
                }
            }
        }
        Ok(())
    }

    pub fn conn(&self) -> &Mutex<Connection> {
        &self.conn
    }

    /// Write a consistent snapshot of the full database (including WAL state)
    /// to `dest` using SQLite's online backup API. This never blocks readers
    /// for long and never touches the live file — the only supported way to
    /// capture a restorable copy while the app is running.
    pub fn backup_snapshot(&self, dest: &std::path::Path) -> Result<()> {
        if dest.exists() {
            return Err(CoreError::Conflict(format!(
                "backup snapshot destination already exists: {}",
                dest.display()
            )));
        }
        let mut target = Connection::open(dest)?;
        {
            let conn = self.conn.lock().unwrap();
            let backup = rusqlite::backup::Backup::new(&conn, &mut target)?;
            backup.run_to_completion(32, std::time::Duration::from_millis(50), None)?;
        }
        crate::paths::AppPaths::restrict_file(dest)?;
        Ok(())
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
        // Fail closed: a corrupt row must surface as an error, not silently
        // hide a project (and its sessions) from the tree.
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
        let project_exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
            params![id],
            |r| r.get(0),
        )?;
        if project_exists == 0 {
            return Err(CoreError::NotFound(format!("project {id}")));
        }
        // Block while ANY session (active or archived) references the project.
        // Archived sessions must be restored or permanently deleted through the
        // explicit archive flows first — silently dropping their rows here would
        // orphan the on-disk session directories and destroy recovery evidence.
        let live: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE project_id=?1",
            params![id],
            |r| r.get(0),
        )?;
        if live > 0 {
            return Err(CoreError::Blocked(format!(
                "project {id} still has {live} session(s); restore or permanently delete them first"
            )));
        }
        // A Worktree is both a Git registration and a directory outside the
        // project checkout. Dropping only its database row would make the
        // Worktree disappear from AgentPort while leaving Git and disk state
        // behind, so users must remove Worktrees through the dedicated safe
        // flow before removing the project record.
        let worktrees: i64 = conn.query_row(
            "SELECT COUNT(*) FROM worktrees WHERE project_id=?1",
            params![id],
            |r| r.get(0),
        )?;
        if worktrees > 0 {
            return Err(CoreError::Blocked(format!(
                "project {id} still has {worktrees} Worktree(s); remove them first"
            )));
        }
        let pending_checkout_roots = {
            let mut statement = conn.prepare(
                "SELECT checkout_root FROM branch_operations
                 WHERE project_id=?1 AND phase NOT IN ('completed','failed')",
            )?;
            let roots = statement
                .query_map(params![id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            roots
        };
        // A missing operation checkout makes recovery impossible. Its journal
        // is stale metadata, so do not let it permanently trap the project in
        // the sidebar. An operation remains protected while its own checkout
        // exists, even if the project root has since drifted or disappeared.
        let recoverable_operations = pending_checkout_roots
            .iter()
            .filter(|root| std::path::Path::new(root).exists())
            .count();
        if recoverable_operations > 0 {
            return Err(CoreError::Blocked(format!(
                "project {id} still has {recoverable_operations} recoverable branch operation(s)"
            )));
        }
        let pending_commits: i64 = conn.query_row(
            "SELECT COUNT(*) FROM git_commit_operations
             WHERE project_id=?1 AND phase='started'",
            params![id],
            |r| r.get(0),
        )?;
        if pending_commits > 0 {
            return Err(CoreError::Blocked(format!(
                "project {id} still has {pending_commits} unresolved Git commit operation(s)"
            )));
        }
        // Clean dependent rows first (FK constraints), then the project.
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
        conn.execute(
            "DELETE FROM session_runs WHERE session_id IN (SELECT id FROM sessions WHERE project_id=?1)",
            params![id],
        )?;
        conn.execute("DELETE FROM sessions WHERE project_id=?1", params![id])?;
        conn.execute(
            "DELETE FROM branch_operation_steps
             WHERE operation_id IN (SELECT id FROM branch_operations WHERE project_id=?1)",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM branch_operations WHERE project_id=?1",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM git_commit_operations WHERE project_id=?1",
            params![id],
        )?;
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
            "approval_model": a.approval_model.as_str(),
            "default_transport": a.default_transport.as_str(),
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
                a.hook_status.as_str(),
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
            ("pre_qoder_safe", AgentType::Qoder, "Qoder 全权限默认"),
            ("pre_pi_safe", AgentType::Pi, "Pi 本地权限默认"),
            ("pre_shell_safe", AgentType::Shell, "Shell 安全默认"),
        ] {
            let p = Preset {
                id: id.into(),
                agent_type: t,
                name: name.into(),
                executable_path: String::new(), // filled after CLI probing
                args: vec![],
                permission_mode: t.default_permission_mode(),
                env_names: vec![],
                secret_ref_ids: vec![],
                built_in: true,
            };
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO presets(id,agent_type,name,executable_path,args_json,permission_mode,env_names_json,secret_ref_ids_json,built_in)
                 VALUES(?1,?2,?3,'','[]',?4,'[]','[]',1)",
                params![p.id, p.agent_type.as_str(), p.name, p.permission_mode.as_str()],
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
        self.delete_worktree_after(id, || Ok(()))
    }

    /// Run the filesystem/Git removal while the database mutex protects the
    /// final "no Session references this Worktree" check. This closes the race
    /// where a Session could otherwise be created after a preflight but before
    /// the Worktree row is deleted.
    pub fn delete_worktree_after<F>(&self, id: &str, remove: F) -> Result<()>
    where
        F: FnOnce() -> Result<()>,
    {
        let conn = self.conn.lock().unwrap();
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM worktrees WHERE id=?1)",
            params![id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(CoreError::NotFound(format!("worktree {id}")));
        }
        let references: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE worktree_id=?1",
            params![id],
            |r| r.get(0),
        )?;
        if references > 0 {
            return Err(CoreError::Blocked(format!(
                "worktree {id} is still used by {references} session(s); archive does not remove this dependency"
            )));
        }
        remove()?;
        let n = conn.execute("DELETE FROM worktrees WHERE id=?1", params![id])?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("worktree {id}")));
        }
        Ok(())
    }

    pub fn worktree_session_counts(&self, id: &str) -> Result<(usize, usize)> {
        let conn = self.conn.lock().unwrap();
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM worktrees WHERE id=?1)",
            params![id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(CoreError::NotFound(format!("worktree {id}")));
        }
        let (all, active): (i64, i64) = conn.query_row(
            "SELECT COUNT(*),
                    SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END)
             FROM sessions WHERE worktree_id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
        )?;
        Ok((all as usize, active as usize))
    }

    pub fn project_dependency_counts(&self, id: &str) -> Result<(usize, usize, usize)> {
        let conn = self.conn.lock().unwrap();
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
            params![id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(CoreError::NotFound(format!("project {id}")));
        }
        let sessions: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE project_id=?1",
            params![id],
            |r| r.get(0),
        )?;
        let worktrees: i64 = conn.query_row(
            "SELECT COUNT(*) FROM worktrees WHERE project_id=?1",
            params![id],
            |r| r.get(0),
        )?;
        let pending_checkout_roots = {
            let mut statement = conn.prepare(
                "SELECT checkout_root FROM branch_operations
                 WHERE project_id=?1 AND phase NOT IN ('completed','failed')",
            )?;
            let roots = statement
                .query_map(params![id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            roots
        };
        let recoverable_operations = pending_checkout_roots
            .iter()
            .filter(|root| std::path::Path::new(root).exists())
            .count();
        Ok((
            sessions as usize,
            worktrees as usize,
            recoverable_operations,
        ))
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
            "INSERT INTO sessions(id,project_id,worktree_id,preset_id,title,cwd,host_pid,host_socket,host_token,lifecycle,agent_session_id,resume_precision,log_path,adapter_type,command_json,permission_mode,transport,created_at,updated_at,archived_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
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
                s.transport.as_str(),
                dt_str(&s.created_at),
                dt_str(&s.updated_at),
                s.archived_at.map(|t| dt_str(&t)),
            ],
        )?;
        ensure_recovery_summary_row(&tx, &s.id)?;
        tx.execute(
            "INSERT OR IGNORE INTO session_runs(session_id,run_id,run_ordinal,created_at)
             VALUES(?1,?2,?3,?4)",
            params![
                s.id,
                LEGACY_RUN_ID,
                LEGACY_RUN_ORDINAL,
                dt_str(&s.created_at)
            ],
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
        let rows: Vec<Session> = match project_id {
            Some(p) => st
                .query_map(params![p], row_session)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            None => st
                .query_map([], row_session)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        };
        Ok(rows)
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

    /// Return the currently claimed run and (once spawned) its Host PID.
    ///
    /// A binding with a run but no PID is the short pre-spawn window owned by
    /// `claim_session_run`. A fully absent run identity is the only supported
    /// legacy shape; a partially populated identity is corrupt and fails
    /// closed rather than weakening a lifecycle CAS to PID-only matching.
    pub fn session_host_binding(&self, id: &str) -> Result<SessionHostBinding> {
        let conn = self.conn.lock().unwrap();
        let binding = conn
            .query_row(
                "SELECT host_pid,host_run_id,host_run_ordinal FROM sessions WHERE id=?1",
                params![id],
                |r| {
                    Ok(SessionHostBinding {
                        host_pid: r.get(0)?,
                        run_id: r.get(1)?,
                        run_ordinal: r.get(2)?,
                    })
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    CoreError::NotFound(format!("session {id}"))
                }
                other => CoreError::Sqlite(other),
            })?;

        match (&binding.run_id, binding.run_ordinal) {
            (Some(run_id), Some(run_ordinal)) => validate_run_identity(run_id, run_ordinal)?,
            (None, None) => {}
            _ => {
                return Err(CoreError::Conflict(format!(
                    "session {id} has an incomplete active host-run identity"
                )))
            }
        }
        Ok(binding)
    }

    /// Claim a new durable run before starting its Host process. This is the
    /// generation fence: once it commits, an old Host's reaper cannot mutate
    /// the Session, even during the interval before the replacement obtains a
    /// PID or accepts its first socket handshake.
    pub fn claim_session_run(
        &self,
        id: &str,
        run_id: &str,
        run_ordinal: i64,
        log_path: &str,
    ) -> Result<()> {
        validate_run_identity(run_id, run_ordinal)?;
        if log_path.is_empty() {
            return Err(CoreError::Validation(
                "session log path must not be empty".into(),
            ));
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session_exists: i64 = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
            params![id],
            |r| r.get(0),
        )?;
        if session_exists == 0 {
            return Err(CoreError::NotFound(format!("session {id}")));
        }
        let run_exists: i64 = tx.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM session_runs
                WHERE session_id=?1 AND run_id=?2 AND run_ordinal=?3
             )",
            params![id, run_id, run_ordinal],
            |r| r.get(0),
        )?;
        if run_exists == 0 {
            return Err(CoreError::Conflict(format!(
                "session {id} run {run_id}/{run_ordinal} was not reserved"
            )));
        }
        tx.execute(
            "UPDATE sessions
             SET host_pid=NULL, host_socket=NULL,
                 host_run_id=?2, host_run_ordinal=?3,
                 log_path=?4, lifecycle='creating', updated_at=?5
             WHERE id=?1",
            params![id, run_id, run_ordinal, log_path, dt_str(&Utc::now())],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Bind the PID/socket after the claimed run has spawned. `false` means a
    /// newer run replaced this claim (or the Session is no longer creating),
    /// so the caller must tear down its newly spawned process without changing
    /// the newer Session lifecycle.
    pub fn bind_session_host_for_run(
        &self,
        id: &str,
        run_id: &str,
        run_ordinal: i64,
        host_pid: i64,
        socket: &str,
    ) -> Result<bool> {
        validate_run_identity(run_id, run_ordinal)?;
        if host_pid <= 0 {
            return Err(CoreError::Validation("host pid must be positive".into()));
        }
        if socket.is_empty() {
            return Err(CoreError::Validation(
                "host socket must not be empty".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions
             SET host_pid=?4, host_socket=?5, updated_at=?6
             WHERE id=?1 AND host_run_id=?2 AND host_run_ordinal=?3
               AND lifecycle='creating'",
            params![
                id,
                run_id,
                run_ordinal,
                host_pid,
                socket,
                dt_str(&Utc::now())
            ],
        )?;
        Ok(n > 0)
    }

    /// Compare-and-set a Session lifecycle using the Host process and, when
    /// available, its durable run identity. A `false` result is a benign stale
    /// observation (including an already-terminal Session), never an error.
    ///
    /// `expected_run=None` is the legacy v1 fallback: its wire protocol has no
    /// run identity, so PID matching is the strongest available proof. v2
    /// callers must always pass `Some`; doing otherwise deliberately gives up
    /// the run-generation fence only for compatibility with an older Host.
    pub fn update_session_lifecycle_if_host(
        &self,
        id: &str,
        expected_host_pid: i64,
        expected_run: Option<(&str, i64)>,
        lifecycle: Lifecycle,
    ) -> Result<bool> {
        if expected_host_pid <= 0 {
            return Err(CoreError::Validation(
                "expected host pid must be positive".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        let now = dt_str(&Utc::now());
        let n = match expected_run {
            Some((run_id, run_ordinal)) => {
                validate_run_identity(run_id, run_ordinal)?;
                conn.execute(
                    "UPDATE sessions SET lifecycle=?5, updated_at=?6
                     WHERE id=?1 AND host_pid=?2
                       AND host_run_id=?3 AND host_run_ordinal=?4
                       AND lifecycle IN ('creating','running','interrupted')",
                    params![
                        id,
                        expected_host_pid,
                        run_id,
                        run_ordinal,
                        lifecycle.as_str(),
                        now
                    ],
                )?
            }
            None => conn.execute(
                "UPDATE sessions SET lifecycle=?3, updated_at=?4
                 WHERE id=?1 AND host_pid=?2
                   AND lifecycle IN ('creating','running','interrupted')",
                params![id, expected_host_pid, lifecycle.as_str(), now],
            )?,
        };
        Ok(n > 0)
    }

    /// Records a verified Host interruption as a durable recovery fact while
    /// moving the matching live Session to `Interrupted`.  This is deliberately
    /// one transaction: a second reconciliation pass, or a replacement Host,
    /// cannot create a duplicate pseudo-exit event for the same run.
    ///
    /// `evidence` describes how the Host death was proved (for example a
    /// reaper observed its child exit, or the recorded PID no longer exists).
    /// It must never be used for a mere socket/transport failure.
    pub fn mark_host_interrupted_and_record(
        &self,
        id: &str,
        expected_host_pid: i64,
        expected_run_id: &str,
        expected_run_ordinal: i64,
        evidence: &str,
    ) -> Result<bool> {
        validate_run_identity(expected_run_id, expected_run_ordinal)?;
        if expected_host_pid <= 0 {
            return Err(CoreError::Validation(
                "expected host pid must be positive".into(),
            ));
        }
        if !evidence.starts_with("host:interrupted:") {
            return Err(CoreError::Validation(
                "interruption evidence must identify a verified host interruption".into(),
            ));
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Utc::now();
        let terminal_event_already_recorded: i64 = tx.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM status_events
                WHERE session_id=?1 AND run_id=?2 AND run_ordinal=?3
                  AND state='exited'
             )",
            params![id, expected_run_id, expected_run_ordinal],
            |r| r.get(0),
        )?;
        if terminal_event_already_recorded != 0 {
            // A journaled terminal fact wins over a later Host-disappearance
            // inference. Do not manufacture an interruption or leave the
            // Session lifecycle contradicting that already-durable fact.
            let changed = tx.execute(
                "UPDATE sessions SET lifecycle='exited', updated_at=?5
                 WHERE id=?1 AND host_pid=?2
                   AND host_run_id=?3 AND host_run_ordinal=?4
                   AND lifecycle IN ('creating','running')",
                params![
                    id,
                    expected_host_pid,
                    expected_run_id,
                    expected_run_ordinal,
                    dt_str(&now),
                ],
            )?;
            tx.commit()?;
            return Ok(changed > 0);
        }
        let changed = tx.execute(
            "UPDATE sessions SET lifecycle='interrupted', updated_at=?5
             WHERE id=?1 AND host_pid=?2
               AND host_run_id=?3 AND host_run_ordinal=?4
               AND lifecycle IN ('creating','running')",
            params![
                id,
                expected_host_pid,
                expected_run_id,
                expected_run_ordinal,
                dt_str(&now),
            ],
        )?;
        if changed == 0 {
            tx.commit()?;
            return Ok(false);
        }
        ensure_session_run_tx(&tx, id, expected_run_id, expected_run_ordinal, &now)?;
        let event_log_cursor = match tx.query_row(
            "SELECT latest_log_generation,latest_log_offset
             FROM recovery_summary
             WHERE session_id=?1 AND latest_log_run_id=?2
               AND latest_log_run_ordinal=?3 AND latest_log_offset>=0",
            params![id, expected_run_id, expected_run_ordinal],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        ) {
            Ok((generation, offset)) if generation >= 0 && offset >= 0 => Some(LogCursor {
                run_id: expected_run_id.to_string(),
                run_ordinal: expected_run_ordinal,
                generation,
                offset,
            }),
            Ok(_) | Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(error) => return Err(CoreError::Sqlite(error)),
        };
        let sequence: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM status_events
             WHERE session_id=?1 AND run_id=?2",
            params![id, expected_run_id],
            |r| r.get(0),
        )?;
        let occurred_at = dt_str(&now);
        tx.execute(
            "INSERT INTO status_events(
                session_id,run_id,run_ordinal,sequence,state,source,confidence,evidence,
                log_generation,log_offset,occurred_at
             ) VALUES(?1,?2,?3,?4,'exited','process','high',?5,?6,?7,?8)",
            params![
                id,
                expected_run_id,
                expected_run_ordinal,
                sequence,
                evidence,
                event_log_cursor.as_ref().map(|cursor| cursor.generation),
                event_log_cursor.as_ref().map(|cursor| cursor.offset),
                occurred_at,
            ],
        )?;
        tx.execute(
            "INSERT INTO latest_status(
                session_id,run_id,run_ordinal,sequence,state,source,confidence,occurred_at
             ) VALUES(?1,?2,?3,?4,'exited','process','high',?5)
             ON CONFLICT(session_id) DO UPDATE SET
                run_id=excluded.run_id,run_ordinal=excluded.run_ordinal,
                sequence=excluded.sequence,state=excluded.state,source=excluded.source,
                confidence=excluded.confidence,occurred_at=excluded.occurred_at
             WHERE excluded.run_ordinal > latest_status.run_ordinal
                OR (excluded.run_ordinal=latest_status.run_ordinal
                    AND excluded.sequence >= latest_status.sequence)",
            params![
                id,
                expected_run_id,
                expected_run_ordinal,
                sequence,
                occurred_at
            ],
        )?;
        ensure_recovery_summary_row(&tx, id)?;
        tx.execute(
            "UPDATE recovery_summary
             SET latest_run_id=?2,latest_run_ordinal=?3,latest_sequence=?4,
                 summary_state='failed',acknowledged_at=NULL
             WHERE session_id=?1 AND (
                ?3 > latest_run_ordinal OR
                (?3=latest_run_ordinal AND ?4>=latest_sequence)
             )",
            params![id, expected_run_id, expected_run_ordinal, sequence],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// CAS used before a Host PID exists. It shares the same terminal-state
    /// guard as `update_session_lifecycle_if_host`, but is keyed by the run
    /// claim made before spawning the Host.
    pub fn update_session_lifecycle_if_run(
        &self,
        id: &str,
        expected_run_id: &str,
        expected_run_ordinal: i64,
        lifecycle: Lifecycle,
    ) -> Result<bool> {
        validate_run_identity(expected_run_id, expected_run_ordinal)?;
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions SET lifecycle=?4, updated_at=?5
             WHERE id=?1 AND host_run_id=?2 AND host_run_ordinal=?3
               AND lifecycle IN ('creating','running','interrupted')",
            params![
                id,
                expected_run_id,
                expected_run_ordinal,
                lifecycle.as_str(),
                dt_str(&Utc::now())
            ],
        )?;
        Ok(n > 0)
    }

    /// Compatibility CAS for a pre-v5 Session that has neither a recorded
    /// PID nor a run identity. New launches always claim a run first, so this
    /// cannot overwrite a concurrent modern launch.
    pub fn update_session_lifecycle_if_unbound(
        &self,
        id: &str,
        lifecycle: Lifecycle,
    ) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions SET lifecycle=?2, updated_at=?3
             WHERE id=?1 AND host_pid IS NULL
               AND host_run_id IS NULL AND host_run_ordinal IS NULL
               AND lifecycle IN ('creating','running','interrupted')",
            params![id, lifecycle.as_str(), dt_str(&Utc::now())],
        )?;
        Ok(n > 0)
    }

    pub fn update_session_host(
        &self,
        id: &str,
        pid: Option<i64>,
        socket: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions
             SET host_pid=?2, host_socket=?3,
                 host_run_id=NULL, host_run_ordinal=NULL,
                 updated_at=?4
             WHERE id=?1",
            params![id, pid, socket, dt_str(&Utc::now())],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    /// Point a Session at the output log for its current Host run. Historical
    /// runs keep their own immutable paths under the Session directory; this
    /// field is intentionally only the active tail/search target.
    pub fn update_session_log_path(&self, id: &str, log_path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions SET log_path=?2, updated_at=?3 WHERE id=?1",
            params![id, log_path, dt_str(&Utc::now())],
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
        enqueue_cleanup_job_tx(&tx, id, &Utc::now())?;
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
        let now = Utc::now();
        for id in &ids {
            enqueue_cleanup_job_tx(&tx, id, &now)?;
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
        tx.execute(
            "DELETE FROM session_runs WHERE session_id IN
             (SELECT id FROM sessions WHERE archived_at IS NOT NULL)",
            [],
        )?;
        tx.execute("DELETE FROM sessions WHERE archived_at IS NOT NULL", [])?;
        tx.commit()?;
        Ok(ids)
    }

    // -- cleanup jobs -------------------------------------------------------

    /// Lists cleanup work whose retry deadline has arrived. Exhausted jobs
    /// have a NULL retry time and remain persisted for operator inspection.
    pub fn list_due_cleanup_jobs(&self, now: DateTime<Utc>) -> Result<Vec<CleanupJob>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(
            "SELECT session_id,attempts,last_error,retry_at,created_at
             FROM cleanup_jobs
             WHERE retry_at IS NOT NULL AND retry_at <= ?1
             ORDER BY retry_at, session_id",
        )?;
        let rows = st.query_map(params![dt_str(&now)], row_cleanup_job)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Marks durable post-purge cleanup as complete. Deletion is idempotent so
    /// a worker can safely repeat acknowledgement after a crash.
    pub fn mark_cleanup_job_success(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM cleanup_jobs WHERE session_id=?1",
            params![session_id],
        )?;
        Ok(())
    }

    /// Records a retryable cleanup failure and schedules capped exponential
    /// backoff. Once the attempt budget is reached, `retry_at` becomes NULL.
    pub fn record_cleanup_job_retry(
        &self,
        session_id: &str,
        error: &str,
        now: DateTime<Utc>,
    ) -> Result<CleanupJob> {
        let error = cleanup_error_summary(error)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let attempts: i64 = match tx.query_row(
            "SELECT attempts FROM cleanup_jobs WHERE session_id=?1",
            params![session_id],
            |r| r.get(0),
        ) {
            Ok(attempts) => attempts,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                return Err(CoreError::NotFound(format!("cleanup job {session_id}")));
            }
            Err(error) => return Err(CoreError::Sqlite(error)),
        };
        let attempts = attempts.saturating_add(1).min(MAX_CLEANUP_JOB_ATTEMPTS);
        let retry_at =
            (attempts < MAX_CLEANUP_JOB_ATTEMPTS).then(|| now + cleanup_retry_delay(attempts));
        tx.execute(
            "UPDATE cleanup_jobs SET attempts=?2,last_error=?3,retry_at=?4 WHERE session_id=?1",
            params![session_id, attempts, error, retry_at.as_ref().map(dt_str),],
        )?;
        let job = tx.query_row(
            "SELECT session_id,attempts,last_error,retry_at,created_at
             FROM cleanup_jobs WHERE session_id=?1",
            params![session_id],
            row_cleanup_job,
        )?;
        tx.commit()?;
        Ok(job)
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

    // -- Session runs --------------------------------------------------------

    /// Allocates the next non-legacy run for a stable Session ID. Repeating a
    /// request with the same run ID is idempotent and returns the original row.
    pub fn create_session_run(&self, session_id: &str, run_id: &str) -> Result<SessionRun> {
        if run_id == LEGACY_RUN_ID {
            return Err(CoreError::Validation(
                "legacy run_id is reserved for migrated state".into(),
            ));
        }
        validate_run_identity(run_id, 1)?;

        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session_exists: i64 = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
            params![session_id],
            |r| r.get(0),
        )?;
        if session_exists == 0 {
            return Err(CoreError::NotFound(format!("session {session_id}")));
        }

        match tx.query_row(
            "SELECT session_id,run_id,run_ordinal,created_at
             FROM session_runs WHERE session_id=?1 AND run_id=?2",
            params![session_id, run_id],
            row_session_run,
        ) {
            Ok(existing) => {
                tx.commit()?;
                return Ok(existing);
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(e) => return Err(CoreError::Sqlite(e)),
        }

        let last_ordinal: Option<i64> = tx.query_row(
            "SELECT MAX(run_ordinal) FROM session_runs WHERE session_id=?1",
            params![session_id],
            |r| r.get(0),
        )?;
        let run_ordinal = last_ordinal
            .unwrap_or(LEGACY_RUN_ORDINAL)
            .checked_add(1)
            .ok_or_else(|| {
                CoreError::Validation(format!("session {session_id} run ordinal exhausted"))
            })?;
        let created_at = Utc::now();
        tx.execute(
            "INSERT INTO session_runs(session_id,run_id,run_ordinal,created_at)
             VALUES(?1,?2,?3,?4)",
            params![session_id, run_id, run_ordinal, dt_str(&created_at)],
        )?;
        tx.commit()?;
        Ok(SessionRun {
            session_id: session_id.into(),
            run_id: run_id.into(),
            run_ordinal,
            created_at,
        })
    }

    pub fn get_session_run(&self, session_id: &str, run_id: &str) -> Result<SessionRun> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT session_id,run_id,run_ordinal,created_at
             FROM session_runs WHERE session_id=?1 AND run_id=?2",
            params![session_id, run_id],
            row_session_run,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                CoreError::NotFound(format!("session {session_id} run {run_id}"))
            }
            other => CoreError::Sqlite(other),
        })
    }

    pub fn list_session_runs(&self, session_id: &str) -> Result<Vec<SessionRun>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(
            "SELECT session_id,run_id,run_ordinal,created_at
             FROM session_runs WHERE session_id=?1 ORDER BY run_ordinal",
        )?;
        let rows = st.query_map(params![session_id], row_session_run)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // -- status events --------------------------------------------------------
    pub fn record_status_event(&self, e: &StatusEvent) -> Result<()> {
        if let Some(cursor) = e.log_cursor.as_ref() {
            validate_run_identity(&cursor.run_id, cursor.run_ordinal)?;
            if cursor.run_id != e.run_id || cursor.run_ordinal != e.run_ordinal {
                return Err(CoreError::Validation(format!(
                    "status event run {}/{} does not match log cursor run {}/{}",
                    e.run_id, e.run_ordinal, cursor.run_id, cursor.run_ordinal
                )));
            }
        }
        let mut conn = self.conn.lock().unwrap();
        // Acquire the write reservation before `ensure_session_run_tx` reads.
        // A deferred transaction can otherwise fail its read-to-write upgrade
        // immediately when another monitor commits between those operations.
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_session_run_tx(&tx, &e.session_id, &e.run_id, e.run_ordinal, &e.occurred_at)?;
        let occurred_at = dt_str(&e.occurred_at);
        let changed = tx.execute(
            "INSERT OR IGNORE INTO status_events(
                session_id,run_id,run_ordinal,sequence,state,source,confidence,evidence,
                log_generation,log_offset,occurred_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                &e.session_id,
                &e.run_id,
                e.run_ordinal,
                e.sequence,
                e.state.as_str(),
                e.source.as_str(),
                e.confidence.as_str(),
                &e.evidence,
                e.log_cursor.as_ref().map(|cursor| cursor.generation),
                e.log_cursor.as_ref().map(|cursor| cursor.offset),
                &occurred_at
            ],
        )?;
        if changed > 0 {
            tx.execute(
                "INSERT INTO latest_status(
                    session_id,run_id,run_ordinal,sequence,state,source,confidence,occurred_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(session_id) DO UPDATE SET
                   run_id=excluded.run_id, run_ordinal=excluded.run_ordinal,
                   sequence=excluded.sequence,
                   state=excluded.state, source=excluded.source, confidence=excluded.confidence,
                   occurred_at=excluded.occurred_at
                 WHERE excluded.run_ordinal > latest_status.run_ordinal
                    OR (excluded.run_ordinal = latest_status.run_ordinal
                        AND excluded.sequence >= latest_status.sequence)",
                params![
                    &e.session_id,
                    &e.run_id,
                    e.run_ordinal,
                    e.sequence,
                    e.state.as_str(),
                    e.source.as_str(),
                    e.confidence.as_str(),
                    &occurred_at
                ],
            )?;
            if let Some(cursor) = e.log_cursor.as_ref() {
                update_latest_log_cursor_tx(&tx, &e.session_id, cursor, &e.occurred_at)?;
            }
            ensure_recovery_summary_row(&tx, &e.session_id)?;
            let summary = summary_state_for(e);
            tx.execute(
                "UPDATE recovery_summary
                 SET latest_run_id=?2, latest_run_ordinal=?3, latest_sequence=?4,
                     summary_state=?5, acknowledged_at=NULL
                 WHERE session_id=?1 AND (
                    ?3 > latest_run_ordinal OR
                    (?3 = latest_run_ordinal AND ?4 >= latest_sequence)
                 )",
                params![
                    &e.session_id,
                    &e.run_id,
                    e.run_ordinal,
                    e.sequence,
                    summary.as_str()
                ],
            )?;
        } else {
            // Idempotency is deliberately narrow: a delivery retry must carry
            // the exact durable fact.  Silently accepting a conflicting frame
            // with the same (session, run, sequence) would make corrupted or
            // split-brain event streams indistinguishable from a retry.
            let existing = tx.query_row(
                "SELECT run_ordinal,state,source,confidence,evidence,log_generation,log_offset,occurred_at
                 FROM status_events
                 WHERE session_id=?1 AND run_id=?2 AND sequence=?3",
                params![&e.session_id, &e.run_id, e.sequence],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<i64>>(5)?,
                        r.get::<_, Option<i64>>(6)?,
                        r.get::<_, String>(7)?,
                    ))
                },
            )?;
            let supplied = (
                e.run_ordinal,
                e.state.as_str(),
                e.source.as_str(),
                e.confidence.as_str(),
                e.evidence.as_deref(),
                e.log_cursor.as_ref().map(|cursor| cursor.generation),
                e.log_cursor.as_ref().map(|cursor| cursor.offset),
                occurred_at.as_str(),
            );
            if existing.0 != supplied.0
                || existing.1 != supplied.1
                || existing.2 != supplied.2
                || existing.3 != supplied.3
                || existing.4.as_deref() != supplied.4
                || existing.5 != supplied.5
                || existing.6 != supplied.6
                || existing.7 != supplied.7
            {
                return Err(CoreError::Conflict(format!(
                    "conflicting duplicate status event for session {} run {} sequence {}",
                    e.session_id, e.run_id, e.sequence
                )));
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn latest_status(&self, session_id: &str) -> Result<Option<StatusEvent>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT session_id,run_id,run_ordinal,sequence,state,source,confidence,
                    evidence,log_generation,log_offset,occurred_at
             FROM status_events
             WHERE session_id=?1
               AND NOT (source='hook' AND evidence='hook:Notification')
             ORDER BY run_ordinal DESC, sequence DESC
             LIMIT 1",
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
            "SELECT session_id,run_id,run_ordinal,sequence,state,source,confidence,evidence,
                    log_generation,log_offset,occurred_at
             FROM status_events WHERE session_id=?1
             ORDER BY run_ordinal DESC, sequence DESC LIMIT ?2",
        )?;
        let rows = st.query_map(params![session_id, limit], row_status_event)?;
        let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        out.reverse(); // chronological
        Ok(out)
    }

    /// Fetches events after run-aware cursors. A later run is always newer than
    /// every sequence in an earlier run, including when its sequence restarts
    /// at one.
    pub fn events_since_cursors(
        &self,
        cursor_per_session: &[(String, StatusCursor)],
    ) -> Result<Vec<StatusEvent>> {
        if cursor_per_session.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let cond = cursor_per_session
            .iter()
            .map(|_| {
                "(session_id=? AND (run_ordinal>? OR \
                    (run_ordinal=? AND run_id=? AND sequence>?)))"
            })
            .collect::<Vec<_>>()
            .join(" OR ");
        let sql = format!(
            "SELECT session_id,run_id,run_ordinal,sequence,state,source,confidence,evidence,
                    log_generation,log_offset,occurred_at
             FROM status_events WHERE {cond}
             ORDER BY occurred_at, session_id, run_ordinal, sequence"
        );
        let mut st = conn.prepare(&sql)?;
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        for (sid, cursor) in cursor_per_session {
            params_vec.push(Box::new(sid.clone()));
            params_vec.push(Box::new(cursor.run_ordinal));
            params_vec.push(Box::new(cursor.run_ordinal));
            params_vec.push(Box::new(cursor.run_id.clone()));
            params_vec.push(Box::new(cursor.sequence));
        }
        let refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
        let rows = st.query_map(refs.as_slice(), row_status_event)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Compatibility wrapper for callers that only have the pre-v3 sequence.
    /// Such a value is interpreted as a cursor in the legacy run; callers that
    /// must resume without replaying a newer run should use
    /// `events_since_cursors` instead.
    pub fn events_since(&self, sequence_per_session: &[(String, i64)]) -> Result<Vec<StatusEvent>> {
        let cursors = sequence_per_session
            .iter()
            .map(|(session_id, sequence)| {
                (
                    session_id.clone(),
                    StatusCursor {
                        sequence: *sequence,
                        ..StatusCursor::default()
                    },
                )
            })
            .collect::<Vec<_>>();
        self.events_since_cursors(&cursors)
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

    /// Current authoritative status cursor represented by the recovery row.
    pub fn get_recovery_status_cursor(&self, session_id: &str) -> Result<StatusCursor> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT latest_run_id,latest_run_ordinal,latest_sequence
             FROM recovery_summary WHERE session_id=?1",
            params![session_id],
            |r| {
                Ok(StatusCursor {
                    run_id: r.get(0)?,
                    run_ordinal: r.get(1)?,
                    sequence: r.get(2)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                CoreError::NotFound(format!("recovery summary {session_id}"))
            }
            other => CoreError::Sqlite(other),
        })
    }

    /// Cursor that was last acknowledged by the user. Use this instead of a
    /// bare sequence when reconnecting after a Session restart.
    pub fn get_last_seen_status_cursor(&self, session_id: &str) -> Result<StatusCursor> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT last_seen_run_id,last_seen_run_ordinal,last_seen_sequence
             FROM recovery_summary WHERE session_id=?1",
            params![session_id],
            |r| {
                Ok(StatusCursor {
                    run_id: r.get(0)?,
                    run_ordinal: r.get(1)?,
                    sequence: r.get(2)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                CoreError::NotFound(format!("recovery summary {session_id}"))
            }
            other => CoreError::Sqlite(other),
        })
    }

    /// Returns `None` when no terminal output remains unread.
    pub fn get_unread_log_cursor(&self, session_id: &str) -> Result<Option<LogCursor>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT unread_run_id,unread_run_ordinal,unread_log_generation,unread_output_offset
             FROM recovery_summary WHERE session_id=?1",
            params![session_id],
            |r| {
                let offset: i64 = r.get(3)?;
                if offset < 0 {
                    Ok(None)
                } else {
                    Ok(Some(LogCursor {
                        run_id: r.get(0)?,
                        run_ordinal: r.get(1)?,
                        generation: r.get(2)?,
                        offset,
                    }))
                }
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                CoreError::NotFound(format!("recovery summary {session_id}"))
            }
            other => CoreError::Sqlite(other),
        })
    }

    /// The newest cursor reported by a verified Host connection or a durable
    /// status event.  `None` means the retained log generation is unknown, so
    /// callers must not turn an offset into a recovery jump.
    pub fn get_latest_log_cursor(&self, session_id: &str) -> Result<Option<LogCursor>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT latest_log_run_id,latest_log_run_ordinal,latest_log_generation,latest_log_offset
             FROM recovery_summary WHERE session_id=?1",
            params![session_id],
            |r| {
                let offset: Option<i64> = r.get(3)?;
                match offset {
                    Some(offset) if offset >= 0 => Ok(Some(LogCursor {
                        run_id: r.get(0)?,
                        run_ordinal: r.get(1)?,
                        generation: r.get(2)?,
                        offset,
                    })),
                    _ => Ok(None),
                }
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                CoreError::NotFound(format!("recovery summary {session_id}"))
            }
            other => CoreError::Sqlite(other),
        })
    }

    /// Same cursor together with the time a verified Host (or durable status
    /// event) last reported it.  This is an observation timestamp, not a
    /// claim that terminal bytes were produced at that instant.
    pub fn get_latest_log_cursor_observed(
        &self,
        session_id: &str,
    ) -> Result<Option<(LogCursor, DateTime<Utc>)>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT latest_log_run_id,latest_log_run_ordinal,latest_log_generation,
                    latest_log_offset,latest_log_observed_at
             FROM recovery_summary WHERE session_id=?1",
            params![session_id],
            |r| {
                let offset: Option<i64> = r.get(3)?;
                let observed_at: Option<String> = r.get(4)?;
                match (offset, observed_at) {
                    (Some(offset), Some(observed_at)) if offset >= 0 => {
                        let observed_at = DateTime::parse_from_rfc3339(&observed_at)
                            .map(|d| d.with_timezone(&Utc))
                            .unwrap_or_else(|_| Utc::now());
                        Ok(Some((
                            LogCursor {
                                run_id: r.get(0)?,
                                run_ordinal: r.get(1)?,
                                generation: r.get(2)?,
                                offset,
                            },
                            observed_at,
                        )))
                    }
                    _ => Ok(None),
                }
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                CoreError::NotFound(format!("recovery summary {session_id}"))
            }
            other => CoreError::Sqlite(other),
        })
    }

    pub fn set_latest_log_cursor(&self, session_id: &str, cursor: &LogCursor) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Utc::now();
        ensure_session_run_tx(&tx, session_id, &cursor.run_id, cursor.run_ordinal, &now)?;
        update_latest_log_cursor_tx(&tx, session_id, cursor, &now)?;
        tx.commit()?;
        Ok(())
    }

    /// Advances the acknowledged state cursor only. A late cursor from an
    /// earlier run (or a lower sequence in the same run) is ignored.
    pub fn set_last_seen_status_cursor(
        &self,
        session_id: &str,
        cursor: &StatusCursor,
    ) -> Result<()> {
        validate_run_identity(&cursor.run_id, cursor.run_ordinal)?;
        if cursor.sequence < 0 {
            return Err(CoreError::Validation(
                "status sequence must not be negative".into(),
            ));
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Utc::now();
        ensure_session_run_tx(&tx, session_id, &cursor.run_id, cursor.run_ordinal, &now)?;
        ensure_recovery_summary_row(&tx, session_id)?;
        tx.execute(
            "UPDATE recovery_summary
             SET last_seen_run_id=?2, last_seen_run_ordinal=?3, last_seen_sequence=?4
             WHERE session_id=?1 AND (
                 ?3 > last_seen_run_ordinal OR
                 (?3 = last_seen_run_ordinal AND ?4 > last_seen_sequence)
             )",
            params![
                session_id,
                &cursor.run_id,
                cursor.run_ordinal,
                cursor.sequence
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_last_seen_sequence(&self, session_id: &str, seq: i64) -> Result<()> {
        let mut cursor = match self.get_recovery_status_cursor(session_id) {
            Ok(cursor) => cursor,
            Err(CoreError::NotFound(_)) => StatusCursor::default(),
            Err(e) => return Err(e),
        };
        cursor.sequence = seq;
        self.set_last_seen_status_cursor(session_id, &cursor)
    }

    /// Sets the precise log position used for a recovery jump. The generation
    /// is persisted alongside the byte offset so rotation cannot redirect a
    /// cursor into unrelated output.
    pub fn set_unread_log_cursor(&self, session_id: &str, cursor: &LogCursor) -> Result<()> {
        validate_run_identity(&cursor.run_id, cursor.run_ordinal)?;
        if cursor.generation < 0 || cursor.offset < 0 {
            return Err(CoreError::Validation(
                "log generation and offset must not be negative".into(),
            ));
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Utc::now();
        ensure_session_run_tx(&tx, session_id, &cursor.run_id, cursor.run_ordinal, &now)?;
        ensure_recovery_summary_row(&tx, session_id)?;
        tx.execute(
            "UPDATE recovery_summary
             SET unread_run_id=?2, unread_run_ordinal=?3, unread_log_generation=?4,
                 unread_output_offset=?5, acknowledged_at=NULL
             WHERE session_id=?1",
            params![
                session_id,
                &cursor.run_id,
                cursor.run_ordinal,
                cursor.generation,
                cursor.offset
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_unread_offset(&self, session_id: &str, offset: i64) -> Result<()> {
        let status = match self.get_recovery_status_cursor(session_id) {
            Ok(cursor) => cursor,
            Err(CoreError::NotFound(_)) => StatusCursor::default(),
            Err(e) => return Err(e),
        };
        self.set_unread_log_cursor(
            session_id,
            &LogCursor {
                run_id: status.run_id,
                run_ordinal: status.run_ordinal,
                generation: 0,
                offset,
            },
        )
    }

    /// Atomically acknowledge a specific status cursor and clear unread output
    /// only when that cursor is not older than the persisted acknowledgement
    /// and the unread bytes do not belong to a newer run. This is the UI-safe
    /// counterpart to `mark_output_unread_at`: a delayed "seen" callback from
    /// a prior Session run can advance neither fact backwards nor erase fresh
    /// output from the replacement run.
    pub fn mark_session_seen_at(&self, session_id: &str, cursor: &StatusCursor) -> Result<()> {
        validate_run_identity(&cursor.run_id, cursor.run_ordinal)?;
        if cursor.sequence < 0 {
            return Err(CoreError::Validation(
                "status sequence must not be negative".into(),
            ));
        }

        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Utc::now();
        ensure_session_run_tx(&tx, session_id, &cursor.run_id, cursor.run_ordinal, &now)?;
        ensure_recovery_summary_row(&tx, session_id)?;
        let current = tx.query_row(
            "SELECT last_seen_run_id,last_seen_run_ordinal,last_seen_sequence,
                    unread_run_id,unread_run_ordinal,unread_log_generation,unread_output_offset
             FROM recovery_summary WHERE session_id=?1",
            params![session_id],
            |r| {
                Ok((
                    StatusCursor {
                        run_id: r.get(0)?,
                        run_ordinal: r.get(1)?,
                        sequence: r.get(2)?,
                    },
                    LogCursor {
                        run_id: r.get(3)?,
                        run_ordinal: r.get(4)?,
                        generation: r.get(5)?,
                        offset: r.get(6)?,
                    },
                ))
            },
        )?;
        let cursor_is_not_older = cursor.run_ordinal > current.0.run_ordinal
            || (cursor.run_ordinal == current.0.run_ordinal
                && cursor.run_id == current.0.run_id
                && cursor.sequence >= current.0.sequence);
        let next_seen = if cursor_is_not_older {
            cursor.clone()
        } else {
            current.0.clone()
        };
        let clears_unread = cursor_is_not_older
            && (current.1.offset < 0
                || cursor.run_ordinal > current.1.run_ordinal
                || (cursor.run_ordinal == current.1.run_ordinal
                    && cursor.run_id == current.1.run_id));
        let next_unread = if clears_unread {
            LogCursor {
                run_id: cursor.run_id.clone(),
                run_ordinal: cursor.run_ordinal,
                generation: 0,
                offset: -1,
            }
        } else {
            current.1
        };
        tx.execute(
            "UPDATE recovery_summary
             SET last_seen_run_id=?2, last_seen_run_ordinal=?3, last_seen_sequence=?4,
                 unread_run_id=?5, unread_run_ordinal=?6, unread_log_generation=?7,
                 unread_output_offset=?8,
                 acknowledged_at=CASE WHEN ?9 THEN ?10 ELSE acknowledged_at END
             WHERE session_id=?1",
            params![
                session_id,
                next_seen.run_id,
                next_seen.run_ordinal,
                next_seen.sequence,
                next_unread.run_id,
                next_unread.run_ordinal,
                next_unread.generation,
                next_unread.offset,
                clears_unread,
                dt_str(&now)
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Acknowledge exactly the recovery facts that were present in a rendered
    /// timeline snapshot.  In particular, this never promotes the status
    /// cursor to a newer DB value discovered after the UI rendered.
    pub fn acknowledge_recovery_snapshot(
        &self,
        session_id: &str,
        status_cursor: Option<&StatusCursor>,
        log_cursor: Option<&LogCursor>,
    ) -> Result<()> {
        if let Some(cursor) = status_cursor {
            validate_run_identity(&cursor.run_id, cursor.run_ordinal)?;
            if cursor.sequence < 0 {
                return Err(CoreError::Validation(
                    "status sequence must not be negative".into(),
                ));
            }
        }
        if let Some(cursor) = log_cursor {
            validate_run_identity(&cursor.run_id, cursor.run_ordinal)?;
            if cursor.generation < 0 || cursor.offset < 0 {
                return Err(CoreError::Validation(
                    "log generation and offset must not be negative".into(),
                ));
            }
        }

        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Utc::now();
        if let Some(cursor) = status_cursor {
            ensure_session_run_tx(&tx, session_id, &cursor.run_id, cursor.run_ordinal, &now)?;
        }
        if let Some(cursor) = log_cursor {
            ensure_session_run_tx(&tx, session_id, &cursor.run_id, cursor.run_ordinal, &now)?;
        }
        ensure_recovery_summary_row(&tx, session_id)?;
        let current = tx.query_row(
            "SELECT last_seen_run_id,last_seen_run_ordinal,last_seen_sequence,
                    unread_run_id,unread_run_ordinal,unread_log_generation,unread_output_offset,
                    latest_log_run_id,latest_log_run_ordinal,latest_log_generation,latest_log_offset
             FROM recovery_summary WHERE session_id=?1",
            params![session_id],
            |r| {
                let latest_offset: Option<i64> = r.get(10)?;
                Ok((
                    StatusCursor {
                        run_id: r.get(0)?,
                        run_ordinal: r.get(1)?,
                        sequence: r.get(2)?,
                    },
                    LogCursor {
                        run_id: r.get(3)?,
                        run_ordinal: r.get(4)?,
                        generation: r.get(5)?,
                        offset: r.get(6)?,
                    },
                    match latest_offset {
                        Some(offset) if offset >= 0 => Some(LogCursor {
                            run_id: r.get(7)?,
                            run_ordinal: r.get(8)?,
                            generation: r.get(9)?,
                            offset,
                        }),
                        _ => None,
                    },
                ))
            },
        )?;
        let next_seen = match status_cursor {
            Some(candidate)
                if candidate.run_ordinal > current.0.run_ordinal
                    || (candidate.run_ordinal == current.0.run_ordinal
                        && candidate.run_id == current.0.run_id
                        && candidate.sequence >= current.0.sequence) =>
            {
                candidate.clone()
            }
            _ => current.0.clone(),
        };
        // The snapshot log cursor is the high-water actually rendered. If a
        // later output arrived while the ACK was in flight, advance unread to
        // that high-water rather than retaining the old first-unread byte
        // (which would replay already-seen output) or clearing fresh output.
        let snapshot_covers_unread = log_cursor.is_some_and(|snapshot| {
            current.1.offset >= 0 && snapshot.is_not_older_than(&current.1)
        });
        let latest_advanced_after_snapshot = match (log_cursor, current.2.as_ref()) {
            (Some(snapshot), Some(latest)) => {
                latest.is_not_older_than(snapshot) && latest != snapshot
            }
            _ => false,
        };
        let next_unread = match log_cursor {
            Some(_snapshot) if current.1.offset < 0 => current.1.clone(),
            Some(snapshot) if snapshot_covers_unread && latest_advanced_after_snapshot => {
                snapshot.clone()
            }
            Some(snapshot) if snapshot_covers_unread => LogCursor {
                offset: -1,
                ..snapshot.clone()
            },
            _ => current.1.clone(),
        };
        tx.execute(
            "UPDATE recovery_summary
             SET last_seen_run_id=?2,last_seen_run_ordinal=?3,last_seen_sequence=?4,
                 unread_run_id=?5,unread_run_ordinal=?6,unread_log_generation=?7,
                 unread_output_offset=?8,acknowledged_at=?9
             WHERE session_id=?1",
            params![
                session_id,
                next_seen.run_id,
                next_seen.run_ordinal,
                next_seen.sequence,
                next_unread.run_id,
                next_unread.run_ordinal,
                next_unread.generation,
                next_unread.offset,
                dt_str(&now),
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Mark the current status and terminal output as viewed by the user.
    pub fn mark_session_seen(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = dt_str(&Utc::now());
        ensure_recovery_summary_row(&conn, session_id)?;
        conn.execute(
            "UPDATE recovery_summary
             SET last_seen_run_id=latest_run_id, last_seen_run_ordinal=latest_run_ordinal,
                 last_seen_sequence=latest_sequence,
                 unread_run_id=latest_run_id, unread_run_ordinal=latest_run_ordinal,
                 unread_log_generation=0, unread_output_offset=-1, acknowledged_at=?2
             WHERE session_id=?1",
            params![session_id, now],
        )?;
        Ok(())
    }

    /// Records the first unread byte in a precise log generation. A later run
    /// or later generation supersedes an unread cursor from an older file;
    /// additional chunks in the same generation retain the original offset.
    pub fn mark_output_unread_at(&self, session_id: &str, cursor: &LogCursor) -> Result<()> {
        validate_run_identity(&cursor.run_id, cursor.run_ordinal)?;
        if cursor.generation < 0 || cursor.offset < 0 {
            return Err(CoreError::Validation(
                "log generation and offset must not be negative".into(),
            ));
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Utc::now();
        ensure_session_run_tx(&tx, session_id, &cursor.run_id, cursor.run_ordinal, &now)?;
        ensure_recovery_summary_row(&tx, session_id)?;
        tx.execute(
            "UPDATE recovery_summary
             SET unread_run_id=?2, unread_run_ordinal=?3, unread_log_generation=?4,
                 unread_output_offset=?5, acknowledged_at=NULL
             WHERE session_id=?1 AND (
                 unread_output_offset < 0 OR
                 ?3 > unread_run_ordinal OR
                 (?3 = unread_run_ordinal AND ?4 > unread_log_generation)
             )",
            params![
                session_id,
                &cursor.run_id,
                cursor.run_ordinal,
                cursor.generation,
                cursor.offset
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Record the first terminal byte produced while the Session is not
    /// focused. Later chunks retain the first offset so recovery can jump to
    /// the start of the unread output. This compatibility form assumes the
    /// latest status run and log generation zero; Host v2 should call
    /// `mark_output_unread_at` with its exact `LogCursor`.
    pub fn mark_output_unread(&self, session_id: &str, offset: i64) -> Result<()> {
        let status = match self.get_recovery_status_cursor(session_id) {
            Ok(cursor) => cursor,
            Err(CoreError::NotFound(_)) => StatusCursor::default(),
            Err(e) => return Err(e),
        };
        self.mark_output_unread_at(
            session_id,
            &LogCursor {
                run_id: status.run_id,
                run_ordinal: status.run_ordinal,
                generation: 0,
                offset: offset.max(0),
            },
        )
    }

    /// PTY working/idle heuristics are too noisy for an unread badge. Only
    /// terminal-attention states count here; ordinary output is tracked by its
    /// byte offset separately.
    pub fn has_unread_attention_after(
        &self,
        session_id: &str,
        cursor: &StatusCursor,
    ) -> Result<bool> {
        validate_run_identity(&cursor.run_id, cursor.run_ordinal)?;
        let conn = self.conn.lock().unwrap();
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM status_events
                WHERE session_id=?1 AND (
                    run_ordinal>?2 OR
                    (run_ordinal=?2 AND run_id=?3 AND sequence>?4)
                ) AND (
                    (state='needs_input' AND (
                        (source='hook' AND evidence='hook:PermissionRequest') OR
                        (source='pty' AND evidence LIKE 'pty:pattern:%')
                    )) OR
                    (state='idle' AND (
                        (source='hook' AND
                            (evidence='hook:Stop' OR evidence='hook:TurnEnd')) OR
                        (source='adapter' AND
                            (evidence='adapter:kimi:TurnEnd' OR
                             evidence='adapter:pi:TurnEnd'))
                    ))
                )
             )",
            params![
                session_id,
                cursor.run_ordinal,
                &cursor.run_id,
                cursor.sequence
            ],
            |row| row.get(0),
        )?;
        Ok(exists != 0)
    }

    /// Compatibility wrapper for the old sequence-only API. It obtains the
    /// persisted acknowledged run and substitutes the caller's sequence.
    pub fn has_unread_attention(&self, session_id: &str, after_sequence: i64) -> Result<bool> {
        let mut cursor = match self.get_last_seen_status_cursor(session_id) {
            Ok(cursor) => cursor,
            Err(CoreError::NotFound(_)) => StatusCursor::default(),
            Err(e) => return Err(e),
        };
        cursor.sequence = after_sequence;
        self.has_unread_attention_after(session_id, &cursor)
    }

    pub fn acknowledge_recovery(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = dt_str(&Utc::now());
        conn.execute(
            "UPDATE recovery_summary
             SET acknowledged_at=?2,
                 last_seen_run_id=latest_run_id, last_seen_run_ordinal=latest_run_ordinal,
                 last_seen_sequence=latest_sequence,
                 unread_run_id=latest_run_id, unread_run_ordinal=latest_run_ordinal,
                 unread_log_generation=0, unread_output_offset=-1
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
            ui_language: map
                .get("ui_language")
                .and_then(|value| UiLanguage::from_code(value))
                .unwrap_or(d.ui_language),
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
            terminal_command: map
                .get("terminal_command")
                .cloned()
                .unwrap_or(d.terminal_command),
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
            agent_order: map
                .get("agent_order")
                .and_then(|v| serde_json::from_str(v).ok())
                .unwrap_or(d.agent_order),
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
        let pairs: [(String, String); 11] = [
            ("log_limit_mib".into(), s.log_limit_mib.to_string()),
            (
                "notifications_enabled".into(),
                s.notifications_enabled.to_string(),
            ),
            ("ui_language".into(), s.ui_language.as_str().into()),
            ("theme".into(), theme.into()),
            (
                "terminal_font_family".into(),
                s.terminal_font_family.clone(),
            ),
            (
                "terminal_font_size".into(),
                s.terminal_font_size.to_string(),
            ),
            ("terminal_command".into(), s.terminal_command.clone()),
            ("reduced_motion".into(), rm.into()),
            (
                "screen_reader_mode".into(),
                s.screen_reader_mode.to_string(),
            ),
            (
                "search_index_enabled".into(),
                s.search_index_enabled.to_string(),
            ),
            ("agent_order".into(), serde_json::to_string(&s.agent_order)?),
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
            transport: AgentTransport::Pty,
            command: vec!["/bin/sh".into()],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            archived_at: None,
        }
    }

    fn insert_pending_branch_operation(db: &Db, id: &str, project_id: &str, checkout_root: &str) {
        let now = Utc::now().to_rfc3339();
        db.conn()
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO branch_operations(
                    id,project_id,repo_key,checkout_root,source_commit,target_branch,phase,created_at,updated_at
                 ) VALUES(?1,?2,'repo-key',?3,'source-commit','target','restored_verified',?4,?4)",
                params![id, project_id, checkout_root, now],
            )
            .unwrap();
    }

    #[test]
    fn data_model_version_matches_migration_count() {
        assert_eq!(DATA_MODEL_VERSION, schema::MIGRATIONS.len() as i64);
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
            db.meta_get("data_model_version").unwrap(),
            Some(DATA_MODEL_VERSION.to_string())
        );
    }

    #[test]
    fn legacy_v6_branch_journal_is_upgraded_without_losing_recovery_evidence() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        for migration in schema::MIGRATIONS.iter().take(5) {
            conn.execute_batch(migration).unwrap();
        }
        conn.execute(
            "INSERT INTO projects(id,name,root_path,git_root_path,created_at)
             VALUES('prj_legacy','legacy','/tmp/legacy','/tmp/legacy',?1)",
            params!["2026-07-22T00:00:00.000Z"],
        )
        .unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE branch_operations (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id),
                repo_key TEXT NOT NULL,
                checkout_root TEXT NOT NULL,
                source_branch TEXT,
                source_commit TEXT NOT NULL,
                target_branch TEXT NOT NULL,
                phase TEXT NOT NULL,
                stash_oid TEXT,
                stash_selector TEXT,
                stash_marker TEXT UNIQUE,
                snapshot_json TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX idx_branch_operations_recovery
                ON branch_operations(repo_key,phase,created_at);
            CREATE TABLE branch_operation_steps (
                operation_id TEXT NOT NULL REFERENCES branch_operations(id) ON DELETE CASCADE,
                sequence INTEGER NOT NULL CHECK(sequence > 0),
                phase TEXT NOT NULL,
                detail TEXT,
                occurred_at TEXT NOT NULL,
                PRIMARY KEY(operation_id,sequence)
            );
            INSERT INTO branch_operations(
                id,project_id,repo_key,checkout_root,source_branch,source_commit,
                target_branch,phase,stash_oid,stash_selector,stash_marker,
                snapshot_json,error,created_at,updated_at
            ) VALUES(
                'op_legacy','prj_legacy','repo-key','/tmp/legacy','main',
                '1111111111111111111111111111111111111111','feature','stashed',
                '2222222222222222222222222222222222222222','stash@{0}',
                'AgentPort:v1:legacy','{}','legacy failure',
                '2026-07-22T00:00:00.000Z','2026-07-22T00:01:00.000Z'
            );
            INSERT INTO branch_operation_steps(
                operation_id,sequence,phase,detail,occurred_at
            ) VALUES(
                'op_legacy',1,'stashed','legacy step','2026-07-22T00:00:30.000Z'
            );
            PRAGMA user_version=6;
            "#,
        )
        .unwrap();

        let db = Db::init(conn).unwrap();
        let operation = crate::git::BranchManager::new(&db)
            .operation("op_legacy")
            .unwrap();
        assert_eq!(operation.target_oid, "");
        assert_eq!(
            operation.phase,
            crate::git::BranchOperationPhase::RecoveryRequired
        );
        assert_eq!(
            operation.stash_marker.as_deref(),
            Some("AgentPort:v1:legacy")
        );
        assert_eq!(
            operation
                .error_json
                .as_ref()
                .and_then(|value| value.get("legacyError").and_then(serde_json::Value::as_str)),
            Some("legacy failure")
        );

        let steps = crate::git::BranchManager::new(&db)
            .operation_steps("op_legacy")
            .unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].detail.as_deref(), Some("legacy step"));
        assert!(steps[0].head_json.is_none());
        assert!(steps[0].status_token.is_none());

        let conn = db.conn().lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, schema::MIGRATIONS.len() as i64);
    }

    #[test]
    fn future_schema_version_is_rejected_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().to_path_buf());
        {
            let db = Db::open(&paths).unwrap();
            let conn = db.conn().lock().unwrap();
            conn.pragma_update(None, "user_version", schema::MIGRATIONS.len() as i64 + 1)
                .unwrap();
        }
        // Opening a database written by a NEWER AgentPort must fail closed
        // instead of silently continuing with unknown columns/semantics.
        assert!(matches!(Db::open(&paths), Err(CoreError::Conflict(_))));
    }

    #[test]
    fn v3_schema_migrates_cleanup_jobs_without_session_foreign_key() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(schema::MIGRATIONS[0]).unwrap();
        conn.execute_batch(schema::MIGRATIONS[1]).unwrap();
        conn.execute_batch(schema::MIGRATIONS[2]).unwrap();
        conn.pragma_update(None, "user_version", 3).unwrap();

        let db = Db::init(conn).unwrap();
        let now = Utc::now();
        {
            let conn = db.conn().lock().unwrap();
            conn.execute(
                "INSERT INTO cleanup_jobs(session_id,attempts,last_error,retry_at,created_at)
                 VALUES(?1,0,NULL,?2,?2)",
                params!["ses_purged", dt_str(&now)],
            )
            .unwrap();
        }
        assert_eq!(
            db.list_due_cleanup_jobs(now).unwrap()[0].session_id,
            "ses_purged"
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
        // An archived Session is still user data: removing the project must
        // not silently drop its rows and orphan the on-disk directory.
        db.archive_session("ses_1").unwrap();
        assert!(matches!(
            db.remove_project("prj_1"),
            Err(CoreError::Blocked(_))
        ));
        db.purge_archived_session("ses_1").unwrap();
        db.remove_project("prj_1").unwrap();
        assert!(matches!(
            db.get_project("prj_1"),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn remove_project_blocks_while_worktrees_are_registered() {
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

        let error = db.remove_project("prj_1").unwrap_err();
        assert!(matches!(error, CoreError::Blocked(_)), "{error}");
        assert!(error.to_string().contains("1 Worktree"), "{error}");
        assert!(db.get_project("prj_1").is_ok());
        assert!(db.get_worktree("wt_1").is_ok());

        db.delete_worktree("wt_1").unwrap();
        db.remove_project("prj_1").unwrap();
    }

    #[test]
    fn remove_project_allows_stale_branch_operations_only_when_checkout_is_gone() {
        let db = db();
        let recoverable_checkout = tempfile::tempdir().unwrap();
        let recoverable_checkout = recoverable_checkout.path().to_string_lossy().into_owned();
        let missing_project_root = std::env::temp_dir().join(format!(
            "agentport-missing-project-root-{}",
            ids::new_uuid()
        ));
        assert!(!missing_project_root.exists());
        let missing_project_root = missing_project_root.to_string_lossy().into_owned();
        let mut live_project = project("prj_live_branch_operation");
        live_project.root_path = missing_project_root.clone();
        live_project.git_root_path = Some(missing_project_root);
        db.add_project(&live_project).unwrap();
        insert_pending_branch_operation(
            &db,
            "op_live_branch_operation",
            &live_project.id,
            &recoverable_checkout,
        );
        assert_eq!(
            db.project_dependency_counts(&live_project.id).unwrap(),
            (0, 0, 1)
        );
        assert!(matches!(
            db.remove_project(&live_project.id),
            Err(CoreError::Blocked(_))
        ));

        let missing_root = std::env::temp_dir().join(format!(
            "agentport-stale-branch-operation-{}",
            ids::new_uuid()
        ));
        assert!(!missing_root.exists());
        let missing_root = missing_root.to_string_lossy().into_owned();
        let mut stale_project = project("prj_stale_branch_operation");
        stale_project.root_path = missing_root.clone();
        stale_project.git_root_path = Some(missing_root.clone());
        db.add_project(&stale_project).unwrap();
        insert_pending_branch_operation(
            &db,
            "op_stale_branch_operation",
            &stale_project.id,
            &missing_root,
        );
        assert_eq!(
            db.project_dependency_counts(&stale_project.id).unwrap(),
            (0, 0, 0)
        );

        db.remove_project(&stale_project.id).unwrap();
        assert!(matches!(
            db.get_project(&stale_project.id),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn preset_seed_and_builtin_protection() {
        let db = db();
        db.seed_builtin_presets().unwrap();
        db.seed_builtin_presets().unwrap(); // idempotent
        let presets = db.list_presets(None).unwrap();
        assert_eq!(presets.len(), 6);
        assert!(presets.iter().all(
            |p| p.agent_type == AgentType::Qoder || p.permission_mode == PermissionMode::Native
        ));
        assert_eq!(
            presets
                .iter()
                .find(|preset| preset.agent_type == AgentType::Qoder)
                .map(|preset| preset.permission_mode),
            Some(PermissionMode::Bypass)
        );
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
            approval_model: AgentType::Kimi.approval_model(),
            default_transport: AgentType::Kimi.default_transport(),
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
        db.update_session_log_path("ses_1", "/tmp/ses_1-r2.log")
            .unwrap();
        db.update_session_agent_id("ses_1", "01HZABC", ResumePrecision::Exact)
            .unwrap();
        let s = db.get_session("ses_1").unwrap();
        assert_eq!(s.lifecycle, Lifecycle::Running);
        assert_eq!(s.host_pid, Some(4242));
        assert_eq!(s.log_path, "/tmp/ses_1-r2.log");
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
    fn lifecycle_cas_rejects_a_stale_host_after_a_new_run_claim() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_cas", "prj_1")).unwrap();
        let first = db.create_session_run("ses_cas", "run_first").unwrap();
        db.claim_session_run(
            "ses_cas",
            &first.run_id,
            first.run_ordinal,
            "/tmp/ses_cas-first.log",
        )
        .unwrap();
        assert!(db
            .bind_session_host_for_run(
                "ses_cas",
                &first.run_id,
                first.run_ordinal,
                111,
                "/tmp/ses_cas-first.sock",
            )
            .unwrap());
        assert!(db
            .update_session_lifecycle_if_host(
                "ses_cas",
                111,
                Some((&first.run_id, first.run_ordinal)),
                Lifecycle::Running,
            )
            .unwrap());

        let second = db.create_session_run("ses_cas", "run_second").unwrap();
        db.claim_session_run(
            "ses_cas",
            &second.run_id,
            second.run_ordinal,
            "/tmp/ses_cas-second.log",
        )
        .unwrap();
        assert!(db
            .bind_session_host_for_run(
                "ses_cas",
                &second.run_id,
                second.run_ordinal,
                222,
                "/tmp/ses_cas-second.sock",
            )
            .unwrap());
        assert!(db
            .update_session_lifecycle_if_host(
                "ses_cas",
                222,
                Some((&second.run_id, second.run_ordinal)),
                Lifecycle::Running,
            )
            .unwrap());

        assert!(!db
            .update_session_lifecycle_if_host(
                "ses_cas",
                111,
                Some((&first.run_id, first.run_ordinal)),
                Lifecycle::Exited,
            )
            .unwrap());
        assert!(!db
            .update_session_lifecycle_if_host(
                "ses_cas",
                222,
                Some((&first.run_id, first.run_ordinal)),
                Lifecycle::Exited,
            )
            .unwrap());
        assert_eq!(
            db.get_session("ses_cas").unwrap().lifecycle,
            Lifecycle::Running
        );
        assert_eq!(
            db.session_host_binding("ses_cas").unwrap(),
            SessionHostBinding {
                host_pid: Some(222),
                run_id: Some(second.run_id),
                run_ordinal: Some(second.run_ordinal),
            }
        );
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
        assert_eq!(
            db.list_due_cleanup_jobs(Utc::now()).unwrap()[0].session_id,
            "ses_restore"
        );
        db.mark_cleanup_job_success("ses_restore").unwrap();
        assert!(db.list_due_cleanup_jobs(Utc::now()).unwrap().is_empty());

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
        assert_eq!(
            db.list_due_cleanup_jobs(Utc::now())
                .unwrap()
                .into_iter()
                .map(|job| job.session_id)
                .collect::<Vec<_>>(),
            vec!["ses_purge"]
        );
    }

    #[test]
    fn cleanup_retry_uses_bounded_exponential_backoff_without_paths() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_cleanup", "prj_1")).unwrap();
        db.archive_session("ses_cleanup").unwrap();
        db.purge_archived_session("ses_cleanup").unwrap();

        let now = Utc::now();
        let first = db
            .record_cleanup_job_retry("ses_cleanup", "resource busy", now)
            .unwrap();
        assert_eq!(first.attempts, 1);
        assert_eq!(first.last_error.as_deref(), Some("resource busy"));
        assert_eq!(
            first.retry_at,
            Some(parse_dt(&dt_str(&(now + Duration::seconds(5)))).unwrap())
        );
        assert!(db.list_due_cleanup_jobs(now).unwrap().is_empty());
        assert_eq!(
            db.list_due_cleanup_jobs(now + Duration::seconds(5))
                .unwrap()
                .len(),
            1
        );
        assert!(matches!(
            db.record_cleanup_job_retry("ses_cleanup", "failed at /tmp/log", now),
            Err(CoreError::Validation(_))
        ));

        let mut job = first;
        for _ in 1..MAX_CLEANUP_JOB_ATTEMPTS {
            job = db
                .record_cleanup_job_retry("ses_cleanup", "resource busy", now)
                .unwrap();
        }
        assert_eq!(job.attempts, MAX_CLEANUP_JOB_ATTEMPTS);
        assert!(job.retry_at.is_none());
        assert!(db
            .list_due_cleanup_jobs(now + Duration::days(1))
            .unwrap()
            .is_empty());
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
            run_id: LEGACY_RUN_ID.into(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            sequence: seq,
            state,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some(evidence.into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        };
        let first_event = ev(1, AgentState::Working, "hook:PreToolUse");
        db.record_status_event(&first_event).unwrap();
        db.record_status_event(&first_event).unwrap(); // exact retry ignored
        db.record_status_event(&ev(2, AgentState::NeedsInput, "hook:PermissionRequest"))
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
    fn informational_notification_is_not_latest_or_unread_attention() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_1", "prj_1")).unwrap();
        let event = |sequence: i64, state: AgentState, evidence: &str| StatusEvent {
            session_id: "ses_1".into(),
            run_id: LEGACY_RUN_ID.into(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            sequence,
            state,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some(evidence.into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        };

        db.record_status_event(&event(1, AgentState::Idle, "hook:Stop"))
            .unwrap();
        db.record_status_event(&event(2, AgentState::NeedsInput, "hook:Notification"))
            .unwrap();

        let latest = db.latest_status("ses_1").unwrap().unwrap();
        assert_eq!(latest.sequence, 1);
        assert_eq!(latest.state, AgentState::Idle);
        assert!(!db.has_unread_attention("ses_1", 1).unwrap());
        assert_eq!(
            db.get_recovery_summary("ses_1").unwrap().summary_state,
            SummaryState::Output
        );
    }

    #[test]
    fn unread_attention_sql_matches_the_shared_semantic_classifier() {
        let db = db();
        db.add_project(&project("prj_attention")).unwrap();
        let cases = [
            (
                AgentState::NeedsInput,
                StateSource::Hook,
                "hook:PermissionRequest",
                true,
            ),
            (
                AgentState::NeedsInput,
                StateSource::Pty,
                "pty:pattern:permission",
                true,
            ),
            (AgentState::Idle, StateSource::Hook, "hook:Stop", true),
            (AgentState::Idle, StateSource::Hook, "hook:TurnEnd", true),
            (
                AgentState::Idle,
                StateSource::Adapter,
                "adapter:kimi:TurnEnd",
                true,
            ),
            (
                AgentState::Idle,
                StateSource::Adapter,
                "adapter:pi:TurnEnd",
                true,
            ),
            (
                AgentState::NeedsInput,
                StateSource::Hook,
                "hook:Notification",
                false,
            ),
            (
                AgentState::NeedsInput,
                StateSource::Hook,
                "hook:AskUserQuestion",
                false,
            ),
            (
                AgentState::Idle,
                StateSource::Pty,
                "pty:silence:3000ms",
                false,
            ),
            (
                AgentState::Exited,
                StateSource::Process,
                "process:exit:0",
                false,
            ),
        ];

        for (index, (state, source, evidence, expected)) in cases.into_iter().enumerate() {
            let session_id = format!("ses_attention_{index}");
            db.insert_session(&session(&session_id, "prj_attention"))
                .unwrap();
            let event = StatusEvent {
                session_id: session_id.clone(),
                run_id: LEGACY_RUN_ID.into(),
                run_ordinal: LEGACY_RUN_ORDINAL,
                sequence: 1,
                state,
                source,
                confidence: Confidence::High,
                evidence: Some(evidence.into()),
                log_cursor: None,
                occurred_at: Utc::now(),
            };
            assert_eq!(event.attention_kind().is_some(), expected, "{evidence}");
            db.record_status_event(&event).unwrap();
            assert_eq!(
                db.has_unread_attention(&session_id, 0).unwrap(),
                expected,
                "{evidence}"
            );
        }
    }

    #[test]
    fn conflicting_duplicate_status_event_is_rejected() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_conflict", "prj_1"))
            .unwrap();
        let event = StatusEvent {
            session_id: "ses_conflict".into(),
            run_id: LEGACY_RUN_ID.into(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            sequence: 7,
            state: AgentState::Working,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some("hook:PreToolUse".into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        };
        db.record_status_event(&event).unwrap();
        db.record_status_event(&event).unwrap(); // exact retry is safe

        let mut conflicting = event.clone();
        conflicting.state = AgentState::NeedsInput;
        conflicting.evidence = Some("hook:Notification".into());
        assert!(matches!(
            db.record_status_event(&conflicting),
            Err(CoreError::Conflict(_))
        ));
        let history = db.status_history("ses_conflict", 10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].state, event.state);
        assert_eq!(history[0].evidence, event.evidence);
    }

    #[test]
    fn status_event_rejects_log_cursor_from_a_different_run() {
        let db = db();
        db.add_project(&project("prj_cursor_run")).unwrap();
        db.insert_session(&session("ses_cursor_run", "prj_cursor_run"))
            .unwrap();
        let first = db
            .create_session_run("ses_cursor_run", "run_first")
            .unwrap();
        let second = db
            .create_session_run("ses_cursor_run", "run_second")
            .unwrap();
        let mut event = StatusEvent {
            session_id: "ses_cursor_run".into(),
            run_id: first.run_id.clone(),
            run_ordinal: first.run_ordinal,
            sequence: 1,
            state: AgentState::Working,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some("hook:PreToolUse".into()),
            log_cursor: Some(LogCursor {
                run_id: second.run_id.clone(),
                run_ordinal: second.run_ordinal,
                generation: 0,
                offset: 10,
            }),
            occurred_at: Utc::now(),
        };

        assert!(matches!(
            db.record_status_event(&event),
            Err(CoreError::Validation(_))
        ));
        assert!(db.status_history("ses_cursor_run", 10).unwrap().is_empty());

        let expected_cursor = LogCursor {
            run_id: first.run_id.clone(),
            run_ordinal: first.run_ordinal,
            generation: 0,
            offset: 10,
        };
        event.log_cursor = Some(expected_cursor.clone());
        db.record_status_event(&event).unwrap();
        db.record_status_event(&event).unwrap();

        let mut conflicting_retry = event.clone();
        conflicting_retry.log_cursor = Some(LogCursor {
            run_id: second.run_id,
            run_ordinal: second.run_ordinal,
            generation: expected_cursor.generation,
            offset: expected_cursor.offset,
        });
        assert!(matches!(
            db.record_status_event(&conflicting_retry),
            Err(CoreError::Validation(_))
        ));
        assert_eq!(
            db.get_latest_log_cursor("ses_cursor_run").unwrap(),
            Some(expected_cursor)
        );
        assert_eq!(db.status_history("ses_cursor_run", 10).unwrap().len(), 1);
    }

    #[test]
    fn run_and_status_queries_propagate_row_decode_errors() {
        let db = db();
        db.add_project(&project("prj_bad_row")).unwrap();
        db.insert_session(&session("ses_bad_row", "prj_bad_row"))
            .unwrap();
        let run = db.create_session_run("ses_bad_row", "run_bad_row").unwrap();
        db.conn()
            .lock()
            .unwrap()
            .execute(
                "UPDATE session_runs SET created_at=?3
                 WHERE session_id=?1 AND run_id=?2",
                params!["ses_bad_row", &run.run_id, vec![0_u8]],
            )
            .unwrap();
        assert!(matches!(
            db.list_session_runs("ses_bad_row"),
            Err(CoreError::Sqlite(_))
        ));

        db.record_status_event(&StatusEvent {
            session_id: "ses_bad_row".into(),
            run_id: run.run_id.clone(),
            run_ordinal: run.run_ordinal,
            sequence: 1,
            state: AgentState::Working,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some("hook:PreToolUse".into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        })
        .unwrap();
        db.conn()
            .lock()
            .unwrap()
            .execute(
                "UPDATE status_events SET occurred_at=?4
                 WHERE session_id=?1 AND run_id=?2 AND sequence=?3",
                params!["ses_bad_row", &run.run_id, 1_i64, vec![0_u8]],
            )
            .unwrap();

        assert!(matches!(
            db.status_history("ses_bad_row", 10),
            Err(CoreError::Sqlite(_))
        ));
        assert!(matches!(
            db.events_since_cursors(&[(
                "ses_bad_row".into(),
                StatusCursor {
                    run_id: run.run_id,
                    run_ordinal: run.run_ordinal,
                    sequence: 0,
                },
            )]),
            Err(CoreError::Sqlite(_))
        ));
    }

    #[test]
    fn status_projection_waits_for_a_short_wal_writer_collision() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().join("agentport"));
        let setup = Db::open(&paths).unwrap();
        setup.add_project(&project("prj_busy")).unwrap();
        setup
            .insert_session(&session("ses_busy", "prj_busy"))
            .unwrap();
        drop(setup);

        // Hold SQLite's single writer slot while a separate Db handle begins
        // the status projection. `busy_timeout` plus an IMMEDIATE projection
        // transaction must wait and succeed rather than report DATABASE_BUSY.
        let projected = Db::open(&paths).unwrap();
        let blocker = Connection::open(paths.db_path()).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            projected.record_status_event(&StatusEvent {
                session_id: "ses_busy".into(),
                run_id: LEGACY_RUN_ID.into(),
                run_ordinal: LEGACY_RUN_ORDINAL,
                sequence: 1,
                state: AgentState::Working,
                source: StateSource::Hook,
                confidence: Confidence::High,
                evidence: Some("hook:PreToolUse".into()),
                log_cursor: None,
                occurred_at: Utc::now(),
            })
        });
        started_rx.recv().unwrap();
        std::thread::sleep(StdDuration::from_millis(75));
        blocker.execute_batch("COMMIT").unwrap();

        worker.join().unwrap().unwrap();
        let verify = Db::open(&paths).unwrap();
        assert_eq!(verify.status_history("ses_busy", 10).unwrap().len(), 1);
    }

    #[test]
    fn run_scoped_events_keep_latest_and_recovery_monotonic() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_1", "prj_1")).unwrap();
        let first = db.create_session_run("ses_1", "run_first").unwrap();
        let second = db.create_session_run("ses_1", "run_second").unwrap();
        assert_eq!(first.run_ordinal, 1);
        assert_eq!(second.run_ordinal, 2);
        assert_eq!(
            db.create_session_run("ses_1", "run_first")
                .unwrap()
                .run_ordinal,
            first.run_ordinal
        );

        let event =
            |run: &SessionRun, sequence: i64, state: AgentState, evidence: &str| StatusEvent {
                session_id: "ses_1".into(),
                run_id: run.run_id.clone(),
                run_ordinal: run.run_ordinal,
                sequence,
                state,
                source: StateSource::Hook,
                confidence: Confidence::High,
                evidence: Some(evidence.into()),
                log_cursor: None,
                occurred_at: Utc::now(),
            };

        let first_run_event = event(&first, 1, AgentState::Working, "hook:PreToolUse");
        db.record_status_event(&first_run_event).unwrap();
        db.record_status_event(&first_run_event).unwrap(); // same-run retry stays idempotent
        db.record_status_event(&event(
            &second,
            1,
            AgentState::NeedsInput,
            "hook:PermissionRequest",
        ))
        .unwrap(); // same sequence is valid in another run
        db.record_status_event(&event(&first, 2, AgentState::Exited, "process:signal:9"))
            .unwrap(); // late event from an older run

        let history = db.status_history("ses_1", 10).unwrap();
        assert_eq!(history.len(), 3);
        assert!(history
            .iter()
            .any(|event| event.run_id == first.run_id && event.sequence == 1));
        assert!(history
            .iter()
            .any(|event| event.run_id == second.run_id && event.sequence == 1));

        let latest = db.latest_status("ses_1").unwrap().unwrap();
        assert_eq!(latest.run_id, second.run_id);
        assert_eq!(latest.sequence, 1);
        assert_eq!(latest.state, AgentState::NeedsInput);
        assert_eq!(
            db.get_recovery_status_cursor("ses_1").unwrap(),
            StatusCursor {
                run_id: second.run_id.clone(),
                run_ordinal: second.run_ordinal,
                sequence: 1,
            }
        );
        assert_eq!(
            db.get_recovery_summary("ses_1").unwrap().summary_state,
            SummaryState::Waiting
        );

        let second_cursor = StatusCursor {
            run_id: second.run_id.clone(),
            run_ordinal: second.run_ordinal,
            sequence: 1,
        };
        db.set_last_seen_status_cursor("ses_1", &second_cursor)
            .unwrap();
        db.set_last_seen_status_cursor(
            "ses_1",
            &StatusCursor {
                run_id: first.run_id.clone(),
                run_ordinal: first.run_ordinal,
                sequence: 99,
            },
        )
        .unwrap();
        assert_eq!(
            db.get_last_seen_status_cursor("ses_1").unwrap(),
            second_cursor
        );

        let after_first = db
            .events_since_cursors(&[(
                "ses_1".into(),
                StatusCursor {
                    run_id: first.run_id.clone(),
                    run_ordinal: first.run_ordinal,
                    sequence: 1,
                },
            )])
            .unwrap();
        assert_eq!(after_first.len(), 2);
        assert!(after_first
            .iter()
            .any(|event| event.run_id == second.run_id && event.sequence == 1));

        db.mark_output_unread_at(
            "ses_1",
            &LogCursor {
                run_id: first.run_id.clone(),
                run_ordinal: first.run_ordinal,
                generation: 0,
                offset: 10,
            },
        )
        .unwrap();
        db.mark_output_unread_at(
            "ses_1",
            &LogCursor {
                run_id: first.run_id.clone(),
                run_ordinal: first.run_ordinal,
                generation: 0,
                offset: 99,
            },
        )
        .unwrap();
        assert_eq!(
            db.get_unread_log_cursor("ses_1").unwrap().unwrap().offset,
            10
        );
        db.mark_output_unread_at(
            "ses_1",
            &LogCursor {
                run_id: second.run_id.clone(),
                run_ordinal: second.run_ordinal,
                generation: 0,
                offset: 4,
            },
        )
        .unwrap();
        assert_eq!(
            db.get_unread_log_cursor("ses_1").unwrap(),
            Some(LogCursor {
                run_id: second.run_id.clone(),
                run_ordinal: second.run_ordinal,
                generation: 0,
                offset: 4,
            })
        );

        // A delayed seen callback from the first run must not erase output
        // that arrived in the second run. The matching current cursor clears
        // it atomically with its monotonic acknowledgement update.
        db.mark_session_seen_at(
            "ses_1",
            &StatusCursor {
                run_id: first.run_id.clone(),
                run_ordinal: first.run_ordinal,
                sequence: 99,
            },
        )
        .unwrap();
        assert_eq!(
            db.get_unread_log_cursor("ses_1").unwrap().unwrap().offset,
            4
        );
        db.mark_session_seen_at("ses_1", &second_cursor).unwrap();
        assert!(db.get_unread_log_cursor("ses_1").unwrap().is_none());
    }

    #[test]
    fn late_lower_sequence_in_one_run_cannot_regress_summary() {
        let db = db();
        db.add_project(&project("prj_1")).unwrap();
        db.insert_session(&session("ses_1", "prj_1")).unwrap();
        let run = db.create_session_run("ses_1", "run_current").unwrap();
        let event = |sequence: i64, state: AgentState, evidence: &str| StatusEvent {
            session_id: "ses_1".into(),
            run_id: run.run_id.clone(),
            run_ordinal: run.run_ordinal,
            sequence,
            state,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some(evidence.into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        };

        db.record_status_event(&event(2, AgentState::NeedsInput, "hook:PermissionRequest"))
            .unwrap();
        db.record_status_event(&event(1, AgentState::Exited, "process:signal:9"))
            .unwrap();

        let latest = db.latest_status("ses_1").unwrap().unwrap();
        assert_eq!(latest.sequence, 2);
        assert_eq!(latest.state, AgentState::NeedsInput);
        assert_eq!(
            db.get_recovery_summary("ses_1").unwrap().summary_state,
            SummaryState::Waiting
        );
    }

    #[test]
    fn v2_status_rows_migrate_to_the_legacy_run_without_loss() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(schema::MIGRATIONS[0]).unwrap();
        conn.execute_batch(schema::MIGRATIONS[1]).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        let now = dt_str(&Utc::now());
        conn.execute(
            "INSERT INTO projects(id,name,root_path,created_at) VALUES(?1,?2,?3,?4)",
            params!["prj_legacy", "legacy", "/tmp/prj_legacy", &now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions(
                id,project_id,preset_id,title,cwd,host_token,lifecycle,log_path,adapter_type,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                "ses_legacy",
                "prj_legacy",
                "pre_shell_safe",
                "legacy session",
                "/tmp",
                "legacy-token",
                "exited",
                "/tmp/ses_legacy.log",
                "shell",
                &now,
                &now
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO status_events(
                session_id,sequence,state,source,confidence,evidence,occurred_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                "ses_legacy",
                1,
                "exited",
                "process",
                "high",
                "process:exit:0",
                &now
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO latest_status(session_id,sequence,state,source,confidence,occurred_at)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params!["ses_legacy", 1, "exited", "process", "high", &now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO recovery_summary(
                session_id,last_seen_sequence,latest_sequence,unread_output_offset,summary_state,acknowledged_at
             ) VALUES(?1,?2,?3,?4,?5,NULL)",
            params!["ses_legacy", 1, 1, -1, "completed"],
        )
        .unwrap();

        let db = Db::init(conn).unwrap();
        let runs = db.list_session_runs("ses_legacy").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, LEGACY_RUN_ID);
        assert_eq!(runs[0].run_ordinal, LEGACY_RUN_ORDINAL);
        let event = db.latest_status("ses_legacy").unwrap().unwrap();
        assert_eq!(event.run_id, LEGACY_RUN_ID);
        assert_eq!(event.run_ordinal, LEGACY_RUN_ORDINAL);
        assert_eq!(event.sequence, 1);
        assert_eq!(db.status_history("ses_legacy", 10).unwrap().len(), 1);
        assert_eq!(
            db.get_recovery_status_cursor("ses_legacy").unwrap(),
            StatusCursor {
                run_id: LEGACY_RUN_ID.into(),
                run_ordinal: LEGACY_RUN_ORDINAL,
                sequence: 1,
            }
        );
        let summary = db.get_recovery_summary("ses_legacy").unwrap();
        assert_eq!(summary.last_seen_sequence, 1);
        assert_eq!(summary.latest_sequence, 1);
        assert_eq!(summary.summary_state, SummaryState::Completed);
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
            run_id: LEGACY_RUN_ID.into(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            sequence: seq,
            state,
            source: StateSource::Pty,
            confidence: Confidence::Medium,
            evidence: Some(evidence.into()),
            log_cursor: None,
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

        db.record_status_event(&event(3, AgentState::NeedsInput, "pty:pattern:permission"))
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
    fn deleting_worktree_never_detaches_referencing_sessions() {
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
        let mut s = session("ses_1", "prj_1");
        s.worktree_id = Some(w.id.clone());
        s.cwd = w.path.clone();
        db.insert_session(&s).unwrap();

        let error = db.delete_worktree("wt_1").unwrap_err();
        assert!(matches!(error, CoreError::Blocked(_)), "{error}");
        assert_eq!(
            db.get_session("ses_1").unwrap().worktree_id.as_deref(),
            Some("wt_1")
        );
        assert!(db.get_worktree("wt_1").is_ok());

        db.archive_session("ses_1").unwrap();
        let archived_error = db.delete_worktree("wt_1").unwrap_err();
        assert!(
            matches!(archived_error, CoreError::Blocked(_)),
            "{archived_error}"
        );
        db.purge_archived_session("ses_1").unwrap();
        db.delete_worktree("wt_1").unwrap();
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
        assert_eq!(d.log_limit_mib, DEFAULT_LOG_LIMIT_MIB);
        assert_eq!(d.terminal_font_size, 13);
        assert_eq!(d.ui_language, UiLanguage::ZhCn);
        assert!(!d.telemetry_enabled);
        let mut s = d.clone();
        s.ui_language = UiLanguage::EnUs;
        s.theme = Theme::Dark;
        s.terminal_font_size = 18;
        s.terminal_command = "kitty".into();
        s.agent_order = vec!["pi".into(), "qoder".into(), "codex".into()];
        db.save_settings(&s).unwrap();
        let back = db.load_settings().unwrap();
        assert_eq!(back.ui_language, UiLanguage::EnUs);
        assert_eq!(back.theme, Theme::Dark);
        assert_eq!(back.terminal_font_size, 18);
        assert_eq!(back.terminal_command, "kitty");
        assert_eq!(back.agent_order, ["pi", "qoder", "codex"]);
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
    fn invalid_ui_language_falls_back_to_simplified_chinese() {
        let db = db();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES('ui_language','unsupported')",
                [],
            )
            .unwrap();
        assert_eq!(db.load_settings().unwrap().ui_language, UiLanguage::ZhCn);
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
