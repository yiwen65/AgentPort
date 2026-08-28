//! Export system (PRD ch.8): raw .log, Markdown, redacted diagnostics .zip.
//!
//! Invariants:
//! - Atomicity: build in a temp dir under exports/, then rename/zip; ANY failure
//!   deletes the temp artifacts and leaves sources untouched (8.3).
//! - Redaction: exports pass through the redactor with all known secret
//!   fingerprints; if redaction itself fails, abort the export (3.6 failure C).
//! - manifest.json declares export version, time, session ids, redaction rules;
//!   never contains tokens, API keys or env values (8.2).

use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::paths::AppPaths;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const EXPORT_FORMAT_VERSION: u32 = 1;
pub const DIAG_ZIP_VERSION: u32 = 1;

/// Per-session terminal log cap inside diagnostics zips: the newest evidence
/// lives at the tail, so only the last 2 MiB per session is packed. Keeps the
/// zip bounded even when a session log sits at its configured rotation limit.

/// Redaction rule string declared in manifest.json (mirrors redact.rs).
const REDACTION_RULE: &str = "exact-byte-match:fixed-mask";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogRange {
    All,
    LastLines(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnsiMode {
    Keep,
    Strip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MdBlocks {
    All,
    Last(u32),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub format_version: u32,
    pub generated_at: DateTime<Utc>,
    pub app_version: String,
    pub sessions: Vec<String>,
    pub redaction: RedactionDeclaration,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionDeclaration {
    pub applied: bool,
    pub rule: String, // e.g. "exact-byte-match:fixed-mask"
    pub hit_count: u64,
}

pub struct Exporter<'a> {
    pub paths: &'a AppPaths,
    pub db: &'a Db,
}

impl<'a> Exporter<'a> {
    /// Raw terminal log (.log). `dest` is the final file; write temp+rename.
    pub fn export_log(
        &self,
        session_id: &str,
        dest: &Path,
        range: LogRange,
        ansi: AnsiMode,
        secrets: &[Vec<u8>],
    ) -> Result<PathBuf> {
        refuse_overwrite(dest)?;
        let session = self.db.get_session(session_id)?;
        // Logs are capped at their configured rotation limit, so a full
        // in-memory read is bounded; binary-safe byte handling throughout.
        let raw = std::fs::read(&session.log_path)?;
        let sliced: &[u8] = match range {
            LogRange::All => &raw,
            LogRange::LastLines(n) => tail_lines(&raw, n as usize),
        };
        // Strip BEFORE redacting: a secret printed with escape sequences between
        // its bytes becomes contiguous only after stripping. (AnsiMode::Keep is
        // raw preservation by definition — such split secrets stay as printed.)
        let cleaned = match ansi {
            AnsiMode::Keep => sliced.to_vec(),
            AnsiMode::Strip => strip_ansi_escapes::strip(sliced),
        };
        // redact_bytes is total (infallible); a future fallible redactor must
        // abort the export here instead of emitting unredacted bytes (3.6 C).
        let (out, hits) = crate::redact::redact_bytes(&cleaned, secrets);
        self.db.record_redaction_hits(session_id, hits)?;
        atomic_write_new(self.paths, dest, &out)?;
        Ok(dest.to_path_buf())
    }

    /// Markdown with header: session, agent, project, branch, time range (8.1).
    pub fn export_markdown(
        &self,
        session_id: &str,
        dest: &Path,
        blocks: MdBlocks,
        secrets: &[Vec<u8>],
    ) -> Result<PathBuf> {
        refuse_overwrite(dest)?;
        let session = self.db.get_session(session_id)?;
        let project = self.db.get_project(&session.project_id)?;
        let worktree = match &session.worktree_id {
            Some(id) => self.db.get_worktree(id).ok(),
            None => None,
        };
        let raw = std::fs::read(&session.log_path)?;
        // Markdown is the human/paste format: always strip ANSI, decode lossy.
        let text = String::from_utf8_lossy(&strip_ansi_escapes::strip(&raw)).into_owned();
        let all = visible_blocks(&text);
        let selected: &[String] = match blocks {
            MdBlocks::All => &all,
            MdBlocks::Last(n) => &all[all.len().saturating_sub(n as usize)..],
        };
        let body = selected.join("\n\n");
        let fence = fence_for(&body);

        let mut md = String::with_capacity(body.len() + 512);
        md.push_str("---\n");
        md.push_str(&format!("session: {}\n", header_value(&session.id)));
        md.push_str(&format!("title: {}\n", header_value(&session.title)));
        md.push_str(&format!(
            "agent: {}\n",
            header_value(session.adapter_type.display_name())
        ));
        md.push_str(&format!("project: {}\n", header_value(&project.name)));
        md.push_str(&format!("cwd: {}\n", header_value(&session.cwd)));
        if let Some(w) = &worktree {
            md.push_str(&format!("branch: {}\n", header_value(&w.branch)));
        }
        md.push_str(&format!("created: {}\n", session.created_at.to_rfc3339()));
        md.push_str(&format!("updated: {}\n", session.updated_at.to_rfc3339()));
        md.push_str(&format!("lifecycle: {}\n", session.lifecycle.as_str()));
        md.push_str(&format!("exported: {}\n", Utc::now().to_rfc3339()));
        md.push_str("---\n\n");
        md.push_str(&fence);
        md.push('\n');
        md.push_str(&body);
        md.push('\n');
        md.push_str(&fence);
        md.push('\n');

        // Redact the assembled document — the header (title/cwd) is user data
        // too, so masking only the body would leave a leak path.
        let (out, hits) = crate::redact::redact_bytes(md.as_bytes(), secrets);
        self.db.record_redaction_hits(session_id, hits)?;
        atomic_write_new(self.paths, dest, &out)?;
        Ok(dest.to_path_buf())
    }

    /// Redacted diagnostics ZIP (P1, 8.2 structure):
    /// manifest.json, sessions/*.md|.log|status-events.json,
    /// worktrees/*-git-status.txt, diagnostics/{app-version,platform,adapter-capabilities}.
    /// Default: NO env values, NO model credentials. Atomic; temp cleanup on failure.
    pub fn export_diagnostics_zip(
        &self,
        session_ids: &[String],
        dest: &Path,
        secrets: &[Vec<u8>],
    ) -> Result<PathBuf> {
        refuse_overwrite(dest)?;
        // 8.3: freeze the export set up front — resolve every session before
        // writing anything so the selection cannot change mid-export.
        let mut sessions = Vec::with_capacity(session_ids.len());
        for id in session_ids {
            sessions.push(self.db.get_session(id)?);
        }

        let exports = self.paths.exports_dir();
        std::fs::create_dir_all(&exports)?;
        let staging = exports.join(format!(".diag-{}", crate::ids::new_id("zip")));
        std::fs::create_dir_all(&staging)?;
        // Stays armed on success AND failure: the staging dir is never the
        // final artifact, so drop always cleans it up (8.3).
        let _dir_guard = TempDirGuard::new(staging.clone());

        let mut files: Vec<String> = Vec::new();
        let mut total_hits = 0u64;

        for s in &sessions {
            // full status-event history as JSON (8.2).
            let events = self.db.status_history(&s.id, u32::MAX)?;
            let json = serde_json::to_vec_pretty(&events)?;
            let h = stage_file(
                &staging,
                &mut files,
                format!("sessions/{}-status-events.json", s.id),
                &json,
                secrets,
            )?;
            total_hits += h;
            self.db.record_redaction_hits(&s.id, h)?;

            // worktree git status — optional: no worktree / missing repo /
            // git failure skips the file, never fails the export (8.2).
            if let Some(wid) = &s.worktree_id {
                if let Ok(w) = self.db.get_worktree(wid) {
                    let wpath = Path::new(&w.path);
                    if let Ok(repo) = crate::git::GitRepo::discover(wpath) {
                        if let Ok(summary) = repo.status(wpath) {
                            let project = self.db.get_project(&s.project_id)?;
                            total_hits += stage_file(
                                &staging,
                                &mut files,
                                format!(
                                    "worktrees/{}-{}-git-status.txt",
                                    crate::paths::slugify(&project.name),
                                    crate::paths::slugify(&w.branch)
                                ),
                                summary.raw.as_bytes(),
                                secrets,
                            )?;
                        }
                    }
                }
            }
        }

        let diag = crate::diag::Diagnostics {
            paths: self.paths,
            db: self.db,
        };
        total_hits += stage_file(
            &staging,
            &mut files,
            "diagnostics/app-version.txt".into(),
            format!("agentport {}\n", env!("CARGO_PKG_VERSION")).as_bytes(),
            secrets,
        )?;
        let p = diag.platform_info();
        total_hits += stage_file(
            &staging,
            &mut files,
            "diagnostics/platform.txt".into(),
            format!(
                "os: {}\nos_version: {}\narch: {}\nwebview: {}\napp_version: {}\n",
                p.os,
                p.os_version,
                p.arch,
                p.webview.as_deref().unwrap_or("unknown"),
                p.app_version
            )
            .as_bytes(),
            secrets,
        )?;
        total_hits += stage_file(
            &staging,
            &mut files,
            "diagnostics/adapter-capabilities.json".into(),
            diag.adapter_capabilities_json()?.as_bytes(),
            secrets,
        )?;

        // manifest.json last — it lists every file staged above. By
        // construction it holds ids/versions/counts only; the redact+verify
        // pass below is the belt-and-suspenders proof that no token, API key
        // or env value leaks into it (8.2).
        files.sort();
        let manifest = ExportManifest {
            format_version: DIAG_ZIP_VERSION,
            generated_at: Utc::now(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            sessions: session_ids.to_vec(),
            redaction: RedactionDeclaration {
                applied: true,
                rule: REDACTION_RULE.into(),
                hit_count: total_hits,
            },
            files: files.clone(),
        };
        let mjson = serde_json::to_vec_pretty(&manifest)?;
        let (mout, _mhits) = crate::redact::redact_bytes(&mjson, secrets);
        verify_no_secrets(&mout, secrets)?;
        write_staged(&staging, "manifest.json", &mout)?;

        // Final assertion before packing (3.6 failure path C): re-scan EVERY
        // staged file for any secret byte sequence.
        for rel in files.iter().map(String::as_str).chain(["manifest.json"]) {
            let bytes = std::fs::read(staging.join(rel))?;
            verify_no_secrets(&bytes, secrets)?;
        }

        // Compress the staged tree into a temp zip under exports/, then rename.
        // The archive carries manifest.json too (the manifest's own `files`
        // list intentionally describes the payload only).
        let tmp_zip = exports.join(format!(".diag-{}.zip", crate::ids::new_id("zip")));
        let _zip_guard = TempFileGuard::new(tmp_zip.clone());
        let mut all = files.clone();
        all.push("manifest.json".into());
        zip_staged(&staging, &all, &tmp_zip)?;
        publish(&tmp_zip, dest)?;
        Ok(dest.to_path_buf())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Overwriting an existing export is an error, not a backup-and-replace: an
/// export is evidence, and silently renaming the user's earlier file away is
/// how the only copy of a bug report gets lost. The GUI picks fresh
/// timestamped names, so a collision means "choose another name".
fn refuse_overwrite(dest: &Path) -> Result<()> {
    if dest.exists() {
        return Err(CoreError::Conflict(format!(
            "export destination already exists: {}",
            dest.display()
        )));
    }
    Ok(())
}

/// Write `data` to `dest` atomically: temp file under exports/ (written +
/// fsynced), then rename onto `dest`. The guard deletes the temp file on any
/// failure; after a successful rename the path is gone and drop is a no-op.
fn atomic_write_new(paths: &AppPaths, dest: &Path, data: &[u8]) -> Result<()> {
    let exports = paths.exports_dir();
    std::fs::create_dir_all(&exports)?;
    let tmp = exports.join(format!(".export-{}", crate::ids::new_id("tmp")));
    let _guard = TempFileGuard::new(tmp.clone());
    let mut f = private_create(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    drop(f);
    publish(&tmp, dest)
}

/// Create a fresh file with owner-only permissions. Exports contain terminal
/// output and must never inherit the process umask's group/world readability,
/// including at the final destination after rename.
fn private_create(path: &Path) -> Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    Ok(opts.open(path)?)
}

/// Rename `staging` onto `dest` (never overwrites — see refuse_overwrite).
/// When exports/ and `dest` live on different filesystems, rename(2) fails
/// with EXDEV; fall back to a copy through a sibling temp file so the
/// destination still materializes atomically.
fn publish(staging: &Path, dest: &Path) -> Result<()> {
    refuse_overwrite(dest)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(staging, dest) {
        Ok(()) => {
            crate::paths::AppPaths::restrict_file(dest)?;
            Ok(())
        }
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            let name = dest.file_name().ok_or_else(|| {
                CoreError::Validation("export destination has no file name".into())
            })?;
            let sibling = dest.with_file_name(format!(
                ".{}.partial-{}",
                name.to_string_lossy(),
                crate::ids::new_id("tmp")
            ));
            let _guard = TempFileGuard::new(sibling.clone());
            std::fs::copy(staging, &sibling)?;
            crate::paths::AppPaths::restrict_file(&sibling)?;
            std::fs::rename(&sibling, dest)?;
            let _ = std::fs::remove_file(staging);
            Ok(())
        }
        Err(e) => Err(CoreError::Io(e)),
    }
}

/// Same atomic publish contract as `publish`, exposed for the backup module
/// (identical staging-temp + rename semantics; refuse overwrite).
pub fn publish_backup(staging: &Path, dest: &Path) -> Result<()> {
    publish(staging, dest)
}

/// Byte-oriented "last n lines": scan for `\n` from the tail, no UTF-8
/// assumption. One trailing newline is ignored so `tail_lines("a\nb\n", 1)`
/// yields "b\n" (tail(1) semantics); fewer lines than `n` yields everything.
fn tail_lines(data: &[u8], n: usize) -> &[u8] {
    if n == 0 {
        return &[];
    }
    let end = if data.last() == Some(&b'\n') {
        data.len() - 1
    } else {
        data.len()
    };
    let mut seen = 0usize;
    for i in (0..end).rev() {
        if data[i] == b'\n' {
            seen += 1;
            if seen == n {
                return &data[i + 1..];
            }
        }
    }
    data
}

/// Split stripped terminal text into "visible output blocks": paragraphs
/// separated by blank (empty or whitespace-only) lines; empty blocks dropped.
fn visible_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            if !cur.is_empty() {
                blocks.push(cur.join("\n"));
                cur.clear();
            }
        } else {
            cur.push(line.trim_end());
        }
    }
    if !cur.is_empty() {
        blocks.push(cur.join("\n"));
    }
    blocks
}

/// Backtick fence one longer than any backtick run inside `content` (min 3),
/// so terminal output containing ``` cannot break out of the fence.
fn fence_for(content: &str) -> String {
    let mut max_run = 0usize;
    let mut run = 0usize;
    for c in content.chars() {
        if c == '`' {
            run += 1;
            max_run = max_run.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat((max_run + 1).max(3))
}

/// One-line header value: CR/LF would break the YAML-style header block.
fn header_value(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

/// Post-redaction assertion: scan for any secret byte sequence still present
/// in an export payload. The error message deliberately carries NO secret
/// material — only the fact that the scan tripped.
fn verify_no_secrets(data: &[u8], secrets: &[Vec<u8>]) -> Result<()> {
    for s in secrets
        .iter()
        .filter(|s| s.len() >= crate::redact::MIN_SECRET_LEN)
    {
        if data.len() >= s.len() && data.windows(s.len()).any(|w| w == s.as_slice()) {
            return Err(CoreError::Redaction(
                "post-redaction scan found secret bytes in export payload".into(),
            ));
        }
    }
    Ok(())
}

/// Stage one payload file: redact, assert the redactor removed every secret
/// (3.6 failure path C — on a trip the export aborts and the temp-dir guard
/// deletes everything), write into the staging dir, record the relative path.
/// Returns the redaction hit count for this file.
fn stage_file(
    staging: &Path,
    files: &mut Vec<String>,
    rel: String,
    data: &[u8],
    secrets: &[Vec<u8>],
) -> Result<u64> {
    let (out, hits) = crate::redact::redact_bytes(data, secrets);
    verify_no_secrets(&out, secrets)?;
    write_staged(staging, &rel, &out)?;
    files.push(rel);
    Ok(hits)
}

fn write_staged(root: &Path, rel: &str, data: &[u8]) -> Result<()> {
    let p = root.join(rel);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&p, data)?;
    Ok(())
}

/// Pack the staged files (relative paths, forward slashes) into a fresh zip.
fn zip_staged(staging: &Path, files: &[String], zip_path: &Path) -> Result<()> {
    let f = private_create(zip_path)?;
    let mut zw = zip::ZipWriter::new(f);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    for rel in files {
        let data = std::fs::read(staging.join(rel))?;
        zw.start_file(rel.clone(), opts)
            .map_err(|e| CoreError::Export(format!("zip start {rel}: {e}")))?;
        zw.write_all(&data)?;
    }
    let f = zw
        .finish()
        .map_err(|e| CoreError::Export(format!("zip finish: {e}")))?;
    f.sync_all()?;
    Ok(())
}

/// Guard that removes a temp dir on drop unless disarmed — the atomicity primitive.
pub struct TempDirGuard {
    pub path: PathBuf,
    armed: bool,
}

impl TempDirGuard {
    pub fn new(path: PathBuf) -> Self {
        TempDirGuard { path, armed: true }
    }
    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

/// Single-file sibling of TempDirGuard. Never disarmed: a successful rename
/// removes the temp path first, so drop-after-success is a harmless no-op.
struct TempFileGuard {
    path: PathBuf,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        TempFileGuard { path }
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::*;
    use chrono::Utc;
    use std::collections::BTreeSet;
    use std::io::Read;
    use std::process::Command;

    const SECRET: &[u8] = b"hunter2-token-abcdef";

    struct Fx {
        dir: tempfile::TempDir,
        paths: AppPaths,
        db: Db,
    }

    fn fx() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().join("data"));
        let db = Db::open_memory().unwrap();
        Fx { dir, paths, db }
    }

    fn add_project(db: &Db, id: &str, name: &str) {
        db.add_project(&Project {
            id: id.into(),
            name: name.into(),
            root_path: format!("/tmp/{id}"),
            git_root_path: None,
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
    }

    fn add_session(db: &Db, id: &str, project: &str, log: &Path) -> Session {
        add_session_wt(db, id, project, log, None)
    }

    fn add_session_wt(db: &Db, id: &str, project: &str, log: &Path, wt: Option<&str>) -> Session {
        let s = Session {
            id: id.into(),
            project_id: project.into(),
            worktree_id: wt.map(str::to_string),
            preset_id: "pre_test".into(),
            title: format!("title of {id}"),
            cwd: "/tmp/cwd".into(),
            host_pid: None,
            host_socket: None,
            host_token: crate::ids::new_host_token(),
            lifecycle: Lifecycle::Running,
            agent_session_id: None,
            resume_precision: ResumePrecision::Unavailable,
            log_path: log.to_string_lossy().into_owned(),
            adapter_type: AgentType::Kimi,
            transport: AgentTransport::Pty,
            command: vec![],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            pinned_at: None,
            archived_at: None,
        };
        db.insert_session(&s).unwrap();
        db.get_session(id).unwrap()
    }

    fn add_worktree(db: &Db, id: &str, project: &str, branch: &str, path: &Path) {
        db.insert_worktree(&Worktree {
            id: id.into(),
            project_id: project.into(),
            branch: branch.into(),
            base_commit: "abc123".into(),
            base_ref: None,
            path: path.to_string_lossy().into_owned(),
            health: WorktreeHealth::Clean,
            created_at: Utc::now(),
        })
        .unwrap();
    }

    fn add_event(db: &Db, session: &str, seq: i64, state: AgentState) {
        db.record_status_event(&StatusEvent {
            session_id: session.into(),
            run_id: LEGACY_RUN_ID.into(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            sequence: seq,
            state,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some("hook:Stop".into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        })
        .unwrap();
    }

    fn write_log(fx: &Fx, name: &str, bytes: &[u8]) -> PathBuf {
        let p = fx.dir.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn entry_strings(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> String {
        let mut e = zip.by_name(name).unwrap();
        let mut s = String::new();
        e.read_to_string(&mut s).unwrap();
        s
    }

    // -- 1. export_log -------------------------------------------------------

    #[test]
    fn export_log_ranges_strip_and_conflict() {
        let fx = fx();
        add_project(&fx.db, "prj_1", "demo");
        let log = write_log(&fx, "out.log", b"l1\nl2\n\x1b[31ml3\x1b[0m\n");
        add_session(&fx.db, "ses_1", "prj_1", &log);
        let ex = Exporter {
            paths: &fx.paths,
            db: &fx.db,
        };
        let secrets: Vec<Vec<u8>> = vec![];

        // All + Keep: byte-exact copy.
        let dest = fx.dir.path().join("all.log");
        let p = ex
            .export_log("ses_1", &dest, LogRange::All, AnsiMode::Keep, &secrets)
            .unwrap();
        assert_eq!(p, dest);
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            b"l1\nl2\n\x1b[31ml3\x1b[0m\n"
        );

        // Existing destination -> Conflict, never silent overwrite (8.3).
        assert!(matches!(
            ex.export_log("ses_1", &dest, LogRange::All, AnsiMode::Keep, &secrets),
            Err(CoreError::Conflict(_))
        ));
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            b"l1\nl2\n\x1b[31ml3\x1b[0m\n"
        );

        // LastLines(2) from the tail.
        let dest2 = fx.dir.path().join("tail.log");
        ex.export_log(
            "ses_1",
            &dest2,
            LogRange::LastLines(2),
            AnsiMode::Keep,
            &secrets,
        )
        .unwrap();
        assert_eq!(std::fs::read(&dest2).unwrap(), b"l2\n\x1b[31ml3\x1b[0m\n");

        // Strip leaves no ESC bytes anywhere.
        let dest3 = fx.dir.path().join("strip.log");
        ex.export_log("ses_1", &dest3, LogRange::All, AnsiMode::Strip, &secrets)
            .unwrap();
        let out = std::fs::read(&dest3).unwrap();
        assert_eq!(out, b"l1\nl2\nl3\n");
        assert!(!out.contains(&0x1b));

        // Binary-safe tailing: invalid UTF-8 / NUL bytes pass through untouched.
        let log2 = write_log(&fx, "bin.log", b"a\n\xff\xfe\x00\nb\n");
        add_session(&fx.db, "ses_2", "prj_1", &log2);
        let dest4 = fx.dir.path().join("bin-tail.log");
        ex.export_log(
            "ses_2",
            &dest4,
            LogRange::LastLines(2),
            AnsiMode::Keep,
            &secrets,
        )
        .unwrap();
        assert_eq!(std::fs::read(&dest4).unwrap(), b"\xff\xfe\x00\nb\n");

        // Redaction is applied and the hit is recorded in the audit table.
        let log3 = write_log(&fx, "secret.log", b"token=hunter2-token-abcdef ok\n");
        add_session(&fx.db, "ses_3", "prj_1", &log3);
        let dest5 = fx.dir.path().join("redacted.log");
        ex.export_log(
            "ses_3",
            &dest5,
            LogRange::All,
            AnsiMode::Keep,
            &[SECRET.to_vec()],
        )
        .unwrap();
        let out = std::fs::read(&dest5).unwrap();
        assert_eq!(out, b"token=[redacted] ok\n");
        assert_eq!(fx.db.redaction_hits_total("ses_3").unwrap(), 1);

        // No temp artifacts left behind in exports/.
        let leftovers: Vec<_> = std::fs::read_dir(fx.paths.exports_dir())
            .map(|it| it.collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "temp leftovers: {leftovers:?}");
    }

    // -- 2. export_markdown --------------------------------------------------

    #[test]
    fn export_markdown_header_blocks_and_redaction() {
        let fx = fx();
        add_project(&fx.db, "prj_1", "main-api");
        add_worktree(
            &fx.db,
            "wt_1",
            "prj_1",
            "agent/fix-login",
            Path::new("/tmp/wt-x"),
        );
        let log = write_log(
            &fx,
            "md.log",
            b"block one\n\nblock two\n\nblock three hunter2-token-abcdef\n",
        );
        add_session_wt(&fx.db, "ses_1", "prj_1", &log, Some("wt_1"));

        let ex = Exporter {
            paths: &fx.paths,
            db: &fx.db,
        };
        let dest = fx.dir.path().join("out.md");
        ex.export_markdown("ses_1", &dest, MdBlocks::Last(2), &[SECRET.to_vec()])
            .unwrap();
        let md = std::fs::read_to_string(&dest).unwrap();

        // Header fields (8.1): session, title, agent, project, cwd, branch,
        // created/updated, lifecycle, export time.
        for needle in [
            "session: ses_1",
            "title: title of ses_1",
            "agent: Kimi Code",
            "project: main-api",
            "cwd: /tmp/cwd",
            "branch: agent/fix-login",
            "created: ",
            "updated: ",
            "lifecycle: running",
            "exported: ",
        ] {
            assert!(md.contains(needle), "header missing {needle:?}:\n{md}");
        }

        // Last(2) keeps the last two visible blocks; block one is gone.
        assert!(!md.contains("block one"));
        assert!(md.contains("block two"));
        assert!(md.contains("block three"));
        // single fence pair around the body
        assert_eq!(md.matches("```").count(), 2, "fence count:\n{md}");

        // Secret masked in the body and hit recorded.
        assert!(md.contains("[redacted]"));
        assert!(!md.contains(std::str::from_utf8(SECRET).unwrap()));
        assert_eq!(fx.db.redaction_hits_total("ses_1").unwrap(), 1);
    }

    // -- 3+4. diagnostics zip: structure, redaction, manifest hygiene --------

    /// Two sessions: ses_a has a worktree on a real git repo, status events and
    /// a secret in its log; ses_b is plain. Returns the zip path + fixture.
    fn build_diag_zip() -> (Fx, PathBuf, Session, Session) {
        let fx = fx();
        add_project(&fx.db, "prj_1", "main-api");

        // Real git repo so DirtySummary.raw is genuine (untracked file shows up
        // without needing a commit).
        let repo = fx.dir.path().join("wt-repo");
        std::fs::create_dir_all(&repo).unwrap();
        let st = Command::new("git").arg("init").arg(&repo).output().unwrap();
        assert!(st.status.success());
        std::fs::write(repo.join("dirty.txt"), b"uncommitted\n").unwrap();
        add_worktree(&fx.db, "wt_1", "prj_1", "agent/fix", &repo);

        let log_a = write_log(
            &fx,
            "a.log",
            b"\x1b[32mok\x1b[0m token=hunter2-token-abcdef\nline2\n",
        );
        let a = add_session_wt(&fx.db, "ses_a", "prj_1", &log_a, Some("wt_1"));
        add_event(&fx.db, "ses_a", 1, AgentState::Working);
        add_event(&fx.db, "ses_a", 2, AgentState::NeedsInput);

        let log_b = write_log(&fx, "b.log", b"plain output\n");
        let b = add_session(&fx.db, "ses_b", "prj_1", &log_b);
        add_event(&fx.db, "ses_b", 1, AgentState::Idle);

        let dest = fx.dir.path().join("diag.zip");
        let ex = Exporter {
            paths: &fx.paths,
            db: &fx.db,
        };
        ex.export_diagnostics_zip(
            &["ses_a".to_string(), "ses_b".to_string()],
            &dest,
            &[SECRET.to_vec()],
        )
        .unwrap();
        (fx, dest, a, b)
    }

    #[test]
    fn diagnostics_zip_structure_redaction_and_manifest() {
        let (fx, dest, a, b) = build_diag_zip();
        let f = std::fs::File::open(&dest).unwrap();
        let mut zip = zip::ZipArchive::new(f).unwrap();

        let names: BTreeSet<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        let expected: BTreeSet<String> = [
            "manifest.json",
            "sessions/ses_a-status-events.json",
            "sessions/ses_b-status-events.json",
            "worktrees/main-api-agent-fix-git-status.txt",
            "diagnostics/app-version.txt",
            "diagnostics/platform.txt",
            "diagnostics/adapter-capabilities.json",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(names, expected);

        // Native transcript bodies and legacy terminal logs are never staged.
        let secret_str = std::str::from_utf8(SECRET).unwrap();
        for i in 0..zip.len() {
            let mut e = zip.by_index(i).unwrap();
            let mut buf = Vec::new();
            e.read_to_end(&mut buf).unwrap();
            assert!(
                !buf.windows(SECRET.len()).any(|w| w == SECRET),
                "secret leaked into zip entry {}",
                e.name()
            );
            assert!(!e.name().ends_with("-terminal.log"));
        }

        // manifest.json: schema fields + redaction declaration.
        let mstr = entry_strings(&mut zip, "manifest.json");
        let m: ExportManifest = serde_json::from_str(&mstr).unwrap();
        assert_eq!(m.format_version, DIAG_ZIP_VERSION);
        assert_eq!(m.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(m.sessions, vec!["ses_a".to_string(), "ses_b".to_string()]);
        assert!(m.redaction.applied);
        assert_eq!(m.redaction.rule, "exact-byte-match:fixed-mask");
        assert_eq!(m.redaction.hit_count, 0, "native transcript was copied: {mstr}");
        let mut listed = m.files.clone();
        listed.push("manifest.json".to_string());
        listed.sort();
        assert_eq!(listed, expected.into_iter().collect::<Vec<_>>());

        // Manifest hygiene (8.2): no host token, no secret value.
        assert!(!mstr.contains(&a.host_token));
        assert!(!mstr.contains(&b.host_token));
        assert!(!mstr.contains(secret_str));

        // status-events.json parses back into the recorded events.
        let evs: Vec<StatusEvent> = serde_json::from_str(&entry_strings(
            &mut zip,
            "sessions/ses_a-status-events.json",
        ))
        .unwrap();
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].sequence, 1);
        assert_eq!(evs[1].state, AgentState::NeedsInput);

        // Worktree diagnostics remain available without copying conversation bodies.
        let git = entry_strings(&mut zip, "worktrees/main-api-agent-fix-git-status.txt");
        assert!(git.contains("??"), "{git}");

        // diagnostics/ files are non-empty and well-formed.
        assert!(entry_strings(&mut zip, "diagnostics/app-version.txt")
            .contains(env!("CARGO_PKG_VERSION")));
        assert!(entry_strings(&mut zip, "diagnostics/platform.txt").contains("os: "));
        let caps: Vec<AdapterInstall> = serde_json::from_str(&entry_strings(
            &mut zip,
            "diagnostics/adapter-capabilities.json",
        ))
        .unwrap();
        assert!(caps.is_empty());

        // Hits were audited; temp staging dir removed (8.3).
        assert_eq!(fx.db.redaction_hits_total("ses_a").unwrap(), 0);
        let leftovers: Vec<_> = std::fs::read_dir(fx.paths.exports_dir())
            .map(|it| it.collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "temp leftovers: {leftovers:?}");
    }

    #[test]
    fn diagnostics_zip_ignores_missing_legacy_logs_and_keeps_sources() {
        let fx = fx();
        add_project(&fx.db, "prj_1", "demo");
        let log_ok = write_log(&fx, "ok.log", b"precious source bytes\n");
        add_session(&fx.db, "ses_ok", "prj_1", &log_ok);
        // A stale or missing legacy log path is irrelevant because diagnostics
        // no longer copies conversation bodies.
        let missing = fx.dir.path().join("does-not-exist.log");
        add_session(&fx.db, "ses_broken", "prj_1", &missing);

        let dest = fx.dir.path().join("diag.zip");
        let ex = Exporter {
            paths: &fx.paths,
            db: &fx.db,
        };
        let r = ex.export_diagnostics_zip(
            &["ses_ok".to_string(), "ses_broken".to_string()],
            &dest,
            &[],
        );
        assert!(r.is_ok(), "{r:?}");
        assert!(dest.exists());
        // temp staging dir removed
        let leftovers: Vec<_> = std::fs::read_dir(fx.paths.exports_dir())
            .map(|it| it.collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "temp leftovers: {leftovers:?}");
        // source log untouched
        assert_eq!(std::fs::read(&log_ok).unwrap(), b"precious source bytes\n");
    }

    // -- helpers unit checks --------------------------------------------------

    #[test]
    fn tail_lines_byte_semantics() {
        assert_eq!(tail_lines(b"a\nb\nc\n", 2), b"b\nc\n");
        assert_eq!(tail_lines(b"a\nb\nc\n", 1), b"c\n");
        assert_eq!(tail_lines(b"a\nb", 1), b"b");
        assert_eq!(tail_lines(b"a\nb", 9), b"a\nb");
        assert_eq!(tail_lines(b"no-newline", 3), b"no-newline");
        assert_eq!(tail_lines(b"a\nb\n", 0), b"");
        assert_eq!(tail_lines(b"", 3), b"");
    }

    #[test]
    fn visible_blocks_split_and_drop_empty() {
        // Leading indentation is terminal content and survives; only trailing
        // whitespace is trimmed.
        let blocks = visible_blocks("one\n\n\n two \n\nthree\nstill three\n\n");
        assert_eq!(blocks, vec!["one", " two", "three\nstill three"]);
        assert!(visible_blocks("\n\n\n").is_empty());
    }
}
