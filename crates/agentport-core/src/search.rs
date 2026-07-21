//! Full-text search over stripped terminal text + metadata (PRD 3.6, P2).
//!
//! - Source of truth is the log files + SQLite metadata; the index is a derived
//!   FTS5 table that can be dropped and rebuilt at any time without touching
//!   sources.
//! - Only ANSI-stripped text is indexed. Secret values and env var values are
//!   never indexed — index input passes through the redactor first.
//! - Queries trigger at >= 2 chars (metadata LIKE) and >= 3 chars (FTS trigram
//!   on terminal text); partial results are flagged when generations rotated or
//!   the index is rebuilding.
//! - Corrupt/mismatched index -> pause indexed queries, fall back to current-
//!   session text search, rebuild in background (PRD 3.6 failure B).

use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::paths::AppPaths;
use crate::redact::redact_bytes;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

pub const INDEX_FORMAT_VERSION: i64 = 1;
pub const MIN_QUERY_CHARS: usize = 2;
pub const MIN_FTS_CHARS: usize = 3;
/// Chunk size of stripped text indexed per row.
pub const INDEX_CHUNK_BYTES: usize = 1024;

/// Snippets keep at most this many chars (PRD 3.6: 匹配行原文截 120 字符).
const SNIPPET_MAX_CHARS: usize = 120;
/// Chunks with a higher share of control / invalid-UTF-8 chars are treated as
/// binary-ish output and NOT indexed: they are unsearchable in practice and
/// would only bloat the trigram index (PRD ch.10 size budget). The high-water
/// mark still advances past them — skipped means "not searchable", not "retry".
const MAX_BAD_CHAR_RATIO: f64 = 0.30;
/// Bound memory used by a focused-session fallback search, even when the
/// retained output log is close to its configured size limit.
const FOCUSED_SEARCH_CHUNK_BYTES: usize = 64 * 1024;
const FOCUSED_SEARCH_MIN_OVERLAP_BYTES: usize = 1024;

const STATE_OK: &str = "ok";
const STATE_REBUILD_NEEDED: &str = "rebuild_needed";

/// Kept separate from META_DDL so rebuild_all can drop + recreate only the FTS
/// table. Trigram tokenizer requires SQLite >= 3.34; rusqlite's bundled SQLite
/// is 3.46, so `tokenize='trigram'` is always available.
const FTS_DDL: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    session_id UNINDEXED,
    chunk_seq UNINDEXED,
    log_offset UNINDEXED,
    text,
    tokenize='trigram'
)";
const META_DDL: &str = "
CREATE TABLE IF NOT EXISTS search_index_meta(
    session_id TEXT PRIMARY KEY,
    high_water INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS search_index_state(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)";

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub kind: HitKind,
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    pub title: String,
    pub snippet: String,
    /// Byte offset in the session log (current generation) for terminal hits;
    /// None when the generation rotated away.
    pub log_offset: Option<u64>,
    pub rotated_away: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitKind {
    Project,
    Session,
    Branch,
    Terminal,
}

#[derive(Debug, Clone, Default)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// Some index areas were unavailable (rotation/rebuild) — PRD 3.6 "部分结果".
    pub partial: bool,
    /// Total matches before the caller's display limit. Global FTS queries do
    /// not currently calculate this, but focused terminal-log searches do so
    /// the UI never mistakes a replay-buffer subset for the whole history.
    pub total_hits: Option<usize>,
}

/// Health of the derived index, for the settings page / background rebuilder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexState {
    Ok,
    /// Index paused: queries degrade to metadata + partial results until
    /// `rebuild_all` completes. This module never spawns threads itself — the
    /// caller owns scheduling.
    RebuildNeeded,
}

pub struct SearchIndex<'a> {
    pub db: &'a Db,
    pub paths: &'a AppPaths,
}

impl<'a> SearchIndex<'a> {
    /// Create the FTS5 table (trigram tokenizer) if absent; check format
    /// version; schedule rebuild when mismatched/corrupt.
    pub fn open(&self) -> Result<()> {
        let conn = self.db.conn().lock().unwrap();
        conn.execute_batch(META_DDL)?;
        let version = get_state(&conn, "format_version")?;
        let prior_state = get_state(&conn, "state")?;
        // Probe BEFORE creating the FTS table: CREATE IF NOT EXISTS would
        // silently heal a dropped table and mask the data loss. (PRAGMA
        // integrity_check would scan the whole database — too expensive here;
        // a failed read on the FTS table surfaces broken/dropped shadow
        // tables just as well.)
        let fts_ok = probe_index(&conn);
        // (Re)create so every later operation finds its tables.
        conn.execute_batch(FTS_DDL)?;
        if version.is_none() && prior_state.is_none() {
            // Fresh database: adopt the current format; an empty index is a
            // valid index.
            set_state(&conn, "format_version", &INDEX_FORMAT_VERSION.to_string())?;
            set_state(&conn, "state", STATE_OK)?;
            return Ok(());
        }
        let version_ok =
            version.as_deref().and_then(|v| v.parse::<i64>().ok()) == Some(INDEX_FORMAT_VERSION);
        let state_ok = matches!(
            prior_state.as_deref(),
            Some(STATE_OK) | Some(STATE_REBUILD_NEEDED)
        );
        if !version_ok || !fts_ok || !state_ok {
            set_state(&conn, "state", STATE_REBUILD_NEEDED)?;
        }
        Ok(())
    }

    /// Current index health — drives the "索引需要重建" banner and the
    /// settings-page rebuild button (PRD 8 索引重建中).
    pub fn index_state(&self) -> Result<IndexState> {
        let conn = self.db.conn().lock().unwrap();
        Ok(match get_state(&conn, "state")?.as_deref() {
            Some(STATE_OK) => IndexState::Ok,
            _ => IndexState::RebuildNeeded,
        })
    }

    /// Remove derived FTS data for sessions that were permanently deleted.
    /// The source-of-truth session rows are removed in the same user action;
    /// this prevents stale index rows from accumulating until the next rebuild.
    pub fn remove_sessions(&self, session_ids: &[String]) -> Result<()> {
        if session_ids.is_empty() {
            return Ok(());
        }
        self.open()?;
        let conn = self.db.conn().lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for session_id in session_ids {
            tx.execute(
                "DELETE FROM search_index WHERE session_id=?1",
                params![session_id],
            )?;
            tx.execute(
                "DELETE FROM search_index_meta WHERE session_id=?1",
                params![session_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Index one session's log: strip ANSI, redact, chunk, upsert rows with
    /// (session_id, chunk_seq, log_offset, text). Tracks a per-session
    /// high-water mark so repeated calls are incremental. Returns the number
    /// of new raw log bytes consumed this call.
    pub fn index_session_log(
        &self,
        session_id: &str,
        log_path: &Path,
        secrets: &[Vec<u8>],
    ) -> Result<u64> {
        // Read-only open: source logs are never modified (PRD 3.6 failure B).
        let mut file = File::open(log_path)?;
        let file_len = file.metadata()?.len();

        let conn = self.db.conn().lock().unwrap();
        let mut high_water: u64 = conn
            .query_row(
                "SELECT high_water FROM search_index_meta WHERE session_id=?1",
                params![session_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0) as u64;

        if file_len < high_water {
            // Log rotated (current generation shorter than what we already
            // indexed): every indexed row points into a dropped generation, so
            // delete them all and start over from offset 0.
            conn.execute(
                "DELETE FROM search_index WHERE session_id=?1",
                params![session_id],
            )?;
            conn.execute(
                "INSERT INTO search_index_meta(session_id,high_water,indexed_at) VALUES(?1,0,?2)
                 ON CONFLICT(session_id) DO UPDATE SET high_water=0, indexed_at=excluded.indexed_at",
                params![session_id, Utc::now().to_rfc3339()],
            )?;
            high_water = 0;
        }
        if file_len == high_water {
            return Ok(0);
        }

        file.seek(SeekFrom::Start(high_water))?;
        let mut raw = Vec::new();
        file.read_to_end(&mut raw)?;
        let consumed = raw.len() as u64;

        let mut next_seq: i64 = conn.query_row(
            "SELECT COALESCE(MAX(chunk_seq), -1) + 1 FROM search_index WHERE session_id=?1",
            params![session_id],
            |r| r.get(0),
        )?;

        // Strip ANSI + redact + filter per chunk BEFORE anything reaches the
        // index (PRD 3.7: secrets must never be indexed; redact_bytes is the
        // one-shot redactor applied to each chunk). log_offset is the chunk's
        // start byte in the raw log so hits map back to logs::read_range.
        let mut rows: Vec<(i64, i64, String)> = Vec::new();
        for (i, chunk) in raw.chunks(INDEX_CHUNK_BYTES).enumerate() {
            let log_offset = high_water + (i * INDEX_CHUNK_BYTES) as u64;
            let stripped = strip_ansi_escapes::strip(chunk);
            let (redacted, _hits) = redact_bytes(&stripped, secrets);
            let text = String::from_utf8_lossy(&redacted);
            if !mostly_printable(&text) {
                continue;
            }
            rows.push((next_seq, log_offset as i64, text.into_owned()));
            next_seq += 1;
        }

        let tx = conn.unchecked_transaction()?;
        {
            let mut st = tx.prepare(
                "INSERT INTO search_index(session_id,chunk_seq,log_offset,text) VALUES(?1,?2,?3,?4)",
            )?;
            for (seq, off, text) in &rows {
                st.execute(params![session_id, seq, off, text])?;
            }
        }
        tx.execute(
            "INSERT INTO search_index_meta(session_id,high_water,indexed_at) VALUES(?1,?2,?3)
             ON CONFLICT(session_id) DO UPDATE SET high_water=excluded.high_water,
               indexed_at=excluded.indexed_at",
            params![
                session_id,
                (high_water + consumed) as i64,
                Utc::now().to_rfc3339()
            ],
        )?;
        tx.commit()?;
        Ok(consumed)
    }

    /// Drop + rebuild ALL index rows from logs/metadata. Source logs are opened
    /// read-only and never modified (PRD 3.6 failure B). Cancellable via
    /// progress callback returning false: on cancellation everything indexed so
    /// far is kept, state stays `rebuild_needed` (queries keep flagging partial
    /// results) and Ok(()) is returned — the caller may resume later.
    pub fn rebuild_all(&self, progress: &mut dyn FnMut(u32, u32) -> bool) -> Result<()> {
        let sessions = self.db.list_sessions(None, true)?; // include archived
        {
            let conn = self.db.conn().lock().unwrap();
            conn.execute_batch(META_DDL)?; // in case open() never ran
            set_state(&conn, "state", STATE_REBUILD_NEEDED)?;
            // Drop + recreate clears stale rows AND broken shadow tables.
            conn.execute_batch("DROP TABLE IF EXISTS search_index")?;
            conn.execute_batch("DELETE FROM search_index_meta")?;
            conn.execute_batch(FTS_DDL)?;
        }
        let total = sessions.len() as u32;
        let mut done: u32 = 0;
        for s in &sessions {
            // Logs were already redacted at write time (logs.rs), so a rebuild
            // has no secret values to apply — pass an empty set.
            match self.index_session_log(&s.id, Path::new(&s.log_path), &[]) {
                Ok(_) => {}
                // Session never produced a log file — nothing to index.
                Err(CoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            done += 1;
            if !progress(done, total) {
                return Ok(()); // cancelled — see doc comment
            }
        }
        let conn = self.db.conn().lock().unwrap();
        set_state(&conn, "format_version", &INDEX_FORMAT_VERSION.to_string())?;
        set_state(&conn, "state", STATE_OK)?;
        Ok(())
    }

    pub fn query(&self, q: &str, limit: usize) -> Result<SearchResult> {
        if q.chars().count() < MIN_QUERY_CHARS {
            return Err(CoreError::Validation(format!(
                "search query needs at least {MIN_QUERY_CHARS} characters"
            )));
        }
        let conn = self.db.conn().lock().unwrap();
        let mut result = SearchResult::default();
        // Missing/garbage state (or open() never ran) => index unavailable.
        let index_ok = matches!(get_state(&conn, "state"), Ok(Some(s)) if s == STATE_OK);
        let mut partial = !index_ok;
        let lim = limit as i64;

        // ---- metadata: projects / sessions / worktree branches (LIKE %q%) ----
        let like = format!("%{}%", like_escape(q));
        {
            let mut st = conn.prepare(
                "SELECT id,name,root_path FROM projects
                 WHERE name LIKE ?1 ESCAPE '\\' OR root_path LIKE ?1 ESCAPE '\\'
                 ORDER BY name LIMIT ?2",
            )?;
            let rows = st.query_map(params![like, lim], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (id, name, root_path) = row?;
                result.hits.push(SearchHit {
                    kind: HitKind::Project,
                    session_id: None,
                    project_id: Some(id),
                    title: name,
                    snippet: root_path,
                    log_offset: None,
                    rotated_away: false,
                });
            }
        }
        {
            let mut st = conn.prepare(
                "SELECT id,project_id,title,cwd FROM sessions
                 WHERE title LIKE ?1 ESCAPE '\\' OR cwd LIKE ?1 ESCAPE '\\'
                 ORDER BY updated_at DESC LIMIT ?2",
            )?;
            let rows = st.query_map(params![like, lim], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?;
            for row in rows {
                let (id, project_id, title, cwd) = row?;
                result.hits.push(SearchHit {
                    kind: HitKind::Session,
                    session_id: Some(id),
                    project_id: Some(project_id),
                    title,
                    snippet: cwd,
                    log_offset: None,
                    rotated_away: false,
                });
            }
        }
        {
            let mut st = conn.prepare(
                "SELECT project_id,branch,path FROM worktrees
                 WHERE branch LIKE ?1 ESCAPE '\\'
                 ORDER BY branch LIMIT ?2",
            )?;
            let rows = st.query_map(params![like, lim], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (project_id, branch, path) = row?;
                result.hits.push(SearchHit {
                    kind: HitKind::Branch,
                    session_id: None,
                    project_id: Some(project_id),
                    title: branch,
                    snippet: path,
                    log_offset: None,
                    rotated_away: false,
                });
            }
        }

        // ---- terminal text: FTS5 trigram (>= MIN_FTS_CHARS, index healthy) ----
        if index_ok && q.chars().count() >= MIN_FTS_CHARS && limit > 0 {
            match query_terminal(&conn, q, limit, &mut result.hits) {
                Ok(rotated) => partial |= rotated,
                Err(_) => {
                    // The index broke after open() (shadow table dropped,
                    // disk error, ...): pause indexed queries (PRD 3.6 failure
                    // B) and degrade to metadata-only results; the caller can
                    // fall back to query_session_text for the focused session.
                    let _ = set_state(&conn, "state", STATE_REBUILD_NEEDED);
                    partial = true;
                }
            }
        }
        result.partial = partial;
        Ok(result)
    }

    /// Current-session fallback when the index is unavailable (PRD failure B).
    /// Naive case-insensitive substring search over the ANSI-stripped log.
    pub fn query_session_text(
        &self,
        session_id: &str,
        q: &str,
        limit: usize,
    ) -> Result<SearchResult> {
        if q.chars().count() < MIN_QUERY_CHARS {
            return Err(CoreError::Validation(format!(
                "search query needs at least {MIN_QUERY_CHARS} characters"
            )));
        }
        let session = self.db.get_session(session_id)?;
        let file = match File::open(&session.log_path) {
            Ok(file) => file,
            // No output yet — empty result, not an error.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SearchResult::default())
            }
            Err(e) => return Err(e.into()),
        };
        query_session_log_stream(
            BufReader::new(file),
            session_id,
            &session.project_id,
            &session.title,
            q,
            limit,
        )
    }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/// Scan a persisted terminal log in bounded windows. A terminal transcript can
/// contain a full-screen TUI redraw as one enormous carriage-return-delimited
/// record, so line-based readers are not sufficient here. Carrying the tail of
/// each window preserves a match that crosses a chunk boundary without ever
/// materialising the complete log in memory.
fn query_session_log_stream<R: Read>(
    mut reader: R,
    session_id: &str,
    project_id: &str,
    title: &str,
    q: &str,
    limit: usize,
) -> Result<SearchResult> {
    let needle = q.to_lowercase();
    let overlap = FOCUSED_SEARCH_MIN_OVERLAP_BYTES
        .max(needle.len())
        .min(FOCUSED_SEARCH_CHUNK_BYTES);
    let mut result = SearchResult::default();
    let mut total_hits = 0usize;
    let mut raw_offset = 0u64;
    let mut carry: Vec<u8> = Vec::with_capacity(overlap);
    let mut chunk = vec![0u8; FOCUSED_SEARCH_CHUNK_BYTES];

    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        let current_start = raw_offset;
        raw_offset += read as u64;

        let carry_len = carry.len();
        let window_start = current_start.saturating_sub(carry_len as u64);
        let mut window = Vec::with_capacity(carry_len + read);
        window.extend_from_slice(&carry);
        window.extend_from_slice(&chunk[..read]);

        // PTY control sequences never need to be searchable themselves. We
        // match the original stream first so raw offsets remain useful, then
        // strip ANSI only for the compact UI snippet when a hit is found.
        let text = String::from_utf8_lossy(&window);
        let lowered = text.to_lowercase();
        let mut display_text: Option<String> = None;
        for (match_offset, _) in lowered.match_indices(&needle) {
            let match_end = match_offset.saturating_add(needle.len());
            // A match wholly inside the carried tail was counted in the prior
            // window. A boundary-spanning match is new and must be retained.
            if match_end <= carry_len {
                continue;
            }
            total_hits += 1;
            if result.hits.len() >= limit {
                continue;
            }
            let clean = display_text.get_or_insert_with(|| {
                String::from_utf8_lossy(&strip_ansi_escapes::strip(&window)).into_owned()
            });
            let clean_match_offset = clean.to_lowercase().find(&needle).unwrap_or(0);
            result.hits.push(SearchHit {
                kind: HitKind::Terminal,
                session_id: Some(session_id.to_string()),
                project_id: Some(project_id.to_string()),
                title: title.to_string(),
                snippet: truncate_around_at(clean, clean_match_offset),
                log_offset: Some(window_start + match_offset as u64),
                rotated_away: false,
            });
        }

        let next_carry = window.len().min(overlap);
        carry.clear();
        carry.extend_from_slice(&window[window.len() - next_carry..]);
    }

    result.total_hits = Some(total_hits);
    Ok(result)
}

fn get_state(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM search_index_state WHERE key=?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?)
}

fn set_state(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO search_index_state(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Cheap corruption probe — see open().
fn probe_index(conn: &Connection) -> bool {
    conn.query_row("SELECT count(*) FROM search_index", [], |r| {
        r.get::<_, i64>(0)
    })
    .is_ok()
        && conn
            .query_row("SELECT count(*) FROM search_index_meta", [], |r| {
                r.get::<_, i64>(0)
            })
            .is_ok()
}

/// FTS5 trigram search over indexed chunks; appends terminal hits.
/// Returns Ok(rotated_any) so the caller can raise the partial flag.
fn query_terminal(
    conn: &Connection,
    q: &str,
    limit: usize,
    hits: &mut Vec<SearchHit>,
) -> Result<bool> {
    // JOIN with sessions both enriches hits (title/project/log path) and
    // silently skips orphan rows whose session no longer exists. The meta
    // join detects logs that rotated since they were indexed.
    let mut st = conn.prepare(
        "SELECT search_index.session_id, search_index.log_offset, search_index.text,
                s.title, s.project_id, s.log_path, COALESCE(m.high_water, 0)
         FROM search_index
         JOIN sessions s ON s.id = search_index.session_id
         LEFT JOIN search_index_meta m ON m.session_id = search_index.session_id
         WHERE search_index MATCH ?1
         ORDER BY bm25(search_index)
         LIMIT ?2",
    )?;
    let rows = st.query_map(params![fts_quote(q), limit as i64], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)?,
        ))
    })?;
    let mut any_rotated = false;
    for row in rows {
        let (session_id, log_offset, text, title, project_id, log_path, high_water) = row?;
        // Rotated when the file is gone, when the hit offset fell out of the
        // current generation (offset >= file length), or when the file was
        // truncated since indexing (high_water > file length — this also
        // catches small offsets that would otherwise look still-valid).
        let rotated = match std::fs::metadata(&log_path) {
            Ok(m) => {
                let len = m.len();
                (log_offset as u64) >= len || (high_water as u64) > len
            }
            Err(_) => true,
        };
        any_rotated |= rotated;
        hits.push(SearchHit {
            kind: HitKind::Terminal,
            session_id: Some(session_id),
            project_id: Some(project_id),
            title,
            snippet: make_snippet(&text, q),
            log_offset: if rotated {
                None
            } else {
                Some(log_offset as u64)
            },
            rotated_away: rotated,
        });
    }
    Ok(any_rotated)
}

/// Wrap the whole query in double quotes so FTS5 syntax chars (AND/OR/NEAR/*,
/// column filters) become literal text; embedded quotes are doubled per FTS5
/// string rules. With the trigram tokenizer this yields substring semantics.
fn fts_quote(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 2);
    out.push('"');
    for c in q.chars() {
        if c == '"' {
            out.push('"');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// Escape LIKE wildcards (% and _) plus the escape char itself.
fn like_escape(q: &str) -> String {
    let mut out = String::with_capacity(q.len());
    for c in q.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// False when more than 30% of chars are control chars / U+FFFD replacement
/// chars (binary-ish output) — see MAX_BAD_CHAR_RATIO.
fn mostly_printable(text: &str) -> bool {
    let mut total = 0usize;
    let mut bad = 0usize;
    for c in text.chars() {
        total += 1;
        if c == '\u{FFFD}' || (c.is_control() && c != '\n' && c != '\t' && c != '\r') {
            bad += 1;
        }
    }
    total > 0 && (bad as f64) <= MAX_BAD_CHAR_RATIO * (total as f64)
}

/// Snippet for an FTS hit: the line of `text` containing the first
/// case-insensitive match, windowed to 120 chars with ellipses. We cut it
/// ourselves instead of relying on FTS5 snippet(), whose trigram support
/// differs across SQLite versions.
fn make_snippet(text: &str, q: &str) -> String {
    let needle = q.to_lowercase();
    let line = text
        .lines()
        .find(|l| l.to_lowercase().contains(&needle))
        .or_else(|| text.lines().next())
        .unwrap_or("");
    truncate_around(line, &needle)
}

fn truncate_around(line: &str, needle_lower: &str) -> String {
    // Char index of the first case-insensitive match. Lowercasing can change
    // char counts for exotic foldings (e.g. 'İ'), which would only shift the
    // snippet window slightly — display cosmetics, not correctness.
    let lowered = line.to_lowercase();
    let match_offset = lowered.find(needle_lower).unwrap_or(0);
    truncate_around_at(line, match_offset)
}

/// Compact a terminal record around a byte offset from its lower-cased text.
/// Case folding can alter a few exotic Unicode byte widths; clamp to a valid
/// UTF-8 boundary because snippets are display-only, not source offsets.
fn truncate_around_at(line: &str, match_offset: usize) -> String {
    let total = line.chars().count();
    if total <= SNIPPET_MAX_CHARS {
        return line.to_string();
    }
    let clamped = match_offset.min(line.len());
    let boundary = (0..=clamped)
        .rev()
        .find(|index| line.is_char_boundary(*index))
        .unwrap_or(0);
    let match_char = line[..boundary].chars().count();
    let mut start = match_char.saturating_sub(SNIPPET_MAX_CHARS / 3);
    start = start.min(total - SNIPPET_MAX_CHARS);
    let mut out = String::with_capacity(SNIPPET_MAX_CHARS + 2);
    if start > 0 {
        out.push('…');
    }
    out.extend(line.chars().skip(start).take(SNIPPET_MAX_CHARS));
    if start + SNIPPET_MAX_CHARS < total {
        out.push('…');
    }
    out
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids;
    use crate::models::*;
    use std::io::Write;
    use std::time::Instant;

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

    /// File-backed db (needed for on-disk index size measurement).
    fn file_fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().join("data"));
        let db = Db::open(&paths).unwrap();
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
        fn add_project(&self, id: &str, name: &str) {
            self.db
                .add_project(&Project {
                    id: id.into(),
                    name: name.into(),
                    root_path: format!("/tmp/{id}"),
                    git_root_path: None,
                    created_at: Utc::now(),
                })
                .unwrap();
        }
        /// Insert a session row and return its log path (file not created).
        fn add_session(&self, id: &str, project: &str, title: &str) -> String {
            let log = self.paths.log_path(id);
            std::fs::create_dir_all(log.parent().unwrap()).unwrap();
            self.db
                .insert_session(&Session {
                    id: id.into(),
                    project_id: project.into(),
                    worktree_id: None,
                    preset_id: "pre_shell_safe".into(),
                    title: title.into(),
                    cwd: format!("/tmp/{id}"),
                    host_pid: None,
                    host_socket: None,
                    host_token: ids::new_host_token(),
                    lifecycle: Lifecycle::Running,
                    agent_session_id: None,
                    resume_precision: ResumePrecision::Unavailable,
                    log_path: log.to_string_lossy().into_owned(),
                    adapter_type: AgentType::Shell,
                    command: vec![],
                    permission_mode: PermissionMode::Native,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                    archived_at: None,
                })
                .unwrap();
            log.to_string_lossy().into_owned()
        }
        fn add_worktree(&self, id: &str, project: &str, branch: &str) {
            self.db
                .insert_worktree(&Worktree {
                    id: id.into(),
                    project_id: project.into(),
                    branch: branch.into(),
                    base_commit: "abc123".into(),
                    base_ref: None,
                    path: format!("/tmp/wt/{id}"),
                    health: WorktreeHealth::Clean,
                    created_at: Utc::now(),
                })
                .unwrap();
        }
    }

    fn terminal_hits(r: &SearchResult) -> Vec<&SearchHit> {
        r.hits
            .iter()
            .filter(|h| h.kind == HitKind::Terminal)
            .collect()
    }

    // 1. open 建表幂等；format_version 不符 → rebuild_needed
    #[test]
    fn open_creates_tables_idempotent_and_version_check() {
        let f = fixture();
        let idx = f.index();
        idx.open().unwrap();
        idx.open().unwrap(); // idempotent
        assert_eq!(idx.index_state().unwrap(), IndexState::Ok);
        {
            let conn = f.db.conn().lock().unwrap();
            for t in ["search_index", "search_index_meta", "search_index_state"] {
                let n: i64 = conn
                    .query_row(
                        "SELECT count(*) FROM sqlite_master WHERE name=?1",
                        params![t],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(n, 1, "table {t} must exist");
            }
            // trigram tokenizer really works on this SQLite build
            conn.execute_batch(
                "CREATE VIRTUAL TABLE temp.tri_probe USING fts5(x, tokenize='trigram')",
            )
            .unwrap();
        }
        // format version mismatch -> rebuild needed
        {
            let conn = f.db.conn().lock().unwrap();
            set_state(&conn, "format_version", "999").unwrap();
        }
        idx.open().unwrap();
        assert_eq!(idx.index_state().unwrap(), IndexState::RebuildNeeded);
        // unknown/garbage state value -> rebuild needed even with good version
        {
            let conn = f.db.conn().lock().unwrap();
            set_state(&conn, "format_version", &INDEX_FORMAT_VERSION.to_string()).unwrap();
            set_state(&conn, "state", "garbage").unwrap();
        }
        idx.open().unwrap();
        assert_eq!(idx.index_state().unwrap(), IndexState::RebuildNeeded);
    }

    // 2. 增量索引：high_water、chunk 数、无重复行
    #[test]
    fn index_incremental_high_water_and_chunks() {
        let f = fixture();
        f.add_project("prj_1", "demo");
        let log = f.add_session("ses_1", "prj_1", "demo session");
        let idx = f.index();
        idx.open().unwrap();

        let part1 = "hello terminal world\n".repeat(100); // 2100 bytes -> 3 chunks
        std::fs::write(&log, &part1).unwrap();
        let n = idx
            .index_session_log("ses_1", Path::new(&log), &[])
            .unwrap();
        assert_eq!(n, part1.len() as u64);
        // no-op reindex returns 0
        assert_eq!(
            idx.index_session_log("ses_1", Path::new(&log), &[])
                .unwrap(),
            0
        );

        let part2 = "second batch of bytes!\n".repeat(50); // 1150 bytes -> 2 chunks
        let mut file = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        file.write_all(part2.as_bytes()).unwrap();
        drop(file);
        let n2 = idx
            .index_session_log("ses_1", Path::new(&log), &[])
            .unwrap();
        assert_eq!(n2, part2.len() as u64);

        let conn = f.db.conn().lock().unwrap();
        let hw: i64 = conn
            .query_row(
                "SELECT high_water FROM search_index_meta WHERE session_id='ses_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hw as u64, (part1.len() + part2.len()) as u64);
        let rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM search_index WHERE session_id='ses_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let chunk = INDEX_CHUNK_BYTES as u64;
        let expect = (part1.len() as u64).div_ceil(chunk) + (part2.len() as u64).div_ceil(chunk);
        assert_eq!(rows as u64, expect);
        // chunk_seq unique per session (no duplicate rows on re-index)
        let distinct: i64 = conn
            .query_row(
                "SELECT count(DISTINCT chunk_seq) FROM search_index WHERE session_id='ses_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, distinct);
        // offsets strictly increasing and chunk-aligned to the byte stream
        let min_off: i64 = conn
            .query_row(
                "SELECT min(log_offset) FROM search_index WHERE session_id='ses_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(min_off, 0);
    }

    // 2b. 二进制占比高的块不索引，但 high_water 照样前进
    #[test]
    fn binary_chunks_are_skipped_but_consumed() {
        let f = fixture();
        f.add_project("prj_1", "demo");
        let log = f.add_session("ses_1", "prj_1", "demo session");
        let idx = f.index();
        idx.open().unwrap();

        // exactly 2048 bytes = 2 whole chunks, so the binary tail never
        // shares a chunk with clean text
        let text = "clean line 1234\n".repeat(128);
        let mut content = text.clone().into_bytes();
        let mut binary = Vec::new();
        while binary.len() < 2048 {
            binary.extend_from_slice(&[0x00, 0x01, 0x02, 0x80, 0xFF, 0x90]);
        }
        content.extend_from_slice(&binary);
        std::fs::write(&log, &content).unwrap();

        let n = idx
            .index_session_log("ses_1", Path::new(&log), &[])
            .unwrap();
        assert_eq!(
            n,
            content.len() as u64,
            "binary bytes still count as consumed"
        );
        let conn = f.db.conn().lock().unwrap();
        let rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM search_index WHERE session_id='ses_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            rows as u64,
            (text.len() as u64).div_ceil(INDEX_CHUNK_BYTES as u64)
        );
        let hw: i64 = conn
            .query_row(
                "SELECT high_water FROM search_index_meta WHERE session_id='ses_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hw as u64, content.len() as u64);
    }

    // 3. secret 不进索引
    #[test]
    fn secrets_are_redacted_before_indexing() {
        let f = fixture();
        f.add_project("prj_1", "demo");
        let log = f.add_session("ses_1", "prj_1", "demo session");
        let idx = f.index();
        idx.open().unwrap();

        std::fs::write(&log, "prefix token supersecret123 suffix line\n").unwrap();
        let secrets = vec![b"supersecret123".to_vec()];
        idx.index_session_log("ses_1", Path::new(&log), &secrets)
            .unwrap();

        // raw index rows must not contain the secret
        let conn = f.db.conn().lock().unwrap();
        let text: String = conn
            .query_row(
                "SELECT text FROM search_index WHERE session_id='ses_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!text.contains("supersecret123"));
        assert!(text.contains("[redacted]"));
        drop(conn);

        let r = idx.query("supersecret", 10).unwrap();
        assert_eq!(terminal_hits(&r).len(), 0);
        let r = idx.query("redacted", 10).unwrap();
        assert_eq!(terminal_hits(&r).len(), 1);
        assert!(terminal_hits(&r)[0].snippet.contains("[redacted]"));
        // neighbouring text is still searchable
        let r = idx.query("prefix token", 10).unwrap();
        assert_eq!(terminal_hits(&r).len(), 1);
    }

    // 4. query：中英文关键词命中 metadata 与 terminal
    #[test]
    fn query_hits_metadata_and_terminal() {
        let f = fixture();
        f.add_project("prj_1", "pay 支付网关");
        let log = f.add_session("ses_1", "prj_1", "pay 修复登录超时");
        f.add_worktree("wt_1", "prj_1", "agent/login-fix");
        std::fs::write(&log, "pay panic: 订单服务 不可用\nretrying ok\n").unwrap();
        let idx = f.index();
        idx.open().unwrap();
        idx.index_session_log("ses_1", Path::new(&log), &[])
            .unwrap();

        // project name (2 chars: metadata only, no terminal part)
        let r = idx.query("支付", 10).unwrap();
        assert!(r
            .hits
            .iter()
            .any(|h| h.kind == HitKind::Project && h.title.contains("支付")));
        assert_eq!(terminal_hits(&r).len(), 0, "2-char query must not hit FTS");
        assert!(!r.partial);

        // session title
        let r = idx.query("登录", 10).unwrap();
        assert!(r
            .hits
            .iter()
            .any(|h| h.kind == HitKind::Session && h.title.contains("登录")));

        // worktree branch
        let r = idx.query("login-fix", 10).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].kind, HitKind::Branch);
        assert_eq!(r.hits[0].title, "agent/login-fix");

        // terminal text (CJK, 4 chars -> FTS)
        let r = idx.query("订单服务", 10).unwrap();
        let t = terminal_hits(&r);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].title, "pay 修复登录超时");
        assert!(t[0].snippet.contains("订单服务"));
        assert_eq!(t[0].log_offset, Some(0));
        assert!(!t[0].rotated_away);
        assert!(!r.partial);

        // mixed query: metadata kinds first, terminal last; per-kind limit
        let r = idx.query("pay", 10).unwrap();
        assert!(r.hits.iter().any(|h| h.kind == HitKind::Project));
        assert!(r.hits.iter().any(|h| h.kind == HitKind::Session));
        assert!(r.hits.iter().any(|h| h.kind == HitKind::Terminal));
        let first_terminal = r
            .hits
            .iter()
            .position(|h| h.kind == HitKind::Terminal)
            .unwrap();
        assert!(r.hits[..first_terminal]
            .iter()
            .all(|h| h.kind != HitKind::Terminal));
        let r = idx.query("pay", 1).unwrap();
        for kind in [HitKind::Project, HitKind::Session, HitKind::Terminal] {
            assert!(r.hits.iter().filter(|h| h.kind == kind).count() <= 1);
        }
    }

    // 5. 轮转：旧 offset 命中 rotated_away=true 且 partial=true；再索引恢复
    #[test]
    fn rotation_marks_old_hits_rotated_away() {
        let f = fixture();
        f.add_project("prj_1", "demo");
        let log = f.add_session("ses_1", "prj_1", "demo session");
        let idx = f.index();
        idx.open().unwrap();

        let content = format!(
            "needle_phrase first line\n{}",
            "filler line xyz\n".repeat(200)
        );
        std::fs::write(&log, &content).unwrap();
        idx.index_session_log("ses_1", Path::new(&log), &[])
            .unwrap();
        let r = idx.query("needle_phrase", 10).unwrap();
        assert_eq!(terminal_hits(&r)[0].log_offset, Some(0));
        assert!(!r.partial);

        // simulate rotation: truncate + rewrite a shorter file, no reindex yet
        std::fs::write(&log, "brand new generation\n").unwrap();
        let r = idx.query("needle_phrase", 10).unwrap();
        let t = terminal_hits(&r);
        assert_eq!(t.len(), 1);
        assert!(t[0].rotated_away);
        assert_eq!(t[0].log_offset, None);
        assert!(r.partial, "rotated hits must raise the partial flag");

        // reindex detects the shorter file and restarts from offset 0
        let n = idx
            .index_session_log("ses_1", Path::new(&log), &[])
            .unwrap();
        assert_eq!(n, "brand new generation\n".len() as u64);
        let r = idx.query("brand new", 10).unwrap();
        let t = terminal_hits(&r);
        assert_eq!(t.len(), 1);
        assert!(!t[0].rotated_away);
        assert_eq!(t[0].log_offset, Some(0));
        assert!(!r.partial);
        // stale generation is gone from the index
        let r = idx.query("needle_phrase", 10).unwrap();
        assert_eq!(terminal_hits(&r).len(), 0);
    }

    // 6. 损坏恢复：DROP 表/乱写 state → rebuild_needed → 回退 → rebuild 恢复；源日志 sha256 不变
    #[test]
    fn corruption_marks_rebuild_and_rebuild_recovers() {
        let f = fixture();
        f.add_project("prj_1", "demo");
        let log = f.add_session("ses_1", "prj_1", "recoverable task");
        let idx = f.index();
        idx.open().unwrap();
        std::fs::write(&log, "recoverable keyword line\nand more filler\n").unwrap();
        let sha_before = crate::logs::sha256_file(Path::new(&log)).unwrap();
        idx.index_session_log("ses_1", Path::new(&log), &[])
            .unwrap();
        assert!(idx
            .query("recoverable", 10)
            .unwrap()
            .hits
            .iter()
            .any(|h| h.kind == HitKind::Terminal));

        // break the index: drop the FTS table
        {
            let conn = f.db.conn().lock().unwrap();
            conn.execute_batch("DROP TABLE search_index").unwrap();
        }
        idx.open().unwrap();
        assert_eq!(idx.index_state().unwrap(), IndexState::RebuildNeeded);
        // global query degrades: metadata still served, terminal paused, partial set
        let r = idx.query("recoverable", 10).unwrap();
        assert!(r.partial);
        assert_eq!(terminal_hits(&r).len(), 0);
        assert!(r.hits.iter().any(|h| h.kind == HitKind::Session));
        // fallback channel still finds the text
        let r2 = idx.query_session_text("ses_1", "recoverable", 10).unwrap();
        assert_eq!(r2.hits.len(), 1);
        assert_eq!(r2.hits[0].log_offset, Some(0));
        assert!(r2.hits[0].snippet.contains("recoverable keyword"));

        // rebuild restores the index without touching the source log
        idx.rebuild_all(&mut |_, _| true).unwrap();
        assert_eq!(idx.index_state().unwrap(), IndexState::Ok);
        let r3 = idx.query("recoverable", 10).unwrap();
        assert!(!r3.partial);
        assert_eq!(terminal_hits(&r3).len(), 1);
        let sha_after = crate::logs::sha256_file(Path::new(&log)).unwrap();
        assert_eq!(sha_before, sha_after, "source log must never be modified");

        // garbage state value also triggers rebuild_needed on open
        {
            let conn = f.db.conn().lock().unwrap();
            set_state(&conn, "state", "bogus").unwrap();
        }
        idx.open().unwrap();
        assert_eq!(idx.index_state().unwrap(), IndexState::RebuildNeeded);
    }

    #[test]
    fn focused_session_search_reads_before_attach_replay_tail() {
        let f = fixture();
        f.add_project("prj_1", "demo");
        let log = f.add_session("ses_1", "prj_1", "long history");
        let marker = "early-history-needle";
        // Deliberately place the match before 256 KiB, the normal terminal
        // attach replay window. The focused-session fallback must scan the
        // persisted log instead of reproducing xterm's visible tail limit.
        let content = format!("{marker}\n{}", "filler terminal output\n".repeat(20_000));
        assert!(content.len() > 262_144);
        std::fs::write(&log, content).unwrap();

        let r = f.index().query_session_text("ses_1", marker, 10).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].log_offset, Some(0));
        assert!(r.hits[0].snippet.contains(marker));
    }

    #[test]
    fn focused_session_search_counts_each_match_in_one_tui_record() {
        let f = fixture();
        f.add_project("prj_1", "demo");
        let log = f.add_session("ses_1", "prj_1", "terminal redraw");
        // A fullscreen TUI can redraw a large amount of output without a
        // newline. Treating one raw record as one hit hides all but the first
        // occurrence, exactly as a Claude transcript does.
        std::fs::write(&log, "千古绝唱\r千古江山\r千古风流").unwrap();

        let r = f.index().query_session_text("ses_1", "千古", 10).unwrap();
        assert_eq!(r.total_hits, Some(3));
        assert_eq!(r.hits.len(), 3);
    }

    #[test]
    fn focused_session_stream_search_keeps_cross_chunk_matches_once() {
        let mut log = b"needle at the beginning\n".to_vec();
        log.resize(FOCUSED_SEARCH_CHUNK_BYTES - 3, b'x');
        // The first occurrence begins before the reader's 64 KiB boundary.
        // The final occurrence is wholly in the next chunk. Both must be
        // found exactly once without loading the full transcript.
        log.extend_from_slice(b"needle across boundary\nneedle after boundary\n");

        let r = query_session_log_stream(
            std::io::Cursor::new(log),
            "ses_1",
            "prj_1",
            "streamed terminal",
            "needle",
            10,
        )
        .unwrap();

        assert_eq!(r.total_hits, Some(3));
        assert_eq!(r.hits.len(), 3);
    }

    // 7. rebuild_all 可取消
    #[test]
    fn rebuild_cancel_keeps_non_ok_state() {
        let f = fixture();
        f.add_project("prj_1", "demo");
        for i in 0..3 {
            let id = format!("ses_{i}");
            let log = f.add_session(&id, "prj_1", "demo session");
            std::fs::write(&log, format!("session {i} content\n")).unwrap();
        }
        let idx = f.index();
        idx.open().unwrap();

        let mut calls: Vec<(u32, u32)> = Vec::new();
        idx.rebuild_all(&mut |done, total| {
            calls.push((done, total));
            false // cancel immediately
        })
        .unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0],
            (1, 3),
            "first progress call happens after session 1"
        );
        assert_eq!(idx.index_state().unwrap(), IndexState::RebuildNeeded);

        // a full rebuild afterwards succeeds
        idx.rebuild_all(&mut |_, _| true).unwrap();
        assert_eq!(idx.index_state().unwrap(), IndexState::Ok);
    }

    // 8. 性能粗测（debug 放宽线）
    #[test]
    fn perf_smoke_index_size_and_query_latency() {
        let f = file_fixture();
        f.add_project("prj_p", "perf");
        let log = f.add_session("ses_p", "prj_p", "perf session");

        // ~20 MiB pseudo terminal text with ANSI escapes + CJK
        let mut buf: Vec<u8> = Vec::with_capacity(21 * 1024 * 1024);
        let mut i = 0u64;
        while buf.len() < 20 * 1024 * 1024 {
            let line = if i % 997 == 0 {
                format!("\x1b[1;31mERROR\x1b[0m PERF_NEEDLE_Q7Z 固定关键词 第{i}行\n")
            } else {
                match i % 4 {
                    0 => format!(
                        "\x1b[32m$\x1b[0m cargo test -p agentport-core -- case_{} 运行第{}个用例\n",
                        i % 89,
                        i
                    ),
                    1 => format!(
                        "   \x1b[90mCompiling\x1b[0m crate_{} v1.{}.{} (/Users/w/Projects/mod_{})\n",
                        i % 53,
                        i % 7,
                        i % 13,
                        i % 31
                    ),
                    2 => format!(
                        "test search::tests::case_{} ... ok, 中文输出混排 passed in 0.{}s\n",
                        i % 211,
                        i % 99
                    ),
                    _ => format!(
                        "\x1b[33mwarn:\x1b[0m 日志行 {} 包含一些普通文本 the quick brown fox {}\n",
                        i,
                        i % 1024
                    ),
                }
            };
            buf.extend_from_slice(line.as_bytes());
            i += 1;
        }
        std::fs::write(&log, &buf).unwrap();
        let raw_len = buf.len() as u64;

        let idx = f.index();
        idx.open().unwrap();
        let t0 = Instant::now();
        let n = idx
            .index_session_log("ses_p", Path::new(&log), &[])
            .unwrap();
        let index_secs = t0.elapsed().as_secs_f64();
        assert_eq!(n, raw_len);

        let conn = f.db.conn().lock().unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        let pages: i64 = conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap();
        let page_size: i64 = conn
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .unwrap();
        drop(conn);
        let db_bytes = (pages * page_size) as f64;
        let ratio = db_bytes / raw_len as f64;
        let mib = (1024 * 1024) as f64;
        println!(
            "perf_smoke: indexed {:.1} MiB in {:.1}s ({:.1} MiB/s); db {:.1} MiB, index/raw ratio {:.2}",
            raw_len as f64 / mib,
            index_secs,
            raw_len as f64 / mib / index_secs,
            db_bytes / mib,
            ratio
        );
        // Measured on this machine (debug): 20.0 MiB indexed in 2.4s
        // (8.4 MiB/s), db 71.7 MiB => index/raw ratio 3.58, avg query 1.6 ms.
        // Trigram FTS5 with stored text and 1 KiB chunks is inherently
        // multiple-x the source text (postings ~ every 3-char window + stored
        // chunk text), so PRD ch.10's <=35% disk target is NOT reachable with
        // this mandated layout — the release perf harness should recheck and,
        // if the 35% target stands, the fix is a contentless/external-content
        // index or Tantivy (PRD 8 allows the swap). This assert is only a
        // coarse sanity bound against blowups.
        assert!(ratio < 4.5, "index size exploded: ratio {ratio:.2}");

        // fixed-keyword query latency, 100 iterations
        let r = idx.query("PERF_NEEDLE_Q7Z", 20).unwrap(); // warmup
        assert!(!terminal_hits(&r).is_empty());
        let t0 = Instant::now();
        for _ in 0..100 {
            idx.query("PERF_NEEDLE_Q7Z", 20).unwrap();
        }
        let avg_ms = t0.elapsed().as_secs_f64() * 1000.0 / 100.0;
        println!("perf_smoke: avg query latency {avg_ms:.2} ms over 100 runs");
        assert!(
            avg_ms < 50.0,
            "debug query latency too high: {avg_ms:.2} ms"
        );
    }

    // 9. MIN_QUERY_CHARS 校验；trigram 转义（引号/%/* 不炸）
    #[test]
    fn query_validation_and_fts_escaping() {
        let f = fixture();
        f.add_project("prj_1", "demo");
        let log = f.add_session("ses_1", "prj_1", "demo session");
        std::fs::write(&log, "some content with 100% coverage \"quoted\" and a*b\n").unwrap();
        let idx = f.index();
        idx.open().unwrap();
        idx.index_session_log("ses_1", Path::new(&log), &[])
            .unwrap();

        assert!(matches!(idx.query("", 10), Err(CoreError::Validation(_))));
        assert!(matches!(idx.query("a", 10), Err(CoreError::Validation(_))));
        // '中' is 1 char (3 bytes): the limit is in chars
        assert!(matches!(idx.query("中", 10), Err(CoreError::Validation(_))));
        assert!(matches!(
            idx.query_session_text("ses_1", "x", 10),
            Err(CoreError::Validation(_))
        ));

        // FTS5 syntax chars must be treated as literal text, never crash
        for q in [
            "\"quoted\"",
            "100%",
            "a*b",
            "NEAR/1",
            "text:abc",
            "a\"b",
            "'''",
        ] {
            let r = idx.query(q, 10);
            assert!(r.is_ok(), "query {q:?} failed: {:?}", r.err());
        }
        // quoted/percent queries actually match literally
        let r = idx.query("\"quoted\"", 10).unwrap();
        assert_eq!(terminal_hits(&r).len(), 1);
        let r = idx.query("coverage", 10).unwrap();
        assert_eq!(terminal_hits(&r).len(), 1);
    }
}
