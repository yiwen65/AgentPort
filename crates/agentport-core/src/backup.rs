//! Full-data backup / restore (single-user, local file).
//!
//! Scope decision (product): a backup captures everything needed to rebuild
//! AgentPort's own state — the SQLite database (consistent snapshot) plus the
//! per-session files — and deliberately EXCLUDES Git worktrees, exports and
//! diagnostics. Worktrees are recoverable from Git itself and can be huge;
//! exports/diagnostics are derived artifacts.
//!
//! Format v1: a zip containing `manifest.json`, `agentport.db` and
//! `sessions/**`. The manifest lists every payload file with size + SHA-256 so
//! `verify` and `restore` can prove integrity before touching real data.
//! Secret VALUES never enter the backup: they live in the OS credential store
//! and are referenced by metadata inside the DB only.

use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::models::DATA_MODEL_VERSION;
use crate::paths::AppPaths;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const BACKUP_FORMAT_VERSION: u32 = 1;

// Backups are user-selected external input during verify/restore. Keep every
// resource dimension bounded before decompression starts. One retained Host
// log is capped at 2 GiB by Settings, so 4 GiB leaves room for the database
// and future per-file growth without accepting an unbounded archive.
const MAX_BACKUP_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BACKUP_PAYLOAD_ENTRIES: usize = 50_000;
const MAX_BACKUP_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_BACKUP_TOTAL_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_BACKUP_COMPRESSION_RATIO: u64 = 200;
const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub format_version: u32,
    pub created_at: DateTime<Utc>,
    pub app_version: String,
    pub data_model_version: i64,
    /// Payload files (manifest.json itself is not listed).
    pub files: Vec<BackupFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

pub struct BackupReport {
    pub files: u64,
    pub bytes: u64,
}

fn sha256_reader(mut r: impl Read) -> Result<(String, u64)> {
    let mut h = Sha256::new();
    let n = std::io::copy(&mut r, &mut h)?;
    Ok((format!("{:x}", h.finalize()), n))
}

fn copy_and_hash_bounded(
    reader: &mut impl Read,
    writer: &mut impl Write,
    max_bytes: u64,
    label: &str,
) -> Result<(String, u64)> {
    let mut hash = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| CoreError::Validation(format!("backup entry too large: {label}")))?;
        if total > max_bytes {
            return Err(CoreError::Validation(format!(
                "backup entry exceeds {max_bytes} bytes: {label}"
            )));
        }
        hash.update(&buffer[..read]);
        writer.write_all(&buffer[..read])?;
    }
    Ok((format!("{:x}", hash.finalize()), total))
}

fn validate_payload_entry_count(count: usize) -> Result<()> {
    if count > MAX_BACKUP_PAYLOAD_ENTRIES {
        return Err(CoreError::Validation(format!(
            "backup has {count} payload entries; maximum is {MAX_BACKUP_PAYLOAD_ENTRIES}"
        )));
    }
    Ok(())
}

fn validate_manifest_limits(manifest: &BackupManifest) -> Result<()> {
    validate_payload_entry_count(manifest.files.len())?;
    let mut total = 0_u64;
    for entry in &manifest.files {
        if entry.size > MAX_BACKUP_FILE_BYTES {
            return Err(CoreError::Validation(format!(
                "backup entry {} declares {} bytes; per-file maximum is {}",
                entry.path, entry.size, MAX_BACKUP_FILE_BYTES
            )));
        }
        total = total
            .checked_add(entry.size)
            .ok_or_else(|| CoreError::Validation("backup declared size overflows u64".into()))?;
        if total > MAX_BACKUP_TOTAL_BYTES {
            return Err(CoreError::Validation(format!(
                "backup declares {total} bytes; total maximum is {MAX_BACKUP_TOTAL_BYTES}"
            )));
        }
    }
    Ok(())
}

fn validate_compression_ratio(uncompressed: u64, compressed: u64, label: &str) -> Result<()> {
    if uncompressed > 0
        && (compressed == 0
            || uncompressed > compressed.saturating_mul(MAX_BACKUP_COMPRESSION_RATIO))
    {
        return Err(CoreError::Validation(format!(
            "backup entry compression ratio exceeds {MAX_BACKUP_COMPRESSION_RATIO}:1: {label}"
        )));
    }
    Ok(())
}

fn validate_zip_entry(
    entry: &zip::read::ZipFile<'_>,
    declared_size: u64,
    label: &str,
) -> Result<()> {
    if entry.is_dir() {
        return Err(CoreError::Validation(format!(
            "backup payload is a directory: {label}"
        )));
    }
    if entry.size() != declared_size {
        return Err(CoreError::Validation(format!(
            "backup entry size differs from manifest for {label}: manifest {declared_size}, zip {}",
            entry.size()
        )));
    }
    validate_compression_ratio(entry.size(), entry.compressed_size(), label)
}

fn validate_archive_shape<R: Read + std::io::Seek>(
    zip: &zip::ZipArchive<R>,
    manifest: &BackupManifest,
) -> Result<()> {
    validate_payload_entry_count(zip.len().saturating_sub(1))?;
    let expected = manifest.files.len().checked_add(1).ok_or_else(|| {
        CoreError::Validation("backup archive entry count overflows usize".into())
    })?;
    if zip.len() != expected {
        return Err(CoreError::Validation(format!(
            "backup archive has {} entries; manifest describes {} payload entries",
            zip.len(),
            manifest.files.len()
        )));
    }
    Ok(())
}

fn private_create(path: &Path) -> Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    Ok(opts.open(path)?)
}

/// Directories/files inside the data root that never enter a backup.
fn is_excluded_from_backup(paths: &AppPaths, abs: &Path) -> bool {
    let root = paths.root();
    let Ok(rel) = abs.strip_prefix(root) else {
        return true;
    };
    let first = rel.components().next().map(|c| c.as_os_str());
    matches!(
        first,
        Some(f) if f == "worktrees"
            || f == "exports"
            || f == "diagnostics"
            || f == "backups"
            || f == "logs"
    ) || abs == paths.db_path()
        || abs == paths.db_path().with_extension("db-wal")
        || abs == paths.db_path().with_extension("db-shm")
}

fn collect_session_files(paths: &AppPaths, out: &mut Vec<PathBuf>) -> Result<()> {
    let mut stack = vec![paths.sessions_dir()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue; // missing sessions dir is an empty backup scope, not an error
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let ft = entry.file_type()?;
            if ft.is_symlink() {
                // Never follow links out of the data root during backup.
                continue;
            }
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                out.push(path);
            }
        }
    }
    out.sort();
    Ok(())
}

/// Create a backup archive at `dest` (must not exist). Atomic: staged under
/// the exports dir and renamed into place; any failure leaves no partial file.
pub fn create(paths: &AppPaths, db: &Db, dest: &Path) -> Result<BackupReport> {
    if dest.exists() {
        return Err(CoreError::Conflict(format!(
            "backup destination already exists: {}",
            dest.display()
        )));
    }
    let exports = paths.exports_dir();
    std::fs::create_dir_all(&exports)?;
    let staging = exports.join(format!(".backup-{}", crate::ids::new_id("bak")));
    std::fs::create_dir_all(&staging)?;
    let _dir_guard = crate::export::TempDirGuard::new(staging.clone());

    // 1. Consistent DB snapshot (online backup API; never copies the WAL raw).
    let db_snapshot = staging.join("agentport.db");
    db.backup_snapshot(&db_snapshot)?;

    // 2. Payload inventory with integrity digests.
    let mut files = vec![BackupFileEntry {
        path: "agentport.db".into(),
        ..digest_entry(&db_snapshot)?
    }];
    let mut session_files = Vec::new();
    collect_session_files(paths, &mut session_files)?;
    for abs in session_files {
        if is_excluded_from_backup(paths, &abs) {
            continue;
        }
        let rel = abs
            .strip_prefix(paths.root())
            .map_err(|_| CoreError::Internal("session file outside data root".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        files.push(BackupFileEntry {
            path: rel,
            ..digest_entry(&abs)?
        });
    }

    let manifest = BackupManifest {
        format_version: BACKUP_FORMAT_VERSION,
        created_at: Utc::now(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        data_model_version: DATA_MODEL_VERSION,
        files: files.clone(),
    };
    validate_manifest_limits(&manifest)?;
    let manifest_json = serde_json::to_vec_pretty(&manifest)?;
    if manifest_json.len() as u64 > MAX_BACKUP_MANIFEST_BYTES {
        return Err(CoreError::Validation(format!(
            "backup manifest exceeds {MAX_BACKUP_MANIFEST_BYTES} bytes"
        )));
    }

    // 3. Pack staged zip, then publish atomically.
    let tmp_zip = exports.join(format!(".backup-{}.zip", crate::ids::new_id("bak")));
    let _zip_guard = TempFileGuard::new(tmp_zip.clone());
    {
        let f = private_create(&tmp_zip)?;
        let mut zw = zip::ZipWriter::new(f);
        // Keep archives produced here compatible with the same compression-ratio
        // guard used for untrusted imports. A manifest flag cannot safely exempt
        // local archives because an attacker could forge it, so generated entries
        // are stored verbatim while external Deflate entries remain ratio-limited.
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(0o600);
        zw.start_file("manifest.json", opts)
            .map_err(|e| CoreError::Export(format!("backup zip manifest: {e}")))?;
        zw.write_all(&manifest_json)?;
        for entry in &files {
            let src = if entry.path == "agentport.db" {
                db_snapshot.clone()
            } else {
                paths.root().join(&entry.path)
            };
            zw.start_file(entry.path.clone(), opts)
                .map_err(|e| CoreError::Export(format!("backup zip entry {}: {e}", entry.path)))?;
            let mut source = std::fs::File::open(&src)?;
            let (sha, size) =
                copy_and_hash_bounded(&mut source, &mut zw, MAX_BACKUP_FILE_BYTES, &entry.path)?;
            // Guard against a file changing between digest and pack.
            if sha != entry.sha256 || size != entry.size {
                return Err(CoreError::Conflict(format!(
                    "file changed during backup: {}",
                    entry.path
                )));
            }
        }
        let f = zw
            .finish()
            .map_err(|e| CoreError::Export(format!("backup zip finish: {e}")))?;
        f.sync_all()?;
    }
    crate::export::publish_backup(&tmp_zip, dest)?;

    let bytes = files.iter().map(|f| f.size).sum();
    Ok(BackupReport {
        files: files.len() as u64,
        bytes,
    })
}

fn digest_entry(path: &Path) -> Result<BackupFileEntry> {
    let (sha256, size) = sha256_reader(std::fs::File::open(path)?)?;
    Ok(BackupFileEntry {
        path: String::new(),
        size,
        sha256,
    })
}

/// Read and structurally verify a backup archive. Returns its manifest.
pub fn verify(archive: &Path) -> Result<BackupManifest> {
    let f = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(f)
        .map_err(|e| CoreError::Validation(format!("not a backup zip: {e}")))?;
    validate_payload_entry_count(zip.len().saturating_sub(1))?;
    let manifest: BackupManifest = {
        let mut entry = zip
            .by_name("manifest.json")
            .map_err(|_| CoreError::Validation("backup manifest missing".into()))?;
        if entry.size() > MAX_BACKUP_MANIFEST_BYTES {
            return Err(CoreError::Validation(format!(
                "backup manifest exceeds {MAX_BACKUP_MANIFEST_BYTES} bytes"
            )));
        }
        validate_compression_ratio(entry.size(), entry.compressed_size(), "manifest.json")?;
        let capacity = usize::try_from(entry.size())
            .map_err(|_| CoreError::Validation("backup manifest is too large".into()))?;
        let mut buf = Vec::with_capacity(capacity);
        entry
            .by_ref()
            .take(MAX_BACKUP_MANIFEST_BYTES + 1)
            .read_to_end(&mut buf)?;
        if buf.len() as u64 > MAX_BACKUP_MANIFEST_BYTES {
            return Err(CoreError::Validation(format!(
                "backup manifest exceeds {MAX_BACKUP_MANIFEST_BYTES} bytes"
            )));
        }
        serde_json::from_slice(&buf)?
    };
    if manifest.format_version != BACKUP_FORMAT_VERSION {
        return Err(CoreError::Validation(format!(
            "unsupported backup format v{} (this build reads v{})",
            manifest.format_version, BACKUP_FORMAT_VERSION
        )));
    }
    if manifest.data_model_version > DATA_MODEL_VERSION {
        return Err(CoreError::Conflict(format!(
            "backup data model v{} is newer than this build (v{})",
            manifest.data_model_version, DATA_MODEL_VERSION
        )));
    }
    if !manifest.files.iter().any(|f| f.path == "agentport.db") {
        return Err(CoreError::Validation(
            "backup has no database snapshot".into(),
        ));
    }
    validate_manifest_limits(&manifest)?;
    validate_archive_shape(&zip, &manifest)?;
    let mut seen = std::collections::HashSet::new();
    for entry in &manifest.files {
        if !seen.insert(entry.path.clone()) {
            return Err(CoreError::Validation(format!(
                "duplicate backup entry {}",
                entry.path
            )));
        }
        // Zip-slip guard: payload paths must stay relative and segment-clean.
        let rel = Path::new(&entry.path);
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(CoreError::Validation(format!(
                "unsafe backup path {}",
                entry.path
            )));
        }
        let mut zf = zip
            .by_name(&entry.path)
            .map_err(|_| CoreError::Validation(format!("missing payload {}", entry.path)))?;
        validate_zip_entry(&zf, entry.size, &entry.path)?;
        let mut sink = std::io::sink();
        let (sha, size) = copy_and_hash_bounded(&mut zf, &mut sink, entry.size, &entry.path)?;
        if sha != entry.sha256 || size != entry.size {
            return Err(CoreError::Validation(format!(
                "integrity check failed for {}",
                entry.path
            )));
        }
    }
    Ok(manifest)
}

/// Restore a verified backup into `target_root`.
///
/// Safety contract:
/// - The archive is fully verified BEFORE anything is extracted.
/// - Extraction happens into a sibling staging dir; the target is only swapped
///   in after the DB passes `PRAGMA integrity_check`.
/// - A non-empty target is renamed aside (`<name>.pre-restore-<ts>`) instead of
///   deleted, so a restore is always reversible by hand.
/// - Live sessions are NOT resumed: restored sessions reconcile as interrupted
///   on next launch (host processes never survive a machine/app restart).
pub fn restore(archive: &Path, target_root: &Path) -> Result<PathBuf> {
    let manifest = verify(archive)?;

    let parent = target_root.parent().ok_or_else(|| {
        CoreError::Validation("restore target must have a parent directory".into())
    })?;
    std::fs::create_dir_all(parent)?;
    let staging = parent.join(format!(
        ".restore-{}-{}",
        target_root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "agentport".into()),
        crate::ids::new_id("rst")
    ));
    std::fs::create_dir_all(&staging)?;
    let _guard = crate::export::TempDirGuard::new(staging.clone());

    // Extract verified payload only.
    {
        let f = std::fs::File::open(archive)?;
        let mut zip = zip::ZipArchive::new(f)
            .map_err(|e| CoreError::Validation(format!("not a backup zip: {e}")))?;
        validate_archive_shape(&zip, &manifest)?;
        for entry in &manifest.files {
            let mut zf = zip
                .by_name(&entry.path)
                .map_err(|_| CoreError::Validation(format!("missing payload {}", entry.path)))?;
            validate_zip_entry(&zf, entry.size, &entry.path)?;
            let out = staging.join(&entry.path);
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p)?;
            }
            let mut destination = private_create(&out)?;
            let (sha, size) =
                copy_and_hash_bounded(&mut zf, &mut destination, entry.size, &entry.path)?;
            if sha != entry.sha256 || size != entry.size {
                return Err(CoreError::Validation(format!(
                    "integrity check failed while restoring {}",
                    entry.path
                )));
            }
            destination.flush()?;
            crate::paths::AppPaths::restrict_file(&out)?;
        }
    }

    // DB sanity before swap: integrity + schema version this build can migrate.
    {
        let conn = rusqlite::Connection::open(staging.join("agentport.db"))?;
        let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if ok != "ok" {
            return Err(CoreError::Validation(format!(
                "restored database failed integrity_check: {ok}"
            )));
        }
        let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let latest = crate::db::schema::MIGRATIONS.len() as i64;
        if user_version > latest {
            return Err(CoreError::Conflict(format!(
                "restored database schema v{user_version} is newer than this build (v{latest})"
            )));
        }
    }

    // Swap: keep the previous tree as a manual rollback point.
    let previous = if target_root.exists() {
        let ts = Utc::now().format("%Y%m%d-%H%M%S");
        let aside = parent.join(format!(
            "{}.pre-restore-{ts}",
            target_root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "agentport".into())
        ));
        if aside.exists() {
            return Err(CoreError::Conflict(format!(
                "rollback destination already exists: {}",
                aside.display()
            )));
        }
        std::fs::rename(target_root, &aside)?;
        Some(aside)
    } else {
        None
    };
    if let Err(e) = std::fs::rename(&staging, target_root) {
        // Best-effort rollback of the swap so we never strand the user with no
        // data directory at all.
        if let Some(aside) = &previous {
            let _ = std::fs::rename(aside, target_root);
        }
        return Err(CoreError::Io(e));
    }
    // Staging was consumed by the swap; disarm the guard.
    std::mem::forget(_guard);
    Ok(previous.unwrap_or_default())
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentType, Lifecycle, PermissionMode, ResumePrecision};
    use chrono::Utc;

    struct Fx {
        dir: tempfile::TempDir,
        paths: AppPaths,
        db: Db,
    }

    fn fx() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().join("data"));
        paths.ensure_layout().unwrap();
        let db = Db::open(&paths).unwrap();
        db.add_project(&crate::models::Project {
            id: "prj_1".into(),
            name: "demo".into(),
            root_path: "/tmp/demo".into(),
            git_root_path: None,
            created_at: Utc::now(),
        })
        .unwrap();
        db.insert_session(&crate::models::Session {
            id: "ses_1".into(),
            project_id: "prj_1".into(),
            worktree_id: None,
            preset_id: "pre_shell_safe".into(),
            title: "demo session".into(),
            cwd: "/tmp/demo".into(),
            host_pid: None,
            host_socket: None,
            host_token: "t".repeat(32),
            lifecycle: Lifecycle::Stopped,
            agent_session_id: None,
            resume_precision: ResumePrecision::Unavailable,
            log_path: paths.log_path("ses_1").to_string_lossy().into_owned(),
            adapter_type: AgentType::Shell,
            transport: crate::models::AgentTransport::Pty,
            command: vec!["sh".into()],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            archived_at: None,
        })
        .unwrap();
        std::fs::create_dir_all(paths.session_dir("ses_1")).unwrap();
        std::fs::write(paths.log_path("ses_1"), b"hello terminal\n").unwrap();
        Fx { dir, paths, db }
    }

    fn manifest(files: Vec<BackupFileEntry>) -> BackupManifest {
        BackupManifest {
            format_version: BACKUP_FORMAT_VERSION,
            created_at: Utc::now(),
            app_version: "test".into(),
            data_model_version: DATA_MODEL_VERSION,
            files,
        }
    }

    fn entry(path: &str, data: &[u8]) -> BackupFileEntry {
        let (sha256, size) = sha256_reader(data).unwrap();
        BackupFileEntry {
            path: path.into(),
            size,
            sha256,
        }
    }

    fn write_custom_backup(
        archive: &Path,
        manifest: &BackupManifest,
        payloads: &[(String, Vec<u8>)],
    ) {
        let file = std::fs::File::create(archive).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(manifest).unwrap())
            .unwrap();
        for (path, data) in payloads {
            zip.start_file(path, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn backup_verify_restore_roundtrip() {
        let fx = fx();
        let archive = fx.dir.path().join("backup.zip");
        let report = create(&fx.paths, &fx.db, &archive).unwrap();
        assert!(report.files >= 2); // db + session log
        assert!(archive.exists());
        // Overwrite protection.
        assert!(matches!(
            create(&fx.paths, &fx.db, &archive),
            Err(CoreError::Conflict(_))
        ));

        let manifest = verify(&archive).unwrap();
        assert!(manifest.files.iter().any(|f| f.path == "agentport.db"));
        assert!(manifest
            .files
            .iter()
            .any(|f| f.path == "sessions/ses_1/output.log"));

        let target = fx.dir.path().join("restored");
        let prev = restore(&archive, &target).unwrap();
        assert!(prev.as_os_str().is_empty());
        assert_eq!(
            std::fs::read(target.join("sessions/ses_1/output.log")).unwrap(),
            b"hello terminal\n"
        );
        // Restored DB opens and contains the session.
        let restored_paths = AppPaths::new(target.clone());
        let restored_db = Db::open(&restored_paths).unwrap();
        assert_eq!(
            restored_db.get_session("ses_1").unwrap().title,
            "demo session"
        );
    }

    #[test]
    fn highly_compressible_created_backup_verifies_and_restores() {
        let fx = fx();
        let payload = vec![0_u8; 1024 * 1024];
        std::fs::write(fx.paths.log_path("ses_1"), &payload).unwrap();

        let archive = fx.dir.path().join("compressible.zip");
        create(&fx.paths, &fx.db, &archive).unwrap();
        verify(&archive).unwrap();

        let target = fx.dir.path().join("restored-compressible");
        restore(&archive, &target).unwrap();
        assert_eq!(
            std::fs::read(target.join("sessions/ses_1/output.log")).unwrap(),
            payload
        );
    }

    #[test]
    fn restore_keeps_previous_tree_aside() {
        let fx = fx();
        let archive = fx.dir.path().join("backup.zip");
        create(&fx.paths, &fx.db, &archive).unwrap();
        let target = fx.dir.path().join("restored");
        restore(&archive, &target).unwrap();
        let prev = restore(&archive, &target).unwrap();
        assert!(prev.exists(), "previous tree moved aside for rollback");
        assert!(target.join("agentport.db").exists());
    }

    #[test]
    fn tampered_backup_is_rejected() {
        let fx = fx();
        let archive = fx.dir.path().join("backup.zip");
        create(&fx.paths, &fx.db, &archive).unwrap();
        // Flip bytes at the tail (payload region) without touching structure.
        let mut raw = std::fs::read(&archive).unwrap();
        let n = raw.len();
        raw[n / 2] ^= 0xFF;
        std::fs::write(&archive, raw).unwrap();
        assert!(verify(&archive).is_err());
    }

    #[test]
    fn forged_manifest_size_is_rejected_before_payload_read() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("forged-size.zip");
        let data = b"not a huge database".to_vec();
        let mut declared = entry("agentport.db", &data);
        declared.size = MAX_BACKUP_FILE_BYTES + 1;
        write_custom_backup(
            &archive,
            &manifest(vec![declared]),
            &[("agentport.db".into(), data)],
        );

        assert!(matches!(verify(&archive), Err(CoreError::Validation(_))));
    }

    #[test]
    fn highly_compressed_payload_is_rejected_as_zip_bomb() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("zip-bomb.zip");
        let data = vec![0_u8; 1024 * 1024];
        write_custom_backup(
            &archive,
            &manifest(vec![entry("agentport.db", &data)]),
            &[("agentport.db".into(), data)],
        );

        let error = verify(&archive).unwrap_err();
        assert!(matches!(error, CoreError::Validation(_)));
        assert!(error.to_string().contains("compression ratio"), "{error}");
    }

    #[test]
    fn manifest_count_and_total_size_are_bounded() {
        assert!(matches!(
            validate_payload_entry_count(MAX_BACKUP_PAYLOAD_ENTRIES + 1),
            Err(CoreError::Validation(_))
        ));

        let oversized = BackupFileEntry {
            path: "payload".into(),
            size: MAX_BACKUP_FILE_BYTES,
            sha256: "0".repeat(64),
        };
        let files = (0..(MAX_BACKUP_TOTAL_BYTES / MAX_BACKUP_FILE_BYTES + 1))
            .map(|index| BackupFileEntry {
                path: format!("payload-{index}"),
                ..oversized.clone()
            })
            .collect();
        assert!(matches!(
            validate_manifest_limits(&manifest(files)),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn worktrees_and_exports_are_excluded() {
        let fx = fx();
        std::fs::create_dir_all(fx.paths.worktrees_root().join("demo/task")).unwrap();
        std::fs::write(fx.paths.worktrees_root().join("demo/task/code.py"), b"x=1").unwrap();
        std::fs::write(fx.paths.exports_dir().join("old.zip"), b"zip").unwrap();
        let archive = fx.dir.path().join("backup.zip");
        create(&fx.paths, &fx.db, &archive).unwrap();
        let manifest = verify(&archive).unwrap();
        assert!(!manifest
            .files
            .iter()
            .any(|f| f.path.starts_with("worktrees/")));
        assert!(!manifest
            .files
            .iter()
            .any(|f| f.path.starts_with("exports/")));
    }
}
