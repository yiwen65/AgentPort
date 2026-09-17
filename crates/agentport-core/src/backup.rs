//! Full-data backup / restore (single-user, local file).
//!
//! Scope decision (product): a backup captures everything needed to rebuild
//! AgentPort's own state — the SQLite database (consistent snapshot) plus the
//! per-session files — and deliberately EXCLUDES Git worktrees, exports and
//! diagnostics. Worktrees are recoverable from Git itself and can be huge;
//! exports/diagnostics are derived artifacts.
//!
//! Format v2: a zip containing `manifest.json`, `agentport.db`,
//! `sessions/**`, and provider-aware `native/**` archive payloads. The
//! manifest lists every payload file with size + SHA-256 so `verify` and
//! `restore` can prove integrity before touching real data. Readers retain v1
//! compatibility; absent native fields mean an empty native payload.
//! AgentPort never reads OS credential-store values for backup; only their DB
//! references are included. Native transcripts are copied verbatim, however,
//! so a value already printed into a conversation or tool output can be present.

use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::models::{AgentType, DATA_MODEL_VERSION};
use crate::native_backup::{
    NativeCoverage, NativeCoverageSummary, NativeSessionBackup, NativeTargetRoot,
};
use crate::paths::AppPaths;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const BACKUP_FORMAT_VERSION: u32 = 2;
const MIN_READABLE_BACKUP_FORMAT_VERSION: u32 = 1;

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
    /// None identifies legacy full-data archives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<AgentType>,
    /// Provider-native Session payload descriptors. Missing in format v1.
    #[serde(default)]
    pub native_sessions: Vec<NativeSessionBackup>,
    /// Aggregate capture coverage. Missing in format v1.
    #[serde(default)]
    pub native_coverage: NativeCoverageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupPhase {
    Database,
    Filtering,
    Native,
    Files,
    Archive,
    Verify,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub phase: BackupPhase,
    pub completed: u64,
    pub total: u64,
}

fn report_progress(
    progress: &mut dyn FnMut(BackupProgress),
    phase: BackupPhase,
    completed: u64,
    total: u64,
) {
    progress(BackupProgress {
        phase,
        completed,
        total,
    });
}

pub struct BackupReport {
    pub files: u64,
    pub bytes: u64,
    pub native_coverage: NativeCoverageSummary,
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

fn safe_relative_path(path: &str) -> bool {
    let path = Path::new(path);
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn native_id_is_safe_component(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && !id.contains('/')
        && !id.contains('\\')
        && id != "."
        && id != ".."
}

fn native_target_matches_session(
    session: &NativeSessionBackup,
    artifact: &crate::native_backup::NativeArtifact,
) -> bool {
    let target = Path::new(&artifact.target_path);
    match session.provider {
        AgentType::Pi | AgentType::EasyPi | AgentType::Omp => target.starts_with(
            Path::new("sessions")
                .join(&session.agentport_session_id)
                .join(session.provider.as_str()),
        ),
        AgentType::Claude => {
            let project = Path::new("projects").join(crate::history::cwd_slug(&session.cwd));
            session.native_session_ids.iter().any(|id| {
                target == project.join(format!("{id}.jsonl"))
                    || target.starts_with(project.join(id))
            })
        }
        AgentType::Codex => {
            target.starts_with("sessions")
                && target.extension().and_then(|value| value.to_str()) == Some("jsonl")
        }
        AgentType::Kimi => session
            .kimi_bindings
            .iter()
            .any(|binding| target.starts_with(&binding.session_relative_dir)),
        AgentType::Qoder => {
            let project = Path::new("logs/sessions").join(crate::history::cwd_slug(&session.cwd));
            session
                .native_session_ids
                .iter()
                .any(|id| target.starts_with(project.join(id)))
        }
        _ => false,
    }
}

fn validate_native_manifest(manifest: &BackupManifest) -> Result<()> {
    let expected_coverage = NativeCoverageSummary::from_sessions(&manifest.native_sessions);
    if manifest.native_coverage != expected_coverage {
        return Err(CoreError::Validation(
            "native backup coverage does not match Session descriptors".into(),
        ));
    }

    let files = manifest
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<std::collections::HashMap<_, _>>();
    let mut session_ids = std::collections::HashSet::new();
    let mut native_files = std::collections::HashSet::new();
    for session in &manifest.native_sessions {
        if !session_ids.insert(session.agentport_session_id.as_str()) {
            return Err(CoreError::Validation(format!(
                "duplicate native Session descriptor {}",
                session.agentport_session_id
            )));
        }
        if session
            .native_session_ids
            .iter()
            .any(|id| !native_id_is_safe_component(id))
        {
            return Err(CoreError::Validation(format!(
                "unsafe native Session id in {}",
                session.agentport_session_id
            )));
        }
        if session.coverage != NativeCoverage::Complete && !session.artifacts.is_empty() {
            return Err(CoreError::Validation(format!(
                "incomplete native Session {} contains artifacts",
                session.agentport_session_id
            )));
        }
        if session.coverage == NativeCoverage::Complete && session.artifacts.is_empty() {
            return Err(CoreError::Validation(format!(
                "complete native Session {} contains no artifacts",
                session.agentport_session_id
            )));
        }
        if session.provider != AgentType::Kimi && !session.kimi_bindings.is_empty() {
            return Err(CoreError::Validation(
                "non-Kimi native Session contains a Kimi index binding".into(),
            ));
        }
        if session.coverage != NativeCoverage::Complete && !session.kimi_bindings.is_empty() {
            return Err(CoreError::Validation(
                "incomplete native Session contains a Kimi index binding".into(),
            ));
        }
        if session.provider == AgentType::Kimi
            && session.coverage == NativeCoverage::Complete
            && session.kimi_bindings.is_empty()
        {
            return Err(CoreError::Validation(
                "complete Kimi native Session has no index binding".into(),
            ));
        }
        let mut kimi_ids = std::collections::HashSet::new();
        for binding in &session.kimi_bindings {
            let entry_id = binding
                .index_entry
                .get("sessionId")
                .and_then(serde_json::Value::as_str);
            let entry_cwd = binding
                .index_entry
                .get("workDir")
                .and_then(serde_json::Value::as_str);
            if !kimi_ids.insert(binding.native_session_id.as_str())
                || !session
                    .native_session_ids
                    .iter()
                    .any(|id| id == &binding.native_session_id)
                || entry_id != Some(binding.native_session_id.as_str())
                || entry_cwd != Some(session.cwd.as_str())
                || !safe_relative_path(&binding.session_relative_dir)
                || !Path::new(&binding.session_relative_dir).starts_with("sessions")
            {
                return Err(CoreError::Validation(
                    "unsafe or duplicate Kimi native Session binding".into(),
                ));
            }
        }

        let expected_root = match session.provider {
            AgentType::Pi | AgentType::EasyPi | AgentType::Omp => NativeTargetRoot::AgentPort,
            AgentType::Claude => NativeTargetRoot::Claude,
            AgentType::Codex => NativeTargetRoot::Codex,
            AgentType::Kimi => NativeTargetRoot::Kimi,
            AgentType::Qoder => NativeTargetRoot::Qoder,
            _ => {
                if !session.artifacts.is_empty() {
                    return Err(CoreError::Validation(
                        "Unsupported native Session contains artifacts".into(),
                    ));
                }
                continue;
            }
        };
        let archive_prefix = format!("native/{}/", session.agentport_session_id);
        for artifact in &session.artifacts {
            if artifact.target_root != expected_root
                || !safe_relative_path(&artifact.archive_path)
                || !artifact.archive_path.starts_with(&archive_prefix)
                || !safe_relative_path(&artifact.target_path)
                || !native_target_matches_session(session, artifact)
            {
                return Err(CoreError::Validation(format!(
                    "invalid native artifact mapping {}",
                    artifact.archive_path
                )));
            }
            if !native_files.insert(artifact.archive_path.as_str()) {
                return Err(CoreError::Validation(format!(
                    "duplicate native artifact {}",
                    artifact.archive_path
                )));
            }
            let Some(file) = files.get(artifact.archive_path.as_str()) else {
                return Err(CoreError::Validation(format!(
                    "native artifact missing from payload inventory: {}",
                    artifact.archive_path
                )));
            };
            if file.size != artifact.size || file.sha256 != artifact.sha256 {
                return Err(CoreError::Validation(format!(
                    "native artifact metadata differs from payload inventory: {}",
                    artifact.archive_path
                )));
            }
        }
    }
    for file in manifest
        .files
        .iter()
        .filter(|entry| entry.path.starts_with("native/"))
    {
        if !native_files.contains(file.path.as_str()) {
            return Err(CoreError::Validation(format!(
                "unclaimed native backup payload {}",
                file.path
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
                if path.file_name().and_then(|name| name.to_str()) == Some("pi")
                    && path.parent().and_then(Path::parent) == Some(paths.sessions_dir().as_path())
                {
                    // Pi's --session-dir is its native transcript store. It is
                    // source data owned by Pi, not AgentPort backup payload.
                    continue;
                }
                stack.push(path);
            } else if ft.is_file() {
                if matches!(
                    path.file_name().and_then(|name| name.to_str()),
                    Some("output.log" | ".pi-storage.lock")
                ) {
                    continue;
                }
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
    create_scoped(paths, db, dest, None, &mut |_| {})
}

pub fn create_agent(
    paths: &AppPaths,
    db: &Db,
    dest: &Path,
    agent: AgentType,
) -> Result<BackupReport> {
    create_agent_with_progress(paths, db, dest, agent, &mut |_| {})
}

pub fn create_agent_with_progress(
    paths: &AppPaths,
    db: &Db,
    dest: &Path,
    agent: AgentType,
    progress: &mut dyn FnMut(BackupProgress),
) -> Result<BackupReport> {
    create_scoped(paths, db, dest, Some(agent), progress)
}

fn create_scoped(
    paths: &AppPaths,
    db: &Db,
    dest: &Path,
    agent: Option<AgentType>,
    progress: &mut dyn FnMut(BackupProgress),
) -> Result<BackupReport> {
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
    report_progress(progress, BackupPhase::Database, 0, 0);
    db.backup_snapshot_with_progress(&db_snapshot, &mut |completed, total| {
        report_progress(progress, BackupPhase::Database, completed, total);
    })?;
    report_progress(progress, BackupPhase::Filtering, 0, 0);
    // Read the same consistent snapshot we pack, not a later live Session list.
    let snapshot = Db::open(&AppPaths::new(staging.clone()))?;
    if let Some(agent) = agent {
        snapshot.retain_backup_agent(agent)?;
    }
    let sessions = snapshot.list_sessions(None, true)?;
    drop(snapshot);
    let session_ids: std::collections::HashSet<_> =
        sessions.iter().map(|s| s.id.as_str()).collect();

    // 2. Capture provider-native payloads after the database snapshot, then
    // inventory every archive payload with its integrity digest.
    let mut files = vec![BackupFileEntry {
        path: "agentport.db".into(),
        ..digest_entry(&db_snapshot)?
    }];
    let mut payload_sources = vec![db_snapshot.clone()];
    let mut native_sessions = Vec::new();
    report_progress(progress, BackupPhase::Native, 0, sessions.len() as u64);
    for (index, session) in sessions.iter().enumerate() {
        let native = crate::native_backup::capture_session(paths, session, &staging)?;
        for artifact in &native.artifacts {
            files.push(BackupFileEntry {
                path: artifact.archive_path.clone(),
                size: artifact.size,
                sha256: artifact.sha256.clone(),
            });
            payload_sources.push(staging.join(&artifact.archive_path));
        }
        native_sessions.push(native);
        report_progress(
            progress,
            BackupPhase::Native,
            (index + 1) as u64,
            sessions.len() as u64,
        );
    }
    let native_coverage = NativeCoverageSummary::from_sessions(&native_sessions);

    report_progress(progress, BackupPhase::Files, 0, 0);
    let mut session_files = Vec::new();
    collect_session_files(paths, &mut session_files)?;
    for abs in session_files {
        if is_excluded_from_backup(paths, &abs) {
            continue;
        }
        if agent.is_some() {
            let relative = abs.strip_prefix(paths.sessions_dir()).unwrap_or(&abs);
            let id = relative
                .components()
                .next()
                .and_then(|c| c.as_os_str().to_str());
            if !id.is_some_and(|id| session_ids.contains(id)) {
                continue;
            }
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
        payload_sources.push(abs);
    }

    let manifest = BackupManifest {
        format_version: BACKUP_FORMAT_VERSION,
        created_at: Utc::now(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        data_model_version: DATA_MODEL_VERSION,
        files: files.clone(),
        agent_type: agent,
        native_sessions,
        native_coverage,
    };
    validate_manifest_limits(&manifest)?;
    validate_native_manifest(&manifest)?;
    let manifest_json = serde_json::to_vec_pretty(&manifest)?;
    if manifest_json.len() as u64 > MAX_BACKUP_MANIFEST_BYTES {
        return Err(CoreError::Validation(format!(
            "backup manifest exceeds {MAX_BACKUP_MANIFEST_BYTES} bytes"
        )));
    }

    // 3. Pack staged zip, then publish atomically.
    report_progress(progress, BackupPhase::Archive, 0, files.len() as u64);
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
        for (index, (entry, src)) in files.iter().zip(&payload_sources).enumerate() {
            zw.start_file(entry.path.clone(), opts)
                .map_err(|e| CoreError::Export(format!("backup zip entry {}: {e}", entry.path)))?;
            let mut source = std::fs::File::open(src)?;
            let (sha, size) =
                copy_and_hash_bounded(&mut source, &mut zw, MAX_BACKUP_FILE_BYTES, &entry.path)?;
            // Guard against a file changing between digest and pack.
            if sha != entry.sha256 || size != entry.size {
                return Err(CoreError::Conflict(format!(
                    "file changed during backup: {}",
                    entry.path
                )));
            }
            report_progress(
                progress,
                BackupPhase::Archive,
                (index + 1) as u64,
                files.len() as u64,
            );
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
        native_coverage,
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
    let mut manifest: BackupManifest = {
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
    if !(MIN_READABLE_BACKUP_FORMAT_VERSION..=BACKUP_FORMAT_VERSION)
        .contains(&manifest.format_version)
    {
        return Err(CoreError::Validation(format!(
            "unsupported backup format v{} (this build reads v{}-v{})",
            manifest.format_version, MIN_READABLE_BACKUP_FORMAT_VERSION, BACKUP_FORMAT_VERSION
        )));
    }
    // Format v1 had no provider-native payload contract. Ignore any forged
    // extension fields rather than granting old-version archives v2 restore
    // semantics; genuinely absent fields deserialize to these same defaults.
    if manifest.format_version == 1 {
        manifest.native_sessions.clear();
        manifest.native_coverage = NativeCoverageSummary::default();
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
        if !safe_relative_path(&entry.path) {
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
    if manifest.format_version == BACKUP_FORMAT_VERSION {
        validate_native_manifest(&manifest)?;
    }
    Ok(manifest)
}

/// Restore a verified backup into `target_root`.
///
/// Safety contract:
/// - The archive is fully verified BEFORE anything is extracted.
/// - Extraction happens into a sibling staging dir; the target is only swapped
///   in after the DB passes `integrity_check` and `foreign_key_check`, and all
///   provider-native destinations pass conflict validation.
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

    extract_verified(archive, &manifest, &staging)?;
    let previous = publish_restore(&staging, target_root, parent, &manifest)?;
    // Staging was consumed by the swap; disarm the guard.
    std::mem::forget(_guard);
    Ok(previous)
}

fn extract_verified(archive: &Path, manifest: &BackupManifest, staging: &Path) -> Result<()> {
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
        let mut foreign_keys = conn.prepare("PRAGMA foreign_key_check")?;
        let mut violations = foreign_keys.query([])?;
        if let Some(row) = violations.next()? {
            let table: String = row.get(0)?;
            let rowid: Option<i64> = row.get(1)?;
            let parent: String = row.get(2)?;
            return Err(CoreError::Validation(format!(
                "restored database failed foreign_key_check: {table} row {rowid:?} references {parent}"
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

    Ok(())
}

fn publish_restore(
    staging: &Path,
    target_root: &Path,
    parent: &Path,
    manifest: &BackupManifest,
) -> Result<PathBuf> {
    // Native restore validates every destination before writing any artifact.
    // Pi targets the not-yet-published staging root, while external providers
    // use their configured homes. A conflict therefore leaves target_root
    // untouched. The archive-only native copy is removed before publication.
    crate::native_backup::materialize(&staging, &staging, &manifest.native_sessions)?;
    let native_staging = staging.join("native");
    match std::fs::symlink_metadata(&native_staging) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(&native_staging)?,
        Ok(_) => std::fs::remove_file(&native_staging)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(CoreError::Io(error)),
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
    Ok(previous.unwrap_or_default())
}

/// Existing IDs are explicitly reported as skipped; they are never updated.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    pub imported: Vec<String>,
    pub skipped: Vec<String>,
    pub native_coverage: NativeCoverageSummary,
}

pub fn restore_agent(
    archive: &Path,
    paths: &AppPaths,
    db: &Db,
    agent: AgentType,
) -> Result<MergeReport> {
    let manifest = verify(archive)?;
    if manifest.agent_type.is_some_and(|kind| kind != agent) {
        return Err(CoreError::Validation(
            "backup belongs to a different agent".into(),
        ));
    }
    let staging = paths.exports_dir().join(crate::ids::new_id("restore"));
    std::fs::create_dir_all(&staging)?;
    let _guard = crate::export::TempDirGuard::new(staging.clone());
    extract_verified(archive, &manifest, &staging)?;
    let snapshot_paths = AppPaths::new(staging.clone());
    let snapshot = Db::open(&snapshot_paths)?;
    snapshot.retain_backup_agent(agent)?;
    let sessions = snapshot.list_sessions(None, true)?;
    // A descriptor must agree with its database row before it can write any
    // provider-native file. Legacy mixed archives are filtered using DB rows.
    let selected: std::collections::HashSet<_> = sessions.iter().map(|s| s.id.as_str()).collect();
    let native: Vec<_> = manifest
        .native_sessions
        .iter()
        .filter(|s| selected.contains(s.agentport_session_id.as_str()))
        .cloned()
        .collect();
    for descriptor in &native {
        if descriptor.provider != agent {
            return Err(CoreError::Validation(
                "native descriptor does not match Session agent".into(),
            ));
        }
    }
    drop(snapshot);
    let mut created_dirs = Vec::new();
    let mut coverage = NativeCoverageSummary::default();
    let result = db.merge_backup(&snapshot_paths.db_path(), paths, |ids| {
        let parent = paths.sessions_dir();
        if std::fs::symlink_metadata(&parent)?.file_type().is_symlink() {
            return Err(CoreError::Validation(
                "Session directory must not be a symlink".into(),
            ));
        }
        for id in ids {
            match std::fs::symlink_metadata(paths.session_dir(id)) {
                Ok(_) => {
                    return Err(CoreError::Conflict(format!(
                        "Session directory already exists: {id}"
                    )))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let native: Vec<_> = native
            .iter()
            .filter(|s| ids.contains(&s.agentport_session_id))
            .cloned()
            .collect();
        coverage = NativeCoverageSummary::from_sessions(&native);
        // Native files targeting AgentPort stay in staging until their Session
        // directory is published. External providers retain never-overwrite rules.
        crate::native_backup::materialize(&staging, &staging, &native)?;
        for id in ids {
            let target = paths.session_dir(id);
            private_create_dir(&target)?; // exclusive: never replace an orphan tree
            created_dirs.push(target.clone());
            let source = snapshot_paths.session_dir(id);
            if source.exists() {
                copy_restore_tree(&source, &target)?;
            }
        }
        Ok(())
    });
    match result {
        Ok((imported, skipped)) => Ok(MergeReport {
            imported,
            skipped,
            native_coverage: coverage,
        }),
        Err(error) => {
            for path in created_dirs.iter().rev() {
                let _ = std::fs::remove_dir_all(path);
            }
            Err(error)
        }
    }
}

fn private_create_dir(path: &Path) -> Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}

fn copy_restore_tree(source: &Path, target: &Path) -> Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let destination = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            private_create_dir(&destination)?;
            copy_restore_tree(&entry.path(), &destination)?;
        } else if kind.is_file() {
            let mut output = private_create(&destination)?;
            std::io::copy(&mut std::fs::File::open(entry.path())?, &mut output)?;
        } else {
            return Err(CoreError::Validation("non-regular restore payload".into()));
        }
    }
    Ok(())
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
    use std::ffi::OsString;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &Path) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

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
            pinned: false,
            sort_order: 0,
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
            adapter_type: AgentType::Shell,
            transport: crate::models::AgentTransport::Pty,
            command: vec!["sh".into()],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            pinned_at: None,
            archived_at: None,
        })
        .unwrap();
        std::fs::create_dir_all(paths.session_dir("ses_1")).unwrap();
        std::fs::write(paths.log_path("ses_1"), b"hello terminal\n").unwrap();
        Fx { dir, paths, db }
    }

    fn insert_session(fx: &Fx, id: &str, provider: AgentType, native_id: Option<&str>, cwd: &str) {
        fx.db
            .insert_session(&crate::models::Session {
                id: id.into(),
                project_id: "prj_1".into(),
                worktree_id: None,
                preset_id: "pre_test".into(),
                title: format!("{provider:?} backup"),
                cwd: cwd.into(),
                host_pid: None,
                host_socket: None,
                host_token: "t".repeat(32),
                lifecycle: Lifecycle::Stopped,
                agent_session_id: native_id.map(str::to_owned),
                resume_precision: ResumePrecision::Exact,
                adapter_type: provider,
                transport: crate::models::AgentTransport::Pty,
                command: Vec::new(),
                permission_mode: PermissionMode::Native,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                pinned_at: None,
                archived_at: None,
            })
            .unwrap();
    }

    #[test]
    fn scoped_backup_excludes_other_agents_settings_and_deleted_pages() {
        let f = fx();
        insert_session(&f, "ses_other", AgentType::Codex, None, "/tmp/other");
        let conn = rusqlite::Connection::open(f.paths.db_path()).unwrap();
        conn.execute(
            "INSERT INTO settings VALUES ('private','GLOBAL_SECRET_SENTINEL_987654')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE sessions SET title='OTHER_AGENT_SENTINEL_987654' WHERE id='ses_other'",
            [],
        )
        .unwrap();
        std::fs::create_dir_all(f.paths.session_dir("ses_other")).unwrap();
        std::fs::write(
            f.paths.session_dir("ses_other").join("private.json"),
            "other",
        )
        .unwrap();
        std::fs::write(
            f.paths.session_dir("ses_1").join("events.jsonl"),
            "selected",
        )
        .unwrap();
        let archive = f.dir.path().join("shell.zip");
        let mut events = Vec::new();
        create_agent_with_progress(&f.paths, &f.db, &archive, AgentType::Shell, &mut |event| {
            events.push(event)
        })
        .unwrap();
        let mut phases: Vec<_> = events.iter().map(|event| event.phase).collect();
        phases.dedup();
        assert_eq!(
            phases,
            [
                BackupPhase::Database,
                BackupPhase::Filtering,
                BackupPhase::Native,
                BackupPhase::Files,
                BackupPhase::Archive
            ]
        );
        let last = events.last().unwrap();
        assert_eq!(last.completed, last.total);
        assert!(last.total > 0);
        let manifest = verify(&archive).unwrap();
        assert_eq!(manifest.agent_type, Some(AgentType::Shell));
        assert_eq!(manifest.native_coverage.total, 1);
        assert!(manifest.files.iter().all(|e| !e.path.contains("ses_other")));
        let raw = std::fs::read(&archive).unwrap();
        for secret in [
            b"GLOBAL_SECRET_SENTINEL_987654".as_slice(),
            b"OTHER_AGENT_SENTINEL_987654".as_slice(),
        ] {
            assert!(!raw.windows(secret.len()).any(|w| w == secret));
        }
        assert_eq!(f.db.list_sessions(None, true).unwrap().len(), 2);
    }

    #[test]
    fn scoped_restore_merges_legacy_archive_and_reports_duplicates() {
        let source = fx();
        insert_session(&source, "ses_other", AgentType::Codex, None, "/tmp/other");
        std::fs::write(
            source.paths.session_dir("ses_1").join("events.jsonl"),
            "selected",
        )
        .unwrap();
        let archive = source.dir.path().join("legacy.zip");
        create(&source.paths, &source.db, &archive).unwrap();
        let target = AppPaths::new(source.dir.path().join("target"));
        let db = Db::open(&target).unwrap();
        // Existing project with a different ID must be reused by checkout path.
        let mut project = source.db.list_projects().unwrap().remove(0);
        project.id = "existing_project".into();
        project.name = "keep current name".into();
        db.add_project(&project).unwrap();
        let report = restore_agent(&archive, &target, &db, AgentType::Shell).unwrap();
        assert_eq!(report.imported, ["ses_1"]);
        assert!(report.skipped.is_empty());
        assert_eq!(db.list_sessions(None, true).unwrap().len(), 1);
        let session = db.get_session("ses_1").unwrap();
        assert_eq!(session.project_id, "existing_project");
        assert!(session.host_pid.is_none());
        assert_eq!(db.list_projects().unwrap()[0].name, "keep current name");
        assert_eq!(
            std::fs::read_to_string(target.session_dir("ses_1").join("events.jsonl")).unwrap(),
            "selected"
        );
        let report = restore_agent(&archive, &target, &db, AgentType::Shell).unwrap();
        assert!(report.imported.is_empty());
        assert_eq!(report.skipped, ["ses_1"]);
    }

    #[test]
    fn scoped_restore_rejects_wrong_agent_and_orphan_directory_without_changes() {
        let f = fx();
        let archive = f.dir.path().join("shell.zip");
        create_agent(&f.paths, &f.db, &archive, AgentType::Shell).unwrap();
        let target = AppPaths::new(f.dir.path().join("target"));
        let db = Db::open(&target).unwrap();
        assert!(restore_agent(&archive, &target, &db, AgentType::Codex).is_err());
        std::fs::create_dir(target.session_dir("ses_1")).unwrap();
        std::fs::write(target.session_dir("ses_1").join("keep"), "keep").unwrap();
        assert!(restore_agent(&archive, &target, &db, AgentType::Shell).is_err());
        assert!(db.list_projects().unwrap().is_empty());
        assert!(db.list_sessions(None, true).unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(target.session_dir("ses_1").join("keep")).unwrap(),
            "keep"
        );
        // A failed attempt must detach and roll back temp tables for a retry.
        std::fs::remove_dir_all(target.session_dir("ses_1")).unwrap();
        assert!(restore_agent(&archive, &target, &db, AgentType::Shell).is_ok());
    }

    #[test]
    fn scoped_restore_preserves_other_agents_and_rejects_cross_agent_id_collision() {
        let source = fx();
        let target = fx();
        insert_session(
            &target,
            "ses_other",
            AgentType::Codex,
            Some("native_other"),
            "/tmp/other",
        );
        let before = serde_json::to_value(target.db.get_session("ses_other").unwrap()).unwrap();
        let archive = source.dir.path().join("shell.zip");
        create_agent(&source.paths, &source.db, &archive, AgentType::Shell).unwrap();
        let report = restore_agent(&archive, &target.paths, &target.db, AgentType::Shell).unwrap();
        assert_eq!(report.skipped, ["ses_1"]);
        assert_eq!(
            before,
            serde_json::to_value(target.db.get_session("ses_other").unwrap()).unwrap()
        );
        let conn = rusqlite::Connection::open(target.paths.db_path()).unwrap();
        conn.execute(
            "UPDATE sessions SET adapter_type='codex' WHERE id='ses_1'",
            [],
        )
        .unwrap();
        assert!(restore_agent(&archive, &target.paths, &target.db, AgentType::Shell).is_err());
        assert_eq!(
            target.db.get_session("ses_1").unwrap().adapter_type,
            AgentType::Codex
        );
    }

    #[test]
    fn scoped_restore_imports_native_history_into_selected_session_only() {
        let source = fx();
        insert_session(
            &source,
            "ses_easy",
            AgentType::EasyPi,
            Some("easy-native"),
            "/tmp/demo",
        );
        let native = source.paths.session_dir("ses_easy").join("easy_pi");
        std::fs::create_dir_all(&native).unwrap();
        std::fs::write(
            native.join("history.jsonl"),
            "{\"type\":\"session\",\"id\":\"easy-native\"}\n",
        )
        .unwrap();
        let archive = source.dir.path().join("easy.zip");
        create_agent(&source.paths, &source.db, &archive, AgentType::EasyPi).unwrap();
        let target = AppPaths::new(source.dir.path().join("target"));
        let db = Db::open(&target).unwrap();
        let result = restore_agent(&archive, &target, &db, AgentType::EasyPi).unwrap();
        assert_eq!(result.imported, ["ses_easy"]);
        assert!(target
            .session_dir("ses_easy")
            .join("easy_pi/history.jsonl")
            .is_file());
        assert!(!target.session_dir("ses_1").exists());
    }

    #[test]
    fn scoped_restore_v1_imports_worktree_status_and_interrupts_live_binding() {
        let f = fx();
        let conn = rusqlite::Connection::open(f.paths.db_path()).unwrap();
        conn.execute_batch("INSERT INTO worktrees VALUES ('wt_1','prj_1','feature','abc',NULL,'/tmp/backup-worktree','clean','2026-01-01T00:00:00Z'); UPDATE sessions SET worktree_id='wt_1',lifecycle='running',host_pid=123,host_socket='/tmp/old.sock',host_run_id='legacy',host_run_ordinal=0;
            INSERT INTO status_events(session_id,run_id,run_ordinal,sequence,state,source,confidence,occurred_at) VALUES ('ses_1','legacy',0,1,'idle','hook','high','2026-01-01T00:00:00Z');").unwrap();
        let snapshot = f.dir.path().join("v1.db");
        f.db.backup_snapshot(&snapshot).unwrap();
        let bytes = std::fs::read(snapshot).unwrap();
        let mut legacy = manifest(vec![entry("agentport.db", &bytes)]);
        legacy.format_version = 1;
        let archive = f.dir.path().join("v1.zip");
        write_custom_backup_with_method(
            &archive,
            &legacy,
            &[("agentport.db".into(), bytes)],
            zip::CompressionMethod::Stored,
        );
        let paths = AppPaths::new(f.dir.path().join("target"));
        let db = Db::open(&paths).unwrap();
        restore_agent(&archive, &paths, &db, AgentType::Shell).unwrap();
        let session = db.get_session("ses_1").unwrap();
        assert_eq!(session.lifecycle, Lifecycle::Interrupted);
        assert_eq!(session.worktree_id.as_deref(), Some("wt_1"));
        assert!(session.host_pid.is_none() && session.host_socket.is_none());
        let target_conn = rusqlite::Connection::open(paths.db_path()).unwrap();
        assert_eq!(
            target_conn
                .query_row(
                    "SELECT count(*) FROM status_events WHERE session_id='ses_1'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(target_conn
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query([])
            .unwrap()
            .next()
            .unwrap()
            .is_none());
    }

    #[test]
    fn scoped_restore_rejects_project_and_native_identity_conflicts() {
        let source = fx();
        insert_session(
            &source,
            "ses_new",
            AgentType::Codex,
            Some("same-native"),
            "/tmp/demo",
        );
        let archive = source.dir.path().join("codex.zip");
        create_agent(&source.paths, &source.db, &archive, AgentType::Codex).unwrap();
        let target = fx();
        let conn = rusqlite::Connection::open(target.paths.db_path()).unwrap();
        conn.execute("UPDATE projects SET root_path='/different'", [])
            .unwrap();
        assert!(
            restore_agent(&archive, &target.paths, &target.db, AgentType::Codex)
                .unwrap_err()
                .to_string()
                .contains("project")
        );
        conn.execute("UPDATE projects SET root_path='/tmp/demo'", [])
            .unwrap();
        insert_session(
            &target,
            "ses_existing_native",
            AgentType::Codex,
            Some("same-native"),
            "/tmp/demo",
        );
        assert!(
            restore_agent(&archive, &target.paths, &target.db, AgentType::Codex)
                .unwrap_err()
                .to_string()
                .contains("native Session")
        );
        assert!(target.db.get_session("ses_new").is_err());
    }

    fn manifest(files: Vec<BackupFileEntry>) -> BackupManifest {
        BackupManifest {
            format_version: BACKUP_FORMAT_VERSION,
            created_at: Utc::now(),
            app_version: "test".into(),
            data_model_version: DATA_MODEL_VERSION,
            files,
            agent_type: None,
            native_sessions: Vec::new(),
            native_coverage: NativeCoverageSummary::default(),
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
        write_custom_backup_with_method(
            archive,
            manifest,
            payloads,
            zip::CompressionMethod::Deflated,
        );
    }

    fn write_custom_backup_with_method(
        archive: &Path,
        manifest: &BackupManifest,
        payloads: &[(String, Vec<u8>)],
        method: zip::CompressionMethod,
    ) {
        let file = std::fs::File::create(archive).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(method)
            .unix_permissions(0o600);
        zip.start_file("manifest.json", options).unwrap();
        let mut manifest_json = serde_json::to_value(manifest).unwrap();
        if manifest.format_version == 1 {
            let object = manifest_json.as_object_mut().unwrap();
            object.remove("nativeSessions");
            object.remove("nativeCoverage");
        }
        zip.write_all(&serde_json::to_vec(&manifest_json).unwrap())
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
        let metadata = fx.paths.session_dir("ses_1").join("status.json");
        std::fs::write(&metadata, br#"{"state":"stopped"}"#).unwrap();
        let archive = fx.dir.path().join("backup.zip");
        let report = create(&fx.paths, &fx.db, &archive).unwrap();
        assert!(report.files >= 2); // db + AgentPort-owned session metadata
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
            .any(|f| f.path == "sessions/ses_1/status.json"));
        assert!(!manifest
            .files
            .iter()
            .any(|f| f.path.ends_with("/output.log")));

        let target = fx.dir.path().join("restored");
        let prev = restore(&archive, &target).unwrap();
        assert!(prev.as_os_str().is_empty());
        assert_eq!(
            std::fs::read(target.join("sessions/ses_1/status.json")).unwrap(),
            br#"{"state":"stopped"}"#
        );
        assert!(!target.join("sessions/ses_1/output.log").exists());
        // Restored DB opens and contains the session.
        let restored_paths = AppPaths::new(target.clone());
        let restored_db = Db::open(&restored_paths).unwrap();
        assert_eq!(
            restored_db.get_session("ses_1").unwrap().title,
            "demo session"
        );
    }

    #[test]
    fn v2_roundtrip_restores_pi_and_external_native_payloads() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let fx = fx();
        let claude_home = fx.dir.path().join("claude-home");
        let _claude_env = EnvVarGuard::set("CLAUDE_CONFIG_DIR", &claude_home);

        insert_session(&fx, "ses_pi", AgentType::Pi, Some("pi-native"), "/tmp/demo");
        let pi_transcript = fx.paths.session_dir("ses_pi").join("pi/pi-native.jsonl");
        std::fs::create_dir_all(pi_transcript.parent().unwrap()).unwrap();
        std::fs::write(&pi_transcript, b"pi transcript\n").unwrap();

        let claude_cwd = "/workspace/external";
        insert_session(
            &fx,
            "ses_claude",
            AgentType::Claude,
            Some("claude-native"),
            claude_cwd,
        );
        let claude_transcript = claude_home
            .join("projects")
            .join(crate::history::cwd_slug(claude_cwd))
            .join("claude-native.jsonl");
        std::fs::create_dir_all(claude_transcript.parent().unwrap()).unwrap();
        std::fs::write(&claude_transcript, b"claude transcript\n").unwrap();

        let archive = fx.dir.path().join("native-v2.zip");
        let report = create(&fx.paths, &fx.db, &archive).unwrap();
        assert_eq!(report.native_coverage.total, 3);
        assert_eq!(report.native_coverage.captured, 2);
        assert_eq!(report.native_coverage.unsupported, 1);

        let manifest = verify(&archive).unwrap();
        assert_eq!(manifest.format_version, 2);
        assert_eq!(manifest.native_coverage, report.native_coverage);
        assert!(manifest
            .files
            .iter()
            .any(|file| file.path.contains("native/ses_pi/agentport/")));
        assert!(manifest
            .files
            .iter()
            .any(|file| file.path.contains("native/ses_claude/claude/")));

        std::fs::remove_file(&claude_transcript).unwrap();
        let target = fx.dir.path().join("native-restored");
        restore(&archive, &target).unwrap();
        assert_eq!(
            std::fs::read(target.join("sessions/ses_pi/pi/pi-native.jsonl")).unwrap(),
            b"pi transcript\n"
        );
        assert_eq!(
            std::fs::read(&claude_transcript).unwrap(),
            b"claude transcript\n"
        );
        assert!(
            !target.join("native").exists(),
            "archive-only native payload must not remain under AgentPort data"
        );
    }

    #[test]
    fn v2_reports_partial_native_coverage() {
        let fx = fx();
        insert_session(
            &fx,
            "ses_missing",
            AgentType::Claude,
            None,
            "/workspace/missing",
        );
        let archive = fx.dir.path().join("partial.zip");
        let report = create(&fx.paths, &fx.db, &archive).unwrap();
        assert_eq!(report.native_coverage.total, 2);
        assert_eq!(report.native_coverage.missing, 1);
        assert_eq!(report.native_coverage.unsupported, 1);
        assert!(!report.native_coverage.complete());
        assert_eq!(
            verify(&archive).unwrap().native_coverage,
            report.native_coverage
        );
    }

    #[test]
    fn v1_without_native_fields_verifies_and_restores() {
        let fx = fx();
        let snapshot = fx.dir.path().join("legacy.db");
        fx.db.backup_snapshot(&snapshot).unwrap();
        let database = std::fs::read(&snapshot).unwrap();
        let mut legacy = manifest(vec![entry("agentport.db", &database)]);
        legacy.format_version = 1;
        let archive = fx.dir.path().join("legacy-v1.zip");
        write_custom_backup_with_method(
            &archive,
            &legacy,
            &[("agentport.db".into(), database)],
            zip::CompressionMethod::Stored,
        );

        let verified = verify(&archive).unwrap();
        assert_eq!(verified.format_version, 1);
        assert!(verified.native_sessions.is_empty());
        assert_eq!(verified.native_coverage, NativeCoverageSummary::default());
        let target = fx.dir.path().join("legacy-restored");
        restore(&archive, &target).unwrap();
        let restored = Db::open(&AppPaths::new(target)).unwrap();
        assert_eq!(restored.get_session("ses_1").unwrap().title, "demo session");
    }

    #[test]
    fn external_native_conflict_does_not_publish_target() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let fx = fx();
        let claude_home = fx.dir.path().join("claude-conflict-home");
        let _claude_env = EnvVarGuard::set("CLAUDE_CONFIG_DIR", &claude_home);
        let cwd = "/workspace/conflict";
        insert_session(
            &fx,
            "ses_claude",
            AgentType::Claude,
            Some("native-conflict"),
            cwd,
        );
        let transcript = claude_home
            .join("projects")
            .join(crate::history::cwd_slug(cwd))
            .join("native-conflict.jsonl");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(&transcript, b"backup content\n").unwrap();
        let archive = fx.dir.path().join("conflict.zip");
        create(&fx.paths, &fx.db, &archive).unwrap();

        std::fs::write(&transcript, b"different local content\n").unwrap();
        let target = fx.dir.path().join("must-not-publish");
        let error = restore(&archive, &target).unwrap_err();
        assert!(matches!(&error, CoreError::Conflict(_)), "{error}");
        assert!(!target.exists());
        let merge_paths = AppPaths::new(fx.dir.path().join("merge-target"));
        let merge_db = Db::open(&merge_paths).unwrap();
        let error =
            restore_agent(&archive, &merge_paths, &merge_db, AgentType::Claude).unwrap_err();
        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(merge_db.list_sessions(None, true).unwrap().is_empty());
        assert!(merge_db.list_projects().unwrap().is_empty());
        assert!(!merge_paths.session_dir("ses_claude").exists());
        assert_eq!(
            std::fs::read(&transcript).unwrap(),
            b"different local content\n"
        );
    }

    #[test]
    fn restore_rejects_database_foreign_key_violations() {
        let fx = fx();
        let snapshot = fx.dir.path().join("invalid-foreign-key.db");
        fx.db.backup_snapshot(&snapshot).unwrap();
        {
            let conn = rusqlite::Connection::open(&snapshot).unwrap();
            conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
            conn.execute(
                "UPDATE sessions SET project_id='missing_project' WHERE id='ses_1'",
                [],
            )
            .unwrap();
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .unwrap();
        }
        let database = std::fs::read(&snapshot).unwrap();
        let archive = fx.dir.path().join("invalid-foreign-key.zip");
        write_custom_backup_with_method(
            &archive,
            &manifest(vec![entry("agentport.db", &database)]),
            &[("agentport.db".into(), database)],
            zip::CompressionMethod::Stored,
        );

        let target = fx.dir.path().join("invalid-foreign-key-target");
        let error = restore(&archive, &target).unwrap_err();
        assert!(error.to_string().contains("foreign_key_check"), "{error}");
        assert!(!target.exists());
    }

    #[test]
    fn highly_compressible_created_backup_verifies_and_restores() {
        let fx = fx();
        let payload = vec![0_u8; 1024 * 1024];
        std::fs::write(
            fx.paths.session_dir("ses_1").join("status-payload.bin"),
            &payload,
        )
        .unwrap();

        let archive = fx.dir.path().join("compressible.zip");
        create(&fx.paths, &fx.db, &archive).unwrap();
        verify(&archive).unwrap();

        let target = fx.dir.path().join("restored-compressible");
        restore(&archive, &target).unwrap();
        assert_eq!(
            std::fs::read(target.join("sessions/ses_1/status-payload.bin")).unwrap(),
            payload
        );
        assert!(!target.join("sessions/ses_1/output.log").exists());
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
    fn native_manifest_cannot_target_provider_configuration_files() {
        let fx = fx();
        let snapshot = fx.dir.path().join("provider-target.db");
        fx.db.backup_snapshot(&snapshot).unwrap();
        let database = std::fs::read(&snapshot).unwrap();
        let payload = b"malicious settings".to_vec();
        let archive_path = "native/ses_1/claude/settings.json";
        let artifact = crate::native_backup::NativeArtifact {
            archive_path: archive_path.into(),
            target_root: NativeTargetRoot::Claude,
            target_path: "settings.json".into(),
            size: payload.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&payload)),
        };
        let mut forged = manifest(vec![
            entry("agentport.db", &database),
            entry(archive_path, &payload),
        ]);
        forged.native_sessions = vec![NativeSessionBackup {
            agentport_session_id: "ses_1".into(),
            provider: AgentType::Claude,
            native_session_ids: vec!["native-id".into()],
            cwd: "/tmp/demo".into(),
            coverage: NativeCoverage::Complete,
            artifacts: vec![artifact],
            kimi_bindings: Vec::new(),
        }];
        forged.native_coverage = NativeCoverageSummary::from_sessions(&forged.native_sessions);
        let archive = fx.dir.path().join("provider-target.zip");
        write_custom_backup_with_method(
            &archive,
            &forged,
            &[
                ("agentport.db".into(), database),
                (archive_path.into(), payload),
            ],
            zip::CompressionMethod::Stored,
        );

        let error = verify(&archive).unwrap_err();
        assert!(error
            .to_string()
            .contains("invalid native artifact mapping"));
    }

    #[test]
    fn zip_slip_payload_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("zip-slip.zip");
        let database = b"db".to_vec();
        let escaped = b"escape".to_vec();
        write_custom_backup(
            &archive,
            &manifest(vec![
                entry("agentport.db", &database),
                entry("../escaped", &escaped),
            ]),
            &[
                ("agentport.db".into(), database),
                ("../escaped".into(), escaped),
            ],
        );

        let error = verify(&archive).unwrap_err();
        assert!(error.to_string().contains("unsafe backup path"), "{error}");
        assert!(!dir.path().join("escaped").exists());
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
