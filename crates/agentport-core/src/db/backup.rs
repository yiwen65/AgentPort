//! Scoped backup snapshots and serialized, insert-only Session imports.
use super::*;
use std::path::Path;

const SNAPSHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

impl Db {
    pub fn backup_snapshot(&self, dest: &Path) -> Result<()> {
        self.backup_snapshot_with_progress(dest, &mut |_, _| {})
    }

    /// Pin a WAL read view on a separate connection. Without the explicit read
    /// transaction, every external Host write can restart incremental backup.
    pub(crate) fn backup_snapshot_with_progress(
        &self,
        dest: &Path,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<()> {
        // Exclusively create the destination; never overwrite an existing file.
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(dest) {
            Ok(file) => drop(file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(CoreError::Conflict(format!(
                    "backup snapshot destination already exists: {}",
                    dest.display()
                )));
            }
            Err(error) => return Err(error.into()),
        }
        let result = (|| {
            let mut target = Connection::open(dest)?;
            target.busy_timeout(std::time::Duration::from_millis(50))?;
            if let Some(path) = &self.snapshot_source {
                let source =
                    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                source.busy_timeout(std::time::Duration::from_millis(50))?;
                copy_snapshot(&source, &mut target, progress, SNAPSHOT_TIMEOUT)
            } else {
                // In-memory fixtures have no second connection to the same DB.
                let source = self.conn.lock().unwrap();
                copy_snapshot(&source, &mut target, progress, SNAPSHOT_TIMEOUT)
            }
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(dest);
        }
        result
    }

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
                tx.execute("UPDATE sessions SET host_pid=NULL,host_socket=NULL,host_token='',host_run_id=NULL,host_run_ordinal=NULL,lifecycle=CASE WHEN lifecycle IN ('creating','running') THEN 'interrupted' ELSE lifecycle END WHERE id=?1", params![id])?;
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

fn copy_snapshot(
    source: &Connection,
    target: &mut Connection,
    progress: &mut dyn FnMut(u64, u64),
    timeout: std::time::Duration,
) -> Result<()> {
    use rusqlite::backup::{Backup, StepResult};
    let deadline = std::time::Instant::now() + timeout;
    let read = source.unchecked_transaction()?;
    // BEGIN is deferred: an actual read is required to establish the snapshot.
    read.query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
        row.get::<_, i64>(0)
    })?;
    let backup = Backup::new(&read, target)?;
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(CoreError::Timeout("database backup exceeded its time limit; no archive was published, retry when disk/lock contention subsides".into()));
        }
        let step = backup.step(256)?;
        let current = backup.progress();
        if current.pagecount > 0 {
            progress(
                (current.pagecount - current.remaining).max(0) as u64,
                current.pagecount as u64,
            );
        }
        match step {
            StepResult::Done => return Ok(()),
            StepResult::More => {} // no artificial pause on healthy progress
            StepResult::Busy | StepResult::Locked => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            _ => {
                return Err(CoreError::Internal(
                    "unexpected SQLite backup result".into(),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    use std::time::{Duration, Instant};

    /// Opt-in reproduction against a busy installation, without opening the
    /// live DB for writes or keeping a second copy of its sensitive contents.
    #[test]
    #[ignore = "requires AGENTPORT_BACKUP_READ_ONLY_SOURCE pointing to an explicitly selected live database"]
    fn backup_snapshot_live_source_read_only() {
        let source = std::path::PathBuf::from(
            std::env::var_os("AGENTPORT_BACKUP_READ_ONLY_SOURCE")
                .expect("explicit source required"),
        );
        let readonly =
            Connection::open_with_flags(&source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let db = Db {
            conn: Mutex::new(readonly),
            snapshot_source: Some(source),
        };
        let temp = tempfile::tempdir().unwrap();
        let snapshot = temp.path().join("snapshot.db");
        let start = Instant::now();
        let mut steps = Vec::new();
        db.backup_snapshot_with_progress(&snapshot, &mut |done, total| steps.push((done, total)))
            .unwrap();
        assert!(steps
            .windows(2)
            .all(|pair| pair[1].0 >= pair[0].0 && pair[1].1 == pair[0].1));
        let copy =
            Connection::open_with_flags(&snapshot, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        assert_eq!(
            copy.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        eprintln!(
            "live read-only snapshot: {:?}, steps={}, final_pages={:?}, integrity=ok",
            start.elapsed(),
            steps.len(),
            steps.last()
        );
    }

    #[test]
    fn backup_snapshot_pins_one_view_without_holding_the_live_mutex() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let db = Db::open(&paths).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO app_meta VALUES ('large_fixture',zeroblob(4194304))",
                [],
            )
            .unwrap();
        let mut steps = Vec::new();
        let snapshot = temp.path().join("snapshot.db");
        db.backup_snapshot_with_progress(&snapshot, &mut |done, total| {
            // A write after the first step must remain possible and must NOT
            // reset progress or appear in this already-pinned snapshot.
            if steps.is_empty() {
                db.conn
                    .try_lock()
                    .expect("live database mutex was held during backup")
                    .execute("INSERT INTO app_meta VALUES ('after_snapshot','new')", [])
                    .unwrap();
            }
            steps.push((done, total));
        })
        .unwrap();
        assert!(steps.len() > 1);
        assert!(steps
            .windows(2)
            .all(|pair| pair[1].0 >= pair[0].0 && pair[1].1 == pair[0].1));
        assert_eq!(steps.last().unwrap().0, steps.last().unwrap().1);
        let copy = Connection::open(snapshot).unwrap();
        assert_eq!(
            copy.query_row(
                "SELECT count(*) FROM app_meta WHERE key='after_snapshot'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM app_meta WHERE key='after_snapshot'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn backup_snapshot_lock_contention_has_a_deadline() {
        let temp = tempfile::tempdir().unwrap();
        let source = Connection::open_in_memory().unwrap();
        source
            .execute_batch("CREATE TABLE example(value); INSERT INTO example VALUES(1);")
            .unwrap();
        let path = temp.path().join("locked.db");
        let mut target = Connection::open(&path).unwrap();
        target.busy_timeout(Duration::from_millis(1)).unwrap();
        let blocker = Connection::open(&path).unwrap();
        blocker
            .execute_batch("BEGIN EXCLUSIVE; CREATE TABLE locked(value);")
            .unwrap();
        let start = Instant::now();
        let result = copy_snapshot(
            &source,
            &mut target,
            &mut |_, _| {},
            Duration::from_millis(40),
        );
        assert!(matches!(result, Err(CoreError::Timeout(_))), "{result:?}");
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn backup_snapshot_finishes_while_another_connection_keeps_writing() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let db = Arc::new(Db::open(&paths).unwrap());
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO app_meta VALUES ('large_fixture', zeroblob(4194304))",
                [],
            )
            .unwrap();
        let writing = Arc::new(AtomicBool::new(true));
        let keep_writing = writing.clone();
        let source = paths.db_path();
        let (ready_tx, ready_rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let conn = Connection::open(source).unwrap();
            conn.busy_timeout(Duration::from_secs(2)).unwrap();
            let mut count = 0;
            while keep_writing.load(Ordering::Relaxed) {
                conn.execute(
                    "INSERT OR REPLACE INTO app_meta VALUES ('writer_tick',?1)",
                    [count],
                )
                .unwrap();
                if count == 0 {
                    ready_tx.send(()).unwrap();
                }
                count += 1;
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        ready_rx.recv().unwrap();
        let worker_db = db.clone();
        let snapshot = temp.path().join("snapshot.db");
        let worker_snapshot = snapshot.clone();
        let (tx, rx) = mpsc::channel();
        let start = Instant::now();
        let worker = std::thread::spawn(move || {
            tx.send(worker_db.backup_snapshot(&worker_snapshot))
                .unwrap();
        });
        let result = rx.recv_timeout(Duration::from_secs(2));
        writing.store(false, Ordering::Relaxed);
        writer.join().unwrap();
        // Let a failing legacy worker finish after writes stop; do not leave
        // a background thread or a permanently hung test process behind.
        worker.join().unwrap();
        assert!(
            result.is_ok(),
            "snapshot did not finish with continuous writes: elapsed {:?}",
            start.elapsed()
        );
        result.unwrap().unwrap();
        let copy = Connection::open(snapshot).unwrap();
        assert_eq!(
            copy.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            copy.query_row(
                "SELECT length(value) FROM app_meta WHERE key='large_fixture'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            4194304
        );
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
