//! Scoped backup snapshots and serialized, insert-only Session imports.
use super::*;
use std::path::Path;

impl Db {
    /// Operates ONLY on an expendable snapshot, never the live database.
    pub(crate) fn retain_backup_agent(&self, agent: AgentType) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        conn.execute_batch("PRAGMA secure_delete=ON;")?;
        let tx = conn.transaction()?;
        for table in [
            "status_events",
            "latest_status",
            "recovery_summary",
            "session_runs",
            "redaction_audit",
        ] {
            tx.execute(&format!("DELETE FROM {table} WHERE session_id NOT IN (SELECT id FROM sessions WHERE adapter_type=?1)"), [agent.as_str()])?;
        }
        tx.execute(
            "DELETE FROM sessions WHERE adapter_type<>?1",
            [agent.as_str()],
        )?;
        // Operational journals, preferences, adapter probes and credential references
        // are not Session history and must not cross the backup boundary.
        for table in [
            "branch_operation_steps",
            "branch_operations",
            "git_commit_operations",
            "cleanup_jobs",
            "settings",
            "app_meta",
            "presets",
            "secret_refs",
            "adapters",
        ] {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        tx.execute("DELETE FROM worktrees WHERE id NOT IN (SELECT worktree_id FROM sessions WHERE worktree_id IS NOT NULL)", [])?;
        tx.execute(
            "DELETE FROM projects WHERE id NOT IN (SELECT project_id FROM sessions)",
            [],
        )?;
        tx.execute_batch("UPDATE sessions SET host_pid=NULL, host_socket=NULL, host_token='', host_run_id=NULL, host_run_ordinal=NULL;")?;
        tx.commit()?;
        // Deleted rows must not remain recoverable from free pages in the archive.
        conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    /// The live connection lock + IMMEDIATE transaction fence concurrent Session
    /// creation/deletion throughout preflight and filesystem publication.
    pub(crate) fn merge_backup<F>(
        &self,
        snapshot: &Path,
        paths: &AppPaths,
        publish: F,
    ) -> Result<(Vec<String>, Vec<String>)>
    where
        F: FnOnce(&[String]) -> Result<()>,
    {
        let mut conn = self.conn.lock().unwrap();
        conn.execute(
            "ATTACH DATABASE ?1 AS restore_source",
            [snapshot.to_string_lossy().as_ref()],
        )?;
        let result = (|| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            // An ID shared by different providers is not a duplicate to silently skip.
            let collision: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM restore_source.sessions b JOIN sessions s ON s.id=b.id WHERE s.adapter_type<>b.adapter_type)", [], |r| r.get(0))?;
            if collision {
                return Err(CoreError::Conflict(
                    "backup Session ID belongs to a different agent".into(),
                ));
            }
            tx.execute_batch("CREATE TEMP TABLE restore_ids AS SELECT id FROM restore_source.sessions WHERE id NOT IN (SELECT id FROM main.sessions);")?;
            let ids = strings(&tx, "SELECT id FROM restore_ids ORDER BY id")?;
            let skipped = strings(&tx, "SELECT id FROM restore_source.sessions WHERE id NOT IN (SELECT id FROM restore_ids) ORDER BY id")?;
            for id in &ids {
                if id.is_empty()
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    return Err(CoreError::Validation("unsafe backup Session ID".into()));
                }
                let fenced: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM cleanup_jobs WHERE session_id=?1)",
                    [id],
                    |r| r.get(0),
                )?;
                if fenced {
                    return Err(CoreError::Conflict(format!(
                        "Session {id} has pending cleanup"
                    )));
                }
            }
            let native_collision: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM restore_source.sessions b JOIN sessions s ON s.adapter_type=b.adapter_type AND s.agent_session_id=b.agent_session_id WHERE b.id IN (SELECT id FROM restore_ids) AND b.agent_session_id IS NOT NULL)", [], |r| r.get(0))?;
            if native_collision {
                return Err(CoreError::Conflict(
                    "native Session already belongs to another AgentPort Session".into(),
                ));
            }
            // Reuse projects by checkout path, even when another install assigned
            // a different project ID. Never update an existing project's metadata.
            tx.execute_batch("CREATE TEMP TABLE restore_projects AS SELECT b.id AS old_id, COALESCE(p.id,b.id) AS new_id FROM restore_source.projects b LEFT JOIN main.projects p ON p.root_path=b.root_path WHERE b.id IN (SELECT project_id FROM restore_source.sessions WHERE id IN (SELECT id FROM restore_ids));")?;
            let project_collision: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM restore_projects m JOIN restore_source.projects b ON b.id=m.old_id JOIN main.projects p ON p.id=m.new_id WHERE p.root_path<>b.root_path)", [], |r| r.get(0))?;
            if project_collision {
                return Err(CoreError::Conflict(
                    "backup project ID refers to a different checkout".into(),
                ));
            }
            for project in strings(&tx, "SELECT new_id FROM restore_projects")? {
                ensure_project_not_removing_conn(&tx, &project)?;
            }
            insert_rows(&tx, "projects", "b.id IN (SELECT old_id FROM restore_projects) AND b.root_path NOT IN (SELECT root_path FROM main.projects)", false, &[])?;
            let worktree_removing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM restore_source.sessions b JOIN main.app_meta m ON m.key='worktree_removal_in_progress:' || b.worktree_id WHERE b.id IN (SELECT id FROM restore_ids))", [], |r| r.get(0))?;
            if worktree_removing {
                return Err(CoreError::Conflict(
                    "backup worktree is being removed".into(),
                ));
            }
            // A conflicting worktree is a hard failure, not an instruction to move
            // or recreate a checkout. Worktree files are never restored.
            let worktree_collision: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM restore_source.worktrees b JOIN main.worktrees w ON w.id=b.id OR w.path=b.path WHERE b.id IN (SELECT worktree_id FROM restore_source.sessions WHERE id IN (SELECT id FROM restore_ids)) AND (w.id<>b.id OR w.path<>b.path OR w.branch<>b.branch OR w.project_id<>(SELECT new_id FROM restore_projects WHERE old_id=b.project_id)))", [], |r| r.get(0))?;
            if worktree_collision {
                return Err(CoreError::Conflict(
                    "backup worktree conflicts with an existing checkout".into(),
                ));
            }
            insert_rows(&tx, "worktrees", "b.id IN (SELECT worktree_id FROM restore_source.sessions WHERE id IN (SELECT id FROM restore_ids)) AND b.id NOT IN (SELECT id FROM main.worktrees)", false, &[("project_id", "(SELECT new_id FROM restore_projects WHERE old_id=b.project_id)")])?;
            insert_rows(
                &tx,
                "sessions",
                "b.id IN (SELECT id FROM restore_ids)",
                false,
                &[(
                    "project_id",
                    "(SELECT new_id FROM restore_projects WHERE old_id=b.project_id)",
                )],
            )?;
            for id in &ids {
                tx.execute("UPDATE sessions SET host_pid=NULL,host_socket=NULL,host_token='',host_run_id=NULL,host_run_ordinal=NULL,log_path=?2,lifecycle=CASE WHEN lifecycle IN ('creating','running') THEN 'interrupted' ELSE lifecycle END WHERE id=?1", params![id, paths.log_path(id).to_string_lossy()])?;
            }
            for table in [
                "session_runs",
                "status_events",
                "latest_status",
                "recovery_summary",
                "redaction_audit",
            ] {
                insert_rows(
                    &tx,
                    table,
                    "b.session_id IN (SELECT id FROM restore_ids)",
                    matches!(table, "status_events" | "redaction_audit"),
                    &[],
                )?;
            }
            // SQL constraints are checked before native files are installed.
            publish(&ids)?;
            tx.execute_batch("DROP TABLE restore_ids; DROP TABLE restore_projects;")?;
            tx.commit()?;
            Ok((ids, skipped))
        })();
        let detached = conn.execute_batch("DETACH DATABASE restore_source;");
        match result {
            Ok(report) => {
                detached?;
                Ok(report)
            }
            Err(error) => Err(error),
        }
    }
}

fn strings(conn: &Connection, sql: &str) -> Result<Vec<String>> {
    Ok(conn
        .prepare(sql)?
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Names come only from the fixed table list and the trusted live schema; no
/// archive-supplied SQL or column names are interpolated.
fn insert_rows(
    conn: &Connection,
    table: &str,
    filter: &str,
    omit_id: bool,
    replacements: &[(&str, &str)],
) -> Result<()> {
    let columns: Vec<String> = conn
        .prepare(&format!("PRAGMA main.table_info({table})"))?
        .query_map([], |r| r.get(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let columns: Vec<_> = columns
        .into_iter()
        .filter(|c| !omit_id || c != "id")
        .collect();
    let values: Vec<_> = columns
        .iter()
        .map(|c| {
            replacements
                .iter()
                .find(|(name, _)| name == c)
                .map(|(_, value)| value.to_string())
                .unwrap_or_else(|| format!("b.\"{c}\""))
        })
        .collect();
    let names = columns
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(",");
    conn.execute(&format!("INSERT INTO main.{table} ({names}) SELECT {} FROM restore_source.{table} b WHERE {filter}", values.join(",")), [])?;
    Ok(())
}
