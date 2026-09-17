//! Retirement of the legacy transcript-body index (PRD 3.6, docs/user-guide.md).
//!
//! Search itself no longer keeps a body index: project/session/branch metadata
//! is queried from SQLite and session text is scanned from the Agent's native
//! logs on demand (`NativeHistory`, and `search_sync` in the desktop shell).
//! What remains here is the one-way cleanup of the retired FTS tables and their
//! compressed display chunks, so an upgrade cannot leave older plaintext
//! postings (or a stale high-water mark) behind in an existing database.
//!
//! The purge is idempotent and transactional: the destructive statements and
//! the completion marker commit together, so a failure leaves the migration
//! unmarked and retryable.

use crate::db::Db;
use crate::error::Result;
use crate::paths::AppPaths;
use rusqlite::{params, Connection};

/// Format marker written by the purge so an old database reports the retired
/// index as healthy instead of "rebuild needed".
pub const INDEX_FORMAT_VERSION: i64 = 3;

const STATE_OK: &str = "ok";
/// Independent app-level migration marker. This deliberately does not share
/// search-index state: an explicit force purge later must not make the one-time
/// upgrade destructive again on every boot.
const LEGACY_TRANSCRIPT_PURGE_MARKER: &str = "migration:legacy_transcript_purge:v1";

/// Kept so the purge can recreate an empty, queryable FTS table after dropping
/// the legacy one. Trigram tokenizer requires SQLite >= 3.34; rusqlite's
/// bundled SQLite is 3.46, so `tokenize='trigram'` is always available.
const FTS_DDL: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    text,
    content='',
    tokenize='trigram',
    detail='none',
    columnsize=0
)";
const META_DDL: &str = "
CREATE TABLE IF NOT EXISTS search_index_chunks(
    rowid INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    chunk_seq INTEGER NOT NULL,
    log_offset INTEGER NOT NULL,
    compressed_text BLOB NOT NULL,
    UNIQUE(session_id, chunk_seq)
);
CREATE INDEX IF NOT EXISTS idx_search_chunks_session
    ON search_index_chunks(session_id, chunk_seq);
CREATE TABLE IF NOT EXISTS search_index_meta(
    session_id TEXT PRIMARY KEY,
    high_water INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS search_index_state(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)";

pub struct SearchIndex<'a> {
    pub db: &'a Db,
    pub paths: &'a AppPaths,
}

impl<'a> SearchIndex<'a> {
    /// Run the legacy transcript-body purge once for this application database.
    ///
    /// The body cleanup and completion marker share one SQLite transaction, so
    /// any failure leaves the migration unmarked and fully retryable. The
    /// marker is checked inside that transaction before any destructive work.
    pub fn purge_legacy_transcript_bodies_once(&self) -> Result<()> {
        let mut conn = self.db.conn().lock().unwrap();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let completed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_meta WHERE key=?1)",
            params![LEGACY_TRANSCRIPT_PURGE_MARKER],
            |row| row.get(0),
        )?;
        if completed {
            tx.commit()?;
            return Ok(());
        }

        purge_transcript_bodies_in(&tx)?;
        // Keep this as the transaction's final write: observing the marker
        // always implies every destructive cleanup statement committed too.
        tx.execute(
            "INSERT INTO app_meta(key,value) VALUES(?1,'complete')",
            params![LEGACY_TRANSCRIPT_PURGE_MARKER],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Explicitly remove every persisted transcript body from the legacy FTS
    /// cache. Unlike `purge_legacy_transcript_bodies_once`, this always purges;
    /// the settings-page rebuild button relies on that force-cleaning behavior.
    pub fn purge_transcript_bodies(&self) -> Result<()> {
        let mut conn = self.db.conn().lock().unwrap();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        purge_transcript_bodies_in(&tx)?;
        tx.commit()?;
        Ok(())
    }
}

fn purge_transcript_bodies_in(conn: &Connection) -> Result<()> {
    conn.execute_batch(META_DDL)?;
    conn.execute_batch("DROP TABLE IF EXISTS search_index")?;
    conn.execute_batch(FTS_DDL)?;
    conn.execute_batch(
        "DELETE FROM search_index_chunks;
         DELETE FROM search_index_meta;",
    )?;
    set_state(conn, "format_version", &INDEX_FORMAT_VERSION.to_string())?;
    set_state(conn, "state", STATE_OK)?;
    Ok(())
}

#[cfg(test)]
fn get_state(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM search_index_state WHERE key=?1",
            params![key],
            |row| row.get(0),
        )
        .ok())
}

fn set_state(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO search_index_state(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        db: Db,
        paths: AppPaths,
        _dir: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().join("data"));
        let db = Db::open_memory().unwrap();
        Fixture {
            db,
            paths,
            _dir: dir,
        }
    }

    impl Fixture {
        fn index(&self) -> SearchIndex<'_> {
            SearchIndex {
                db: &self.db,
                paths: &self.paths,
            }
        }

        /// Recreate what an older AgentPort left behind: FTS postings plus a
        /// compressed display chunk and a high-water mark for one session.
        fn seed_legacy_body(&self, session_id: &str) {
            let conn = self.db.conn().lock().unwrap();
            conn.execute_batch(META_DDL).unwrap();
            conn.execute_batch(FTS_DDL).unwrap();
            // Contentless FTS5 tables are populated with an explicit rowid.
            // Contentless FTS5 tables are populated with an explicit rowid;
            // the purge removes them by dropping the whole table.
            conn.execute(
                "INSERT INTO search_index(rowid,text) VALUES(1,'legacy transcript body')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO search_index_chunks(session_id,chunk_seq,log_offset,compressed_text)
                 VALUES(?1,0,0,x'00')",
                params![session_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO search_index_meta(session_id,high_water) VALUES(?1,42)",
                params![session_id],
            )
            .unwrap();
        }

        fn legacy_body_rows(&self) -> (i64, i64) {
            let conn = self.db.conn().lock().unwrap();
            let chunks: i64 = conn
                .query_row("SELECT count(*) FROM search_index_chunks", [], |row| {
                    row.get(0)
                })
                .unwrap();
            let meta: i64 = conn
                .query_row("SELECT count(*) FROM search_index_meta", [], |row| {
                    row.get(0)
                })
                .unwrap();
            (chunks, meta)
        }

        fn purge_marker_count(&self) -> i64 {
            let conn = self.db.conn().lock().unwrap();
            conn.query_row(
                "SELECT count(*) FROM app_meta WHERE key=?1",
                params![LEGACY_TRANSCRIPT_PURGE_MARKER],
                |row| row.get(0),
            )
            .unwrap()
        }

        fn total_changes(&self) -> u64 {
            self.db.conn().lock().unwrap().total_changes()
        }
    }

    #[test]
    fn purge_transcript_bodies_removes_legacy_fts_and_progress_rows() {
        let f = fixture();
        f.seed_legacy_body("ses_1");
        assert_eq!(f.legacy_body_rows(), (1, 1));

        f.index().purge_transcript_bodies().unwrap();

        assert_eq!(
            f.legacy_body_rows(),
            (0, 0),
            "legacy chunks and high-water marks must be gone (the FTS table is dropped and recreated)"
        );
        let conn = f.db.conn().lock().unwrap();
        // The recreated table is empty but queryable, so later boots do not
        // report data loss on a database that simply has no body index.
        let recreated: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='search_index'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recreated, 1, "the empty FTS table is recreated for later probes");
        assert_eq!(get_state(&conn, "state").unwrap().as_deref(), Some(STATE_OK));
        assert_eq!(
            get_state(&conn, "format_version").unwrap().as_deref(),
            Some(INDEX_VERSION_STR)
        );
    }

    const INDEX_VERSION_STR: &str = "3";

    #[test]
    fn legacy_transcript_purge_runs_once_but_force_purge_still_runs() {
        let f = fixture();
        f.seed_legacy_body("ses_1");

        f.index().purge_legacy_transcript_bodies_once().unwrap();
        assert_eq!(f.legacy_body_rows(), (0, 0));
        assert_eq!(f.purge_marker_count(), 1);
        let changes_after_migration = f.total_changes();

        f.index().purge_legacy_transcript_bodies_once().unwrap();
        assert_eq!(
            f.total_changes(),
            changes_after_migration,
            "completed migration must not perform another SQLite write",
        );

        // Derived data created after the migration (by an older build sharing
        // the database) must survive a boot-time call.
        f.seed_legacy_body("ses_2");
        f.index().purge_legacy_transcript_bodies_once().unwrap();
        assert_eq!(
            f.legacy_body_rows(),
            (1, 1),
            "completed migration must be a destructive no-op"
        );

        // The settings-page rebuild keeps an explicit force-cleaning path.
        f.index().purge_transcript_bodies().unwrap();
        assert_eq!(f.legacy_body_rows(), (0, 0));
        assert_eq!(f.purge_marker_count(), 1);
    }
}
