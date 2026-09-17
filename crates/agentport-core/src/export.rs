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

/// Redaction rule string declared in manifest.json (mirrors redact.rs).
const REDACTION_RULE: &str = "exact-byte-match:fixed-mask";

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

    fn add_session_wt(db: &Db, id: &str, project: &str, _log: &Path, wt: Option<&str>) -> Session {
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


}
